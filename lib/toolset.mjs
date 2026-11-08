/**
 * lib/toolset.mjs —— 12 个 DSH 工具：策略闸门都在这里
 * ============================================================================
 * 分工：
 *   Python MCP  = 网络 + 字节（登录、搜索、详情、下载、正文、校验）
 *   这一层      = 命名、目录、额度、分级、去重、metadata、报告
 *
 * 为什么额度/分级/去重必须在工具里拦：提示词只能"告诉"模型怎么做。
 * 一旦作品简介里写了"忽略之前的设定"，模型可能被带走 —— 但 `pixiv_save` 仍然会拒。
 * ============================================================================
 */
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync, renameSync,
  rmSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { McpClient } from './mcp.mjs'
import { loadCfg, resolveSaveRoot } from './config.mjs'
import { auditLibrary, repairLibrary, importWorkDir, treeSize, renderWorkName, matchMirrorTags } from './library.mjs'
import { dayKey, readJson, writeJson, appendLog } from './state.mjs'
import { lookup, appendEntry, savedOn, seenEver } from './seen.mjs'
import { getFollowing, judgePush } from './following.mjs'
import { saveWork, probeDir, freeBytes, estimateBytes, verifySaved } from './save.mjs'
import {
  loadCandidates, saveCandidates, writeRoundPage, latestRound,
  thumbsDir, thumbRel, pageFile,
} from './picks.mjs'

const MCP_TOOLS = ['px_auth', 'px_search', 'px_detail', 'px_fetch', 'px_novel', 'px_tags', 'px_verify', 'px_following']

/** 白名单随轮次下发；没写就全给 */
function mcpEnv(home, cfg, allow = MCP_TOOLS) {
  const env = {
    PIXIV_DUTY_HOME: home,
    PIXIV_CREDENTIAL_FILE: join(home, 'credential.json'),
    PIXIV_CACHE_DIR: join(home, 'cache'),
    PIXIV_MCP_TOOLS: allow.join(','),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  }
  // 代理：这台机器上 Pixiv 直连不通，必须走本地代理。
  // ⚠️ requests 读的是环境里**最后出现**的那个键，且大小写都认 ——
  //    父进程里的小写 https_proxy（沙箱那条，对 pixiv 返 502）会把大写覆盖掉，
  //    所以四个键一起写。
  const proxy = String(cfg?.proxyUrl || '').trim()
  if (proxy) {
    env.HTTP_PROXY = proxy; env.http_proxy = proxy
    env.HTTPS_PROXY = proxy; env.https_proxy = proxy
    env.ALL_PROXY = proxy; env.all_proxy = proxy
    env.NO_PROXY = '127.0.0.1,localhost'; env.no_proxy = '127.0.0.1,localhost'
  } else {
    // 不要继承沙箱那条对 pixiv 返 502 的代理
    env.HTTP_PROXY = ''; env.http_proxy = ''
    env.HTTPS_PROXY = ''; env.https_proxy = ''
    env.ALL_PROXY = ''; env.all_proxy = ''
  }
  return env
}

const safe = (v) => JSON.parse(JSON.stringify(v))

/** 存好一件后自动打开它的文件夹（失败不抛：这只是便利功能） */
function openFolder(dir) {
  try {
    if (process.platform === 'win32') spawn('explorer', [dir], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    else if (process.platform === 'darwin') spawn('open', [dir], { detached: true, stdio: 'ignore' }).unref()
    else spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref()
    return true
  } catch { return false }
}

class ToolError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 一轮的计数器（落盘，进程重启也不丢；**按 roundId 隔离**） */
function roundState(home) {
  const f = join(home, 'state.json')
  const st = readJson(f, {})
  return { file: f, st }
}

/** 换了轮次就把计数清零 —— 否则上一轮用掉的预算会一直压着这一轮 */
function ensureRound(st, roundId) {
  if (!st.round || st.round.id !== roundId) {
    st.round = { id: roundId, startedAt: new Date().toISOString(), counters: {} }
  }
  if (!st.round.counters) st.round.counters = {}
  return st.round
}

function bumpCounter(home, field, by = 1, roundId = 'manual') {
  const { file, st } = roundState(home)
  const round = ensureRound(st, roundId)
  round.counters[field] = Number(round.counters[field] || 0) + by
  st.round = round
  try { writeJson(file, st) } catch { /* 忽略 */ }
  return round.counters[field]
}

function counterOf(home, field, roundId = 'manual') {
  const { st } = roundState(home)
  if (st.round?.id !== roundId) return 0
  return Number(st.round?.counters?.[field] || 0)
}

/** 中文判定：language → 汉字占比 → 标签 */
export function judgeChinese(detail, sampleText, cfg) {
  const mode = cfg.zhMode
  if (mode === 'off') return { zh: true, why: '未启用中文判定' }
  const tags = (detail.tags || []).map((t) => `${t.name} ${t.translated || ''}`.toLowerCase())
  const tagHit = tags.find((t) => /中文|中国语|中国語|漢化|汉化|翻译|翻譯|简体|繁體|繁体/.test(t))
  if (mode === 'tag') return tagHit ? { zh: true, why: `标签命中：${tagHit}` } : { zh: false, why: '标签里没有中文标记' }
  if (detail.language === 'zh') return { zh: true, why: 'language=zh' }
  if (mode === 'language') return { zh: false, why: `language=${detail.language || 'unknown'}` }

  const text = String(sampleText || '')
  const han = (text.match(/[\u4e00-\u9fff]/g) || []).length
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length
  const ratio = text.length ? han / text.length : 0
  if (kana / Math.max(1, text.length) > 0.05) return { zh: false, why: `假名占比 ${(kana / text.length * 100).toFixed(1)}%` }
  if (ratio >= cfg.zhRatio) return { zh: true, why: `汉字占比 ${(ratio * 100).toFixed(0)}%` }
  if (mode === 'auto' && tagHit) return { zh: true, why: `标签命中：${tagHit}` }
  return { zh: false, why: `汉字占比仅 ${(ratio * 100).toFixed(0)}%（阈值 ${(cfg.zhRatio * 100).toFixed(0)}%）` }
}

/** 偏好打分（只用于报告与排序，不做硬过滤） */
export function scoreItem(item, cfg) {
  const weights = new Map()
  for (const line of String(cfg.tagWeights || '').split(/\r?\n/)) {
    const m = /^(.+?)\s*[=:：]\s*(-?\d+(?:\.\d+)?)$/.exec(line.trim())
    if (m) weights.set(m[1].trim().toLowerCase(), Number(m[2]))
  }
  const tags = (item.tags || []).map((t) => `${t.name}`.toLowerCase())
  let score = 0
  const matched = []
  for (const [tag, w] of weights) {
    if (tags.some((t) => t.includes(tag))) { score += w; matched.push(tag) }
  }
  for (const kw of cfg.keywords) {
    const k = kw.toLowerCase()
    if (tags.some((t) => t.includes(k))) { score += 1; matched.push(kw) }
  }
  if (Number(item.bookmarks) > 1000) score += 0.5
  return { score, matched }
}

/** 硬过滤：内容类型 / 分级 / 必须标签 / 排除标签 / 收藏数区间 */
function filterItems(items, cfg) {
  const out = []
  const dropped = []
  const req = cfg.requiredTags.map((s) => s.toLowerCase())
  const exc = cfg.excludeTags.map((s) => s.toLowerCase())
  for (const it of items) {
    const tags = (it.tags || []).map((t) => `${t.name} ${t.translated || ''}`.toLowerCase())
    if (it.kind === 'illust' && !cfg.contentIllust) { dropped.push({ id: it.id, why: 'content:illust' }); continue }
    if (it.kind === 'manga' && !cfg.contentManga) { dropped.push({ id: it.id, why: 'content:manga' }); continue }
    if (it.kind === 'novel' && !cfg.contentNovel) { dropped.push({ id: it.id, why: 'content:novel' }); continue }
    if (!cfg.allowR18 && it.rating !== 'all') { dropped.push({ id: it.id, why: 'r18' }); continue }
    if (req.length && !req.every((t) => tags.some((x) => x.includes(t)))) { dropped.push({ id: it.id, why: 'required-tags' }); continue }
    if (exc.length && exc.some((t) => tags.some((x) => x.includes(t)))) { dropped.push({ id: it.id, why: 'excluded-tag' }); continue }
    const bm = Number(it.bookmarks ?? 0)
    if (cfg.bookmarkMin > 0 && bm < cfg.bookmarkMin) { dropped.push({ id: it.id, why: 'bookmark-min' }); continue }
    if (cfg.bookmarkMax > 0 && bm > cfg.bookmarkMax) { dropped.push({ id: it.id, why: 'bookmark-max' }); continue }
    out.push(it)
  }
  return { out, dropped }
}

/**
 * 创建工具集。
 * @param {object} o
 * @param {object} o.ctx          DSH 上下文（只需 tools）
 * @param {Function} o.defineTool 宿主的 defineTool（或本地等价实现）
 * @param {string} o.home         插件家目录
 * @param {string} o.roundId      本轮 id（host 手动调用时可为 'manual'）
 * @param {object} o.log          日志函数
 */
export function createToolset({ ctx, defineTool, home, roundId = 'manual', log = () => {} }) {
  // 交互会话（使用者就坐在对面，能当场点头）才允许直接落盘；
  // 自动轮/探索轮一律只能 stage 到预览页。
  const interactive = roundId === 'host' || roundId === 'manual'
  let client = null
  let cfgCache = null
  let cfgAt = 0

  const freshCfg = () => {
    if (!cfgCache || Date.now() - cfgAt > 3000) {
      cfgCache = loadCfg(home)
      cfgAt = Date.now()
    }
    return cfgCache
  }

  const invalidateCfg = () => { cfgCache = null }

  function ensureMcp() {
    const cfg = freshCfg()
    const py = cfg.pythonPath || 'python'
    // 解释器换过（比如 settings 从空值填成 venv）但旧客户端还攥着上一条命令时，
    // 必须重建 —— 否则会拿着已经作废的命令反复 spawn，永远起不来。
    if (client && client.cfg?.command !== py) {
      try { client.stop() } catch { /* 已退出 */ }
      client = null
    }
    if (client) return client
    const args = [join(home, 'mcp_server.py')]
    client = new McpClient({
      command: py,
      args,
      cwd: home,
      env: mcpEnv(home, cfg),
      log: (m) => log(`[mcp] ${m}`),
    })
    return client
  }

  async function callPx(name, args = {}, timeoutMs = 180000) {
    let c = ensureMcp()
    let res
    try {
      res = await c.call(name, args, { timeoutMs })
    } catch (e) {
      // 进程级失败（spawn 失败 / 子进程退出）→ 丢掉这个客户端重起一次，业务错误照常抛
      if (/子进程退出|ENOENT|spawn/i.test(String(e?.message || ''))) {
        try { c.stop() } catch { /* 已退出 */ }
        client = null
        res = await ensureMcp().call(name, args, { timeoutMs })
      } else {
        throw e
      }
    }
    if (res && typeof res === 'object' && res.ok === false) {
      throw new ToolError(res.code || 'MCP_FAILED', res.message || 'MCP 调用失败')
    }
    return res
  }

  function stop() {
    try { client?.stop() } catch { /* 已退出 */ }
    client = null
  }

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) }],
  }

  const reg = (spec) => ctx.tools.register(defineTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters || {},
    output: spec.output || textOutput,
    timeoutMs: spec.timeoutMs ?? 240000,
    async execute(args, exec) {
      try {
        return safe(await spec.execute(args || {}, exec))
      } catch (e) {
        const code = e?.code || 'UNKNOWN'
        log(`工具 ${spec.name} 失败：${code} ${e?.message || e}`)
        return safe({ ok: false, code, message: String(e?.message || e).slice(0, 500) })
      }
    },
  }))

  /* ───────────────────────── pixiv_status ───────────────────────── */
  reg({
    name: 'pixiv_status',
    description: '一轮开场总览：登录态、额度、保存目录、环境、本轮预算。先调这个。',
    parameters: {},
    async execute() {
      const cfg = freshCfg()
      const root = resolveSaveRoot(cfg, home)
      let auth = { state: 'none' }
      let mcpReady = false
      try {
        auth = await callPx('px_auth', { action: 'status' }, 60000)
        mcpReady = true
      } catch (e) {
        auth = { state: 'error', message: String(e?.message || e).slice(0, 200) }
      }
      const probe = probeDir(root)
      const used = savedOn(home)
      const { st } = roundState(home)
      return {
        ok: true,
        version: '0.1.0',
        auth: {
          state: auth.state, loggedIn: auth.state === 'ok',
          userId: auth.userId ?? null, pixivId: cfg.pixivId || auth.pixivId || null,
        },
        env: {
          mcpReady, python: cfg.pythonPath,
          saveRoot: root, saveRootWritable: probe.ok, freeGB: probe.free ? +(probe.free / 1e9).toFixed(1) : null,
          error: probe.ok ? null : probe.error,
        },
        today: { saved: used, quota: cfg.perDay, left: Math.max(0, cfg.perDay - used) },
        round: {
          id: roundId,
          startedAt: st.round?.id === roundId ? st.round.startedAt : null,
          counters: st.round?.id === roundId ? (st.round.counters || {}) : {},
          unfinished: st.unfinished ?? null,
        },
        config: {
          content: [cfg.contentIllust && 'illust', cfg.contentManga && 'manga', cfg.contentNovel && 'novel'].filter(Boolean),
          allowR18: cfg.allowR18,
          keywords: cfg.keywords,
          requiredTags: cfg.requiredTags,
          excludeTags: cfg.excludeTags,
          bookmarkRange: { min: cfg.bookmarkMin, max: cfg.bookmarkMax },
          days: cfg.daysOn ? cfg.days : 0,
          daysEnabled: cfg.daysOn,
          novelMode: cfg.novelMode,
          novelVibe: cfg.novelVibe || null,
          novelVibeMin: cfg.novelVibeMin,
          zhMode: cfg.zhMode,
          dirTemplate: cfg.dirTemplate,
          openAfterSave: cfg.openAfterSave,
        },
        limits: {
          perRound: Math.min(cfg.perRound, Math.max(0, cfg.perDay - used)),
          maxCandidates: cfg.maxCandidates,
          maxImages: cfg.maxImages,
          maxPagesPerWork: cfg.maxPagesPerWork,
        },
        paths: {
          home,
          cache: join(home, 'cache'),
          ledger: join(home, 'ledger.jsonl'),
          report: join(home, 'out', `${dayKey()}.md`),
        },
      }
    },
  })

  /* ───────────────────────── pixiv_login_status ───────────────────────── */
  reg({
    name: 'pixiv_login_status',
    description: '查登录态（会尝试刷新一次 token）。返回 state / userId / expiresInMin。',
    parameters: {},
    async execute() {
      const r = await callPx('px_auth', { action: 'status' }, 60000)
      return { ok: true, ...r }
    },
  })

  /* ───────────────────────── pixiv_search ───────────────────────── */
  reg({
    name: 'pixiv_search',
    description: '批量搜索（1–3 个查询一次返回，返回紧凑元数据，不含图片 URL）。自动按内容类型/分级/必须标签/排除标签/收藏数过滤。',
    parameters: {
      queries: { type: 'array', required: true, items: { type: 'string' }, description: '1–3 个搜索词（标签用空格表示 AND）' },
      kind: { type: 'string', enum: ['illust', 'manga', 'novel', 'all'], description: '内容类型，默认 all' },
      days: { type: 'number', description: '只看最近几天，默认取配置' },
      limit: { type: 'number', description: '每个查询最多几条，默认 20' },
      sort: { type: 'string', enum: ['date_desc', 'date_asc', 'popular_desc'], description: '排序' },
    },
    async execute({ queries, kind = 'all', days, limit = 20, sort = 'date_desc' }) {
      const cfg = freshCfg()
      const qs = (Array.isArray(queries) ? queries : [queries]).filter(Boolean).slice(0, 3)
      if (!qs.length) return { ok: false, code: 'BAD_REQUEST', message: 'queries 不能为空' }
      const used = counterOf(home, 'candidates', roundId)
      const budget = Math.max(0, cfg.maxCandidates - used)
      if (budget <= 0) return { ok: false, code: 'BUDGET', message: '本轮的候选元数据预算用完了' }
      const res = await callPx('px_search', {
        queries: qs.join('||'),
        kind,
        // 时间窗关掉时传 0 ⇒ MCP 不带任何日期参数（不限发布时间）
        days: cfg.daysOn ? Number(days ?? cfg.days) : 0,
        limit: Math.min(30, Math.max(1, Number(limit))),
        sort,
      })
      const { out, dropped } = filterItems(res.items || [], cfg)
      bumpCounter(home, 'candidates', out.length, roundId)
      return {
        ok: true,
        cached: Boolean(res.cached),
        items: out.slice(0, budget).map((it) => ({
          ...it,
          score: scoreItem(it, cfg).score,
        })),
        dropped: dropped.slice(0, 40),
        byQuery: res.byQuery ?? [],
        note: out.length ? undefined : '这一批没有通过过滤的；换关键词，或放宽 minBookmarks',
      }
    },
  })

  /* ───────────────────────── pixiv_inspect ───────────────────────── */
  reg({
    name: 'pixiv_inspect',
    description: '批量作品详情（≤12 个 id）。返回完整元数据、是否已存、评分线索；不含图片 URL。kind=novel 时只查小说库（插画/小说 id 会撞号）',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'number' }, description: '作品 id 列表（≤12）' },
      kind: { type: 'string', enum: ['auto', 'novel', 'illust'], description: '按哪个命名空间查；默认 auto（先插画后小说）' },
    },
    async execute({ ids, kind = 'auto' }) {
      const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite).slice(0, 12)
      if (!arr.length) return { ok: false, code: 'BAD_REQUEST', message: 'ids 不能为空' }
      const res = await callPx('px_detail', { ids: arr.join(','), kind })
      const cfg = freshCfg()
      const known = lookup(home, res.items || [], cfg.revisitDays)
      const saved = new Map(known.known.map((k) => [`${k.kind}:${k.id}`, k]))
      const items = (res.items || []).map((it) => {
        const hit = saved.get(`${it.kind}:${it.id}`) || saved.get(`illust:${it.id}`) || saved.get(`manga:${it.id}`)
        const { _pageUrls, ...rest } = it
        return {
          ...rest,
          score: scoreItem(it, cfg).score,
          saved: hit ? { saved: hit.action === 'saved', dir: hit.dir, at: hit.savedAt } : { saved: false },
        }
      })
      return { ok: true, items, errors: res.errors ?? [] }
    },
  })

  /* ───────────────────────── pixiv_prepare ───────────────────────── */
  reg({
    name: 'pixiv_prepare',
    description: '把缩图下到本地缓存并返回路径（供 read_image 读）。每件默认取封面+前 2 页；受 maxImages 预算约束。',
    parameters: {
      items: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'number', required: true },
            pages: { type: 'array', items: { type: 'number' } },
          },
        },
        description: '最多 3 件；pages 省略则取前 3 页',
      },
      maxEdge: { type: 'number', description: '缩图长边上限，默认 1536' },
    },
    async execute({ items, maxEdge = 1536 }) {
      const cfg = freshCfg()
      const list = (Array.isArray(items) ? items : []).slice(0, 3)
      if (!list.length) return { ok: false, code: 'BAD_REQUEST', message: 'items 不能为空' }
      const imgs = counterOf(home, 'images', roundId)
      const budget = Math.max(0, cfg.maxImages - imgs)
      if (budget <= 0) return { ok: false, code: 'BUDGET', message: `本轮读图预算（${cfg.maxImages} 张）用完了` }
      const trimmed = list.map((it) => ({
        id: Number(it.id),
        pages: Array.isArray(it.pages) ? it.pages.slice(0, Math.min(3, budget)) : undefined,
      }))
      const res = await callPx('px_fetch', {
        items: JSON.stringify(trimmed),
        variant: 'view',
        maxEdge: Math.min(2048, Math.max(512, Number(maxEdge))),
        defaultPages: Math.min(3, budget),
      })
      let n = 0
      for (const it of res.items || []) n += (it.files || []).length
      bumpCounter(home, 'images', n, roundId)
      return { ok: true, items: res.items || [], usedImages: imgs + n, maxImages: cfg.maxImages }
    },
  })

  /* ───────────────────────── 小说三件套 ───────────────────────── */
  reg({
    name: 'pixiv_novel_outline',
    description: '小说骨架：字数、段落数、章节、语言、开头 800 字。判断要不要读、读哪儿。',
    parameters: { id: { type: 'number', required: true, description: '小说 id' } },
    async execute({ id }) {
      const res = await callPx('px_novel', { id: Number(id), action: 'outline' }, 120000)
      const detail = await callPx('px_detail', { ids: String(id) }, 60000).catch(() => ({ items: [] }))
      const meta = detail.items?.[0] || {}
      const zh = judgeChinese(meta, res.head, freshCfg())
      return { ...res, chinese: zh }
    },
  })

  reg({
    name: 'pixiv_novel_read',
    description: '按段落读正文：fromBlock 起读 blocks 段（≤60）。用来补选段的上下文。',
    parameters: {
      id: { type: 'number', required: true },
      fromBlock: { type: 'number', description: '起始段落序号，默认 0' },
      blocks: { type: 'number', description: '读多少段，默认 20，最多 60' },
    },
    async execute({ id, fromBlock = 0, blocks = 20 }) {
      return callPx('px_novel', {
        id: Number(id), action: 'read',
        fromBlock: Number(fromBlock), blocks: Math.min(60, Number(blocks)),
      }, 120000)
    },
  })

  reg({
    name: 'pixiv_novel_pick',
    description: '按关键词挑最相关段落（返回段落序号、命中词、正文）。长篇选段就用它。',
    parameters: {
      id: { type: 'number', required: true },
      terms: { type: 'array', required: true, items: { type: 'string' }, description: '相关性关键词（来自用户偏好/标签）' },
      blocks: { type: 'number', description: '最多几段，默认 6' },
      context: { type: 'number', description: '每段带前后几段，默认 0' },
    },
    async execute({ id, terms, blocks = 6, context = 0 }) {
      return callPx('px_novel', {
        id: Number(id), action: 'pick',
        terms: (terms || []).join(','),
        blocks: Math.min(20, Number(blocks)),
        context: Math.min(3, Number(context)),
      }, 120000)
    },
  })

  /* ───────────────────────── pixiv_novel_vibe ───────────────────────── */
  reg({
    name: 'pixiv_novel_vibe',
    description: '按「小说正文模糊偏好」比对正文：返回匹配度（0–1）、命中的词片与最相关段落。保存前想确认合不合口味就用它。',
    parameters: {
      id: { type: 'number', required: true, description: '小说 id' },
      vibe: { type: 'string', description: '自然语言场景描述；省略则用设置里的偏好' },
      blocks: { type: 'number', description: '返回几段最相关的，默认 6' },
    },
    async execute({ id, vibe, blocks = 6 }) {
      const cfg = freshCfg()
      const text = String(vibe || cfg.novelVibe || '').trim()
      if (!text) return { ok: false, code: 'NO_VIBE', message: '设置里没有填小说正文偏好' }
      const r = await callPx('px_novel', {
        id: Number(id), action: 'vibe', vibe: text, blocks: Math.min(12, Math.max(1, Number(blocks))),
      }, 180000)
      return { ...r, threshold: cfg.novelVibeMin, pass: Number(r.score ?? 0) >= cfg.novelVibeMin }
    },
  })

  /* ───────────────────────── 落盘内核 ───────────────────────── */
  /**
   * 原图落盘的唯一实现。不自己注册工具 —— 由两个入口调用：
   *   · pixiv_save    交互会话（roundId='host'：使用者就在对面，能当场点头）
   *   · pixiv_approve 探索轮攒下的候选，在他点头之后批量下载 / 从暂存区归位
   * 探索轮（headless）拿不到保存能力，见 pixiv_save 里的审批闸。
   */
  async function saveOne({ id, kind, pages, novel, decision, keyword, restore = false }) {
      const cfg = freshCfg()
      const root = resolveSaveRoot(cfg, home)

      // 1) 元数据以服务端为准（不让模型编造标题/画师/分级）
      //    ⚠️ 插画与小说是两个 id 命名空间、会撞号：调用方说 novel 就**只查小说接口**，
      //    否则同号插画会冒充小说，落盘时被 CONTENT_TYPE 拦下（29222785 就是这么炸的）。
      const wantKind = kind === 'novel' ? 'novel'
        : (kind === 'illust' || kind === 'manga') ? 'illust'
          : (cfg.contentNovel && !cfg.contentIllust && !cfg.contentManga ? 'novel' : 'auto')
      const dres = await callPx('px_detail', { ids: String(id), kind: wantKind }, 90000)
      const detail = dres.items?.[0]
      if (!detail) {
        const err = (dres.errors || [])[0] || {}
        if (err.collidesWithIllust) {
          return {
            ok: false, blocked: true, code: 'CONTENT_TYPE',
            hint: `id ${id} 在**小说**库里不存在；这个号是同号插画（插画/小说 id 会撞号）`,
          }
        }
        if (err.collidesWithNovel) {
          return {
            ok: false, blocked: true, code: 'CONTENT_TYPE',
            hint: `id ${id} 在**插画**库里不存在；这个号是同号小说，请用 kind=novel`,
          }
        }
        return { ok: false, blocked: true, code: 'NOT_FOUND', hint: '作品不存在或已删除' }
      }
      const realKind = detail.kind === 'novel' ? 'novel' : (detail.kind === 'manga' ? 'manga' : 'illust')

      // 2) 策略闸门
      if (realKind === 'illust' && !cfg.contentIllust) return { ok: false, blocked: true, code: 'CONTENT_TYPE', hint: '插画开关是关的' }
      if (realKind === 'manga' && !cfg.contentManga) return { ok: false, blocked: true, code: 'CONTENT_TYPE', hint: '漫画开关是关的' }
      if (realKind === 'novel' && !cfg.contentNovel) return { ok: false, blocked: true, code: 'CONTENT_TYPE', hint: '小说开关是关的' }
      if (realKind === 'ugoira') return { ok: false, blocked: true, code: 'UGOIRA_SKIPPED', hint: '动图不支持' }
      if (!cfg.allowR18 && detail.rating !== 'all') return { ok: false, blocked: true, code: 'R18', hint: '这件是 R-18，当前设置不收' }

      const used = savedOn(home)
      if (!restore && used >= cfg.perDay) return { ok: false, blocked: true, code: 'QUOTA', hint: `今天的额度（${cfg.perDay}）已经用完了` }
      const inRound = counterOf(home, 'saves', roundId)
      const roundLeft = Math.min(cfg.perRound, cfg.perDay - used) - inRound
      if (!restore && roundLeft <= 0) return { ok: false, blocked: true, code: 'QUOTA', hint: `本轮额度（${cfg.perRound}）用完了` }

      if (!restore) {
        const dup = lookup(home, [{ id: detail.id, kind: realKind }], cfg.revisitDays)
        if (dup.known.some((k) => k.action === 'saved')) {
          const hit = dup.known.find((k) => k.action === 'saved')
          return { ok: false, blocked: true, code: 'DUPLICATE', hint: '这件已经存过了', existing: { dir: hit.dir, savedAt: hit.savedAt } }
        }
      }

      const probe = probeDir(root)
      if (!probe.ok) return { ok: false, blocked: true, code: 'PATH_INVALID', hint: `保存目录不可写：${root}（${probe.error}）` }

      // 3) 小说：正文 + 语言判定 + 模糊偏好比对
      let novelPayload = null
      if (realKind === 'novel') {
        const mode = novel?.mode || (cfg.novelMode === 'auto' ? null : cfg.novelMode)
        const outline = await callPx('px_novel', { id: detail.id, action: 'outline' }, 180000)
        const zh = judgeChinese(detail, outline.head, cfg)
        if (!zh.zh) return { ok: false, blocked: true, code: 'NOVEL_LANG', hint: `判定不是中文小说（${zh.why}）` }

        // 「小说正文模糊偏好」：字面预筛 + 语义靠 agent 确认
        let vibe = null
        if (String(cfg.novelVibe || '').trim()) {
          const v = await callPx('px_novel', {
            id: detail.id, action: 'vibe', vibe: cfg.novelVibe, blocks: 6,
          }, 180000)
          const score = Number(v.score ?? 0)
          const approved = novel?.vibeApproved === true
          const reason = String(novel?.vibeReason || '').trim()
          if (score < cfg.novelVibeMin && !(approved && reason)) {
            return {
              ok: false, blocked: true, code: 'NOVEL_VIBE', score,
              hits: (v.hits || []).slice(0, 8),
              samples: (v.blocks || []).slice(0, 2).map((b) => ({ index: b.index, text: String(b.text || '').slice(0, 160) })),
              hint: `字面匹配度 ${score} < ${cfg.novelVibeMin}。先看 samples 判断语义是否相符：`
                + '相符就带 novel.vibeApproved=true + vibeReason 再存；不相符就跳过。',
            }
          }
          vibe = {
            score,
            hits: (v.hits || []).slice(0, 8),
            approved: score < cfg.novelVibeMin ? true : false,
            reason: score < cfg.novelVibeMin ? reason : '',
          }
        }

        const wantMode = mode || (outline.chars <= cfg.novelFullMaxChars ? 'full' : 'excerpt')
        if (wantMode === 'full') {
          const full = await callPx('px_novel', { id: detail.id, action: 'full' }, 180000)
          novelPayload = {
            mode: 'full', text: full.text, chars: full.chars, totalChars: full.chars,
            totalBlocks: full.blocks, language: full.language, vibe,
          }
        } else {
          let blocksIdx = Array.isArray(novel?.blocks) ? novel.blocks.map(Number).filter(Number.isFinite) : null
          if (!blocksIdx?.length) {
            const terms = [...cfg.requiredTags, ...cfg.keywords].slice(0, 10)
            const picked = await callPx('px_novel', {
              id: detail.id, action: 'pick', terms: terms.join(','),
              blocks: cfg.novelExcerptBlocks, context: 0,
            }, 180000)
            blocksIdx = (picked.picks || []).flatMap((p) => {
              const arr = []
              for (let i = p.fromBlock; i <= p.toBlock; i++) arr.push(i)
              return arr
            })
          }
          if (!blocksIdx?.length) {
            return { ok: false, blocked: true, code: 'NOVEL_EMPTY', hint: '选段没命中任何段落；可改 novelMode=full 或给更具体的标签' }
          }
          const all = await callPx('px_novel', { id: detail.id, action: 'blocks' }, 180000)
          const map = {}
          for (const idx of blocksIdx) {
            if (all.blocks && all.blocks[idx] !== undefined) map[idx] = all.blocks[idx]
          }
          if (!Object.keys(map).length) {
            return { ok: false, blocked: true, code: 'NOVEL_EMPTY', hint: '选段段落取不到正文' }
          }
          novelPayload = {
            mode: 'excerpt', blocks: blocksIdx, blockText: map,
            chars: Object.values(map).reduce((n, s) => n + s.length, 0),
            totalChars: outline.chars, totalBlocks: outline.blocks, language: outline.language, vibe,
          }
        }
      }

      // 4) 磁盘
      const pageCount = realKind === 'novel' ? 1 : Math.min(
        Number(pages?.length || detail.pages || 1), cfg.maxPagesPerWork,
      )
      const need = estimateBytes(detail, pageCount)
      const free = freeBytes(root)
      if (free !== null && free < need * 2 + 200 * 1024 * 1024) {
        return { ok: false, blocked: true, code: 'DISK_LOW', hint: `磁盘剩余 ${(free / 1e9).toFixed(1)}GB，不够安全落盘` }
      }

      // 5) 取图
      let files = []
      if (realKind !== 'novel') {
        let wantPages = Array.isArray(pages) && pages.length ? pages.map(Number) : null
        if (!wantPages && detail.pages > cfg.maxPagesPerWork) {
          wantPages = Array.from({ length: cfg.maxPagesPerWork }, (_, i) => i + 1)
        }
        const fres = await callPx('px_fetch', {
          items: JSON.stringify([{ id: detail.id, pages: wantPages || undefined }]),
          variant: 'original',
          defaultPages: cfg.maxPagesPerWork,
        }, 600000)
        const one = (fres.items || [])[0]
        if (!one?.ok) {
          return { ok: false, blocked: true, code: one?.code || 'IMAGE_FORBIDDEN', hint: one?.message || '图片下载失败' }
        }
        files = (one.files || []).map((f) => ({ ...f, ext: f.ext || 'jpg' }))
      }

      // 6) 写盘（metadata 最后写 = 提交标记）
      // 「metadata 用关键词命名」：优先用本轮实际命中的搜索词
      const kw = String(
        keyword || decision?.matchedTags?.[0] || cfg.keywords?.[0] || '',
      ).trim()

      const saved = saveWork({
        root, home, cfg, round: roundId, detail: { ...detail, kind: realKind },
        files,
        decision: decision || {}, novel: novelPayload,
        keyword: kw,
      })

      const check = verifySaved(saved.dir)
      if (!check.ok) {
        appendLog(home, `保存校验失败 ${saved.dir}: ${check.problems.join('; ')}`)
        return { ok: false, blocked: true, code: 'VERIFY_FAILED', hint: check.problems.join('; ') }
      }

      // 7) 台账（同事务的最后一步）
      appendEntry(home, {
        id: detail.id, kind: realKind, action: 'saved',
        round: roundId, title: detail.title, dir: saved.dir,
        rating: detail.rating, sha256: saved.sha256, keyword: kw || null,
        tags: (detail.tags || []).map((t) => t.name).slice(0, 12),
        reason: decision?.reason ?? '',
        ...(restore ? { quota: false, restored: true } : {}),
      })
      if (!restore) bumpCounter(home, 'saves', 1, roundId)

      // 8) 存好就把文件夹弹出来（用户要求：不用自己去找）
      const opened = cfg.openAfterSave ? openFolder(saved.dir) : false

      return {
        ok: true, saved: true, kind: realKind,
        dir: saved.dir, files: saved.files, metadata: saved.metadata,
        keyword: kw || null, opened,
        bytes: saved.bytes, pageCount: saved.pageCount,
        merged: saved.merged, warnings: saved.warnings,
        duplicate: null,
      }
  }

  /* ───────────────────────── pixiv_save ───────────────────────── */
  reg({
    name: 'pixiv_save',
    description: '落盘入口（仅限使用者当面的会话）。探索轮里会被 NEED_APPROVAL 拦住 —— 那时请改用 pixiv_stage。内部强制校验内容类型/分级/额度/去重/磁盘，再原子写盘并写 metadata。被拦时返回 {ok:false,blocked:true,code}，照实说、不要重试。',
    parameters: {
      id: { type: 'number', required: true },
      kind: { type: 'string', required: true, enum: ['illust', 'manga', 'novel'] },
      pages: { type: 'array', items: { type: 'number' }, description: '要保存的页码；省略 = 全部（受 maxPagesPerWork 限制）' },
      novel: {
        type: 'object', additionalProperties: false, properties: {
          mode: { type: 'string', enum: ['full', 'excerpt'], required: true },
          blocks: { type: 'array', items: { type: 'number' } },
          vibeApproved: { type: 'boolean', description: '字面匹配度低于下限、但你读过正文确认语义相符时置 true（必须同时给 vibeReason）' },
          vibeReason: { type: 'string', description: '为什么认为它和「小说正文模糊偏好」相符，会写进 metadata' },
        },
        description: '小说专用：整篇 / 选段（blocks 为段落序号）',
      },
      decision: {
        type: 'object', required: true, additionalProperties: false, properties: {
          score: { type: 'number', required: true },
          reason: { type: 'string', required: true },
          matchedTags: { type: 'array', items: { type: 'string' } },
        },
      },
      keyword: { type: 'string', description: '这件是从哪个搜索词/标签下挖到的；用来给 metadata 命名（省略则取命中标签的第一个）' },
    },
    timeoutMs: 600000,
    async execute(args) {
      // 审批闸：探索轮里没人能点头，所以**根本不给**保存能力。
      // （2026-10-30 使用者原话：我没有点头认可的图片不允许下载到我的电脑里）
      if (!interactive) {
        return {
          ok: false, blocked: true, code: 'NEED_APPROVAL',
          hint: '这一轮是探索轮，原图不能直接落盘。用 pixiv_stage 把候选摆到预览页，等他点头之后由交互会话调 pixiv_approve。',
        }
      }
      return saveOne(args || {})
    },
  })

  /* ───────────────────────── pixiv_stage ───────────────────────── */
  /**
   * 探索轮的唯一产出：校验 → 抓封面缩略图 → 写 candidates.json → 重出预览页。
   * 工具和 HTTP 共用这一份实现。
   */
  async function doStage({ items, note } = {}) {
      const cfg = freshCfg()
      const list = (Array.isArray(items) ? items : []).slice(0, 12)
      if (!list.length) return { ok: false, code: 'BAD_REQUEST', message: 'items 不能为空' }
      const rid = roundId
      const data = loadCandidates(cfg, home, rid)
      const dedup = new Map(data.items.map((x) => [`${x.kind}:${x.id}`, x]))
      const everSeen = seenEver(home)
      // 推送模式：只推已关注作者（配置改了以后下一轮才生效，所以这里直接读当前配置）
      const following = cfg.followedOnly ? await getFollowing({ home, callPx, log }) : { ids: [], ok: true }

      // 1) 服务端详情（不信任模型给的标题/画师/标签）
      const ids = [...new Set(list.map((x) => Number(x.id)).filter(Number.isFinite))]
      const dres = await callPx('px_detail', { ids: ids.join(','), kind: 'auto' }, 120000)
      const details = new Map()
      for (const d of dres.items || []) details.set(`${d.kind}:${d.id}`, d)
      const errors = dres.errors || []

      const staged = []
      const blocked = []
      for (const it of list) {
        const want = String(it.kind || '')
        const cand = (want && details.get(`${want}:${it.id}`))
          || details.get(`illust:${it.id}`) || details.get(`manga:${it.id}`) || details.get(`novel:${it.id}`)
        if (!cand) {
          blocked.push({ id: it.id, code: 'NOT_FOUND', hint: '详情里没有这件（可能已删除 / 是小说号但按插画查）' })
          continue
        }
        const realKind = cand.kind === 'novel' ? 'novel' : (cand.kind === 'manga' ? 'manga' : 'illust')
        if (realKind === 'novel' && !cfg.contentNovel) { blocked.push({ id: it.id, code: 'CONTENT_TYPE', hint: '小说开关是关的' }); continue }
        if (realKind === 'manga' && !cfg.contentManga) { blocked.push({ id: it.id, code: 'CONTENT_TYPE', hint: '漫画开关是关的' }); continue }
        if (realKind === 'illust' && !cfg.contentIllust) { blocked.push({ id: it.id, code: 'CONTENT_TYPE', hint: '插画开关是关的' }); continue }
        if (!cfg.allowR18 && cand.rating === 'r18') { blocked.push({ id: it.id, code: 'R18', hint: '这件是 R-18，当前设置不收' }); continue }

        const key = `${realKind}:${cand.id}`
        // 硬规则：以前任何一轮出现过的作品，这一轮不再摆（不是 7/14 天冷却，是永不重复）
        if (everSeen.has(key)) {
          blocked.push({ id: it.id, code: 'SEEN_BEFORE', hint: '这件在前几轮里已经出现过，每轮不重复' })
          continue
        }
        const hit = null
        const why = String(it.why || '').trim()
        if (!why) { blocked.push({ id: it.id, code: 'NO_WHY', hint: '没写「为什么给你看」——这条别塞进页里' }); continue }

        // 推送模式闸：权重和 ≥minPushWeight 且作者被关注，或权重 >mustPushWeight 必推
        const push = judgePush({
          cfg,
          tags: (cand.tags || []).flatMap((t) => [t.name, t.translated].filter(Boolean)),
          authorId: cand.artist?.id,
          following,
        })
        if (!push.ok) {
          blocked.push({ id: it.id, code: push.code, hint: push.why })
          continue
        }

        const entry = {
          id: cand.id, kind: realKind,
          title: cand.title || '', artist: cand.artist?.name || '',
          artistId: cand.artist?.id ?? null,
          url: realKind === 'novel'
            ? `https://www.pixiv.net/novel/show.php?id=${cand.id}`
            : `https://www.pixiv.net/artworks/${cand.id}`,
          tags: (cand.tags || []).map((t) => t.name).slice(0, 10),
          rating: cand.rating || 'all', pages: cand.pages ?? cand.pageCount ?? 1,
          bookmarks: cand.bookmarks ?? null, views: cand.views ?? null,
          why, group: String(it.group || '').trim(), score: Number(it.score ?? 0) || null,
          pagesWanted: Array.isArray(it.pages) && it.pages.length ? it.pages.map(Number) : null,
          status: hit ? (hit.action === 'saved' ? 'saved' : hit.action) : 'candidate',
          cover: null, at: new Date().toISOString(),
          weight: push.weight,
          followedAuthor: !!push.followed,
          pushWhy: cfg.followedOnly ? push.why : '',
        }
        dedup.set(key, entry)
        staged.push({ ...entry, _detail: cand })
      }

      // 2) 封面缩略图（view 变体，只落缓存尺寸；px_fetch 一次最多 3 件）
      const thumbFail = []
      for (let i = 0; i < staged.length; i += 3) {
        const batch = staged.slice(i, i + 3)
        try {
          const res = await callPx('px_fetch', {
            items: JSON.stringify(batch.map((s) => ({ id: s.id, pages: [1] }))),
            variant: 'view', maxEdge: 720, defaultPages: 1,
          }, 300000)
          for (const one of res.items || []) {
            const f = (one.files || [])[0]
            const target = batch.find((s) => s.id === one.id)
            if (!f?.path || !target) continue
            const dir = thumbsDir(cfg, home, rid)
            mkdirSync(dir, { recursive: true })
            const dst = join(dir, `${one.id}.jpg`)
            copyFileSync(f.path, dst)
            target.cover = thumbRel(one.id)
          }
        } catch (e) {
          for (const s of batch) thumbFail.push({ id: s.id, error: String(e?.message || e).slice(0, 120) })
        }
      }

      // 3) 落候选 + 出页
      const items2 = [...dedup.values()].map((x) => {
        const { _detail, ...rest } = x
        return rest
      })
      saveCandidates(cfg, home, rid, {
        ...data,
        createdAt: data.createdAt || new Date().toISOString(),
        note: String(note ?? data.note ?? '').trim(),
        pushMode: Boolean(cfg.followedOnly),
        items: items2,
      })
      const page = writeRoundPage({ cfg, home, roundId: rid })
      bumpCounter(home, 'staged', staged.length, rid)

      return {
        ok: true,
        round: rid,
        page: page.page,
        count: items2.length,
        added: staged.map((s) => ({ id: s.id, kind: s.kind, title: s.title, artist: s.artist, group: s.group, cover: Boolean(s.cover) })),
        blocked,
        errors,
        thumbFail,
        hint: items2.length
          ? `预览页已更新（${items2.length} 件候选）。本轮不要调 pixiv_save，写完报告就收尾 —— 原图等点头。`
          : '一件都没进页，检查 blocked 再试。',
      }
  }

  reg({
    name: 'pixiv_stage',
    description: '探索轮的唯一产出：把候选摆进预览页（缩略图 + 直达链接 + 为什么给你看），等使用者点头。校验存在/分级/开关/去重，抓封面缩略图，重写 picks/<round>.html。**不要**再调 pixiv_save。可以分多次调用累积，同一 id 覆盖。',
    parameters: {
      items: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'number', required: true },
            kind: { type: 'string', enum: ['illust', 'manga', 'novel'], description: '默认从详情推断' },
            why: { type: 'string', required: true, description: '为什么给他看：具体到画面/构图/画师/命中的xp，一两句人话。**必须**写，写不出就说明这条不该进页。' },
            group: { type: 'string', description: '页内分组名（如「萝莉」「白丝」「唯美」），省略归到「候选」' },
            score: { type: 'number', description: '你的确信程度 0–1' },
            pages: { type: 'array', items: { type: 'number' }, description: '如果点头，会下哪几页；省略 = 全部' },
          },
        },
        description: '一次最多 12 件；同一 id 重复调用以最后一次为准',
      },
      note: { type: 'string', description: '这一轮的总体思路，写进页头（如「今天重点补终末地和足裏」）' },
    },
    timeoutMs: 600000,
    async execute(args) {
      return doStage(args || {})
    },
  })

  /* ───────────────────────── pixiv_approve ───────────────────────── */
  /**
   * 使用者点头之后的落盘。工具和 HTTP（面板/预览页上的按钮）共用这一份实现。
   * items 里可以混着 preview 编号（1-based）和作品 id。
   */
  async function doApprove({ items, round, note } = {}) {
      const cfg = freshCfg()
      const rid = String(round || latestRound(cfg, home) || roundId)
      const data = loadCandidates(cfg, home, rid)
      const nums = (Array.isArray(items) ? items : [items]).map(Number).filter(Number.isFinite)
      const chosen = []
      const unknown = []
      for (const n of nums) {
        const byIndex = n >= 1 && n <= data.items.length && n < 100000 ? data.items[n - 1] : null
        const hit = byIndex || data.items.find((x) => Number(x.id) === n)
        if (hit) { if (!chosen.includes(hit)) chosen.push(hit) } else unknown.push(n)
      }
      if (!chosen.length) {
        return { ok: false, code: 'NOT_FOUND', hint: `这一轮（${rid}）的候选里没找到这些编号/ID；先看看预览页。`, unknown }
      }

      const results = []
      for (const c of chosen) {
        // ① 历史轮次已经下到暂存区的：搬进作品库正规位置（allwork + 标签快捷方式），不再下载
        if (c.pendingRel && existsSync(join(home, 'pending', c.pendingRel))) {
          try {
            const imp = importWorkDir({
              cfg, home,
              srcDir: join(home, 'pending', c.pendingRel),
              detail: {
                id: c.id, kind: c.kind, title: c.title, rating: c.rating,
                artist: { id: c.artistId ?? null, name: c.artist ?? '' },
                tags: (c.tags || [])
                  .map((t) => (typeof t === 'string' ? { name: t } : { name: t?.name || '', translated: t?.translated }))
                  .filter((t) => t.name),
                created: c.createDate || '', round: rid,
              },
            })
            c.status = 'saved'
            delete c.pendingRel
            c.dir = imp.dir
            appendEntry(home, {
              id: c.id, kind: c.kind, action: 'saved', round: rid, title: c.title,
              dir: imp.dir, rating: c.rating, quota: false, moved: true,
              reason: c.why || '', note: note || null,
            })
            results.push({ id: c.id, ok: true, kind: c.kind, dir: imp.dir, moved: true, mirrors: imp.tags })
          } catch (e) {
            results.push({ id: c.id, ok: false, code: 'MOVE_FAILED', hint: String(e?.message || e) })
          }
          continue
        }

        // ② 候选但没下载：走正式落盘
        try {
          const r = await saveOne({
            id: c.id, kind: c.kind,
            pages: c.pagesWanted || undefined,
            decision: { score: Number(c.score ?? 0.8), reason: c.why || '使用者点头', matchedTags: (c.tags || []).slice(0, 6) },
            keyword: c.tags?.[0] || cfg.keywords?.[0] || '',
          })
          if (r.ok) { c.status = 'saved'; c.dir = r.dir }
          results.push({ id: c.id, ...r })
        } catch (e) {
          results.push({ id: c.id, ok: false, code: e?.code || 'SAVE_FAILED', hint: String(e?.message || e).slice(0, 200) })
        }
      }

      // 3) 回写候选状态 + 重出页 + 报告追加
      saveCandidates(cfg, home, rid, { ...data, items: data.items })
      writeRoundPage({ cfg, home, roundId: rid })
      const okRows = results.filter((r) => r.ok)
      try {
        const day = dayKey()
        const file = join(home, 'out', `${day}.md`)
        const lines = [`<!-- approve ${rid} @ ${new Date().toISOString()} -->`, '', `### 点头落盘（${okRows.length} 件）`, '']
        for (const r of okRows) lines.push(`- \`${r.dir}\``)
        lines.push('')
        appendFileSync(file, lines.join('\n'), 'utf8')
      } catch { /* 报告写不了不影响落盘 */ }

      return {
        ok: results.some((r) => r.ok),
        round: rid,
        saved: okRows.length,
        results,
        unknown,
        page: pageFile(cfg, home, rid),
      }
  }

  /**
   * 误删恢复：按台账把「磁盘上没了」的作品重新下一遍。
   * 不占每日额度、不走去重（恢复不是"新收藏"）。
   */
  async function doRestore({ items, limit = 10 } = {}) {
    const cfg = freshCfg()
    const a = auditLibrary({ cfg, home })
    let targets = a.missing
    if (Array.isArray(items) && items.length) {
      const want = new Set(items.map(Number))
      targets = a.missing.filter((m) => want.has(Number(m.id)))
    }
    targets = targets.slice(0, Math.max(1, Math.min(30, Number(limit) || 10)))
    if (!targets.length) return { ok: true, restored: [], note: '没有缺失的作品，不用恢复' }
    const out = []
    for (const t of targets) {
      try {
        const r = await saveOne({
          id: t.id, kind: t.kind, restore: true,
          decision: { score: 1, reason: '误删恢复（台账里有记录）', matchedTags: [] },
          keyword: '',
        })
        out.push({ id: t.id, kind: t.kind, ...r })
      } catch (e) {
        out.push({ id: t.id, ok: false, error: String(e?.message || e).slice(0, 200) })
      }
    }
    return { ok: true, restored: out, remaining: auditLibrary({ cfg, home }).missing.length }
  }

  /**
   * 他没点头的，别留在他硬盘上：把这一轮的候选状态 pending 的暂存目录整个清掉。
   * 只删 home/pending 下的东西，作品库、缓存一律不碰。
   */
  async function doPurgePending({ round } = {}) {
    const cfg = freshCfg()
    const rid = String(round || latestRound(cfg, home) || roundId)
    const data = loadCandidates(cfg, home, rid)
    const root = join(home, 'pending')
    let removed = 0
    let bytes = 0
    const pruned = []
    for (const c of data.items || []) {
      if (c.status !== 'pending') continue
      if (c.pendingRel) {
        const dir = join(root, c.pendingRel)
        if (existsSync(dir)) {
          try { bytes += treeSize(dir) } catch { /* ignore */ }
          try { rmSync(dir, { recursive: true, force: true }); removed++ } catch { /* 被占用就留着 */ }
        }
        let p = c.pendingRel
        while (true) {
          const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
          if (!parent) break
          p = parent
          try {
            const abs = join(root, p)
            if (existsSync(abs) && !readdirSync(abs).length) rmSync(abs, { recursive: true, force: true })
            else break
          } catch { break }
        }
      }
      c.status = 'dropped'
      delete c.pendingRel
      pruned.push(Number(c.id))
    }
    if (pruned.length) {
      saveCandidates(cfg, home, rid, { ...data, items: data.items })
      writeRoundPage({ cfg, home, roundId: rid })
      const day = dayKey()
      try {
        appendFileSync(join(home, 'out', `${day}.md`),
          `\n<!-- purge ${rid} @ ${new Date().toISOString()} -->\n### 清出未点头的暂存（${pruned.length} 件，${(bytes / 1048576).toFixed(1)} MB）\n\n`, 'utf8')
      } catch { /* ignore */ }
    }
    return { ok: true, round: rid, removed, bytes, ids: pruned, page: pageFile(cfg, home, rid) }
  }

  reg({
    name: 'pixiv_purge_pending',
    description: '清出暂存区里没点头的作品（只删 pending/，不碰作品库和缓存）。前台按钮会调它。',
    parameters: {
      round: { type: 'string', description: '哪一轮；省略 = 最近一轮' },
    },
    timeoutMs: 300000,
    execute: (args) => doPurgePending(args || {}),
  })

  reg({
    name: 'pixiv_approve',
    description: '使用者点头之后才能用：把预览页上他选中的作品真正落进 masterpiece/allwork。items 里填预览页编号（整数）或作品 id 都行。已在暂存区（旧轮次遗留）的直接挪进 allwork，没下过的现场下载。',
    parameters: {
      items: { type: 'array', required: true, items: { type: 'number' }, description: '编号（预览页 #3）或 pixiv 作品 id，可混传' },
      round: { type: 'string', description: '哪一轮的候选；省略 = 最近一轮' },
      note: { type: 'string', description: '使用者是怎么点头的（原话），记进台账' },
    },
    timeoutMs: 900000,
    async execute(args) {
      return doApprove(args || {})
    },
  })

  /* ───────────────────────── pixiv_seen ───────────────────────── */
  reg({
    name: 'pixiv_seen',
    description: '批量判重（≤50 个 id）。known 里 action=saved 的不要再存；action=skipped 且在冷却期内的也别重复看。',
    parameters: {
      ids: { type: 'array', required: true, items: { type: 'number' } },
      kinds: { type: 'array', items: { type: 'string' }, description: '可选：与 ids 对应的类型' },
    },
    async execute({ ids, kinds }) {
      const cfg = freshCfg()
      const arr = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite).slice(0, 50)
      const items = arr.map((id, i) => ({ id, kind: kinds?.[i] }))
      const r = lookup(home, items, cfg.revisitDays)
      return { ok: true, ...r, revisitDays: cfg.revisitDays }
    },
  })

  /* ───────────────────────── pixiv_report ───────────────────────── */
  reg({
    name: 'pixiv_report',
    description: '写当日报告（追加，不覆盖）。每条第一行固定 `### <kind>:<id>`。',
    parameters: {
      summary: { type: 'string', required: true, description: '两三句总结：看了几条、存了几条、跳过几条' },
      entries: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false, properties: {
            id: { type: 'number', required: true },
            kind: { type: 'string', required: true },
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            saved: { type: 'boolean', required: true },
            dir: { type: 'string' },
            reason: { type: 'string' },
            note: { type: 'string' },
          },
        },
      },
    },
    async execute({ summary, entries }) {
      const day = dayKey()
      const file = join(home, 'out', `${day}.md`)
      const lines = []
      const fresh = !existsSync(file)
      if (fresh) {
        lines.push(`# Pixiv 日报 · ${day}`, '')
      }
      lines.push(`<!-- round ${roundId} @ ${new Date().toISOString()} -->`)
      lines.push('', String(summary || '').trim(), '')
      for (const e of entries || []) {
        lines.push(`### ${e.kind}:${e.id}`)
        lines.push(`- 标题：${e.title}`)
        lines.push(`- 链接：${e.url}`)
        if (e.saved) lines.push(`- 已存：\`${e.dir || ''}\``)
        else lines.push(`- 未存：${e.note || e.reason || ''}`)
        if (e.reason) lines.push(`- 理由：${e.reason}`)
        lines.push('')
      }
      const text = lines.join('\n')
      mkdirSync(join(home, 'out'), { recursive: true })
      appendFileSync(file, text, 'utf8')
      return { ok: true, file, bytes: Buffer.byteLength(text) }
    },
  })

  /* ───────────────────────── pixiv_tag_suggest ───────────────────────── */
  reg({
    name: 'pixiv_tag_suggest',
    description: '按种子词看相邻标签（带翻译与出现次数），用于扩展或收敛偏好。',
    parameters: {
      seed: { type: 'string', required: true },
      limit: { type: 'number', description: '默认 12' },
    },
    async execute({ seed, limit = 12 }) {
      return callPx('px_tags', { seed: String(seed), limit: Math.min(30, Number(limit)) }, 90000)
    },
  })

  /* ───────────────────────── pixiv_library ───────────────────────── */
  /**
   * 作品库体检 / 自修。用户挂心的事：目录还在不在、文件全不全、快捷方式断没断。
   * repair=true 时会把断掉的 junction 清掉、按台账重建，并把「台账有、磁盘没有」的作品列出来。
   */
  reg({
    name: 'pixiv_library',
    description: '作品库体检（masterpiece/allwork + 标签快捷方式）。repair=true 时顺手重建断掉的快捷方式；缺的作品会列在 missing 里，等调用方决定是否 pixiv_restore。',
    parameters: {
      repair: { type: 'boolean', description: 'true = 先修一遍再报告（默认 false）' },
    },
    async execute({ repair } = {}) {
      const cfg = freshCfg()
      let fixed = null
      if (repair) fixed = repairLibrary({ cfg, home })
      const a = auditLibrary({ cfg, home })
      return { ok: true, ...a, fixed, bytes: treeSize(a.allwork) }
    },
  })

  /* ───────────────────────── pixiv_restore ───────────────────────── */
  /**
   * 误删恢复：按台账把「磁盘上没了」的作品重新下一遍。
   * 不占每日额度、不走去重（恢复不是"新收藏"）。
   */
  reg({
    name: 'pixiv_restore',
    description: '误删恢复：把台账里记着、但磁盘上已经没了的作品重新下载回 masterpiece/allwork。items 省略 = 全部缺失的。不占每日额度。',
    parameters: {
      items: { type: 'array', items: { type: 'number' }, description: '作品 id；省略 = 体检里 missing 的全部' },
      limit: { type: 'number', description: '这次最多恢复几件（默认 10）' },
    },
    timeoutMs: 900000,
    execute: (args) => doRestore(args || {}),
  })

  return {
    stop,
    restart: () => { stop(); ensureMcp() },
    invalidateCfg,
    ensureMcp,
    // 面板 / 预览页的按钮走这两个（与工具同一份实现）
    approve: doApprove,
    stage: doStage,
    restore: doRestore,
    purgePending: doPurgePending,
    following: (opts = {}) => getFollowing({ home, callPx, log, ...opts }),
  }
}
