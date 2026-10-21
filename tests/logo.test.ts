import { describe, expect, test } from 'claude-code/testing'

import { FRAMES_PER_STORY, LOGO_COLUMNS, LOGO_ROWS, ORANGE, TICK_MS, WHITE, frame, paint, pixels } from '../hooks/logo'

// The tile as approved, '#' white and '.' orange. The tests keep their own
// copy, so a slip in the module's map cannot pass by agreeing with itself.
const REST = [
  '............',
  '.#..#.#...#.',
  '.####.##..#.',
  '.#..#.#.#.#.',
  '.#..#.#..##.',
  '............',
]
const WIDTH = LOGO_COLUMNS * 2
const HEIGHT = LOGO_ROWS * 2
const BLANK = '.'.repeat(WIDTH)
const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'
const GLYPHS = new Set([...QUADRANTS].map(ch => ch.charCodeAt(0)))

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i)
}

// The story's timeline, written out rather than imported so the tests pin the
// approved timing: the letters have settled by frame 9, and the shine crosses
// the tile from frame 20, a cell column a frame.
const SETTLED = 9
const SHINE_AT = 20
const AT_REST = [...range(SETTLED, SHINE_AT), ...range(SHINE_AT + LOGO_COLUMNS, FRAMES_PER_STORY)]

function rows(flat: readonly string[]): string[] {
  return range(0, HEIGHT).map(y => flat.slice(y * WIDTH, (y + 1) * WIDTH).join(''))
}

// The picture as rows of characters, so a failure prints the art; any color
// but the two shows up as '?'.
function art(p: Uint32Array): string[] {
  return rows([...p].map(color => (color === WHITE ? '#' : color === ORANGE ? '.' : '?')))
}

// What the terminal shows: each cell's glyph lights its white quadrants.
function unpack(cells: Uint32Array): string[] {
  const flat = new Array<string>(WIDTH * HEIGHT).fill('?')
  for (let i = 0; i < LOGO_COLUMNS * LOGO_ROWS; i++) {
    const mask = QUADRANTS.indexOf(String.fromCharCode(cells[i * 3] ?? 0))
    const x = (i % LOGO_COLUMNS) * 2
    const y = Math.floor(i / LOGO_COLUMNS) * 2
    for (let bit = 0; bit < 4; bit++) {
      flat[(y + (bit >> 1)) * WIDTH + x + (bit % 2)] = mask & (1 << bit) ? '#' : '.'
    }
  }
  return rows(flat)
}

// The rest picture with the letters moved down by `offset` rows (up when
// negative), whatever leaves the tile dropped.
function shifted(offset: number): string[] {
  return range(0, HEIGHT).map(y => REST[y - offset] ?? BLANK)
}

describe('logo', () => {
  test('keeps the approved size, timing and colors', async () => {
    expect([LOGO_COLUMNS, LOGO_ROWS, TICK_MS, FRAMES_PER_STORY, ORANGE, WHITE]).toEqual([6, 3, 150, 40, 0xff6600, 0xffffff])
  })

  test('rests on the approved tile between the roll and the shine', async () => {
    for (const f of AT_REST) {
      expect(art(pixels(f))).toEqual(REST)
      expect(unpack(paint(f))).toEqual(REST)
    }
  })

  test('every frame packs white quadrant glyphs on orange', async () => {
    for (let t = 0; t < FRAMES_PER_STORY; t++) {
      const cells = paint(t)
      expect(cells.length).toBe(LOGO_COLUMNS * LOGO_ROWS * 3)
      for (let i = 0; i < cells.length; i += 3) {
        expect(GLYPHS.has(cells[i] ?? 0)).toBe(true)
        expect(cells[i + 1]).toBe(WHITE)
        expect(cells[i + 2]).toBe(ORANGE)
      }
    }
  })

  test('the cells show exactly the picture, which is only orange and white', async () => {
    for (let t = 0; t < FRAMES_PER_STORY; t++) {
      const picture = art(pixels(t))
      expect(picture.join('')).not.toContain('?')
      expect(unpack(paint(t))).toEqual(picture)
    }
  })

  test('the letters roll up and out, then back in from below, as a story starts', async () => {
    expect(art(pixels(0))).toEqual([...REST.slice(1), BLANK])
    expect(art(pixels(4))).toEqual(range(0, HEIGHT).map(() => BLANK))
    expect(art(pixels(5))).toEqual([BLANK, BLANK, BLANK, BLANK, BLANK, '.#..#.#...#.'])
    const offsets = [-1, -2, -3, -4, -5, 4, 3, 2, 1, 0]
    offsets.forEach((offset, f) => expect(art(pixels(f))).toEqual(shifted(offset)))
  })

  test('a shine sweeps left to right, inverting one cell column a frame', async () => {
    const rest = paint(SETTLED)
    for (let band = 0; band < LOGO_COLUMNS; band++) {
      const cells = paint(SHINE_AT + band)
      for (let i = 0; i < LOGO_COLUMNS * LOGO_ROWS; i++) {
        const glyph = cells[i * 3]
        const was = rest[i * 3] ?? 0
        const inverted = QUADRANTS.charCodeAt(15 - QUADRANTS.indexOf(String.fromCharCode(was)))
        expect(glyph).toBe(i % LOGO_COLUMNS === band ? inverted : was)
        expect(cells[i * 3 + 1]).toBe(WHITE)
        expect(cells[i * 3 + 2]).toBe(ORANGE)
      }
    }
  })

  // A round trip, so a wrong byte order, alphabet or padding cannot pass.
  test('encodes every cell word as little-endian base64', async () => {
    for (let t = 0; t < FRAMES_PER_STORY; t++) {
      const words = paint(t)
      const bytes = Uint8Array.from(atob(frame(t)), ch => ch.charCodeAt(0))
      expect(bytes.length).toBe(words.length * 4)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < words.length; i++) expect(view.getUint32(i * 4, true)).toBe(words[i])
    }
  })

  test('plays the same animation for every story', async () => {
    for (let t = 0; t < FRAMES_PER_STORY; t++) {
      expect(frame(t + FRAMES_PER_STORY)).toBe(frame(t))
      expect(frame(t + 7 * FRAMES_PER_STORY)).toBe(frame(t))
    }
  })
})
