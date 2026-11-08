# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-pixiv-scroll`（中文名「**刷Pixiv**」）：按用户口味刷 Pixiv，把**插画 / 漫画 / 中文小说**挑出来存到本地。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` 或 `uv`；登录那一次需要本机有 **Edge 或 Chrome**。
2. 装插件：
   ```bash
   dsh plugin --profile web add link:F:\Deepseek harness\dsh-pixiv-scroll
   ```
3. ⚠️ **提醒用户重启一次 dsh**（bundle 层要重启才组装）。
4. 进 **设置 → 刷Pixiv**：
   - 点「**装依赖**」（建 venv + 装 pixivpy3 / mcp<2 / Pillow）
   - 点「**装依赖**」之后再用账号密码登录，或让用户手贴 `refresh_token`
   - 点「**测一下**」自检（凭证 / Python 依赖 / 保存目录）
   - 点「**现在跑一轮**」
5. **不要**替用户打开 R-18，也不要替他填保存目录 —— 这两项是他的选择。

## 环境差异与已知坑

- **取宿主服务必须用 `lib/svc.mjs` 的 `svc(ctx, name)`**：cordis 里未 inject 的 `ctx.foo` 会**抛错**，
  写成 `ctx.foo || ctx.get('foo')` 放在同一个 try 里 = 兜底永远不执行（v1.1.1 的归组/模型目录失效就是这个）。
- **Jet Hub 不声明 configurable provider**（2026-10-01 起）：模型目录必须
  `listConfigurableProviders() ∪ listProviders()`，否则 CodeBuddy 等渠道永远不出现。

- **工作区绑定的原理**：DSH 按会话的 cwd 归属工作区（会话落盘在 `~/.dsh/sessions/--<cwd slug>--/`）。
  ⚠️ 但工作区的成员是**显式名单**：`record.sessionIds`。DSH 只在首次 bootstrap 按 cwd 归一次，
  之后外部进程新建的会话**不会自动挂进去**（落「未分组」）——必须调
  `entity.attachSession(id)`（见 `lib/workspace.mjs` 的 `adoptSessions`，跑完一轮在 onExit 里调用，
  带 4 次重试等会话落盘）。挂载会校验 header.cwd == workspace.path，不符会被拒（安全阀）。
  所以完整链路是：① `ctx.inject(['workspaceRegistry'], …)` 注册目录；② headless cwd 指过去；
  ③ 跑完 onExit 里 adoptSessions 显式挂载。
- **Jet Hub 桥接**：headless profile 没有 `dsh-providers-hub`，但 overlay 的 `name` 支持绝对路径
  （loader 转 file URL），所以开了 `useHubChannel` 就把它的 `lib/index.js` 塞进 overlay。
  账号数据在 `~/.dsh/jet-hub/state.json`（同机共享，跨 profile 有效）；登录仍在 Jet Hub 自己的设置里做。

- **桌面版没有 TCP 端口**：Electron 用的是自定义协议，`ctx.webServer.register()` 注册的路由在桌面里收不到请求，
  设置页会永远停在"读取配置中…"。**必须**同时注册 `ctx.connection.fetch.register({ path:'/api/pixiv-duty/…',
  methods, requestBody:'buffered', fetch(request) })`（精确路由、Request/Response 风格，`path` 必须在 `/api` 下）。
  `lib/http.mjs` 已经两条通道都注册，前端 `resolveBase()` 会先试 `/api/pixiv-duty/ping`，再退回 `/pixiv-duty/api/ping`。

- **模型视觉能力是硬前提**：headless 默认 `deepseek-flash` 声明 `inputModalities:['text','image']`，可以读图。
  如果用户把 `agentModel` 设成纯文本模型，`read_image` 会**直接报错**（不是效果差）。⇒ 让他换模型，或关掉插画/漫画只跑小说。
- **密码不是配置项**：`POST /pixiv-duty/api/login` 的一次性 body。不要把它写进 `config.json`、
  不要写进 prompt、不要写进日志。落盘只有 `credential.json` 里的 refresh_token。
- **refresh_token 会轮换**：Pixiv 每次刷新都换发新值，旧的立即失效。插件用文件锁 + 单进程刷新；
  如果用户在别的工具里也用同一个 token，会互相踢掉，只能重新登录。
- **无头登录可能被 reCAPTCHA 拦**：面板会提示。退路一：`PIXIV_LOGIN_HEADLESS=0` 用有头 Edge；
  退路二：手贴 refresh_token。不要反复重试同一个失败。
- **桌面版（Electron）**：`dsh` 不在 PATH。`dshBin` 填了就按它走；没填时 `resolveDsh` 自动探测
  `<安装目录>\resources\runtime\cli\bin\dsh.cmd`（旧版桌面版还可能发 `bin.js` / `dsh.exe`）。
  `.cmd` 包装内部已设 `ELECTRON_RUN_AS_NODE`，并带 `--expose-internals`。
  ⚠️ **不要**让 headless 去解析包名 `dsh-pixiv-scroll/agent` —— headless profile 里没装本插件；
  overlay 里用**绝对路径**（`lib/runner.mjs` 的 `DEFAULT_AGENT_ENTRY` 已经这么做了）。
- **网络**：国内环境必须配 `proxyUrl`（如 `http://127.0.0.1:7890`）。Node 与 Python 直连 Pixiv 会被阻断，
  而 Edge 走系统代理能通 —— 典型症状是"登录成功、搜索 0 条"。
  `runRound` 起子会话前会 `ensureProxy()`：先 TCP 探一次代理端口，不通且 `vpnAuto` 开着就
  `spawn(vpnPath)` 拉起代理软件（Clash / V2RayN 都行），最多等 `vpnWaitSec` 秒；超时则这一轮不跑（`/run` 返回 409 并写 duty.log）。
  探活只看端口通不通，不验证它是不是真代理。
  Python `requests` 认**小写** `https_proxy`，父进程里的沙箱代理会盖掉大写变量，所以 `lib/toolset.mjs`
  一次写全 6 个键（大小写各三份）。
- **一轮里没有 bash / write / edit**：这是故意的。落盘只能走 `pixiv_save`，
  因为 agent 的 `write` 被沙箱限制在插件家目录，写不到用户指定的盘，而且 `approval: ask` 会等一个不存在的人。

## 仓库结构（改代码时看这里）

- `index.js` —— Web 宿主半端：设置页后端（`/pixiv-duty/api/*`）、谷时定时器、手动跑一轮
- `agent.js` —— headless 子会话半端：只 `inject: ['tools']`，起 Python MCP、注册同一套工具
- `client.js` —— 浏览器半端：`window.__ModuleLoader__.load` 自注册，挂 `settings.section`
- `lib/config.mjs` —— Config schema（全字段 volatile）、默认值、钳制、双层读写
- `lib/toolset.mjs` —— 12 个工具的契约与策略闸门（额度 / 分级 / 去重 / 磁盘）
- `lib/save.mjs` —— 命名清洗、目录模板、原子落盘、`metadata.json`
- `lib/seen.mjs` —— JSONL 台账（额度与判重的唯一真相源）
- `lib/runner.mjs` —— overlay、prompt、spawn、收尾
- `lib/login-pixiv.mjs` —— OAuth PKCE（本机 Edge）+ 手贴 token
- `lib/http.mjs` —— 设置页后端
- `vendor/pixiv-mcp/` —— 内置 Python MCP（只做网络与字节）
- `prompts/duty.md` —— 一轮章程（用户可改；升级不被覆盖）
- `selfcheck.mjs` —— `node selfcheck.mjs`，73 项断言，退出码 0 才算过

## 约定

- 配置与运行数据都在 `$DSH_HOME/pixiv-duty/`，**不写进插件包目录**
- cordis entry id = 设置命名空间 = 家目录名 = `pixiv-duty`（三处必须一致）
- `--patch` 覆盖层与 settings 写入互斥 ⇒ overlay 只写子会话的模型与工具开关，**绝不写本插件自己的 config**
