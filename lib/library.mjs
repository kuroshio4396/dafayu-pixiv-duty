/**
 * 作品库布局（用户 2026-10-30 定的规矩）
 *
 *   <saveRoot>/allwork/<{artistId}_{title}_{id}>/      ← 真身，只有点头的作品才会出现在这里
 *   <saveRoot>/终末地/<同名>/                           ← 快捷方式（Windows junction）
 *   <saveRoot>/绝区零/<同名>/
 *
 * 缓存目录（cache/）永远不参与这套布局。标签文件夹跟着配置里的 mirrorTags 动态增删，
 * 一个作品命中几个标签就放几份快捷方式。
 */
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, renameSync, rmSync, statSync, symlinkSync, cpSync, writeFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { resolveSaveRoot } from './config.mjs'

export const ALLWORK = 'all_works'
const BAD = /[<>:"/\\|?*\u0000-\u001f]/g
const TOKENS = ['artistId', 'artist', 'title', 'id', 'kind', 'rating', 'year']

/** 文件名里的非法字符换成 _，收尾去点和空格（Windows 不允许） */
export function safeName(s, max = 120) {
  const out = String(s ?? '').replace(BAD, '_').replace(/\s*_\s*/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '')
  return out.slice(0, max) || 'untitled'
}

const KIND_CN = { illust: '插画', manga: '漫画', novel: '小说' }

/** 按 workTemplate 渲染作品目录名，默认 {artistId}_{title}_{id} */
export function renderWorkName(cfg, detail = {}) {
  const map = {
    artistId: detail.artist?.id ?? detail.artistId ?? '0',
    artist: detail.artist?.name ?? '',
    title: detail.title ?? '',
    id: detail.id ?? '',
    kind: KIND_CN[detail.kind] ?? '插画',
    rating: detail.rating === 'all' ? 'all' : 'r18',
    year: String(detail.created ?? detail.createDate ?? '').slice(0, 4),
  }
  const tpl = cfg?.workTemplate || '{artistId}_{title}_{id}'
  const filled = String(tpl).replace(/\{(\w+)\}/g, (m, k) => (TOKENS.includes(k) ? String(map[k] ?? '') : m))
  const name = safeName(filled, 120)
  // 模板坏了也不允许出现没 id 的名字：兜底拼上 id
  return String(detail.id) && !name.includes(String(detail.id)) ? safeName(`${name}_${detail.id}`, 120) : name
}

/** 作品命中哪些「标签文件夹」：标签原文或中文译文任一处包含即算 */
export function matchMirrorTags(cfg, tags = []) {
  const want = (cfg?.mirrorTags ?? []).filter(Boolean)
  if (!want.length) return []
  const hay = []
  for (const t of tags) {
    if (!t) continue
    if (typeof t === 'string') hay.push(t.toLowerCase())
    else {
      if (t.name) hay.push(String(t.name).toLowerCase())
      if (t.translated) hay.push(String(t.translated).toLowerCase())
    }
  }
  const hit = []
  for (const w of want) {
    const wl = String(w).toLowerCase()
    if (hay.some((h) => h.includes(wl))) hit.push(w)
  }
  return [...new Set(hit)]
}

export function libPaths(cfg, home) {
  const libRoot = resolveSaveRoot(cfg, home)
  return {
    libRoot,
    allwork: join(libRoot, ALLWORK),
    manifest: join(home, 'library-manifest.jsonl'),
  }
}

/** 造快捷方式：能建 junction 就 junction（双击即进目录，不占空间） */
function linkWork(workDir, linkPath) {
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    if (existsSync(linkPath) || isLink(linkPath)) {
      const st = safeLstat(linkPath)
      if (st && st.isSymbolicLink()) {
        const target = readLinkTarget(linkPath)
        if (target === workDir) return 'exists'
        rmSync(linkPath, { force: true, recursive: false })
      } else {
        return 'occupied' // 是真目录/文件，不碰用户的东西
      }
    }
    symlinkSync(workDir, linkPath, 'junction')
    return 'created'
  } catch (e) {
    return `error:${e?.code || e?.message || e}`
  }
}

function isLink(p) {
  try { return lstatSync(p).isSymbolicLink() } catch { return false }
}
function safeLstat(p) { try { return lstatSync(p) } catch { return null } }
function readLinkTarget(p) {
  try {
    const t = readlinkSync(p)
    return String(t).replace(/^\\\\\?\\/, '')
  } catch { return null }
}

/** 给一件作品铺所有标签快捷方式；返回创建的标签列表 */
export function syncMirrors({ libRoot, name, tags = [], workDir }) {
  const made = []
  const problems = []
  for (const tag of tags) {
    const dir = join(libRoot, tag)
    mkdirSync(dir, { recursive: true })
    const r = linkWork(workDir, join(dir, name))
    if (r === 'created' || r === 'exists') made.push(tag)
    else problems.push(`${tag}: ${r}`)
  }
  return { made, problems }
}

/** 台账（append-only）：谁、什么时候、命中哪些标签存进来的 */
export function appendManifest(home, entry) {
  const { manifest } = libPaths({ saveRoot: '' }, home)
  try {
    mkdirSync(dirname(manifest), { recursive: true })
    appendFileSync(manifest, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
    return true
  } catch { return false }
}

export function readManifest(home) {
  const { manifest } = libPaths({ saveRoot: '' }, home)
  if (!existsSync(manifest)) return []
  const rows = []
  for (const line of readFileSync(manifest, 'utf8').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { rows.push(JSON.parse(s)) } catch { /* 半行忽略 */ }
  }
  return rows
}

/** 每件作品的最新状态（同 id 以最后一行为准） */
export function manifestIndex(home) {
  const map = new Map()
  for (const r of readManifest(home)) {
    if (r?.id) map.set(`${r.kind || 'illust'}:${r.id}`, r)
  }
  return map
}

/** 磁盘上的作品（allwork 下一层目录 = 一件作品），元数据能读就读 */
function scanWorks(allwork) {
  const out = []
  let list = []
  try { list = readdirSync(allwork, { withFileTypes: true }) } catch { return out }
  for (const e of list) {
    if (!e.isDirectory() && !isLink(join(allwork, e.name))) continue
    const dir = join(allwork, e.name)
    let meta = null
    try {
      for (const f of readdirSync(dir)) {
        if (f.startsWith('metadata') && f.endsWith('.json')) {
          try { meta = JSON.parse(readFileSync(join(dir, f), 'utf8')) } catch { /* 半截文件 */ }
          break
        }
      }
    } catch { /* ignore */ }
    out.push({ name: e.name, dir, meta })
  }
  return out
}

/** 这件作品「应该」在哪些标签文件夹里有快捷方式（元数据 + 台账合并判断） */
function expectedTags(cfg, work, manifestRow) {
  const tags = new Set()
  for (const t of matchMirrorTags(cfg, work.meta?.tags ?? [])) tags.add(t)
  for (const t of manifestRow?.tags ?? []) tags.add(t)
  const allowed = new Set((cfg?.mirrorTags ?? []).filter(Boolean))
  return [...tags].filter((t) => allowed.has(t))
}

/**
 * 开跑前的体检：根目录、allwork、台账、快捷方式。
 * 以磁盘为准（allwork 里有目录就是作品），以台账为「应该有什么」的依据。
 * 只读，不动任何东西。
 */
export function auditLibrary({ cfg, home }) {
  const { libRoot, allwork } = libPaths(cfg, home)
  const issues = []
  const tags = (cfg?.mirrorTags ?? []).filter(Boolean)
  const idx = manifestIndex(home)

  if (!existsSync(libRoot)) issues.push({ code: 'NO_ROOT', msg: `作品库根目录不存在：${libRoot}` })
  if (!existsSync(allwork)) issues.push({ code: 'NO_ALLWORK', msg: `缺少 allwork 目录：${allwork}` })

  const works = scanWorks(allwork)
  const seen = new Set()
  for (const w of works) {
    for (const r of idx.values()) if (r.name === w.name) seen.add(`${r.kind || 'illust'}:${r.id}`)
    if (!w.meta) issues.push({ code: 'NO_META', msg: `${w.name} 缺 metadata（可能是写盘中断）` })
  }

  // 台账有、磁盘没有 ⇒ 可恢复的缺失
  const missing = []
  for (const [key, r] of idx) {
    if (seen.has(key)) continue
    const dir = r.name ? join(allwork, r.name) : null
    if (!dir || !existsSync(dir)) missing.push({ key, id: r.id, kind: r.kind, name: r.name })
  }
  if (missing.length) issues.push({ code: 'MISSING_WORK', msg: `${missing.length} 件作品在台账里但磁盘上没了（可恢复）` })

  // 快捷方式：该在的不在（目标可能整个没了），以及标签文件夹本身
  const broken = []
  for (const tag of tags) {
    const dir = join(libRoot, tag)
    if (!existsSync(dir)) { issues.push({ code: 'NO_TAG_DIR', msg: `标签文件夹不存在：${tag}（可自修）` }); continue }
    for (const w of works) {
      if (!expectedTags(cfg, w, idx.get(Object.keys(idx).find((k) => idx.get(k).name === w.name))).includes(tag)) continue
      const p = join(dir, w.name)
      if (!existsSync(p)) broken.push({ tag, name: w.name, why: 'missing' })
      else if (!isLink(p)) broken.push({ tag, name: w.name, why: 'occupied' })
    }
  }
  if (broken.length) issues.push({ code: 'BROKEN_LINK', msg: `${broken.length} 个快捷方式缺失或指向不对（可自修）` })

  return {
    ok: issues.length === 0,
    libRoot,
    allwork,
    tags,
    works: works.length,
    missing,
    broken,
    issues,
  }
}

/**
 * 修复：建好目录、清掉死链、按标签把该补的快捷方式补回来；
 * 台账里缺的作品列在 needRestore 里（重下由调用方决定，不擅自删台账）。
 */
export function repairLibrary({ cfg, home, keepMissing = true }) {
  const { libRoot, allwork } = libPaths(cfg, home)
  const tags = (cfg?.mirrorTags ?? []).filter(Boolean)
  mkdirSync(allwork, { recursive: true })
  const repaired = []
  const removed = []

  // 1) 标签文件夹一定先建出来（用户改了 mirrorTags 也要跟上）
  for (const tag of tags) {
    try { mkdirSync(join(libRoot, tag), { recursive: true }) } catch { /* ignore */ }
  }

  // 2) 清死链 / 清已经不对应任何作品的链接
  const works = scanWorks(allwork)
  const names = new Set(works.map((w) => w.name))
  for (const tag of tags) {
    const dir = join(libRoot, tag)
    let list = []
    try { list = readdirSync(dir) } catch { continue }
    for (const ent of list) {
      const p = join(dir, ent)
      if (!names.has(ent) || !existsSync(p)) {
        try {
          if (isLink(p) || !existsSync(p)) { rmSync(p, { force: true, recursive: true }); removed.push(`${tag}/${ent}`) }
        } catch { /* ignore */ }
      }
    }
  }

  // 3) 按磁盘上的作品补齐快捷方式
  const idx = manifestIndex(home)
  for (const w of works) {
    const row = [...idx.values()].find((r) => r.name === w.name)
    const want = expectedTags(cfg, w, row)
    const { made } = syncMirrors({ libRoot, name: w.name, tags: want, workDir: w.dir })
    for (const t of made) if (!(row?.tags ?? []).includes(t) || removed.some((x) => x === `${t}/${w.name}`)) repaired.push(`${t}/${w.name}`)
  }

  // 4) 台账有、磁盘没有 ⇒ 交给调用方决定恢复
  const needRestore = []
  const seen = new Set(works.map((w) => w.name))
  for (const r of idx.values()) if (!seen.has(r.name)) needRestore.push(r)

  const issues = []
  if (!keepMissing && needRestore.length) issues.push(...needRestore.map((r) => ({ code: 'MISSING_WORK', id: r.id, name: r.name })))

  return { ok: issues.length === 0, removed, repaired, needRestore, issues }
}

/**
 * 把「已经下载好、放在暂存区」的作品目录搬进作品库正规位置：
 *   <saveRoot>/allwork/<name>/  + 各标签快捷方式 + 台账。
 * 用于：老轮次未经点头就落盘的作品、以及 pending → 点头。
 */
/**
 * 把作品目录里的页文件改成「作品命名方式」：
 *   单页 → {workName}.jpg　　多页 → {workName}_p01.jpg
 * 同时改写 metadata.files[].name，别让台账和磁盘对不上。
 * 老库里遗留的 001.png 就是这样被统一过来的。
 */
export function normalizePageFiles(dir, workName) {
  const metaFile = (readdirSync(dir) || []).find((f) => f.startsWith('metadata') && f.endsWith('.json'))
  let meta = null
  try { if (metaFile) meta = JSON.parse(readFileSync(join(dir, metaFile), 'utf8')) } catch { /* ignore */ }
  const name = workName || meta?.workName || dir.split(/[\\/]/).pop()
  if (!name) return { renamed: 0 }

  // 页清单：优先 metadata.files，没有就把目录里的图片按名字排序凑一份
  const list = Array.isArray(meta?.files) && meta.files.length
    ? meta.files.map((f) => ({ name: f.name, page: Number(f.page) || 0, ext: String(f.name || '').split('.').pop() }))
    : readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
        .sort().map((f, i) => ({ name: f, page: i + 1, ext: f.split('.').pop() }))

  if (!list.length) return { renamed: 0 }
  const width = Math.max(2, String(list.length).length)
  const simple = list.length <= 1
  let renamed = 0
  for (const it of list) {
    const ext = String(it.ext || 'jpg').toLowerCase()
    const stem = simple ? name : `${name}_p${String(it.page || 1).padStart(width, '0')}`
    const target = `${safeName(stem, 150)}.${ext}`
    if (!it.name || it.name === target) { if (it.name && meta) it.name = target; continue }
    const from = join(dir, it.name)
    const to = join(dir, target)
    if (!existsSync(from)) continue
    if (existsSync(to)) continue
    try { renameSync(from, to); renamed++; it.name = target } catch { /* 被占用就留着 */ }
  }
  if (meta && metaFile) {
    meta.workName = meta.workName || name
    if (Array.isArray(meta.files) && list.length === meta.files.length) {
      meta.files = meta.files.map((f, i) => ({ ...f, name: list[i]?.name || f.name }))
    }
    try { writeFileSync(join(dir, metaFile), JSON.stringify(meta, null, 2), 'utf8') } catch { /* ignore */ }
  }
  return { renamed }
}

export function importWorkDir({ cfg, home, srcDir, detail = {} }) {
  const { libRoot, allwork } = libPaths(cfg, home)
  mkdirSync(allwork, { recursive: true })
  const base = renderWorkName(cfg, detail)
  let name = base
  let dir = join(allwork, name)
  for (let i = 2; existsSync(dir) && i < 50; i++) { name = `${base}_${i}`; dir = join(allwork, name) }
  let mode = 'rename'
  try {
    renameSync(srcDir, dir)
  } catch {
    mode = 'copy'
    cpSync(srcDir, dir, { recursive: true, force: true })
    try { rmSync(srcDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  // 作品自带的 metadata 里标签最全（带中文译名），优先用它判断命中哪些标签文件夹
  let metaTags = []
  try {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('metadata') && f.endsWith('.json')) {
        const m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        if (Array.isArray(m?.tags)) metaTags = m.tags
        break
      }
    }
  } catch { /* 没元数据就用调用方给的 */ }
  const tags = matchMirrorTags(cfg, metaTags.length ? metaTags : (detail.tags ?? []))
  const allTags = metaTags.length ? metaTags : (detail.tags ?? [])
  try { normalizePageFiles(dir, name) } catch { /* 改名失败不影响入库 */ }
  const linked = syncMirrors({ libRoot, name, tags, workDir: dir })
  appendManifest(home, {
    id: Number(detail.id), kind: detail.kind || 'illust', name,
    tags: linked.made, round: detail.round || '', artist: detail.artist?.name ?? detail.artist ?? '',
    title: detail.title ?? '', imported: true,
    tagNames: allTags.map((t) => (typeof t === 'string' ? t : t?.name)).filter(Boolean).slice(0, 20),
  })
  return { dir, name, tags: linked.made, problems: linked.problems, mode }
}

/** 换保存位置：整棵树搬过去，然后重建快捷方式（junction 存的是绝对路径） */export function moveLibrary({ from, to }) {
  if (!from || !to) throw new Error('缺少 from/to')
  if (from === to) return { moved: false, entries: 0 }
  if (!existsSync(from)) { mkdirSync(to, { recursive: true }); return { moved: false, entries: 0, note: '旧目录不存在，已直接建新目录' } }
  mkdirSync(dirname(to), { recursive: true })
  let entries = 0
  if (!existsSync(to)) {
    try {
      renameSync(from, to)
      entries = readdirSync(to).length
      return { moved: true, entries, mode: 'rename' }
    } catch { /* 跨盘：退化到复制 */ }
  } else {
    mkdirSync(to, { recursive: true })
  }
  for (const ent of readdirSync(from)) {
    const src = join(from, ent)
    const dst = join(to, ent)
    try {
      if (!existsSync(dst)) { renameSync(src, dst); entries++ }
      else { cpSync(src, dst, { recursive: true, force: true }); entries++ }
    } catch { /* ignore */ }
  }
  try { rmSync(from, { recursive: true, force: true }) } catch { /* 留给人手动清 */ }
  return { moved: true, entries, mode: 'copy' }
}

/** 目录树大小（给体检报告用） */
export function treeSize(dir) {
  let n = 0
  const walk = (d) => {
    let list = []
    try { list = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of list) {
      const p = join(d, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) n += statSync(p).size
      } catch { /* ignore */ }
    }
  }
  walk(dir)
  return n
}
