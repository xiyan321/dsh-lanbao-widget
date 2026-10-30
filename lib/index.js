/**
 * dsh-lanbao-widget —— 蓝宝挂件（宿主端）
 *
 * 职责：
 *  1. 把浏览器端脚本与 5 张表情图挂到 DSH Web 的 index.html 上；
 *  2. 订阅会话事件，算出「当前情境」（待机 / 思考 / 忙碌 / 开心 / 疑惑）；
 *  3. 读 DSH 凭据调用 DeepSeek 余额接口，给出余额等级与每轮花费；
 *  4. 通过 /dsh-lanbao/* 只读接口把上面这些喂给浏览器端。
 *
 * 设计原则：任何一步失败都只降级，绝不抛到宿主。余额接口异常时蓝宝会「疑惑」一下，
 * 但聊天、会话、插件本身照常工作。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = path.join(PACKAGE_ROOT, 'assets')
const EXPR_DIR = path.join(ASSETS_DIR, 'expressions')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const BUILD_VERSION = '1.0.0'

/** 余额接口。DeepSeek 官方在 balance_infos[0] 上给三个数字。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** 与 assets/expressions 下的文件名一一对应。 */
const EXPRESSIONS = ['idle', 'thinking', 'busy', 'happy', 'confused']

/** 越线提醒默认值：余额低于该值算「偏低」，等于 0 算「见底」。 */
const DEFAULTS = {
  /** 是否显示挂件。 */
  visible: true,
  /** 角色宽度（px）。 */
  size: 184,
  /** 距视口右 / 下边缘（px）。下边缘留高一点，避开输入框和右下角原有的鲸鱼挂件。 */
  right: 24,
  bottom: 200,
  /** 是否显示气泡。 */
  bubble: true,
  /** 气泡自动收起时间（ms）。 */
  bubbleMs: 6000,
  /** 低余额阈值（元）。 */
  lowBalance: 10,
  /** 余额缓存时长（ms）。 */
  balanceTtlMs: 60_000,
  /** 自动刷新余额的最小间隔（ms），防止连轮把接口打炸。 */
  minRefreshMs: 15_000,
  /** 用户手动刷新余额的最小间隔（ms），只拦连点。 */
  userRefreshMs: 3000,
  /** 读密钥用的凭据名。 */
  apiKeyRef: 'DEEPSEEK_API_KEY',
  /** 余额越线后，蓝宝保持「疑惑」表情的窗口（ms）。 */
  alertWindowMs: 30_000,
}

const SETTINGS_FILE = path.join(DSH_HOME, 'lanbao-widget.json')

/** 允许用户改、也允许落盘的字段。其余（缓存时长、凭据名等）只认 patch 配置。 */
const PERSISTED_KEYS = ['visible', 'size', 'right', 'bottom', 'bubble', 'bubbleMs', 'lowBalance']

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

const log = (...args) => {
  try {
    console.log('[lanbao]', ...args)
  } catch {
    /* 控制台被接管时忽略 */
  }
}
const warn = (...args) => {
  try {
    console.warn('[lanbao]', ...args)
  } catch {
    /* 同上 */
  }
}

/** 错误信息一律截断，避免把上游返回体整段漏到前端。 */
const brief = (err, max = 180) => {
  const text = typeof err === 'string' ? err : (err && (err.message || err.code)) || ''
  const s = String(text || '未知错误')
  return s.length > max ? `${s.slice(0, max)}…` : s
}

const clamp = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** 读设置文件。坏文件自动备份并用默认值，不让挂件因为一个坏 JSON 起不来。 */
function readSettings() {
  let raw
  try {
    raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
  } catch (err) {
    if (err && err.code !== 'ENOENT') warn('设置文件读取失败：', brief(err))
    return {}
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (err) {
    try {
      fs.renameSync(SETTINGS_FILE, `${SETTINGS_FILE}.corrupt-${Date.now()}.bak`)
    } catch {
      /* 备份失败也不影响继续用默认值 */
    }
    warn('设置文件损坏，已备份并回退默认值：', brief(err))
    return {}
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  // 只把受控字段写进文件，免得运行期的内部参数（缓存 TTL、凭据名）漏进去
  const clean = {}
  for (const key of PERSISTED_KEYS) {
    if (next[key] !== undefined) clean[key] = next[key]
  }
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, `${JSON.stringify(clean, null, 2)}\n`, 'utf8')
    return { ok: true, settings: next }
  } catch (err) {
    return { ok: false, error: brief(err), settings: next }
  }
}

/** 把外部传入的设置收敛成受控字段，杜绝任意字段写进文件。 */
function normalizeSettings(input, base) {
  const out = { ...base }
  if (!input || typeof input !== 'object') return out
  if (typeof input.visible === 'boolean') out.visible = input.visible
  if (typeof input.bubble === 'boolean') out.bubble = input.bubble
  if (input.size !== undefined) out.size = clamp(input.size, 96, 360, base.size)
  if (input.right !== undefined) out.right = clamp(input.right, 0, 4000, base.right)
  if (input.bottom !== undefined) out.bottom = clamp(input.bottom, 0, 4000, base.bottom)
  if (input.bubbleMs !== undefined) out.bubbleMs = clamp(input.bubbleMs, 1500, 60_000, base.bubbleMs)
  if (input.lowBalance !== undefined) out.lowBalance = clamp(input.lowBalance, 0, 100_000, base.lowBalance)
  return out
}

/**
 * 余额分档：ok / low / empty / error / unknown。
 *
 * 「没配密钥」归到 unknown 而不是 error —— 那多半是用户没打算用余额功能，
 * 不该让蓝宝一直苦着脸；真正的读失败（网络、HTTP、结构异常）才是 error。
 */
function levelOf(balance, threshold) {
  if (!balance || !balance.ok) {
    if (!balance) return 'unknown'
    if (balance.code === 'NO_KEY') return 'unknown'
    return balance.code ? 'error' : 'unknown'
  }
  const total = Number(balance.total)
  if (!Number.isFinite(total)) return 'unknown'
  if (total <= 0.0001) return 'empty'
  if (total < threshold) return 'low'
  return 'ok'
}

/** 单次会话的活动轨迹。 */
function newSessionTrack() {
  return {
    turn: null,
    tools: new Map(), // callId -> 工具名
    startedAt: 0,
    lastAt: 0,
  }
}

export default {
  name: 'lanbao-widget',

  apply(root, config) {
    const disposers = []
    const cfg = { ...DEFAULTS, ...(config || {}) }
    root.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 单个 disposer 失败不影响其它清理 */
        }
      }
    })

    // ————————————————————————————————————————————————
    // ① 注入行：不依赖任何服务，apply 第一件事就注册
    // ————————————————————————————————————————————————
    const SCRIPT_SRC = '/dsh-lanbao/widget.js'
    const INLINE_ROW_TEXT = `(function(){try{var s=document.createElement("script");s.src="${SCRIPT_SRC}";s.async=true;s.onerror=function(){};document.head.appendChild(s)}catch(e){}})();`

    disposers.push(
      root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === SCRIPT_SRC) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(SCRIPT_SRC) >= 0) return
          }
          // 用内联行：桌面端解释器对 script-src 加载失败会 reject 整个 boot，
          // 内联行由我们自己建 <script> 并吞掉 onerror，路由不在时只是不显示。
          table.push({ kind: 'script', placement: 'body', text: INLINE_ROW_TEXT })
        } catch {
          /* 注入表异常不应影响宿主启动 */
        }
      }),
    )

    // ————————————————————————————————————————————————
    // ② 其余逻辑：等 webServer 就绪
    // ————————————————————————————————————————————————
    root.inject(['webServer'], (ctx) => {
      const local = []
      ctx.effect(() => () => {
        for (const dispose of local) {
          try {
            dispose()
          } catch {
            /* ignore */
          }
        }
      })

      let settings = { ...cfg, ...readSettings() }

      // —— 浏览器信任栅栏：能拿到 connection 服务就借用，拿不到只做同源自检 ——
      const connectionFence = () => {
        try {
          const conn = ctx.get('connection')
          return conn && typeof conn.requestRejection === 'function' ? conn : null
        } catch {
          return null
        }
      }

      const isLoopback = (hostname) =>
        hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'

      function selfRejection(req) {
        try {
          const headers = (req && req.headers) || {}
          const hostUrl = new URL(`http://${String(headers.host || '')}`)
          const fence = connectionFence()
          // 非回环地址时由 connection 栅栏裁决；它不在才放行，避免局域网使用完全不能用。
          if (!isLoopback(hostUrl.hostname) && !fence) return null
          const site = String(headers['sec-fetch-site'] || '').toLowerCase()
          if (site === 'cross-site') return 403
          const origin = headers.origin
          if (typeof origin === 'string' && origin && origin !== 'null') {
            let originUrl = null
            try {
              originUrl = new URL(origin)
            } catch {
              return 403
            }
            if (originUrl.host.toLowerCase() !== hostUrl.host.toLowerCase()) return 403
          }
          return null
        } catch {
          return 403 // 自检自己出错也拒绝（fail-closed）
        }
      }

      function rejection(req) {
        const self = selfRejection(req)
        if (self !== null) return self
        const conn = connectionFence()
        if (!conn) return null
        try {
          const code = conn.requestRejection(req)
          if (code === undefined || code === null || code === false) return null
          return typeof code === 'number' ? code : 403
        } catch {
          return 403
        }
      }

      function register(route) {
        const inner = route.handler
        try {
          return ctx.webServer.register({
            ...route,
            handler: async (req, res) => {
              const code = rejection(req)
              if (code !== null) {
                try {
                  res.statusCode = code
                  res.end()
                } catch {
                  /* ignore */
                }
                return
              }
              return inner(req, res)
            },
          })
        } catch (err) {
          warn(`路由 ${route.path} 注册失败：`, brief(err))
          return () => {}
        }
      }

      function sendJson(res, status, payload) {
        try {
          res.writeHead(status, JSON_HEADERS)
          res.end(JSON.stringify(payload))
        } catch {
          /* 客户端已断开 */
        }
      }

      // ————————————————————————————————————————————————
      // 余额
      // ————————————————————————————————————————————————
      let balanceCache = null
      let balanceInFlight = null
      let balanceAlert = null // { level, at }
      let lastTurn = null // { at, cost, currency, symbol, before, after, reason }
      let pendingCost = null // { before, at, reason }

      const currencySymbol = (currency) => (String(currency || 'CNY').toUpperCase() === 'CNY' ? '¥' : '$')

      async function fetchBalanceFromApi() {
        let credential = null
        try {
          const credentials = ctx.get('credentials')
          if (!credentials || typeof credentials.resolve !== 'function') {
            return { ok: false, code: 'NO_KEY', error: '宿主未提供凭据服务' }
          }
          credential = await credentials.resolve(settings.apiKeyRef || DEFAULTS.apiKeyRef)
        } catch (err) {
          return { ok: false, code: 'NO_KEY', error: `读取密钥失败：${brief(err)}` }
        }
        const key = credential && credential.value
        if (!key) return { ok: false, code: 'NO_KEY', error: '没有配置 DeepSeek API Key' }

        let response
        try {
          response = await fetch(BALANCE_URL, {
            headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
          })
        } catch (err) {
          return { ok: false, code: 'NETWORK', error: `余额接口请求失败：${brief(err)}` }
        }
        if (!response.ok) {
          return { ok: false, code: 'HTTP', error: `余额接口返回 HTTP ${response.status}`, status: response.status }
        }
        let body
        try {
          body = await response.json()
        } catch (err) {
          return { ok: false, code: 'BAD_JSON', error: `余额响应不是 JSON：${brief(err)}` }
        }
        const info = Array.isArray(body && body.balance_infos) ? body.balance_infos[0] : null
        if (!info) return { ok: false, code: 'BAD_JSON', error: '余额响应缺少 balance_infos' }
        const total = Number.parseFloat(info.total_balance)
        if (!Number.isFinite(total)) return { ok: false, code: 'BAD_JSON', error: '余额响应里的 total_balance 不是数字' }
        const currency = String(info.currency || 'CNY').toUpperCase()
        const num = (value) => {
          const n = Number.parseFloat(value)
          return Number.isFinite(n) ? n : null
        }
        return {
          ok: true,
          total,
          currency,
          symbol: currencySymbol(currency),
          granted: num(info.granted_balance),
          toppedUp: num(info.topped_up_balance),
          available: body.is_available !== false,
          at: Date.now(),
        }
      }

      /**
       * 读余额。三种取法：
       *  - 'cache'：命中 TTL 就直接返回，给每次轮询用；
       *  - 'auto' ：自动触发（回合结束）走最小间隔，防止连轮把接口打炸；
       *  - 'user' ：用户点「刷新」，只拦极短的连点。
       * 请求单飞；失败时保留上一份可用数据并标 stale，前端据此显示「缓存」。
       */
      async function getBalance(mode) {
        const kind = mode === true ? 'auto' : mode === false ? 'cache' : (mode || 'cache')
        const now = Date.now()
        const ttl = clamp(settings.balanceTtlMs, 5000, 600_000, DEFAULTS.balanceTtlMs)
        const gap = clamp(settings.minRefreshMs, 1000, 600_000, DEFAULTS.minRefreshMs)
        if (kind === 'cache' && balanceCache && now - balanceCache.at < ttl) return balanceCache
        if (balanceInFlight) {
          try {
            return await balanceInFlight
          } catch {
            return balanceCache
          }
        }
        if (balanceCache) {
          const wait = kind === 'user' ? clamp(settings.userRefreshMs, 0, 600_000, DEFAULTS.userRefreshMs) : gap
          if (now - (balanceCache.attemptAt || 0) < wait) return balanceCache
        }
        balanceInFlight = (async () => {
          const result = await fetchBalanceFromApi()
          if (result.ok) {
            const previous = balanceCache && balanceCache.ok ? balanceCache.total : null
            balanceCache = { ...result, attemptAt: Date.now(), stale: false }
            noteBalanceSample(previous, result)
          } else {
            balanceCache = {
              ...(balanceCache || {}),
              ok: false,
              code: result.code,
              error: result.error,
              attemptAt: Date.now(),
              stale: Boolean(balanceCache && balanceCache.total !== undefined),
              at: balanceCache ? balanceCache.at : Date.now(),
            }
          }
          return balanceCache
        })()
        try {
          return await balanceInFlight
        } finally {
          balanceInFlight = null
        }
      }

      /** 余额越线时记一条告警，让前端只高亮一次而不是每次轮询都弹。 */
      function noteBalanceSample(previousTotal, sample) {
        const level = levelOf({ ok: true, total: sample.total }, settings.lowBalance)
        const lastLevel = balanceAlert ? balanceAlert.level : 'ok'
        if (level !== 'ok' && lastLevel !== level) {
          balanceAlert = { level, at: Date.now() }
        } else if (level === 'ok' && lastLevel !== 'ok') {
          balanceAlert = { level: 'ok', at: Date.now() }
        }
        // 本轮花费 = 回合开始前的采样 - 刷新后的余额
        if (pendingCost && Number.isFinite(previousTotal) && previousTotal > sample.total) {
          const cost = previousTotal - sample.total
          if (cost > 0 && cost < 10_000) {
            lastTurn = {
              at: Date.now(),
              cost: Math.round(cost * 10000) / 10000,
              currency: sample.currency,
              symbol: sample.symbol,
              before: Math.round(previousTotal * 10000) / 10000,
              after: Math.round(sample.total * 10000) / 10000,
              reason: pendingCost.reason,
            }
          }
          pendingCost = null
        }
      }

      // ————————————————————————————————————————————————
      // 情境状态机
      // ————————————————————————————————————————————————
      const tracks = new Map()
      let transient = null // { phase, reason, detail, until, at }

      const toolLabel = (name) => {
        const n = String(name || '')
        if (!n) return '干活'
        const map = {
          read: '读文件', write: '写文件', edit: '改文件', glob: '找文件', grep: '搜代码',
          pwsh: '跑命令', bash: '跑命令', todo_write: '排计划', web_search: '查资料',
          web_fetch: '抓网页', subagent: '派小弟', workflow: '开流水线', present: '交付',
          generate_image: '画图', edit_image: '改图', ask_user_question: '等你回答',
          read_image: '看图', job_output: '收后台活', skill: '翻技能书',
        }
        for (const key of Object.keys(map)) {
          if (n === key || n.startsWith(`${key}_`) || n.startsWith(key)) return map[key]
        }
        return '干活'
      }

      function trackOf(sessionId) {
        let track = tracks.get(sessionId)
        if (!track) {
          track = newSessionTrack()
          tracks.set(sessionId, track)
        }
        return track
      }

      function setTransient(phase, reason, detail, ttl) {
        transient = { phase, reason, detail: detail || null, until: Date.now() + ttl, at: Date.now() }
      }

      function handleSessionEvent(session, event) {
        const sessionId = session && session.id ? String(session.id) : 'default'
        const type = event && event.type
        const data = (event && event.data) || {}
        const track = trackOf(sessionId)
        track.lastAt = Date.now()
        switch (type) {
          case 'turn/start': {
            track.turn = Number(data.turn) || 0
            track.startedAt = Date.now()
            track.tools.clear()
            // 回合开始时钉一份余额基线，用来算本轮花费
            if (balanceCache && balanceCache.ok) pendingCost = { before: balanceCache.total, at: Date.now(), reason: 'turn' }
            break
          }
          case 'tool/call': {
            const callId = String(data.callId || '')
            track.tools.set(callId, String(data.name || ''))
            if (track.turn === null) track.turn = Number(data.turn) || 0
            break
          }
          case 'tool/result': {
            const callId = String((data.message && data.message.toolCallId) || data.callId || '')
            track.tools.delete(callId)
            if (data.error) setTransient('confused', 'tool-error', data.error.reason || data.error.name || null, 6000)
            break
          }
          case 'assistant/message': {
            if (data.interrupted) setTransient('confused', 'interrupted', null, 5000)
            break
          }
          case 'turn/end': {
            const reason = (data.reason && data.reason.kind) || 'completed'
            track.turn = null
            track.tools.clear()
            if (reason === 'completed') {
              setTransient('happy', 'turn-completed', null, 6000)
              if (pendingCost) pendingCost.reason = 'turn'
              void getBalance('auto').catch(() => {})
            } else if (reason === 'failed') {
              const detail = (data.reason && data.reason.error && (data.reason.error.message || data.reason.error.code)) || null
              setTransient('confused', 'turn-failed', detail ? brief(detail, 90) : null, 9000)
              void getBalance('auto').catch(() => {})
            } else {
              setTransient('confused', reason === 'aborted' ? 'turn-aborted' : 'turn-blocked', null, 5000)
              pendingCost = null
            }
            break
          }
          default:
            break
        }
      }

      const subscriptions = []
      try {
        subscriptions.push(ctx.on('session/event', (session, event) => {
          try {
            handleSessionEvent(session, event)
          } catch (err) {
            warn('会话事件处理失败：', brief(err))
          }
        }))
      } catch (err) {
        warn('无法订阅 session/event：', brief(err))
      }
      try {
        subscriptions.push(ctx.on('session/disposed', (session) => {
          try {
            const id = session && session.id ? String(session.id) : null
            if (id) tracks.delete(id)
          } catch {
            /* ignore */
          }
        }))
      } catch (err) {
        warn('无法订阅 session/disposed：', brief(err))
      }
      for (const dispose of subscriptions) local.push(dispose)

      /** 汇总所有会话，得出当前情境。 */
      function currentView() {
        const now = Date.now()
        // 顺手清掉半小时没动静的会话轨迹，避免长跑服务里 Map 只增不减
        if (tracks.size > 32) {
          for (const [id, track] of tracks) {
            if (track.turn === null && track.tools.size === 0 && now - (track.lastAt || 0) > 30 * 60 * 1000) tracks.delete(id)
          }
        }
        let activeTurns = 0
        let activeTools = 0
        let toolName = null
        for (const track of tracks.values()) {
          if (track.turn !== null) activeTurns += 1
          if (track.tools.size > 0) {
            activeTools += track.tools.size
            if (!toolName) toolName = toolLabel([...track.tools.values()][0])
          }
        }

        const balance = balanceCache
          ? {
              ok: Boolean(balanceCache.ok),
              level: levelOf(balanceCache, settings.lowBalance),
              total: balanceCache.total ?? null,
              currency: balanceCache.currency || 'CNY',
              symbol: balanceCache.symbol || '¥',
              granted: balanceCache.granted ?? null,
              toppedUp: balanceCache.toppedUp ?? null,
              available: balanceCache.available !== false,
              at: balanceCache.at || null,
              stale: Boolean(balanceCache.stale),
              threshold: settings.lowBalance,
              error: balanceCache.ok ? null : balanceCache.error || null,
            }
          : { ok: false, level: 'unknown', total: null, currency: 'CNY', symbol: '¥', threshold: settings.lowBalance, error: null }

        let phase = 'idle'
        let reason = 'idle'
        let detail = null
        const alertFresh =
          Boolean(balanceAlert) &&
          now - balanceAlert.at < clamp(settings.alertWindowMs, 1000, 300_000, DEFAULTS.alertWindowMs)
        if (activeTools > 0) {
          phase = 'busy'
          reason = 'tool'
          detail = toolName
        } else if (activeTurns > 0) {
          phase = 'thinking'
          reason = 'turn'
        } else if (transient && transient.until > now) {
          phase = transient.phase
          reason = transient.reason
          detail = transient.detail
        } else if (balance.level === 'empty') {
          // 余额真的见底：一直维持「疑惑」，因为这时候继续干活就会失败
          phase = 'confused'
          reason = 'balance-empty'
          detail = balance.error
        } else if (balance.level === 'error' && alertFresh) {
          phase = 'confused'
          reason = 'balance-error'
          detail = balance.error
        } else if (balance.level === 'low' && alertFresh) {
          phase = 'confused'
          reason = 'balance-low'
        }

        return {
          phase,
          reason,
          detail,
          since: transient && transient.phase === phase ? transient.at : now,
          active: { sessions: tracks.size, turns: activeTurns, tools: activeTools },
          balance,
          lastTurn,
          balanceAlert,
        }
      }

      // ————————————————————————————————————————————————
      // 路由
      // ————————————————————————————————————————————————
      function readAsset(file, contentType) {
        try {
          const bytes = fs.readFileSync(file)
          return { bytes, contentType }
        } catch (err) {
          warn(`资源读取失败 ${path.basename(file)}：`, brief(err))
          return null
        }
      }

      // 浏览器端脚本
      local.push(register({
        kind: 'exact',
        path: '/dsh-lanbao/widget.js',
        handler: async (req, res) => {
          const asset = readAsset(path.join(ASSETS_DIR, 'lanbao-widget.js'), 'application/javascript; charset=utf-8')
          if (!asset) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: 'widget.js 缺失' }))
            return
          }
          res.writeHead(200, {
            'Content-Type': asset.contentType,
            'Cache-Control': 'no-store',
          })
          res.end(asset.bytes)
        },
      }))

      // 表情图（前缀路由：/dsh-lanbao/expr/<name>.png）
      local.push(register({
        kind: 'prefix',
        path: '/dsh-lanbao/expr',
        handler: async (req, res) => {
          const url = new URL(req.url || '/', 'http://localhost')
          const name = decodeURIComponent(url.pathname.replace(/^\/dsh-lanbao\/expr\/?/, '')).replace(/\.webp$/i, '')
          if (!EXPRESSIONS.includes(name)) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: `未知表情 ${name}` }))
            return
          }
          const asset = readAsset(path.join(EXPR_DIR, `${name}.webp`), 'image/webp')
          if (!asset) {
            res.writeHead(404, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: '表情图缺失' }))
            return
          }
          res.writeHead(200, {
            'Content-Type': asset.contentType,
            'Cache-Control': 'public, max-age=604800',
          })
          res.end(asset.bytes)
        },
      }))

      // 主状态
      local.push(register({
        kind: 'exact',
        path: '/dsh-lanbao/state.json',
        handler: async (req, res) => {
          try {
            await getBalance('cache').catch(() => {})
            const view = currentView()
            sendJson(res, 200, {
              ok: true,
              at: Date.now(),
              version: BUILD_VERSION,
              ...view,
              settings: {
                visible: settings.visible !== false,
                size: settings.size,
                right: settings.right,
                bottom: settings.bottom,
                bubble: settings.bubble !== false,
                bubbleMs: settings.bubbleMs,
                lowBalance: settings.lowBalance,
              },
              expressions: EXPRESSIONS,
            })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: brief(err), at: Date.now(), phase: 'confused', reason: 'host-error' })
          }
        },
      }))

      // 强制刷新余额
      local.push(register({
        kind: 'exact',
        path: '/dsh-lanbao/refresh.json',
        handler: async (req, res) => {
          try {
            const sample = await getBalance('user')
            sendJson(res, 200, {
              ok: Boolean(sample && sample.ok),
              balance: sample
                ? {
                    ok: Boolean(sample.ok),
                    total: sample.total ?? null,
                    currency: sample.currency || 'CNY',
                    symbol: sample.symbol || '¥',
                    level: levelOf(sample, settings.lowBalance),
                    error: sample.ok ? null : sample.error || null,
                    at: sample.at || Date.now(),
                  }
                : null,
            })
          } catch (err) {
            sendJson(res, 200, { ok: false, error: brief(err) })
          }
        },
      }))

      // 设置读写
      local.push(register({
        kind: 'exact',
        path: '/dsh-lanbao/settings.json',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET' || req.method === undefined) {
              sendJson(res, 200, { ok: true, settings, file: SETTINGS_FILE })
              return
            }
            if (req.method !== 'POST' && req.method !== 'PUT') {
              res.writeHead(405, { ...JSON_HEADERS, Allow: 'GET, POST, PUT' })
              res.end(JSON.stringify({ ok: false, error: '不支持的方法' }))
              return
            }
            const chunks = []
            let size = 0
            await new Promise((resolve, reject) => {
              req.on('data', (chunk) => {
                size += chunk.length
                if (size > 64_000) {
                  reject(new Error('请求体过大'))
                  req.destroy()
                  return
                }
                chunks.push(chunk)
              })
              req.on('end', resolve)
              req.on('error', reject)
            })
            let parsed = {}
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            } catch {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
              return
            }
            const merged = normalizeSettings(parsed, settings)
            const written = writeSettings(merged)
            settings = { ...settings, ...written.settings }
            sendJson(res, written.ok ? 200 : 500, {
              ok: written.ok,
              settings,
              error: written.error || null,
            })
          } catch (err) {
            sendJson(res, 400, { ok: false, error: brief(err) })
          }
        },
      }))

      // 健康检查（排障用）
      local.push(register({
        kind: 'exact',
        path: '/dsh-lanbao/health.json',
        handler: async (req, res) => {
          const files = {}
          for (const name of ['lanbao-widget.js']) {
            try {
              const stat = fs.statSync(path.join(ASSETS_DIR, name))
              files[name] = { bytes: stat.size, mtime: stat.mtimeMs }
            } catch {
              files[name] = null
            }
          }
          const exprFiles = {}
          for (const name of EXPRESSIONS) {
            try {
              const stat = fs.statSync(path.join(EXPR_DIR, `${name}.webp`))
              exprFiles[name] = { bytes: stat.size, mtime: stat.mtimeMs }
            } catch {
              exprFiles[name] = null
            }
          }
          sendJson(res, 200, {
            ok: true,
            version: BUILD_VERSION,
            settingsFile: SETTINGS_FILE,
            hasCredentials: (() => {
              try {
                return Boolean(ctx.get('credentials'))
              } catch {
                return false
              }
            })(),
            files,
            expressions: exprFiles,
          })
        },
      }))

      // index.html 兜底注入（Web 形态走这里；桌面端走上面的结构化行）
      local.push(ctx.webServer.tapIndex((html) => {
        try {
          if (typeof html !== 'string' || html.includes(SCRIPT_SRC)) return html
          const tag = `<script defer src="${SCRIPT_SRC}"></script>`
          if (html.includes('</body>')) return html.replace('</body>', `${tag}</body>`)
          return html + tag
        } catch {
          return html
        }
      }))

      // 启动时预热一次余额，避免第一屏一直是「—」
      void getBalance('auto').catch(() => {})
      log(`已挂载，版本 ${BUILD_VERSION}，设置文件 ${SETTINGS_FILE}`)
    })
  },
}
