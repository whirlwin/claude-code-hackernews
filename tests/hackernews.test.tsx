import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock, Mounted } from 'claude-code/testing'
import type { On, RenderElement, RenderPropsOf } from 'claude-code'

import { REFRESH_MS, TOP_STORIES_URL, itemUrl, threadUrl } from '../hooks/hn'
import { FRAMES_PER_STORY, TICK_MS } from '../hooks/logo'

const SURFACES = ['terminal', 'desktop'] as const
const SPINNER = { word: 'Baking', message: null, suffix: '\u2026', mode: 'responding' as const }
const ENDED = { answer: '', durationMs: 1000, isAborted: false, reason: 'answer' } as const
const SLASH_HACKERNEWS = {
  command: 'hackernews',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
} as const
const SLASH_NEXT = { ...SLASH_HACKERNEWS, args: 'next' } as const
// Copies of the hooks module's timing, which it keeps private: a running turn
// checks each second whether the list is due, tries a failed one again after
// 30 s, and gives up on a fetch after 8 s.
const POLL_MS = 1000
const RETRY_MS = 30 * 1000
const TIMEOUT_MS = 8 * 1000
const STORY_MS = FRAMES_PER_STORY * TICK_MS

const POSTED = 1792610455
// An hour after every fixture was posted, so each one reads `1 hour ago`.
const HOUR_LATER = (POSTED + 3600) * 1000
const MISTRAL = {
  by: 'whirlwin',
  descendants: 57,
  id: 50186129,
  score: 233,
  time: POSTED,
  title: 'Mistral Large 4',
  type: 'story',
  url: 'https://docs.mistral.ai/models/mistral-large-4-0',
}
const ASK = { by: 'curious', descendants: 300, id: 50186200, score: 120, time: POSTED, title: 'Ask HN: What are you working on?', type: 'story' }
const JOB = { by: 'acme', id: 50186300, score: 1, time: POSTED, title: 'Acme (YC W24) is hiring engineers', type: 'job', url: 'https://acme.example/careers' }

type Answer = { status: number; text: string }
// How a test answers a URL otherwise than FRONT_PAGE does (late, or with an
// error); undefined leaves it to FRONT_PAGE.
type Change = (url: string) => Answer | undefined | Promise<Answer | undefined>

function json(body: unknown): Answer {
  return { status: 200, text: JSON.stringify(body) }
}

const FRONT_PAGE = new Map<string, Answer>([
  [TOP_STORIES_URL, json([MISTRAL.id, ASK.id, JOB.id])],
  ...[MISTRAL, ASK, JOB].map(item => [itemUrl(item.id), json(item)] as const),
])
const NOT_FOUND: Answer = { status: 404, text: 'null' }
const DOWN: Answer = { status: 503, text: 'Service Unavailable' }

// The Firebase API beneath the plugin; `fetches` counts the fetches of the
// list, not of its items.
function api(on: On, change: Change = () => undefined): { fetches: number } {
  const seen = { fetches: 0 }
  on('http.fetch', async (_, e) => {
    if (e.url === TOP_STORIES_URL) seen.fetches += 1
    const answer = (await change(e.url)) ?? FRONT_PAGE.get(e.url) ?? NOT_FOUND
    return { value: { status: answer.status, ok: answer.status === 200, headers: {}, text: answer.text } }
  })
  return seen
}

// The list answers 503 while `isDown` says so.
function listDown(isDown: () => boolean = () => true): Change {
  return url => (url === TOP_STORIES_URL && isDown() ? DOWN : undefined)
}

// The engine beneath: a session that starts, turns that start and end, a
// spinner drawn from the props it is handed, and a terminal that takes a
// blit while the spinner is up and denies one once it is gone.
function engine(on: On): { isUp: boolean } {
  const spinner = { isUp: true }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.blit', () => ({ value: spinner.isUp ? {} : { deny: 'nothing of hackernews is mounted there' } }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    const props = e.props as { word: string; suffix: string }
    return h(Text, {}, `${props.word}${props.suffix}`) as RenderElement
  })
  return spinner
}

async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

async function startTurn($: Engine, clock: MockClock): Promise<void> {
  await startSession($)
  await $.turn.start({ text: 'hi', turnId: 'main' })
  await clock.advance(POLL_MS)
}

function mount<P extends (typeof SURFACES)[number]>($: Engine, surface: P, props: RenderPropsOf['Spinner'] = SPINNER) {
  return $.ui.mount({ plugin: 'hackernews', surface, component: 'Spinner', requestId: 'main', props })
}

// What a terminal shows of an element: the kit's own `text` of a Link
// carries its href too.
function shown(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null || !('children' in node) || !Array.isArray(node.children)) return ''
  return node.children.map(shown).join('')
}

// The whole drawing as one string, the tree's or the engine's.
async function screen(ui: Pick<Mounted, 'drawn'>): Promise<string> {
  return shown(await ui.drawn())
}

// The lines beside the tile, the only Texts that truncate.
async function lines(ui: Pick<Mounted, 'findAll'>): Promise<string[]> {
  const texts = await ui.findAll({ type: 'Text' })
  return texts.filter(text => text.props.wrap === 'truncate-end').map(shown)
}

// How the column of lines sits beside the tile.
async function justified(ui: Pick<Mounted, 'findAll'>): Promise<unknown> {
  return (await ui.findAll({ type: 'Box' }))[1]?.props.justifyContent
}

describe('spinner', () => {
  test('draws the tile beside the story and its links in the terminal', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal')

    expect(await ui.find({ type: 'Raster', key: 'hn' })).toBeDefined()
    expect(await lines(ui)).toEqual([
      '1. Mistral Large 4 (docs.mistral.ai)',
      '   233 points by whirlwin 1 hour ago | 57 comments (0s)',
    ])
    expect(await justified(ui)).toBe('flex-start')
    expect((await ui.find({ type: 'Text', text: /^1\.$/ }))?.props.color).toBe('#ff6600')
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(link => link.props.href)).toEqual([MISTRAL.url, threadUrl(MISTRAL.id)])
    expect(links.map(shown)).toEqual(['Mistral Large 4', '57 comments'])
  })

  test('redraws its own elapsed time each second, which the engine no longer draws', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal')
    await clock.advance(5500)
    expect((await lines(ui))[1]).toMatch(/ \(5s\)$/)
  })

  test('only swaps the word where it cannot draw a raster', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'desktop')
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect(await screen(ui)).toBe('1. Mistral Large 4\u2026')
  })

  test('shows the engine word beside the tile before the first fetch', async ($, on) => {
    mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startSession($)
    await $.turn.start({ text: 'hi', turnId: 'main' })
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await ui.find({ type: 'Raster', key: 'hn' }), surface).toEqual(surface === 'terminal' ? expect.anything() : undefined)
      expect(await screen(ui)).toBe(surface === 'terminal' ? 'Baking\u2026 (0s)' : 'Baking\u2026')
      if (surface === 'terminal') expect(await justified(ui)).toBe('center')
      await ui.unmount()
    }
  })

  for (const surface of SURFACES) {
    test(`draws the story as soon as the first fetch lands on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: HOUR_LATER })
      engine(on)
      api(on)
      await startSession($)
      await $.turn.start({ text: 'hi', turnId: 'main' })
      const ui = await mount($, surface)
      expect(await screen(ui)).toMatch(/^Baking\u2026/)
      await clock.advance(POLL_MS)
      expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
    })
  }

  test('shows the engine word when the front page cannot be fetched, and /hackernews says why', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on, listDown())
    await startTurn($, clock)
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect(await ui.find({ type: 'Raster', key: 'hn' }), surface).toEqual(surface === 'terminal' ? expect.anything() : undefined)
      expect(await screen(ui)).toMatch(/^Baking\u2026/)
      await ui.unmount()
    }
    expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe('The spinner no longer shows Hacker News.')
    expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe(
      'The spinner shows the Hacker News front page, but it could not be fetched: topstories.json answered 503',
    )
  })

  test('shows the engine message in place of the story', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal', { ...SPINNER, message: 'Compacting conversation' })
    expect(await ui.find({ type: 'Raster', key: 'hn' })).toBeDefined()
    expect(await lines(ui)).toEqual(['Compacting conversation\u2026 (0s)'])
    expect(await justified(ui)).toBe('center')
    expect(await ui.find({ type: 'Link' })).toBeUndefined()
  })

  test('draws one ellipsis after a message that ends in one', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal', { ...SPINNER, message: 'Compacting conversation\u2026' })
    expect(await lines(ui)).toEqual(['Compacting conversation\u2026 (0s)'])
  })

  test('shows a job with nothing but its age, and no comments link', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    await $.command.run(SLASH_NEXT)
    expect((await $.command.run(SLASH_NEXT)).text).toBe('Next up: 3. Acme (YC W24) is hiring engineers')
    const ui = await mount($, 'terminal')
    expect(await lines(ui)).toEqual(['3. Acme (YC W24) is hiring engineers (acme.example)', '   1 hour ago (0s)'])
    expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([JOB.url])
  })

  test('links an Ask HN post to its thread and names no domain', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    expect((await $.command.run(SLASH_NEXT)).text).toBe('Next up: 2. Ask HN: What are you working on?')
    const ui = await mount($, 'terminal')
    expect((await lines(ui))[0]).toBe('2. Ask HN: What are you working on?')
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(link => link.props.href)).toEqual([threadUrl(ASK.id), threadUrl(ASK.id)])
  })

  for (const surface of SURFACES) {
    test(`rotates through the front page and back to its top on ${surface}`, async ($, on) => {
      const clock = mock.clock(on, { now: HOUR_LATER })
      engine(on)
      api(on)
      await startTurn($, clock)
      const ui = await mount($, surface)
      expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
      await clock.advance(STORY_MS)
      expect(await screen(ui)).toMatch(/^2\. Ask HN: What are you working on\?/)
      await clock.advance(2 * STORY_MS)
      expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
    })
  }

  test('starts at rank 1 when the first list comes late', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    let isDown = true
    api(on, listDown(() => isDown))
    await startTurn($, clock)
    const ui = await mount($, 'terminal')
    isDown = false
    // The tile rolls on through the wait, long enough to reach another story.
    await clock.advance(RETRY_MS)
    expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
  })

  test('picks the rotation up where it left off at the next turn', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    const spinner = engine(on)
    api(on)
    await startTurn($, clock)
    let ui = await mount($, 'terminal')
    await clock.advance(STORY_MS / 2)
    spinner.isUp = false
    await ui.unmount()
    await $.turn.complete({ ...ENDED, turnId: 'main' })
    await clock.advance(60 * 1000)

    await $.turn.start({ text: 'again', turnId: 'next' })
    spinner.isUp = true
    ui = await mount($, 'terminal')
    expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
    expect((await lines(ui))[1]).toMatch(/ \(0s\)$/)
    await clock.advance(STORY_MS / 2)
    expect(await screen(ui)).toMatch(/^2\. Ask HN/)
  })

  test('starts its elapsed time afresh each turn, even after hiding mid-turn', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    let ui = await mount($, 'terminal')
    await clock.advance(3000)
    await $.command.run(SLASH_HACKERNEWS)
    await ui.unmount()
    await $.turn.complete({ ...ENDED, turnId: 'main' })
    await clock.advance(60 * 1000)

    await $.command.run(SLASH_HACKERNEWS)
    await $.turn.start({ text: 'again', turnId: 'next' })
    ui = await mount($, 'terminal')
    expect((await lines(ui))[1]).toMatch(/ \(0s\)$/)
  })

  test('does not rotate while hidden', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal')
    await $.command.run(SLASH_HACKERNEWS)
    await clock.advance(2 * STORY_MS)
    await $.command.run(SLASH_HACKERNEWS)
    expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
  })

  test('does not rotate a word drawn after the main turn ended', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'desktop')
    await $.turn.complete({ ...ENDED, turnId: 'main' })
    await ui.redraw()
    await clock.advance(STORY_MS)
    expect(await screen(ui)).toBe('1. Mistral Large 4\u2026')
  })

  test('/hackernews hides the front page and shows it again', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    for (const surface of SURFACES) {
      const ui = await mount($, surface)
      expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe('The spinner no longer shows Hacker News.')
      expect(await ui.find({ type: 'Raster' })).toBeUndefined()
      expect(await screen(ui)).toBe('Baking\u2026')

      expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe('The spinner shows the Hacker News front page.')
      expect(await screen(ui)).toMatch(/^1\. Mistral Large 4/)
      await ui.unmount()
    }
  })

  test('/hackernews next shows the front page again and skips a story', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    api(on)
    await startTurn($, clock)
    const ui = await mount($, 'terminal')
    await $.command.run(SLASH_HACKERNEWS)
    expect(await ui.find({ type: 'Raster' })).toBeUndefined()
    expect((await $.command.run(SLASH_NEXT)).text).toBe('Next up: 2. Ask HN: What are you working on?')
    expect(await ui.find({ type: 'Raster', key: 'hn' })).toBeDefined()
    expect(await screen(ui)).toMatch(/^2\. Ask HN/)
  })
})

describe('fetching', () => {
  test('fetches only while a turn runs', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on)
    await startSession($)
    await clock.advance(REFRESH_MS * 2)
    expect(seen.fetches).toBe(0)
    await $.turn.start({ text: 'hi', turnId: 'main' })
    await clock.advance(POLL_MS)
    expect(seen.fetches).toBe(1)
    await $.turn.complete({ ...ENDED, turnId: 'main' })
    await clock.advance(REFRESH_MS * 2)
    expect(seen.fetches).toBe(1)
  })

  test('does not fetch while hidden, turn or not', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on)
    await startSession($)
    await $.command.run(SLASH_HACKERNEWS)
    await $.turn.start({ text: 'hi', turnId: 'main' })
    await clock.advance(REFRESH_MS * 2)
    expect(seen.fetches).toBe(0)
  })

  test('fetches again REFRESH_MS into a long turn', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on)
    await startTurn($, clock)
    expect(seen.fetches).toBe(1)
    await clock.advance(REFRESH_MS - POLL_MS)
    expect(seen.fetches).toBe(1)
    await clock.advance(POLL_MS)
    expect(seen.fetches).toBe(2)
  })

  test('follows the main loop: a subagent turn neither stops nor starts the fetches', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on)
    await startTurn($, clock)
    await $.turn.complete({ ...ENDED, turnId: 'sub', agentId: 'agent-1' })
    await clock.advance(REFRESH_MS)
    expect(seen.fetches).toBe(2)
    await $.turn.complete({ ...ENDED, turnId: 'main' })
    await $.turn.start({ text: 'task', turnId: 'sub-2', agentId: 'agent-2' })
    await $.turn.complete({ ...ENDED, turnId: 'sub-2', agentId: 'agent-2' })
    await clock.advance(REFRESH_MS * 3)
    expect(seen.fetches).toBe(2)
  })

  test('tries again RETRY_MS after a failure that left no list', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on, listDown())
    await startTurn($, clock)
    expect(seen.fetches).toBe(1)
    await clock.advance(RETRY_MS - POLL_MS)
    expect(seen.fetches).toBe(1)
    await clock.advance(POLL_MS)
    expect(seen.fetches).toBe(2)
  })

  test('keeps the old list when a refresh fails, and waits REFRESH_MS to try again', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    let isDown = false
    const seen = api(on, listDown(() => isDown))
    await startTurn($, clock)
    isDown = true
    await clock.advance(REFRESH_MS)
    expect(seen.fetches).toBe(2)
    await clock.advance(RETRY_MS)
    expect(seen.fetches).toBe(2)
    const ui = await mount($, 'terminal')
    expect((await lines(ui))[0]).toBe('1. Mistral Large 4 (docs.mistral.ai)')
    await $.command.run(SLASH_HACKERNEWS)
    expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe(
      'The spinner shows the Hacker News front page as last fetched, but it could not be fetched again: topstories.json answered 503',
    )
  })

  test('gives up on a front page that does not answer, and fetches again later', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    let isHung = false
    // Long past the timeout, but within the test, so nothing is left waiting.
    const seen = api(on, url => (url === itemUrl(ASK.id) && isHung ? clock.sleep(60 * 1000).then(() => undefined) : undefined))
    await startTurn($, clock)
    isHung = true
    await clock.advance(REFRESH_MS)
    expect(seen.fetches).toBe(2)
    await clock.advance(TIMEOUT_MS)

    const ui = await mount($, 'terminal')
    expect((await lines(ui))[0]).toBe('1. Mistral Large 4 (docs.mistral.ai)')
    await ui.unmount()
    await $.command.run(SLASH_HACKERNEWS)
    expect((await $.command.run(SLASH_HACKERNEWS)).text).toBe(
      'The spinner shows the Hacker News front page as last fetched, but it could not be fetched again: Hacker News did not answer within 8 seconds',
    )
    isHung = false
    await clock.advance(REFRESH_MS)
    expect(seen.fetches).toBe(3)
  })

  test('/hackernews joins a fetch under way rather than starting another', async ($, on) => {
    const clock = mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on, url => (url === TOP_STORIES_URL ? clock.sleep(500).then(() => undefined) : undefined))
    await startTurn($, clock)
    const reply = $.command.run(SLASH_NEXT)
    await clock.settle()
    await clock.advance(500)
    expect((await reply).text).toBe('Next up: 1. Mistral Large 4')
    expect(seen.fetches).toBe(1)
  })

  test('/hackernews fetches the front page when it has none to answer with', async ($, on) => {
    mock.clock(on, { now: HOUR_LATER })
    engine(on)
    const seen = api(on)
    await startSession($)
    expect((await $.command.run(SLASH_NEXT)).text).toBe('Next up: 1. Mistral Large 4')
    expect(seen.fetches).toBe(1)
  })
})
