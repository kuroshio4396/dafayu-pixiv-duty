/**
 * lib/picks.mjs —— 「候选预览页」：每轮自动出一页，等使用者点头
 * ============================================================================
 * 为什么要有这一层（2026-10-30 使用者拍板的三条规矩）：
 *   ① 他没有点头的作品，原图**不许**落进 library（预览只缓存缩略图）；
 *   ② 每轮的报告必须是网页预览模式：缩略图可点、直达 Pixiv 作品页；
 *   ③ 报告只讲「为什么给你看 / 亮点」，不复述"捞到了什么"。
 *
 * 于是探索轮只做两件事：把候选写进 candidates.json、把这一页渲染出来。
 * 原图要等他在这边点头之后，由 `pixiv_approve` 走正式的 pixiv_save 老路。
 *
 * 目录结构（都在工作区里，不碰 library）：
 *   <workspace>/picks/<round>/candidates.json
 *   <workspace>/picks/<round>/thumbs/<id>.jpg
 *   <workspace>/picks/<round>.html        ← 人看的那一页（相对路径引 thumbs，file:// 直接能开）
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceDirOf } from './workspace.mjs'
import { readJson, writeJsonAtomic } from './state.mjs'

export const PICKS_SCHEMA = 2

export function picksRoot(cfg, home) {
  return join(workspaceDirOf(cfg, home), 'picks')
}

export function roundSlug(roundId) {
  return String(roundId || 'manual').replace(/[^\w.-]+/g, '-').slice(0, 80)
}

export function roundDir(cfg, home, roundId) {
  return join(picksRoot(cfg, home), roundSlug(roundId))
}

export function candidatesFile(cfg, home, roundId) {
  return join(roundDir(cfg, home, roundId), 'candidates.json')
}

export function thumbsDir(cfg, home, roundId) {
  return join(roundDir(cfg, home, roundId), 'thumbs')
}

export function pageFile(cfg, home, roundId) {
  return join(picksRoot(cfg, home), `${roundSlug(roundId)}.html`)
}

/** 读一轮的候选（没有就返回空壳，调用方不用判空） */
export function loadCandidates(cfg, home, roundId) {
  const empty = { schema: PICKS_SCHEMA, round: String(roundId || ''), createdAt: null, note: '', items: [] }
  const f = candidatesFile(cfg, home, roundId)
  if (!existsSync(f)) return empty
  const v = readJson(f, null)
  if (!v || !Array.isArray(v.items)) return empty
  return { ...empty, ...v }
}

export function saveCandidates(cfg, home, roundId, data) {
  const f = candidatesFile(cfg, home, roundId)
  mkdirSync(join(f, '..'), { recursive: true })
  writeJsonAtomic(f, { ...data, schema: PICKS_SCHEMA, round: String(roundId || ''), updatedAt: new Date().toISOString() })
  return f
}

/** 最近一个出过页的轮次（pixiv_approve 没给 round 时用它） */
export function latestRound(cfg, home) {
  const dir = picksRoot(cfg, home)
  if (!existsSync(dir)) return null
  let best = null
  for (const e of readdirSync(dir)) {
    if (!/\.html$/i.test(e)) continue
    const p = join(dir, e)
    let t = 0
    try { t = statSync(p).mtimeMs } catch { continue }
    if (!best || t > best.t) best = { t, round: e.replace(/\.html$/i, '') }
  }
  return best?.round ?? null
}

/* ───────────────────────────── 渲染 ───────────────────────────── */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;')

const KIND_CN = { illust: '插画', manga: '漫画', novel: '小说' }

function tagsOf(item) {
  const list = Array.isArray(item.tags) ? item.tags : []
  return list.filter(Boolean).slice(0, 9)
}

function cardHtml(item, i, base = '') {
  const id = Number(item.id)
  const url = item.url || (item.kind === 'novel'
    ? `https://www.pixiv.net/novel/show.php?id=${id}`
    : `https://www.pixiv.net/artworks/${id}`)
  const cover = item.cover ? `<img loading="lazy" src="${esc(base + item.cover)}" alt="${esc(item.title)}" onerror="this.closest('.cov').classList.add('nocover')">` : ''
  const status = item.status || 'candidate'
  const statusNote = status === 'pending'
    ? '<span class="st pending">已下到暂存区 · 等你点头</span>'
    : status === 'saved' ? '<span class="st saved">已收进作品库</span>'
    : status === 'dropped' ? '<span class="st dropped">没点头 · 已清出</span>' : ''
  const rating = item.rating === 'r18' ? '<span class="rate">R-18</span>' : ''
  const kind = KIND_CN[item.kind] || item.kind || ''
  const tags = tagsOf(item).map((t) => `<span class="tag">${esc(t)}</span>`).join('')
  const why = String(item.why || '').trim()
  const followed = item.followedAuthor ? '<span class="follow">仅来自已关注作者</span>' : ''
  const meta = [
    item.artist ? esc(item.artist) : '',
    id ? `#${id}` : '',
    kind,
    Number(item.bookmarks) ? `收藏 ${Number(item.bookmarks)}` : '',
    Number(item.pages) > 1 ? `${Number(item.pages)}P` : '',
  ].filter(Boolean).join(' · ')
  return `<article class="card${status === 'saved' ? ' done' : ''}${item.followedAuthor ? ' glow' : ''}" data-id="${id}" data-i="${i}" data-status="${esc(status)}">
  <div class="cov"><a href="${esc(url)}" target="_blank" rel="noreferrer">${cover}</a>${rating}${followed}${statusNote}</div>
  <div class="body">
    <a class="t" href="${esc(url)}" target="_blank" rel="noreferrer">${esc(item.title || '(无题)')}</a>
    <div class="a">${meta}</div>
    ${tags ? `<div class="tags">${tags}</div>` : ''}
    ${why ? `<p class="why"><b>为什么给你看</b>${esc(why)}</p>` : ''}
    <div class="foot">
      <a class="go" href="${esc(url)}" target="_blank" rel="noreferrer">去 Pixiv 看原图 ↗</a>
    </div>
  </div>
</article>`
}

export function renderPage({ roundId, note = '', items = [], title = '', atText = '', base = '' }) {
  const groups = new Map()
  for (const it of items) {
    const g = String(it.group || '').trim() || '候选'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g).push(it)
  }
  const sections = [...groups.entries()].map(([name, list]) => `<h2>${esc(name)} <span class="n">${list.length} 件</span></h2>
<div class="grid">
${list.map((it) => cardHtml(it, items.indexOf(it) + 1, base)).join('\n')}
</div>`).join('\n')

  const r18 = items.filter((x) => x.rating === 'r18').length
  const dateText = atText || new Date().toLocaleString('zh-CN', { hour12: false })
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title || `Pixiv 候选 · ${dateText}`)}</title><style>
*{box-sizing:border-box}
body{margin:0;padding:26px 22px 92px;background:#12121a;color:#e8e6f0;font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:22px;margin:0 0 6px}
.sub{color:#8d89a8;font-size:13px;margin-bottom:14px}
.gate{background:#221c33;border:1px solid #3d2f63;border-radius:12px;padding:10px 14px;margin:0 0 20px;font-size:13px;color:#cfc7ee}
.gate b{color:#b9a6ff}
h2{font-size:16px;margin:32px 0 10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
h2 .n{font-size:12px;color:#8d89a8;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
.card{background:#1a1826;border:1px solid #272338;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:.15s}
.card:hover{border-color:#423a63}
.card.done{opacity:.62}
.card.glow{position:relative;isolation:isolate}
.card.glow:before{content:"";position:absolute;inset:-6px;border-radius:18px;background:radial-gradient(60% 60% at 50% 0%,rgba(244,114,182,.55),rgba(244,114,182,0) 72%);filter:blur(7px);z-index:-1;pointer-events:none}
.follow{position:absolute;top:8px;right:8px;background:#f472b6;color:#2a0716;font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px}
.cov{position:relative;background:#221f30}
.cov img{width:100%;height:250px;object-fit:cover;display:block}
.cov.nocover img{display:none}
.cov.nocover:after{content:"（封面没拉到，点标题去 Pixiv 看）";display:flex;align-items:center;justify-content:center;height:250px;color:#6f6a88;font-size:12px;padding:0 16px;text-align:center}
.rate{position:absolute;top:8px;left:8px;background:#7a1f3d;color:#ffd9e3;font-size:11px;padding:2px 7px;border-radius:999px}
.st{position:absolute;bottom:8px;left:8px;right:8px;font-size:11px;padding:3px 8px;border-radius:8px;background:#000a;color:#d9d3ff;text-align:center}
.st.pending{background:#3a2a12cc;color:#ffd9a0}
.st.saved{background:#14301fcc;color:#a9e6bd}
.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:5px;flex:1}
.t{font-size:13.5px;color:#f2efff;text-decoration:none;line-height:1.35;display:block}
.t:hover{color:#a99cff}
.a{color:#8f89ad;font-size:11.5px}
.tags{display:flex;flex-wrap:wrap;gap:4px}
.tag{font-size:10.5px;color:#b3a8dd;background:#241f36;border:1px solid #342c50;border-radius:6px;padding:1px 6px}
.why{font-size:12.5px;color:#d5cfe8;background:#1f1b2c;border-left:3px solid #6c53c8;border-radius:0 8px 8px 0;margin:4px 0 0;padding:6px 9px;line-height:1.55}
.why b{display:block;color:#9f8de8;font-size:11px;font-weight:600;letter-spacing:.5px;margin-bottom:2px}
.foot{margin-top:auto;padding-top:8px;display:flex;align-items:center;gap:8px}
.go{font-size:12px;color:#8f7ee0;text-decoration:none;white-space:nowrap}
footer{color:#5f5a76;font-size:11.5px;margin-top:36px;line-height:1.7}
</style></head><body>
<h1>${esc(title || `Pixiv 候选 · ${dateText}`)}</h1>
<div class="sub">${esc(roundId)} · 共 ${items.length} 件${r18 ? ` · 其中 R-18 ${r18} 件` : ''} · 点缩略图或标题直达 Pixiv 作品页</div>
<div class="gate"><b>这一页只放了缩略图 —— 原图一张都还没下。</b>
挑图和下载可以交给选装的 DSH 画廊（那边负责评分、标星、点头落盘）；没装也不影响本插件，入库时直接跟大肥鱼说编号就行。这一页只负责给你看画面和理由。</div>
${note ? `<div class="sub">${esc(note)}</div>` : ''}
${sections || '<p class="sub">这一轮没有候选。</p>'}
<footer>缩略图只用于预览，原图一张都没下 · 候选清单：<code>picks/${esc(roundSlug(roundId))}/candidates.json</code></footer>
</body></html>`
}

/** 把一轮的候选渲染成页（candidates.json 是真相源，页是视图） */
export function writeRoundPage({ cfg, home, roundId, note } = {}) {
  const data = loadCandidates(cfg, home, roundId)
  if (typeof note === 'string' && note.trim()) data.note = note.trim()
  const page = pageFile(cfg, home, roundId)
  mkdirSync(join(page, '..'), { recursive: true })
  const html = renderPage({
    roundId,
    note: data.note || '',
    items: data.items,
    base: `${roundSlug(roundId)}/`,
    atText: data.createdAt ? new Date(data.createdAt).toLocaleString('zh-CN', { hour12: false }) : '',
  })
  writeFileSync(page, html, 'utf8')
  return { page, count: data.items.length, candidates: candidatesFile(cfg, home, roundId) }
}

/** 清掉 N 天前的 picks 目录（只删 html/thumbs，不动 library） */
export function prunePicks(cfg, home, days = 21) {
  const root = picksRoot(cfg, home)
  if (!existsSync(root) || days <= 0) return 0
  const cutoff = Date.now() - days * 864e5
  let n = 0
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, e.name)
      let t = 0
      try { t = statSync(p).mtimeMs } catch { continue }
      if (t < cutoff) { try { rmSync(p, { recursive: true, force: true }); n++ } catch { /* 忽略 */ } }
    }
  } catch { /* 忽略 */ }
  return n
}

/** 缩略图命名：thumbs/<id>.jpg（candidates 里 cover 存相对路径） */
export function thumbRel(id) { return `thumbs/${Number(id)}.jpg` }
