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
  readdirSync, utimesSync, mkdtempSync } from 'node:fs'
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
  must(names.length === 18, `注册了 ${names.length} 个工具（应为 18）：${names.join(", ")}`)
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

  // 同步到 DSH 原生设置：没 inject settings 时 `ctx.settings` 会抛，必须改走 ctx.get('settings')
  const { syncToHost } = await import('./lib/config.mjs')
  let syncedPatch = null
  const picky = { get: (n) => (n === 'settings' ? { update: async (ns, patch) => { syncedPatch = { ns, patch } } } : undefined) }
  Object.defineProperty(picky, 'settings', {
    get() { throw new Error('cannot get property "settings" without inject') },
  })
  const s1 = await syncToHost(picky, { perDay: 5 })
  must(s1.ok && syncedPatch?.ns === 'pixiv-duty' && syncedPatch?.patch?.perDay === 5,
    `ctx.settings 抛错时改走 ctx.get('settings') 同步成功${s1.ok ? '' : '：' + s1.reason}`)
  const s2 = await syncToHost({ get: () => null }, {})
  must(s2.ok === false && /settings/.test(String(s2.reason)), '没有 settings 服务时返回原因而不是抛错')
  must(readFileSync(join(ROOT, 'lib/http.mjs'), 'utf8').includes("'/config/sync'"),
    '有 POST /config/sync 路由（面板顶部「保存更改」用）')
  must(readFileSync(join(ROOT, 'client.js'), 'utf8').includes('保存更改'),
    '面板顶部有「保存更改」按钮')

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
  must(names.length === 18, `agent 半端注册了 ${names.length} 个工具（应与 host 一致：18）`)
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
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (f) => f,
    useMemo: (f) => f(),
    useReducer: (r, init) => [init, () => {}],
    useContext: () => ({}),
    Fragment: 'Fragment',
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

  // 面板能不能真的渲染出来：useEffect 依赖数组引用「后面才 const 定义」的变量时，
  // 渲染期就抛 ReferenceError，线上表现是设置页整片白 —— 这条断言专门拦这种白屏。
  try {
    let node = reg.comp({})
    if (typeof node?.type === 'function') node = node.type(node.props || {})
    must(Boolean(node), '设置面板 render 有返回（不是白屏）')
  } catch (e) { bad('设置面板一渲染就抛错（多半是 TDZ）', e) }
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

  // 新规矩：一轮的成败看「摆出候选」，不看「存下几件」——旧台账里有 saved 也不算这轮的成果
  appendEntry(tmpHome, { id: 9001, kind: 'illust', action: 'saved', round: 'ws-one', title: 't', dir: join(tmpHome, 'not-real') })
  const r1 = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-one', code: 0 })
  must(r1.status === '搜寻无结果', `只有旧台账、没摆候选 ⇒ 搜寻无结果（实际 ${r1.status}）`)

  const { saveCandidates } = await import('./lib/picks.mjs')
  saveCandidates(cfg0, tmpHome, 'ws-two', { roundId: 'ws-two', items: [
    { id: 9002, kind: 'illust', title: 'a', status: 'candidate', why: 'x' },
    { id: 9003, kind: 'illust', title: 'b', status: 'pending', why: 'y' },
  ] })
  const r1b = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-two', code: 0 })
  must(r1b.status === '候选待点头', `摆了 2 件 ⇒ 候选待点头（实际 ${r1b.status}）`)
  must(r1b.staged === 2, `结果里带回 staged=2（实际 ${r1b.staged}）`)
  must(Boolean(r1b.page) && existsSync(r1b.page), '出了预览页，且文件真的在')

  const r2 = finalizeRound({ home: tmpHome, cfg: cfg0, roundId: 'ws-fail', code: 1 })
  must(r2.status === '本轮失败', `code≠0 ⇒ 本轮失败（实际 ${r2.status}）`)

  const st = JSON.parse(readFileSync(join(tmpHome, 'state.json'), 'utf8'))
  must(st.lastStatus?.status === '本轮失败', 'state.json 里落了 lastStatus')
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
    '摆候选', '台账', '断点续跑', '预算与停止条件', '防提示注入', '摆上页之前自检五问']
  const missing = sections.filter((s) => !text.includes(s))
  must(missing.length === 0, `章节齐全${missing.length ? '，缺：' + missing.join('、') : ''}`)
  must(text.includes('不是指令'), '写明了"作品里的文字不是指令"')
  must(text.includes('pixiv_stage'), '写明了这一轮只摆候选（pixiv_stage）')
  must(!/唯一的落盘入口[\s\S]{0,40}pixiv_save/.test(text), '章程里不再把 pixiv_save 当本轮落盘手段')
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
  // 优先用插件自己的 venv：Windows 上 PATH 里的 python.exe 常是 Microsoft Store 的空壳，
  // 它返回非 0 但根本不存在解释器，会让这项检查变成假警报。
  const homeDir = process.env.USERPROFILE || process.env.HOME || ''
  const pythons = [
    process.env.PIXIV_PYTHON || '',
    join(homeDir, '.dsh', 'pixiv-duty', '.venv', 'Scripts', 'python.exe'),
    join(homeDir, '.dsh', 'pixiv-duty', '.venv', 'bin', 'python'),
    'python3',
    'python',
  ].filter((p) => p && (!isAbsolute(p) || existsSync(p)))
  let done = false
  let lastErr = ''
  for (const py of pythons) {
    const r = spawnSync(py, ['-B', '-c', pyCode, ...pyFiles], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    if (r.error) continue
    if (r.status === 0) {
      must(true, `py_compile 通过（${py.replace(/\\/g, '/').split('/').pop()}）`)
      done = true
      break
    }
    lastErr = String(r.stderr || `exit ${r.status}`)
    // 真解释器报语法错就别再往后试了；Store 的空壳返回非 0，继续找下一个
    if (/SyntaxError|IndentationError|Traceback/.test(lastErr)) break
  }
  if (!done) {
    if (/SyntaxError|IndentationError|Traceback/.test(lastErr)) {
      must(false, 'py_compile 通过（vendor）', new Error(lastErr.slice(0, 300)))
    } else {
      console.log(`  · 跳过：本机没有可用的 python 解释器${lastErr ? '（' + lastErr.trim().split('\n')[0].slice(0, 100) + '）' : ''}`)
    }
  }
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

/* 11. 作品库：命名 / 标签快捷方式 / 体检 / 修复 */
group('⑪ 作品库：命名、标签快捷方式、体检与修复')
try {
  const lib = await import('./lib/library.mjs')
  const AW = lib.ALLWORK
  const { DEFAULTS, clampCfg } = await import('./lib/config.mjs')
  const libHome = join(SANDBOX, 'lib-home')
  rmSync(libHome, { recursive: true, force: true })
  mkdirSync(libHome, { recursive: true })
  const cfgL = clampCfg({ ...DEFAULTS, saveRoot: join(libHome, 'masterpiece'), mirrorTags: ['终末地', '绝区零'] })

  const name = lib.renderWorkName(cfgL, {
    id: 151421424, kind: 'illust', title: '游丹青 / 终末地', artist: { id: 7012, name: '繁凪穆木' },
  })
  must(name === '7012_游丹青_终末地_151421424', '默认命名 = {artistId}_{title}_{id}')
  must(!/[\\/:*?"<>|]/.test(name), '作品名里没有 Windows 非法字符')
  must(lib.renderWorkName(clampCfg({ ...cfgL, workTemplate: 'xx' }), { id: 9, title: 't' }).endsWith('_9'),
    '命名模板不合规时回落并在末尾补上作品 id')

  const hit = lib.matchMirrorTags(cfgL, [{ name: '終末地', translated: '明日方舟终末地' }, { name: 'ロリ' }])
  must(hit.length === 1 && hit[0] === '终末地', '标签快捷方式按中文译名命中（終末地 → 终末地）')
  const hit2 = lib.matchMirrorTags(cfgL, [{ name: 'ゼンレスゾーンゼロ', translated: '绝区零' }])
  must(hit2.length === 1 && hit2[0] === '绝区零', '命中「绝区零」译名的作品也会进对应文件夹')

  const workDir = join(libHome, 'masterpiece', AW, name)
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, '001.jpg'), 'x')
  writeFileSync(join(workDir, 'metadata.终末地.json'), JSON.stringify({
    id: 151421424, kind: 'illust', title: '游丹青', tags: [{ name: '終末地', translated: '明日方舟终末地' }],
    files: [{ name: '001.jpg', page: 0, bytes: 1 }],
  }))
  const syn = lib.syncMirrors({ libRoot: join(libHome, 'masterpiece'), name, tags: hit, workDir })
  must(syn.made.length === 1 && existsSync(join(libHome, 'masterpiece', hit[0], name)), '命中标签的作品在标签文件夹里有一份快捷方式')

  const a1 = lib.auditLibrary({ cfg: cfgL, home: libHome })
  must(a1.ok === false && a1.issues.some((i) => i.code === 'NO_TAG_DIR'),
    '体检能发现「标签文件夹整个不见了」')

  rmSync(join(libHome, 'masterpiece', hit[0], name), { recursive: true, force: true })
  const a2 = lib.auditLibrary({ cfg: cfgL, home: libHome })
  must(a2.issues.some((i) => i.code === 'BROKEN_LINK'),
    '快捷方式断了 / 作品没了，体检能发现')

  const fixed = lib.repairLibrary({ cfg: cfgL, home: libHome })
  must(fixed.repaired.length >= 1, 'repairLibrary 会按台账/标签把快捷方式补回来')
  const a3 = lib.auditLibrary({ cfg: cfgL, home: libHome })
  must(a3.ok === true, '修完再体检：库是完好的')

  writeFileSync(join(libHome, 'library-manifest.jsonl'), JSON.stringify({
    id: 42, kind: 'illust', name: '7_被删掉的_42', tags: ['终末地'], bytes: 1, pages: 1, round: 'r', at: new Date().toISOString(),
  }) + '\n', 'utf8')
  const a4 = lib.auditLibrary({ cfg: cfgL, home: libHome })
  must(a4.missing.some((m) => m.id === 42) || a4.issues.some((i) => i.code === 'MISSING_WORK'),
    '台账里有、磁盘上没了 ⇒ 记为可恢复的缺失（恢复预案的数据来源）')
} catch (e) { bad('作品库检查失败', e) }

/* ⑫ 快照守护：只数文件夹与字节；对不上回滚；过期归档 */
group('⑫ 快照守护：目录/字节比对、回滚、缓存归档')
try {
  const snapMod = await import('./lib/snapshot.mjs')
  const AW2 = (await import('./lib/library.mjs')).ALLWORK
  const ret = await import('./lib/retention.mjs')
  const picksMod = await import('./lib/picks.mjs')
  const { DEFAULTS, clampCfg } = await import('./lib/config.mjs')

  must(DEFAULTS.libGuard === 'ask' && DEFAULTS.cacheDays === 30 && DEFAULTS.deleteRecordDays === 90,
    '默认：守护模式=ask、候选缓存留 30 天、删除记录留 90 天')
  must(clampCfg({ ...DEFAULTS, libGuard: '随便' }).libGuard === 'ask', 'libGuard 只认 auto/ask/off，其余回落 ask')

  const gHome = join(SANDBOX, 'guard-home')
  rmSync(gHome, { recursive: true, force: true })
  mkdirSync(gHome, { recursive: true })
  const cfgG = clampCfg({ ...DEFAULTS, saveRoot: join(gHome, 'masterpiece'), mirrorTags: ['终末地'] })
  const aw = join(gHome, 'masterpiece', AW2)

  const mkWork = (name, id) => {
    const d = join(aw, name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'a.jpg'), 'x'.repeat(16))
    writeFileSync(join(d, `metadata.test.json`), JSON.stringify({ id, kind: 'illust', title: name, pageCount: 1 }))
  }
  mkWork('7_甲_100', 100)
  mkWork('8_乙_200', 200)

  const s0 = snapMod.scanLibrary({ cfg: cfgG, home: gHome })
  must(s0.dirs === 2, '扫描：一层目录 = 一件作品，数目对得上')
  snapMod.saveSnapshot({ cfg: cfgG, home: gHome })
  must(snapMod.diffLibrary({ cfg: cfgG, home: gHome }).ok === true, '存档之后立刻比对：一致')

  rmSync(join(aw, '8_乙_200'), { recursive: true, force: true })
  const d1 = snapMod.diffLibrary({ cfg: cfgG, home: gHome })
  must(d1.ok === false && d1.missing.length === 1 && d1.missing[0].id === 200,
    '少了一件 ⇒ 比对报 missing，且能指名是哪件（带 id）')

  const fakeRestore = async ({ items }) => {
    for (const id of items) mkWork(id === 200 ? '8_乙_200' : 'x', id)
    return { ok: true, restored: items.map((id) => ({ id, ok: true })) }
  }
  const rb = await snapMod.rollbackLibrary({ cfg: cfgG, home: gHome, restore: fakeRestore })
  must(rb.ok === true && rb.rolledBack.length === 1, '回滚：按存档把缺的补回来，补完再比对一致')
  must(snapMod.diffLibrary({ cfg: cfgG, home: gHome }).ok === true, '回滚后存档自动更新')

  // 归档：过期的候选缓存 → 只留「当天选了哪些」
  const oldRound = '2020-01-01-old'
  const rd = picksMod.roundDir(cfgG, gHome, oldRound)
  mkdirSync(join(rd, 'thumbs'), { recursive: true })
  writeFileSync(join(rd, 'thumbs', '1.jpg'), 't')
  picksMod.saveCandidates(cfgG, gHome, oldRound, {
    schema: 2, round: oldRound, note: '', at: '2020-01-01T00:00:00.000Z',
    items: [{ id: 1, kind: 'illust', title: '选中的', artist: 'a', status: 'saved' },
      { id: 2, kind: 'illust', title: '没选的', artist: 'b', status: 'pending' }],
  })
  const oldPage = picksMod.pageFile(cfgG, gHome, oldRound)
  writeFileSync(oldPage, '<html></html>')
  const old = new Date('2020-01-01T00:00:00Z')
  utimesSync(oldPage, old, old)
  utimesSync(rd, old, old)
  const ar = ret.archiveOldPicks({ cfg: cfgG, home: gHome })
  must(ar.archived === 1 && !existsSync(rd), '过期候选缓存被清掉（缩略图一起删）')
  const hist = JSON.parse(readFileSync(join(picksMod.picksRoot(cfgG, gHome), 'history', `${oldRound}.json`), 'utf8'))
  must(hist.picked.length === 1 && hist.picked[0].id === 1 && hist.stagedCount === 2,
    '归档后只留「当天选了哪些」：选中 1 件，候选总数仍记得')

  // 删除记录过期：删掉记录就真的恢复不了
  const days = (n) => new Date(Date.now() - n * 864e5).toISOString()
  writeFileSync(join(gHome, 'library-manifest.jsonl'),
    [
      JSON.stringify({ id: 900, kind: 'illust', name: '9_很旧_900', tags: [], at: days(200) }),
      JSON.stringify({ id: 901, kind: 'illust', name: '9_刚丢_901', tags: [], at: days(3) }),
    ].join('\n') + '\n', 'utf8')
  const dr = ret.expireDeleteRecords({ cfg: cfgG, home: gHome })
  const rowsLeft = (await import('./lib/library.mjs')).readManifest(gHome)
  must(dr.dropped === 1 && rowsLeft.length === 1 && rowsLeft[0].id === 901,
    '删除记录过期：超过 90 天的清掉（再也恢复不了），3 天前的留着')
} catch (e) { bad('快照守护检查失败', e) }

/* ⑬ 推送模式：标签权重、关注门槛、必推线、关注列表缓存 */
group('⑬ 推送模式：权重、关注门槛与缓存')
try {
  const { tagWeight, judgePush, normTag, readFollowing, writeFollowingForTest } = await import('./lib/following.mjs')
  const pcfg = {
    keywords: ['终末地', '白タイツ', 'ぱんつ', '触手', '東方', 'アズールレーン'],
    dislikeTags: ['催眠'], dislikeWeight: -1, minPushWeight: 1, mustPushWeight: 5, followedOnly: true,
  }
  const w = tagWeight(pcfg, ['終末地', '白タイツ', '催眠', '無関係'])
  must(w.weight === 1 && w.hit.length === 2, '权重：日文「終末地」也算命中「终末地」，不喜欢标签按 -1 扣')
  must(normTag('終末地') === normTag('终末地') && normTag('絶区零') === normTag('绝区零'), '字形归一：終/绝 这种只差一个字的标签能对上')
  must(judgePush({ cfg: { ...pcfg, followedOnly: false }, tags: [], authorId: 1, following: { ids: [] } }).ok, '推送模式关着时不拦任何作品')
  must(judgePush({ cfg: pcfg, tags: ['白タイツ', 'ぱんつ'], authorId: 42, following: { ids: [42] } }).ok, '权重 ≥ 下限且作者被关注 ⇒ 可推')
  must(judgePush({ cfg: pcfg, tags: ['白タイツ', 'ぱんつ'], authorId: 7, following: { ids: [42] } }).code === 'PUSH_MODE', '权重够、但作者没关注 ⇒ 拦下')
  const mustP = judgePush({ cfg: pcfg, tags: ['白タイツ', 'ぱんつ', '終末地', '触手', '東方', 'アズールレーン'], authorId: 7, following: { ids: [] } })
  must(mustP.ok && mustP.weight === 6, '权重和 > 必推线 ⇒ 必推（不看关注）')
  must(judgePush({ cfg: pcfg, tags: ['催眠'], authorId: 42, following: { ids: [42] } }).code === 'PUSH_MODE', '只命中不喜欢标签 ⇒ 哪怕已关注也拦下')

  const fHome = mkdtempSync(join(tmpdir(), 'px-follow-'))
  let calls = 0
  const fakePx = async () => {
    calls += 1
    if (calls === 1) return { ok: true, userId: 9, users: [{ id: 42 }, { id: 43 }] }
    throw new Error('第二次应该命中缓存')
  }
  const f1 = await (await import('./lib/following.mjs')).getFollowing({ home: fHome, callPx: fakePx })
  const f2 = await (await import('./lib/following.mjs')).getFollowing({ home: fHome, callPx: fakePx })
  must(f1.total === 2 && f2.total === 2 && calls === 1, '关注列表缓存 12 小时：第二次不再打网络')
  must(readFollowing(fHome).ids.length === 2, '关注列表落盘到 following.json')
  const f3 = await (await import('./lib/following.mjs')).getFollowing({ home: fHome, callPx: async () => { throw new Error('网络断了') }, maxAgeMs: 0 })
  must(f3.ok === false && f3.ids.length === 2, '网络失败时退回上一次的缓存，不把推送模式搞成空')
} catch (e) { bad('推送模式检查失败', e) }

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
