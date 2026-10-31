#!/usr/bin/env node
/**
 * 生成蓝宝的点触音效（纯 Node，零依赖）。
 *
 * 输出 assets/audio/<set>-press.wav 与 <set>-release.wav，共三套：
 *   bubble  气泡：按下「啵」、松开「叮」        —— 最贴蓝宝的深海人设
 *   drop    水滴：按下软木轻点、松开水滴下落     —— 最安静，不抢注意力
 *   squeak  鲨鱼：按下短促上扬、松开回落         —— 最像玩具，最皮
 *
 * 规格：44.1kHz / 单声道 / 16bit PCM，峰值 -6dBFS，首尾各 3ms 淡入淡出防爆音。
 *
 * 用法：node tools/make-sounds.mjs [--set bubble|drop|squeak] [--out <目录>]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SR = 44100
const TAU = Math.PI * 2
const PEAK = 0.5 // -6 dBFS

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const ONLY = argOf('--set', '')
const OUT_DIR = path.resolve(argOf('--out', path.join(ROOT, 'assets', 'audio')))

// ── 基础工具 ────────────────────────────────────────────
const blank = (seconds) => new Float32Array(Math.ceil(SR * seconds))

/** 指数包络：attack 秒线性淡入，之后以 tau 衰减。 */
function env(t, attack, tau) {
  if (t < attack) return attack > 0 ? t / attack : 1
  return Math.exp(-(t - attack) / tau)
}

/** 一阶低通，用来把白噪声磨成"气声"而不是"沙沙"。 */
function addNoise(out, startSec, durSec, amp, cutoffHz) {
  const start = Math.floor(startSec * SR)
  const n = Math.floor(durSec * SR)
  const a = Math.exp((-TAU * cutoffHz) / SR)
  let y = 0
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / SR
    y = (1 - a) * (Math.random() * 2 - 1) + a * y
    out[start + i] += y * amp * Math.exp(-t / Math.max(0.002, durSec / 3))
  }
}

/** 三角波，比正弦更"玩具"。 */
const tri = (phase) => {
  const x = (phase / TAU) % 1
  return 4 * Math.abs(x - 0.5) - 1
}

/** 统一归一化到 PEAK，并在首尾加淡入淡出，避免咔哒声。 */
function finish(out, fadeSec = 0.003) {
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  const gain = peak > 0 ? PEAK / peak : 1
  const fade = Math.max(1, Math.floor(fadeSec * SR))
  for (let i = 0; i < out.length; i++) {
    let g = gain
    if (i < fade) g *= i / fade
    const tail = out.length - 1 - i
    if (tail < fade) g *= tail / fade
    out[i] *= g
  }
  return out
}

// ── 三套音色 ────────────────────────────────────────────
/** 按下：气泡上浮的「啵」——音高快速上滑，短促有力。 */
function bubblePress() {
  const out = blank(0.12)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const k = Math.min(1, t / 0.075)
    const f = 250 * Math.pow(760 / 250, k) // 指数上滑
    phase += (TAU * f) / SR
    out[i] = Math.sin(phase) * env(t, 0.003, 0.038) * 0.9
  }
  addNoise(out, 0, 0.012, 0.12, 5200) // 一点气声，让"啵"有实体
  return finish(out)
}

/** 松开：水滴落在水面的「叮」。 */
function bubbleRelease() {
  const out = blank(0.2)
  let p1 = 0
  let p2 = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    p1 += (TAU * 1380) / SR
    p2 += (TAU * 2070) / SR
    const a = env(t, 0.001, 0.03)
    out[i] = (Math.sin(p1) * 0.8 + Math.sin(p2) * 0.22 * env(t, 0.001, 0.016)) * a
  }
  addNoise(out, 0, 0.006, 0.06, 7000)
  return finish(out)
}

/** 按下：软木轻点，短、闷、不刺耳。 */
function dropPress() {
  const out = blank(0.08)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    phase += (TAU * 175) / SR
    out[i] = Math.sin(phase) * env(t, 0.002, 0.028) * 0.75
  }
  addNoise(out, 0, 0.014, 0.35, 1900)
  return finish(out)
}

/** 松开：水滴下坠的短滑音。 */
function dropRelease() {
  const out = blank(0.16)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const k = Math.min(1, t / 0.09)
    const f = 950 * Math.pow(330 / 950, k)
    phase += (TAU * f) / SR
    out[i] = Math.sin(phase) * env(t, 0.002, 0.045) * 0.85
  }
  return finish(out)
}

/** 按下：小鲨鱼玩具的短促上扬 squeak。 */
function squeakPress() {
  const out = blank(0.14)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const k = Math.min(1, t / 0.09)
    const vib = Math.sin(TAU * 34 * t) * 22
    const f = 700 * Math.pow(1500 / 700, k) + vib
    phase += (TAU * f) / SR
    out[i] = tri(phase) * env(t, 0.004, 0.05) * 0.7
  }
  return finish(out)
}

/** 松开：回落的一声，比按下轻。 */
function squeakRelease() {
  const out = blank(0.18)
  let phase = 0
  for (let i = 0; i < out.length; i++) {
    const t = i / SR
    const k = Math.min(1, t / 0.12)
    const vib = Math.sin(TAU * 26 * t) * 14
    const f = 1200 * Math.pow(620 / 1200, k) + vib
    phase += (TAU * f) / SR
    out[i] = tri(phase) * env(t, 0.005, 0.06) * 0.55
  }
  return finish(out)
}

const SETS = {
  bubble: { press: bubblePress, release: bubbleRelease },
  drop: { press: dropPress, release: dropRelease },
  squeak: { press: squeakPress, release: squeakRelease },
}

// ── WAV 封装 ────────────────────────────────────────────
function toWav(samples) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(SR, 24)
  buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

// ── 写盘 ────────────────────────────────────────────────
fs.mkdirSync(OUT_DIR, { recursive: true })
const rows = []
const names = ONLY ? [ONLY] : Object.keys(SETS)
for (const name of names) {
  const set = SETS[name]
  if (!set) {
    console.error(`未知音色：${name}（可选：${Object.keys(SETS).join(' / ')}）`)
    process.exit(1)
  }
  for (const slot of ['press', 'release']) {
    const samples = set[slot]()
    const file = path.join(OUT_DIR, `${name}-${slot}.wav`)
    const buf = toWav(samples)
    fs.writeFileSync(file, buf)
    rows.push({
      file: path.relative(ROOT, file).replace(/\\/g, '/'),
      ms: Math.round((samples.length / SR) * 1000),
      kb: (buf.length / 1024).toFixed(1),
    })
  }
}

console.log('已生成：')
for (const r of rows) console.log(`  ${r.file.padEnd(34)} ${String(r.ms).padStart(4)}ms  ${r.kb}KB`)
