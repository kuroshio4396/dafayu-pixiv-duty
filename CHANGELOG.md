# 更新日志

用人话记每个版本改了什么 —— 面向使用者，不是开发笔记。

## 1.1.4 — 2026-10-30

这一版把「自己闷头下载」改成了「先摆出来给你看，你点头再下」。

- **新增：候选预览页**。每轮把候选排成一张网页（`workspace/picks/<round>.html`）：缩略图直接链到 Pixiv 作品页，
  每张卡片写清「为什么给你看」，按 R-18 / 分组分开。页面由本机固定端口（47825）托管，地址带随机口令，可收藏。
- **新增：点头才落盘**。探索轮里 `pixiv_save` 会被 `NEED_APPROVAL` 拦住——原图一张都不下；
  只有你确认之后（`pixiv_approve` / 面板 / 选装画廊）才真正写盘。没点头的候选可以一键清出暂存区。
- **作品库改结构**：一律 `<保存根>/all_works/<作者pid>_<作品名>_<作品id>/`，页文件与目录同名（多页 `_p01`…），
  命名模板可在设置里改（必须含 `{id}`）；改保存位置会把整棵树一起搬过去。
- **新增：作品库轻量守护**。开跑前只比「目录数 / 目录名 / 字节数」（不为几千件逐个读文件）：对不上可按三档处理
  （立刻回滚并弹窗 / 只弹窗询问 / 都不管），回滚只补不删，换下来的残件进 `trash/`；台账在
  `library-manifest.jsonl`，基准在 `library-snapshot.json`。
- **新增：缓存与记录保留期**。没选中的候选缓存默认留 30 天（之后只留「当天选了哪些」）；删除记录默认留 90 天。
- **网络设置通用化**：`clashAuto/clashPath/clashWaitSec` → `vpnAuto/vpnPath/vpnWaitSec`，
  不再假定你用 Clash（V2RayN、Shadowsocks 都行），旧配置自动迁移。
- **修：设置页偶发空白**。面板里一个 `useEffect` 依赖了后面才定义的 `loadLibrary`，触发 TDZ 直接白屏；
  已挪到定义之后，并在自检里加了一条「设置面板能渲染」的断言防复发。
- **与 DSH 画廊解耦**：本插件不再内置筛选/评分界面，这部分交给可选的 `dsh-pixiv-gallery`；
  不装画廊也照常运行（轮次产出的 `picks/`、`candidates.json`、`thumbs/` 与 `approve` 接口都保留）。
- **新增：面板顶部「保存更改」**。它把这整份配置再推一遍到 DSH 原生设置，并显示还有几项没同步。
  顺带修了同步从来没成功过的根因：直接读 `ctx.settings` 在没 inject 时会抛
  `cannot get property "settings" without inject`，现在改走 `ctx.get('settings')`。
- **保存位置可以直接选**：设置里点「选…」弹系统文件夹选择框（Windows），选完自动搬运整棵树。
- **更名**：包名 / 设置 id / 代码里的路径统一叫 `dsh-pixiv-scroll`（仓库名 `dafayu-pixiv-duty` 是历史遗留）。
- **新增：每件作品永不重复出现**。判重从「7/14 天冷却」改成扫全量台账：同一 `kind:id` 只要在任何一轮摆过，
  之后一律 `SEEN_BEFORE` 拦下，不再在几轮之间反复出现。
- **新增：推送模式（只推已关注作者）**。标签权重和 > 必推线（默认 5）必推；≥ 下限（默认 1）且作者在关注列表才推；
  不喜欢的标签可配权重（默认 -1）；开关只对下一轮生效。关注列表经 MCP 新工具 `px_following` 读取并缓存 12 小时
  （`following.json`，失败退回旧缓存）。新配置项：`followedOnly` / `dislikeTags` / `dislikeWeight` / `minPushWeight` / `mustPushWeight`。

## 1.1.3 — 2026-10-20

- **修：小说被同号插画顶替**。插画与小说是两套 id，会撞号（例如 29222785 既是 2012 年的插画，
  又是一篇小说）。`px_detail` 原来**永远先查插画**，导致小说落盘时被识别成插画、被 `CONTENT_TYPE` 拦下。
  现在两套检测分开：
  - `kind: 'novel'` → **只查小说接口**；`kind: 'illust'` → 只查插画接口；`kind: 'auto'` 才是旧的先插画后小说
  - 查不到时明确告知"这个号是同号插画/小说"，而不是含糊的 `NOT_FOUND`
  - `pixiv_inspect` 新增 `kind` 参数；`pixiv_save` 把调用方的 `kind` 带进详情查询，
    完全没给时按"只开了小说"推断为 novel
  - 返回里带 `kindSource` 与 `alsoIllust`（同号提示），报告与排查都能看出走的是哪个接口

## 1.1.2 — 2026-10-20

两个"看起来没生效"的真 bug，根因同一个：

- **`ctx.get()` 兜底永远走不到**：cordis 里 `ctx.workspaceRegistry` 这种未 inject 的属性访问会**抛错**，
  而我们写的是 `ctx.x || ctx.get('x')` —— 属性先抛，兜底代码根本没执行。
  结果：日志里"没有 workspaceRegistry"、模型目录空、会话永远归不了组。
  修法：抽出 `lib/svc.mjs`，属性访问与 `ctx.get` **分开 try**。
- **Jet Hub 渠道列不出来**：它自 2026-10-01 起**不再声明 configurable provider**，
  而面板只查 `listConfigurableProviders()`。现在改为 `listConfigurableProviders() ∪ listProviders()`，
  并按渠道并行拉模型（单渠道 8 秒超时，慢渠道不再拖住整个列表）。
- 新增渠道前置校验：没选模型 / 宿主没这个渠道 / hub 渠道但开关没开，都会在**开跑前**给出明确错误，
  而不是等子进程报 `NO_ADAPTER`。
- 面板加了「刷新模型目录」按钮与渠道/模型计数。

## 1.1.1 — 2026-10-19

- **修：会话不挂进工作区**。工作区的成员是**显式名单**（`record.sessionIds`），DSH 只在首次初始化时
  按 cwd 归一次，外部进程新建的会话一律落「未分组」。现在每轮跑完会调
  `workspaceRegistry.attachSession()` 把 cwd 匹配工作区的会话挂进去（挂载时带 cwd 校验，路径对不上会被拒），
  UI 靠工作区订阅即刻刷新，不用重启。
- **新增：Jet Hub 渠道桥接**。headless profile 里没装 `dsh-providers-hub`，所以按开关
  （设置 → 用哪个 agent 跑 → 「启用 Jet Hub 渠道」）用绝对路径把它的 `index.js` 塞进每轮 overlay，
  CodeBuddy（腾讯）等渠道就能在下拉里选；面板同时显示 Jet Hub 里已登录的账号概况（不读凭据）。
  账号**登录**仍在 Jet Hub 自己的设置里做，这里不重复造轮子。

## 1.1.0 — 2026-10-19

**新增：工作区播报**

- 插件会在 DSH 侧栏里挂一个和自己绑定的工作区（默认 `<插件家>/workspace`，可改）。
- 每轮的 headless 会话直接跑在这个目录里，所以会话就归属该工作区。
- agent 最后一条消息固定是第一行三种状态之一：`下载成功：N 件`（附绝对路径）/ `搜寻无结果` / `下载失败：原因`。
- 除模型措辞外，插件另写一份以台账为准的 `last-status.md` 与 `state.json.lastStatus`，面板也能看到上次状态。

**备份**：本版开工前把 v1.0 完整快照存到了 `_backup-20261019-pixiv-scroll-v1.0/`（含 MANIFEST 与 RESTORE.md）。

## 0.1.1 — 2026-10-19

按使用反馈补的六项：

- **模型选择重做**：直接读宿主的模型目录，按**渠道（provider）分组**列出来，选项显示「渠道 ｜ 模型 ｜ 是否可读图」，
  一个下拉就能确认自己在用哪个渠道的哪个模型（之前是 provider / model 两个下拉，容易选串）。
- **收藏数改成区间**：下限 + 上限（0 = 不限），区间外的作品在搜索阶段就被丢掉，不再占用读图与详情预算。
- **存好自动打开文件夹**：每存下一件就弹出它所在的目录（可在设置里关）。
- **metadata 用关键词命名**：`metadata.初音ミク.json`，一眼看出这件是从哪个搜索词下挖到的；
  `pixiv_save` 新增 `keyword` 参数，报告与台账里也会记。
- **时间窗可关闭**：新增「启用时间窗」开关，关掉就不限发布时间（MCP 侧不再带任何日期参数）。
- **小说正文模糊搜索**：新栏位写自然语言场景偏好。先按关键词筛出候选，再对正文做字面预筛：
  分高直接可收；分低则由 agent 读返回段落判断语义，确认相符要在 `pixiv_save` 里带
  `vibeApproved + vibeReason`（会写进 metadata），否则被 `NOVEL_VIBE` 拦下。
- 修：轮次计数器没按 round 隔离，上一轮用掉的预算会压着下一轮（表现为"预算用完了"）。

## 0.1.0 测试期修复 — 2026-10-19（首次真机联调）

在 Windows + 桌面版 0.2.1 上真跑了一轮，修掉这些：

- **设置页卡在「读取配置中…」**：桌面版没有 TCP 端口，`webServer.register` 的路由永远收不到请求。
  改为同时注册 `connection.fetch` 精确路由（`/api/pixiv-duty/*`），前端自动探测两条通路；
  并且把失败原因显示出来（以前错误被吞在早退分支里）。

- **数值默认值被钳到下限**：`asNum` 把 `undefined` 当成 0，`days` 变 1、`perDay` 变 0；`zhRatio` 还被四舍五入成 0。
- **首启写出 `[object Object]`**：cordis 传来的 config 里有非原始值，被直接落盘；改成只挑原始类型（`pickSeed`）。
- **MCP 工具名与模块名冲突**：`px_search` 函数把同名模块覆盖，搜索直接 `AttributeError`。
- **`search_novel` 不支持 `duration`**：小说搜索改用 `start_date`；顺带把两类搜索拆开 try，小说失败不再拖累插画。
- **小说 id 被误判成插画**：pixiv 对小说 id 会返回空标题的假插画对象，加了有效性校验。
- **`webview_novel` 结构**：正文在返回**顶层**，不是 `res.novel.text`。
- **换 token 的网络**：Node 直连 Pixiv 不通，改成在浏览器里用路由拦截发带 App 头的 POST。
- **OAuth code 监听太晚**：`pixiv://account/login?code=` 在点击后 1 秒内返回，监听必须提前挂。
- **代理小写变量**：`requests` 会读父进程的小写 `https_proxy`，把大写覆盖掉；现在 6 个键一起写。
- **桌面版 schema**：拿不到宿主 `dsh-tools` 时，本地兜底实现没把参数表编译成 JSON Schema，模型侧报 `type: null`。

## 0.1.0 — 2026-10-19

首个版本。从 [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) 的架构改出来，
目标站点换成 Pixiv，内容从"视频"换成"插画 / 漫画 / 中文小说"。

**有的东西**

- 账号密码 → 一次性 OAuth（本机 Edge）→ refresh_token；也可以手贴 token
- 标签优先搜索：关键词 / 必须标签（AND）/ 排除标签 / 标签权重 / 收藏数下限 / 时间窗
- 读图判断：缩图落到本地缓存，agent 用内置 `read_image` 看（每轮有张数预算）
- 中文小说：四通道抓正文，字数/语言/章节 + 关键词选段；短篇整篇、长篇选段
- 落盘：`类型/画师/标题_ID/`，多页按页序编号，`metadata.json` 最后写（提交标记）
- 十二个工具里 `pixiv_save` 是唯一落盘入口，内部强制：内容类型 / 分级 / 今日额度 /
  单轮额度 / 去重 / 磁盘空间
- 定时：DeepSeek 谷时窗口（中午 12–14、晚上 18–09），每个窗口每天只跑一次
- 日报 `out/<日期>.md`；判重台账 `ledger.jsonl`（额度以它为准，不信报告文本）

**故意删掉的**（相对参考实现）

- B 站扫码登录、评论 / @ / 私信、评论复核、ASR 转写、视频信息、弹幕、`### BV` 计数

**已知限制**

- 密码登录必须开一个浏览器过 reCAPTCHA；无头被拦时要改有头或手贴 token
- 纯文本模型不能跑插画 / 漫画（`read_image` 会拒绝）
- 动图（ugoira）默认跳过
- R-18 需要账号先在网页端开启显示，插件不能替你开
