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
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { loadCfg, saveCfg, syncToHost, markUnsynced, unsyncedKeys, resolveSaveRoot, CONFIG_KEYS } from './config.mjs'
import { appendLog, dayKey, tailLog, readJson } from './state.mjs'
import { runRound } from './runner.mjs'
import { listProfiles, listModels, checkVision, HUB_PROVIDERS } from './agents.mjs'
import { loginWithBrowser, loginWithToken } from './login-pixiv.mjs'
import { probeDir } from './save.mjs'
import { readAll, exportMarkdown } from './seen.mjs'
import { ensureWorkspace, workspaceStatus, workspaceDirOf, adoptSessions, findHubDir, hubAccounts } from './workspace.mjs'
import { svc, serviceReport } from './svc.mjs'

const API_BASE = '/api/pixiv-duty'
const LEGACY_PREFIX = '/pixiv-duty/api'
const MAX_BODY = 1024 * 1024

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
function createApi({ home, toolset, log = () => {}, ctx }) {
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
    const next = saveCfg(home, patch)
    toolset?.invalidateCfg?.()
    // 工作区相关设置改了要重新注册（目录可能变了 / 开关刚打开）
    if ('workspaceDir' in patch || 'notifyWorkspace' in patch) {
      ensureWorkspace(ctx, home, next).then((r) => log(`工作区：${r.ok ? r.path : r.note}`)).catch(() => {})
    }
    const sync = await syncToHost(ctx, patch).catch((e) => ({ ok: false, reason: String(e?.message ?? e) }))
    if (!sync.ok) markUnsynced(home, Object.keys(patch), sync.reason)
    return { status: 200, body: { ok: true, config: next, synced: sync.ok, syncError: sync.ok ? null : sync.reason } }
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
        const r = runRound({
          home, cfg, roundId: rid, why: 'manual', log,
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
    '/open': {
      methods: ['POST'],
      handler: async (_q, body) => {
        const cfg = cfgNow()
        const target = body?.target === 'root' ? resolveSaveRoot(cfg, home)
          : body?.target === 'out' ? join(home, 'out')
            : body?.target === 'workspace' ? workspaceDirOf(cfg, home)
              : home
        try { mkdirSync(target, { recursive: true }) } catch { /* 忽略 */ }
        if (process.platform === 'win32') spawn('explorer', [target], { detached: true, stdio: 'ignore' }).unref()
        else if (process.platform === 'darwin') spawn('open', [target], { detached: true, stdio: 'ignore' }).unref()
        else spawn('xdg-open', [target], { detached: true, stdio: 'ignore' }).unref()
        return { status: 200, body: { ok: true, target } }
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
