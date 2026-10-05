/* ============================================================================
 * dsh-startup-screen-repair — Host 半侧
 * ----------------------------------------------------------------------------
 * 做三件事：
 *   1) 通过 webserver/index-inject 结构化行注入「启动界面」：关键 CSS + 黑幕
 *      + 配置 + 运行时；dsh web 与 dsh desktop 共用同一条注入通道
 *   2) 提供 /dsh-startup/splash.css · splash.js · asset · config 四个路由
 *   3) 把配置持久化到 ~/.dsh/dsh-startup.json（设置页经 /dsh-startup/config 读写）
 *
 * 为什么用 index-inject 而不是 tapIndex（本项目修复的核心）：
 *   tapIndex 是服务端字符串改写，只有「由本进程渲染 index.html」时才会执行。
 *   dsh desktop 的 index.html 由 Electron 从 dist 直接读（dsh-app:// 协议），
 *   本进程不参与渲染，tapIndex 永远不被调用 —— 这正是旧版在 desktop 上
 *   完全不出现启动动画的原因。而 index-inject 的结构化行表是一份纯 JSON
 *   数据：web 侧 renderIndexInjections() 把它渲染进 HTML；desktop 侧
 *   collectIndexInjections() 经 IPC 把同一份行表交给页面内解释器。
 *   一条通道同时覆盖两端，故弃用 tapIndex。
 *
 * 说明：配置刻意不走 settings 命名空间，而是自带一份 JSON + 自带设置面板
 * （与 dsh-meme 同款做法），这样不受 dsh-settings 版本变更影响。
 * ========================================================================== */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'dsh-startup.json')

const NS = 'dsh-startup-screen-repair'
const ROUTE_BASE = '/dsh-startup'
const ROOT_ID = 'dsh-startup-root'
/** sessionStorage / localStorage 的跳过标记：沿用旧键，升级后用户不会又被放一遍。 */
const SHOWN_KEY = 'dsh-startup-screen:shown'
const DAY_KEY = 'dsh-startup-screen:day'

/** 默认配置：字段与 lib/splash.js 的 DEFAULTS 一一对应。 */
const DEFAULTS = {
  enabled: true,
  mode: 'session',            // always | session | daily
  theme: 'light',             // light | dark
  speed: 1,
  requireInteraction: true,
  allowSkip: true,
  sound: true,                // 界面音效（WebAudio 合成，无音频文件）
  soundVolume: 0.5,
  voice: true,                // 女声播报（Web Speech API）
  voiceLang: 'en',            // en | zh | both
  voiceName: '',              // '' = 自动挑（按分数优先神经网络女声）
  voiceRate: 0.88,            // 电影旁白档：比朗读慢，字与字之间才有重量
  voicePitch: 0.85,           // 压低音调，深沉的 AI 女声
  voiceVolume: 0.9,
  voiceCue: true,             // 念台词前的一声轻提示
  sfx: 'audio',               // 音效来源：audio=lib/assets 里的真素材 / synth=现场合成
  voiceSource: 'asset',       // 语音来源：asset=优先用真声素材（拿不到自动回落 TTS）/ tts=全 TTS
  voiceLead: 240,             // 提示音之后留一小段空白再开口
  identity: 'JOYCE MOORE',    // ← 设置页里可改的「身份名称」
  identityId: '0087',
  accessLevel: '3',
  brand1: 'DEEPSEEK',
  brand2: 'SYNTHESIZE INTELLIGENCE',
  brand3a: 'HARNESS',
  brand3b: 'OS',
  orgZh: '深度求索',
  orgEn: 'DEEPSEEK',
  orgSub: 'DEEPSEEK HARNESS',
  welcomeBox: 'DEEPSEEK HARNESS',
  footer: 'POWERED BY DEEPSEEK',
  accent: '#ff7500',
  glitchA: '#ff3b30',
  glitchB: '#2971b8'
}

const TEXT_KEYS = [
  'identity', 'identityId', 'accessLevel',
  'brand1', 'brand2', 'brand3a', 'brand3b',
  'orgZh', 'orgEn', 'orgSub', 'welcomeBox', 'footer', 'voiceName'
]
const COLOR_KEYS = ['accent', 'glitchA', 'glitchB']
const ENUMS = {
  mode: ['always', 'session', 'daily'],
  theme: ['light', 'dark'],
  voiceLang: ['en', 'zh', 'both'],
  sfx: ['audio', 'synth'],
  voiceSource: ['asset', 'tts']
}
const BOOL_KEYS = ['enabled', 'requireInteraction', 'allowSkip', 'sound', 'voice', 'voiceCue']
/** 数值字段的合法区间（越界即夹取）。 */
const RANGES = {
  speed: [0.35, 3],
  soundVolume: [0, 1],
  voiceRate: [0.5, 2],
  voiceLead: [0, 1200],
  voicePitch: [0, 2],
  voiceVolume: [0, 1]
}

function normalize(input) {
  const out = { ...DEFAULTS }
  const src = input && typeof input === 'object' ? input : {}
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in src) || src[key] === undefined || src[key] === null) continue
    const value = src[key]
    if (BOOL_KEYS.includes(key)) {
      out[key] = value === true || value === 'true' || value === 1 || value === '1'
    } else if (ENUMS[key]) {
      out[key] = ENUMS[key].includes(value) ? value : DEFAULTS[key]
    } else if (key === 'speed' || RANGES[key]) {
      const [lo, hi] = RANGES[key] || RANGES.speed
      const n = Number(value)
      out[key] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[key]
    } else if (COLOR_KEYS.includes(key)) {
      const s = String(value).trim()
      out[key] = /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : DEFAULTS[key]
    } else if (TEXT_KEYS.includes(key)) {
      out[key] = String(value).slice(0, 64)
    } else {
      out[key] = value
    }
  }
  if (!String(out.identity).trim()) out.identity = DEFAULTS.identity
  if (!String(out.identityId).trim()) {
    out.identityId = String(out.identity).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)
  }
  if (!String(out.identityId).trim()) out.identityId = 'OPERATOR'
  return out
}

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8')
    return normalize(JSON.parse(raw))
  } catch (err) {
    return { ...DEFAULTS }
  }
}

function writeConfig(next) {
  const cfg = normalize(next)
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  const tmp = CONFIG_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8')
  fs.renameSync(tmp, CONFIG_FILE)
  return cfg
}

/** 静态文件按 mtime 缓存，改完插件刷新页面即生效。 */
function makeReader(rel) {
  let cache = null
  return function read() {
    const file = path.join(PACKAGE_ROOT, rel)
    try {
      const st = fs.statSync(file)
      if (!cache || cache.mtimeMs !== st.mtimeMs) {
        cache = { mtimeMs: st.mtimeMs, text: fs.readFileSync(file, 'utf8') }
      }
      return cache.text
    } catch (err) {
      return ''
    }
  }
}

const readSplashCss = makeReader('lib/splash.css')
const readSplashJs = makeReader('lib/splash.js')

/** 内联脚本里绝对不能出现 `</script>`。 */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '')
}

/** 首屏兜底：在应用挂载前先把窗口盖住，避免闪出界面本体。 */
const CRITICAL_CSS = [
  'html.dsu-lock,html.dsu-lock body{overflow:hidden!important}',
  '#dsh-startup-root.dsu-boot{position:fixed;inset:0;z-index:2147483000;background:#000}'
].join('')

const BOOTSTRAP_JS = `(function(){try{
var c=window.__DSH_STARTUP__||{};
var root=document.getElementById('${ROOT_ID}');
var off=!c.enabled;
if(!off&&c.mode==='session'&&sessionStorage.getItem('${SHOWN_KEY}')==='1')off=true;
if(!off&&c.mode==='daily'&&localStorage.getItem('${DAY_KEY}')===new Date().toISOString().slice(0,10))off=true;
if(off){window.__DSH_STARTUP_SKIP__=true;if(root&&root.parentNode)root.parentNode.removeChild(root);}
else{document.documentElement.classList.add('dsu-lock');/* 兜底：连 splash.js 都没跑起来（404/被拦/语法错）时，9 秒后无条件放行，绝不锁黑屏 */setTimeout(function(){try{var r=document.getElementById('${ROOT_ID}');if(r&&r.className&&r.className.indexOf('dsu-boot')!==-1){if(r.parentNode)r.parentNode.removeChild(r);document.documentElement.classList.remove('dsu-lock');if(document.body)document.body.style.overflow='';window.__DSH_STARTUP_FAILED__=true;}}catch(e){}},9000);}
}catch(e){} })()`

const name = NS
const inject = ['webServer', 'connection']

function apply(ctx) {
  const disposers = []

  /** 浏览器信任栅栏：自定义路由必须过一遍，否则可被任意网页读写。 */
  function rejected(req, res) {
    try {
      const conn = ctx.get('connection') || ctx.connection
      if (!conn || typeof conn.requestRejection !== 'function') return false
      const code = conn.requestRejection(req)
      if (code === undefined || code === null || code === false) return false
      res.statusCode = typeof code === 'number' ? code : 403
      res.end()
      return true
    } catch (err) {
      return false
    }
  }

  function registerRoute(route) {
    const inner = route && route.handler
    const wrapped = Object.assign({}, route, {
      handler: async (req, res) => {
        if (rejected(req, res)) return
        return inner(req, res)
      }
    })
    return ctx.webServer.register(wrapped)
  }

  function sendJson(res, code, payload) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length)
    })
    res.end(body)
  }

  function readBody(req, limit = 64 * 1024) {
    return new Promise((resolve) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > limit) {
          req.destroy()
          resolve('')
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
  }

  function sendText(res, type, text) {
    const body = Buffer.from(text, 'utf8')
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length)
    })
    res.end(body)
  }

  disposers.push(registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/splash.css',
    handler: (req, res) => sendText(res, 'text/css; charset=utf-8', readSplashCss())
  }))

  disposers.push(registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/splash.js',
    handler: (req, res) => sendText(res, 'application/javascript; charset=utf-8', readSplashJs())
  }))

  /* 音频素材：从用户提供的音轨里抠出来的音效（选项/确认音）。
     只读、白名单、不含子路径 —— 杜绝目录穿越。素材缺失时浏览器会自动回落到合成音。 */
  disposers.push(registerRoute({
    kind: 'prefix',
    path: ROUTE_BASE + '/asset',
    handler: (req, res) => {
      const name = path.basename(decodeURIComponent((req.url || '').split('?')[0]))
      if (!/^[a-z0-9._-]+\.mp3$/i.test(name) || name.includes('..')) {
        res.writeHead(404); res.end(); return
      }
      const file = path.join(PACKAGE_ROOT, 'lib', 'assets', name)
      let bytes
      try { bytes = fs.readFileSync(file) } catch (err) {
        res.writeHead(404); res.end(); return
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400',
        'Content-Length': String(bytes.length)
      })
      res.end(bytes)
    }
  }))

  disposers.push(registerRoute({
    kind: 'exact',
    path: ROUTE_BASE + '/config',
    handler: async (req, res) => {
      const method = (req.method || 'GET').toUpperCase()
      if (method === 'GET') {
        sendJson(res, 200, { ok: true, config: readConfig(), defaults: DEFAULTS, file: CONFIG_FILE })
        return
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const text = await readBody(req)
      let payload = {}
      try {
        payload = text ? JSON.parse(text) : {}
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'invalid json' })
        return
      }
      try {
        if (payload && payload.action === 'reset') {
          const cfgNow = writeConfig(DEFAULTS)
          sendJson(res, 200, { ok: true, config: cfgNow, defaults: DEFAULTS })
          return
        }
        const current = readConfig()
        const patch = payload && typeof payload.patch === 'object' && payload.patch ? payload.patch : payload
        const cfgNow = writeConfig({ ...current, ...patch })
        sendJson(res, 200, { ok: true, config: cfgNow, defaults: DEFAULTS })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
      }
    }
  }))

  /* --------------------------------------------------------------------------
   * index 注入：结构化行表（web 服务端渲染 + desktop IPC 下发，共用同一份）
   * ------------------------------------------------------------------------
   * 行表在「每次 index 请求时」重新收集（collectIndexInjections 现取现发），
   * 所以配置必须在这一刻读取，而不是 apply() 时读一次快照 —— 这样在设置页
   * 改完配置刷新页面即生效，无需重启 DSH。
   *
   * 行序即生效顺序：
   *   head: style(关键 CSS 兜底黑幕) → style(主题变量) → script(配置+引导守卫)
   *   body: html(挂载点) → script-src(运行时 splash.js)
   * 关键 CSS 与引导守卫都走「内联 script/style 行」，因为内联行在文档里同步
   * 执行、且排在应用入口模块之前；script-src 是独立异步资源，可能晚于应用
   * 挂载，故只用于运行时本身（黑幕与 9 秒兜底已由内联守卫保证）。
   * ------------------------------------------------------------------------ */
  function buildInjections() {
    const cfg = readConfig()
    if (!cfg.enabled) return []

    const rows = []
    rows.push({ kind: 'style', text: CRITICAL_CSS })
    rows.push({
      kind: 'script',
      placement: 'head',
      text:
        'window.__DSH_STARTUP_BASE__=' + safeJson(ROUTE_BASE) + ';' +
        'window.__DSH_STARTUP__=' + safeJson(cfg) + ';' +
        BOOTSTRAP_JS
    })
    rows.push({
      kind: 'html',
      placement: 'body',
      html: '<div id="' + ROOT_ID + '" class="dsu-root dsu-boot"></div>'
    })
    rows.push({ kind: 'script-src', placement: 'body', src: ROUTE_BASE + '/splash.js' })
    return rows
  }

  disposers.push(ctx.on('webserver/index-inject', (table) => {
    if (!Array.isArray(table)) return
    for (const row of buildInjections()) table.push(row)
  }))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch (err) { /* noop */ }
    }
  })
}

/* 导出形状对齐 DSH 内部插件（如 dsh-host-open-in-app）：
   只给具名 name / inject / apply。
   两点刻意不做：
   1) 不导出 default —— cordis-plugin-loader 的 unwrapExports 是
      `exports.default ?? exports`，一旦有 default 就只认 default，
      两边都写反而多一个"改一处忘一处"的坑；
   2) 不导出 Config —— Cordis 约定 Config 是 schemastery schema，
      我这份只是普通默认值对象，当 schema 用会炸。本插件也不吃 profile 配置。 */
export { apply, inject, name }
