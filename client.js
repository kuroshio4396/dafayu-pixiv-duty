/**
 * dsh-pixiv-scroll —— 浏览器半端（设置里的「刷Pixiv」一页）
 * ============================================================================
 * ⚠️ client bundle 不是 ESM，是自注册脚本：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                        // 必须等于 package.json 的 name
 *       factory: (require) => ({ inject, apply }),
 *     })
 *
 * 进「设置」的方式（跟别的第三方插件一致，别自己糊标题栏按钮 + 全屏 overlay）：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'pixiv-duty', order: 30, label: '刷Pixiv' },
 *       () => h(Panel),
 *     ))
 *
 * 这一页的形状（用户 2026-10-19 定的）：
 *   · 账号密码 → 一次性换 token，之后不再需要密码
 *   · 选 agent / 模型（标出是否支持读图）
 *   · 偏好：关键词 / 必须标签 / 排除标签 / 权重
 *   · 保存目录与目录模板
 *   · 小说粒度与阈值；R-18 独立开关（默认关）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-pixiv-scroll',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/pixiv-duty/api'
    /** Jet Hub 注册的渠道（与 lib/agents.mjs 的 HUB_PROVIDERS 保持一致） */
    const HUB_PROVIDER_IDS = ['buddy', 'workbuddy', 'codearts', 'qoder', 'qodercn', 'trae', 'cline',
      'loomy', 'raccoon', 'minimax', 'minimax-intl', 'accio', 'lobsterai', 'opencode', 'zcode', 'jet-hub-auto']
    /**
     * 双通道探测：桌面版走 `connection.fetch`（/api/pixiv-duty/*），
     * Web/源码模式走 webServer 前缀（/pixiv-duty/api/*）。第一次请求前测一下。
     */
    const CANDIDATES = ['/api/pixiv-duty', '/pixiv-duty/api']
    let BASE = null
    const resolveBase = async () => {
      if (BASE) return BASE
      for (const b of CANDIDATES) {
        try {
          const r = await fetch(b + '/ping', { credentials: 'same-origin', signal: AbortSignal.timeout(3000) })
          if (r.ok) { BASE = b; return b }
        } catch { /* 试下一条 */ }
      }
      BASE = CANDIDATES[0]
      return BASE
    }

    /**
     * 统一的请求封装。
     * ⚠️ 必须带超时 + 把 HTTP 状态/响应体带进错误里：之前"读取配置中…"永远不动，
     *    就是因为错误被吞在 catch 里，面板又提前 return，用户看不到任何原因。
     */
    const asJson = async (res) => {
      const text = await res.text().catch(() => '')
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { /* 不是 JSON */ }
      if (!res.ok) {
        const detail = data?.error || data?.message || text.slice(0, 160) || res.statusText
        throw new Error(`HTTP ${res.status}${detail ? '：' + detail : ''}（${BASE}）`)
      }
      return data
    }
    const request = async (p, opts = {}) => {
      const b = await resolveBase()
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 10000)
      try {
        const res = await fetch(b + p, { credentials: 'same-origin', ...opts, signal: ctl.signal })
        return await asJson(res)
      } catch (e) {
        if (e?.name === 'AbortError') throw new Error(`请求超时（10 秒）—— 插件后端没响应（${b}），看 duty.log`)
        if (e instanceof TypeError) throw new Error(`网络错误（${e.message}）—— 找不到插件后端（试过 ${CANDIDATES.join(' 与 ')}）`)
        throw e
      } finally { clearTimeout(timer) }
    }
    const jget = (p) => request(p)
    const jpost = (p, body) => request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    const CSS = `
[data-px]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 10px;max-width:680px;}
[data-px-sec]{display:flex;flex-direction:column;gap:8px;}
[data-px-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-px-row]{display:flex;align-items:center;gap:10px;}
[data-px-grow]{flex:1;min-width:0;}
[data-px-label]{font-size:13px;}
[data-px-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-px-note][data-warn]{color:#c2410c;}
[data-px-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-px-sw][data-on]{background:#3b82f6;}
[data-px-sw]::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;
  background:#fff;transition:left .15s;}
[data-px-sw][data-on]::after{left:19px;}
[data-px-in]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:13px;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));
  background:var(--dsw-alias-bg-secondary,transparent);color:inherit;outline:none;font-family:inherit;}
[data-px-in]:focus{border-color:#3b82f6;}
[data-px-ta]{min-height:64px;resize:vertical;line-height:1.5;}
[data-px-field]{display:flex;flex-direction:column;gap:6px;}
[data-px-field]>[data-px-ta]{width:100%;box-sizing:border-box;font-family:inherit;}
[data-px-num]{width:92px;text-align:right;}
[data-px-btn]{padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-secondary,rgba(128,128,128,.35));
  background:var(--dsw-alias-bg-secondary,transparent);color:inherit;}
[data-px-btn]:disabled{opacity:.5;cursor:default;}
[data-px-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-px-btn][data-danger]{border-color:#dc2626;color:#dc2626;}
[data-px-badge]{font-size:11px;padding:1px 7px;border-radius:9px;background:rgba(128,128,128,.15);}
[data-px-badge][data-ok]{background:rgba(22,163,74,.15);color:#15803d;}
[data-px-badge][data-bad]{background:rgba(220,38,38,.15);color:#b91c1c;}
[data-px-say]{font-size:12px;line-height:18px;padding:8px 10px;border-radius:8px;background:rgba(128,128,128,.09);}
[data-px-say][data-tone=bad]{background:rgba(220,38,38,.1);color:#b91c1c;}
[data-px-say][data-tone=ok]{background:rgba(22,163,74,.1);color:#15803d;}
[data-px-grid]{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;}
[data-px-bar]{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        type: 'button', 'data-px-sw': '', 'data-on': on ? '' : undefined,
        disabled, onClick: () => !disabled && onChange(!on),
        'aria-pressed': on,
      })
    }

    function Row({ label, note, children }) {
      return h('div', { 'data-px-row': '' },
        h('div', { 'data-px-grow': '' },
          h('div', { 'data-px-label': '' }, label),
          note ? h('div', { 'data-px-note': '' }, note) : null),
        children)
    }

    function ToggleRow({ label, note, on, onChange, disabled }) {
      return h(Row, { label, note },
        h(Switch, { on, onChange, disabled }))
    }

    function Section({ title, children, extra }) {
      return h('div', { 'data-px-sec': '' },
        h('div', { 'data-px-row': '' },
          h('div', { 'data-px-h': '', 'data-px-grow': '' }, title),
          extra || null),
        children)
    }

    /**
     * 文本字段：本地立即显示，失焦/回车才提交 —— 避免每敲一个字打一次接口。
     */
    function TextField({ label, note, value, onCommit, placeholder, textarea, password, type = 'text' }) {
      const [v, setV] = React.useState(value ?? '')
      const last = React.useRef(value ?? '')
      React.useEffect(() => {
        if ((value ?? '') !== last.current) { last.current = value ?? ''; setV(value ?? '') }
      }, [value])
      const commit = () => {
        if (v === last.current) return
        last.current = v
        onCommit(v)
      }
      const common = {
        'data-px-in': '', value: v,
        placeholder: placeholder || '',
        type: password ? 'password' : type,
        onChange: (e) => setV(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter' && !textarea) { e.preventDefault(); commit() } },
      }
      if (textarea) {
        // 多行字段一律**纵向**排：标签在上、输入框占满一行。
        // 之前塞进 flex 行里跟标签并排 + width:100%，会把整行撑破。
        return h('div', { 'data-px-field': '' },
          h('div', { 'data-px-label': '' }, label),
          note ? h('div', { 'data-px-note': '' }, note) : null,
          h('textarea', { ...common, 'data-px-ta': '' }))
      }
      return h(Row, { label, note },
        h('div', { style: { flex: '0 1 260px', width: 260, minWidth: 0, maxWidth: '100%' } },
          h('input', common)))
    }

    function NumberField({ label, note, value, onCommit, min, max, disabled, fraction }) {
      const [v, setV] = React.useState(String(value ?? 0))
      React.useEffect(() => { setV(String(value ?? 0)) }, [value])
      const commit = () => {
        const n = Number(v)
        if (!Number.isFinite(n)) { setV(String(value ?? 0)); return }
        // fraction = 小数比例字段（如 0.15），绝不能四舍五入
        const bounded = Math.min(max ?? 1e9, Math.max(min ?? 0, fraction ? n : Math.round(n)))
        setV(String(bounded))
        if (bounded !== value) onCommit(bounded)
      }
      return h(Row, { label, note },
        h('input', {
          'data-px-in': '', 'data-px-num': '', value: v, inputMode: 'numeric', disabled,
          style: disabled ? { opacity: .5 } : undefined,
          onChange: (e) => setV(e.target.value), onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') commit() },
        }))
    }

    function Panel() {
      const [cfg, setCfg] = React.useState(null)
      const [status, setStatus] = React.useState(null)
      const [agents, setAgents] = React.useState({ profiles: [], providers: [] })
      const [say, setSay] = React.useState(null)
      const [fatal, setFatal] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [pwd, setPwd] = React.useState('')
      const [tok, setTok] = React.useState('')
      const [loginStep, setLoginStep] = React.useState('')
      const [report, setReport] = React.useState('')

      const notify = (text, tone = '') => setSay({ text, tone })

      const refresh = React.useCallback(async () => {
        try {
          const [c, s] = await Promise.all([jget('/config'), jget('/status')])
          setCfg(c?.config || {})
          setStatus(s)
          setFatal(null)
        } catch (e) {
          setFatal(String(e?.message || e))
        }
      }, [])

      React.useEffect(() => { refresh() }, [refresh])
      React.useEffect(() => {
        let alive = true
        jget('/agents').then((a) => { if (alive) setAgents(a) }).catch(() => {})
        return () => { alive = false }
      }, [])
      React.useEffect(() => {
        const t = setInterval(() => { jget('/status').then(setStatus).catch(() => {}) }, 15000)
        return () => clearInterval(t)
      }, [])

      const save = async (patch) => {
        setCfg((c) => ({ ...c, ...patch }))
        try {
          const r = await jpost('/config', patch)
          setCfg(r.config)
          if (!r.synced) notify('已保存到插件；但没能同步到 DSH 原生设置（以这里为准）', '')
          else notify('已保存', 'ok')
        } catch (e) { notify(`保存失败：${e.message}`, 'bad') }
      }

      const runNow = async () => {
        setBusy('run')
        try {
          const r = await jpost('/run', {})
          notify(`已开跑：${r.roundId}（profile=${r.profile}）`, 'ok')
          setTimeout(refresh, 1500)
        } catch (e) { notify(`开跑失败：${e.message}`, 'bad') } finally { setBusy('') }
      }

      const doLogin = async (mode) => {
        setBusy('login'); setLoginStep('提交中…')
        try {
          const body = mode === 'token' ? { mode, refreshToken: tok } : { mode, pixivId: cfg.pixivId, password: pwd }
          const { jobId } = await jpost('/login', body)
          setPwd('')
          for (let i = 0; i < 240; i++) {
            await new Promise((r) => setTimeout(r, 500))
            const p = await jget(`/login/poll?jobId=${jobId}`)
            setLoginStep(p.step || '')
            if (p.state === 'ok') {
              setTok(''); notify('登录成功，refresh_token 已落在插件家目录', 'ok'); refresh(); break
            }
            if (p.state === 'failed' || p.state === 'captcha') {
              notify(p.message || '登录失败', 'bad'); break
            }
          }
        } catch (e) { notify(`登录失败：${e.message}`, 'bad') } finally { setBusy(''); setLoginStep('') }
      }

      const install = async () => {
        setBusy('install')
        try {
          await jpost('/install', {})
          notify('开始装依赖，进度写在插件家目录的 install.log；装完会提示', 'ok')
          const t = setInterval(async () => {
            const s = await jget('/install/status').catch(() => null)
            if (s && s.job && s.job.running === false) {
              clearInterval(t); setBusy(''); notify(s.job.ok ? '依赖装好了' : '依赖装失败，看 install.log', s.job.ok ? 'ok' : 'bad'); refresh()
            }
          }, 3000)
        } catch (e) { notify(`装依赖失败：${e.message}`, 'bad'); setBusy('') }
      }

      const check = async () => {
        setBusy('check')
        try {
          const r = await jpost('/check', {})
          notify(r.steps.map((s) => `${s.ok ? '✓' : '✗'} ${s.name}：${s.detail}`).join('\n'), r.ok ? 'ok' : 'bad')
        } catch (e) { notify(`自检失败：${e.message}`, 'bad') } finally { setBusy('') }
      }

      const openReport = async () => {
        try {
          const r = await jget('/report')
          setReport(r.text || '（今天还没有报告）')
        } catch (e) { notify(`读报告失败：${e.message}`, 'bad') }
      }

      if (!cfg) {
        return h('div', { 'data-px': '' },
          h('div', {
            'data-px-say': '', 'data-tone': fatal ? 'bad' : undefined,
            style: { whiteSpace: 'pre-wrap' },
          }, fatal ? `读取配置失败：${fatal}` : '读取配置中…'),
          fatal
            ? h('div', { 'data-px-bar': '' },
                h('button', { 'data-px-btn': '', 'data-primary': '', onClick: refresh }, '重试'),
                h('span', { 'data-px-note': '' }, `接口前缀：${API}`))
            : null,
          h('div', { 'data-px-note': '' }, fatal
            ? '如果一直失败：看 ~/.dsh/pixiv-duty/duty.log 里有没有 "HTTP ... -> 401/404"，或重启一次桌面版。'
            : '正在读取插件配置…'),
        )
      }

      const auth = status?.auth || { state: 'none' }
      const autoRun = Boolean(cfg.autoRun)
      const novelOn = Boolean(cfg.contentNovel)
      const anyContent = cfg.contentIllust || cfg.contentManga || cfg.contentNovel
      const modelList = (agents.providers || []).find((p) => p.id === cfg.agentProvider)?.models || []
      const pickedModel = modelList.find((m) => m.id === cfg.agentModel)
      const picked = pickedModel
        ? { ...pickedModel, providerName: (agents.providers || []).find((p) => p.id === cfg.agentProvider)?.name || cfg.agentProvider }
        : null

      return h('div', { 'data-px': '' },

        /* 状态条 */
        h('div', { 'data-px-bar': '' },
          h('span', { 'data-px-badge': '', 'data-ok': auth.state === 'ok' ? '' : undefined },
            auth.state === 'ok' ? `已登录 ${auth.pixivId || auth.userId || ''}` : '未登录'),
          h('span', { 'data-px-badge': '' }, `今日 ${status?.today?.saved ?? 0} / ${status?.today?.quota ?? cfg.perDay}`),
          h('span', { 'data-px-badge': '' }, `v${status?.version || '0.1.0'}`),
          status?.round?.phase && status.round.phase !== 'done'
            ? h('span', { 'data-px-badge': '', 'data-ok': '' }, `正在跑 ${status.round.id}`) : null,
          h('div', { 'data-px-grow': '' }),
          h('button', {
            'data-px-btn': '', 'data-primary': '', disabled: busy === 'run' || !anyContent,
            onClick: runNow,
          }, busy === 'run' ? '开跑中…' : '现在跑一轮'),
          h('button', { 'data-px-btn': '', onClick: check, disabled: busy === 'check' }, busy === 'check' ? '自检中…' : '测一下'),
        ),

        say ? h('div', { 'data-px-say': '', 'data-tone': say.tone || undefined, style: { whiteSpace: 'pre-wrap' } }, say.text) : null,
        !anyContent ? h('div', { 'data-px-say': '', 'data-tone': 'bad' }, '插画 / 漫画 / 小说 全关了，跑一轮没有意义。') : null,

        /* 账号 */
        h(Section, { title: '账号与登录' },
          h(TextField, {
            label: 'Pixiv 登录名', note: '只用于登录表单；密码不会保存',
            value: cfg.pixivId, onCommit: (v) => save({ pixivId: v }),
          }),
          h(Row, { label: '密码', note: '只在这次登录里用一次，换到 refresh_token 后即丢弃' },
            h('div', { style: { width: 260, display: 'flex', gap: 6 } },
              h('input', {
                'data-px-in': '', type: 'password', value: pwd, placeholder: '••••••••',
                onChange: (e) => setPwd(e.target.value),
              }))),
          h('div', { 'data-px-bar': '' },
            h('button', {
              'data-px-btn': '', 'data-primary': '',
              disabled: busy === 'login' || !cfg.pixivId || !pwd,
              onClick: () => doLogin('edge'),
            }, busy === 'login' ? '登录中…' : '用账号密码登录'),
            h('button', { 'data-px-btn': '', disabled: busy === 'install', onClick: install },
              busy === 'install' ? '装依赖中…' : '装依赖'),
            loginStep ? h('span', { 'data-px-note': '' }, loginStep) : null,
          ),
          h(Row, { label: '或者：手贴 refresh_token', note: '不想让插件碰密码就走这条；只校验一次就存' },
            h('div', { style: { width: 260 } },
              h('input', {
                'data-px-in': '', value: tok, placeholder: '粘贴 refresh_token',
                onChange: (e) => setTok(e.target.value),
              }))),
          h('div', { 'data-px-bar': '' },
            h('button', { 'data-px-btn': '', disabled: !tok || busy === 'login', onClick: () => doLogin('token') }, '用 token 登录'),
            h('span', { 'data-px-note': '' }, auth.updatedAt ? `凭证更新于 ${String(auth.updatedAt).slice(0, 16)}` : '还没有凭证'),
          ),
        ),

        /* 跑哪一轮 */
        h(Section, { title: '用哪个 agent 跑' },
          h(Row, { label: 'Profile', note: '默认 headless；也可以在 $DSH_HOME/profiles 下自建' },
            h('select', {
              'data-px-in': '', style: { width: 180 }, value: cfg.agentProfile,
              onChange: (e) => save({ agentProfile: e.target.value }),
            }, (agents.profiles || [{ id: 'headless' }]).map((p) => h('option', { key: p.id, value: p.id }, p.id)))),
          h(Row, {
            label: '渠道 + 模型',
            note: agents.note
              ? `读不到模型目录：${agents.note}`
              : (picked
                  ? `当前渠道：${picked.providerName} ｜ ${picked.image === true ? '支持读图' : picked.image === false ? '纯文本（插画/漫画用不了）' : '能力未知'}`
                  : '空 = 跟随 profile 的默认模型'),
          },
            h('select', {
              'data-px-in': '', style: { width: 300, maxWidth: '100%' },
              value: cfg.agentProvider && cfg.agentModel ? `${cfg.agentProvider}|${cfg.agentModel}` : '',
              onChange: (e) => {
                const v = e.target.value
                if (!v) return save({ agentProvider: '', agentModel: '' })
                const [provider, ...rest] = v.split('|')
                save({ agentProvider: provider, agentModel: rest.join('|') })
              },
            }, [
              h('option', { key: '', value: '' }, '（跟随 profile 默认）'),
              ...(agents.providers || []).map((p) => h('optgroup', { key: p.id, label: p.name || p.id },
                (p.models || []).length
                  ? p.models.map((m) => h('option', { key: `${p.id}|${m.id}`, value: `${p.id}|${m.id}` },
                      `${m.name}${m.image === false ? ' · 纯文本' : m.image ? ' · 可读图' : ''}`))
                  : [h('option', { key: `${p.id}|`, value: `${p.id}|`, disabled: true }, '（该渠道还没列到模型）')])),
            ])),
          (agents.providers || []).length === 0
            ? h('div', { 'data-px-note': '' },
                '没读到渠道列表：确认插件能在宿主里拿到 llm 服务；也可以先留空，用 profile 默认模型跑。')
            : null,
          h('div', { 'data-px-bar': '' },
            h('button', {
              'data-px-btn': '',
              onClick: async () => {
                try { setAgents(await jget('/agents')); notify('模型目录已刷新') } catch (e) { notify(`刷新失败：${e.message}`, 'bad') }
              },
            }, '刷新模型目录'),
            h('span', { 'data-px-note': '' },
              `${(agents.providers || []).length} 个渠道 / ${(agents.providers || []).reduce((n, p) => n + (p.models?.length || 0), 0)} 个模型`)),
          cfg.agentProvider && HUB_PROVIDER_IDS.includes(cfg.agentProvider) && !cfg.useHubChannel
            ? h('div', { 'data-px-note': '', 'data-warn': '' },
                `${cfg.agentProvider} 属于 Jet Hub 渠道：不开下面的开关，这一轮在 headless 里会找不到它。`)
            : null,
          picked && picked.image === false && (cfg.contentIllust || cfg.contentManga)
            ? h('div', { 'data-px-note': '', 'data-warn': '' }, '所选模型不支持图片输入：插画/漫画判断会直接失败，请换模型或关掉这两项。')
            : null,
          h(ToggleRow, {
            label: '启用 Jet Hub 渠道（CodeBuddy 等）',
            note: 'headless 里加载本机装的 dsh-providers-hub，让它的渠道可以在上面选择',
            on: cfg.useHubChannel,
            onChange: (v) => save({ useHubChannel: v }),
          }),
          status?.hub?.installed
            ? (status.hub.accounts?.length
                ? h('div', {},
                    h('div', { 'data-px-note': '' }, 'Jet Hub 账号：'),
                    ...status.hub.accounts.map((a) => h('div', { 'data-px-note': '', style: { paddingLeft: 12 } },
                      `· ${a.provider} — ${a.name || a.id}${a.disabled ? '（已停用）' : ''}`)))
                : h('div', { 'data-px-note': '' }, 'Jet Hub 已安装，但还没有登录任何账号 —— 到 Jet Hub 的设置里登录 CodeBuddy（腾讯），这里的下拉就会出现它的模型。'))
            : h('div', { 'data-px-note': '' }, '没检测到 dsh-providers-hub（装它的那个 profile 需要在同一台机子上）。'),
        ),

        /* 内容类型 */
        h(Section, { title: '收什么' },
          h(ToggleRow, { label: '插画', note: '单张 / 多张的原创图', on: cfg.contentIllust, onChange: (v) => save({ contentIllust: v }) }),
          h(ToggleRow, { label: '漫画', note: '多页漫画（按页序保存）', on: cfg.contentManga, onChange: (v) => save({ contentManga: v }) }),
          h(ToggleRow, { label: '中文小说', note: '按标签与正文判定语言', on: cfg.contentNovel, onChange: (v) => save({ contentNovel: v }) }),
        ),

        /* 分级 */
        h(Section, { title: '内容分级' },
          h(ToggleRow, {
            label: '收 R-18', note: '需要账号在网页端已开启 R-18 显示；开启后落到 R-18/ 子目录',
            on: cfg.allowR18,
            onChange: (v) => {
              if (v && !window.confirm('确定要收 R-18 内容吗？会单独存放在 R-18/ 子目录。')) return
              save({ allowR18: v })
            },
          }),
        ),

        /* 偏好 */
        h(Section, { title: '偏好（优先按标签搜，再按画面判断）' },
          h(TextField, {
            label: '关注关键词', note: '一行一个；空则用章程里的默认组（DSH / 插件 / 记忆 等）',
            value: (cfg.keywords || []).join('\n'), textarea: true,
            onCommit: (v) => save({ keywords: v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }),
          }),
          h(TextField, {
            label: '必须标签（AND）', note: '一行一个；要求全部命中',
            value: (cfg.requiredTags || []).join('\n'), textarea: true,
            onCommit: (v) => save({ requiredTags: v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }),
          }),
          h(TextField, {
            label: '排除标签', note: '一行一个；任一命中即淘汰',
            value: (cfg.excludeTags || []).join('\n'), textarea: true,
            onCommit: (v) => save({ excludeTags: v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }),
          }),
          h(TextField, {
            label: '标签权重', note: '一行一个 `标签=3`；只影响打分，不影响搜什么',
            value: cfg.tagWeights || '', textarea: true,
            onCommit: (v) => save({ tagWeights: v }),
          }),
          h(NumberField, { label: '收藏数下限', note: '0 = 不设下限；低于它的作品直接忽略', value: cfg.bookmarkMin, min: 0, max: 100000, onCommit: (v) => save({ bookmarkMin: v }) }),
          h(NumberField, { label: '收藏数上限', note: '0 = 不设上限；高于它的作品直接忽略', value: cfg.bookmarkMax, min: 0, max: 100000, onCommit: (v) => save({ bookmarkMax: v }) }),
          h(ToggleRow, {
            label: '启用时间窗',
            note: cfg.daysOn ? `只搜最近 ${cfg.days} 天发布的` : '已关闭：不限发布时间',
            on: cfg.daysOn, onChange: (v) => save({ daysOn: v }),
          }),
          h(NumberField, {
            label: '时间窗（天）', note: cfg.daysOn ? '' : '时间窗已关闭，这项不生效',
            value: cfg.days, min: 1, max: 365, disabled: !cfg.daysOn,
            onCommit: (v) => save({ days: v }),
          }),
        ),

        /* 预算 */
        h(Section, { title: '数量与预算' },
          h(NumberField, { label: '每天最多存', note: '0 = 不自动跑（手动仍可）', value: cfg.perDay, min: 0, max: 100, onCommit: (v) => save({ perDay: v }) }),
          h(NumberField, { label: '单轮最多存', note: '会被当天剩余额度再钳一次', value: cfg.perRound, min: 0, max: 50, onCommit: (v) => save({ perRound: v }) }),
          h(NumberField, { label: '单轮最多看几条元数据', note: '', value: cfg.maxCandidates, min: 5, max: 200, onCommit: (v) => save({ maxCandidates: v }) }),
          h(NumberField, { label: '单轮最多读几张图', note: '每张图都算 token；6 是性价比比较好的档', value: cfg.maxImages, min: 0, max: 40, onCommit: (v) => save({ maxImages: v }) }),
          h(NumberField, { label: '单件最多存几页', note: '漫画特别长时截断', value: cfg.maxPagesPerWork, min: 1, max: 200, onCommit: (v) => save({ maxPagesPerWork: v }) }),
        ),

        /* 保存 */
        h(Section, { title: '保存到哪' },
          h(TextField, {
            label: '保存根目录', note: `空 = 插件家目录下的 library（当前：${status?.env?.saveRoot || ''}）`,
            value: cfg.saveRoot, placeholder: 'D:\\Pixiv',
            onCommit: (v) => save({ saveRoot: v }),
          }),
          h(TextField, {
            label: '目录模板', note: '占位符 {kind} {artist} {title} {id} {year}；必须含 {id}',
            value: cfg.dirTemplate, onCommit: (v) => save({ dirTemplate: v }),
          }),
          h(ToggleRow, {
            label: '存好自动打开文件夹',
            note: '每存下一件就弹出它所在的目录，不用自己去找',
            on: cfg.openAfterSave, onChange: (v) => save({ openAfterSave: v }),
          }),
          h('div', { 'data-px-bar': '' },
            h('button', { 'data-px-btn': '', onClick: () => jpost('/open', { target: 'root' }).catch(() => {}) }, '打开保存目录'),
            h('button', { 'data-px-btn': '', onClick: () => jpost('/open', { target: 'out' }).catch(() => {}) }, '打开报告目录'),
            h('span', { 'data-px-note': '' }, status?.env?.saveRootWritable ? '可写' : `不可写：${status?.env?.error || '未知'}`),
          ),
        ),

        /* 网络 */
        h(Section, { title: '网络' },
          h(TextField, {
            label: '访问 Pixiv 的代理', note: '留空 = 直连；国内多数网络需要填，例如 http://127.0.0.1:12000',
            value: cfg.proxyUrl, placeholder: 'http://127.0.0.1:12000',
            onCommit: (v) => save({ proxyUrl: v.trim() }),
          }),
        ),

        /* 小说 */
        novelOn ? h(Section, { title: '小说' },
          h(Row, { label: '粒度', note: 'auto = 短篇整篇、长篇选段' },
            h('select', {
              'data-px-in': '', style: { width: 160 }, value: cfg.novelMode,
              onChange: (e) => save({ novelMode: e.target.value }),
            }, [['auto', '自动'], ['full', '整篇'], ['excerpt', '选段']].map(([v, t]) => h('option', { key: v, value: v }, t)))),
          h(NumberField, { label: '整篇阈值（字）', note: '不超过就整篇保存', value: cfg.novelFullMaxChars, min: 500, max: 200000, onCommit: (v) => save({ novelFullMaxChars: v }) }),
          h(NumberField, { label: '选段总字数上限', note: '', value: cfg.novelExcerptChars, min: 200, max: 20000, onCommit: (v) => save({ novelExcerptChars: v }) }),
          h(NumberField, { label: '最多选几段', note: '', value: cfg.novelExcerptBlocks, min: 1, max: 30, onCommit: (v) => save({ novelExcerptBlocks: v }) }),
          h(Row, { label: '中文判定', note: 'auto = 语言字段 → 汉字占比 → 标签' },
            h('select', {
              'data-px-in': '', style: { width: 160 }, value: cfg.zhMode,
              onChange: (e) => save({ zhMode: e.target.value }),
            }, [['auto', '自动'], ['language', '看语言字段'], ['script', '看汉字占比'], ['tag', '看标签'], ['off', '不判定']].map(([v, t]) => h('option', { key: v, value: v }, t)))),
          h(TextField, {
            label: '小说正文模糊搜索',
            note: '用自然语言写你想要的场景/情节（例如「雨夜的电车、两个人谁都没先开口」）。只在中文小说上生效：先按关键词筛出候选，再比对正文，相符才收。留空 = 不比对。',
            value: cfg.novelVibe || '', textarea: true,
            placeholder: '例如：主角在旧书店里翻到一封没寄出的信，回忆穿插着现实的雨声',
            onCommit: (v) => save({ novelVibe: v }),
          }),
          h(NumberField, {
            label: '正文匹配度下限', note: '0–1，默认 0.15；调高 = 更严格（可能一件都不收）',
            value: cfg.novelVibeMin, min: 0, max: 1, fraction: true,
            disabled: !String(cfg.novelVibe || '').trim(),
            onCommit: (v) => save({ novelVibeMin: v }),
          }),
        ) : null,

        /* 工作区播报 */
        h(Section, { title: '工作区播报' },
          h(ToggleRow, {
            label: '每轮把状态播报到工作区',
            note: '在 DSH 里挂一个工作区，agent 会回复「下载成功 / 下载失败 / 搜寻无结果」并附下载目录',
            on: cfg.notifyWorkspace, onChange: (v) => save({ notifyWorkspace: v }),
          }),
          h(TextField, {
            label: '工作区目录',
            note: `空 = 插件家目录下的 workspace（当前：${status?.workspace?.path || '—'}）`,
            value: cfg.workspaceDir || '', placeholder: 'D:\\Pixiv\\workspace',
            onCommit: (v) => save({ workspaceDir: v }),
          }),
          h('div', { 'data-px-bar': '' },
            h('button', {
              'data-px-btn': '',
              onClick: () => jpost('/open', { target: 'workspace' }).catch(() => {}),
            }, '打开工作区'),
            h('span', { 'data-px-note': '' },
              status?.workspace?.exists ? '目录已就绪' : '目录还没建（重启插件后自动创建）')),
          status?.lastStatus
            ? h('div', { 'data-px-note': '' },
                `上次播报：${status.lastStatus.status} · 存 ${status.lastStatus.saved} 件 · ${String(status.lastStatus.at).slice(0, 16)}`)
            : null,
        ),

        /* 定时 */
        h(Section, { title: '定时' },
          h(ToggleRow, { label: '谷时自动跑', note: '工作日 9–12 / 14–18 是高峰，其余（含周末）都便宜', on: autoRun, onChange: (v) => save({ autoRun: v }) }),
          autoRun ? h(ToggleRow, { label: '中午 12:00–14:00', note: '', on: cfg.noon, onChange: (v) => save({ noon: v }) }) : null,
          autoRun ? h(ToggleRow, { label: '晚上 18:00–09:00', note: '', on: cfg.night, onChange: (v) => save({ night: v }) }) : null,
        ),

        /* 报告 */
        h(Section, {
          title: '今天',
          extra: h('button', { 'data-px-btn': '', onClick: openReport }, '看报告'),
        },
          report ? h('pre', {
            style: {
              fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto',
              background: 'rgba(128,128,128,.07)', borderRadius: 8, padding: 10, margin: 0,
            },
          }, report) : h('div', { 'data-px-note': '' }, status?.last ? `上一轮：存 ${status.last.saved} 件 · ${String(status.last.at).slice(0, 16)}` : '还没跑过'),
          status?.unsynced?.length
            ? h('div', { 'data-px-note': '', 'data-warn': '' }, `有 ${status.unsynced.length} 项没能同步到 DSH 原生设置（以本页为准）`)
            : null,
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-pixiv-scroll: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots?.inject || !slots?.register) return
        ctx.effect(() => slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'pixiv-duty', order: 30, label: '刷Pixiv' },
          () => h(Panel),
        )), 'dsh-pixiv-scroll: 设置页')
      },
    }
  },
})
