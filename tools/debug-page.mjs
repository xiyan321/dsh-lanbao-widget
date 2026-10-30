/** 调试：把预览页里发生的错误全打出来。 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire('C:/Users/lenovo/.dsh/profiles/web/package.json')
const puppeteer = require('puppeteer-core')

const ROOT = 'D:/develp/test/dsh-lanbao-widget'
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

const STATE = {
  ok: true, at: Date.now(), version: '1.0.0', phase: 'idle', reason: 'idle', detail: null,
  active: { sessions: 1, turns: 0, tools: 0 },
  balance: { ok: true, level: 'ok', total: 128.46, currency: 'CNY', symbol: '¥', granted: 18.46, toppedUp: 110, available: true, at: Date.now(), stale: false, threshold: 10, error: null },
  lastTurn: null, balanceAlert: null,
  settings: { visible: true, size: 168, right: 24, bottom: 20, bubble: true, bubbleMs: 6000, lowBalance: 10 },
  expressions: ['idle', 'thinking', 'busy', 'happy', 'confused'],
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#f4f6fa"><div id="app"></div><script defer src="/dsh-lanbao/widget.js"></script></body></html>')
    return
  }
  if (url.pathname === '/dsh-lanbao/state.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(STATE))
    return
  }
  if (url.pathname === '/dsh-lanbao/widget.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
    res.end(fs.readFileSync(path.join(ROOT, 'assets', 'lanbao-widget.js'), 'utf8').split('__LANBAO_ASSET_REV__').join('dev'))
    return
  }
  const m = /^\/dsh-lanbao\/expr\/([a-z]+)\.webp$/.exec(url.pathname)
  if (m) {
    res.writeHead(200, { 'Content-Type': 'image/webp' })
    res.end(fs.readFileSync(path.join(ROOT, 'assets', 'expressions', `${m[1]}.webp`)))
    return
  }
  res.writeHead(404).end('nope')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-first-run', '--no-default-browser-check'],
  defaultViewport: { width: 1000, height: 700 },
})
const page = await browser.newPage()
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message, '\n', e.stack))
page.on('requestfailed', (r) => console.log('[requestfailed]', r.url(), r.failure()?.errorText))

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 2000))

const info = await page.evaluate(() => {
  const root = document.querySelector('.lbd-root')
  const front = document.querySelector('.lbd-img.is-front')
  return {
    loadedFlag: Boolean(window.__dshLanbaoWidget),
    hasRoot: Boolean(root),
    rootClass: root ? root.className : null,
    frontSrc: front ? front.src : null,
    frontNatural: front ? front.naturalWidth : null,
    chipText: document.querySelector('.lbd-chip-text')?.textContent,
    bubbleHidden: document.querySelector('.lbd-bubble')?.hidden,
    bubbleShown: document.querySelector('.lbd-bubble')?.className,
    bubbleText: document.querySelector('.lbd-bubble-text')?.textContent,
    imgs: Array.from(document.querySelectorAll('.lbd-img')).map((i) => ({ src: i.src, cls: i.className, nw: i.naturalWidth })),
  }
})
console.log(JSON.stringify(info, null, 2))

await browser.close()
server.close()
