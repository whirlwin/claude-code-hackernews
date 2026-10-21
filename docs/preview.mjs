// Draws one story's worth of the logo as a strip for the README: the roll, a
// frame at rest and the shine, from the same pixels the spinner packs. Each
// quadrant pixel is 8 by 16, half a terminal cell each way, so the tile keeps
// the shape it has in the terminal. A PNG is simple enough to write by hand,
// which keeps the repo free of dependencies.
// Needs Node 22.18 or later, for unflagged .ts imports and zlib.crc32.
import { writeFileSync } from 'node:fs'
import { crc32, deflateSync } from 'node:zlib'

import { LOGO_COLUMNS, LOGO_ROWS, pixels } from '../hooks/logo.ts'

const [out] = process.argv.slice(2)
if (out === undefined) {
  console.error('usage: node docs/preview.mjs <out.png>')
  process.exit(1)
}

// logo.ts keeps its timing private, so these follow it by hand: the roll is
// frames 0 to 8, the letters have settled by 9 and the shine crosses from 20.
const SHOWN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22, 23, 24, 25]

const WIDTH = LOGO_COLUMNS * 2
const HEIGHT = LOGO_ROWS * 2
const PIXEL_WIDTH = 8
const PIXEL_HEIGHT = 16
const GAP = 16
const BACKGROUND = 0x1e1e1e

const frameWidth = WIDTH * PIXEL_WIDTH
const frameHeight = HEIGHT * PIXEL_HEIGHT
const width = GAP + SHOWN.length * (frameWidth + GAP)
const height = frameHeight + 2 * GAP
// Each scanline starts with its filter type, left at 0 (none).
const stride = 1 + width * 3
const raw = Buffer.alloc(height * stride)

function fill(left, top, w, h, color) {
  for (let y = top; y < top + h; y++) {
    for (let x = left; x < left + w; x++) {
      const at = y * stride + 1 + x * 3
      raw[at] = (color >> 16) & 0xff
      raw[at + 1] = (color >> 8) & 0xff
      raw[at + 2] = color & 0xff
    }
  }
}

fill(0, 0, width, height, BACKGROUND)
SHOWN.forEach((t, i) => {
  const p = pixels(t)
  const left = GAP + i * (frameWidth + GAP)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      fill(left + x * PIXEL_WIDTH, GAP + y * PIXEL_HEIGHT, PIXEL_WIDTH, PIXEL_HEIGHT, p[y * WIDTH + x])
    }
  }
})

function chunk(type, data) {
  const bytes = Buffer.alloc(12 + data.length)
  bytes.writeUInt32BE(data.length, 0)
  bytes.write(type, 4, 'latin1')
  data.copy(bytes, 8)
  bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length)
  return bytes
}

// 8 bits per channel, truecolor, no interlace.
const header = Buffer.alloc(13)
header.writeUInt32BE(width, 0)
header.writeUInt32BE(height, 4)
header[8] = 8
header[9] = 2

writeFileSync(
  out,
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
