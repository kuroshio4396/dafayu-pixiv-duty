/**
 * dsh-pixiv-scroll —— Web 宿主半端
 * ============================================================================
 * 它负责的是"住在这个进程里的那一半"：
 *   · 设置页的后端（/pixiv-duty/api/*）
 *   · 定时器（谷时窗口里到点跑一轮）
 *   · 手动跑一轮的入口
 *   · 把 vendored 的 Python 脚本 / 章程铺到插件家目录
 *
 * 一轮真正的工具执行发生在 headless 子进程里（agent.js），这里注册的同一套工具
 * 只是为了"在宿主会话里也能手动调一下"，两条路共用 lib/toolset.mjs。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

// 这两样从宿主那棵树取（拿不到就用本地等价实现）—— optional peer 的坑见 lib/hostdeps.mjs
const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeConfigSchema, loadCfg, saveCfg, configFile, pickSeed } from './lib/config.mjs'
import { ensureWorkspace, adoptSessions } from './lib/workspace.mjs'
import { stateDirOf, ensureDirs, ensureHomeFiles, ensureCharter, appendLog, dayKey, readJson, writeJson, WINDOWS, inWindow } from './lib/state.mjs'
import { createToolset } from './lib/toolset.mjs'
import { registerHttp } from './lib/http.mjs'
import { runRound } from './lib/runner.mjs'
import { startLocalServer } from './lib/localsrv.mjs'
import { previewState } from './lib/preview.mjs'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export const name = 'pixiv-duty'
export const inject = ['webServer', 'tools']

// Config 拿不到 schemastery 时是 undefined —— 插件照常加载，只是设置页降级
export const Config = makeConfigSchema(z) || undefined

export function apply(ctx, config = {}) {
  const home = stateDirOf(ctx)
  const log = (m) => {
    try { appendLog(home, `[host] ${m}`) } catch { /* 忽略 */ }
    try { ctx.logger?.('pixiv-duty')?.info?.(m) } catch { /* 忽略 */ }
  }

  ensureDirs(home)
  ensureHomeFiles(PLUGIN_DIR, home, log)
  ensureCharter(PLUGIN_DIR, home, log)

  // 首次运行：把 cordis 层的 config **挑出原始值**种进 config.json（之后以本地为准）
  if (!existsSync(configFile(home))) {
    saveCfg(home, pickSeed(config || {}))
    log('已初始化 config.json')
  }

  // ── 工作区 ──
  // 在 DSH 侧栏里挂一个和插件绑定的工作区；每轮的 headless 会话就跑在它里面
  // （会话按 cwd 归属：~/.dsh/sessions/--<cwd slug>--），
  // 于是 agent 的收尾回复（下载成功 / 下载失败 / 搜寻无结果）会落在这个工作区。
  try {
    ctx.inject(['workspaceRegistry'], (wsCtx) => {
      const cfg = loadCfg(home)
      ensureWorkspace(wsCtx, home, cfg)
        .then((r) => {
          log(r.ok
            ? `工作区就绪：${r.path}${r.id ? `（id=${r.id}）` : ''}`
            : `工作区未就绪：${r.note}（目录 ${r.path}）`)
        })
        .catch((e) => log(`工作区初始化异常：${e?.message ?? e}`))
    })
  } catch (e) {
    log(`工作区注册跳过：${e?.message ?? e}`)
  }

  const toolset = createToolset({
    ctx,
    defineTool: defineTool || ((o) => o),
    home,
    roundId: 'host',
    log,
  })

  // ── 预览页回环服务（勾选后直接落盘要靠它） ──
  let localSrv = null
  startLocalServer({
    home,
    getCfg: () => loadCfg(home),
    approve: (x) => toolset.approve(x),
    log,
  }).then((srv) => {
    localSrv = srv
    previewState.origin = srv.origin
    previewState.port = srv.port
    previewState.startedAt = new Date().toISOString()
    previewState.error = null
    log(`预览服务已就绪：${srv.origin}`)
  }).catch((e) => {
    previewState.error = String(e?.message ?? e)
    log(`预览服务起不来：${previewState.error}`)
  })
  ctx.effect(() => () => { try { localSrv?.dispose?.() } catch { /* ignore */ } }, 'pixiv-duty: preview-server')

  // ── HTTP ──
  try {
    const api = registerHttp(ctx, { home, toolset, log })
    ctx.effect(() => () => api.dispose?.(), 'pixiv-duty: http')
    log(`HTTP 已挂载 ${api.prefix}`)
  } catch (e) {
    // 挂不上路由不该让整条插件不激活 —— 手动跑一轮仍可用
    log(`HTTP 挂载失败：${e?.message ?? e}`)
  }

  // ── 定时器：每分钟一跳，进窗口才跑 ──
  const timer = setInterval(() => {
    try {
      const cfg = loadCfg(home)
      if (!cfg.enabled || !cfg.autoRun) return
      const now = new Date()
      const hits = []
      if (cfg.noon && inWindow(now, WINDOWS.noon)) hits.push('noon')
      if (cfg.night && inWindow(now, WINDOWS.night)) hits.push('night')
      if (!hits.length) return

      const stateFile = join(home, 'state.json')
      const st = readJson(stateFile, {})
      st.autoRuns = st.autoRuns || {}
      // 只留今天的记录，避免 state.json 无限长
      for (const k of Object.keys(st.autoRuns)) if (!k.startsWith(dayKey())) delete st.autoRuns[k]
      const slot = hits.find((h) => !st.autoRuns[`${dayKey()} ${h}`])
      if (!slot) return

      // 先记账再跑：同一窗口只跑一次（跑失败也不在窗口里反复烧钱）
      st.autoRuns[`${dayKey()} ${slot}`] = new Date().toISOString()
      try { writeJson(stateFile, st) } catch { /* 忽略 */ }

      const rid = `${dayKey()}-${slot}-${Date.now().toString(36)}`
      const since = Date.now()
      // runRound 是 async 的（跑之前要探测/拉起代理），这里用 .then 收口，别让异常冒到定时器
      runRound({
        home, cfg, roundId: rid, why: `window:${slot}`, log,
        restore: (x) => toolset.restore(x),
        onExit: () => {
          // 跑完把会话挂进工作区（否则它落在「未分组」）
          adoptSessions(ctx, { home, cfg: loadCfg(home), since, log })
            .then((x) => { if (!x.ok) log(`会话归组跳过：${x.note}`) })
            .catch((e) => log(`会话归组异常：${e?.message ?? e}`))
        },
      }).then((r) => {
        log(`自动跑（${slot}）：${r.started ? `已启动 ${rid}` : `跳过 ${r.error}`}`)
      }).catch((e) => {
        try { appendLog(home, `[host] 自动跑异常：${e?.message ?? e}`) } catch { /* 忽略 */ }
      })
    } catch (e) {
      // ⚠️ 定时器回调里冒异常会杀掉整个宿主 —— 必须自己吞掉
      try { appendLog(home, `[host] 定时器异常：${e?.message ?? e}`) } catch { /* 忽略 */ }
    }
  }, 60_000)
  timer.unref?.()

  ctx.effect(() => () => {
    clearInterval(timer)
    toolset.stop()
  }, 'pixiv-duty: timer+mcp')

  log(`已激活（home=${home}, hostdeps=${(hostDeps.notes || []).length} 条说明）`)
}
