/**
 * lib/seen.mjs —— 判重台账（JSONL，append-only）
 * ============================================================================
 * 为什么不用一份 markdown 表（参考实现那样）：报告是给人看的，台账是给程序用的。
 * 两份混在一起时，模型一旦改了口径（写错标题行、漏写一段），额度就会算错。
 * 这里用一行一个 JSON，坏行跳过，额度只认 `action === 'saved'`。
 * ============================================================================
 */
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dayKey } from './state.mjs'

export function ledgerFile(stateDir) { return join(stateDir, 'ledger.jsonl') }

export function keyOf(kind, id) { return `${kind}:${id}` }

/** 追加一条（失败不抛：台账丢了不该让一整轮崩掉，但调用方要记日志） */
export function appendEntry(stateDir, entry) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    day: dayKey(),
    ...entry,
  })
  try { appendFileSync(ledgerFile(stateDir), line + '\n', 'utf8'); return true } catch { return false }
}

/** 读全部条目，坏行直接忽略 */
export function readAll(stateDir) {
  const f = ledgerFile(stateDir)
  if (!existsSync(f)) return []
  let text = ''
  try { text = readFileSync(f, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try {
      const v = JSON.parse(s)
      if (v && v.id !== undefined && v.kind) out.push(v)
    } catch { /* 坏行跳过 */ }
  }
  return out
}

/** `kind:id` → 最近一条 */
export function latestIndex(entries) {
  const map = new Map()
  for (const e of entries) map.set(keyOf(e.kind, e.id), e)
  return map
}

/**
 * 批量判重。
 * 返回的 known 包含：
 *   · 已经保存过的（action=saved，永久 known）
 *   · `revisitDays` 内被跳过的（action=skipped，冷却期内 known）
 */
export function lookup(stateDir, items, revisitDays = 14) {
  const entries = readAll(stateDir)
  const idx = latestIndex(entries)
  const cutoff = Date.now() - revisitDays * 864e5
  const known = []
  const unknown = []
  for (const it of items) {
    const id = Number(it.id ?? it)
    const kinds = it.kind ? [it.kind] : ['illust', 'manga', 'novel']
    let hit = null
    for (const k of kinds) {
      const e = idx.get(keyOf(k, id))
      if (e) { hit = e; break }
    }
    if (hit && (hit.action === 'saved' || new Date(hit.at).getTime() >= cutoff)) {
      known.push({
        id: hit.id, kind: hit.kind, action: hit.action,
        savedAt: hit.at, dir: hit.dir ?? null, title: hit.title ?? null,
        reason: hit.reason ?? null,
      })
    } else {
      unknown.push(id)
    }
  }
  return { known, unknown }
}

/**
 * 「这一件在以前任何一轮里出现过吗」——不设期限。
 * 只要台账里有过它的任何状态（staged / pending / saved / skipped / dropped），
 * 新的一轮就不许再摆它：每轮的图应该完全不重复，翻来覆去摆同一批是噪音。
 */
export function seenEver(stateDir) {
  const set = new Set()
  for (const e of readAll(stateDir)) set.add(keyOf(e.kind, e.id))
  return set
}

/** 今天已经存了几件（额度只认这个）
 * 只算「每个作品最新状态 = saved」的行：后来被标成 pending / skipped 的撤回去；
 * 纯搬运（quota:false，暂存区 → library）不再算一次下载。
 */
export function savedOn(stateDir, day = dayKey()) {
  let n = 0
  for (const e of latestIndex(readAll(stateDir)).values()) {
    if (e.action === 'saved' && e.quota !== false && String(e.day) === String(day)) n++
  }
  return n
}

export function savedTotal(stateDir) {
  return readAll(stateDir).filter((e) => e.action === 'saved').length
}

/** 同一张图（sha256）是否已经被别的作品存过 —— 判转载用 */
export function findBySha(stateDir, sha) {
  if (!sha) return null
  return readAll(stateDir).find((e) => e.action === 'saved' && e.sha256 === sha) ?? null
}

/** 导出人类可读的 seen.md（面板"最近台账"用；不是真相源） */
export function exportMarkdown(stateDir, limit = 200) {
  const rows = readAll(stateDir).slice(-limit).reverse()
  const lines = ['# Pixiv 台账（最近 ' + rows.length + ' 条）', '']
  for (const r of rows) {
    const flag = r.action === 'saved' ? '已存' : r.action === 'skipped' ? '跳过' : '失败'
    lines.push(`- ${r.at?.slice(0, 16) ?? ''} · ${r.kind}:${r.id} · ${flag} · ${r.title ?? ''}${r.reason ? `（${r.reason}）` : ''}`)
  }
  const text = lines.join('\n') + '\n'
  try { writeFileSync(join(stateDir, 'seen.md'), text, 'utf8') } catch { /* 忽略 */ }
  return text
}
