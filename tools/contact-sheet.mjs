/** 出一张 5 连对比图，检查新表情与其它四张的比例是否一致。 */
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/lenovo/.dsh/profiles/web/package.json')
const sharp = require('sharp')

const ROOT = 'D:/develp/test/dsh-lanbao-widget'
const NAMES = ['idle', 'thinking', 'busy', 'happy', 'confused']
const TILE = 300

const tiles = []
for (let i = 0; i < NAMES.length; i++) {
  const buf = await sharp(`${ROOT}/assets/expressions/${NAMES[i]}.webp`)
    .resize(TILE, TILE)
    .flatten({ background: { r: 92, g: 122, b: 164 } })
    .png()
    .toBuffer()
  tiles.push({ input: buf, left: i * TILE, top: 0 })
}

await sharp({ create: { width: TILE * NAMES.length, height: TILE, channels: 3, background: { r: 92, g: 122, b: 164 } } })
  .composite(tiles)
  .png()
  .toFile(`${ROOT}/tools/contact-sheet.png`)

console.log('ok → tools/contact-sheet.png')
