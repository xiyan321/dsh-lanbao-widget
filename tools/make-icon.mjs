/**
 * 生成插件图标：把「开心」表情放在柔和的蓝底圆角方块上。
 *
 * 用法：node tools/make-icon.mjs
 * 产物：icon.png
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSharp } from './lib/deps.mjs'

const sharp = loadSharp()
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const face = await sharp(path.join(ROOT, 'assets', 'expressions', 'happy.webp'))
  .resize(224, 224, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .toBuffer()

const bg = Buffer.from(
  '<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#eef4fd"/><stop offset="1" stop-color="#c9dcf7"/>' +
    '</linearGradient></defs>' +
    '<rect width="256" height="256" rx="58" fill="url(#g)"/>' +
    '<circle cx="128" cy="150" r="86" fill="#ffffff" opacity="0.55"/>' +
    '</svg>',
)

await sharp(bg)
  .composite([{ input: face, left: 16, top: 22 }])
  .png()
  .toFile(path.join(ROOT, 'icon.png'))

console.log('icon.png 已生成')
