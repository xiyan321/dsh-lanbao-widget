/**
 * 出一张五连对比图，检查各表情的角色比例是否一致（换图后特别有用）。
 *
 * 用法：node tools/contact-sheet.mjs
 * 产物：tools/contact-sheet.png（已被 .gitignore 排除）
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSharp } from './lib/deps.mjs'

const sharp = loadSharp()
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NAMES = ['idle', 'thinking', 'busy', 'happy', 'confused']
const TILE = 300
const BG = { r: 92, g: 122, b: 164 }

const tiles = []
for (let i = 0; i < NAMES.length; i++) {
  const buf = await sharp(path.join(ROOT, 'assets', 'expressions', `${NAMES[i]}.webp`))
    .resize(TILE, TILE)
    .flatten({ background: BG })
    .png()
    .toBuffer()
  tiles.push({ input: buf, left: i * TILE, top: 0 })
}

await sharp({ create: { width: TILE * NAMES.length, height: TILE, channels: 3, background: BG } })
  .composite(tiles)
  .png()
  .toFile(path.join(ROOT, 'tools', 'contact-sheet.png'))

console.log('ok → tools/contact-sheet.png')
