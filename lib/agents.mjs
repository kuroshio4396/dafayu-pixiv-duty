/**
 * lib/agents.mjs —— "用哪个 agent 跑这一轮"：渠道（provider）/ 模型 / 视觉能力
 * ============================================================================
 * 模型列表来自宿主的 llm 服务（不是我们自己维护的常量）：
 *   llm.listConfigurableProviders() → [{ provider, displayName, settingsNs, … }]
 *   llm.listModels(provider)        → [{ provider, id, name, inputModalities? }]
 * 面板按 **渠道分组**（optgroup），这样用户能确认"用的是哪个渠道的哪个模型"。
 *
 * 视觉能力是硬前提：`read_image` 会校验当前路由是否声明 inputModalities 含 image，
 * 不满足直接报错。拿到就标出来；拿不到一律当 unknown，不拦人。
 * ============================================================================
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { svc } from './svc.mjs'

function dshHome(env = process.env) {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function listProfiles(env = process.env) {
  const root = join(dshHome(env), 'profiles')
  const out = []
  try {
    for (const name of readdirSync(root)) {
      const dir = join(root, name)
      try {
        if (!existsSync(dir)) continue
        out.push({ id: name, hasPatch: existsSync(join(dir, 'cordis.patch.yml')) })
      } catch { /* 忽略 */ }
    }
  } catch { /* 没有 profiles 目录 */ }
  if (!out.some((p) => p.id === 'headless')) out.unshift({ id: 'headless', hasPatch: false })
  return out
}

/** Jet Hub 注册的渠道 id（用于判断"这个渠道需要 hub 才能在 headless 里用"） */
export const HUB_PROVIDERS = new Set([
  'buddy', 'workbuddy', 'codearts', 'qoder', 'qodercn', 'trae', 'cline',
  'loomy', 'raccoon', 'minimax', 'minimax-intl', 'accio', 'lobsterai',
  'opencode', 'zcode', 'jet-hub-auto',
])

function llmOf(ctx) {
  return svc(ctx, 'llm')
}

/**
 * 真实模型目录：按渠道分组。
 * 返回 { ok, providers: [{ id, name, models: [{ id, name, image }] }], note? }
 */
export async function listModels(ctx) {
  const llm = llmOf(ctx)
  if (!llm) {
    return { ok: false, providers: [], note: '宿主没有暴露 llm 服务（插件未 inject llm）' }
  }

  let providers = []
  try {
    if (typeof llm.listConfigurableProviders === 'function') {
      const list = await llm.listConfigurableProviders()
      for (const p of list || []) {
        const id = p.provider ?? p.id
        if (id) providers.push({ id, name: p.displayName ?? p.name ?? id })
      }
    }
  } catch (e) {
    // 拿不到"可配置"目录不是致命错，下面还有 listProviders 兜底
  }
  // ⚠️ 只查 listConfigurableProviders 会漏掉 Jet Hub：
  //    它自 2026-10-01 起**不再声明 configurable provider**（见其 llm-register-compat.ts），
  //    但它注册的适配器仍在 listProviders() 里。两个来源要**并集**。
  try {
    if (typeof llm.listProviders === 'function') {
      for (const p of llm.listProviders() || []) {
        const id = p.id ?? p.provider
        if (!id) continue
        if (!providers.some((x) => x.id === id)) providers.push({ id, name: p.name ?? id })
      }
    }
  } catch { /* 忽略 */ }

  if (!providers.length) {
    return { ok: false, providers: [], note: '宿主没有暴露任何 llm 渠道（服务不可见或还没配置 provider）' }
  }

  const withTimeout = (p, ms = 8000) => Promise.race([
    p, new Promise((resolve) => setTimeout(() => resolve(null), ms)),
  ])

  // 并行拉模型：某个渠道慢（远端目录）不该把整个列表拖住
  const out = (await Promise.all(providers.map(async (p) => {
    const id = p.id
    if (!id) return null
    let models = []
    try {
      models = typeof llm.listModels === 'function' ? (await withTimeout(llm.listModels(id))) : []
    } catch { models = [] }
    return {
      id,
      name: p.name || id,
      models: (models || [])
        .map((m) => ({
          id: m.id,
          name: m.name && m.name !== m.id ? `${m.name}` : m.id,
          image: Array.isArray(m.inputModalities)
            ? m.inputModalities.includes('image')
            : null,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }
  }))).filter(Boolean)

  return { ok: out.length > 0, providers: out }
}

export async function resolveModelInfo(ctx, provider, model) {
  const llm = llmOf(ctx)
  if (!llm || !provider || !model) return { image: null, note: '未指定模型' }
  try {
    const info = typeof llm.resolveModelInfo === 'function'
      ? await llm.resolveModelInfo(provider, model)
      : null
    if (!info) return { image: null, note: '拿不到模型信息' }
    const mods = info.inputModalities
    if (!mods) return { image: false, note: '未声明多模态（按纯文本处理）' }
    return { image: mods.includes('image'), note: mods.join('+') }
  } catch (e) {
    return { image: null, note: String(e?.message ?? e).slice(0, 120) }
  }
}

/**
 * 开跑前的视觉预检。只有"明确不支持"才拦；探测不到就放行（未知≠不支持）。
 */
export async function checkVision(ctx, cfg) {
  const needImage = cfg.contentIllust || cfg.contentManga
  if (!needImage) return { ok: true, note: '只跑小说，不需要读图' }
  if (!cfg.agentProvider || !cfg.agentModel) {
    return { ok: true, note: '用 profile 默认模型（headless 默认 deepseek-flash 支持图片）' }
  }
  const info = await resolveModelInfo(ctx, cfg.agentProvider, cfg.agentModel)
  if (info.image === false) {
    return {
      ok: false,
      error: `当前模型 ${cfg.agentProvider}/${cfg.agentModel} 不支持图片输入；插画/漫画要读图，请换模型或关掉插画与漫画`,
    }
  }
  return { ok: true, note: info.note }
}
