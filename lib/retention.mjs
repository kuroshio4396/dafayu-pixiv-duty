/**
 * 归档策略（使用者 2026-10-30 定的口径）：
 *
 * ① 没点头的候选缓存：留 30 天可查；过期只保留「当天选了哪些」这一条记录，
 *    缩略图、理由、标签全删 —— 他要的是「我当时挑了哪几张」，不是全文回放。
 * ② 被删作品的记录：留 90 天（这段时间里还能按台账重下恢复）；过期连记录一起清掉，
 *    也就是说过期之后就真的恢复不了了。
 *
 * 两个数都能在设置里改（cacheDays / deleteRecordDays）。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { candidatesFile, pageFile, picksRoot, roundDir } from './picks.mjs'
import { libPaths, readManifest } from './library.mjs'

const day = 864e5

function histDir(root) {
  const d = join(root, 'history')
  try { mkdirSync(d, { recursive: true }) } catch { /* 忽略 */ }
  return d
}

/** 把过期轮次压成「当天选了哪些」，再删掉缓存 */
export function archiveOldPicks({ cfg, home, log = () => {} }) {
  const root = picksRoot(cfg, home)
  const days = Math.max(7, Number(cfg.cacheDays) || 30)
  if (!existsSync(root)) return { archived: 0, days }
  const cutoff = Date.now() - days * day
  let archived = 0
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name === 'history') continue
    const p = join(root, e.name)
    const slug = e.name.endsWith('.html') ? e.name.slice(0, -5) : e.name
    let t = 0
    try { t = statSync(p).mtimeMs } catch { continue }
    if (t >= cutoff) continue

    // 先留一条极简记录：这一轮他选中了哪些
    try {
      const cf = candidatesFile(cfg, home, slug)
      const data = existsSync(cf) ? JSON.parse(readFileSync(cf, 'utf8').replace(/^\uFEFF/, '')) : null
      if (data) {
        const picked = (data.items || [])
          .filter((x) => x.status === 'saved')
          .map((x) => ({ id: x.id, title: x.title, artist: x.artist, url: x.url }))
        const rec = {
          round: slug,
          archivedAt: new Date().toISOString(),
          keptFor: `${days} 天`,
          picked,
          stagedCount: (data.items || []).length,
          note: '只保留「当天选了哪些」；候选缓存（缩略图/理由/标签）已按策略清除',
        }
        writeFileSync(join(histDir(root), `${slug}.json`), JSON.stringify(rec, null, 2), 'utf8')
        archived += 1
      }
    } catch (err) {
      log(`归档 ${slug} 失败：${err?.message ?? err}`)
    }

    try { rmSync(p, { recursive: true, force: true }) } catch { /* 忽略 */ }
    try {
      const rd = roundDir(cfg, home, slug)
      if (rd !== p && existsSync(rd)) rmSync(rd, { recursive: true, force: true })
    } catch { /* 忽略 */ }
    log(`缓存过期（>${days} 天），已压成记录并清掉：${slug}`)
  }
  return { archived, days }
}

/** 引用的历史轮次（面板「往期」用） */
export function listPicksHistory({ cfg, home, limit = 30 }) {
  const d = join(picksRoot(cfg, home), 'history')
  if (!existsSync(d)) return []
  const out = []
  for (const f of readdirSync(d)) {
    if (!f.endsWith('.json')) continue
    try {
      const r = JSON.parse(readFileSync(join(d, f), 'utf8'))
      out.push({ round: r.round, archivedAt: r.archivedAt, picked: (r.picked || []).length, staged: r.stagedCount })
    } catch { /* 忽略坏文件 */ }
  }
  return out.sort((a, b) => String(b.round).localeCompare(String(a.round))).slice(0, limit)
}

/**
 * 被删作品的记录过期：manifest 里「磁盘上已经没有」且记录超过 N 天的行清掉。
 * 清了之后就真的没依据恢复了 —— 这正是使用者要的边界。
 */
export function expireDeleteRecords({ cfg, home, log = () => {} }) {
  const days = Math.max(30, Number(cfg.deleteRecordDays) || 90)
  const cutoff = Date.now() - days * day
  const rows = readManifest(home)
  if (!rows.length) return { kept: 0, dropped: 0, days }
  const { allwork, manifest } = libPaths(cfg, home)
  const onDisk = new Set()
  const idsOnDisk = new Set()
  try {
    for (const e of readdirSync(allwork, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      onDisk.add(e.name)
      const m = /_(\d+)$/.exec(e.name)
      if (m) idsOnDisk.add(Number(m[1]))
    }
  } catch { /* 库还没建 */ }

  const keep = []
  let dropped = 0
  for (const r of rows) {
    const present = onDisk.has(r.name) || (r.id && (idsOnDisk.has(Number(r.id)) || onDisk.has(r.name)))
    const at = Date.parse(r.at || r.savedAt || 0) || 0
    if (!present && at && at < cutoff) {
      dropped += 1
      continue
    }
    keep.push(r)
  }
  if (dropped) {
    try {
      writeFileSync(manifest, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''), 'utf8')
      log(`删掉 ${dropped} 条过期删除记录（>${days} 天），这些作品以后无法按台账恢复`)
    } catch (e) {
      log(`清理删除记录失败：${e?.message ?? e}`)
    }
  }
  return { kept: keep.length, dropped, days }
}

export function runRetention({ cfg, home, log = () => {} }) {
  let a = { archived: 0 }
  let b = { dropped: 0 }
  try { a = archiveOldPicks({ cfg, home, log }) } catch (e) { log(`归档失败：${e?.message ?? e}`) }
  try { b = expireDeleteRecords({ cfg, home, log }) } catch (e) { log(`删除记录清理失败：${e?.message ?? e}`) }
  return { archived: a.archived, droppedRecords: b.dropped, cacheDays: a.days ?? cfg.cacheDays, recordDays: b.days ?? cfg.deleteRecordDays }
}
