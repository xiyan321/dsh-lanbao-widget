/**
 * 蓝宝挂件（浏览器端）
 *
 * 三块界面：
 *   1. 角色：按情境换表情（待机 / 思考 / 忙碌 / 开心 / 疑惑），左键摸摸头、拖动换位置；
 *   2. 椭圆气泡：说一句话，并常驻显示余额；不说话时收成只显示余额的小胶囊；
 *      点气泡 → 余额详情（余额、赠金、充值、阈值、上轮花费、刷新）；
 *      右击角色 → 设置菜单（大小、低余额阈值、气泡台词、隐藏、状态 JSON）。
 *   3. 全部 DOM 自带、样式加前缀，不依赖宿主框架，也不碰页面已有节点。
 */
(function () {
  'use strict'

  if (window.__dshLanbaoWidget) return
  window.__dshLanbaoWidget = true

  // ── 常量 ──────────────────────────────────────────────
  // 表情 URL 要带版本号：文件名是固定的（thinking.webp），换图后如果 URL 不变，
  // 浏览器会继续用旧缓存 —— 表现就是"新旧两张图来回跳"。
  // 宿主会在发 widget.js 时把占位符换成表情文件的真实 mtime；
  // 宿主还没重载到新版时，退回下面这个手动版本号（换图时记得一起改）。
  var ASSET_REV = '__LANBAO_ASSET_REV__'
  if (ASSET_REV.indexOf('__LANBAO_') === 0) ASSET_REV = '20261030a'
  var API = {
    state: '/dsh-lanbao/state.json',
    settings: '/dsh-lanbao/settings.json',
    refresh: '/dsh-lanbao/refresh.json',
    expr: function (name) { return '/dsh-lanbao/expr/' + name + '.webp?rev=' + ASSET_REV },
    audio: function (set, slot) { return '/dsh-lanbao/audio/' + set + '-' + slot + '.wav?rev=' + ASSET_REV }
  }
  var EXPRESSIONS = ['idle', 'thinking', 'busy', 'happy', 'confused']
  // 音色表：id 必须和宿主 SOUND_SETS、assets/audio 下的文件名前缀一致
  var SOUND_SETS = [
    { id: 'bubble', name: '气泡' },
    { id: 'drop', name: '水滴' },
    { id: 'squeak', name: '鲨鱼' }
  ]
  var LABEL = { idle: '待机', thinking: '思考', busy: '忙碌', happy: '开心', confused: '疑惑' }
  var DEFAULTS = {
    visible: true,
    size: 184,
    right: 24,
    bottom: 200,
    bubble: true,
    bubbleMs: 6000,
    lowBalance: 10,
    sound: true,
    soundVolume: 60,
    soundSet: 'bubble'
  }
  var POLL_MS = 1200
  var IDLE_CHAT_MIN = 75000
  var IDLE_CHAT_MAX = 155000
  // 余额冒泡：随机间隔 3~8 分钟，每次亮 4.5 秒
  var BALANCE_MIN = 180000
  var BALANCE_MAX = 480000
  var BALANCE_TTL = 4500
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

  function clockOf(ts) {
    try {
      var d = new Date(Number(ts))
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    } catch (e) {
      return ''
    }
  }

  // ── 状态 ──────────────────────────────────────────────
  var settings = Object.assign({}, DEFAULTS)
  var view = { phase: 'idle', reason: 'idle', detail: null }
  var balance = null
  var lastTurn = null
  var lastTurnAt = 0
  // 初值是 null：首帧必须真的加载一次 idle.webp，否则前面两个 <img> 一直是空的
  var expression = null
  var failStreak = 0
  var firstRun = true
  var pollTimer = 0
  var idleChatTimer = 0
  var randomBalanceTimer = 0
  var bubble = { priority: -1, until: 0 }
  var condenseTimer = 0
  var dragging = null
  var lastDragEndAt = 0
  var lastLocalMoveAt = 0
  var openPopover = null // 'detail' | 'menu' | null

  // ── DOM 骨架 ──────────────────────────────────────────
  var root = document.createElement('div')
  root.className = 'lbd-root'
  root.innerHTML = [
    // 椭圆气泡：说话文本 + 常驻余额，点它看详情
    '<div class="lbd-bubble" role="button" tabindex="0" aria-label="查看余额详情">',
    '  <div class="lbd-speech">',
    '    <span class="lbd-speech-text"></span>',
    '    <i class="lbd-dots"><b></b><b></b><b></b></i>',
    '  </div>',
    '  <div class="lbd-bubble-balance">',
    '    <i class="lbd-dot"></i>',
    '    <span class="lbd-balance-text">余额 —</span>',
    '  </div>',
    '  <i class="lbd-tail"></i>',
    '  <i class="lbd-tail-dot"></i>',
    '</div>',
    '<div class="lbd-actor" role="button" tabindex="0" aria-label="蓝宝：左键摸摸头，右键打开菜单">',
    '  <img class="lbd-img is-front" alt="" draggable="false">',
    '  <img class="lbd-img is-back" alt="" draggable="false">',
    '</div>',
    '<button class="lbd-restore" type="button" title="叫出蓝宝" aria-label="叫出蓝宝">蓝</button>',

    // 余额详情（点气泡）
    '<div class="lbd-pop lbd-detail" role="dialog" aria-label="余额详情" hidden>',
    '  <div class="lbd-pop-head">',
    '    <strong>余额</strong>',
    '    <span class="lbd-detail-state"></span>',
    '    <button class="lbd-close" type="button" data-close aria-label="关闭">×</button>',
    '  </div>',
    '  <div class="lbd-detail-main">',
    '    <span class="lbd-detail-num">—</span>',
    '    <button class="lbd-refresh" type="button">刷新</button>',
    '  </div>',
    '  <div class="lbd-detail-sub"></div>',
    '  <div class="lbd-detail-turn"></div>',
    '  <div class="lbd-detail-foot">',
    '    <span class="lbd-detail-time"></span>',
    '    <a class="lbd-link" href="/dsh-lanbao/state.json" target="_blank" rel="noreferrer">状态 JSON</a>',
    '  </div>',
    '</div>',

    // 设置菜单（右击角色）
    '<div class="lbd-pop lbd-menu" role="menu" aria-label="蓝宝设置" hidden>',
    '  <div class="lbd-pop-head">',
    '    <strong>蓝宝设置</strong>',
    '    <span class="lbd-menu-state"></span>',
    '    <button class="lbd-close" type="button" data-close aria-label="关闭">×</button>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>大小</label>',
    '    <div class="lbd-stepper">',
    '      <button type="button" data-size="-1">−</button>',
    '      <span class="lbd-size-val">184</span>',
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
    '    <label>气泡台词</label>',
    '    <button class="lbd-toggle" type="button" data-toggle="bubble">开</button>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>音效</label>',
    '    <button class="lbd-toggle" type="button" data-toggle="sound">开</button>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>音量</label>',
    '    <div class="lbd-stepper">',
    '      <button type="button" data-volume="-1">−</button>',
    '      <span class="lbd-volume-val">60%</span>',
    '      <button type="button" data-volume="1">+</button>',
    '    </div>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>音色</label>',
    '    <div class="lbd-sound-tools">',
    '      <button class="lbd-sound-set" type="button">气泡</button>',
    '      <button class="lbd-sound-try" type="button">试听</button>',
    '    </div>',
    '  </div>',
    '  <div class="lbd-row">',
    '    <label>余额</label>',
    '    <button class="lbd-open-detail" type="button">查看详情</button>',
    '  </div>',
    '  <div class="lbd-row lbd-row-end">',
    '    <button class="lbd-hide" type="button">隐藏蓝宝</button>',
    '    <span class="lbd-hint">右键角色可再打开</span>',
    '  </div>',
    '</div>'
  ].join('')

  var style = document.createElement('style')
  style.textContent = [
    // —— 舞台 ——
    '.lbd-root{position:fixed;z-index:20400;right:24px;bottom:200px;display:flex;flex-direction:column;align-items:flex-end;gap:10px;',
    '  font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    '  -webkit-user-select:none;user-select:none;pointer-events:none;}',
    '.lbd-root.is-hidden .lbd-actor,.lbd-root.is-hidden .lbd-bubble,.lbd-root.is-hidden .lbd-pop{display:none}',

    // —— 角色 ——
    '.lbd-actor{position:relative;width:184px;height:184px;pointer-events:auto;cursor:grab;touch-action:none;',
    '  filter:drop-shadow(0 10px 18px rgba(28,52,92,.22));transition:width .18s ease,height .18s ease;',
    '  animation:lbd-float 4.2s ease-in-out infinite;transform-origin:50% 92%;}',
    '.lbd-actor:active{cursor:grabbing}',
    '.lbd-img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;opacity:0;',
    '  transition:opacity .24s ease,transform .3s ease;pointer-events:none;-webkit-user-drag:none;}',
    '.lbd-img.is-front{opacity:1}',

    // —— 椭圆气泡 ——
    '.lbd-bubble{pointer-events:auto;cursor:pointer;position:relative;align-self:flex-end;',
    '  max-width:min(266px,calc(100vw - 44px));box-sizing:border-box;padding:9px 17px;border-radius:999px;',
    '  background:rgba(255,255,255,.975);color:#1f2a3d;border:1px solid rgba(38,74,140,.14);',
    '  box-shadow:0 10px 26px rgba(24,46,86,.16);text-align:center;word-break:break-word;',
    '  opacity:0;transform:translateY(8px) scale(.9);transform-origin:80% 100%;',
    '  transition:opacity .2s ease,transform .24s cubic-bezier(.2,1.3,.4,1),padding .2s ease,background .2s ease;}',
    '.lbd-bubble.is-show{opacity:1;transform:translateY(0) scale(1)}',
    // 没展开时整颗气泡不接事件，避免挡住下面的页面
    '.lbd-bubble:not(.is-show){pointer-events:none}',
    '.lbd-bubble:hover{box-shadow:0 12px 30px rgba(24,46,86,.22)}',
    '.lbd-bubble.is-warn{background:#fff8e6;border-color:rgba(196,138,20,.42);color:#6b4a00}',
    '.lbd-bubble.is-error{background:#fff0f0;border-color:rgba(196,52,52,.36);color:#7a1f1f}',
    '.lbd-bubble.is-happy{background:#eef8ff;border-color:rgba(38,96,180,.24);color:#123a6b}',
    // 只显示余额（点角色 / 随机 / 回合结束）：隐藏台词行，去掉分隔线
    '.lbd-bubble.is-balance-only .lbd-speech{display:none}',
    '.lbd-bubble.is-balance-only .lbd-bubble-balance{border-top:0;margin-top:0;padding-top:0}',
    // 只说话、不提余额（思考 / 忙碌 / 闲聊）
    '.lbd-bubble.no-balance .lbd-bubble-balance{display:none}',
    '.lbd-speech{line-height:1.5;max-width:100%}',
    '.lbd-dots{display:none;margin-left:4px;gap:3px;vertical-align:middle}',
    '.lbd-bubble.is-thinking .lbd-dots{display:inline-flex}',
    '.lbd-dots b{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.45;animation:lbd-blink 1.1s infinite}',
    '.lbd-dots b:nth-child(2){animation-delay:.18s}',
    '.lbd-dots b:nth-child(3){animation-delay:.36s}',
    '.lbd-bubble-balance{display:flex;align-items:center;justify-content:center;gap:5px;font-size:11.5px;color:#4a5b76;',
    '  margin-top:6px;padding-top:6px;border-top:1px dashed rgba(38,74,140,.18);white-space:nowrap}',
    '.lbd-dot{width:7px;height:7px;border-radius:50%;background:#3d7bd6;box-shadow:0 0 0 3px rgba(61,123,214,.16);flex:0 0 auto}',
    '.lbd-bubble.is-low .lbd-dot{background:#d99512;box-shadow:0 0 0 3px rgba(217,149,18,.18)}',
    '.lbd-bubble.is-low .lbd-bubble-balance{color:#8a5f06}',
    '.lbd-bubble.is-empty .lbd-dot,.lbd-bubble.is-error .lbd-dot{background:#d24b4b;box-shadow:0 0 0 3px rgba(210,75,75,.18)}',
    '.lbd-bubble.is-empty .lbd-bubble-balance,.lbd-bubble.is-error .lbd-bubble-balance{color:#a03636}',
    // 气泡尾巴：一颗大点 + 一颗小点，指向角色；横向位置由 JS 按"角色头心"算
    '.lbd-tail{position:absolute;left:var(--lbd-tail-x,22px);bottom:-9px;width:13px;height:13px;border-radius:50%;background:inherit;',
    '  border:1px solid rgba(38,74,140,.14);transition:background .2s ease}',
    '.lbd-tail-dot{position:absolute;left:calc(var(--lbd-tail-x,22px) - 11px);bottom:-19px;width:5px;height:5px;border-radius:50%;',
    '  background:inherit;border:1px solid rgba(38,74,140,.14);transition:background .2s ease}',

    // —— 弹层（详情 / 菜单共用骨架）——
    '.lbd-pop{pointer-events:auto;position:fixed;top:0;right:0;box-sizing:border-box;overflow:auto;',
    '  overscroll-behavior:contain;width:264px;',
    '  background:rgba(255,255,255,.985);border:1px solid rgba(38,74,140,.16);border-radius:16px;padding:12px 14px 11px;',
    '  box-shadow:0 18px 44px rgba(20,40,78,.22);color:#1f2a3d;display:flex;flex-direction:column;gap:9px;}',
    '.lbd-pop[hidden]{display:none}',
    '.lbd-pop-head{display:flex;align-items:center;gap:8px}',
    '.lbd-pop-head strong{font-size:14px}',
    '.lbd-detail-state,.lbd-menu-state{font-size:11px;color:#5b6d88;background:rgba(61,123,214,.1);border-radius:999px;padding:2px 8px}',
    '.lbd-close{margin-left:auto;border:0;background:transparent;color:#6b7c95;font-size:17px;line-height:1;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.lbd-close:hover{background:rgba(38,74,140,.08)}',
    '.lbd-detail-main{display:flex;align-items:baseline;gap:8px;background:rgba(61,123,214,.06);border-radius:12px;padding:10px 12px}',
    '.lbd-detail-num{font-size:22px;font-weight:600;letter-spacing:.2px}',
    '.lbd-detail.is-low .lbd-detail-num{color:#a8700a}',
    '.lbd-detail.is-empty .lbd-detail-num,.lbd-detail.is-error .lbd-detail-num{color:#b33636}',
    '.lbd-refresh{margin-left:auto;border:1px solid rgba(38,74,140,.18);background:#fff;border-radius:8px;padding:3px 9px;',
    '  font:inherit;font-size:12px;color:#2a3d5c;cursor:pointer}',
    '.lbd-refresh:hover{background:rgba(61,123,214,.08)}',
    '.lbd-refresh[disabled]{opacity:.55;cursor:default}',
    '.lbd-detail-sub,.lbd-detail-turn,.lbd-detail-time{font-size:11.5px;color:#5b6d88}',
    '.lbd-detail-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;',
    '  border-top:1px solid rgba(38,74,140,.1);padding-top:8px;margin-top:1px}',
    '.lbd-link{color:#5b6d88;font-size:11.5px;text-decoration:none}',
    '.lbd-link:hover{text-decoration:underline}',
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
    '.lbd-open-detail{border:1px solid rgba(38,74,140,.18);background:#fff;border-radius:8px;padding:3px 10px;font:inherit;',
    '  font-size:12px;color:#2a3d5c;cursor:pointer}',
    '.lbd-open-detail:hover{background:rgba(61,123,214,.08)}',
    '.lbd-sound-tools{display:inline-flex;gap:6px}',
    '.lbd-sound-set,.lbd-sound-try{border:1px solid rgba(38,74,140,.18);background:#fff;border-radius:8px;padding:3px 10px;',
    '  font:inherit;font-size:12px;color:#2a3d5c;cursor:pointer}',
    '.lbd-sound-set{min-width:52px}',
    '.lbd-sound-set:hover,.lbd-sound-try:hover{background:rgba(61,123,214,.08)}',
    '.lbd-sound-try:active{transform:translateY(1px)}',
    '.lbd-row-end{border-top:1px solid rgba(38,74,140,.1);padding-top:9px;margin-top:1px}',
    '.lbd-hide{border:0;background:transparent;color:#a03636;font:inherit;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:6px}',
    '.lbd-hide:hover{background:rgba(196,52,52,.09)}',
    '.lbd-hint{font-size:11px;color:#8a99b0}',

    // —— 隐藏后的召回按钮 ——
    '.lbd-restore{display:none;pointer-events:auto;width:30px;height:30px;border-radius:50%;border:1px solid rgba(38,74,140,.2);',
    '  background:rgba(255,255,255,.9);color:#2a5da8;font:inherit;font-size:12px;cursor:pointer;align-items:center;justify-content:center;',
    '  box-shadow:0 4px 12px rgba(24,46,86,.14);opacity:.62;transition:opacity .18s ease,transform .18s ease}',
    '.lbd-restore:hover{opacity:1;transform:translateY(-1px)}',
    '.lbd-root.is-hidden .lbd-restore{display:flex}',

    // —— 动画 ——
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

    // —— 深色皮：采样页面底色后挂 .is-dark ——
    '.lbd-root.is-dark .lbd-bubble{background:rgba(32,40,54,.97);color:#e7eefa;border-color:rgba(120,160,225,.26)}',
    '.lbd-root.is-dark .lbd-tail,.lbd-root.is-dark .lbd-tail-dot{border-color:rgba(120,160,225,.26)}',
    '.lbd-root.is-dark .lbd-bubble.is-warn{background:#3a2f14;color:#f0d79a;border-color:rgba(214,164,50,.42)}',
    '.lbd-root.is-dark .lbd-bubble.is-error{background:#3a1d1d;color:#f3c3c3;border-color:rgba(220,90,90,.4)}',
    '.lbd-root.is-dark .lbd-bubble.is-happy{background:#132a46;color:#cfe3ff;border-color:rgba(96,150,225,.32)}',
    '.lbd-root.is-dark .lbd-bubble-balance{color:#9fb4d2;border-top-color:rgba(120,160,225,.2)}',
    '.lbd-root.is-dark .lbd-bubble.is-low .lbd-bubble-balance{color:#e8b96a}',
    '.lbd-root.is-dark .lbd-bubble.is-empty .lbd-bubble-balance,.lbd-root.is-dark .lbd-bubble.is-error .lbd-bubble-balance{color:#f0a3a3}',
    '.lbd-root.is-dark .lbd-pop{background:rgba(26,33,45,.985);color:#e6edf8;border-color:rgba(120,160,225,.22)}',
    '.lbd-root.is-dark .lbd-detail-main{background:rgba(96,150,225,.12)}',
    '.lbd-root.is-dark .lbd-detail.is-low .lbd-detail-num{color:#e8b96a}',
    '.lbd-root.is-dark .lbd-detail.is-empty .lbd-detail-num,.lbd-root.is-dark .lbd-detail.is-error .lbd-detail-num{color:#f0a3a3}',
    '.lbd-root.is-dark .lbd-detail-state,.lbd-root.is-dark .lbd-menu-state{color:#adc2df;background:rgba(96,150,225,.18)}',
    '.lbd-root.is-dark .lbd-row label,.lbd-root.is-dark .lbd-detail-sub,.lbd-root.is-dark .lbd-detail-turn,',
    '.lbd-root.is-dark .lbd-detail-time,.lbd-root.is-dark .lbd-link,.lbd-root.is-dark .lbd-hint{color:#a8bad4}',
    '.lbd-root.is-dark .lbd-stepper button,.lbd-root.is-dark .lbd-toggle,.lbd-root.is-dark .lbd-refresh{',
    '  background:rgba(255,255,255,.06);color:#d7e3f5;border-color:rgba(120,160,225,.26)}',
    '.lbd-root.is-dark .lbd-toggle.is-on{background:rgba(96,150,225,.24);color:#cfe2ff}',
    '.lbd-root.is-dark .lbd-row-end,.lbd-root.is-dark .lbd-detail-foot{border-top-color:rgba(120,160,225,.14)}',
    '.lbd-root.is-dark .lbd-close{color:#93a7c4}',
    '.lbd-root.is-dark .lbd-hide{color:#ef9c9c}',
    '.lbd-root.is-dark .lbd-restore{background:rgba(32,40,54,.92);color:#a8c8f0;border-color:rgba(120,160,225,.28)}'
  ].join('\n')
  ;(document.head || document.documentElement).appendChild(style)
  ;(document.body || document.documentElement).appendChild(root)

  var actor = root.querySelector('.lbd-actor')
  var front = root.querySelector('.lbd-img.is-front')
  var back = root.querySelector('.lbd-img.is-back')
  var bubbleEl = root.querySelector('.lbd-bubble')
  var speechEl = root.querySelector('.lbd-speech')
  var speechText = root.querySelector('.lbd-speech-text')
  var balanceText = root.querySelector('.lbd-balance-text')
  var restoreBtn = root.querySelector('.lbd-restore')

  var detail = root.querySelector('.lbd-detail')
  var detailState = root.querySelector('.lbd-detail-state')
  var detailNum = root.querySelector('.lbd-detail-num')
  var detailSub = root.querySelector('.lbd-detail-sub')
  var detailTurn = root.querySelector('.lbd-detail-turn')
  var detailTime = root.querySelector('.lbd-detail-time')
  var refreshBtn = root.querySelector('.lbd-refresh')

  var menu = root.querySelector('.lbd-menu')
  var menuState = root.querySelector('.lbd-menu-state')
  var sizeVal = root.querySelector('.lbd-size-val')
  var thresholdVal = root.querySelector('.lbd-threshold-val')
  var toggleBtn = root.querySelector('[data-toggle="bubble"]')
  var soundToggleBtn = root.querySelector('[data-toggle="sound"]')
  var volumeVal = root.querySelector('.lbd-volume-val')
  var soundSetBtn = root.querySelector('.lbd-sound-set')
  var soundTryBtn = root.querySelector('.lbd-sound-try')

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
      return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b < 120
    }
    return mediaDark
  }

  var themed = null
  var themePending = null
  /**
   * DSH 启动瞬间 body 底色会短暂变深（加载态），直接跟着切会出现一次假深色闪烁。
   * 所以：首次直接定，之后要连续两次采样结果一致才真正切换。
   */
  function applyTheme() {
    var dark = detectDark()
    if (themed === null) {
      themed = dark
      themePending = dark
      root.classList.toggle('is-dark', dark)
      return
    }
    if (dark === themed) {
      themePending = dark
      return
    }
    if (themePending !== dark) {
      themePending = dark
      return
    }
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
  /**
   * 气泡平时是完全收起的（不占视觉、也不挡鼠标）。
   * 出现只有三种由头：
   *  1. 情境台词（思考 / 忙碌 / 完成 / 出错）；
   *  2. 余额：点一下角色、随机冒泡、对话跑完；
   *  3. 余额告警（偏低 / 见底 / 读不到）。
   * 余额行按需开关，不再常驻。
   */
  function presentBubble(opts) {
    var o = opts || {}
    bubbleEl.classList.toggle('is-balance-only', !o.speech)
    bubbleEl.classList.toggle('no-balance', !o.balance)
    bubbleEl.classList.toggle('is-thinking', !!o.thinking)
    bubbleEl.classList.toggle('is-warn', o.tone === 'warn')
    bubbleEl.classList.toggle('is-error', o.tone === 'error')
    bubbleEl.classList.toggle('is-happy', o.tone === 'happy')
    speechText.textContent = o.speech || ''
    bubbleEl.classList.add('is-show')
    window.clearTimeout(condenseTimer)
    condenseTimer = window.setTimeout(hideBubble, o.ttl || settings.bubbleMs)
    schedulePositionTail()
  }

  /** 情境台词。关掉「气泡台词」后不再说话，但不影响余额冒泡。 */
  function showBubble(text, options) {
    var opts = options || {}
    if (!settings.bubble || !text) return
    var priority = opts.priority === undefined ? 1 : opts.priority
    var now = Date.now()
    if (priority < bubble.priority && now < bubble.until) return
    bubble.priority = priority
    bubble.until = now + (opts.ttl || settings.bubbleMs)
    presentBubble({
      speech: text,
      balance: !!opts.balance,
      tone: opts.tone,
      thinking: opts.thinking,
      ttl: opts.ttl || settings.bubbleMs
    })
  }

  /** 只把余额亮出来（点角色 / 随机 / 回合结束）。不受「气泡台词」开关影响。 */
  function showBalance(options) {
    var opts = options || {}
    var level = balanceLevel()
    bubble.priority = opts.priority === undefined ? 2 : opts.priority
    bubble.until = Date.now() + (opts.ttl || BALANCE_TTL)
    presentBubble({
      speech: null,
      balance: true,
      tone: opts.tone || (level === 'low' ? 'warn' : level === 'error' || level === 'empty' ? 'error' : undefined),
      ttl: opts.ttl || BALANCE_TTL
    })
  }

  function hideBubble() {
    window.clearTimeout(condenseTimer)
    bubbleEl.classList.remove('is-show')
    speechText.textContent = ''
    bubble.priority = -1
  }

  /**
   * 尾巴要指向角色的头，而不是气泡自己的某个角。
   * 气泡宽度会随文字变化（宽话时比角色还宽），所以每次布局后按实际坐标算一次。
   */
  function positionTail() {
    if (!bubbleEl.offsetWidth) return
    var bubbleRect = bubbleEl.getBoundingClientRect()
    var actorRect = actor.getBoundingClientRect()
    // 稍微偏离头心一点，落在头顶左前方，看起来更像"从嘴边冒出来"
    var target = actorRect.left + actorRect.width * 0.42 - bubbleRect.left
    var min = 16
    var max = Math.max(min, bubbleRect.width - 26)
    bubbleEl.style.setProperty('--lbd-tail-x', Math.round(Math.max(min, Math.min(max, target))) + 'px')
  }

  var tailFrame = 0
  function schedulePositionTail() {
    if (tailFrame) return
    tailFrame = window.requestAnimationFrame(function () {
      tailFrame = 0
      positionTail()
    })
  }

  function clearBubbleTone() {
    bubbleEl.classList.remove('is-warn', 'is-error', 'is-happy')
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

    var soundOn = settings.sound !== false
    var soundVol = Number(settings.soundVolume)
    if (!isFinite(soundVol)) soundVol = DEFAULTS.soundVolume // 宿主还没下发这个字段时别显示 NaN%
    soundToggleBtn.textContent = soundOn ? '开' : '关'
    soundToggleBtn.classList.toggle('is-on', soundOn)
    volumeVal.textContent = Math.round(Math.max(0, Math.min(100, soundVol))) + '%'
    soundSetBtn.textContent = soundSetName(settings.soundSet)
    // 开着就把当前音色预取一遍，第一次点按下才不会有解码延迟
    if (soundOn) {
      var warmSet = settings.soundSet || DEFAULTS.soundSet
      soundAudio(warmSet, 'press')
      soundAudio(warmSet, 'release')
    }
    positionFromSettings()
    schedulePositionTail()
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

  function balanceLevel() {
    return (balance && balance.level) || 'unknown'
  }

  function renderBalance() {
    var level = balanceLevel()
    var symbol = (balance && balance.symbol) || '¥'
    var total = balance && balance.total

    var text = level === 'unknown'
      ? '余额 —'
      : level === 'error'
        ? '余额读取失败'
        : '余额 ' + money(total, symbol)

    balanceText.textContent = text
    bubbleEl.classList.remove('is-low', 'is-empty', 'is-error')
    detail.classList.remove('is-low', 'is-empty', 'is-error')
    if (level === 'low') { bubbleEl.classList.add('is-low'); detail.classList.add('is-low') }
    if (level === 'empty') { bubbleEl.classList.add('is-empty'); detail.classList.add('is-empty') }
    if (level === 'error') { bubbleEl.classList.add('is-error'); detail.classList.add('is-error') }

    // 详情面板
    detailNum.textContent = level === 'error' || level === 'unknown' ? '—' : money(total, symbol)
    detailState.textContent = phaseText()

    var sub = []
    if (level === 'error' && balance && balance.error) sub.push(balance.error)
    else if (level === 'unknown') sub.push('还没有余额数据')
    else {
      if (balance.granted !== null && balance.granted !== undefined) sub.push('赠金 ' + money(balance.granted, symbol))
      if (balance.toppedUp !== null && balance.toppedUp !== undefined) sub.push('充值 ' + money(balance.toppedUp, symbol))
      sub.push('阈值 ' + money(settings.lowBalance, symbol))
      if (balance.stale) sub.push('缓存')
    }
    detailSub.textContent = sub.join(' · ')

    if (lastTurn && lastTurn.cost !== null && lastTurn.cost !== undefined) {
      detailTurn.textContent = '上轮花费 ' + money(lastTurn.cost, lastTurn.symbol || symbol) + ' · ' + clockOf(lastTurn.at)
    } else {
      detailTurn.textContent = '还没有本机花费记录'
    }
    detailTime.textContent = balance && balance.at ? '更新于 ' + clockOf(balance.at) : '尚未获取'
    schedulePositionTail()
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
    menuState.textContent = phaseText()

    var changed = previousReason !== view.reason || previousPhase !== view.phase
    if (!changed && !options.force) return

    // 每轮花费优先播报（余额提示的核心：一轮花了多少、剩多少）
    if (lastTurn && lastTurn.at && lastTurn.at !== lastTurnAt) {
      lastTurnAt = lastTurn.at
      showBubble('这轮花了 ' + money(lastTurn.cost, lastTurn.symbol) + '，余额 ' + money(lastTurn.after, lastTurn.symbol), {
        priority: 3,
        ttl: Math.max(settings.bubbleMs, 6500),
        tone: balanceTone(balanceLevel())
      })
      return
    }

    // 注意各分支的 balance 标记：只有和钱有关的才把余额行带出来
    switch (view.reason) {
      case 'tool':
        showBubble(pick('tool') + (view.detail ? '（' + view.detail + '）' : ''), { priority: 1 })
        break
      case 'turn':
        showBubble(pick('turn'), { priority: 1, thinking: true, ttl: Math.max(settings.bubbleMs, 5000) })
        break
      case 'turn-completed':
        showBubble(pick('completed'), { priority: 2, tone: 'happy', balance: true })
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
        showBubble(pick('balanceError'), { priority: 4, tone: 'error', ttl: 12000, balance: true })
        break
      case 'balance-empty':
        showBubble(pick('empty'), { priority: 4, tone: 'error', balance: true })
        break
      case 'balance-low':
        showBubble(pick('low'), { priority: 3, tone: 'warn', balance: true })
        break
      case 'idle':
      default:
        if (options.idleChat) showBubble(pick('idle'), { priority: 0 })
        break
    }
  }

  // ── 弹层定位（详情 / 菜单共用）─────────────────────────
  /**
   * 以某个锚点矩形为基准摆放弹层：优先开在锚点上方，放不下翻到下方，
   * 水平方向夹在视口内。anchor 可以是元素，也可以是 { x, y } 光标点。
   */
  function placePopover(el, anchor) {
    var rect = anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : { left: (anchor && anchor.x) || 0, top: (anchor && anchor.y) || 0, right: (anchor && anchor.x) || 0, bottom: (anchor && anchor.y) || 0, width: 0, height: 0 }

    var width = Math.max(236, Math.min(272, window.innerWidth - 24))
    el.style.width = width + 'px'
    el.style.maxHeight = Math.max(200, window.innerHeight - 16) + 'px'

    var left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    el.style.left = left + 'px'
    el.style.right = 'auto'

    var height = el.offsetHeight
    var top = rect.top - height - 10
    if (top < 8) top = rect.bottom + 10
    top = Math.max(8, Math.min(top, window.innerHeight - height - 8))
    el.style.top = top + 'px'
  }

  function closePopovers() {
    openPopover = null
    detail.hidden = true
    menu.hidden = true
  }

  function showPopover(which, anchor) {
    closePopovers()
    openPopover = which
    var el = which === 'detail' ? detail : menu
    el.hidden = false
    if (which === 'detail') {
      renderBalance()
      detailState.textContent = phaseText()
    } else {
      menuState.textContent = phaseText()
    }
    placePopover(el, anchor || bubbleEl)
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

  /**
   * 随机亮一下余额（3~8 分钟一次）。
   * 正在干活、弹层开着、气泡已经在说话、或者余额根本读不到时都跳过，
   * 免得在忙的时候插嘴或者反复报错。
   */
  function scheduleRandomBalance() {
    window.clearTimeout(randomBalanceTimer)
    var wait = BALANCE_MIN + Math.random() * (BALANCE_MAX - BALANCE_MIN)
    randomBalanceTimer = window.setTimeout(function () {
      var level = balanceLevel()
      var quiet = !bubbleEl.classList.contains('is-show')
      var usable = level === 'ok' || level === 'low' || level === 'empty'
      if (document.visibilityState === 'visible' && quiet && usable && !openPopover && view.phase === 'idle') {
        showBalance({ priority: 2 })
      }
      scheduleRandomBalance()
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
        if (openPopover === 'detail') renderBalance()
        if (firstRun) {
          firstRun = false
          // 开场白只在第一次见面说，之后刷新页面直接进入情境台词
          try {
            if (!window.localStorage.getItem(GREET_KEY)) {
              window.localStorage.setItem(GREET_KEY, '1')
              showBubble(pick('first'), { priority: 5, ttl: 5200, balance: true })
            }
          } catch (e) {
            showBubble(pick('first'), { priority: 5, ttl: 5200, balance: true })
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

  // ── 点触音效 ──────────────────────────────────────────
  // 按下 / 松开各一条，Audio 元素按音色懒建后复用（连点不会堆出一串重叠音）。
  // 浏览器的自动播放限制靠「用户手势」解锁：pointerdown / keydown 本身就是手势，
  // 所以第一次点就有声，不需要额外的"点一下开启声音"。
  var soundCache = {}
  var lastPressSoundAt = 0

  function soundSetName(id) {
    for (var i = 0; i < SOUND_SETS.length; i++) {
      if (SOUND_SETS[i].id === id) return SOUND_SETS[i].name
    }
    return SOUND_SETS[0].name
  }

  function soundAudio(set, slot) {
    var key = set + '-' + slot
    if (soundCache[key]) return soundCache[key]
    var el = null
    try {
      el = new Audio(API.audio(set, slot))
      el.preload = 'auto'
      soundCache[key] = el
    } catch (e) {
      el = null
    }
    return el
  }

  /** 0–100 的设置值 → Audio.volume（留 10% 余量，避免和页面其它声音叠在一起过冲）。 */
  function soundGain() {
    var v = Number(settings.soundVolume)
    if (!isFinite(v)) v = DEFAULTS.soundVolume
    v = Math.max(0, Math.min(100, v))
    return (v / 100) * 0.9
  }

  function playSound(slot, force) {
    if (!force && settings.sound === false) return
    var set = settings.soundSet || DEFAULTS.soundSet
    var el = soundAudio(set, slot)
    if (!el) return
    try {
      el.pause()
      el.currentTime = 0
      el.volume = soundGain()
      // ±3% 音高抖动：连点几十次也不会听起来像复读机
      el.playbackRate = 1 + (Math.random() * 0.06 - 0.03)
    } catch (e) {}
    var p = el.play()
    if (p && typeof p.catch === 'function') p.catch(function () {})
  }

  function playPressSound() {
    var now = Date.now()
    // 极短间隔连点只播第一下，免得重叠成噪音
    if (now - lastPressSoundAt < 55) return
    lastPressSoundAt = now
    playSound('press')
  }

  function playReleaseSound() {
    playSound('release')
  }

  /** 菜单里的「试听」：按下 → 150ms 后松开，模拟真实点一下的听感。 */
  function soundTry() {
    playSound('press', true)
    window.setTimeout(function () { playSound('release', true) }, 150)
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

  // ── 交互：角色 ────────────────────────────────────────
  /** 点一下 = 摸摸头；同时把余额亮出来（"我主动点击"这条由头）。 */
  function pet() {
    setPhase('happy')
    actor.classList.add('is-happy')
    if (settings.bubble) {
      showBubble(pick('pet'), { priority: 5, tone: 'happy', ttl: 4600, balance: true })
    } else {
      showBalance({ priority: 5, tone: 'happy', ttl: BALANCE_TTL })
    }
    window.setTimeout(function () {
      if (view.phase !== 'happy') setPhase(view.phase)
    }, 4600)
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
      // 键盘没有 pointerdown/up，手动补一对，手感和鼠标一致
      playPressSound()
      window.setTimeout(playReleaseSound, 120)
      pet()
    }
    // 键盘唤起菜单（等价于右键）
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault()
      showPopover('menu', actor)
    }
  })

  // 右键 → 设置菜单
  actor.addEventListener('contextmenu', function (event) {
    event.preventDefault()
    showPopover('menu', { x: event.clientX, y: event.clientY })
  })

  // 触屏长按也能出菜单（移动端没有右键）
  var longPressTimer = 0
  var longPressFired = false
  actor.addEventListener('pointerdown', function (event) {
    if (event.pointerType === 'mouse') return
    longPressFired = false
    longPressTimer = window.setTimeout(function () {
      longPressFired = true
      var rect = actor.getBoundingClientRect()
      showPopover('menu', { x: rect.left + rect.width / 2, y: rect.top })
    }, 560)
  })
  actor.addEventListener('pointerup', function () { window.clearTimeout(longPressTimer) })
  actor.addEventListener('pointercancel', function () { window.clearTimeout(longPressTimer) })

  // 点触音效：按下 / 松开。和拖动、长按、右键各走各的，互不干扰。
  actor.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return
    playPressSound()
  })
  actor.addEventListener('pointerup', function (event) {
    if (event.button !== 0) return
    playReleaseSound()
  })
  actor.addEventListener('pointercancel', function () {
    // 手势被系统收走时不会有 pointerup，重置节流，别让下一次点击被吃掉
    lastPressSoundAt = 0
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
    // 真的开始拖了才收弹层：单纯点一下当抚摸，不该把菜单关掉
    if (!dragging.moved) closePopovers()
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
    // 兜底：万一 style 还没写上就结束拖拽，读到的会是 NaN，别把角色丢到 0/0
    var right = parseFloat(root.style.right)
    var bottom = parseFloat(root.style.bottom)
    if (!isFinite(right)) right = Number(settings.right) || 0
    if (!isFinite(bottom)) bottom = Number(settings.bottom) || 0
    right = Math.round(right)
    bottom = Math.round(bottom)
    try { window.localStorage.setItem(POS_KEY, JSON.stringify({ right: right, bottom: bottom })) } catch (e) {}
    persistSettings({ right: right, bottom: bottom })
  }
  actor.addEventListener('pointerup', function () {
    window.clearTimeout(longPressTimer)
    endDrag()
  })
  actor.addEventListener('pointercancel', function () { window.clearTimeout(longPressTimer); endDrag() })
  actor.addEventListener('pointerleave', function () { if (dragging && dragging.moved) endDrag() })

  // ── 交互：气泡 ────────────────────────────────────────
  bubbleEl.addEventListener('click', function (event) {
    event.stopPropagation()
    if (openPopover === 'detail') {
      closePopovers()
      return
    }
    showPopover('detail', bubbleEl)
  })
  bubbleEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      showPopover('detail', bubbleEl)
    }
  })

  // ── 交互：详情面板 ────────────────────────────────────
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

  // ── 交互：设置菜单 ────────────────────────────────────
  menu.querySelectorAll('[data-size]').forEach(function (button) {
    button.addEventListener('click', function () {
      var step = Number(button.getAttribute('data-size'))
      persistSettings({ size: Math.max(96, Math.min(360, settings.size + step * 16)) })
      setTimeout(function () { if (openPopover === 'menu') placePopover(menu, menu) }, 60)
    })
  })

  menu.querySelectorAll('[data-threshold]').forEach(function (button) {
    button.addEventListener('click', function () {
      var step = Number(button.getAttribute('data-threshold'))
      persistSettings({ lowBalance: Math.max(0, Math.min(1000, (Number(settings.lowBalance) || 0) + step * 5)) })
      setTimeout(poll, 320)
    })
  })

  toggleBtn.addEventListener('click', function () {
    var on = !settings.bubble
    persistSettings({ bubble: on })
    if (!on) {
      hideBubble()
      // 关掉台词不代表不报余额：先把当前余额亮一下，让用户知道差别
      showBalance({ priority: 2 })
    } else {
      showBubble(pick('idle'), { priority: 2 })
    }
  })

  // —— 音效：开关 / 音量 / 音色 / 试听 ——
  soundToggleBtn.addEventListener('click', function () {
    var on = settings.sound === false
    persistSettings({ sound: on })
    if (on) playSound('press', true)
  })

  menu.querySelectorAll('[data-volume]').forEach(function (button) {
    button.addEventListener('click', function () {
      var step = Number(button.getAttribute('data-volume'))
      var next = Math.max(0, Math.min(100, (Number(settings.soundVolume) || 0) + step * 10))
      persistSettings({ soundVolume: next })
      soundTry()
    })
  })

  soundSetBtn.addEventListener('click', function () {
    var idx = 0
    for (var i = 0; i < SOUND_SETS.length; i++) {
      if (SOUND_SETS[i].id === settings.soundSet) idx = i
    }
    var next = SOUND_SETS[(idx + 1) % SOUND_SETS.length]
    persistSettings({ soundSet: next.id })
    soundTry()
  })

  soundTryBtn.addEventListener('click', soundTry)

  menu.querySelector('.lbd-open-detail').addEventListener('click', function () {
    closePopovers()
    showPopover('detail', actor)
  })

  menu.querySelector('.lbd-hide').addEventListener('click', function () {
    persistSettings({ visible: false })
    closePopovers()
    hideBubble()
  })

  restoreBtn.addEventListener('click', function () {
    persistSettings({ visible: true })
    showBubble('我回来了！', { priority: 5, tone: 'happy' })
  })

  // 关闭按钮 / 点外面 / Esc
  root.querySelectorAll('[data-close]').forEach(function (button) {
    button.addEventListener('click', function () { closePopovers() })
  })
  document.addEventListener('click', function (event) {
    if (!openPopover) return
    if (root.contains(event.target)) return
    closePopovers()
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && openPopover) closePopovers()
  })
  window.addEventListener('resize', function () {
    schedulePositionTail()
    if (!openPopover) return
    var el = openPopover === 'detail' ? detail : menu
    placePopover(el, bubbleEl)
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
  // 余额不常驻：气泡默认收起，等点击 / 随机 / 对话结束再出来
  hideBubble()
  poll()
  scheduleIdleChat()
  scheduleRandomBalance()

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') poll()
  })

  // 排障/测试用：手动让余额冒一次泡（随机那一档要等 3~8 分钟，不方便验证）
  window.__dshLanbao = {
    pingBalance: function () { showBalance({ priority: 2 }) },
    hide: hideBubble
  }
})()
