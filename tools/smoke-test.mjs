/**
 * 离线冒烟测试：用假的 cordis root / ctx 跑一遍宿主插件，
 * 验证路由注册、余额分档、情境状态机与降级都不会抛异常。
 *
 * 全程不打真网：globalThis.fetch 被换成本地桩。
 * 注意顺序：余额相关的断言放在会话事件之前 —— 回合结束留下的「瞬时表情」
 * 优先级高于余额状态，先跑余额才能测到它自己的分支。
 *
 * 用法：node tools/smoke-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 隔离 DSH_HOME：插件的设置文件落在 $DSH_HOME/lanbao-widget.json，
// 不隔离的话上一次测试写进去的 lowBalance/size 会污染这一次。
const TEMP_HOME = path.join(os.tmpdir(), `lanbao-smoke-${process.pid}`)
fs.rmSync(TEMP_HOME, { recursive: true, force: true })
fs.mkdirSync(TEMP_HOME, { recursive: true })
process.env.DSH_HOME = TEMP_HOME

// —— 先装 fetch 桩，再加载插件（apply 里会预热一次余额）——
// 字段名照抄 DeepSeek /user/balance 的真实响应结构。
const mock = {
  balance: { total_balance: '123.45', granted_balance: '10.00', topped_up_balance: '113.45', currency: 'CNY' },
  fail: null,
  calls: 0,
}

globalThis.fetch = async () => {
  mock.calls += 1
  if (mock.fail) throw new Error(mock.fail)
  const snapshot = { ...mock.balance }
  return {
    ok: true,
    status: 200,
    async json() {
      return { is_available: true, balance_infos: [snapshot] }
    },
  }
}

const { default: plugin } = await import('../lib/index.js')

const tick = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

const routes = new Map()
const taps = []
const eventHandlers = new Map()

function makeRes() {
  return {
    statusCode: 200,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers
      return this
    },
    end(body) {
      this.body = body === undefined ? '' : String(body)
      return this
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

let credentialsMode = 'ok'
const fakeCredentials = {
  async resolve(name) {
    assert.equal(name, 'DEEPSEEK_API_KEY')
    if (credentialsMode === 'throw') throw new Error('凭据服务炸了')
    if (credentialsMode === 'empty') return { value: '' }
    return { value: 'sk-fake-key' }
  },
}

const ctx = {
  webServer: {
    register(route) {
      const key = `${route.kind}:${route.path}`
      if (routes.has(key)) throw new Error(`重复路由 ${key}`)
      routes.set(key, route)
      return () => routes.delete(key)
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  get(name) {
    if (name === 'credentials') return fakeCredentials
    return undefined
  },
  on(name, handler) {
    eventHandlers.set(name, handler)
    return () => eventHandlers.delete(name)
  },
  effect(setup) {
    setup()
  },
}

const root = {
  on() {
    return () => {}
  },
  inject(deps, cb) {
    assert.deepEqual(deps, ['webServer'])
    cb(ctx)
  },
  effect(setup) {
    setup()
  },
}

plugin.apply(root, { userRefreshMs: 0 })

async function call(kind, path, extra = {}) {
  const route = routes.get(`${kind}:${path}`)
  assert.ok(route, `路由 ${kind}:${path} 不存在`)
  const res = makeRes()
  const req = { url: extra.url || path, method: extra.method || 'GET', headers: { host: '127.0.0.1:3080', ...(extra.headers || {}) } }
  await route.handler(req, res)
  return res
}

const state = async () => (await call('exact', '/dsh-lanbao/state.json')).json()
const refresh = async () => (await call('exact', '/dsh-lanbao/refresh.json', { method: 'POST' })).json()

// ═══════════════ ① 路由与静态资源 ═══════════════
for (const key of [
  'exact:/dsh-lanbao/widget.js',
  'prefix:/dsh-lanbao/expr',
  'prefix:/dsh-lanbao/audio',
  'exact:/dsh-lanbao/state.json',
  'exact:/dsh-lanbao/settings.json',
  'exact:/dsh-lanbao/refresh.json',
  'exact:/dsh-lanbao/health.json',
]) {
  assert.ok(routes.has(key), `缺少路由 ${key}`)
}
assert.equal(taps.length, 1, 'tapIndex 未注册')

const html = taps[0]('<html><body><div id="app"></div></body></html>')
assert.ok(html.includes('/dsh-lanbao/widget.js'), 'index 注入失败')
assert.equal(taps[0](html), html, '重复注入未去重')

const widget = await call('exact', '/dsh-lanbao/widget.js')
assert.equal(widget.statusCode, 200)
assert.ok(widget.body.length > 5000, 'widget.js 内容过短')

const idlePng = await call('prefix', '/dsh-lanbao/expr', { url: '/dsh-lanbao/expr/idle.webp' })
assert.equal(idlePng.statusCode, 200)
assert.equal(idlePng.headers['Content-Type'], 'image/webp')

const badPng = await call('prefix', '/dsh-lanbao/expr', { url: '/dsh-lanbao/expr/passwd' })
assert.equal(badPng.statusCode, 404, '未知表情应 404')

// 点触音效：白名单内 200（audio/wav）、未登记的音色 404、路径穿越 404
const pressWav = await call('prefix', '/dsh-lanbao/audio', { url: '/dsh-lanbao/audio/bubble-press.wav' })
assert.equal(pressWav.statusCode, 200, '按下音应可取到')
assert.equal(pressWav.headers['Content-Type'], 'audio/wav')
const releaseWav = await call('prefix', '/dsh-lanbao/audio', { url: '/dsh-lanbao/audio/squeak-release.wav' })
assert.equal(releaseWav.statusCode, 200, '松开音应可取到')

const unknownSet = await call('prefix', '/dsh-lanbao/audio', { url: '/dsh-lanbao/audio/evil-press.wav' })
assert.equal(unknownSet.statusCode, 404, '未登记的音色应 404')

const traversal = await call('prefix', '/dsh-lanbao/audio', { url: '/dsh-lanbao/audio/..%2F..%2Fpackage.json' })
assert.equal(traversal.statusCode, 404, '路径穿越应 404')

const health = (await call('exact', '/dsh-lanbao/health.json')).json()
assert.equal(health.ok, true)
assert.ok(health.files['lanbao-widget.js'])
for (const name of ['idle', 'thinking', 'busy', 'happy', 'confused']) {
  assert.ok(health.expressions[name], `缺少表情文件 ${name}`)
}

// ═══════════════ ② 余额分档与降级 ═══════════════
await tick()
let s = await state()
assert.equal(s.ok, true)
assert.equal(s.balance.level, 'ok', `初始余额应 ok，实际 ${s.balance.level}`)
assert.equal(s.balance.total, 123.45)
assert.equal(s.balance.granted, 10)
assert.equal(s.balance.toppedUp, 113.45)
assert.equal(s.phase, 'idle')
assert.deepEqual(s.expressions, ['idle', 'thinking', 'busy', 'happy', 'confused'])

// 转低 → 疑惑 + 告警
mock.balance = { total_balance: '5.00', granted_balance: '0.00', topped_up_balance: '5.00', currency: 'CNY' }
let r = await refresh()
assert.equal(r.ok, true)
assert.equal(r.balance.level, 'low')
s = await state()
assert.equal(s.balance.level, 'low')
assert.equal(s.reason, 'balance-low', `期望 balance-low，实际 ${s.reason}`)
assert.equal(s.phase, 'confused')
assert.ok(s.balanceAlert && s.balanceAlert.level === 'low', '缺少余额告警')

// 见底 → 持续疑惑
mock.balance = { total_balance: '0', granted_balance: '0', topped_up_balance: '0', currency: 'CNY' }
await refresh()
s = await state()
assert.equal(s.balance.level, 'empty')
assert.equal(s.reason, 'balance-empty')
assert.equal(s.phase, 'confused')

// 接口失败 → 保留旧值 + error 档 + 错误说明
mock.fail = 'network down'
await refresh()
s = await state()
assert.equal(s.balance.level, 'error', `期望 error，实际 ${s.balance.level}`)
assert.equal(s.balance.total, 0, '失败时应保留上一份数值')
assert.ok(s.balance.error.includes('network down'), '缺少错误说明')

// 恢复 → 回到正常
mock.fail = null
mock.balance = { total_balance: '88.80', granted_balance: '8.80', topped_up_balance: '80.00', currency: 'CNY' }
r = await refresh()
assert.equal(r.ok, true)
s = await state()
assert.equal(s.balance.level, 'ok', `恢复后应 ok，实际 ${s.balance.level}`)
assert.equal(s.balance.total, 88.8)

// 没配密钥 → unknown，不苦脸
credentialsMode = 'throw'
await refresh()
s = await state()
assert.equal(s.balance.level, 'unknown', `凭据报错应 unknown，实际 ${s.balance.level}`)
assert.equal(s.phase, 'idle', `没密钥不该苦脸，实际 ${s.phase}`)
credentialsMode = 'empty'
await refresh()
s = await state()
assert.equal(s.balance.level, 'unknown')
assert.equal(s.phase, 'idle')
credentialsMode = 'ok'
await refresh()

// ═══════════════ ③ 情境状态机 ═══════════════
const onEvent = eventHandlers.get('session/event')
assert.equal(typeof onEvent, 'function', '未订阅 session/event')
const session = { id: 'sess-1' }

onEvent(session, { type: 'turn/start', data: { turn: 1 } })
s = await state()
assert.equal(s.phase, 'thinking')
assert.equal(s.reason, 'turn')

onEvent(session, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' } })
s = await state()
assert.equal(s.phase, 'busy')
assert.equal(s.reason, 'tool')
assert.equal(s.detail, '跑命令')
assert.equal(s.active.tools, 1)

// 未知工具名兜底：收掉 sess-1 的工具后只剩 sess-2 的未知工具
onEvent({ id: 'sess-2' }, { type: 'turn/start', data: { turn: 1 } })
onEvent({ id: 'sess-2' }, { type: 'tool/call', data: { turn: 1, step: 1, callId: 'c9', name: 'some_unknown_tool', arguments: '{}' } })
onEvent(session, { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c1', message: { toolCallId: 'c1' } } })
s = await state()
assert.equal(s.detail, '干活')
assert.equal(s.active.tools, 1)

// 工具结束 → 回到思考
onEvent({ id: 'sess-2' }, { type: 'tool/result', data: { turn: 1, step: 1, callId: 'c9', message: { toolCallId: 'c9' } } })
onEvent({ id: 'sess-2' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
s = await state()
assert.equal(s.phase, 'thinking', '工具结束后应回到思考')

// 回合完成 → 开心
onEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
s = await state()
assert.equal(s.phase, 'happy')
assert.equal(s.reason, 'turn-completed')

// 回合失败 → 疑惑 + 原因
onEvent(session, { type: 'turn/start', data: { turn: 2 } })
onEvent(session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'failed', error: { message: '模型超时' } } } })
s = await state()
assert.equal(s.phase, 'confused')
assert.equal(s.reason, 'turn-failed')
assert.ok(s.detail.includes('模型超时'))

// 工具报错 → 瞬时疑惑（用新会话，避开上面的 turn-failed）
onEvent({ id: 'sess-3' }, { type: 'turn/start', data: { turn: 9 } })
onEvent({ id: 'sess-3' }, { type: 'tool/result', data: { turn: 9, step: 1, callId: 'x', message: { toolCallId: 'x', isError: true }, error: { name: 'Boom', code: 'E' } } })
onEvent({ id: 'sess-3' }, { type: 'turn/end', data: { turn: 9, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
s = await state()
assert.ok(['turn-aborted', 'tool-error', 'interrupted'].includes(s.reason), `异常原因未知：${s.reason}`)

// ═══════════════ ④ 设置、越权与开销 ═══════════════
async function postSettings(payload) {
  const route = routes.get('exact:/dsh-lanbao/settings.json')
  const res = makeRes()
  const chunks = [Buffer.from(JSON.stringify(payload))]
  const req = {
    method: 'POST',
    url: '/dsh-lanbao/settings.json',
    headers: { host: '127.0.0.1:3080' },
    on(name, handler) {
      if (name === 'data') chunks.forEach((c) => handler(c))
      if (name === 'end') handler()
      return req
    },
  }
  await route.handler(req, res)
  return res.json()
}

let settingsBody = await postSettings({ size: 240, lowBalance: 25, bubble: false })
assert.equal(settingsBody.ok, true, `设置写入失败：${settingsBody.error}`)
assert.equal(settingsBody.settings.size, 240)
assert.equal(settingsBody.settings.lowBalance, 25)
assert.equal(settingsBody.settings.bubble, false)

settingsBody = await postSettings({ size: 99999, lowBalance: -5 })
assert.equal(settingsBody.settings.size, 360, 'size 未夹紧')
assert.equal(settingsBody.settings.lowBalance, 0, 'lowBalance 未夹紧')

// —— 音效设置：默认值、夹紧、白名单 ——
assert.equal(settingsBody.settings.sound, true, '音效应默认开')
assert.equal(settingsBody.settings.soundVolume, 60, '音量默认 60')
assert.equal(settingsBody.settings.soundSet, 'bubble', '默认音色应为 bubble')

settingsBody = await postSettings({ sound: false, soundVolume: 150, soundSet: 'squeak' })
assert.equal(settingsBody.settings.sound, false)
assert.equal(settingsBody.settings.soundVolume, 100, '音量应夹到 100')
assert.equal(settingsBody.settings.soundSet, 'squeak')

settingsBody = await postSettings({ soundVolume: -20, soundSet: 'nope' })
assert.equal(settingsBody.settings.soundVolume, 0, '音量应夹到 0')
assert.equal(settingsBody.settings.soundSet, 'squeak', '未登记的音色不应写进设置')

// 落盘后重新读也要在（PERSISTED_KEYS 覆盖到了新字段）
const reread = (await call('exact', '/dsh-lanbao/settings.json')).json()
assert.equal(reread.settings.sound, false)
assert.equal(reread.settings.soundSet, 'squeak')

// state.json 要把音效设置一并下发，前端才能渲染菜单
const withSound = await state()
assert.equal(withSound.settings.sound, false)
assert.equal(withSound.settings.soundVolume, 0)
assert.equal(withSound.settings.soundSet, 'squeak')

const crossRes = makeRes()
await routes.get('exact:/dsh-lanbao/state.json').handler(
  { url: '/dsh-lanbao/state.json', method: 'GET', headers: { host: '127.0.0.1:3080', origin: 'http://evil.example' } },
  crossRes,
)
assert.equal(crossRes.statusCode, 403, '跨源请求未被拒')

const before = mock.calls
await state()
await state()
assert.equal(mock.calls, before, 'state.json 不应每次都请求上游')

console.log('冒烟测试全部通过 ✅')
console.log('最终状态：', JSON.stringify({ phase: s.phase, reason: s.reason, balance: s.balance, lastTurn: s.lastTurn }))
