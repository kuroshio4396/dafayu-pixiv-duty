/**
 * lib/workspace.mjs —— 把插件绑到一个 DSH 工作区
 * ============================================================================
 * 目的（用户要求）：在 DSH 侧栏里有一个和本插件绑定的工作区。
 * 每轮 headless 会话就在这个目录里跑，于是它自然归属该工作区，
 * agent 的最后一条回复就是"下载成功 / 下载失败 / 搜寻无结果"的状态播报。
 *
 * 服务：`ctx.workspaceRegistry`（packages/workspace）
 *   - create(path, title)：目录必须已存在；同一路径重复调用返回同一条记录（不会重复建）
 *   - 它自己会做 realpath 规范化，所以传绝对路径即可
 *
 * ⚠️ 不能 inject 'workspaceRegistry'：某些精简 profile 没有这个服务，
 *     inject 缺失会让整条插件不激活。这里一律 ctx.get + try/catch。
 * ============================================================================
 */
import { mkdirSync, existsSync, realpathSync, readdirSync, readFileSync } from 'node:fs'
import { join, isAbsolute, resolve } from 'node:path'
import { svc } from './svc.mjs'

export function workspaceDirOf(cfg, home) {
  const raw = String(cfg?.workspaceDir || '').trim()
  if (!raw) return join(home, 'workspace')
  return isAbsolute(raw) ? raw : resolve(home, raw)
}

function registryOf(ctx) {
  return svc(ctx, 'workspaceRegistry')
}

/**
 * 确保工作区目录存在，并在 DSH 里注册。
 * @returns {{ok:boolean, path:string, id?:string, title?:string, note?:string}}
 */
export async function ensureWorkspace(ctx, home, cfg) {
  const dir = workspaceDirOf(cfg, home)
  try {
    mkdirSync(dir, { recursive: true })
  } catch (e) {
    return { ok: false, path: dir, note: `建目录失败：${e?.message ?? e}` }
  }
  if (cfg?.notifyWorkspace === false) {
    return { ok: true, path: dir, note: '工作区播报已关闭（不注册）' }
  }

  const reg = registryOf(ctx)
  if (!reg || typeof reg.create !== 'function') {
    return { ok: false, path: dir, note: '宿主没有 workspaceRegistry 服务，工作区未注册' }
  }

  try {
    const ws = await reg.create(dir, '刷Pixiv')
    let real = dir
    try { real = realpathSync.native ? realpathSync.native(dir) : realpathSync(dir) } catch { /* 忽略 */ }
    return { ok: true, path: real, id: ws?.id ? String(ws.id) : undefined, title: ws?.title || '刷Pixiv' }
  } catch (e) {
    return { ok: false, path: dir, note: `注册失败：${String(e?.message ?? e).slice(0, 200)}` }
  }
}

/** 供 /status 展示：目录在不在、有没有注册过（不主动建） */
export function workspaceStatus(cfg, home) {
  const dir = workspaceDirOf(cfg, home)
  return { path: dir, exists: existsSync(dir), enabled: cfg?.notifyWorkspace !== false }
}

function canonical(p) {
  try { return realpathSync(p) } catch { return resolve(p) }
}

function persistenceOf(ctx) {
  return svc(ctx, 'sessionPersistence')
}

/**
 * 把跑在**工作区目录里**的会话挂进该工作区。
 * ⚠️ 这是必需的：工作区的成员是 `record.sessionIds` 这份**显式名单**，
 *    DSH 只在首次 bootstrap 时按 cwd 归一次，之后外部进程新建的会话一律落「未分组」。
 *    `attachSession` 会校验会话 header 的 cwd 是否等于工作区路径，不等就拒绝——正好当安全阀。
 */
export async function adoptSessions(ctx, { home, cfg, since = 0, log = () => {} }) {
  if (cfg?.notifyWorkspace === false) return { ok: false, note: '播报已关闭' }
  const reg = registryOf(ctx)
  if (!reg || typeof reg.create !== 'function') return { ok: false, note: '没有 workspaceRegistry' }
  const dir = workspaceDirOf(cfg, home)
  try { mkdirSync(dir, { recursive: true }) } catch { /* 忽略 */ }

  let ws
  try { ws = await reg.create(dir, '刷Pixiv') } catch (e) {
    return { ok: false, note: `工作区不可用：${String(e?.message ?? e).slice(0, 160)}` }
  }

  const persistence = persistenceOf(ctx)
  if (!persistence || typeof persistence.list !== 'function') {
    return { ok: false, note: '没有 sessionPersistence，无法枚举会话' }
  }

  const target = canonical(dir)
  const current = new Set((ws.sessionIds || []).map(String))
  const added = []

  // 子进程刚退出时会话可能还没落盘 ⇒ 最多试 4 次（0/1.2/2.4/4.8 秒）
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1200 * attempt))
    let snapshots = []
    try { snapshots = await persistence.list() } catch { snapshots = [] }
    for (const snap of snapshots) {
      const h = snap?.header || snap
      if (!h?.id || !h.cwd) continue
      const id = String(h.id)
      if (current.has(id)) continue
      if (canonical(h.cwd) !== target) continue
      if (since) {
        const at = Date.parse(h.createdAt || '')
        if (Number.isFinite(at) && at < since - 120000) continue
      }
      try {
        await ws.attachSession(id)
        current.add(id)
        added.push(id)
      } catch (e) {
        log(`会话 ${id} 挂载失败：${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
    if (added.length) break
  }

  if (added.length) log(`已把 ${added.length} 个会话挂进工作区：${added.join(', ')}`)
  return { ok: true, path: target, added }
}

/** 是否有 Jet Hub（CodeBuddy 等渠道）可用：只探测，不加载 */
export function findHubDir(env = process.env) {
  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || '', '.dsh')
  const candidates = []
  // 1) 各 profile 里装过（最常见）
  try {
    for (const p of readdirSync(home + '/profiles')) {
      candidates.push(join(home, 'profiles', p, 'node_modules', 'dsh-providers-hub'))
    }
  } catch { /* 没有 profiles */ }
  // 2) 桌面版内置
  if (env.DSH_DESKTOP_NODE_EXECUTABLE) {
    candidates.push(join(env.DSH_DESKTOP_NODE_EXECUTABLE, '..', 'resources', 'app.asar', 'dsh', 'node_modules', 'dsh-providers-hub'))
  }
  for (const dir of candidates) {
    try { if (existsSync(join(dir, 'lib', 'index.js'))) return dir } catch { /* 忽略 */ }
  }
  return null
}

/** 读 Jet Hub 的账号概况（**不读任何凭据字段**，只读展示用信息） */
export function hubAccounts(home) {
  const file = join(home, '..', 'jet-hub', 'state.json')
  const st = (() => {
    try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  })()
  if (!st) return { ok: false, note: '没找到 Jet Hub 账号数据（/jet-hub/state.json）', accounts: [] }
  const list = Array.isArray(st.accounts) ? st.accounts : Object.values(st.accounts || {})
  const accounts = list.slice(0, 30).map((a) => ({
    provider: a.provider || '',
    id: a.id || a.accountId || '',
    name: a.name || a.nickname || a.email || '',
    disabled: Boolean(a.disabled || a.enabled === false),
  }))
  return { ok: true, accounts }
}
