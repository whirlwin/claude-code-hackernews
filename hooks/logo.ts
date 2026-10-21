// The spinner's HN tile: a canvas of quadrant pixels, four to a terminal cell,
// packed into Raster cells.

export const LOGO_COLUMNS = 6
export const LOGO_ROWS = 3
export const TICK_MS = 150
// A story stays up for 6 s at TICK_MS.
export const FRAMES_PER_STORY = 40
export const ORANGE = 0xff6600
export const WHITE = 0xffffff

const WIDTH = LOGO_COLUMNS * 2
const HEIGHT = LOGO_ROWS * 2

// The tile at rest, '#' white and '.' orange, orange to every edge so no pixel
// falls back to the terminal's own background.
const TILE = [
  '............',
  '.#..#.#...#.',
  '.####.##..#.',
  '.#..#.#.#.#.',
  '.#..#.#..##.',
  '............',
]

// The letters' offset from rest over a story's first frames: up and out (-5
// clears the tile), then back in from below, like a ticker flipping.
const ROLL = [-1, -2, -3, -4, -5, 4, 3, 2, 1]
// Midway through a story a shine crosses the tile, one cell column a frame.
const SHINE_AT = 20

type Canvas = Uint32Array

function set(c: Canvas, x: number, y: number, color: number): void {
  if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) c[y * WIDTH + x] = color
}

function get(c: Canvas, x: number, y: number): number {
  return c[y * WIDTH + x] ?? ORANGE
}

// A band exactly one cell column wide flips each cell under it whole, to its
// complement glyph, and crosses the tile in LOGO_COLUMNS frames.
function shine(c: Canvas, f: number): void {
  const col = f - SHINE_AT
  if (col < 0 || col >= LOGO_COLUMNS) return
  for (let y = 0; y < HEIGHT; y++) {
    for (const x of [col * 2, col * 2 + 1]) set(c, x, y, get(c, x, y) === WHITE ? ORANGE : WHITE)
  }
}

// Exported for docs/preview.mjs, which draws the README's strip from it.
export function pixels(t: number): Uint32Array {
  const f = t % FRAMES_PER_STORY
  const c: Canvas = new Uint32Array(WIDTH * HEIGHT).fill(ORANGE)
  // The border rows are plain orange, so shifting the whole picture moves only
  // the letters; `set` drops whatever lands outside the tile.
  const offset = ROLL[f] ?? 0
  for (let y = 0; y < HEIGHT; y++) {
    const line = TILE[y] ?? ''
    for (let x = 0; x < WIDTH; x++) {
      if (line[x] === '#') set(c, x, y + offset, WHITE)
    }
  }
  shine(c, f)
  return c
}

// Indexed by which quadrants hold the foreground: 1 upper left, 2 upper
// right, 4 lower left, 8 lower right.
const QUADRANTS = ' ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█'

// Every cell is white on orange, so the glyph alone says which quadrants are
// white: a plain orange cell is a space, a shined one a full block.
export function paint(t: number): Uint32Array {
  const c = pixels(t)
  const cells = new Uint32Array(LOGO_COLUMNS * LOGO_ROWS * 3)
  for (let row = 0; row < LOGO_ROWS; row++) {
    for (let col = 0; col < LOGO_COLUMNS; col++) {
      const x = col * 2
      const y = row * 2
      const quadrants = [get(c, x, y), get(c, x + 1, y), get(c, x, y + 1), get(c, x + 1, y + 1)]
      const mask = quadrants.reduce((m, p, i) => (p === WHITE ? m | (1 << i) : m), 0)
      cells.set([QUADRANTS.charCodeAt(mask), WHITE, ORANGE], (row * LOGO_COLUMNS + col) * 3)
    }
  }
  return cells
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Raster cells are little-endian u32s; typed arrays use the host's order,
// which is little-endian on every platform Claude Code ships for.
function encode(words: Uint32Array): string {
  const bytes = new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const d = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | d
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }
  return out
}

export function frame(t: number): string {
  return encode(paint(t))
}
