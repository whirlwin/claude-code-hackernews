// The Hacker News front page from the official Firebase API. Every response
// is untrusted: it is parsed field by field and drawn on a terminal.

export const TOP_STORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json'
// As many stories as news.ycombinator.com shows on its first page.
export const TOP_COUNT = 30
// The front page moves slowly, and each refresh costs one request per story.
export const REFRESH_MS = 5 * 60 * 1000

// The engine's Link takes an href of at most 2048 characters once
// percent-encoded, so past this the story links to its thread instead.
const MAX_HREF = 2048

// C0 and C1 controls, which could end the OSC 8 hyperlink a title is drawn
// in, and bidi overrides and isolates, which could reorder the line around it.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export type Story = {
  id: number
  // The position in topstories.json, so a skipped item leaves a gap rather
  // than renumbering the stories below it.
  rank: number
  title: string
  href: string
  domain: string | null
  // Unix seconds.
  time: number
  // All three null for a job post, which HN shows with only its age; `by` is
  // null as well when the item names no author.
  points: number | null
  by: string | null
  comments: number | null
  threadHref: string
}

// The subset of $.http.fetch's result this module reads, so it stays testable
// without the engine.
export type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text: string }>

export function itemUrl(id: number): string {
  return `https://hacker-news.firebaseio.com/v0/item/${id}.json`
}

export function threadUrl(id: number): string {
  return `https://news.ycombinator.com/item?id=${id}`
}

function isPositiveInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0
}

function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0
}

// Whitespace first, so a tab, newline or NEL (controls too, and NEL is not in
// \s) stays a word break instead of gluing two words; again after, for the
// spaces a removed control leaves side by side.
function clean(text: string): string {
  return text.replace(/[\s\u0085]+/g, ' ').replace(UNSAFE, '').replace(/\s+/g, ' ').trim()
}

// The serialized URL rather than the string HN sent: serializing
// percent-encodes controls and bidi characters, which in the raw string
// would break out of the hyperlink just as they would in a title.
function article(url: unknown): { href: string; domain: string } | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.href.length > MAX_HREF) return null
  return { href: parsed.href, domain: parsed.hostname.replace(/^www\./, '') || parsed.hostname }
}

/**
 * The first TOP_COUNT story ids of topstories.json, or null when the body is
 * not a list of ids.
 */
export function parseTopIds(text: string): number[] | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(value)) return null
  const ids: unknown[] = value.slice(0, TOP_COUNT)
  return ids.every(isPositiveInt) ? ids : null
}

/**
 * The story an item answered, at `rank` on the front page, or null when it
 * is gone, is not a front page item, or does not hold one.
 */
export function parseItem(text: string, rank: number): Story | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  if (item.dead === true || item.deleted === true) return null
  const { id, type, time } = item
  if (type !== 'story' && type !== 'job' && type !== 'poll') return null
  if (!isPositiveInt(id) || !isPositiveInt(time)) return null
  const title = typeof item.title === 'string' ? clean(item.title) : ''
  if (title === '') return null
  const link = article(item.url)
  const threadHref = threadUrl(id)
  const isJob = type === 'job'
  // Jobs carry a score and an author in the API, but HN shows neither. The
  // author is drawn on the same line as the title, so it is cleaned as one.
  const by = !isJob && typeof item.by === 'string' ? clean(item.by) : ''
  return {
    id,
    rank,
    title,
    href: link?.href ?? threadHref,
    domain: link?.domain ?? null,
    points: isJob ? null : count(item.score),
    by: by === '' ? null : by,
    time,
    comments: isJob ? null : count(item.descendants),
    threadHref,
  }
}

/**
 * The front page in rank order, leaving out the items that could not be read.
 * Throws, in words fit to show the person, when the list itself cannot be
 * read or none of its stories can. A request for the list that fails or is
 * refused rejects with the host's own reason.
 */
export async function fetchTop(fetch: Fetch): Promise<Story[]> {
  const top = await fetch(TOP_STORIES_URL)
  if (!top.ok) throw new Error(`topstories.json answered ${top.status}`)
  const ids = parseTopIds(top.text)
  if (ids === null) throw new Error('topstories.json did not hold a list of story ids')
  if (ids.length === 0) throw new Error('topstories.json listed no stories')
  const stories = await Promise.all(
    ids.map(async (id, i) => {
      try {
        const answer = await fetch(itemUrl(id))
        if (!answer.ok) return null
        const story = parseItem(answer.text, i + 1)
        // An item answering for another id would link to the wrong thread.
        return story?.id === id ? story : null
      } catch {
        return null
      }
    }),
  )
  const read = stories.filter((story): story is Story => story !== null)
  if (read.length === 0) throw new Error(`none of the top ${ids.length} stories could be read`)
  return read
}

export function points(n: number): string {
  return n === 1 ? '1 point' : `${n} points`
}

/**
 * The comment count as HN words it, `discuss` while there are none.
 */
export function comments(n: number): string {
  if (n === 0) return 'discuss'
  return n === 1 ? '1 comment' : `${n} comments`
}

/**
 * How long ago `timeSec` was, as HN words it. A story from the future (the
 * clock here behind HN's) reads as just posted.
 */
export function ago(nowMs: number, timeSec: number): string {
  const minutes = Math.max(1, Math.floor((nowMs / 1000 - timeSec) / 60))
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day ago' : `${days} days ago`
}

/**
 * `233 points by whirlwin 1 hour ago`, or just the age for a job. The
 * comments are left out: they are drawn on their own, as a link.
 */
export function byline(story: Story, nowMs: number): string {
  const age = ago(nowMs, story.time)
  if (story.points === null) return age
  const by = story.by === null ? '' : ` by ${story.by}`
  return `${points(story.points)}${by} ${age}`
}

/**
 * `7. Mistral Large 4`, the spinner's word where it cannot draw a link.
 */
export function label(story: Story): string {
  return `${story.rank}. ${story.title}`
}
