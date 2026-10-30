/**
 * 蓝宝表情素材预处理：把设计稿（白底方图）转成带透明通道、统一尺寸的 PNG。
 *
 * 三步：
 *  1. 从画面左/右/上三边做「近白泛洪」，抠掉与边框连通的白色背景。
 *     底边不参与泛洪，且最后两行强制透明 —— 设计稿里角色是被底边裁切的，
 *     若允许从底边进入，白色帽兜会被一起抠穿。
 *  2. 对 alpha 做一次 1px 盒式模糊，去掉锯齿。
 *  3. 五张图**共用**同一个方形裁切框（各图轮廓的并集，取最大边），
 *     这样换表情时角色不会忽大忽小，同时把大片透明留白裁掉。
 *
 * 用法：node tools/prepare-images.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// sharp 装在 DSH web profile 里，借它解码/编码，避免本包再依赖原生模块。
const PROFILE_PKG = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'profiles', 'web', 'package.json')
const require = createRequire(PROFILE_PKG)
const sharp = require('sharp')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '..', 'assets', 'expressions')
/** 设计稿目录：默认取仓库同级的「蓝宝形象设计」，也可以用 LANBAO_SRC 指过去。 */
const SRC_DIR = process.env.LANBAO_SRC || path.resolve(HERE, '..', '..', '蓝宝形象设计')
const OUT_SIZE = 640
const WORK_SIZE = 900
/** 裁切框在轮廓外再留出多少（相对边长），免得贴边。 */
const PADDING_RATIO = 0.03

const NAMES = ['idle', 'thinking', 'busy', 'happy', 'confused']
const LABELS = { idle: '待机', thinking: '思考', busy: '忙碌', happy: '开心', confused: '疑惑' }
/**
 * 表情名 → 设计稿文件名（原图扩展名与实际编码并不一致，sharp 按内容嗅探，无妨）。
 * 优先用仓库自带的 assets/source/*.jpg；没有才去设计稿目录找原始中文文件名。
 */
const SOURCES = {
  idle: '待机.jpeg',
  thinking: '思考.jpeg',
  busy: '忙碌.jpeg',
  happy: '开心.jpeg',
  confused: '疑惑.jpeg',
}

/** 返回该表情实际要读的文件；两个位置都没有就返回 null。 */
function sourceOf(name) {
  const bundled = path.resolve(HERE, '..', 'assets', 'source', `${name}.jpg`)
  if (fs.existsSync(bundled)) return bundled
  const original = path.join(SRC_DIR, SOURCES[name])
  if (fs.existsSync(original)) return original
  return null
}

if (!fs.existsSync(SRC_DIR) && !fs.existsSync(path.resolve(HERE, '..', 'assets', 'source'))) {
  console.error(`找不到素材：既没有 ${SRC_DIR}，也没有 assets/source/。\n用 LANBAO_SRC=<目录> 指定设计稿目录。`)
  process.exit(1)
}

/** 近白判定：三通道都够亮，且色偏很小（白底通常是纯白或极淡的冷白）。 */
function isWhitish(r, g, b) {
  if (r < 233 || g < 233 || b < 233) return false
  return Math.max(r, g, b) - Math.min(r, g, b) <= 16
}

/** 从三边泛洪，返回需要置透明的像素掩码。 */
function floodBackground({ data, width, height, channels }) {
  const total = width * height
  const bg = new Uint8Array(total)
  const stack = new Int32Array(total)
  let sp = 0

  const tryPush = (idx) => {
    if (bg[idx]) return
    const o = idx * channels
    if (!isWhitish(data[o], data[o + 1], data[o + 2])) return
    bg[idx] = 1
    stack[sp++] = idx
  }

  for (let x = 0; x < width; x++) tryPush(x)
  for (let y = 0; y < height - 1; y++) {
    tryPush(y * width)
    tryPush(y * width + width - 1)
  }

  while (sp > 0) {
    const idx = stack[--sp]
    const x = idx % width
    const y = (idx - x) / width
    if (y >= height - 1) continue // 底边封口：绝不向最后一行扩散
    if (x > 0) tryPush(idx - 1)
    if (x < width - 1) tryPush(idx + 1)
    if (y > 0) tryPush(idx - width)
    if (y < height - 2) tryPush(idx + width)
  }

  return bg
}

/** 对 alpha 做一次可分离盒式模糊（半径 1），顺带把底边两行清空。 */
function softenAlpha(alpha, width, height) {
  const tmp = new Float32Array(alpha.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      let sum = alpha[i]
      let n = 1
      if (x > 0) { sum += alpha[i - 1]; n++ }
      if (x < width - 1) { sum += alpha[i + 1]; n++ }
      tmp[i] = sum / n
    }
  }
  const out = new Uint8ClampedArray(alpha.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      let sum = tmp[i]
      let n = 1
      if (y > 0) { sum += tmp[i - width]; n++ }
      if (y < height - 1) { sum += tmp[i + width]; n++ }
      out[i] = y >= height - 2 ? 0 : Math.round(sum / n)
    }
  }
  return out
}

/** 把一组图处理成「背景透明 + rgba 缓冲 + alpha 包围盒」。 */
async function build(name) {
  const src = sourceOf(name)
  if (!src) throw new Error(`找不到 ${name} 的素材（assets/source/${name}.jpg 或设计稿目录）`)
  const { data, info } = await sharp(src)
    .resize(WORK_SIZE, WORK_SIZE, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const bg = floodBackground({ data, width, height, channels })
  const alpha = new Uint8ClampedArray(width * height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = bg[i] ? 0 : 255
  const soft = softenAlpha(alpha, width, height)

  const rgba = Buffer.alloc(width * height * 4)
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const s = i * channels
      const d = i * 4
      rgba[d] = data[s]
      rgba[d + 1] = data[s + 1]
      rgba[d + 2] = data[s + 2]
      rgba[d + 3] = soft[i]
      if (soft[i] > 8) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  const removed = bg.reduce((a, b) => a + b, 0) / bg.length
  return { name, rgba, width, height, bbox: { minX, minY, maxX, maxY }, removed }
}

const built = []
for (const name of NAMES) {
  const item = await build(name)
  built.push(item)
  const { bbox } = item
  console.log(
    `[${LABELS[name]}] 去背景 ${(item.removed * 100).toFixed(1)}%  轮廓 ${bbox.maxX - bbox.minX + 1}×${bbox.maxY - bbox.minY + 1}`,
  )
}

// —— 五张共用同一个方形裁切框 ——
const union = built.reduce(
  (acc, item) => ({
    minX: Math.min(acc.minX, item.bbox.minX),
    minY: Math.min(acc.minY, item.bbox.minY),
    maxX: Math.max(acc.maxX, item.bbox.maxX),
    maxY: Math.max(acc.maxY, item.bbox.maxY),
  }),
  { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: -1, maxY: -1 },
)

const W = built[0].width
const H = built[0].height
const boxW = union.maxX - union.minX + 1
const boxH = union.maxY - union.minY + 1
const side = Math.max(boxW, boxH) * (1 + PADDING_RATIO * 2)
const cx = (union.minX + union.maxX) / 2
const cy = (union.minY + union.maxY) / 2
let left = Math.round(cx - side / 2)
let top = Math.round(cy - side / 2)
// 不能裁出画面外（超出部分由 sharp 用透明补齐）
const cropSide = Math.min(Math.round(side), Math.max(W, H))
if (left + cropSide > W) left = W - cropSide
if (top + cropSide > H) top = H - cropSide
if (left < 0) left = 0
if (top < 0) top = 0

console.log(`共用裁切框：left=${left} top=${top} side=${cropSide}`)

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const item of built) {
  const dest = path.join(OUT_DIR, `${item.name}.webp`)
  await sharp(item.rgba, { raw: { width: W, height: H, channels: 4 } })
    .extract({ left, top, width: cropSide, height: cropSide })
    .resize(OUT_SIZE, OUT_SIZE, { fit: 'fill', kernel: 'lanczos3' })
    // WebP 带 alpha：同样画质下体积约是 PNG 的 1/8，首屏快很多
    .webp({ quality: 88, alphaQuality: 100, effort: 6 })
    .toFile(dest)
  console.log(`输出 ${item.name}.webp  ${(fs.statSync(dest).size / 1024).toFixed(0)} KB`)
}

console.log('完成 →', OUT_DIR)
