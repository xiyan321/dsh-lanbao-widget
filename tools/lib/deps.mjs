/**
 * tools/ 下这些脚本要用 sharp（图像处理）和 puppeteer-core（无头截图）。
 * 它们**不是**插件的运行时依赖，所以不进 dependencies —— 这里做两级查找：
 *
 *   1. 先按普通 Node 模块解析（你自己 `npm i -D sharp puppeteer-core` 的情况）；
 *   2. 找不到就去 DSH 的 web profile 里借（DSH 自带 sharp；装了鲸鱼挂件之类通常也有 puppeteer-core）。
 *
 * 这样仓库里不用出现任何人的本机绝对路径。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const localRequire = createRequire(import.meta.url)

function dshRequire() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const profile = process.env.DSH_PROFILE || 'web'
  const pkg = path.join(home, 'profiles', profile, 'package.json')
  return createRequire(pkg)
}

export function loadModule(name) {
  try {
    return localRequire(name)
  } catch (first) {
    try {
      return dshRequire()(name)
    } catch (second) {
      const err = new Error(`缺少依赖 ${name}。可在仓库根目录执行：npm i -D ${name}`)
      err.cause = second
      throw err
    }
  }
}

export const loadSharp = () => loadModule('sharp')

export const loadPuppeteer = () => loadModule('puppeteer-core')

/** 找一个 Chromium 系浏览器：环境变量优先，其次常见安装位置。 */
export function findBrowser() {
  const fromEnv = process.env.LANBAO_BROWSER || process.env.CHROME_PATH
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) return fromEnv
    throw new Error(`LANBAO_BROWSER 指向的文件不存在：${fromEnv}`)
  }
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error('找不到 Chromium 系浏览器，用 LANBAO_BROWSER=<可执行文件路径> 指定')
}
