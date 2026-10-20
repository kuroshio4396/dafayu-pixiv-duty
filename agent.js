/**
 * dsh-pixiv-scroll —— headless 半端（一轮里真正挂工具的那个）
 * ============================================================================
 * 为什么单独一个入口，而不是复用 index.js：
 *   index.js 是 Web 宿主半端，它 inject 了 webServer / settings / 定时器；
 *   把这些拖进一个一次性子进程既没必要，也会让 overlay 的依赖变复杂。
 *   这里只 inject `tools`，起 Python MCP、注册同一套工具，跑完就退出。
 *
 * 挂载方式（由 lib/runner.mjs 生成）：
 *   - insert:
 *       - id: pixiv-duty-agent
 *         name: dsh-pixiv-scroll/agent
 *         config: { home, round, tools[] }
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool

import { createToolset } from './lib/toolset.mjs'
import { ensureDirs, ensureHomeFiles, appendLog } from './lib/state.mjs'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export const name = 'pixiv-duty-agent'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const home = String(config.home || process.env.PIXIV_DUTY_HOME || '').trim()
  if (!home) {
    // 没有家目录就什么都不注册 —— 但要留下痕迹，别静默
    try { ctx.logger?.('pixiv-duty-agent')?.error?.('缺少 config.home，本轮不注册工具') } catch { /* 忽略 */ }
    return
  }
  const roundId = String(config.round || process.env.PIXIV_DUTY_ROUND || 'manual')
  const log = (m) => {
    try { appendLog(home, `[agent] ${m}`) } catch { /* 忽略 */ }
    try { ctx.logger?.('pixiv-duty-agent')?.info?.(m) } catch { /* 忽略 */ }
  }

  ensureDirs(home)
  ensureHomeFiles(PLUGIN_DIR, home, log)

  const toolset = createToolset({
    ctx,
    defineTool: defineTool || ((o) => o),
    home,
    roundId,
    log,
  })

  ctx.effect(() => () => {
    log('一轮结束，关掉 MCP 子进程')
    toolset.stop()
  }, 'pixiv-duty-agent: mcp')

  log(`工具已注册（round=${roundId}, home=${home}, hostdeps=${(hostDeps.notes || []).length} 条）`)
}
