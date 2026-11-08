/**
 * 作品库「轻量守护」：只数文件夹和字节数，不逐个读文件。
 *
 * 使用者原话：作品多到不可能逐文件核对，所以每轮开跑前只确认
 *   「下载目录还在不在 + 目录下文件夹数目 + 文件总大小」
 * 一旦对不上：auto = 立刻回滚并弹窗；ask = 弹窗问；off = 不管。
 *
 * 哨兵文件放插件家目录，记的是「上一次已知良好的样子」。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { libPaths } from './library.mjs'
import { readJson, writeJsonAtomic } from './state.mjs'

const SNAP = 'library-snapshot.json'

function dirSize(dir) {
  let bytes = 0
  let files = 0
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return { bytes: 0, files: 0 }
  }
  for (const e of entries) {
    if (!e.isFile()) continue
    try {
      bytes += statSync(join(dir, e.name)).size
      files += 1
    } catch {
      /* 文件刚好被删，忽略 */
    }
  }
  return { bytes, files }
}

function readMeta(dir) {
  try {
    const mf = readdirSync(dir).find((f) => /^metadata\..*\.json$/.test(f))
    if (!mf) return {}
    return JSON.parse(readFileSync(join(dir, mf), 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return {}
  }
}

/** 只扫 allwork 一层目录：一个目录 = 一件作品（页文件都在里面） */
export function scanLibrary({ cfg, home }) {
  const p = libPaths(cfg, home)
  const works = []
  if (existsSync(p.allwork)) {
    for (const d of readdirSync(p.allwork, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const dir = join(p.allwork, d.name)
      const meta = readMeta(dir)
      const s = dirSize(dir)
      works.push({
        name: d.name,
        id: Number(meta.id) || null,
        kind: meta.kind || '',
        pages: Number(meta.pageCount) || 0,
        bytes: s.bytes,
        files: s.files,
        at: meta.savedAt || '',
      })
    }
  }
  return {
    at: new Date().toISOString(),
    dir: p.allwork,
    works,
    dirs: works.length,
    bytes: works.reduce((a, w) => a + w.bytes, 0),
  }
}

export function readSnapshot({ cfg, home }) {
  return readJson(join(home, SNAP), null)
}

/** 记下「现在这个样子是好的」，下次开跑拿它比 */
export function saveSnapshot({ cfg, home, snap }) {
  const s = snap || scanLibrary({ cfg, home })
  writeJsonAtomic(join(home, SNAP), s)
  return s
}

export function snapshotSummary(snap) {
  if (!snap) return '还没有存档（第一次跑会建）'
  return `${snap.dirs} 件 · ${(snap.bytes / 1048576).toFixed(1)} MB · 存档于 ${String(snap.at || '').slice(0, 16).replace('T', ' ')}`
}

/** 比对：缺了哪些作品、哪些作品里文件少了、多了哪些 */
export function diffLibrary({ cfg, home }) {
  const prev = readSnapshot({ cfg, home })
  const now = scanLibrary({ cfg, home })
  if (!prev) {
    return { ok: true, first: true, now, prev: null, missing: [], shrunk: [], added: now.dirs, dirs: now.dirs, bytes: now.bytes }
  }
  const byName = new Map(now.works.map((w) => [w.name, w]))
  const missing = []
  const shrunk = []
  for (const w of prev.works) {
    const n = byName.get(w.name)
    if (!n) missing.push(w)
    else if (n.bytes < w.bytes || n.files < w.files) shrunk.push({ ...w, nowBytes: n.bytes, nowFiles: n.files })
  }
  const prevNames = new Set(prev.works.map((w) => w.name))
  const added = now.works.filter((w) => !prevNames.has(w.name)).length
  return {
    ok: missing.length === 0 && shrunk.length === 0,
    first: false,
    now,
    prev,
    missing,
    shrunk,
    added,
    dirs: now.dirs,
    bytes: now.bytes,
    prevDirs: prev.dirs,
    prevBytes: prev.bytes,
  }
}

/**
 * 回滚到最新存档：把缺的 / 少文件的先挪进 trash（不删），再按台账重下。
 * 只补不删，多出来的作品原样留着。
 */
export async function rollbackLibrary({ cfg, home, restore, log = () => {} }) {
  const d = diffLibrary({ cfg, home })
  if (d.ok) return { ok: true, rolledBack: [], note: '和存档一致，不用回滚' }
  const targets = [...d.missing.map((w) => ({ ...w, why: 'gone' })), ...d.shrunk.map((w) => ({ ...w, why: 'shrunk' }))]
  const trash = join(home, 'trash', new Date().toISOString().replace(/[:.]/g, '-'))
  const moved = []
  for (const t of targets) {
    if (!t.id) continue
    if (t.why === 'shrunk') {
      try {
        mkdirSync(trash, { recursive: true })
        renameSync(join(libPaths(cfg, home).allwork, t.name), join(trash, t.name))
        moved.push(t.name)
      } catch (e) {
        log(`挪走残件失败 ${t.name}: ${e?.message ?? e}`)
      }
    }
  }
  const ids = targets.map((t) => t.id).filter(Boolean)
  let r = { restored: [] }
  try {
    r = await restore({ items: ids, limit: Math.max(1, Math.min(30, ids.length)) })
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e), targets: ids, moved }
  }
  const back = (r.restored || []).filter((x) => x.ok !== false)
  const after = diffLibrary({ cfg, home })
  saveSnapshot({ cfg, home })
  return {
    ok: after.ok,
    rolledBack: back.map((x) => x.id),
    failed: (r.restored || []).filter((x) => x.ok === false),
    targets: ids,
    moved,
    stillMissing: after.missing.length + after.shrunk.length,
  }
}

/** 只留一份快照 + 一份「上次比对结果」，别让家目录长毛 */
export function pruneSnapshots({ home }) {
  for (const f of ['library-snapshot.json.tmp']) {
    try {
      if (existsSync(join(home, f))) rmSync(join(home, f), { force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/** 备份快照（回滚前留证据，排错用） */
export function backupSnapshot({ home }) {
  const src = join(home, SNAP)
  if (!existsSync(src)) return ''
  const dst = join(home, 'log', `snapshot-${Date.now()}.json`)
  try {
    copyFileSync(src, dst)
    return dst
  } catch {
    return ''
  }
}
