/**
 * lib/state.mjs —— 插件的"家"：目录、窗口、章程账本、日志
 * ============================================================================
 * 规矩（沿用 dsh-bili-scroll）：配置、凭证、缓存、报告、日志全部放插件自己的家
 * `$DSH_HOME/pixiv-duty/`，**绝不写进插件包目录**（装进 node_modules 后可能只读，
 * 升级也会被覆盖）。
 *
 * 还有一件小事但很要紧：vendor 里的 `mcp_server.py` 用 `PIXIV_CREDENTIAL_FILE`
 * 定位凭证；脚本仍然要拷一份到家里再跑 —— 这样 `__file__` 旁边那份默认位置也落在家里。
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, appendFileSync,
  statSync, renameSync, readdirSync, rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 谷时窗口（北京时间）—— 想改就改这一处。
 * DeepSeek 官方口径：工作日 9:00–12:00、14:00–18:00 是高峰，其余（含整个周末）都是谷时。
 * ⇒ 12:00–14:00、18:00 之后一整晚都便宜。
 */
export const WINDOWS = {
  noon: { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/** 家目录下要预建的子目录（沙箱只允许写"启动前已存在"的目录） */
const SUBDIRS = ['cache', 'cache/view', 'cache/orig', 'cache/novel', 'out', 'library', 'log', 'tmp']

/**
 * ⚠️ `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串：
 *    `dshHomePath(...segments) => join(resolveDshHome(), ...segments)`
 *    当字符串用会把函数源码当成路径 ⇒ mkdir ENOENT ⇒ 插件整条不激活。
 */
export function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('pixiv-duty')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'pixiv-duty')
    }
  } catch { /* 拿不到就用下面的兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'pixiv-duty')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
}

/** 原子写：先写 .tmp 再 rename（断电/被杀不会留下半个 JSON） */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 预建目录：host 半端在 spawn 之前必须跑一次 */
export function ensureDirs(stateDir) {
  const made = []
  for (const sub of SUBDIRS) {
    const p = join(stateDir, sub)
    if (!existsSync(p)) { mkdirSync(p, { recursive: true }); made.push(p) }
  }
  return made
}

/** 首次运行：把 vendored 的 Python 脚本铺进家里（脚本变了就覆盖） */
export function ensureHomeFiles(pluginDir, stateDir, log = () => {}) {
  const py = ['mcp_server.py', 'px_client.py', 'px_search.py', 'px_fetch.py', 'px_novel.py', 'requirements.txt']
  const copies = py.map((f) => [join(pluginDir, 'vendor', 'pixiv-mcp', f), join(stateDir, f)])
  for (const [from, to] of copies) {
    try {
      if (!existsSync(from)) { log(`缺文件：${from}`); continue }
      if (existsSync(to) && readFileSync(from, 'utf8') === readFileSync(to, 'utf8')) continue
      copyFileSync(from, to)
      log(`已铺好：${to}`)
    } catch (e) { log(`铺 ${to} 失败：${e?.message ?? e}`) }
  }
}

/** 值班章程：家里那份优先，没有才用插件里那份 */
export function charterPath(pluginDir, stateDir) {
  const home = join(stateDir, 'duty.md')
  try { if (existsSync(home)) return home } catch { /* 兜底 */ }
  return join(pluginDir, 'prompts', 'duty.md')
}

/**
 * 章程升级 = 记账制（不是比 mtime）。
 *   · 家里那份 === 上次铺的 sha256 ⇒ 用户没动过 ⇒ 直接用 shipped 覆盖
 *   · 家里那份变过            ⇒ 用户改过   ⇒ 一个字都不动，新版另存 duty.md.new
 *   · 没有账本（第一次带账本跑）⇒ 分不清，按"改过"处理
 */
export function ensureCharter(pluginDir, stateDir, log = () => {}) {
  const shipped = join(pluginDir, 'prompts', 'duty.md')
  const home = join(stateDir, 'duty.md')
  const ledger = join(stateDir, 'charter.sha256')
  const fresh = join(stateDir, 'duty.md.new')
  const readIf = (f) => { try { return readFileSync(f, 'utf8') } catch { return '' } }
  try {
    if (!existsSync(shipped)) { log(`缺文件：${shipped}`); return }
    const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
    const newText = readFileSync(shipped, 'utf8')
    const hShip = sha(newText)
    const hLast = readIf(ledger).trim()
    if (!existsSync(home)) {
      writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
      log('已铺好值班章程')
      return
    }
    const hHome = sha(readFileSync(home, 'utf8'))
    if (hHome === hShip) {
      if (hLast !== hShip) writeFileSync(ledger, hShip, 'utf8')
      return
    }
    if (!hLast || hHome !== hLast) {
      if (hShip !== hLast && readIf(fresh) !== newText) {
        writeFileSync(fresh, newText, 'utf8')
        log(`值班章程有新版、但家里那份你改过 ⇒ 新版另存为 ${fresh}，自己合一下`)
      }
      return
    }
    writeFileSync(home, newText, 'utf8'); writeFileSync(ledger, hShip, 'utf8')
    log('值班章程已更新到插件里这一版')
  } catch (e) { log(`铺值班章程失败：${e?.message ?? e}`) }
}

/** 'HH:MM' → 当天分钟数 */
function minutesOf(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim())
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** 现在在不在这个窗口里（支持跨零点，如 18:00–09:00） */
export function inWindow(now, win) {
  const start = minutesOf(win.start); const end = minutesOf(win.end)
  if (start === null || end === null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)
}

/** 本地日期 YYYY-MM-DD */
export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 本地时间 HHMMSS */
export function timeKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** 一轮的 id：日期-时分秒-4 位随机 */
export function roundId(now = new Date()) {
  const r = Math.random().toString(36).slice(2, 6)
  return `${dayKey(now)}-${timeKey(now)}-${r}`
}

/**
 * 写日志 —— **所有写失败都要吞掉**。
 * 参考实现踩过：日志被占用时抛 EBUSY，回调里没人接 ⇒ 整个宿主被杀。
 */
export function appendLog(stateDir, line, { maxBytes = 2 * 1024 * 1024 } = {}) {
  try {
    const f = join(stateDir, 'duty.log')
    const stamp = new Date().toISOString()
    appendFileSync(f, `[${stamp}] ${String(line).replace(/\s+$/, '')}\n`, 'utf8')
    try {
      if (statSync(f).size > maxBytes) {
        const old = join(stateDir, 'duty.log.1')
        if (existsSync(old)) rmSync(old, { force: true })
        renameSync(f, old)
      }
    } catch { /* 轮转失败不影响主流程 */ }
  } catch { /* 写不了日志也绝不能冒泡 */ }
}

/** 读日志尾部 N 行（给设置页与占位报告用） */
export function tailLog(stateDir, lines = 40) {
  try {
    const text = readFileSync(join(stateDir, 'duty.log'), 'utf8')
    return text.trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch { return '' }
}

/** 清缓存：删掉 N 小时之前的文件（只在收尾时调） */
export function pruneCache(stateDir, hours = 24, log = () => {}) {
  const root = join(stateDir, 'cache')
  const cutoff = Date.now() - hours * 3600e3
  let n = 0
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      try {
        if (e.isDirectory()) { walk(p); continue }
        if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); n++ }
      } catch { /* 单个文件失败就算了 */ }
    }
  }
  try { walk(root); if (n) log(`清理缓存 ${n} 个文件`) } catch { /* 忽略 */ }
  return n
}
