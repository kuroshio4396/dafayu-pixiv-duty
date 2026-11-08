/**
 * lib/save.mjs —— 落盘：命名、目录模板、原子提交、metadata
 * ============================================================================
 * 这里是**唯一**会往用户目录写东西的地方（工具 `pixiv_save` 调它）。
 * 为什么不让 agent 自己 write：
 *   · 它的 `write` 被 sandbox 限制在 workspaceRoot（= 插件家目录），写不到用户指定的盘；
 *   · 命名清洗 / 路径长度 / Windows 保留名 / 同名合并，模型做不可靠；
 *   · `metadata.json` 必须机器生成、并且**最后写**（它就是这次保存的提交标记）。
 * ============================================================================
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, statfsSync, rmSync, readdirSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { ALLWORK, renderWorkName, matchMirrorTags, syncMirrors, appendManifest } from './library.mjs'
import { join, dirname, basename, resolve, sep } from 'node:path'

/** kind → 目录名（用户看到的分类） */
export const KIND_DIR = { illust: '插画', manga: '漫画', novel: '小说' }

const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`COM${n}`, `LPT${n}`]),
])

/** 单个路径段清洗（Windows 规则 + 跨平台保守处理） */
export function sanitizeSegment(input, maxLen = 77) {
  let s = String(input ?? '')
  s = s.replace(/[<>:"/\\|?*]/g, '_')
  s = s.replace(/[\u0000-\u001f\u007f]/g, '')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/[. ]+$/g, '')                 // Windows 会静默去掉结尾的点和空格
  if (!s) s = 'untitled'
  const stem = s.split('.')[0].toUpperCase()
  if (RESERVED.has(stem)) s = `_${s}`
  const chars = [...s]
  if (chars.length > maxLen) s = chars.slice(0, maxLen - 1).join('') + '…'
  return s
}

/** 模板占位符 */
export function renderDir(template, { kind, title, artist, id, rating, year }) {
  const vals = {
    kind: KIND_DIR[kind] ?? kind,
    artist: artist || 'unknown',
    title: title || 'untitled',
    id: String(id),
    rating: rating || 'all',
    year: year || '',
  }
  const parts = String(template || '{kind}/{artist}/{title}_{id}')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => sanitizeSegment(p.replace(/\{(\w+)\}/g, (_, k) => vals[k] ?? '')))
  return parts.join(sep)
}

/** 剩余空间（字节）；拿不到返回 null */
export function freeBytes(path) {
  try {
    const st = statfsSync(path)
    return Number(st.bavail) * Number(st.bsize)
  } catch { return null }
}

/** 目录可写探针：不存在就试着建，然后写一个 0 字节文件再删 */
export function probeDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.pixiv-duty-probe-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return { ok: true, free: freeBytes(dir) }
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) }
  }
}

function sha256Of(buf) { return createHash('sha256').update(buf).digest('hex') }

/** 原子写一个文件：写 `.part` → rename */
function writeAtomic(dest, buf) {
  const tmp = join(dirname(dest), `.${basename(dest)}.part-${process.pid}`)
  writeFileSync(tmp, buf)
  renameSync(tmp, dest)
}

/** 已有目录里是否已经有同一件作品（读 metadata） */
function readMeta(dir) {
  const f = metaFileIn(dir)
  if (!f) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

/**
 * 作品目录里的 metadata 文件名。
 * 用户要求：用**搜索关键词**命名，一眼看出这件是从哪个词下挖到的。
 *   `metadata.初音ミク.json` / 没有关键词时回退 `metadata.json`
 */
export function metaNameFor(keyword) {
  const k = String(keyword || '').trim()
  if (!k) return 'metadata.json'
  return `metadata.${sanitizeSegment(k, 40)}.json`
}

/** 找目录里现成的 metadata（兼容旧名与关键词命名） */
export function metaFileIn(dir) {
  try {
    const name = readdirSync(dir).find((n) => /^metadata(\..+)?\.json$/.test(n))
    return name ? join(dir, name) : null
  } catch { return null }
}

function metaMatches(meta, id) { return meta && Number(meta.id) === Number(id) }

/** 找到最终目录：模板路径冲突时依次退让 */
function pickDir(root, rel, id) {
  let target = join(root, rel)
  for (let i = 0; i < 20; i++) {
    if (!existsSync(target)) return target
    const meta = readMeta(target)
    if (metaMatches(meta, id)) return target           // 同 id：合并
    if (!meta) {
      // 有目录没 metadata ⇒ 上次没提交完，清掉 .part 后重写
      try {
        for (const f of readdirSync(target)) {
          if (f.includes('.part-')) rmSync(join(target, f), { force: true })
        }
      } catch { /* 忽略 */ }
      return target
    }
    target = join(root, `${rel}_v${i + 2}`)
  }
  return join(root, `${rel}_v${Date.now()}`)
}

/** 超长路径：缩短最后一段（保留 `_id`） */
function fitPath(dir, id) {
  if (dir.length <= 240) return dir
  const parent = dirname(dir)
  const last = basename(dir)
  const suffix = `_${id}`
  const keep = Math.max(8, 240 - parent.length - suffix.length - 1)
  return join(parent, [...last].slice(0, keep).join('') + suffix)
}

/** 小说正文 → markdown */
export function novelMarkdown(detail, novel) {
  const picked = novel.blocks ?? novel.excerptBlocks ?? []
  const fm = [
    '---',
    `pixiv_id: ${detail.id}`,
    `title: ${JSON.stringify(detail.title ?? '')}`,
    `author: ${JSON.stringify(detail.artist?.name ?? '')}`,
    `url: ${detail.url}`,
    `language: ${novel.language ?? 'unknown'}`,
    `rating: ${detail.rating ?? 'all'}`,
    `saved_at: ${new Date().toISOString()}`,
    `mode: ${novel.mode}`,
  ]
  if (novel.mode === 'excerpt') {
    fm.push(`excerpt_blocks: ${picked.slice(0, 1)}-${picked.slice(-1)}`)
    fm.push(`total_blocks: ${novel.totalBlocks}`)
    fm.push(`excerpt_chars: ${novel.chars}`)
    fm.push(`total_chars: ${novel.totalChars}`)
  } else {
    fm.push(`chars: ${novel.chars}`)
    fm.push(`blocks: ${novel.totalBlocks}`)
  }
  fm.push('---', '')

  const head = [`# ${detail.title ?? `novel ${detail.id}`}`, '',
    `作者：${detail.artist?.name ?? '未知'} ｜ 原文：${detail.url}`, '']

  if (novel.mode === 'full') {
    return [...fm, ...head, novel.text.trim(), ''].join('\n')
  }

  const lines = [...fm, ...head,
    '> 以下为节选，保留原作段落顺序与段落编号；省略处已标注。', '']
  let cursor = 0
  const picks = [...picked].sort((a, b) => a - b)
  for (const b of picks) {
    if (b > cursor) lines.push(`> ……（省略第 ${cursor + 1}–${b} 段，共 ${b - cursor} 段）……`, '')
    const text = novel.blockText?.[b] ?? ''
    lines.push(`<!-- pixiv:block ${b} -->`, text.trim(), `<!-- /pixiv:block -->`, '')
    cursor = b + 1
  }
  if (cursor < novel.totalBlocks) {
    lines.push(`> ……（省略第 ${cursor + 1}–${novel.totalBlocks} 段，共 ${novel.totalBlocks - cursor} 段）……`, '')
  }
  return lines.join('\n')
}

/**
 * 保存一件作品。
 * @param {object} o
 * @param {string} o.root        保存根目录（绝对路径）
 * @param {object} o.cfg         生效配置
 * @param {string} o.round       本轮 id
 * @param {object} o.detail      px_detail 的完整元数据
 * @param {Array}  o.files       [{ path, page, w, h }] 本地缓存文件
 * @param {object} o.decision    { score, reason, matchedTags }
 * @param {object} [o.novel]     小说：{ mode, text, language, chars, totalChars, totalBlocks, excerptBlocks, blockText }
 */
export function saveWork({ root, home = '', cfg, round, detail, files = [], decision = {}, novel = null, keyword = '' }) {
  const kind = detail.kind === 'novel' ? 'novel' : (detail.kind === 'manga' ? 'manga' : 'illust')
  const rating = detail.rating ?? 'all'
  const year = String(detail.created ?? '').slice(0, 4)

  // 新布局（2026-10-30）：<saveRoot>/allwork/{artistId}_{title}_{id}/
  const name = renderWorkName(cfg, detail)
  const baseDir = join(root, ALLWORK, name)
  const dir = fitPath(pickDir(root, join(ALLWORK, name), detail.id), detail.id)

  const prev = readMeta(dir)
  const existed = metaMatches(prev, detail.id)
  mkdirSync(dir, { recursive: true })

  const written = []
  const warnings = []

  if (kind === 'novel' && novel) {
    const name = `${sanitizeSegment(detail.title || `novel_${detail.id}`, 60)}.md`
    const buf = Buffer.from(novelMarkdown(detail, novel), 'utf8')
    writeAtomic(join(dir, name), buf)
    written.push({ name, page: 1, bytes: buf.length, width: null, height: null, sha256: sha256Of(buf) })
  } else {
    const width = Math.max(2, String(files.length).length)
    const simple = files.length <= 1
    for (const f of files) {
      const page = Number(f.page ?? written.length + 1)
      const ext = String(f.ext || 'jpg').toLowerCase().replace(/^\./, '')
      // 文件名也按「作品命名方式」来：单页 {name}.jpg，多页 {name}_p01.jpg
      const stem = simple ? name : `${name}_p${String(page).padStart(width, '0')}`
      const fname = `${sanitizeSegment(stem, 150) || stem}.${ext}`
      try {
        const buf = readFileSync(f.path)
        writeAtomic(join(dir, fname), buf)
        written.push({ name: fname, page, bytes: buf.length, width: f.w ?? null, height: f.h ?? null, sha256: sha256Of(buf) })
      } catch (e) {
        warnings.push(`第 ${page} 页写入失败：${e?.message ?? e}`)
      }
    }
    if (!written.length) throw new Error('没有任何一页写入成功')
  }

  const totalBytes = written.reduce((n, f) => n + f.bytes, 0)
  const mirrorTags = matchMirrorTags(cfg, detail.tags ?? [])
  const meta = {
    schema: 1,
    source: 'pixiv',
    kind,
    id: Number(detail.id),
    title: detail.title ?? '',
    pageTitle: detail.pageTitle ?? detail.title ?? '',
    url: detail.url,
    artist: detail.artist ?? { id: null, name: '', account: '' },
    tags: detail.tags ?? [],
    rating,
    xRestrict: detail.xRestrict ?? 0,
    sanityLevel: detail.sanity ?? null,
    pageCount: kind === 'novel' ? null : detail.pages ?? written.length,
    width: detail.w ?? null,
    height: detail.h ?? null,
    createDate: detail.created ?? null,
    bookmarks: detail.bookmarks ?? null,
    views: detail.views ?? null,
    description: String(detail.caption ?? '').slice(0, 2000),
    savedAt: existed ? (prev.savedAt ?? new Date().toISOString()) : new Date().toISOString(),
    updatedAt: existed ? new Date().toISOString() : null,
    savedBy: { plugin: 'dsh-pixiv-scroll', version: '1.1.4', round },
    workName: name,
    mirrors: mirrorTags,
    files: written,
    decision: {
      score: Number(decision.score ?? 0),
      matchedTags: Array.isArray(decision.matchedTags) ? decision.matchedTags : [],
      reason: String(decision.reason ?? '').slice(0, 500),
    },
    keyword: keyword || null,
    novel: novel
      ? {
          mode: novel.mode,
          chars: novel.chars ?? null,
          totalChars: novel.totalChars ?? null,
          blocks: novel.mode === 'excerpt' ? (novel.blocks ?? novel.excerptBlocks ?? null) : null,
          totalBlocks: novel.totalBlocks ?? null,
          vibe: novel.vibe ?? null,
        }
      : null,
    licenseNote: '仅个人收藏，请勿二次分发',
    warnings,
  }

  // 标签快捷方式：真身在 allwork，标签文件夹里只放 junction（指向真身）
  const linked = syncMirrors({ libRoot: root, name, tags: mirrorTags, workDir: dir })
  if (linked.problems.length) warnings.push(...linked.problems.map((s) => `快捷方式失败：${s}`))
  meta.mirrors = linked.made

  // metadata **最后写**：有它就是"这次保存已提交"
  // 文件名用搜索关键词（用户要求），合并时沿用旧文件，避免一个目录两份 metadata
  const prevMetaFile = metaFileIn(dir)
  const metaFile = prevMetaFile || join(dir, metaNameFor(keyword || (meta.tags?.[0]?.name ?? '')))
  writeAtomic(metaFile, Buffer.from(JSON.stringify(meta, null, 2), 'utf8'))

  // 台账：误删之后靠它知道「本来有什么、在哪个标签下」
  if (home) {
    appendManifest(home, {
      id: Number(detail.id), kind, name,
      tags: linked.made, bytes: totalBytes, pages: written.length, round,
      artist: detail.artist?.name ?? '', title: detail.title ?? '',
    })
  }

  return {
    ok: true,
    dir,
    name,
    mirrors: linked.made,
    files: written.map((f) => f.name),
    metadata: metaFile,
    keyword: keyword || null,
    bytes: totalBytes,
    pageCount: kind === 'novel' ? 1 : written.length,
    merged: existed,
    warnings,
    sha256: written[0]?.sha256 ?? null,
  }
}

/** 收尾校验：目录、metadata、文件是否都在 */
export function verifySaved(dir) {
  const problems = []
  const meta = readMeta(dir)
  if (!meta) return { ok: false, problems: ['metadata.json 缺失或损坏'] }
  for (const f of meta.files ?? []) {
    const p = join(dir, f.name)
    if (!existsSync(p)) { problems.push(`缺文件：${f.name}`); continue }
    try {
      const st = statSync(p)
      if (st.size !== f.bytes) problems.push(`${f.name} 大小不符（${st.size} ≠ ${f.bytes}）`)
      if (st.size === 0) problems.push(`${f.name} 是空文件`)
    } catch (e) { problems.push(`${f.name} 读取失败：${e?.message ?? e}`) }
  }
  return { ok: problems.length === 0, problems }
}

/** 估一件作品要占多少字节（磁盘预检用） */
export function estimateBytes(detail, pageCount) {
  const w = Number(detail?.w ?? 1200)
  const h = Number(detail?.h ?? 1700)
  return Math.max(1, Math.round(w * h * 0.35)) * Math.max(1, pageCount)
}

/** 把一个相对目录钉死在 root 里（防 `..` 逃逸） */
export function assertInside(root, dir) {
  const r = resolve(root)
  const d = resolve(dir)
  return d === r || d.startsWith(r + sep)
}
