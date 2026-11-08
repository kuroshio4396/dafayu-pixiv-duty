/**
 * lib/http.mjs —— 设置页的后端（双通道）
 * ============================================================================
 * ⚠️ 关键事实（2026-10-19 实测）：**桌面版根本不监听 TCP**，UI 由 Electron 的
 *    自定义协议承载。`ctx.webServer.register()` 在桌面里注册了也收不到请求，
 *    表现就是设置页永远"读取配置中…"。
 *
 * 所以这里注册两条通道：
 *   ① 桌面/Web 通用：`ctx.connection.fetch.register({ path: '/api/pixiv-duty/…' })`
 *      —— 官方给插件留的精确路由，Request/Response 风格，且已带信任与鉴权。
 *   ② 仅 Web：`ctx.webServer.register({ kind:'prefix', path:'/pixiv-duty/api' })`
 *      —— 传统 Node req/res，保留给源码模式与旧宿主。
 *
 * 前端会自动探测哪条通路可用（见 client.js 的 resolveBase）。
 * ============================================================================
 */
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { loadCfg, saveCfg, syncToHost, markUnsynced, unsyncedKeys, clearUnsynced, resolveSaveRoot, CONFIG_KEYS } from './config.mjs'
import { appendLog, dayKey, tailLog, readJson } from './state.mjs'
import { runRound } from './runner.mjs'
import { listProfiles, listModels, checkVision, HUB_PROVIDERS } from './agents.mjs'
import { loginWithBrowser, loginWithToken } from './login-pixiv.mjs'
import { probeDir } from './save.mjs'
import { readAll, exportMarkdown } from './seen.mjs'
import { ensureWorkspace, workspaceStatus, workspaceDirOf, adoptSessions, findHubDir, hubAccounts } from './workspace.mjs'
import { svc, serviceReport } from './svc.mjs'
import { loadCandidates, pageFile, latestRound, picksRoot, roundSlug } from './picks.mjs'
import { auditLibrary, repairLibrary, moveLibrary, libPaths, ALLWORK, treeSize } from './library.mjs'
import { diffLibrary, readSnapshot, rollbackLibrary } from './snapshot.mjs'
import { listPicksHistory } from './retention.mjs'
import { previewState, previewUrlFor } from './preview.mjs'

/** 用系统默认浏览器打开一个地址（预览页必须是渲染态的浏览器，不是编辑器预览） */
function openInBrowser(url) {
  const target = String(url)
  if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore' }).unref()
  else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
  else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
}

/**
 * 弹一个系统原生的「选文件夹」对话框（只有 Windows 有实现）。
 * 注意：对话框可能要开很久，所以调用方不要同步等 —— 这里用 Promise，HTTP 层再用 job 轮询。
 */
function pickDirectory({ initial = '', title = '选择文件夹' } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, error: '系统选择框目前只支持 Windows，请手动填写路径' })
    }
    const q = (s) => String(s).replace(/'/g, "''")
    const ps = [
      "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
      "$ErrorActionPreference='Stop'",
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d=New-Object System.Windows.Forms.FolderBrowserDialog',
      `$d.Description='${q(title)}'`,
      '$d.ShowNewFolderButton=$true',
      `$init='${q(initial)}'`,
      'if($init -and (Test-Path -LiteralPath $init)){ try{$d.SelectedPath=$init}catch{} }',
      '$top=New-Object System.Windows.Forms.Form',
      "$top.TopMost=$true;$top.ShowInTaskbar=$false;$top.WindowState='Minimized';$top.Opacity=0",
      "if($d.ShowDialog($top) -eq [System.Windows.Forms.DialogResult]::OK){ [Console]::Out.Write('PICKED:'+$d.SelectedPath) } else { [Console]::Out.Write('CANCELLED') }",
      '$top.Dispose()',
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true })
    let out = ''
    let err = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('error', (e) => done({ ok: false, error: String(e?.message || e) }))
    child.on('exit', () => {
      const i = out.indexOf('PICKED:')
      if (i >= 0) return done({ ok: true, path: out.slice(i + 7).trim() })
      done({ ok: false, cancelled: true, error: err.trim().slice(0, 300) || '已取消' })
    })
  })
}


const API_BASE = '/api/pixiv-duty'
const LEGACY_PREFIX = '/pixiv-duty/api'
const MAX_BODY = 1024 * 1024

/** 「选文件夹」对话框的临时 job 表（id → {at,status,path,error}） */
const pickJobs = new Map()

function venvPython(home) {
  return process.platform === 'win32'
    ? join(home, '.venv', 'Scripts', 'python.exe')
    : join(home, '.venv', 'bin', 'python')
}

function run(cmd, args, { cwd, env, log }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, PYTHONUTF8: '1', ...env }, windowsHide: true })
    const onData = (b) => { try { appendFileSync(log, String(b), 'utf8') } catch { /* 忽略 */ } }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => resolve({ code: -1, error: String(e?.message ?? e) }))
    child.on('exit', (code) => resolve({ code }))
  })
}

/**
 * 建 venv + 装依赖（后台跑，页面不阻塞）。
 * ⚠️ 镜像要按顺序试：清华镜像里没有 pixivpy3（实测 "from versions: none"），阿里云有。
 */
const MIRRORS = [
  'https://mirrors.aliyun.com/pypi/simple',
  'https://pypi.tuna.tsinghua.edu.cn/simple',
  'https://mirrors.ustc.edu.cn/pypi/simple',
]

async function installDeps({ home, cfg }) {
  const installLog = join(home, 'install.log')
  const py = cfg.pythonPath || 'python'
  const req = join(home, 'requirements.txt')
  mkdirSync(home, { recursive: true })
  appendFileSync(installLog, `\n=== ${new Date().toISOString()} 开始装依赖 ===\n`, 'utf8')

  let ok = false
  const uvTry = await run('uv', ['venv', join(home, '.venv')], { cwd: home, log: installLog })
  if (uvTry.code === 0) {
    for (const index of MIRRORS) {
      appendFileSync(installLog, `\n--- uv pip @ ${index} ---\n`, 'utf8')
      const r = await run('uv', ['pip', 'install', '--python', venvPython(home), '-r', req], {
        cwd: home, log: installLog, env: { UV_DEFAULT_INDEX: index, UV_INDEX_URL: index },
      })
      if (r.code === 0) { ok = true; break }
    }
  }
  if (!ok) {
    const v = await run(py, ['-m', 'venv', join(home, '.venv')], { cwd: home, log: installLog })
    if (v.code === 0) {
      const pip = venvPython(home)
      for (const index of MIRRORS) {
        appendFileSync(installLog, `\n--- pip @ ${index} ---\n`, 'utf8')
        const r = await run(pip, ['-m', 'pip', 'install', '-r', req, '-i', index], { cwd: home, log: installLog })
        if (r.code === 0) { ok = true; break }
      }
    } else {
      appendFileSync(installLog, `venv 创建失败：${v.error || v.code}\n`, 'utf8')
    }
  }
  if (ok) {
    saveCfg(home, { pythonPath: venvPython(home) })
    writeFileSync(join(home, 'env.json'), JSON.stringify({
      ok: true, at: new Date().toISOString(), python: venvPython(home),
    }, null, 2), 'utf8')
  }
  appendFileSync(installLog, `=== ${new Date().toISOString()} ${ok ? '装完了' : '装失败'} ===\n`, 'utf8')
  return ok
}

/** 与传输无关的业务实现：入参是已解析的 path/query/body，返回 { status, body } */
export function createApi({ home, toolset, log = () => {}, ctx }) {
  const jobs = new Map()
  let installJob = null
  const cfgNow = () => loadCfg(home)

  async function status() {
    const cfg = cfgNow()
    const cred = readJson(join(home, 'credential.json'), null)
    const root = resolveSaveRoot(cfg, home)
    const probe = probeDir(root)
    const st = readJson(join(home, 'state.json'), {})
    const all = readAll(home)
    return {
      ok: true,
      version: '1.1.3',
      auth: {
        state: cred?.refreshToken ? 'ok' : 'none',
        userId: cred?.userId || null,
        pixivId: cred?.pixivId || cfg.pixivId || null,
        updatedAt: cred?.updatedAt || null,
      },
      env: {
        python: cfg.pythonPath, venv: existsSync(venvPython(home)),
        saveRoot: root, saveRootWritable: probe.ok,
        freeGB: probe.free ? +(probe.free / 1e9).toFixed(1) : null,
        error: probe.ok ? null : probe.error,
      },
      today: {
        saved: all.filter((e) => e.action === 'saved' && e.day === dayKey()).length,
        quota: cfg.perDay,
      },
      round: st.round || null,
      last: st.last || null,
      workspace: workspaceStatus(cfg, home),
      hub: (() => {
        const dir = findHubDir()
        const acc = hubAccounts(home)
        return { installed: Boolean(dir), dir: dir || null, accounts: acc.accounts || [], note: acc.note || null }
      })(),
      unsynced: unsyncedKeys(home),
      services: serviceReport(ctx, ['workspaceRegistry', 'sessionPersistence', 'llm', 'connection', 'sessions']),
      logTail: tailLog(home, 12),
    }
  }

  async function saveConfig(body) {
    const patch = {}
    for (const k of Object.keys(body || {})) if (CONFIG_KEYS.includes(k)) patch[k] = body[k]
    if (!Object.keys(patch).length) return { status: 400, body: { ok: false, error: '没有可保存的字段' } }

    // 换保存位置：整棵树一起搬（allwork + 各标签文件夹），搬完重建快捷方式
    let moved = null
    if ('saveRoot' in patch) {
      const before = cfgNow()
      const from = resolveSaveRoot(before, home)
      const to = String(patch.saveRoot || '').trim() || join(home, 'Download')
      if (from !== to) {
        try {
          moved = moveLibrary({ from, to })
        } catch (e) {
          return { status: 500, body: { ok: false, error: `搬目录失败：${e?.message ?? e}` } }
        }
      }
    }

    const next = saveCfg(home, patch)
    toolset?.invalidateCfg?.()
    if (moved) {
      try {
        const rep = repairLibrary({ cfg: next, home, keepMissing: true })
        moved.repaired = rep.repaired.length
        moved.removed = rep.removed.length
        moved.needRestore = rep.needRestore.length
      } catch (e) { moved.repairError = String(e?.message ?? e) }
    }
    // 工作区相关设置改了要重新注册（目录可能变了 / 开关刚打开）
    if ('workspaceDir' in patch || 'notifyWorkspace' in patch) {
      ensureWorkspace(ctx, home, next).then((r) => log(`工作区：${r.ok ? r.path : r.note}`)).catch(() => {})
    }
    const sync = await syncToHost(ctx, patch).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }))
    if (!sync.ok) markUnsynced(home, Object.keys(patch), sync.reason)
    return { status: 200, body: { ok: true, config: next, moved, synced: sync.ok, syncError: sync.ok ? null : sync.reason } }
  }

  /**
   * 把 config.json 里的现值整体推一遍到 DSH 原生设置。
   * 面板顶部的「保存更改」按钮调它 —— 平时每改一项就已经存盘了，这里是「补推 + 补同步」。
   */
  async function syncConfig() {
    const cfg = cfgNow()
    const patch = {}
    for (const k of CONFIG_KEYS) if (k in cfg) patch[k] = cfg[k]
    const keys = Object.keys(patch)
    const sync = await syncToHost(ctx, patch).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }))
    if (sync.ok) {
      clearUnsynced(home)
      log(`已把 ${keys.length} 项配置推给 DSH 原生设置`)
      return { status: 200, body: { ok: true, synced: true, keys: keys.length } }
    }
    markUnsynced(home, keys, sync.reason)
    return {
      status: 200,
      body: { ok: false, synced: false, keys: keys.length, reason: sync.reason, unsynced: unsyncedKeys(home) },
    }
  }

  async function startLogin(body) {
    const id = `login-${Date.now().toString(36)}`
    const job = { id, state: 'running', step: '准备中', message: '', at: Date.now() }
    jobs.set(id, job)
    const mode = body.mode || 'edge'
    const done = (async () => {
      try {
        if (mode === 'token') {
          job.step = '校验 refresh_token'
          const r = await loginWithToken({ refreshToken: body.refreshToken, home })
          Object.assign(job, { state: 'ok', step: '完成', userId: r.userId, pixivId: r.pixivId })
          saveCfg(home, { authState: 'ok', pixivId: r.pixivId || cfgNow().pixivId })
          return
        }
        job.step = '启动浏览器'
        const r = await loginWithBrowser({
          mode, pixivId: body.pixivId, password: body.password, home,
          onStep: (s) => { job.step = s },
        })
        if (r.ok) {
          Object.assign(job, { state: 'ok', step: '完成', userId: r.credential?.userId, pixivId: r.credential?.pixivId })
          saveCfg(home, { authState: 'ok', pixivId: r.credential?.pixivId || cfgNow().pixivId })
        } else {
          Object.assign(job, { state: r.state === 'captcha' ? 'captcha' : 'failed', step: '失败', message: r.message })
          saveCfg(home, { authState: 'expired' })
        }
      } catch (e) {
        Object.assign(job, { state: 'failed', message: String(e?.message ?? e).slice(0, 300) })
      } finally {
        job.doneAt = Date.now()
        job.password = undefined
      }
    })()
    done.catch(() => {})
    return { status: 200, body: { ok: true, jobId: id } }
  }

  /** 路由表：path → { methods, handler(query, body) } */
  const routes = {
    '/ping': { methods: ['GET'], handler: async () => ({ status: 200, body: { ok: true, plugin: 'pixiv-duty' } }) },
    '/status': { methods: ['GET'], handler: async () => ({ status: 200, body: await status() }) },
    '/config': {
      methods: ['GET', 'POST'],
      handler: async (_q, body) => {
        if (body === undefined) return { status: 200, body: { ok: true, config: cfgNow(), keys: CONFIG_KEYS } }
        return saveConfig(body)
      },
    },
    // 把当前配置整体推一遍到 DSH 原生设置（面板顶部「保存更改」按钮）
    '/config/sync': {
      methods: ['POST'],
      handler: async () => syncConfig(),
    },
    // 作品库：台账 + 快照比对（数目/字节）+ 修复 / 回滚 / 恢复
    '/library': {
      methods: ['GET'],
      handler: async () => {
        const cfg = cfgNow()
        const a = auditLibrary({ cfg, home })
        const d = diffLibrary({ cfg, home })
        const snap = readSnapshot({ cfg, home })
        return {
          status: 200,
          body: {
            ok: true,
            ...a,
            bytes: treeSize(a.allwork),
            page: pageFile(cfg, home, latestRound(cfg, home) || ''),
            guard: cfg.libGuard,
            guardWaitSec: cfg.guardWaitSec,
            snapshot: {
              at: snap?.at || '',
              dirs: d.dirs,
              bytes: d.bytes,
              prevDirs: d.prevDirs ?? null,
              prevBytes: d.prevBytes ?? null,
              matched: d.ok,
              missing: d.missing.length,
              shrunk: d.shrunk.length,
              added: d.added,
            },
            history: listPicksHistory({ cfg, home, limit: 8 }),
            cacheDays: cfg.cacheDays,
            deleteRecordDays: cfg.deleteRecordDays,
          },
        }
      },
    },
    '/library/rollback': {
      methods: ['POST'],
      handler: async () => {
        const cfg = cfgNow()
        const r = await rollbackLibrary({ cfg, home, restore: (x) => toolset.restore(x), log })
        return { status: 200, body: { ...r, audit: auditLibrary({ cfg, home }) } }
      },
    },
    '/library/repair': {
      methods: ['POST'],
      handler: async () => {
        const cfg = cfgNow()
        const r = repairLibrary({ cfg, home })
        return { status: 200, body: { ok: true, ...r, audit: auditLibrary({ cfg, home }) } }
      },
    },
    // 误删恢复：把台账里记着、磁盘上没有的作品重下一遍（不占每日额度）
    '/library/restore': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const limit = Math.max(1, Math.min(30, Number(body?.limit) || 10))
        const r = await toolset.restore({ limit })
        return { status: 200, body: { ...r, audit: auditLibrary({ cfg: cfgNow(), home }) } }
      },
    },
    '/following/refresh': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const r = await toolset.following({ force: Boolean(body?.force ?? true) })
        return { status: 200, body: { ok: r.ok, total: r.total, at: r.at, error: r.error } }
      },
    },
    '/preview': {
      methods: ['GET'],
      handler: async () => {
        const cfg = cfgNow()
        const round = latestRound(cfg, home)
        return {
          status: 200,
          body: {
            ok: true,
            origin: previewState.origin,
            port: previewState.port,
            error: previewState.error,
            round,
            url: previewUrlFor(round),
          },
        }
      },
    },
    '/preview/open': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const cfg = cfgNow()
        const round = String(body?.round || '').trim() || latestRound(cfg, home)
        const url = previewUrlFor(round) || (round ? pageFile(cfg, home, round) : null)
        if (!url) return { status: 404, body: { ok: false, error: '还没有任何一轮' } }
        openInBrowser(url)
        return { status: 200, body: { ok: true, url, origin: previewState.origin } }
      },
    },
    '/run': {
      methods: ['POST'],
      handler: async () => {
        const cfg = cfgNow()
        const vision = await checkVision(ctx, cfg)
        if (!vision.ok) return { status: 409, body: { ok: false, error: vision.error } }

        // 渠道前置校验：说清"宿主没有这个渠道"与"hub 渠道没开开关"两种情况，
        // 免得跑一轮才在子进程里报 NO_ADAPTER
        if (cfg.agentProvider) {
          if (!cfg.agentModel) return { status: 409, body: { ok: false, error: `选了渠道 ${cfg.agentProvider} 却没选模型` } }
          const catalog = await listModels(ctx)
          const hit = (catalog.providers || []).find((p) => p.id === cfg.agentProvider)
          if (!hit) {
            return {
              status: 409,
              body: {
                ok: false,
                error: `宿主里没有渠道 ${cfg.agentProvider}；当前可选：${(catalog.providers || []).map((p) => p.id).join(', ') || '（空）'}`,
              },
            }
          }
          if (HUB_PROVIDERS.has(cfg.agentProvider) && !cfg.useHubChannel) {
            return {
              status: 409,
              body: { ok: false, error: `${cfg.agentProvider} 是 Jet Hub 渠道，请先打开「启用 Jet Hub 渠道」开关（headless 里要加载它）` },
            }
          }
        }
        const rid = `${dayKey()}-${Date.now().toString(36)}`
        const since = Date.now()
        const r = await runRound({
          home, cfg, roundId: rid, why: 'manual', log,
          restore: (x) => toolset.restore(x),
          onExit: (info) => {
            log(`一轮收尾：${JSON.stringify(info).slice(0, 300)}`)
            // 会话跑在工作区目录里，跑完必须显式挂进去，否则 UI 归到「未分组」
            adoptSessions(ctx, { home, cfg: cfgNow(), since, log })
              .then((x) => { if (!x.ok) log(`会话归组跳过：${x.note}`) })
              .catch((e) => log(`会话归组异常：${e?.message ?? e}`))
          },
        })
        if (!r.started) return { status: 409, body: { ok: false, error: r.error } }
        return { status: 200, body: { ok: true, ...r } }
      },
    },
    '/preflight': {
      methods: ['GET'],
      handler: async () => ({ status: 200, body: { ok: true, vision: await checkVision(ctx, cfgNow()) } }),
    },
    '/agents': {
      methods: ['GET'],
      handler: async () => ({ status: 200, body: { ok: true, profiles: listProfiles(), ...(await listModels(ctx)) } }),
    },
    '/login': { methods: ['POST'], handler: async (_q, body) => startLogin(body || {}) },
    '/login/poll': {
      methods: ['GET'],
      handler: async (query) => {
        const job = jobs.get(query.get('jobId'))
        if (!job) return { status: 404, body: { ok: false, error: '没有这个登录任务（可能已过期）' } }
        return {
          status: 200,
          body: {
            ok: true, state: job.state, step: job.step, message: job.message,
            userId: job.userId ?? null, pixivId: job.pixivId ?? null,
          },
        }
      },
    },
    '/login/cancel': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const job = jobs.get(body?.jobId)
        if (job && job.state === 'running') Object.assign(job, { state: 'failed', message: '用户取消' })
        return { status: 200, body: { ok: true } }
      },
    },
    '/install': {
      methods: ['POST'],
      handler: async () => {
        if (installJob?.running) return { status: 409, body: { ok: false, error: '已经在装了' } }
        installJob = { running: true, at: Date.now() }
        installDeps({ home, cfg: cfgNow() })
          .then((ok) => { installJob = { running: false, ok, at: Date.now() }; log(`装依赖：${ok ? '成功' : '失败'}`) })
          .catch((e) => { installJob = { running: false, ok: false, error: String(e?.message ?? e) } })
        return { status: 200, body: { ok: true, started: true, log: join(home, 'install.log') } }
      },
    },
    '/install/status': {
      methods: ['GET'],
      handler: async () => ({ status: 200, body: { ok: true, job: installJob || { running: false }, logTail: tailLog(home, 5) } }),
    },
    '/report': {
      methods: ['GET'],
      handler: async (query) => {
        const day = query.get('day') || dayKey()
        const f = join(home, 'out', `${day}.md`)
        return { status: 200, body: { ok: true, day, file: f, text: existsSync(f) ? readFileSync(f, 'utf8') : '' } }
      },
    },
    '/seen': {
      methods: ['GET'],
      handler: async (query) => {
        const limit = Number(query.get('limit') || 50)
        return { status: 200, body: { ok: true, rows: readAll(home).slice(-limit).reverse(), markdown: exportMarkdown(home, limit) } }
      },
    },
    /** 候选预览页的数据源（面板里那一栏「待你点头」） */
    '/picks': {
      methods: ['GET'],
      handler: async (query) => {
        const cfg = cfgNow()
        const want = String(query.get('round') || '').trim()
        const rid = want || latestRound(cfg, home)
        const data = rid ? loadCandidates(cfg, home, rid) : { items: [], note: '', createdAt: null }
        const rounds = []
        try {
          const root = picksRoot(cfg, home)
          for (const e of readdirSync(root)) {
            if (!/\.html$/i.test(e)) continue
            const p = join(root, e)
            let t = 0
            try { t = statSync(p).mtimeMs } catch { continue }
            rounds.push({ round: e.replace(/\.html$/i, ''), page: p, at: new Date(t).toISOString() })
          }
        } catch { /* 还没有 picks 目录 */ }
        rounds.sort((a, b) => String(b.at).localeCompare(String(a.at)))
        return {
          status: 200,
          body: {
            ok: true,
            round: rid,
            page: rid ? pageFile(cfg, home, rid) : null,
            slug: rid ? roundSlug(rid) : null,
            note: data.note || '',
            createdAt: data.createdAt || null,
            items: data.items || [],
            rounds: rounds.slice(0, 12),
          },
        }
      },
    },
    /** 在默认浏览器里打开某一轮的预览页（file:// 直接能开，缩略图是相对路径） */
    '/picks/open': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const cfg = cfgNow()
        const rid = String(body?.round || '').trim() || latestRound(cfg, home)
        if (!rid) return { status: 404, body: { ok: false, error: '还没有任何一轮的预览页' } }
        const page = pageFile(cfg, home, rid)
        if (!existsSync(page)) return { status: 404, body: { ok: false, error: `预览页不存在：${page}` } }
        try {
          if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', page], { detached: true, stdio: 'ignore', windowsVerbatimArguments: false }).unref()
          else if (process.platform === 'darwin') spawn('open', [page], { detached: true, stdio: 'ignore' }).unref()
          else spawn('xdg-open', [page], { detached: true, stdio: 'ignore' }).unref()
        } catch (e) {
          return { status: 500, body: { ok: false, error: String(e?.message ?? e) } }
        }
        return { status: 200, body: { ok: true, page } }
      },
    },
    /** 面板里点「入库」：真正下载他点头的那几件 */
    '/picks/approve': {
      methods: ['POST'],
      handler: async (_q, body) => {
        if (!toolset?.approve) return { status: 501, body: { ok: false, error: '这个版本没有 approve 实现' } }
        const items = Array.isArray(body?.items) ? body.items : []
        if (!items.length) return { status: 400, body: { ok: false, error: '没选任何一件' } }
        log(`点头入库：round=${body?.round || '(最近一轮)'} items=${items.join(',')}`)
        const r = await toolset.approve({ items, round: body?.round, note: body?.note || '面板按钮' })
        return { status: 200, body: r }
      },
    },
    // 清出没点头的暂存（用户规矩：没点头的图不许留在他电脑上）
    '/picks/purge': {
      methods: ['POST'],
      handler: async (_q, body) => {
        if (!toolset?.purgePending) return { status: 501, body: { ok: false, error: '这个版本没有 purge 实现' } }
        const r = await toolset.purgePending({ round: body?.round })
        log(`清出未点头的暂存：round=${body?.round || '(最近一轮)'} 删了 ${r.removed} 件`)
        return { status: 200, body: r }
      },
    },
    '/open': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const cfg = cfgNow()
        const target = body?.target === 'root' ? resolveSaveRoot(cfg, home)
          : body?.target === 'out' ? join(home, 'out')
            : body?.target === 'picks' ? picksRoot(cfg, home)
              : body?.target === 'workspace' ? workspaceDirOf(cfg, home)
                : home
        try { mkdirSync(target, { recursive: true }) } catch { /* 忽略 */ }
        if (process.platform === 'win32') spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
        return { status: 200, body: { ok: true, target } }
      },
    },
    /* 系统「选文件夹」对话框：开一个 job 后立刻返回 id，前端轮询状态。
       直接同步等会把宿主网关拖超时（用户可能让对话框开着去泡茶）。 */
    '/pick-dir': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const id = randomBytes(5).toString('hex')
        pickJobs.set(id, { at: Date.now(), status: 'waiting', path: '', error: '' })
        pickDirectory({ initial: body?.initial || '', title: body?.title || '选择作品库根目录' })
          .then((r) => {
            const j = pickJobs.get(id)
            if (!j) return
            if (r.ok) { j.status = 'ok'; j.path = r.path } else { j.status = r.cancelled ? 'cancelled' : 'failed'; j.error = r.error || '' }
          })
          .catch((e) => {
            const j = pickJobs.get(id)
            if (j) { j.status = 'failed'; j.error = String(e?.message || e) }
          })
        // 顺手清掉 10 分钟前的老 job
        const cutoff = Date.now() - 600_000
        for (const [k, v] of pickJobs) if (v.at < cutoff) pickJobs.delete(k)
        return { status: 200, body: { ok: true, id } }
      },
    },
    '/pick-dir/status': {
      methods: ['GET'],
      handler: async (q) => {
        const id = String(q?.get?.('id') || '')
        const j = pickJobs.get(id)
        if (!j) return { status: 200, body: { ok: false, status: 'gone', error: '这次选择已经过期了，再点一次' } }
        return { status: 200, body: { ok: true, status: j.status, path: j.path, error: j.error } }
      },
    },
    '/check': {
      methods: ['POST'],
      handler: async () => {
        const cfg = cfgNow()
        const steps = []
        const cred = readJson(join(home, 'credential.json'), null)
        steps.push({ name: '凭证', ok: Boolean(cred?.refreshToken), detail: cred?.userId || '未登录' })
        const r = await run(cfg.pythonPath || 'python', ['-c', 'import pixivpy3, PIL, mcp; print("ok")'],
          { cwd: home, log: join(home, 'install.log') })
        steps.push({ name: 'Python 依赖', ok: r.code === 0, detail: r.code === 0 ? 'pixivpy3 / Pillow / mcp 都在' : '缺包，先点【装依赖】' })
        const probe = probeDir(resolveSaveRoot(cfg, home))
        steps.push({ name: '保存目录', ok: probe.ok, detail: probe.ok ? resolveSaveRoot(cfg, home) : String(probe.error) })
        return { status: 200, body: { ok: steps.every((s) => s.ok), steps } }
      },
    },
  }

  return {
    routes,
    async handle(method, path, query, body) {
      const route = routes[path]
      if (!route) return { status: 404, body: { ok: false, error: `没有这个接口：${method} ${path}` } }
      if (!route.methods.includes(method)) return { status: 405, body: { ok: false, error: `${path} 不支持 ${method}` } }
      return route.handler(query, body)
    },
  }
}

function sendNode(res, code, value) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function foreignOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return false
  try { return new URL(origin).host !== String(req.headers.host || '') } catch { return true }
}

export function registerHttp(ctx, deps) {
  const api = createApi({ ...deps, ctx })
  const disposers = []
  const log = deps.log || (() => {})

  // ① 桌面/Web 通用：connection.fetch 的精确路由（必须在 /api 下）
  //     ⚠️ ctx.connection 未 inject 时会抛错，必须走 svc()（属性 + ctx.get 分开试）
  let fetchHost
  try { fetchHost = svc(ctx, 'connection')?.fetch } catch { fetchHost = undefined }
  if (fetchHost?.register) {
    for (const [path, route] of Object.entries(api.routes)) {
      const full = `${API_BASE}${path}`
      try {
        const dispose = fetchHost.register({
          path: full,
          methods: route.methods,
          requestBody: route.methods.some((m) => m !== 'GET' && m !== 'HEAD') ? 'buffered' : 'none',
          fetch: async (request) => {
            try {
              const url = new URL(request.url)
              const isPost = request.method !== 'GET' && request.method !== 'HEAD'
              let body
              if (isPost) {
                try { body = await request.json() } catch { body = {} }
              }
              const r = await api.handle(request.method, path, url.searchParams, isPost ? (body ?? {}) : undefined)
              return new Response(JSON.stringify(r.body), {
                status: r.status,
                headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
              })
            } catch (e) {
              log(`fetch 路由 ${path} 失败：${e?.message ?? e}`)
              return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
                status: 500, headers: { 'content-type': 'application/json; charset=utf-8' },
              })
            }
          },
        })
        disposers.push(dispose)
      } catch (e) {
        log(`注册 fetch 路由 ${full} 失败：${e?.message ?? e}`)
      }
    }
    log(`connection.fetch 路由已挂载 ${API_BASE}/*`)
  }

  // ② Web：传统前缀路由（源码模式 / 老宿主）
  if (ctx.webServer?.register) {
    try {
      const dispose = ctx.webServer.register({
        kind: 'prefix',
        path: LEGACY_PREFIX,
        handler: async (req, res) => {
          if (foreignOrigin(req)) { res.statusCode = 403; res.end('forbidden'); return }
          const url = new URL(req.url || '/', 'http://localhost')
          const path = url.pathname.startsWith(LEGACY_PREFIX) ? url.pathname.slice(LEGACY_PREFIX.length) || '/' : url.pathname
          const method = (req.method || 'GET').toUpperCase()
          let body
          if (method === 'POST') {
            body = await new Promise((resolve) => {
              let size = 0
              const chunks = []
              req.on('data', (c) => {
                size += c.length
                if (size > MAX_BODY) { resolve({}); req.destroy(); return }
                chunks.push(c)
              })
              req.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8')
                try { resolve(text ? JSON.parse(text) : {}) } catch { resolve({}) }
              })
              req.on('error', () => resolve({}))
            })
          }
          const started = Date.now()
          try {
            const r = await api.handle(method, path, url.searchParams, body)
            sendNode(res, r.status, r.body)
            log(`HTTP ${method} ${path} -> ${r.status} ${Date.now() - started}ms`)
          } catch (e) {
            log(`HTTP ${method} ${path} 失败：${e?.message ?? e}`)
            sendNode(res, 500, { ok: false, error: String(e?.message ?? e).slice(0, 300) })
          }
        },
      })
      disposers.push(dispose)
      log(`webServer 前缀路由已挂载 ${LEGACY_PREFIX}`)
    } catch (e) {
      log(`注册 webServer 路由失败：${e?.message ?? e}`)
    }
  }

  return {
    prefix: API_BASE,
    dispose() {
      for (const d of disposers) { try { d?.() } catch { /* 忽略 */ } }
    },
  }
}
