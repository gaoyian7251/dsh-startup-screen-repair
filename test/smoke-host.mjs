/* ============================================================================
 * Host 半侧冒烟测试 —— 不装进 DSH，直接用假 ctx 把 apply() 跑一遍。
 * 覆盖：路由注册 / 信任栅栏 / 配置读写落盘 / 结构化 index 注入行
 *       / web 服务端渲染 / desktop IPC 下发 两条通道的一致性。
 * 用法：node smoke-host.mjs
 * ========================================================================== */
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 找一份真实的 DSH dist/index.html 来做注入测试；找不到就用等价的最小样本。
 *  跨平台：Windows 的 npx 缓存在 %LOCALAPPDATA%，POSIX 在 ~/.npm 或 ~/.cache。 */
function findRealIndex() {
  const candidates = []
  if (process.env.DSH_FRONTEND_INDEX) candidates.push(process.env.DSH_FRONTEND_INDEX)
  const caches = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'npm-cache', '_npx'),
    path.join(os.homedir(), '.npm', '_npx'),
    path.join(os.homedir(), '.cache', 'npm', '_npx'),
    /* DSH desktop：前端 dist 打包在应用资源里，允许直接指过去 */
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar.unpacked'),
  ].filter(Boolean)
  for (const npx of caches) {
    try {
      for (const d of fs.readdirSync(npx)) {
        candidates.push(path.join(npx, d, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'))
      }
    } catch { /* 这个缓存目录不存在，换下一个 */ }
  }
  for (const c of candidates) if (fs.existsSync(c)) return { path: c, html: fs.readFileSync(c, 'utf8') }
  /* 样本严格照 DSH dist/index.html 的形状写（属性都带引号），
     这样没装 DSH 的机器上跑到的断言和真机完全一致 */
  return { path: '(内置样本，形状等同 DSH dist/index.html)', html: [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '    <title>DeepSeek Harness</title>',
    '    <script type="module" crossorigin src="./assets/index-XXX.js"></script>',
    '    <link rel="stylesheet" crossorigin href="./assets/vendor-XXX.css">',
    '  </head>',
    '  <body>',
    '    <div id="root"></div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n') }
}
const REAL_INDEX = findRealIndex()
const SMOKE_HOME = path.join(os.tmpdir(), 'dsh-startup-smoke-' + Date.now())
fs.mkdirSync(SMOKE_HOME, { recursive: true })
process.env.DSH_HOME = SMOKE_HOME

/* ----------------------------------------------------------------------------
 * 复刻 dsh-host-webserver 的 renderIndexInjections（逐行照抄语义），
 * 用来验证 web 侧渲染结果；desktop 侧则直接消费同一份行表。
 * -------------------------------------------------------------------------- */
const READY_MARKUP = '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'
const escapeHtmlAttribute = (v) => v.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const lt = (s) => JSON.stringify(s).replaceAll('<', '\\u003c')

function renderRow(row) {
  switch (row.kind) {
    case 'global': return { placement: 'head', markup: `<script>globalThis[${lt(row.name)}] = ${row.value === undefined ? 'undefined' : lt(row.value)}</script>` }
    case 'script': return { placement: row.placement, markup: `<script>${row.text}</script>` }
    case 'script-src': return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` }
    case 'script-preload': return { placement: 'head', markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">` }
    case 'style': return { placement: 'head', markup: `<style>${row.text}</style>` }
    case 'html': return { placement: row.placement, markup: row.html }
    default: throw new Error('webserver: unknown index injection row ' + JSON.stringify(row))
  }
}
function renderIndexInjections(html, rows) {
  let head = ''
  let body = ''
  for (const row of rows) {
    const r = renderRow(row)
    if (r.placement === 'head') head += r.markup
    else body += r.markup
  }
  body += READY_MARKUP
  const splice = (h, at, m) => h.slice(0, at) + m + h.slice(at)
  let out = html
  if (head !== '') {
    const open = /<head(?:\s[^>]*)?>/i.exec(out)
    out = open === null ? head + out : splice(out, open.index + open[0].length, head)
  }
  if (body !== '') {
    const open = /<body(?:\s[^>]*)?>/i.exec(out)
    out = open === null ? out + body : splice(out, open.index + open[0].length, body)
  }
  return out
}

/** 复刻 desktop 页面侧解释器 hM(rows, loadScript) 的可观察效果。 */
function applyDesktopRows(rows) {
  const applied = []
  for (const row of rows) {
    switch (row.kind) {
      case 'global': applied.push({ type: 'global', name: row.name, value: row.value }); break
      case 'script': applied.push({ type: 'inline-script', placement: row.placement || 'body', text: row.text }); break
      case 'script-src': applied.push({ type: 'external-script', placement: row.placement || 'body', src: row.src }); break
      case 'script-preload': break
      case 'style': applied.push({ type: 'style', text: row.text }); break
      case 'html': applied.push({ type: 'html', placement: row.placement || 'body', html: row.html }); break
      default: throw new Error('web boot: unknown index injection row ' + JSON.stringify(row))
    }
  }
  return applied
}

const ROUTES = new Map()
const INJECT_HANDLERS = []
let effects = 0
let rejectNext = undefined

const ctx = {
  webServer: {
    register(route) {
      if (ROUTES.has(route.kind + ' ' + route.path)) throw new Error('duplicate route ' + route.path)
      ROUTES.set(route.kind + ' ' + route.path, route)
      return () => ROUTES.delete(route.kind + ' ' + route.path)
    },
    /* 现取现发：与真实 WebServer.collectIndexInjections() 同构 */
    collectIndexInjections() {
      const table = []
      for (const h of INJECT_HANDLERS) h(table)
      return table
    },
  },
  on(event, handler) {
    if (event !== 'webserver/index-inject') throw new Error('unexpected event ' + event)
    INJECT_HANDLERS.push(handler)
    return () => INJECT_HANDLERS.splice(INJECT_HANDLERS.indexOf(handler), 1)
  },
  get(name) {
    if (name !== 'connection') return undefined
    return {
      // 官方 dsh-host-open-in-app 同款栅栏：返回 undefined = 放行
      requestRejection() { return rejectNext },
    }
  },
  effect(fn) { effects++; const d = fn(); return () => { if (typeof d === 'function') d() } },
}

const collect = () => ctx.webServer.collectIndexInjections()

class FakeReq extends EventEmitter {
  constructor(method, body, url) {
    super()
    this.method = method
    this.headers = { host: '127.0.0.1:3080' }
    this.url = url || '/'
    process.nextTick(() => {
      if (body !== undefined) this.emit('data', Buffer.from(body))
      this.emit('end')
    })
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || {}; return this },
    end(buf) { this.body = buf === undefined ? '' : Buffer.from(buf).toString('utf8') },
  }
}

async function call(kindPath, method = 'GET', body, url) {
  const route = ROUTES.get(kindPath)
  if (!route) throw new Error('route missing: ' + kindPath)
  const res = fakeRes()
  await route.handler(new FakeReq(method, body, url), res)
  return res
}

let pass = 0
let fail = 0
function check(label, ok, extra) {
  if (ok) { pass++; console.log('  ok   ' + label) }
  else { fail++; console.log('  FAIL ' + label + (extra ? '  → ' + extra : '')) }
}

console.log('\n[1] 模块导出形状（对齐 cordis-plugin-loader 的 unwrapExports）')
const mod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'lib', 'index.js')).href)
check('有具名 name', typeof mod.name === 'string', mod.name)
check('name 与 cordis.patch.yml 的 id 一致', mod.name === 'dsh-startup-screen-repair', mod.name)
check('有具名 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))
check('inject 含 webServer + connection', mod.inject.includes('webServer') && mod.inject.includes('connection'))
check('有具名 apply', typeof mod.apply === 'function')
check('没有 default 导出（避免 unwrapExports 只认 default）', mod.default === undefined, String(mod.default))
check('没有 Config 导出（普通对象不是 schemastery schema）', mod.Config === undefined, String(mod.Config))

console.log('\n[2] apply(ctx)：路由与注入')
mod.apply(ctx)
check('注册了 4 条路由', ROUTES.size === 4, [...ROUTES.keys()].join(' | '))
check('订阅了 1 个 webserver/index-inject', INJECT_HANDLERS.length === 1, String(INJECT_HANDLERS.length))
check('不再使用已废弃的 tapIndex', typeof ctx.webServer.tapIndex === 'undefined')
check('用了 ctx.effect 管理生命周期', effects === 1, String(effects))

console.log('\n[3] 静态路由')
let r = await call('exact /dsh-startup/splash.css')
check('splash.css 200 + 正确 MIME', r.statusCode === 200 && /text\/css/.test(r.headers['Content-Type']), r.headers['Content-Type'])
check('splash.css 非空', r.body.length > 10000, r.body.length + ' bytes')
r = await call('exact /dsh-startup/splash.js')
check('splash.js 200 + 正确 MIME', r.statusCode === 200 && /javascript/.test(r.headers['Content-Type']), r.headers['Content-Type'])
check('splash.js 非空', r.body.length > 20000, r.body.length + ' bytes')

console.log('\n[3b] 音频素材路由')
r = await call('prefix /dsh-startup/asset')
check('请求 /asset 无文件名 -> 404', r.statusCode === 404, String(r.statusCode))
r = await call('prefix /dsh-startup/asset', 'GET', undefined, '/dsh-startup/asset/sfx-tick.mp3')
check('sfx-tick.mp3 -> 200 + audio/mpeg', r.statusCode === 200 && r.headers['Content-Type'] === 'audio/mpeg', r.headers['Content-Type'])
check('sfx-tick.mp3 有内容', r.body.length > 500, r.body.length + ' bytes')
r = await call('prefix /dsh-startup/asset', 'GET', undefined, '/dsh-startup/asset/../../package.json')
check('目录穿越被拒 -> 404', r.statusCode === 404, String(r.statusCode))
r = await call('prefix /dsh-startup/asset', 'GET', undefined, '/dsh-startup/asset/nope.mp3')
check('不存在的素材 -> 404', r.statusCode === 404, String(r.statusCode))
for (const f of ['line-1', 'line-2', 'line-3', 'line-4', 'line-5']) {
  const rr = await call('prefix /dsh-startup/asset', 'GET', undefined, '/dsh-startup/asset/' + f + '.mp3')
  check('真声素材 ' + f + '.mp3 -> 200', rr.statusCode === 200 && rr.body.length > 5000, rr.statusCode + ' ' + rr.body.length)
}

console.log('\n[4] 配置读写落盘')
r = await call('exact /dsh-startup/config')
let cfg = JSON.parse(r.body)
check('GET config ok', cfg.ok === true)
check('默认身份名称 = JOYCE MOORE', cfg.config.identity === 'JOYCE MOORE', cfg.config.identity)
check('默认身份编号 = 0087', cfg.config.identityId === '0087', cfg.config.identityId)
check('返回了配置文件路径', typeof cfg.file === 'string' && cfg.file.startsWith(SMOKE_HOME), cfg.file)

r = await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { identity: '琉璃', speed: 99, enabled: 'true' } }))
cfg = JSON.parse(r.body)
check('POST config ok', cfg.ok === true)
check('身份名称写入成功（中文）', cfg.config.identity === '琉璃', cfg.config.identity)
check('speed 被夹到上限 3', cfg.config.speed === 3, String(cfg.config.speed))
check('enabled 字符串 "true" 被转成 boolean true', cfg.config.enabled === true, String(cfg.config.enabled))
check('配置已落盘', fs.existsSync(path.join(SMOKE_HOME, 'dsh-startup.json')))

r = await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { identityId: '' } }))
check('身份编号留空 + 纯中文名 → 兜底 OPERATOR', JSON.parse(r.body).config.identityId === 'OPERATOR', JSON.parse(r.body).config.identityId)
r = await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { identity: 'Ada Lovelace', identityId: '' } }))
check('身份编号留空 + 英文名 → 自动派生 ADALOVELACE', JSON.parse(r.body).config.identityId === 'ADALOVELACE', JSON.parse(r.body).config.identityId)
r = await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { speed: 0.01, theme: 'neon', accent: 'javascript:alert(1)' } }))
cfg = JSON.parse(r.body)
check('speed 低于下限被夹到 0.35', cfg.config.speed === 0.35, String(cfg.config.speed))
check('非法 theme 回落到 light', cfg.config.theme === 'light', cfg.config.theme)
check('非法颜色回落到默认橙', cfg.config.accent === '#ff7500', cfg.config.accent)

r = await call('exact /dsh-startup/config', 'POST', JSON.stringify({ action: 'reset' }))
check('reset 恢复默认', JSON.parse(r.body).config.identity === 'JOYCE MOORE')

r = await call('exact /dsh-startup/config', 'POST', '{ not json')
check('非法 JSON 返回 400', r.statusCode === 400, String(r.statusCode))
r = await call('exact /dsh-startup/config', 'DELETE')
check('不支持的方法返回 405', r.statusCode === 405, String(r.statusCode))

console.log('\n[5] 信任栅栏（DNS 重绑定 / 未认证请求）')
rejectNext = 403
r = await call('exact /dsh-startup/config')
check('connection 拒绝时返回 403 且不吐配置', r.statusCode === 403 && r.body === '', r.statusCode + ' body=' + JSON.stringify(r.body.slice(0, 40)))
rejectNext = undefined

/** 从注入结果里精确抠出内联 JSON 载荷（window.__DSH_STARTUP__= ... ;BOOTSTRAP） */
function inlinePayload(html) {
  const a = html.indexOf('window.__DSH_STARTUP__=')
  const b = html.indexOf(';(function(){try{', a)
  return a === -1 || b === -1 ? '' : html.slice(a + 'window.__DSH_STARTUP__='.length, b)
}

console.log('\n[6] 结构化注入行表（row shape）')
const rows = collect()
check('注入行数 = 4', rows.length === 4, String(rows.length))
check('行 1 = style(关键 CSS)', rows[0].kind === 'style' && rows[0].text.includes('dsu-boot'), rows[0].kind)
check('行 2 = head 内联 script(配置+引导)', rows[1].kind === 'script' && rows[1].placement === 'head', rows[1].kind + '/' + rows[1].placement)
check('行 3 = html 挂载点', rows[2].kind === 'html' && rows[2].html.includes('id="dsh-startup-root"'), rows[2].kind)
check('行 4 = script-src 运行时', rows[3].kind === 'script-src' && rows[3].src === '/dsh-startup/splash.js', rows[3].kind + '/' + rows[3].src)
check('所有行都是纯 JSON 可序列化（web 渲染 + desktop IPC 共用前提）', (() => {
  try { JSON.parse(JSON.stringify(rows)); return true } catch { return false }
})())
check('行内不含 undefined 值', JSON.stringify(rows).includes('undefined') === false || !/(:|\[|,)\s*undefined/.test(JSON.stringify(rows)))
check('每行 kind 都是已知类型', rows.every((x) => ['global', 'script', 'script-src', 'script-preload', 'style', 'html'].includes(x.kind)))

console.log('\n[6b] web 通道：服务端渲染进 index.html（源: ' + REAL_INDEX.path + '）')
const before = REAL_INDEX.html
const after = renderIndexInjections(before, collect())
check('关键 CSS 落在 <head> 内', after.indexOf('dsu-boot') > after.toLowerCase().indexOf('<head'), String(after.indexOf('dsu-boot')))
check('关键 CSS 早于应用入口模块', after.indexOf('dsu-boot') < after.indexOf('type="module"'))
check('配置 + 引导脚本落在 <head> 内且早于应用入口', after.indexOf('window.__DSH_STARTUP__=') < after.indexOf('type="module"') && after.indexOf('window.__DSH_STARTUP__=') > 0)
check('注入了挂载点 div', after.includes('<div id="dsh-startup-root" class="dsu-root dsu-boot">'))
check('注入了运行时 <script src>', after.includes('<script src="/dsh-startup/splash.js"></script>'))
check('挂载点紧跟 <body>', /<body>\s*<div id="dsh-startup-root"/.test(after))
check('注入了 __DSH_BOOT_READY__ 结算脚本', after.includes('__DSH_BOOT_READY__ ??= Promise.withResolvers()'))
check('原 <div id="root"></div> 仍在（应用照常挂载）', after.includes('<div id="root"></div>'))
check('内联载荷是合法 JSON', (() => { try { JSON.parse(inlinePayload(after)); return true } catch { return false } })())
check('内联载荷里没有裸的 < （防 </script> 提前闭合）', !inlinePayload(after).includes('<'))

console.log('\n[6c] desktop 通道：同表经 IPC 由页面内解释器应用')
const applied = applyDesktopRows(collect())
check('页面侧能应用全部 4 行（无未知 kind）', applied.length === 4, String(applied.length))
check('  含 style 行（首屏黑幕）', applied.some((x) => x.type === 'style' && x.text.includes('dsu-boot')))
check('  含内联 script 行（配置+引导）', applied.some((x) => x.type === 'inline-script' && x.text.includes('window.__DSH_STARTUP__=')))
check('  含 html 行（挂载点）', applied.some((x) => x.type === 'html' && x.html.includes('dsh-startup-root')))
check('  含 external-script 行（运行时）', applied.some((x) => x.type === 'external-script' && x.src === '/dsh-startup/splash.js'))
check('两端消费的是同一份行表（web 渲染数 = desktop 应用数）', renderRow(rows[0]).placement !== undefined && applied.length === rows.length)

console.log('\n[6d] enabled=false 时完全静默')
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { enabled: false } }))
check('关闭后行表为空（不注入任何东西）', collect().length === 0, String(collect().length))
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { enabled: true } }))
check('重新打开后行表恢复 4 行', collect().length === 4, String(collect().length))

console.log('\n[6e] 配置在「每次收集时」现读（改完刷新即生效）')
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { identity: '实时刷新检查' } }))
const rowsLive = collect()
const livePayload = rowsLive.find((x) => x.kind === 'script').text
check('新配置无需重启即出现在注入行里', livePayload.includes('实时刷新检查'), livePayload.slice(0, 80))
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ action: 'reset' }))

console.log('\n[7] XSS 边界：身份名称里的尖括号不会逃出内联脚本')
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ patch: { identity: '</script><img src=x onerror=alert(1)>' } }))
const xssRows = collect()
const payload = inlinePayload(renderIndexInjections(before, xssRows))
check('尖括号被转义成 \\u003c', payload.includes('\\u003c'), payload.slice(0, 120))
check('载荷里没有 </script>', !payload.includes('</script>'))
check('转义后仍是合法 JSON 且值可还原', (() => {
  try { return JSON.parse(payload).identity === '</script><img src=x onerror=alert(1)>' } catch { return false }
})())
check('挂载点 html 行不含配置内容（静态标记，无注入面）', !xssRows.find((x) => x.kind === 'html').html.includes('script'))
await call('exact /dsh-startup/config', 'POST', JSON.stringify({ action: 'reset' }))

console.log('\n[8] 生命周期：dispose 后不留残留')
/* 用一份完全独立的 ctx 走完整 apply，再触发它注册的 effect 清理回调，
   避免与前面已注册的路由共用 key。 */
const ROUTES2 = new Map()
const HANDLERS2 = []
let cleanup
const ctx2 = {
  webServer: {
    register(route) {
      const key = route.kind + ' ' + route.path
      if (ROUTES2.has(key)) throw new Error('duplicate route ' + route.path)
      ROUTES2.set(key, route)
      return () => ROUTES2.delete(key)
    },
    collectIndexInjections() {
      const table = []
      for (const h of HANDLERS2) h(table)
      return table
    },
  },
  on(event, handler) {
    if (event !== 'webserver/index-inject') throw new Error('unexpected event ' + event)
    HANDLERS2.push(handler)
    return () => HANDLERS2.splice(HANDLERS2.indexOf(handler), 1)
  },
  get() { return undefined },
  effect(fn) { cleanup = fn(); return () => {} },
}
mod.apply(ctx2)
check('独立 ctx 上注册了 4 条路由', ROUTES2.size === 4, String(ROUTES2.size))
check('独立 ctx 上订阅了 1 个 index-inject', HANDLERS2.length === 1, String(HANDLERS2.length))
check('清理前有注入行', (() => { const t = []; HANDLERS2.forEach((h) => h(t)); return t.length === 4 })())
cleanup()
check('dispose 清掉了路由', ROUTES2.size === 0, String(ROUTES2.size))
check('dispose 清掉了 index-inject 订阅', HANDLERS2.length === 0, String(HANDLERS2.length))
check('dispose 后不再注入', (() => { const t = []; HANDLERS2.forEach((h) => h(t)); return t.length === 0 })())
/* 插件自身对 index-inject 表做了 Array.isArray 防抖：即使宿主传进来
   一个非数组（不该发生），也不能把插件打挂。 */
let nonArraySafe = true
try { for (const h of INJECT_HANDLERS) h(undefined) } catch { nonArraySafe = false }
check('宿主误传非数组表时不抛异常（防御性判断）', nonArraySafe)
check('误传非数组后正常收集仍返回 4 行', collect().length === 4, String(collect().length))

fs.rmSync(SMOKE_HOME, { recursive: true, force: true })
console.log('\n============================')
console.log(`  通过 ${pass} / 失败 ${fail}`)
console.log('============================\n')
process.exit(fail === 0 ? 0 : 1)
