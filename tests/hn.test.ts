import { describe, expect, test } from 'claude-code/testing'

import {
  TOP_COUNT,
  TOP_STORIES_URL,
  ago,
  byline,
  comments,
  fetchTop,
  itemUrl,
  label,
  parseItem,
  parseTopIds,
  points,
  threadUrl,
} from '../hooks/hn'
import type { Fetch, Story } from '../hooks/hn'

const MISTRAL = {
  by: 'whirlwin',
  descendants: 57,
  id: 50186129,
  score: 233,
  time: 1792610455,
  title: 'Mistral Large 4',
  type: 'story',
  url: 'https://docs.mistral.ai/models/mistral-large-4-0',
}
const POSTED = MISTRAL.time
const HOUR_LATER = (POSTED + 3600) * 1000
// What must never reach the terminal from a title, an author or a link.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

type Answer = { ok: boolean; status: number; text: string }

function json(body: unknown): Answer {
  return { ok: true, status: 200, text: JSON.stringify(body) }
}

// Mistral with some fields changed; a field set to undefined is left out.
function parse(fields: Record<string, unknown>, rank = 1): Story | null {
  return parseItem(JSON.stringify({ ...MISTRAL, ...fields }), rank)
}

function read(fields: Record<string, unknown> = {}, rank = 1): Story {
  const story = parse(fields, rank)
  if (story === null) throw new Error(`${JSON.stringify(fields)} did not parse`)
  return story
}

function at(seconds: number): string {
  return ago((POSTED + seconds) * 1000, POSTED)
}

// The front page at rank r is item 1000 + r; `change` answers some ranks
// otherwise (an Error is a fetch that rejects).
function frontPage(length: number, change: Record<number, Answer | Error> = {}): Map<string, Answer | Error> {
  const ids = Array.from({ length }, (_, i) => 1001 + i)
  const answers = new Map<string, Answer | Error>([[TOP_STORIES_URL, json(ids)]])
  for (const [i, id] of ids.entries()) {
    answers.set(itemUrl(id), change[i + 1] ?? json({ ...MISTRAL, id, title: `Story ${id}` }))
  }
  return answers
}

// The most requests fetchTop makes: topstories.json, then one per story.
const REQUESTS = 1 + TOP_COUNT

type Api = { fetch: Fetch; asked: string[]; busy: { now: number; peak: number } }

// The Firebase API beneath fetchTop: an unknown URL answers 404, `asked`
// records every request and `busy` how many were in flight at once. Later
// requests settle first, so the order of the stories cannot come from the
// order their answers arrive in.
function api(answers: ReadonlyMap<string, Answer | Error>): Api {
  const asked: string[] = []
  const busy = { now: 0, peak: 0 }
  const fetch: Fetch = async url => {
    asked.push(url)
    busy.now += 1
    busy.peak = Math.max(busy.peak, busy.now)
    try {
      for (let hop = asked.length; hop <= REQUESTS; hop++) await Promise.resolve()
      const answer = answers.get(url) ?? { ok: false, status: 404, text: 'null' }
      if (answer instanceof Error) throw answer
      return answer
    } finally {
      busy.now -= 1
    }
  }
  return { fetch, asked, busy }
}

describe('parseItem', () => {
  test('reads a story as the front page shows it', async () => {
    const story = read({}, 7)
    expect(story).toEqual({
      id: 50186129,
      rank: 7,
      title: 'Mistral Large 4',
      href: 'https://docs.mistral.ai/models/mistral-large-4-0',
      domain: 'docs.mistral.ai',
      points: 233,
      by: 'whirlwin',
      time: 1792610455,
      comments: 57,
      threadHref: 'https://news.ycombinator.com/item?id=50186129',
    })
    expect(label(story)).toBe('7. Mistral Large 4')
    expect(byline(story, HOUR_LATER)).toBe('233 points by whirlwin 1 hour ago')
    expect(itemUrl(50186129)).toBe('https://hacker-news.firebaseio.com/v0/item/50186129.json')
    expect(threadUrl(50186129)).toBe(story.threadHref)
  })

  test('links an Ask HN post to its own thread', async () => {
    const story = read({ title: 'Ask HN: What are you working on?', url: undefined, text: 'Tell us' })
    expect(story.href).toBe('https://news.ycombinator.com/item?id=50186129')
    expect(story.domain).toBeNull()
    expect(story.points).toBe(233)
    expect(story.comments).toBe(57)
  })

  test('reads a poll as a story', async () => {
    const poll = read({ type: 'poll', url: undefined, parts: [1, 2] })
    expect(byline(poll, HOUR_LATER)).toBe('233 points by whirlwin 1 hour ago')
    expect(poll.href).toBe(poll.threadHref)
  })

  test('shows a job with nothing but its age', async () => {
    const job = read({ type: 'job', title: 'Acme (YC W24) is hiring', score: 1, descendants: undefined })
    expect(job.points).toBeNull()
    expect(job.by).toBeNull()
    expect(job.comments).toBeNull()
    expect(job.href).toBe(MISTRAL.url)
    expect(byline(job, HOUR_LATER)).toBe('1 hour ago')
  })

  test('counts a missing score as 0 points and a missing author as none', async () => {
    const bare = read({ score: undefined, by: undefined, descendants: undefined })
    expect(bare.points).toBe(0)
    expect(bare.by).toBeNull()
    expect(bare.comments).toBe(0)
    expect(byline(bare, HOUR_LATER)).toBe('0 points 1 hour ago')
    // Not a count, or not a name: the same as missing.
    const odd = read({ score: '233', by: 42, descendants: -1 })
    expect([odd.points, odd.by, odd.comments]).toEqual([0, null, 0])
    expect(read({ by: ' \u0007 ' }).by).toBeNull()
  })

  test('leaves out what the front page would not show', async () => {
    const GONE: [string, string][] = [
      ['null', 'null'],
      ['not JSON', 'Service Unavailable'],
      ['empty', ''],
      ['an array', JSON.stringify([MISTRAL])],
      ['a number', '42'],
      ['dead', JSON.stringify({ ...MISTRAL, dead: true })],
      ['deleted', JSON.stringify({ ...MISTRAL, deleted: true })],
      ['a comment', JSON.stringify({ ...MISTRAL, type: 'comment' })],
      ['a poll option', JSON.stringify({ ...MISTRAL, type: 'pollopt' })],
      ['without a type', JSON.stringify({ ...MISTRAL, type: undefined })],
      ['a blank title', JSON.stringify({ ...MISTRAL, title: ' \t\n ' })],
      ['a title of controls', JSON.stringify({ ...MISTRAL, title: '\u001b\u0007\u202e' })],
      ['no title', JSON.stringify({ ...MISTRAL, title: undefined })],
      ['a title that is not text', JSON.stringify({ ...MISTRAL, title: 42 })],
      ['no id', JSON.stringify({ ...MISTRAL, id: undefined })],
      ['id 0', JSON.stringify({ ...MISTRAL, id: 0 })],
      ['a negative id', JSON.stringify({ ...MISTRAL, id: -1 })],
      ['a fractional id', JSON.stringify({ ...MISTRAL, id: 1.5 })],
      ['an id as text', JSON.stringify({ ...MISTRAL, id: '50186129' })],
      ['an unsafe id', JSON.stringify({ ...MISTRAL, id: 2 ** 53 })],
      ['no time', JSON.stringify({ ...MISTRAL, time: undefined })],
      ['a time as text', JSON.stringify({ ...MISTRAL, time: '1792610455' })],
      ['an infinite time', '{"id":1,"type":"story","title":"Overflow","time":1e400}'],
      ['a time past safe integers', '{"id":1,"type":"story","title":"Overflow","time":1e300}'],
      ['a negative time', JSON.stringify({ ...MISTRAL, time: -1 })],
      ['time 0', JSON.stringify({ ...MISTRAL, time: 0 })],
      ['a fractional time', JSON.stringify({ ...MISTRAL, time: 1792610455.5 })],
    ]
    for (const [what, body] of GONE) expect(parseItem(body, 1), what).toBeNull()
    expect(parse({ dead: false, deleted: false })).not.toBeNull()
  })
})

describe('sanitizing', () => {
  test('drops an escape sequence that would end the hyperlink', async () => {
    const story = read({ title: 'Mistral\u001b]8;;https://evil\u0007 Large 4', by: 'whirl\u001b[31mwin' })
    expect(story.title).toBe('Mistral]8;;https://evil Large 4')
    expect(story.by).toBe('whirl[31mwin')
    expect(read({ title: 'Mistral\u009b31m Large\u0085 4\u007f' }).title).toBe('Mistral31m Large 4')
  })

  test('drops bidi overrides and isolates', async () => {
    const story = read({ title: 'Mistral \u202eLarge\u202c \u2066 4\u2069' })
    expect(story.title).toBe('Mistral Large 4')
    expect(story.title).not.toMatch(UNSAFE)
  })

  test('keeps a tab or newline as one space and trims', async () => {
    expect(read({ title: '\n  Mistral\tLarge\r\n\n4  ' }).title).toBe('Mistral Large 4')
    expect(read({ title: 'Mistral \u0007 Large \u202e 4' }).title).toBe('Mistral Large 4')
    // NEL breaks a line too, though \s leaves it out.
    expect(read({ title: 'Mistral\u0085Large' }).title).toBe('Mistral Large')
  })

  test('drops or spaces every character of each unsafe range, ends included', async () => {
    const RANGES: [number, number][] = [[0x00, 0x1f], [0x7f, 0x9f], [0x202a, 0x202e], [0x2066, 0x2069]]
    for (const [first, last] of RANGES) {
      for (let code = first; code <= last; code++) {
        const title = read({ title: `Mistral${String.fromCharCode(code)}Large` }).title
        expect(['Mistral Large', 'MistralLarge'], `U+${code.toString(16).padStart(4, '0')}`).toContain(title)
      }
    }
  })
})

describe('href', () => {
  test('links an article only over http or https', async () => {
    const UNSAFE_URLS: unknown[] = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'ftp://example.com/a',
      'not a url',
      '/item?id=1',
      '',
      42,
      `https://example.com/${'a'.repeat(2048)}`,
    ]
    for (const url of UNSAFE_URLS) {
      const story = read({ url })
      expect(story.href, String(url).slice(0, 40)).toBe(story.threadHref)
      expect(story.domain, String(url).slice(0, 40)).toBeNull()
    }
    expect(read({ url: 'http://example.com/a' }).href).toBe('http://example.com/a')
    expect(read({ url: `https://example.com/${'a'.repeat(2000)}` }).domain).toBe('example.com')
  })

  test('links an article of exactly 2048 characters and not one more', async () => {
    const longest = read({ url: `https://example.com/${'a'.repeat(2028)}` })
    expect(longest.href).toHaveLength(2048)
    expect(longest.domain).toBe('example.com')
    const over = read({ url: `https://example.com/${'a'.repeat(2029)}` })
    expect(over.href).toBe(over.threadHref)
    expect(over.domain).toBeNull()
  })

  test('encodes the characters that would end the hyperlink', async () => {
    const story = read({ url: 'https://example.com/a\u001b]8;;x\u0007b\u202e' })
    expect(story.href).not.toMatch(UNSAFE)
    expect(story.href).toStartWith('https://example.com/a%1B')
    expect(story.domain).toBe('example.com')
  })

  test('shows the domain without its www', async () => {
    const DOMAINS: [string, string][] = [
      ['https://www.example.com/a', 'example.com'],
      ['https://WWW.Example.com', 'example.com'],
      ['https://user:pw@www.example.com:8443/x', 'example.com'],
      ['https://wwwx.example.com', 'wwwx.example.com'],
      ['https://news.www.example.com', 'news.www.example.com'],
      ['https://docs.mistral.ai/models', 'docs.mistral.ai'],
      // A lookalike of apple.com in Cyrillic shows as the punycode it is.
      ['https://\u0430\u0440\u0440\u04cf\u0435.com/', 'xn--80ak6aa92e.com'],
      // Nothing left after the www: the host as it is.
      ['https://www./', 'www.'],
    ]
    for (const [url, domain] of DOMAINS) expect(read({ url }).domain, url).toBe(domain)
  })
})

describe('parseTopIds', () => {
  test('reads the first TOP_COUNT ids in order', async () => {
    const ids = Array.from({ length: 500 }, (_, i) => 50186129 + i)
    expect(parseTopIds(JSON.stringify(ids))).toEqual(ids.slice(0, TOP_COUNT))
    expect(parseTopIds('[3,1,2]')).toEqual([3, 1, 2])
    // Only the ids it reads have to be ids.
    expect(parseTopIds(JSON.stringify([...ids.slice(0, TOP_COUNT), 'x']))).toHaveLength(TOP_COUNT)
  })

  test('reads nothing but a list of ids', async () => {
    const BODIES = ['', 'not JSON', 'null', '42', '{"0":1}', '[1,0]', '[1,-2]', '[1,2.5]', '[1,"2"]', '[1,null]', `[${2 ** 53}]`]
    for (const body of BODIES) expect(parseTopIds(body), body).toBeNull()
  })
})

describe('fetchTop', () => {
  test('keeps each rank when items in the middle cannot be read', async () => {
    const { fetch } = api(
      frontPage(TOP_COUNT, {
        3: new Error('socket hang up'),
        5: { ok: false, status: 500, text: 'Internal Server Error' },
        8: json({ ...MISTRAL, id: 1008, dead: true }),
        12: json(null),
        15: json({ ...MISTRAL, id: 9999 }),
      }),
    )
    const stories = await fetchTop(fetch)
    const ranks = Array.from({ length: TOP_COUNT }, (_, i) => i + 1).filter(rank => ![3, 5, 8, 12, 15].includes(rank))
    expect(stories.map(story => story.rank)).toEqual(ranks)
    expect(stories.map(story => story.id)).toEqual(ranks.map(rank => 1000 + rank))
    expect(stories[0]?.title).toBe('Story 1001')
  })

  test('fetches exactly the top TOP_COUNT items, all at once', async () => {
    const { fetch, asked, busy } = api(frontPage(40))
    const stories = await fetchTop(fetch)
    expect(stories).toHaveLength(TOP_COUNT)
    const items = asked.filter(url => url !== TOP_STORIES_URL).sort()
    expect(items).toEqual(Array.from({ length: TOP_COUNT }, (_, i) => itemUrl(1001 + i)).sort())
    expect(busy.peak).toBe(TOP_COUNT)
  })

  test('says what topstories.json answered when it fails', async () => {
    const { fetch, asked } = api(new Map([[TOP_STORIES_URL, { ok: false, status: 503, text: 'Service Unavailable' }]]))
    await expect(fetchTop(fetch)).rejects.toThrow('topstories.json answered 503')
    expect(asked).toEqual([TOP_STORIES_URL])
  })

  test('passes on why the request for topstories.json failed', async () => {
    const { fetch, asked } = api(new Map([[TOP_STORIES_URL, new Error('connection refused')]]))
    await expect(fetchTop(fetch)).rejects.toThrow('connection refused')
    expect(asked).toEqual([TOP_STORIES_URL])
  })

  test('fails when topstories.json is not a list of ids', async () => {
    await expect(fetchTop(api(new Map([[TOP_STORIES_URL, json({ error: 'Permission denied' })]])).fetch)).rejects.toThrow(/story ids/)
    await expect(fetchTop(api(new Map([[TOP_STORIES_URL, json([])]])).fetch)).rejects.toThrow(/no stories/)
  })

  test('fails when no story can be read', async () => {
    const dead: Record<number, Answer | Error> = {}
    for (let rank = 1; rank <= TOP_COUNT; rank++) dead[rank] = rank % 2 === 0 ? json({ ...MISTRAL, dead: true }) : new Error('offline')
    await expect(fetchTop(api(frontPage(TOP_COUNT, dead)).fetch)).rejects.toThrow(`none of the top ${TOP_COUNT} stories`)
  })
})

describe('words', () => {
  test('points and comments as HN words them', async () => {
    expect([points(0), points(1), points(2), points(233)]).toEqual(['0 points', '1 point', '2 points', '233 points'])
    expect([comments(0), comments(1), comments(2), comments(57)]).toEqual(['discuss', '1 comment', '2 comments', '57 comments'])
  })

  test('ago in whole minutes, hours and days', async () => {
    const MINUTE = 60
    const HOUR = 60 * MINUTE
    const DAY = 24 * HOUR
    expect(at(0)).toBe('1 minute ago')
    expect(at(59)).toBe('1 minute ago')
    expect(at(MINUTE)).toBe('1 minute ago')
    expect(at(2 * MINUTE)).toBe('2 minutes ago')
    expect(at(59 * MINUTE)).toBe('59 minutes ago')
    expect(at(HOUR)).toBe('1 hour ago')
    expect(at(2 * HOUR)).toBe('2 hours ago')
    expect(at(23 * HOUR)).toBe('23 hours ago')
    expect(at(23 * HOUR + 59 * MINUTE)).toBe('23 hours ago')
    expect(at(DAY)).toBe('1 day ago')
    expect(at(3 * DAY)).toBe('3 days ago')
    // The clock here behind HN's.
    expect(at(-5 * MINUTE)).toBe('1 minute ago')
  })
})
