/**
 * lib/config.mjs —— 配置的唯一真相源
 * ============================================================================
 * 两条硬规矩（都是被 DSH 的机制逼出来的）：
 *
 * ① **每个字段都必须 `.extra('volatile', true)`**
 *    DSH 的 settings 只投影 volatile 字段；一个都没有 ⇒ 设置面板里根本不出现这一项，
 *    `ctx.settings.update()` 还会抛 `has no volatile fields`。
 *
 * ② **schema 里一律不写 .min()/.max()**
 *    校验失败会让 cordis 拒收 entry，表现是「整条插件不激活」，比"值不合法"严重得多。
 *    范围只在 clampCfg() 里钳 —— 读和写两头都过一遍。
 *
 * 配置以本文件的 `config.json` 为真相源（D7）。DSH 原生设置页只是尽力同步；
 * 同步失败记进 `local-override.json`，面板会说一句「未同步到 DSH」。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

/** 字段登记表：key → 类型 / 默认值 / 说明 / 可选值 */
export const SPEC = {
  enabled: { type: 'bool', def: true, desc: '总开关：关掉只停自动跑，手动仍可跑一轮' },

  pixivId: { type: 'str', def: '', desc: 'Pixiv 登录名（只用于填表与显示，不参与鉴权）' },
  authState: { type: 'str', def: 'none', desc: '登录状态：none / ok / expired（插件写，面板读）' },

  agentProfile: { type: 'str', def: 'headless', desc: '用哪个 profile 跑这一轮' },
  agentProvider: { type: 'str', def: '', desc: '模型 provider；空 = 用 profile 默认' },
  agentModel: { type: 'str', def: '', desc: '模型；空 = 用 profile 默认' },

  contentIllust: { type: 'bool', def: true, desc: '收插画' },
  contentManga: { type: 'bool', def: true, desc: '收漫画' },
  contentNovel: { type: 'bool', def: true, desc: '收小说' },

  allowR18: { type: 'bool', def: false, desc: '取 R-18（需账号在网页端已开启显示）' },

  keywords: { type: 'list', def: [], desc: '关注关键词 / 标签，一行一个；空则用章程里的默认组' },
  requiredTags: { type: 'list', def: [], desc: '必须全部命中（AND）' },
  excludeTags: { type: 'list', def: [], desc: '任一命中即淘汰' },
  tagWeights: { type: 'str', def: '', desc: '标签权重，一行一个 `标签=3`；只用于打分' },

  bookmarkMin: { type: 'num', def: 0, desc: '收藏数下限；0 = 不设下限' },
  bookmarkMax: { type: 'num', def: 0, desc: '收藏数上限；0 = 不设上限' },
  days: { type: 'num', def: 7, desc: '只看最近几天（受「启用时间窗」控制）' },
  daysOn: { type: 'bool', def: true, desc: '启用时间窗；关掉 = 不限发布时间' },

  novelVibe: { type: 'str', def: '', desc: '小说正文模糊偏好（自然语言）；只在中文小说上生效' },
  novelVibeMin: { type: 'num', def: 0.15, desc: '正文匹配度下限（0–1），低于它就不收' },

  openAfterSave: { type: 'bool', def: true, desc: '存好一件后自动打开它的文件夹' },

  notifyWorkspace: { type: 'bool', def: true, desc: '把每轮状态播报到 DSH 工作区' },
  workspaceDir: { type: 'str', def: '', desc: '工作区目录；空 = <插件家>/workspace' },

  useHubChannel: { type: 'bool', def: false, desc: 'headless 里加载本机 dsh-providers-hub（CodeBuddy 等渠道）' },

  perDay: { type: 'num', def: 12, desc: '每天最多存几件' },
  perRound: { type: 'num', def: 4, desc: '单轮最多存几件' },
  maxCandidates: { type: 'num', def: 40, desc: '单轮最多看多少条元数据' },
  maxImages: { type: 'num', def: 6, desc: '单轮最多读多少张图' },
  maxPagesPerWork: { type: 'num', def: 40, desc: '单件最多下载多少页' },

  saveRoot: { type: 'str', def: '', desc: '作品库根目录；空 = <插件家>/Download（其下有 all_works）' },
  workTemplate: { type: 'str', def: '{artistId}_{title}_{id}', desc: '作品命名模板，可用 {artistId} {artist} {title} {id} {kind} {rating} {year}，必须含 {id}' },
  mirrorTags: { type: 'list', def: [], desc: '旧版标签快捷方式；画廊已改为虚拟分类，默认不建文件夹' },
  previewPort: { type: 'num', def: 47825, desc: '预览页回环端口（固定端口才能收藏链接）；0 = 每次随机' },
  dirTemplate: { type: 'str', def: '{kind}/{artist}/{title}_{id}', desc: '旧版目录模板（仅迁移用）' },

  libGuard: { type: 'str', def: 'ask', desc: '开跑前查库：auto=对不上就立刻回滚并弹窗 / ask=弹窗问你回不回滚 / off=不管（只提醒面板）' },
  guardWaitSec: { type: 'num', def: 90, desc: 'libGuard=ask 时最多等你几秒，超时当「不回滚」继续跑' },
  cacheDays: { type: 'num', def: 30, desc: '没点头的候选缓存保留几天，过期只留「当天选了哪些」' },
  deleteRecordDays: { type: 'num', def: 90, desc: '被删作品的记录保留几天，过期连恢复依据一起清掉' },

  followedOnly: { type: 'bool', def: false, desc: '推送模式：只推已关注作者（权重 >5 必推；≥1 且作者被关注也推）；开关只对下一轮生效' },
  dislikeTags: { type: 'list', def: [], desc: '不喜欢的标签（命中就按 dislikeWeight 扣分）' },
  dislikeWeight: { type: 'num', def: -1, desc: '不喜欢标签的权重（通常 -1）' },
  minPushWeight: { type: 'num', def: 1, desc: '推送模式下的最低权重和（≥ 这个数才有机会推）' },
  mustPushWeight: { type: 'num', def: 5, desc: '权重和超过这个数就必推（不看是否关注）' },

  novelMode: { type: 'str', def: 'auto', desc: 'auto / full / excerpt' },
  novelFullMaxChars: { type: 'num', def: 8000, desc: '短于这个字数整篇保存' },
  novelExcerptChars: { type: 'num', def: 3000, desc: '选段总字数上限' },
  novelExcerptBlocks: { type: 'num', def: 6, desc: '最多选几段' },

  zhMode: { type: 'str', def: 'auto', desc: '中文判定：auto / language / script / tag / off' },
  zhRatio: { type: 'num', def: 0.25, desc: '汉字占比阈值' },

  revisitDays: { type: 'num', def: 14, desc: '跳过的作品多少天内不再看' },

  autoRun: { type: 'bool', def: false, desc: '谷时自动跑' },
  noon: { type: 'bool', def: false, desc: '中午 12:00–14:00' },
  night: { type: 'bool', def: true, desc: '晚上 18:00–09:00' },

  pythonPath: { type: 'str', def: 'python', desc: 'Python 解释器；装依赖后指向插件 venv' },
  dshBin: { type: 'str', def: '', desc: 'dsh 的 bin.js 路径（桌面版找不到时手填）' },
  proxyUrl: { type: 'str', def: '', desc: '访问 Pixiv 的 HTTP 代理，如 http://127.0.0.1:7890；空 = 直连' },
  vpnAuto: { type: 'bool', def: true, desc: '跑之前代理端口不通，就自动把下面的代理软件（VPN）拉起来' },
  vpnPath: { type: 'str', def: '', desc: '代理软件主程序路径：Clash / V2RayN / Shadowsocks 等任意 VPN 客户端都行，要 GUI 那个 exe；空 = 不自动拉' },
  vpnWaitSec: { type: 'num', def: 25, desc: '拉起代理软件后最多等它几秒（等端口起来）' },
}

export const CONFIG_KEYS = Object.keys(SPEC)

export const DEFAULTS = Object.freeze(Object.fromEntries(
  CONFIG_KEYS.map((k) => [k, Array.isArray(SPEC[k].def) ? [...SPEC[k].def] : SPEC[k].def]),
))

/** 数值钳制范围（见文件头 ②） */
const RANGES = {
  bookmarkMin: [0, 100000],
  bookmarkMax: [0, 100000],
  days: [1, 365],
  perDay: [0, 100],
  perRound: [0, 50],
  maxCandidates: [5, 200],
  maxImages: [0, 40],
  maxPagesPerWork: [1, 200],
  novelFullMaxChars: [500, 200000],
  novelExcerptChars: [200, 20000],
  novelExcerptBlocks: [1, 30],
  novelVibeMin: [0, 1],
  zhRatio: [0, 1],
  revisitDays: [0, 365],
  vpnWaitSec: [3, 120],
  guardWaitSec: [0, 600],
  cacheDays: [7, 365],
  deleteRecordDays: [30, 3650],
}

const ENUMS = {
  novelMode: ['auto', 'full', 'excerpt'],
  zhMode: ['auto', 'language', 'script', 'tag', 'off'],
  libGuard: ['auto', 'ask', 'off'],
}

/**
 * 生成 schemastery 的 Config。`z` 从宿主那棵树取（lib/hostdeps.mjs）。
 * 拿不到 z 时返回 null —— 插件照常加载，只是没有 Config、设置页降级。
 */
export function makeConfigSchema(z) {
  if (!z || typeof z.object !== 'function') return null
  const shape = {}
  for (const [key, spec] of Object.entries(SPEC)) {
    let v
    if (spec.type === 'bool') v = z.boolean()
    else if (spec.type === 'num') v = z.number()
    else if (spec.type === 'list') v = z.array(z.string())
    else v = z.string()
    v = v.default(Array.isArray(spec.def) ? [...spec.def] : spec.def)
    if (spec.desc) v = v.description(spec.desc)
    shape[key] = v.extra('volatile', true)
  }
  return z.object(shape)
}

function asBool(v, def) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes'
  if (typeof v === 'number') return v !== 0
  return def
}

function asNum(v, def) {
  // ⚠️ 不能把 undefined 当 0 —— 那会让所有"没填"的数值字段被钳到下限
  if (v === undefined || v === null || v === '') return def
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isFinite(n) ? n : def
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  if (typeof v === 'string') return v.split(/[\r\n,，]+/).map((x) => x.trim()).filter(Boolean)
  return []
}

/** 把任意来源（config.json / 原生设置 / HTTP body）的原始值收敛成合法配置 */
export function normalizeCfg(raw = {}) {
  // 老配置迁移：minBookmarks → bookmarkMin（用户已有配置不丢）
  let input = raw || {}
  if (input && input.bookmarkMin === undefined && input.minBookmarks !== undefined) {
    input = { ...input, bookmarkMin: input.minBookmarks }
  }
  // 老配置迁移：只认 Clash 的三项 → 通用的代理软件三项（换成 V2RayN 之类也照样用）
  if (input && input.vpnAuto === undefined && input.clashAuto !== undefined) input = { ...input, vpnAuto: input.clashAuto }
  if (input && input.vpnPath === undefined && input.clashPath !== undefined) input = { ...input, vpnPath: input.clashPath }
  if (input && input.vpnWaitSec === undefined && input.clashWaitSec !== undefined) input = { ...input, vpnWaitSec: input.clashWaitSec }
  const out = {}
  for (const [key, spec] of Object.entries(SPEC)) {
    const v = input?.[key]
    if (spec.type === 'bool') out[key] = asBool(v, spec.def)
    else if (spec.type === 'num') out[key] = asNum(v, spec.def)
    else if (spec.type === 'list') out[key] = v === undefined ? [...spec.def] : asList(v)
    else out[key] = v === undefined || v === null ? spec.def : String(v)
  }
  return out
}

/** 小数比例字段：不能四舍五入（zhRatio 0.25 会被舍成 0） */
const FRACTION = new Set(['zhRatio', 'novelVibeMin'])

/** 范围钳制 + 枚举兜底 + 模板合法性 */
export function clampCfg(cfg) {
  const out = normalizeCfg(cfg)
  for (const [key, [lo, hi]] of Object.entries(RANGES)) {
    const raw = asNum(out[key], DEFAULTS[key])
    const n = FRACTION.has(key) ? raw : Math.round(raw)
    out[key] = Math.min(hi, Math.max(lo, n))
  }
  for (const [key, allowed] of Object.entries(ENUMS)) {
    if (!allowed.includes(out[key])) out[key] = DEFAULTS[key]
  }
  out.agentProfile = String(out.agentProfile || 'headless').trim() || 'headless'
  out.pythonPath = String(out.pythonPath || 'python').trim() || 'python'
  out.saveRoot = String(out.saveRoot || '').trim()
  let tpl = String(out.dirTemplate || DEFAULTS.dirTemplate).trim()
  if (!tpl.includes('{id}')) tpl = DEFAULTS.dirTemplate
  if (tpl.includes('..') || /^[a-zA-Z]:/.test(tpl) || tpl.startsWith('/') || tpl.startsWith('\\')) tpl = DEFAULTS.dirTemplate
  out.dirTemplate = tpl
  // 新的作品命名模板：必须带 {id}，不许有路径分隔/穿越
  let wt = String(out.workTemplate || DEFAULTS.workTemplate).trim() || DEFAULTS.workTemplate
  if (!wt.includes('{id}') || /[\\/]|\.\./.test(wt)) wt = DEFAULTS.workTemplate
  out.workTemplate = wt
  // 标签文件夹：去空、去重、限长
  out.mirrorTags = [...new Set((Array.isArray(out.mirrorTags) ? out.mirrorTags : [])
    .map((s) => String(s || '').trim()).filter(Boolean))]
    .slice(0, 30).map((s) => s.slice(0, 40))
  // 必填/排除标签互相冲突时，排除优先（工具层也会照这条执行）
  const ex = new Set(out.excludeTags.map((s) => s.toLowerCase()))
  out.requiredTags = out.requiredTags.filter((s) => !ex.has(s.toLowerCase()))
  return out
}

/**
 * 从 cordis 的 Config 里挑出**能安全落盘**的值。
 * ⚠️ 不能直接把 apply(ctx, config) 的 config 写进 config.json：
 *    宿主给过来的对象里，未被显式设置的字段可能不是原始值（我们实测到过对象），
 *    直接落盘会得到一堆 "[object Object]"。只接受原始类型，其余靠 DEFAULTS。
 */
export function pickSeed(raw) {
  const out = {}
  for (const [key, spec] of Object.entries(SPEC)) {
    const v = raw?.[key]
    if (spec.type === 'bool' && typeof v === 'boolean') out[key] = v
    else if (spec.type === 'num' && typeof v === 'number' && Number.isFinite(v)) out[key] = v
    else if (spec.type === 'str' && typeof v === 'string') out[key] = v
    else if (spec.type === 'list' && Array.isArray(v) && v.every((x) => typeof x === 'string')) out[key] = v
  }
  return out
}

export function configFile(stateDir) { return join(stateDir, 'config.json') }
export function overrideFile(stateDir) { return join(stateDir, 'local-override.json') }

/** 读：config.json → 补默认值 → 钳制 */
export function loadCfg(stateDir) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(configFile(stateDir), 'utf8')) } catch { /* 第一次跑 */ }
  return clampCfg(raw)
}

/** 写：原子写 config.json，返回落盘后的完整配置 */
export function saveCfg(stateDir, patch) {
  const next = clampCfg({ ...loadCfg(stateDir), ...(patch || {}) })
  const f = configFile(stateDir)
  const tmp = `${f}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, f)
  return next
}

/** 记下"哪几个键没能同步到 DSH 原生设置"（只用于面板提示，不影响生效值） */
export function markUnsynced(stateDir, keys, reason) {
  if (!keys?.length) return
  let prev = {}
  try { prev = JSON.parse(readFileSync(overrideFile(stateDir), 'utf8')) } catch { /* 首次 */ }
  const merged = { ...prev }
  for (const k of keys) merged[k] = { at: new Date().toISOString(), reason: String(reason ?? '').slice(0, 200) }
  try { writeFileSync(overrideFile(stateDir), JSON.stringify(merged, null, 2), 'utf8') } catch { /* 忽略 */ }
}

export function unsyncedKeys(stateDir) {
  try { return Object.keys(JSON.parse(readFileSync(overrideFile(stateDir), 'utf8'))) } catch { return [] }
}

export function clearUnsynced(stateDir, keys) {
  let prev = {}
  try { prev = JSON.parse(readFileSync(overrideFile(stateDir), 'utf8')) } catch { return }
  let changed = false
  for (const k of keys || Object.keys(prev)) { if (k in prev) { delete prev[k]; changed = true } }
  if (!changed) return
  try {
    if (Object.keys(prev).length) writeFileSync(overrideFile(stateDir), JSON.stringify(prev, null, 2), 'utf8')
    else writeFileSync(overrideFile(stateDir), '{}', 'utf8')
  } catch { /* 忽略 */ }
}

/**
 * 尽力同步到 DSH 原生设置。
 * 失败不算错误：panel 上提示"未同步"，生效值仍然是本地这份。
 * ⚠️ 用 `--patch` 调参时 DSH 会拒绝写入（overridden by ... overlay），这是预期内的。
 */
function settingsService(ctx) {
  // ① 首选 ctx.get('settings')：直接读 ctx.settings 在没 inject 时会抛
  //    「cannot get property "settings" without inject」—— 那正是以前每次都同步失败的原因。
  try {
    const svc = typeof ctx?.get === 'function' ? ctx.get('settings') : null
    if (svc) return svc
  } catch { /* 没这个服务，继续试下一条 */ }
  // ② 兜底：如果调用方已经 inject 过 settings，直接取也行
  try { return ctx?.settings || null } catch { return null }
}

export async function syncToHost(ctx, patch) {
  const svc = settingsService(ctx)
  if (!svc || typeof svc.update !== 'function') {
    return { ok: false, reason: '宿主没有 settings 服务（ctx.get("settings") 取不到）' }
  }
  try {
    await svc.update('pixiv-duty', patch)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: e?.message ?? String(e) }
  }
}

/** 保存根目录：空则落在插件家里 */
export function resolveSaveRoot(cfg, stateDir) {
  return cfg.saveRoot ? cfg.saveRoot : join(stateDir, 'Download')
}
