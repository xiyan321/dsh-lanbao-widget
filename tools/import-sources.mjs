/**
 * 把设计稿整理进仓库：缩到 1024 长边、存成 JPEG，作为可复现的素材来源。
 * 原图（~2MB/张）不进仓库；需要全分辨率时用 LANBAO_SRC 指向设计稿目录。
 *
 * 产物：
 *   assets/source/{idle,thinking,busy,happy,confused}.jpg   ← prepare-images 的输入
 *   docs/design-sheet.jpg                                  ← 角色设定图，供 README 引用
 *
 * 用法：node tools/import-sources.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSharp } from './lib/deps.mjs'

const sharp = loadSharp()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC_DIR = process.env.LANBAO_SRC || path.resolve(ROOT, '..', '蓝宝形象设计')
const OUT_DIR = path.join(ROOT, 'assets', 'source')
const DOCS = path.join(ROOT, 'docs')

const FILES = [
  ['待机.jpeg', path.join(OUT_DIR, 'idle.jpg')],
  ['思考中.png', path.join(OUT_DIR, 'thinking.jpg')],
  ['忙碌.jpeg', path.join(OUT_DIR, 'busy.jpg')],
  ['开心.jpeg', path.join(OUT_DIR, 'happy.jpg')],
  ['疑惑.jpeg', path.join(OUT_DIR, 'confused.jpg')],
  ['设定.jpg', path.join(DOCS, 'design-sheet.jpg')],
]

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(DOCS, { recursive: true })

for (const [from, dest] of FILES) {
  const src = path.join(SRC_DIR, from)
  if (!fs.existsSync(src)) {
    console.error(`缺少设计稿：${src}\n用 LANBAO_SRC=<目录> 指定。`)
    process.exit(1)
  }
  await sharp(src)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4', mozjpeg: true })
    .toFile(dest)
  const rel = dest.startsWith(ROOT) ? dest.slice(ROOT.length + 1) : dest
  console.log(`${from} → ${rel}  ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`)
}
