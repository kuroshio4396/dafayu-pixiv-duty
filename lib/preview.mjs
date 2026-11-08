/** 预览服务的运行态（单例）：宿主起来时填，别处只读 */
export const previewState = { origin: null, port: 0, startedAt: null, error: null }

export function previewUrlFor(roundId) {
  if (!previewState.origin || !roundId) return null
  const slug = String(roundId).replace(/[^\w.-]+/g, '-').slice(0, 80)
  return `${previewState.origin}/p/${slug}`
}
