/**
 * 本地预览 + 截图：起一个假站点，把挂件挂在一张仿 DSH 的页面上，
 * 用 Edge 无头模式逐种情境截图，验收表情、气泡、余额提示在浅色/深色皮肤下的表现。
 *
 * 用法：node tools/preview.mjs
 * 产物：tools/shots/*.png
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire('C:/Users/lenovo/.dsh/profiles/web/package.json')
const puppeteer = require('puppeteer-core')
const sharp = require('sharp')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SHOTS = path.join(HERE, 'shots')
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(SHOTS, { recursive: true })

const EXPRESSIONS = ['idle', 'thinking', 'busy', 'happy', 'confused']
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

function pageHtml(theme) {
  const dark = theme === 'dark'
  const ink = dark ? '#e6edf8' : '#22314a'
  const paper = dark ? '#14171d' : '#f4f6fa'
  const card = dark ? 'rgba(30,36,48,.86)' : 'rgba(255,255,255,.86)'
  const line = dark ? 'rgba(140,170,220,.16)' : 'rgba(38,74,140,.10)'
  const accent = dark ? 'rgba(96,150,225,.22)' : 'rgba(61,123,214,.12)'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>蓝宝挂件预览</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex;
    font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: ${ink}; background-color: ${paper};
    background-image:
      radial-gradient(900px 520px at 82% -10%, ${dark ? 'rgba(60,110,190,.30)' : 'rgba(150,190,240,.34)'}, transparent 62%),
      radial-gradient(700px 460px at 4% 108%, ${dark ? 'rgba(80,110,160,.22)' : 'rgba(190,205,235,.28)'}, transparent 60%);
  }
  .side { width: 210px; border-right: 1px solid ${line}; padding: 18px 14px; flex: 0 0 210px; }
  .side h1 { font-size: 14px; margin: 0 0 14px; letter-spacing: .5px; }
  .side .item { padding: 7px 9px; border-radius: 8px; font-size: 12.5px; opacity: .72; }
  .side .item.on { background: ${accent}; opacity: 1; font-weight: 600; }
  .main { flex: 1; display: flex; flex-direction: column; padding: 22px 26px; gap: 14px; overflow: hidden; }
  .msg { max-width: 620px; padding: 10px 14px; border-radius: 14px; background: ${card};
         border: 1px solid ${line}; box-shadow: 0 4px 14px rgba(24,46,86,.06); font-size: 13.5px; }
  .msg.me { align-self: flex-end; background: ${accent}; }
  .composer { margin-top: auto; height: 58px; border-radius: 16px; background: ${card};
              border: 1px solid ${line}; box-shadow: 0 8px 24px rgba(24,46,86,.08); }
</style></head>
<body>
  <div class="side"><h1>DeepSeek Harness</h1><div class="item on">蓝宝形象设计</div><div class="item">表情挂件</div><div class="item">余额提醒</div></div>
  <div class="main">
    <div class="msg me">帮我搭个插件，按情境换表情，再加余额提示。</div>
    <div class="msg">收到！我先看看设计图……</div>
    <div class="composer"></div>
  </div>
  <script defer src="/dsh-lanbao/widget.js"></script>
</body></html>`
}

/** 每种情境对应的宿主返回。 */
function stateFor(kind, theme) {
  const base = {
    ok: true,
    at: Date.now(),
    version: '1.0.0',
    phase: 'idle',
    reason: 'idle',
    detail: null,
    active: { sessions: 1, turns: 0, tools: 0 },
    balance: {
      ok: true, level: 'ok', total: 128.46, currency: 'CNY', symbol: '¥',
      granted: 18.46, toppedUp: 110, available: true, at: Date.now(), stale: false, threshold: 10, error: null,
    },
    lastTurn: null,
    balanceAlert: null,
    settings: { visible: true, size: 184, right: 20, bottom: 96, bubble: true, bubbleMs: 6000, lowBalance: 10 },
    expressions: EXPRESSIONS,
    theme: theme || 'light',
  }
  if (kind === 'thinking') Object.assign(base, { phase: 'thinking', reason: 'turn' })
  if (kind === 'busy') Object.assign(base, { phase: 'busy', reason: 'tool', detail: '跑命令' })
  if (kind === 'happy') {
    Object.assign(base, { phase: 'happy', reason: 'turn-completed' })
    base.lastTurn = { at: Date.now(), cost: 0.0132, currency: 'CNY', symbol: '¥', before: 128.4732, after: 128.46, reason: 'turn' }
  }
  if (kind === 'confused') Object.assign(base, { phase: 'confused', reason: 'turn-failed', detail: '模型超时' })
  if (kind === 'low') {
    base.phase = 'confused'
    base.reason = 'balance-low'
    base.balance = { ...base.balance, level: 'low', total: 6.42, granted: 0.42, toppedUp: 6 }
    base.balanceAlert = { level: 'low', at: Date.now() }
  }
  if (kind === 'error') {
    base.phase = 'confused'
    base.reason = 'balance-error'
    base.balance = { ...base.balance, ok: false, level: 'error', total: null, error: '余额接口返回 HTTP 401', stale: true }
    base.balanceAlert = { level: 'error', at: Date.now() }
  }
  return base
}

let current = 'idle'
/** 预览站点的设置也要能写回，否则每 1.2s 的轮询会把界面上的改动刷回去。 */
let liveSettings = { visible: true, size: 184, right: 24, bottom: 200, bubble: true, bubbleMs: 6000, lowBalance: 10 }

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(pageHtml(url.searchParams.get('theme')))
    return
  }
  if (url.pathname === '/__phase') {
    current = url.searchParams.get('phase') || 'idle'
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  if (url.pathname === '/dsh-lanbao/state.json') {
    const body = stateFor(current)
    body.settings = { ...liveSettings }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/dsh-lanbao/settings.json') {
    if (req.method === 'POST') {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        try {
          liveSettings = { ...liveSettings, ...JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }
        } catch {
          /* 忽略坏 JSON */
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: true, settings: liveSettings }))
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, settings: liveSettings }))
    return
  }
  if (url.pathname === '/dsh-lanbao/refresh.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, balance: stateFor(current).balance }))
    return
  }
  if (url.pathname === '/dsh-lanbao/widget.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
    res.end(fs.readFileSync(path.join(ROOT, 'assets', 'lanbao-widget.js')))
    return
  }
  const expr = /^\/dsh-lanbao\/expr\/([a-z]+)\.webp$/.exec(url.pathname)
  if (expr && EXPRESSIONS.includes(expr[1])) {
    res.writeHead(200, { 'Content-Type': 'image/webp' })
    res.end(fs.readFileSync(path.join(ROOT, 'assets', 'expressions', `${expr[1]}.webp`)))
    return
  }
  res.writeHead(404).end('not found')
})

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

const VIEW = { width: 1180, height: 720 }
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--hide-scrollbars', '--force-device-scale-factor=2', '--no-first-run', '--no-default-browser-check'],
  defaultViewport: { ...VIEW, deviceScaleFactor: 2 },
})

const page = await browser.newPage()
const problems = []
page.on('console', (msg) => {
  // 预览站点没有 favicon，忽略这条 404
  if (msg.type() === 'error' && msg.text().includes('404')) return
  problems.push(`console: ${msg.text()}`)
})
page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))

/** 等到蓝宝真的画出来（正面图层有像素）并且余额不再是占位符。 */
async function waitReady() {
  await page.waitForFunction(() => {
    const img = document.querySelector('.lbd-img.is-front')
    const chip = document.querySelector('.lbd-chip-text')
    return Boolean(img && img.naturalWidth > 0 && chip && chip.textContent.indexOf('—') === -1)
  }, { timeout: 15000 })
  await delay(650)
}

const CLIP = { x: VIEW.width - 430, y: VIEW.height - 600, width: 430, height: 600 }

async function shot(name, phase, theme) {
  await page.goto(`${base}/__phase?phase=${phase}`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'networkidle2' })
  await waitReady()
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file, clip: CLIP })
  console.log(`截图 ${name}`)
  return file
}

const phases = [
  ['idle', '待机'],
  ['thinking', '思考'],
  ['busy', '忙碌'],
  ['happy', '开心'],
  ['confused', '疑惑'],
  ['low', '余额偏低'],
  ['error', '余额读取失败'],
]

const shotFiles = []
for (const [phase] of phases) {
  shotFiles.push(await shot(`light-${phase}`, phase, 'light'))
}

// 深色皮肤抽两张
const darkIdle = await shot('dark-idle', 'idle', 'dark')
const darkLow = await shot('dark-low', 'low', 'dark')

// 面板
await page.goto(`${base}/__phase?phase=low`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
await page.click('.lbd-chip')
await delay(450)
const panelFile = path.join(SHOTS, 'panel.png')
await page.screenshot({
  path: panelFile,
  clip: { x: VIEW.width - 470, y: VIEW.height - 820, width: 470, height: 820 },
})
console.log('截图 panel')

// 整页
await page.goto(`${base}/__phase?phase=busy`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
await page.screenshot({ path: path.join(SHOTS, 'full.png') })
console.log('截图 full')

// 点击角色 → 开心 + 台词
await page.click('.lbd-actor')
await delay(500)
await page.screenshot({ path: path.join(SHOTS, 'pet.png'), clip: CLIP })
console.log('截图 pet')

// ── 交互回归 ────────────────────────────────────────────
const results = []
const expect = (label, ok, extra) => {
  results.push({ label, ok })
  console.log(`${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`)
}

const readState = () =>
  page.evaluate(() => ({
    actorClass: document.querySelector('.lbd-actor').className,
    actorWidth: document.querySelector('.lbd-actor').style.width,
    bubbleShown: document.querySelector('.lbd-bubble').classList.contains('is-show'),
    bubbleText: document.querySelector('.lbd-bubble-text').textContent,
    panelHidden: document.querySelector('.lbd-panel').hidden,
    rootHidden: document.querySelector('.lbd-root').classList.contains('is-hidden'),
    restoreDisplay: getComputedStyle(document.querySelector('.lbd-restore')).display,
    right: parseFloat(document.querySelector('.lbd-root').style.right) || 0,
    bottom: parseFloat(document.querySelector('.lbd-root').style.bottom) || 0,
    chip: document.querySelector('.lbd-chip-text').textContent,
  }))

// 重新装一次页面，让状态干净
liveSettings = { visible: true, size: 184, right: 24, bottom: 200, bubble: true, bubbleMs: 6000, lowBalance: 10 }
await page.goto(`${base}/__phase?phase=idle`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()

// 点一下 → 开心
await page.click('.lbd-actor')
await delay(320)
let st = await readState()
expect('点一下变开心表情', st.actorClass.includes('is-happy'), st.actorClass)
expect('点一下有回应台词', st.bubbleShown && st.bubbleText.length > 0, st.bubbleText)

// 打开面板
await page.click('.lbd-chip')
await delay(260)
st = await readState()
expect('点余额胶囊打开面板', st.panelHidden === false)

// 改大小
const beforeSize = parseFloat(st.actorWidth)
await page.click('[data-size="1"]')
await delay(420)
st = await readState()
expect('面板 + 号放大角色', parseFloat(st.actorWidth) === beforeSize + 16, `${beforeSize} → ${st.actorWidth}`)
expect('大小写回后端', liveSettings.size === beforeSize + 16, String(liveSettings.size))

// 关气泡后不再冒泡
await page.click('[data-toggle="bubble"]')
await delay(300)
await page.click('.lbd-actor')
await delay(360)
st = await readState()
expect('关掉气泡后不再说话', st.bubbleShown === false)
expect('气泡开关写回后端', liveSettings.bubble === false, String(liveSettings.bubble))

// 恢复气泡
await page.click('[data-toggle="bubble"]')
await delay(300)
expect('气泡可以再打开', liveSettings.bubble === true)

// 隐藏 / 恢复
async function ensurePanel() {
  const hidden = await page.$eval('.lbd-panel', (el) => el.hidden)
  if (hidden) {
    await page.click('.lbd-chip')
    await delay(220)
  }
}
await ensurePanel()
await page.click('.lbd-hide')
await delay(340)
st = await readState()
expect('隐藏后角色不显示', st.rootHidden === true)
expect('隐藏后留下恢复按钮', st.restoreDisplay !== 'none', st.restoreDisplay)
await page.click('.lbd-restore')
await delay(340)
st = await readState()
expect('点恢复按钮叫回蓝宝', st.rootHidden === false)
expect('恢复写回后端', liveSettings.visible === true)

// 拖动
const box = await page.$eval('.lbd-actor', (el) => {
  const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})
const beforeDrag = await readState()
await page.mouse.move(box.x, box.y)
await page.mouse.down()
await page.mouse.move(box.x - 120, box.y - 60, { steps: 8 })
await page.mouse.up()
await delay(500)
st = await readState()
expect('拖动改变位置', Math.abs(st.right - beforeDrag.right) > 60, `${beforeDrag.right} → ${st.right}`)
expect('拖动后位置写回后端', Math.abs((liveSettings.right || 0) - st.right) < 6, `${liveSettings.right} vs ${st.right}`)
expect('拖动不会误触发摸摸头', !st.actorClass.includes('is-happy'), st.actorClass)

// 余额提醒
await page.goto(`${base}/__phase?phase=error`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
st = await readState()
await delay(900)
st = await readState()
expect('余额读取失败会提示', st.chip.includes('失败') || st.bubbleText.includes('余额'), `${st.chip} / ${st.bubbleText}`)

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '✅ 交互回归全部通过' : `❌ ${failed.length} 项交互回归失败`)

await browser.close()
server.close()

// 合成验收大图：4 列
const TILE_W = 300
const TILE_H = 418
const rows = [shotFiles, [darkIdle, darkLow, panelFile]]
const tiles = []
rows.forEach((row, r) => {
  row.forEach((file, c) => {
    tiles.push({ input: file, left: c * TILE_W, top: r * TILE_H })
  })
})
const sheetW = TILE_W * 4
const sheetH = TILE_H * rows.length
const layers = []
for (const tile of tiles) {
  layers.push({
    input: await sharp(tile.input).resize(TILE_W, TILE_H, { fit: 'cover', position: 'right bottom' }).toBuffer(),
    left: tile.left,
    top: tile.top,
  })
}
await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: { r: 244, g: 246, b: 250 } } })
  .composite(layers)
  .png()
  .toFile(path.join(SHOTS, 'sheet.png'))

console.log(problems.length ? `问题：\n${problems.join('\n')}` : '✅ 无控制台错误')
console.log('完成 →', SHOTS)
