/**
 * lib/svc.mjs —— 安全地拿宿主服务
 * ============================================================================
 * cordis 的语义：
 *   · `ctx.workspaceRegistry` —— 没在 `inject` 里声明就直接**抛错**（不是 undefined）
 *   · `ctx.get('workspaceRegistry')` —— 官方给的"不需要 inject 的读取"，拿不到返回 undefined
 *
 * ⚠️ 踩过的坑：把两者写成 `ctx.x || ctx.get('x')` 放在同一个 try 里，
 *    属性访问先抛，`ctx.get` 永远走不到 —— 表现就是日志里"没有 workspaceRegistry"、
 *    模型目录空、会话归不了组。所以必须**分开 try**。
 * ============================================================================
 */

/** 取服务：先按属性（可能抛），再退回 ctx.get（安全） */
export function svc(ctx, name) {
  if (!ctx) return undefined
  try {
    const direct = ctx[name]
    if (direct !== undefined && direct !== null) return direct
  } catch { /* 未 inject：cordis 抛错，继续走 get */ }
  try {
    return ctx.get?.(name) ?? undefined
  } catch {
    return undefined
  }
}

/** 探测几个关键服务是否可见（给 /status 与日志用，不抛） */
export function serviceReport(ctx, names) {
  const out = {}
  for (const n of names) out[n] = Boolean(svc(ctx, n))
  return out
}
