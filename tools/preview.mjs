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
    // 和宿主一样，把占位符换成版本号
    res.end(fs.readFileSync(path.join(ROOT, 'assets', 'lanbao-widget.js'), 'utf8').split('__LANBAO_ASSET_REV__').join('dev'))
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
    const balance = document.querySelector('.lbd-balance-text')
    return Boolean(img && img.naturalWidth > 0 && balance && balance.textContent.indexOf('—') === -1)
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

// 余额详情（点气泡）
await page.goto(`${base}/__phase?phase=low`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
await page.click('.lbd-bubble')
await delay(450)
const detailFile = path.join(SHOTS, 'detail.png')
await page.screenshot({
  path: detailFile,
  clip: { x: VIEW.width - 470, y: VIEW.height - 780, width: 470, height: 780 },
})
console.log('截图 detail（点气泡）')

// 设置菜单（右击角色）
await page.goto(`${base}/__phase?phase=busy`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
await page.click('.lbd-actor', { button: 'right' })
await delay(450)
const menuFile = path.join(SHOTS, 'menu.png')
await page.screenshot({
  path: menuFile,
  clip: { x: VIEW.width - 470, y: VIEW.height - 780, width: 470, height: 780 },
})
console.log('截图 menu（右击角色）')

// 只有余额的冒泡（点击 / 随机 / 对话结束都是这个形态）
await page.goto(`${base}/__phase?phase=idle`, { waitUntil: 'domcontentloaded' })
await page.goto(`${base}/?theme=light`, { waitUntil: 'networkidle2' })
await waitReady()
await page.evaluate(() => window.__dshLanbao.pingBalance())
await delay(420)
const balanceFile = path.join(SHOTS, 'light-balance.png')
await page.screenshot({ path: balanceFile, clip: CLIP })
console.log('截图 light-balance（只显示余额）')

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
  page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const bubble = q('.lbd-bubble')
    return {
      actorClass: q('.lbd-actor').className,
      actorWidth: q('.lbd-actor').style.width,
      bubbleShown: bubble.classList.contains('is-show'),
      balanceOnly: bubble.classList.contains('is-balance-only'),
      noBalance: bubble.classList.contains('no-balance'),
      balanceRowDisplay: getComputedStyle(q('.lbd-bubble-balance')).display,
      speech: q('.lbd-speech-text').textContent,
      balance: q('.lbd-balance-text').textContent,
      detailHidden: q('.lbd-detail').hidden,
      detailNum: q('.lbd-detail-num').textContent,
      menuHidden: q('.lbd-menu').hidden,
      rootHidden: q('.lbd-root').classList.contains('is-hidden'),
      restoreDisplay: getComputedStyle(q('.lbd-restore')).display,
      right: parseFloat(q('.lbd-root').style.right) || 0,
    }
  })

const reload = async (phase, theme = 'light') => {
  await page.goto(`${base}/__phase?phase=${phase}`, { waitUntil: 'domcontentloaded' })
  await page.goto(`${base}/?theme=${theme}`, { waitUntil: 'networkidle2' })
  await waitReady()
}

const pingBalance = () => page.evaluate(() => window.__dshLanbao.pingBalance())

// 重新装一次页面，让状态干净
liveSettings = { visible: true, size: 184, right: 24, bottom: 200, bubble: true, bubbleMs: 1200, lowBalance: 10 }
await reload('idle')
await delay(400)

// ① 平时不显示余额
let st = await readState()
expect('默认不显示气泡', st.bubbleShown === false, `shown=${st.bubbleShown}`)

// ② 主动点击 → 台词 + 余额
await page.click('.lbd-actor')
await delay(320)
st = await readState()
expect('点一下变开心表情', st.actorClass.includes('is-happy'), st.actorClass)
expect('点一下出现台词', st.speech.length > 0 && !st.balanceOnly, st.speech)
expect('点一下同时显示余额', !st.noBalance && st.balanceRowDisplay !== 'none', st.balance)

// ③ 过一会儿整颗气泡收掉（不是留个胶囊）
await delay(4400)
st = await readState()
expect('台词结束后气泡整个收起', st.bubbleShown === false)

// ④ 随机/对话结束那一档：只有余额，没有说话
await pingBalance()
await delay(260)
st = await readState()
expect('余额可以单独冒泡', st.bubbleShown === true && st.balanceOnly === true, `speech="${st.speech}"`)
expect('单独冒泡时余额可见', st.balanceRowDisplay !== 'none', st.balance)

// ⑤ 点气泡 → 余额详情
await page.click('.lbd-bubble')
await delay(300)
st = await readState()
expect('点气泡打开余额详情', st.detailHidden === false)
expect('详情里有余额数字', st.detailNum.length > 0 && st.detailNum !== '—', st.detailNum)

// ⑥ 详情里的刷新
await page.click('.lbd-refresh')
await delay(700)
const refreshLabel = await page.$eval('.lbd-refresh', (el) => el.textContent)
expect('详情里能刷新余额', refreshLabel === '刷新', refreshLabel)

// ⑦ Esc 关闭
await page.keyboard.press('Escape')
await delay(220)
st = await readState()
expect('Esc 关闭详情', st.detailHidden === true)

// ⑧ 右击角色 → 设置菜单
await page.click('.lbd-actor', { button: 'right' })
await delay(300)
st = await readState()
expect('右击角色弹出设置菜单', st.menuHidden === false)

// ⑨ 菜单里的「查看详情」也能进余额详情
await page.click('.lbd-open-detail')
await delay(300)
st = await readState()
expect('菜单能打开余额详情', st.detailHidden === false && st.menuHidden === true)
await page.keyboard.press('Escape')
await delay(220)

// ⑩ 改大小
await page.click('.lbd-actor', { button: 'right' })
await delay(280)
st = await readState()
const beforeSize = parseFloat(st.actorWidth)
await page.click('[data-size="1"]')
await delay(420)
st = await readState()
expect('菜单 + 号放大角色', parseFloat(st.actorWidth) === beforeSize + 16, `${beforeSize} → ${st.actorWidth}`)
expect('大小写回后端', liveSettings.size === beforeSize + 16, String(liveSettings.size))

// ⑪ 阈值
await page.click('[data-threshold="1"]')
await delay(420)
expect('低余额阈值写回后端', liveSettings.lowBalance === 15, String(liveSettings.lowBalance))

// ⑫ 关台词：还能报余额，但不再说话
await page.click('[data-toggle="bubble"]')
await delay(300)
await page.click('.lbd-actor')
await delay(360)
st = await readState()
expect('关掉台词后不再说话', st.speech === '' && st.balanceOnly === true, `speech="${st.speech}"`)
expect('关掉台词后点一下仍报余额', st.bubbleShown === true && st.balanceRowDisplay !== 'none', st.balance)
expect('台词开关写回后端', liveSettings.bubble === false, String(liveSettings.bubble))

// ⑬ 恢复台词
if (await page.$eval('.lbd-menu', (el) => el.hidden)) {
  await page.click('.lbd-actor', { button: 'right' })
  await delay(250)
}
await page.click('[data-toggle="bubble"]')
await delay(300)
expect('台词可以再打开', liveSettings.bubble === true)

// ⑭ 隐藏 / 恢复
if (await page.$eval('.lbd-menu', (el) => el.hidden)) {
  await page.click('.lbd-actor', { button: 'right' })
  await delay(250)
}
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

// ⑮ 拖动
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

// ⑯ 余额读取失败
await reload('error')
await pingBalance()
await delay(300)
st = await readState()
expect('余额读取失败会冒泡提示', st.bubbleShown === true && /失败/.test(st.balance), st.balance)
await page.click('.lbd-bubble')
await delay(300)
st = await readState()
expect('余额失败时详情仍可打开', st.detailHidden === false, st.detailNum)

const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? '✅ 交互回归全部通过' : `❌ ${failed.length} 项交互回归失败`)

await browser.close()
server.close()

// 合成验收大图：4 列，行数按实际张数算（之前多出来的会被画到画布外）
const TILE_W = 300
const TILE_H = 418
const COLS = 4
const gallery = [...shotFiles, balanceFile, darkIdle, darkLow, detailFile, menuFile]
const sheetW = TILE_W * COLS
const sheetH = TILE_H * Math.ceil(gallery.length / COLS)
const layers = []
for (let i = 0; i < gallery.length; i++) {
  layers.push({
    input: await sharp(gallery[i]).resize(TILE_W, TILE_H, { fit: 'cover', position: 'right bottom' }).toBuffer(),
    left: (i % COLS) * TILE_W,
    top: Math.floor(i / COLS) * TILE_H,
  })
}
await sharp({ create: { width: sheetW, height: sheetH, channels: 3, background: { r: 244, g: 246, b: 250 } } })
  .composite(layers)
  .png()
  .toFile(path.join(SHOTS, 'sheet.png'))

console.log(problems.length ? `问题：\n${problems.join('\n')}` : '✅ 无控制台错误')
console.log('完成 →', SHOTS)
