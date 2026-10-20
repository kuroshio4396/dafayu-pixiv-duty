/**
 * selfcheck.mjs —— 本地预检：两个半端都真跑一遍，不靠"重启一次才知道错哪"
 * ============================================================================
 * 用法：`node selfcheck.mjs`（不需要解析钩子；本插件不裸 import @deepseek-ai/*）
 * 退出码：0 = 全过；1 = 有问题
 *
 * 覆盖的东西，都是**真机上"整条插件不激活"的成因**：
 *   · 工具 schema 里漏写 additionalProperties  → defineTool 抛错 → entry 不激活
 *   · Config 没有 volatile 字段                 → 设置面板不出现、update 抛错
 *   · entry id ≠ 设置 ns ≠ 家目录名             → 设置改了不生效
 *   · client 的 id ≠ 包名                        → 设置页加载不出来
 * ============================================================================
 */
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync,
  readdirSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(tmpdir(), 'dsh-pixiv-scroll-selfcheck')

let failures = 0
let checks = 0

function ok(msg) { checks++; console.log(`  ✓ ${msg}`) }
function bad(msg, e) {
  checks++; failures++
  console.error(`  ✗ ${msg}`)
  if (e) console.error(`    ${e?.name || 'Error'}: ${e?.message || e}`)
}
function group(name) { console.log(`\n${name}`) }
function must(cond, msg, e) { cond ? ok(msg) : bad(msg, e) }

function assert(cond, msg) { if (!cond) throw new Error(msg) }

/* ────────────── 假 ctx ────────────── */

function fakeCtx(dshHome, { withSlots = false } = {}) {
  const tools = new Map()
  const disposers = []
  const routes = []
  const ctx = {
    tools: {
      register(t) {
        if (!t?.name) throw new Error('工具没有 name')
        if (tools.has(t.name)) throw new Error(`工具重名：${t.name}`)
        tools.set(t.name, t)
        return () => tools.delete(t.name)
      },
    },
    webServer: {
      register(r) {
        if (routes.some((x) => x.kind === r.kind && x.path === r.path)) {
          throw new Error(`路由重复注册：${r.kind} ${r.path}`)
        }
        routes.push(r)
        return () => { const i = routes.indexOf(r); if (i >= 0) routes.splice(i, 1) }
      },
    },
    connection: { requestRejection: () => undefined },
    settings: { update: async () => ({}) },
    logger: () => ({ info() {}, error() {}, warn() {} }),
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    get(k) {
      if (k === 'dshHomePath') return (...seg) => join(dshHome, ...seg)
      if (k === 'slots') return withSlots ? slots : undefined
      return undefined
    },
  }
  const slots = {
    registered: [],
    inject(key, fn) { return fn() },
    register(def, comp) { slots.registered.push({ ...def, comp }); return () => {} },
  }
  return { ctx, tools, disposers, routes, slots }
}

/* ────────────── schema 走查 ────────────── */

function walkSchema(node, where, problems) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((n, i) => walkSchema(n, `${where}[${i}]`, problems)); return }
  if (node.type === 'object' && node.additionalProperties === undefined) {
    problems.push(`${where} 是 object 却没写 additionalProperties`)
  }
  for (const [k, v] of Object.entries(node.properties || {})) walkSchema(v, `${where}.properties.${k}`, problems)
  if (node.items) walkSchema(node.items, `${where}.items`, problems)
  if (node.oneOf) walkSchema(node.oneOf, `${where}.oneOf`, problems)
}

/* ────────────── 开始 ────────────── */

rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })
const DSH_HOME = join(SANDBOX, 'home')
mkdirSync(DSH_HOME, { recursive: true })
process.env.DSH_HOME = DSH_HOME

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
console.log(`dsh-pixiv-scroll selfcheck · v${pkg.version}`)
console.log(`包目录：${ROOT}`)
console.log(`沙箱家目录：${DSH_HOME}`)

let hostMod = null
let hostCtx = null

/* 1. host 半端 */
group('① host 半端：在假 ctx 上真跑 apply()')
try {
  hostMod = await import('./index.js')
  must(hostMod.name === 'pixiv-duty', `name = ${hostMod.name}（应等于 cordis entry id / 设置 ns）`)
  must(Array.isArray(hostMod.inject) && hostMod.inject.includes('webServer') && hostMod.inject.includes('tools'),
    `inject = ${JSON.stringify(hostMod.inject)}`)
  must(Boolean(hostMod.Config), 'Config 已导出（schemastery 从宿主树取到）')

  const f = fakeCtx(DSH_HOME)
  hostCtx = f
  hostMod.apply(f.ctx, { enabled: true })
  ok('apply() 没抛错')

  const names = [...f.tools.keys()]
  must(names.length === 13, `注册了 ${names.length} 个工具（应为 13）：${names.join(", ")}`)
  must(names.every((n) => n.startsWith('pixiv_')), '所有工具都以 pixiv_ 前缀')
  must(f.routes.some((r) => r.path === '/pixiv-duty/api'), 'HTTP 前缀 /pixiv-duty/api 已注册')
} catch (e) { bad('host 半端不可用', e) }

/* 2. 工具契约 */
group('② 工具契约：schema 递归检查')
try {
  assert(hostCtx, '前一步没有拿到 ctx')
  for (const [name, t] of hostCtx.tools) {
    const problems = []
    if (!t.description) problems.push('没有 description')
    const params = t.parameters || {}
    // 参数根是「隐式开放 object」，宿主规定不写 additionalProperties；
    // 只对根下面的每个属性做递归检查。
    if (params.type === 'object') {
      for (const [k, v] of Object.entries(params.properties || {})) {
        if (!v?.type) problems.push(`参数 ${k} 没有 type`)
        walkSchema(v, `parameters.${k}`, problems)
      }
    } else {
      for (const [k, v] of Object.entries(params)) {
        if (!v?.type) problems.push(`参数 ${k} 没有 type`)
        walkSchema(v, `parameters.${k}`, problems)
      }
    }
    walkSchema(t.output?.schema, 'output.schema', problems)
    if (typeof t.output?.render !== 'function') problems.push('没有 output.render')
    if (typeof t.execute !== 'function') problems.push('没有 execute')
    must(problems.length === 0, `${name} 契约完整${problems.length ? '：' + problems.join('; ') : ''}`, problems[0])
  }
} catch (e) { bad('工具契约检查失败', e) }

/* 3. Config */
group('③ Config：字段与 volatile')
try {
  const C = hostMod?.Config
  assert(C, '没有 Config')
  const dict = C.dict || {}
  const { SPEC, DEFAULTS } = await import('./lib/config.mjs')
  const specKeys = Object.keys(SPEC).sort()
  const dictKeys = Object.keys(dict).sort()
  must(JSON.stringify(specKeys) === JSON.stringify(dictKeys), `SPEC 与 Config 键集一致（${specKeys.length} 个）`)

  const noVolatile = specKeys.filter((k) => dict[k]?.meta?.volatile !== true)
  must(noVolatile.length === 0, `全部字段 volatile${noVolatile.length ? '，缺：' + noVolatile.join(',') : ''}`)

  const defMismatch = specKeys.filter((k) => {
    const a = dict[k]?.meta?.default
    const b = DEFAULTS[k]
    return JSON.stringify(a) !== JSON.stringify(b)
  })
  must(defMismatch.length === 0, `默认值与 DEFAULTS 一致${defMismatch.length ? '，不一致：' + defMismatch.join(',') : ''}`)

  // 范围钳制：故意给超界值
  const { clampCfg, pickSeed } = await import('./lib/config.mjs')
  const empty = clampCfg({})
  const drift = Object.keys(DEFAULTS).filter((k) => JSON.stringify(empty[k]) !== JSON.stringify(DEFAULTS[k]))
  must(drift.length === 0, `clampCfg({{}}) 与默认值一致${drift.length ? '，漂移：' + drift.map((k) => `${k}=${JSON.stringify(empty[k])}`).join(', ') : ''}`)
  must(empty.zhRatio === 0.25, `zhRatio 不被四舍五入（${empty.zhRatio}）`)

  const c = clampCfg({ perDay: 9999, perRound: -5, days: 0, zhRatio: 9, dirTemplate: '../../etc', novelMode: 'wat' })
  must(c.perDay === 100 && c.perRound === 0 && c.days === 1 && c.zhRatio === 1,
    `钳制生效：perDay=${c.perDay} perRound=${c.perRound} days=${c.days} zhRatio=${c.zhRatio}`)
  must(c.dirTemplate === '{kind}/{artist}/{title}_{id}', `危险模板被拒绝：${c.dirTemplate}`)
  must(c.novelMode === 'auto', `非法枚举回落默认：${c.novelMode}`)

  // 首启种子：对象/函数一律不收（否则会写出 "[object Object]"）
  const seed = pickSeed({ pixivId: 'a@b.c', perDay: 5, keywords: ['x'], saveRoot: { bad: true }, dshBin: () => {} })
  must(seed.pixivId === 'a@b.c' && seed.perDay === 5 && !('saveRoot' in seed) && !('dshBin' in seed),
    `pickSeed 只收原始值：${JSON.stringify(seed)}`)

  // 新版字段：收藏区间 / 时间窗开关 / 小数匹配度 / 老配置迁移
  const r2 = clampCfg({ bookmarkMin: 500, bookmarkMax: 2000, daysOn: false, novelVibeMin: 0.35, novelVibe: '雨夜的电车' })
  must(r2.bookmarkMin === 500 && r2.bookmarkMax === 2000 && r2.daysOn === false,
    `收藏区间与时间窗开关可写入（${r2.bookmarkMin}–${r2.bookmarkMax}, daysOn=${r2.daysOn}）`)
  must(r2.novelVibeMin === 0.35, `novelVibeMin 不被取整（${r2.novelVibeMin}）`)
  must(r2.novelVibe === '雨夜的电车', 'novelVibe 原样保留')
  const migrated = clampCfg({ minBookmarks: 42 })
  must(migrated.bookmarkMin === 42, `老配置 minBookmarks 迁移为 bookmarkMin（${migrated.bookmarkMin}）`)
  must(migrated.bookmarkMax === 0, `上限默认 0 = 不限（${migrated.bookmarkMax}）`)
} catch (e) { bad('Config 检查失败', e) }

/* 3b. 模型目录：按渠道分组 */
group('③b 模型目录：按渠道分组（llm 服务）')
try {
  const { listModels, checkVision } = await import('./lib/agents.mjs')
  const fakeLlm = {
    listConfigurableProviders: async () => ([
      { provider: 'alpha', displayName: '渠道 A' },
      { provider: 'beta', displayName: '渠道 B' },
    ]),
    listModels: async (p) => (p === 'alpha'
      ? [{ id: 'vision-1', name: 'Vision One', inputModalities: ['text', 'image'] },
         { id: 'text-1', name: 'Text One', inputModalities: ['text'] }]
      : [{ id: 'b-1', name: 'b-1' }]),
    resolveModelInfo: async (_p, m) => ({ inputModalities: m === 'text-1' ? ['text'] : ['text', 'image'] }),
  }
  const fake = { get: (k) => (k === 'llm' ? fakeLlm : undefined) }
  const r = await listModels(fake)
  must(r.ok && r.providers.length === 2, `列出 ${r.providers.length} 个渠道`)
  must(r.providers[0].name === '渠道 A' && r.providers[0].models.length === 2, '渠道 A 名称与模型数正确')
  must(r.providers[0].models.find((m) => m.id === 'vision-1')?.image === true, 'vision-1 标记为可读图')
  must(r.providers[0].models.find((m) => m.id === 'text-1')?.image === false, 'text-1 标记为纯文本')
  must(r.providers[1].models[0].image === null, '未声明模态时标记为未知')

  const noImg = await checkVision(fake, { contentIllust: true, contentManga: false, agentProvider: 'alpha', agentModel: 'text-1' })
  must(noImg.ok === false, '纯文本模型 + 插画 会被视觉预检拦下')
  const onlyNovel = await checkVision(fake, { contentIllust: false, contentManga: false, agentProvider: 'alpha', agentModel: 'text-1' })
  must(onlyNovel.ok === true, '只跑小说时不做视觉预检')

  // Jet Hub 自 2026-10-01 起不声明 configurable provider —— 必须靠 listProviders 兜底
  const hubLike = {
    listConfigurableProviders: async () => [],
    listProviders: () => [{ id: 'buddy', name: 'CodeBuddy' }],
    listModels: async () => [{ id: 'cb-1', name: 'CB', inputModalities: ['text', 'image'] }],
  }
  const h = await listModels({ get: (k) => (k === 'llm' ? hubLike : undefined) })
  must(h.ok && h.providers[0].id === 'buddy' && h.providers[0].models.length === 1,
    '没有 configurable provider 时靠 listProviders 列出 Jet Hub 渠道')
} catch (e) { bad('模型目录检查失败', e) }

/* 3c. svc()：未 inject 时属性访问会抛，必须退回 ctx.get */
group('③c 服务取值：属性抛错也要能退回 ctx.get')
try {
  const { svc } = await import('./lib/svc.mjs')
  const registry = { create: async () => ({ sessionIds: [], attachSession: async () => {} }) }
  const map = { workspaceRegistry: registry, llm: { listModels: async () => [] } }
  // 模拟 cordis：未 inject 的服务属性访问直接抛错；ctx.get 正常
  const throwing = new Proxy({}, {
    get(_t, key) {
      if (key === 'get') return (n) => map[n]
      if (key === 'then') return undefined
      throw new Error(`cannot access '${String(key)}' without inject`)
    },
  })
  must(svc(throwing, 'workspaceRegistry') === registry, '属性抛错时 svc 仍能经 ctx.get 拿到服务')
  must(svc(throwing, 'nothing') === undefined, '拿不到的服务返回 undefined 而不是抛')

  // 同一个 ctx 喂给 listModels / adoptSessions，都要正常工作
  const { listModels } = await import('./lib/agents.mjs')
  const lm = await listModels(new Proxy({}, {
    get(_t, key) {
      if (key === 'get') return (n) => (n === 'llm' ? {
        listConfigurableProviders: async () => [{ provider: 'buddy', displayName: 'CodeBuddy' }],
        listModels: async () => [{ id: 'cb-1', name: 'CodeBuddy 1', inputModalities: ['text'] }],
      } : undefined)
      if (key === 'then') return undefined
      throw new Error('no inject')
    },
  }))
  must(lm.ok && lm.providers[0].id === 'buddy', `listModels 在抛错 ctx 下也能列出渠道（${lm.providers.length}）`)
} catch (e) { bad('svc 取值检查失败', e) }

/* 4. agent 半端 */group('④ agent 半端：只依赖 tools')
try {
  const home = join(DSH_HOME, 'pixiv-duty')
  mkdirSync(home, { recursive: true })
  const agent = await import('./agent.js')
  must(agent.name === 'pixiv-duty-agent', `name = ${agent.name}`)
  must(JSON.stringify(agent.inject) === JSON.stringify(['tools']), `inject = ${JSON.stringify(agent.inject)}（只应有 tools）`)
  const f = fakeCtx(DSH_HOME)
  agent.apply(f.ctx, { home, round: 'selfcheck' })
  const names = [...f.tools.keys()]
  must(names.length === 13, `agent 半端注册了 ${names.length} 个工具（应与 host 一致：13）`)
  f.disposers.reverse().forEach((d) => { try { d() } catch { /* 忽略 */ } })
} catch (e) { bad('agent 半端不可用', e) }

/* 5. client 半端 */
group('⑤ client 半端：自注册与 slot')
try {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  let captured = null
  globalThis.window = {
    __ModuleLoader__: { load: (def) => { captured = def } },
  }
  globalThis.document = {
    createElement: () => ({ textContent: '', remove() {} }),
    head: { appendChild() {} },
  }
  await import(`./client.js?selfcheck=${Date.now()}`)
  must(Boolean(captured), '调用了 window.__ModuleLoader__.load')
  must(captured.id === pkg.name, `client id = ${captured?.id}（应等于包名 ${pkg.name}）`)

  const React = {
    createElement: () => null,
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
  }
  const mod = captured.factory((name) => (name === 'react' ? React : {}))
  must(Array.isArray(mod.inject) && mod.inject.includes('slots'), `client inject = ${JSON.stringify(mod.inject)}`)

  const f = fakeCtx(DSH_HOME, { withSlots: true })
  mod.apply(f.ctx)
  const reg = f.slots.registered.find((r) => r.name === 'settings.section')
  must(Boolean(reg), '注册到了 settings.section')
  must(reg?.id === 'pixiv-duty', `slot id = ${reg?.id}（必须等于 entry id / 设置 ns）`)
  must(reg?.label === '刷Pixiv', `slot label = ${reg?.label}`)
  must(source.includes('[data-px-sw]'), '样式里包含开关选择器（防止 CSS 丢）')
} catch (e) { bad('client 半端不可用', e) }

/* 6. overlay / prompt */
group('⑥ 生成物：overlay 与 prompt')
try {
  const { buildOverlay, buildPrompt } = await import('./lib/runner.mjs')
  const y = buildOverlay({ home: 'C:/x/pixiv-duty', round: 'r1' })
  for (const key of ['- id: tool-bash', '- id: tool-pwsh', '- id: tool-web', '- id: tool-fs-search']) {
    must(y.includes(key) && y.includes('  disabled: true'), `${key} 被关掉`)
  }
  must(y.includes('write: false') && y.includes('edit: false'), 'tool-fs 的 write/edit 被关掉')
  must(/name: ".*agent\.js"/.test(y), 'overlay 用绝对路径挂 agent（headless profile 里不一定装了本包）')
  must(!y.includes('agent-default-model'), '没指定模型时不出 agent-default-model')
  const y2 = buildOverlay({ home: 'C:/x', round: 'r2', provider: 'p', model: 'm' })
  must(y2.includes('agent-default-model') && y2.includes('provider: "p"'), '指定模型时写出 agent-default-model')

  const { DEFAULTS, clampCfg } = await import('./lib/config.mjs')
  const cfg = clampCfg(DEFAULTS)
  const p = buildPrompt({
    cfg, roundId: 'r-abc', root: 'D:/Pixiv', left: 5,
    limits: { perRound: 3, maxCandidates: 40, maxImages: 6, maxPagesPerWork: 40 },
    charterPath: 'C:/x/pixiv-duty/duty.md',
  })
  must(p.includes('r-abc'), 'prompt 带 roundId')
  must(p.includes('D:/Pixiv'), 'prompt 带绝对保存路径')
  must(p.includes('C:/x/pixiv-duty/duty.md'), 'prompt 带章程绝对路径')
  must(!p.includes('<家目录>') && !p.includes('<home>'), 'prompt 里没有占位符残留')
  must(isAbsolute('D:/Pixiv') || /^[A-Za-z]:\//.test('D:/Pixiv'), '保存路径是绝对路径')
} catch (e) { bad('生成物检查失败', e) }

/* 7. 命名清洗 */
group('⑦ 命名清洗：Windows 边界')
try {
  const { sanitizeSegment, renderDir } = await import('./lib/save.mjs')
  const cases = [
    ['CON', '_CON'],
    ['a/b:c*?', 'a_b_c__'],
    ['name.', 'name'],
    ['  spaced  ', 'spaced'],
    ['', 'untitled'],
    ['..', 'untitled'],
  ]
  for (const [input, want] of cases) {
    const got = sanitizeSegment(input)
    must(got === want, `sanitize(${JSON.stringify(input)}) = ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`)
  }
  const long = sanitizeSegment('x'.repeat(200))
  must([...long].length <= 77, `超长标题截断到 ${[...long].length} 字（≤77）`)

  const dir = renderDir('{kind}/{artist}/{title}_{id}', {
    kind: 'manga', title: 'A/B', artist: 'CON', id: 42, rating: 'all',
  })
  must(dir.includes('_CON') && dir.includes('A_B') && dir.endsWith('A_B_42'), `模板渲染：${dir}`)
  must(!dir.includes(':') && !dir.includes('..'), '渲染结果里没有危险字符')
} catch (e) { bad('命名清洗检查失败', e) }

/* 7b. 工作区播报 */
group('⑦b 工作区播报：目录与三种状态')
try {
  const { workspaceDirOf } = await import('./lib/workspace.mjs')
  const tmpHome = join(SANDBOX, 'ws-home')
  mkdirSync(tmpHome, { recursive: true })
  must(workspaceDirOf({ workspaceDir: '' }, tmpHome) === join(tmpHome, 'workspace'), '默认工作区 = <家>/workspace')
  must(workspaceDirOf({ workspaceDir: 'D:/Pixiv/ws' }, tmpHome) === 'D:/Pixiv/ws', '绝对路径原样使用')
  must(workspaceDirOf({ workspaceDir: 'sub/dir' }, tmpHome).endsWith(join('sub', 'dir')), '相对路径拼到家目录')

  const { finalizeRound } = await import('./lib/runner.mjs')
  const { appendEntry } = await import('./lib/seen.mjs')
  const { DEFAULTS, clampCfg } = await import('./lib/config.mjs')
  const cfg0 = clampCfg({ ...DEFAULTS, workspaceDir: join(tmpHome, 'workspace') })

  const r0 = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-empty', code: 0 })
  must(r0.status === '搜寻无结果', `0 件 + code 0 ⇒ 搜寻无结果（实际 ${r0.status}）`)

  appendEntry(tmpHome, { id: 9001, kind: 'illust', action: 'saved', round: 'ws-one', title: 't', dir: join(tmpHome, 'not-real') })
  const r1 = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-one', code: 0 })
  must(r1.status === '下载成功', `有 1 件 ⇒ 下载成功（实际 ${r1.status}）`)

  const r2 = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-fail', code: 1 })
  must(r2.status === '下载失败', `code≠0 ⇒ 下载失败（实际 ${r2.status}）`)

  const st = JSON.parse(readFileSync(join(tmpHome, 'state.json'), 'utf8'))
  must(st.lastStatus?.status === '下载失败', 'state.json 里落了 lastStatus')
  must(existsSync(join(tmpHome, 'workspace', 'last-status.md')), '工作区里写了 last-status.md')
} catch (e) { bad('工作区播报检查失败', e) }

/* 7c. 会话归组 + Jet Hub 桥接 */
group('⑦c 会话归组：显式 attachSession；overlay 注入 hub')
try {
  const { adoptSessions, findHubDir, hubAccounts } = await import('./lib/workspace.mjs')
  const { buildOverlay } = await import('./lib/runner.mjs')
  const { clampCfg, DEFAULTS } = await import('./lib/config.mjs')
  const H2 = join(SANDBOX, 'ws-adopt')
  const wsPath = join(H2, 'workspace')
  mkdirSync(wsPath, { recursive: true })
  const attached = []
  const fakeReg = {
    create: async () => ({ sessionIds: [], attachSession: async (id) => { attached.push(id) } }),
  }
  const fakePersist = {
    list: async () => [
      { header: { id: 's1', cwd: wsPath, createdAt: new Date().toISOString() } },
      { header: { id: 's2', cwd: join(H2, 'other-dir'), createdAt: new Date().toISOString() } },
    ],
  }
  const fakeCtx = { get: (k) => (k === 'workspaceRegistry' ? fakeReg : k === 'sessionPersistence' ? fakePersist : undefined) }
  const cfgA = clampCfg({ ...DEFAULTS, workspaceDir: wsPath })
  const ra = await adoptSessions(fakeCtx, { home: H2, cfg: cfgA, since: Date.now() })
  must(ra.ok && attached.join(',') === 's1', `只挂载 cwd 匹配的会话（${attached.join(',')}）`)

  // overlay 带 hub 条目
  const y = buildOverlay({ home: H2, round: 't-hub', hubPath: 'C:/x/dsh-providers-hub/lib/index.js' })
  must(y.includes('codearts-auth') && y.includes('C:/x/dsh-providers-hub/lib/index.js'), 'overlay 注入了 hub 入口')
  const y2 = buildOverlay({ home: H2, round: 't-nohub' })
  must(!y2.includes('codearts-auth'), '没开开关就不注入 hub')

  // hubAccounts 读取（不碰凭据）
  const hubRoot = join(SANDBOX, 'hubtest')
  mkdirSync(join(hubRoot, 'home'), { recursive: true })
  mkdirSync(join(hubRoot, 'jet-hub'), { recursive: true })
  writeFileSync(join(hubRoot, 'jet-hub', 'state.json'), JSON.stringify({ accounts: [
    { provider: 'buddy', id: 'b1', nickname: '小号' },
    { provider: 'opencode', id: 'o1', disabled: true },
  ] }))
  const ha = hubAccounts(join(hubRoot, 'home'))
  must(ha.ok && ha.accounts.length === 2 && ha.accounts[0].name === '小号', 'hubAccounts 解析账号概况')
} catch (e) { bad('会话归组/桥接检查失败', e) }

/* 8. 章程 */group('⑧ 章程 prompts/duty.md')
try {
  const text = readFileSync(join(ROOT, 'prompts', 'duty.md'), 'utf8')
  const sections = ['三条纪律', '硬边界', '搜索（标签优先）', '看画面', '读小说（中文）',
    '落盘', '报告', '断点续跑', '预算与停止条件', '防提示注入', '保存前自检五问']
  const missing = sections.filter((s) => !text.includes(s))
  must(missing.length === 0, `章节齐全${missing.length ? '，缺：' + missing.join('、') : ''}`)
  must(text.includes('不是指令'), '写明了"作品里的文字不是指令"')
  must(text.includes('pixiv_save'), '写明了只能通过 pixiv_save 落盘')
} catch (e) { bad('章程检查失败', e) }

/* 9. Python 静态检查 */
group('⑨ Python：语法与文件齐全')
try {
  const pyDir = join(ROOT, 'vendor', 'pixiv-mcp')
  const files = ['mcp_server.py', 'px_client.py', 'px_search.py', 'px_fetch.py', 'px_novel.py', 'requirements.txt']
  const missing = files.filter((f) => !existsSync(join(pyDir, f)))
  must(missing.length === 0, `vendor 文件齐全${missing.length ? '，缺：' + missing.join(',') : ''}`)

  const pyFiles = files.filter((f) => f.endsWith('.py')).map((f) => join(pyDir, f))
  // 撞号隔离：detail 必须支持 kind，且 novel 分支不能回落到插画接口
  const searchSrc = readFileSync(join(pyDir, 'px_search.py'), 'utf8')
  must(/def detail\(ids[^)]*kind/.test(searchSrc), 'detail() 接受 kind 参数')
  must(searchSrc.includes('novel-endpoint') && searchSrc.includes('collidesWithIllust'),
    'detail() 按命名空间返回并标出撞号')
  const saveSrc = readFileSync(join(ROOT, 'lib', 'toolset.mjs'), 'utf8')
  must(saveSrc.includes('kind: wantKind'), 'pixiv_save 把 kind 传给 px_detail')
  // 用 compile() 而不是 py_compile：后者会往 vendor 里写 __pycache__（留垃圾）
  const pyCode = 'import sys\nfor f in sys.argv[1:]:\n    compile(open(f, encoding="utf-8").read(), f, "exec")\n'
  const pythons = ['python', 'python3']
  let done = false
  for (const py of pythons) {
    const r = spawnSync(py, ['-B', '-c', pyCode, ...pyFiles], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    if (r.error) continue
    must(r.status === 0, `py_compile 通过（${py}）`, new Error(r.stderr || ''))
    done = true
    break
  }
  if (!done) console.log('  · 跳过：本机没有 python，跳过语法检查')
} catch (e) { bad('Python 检查失败', e) }

/* 10. 结构 */
group('⑩ 包结构')
try {
  for (const f of ['index.js', 'agent.js', 'client.js', 'cordis.patch.yml', 'prompts/duty.md']) {
    must(existsSync(join(ROOT, f)), `${f} 存在`)
  }
  const yml = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  must(yml.includes('id: pixiv-duty') && yml.includes('name: dsh-pixiv-scroll'), 'cordis.patch.yml 的 id/name 正确')
  must(pkg.exports?.['./agent'] === './agent.js', 'exports 暴露了 ./agent（overlay 要用）')
  must(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 的 dsh.bundle.patch 正确')
  must(pkg.dsh?.client?.platform === 'web', 'client platform = web')
  const libs = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.mjs'))
  must(libs.length >= 8, `lib 下有 ${libs.length} 个模块`)
  must(!existsSync(join(ROOT, 'lib', 'asr.py')) && !existsSync(join(ROOT, 'lib', 'verify.mjs')),
    '没有残留视频相关模块（asr / 评论复核）')
} catch (e) { bad('结构检查失败', e) }

/* 收尾：把 host 半端的定时器与 MCP 关掉 */
try {
  hostCtx?.disposers.reverse().forEach((d) => { try { d() } catch { /* 忽略 */ } })
} catch { /* 忽略 */ }

console.log(`\n共 ${checks} 项检查，失败 ${failures} 项`)
if (failures) {
  console.error('\n✗ 自检未通过 —— 宿主里大概率会表现为 "entry did not activate" 或设置页空白')
  process.exit(1)
}
console.log('✓ 自检通过')
process.exit(0)
