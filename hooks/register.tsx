import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { REFRESH_MS, byline, comments, fetchTop, label } from './hn'
import type { Story } from './hn'
import { FRAMES_PER_STORY, LOGO_COLUMNS, LOGO_ROWS, ORANGE, TICK_MS, frame } from './logo'

const isHidden = atom({ plugin: 'hackernews', key: 'isHidden' } as const, false)

const RASTER = 'hn'
// Rounded down, so the timer is redrawn a little more often than each second
// rather than a little less, which skipped a second now and then.
const TICKS_PER_SECOND = Math.floor(1000 / TICK_MS)
const RANK_COLOR = `#${ORANGE.toString(16).padStart(6, '0')}`
// How often a running turn checks whether the front page is due.
const POLL_MS = 1000
// With no list to show at all, a failed fetch is tried again well before
// REFRESH_MS, so a blip does not leave the spinner without a story for five
// minutes.
const RETRY_MS = 30 * 1000
// $.http.fetch has no timeout of its own, and a request that never answers
// would hold every later refresh behind it. Under the 10 s hook budget, as
// /hackernews waits for a fetch.
const FETCH_TIMEOUT_MS = 8 * 1000

// The front page as last fetched. An object rather than variables of
// register's own: the engine lets `$` be handed only to a function declared
// at the top of the file, and refresh needs both.
type Front = {
  stories: Story[]
  // Why the last fetch failed, for /hackernews to say; null when it worked.
  problem: string | null
  attemptedAt: number | null
  // The fetch under way, which a second caller joins rather than starting
  // another round of requests beside it.
  fetching: Promise<void> | null
}

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function refresh($: EngineInterface, front: Front): Promise<void> {
  front.fetching ??= (async () => {
    let timer: Timer | undefined
    try {
      front.attemptedAt = await $.clock.now()
      const timeout = new Promise<never>((_, reject) => {
        timer = $.clock.after(FETCH_TIMEOUT_MS, () => {
          reject(new Error(`Hacker News did not answer within ${FETCH_TIMEOUT_MS / 1000} seconds`))
        })
      })
      front.stories = await Promise.race([fetchTop(url => $.http.fetch(url)), timeout])
      front.problem = null
      $.ui.invalidate('ui.render')
    } catch (error) {
      // The list stays as it was, and so does the drawing: stale headlines
      // beat none.
      front.problem = error instanceof Error ? error.message : String(error)
    } finally {
      timer?.cancel()
    }
  })().finally(() => {
    front.fetching = null
  })
  return front.fetching
}

export const register: Register = on => {
  let tick = 0
  // The spinner as last drawn, which the timer repaints between draws.
  let spinner: string | null = null
  // Whether a surface without a Raster shows a story as the spinner's word.
  // Nothing there can be blitted, so no deny says it went: the main turn's end
  // does.
  let isWordShown = false
  // When each spinner first drew: drawing a tree replaces the engine's own
  // elapsed time, so the mod keeps its own.
  const startedAt = new Map<string, number>()
  let isTurnRunning = false
  const front: Front = { stories: [], problem: null, attemptedAt: null, fetching: null }

  function storyAt(t: number): Story | null {
    return front.stories[Math.floor(t / FRAMES_PER_STORY) % front.stories.length] ?? null
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'hackernews',
      description: 'Show or hide the Hacker News front page in the spinner; "next" skips to the next story',
      argumentHint: '[next]',
    })

    // Only while something shows a story, so the rotation picks up at the next
    // turn where it left off rather than having moved on unseen. A word drawn
    // after the turn ended (a last desktop draw) shows nothing for long.
    $.clock.every(TICK_MS, () => {
      if (spinner === null && !(isWordShown && isTurnRunning)) return
      tick += 1
      // The story and the timer are text, so a new story or second is a
      // redraw; a surface showing only the word keeps its own timer.
      if (tick % FRAMES_PER_STORY === 0 || (spinner !== null && tick % TICKS_PER_SECOND === 0)) {
        $.ui.invalidate('ui.render')
        return
      }
      if (spinner === null) return
      const requestId = spinner
      void $.ui.blit({ requestId, key: RASTER, cells: frame(tick) }).then(result => {
        if (result.deny !== undefined && spinner === requestId) {
          spinner = null
          startedAt.delete(requestId)
        }
      })
    })

    // Only while a turn runs: between turns there is no spinner to show it.
    $.clock.every(POLL_MS, () => {
      if (!isTurnRunning || front.fetching !== null) return
      void (async () => {
        const wait = front.stories.length === 0 && front.problem !== null ? RETRY_MS : REFRESH_MS
        if (front.attemptedAt !== null && (await $.clock.now()) - front.attemptedAt < wait) return
        if (await read($, isHidden)) return
        // The tile has rolled on while there was no list: the first one
        // starts at rank 1.
        const hadNone = front.stories.length === 0
        await refresh($, front)
        if (hadNone && front.stories.length > 0) tick = 0
      })()
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's or teammate's run starts here too, and ends with an
    // agentId, so only the main loop's start starts the fetches.
    if (e.agentId === undefined) isTurnRunning = true
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ends here too, inside the main turn, so only the main
    // loop's end stops the fetches. The list is kept: the next turn shows it
    // at once.
    if (e.agentId === undefined) {
      isTurnRunning = false
      isWordShown = false
      // A spinner hidden mid-turn was never denied a blit, so its start would
      // otherwise carry over into the next turn's time.
      startedAt.clear()
    }
    return next(e)
  })

  on('command.run', { command: 'hackernews' }, async ($, e) => {
    const isNext = e.args.trim() === 'next'
    const hadNone = front.stories.length === 0
    if (isNext) {
      tick = (Math.floor(tick / FRAMES_PER_STORY) + 1) * FRAMES_PER_STORY
      await update($, isHidden, () => false)
      $.ui.invalidate('ui.render')
    } else if (await update($, isHidden, was => !was)) {
      return { text: 'The spinner no longer shows Hacker News.' }
    }
    // Between turns nothing fetches, so with no list yet the answer would
    // have nothing to say. The first list starts at rank 1, skipped or not.
    if (hadNone) {
      await refresh($, front)
      if (front.stories.length > 0) tick = 0
    }
    const story = storyAt(tick)
    if (isNext) {
      if (story !== null) return { text: `Next up: ${label(story)}` }
      if (front.problem !== null) return { text: `The front page could not be fetched: ${front.problem}` }
      return { text: 'The front page is still loading.' }
    }
    const shows = 'The spinner shows the Hacker News front page'
    if (front.problem === null) return { text: `${shows}.` }
    if (story === null) return { text: `${shows}, but it could not be fetched: ${front.problem}` }
    return { text: `${shows} as last fetched, but it could not be fetched again: ${front.problem}` }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (await read($, isHidden)) {
      spinner = null
      isWordShown = false
      return next(e)
    }
    const story = storyAt(tick)
    if (e.surface !== 'terminal') {
      if (story === null) return next(e)
      isWordShown = true
      return next({ ...e, props: { ...e.props, word: label(story) } })
    }

    const now = await $.clock.now()
    const start = startedAt.get(e.requestId) ?? now
    startedAt.set(e.requestId, start)
    spinner = e.requestId
    const time = ` (${elapsed(now - start)})`
    const { Box, Link, Raster, Text } = $.ui.resolve(e)

    let lines
    if (story === null || e.props.message !== null) {
      // The engine's own state (compacting, say) outranks the story, and
      // before the first list there is no story: either way its words show.
      const text = e.props.message ?? e.props.word
      // As the engine draws it: its ellipsis left off a text ending in one,
      // a suffix another mod rewrote drawn as handed.
      const suffix = text.endsWith('\u2026') && e.props.suffix === '\u2026' ? '' : e.props.suffix
      lines = (
        <Text wrap="truncate-end">
          {text}
          {suffix}
          <Text dimColor>{time}</Text>
        </Text>
      )
    } else {
      // The second line starts under the title, as HN indents it.
      const rank = `${story.rank}.`
      lines = [
        <Text wrap="truncate-end">
          <Text color={RANK_COLOR}>{rank}</Text>{' '}
          <Link href={story.href}>{story.title}</Link>
          {story.domain === null ? null : <Text dimColor> ({story.domain})</Text>}
        </Text>,
        <Text dimColor wrap="truncate-end">
          {' '.repeat(rank.length + 1)}
          {byline(story, now)}
          {story.comments === null ? null : [' | ', <Link href={story.threadHref}>{comments(story.comments)}</Link>]}
          {time}
        </Text>,
      ]
    }

    // One line centers on the three-row tile; two cannot, and centering them
    // flipped between the top rows and the bottom ones, so they sit at the top.
    return (
      <Box flexDirection="row">
        <Raster key={RASTER} columns={LOGO_COLUMNS} rows={LOGO_ROWS} cells={frame(tick)} />
        <Box flexDirection="column" justifyContent={Array.isArray(lines) ? 'flex-start' : 'center'} marginLeft={1}>
          {lines}
        </Box>
      </Box>
    )
  })
}
