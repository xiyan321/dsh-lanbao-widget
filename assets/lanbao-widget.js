/**
 * 蓝宝挂件（浏览器端）
 *
 * 只做三件事：
 *   1. 把蓝宝画在右下角，按情境换表情（待机 / 思考 / 忙碌 / 开心 / 疑惑）；
 *   2. 用气泡说对应的话（情境台词 + 余额提示 + 每轮花费）；
 *   3. 提供一块小面板：余额明细、刷新、大小、低余额阈值、气泡开关。
 *
 * 全部 DOM 自带、样式加前缀，不依赖宿主框架，也不碰页面已有节点。
 */
(function () {
  'use strict'

  if (window.__dshLanbaoWidget) return
  window.__dshLanbaoWidget = true

  // ── 常量 ──────────────────────────────────────────────
  var API = {
    state: '/dsh-lanbao/state.json',
    settings: '/dsh-lanbao/settings.json',
    refresh: '/dsh-lanbao/refresh.json',
    expr: function (name) { return '/dsh-lanbao/expr/' + name + '.webp' }
  }
  var EXPRESSIONS = ['idle', 'thinking', 'busy', 'happy', 'confused']
  var LABEL = { idle: '待机', thinking: '思考', busy: '忙碌', happy: '开心', confused: '疑惑' }
  var DEFAULTS = {
    visible: true,
    size: 184,
    right: 24,
    bottom: 200,
    bubble: true,
    bubbleMs: 6000,
    lowBalance: 10
  }
  var POLL_MS = 1200
  var IDLE_CHAT_MIN = 75000
  var IDLE_CHAT_MAX = 155000
  var POS_KEY = 'dsh-lanbao:pos'
  var GREET_KEY = 'dsh-lanbao:greeted'
  var REDUCED = false
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch (e) {}

  // ── 台词库 ────────────────────────────────────────────
  var LINES = {
    idle: [
      '待机中…要不要派点活给我？',
      '我在的，叫我一声就来～',
      '没任务的时候，我就看看海。',
      '深海信号良好，随时开工。',
      '有点闲…要不要让我写点什么？',
      '兜帽里很暖，适合待机。'
    ],
    turn: [
      '让我想想……',
      '脑内小鲨鱼正在加速。',
      '唔，这个得捋一捋。',
      '别急，正在组织语言。',
      '在想了在想了。'
    ],
    tool: [
      '手上活儿有点多，稍等！',
      '正在搬砖…搬代码。',
      '工具已就位，开干。',
      '马上就好，别催啦。'
    ],
    completed: [
      '搞定！要不要检查一下？',
      '收工～夸我一句吧。',
      '这波还行吧？',
      '完成！我先摆个姿势。'
    ],
    failed: [
      '诶？好像出错了…',
      '这次翻车了，我看看日志。',
      '唔…报错了，要不要再试一次？'
    ],
    toolError: ['有个工具闹脾气了。', '工具那边出岔子了，我绕一下。'],
    interrupted: ['被打断了？那我停这儿。'],
    stopped: ['好，停下来了。'],
    low: [
      '余额有点低了，省着点用～',
      '钱包快瘪了，记得充点。',
      '余额告急，我尽量少跑几趟。'
    ],
    empty: ['余额见底了！先充点吧。', '0 元了…我真的干不动活了。'],
    balanceError: [
      '余额查不到了，检查下 API Key？',
      '拿不到余额，可能是网络或密钥的问题。'
    ],
    pet: [
      '嘿嘿，好痒～',
      '摸摸头可以，别扯帽子！',
      '再摸就要收费了……才怪。',
      '唔…舒服。',
      '只准摸三下。'
    ],
    first: ['我是蓝宝，深海来的。有活尽管派！']
  }

  var lastPick = {}
  function pick(key) {
    var list = LINES[key] || LINES.idle
    var value = list[Math.floor(Math.random() * list.length)]
    if (list.length > 1 && value === lastPick[key]) {
      value = list[(list.indexOf(value) + 1) % list.length]
    }
    lastPick[key] = value
    return value
  }

  function money(value, symbol) {
    var n = Number(value)
    if (!isFinite(n)) return '—'
    var abs = Math.abs(n)
    var digits = abs >= 100 ? 1 : abs >= 1 ? 2 : 3
    return (symbol || '¥') + n.toFixed(digits)
  }

  // ── 状态 ──────────────────────────────────────────────
  var settings = Object.assign({}, DEFAULTS)
  var view = { phase: 'idle', reason: 'idle', detail: null }
  var balance = null
  var lastTurn = null
  var lastTurnAt = 0
  // 初值是 null：首帧必须真的加载一次 idle.png，否则前面两个 <img> 一直是空的
  var expression = null
  var failStreak = 0
  var firstRun = true
  var pollTimer = 0
  var idleChatTimer = 0
  var bubble = { priority: -1, until: 0 }
  var dragging = null
  var lastDragEndAt = 0
  var lastLocalMoveAt = 0
  var panelOpen = false

  // ── DOM 骨架 ──────────────────────────────────────────
  var root = document.createElement('div')
  root.className = 'lbd-root'
  root.innerHTML = [
    '<div class="lbd-bubble" role="status" aria-live="polite" hidden>',
    '  <span class="lbd-bubble-text"></span>',
    '  <i class="lbd-dots"><b></b><b></b><b></b></i>',
    '</div>',
    '<div class="lbd-actor" role="button" tabindex="0" aria-label="蓝宝，点一下摸摸头">',
    '  <img class="lbd-img is-front" alt="" draggable="false">',
    '  <img class="lbd-img is-back" alt="" draggable="false">',
    '</div>',
    '<button class="lbd-chip" type="button" aria-label="查看余额详情">',
    '  <i class="lbd-dot"></i>',
    '  <span class="lbd-chip-text">余额 —</span>',
    '</button>',
    '<button class="lbd-restore" type="button" title="叫出蓝宝" aria-label="叫出蓝宝">蓝</button>',
    '<div class="lbd-panel" role="dialog" aria-label="蓝宝设置" hidden>',
    '  <div class="lbd-panel-head">',
    '    <strong>蓝宝</strong>',
    '    <span class="lbd-panel-state"></span>',
    '    <button class="lbd-close" type="button" aria-label="关闭">×</button>',
    '  </div>',
    '  <div class="lbd-balance">',
    '    <div class="lbd-balance-main">',
    '      <span class="lbd-balance-num">—</span>',
    '      <button class="lbd-refresh" type="button">刷新</button>',
    '    </div>',
    '    <div class="lbd-balance-sub"></div>',
    '    <div class="lbd-turn-cost"></div>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>大小</label>',
    '    <div class="lbd-stepper">',
    '      <button type="button" data-size="-1">−</button>',
    '      <span class="lbd-size-val">168</span>',
    '      <button type="button" data-size="1">+</button>',
    '    </div>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>低余额提醒</label>',
    '    <div class="lbd-stepper">',
    '      <button type="button" data-threshold="-1">−</button>',
    '      <span class="lbd-threshold-val">¥10</span>',
    '      <button type="button" data-threshold="1">+</button>',
    '    </div>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>气泡</label>',
    '    <button class="lbd-toggle" type="button" data-toggle="bubble">开</button>',
    '  </div>',
    '  <div class="lbd-row lbd-row-end">',
    '    <a class="lbd-link" href="/dsh-lanbao/state.json" target="_blank" rel="noreferrer">状态 JSON</a>',
    '    <button class="lbd-hide" type="button">隐藏蓝宝</button>',
    '  </div>',
    '</div>'
  ].join('')

  var style = document.createElement('style')
  style.textContent = [
    '.lbd-root{position:fixed;z-index:20400;right:24px;bottom:200px;display:flex;flex-direction:column;align-items:center;gap:6px;',
    '  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    '  -webkit-user-select:none;user-select:none;pointer-events:none;transition:opacity .22s ease;}',
    '.lbd-root.is-hidden .lbd-actor,.lbd-root.is-hidden .lbd-bubble,.lbd-root.is-hidden .lbd-chip,.lbd-root.is-hidden .lbd-panel{display:none}',
    '.lbd-restore{display:none;pointer-events:auto;width:30px;height:30px;border-radius:50%;border:1px solid rgba(38,74,140,.2);',
    '  background:rgba(255,255,255,.9);color:#2a5da8;font:inherit;font-size:12px;cursor:pointer;align-items:center;justify-content:center;',
    '  box-shadow:0 4px 12px rgba(24,46,86,.14);opacity:.62;transition:opacity .18s ease,transform .18s ease}',
    '.lbd-restore:hover{opacity:1;transform:translateY(-1px)}',
    '.lbd-root.is-hidden .lbd-restore{display:flex}',
    '.lbd-root.is-dark .lbd-restore{background:rgba(32,40,54,.92);color:#a8c8f0;border-color:rgba(120,160,225,.28)}',
    '.lbd-actor{position:relative;width:168px;height:168px;pointer-events:auto;cursor:grab;touch-action:none;',
    '  filter:drop-shadow(0 10px 18px rgba(28,52,92,.22));transition:width .18s ease,height .18s ease;',
    '  animation:lbd-float 4.2s ease-in-out infinite;transform-origin:50% 92%;}',
    '.lbd-actor:active{cursor:grabbing}',
    '.lbd-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;',
    '  transition:opacity .24s ease,transform .3s ease;pointer-events:none;-webkit-user-drag:none;}',
    '.lbd-img.is-front{opacity:1}',
    '.lbd-bubble{pointer-events:none;max-width:232px;min-width:64px;padding:8px 12px;border-radius:14px;',
    '  background:rgba(255,255,255,.97);color:#1f2a3d;border:1px solid rgba(38,74,140,.14);',
    '  box-shadow:0 8px 22px rgba(24,46,86,.16);position:relative;opacity:0;transform:translateY(6px) scale(.96);',
    '  transition:opacity .18s ease,transform .18s ease;text-align:center;line-height:1.5;word-break:break-word;}',
    '.lbd-bubble.is-show{opacity:1;transform:translateY(0) scale(1)}',
    '.lbd-bubble::after{content:"";position:absolute;left:50%;bottom:-6px;width:12px;height:12px;margin-left:-6px;',
    '  background:inherit;border-right:1px solid rgba(38,74,140,.14);border-bottom:1px solid rgba(38,74,140,.14);',
    '  transform:rotate(45deg);border-bottom-right-radius:3px;}',
    '.lbd-bubble.is-warn{background:#fff8e6;border-color:rgba(196,138,20,.4);color:#6b4a00}',
    '.lbd-bubble.is-error{background:#fff0f0;border-color:rgba(196,52,52,.35);color:#7a1f1f}',
    '.lbd-bubble.is-happy{background:#eef8ff;border-color:rgba(38,96,180,.24);color:#123a6b}',
    '.lbd-dots{display:none;margin-left:4px;gap:3px}',
    '.lbd-bubble.is-thinking .lbd-dots{display:inline-flex}',
    '.lbd-dots b{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.45;animation:lbd-blink 1.1s infinite}',
    '.lbd-dots b:nth-child(2){animation-delay:.18s}',
    '.lbd-dots b:nth-child(3){animation-delay:.36s}',
    '.lbd-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;border:1px solid rgba(38,74,140,.16);',
    '  background:rgba(255,255,255,.94);color:#22314a;border-radius:999px;padding:4px 11px;font:inherit;font-size:12px;',
    '  cursor:pointer;box-shadow:0 4px 12px rgba(24,46,86,.12);transition:transform .15s ease,box-shadow .15s ease,background .15s;}',
    '.lbd-chip:hover{transform:translateY(-1px);box-shadow:0 6px 16px rgba(24,46,86,.18)}',
    '.lbd-dot{width:7px;height:7px;border-radius:50%;background:#3d7bd6;box-shadow:0 0 0 3px rgba(61,123,214,.16)}',
    '.lbd-chip.is-low .lbd-dot{background:#d99512;box-shadow:0 0 0 3px rgba(217,149,18,.18)}',
    '.lbd-chip.is-empty .lbd-dot,.lbd-chip.is-error .lbd-dot{background:#d24b4b;box-shadow:0 0 0 3px rgba(210,75,75,.18)}',
    '.lbd-chip.is-low{border-color:rgba(196,138,20,.4);background:rgba(255,249,232,.96)}',
    '.lbd-chip.is-empty,.lbd-chip.is-error{border-color:rgba(196,52,52,.35);background:rgba(255,241,241,.96);color:#7a1f1f}',
    '.lbd-panel{pointer-events:auto;position:fixed;right:0;top:0;width:264px;box-sizing:border-box;overflow:auto;',
    '  overscroll-behavior:contain;',
    '  background:rgba(255,255,255,.985);border:1px solid rgba(38,74,140,.16);border-radius:16px;padding:12px 14px 10px;',
    '  box-shadow:0 18px 44px rgba(20,40,78,.22);color:#1f2a3d;display:flex;flex-direction:column;gap:9px;}',
    '.lbd-panel[hidden]{display:none}',
    '.lbd-panel-head{display:flex;align-items:center;gap:8px}',
    '.lbd-panel-head strong{font-size:14px}',
    '.lbd-panel-state{font-size:11px;color:#5b6d88;background:rgba(61,123,214,.1);border-radius:999px;padding:2px 8px}',
    '.lbd-close{margin-left:auto;border:0;background:transparent;color:#6b7c95;font-size:17px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.lbd-close:hover{background:rgba(38,74,140,.08)}',
    '.lbd-balance{background:rgba(61,123,214,.06);border-radius:12px;padding:9px 11px}',
    '.lbd-balance-main{display:flex;align-items:baseline;gap:8px}',
    '.lbd-balance-num{font-size:20px;font-weight:600;letter-spacing:.2px}',
    '.lbd-balance.is-low .lbd-balance-num{color:#a8700a}',
    '.lbd-balance.is-empty .lbd-balance-num,.lbd-balance.is-error .lbd-balance-num{color:#b33636}',
    '.lbd-refresh{margin-left:auto;border:1px solid rgba(38,74,140,.18);background:#fff;border-radius:8px;padding:3px 9px;',
    '  font:inherit;font-size:12px;color:#2a3d5c;cursor:pointer}',
    '.lbd-refresh:hover{background:rgba(61,123,214,.08)}',
    '.lbd-refresh[disabled]{opacity:.55;cursor:default}',
    '.lbd-balance-sub{font-size:11.5px;color:#5b6d88;margin-top:3px}',
    '.lbd-turn-cost{font-size:11.5px;color:#5b6d88;margin-top:2px}',
    '.lbd-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12.5px}',
    '.lbd-row label{color:#48586f}',
    '.lbd-stepper{display:inline-flex;align-items:center;gap:6px}',
    '.lbd-stepper button{width:24px;height:24px;border-radius:7px;border:1px solid rgba(38,74,140,.18);background:#fff;',
    '  color:#2a3d5c;font:inherit;line-height:1;cursor:pointer}',
    '.lbd-stepper button:hover{background:rgba(61,123,214,.08)}',
    '.lbd-stepper span{min-width:46px;text-align:center;font-variant-numeric:tabular-nums}',
    '.lbd-toggle{border:1px solid rgba(38,74,140,.18);background:#fff;border-radius:8px;padding:3px 12px;font:inherit;',
    '  font-size:12px;color:#2a3d5c;cursor:pointer;min-width:52px}',
    '.lbd-toggle.is-on{background:rgba(61,123,214,.12);border-color:rgba(61,123,214,.4);color:#1d4e96}',
    '.lbd-row-end{border-top:1px solid rgba(38,74,140,.1);padding-top:8px;margin-top:1px}',
    '.lbd-link{color:#5b6d88;font-size:11.5px;text-decoration:none}',
    '.lbd-link:hover{text-decoration:underline}',
    '.lbd-hide{border:0;background:transparent;color:#a03636;font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.lbd-hide:hover{background:rgba(196,52,52,.09)}',
    '@keyframes lbd-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}',
    '@keyframes lbd-blink{0%,100%{opacity:.25}50%{opacity:1}}',
    '@keyframes lbd-bounce{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-14px) scale(1.04)}60%{transform:translateY(0) scale(.98)}80%{transform:translateY(-5px) scale(1.01)}100%{transform:translateY(0) scale(1)}}',
    '@keyframes lbd-shake{0%,100%{transform:translateX(0) rotate(0)}25%{transform:translateX(-3px) rotate(-1.2deg)}75%{transform:translateX(3px) rotate(1.2deg)}}',
    '@keyframes lbd-tilt{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}',
    '.lbd-actor.is-thinking{animation:lbd-float 2.6s ease-in-out infinite}',
    '.lbd-actor.is-busy{animation:lbd-shake .5s ease-in-out infinite}',
    '.lbd-actor.is-happy{animation:lbd-bounce .85s ease-out 1,lbd-float 4s ease-in-out .85s infinite}',
    '.lbd-actor.is-confused{animation:lbd-tilt 2.2s ease-in-out infinite}',
    '.lbd-root.is-reduced .lbd-actor,.lbd-root.is-reduced .lbd-dots b{animation:none!important}',
    '.lbd-root.is-dragging .lbd-actor{animation:none!important}',
    // 深色皮：不跟系统 prefers-color-scheme 走，而是采样页面底色后挂 .is-dark，
    // 因为 DSH 的主题是应用内切换的，不一定和系统一致。
    '.lbd-root.is-dark .lbd-bubble{background:rgba(32,40,54,.97);color:#e7eefa;border-color:rgba(120,160,225,.24)}',
    '.lbd-root.is-dark .lbd-bubble::after{border-right-color:rgba(120,160,225,.24);border-bottom-color:rgba(120,160,225,.24)}',
    '.lbd-root.is-dark .lbd-bubble.is-warn{background:#3a2f14;color:#f0d79a;border-color:rgba(214,164,50,.4)}',
    '.lbd-root.is-dark .lbd-bubble.is-error{background:#3a1d1d;color:#f3c3c3;border-color:rgba(220,90,90,.4)}',
    '.lbd-root.is-dark .lbd-bubble.is-happy{background:#132a46;color:#cfe3ff;border-color:rgba(96,150,225,.3)}',
    '.lbd-root.is-dark .lbd-chip{background:rgba(32,40,54,.94);color:#e2eaf7;border-color:rgba(120,160,225,.24)}',
    '.lbd-root.is-dark .lbd-chip.is-low{background:rgba(58,47,20,.95);color:#f2dca4;border-color:rgba(214,164,50,.4)}',
    '.lbd-root.is-dark .lbd-chip.is-empty,.lbd-root.is-dark .lbd-chip.is-error{background:rgba(58,29,29,.95);color:#f5cccc;border-color:rgba(220,90,90,.4)}',
    '.lbd-root.is-dark .lbd-panel{background:rgba(26,33,45,.985);color:#e6edf8;border-color:rgba(120,160,225,.22)}',
    '.lbd-root.is-dark .lbd-balance{background:rgba(96,150,225,.12)}',
    '.lbd-root.is-dark .lbd-balance.is-low .lbd-balance-num{color:#e8b96a}',
    '.lbd-root.is-dark .lbd-balance.is-empty .lbd-balance-num,.lbd-root.is-dark .lbd-balance.is-error .lbd-balance-num{color:#f0a3a3}',
    '.lbd-root.is-dark .lbd-panel-state{color:#adc2df;background:rgba(96,150,225,.18)}',
    '.lbd-root.is-dark .lbd-row label,.lbd-root.is-dark .lbd-balance-sub,.lbd-root.is-dark .lbd-turn-cost,.lbd-root.is-dark .lbd-link{color:#a8bad4}',
    '.lbd-root.is-dark .lbd-stepper button,.lbd-root.is-dark .lbd-toggle,.lbd-root.is-dark .lbd-refresh{background:rgba(255,255,255,.06);color:#d7e3f5;border-color:rgba(120,160,225,.26)}',
    '.lbd-root.is-dark .lbd-toggle.is-on{background:rgba(96,150,225,.24);color:#cfe2ff}',
    '.lbd-root.is-dark .lbd-row-end{border-top-color:rgba(120,160,225,.14)}',
    '.lbd-root.is-dark .lbd-close{color:#93a7c4}',
    '.lbd-root.is-dark .lbd-hide{color:#ef9c9c}'
  ].join('\n')
  ;(document.head || document.documentElement).appendChild(style)
  ;(document.body || document.documentElement).appendChild(root)

  var actor = root.querySelector('.lbd-actor')
  var front = root.querySelector('.lbd-img.is-front')
  var back = root.querySelector('.lbd-img.is-back')
  var bubbleEl = root.querySelector('.lbd-bubble')
  var bubbleText = root.querySelector('.lbd-bubble-text')
  var chip = root.querySelector('.lbd-chip')
  var chipText = root.querySelector('.lbd-chip-text')
  var panel = root.querySelector('.lbd-panel')
  var panelState = root.querySelector('.lbd-panel-state')
  var balanceBox = root.querySelector('.lbd-balance')
  var balanceNum = root.querySelector('.lbd-balance-num')
  var balanceSub = root.querySelector('.lbd-balance-sub')
  var turnCostEl = root.querySelector('.lbd-turn-cost')
  var refreshBtn = root.querySelector('.lbd-refresh')
  var sizeVal = root.querySelector('.lbd-size-val')
  var thresholdVal = root.querySelector('.lbd-threshold-val')
  var toggleBtn = root.querySelector('[data-toggle="bubble"]')

  if (REDUCED) root.classList.add('is-reduced')

  // ── 主题探测 ──────────────────────────────────────────
  // DSH 的主题是应用内切换的，不一定跟系统 prefers-color-scheme 一致，
  // 所以优先采样页面实际底色，探不出来才回退到媒体查询。
  var mediaDark = false
  try { mediaDark = window.matchMedia('(prefers-color-scheme: dark)').matches } catch (e) {}

  function parseRgb(color) {
    var m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(String(color || ''))
    if (!m) return null
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }
  }

  function detectDark() {
    var nodes = [document.body, document.documentElement]
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i]
      if (!el) continue
      var rgb = parseRgb(window.getComputedStyle(el).backgroundColor)
      if (!rgb || rgb.a < 0.35) continue
      var luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
      return luminance < 120
    }
    return mediaDark
  }

  var themed = null
  function applyTheme() {
    var dark = detectDark()
    if (dark === themed) return
    themed = dark
    root.classList.toggle('is-dark', dark)
  }

  // ── 表情切换（双图层交叉淡入）────────────────────────
  var buffer = null

  function preload() {
    buffer = {}
    EXPRESSIONS.forEach(function (name) {
      var img = new Image()
      img.src = API.expr(name)
      buffer[name] = img
    })
  }

  function setExpression(name) {
    if (!EXPRESSIONS.includes(name) || name === expression) return
    var next = buffer && buffer[name]
    var src = API.expr(name)
    expression = name
    var apply = function () {
      back.src = src
      back.classList.remove('is-back')
      back.classList.add('is-front')
      front.classList.remove('is-front')
      front.classList.add('is-back')
      var tmp = front
      front = back
      back = tmp
    }
    if (next && next.complete && next.naturalWidth > 0) apply()
    else {
      var loader = new Image()
      loader.onload = apply
      loader.onerror = apply
      loader.src = src
    }
  }

  function setPhase(phase) {
    actor.classList.remove('is-idle', 'is-thinking', 'is-busy', 'is-happy', 'is-confused')
    actor.classList.add('is-' + (EXPRESSIONS.includes(phase) ? phase : 'idle'))
    setExpression(phase)
  }

  // ── 气泡 ──────────────────────────────────────────────
  function showBubble(text, options) {
    if (!settings.bubble || !text) return
    var opts = options || {}
    var priority = opts.priority === undefined ? 1 : opts.priority
    var now = Date.now()
    if (priority < bubble.priority && now < bubble.until) return
    bubble.priority = priority
    bubble.until = now + (opts.ttl || settings.bubbleMs)
    bubbleText.textContent = text
    bubbleEl.hidden = false
    bubbleEl.classList.toggle('is-warn', opts.tone === 'warn')
    bubbleEl.classList.toggle('is-error', opts.tone === 'error')
    bubbleEl.classList.toggle('is-happy', opts.tone === 'happy')
    bubbleEl.classList.toggle('is-thinking', !!opts.thinking)
    bubbleEl.classList.add('is-show')
    window.clearTimeout(showBubble.timer)
    showBubble.timer = window.setTimeout(function () {
      bubbleEl.classList.remove('is-show')
      bubble.priority = -1
    }, opts.sticky ? Math.max(1200, settings.bubbleMs) : bubble.until - now)
  }

  function hideBubble() {
    bubbleEl.classList.remove('is-show')
    bubble.priority = -1
  }

  // ── 渲染 ──────────────────────────────────────────────
  /**
   * 本地刚改过的字段，短时间内不让服务端值覆盖。
   * 起因是个真实竞态：用户点「隐藏」后发出 POST，但一次**早已在途**的轮询响应
   * 可能随后到达，带着旧的 visible:true，把界面刷回显示状态。
   */
  var localUntil = {}
  var LOCAL_GRACE_MS = 1800

  function applySettings(next, opts) {
    var force = Boolean(opts && opts.force)
    var now = Date.now()
    var merged = Object.assign({}, settings)
    Object.keys(next || {}).forEach(function (key) {
      if (!force && localUntil[key] && localUntil[key] > now) return
      merged[key] = next[key]
    })
    settings = merged
    root.classList.toggle('is-hidden', settings.visible === false)
    actor.style.width = settings.size + 'px'
    actor.style.height = settings.size + 'px'
    sizeVal.textContent = String(settings.size)
    thresholdVal.textContent = '¥' + settings.lowBalance
    toggleBtn.textContent = settings.bubble ? '开' : '关'
    toggleBtn.classList.toggle('is-on', !!settings.bubble)
    positionFromSettings()
  }

  function positionFromSettings() {
    // 刚拖完的一小段时间内以本地位置为准，免得下一次轮询把角色弹回旧坐标
    if (Date.now() - lastLocalMoveAt < 2500) return
    var right = settings.right
    var bottom = settings.bottom
    if (right === null || right === undefined || bottom === null || bottom === undefined) return
    root.style.right = right + 'px'
    root.style.bottom = bottom + 'px'
  }

  function renderBalance() {
    var level = (balance && balance.level) || 'unknown'
    var symbol = (balance && balance.symbol) || '¥'
    var total = balance && balance.total
    var text = level === 'unknown'
      ? '余额 —'
      : level === 'error'
        ? '余额读取失败'
        : '余额 ' + money(total, symbol)

    chipText.textContent = text
    chip.classList.remove('is-low', 'is-empty', 'is-error')
    if (level === 'low') chip.classList.add('is-low')
    if (level === 'empty') chip.classList.add('is-empty')
    if (level === 'error') chip.classList.add('is-error')

    balanceBox.classList.remove('is-low', 'is-empty', 'is-error')
    if (level === 'low') balanceBox.classList.add('is-low')
    if (level === 'empty') balanceBox.classList.add('is-empty')
    if (level === 'error') balanceBox.classList.add('is-error')

    balanceNum.textContent = level === 'error' ? '—' : level === 'unknown' ? '—' : money(total, symbol)

    var sub = []
    if (level === 'error' && balance && balance.error) sub.push(balance.error)
    else if (level === 'unknown') sub.push('正在获取…')
    else {
      if (balance.granted !== null && balance.granted !== undefined) sub.push('赠金 ' + money(balance.granted, symbol))
      if (balance.toppedUp !== null && balance.toppedUp !== undefined) sub.push('充值 ' + money(balance.toppedUp, symbol))
      if (balance.stale) sub.push('· 缓存')
      sub.push('阈值 ' + money(settings.lowBalance, symbol))
    }
    balanceSub.textContent = sub.join(' · ')

    if (lastTurn && lastTurn.cost !== null && lastTurn.cost !== undefined) {
      var when = new Date(lastTurn.at)
      var hh = String(when.getHours()).padStart(2, '0')
      var mm = String(when.getMinutes()).padStart(2, '0')
      turnCostEl.textContent = '上一轮花费 ' + money(lastTurn.cost, lastTurn.symbol || symbol) + ' · ' + hh + ':' + mm
    } else {
      turnCostEl.textContent = ''
    }
  }

  function phaseText() {
    if (view.phase === 'busy' && view.detail) return '忙碌 · ' + view.detail
    return LABEL[view.phase] || '待机'
  }

  function balanceTone(level) {
    if (level === 'low') return 'warn'
    if (level === 'empty' || level === 'error') return 'error'
    return 'happy'
  }

  /** 把宿主返回的 view 映射成「表情 + 一句话」。 */
  function reactTo(next, opts) {
    var options = opts || {}
    var previousReason = view.reason
    var previousPhase = view.phase
    view = {
      phase: next.phase || 'idle',
      reason: next.reason || 'idle',
      detail: next.detail || null
    }
    balance = next.balance || null
    lastTurn = next.lastTurn || null
    setPhase(view.phase)
    panelState.textContent = phaseText()

    var changedReason = previousReason !== view.reason || previousPhase !== view.phase
    if (!changedReason && !options.force) return

    // 每轮花费优先播报（余额提示的核心：一轮花了多少、剩多少）
    if (lastTurn && lastTurn.at && lastTurn.at !== lastTurnAt) {
      lastTurnAt = lastTurn.at
      showBubble('这轮花了 ' + money(lastTurn.cost, lastTurn.symbol) + '，余额 ' + money(lastTurn.after, lastTurn.symbol), {
        priority: 3,
        ttl: Math.max(settings.bubbleMs, 6500),
        tone: balanceTone(balance && balance.level)
      })
      return
    }

    switch (view.reason) {
      case 'tool':
        showBubble(pick('tool') + (view.detail ? '（' + view.detail + '）' : ''), { priority: 1 })
        break
      case 'turn':
        showBubble(pick('turn'), { priority: 1, thinking: true, ttl: Math.max(settings.bubbleMs, 5000) })
        break
      case 'turn-completed':
        showBubble(pick('completed'), { priority: 2, tone: 'happy' })
        break
      case 'turn-failed':
        showBubble(view.detail ? pick('failed') + '（' + view.detail + '）' : pick('failed'), { priority: 4, tone: 'error', ttl: 9000 })
        break
      case 'tool-error':
        showBubble(pick('toolError'), { priority: 2, tone: 'warn' })
        break
      case 'interrupted':
        showBubble(pick('interrupted'), { priority: 2, tone: 'warn' })
        break
      case 'turn-aborted':
      case 'turn-blocked':
        showBubble(pick('stopped'), { priority: 2 })
        break
      case 'balance-error':
        showBubble(pick('balanceError'), { priority: 4, tone: 'error', ttl: 12000 })
        break
      case 'balance-empty':
        showBubble(pick('empty'), { priority: 4, tone: 'error' })
        break
      case 'balance-low':
        showBubble(pick('low'), { priority: 3, tone: 'warn' })
        break
      case 'idle':
      default:
        if (options.idleChat) showBubble(pick('idle'), { priority: 0 })
        break
    }
  }

  // ── 轮询 ──────────────────────────────────────────────
  function scheduleIdleChat() {
    window.clearTimeout(idleChatTimer)
    var wait = IDLE_CHAT_MIN + Math.random() * (IDLE_CHAT_MAX - IDLE_CHAT_MIN)
    idleChatTimer = window.setTimeout(function () {
      if (view.phase === 'idle' && document.visibilityState === 'visible') {
        showBubble(pick('idle'), { priority: 0, ttl: 5200 })
      }
      scheduleIdleChat()
    }, wait)
  }

  function poll() {
    fetch(API.state, { credentials: 'same-origin', cache: 'no-store' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        failStreak = 0
        if (!data || data.ok === false) {
          showBubble(pick('balanceError'), { priority: 3, tone: 'error' })
          return
        }
        applySettings(data.settings)
        applyTheme()
        reactTo(data, { idleChat: false })
        renderBalance()
        if (firstRun) {
          firstRun = false
          // 开场白只在第一次见面说，之后刷新页面直接进入情境台词
          try {
            if (!window.localStorage.getItem(GREET_KEY)) {
              window.localStorage.setItem(GREET_KEY, '1')
              showBubble(pick('first'), { priority: 5, ttl: 5200 })
            }
          } catch (e) {
            showBubble(pick('first'), { priority: 5, ttl: 5200 })
          }
        }
      })
      .catch(function () {
        failStreak += 1
        setPhase('confused')
        if (failStreak >= 3) {
          showBubble('连不上宿主了，蓝宝暂时下线…', { priority: 4, tone: 'error', ttl: 12000 })
        }
      })
      .then(function () {
        window.clearTimeout(pollTimer)
        pollTimer = window.setTimeout(poll, failStreak > 0 ? Math.min(8000, POLL_MS * failStreak) : POLL_MS)
      })
  }

  // ── 设置写回 ──────────────────────────────────────────
  var saveTimer = 0
  function persistSettings(patch) {
    var now = Date.now()
    // 本地改动必须无条件生效，再立个"保护期"挡住随后到达的旧轮询响应
    if (patch && (patch.right !== undefined || patch.bottom !== undefined)) lastLocalMoveAt = now
    applySettings(patch, { force: true })
    Object.keys(patch || {}).forEach(function (key) {
      localUntil[key] = now + LOCAL_GRACE_MS
    })
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(function () {
      fetch(API.settings, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }).catch(function () {})
    }, 260)
  }

  // ── 交互 ──────────────────────────────────────────────
  function pet() {
    setPhase('happy')
    actor.classList.add('is-happy')
    showBubble(pick('pet'), { priority: 5, tone: 'happy', ttl: 4200 })
    window.setTimeout(function () {
      if (view.phase !== 'happy') setPhase(view.phase)
    }, 4200)
  }

  actor.addEventListener('click', function (event) {
    // pointerup 之后浏览器还会补一个 click，用它区分「拖拽」和「点一下」
    if (Date.now() - lastDragEndAt < 320) return
    event.preventDefault()
    pet()
  })
  actor.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pet()
    }
  })

  // 拖拽：用 pointer 事件，落位写回设置
  actor.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return
    var rect = root.getBoundingClientRect()
    dragging = {
      startX: event.clientX,
      startY: event.clientY,
      originRight: window.innerWidth - rect.right,
      originBottom: window.innerHeight - rect.bottom,
      moved: false
    }
    root.classList.add('is-dragging')
    try { actor.setPointerCapture(event.pointerId) } catch (e) {}
  })

  actor.addEventListener('pointermove', function (event) {
    if (!dragging) return
    var dx = event.clientX - dragging.startX
    var dy = event.clientY - dragging.startY
    if (!dragging.moved && Math.abs(dx) + Math.abs(dy) < 5) return
    // 真的开始拖了才收面板：单纯点一下当抚摸，不该把面板关掉
    if (!dragging.moved && panelOpen) {
      panelOpen = false
      panel.hidden = true
    }
    dragging.moved = true
    var right = Math.max(0, Math.min(window.innerWidth - 40, dragging.originRight - dx))
    var bottom = Math.max(0, Math.min(window.innerHeight - 40, dragging.originBottom - dy))
    root.style.right = right + 'px'
    root.style.bottom = bottom + 'px'
  })

  function endDrag() {
    if (!dragging) return
    var moved = dragging.moved
    dragging = null
    root.classList.remove('is-dragging')
    if (!moved) return
    lastDragEndAt = Date.now()
    var right = Math.round(parseFloat(root.style.right) || 0)
    var bottom = Math.round(parseFloat(root.style.bottom) || 0)
    try { window.localStorage.setItem(POS_KEY, JSON.stringify({ right: right, bottom: bottom })) } catch (e) {}
    persistSettings({ right: right, bottom: bottom })
  }
  actor.addEventListener('pointerup', endDrag)
  actor.addEventListener('pointercancel', endDrag)
  actor.addEventListener('pointerleave', function () { if (dragging && dragging.moved) endDrag() })

  chip.addEventListener('click', function (event) {
    event.stopPropagation()
    togglePanel()
  })

  /**
   * 面板以角色为锚：右对齐角色的右边，垂直方向夹在视口内。
   * 默认开在角色上方，上方放不下就翻到下方，还放不下就限高滚动。
   */
  function placePanel() {
    var actorRect = actor.getBoundingClientRect()
    var width = Math.max(236, Math.min(300, window.innerWidth - 24))
    panel.style.width = width + 'px'
    panel.style.right = Math.max(8, Math.min(window.innerWidth - width - 8, window.innerWidth - actorRect.right)) + 'px'
    panel.style.bottom = 'auto'
    panel.style.maxHeight = Math.max(200, window.innerHeight - 16) + 'px'

    var height = panel.offsetHeight
    var top = actorRect.top - height - 10
    if (top < 8) top = actorRect.bottom + 10
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
    panel.style.top = top + 'px'
  }

  function togglePanel() {
    panelOpen = !panelOpen
    panel.hidden = !panelOpen
    if (panelOpen) {
      renderBalance()
      panelState.textContent = phaseText()
      placePanel()
    }
  }

  panel.querySelector('.lbd-close').addEventListener('click', function () { panelOpen = false; panel.hidden = true })

  refreshBtn.addEventListener('click', function () {
    refreshBtn.disabled = true
    refreshBtn.textContent = '刷新中…'
    fetch(API.refresh, { credentials: 'same-origin', method: 'POST' })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (data && data.balance) {
          balance = Object.assign({}, balance, data.balance)
          renderBalance()
          showBubble(data.ok ? '余额已更新：' + money(data.balance.total, data.balance.symbol) : pick('balanceError'), {
            priority: 4,
            tone: data.ok ? 'happy' : 'error'
          })
        }
      })
      .catch(function () { showBubble(pick('balanceError'), { priority: 4, tone: 'error' }) })
      .then(function () {
        refreshBtn.disabled = false
        refreshBtn.textContent = '刷新'
      })
  })

  panel.querySelectorAll('[data-size]').forEach(function (button) {
    button.addEventListener('click', function () {
      var step = Number(button.getAttribute('data-size'))
      persistSettings({ size: Math.max(96, Math.min(360, settings.size + step * 16)) })
    })
  })

  panel.querySelectorAll('[data-threshold]').forEach(function (button) {
    button.addEventListener('click', function () {
      var step = Number(button.getAttribute('data-threshold'))
      var next = Math.max(0, Math.min(1000, (Number(settings.lowBalance) || 0) + step * 5))
      persistSettings({ lowBalance: next })
      setTimeout(poll, 320)
    })
  })

  toggleBtn.addEventListener('click', function () {
    var on = !settings.bubble
    persistSettings({ bubble: on })
    if (!on) hideBubble()
  })

  panel.querySelector('.lbd-hide').addEventListener('click', function () {
    persistSettings({ visible: false })
    panelOpen = false
    panel.hidden = true
  })

  root.querySelector('.lbd-restore').addEventListener('click', function () {
    persistSettings({ visible: true })
    showBubble('我回来了！', { priority: 5, tone: 'happy' })
  })

  document.addEventListener('click', function (event) {
    if (!panelOpen) return
    if (root.contains(event.target)) return
    panelOpen = false
    panel.hidden = true
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && panelOpen) {
      panelOpen = false
      panel.hidden = true
    }
  })

  window.addEventListener('resize', function () {
    if (panelOpen) placePanel()
  })

  // ── 启动 ──────────────────────────────────────────────
  try {
    var saved = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null')
    if (saved && typeof saved.right === 'number' && typeof saved.bottom === 'number') {
      settings.right = saved.right
      settings.bottom = saved.bottom
    }
  } catch (e) {}

  actor.style.width = settings.size + 'px'
  actor.style.height = settings.size + 'px'
  positionFromSettings()
  applyTheme()
  preload()
  setPhase('idle')
  renderBalance()
  poll()
  scheduleIdleChat()

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll()
  })
})()
