/**
 * lib/login-pixiv.mjs —— 密码 → refresh_token（一次性），之后全程 App API
 * ============================================================================
 * 为什么不能"账号密码直接调接口"：
 *   Pixiv 的登录页有 Cloudflare + reCAPTCHA，纯 HTTP 直登早已不可用。
 *   官方客户端走的是 OAuth PKCE：浏览器里完成登录 → 回调地址带 `code`
 *   → 用 code + code_verifier 换 access_token / refresh_token。
 *
 * 所以这里的流程是：
 *   ① 起一个 **本机已有的 Edge**（playwright-core 的 channel:'msedge'，不下载 Chromium）
 *   ② 打开 app-api 的登录页，把账号密码填进去
 *   ③ 四路竞速抓 `code`（URL 跳转 / request 事件 / framenavigated / 轮询）
 *   ④ 换 token，落 credential.json（0600），密码随函数返回即丢
 *
 * 拿不到 code 时的两条退路：有头 Edge 再试一次；还不行就让用户手贴 refresh_token。
 * ============================================================================
 */
import { createHash, randomBytes } from 'node:crypto'
import { writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT'
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'
const APP_UA = 'PixivAndroidApp/5.0.234 (Android 11; Pixel 5)'
const APP_SECRET = '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c'
const REDIRECT = 'https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback'
const LOGIN_URL = 'https://app-api.pixiv.net/web/v1/login'
const TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token'

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function makePkce() {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

function appHeaders() {
  const t = new Date().toISOString()
  const hash = createHash('md5').update(t + APP_SECRET).digest('hex')
  return {
    'User-Agent': APP_UA,
    'App-OS': 'android',
    'App-OS-Version': '11',
    'App-Version': '5.0.234',
    'X-Client-Time': t,
    'X-Client-Hash': hash,
  }
}

async function postToken(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { ...appHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      include_policy: 'true',
      ...body,
    }),
  })
  let json = {}
  try { json = await res.json() } catch { /* 有时是空体 */ }
  if (!res.ok || json?.error) {
    const code = json?.errors?.system?.message || json?.error || `HTTP ${res.status}`
    throw Object.assign(new Error(`换取 token 失败：${code}`), { code: 'TOKEN_EXCHANGE' })
  }
  const r = json.response || {}
  return {
    accessToken: r.access_token || '',
    refreshToken: r.refresh_token || '',
    userId: r.user?.id ? String(r.user.id) : '',
    pixivId: r.user?.account || '',
    expiresIn: Number(r.expires_in || 3600),
  }
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * ✅ 在**浏览器里**用表单 POST 换 token。
 * 为什么不在 Node 里 fetch：这台机器上 Node 直连 Pixiv 超时、沙箱代理对 pixiv 返回 502，
 * 而浏览器走的是系统代理（能通）。表单导航是顶层导航，不受 CORS 限制，
 * 响应体（application/json）会被 Chromium 原样渲染成文本，读 body 即可。
 */
async function postTokenInBrowser(page, body) {
  const fields = {
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    include_policy: 'true',
    ...body,
  }
  const postData = new URLSearchParams(fields).toString()

  // 用路由拦截把一次"浏览器导航"改写成带官方 App 头的 POST：
  //   · 走的是 Chromium 的网络栈（系统代理，能到 Pixiv）
  //   · 头里有 App-OS / App-Version / X-Client-Hash —— 少了这些容易被判成脚本
  const handler = async (route) => {
    try {
      await route.continue({
        method: 'POST',
        postData,
        headers: { ...appHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      })
    } catch {
      try { await route.abort() } catch { /* 忽略 */ }
    }
  }
  await page.route('**/auth/token*', handler)
  let text = ''
  try {
    await page.goto(`${TOKEN_URL}?t=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
    await page.waitForTimeout(1500)
    text = (await page.innerText('body').catch(() => '')).trim()
  } finally {
    await page.unroute('**/auth/token*', handler).catch(() => {})
  }

  let json = {}
  try { json = JSON.parse(text) } catch { /* 不是 JSON 就是被拦了 */ }
  if (!json?.response?.refresh_token) {
    const why = json?.errors?.system?.message || json?.error || text.slice(0, 200).replace(/\s+/g, ' ') || '响应为空'
    throw Object.assign(new Error(`浏览器内换 token 失败：${why}`), { code: 'TOKEN_EXCHANGE' })
  }
  const r = json.response
  return {
    accessToken: r.access_token || '',
    refreshToken: r.refresh_token || '',
    userId: r.user?.id ? String(r.user.id) : '',
    pixivId: r.user?.account || '',
    expiresIn: Number(r.expires_in || 3600),
  }
}

/** 手贴 token：先验证一次再落盘（Node 直连不通时自动退回浏览器） */
export async function loginWithToken({ refreshToken, home }) {
  const token = String(refreshToken || '').trim()
  if (!token) throw Object.assign(new Error('refresh_token 为空'), { code: 'BAD_REQUEST' })
  const body = { grant_type: 'refresh_token', refresh_token: token }
  let t
  try {
    t = await postToken(body)
  } catch (e) {
    try {
      const pw = await loadPlaywright()
      if (!pw) throw e
      let b = null
      for (const channel of channelCandidates()) {
        try { b = await pw.chromium.launch({ channel, headless: true }); break } catch { /* 下一个 */ }
      }
      if (!b) throw e
      try {
        const page = await b.newPage()
        t = await postTokenInBrowser(page, body)
      } finally { await b.close() }
    } catch {
      throw Object.assign(new Error('这个 refresh_token 用不了（可能已失效，或网络到不了 Pixiv）'), { code: 'INVALID_TOKEN' })
    }
  }
  return saveCredential(home, { ...t, refreshToken: t.refreshToken || token })
}

/** 落盘：只存 token 与 userId，绝不存密码 */
export function saveCredential(home, cred) {
  const file = join(home, 'credential.json')
  const data = {
    version: 1,
    userId: cred.userId || '',
    pixivId: cred.pixivId || '',
    refreshToken: cred.refreshToken || '',
    accessToken: cred.accessToken || '',
    accessTokenExpiresAt: Date.now() + Number(cred.expiresIn || 3600) * 1000,
    webCookie: cred.webCookie || {},
    updatedAt: new Date().toISOString(),
  }
  if (existsSync(file)) {
    // 保留上一次导出的 web cookie（小说正文兜底要用）
    try {
      const old = JSON.parse(readFileSync(file, 'utf8'))
      if (!data.webCookie?.PHPSESSID && old?.webCookie) data.webCookie = old.webCookie
    } catch { /* 忽略 */ }
  }
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  try { chmodSync(file, 0o600) } catch { /* Windows 上忽略 */ }
  return { userId: data.userId, pixivId: data.pixivId }
}

async function loadPlaywright() {
  const candidates = ['playwright-core', 'playwright']
  for (const name of candidates) {
    try { return await import(name) } catch { /* 下一个 */ }
  }
  return null
}

function channelCandidates() {
  if (process.platform === 'win32') return ['msedge', 'chrome']
  if (process.platform === 'darwin') return ['chrome', 'msedge']
  return ['chrome', 'msedge']
}

/**
 * 浏览器登录。返回 { ok, state, message, credential? }
 * state: ok | captcha | timeout | selectors | no_browser | bad_credentials
 */
export async function loginWithBrowser({ mode = 'edge', pixivId, password, home, onStep = () => {} }) {
  const pw = await loadPlaywright()
  if (!pw) {
    return { ok: false, state: 'no_browser', message: '没装 playwright-core，改用手贴 refresh_token' }
  }
  const { chromium } = pw
  const { verifier, challenge } = makePkce()
  const url = `${LOGIN_URL}?code_challenge=${challenge}&code_challenge_method=S256&client=pixiv-android`

  let browser = null
  let context = null
  try {
    if (mode === 'cdp') {
      const cdp = process.env.PIXIV_LOGIN_CDP || 'http://127.0.0.1:9222'
      onStep(`连接已开的浏览器：${cdp}`)
      browser = await chromium.connectOverCDP(cdp)
      context = browser.contexts()[0] || await browser.newContext()
    } else {
      // 2026-10 实测：新浏览器必出 reCAPTCHA，无头基本过不去 ⇒ **默认有头**。
      // 想无头就显式 PIXIV_LOGIN_HEADLESS=1（并通过 CDP 复用已登录浏览器）。
      const headless = process.env.PIXIV_LOGIN_HEADLESS === '1'
      // ⭐ 持久化 profile：reCAPTCHA 的清关记录、cookie 都留在插件家里，
      //    下次不用再验一遍（也让"选择账号"页能直接点）。
      const userDataDir = join(home, 'browser-profile')
      let lastErr = null
      for (const channel of channelCandidates()) {
        try {
          onStep(`启动本机 ${channel}（${headless ? '无头' : '有头'}，持久 profile）`)
          context = await chromium.launchPersistentContext(userDataDir, {
            channel,
            headless,
            args: ['--disable-blink-features=AutomationControlled', ...(headless ? [] : ['--start-maximized'])],
            locale: 'zh-CN',
            viewport: headless ? { width: 1280, height: 900 } : null,
          })
          break
        } catch (e) { lastErr = e }
      }
      if (!context) {
        return { ok: false, state: 'no_browser', message: `本机没有可用的 Edge/Chrome：${lastErr?.message ?? ''}` }
      }
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      })
    }

    const page = await context.newPage()
    onStep('打开 Pixiv 登录页')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })

    // ⭐ 监听必须在**任何点击之前**挂上：授权成功时 pixiv 会用自定义协议
    //    `pixiv://account/login?code=…` 返回，这个请求在点击后 1 秒内就发出，
    //    晚挂 2–3 秒就永远等不到（实测踩过）。
    const WAIT_MS = Math.max(30000, Number(process.env.PIXIV_LOGIN_WAIT_MS || 300000))
    const codePromise = new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      const grab = (s) => {
        const text = String(s)
        const m = /[?&]code=([A-Za-z0-9_-]+)/.exec(text)
        if (m && !/code_challenge/.test(text)) finish(m[1])
      }
      const timer = setTimeout(() => finish(null), WAIT_MS)
      timer.unref?.()
      page.on('request', (r) => grab(r.url()))
      page.on('framenavigated', (f) => grab(f.url()))
      context.on('request', (r) => grab(r.url()))
      const poll = setInterval(() => grab(page.url()), 250)
      setTimeout(() => { clearInterval(poll); clearTimeout(timer) }, WAIT_MS).unref?.()
    })

    // 已经登录过（CDP 复用）⇒ 直接等 code
    if (pixivId && password) {
      onStep('填写账号密码')
      const USER_SEL = 'input[autocomplete*="username"], input[placeholder*="邮箱"], input[placeholder*="pixiv"]'
      const PASS_SEL = 'input[type="password"]'
      try {
        // 2026-10 实测：accounts.pixiv.net 的输入框**没有 name / id**，
        // 只有 placeholder 与 autocomplete；另外还有个隐私政策弹层要先关掉。
        const okBtn = page.getByText('OK', { exact: true }).first()
        if (await okBtn.isVisible().catch(() => false)) {
          await okBtn.click({ timeout: 3000 }).catch(() => {})
          onStep('关掉了隐私政策提示')
        }

        // 持久 profile 里已经有会话时，页面不会给表单 ⇒ 先处理这几种"已登录"形态
        let hasForm = await page.waitForSelector(USER_SEL, { timeout: 8000 }).then(() => true).catch(() => false)
        if (!hasForm) {
          const emailBtn = page.getByRole('button', { name: /使用邮箱登录|メールアドレスでログイン|Log in with email/i }).first()
          if (await emailBtn.count().catch(() => 0)) {
            onStep('已登录状态：切到「使用邮箱登录」')
            await emailBtn.click({ timeout: 5000 }).catch(() => {})
            hasForm = await page.waitForSelector(USER_SEL, { timeout: 10000 }).then(() => true).catch(() => false)
          }
        }
        if (!hasForm) {
          // 持久 profile 已登录时，这里出现的是「继续使用此账号」的账号选择页
          const cont = page.getByRole('button', { name: /继续使用此账号|このアカウントで続行|Continue with this account/i }).first()
          if (await cont.count().catch(() => 0)) {
            onStep('已登录状态：继续使用此账号')
            await cont.click({ timeout: 8000 }).catch(() => {})
          } else {
            // 账号选择页：直接点那个账号（不用密码）
            const acct = page.locator('[data-user-id], .account-item, a[href*="users/auth/pixiv/start"]').first()
            if (await acct.count().catch(() => 0)) {
              onStep('已登录状态：点选账号')
              await acct.click({ timeout: 5000 }).catch(() => {})
            } else {
              // 既没表单也没账号可选：可能已经跳到回调了，直接进等待
              onStep('没看到登录表单（可能已直接授权）')
            }
          }
        }

        if (await page.locator(USER_SEL).count().catch(() => 0)) {
          await page.fill(USER_SEL, pixivId)
          await page.fill(PASS_SEL, password)
          const submit = page.locator('button[type="submit"]').filter({ hasText: /登录|ログイン|Log in/i }).first()
          if (await submit.count()) await submit.click({ timeout: 8000 })
          else await page.press(PASS_SEL, 'Enter')
          onStep('已提交，等待跳转')
        }

        // reCAPTCHA：先试着点一下复选框；点了还不过就是图片挑战，只能等人
        await page.waitForTimeout(2500)
        for (const f of page.frames()) {
          if (!/recaptcha/.test(f.url())) continue
          const anchor = f.locator('#recaptcha-anchor')
          if (await anchor.count().catch(() => 0)) {
            await anchor.click({ timeout: 4000 }).catch(() => {})
            break
          }
        }
        const bframe = page.locator('iframe[src*="recaptcha"][src*="bframe"]').first()
        if (await bframe.isVisible().catch(() => false)) {
          onStep('需要你在打开的窗口里完成人机验证（勾选 / 选图），完成后这里会自动继续')
        }
      } catch (e) {
        return { ok: false, state: 'selectors', message: `登录表单填不进去：${e?.message ?? e}` }
      }
    }

    onStep('等待 OAuth 回调里的 code')
    const code = await codePromise

    if (!code) {
      // ⚠️ 不可见 reCAPTCHA 的 anchor iframe **一直都在**，不能拿它判断"被拦"；
      //    只有 bframe（点选挑战）可见，或页面明确提示验证失败，才算被拦。
      const challenge = await page.locator('iframe[src*="recaptcha"][src*="bframe"]').first().isVisible().catch(() => false)
      const body = await page.innerText('body').catch(() => '')
      const blocked = challenge || /人机验证|不是机器人|验证失败|try again/i.test(body)
      return {
        ok: false,
        state: blocked ? 'captcha' : 'timeout',
        message: blocked ? '被人机验证拦住了（改用有头模式或手贴 token）' : '120 秒内没拿到 code（账号密码错误 / 页面改版 / 风控）',
      }
    }

    onStep('用 code 换 token')
    const tokenBody = {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
    }
    let t
    try {
      t = await postTokenInBrowser(page, tokenBody)
      onStep('已在浏览器内换到 token')
    } catch (e1) {
      onStep(`浏览器内换取失败：${String(e1?.message || e1).slice(0, 140)}`)
      try {
        t = await postToken(tokenBody)
      } catch (e2) {
        throw new Error(`两条换 token 通道都失败：${e1?.message || e1} ／ ${e2?.message || e2}`)
      }
    }

    // 顺手导出 web cookie（小说正文 Web 通道兜底用；拿不到不影响主流程）
    let webCookie = {}
    try {
      const cookies = await context.cookies('https://www.pixiv.net')
      for (const c of cookies || []) {
        if (c.name === 'PHPSESSID' || c.name === 'device_token') webCookie[c.name] = c.value
      }
    } catch { /* 忽略 */ }

    const saved = saveCredential(home, { ...t, webCookie, pixivId: t.pixivId || pixivId })
    return { ok: true, state: 'ok', credential: saved }
  } catch (e) {
    return { ok: false, state: 'error', message: String(e?.message ?? e).slice(0, 300) }
  } finally {
    try { if (mode !== 'cdp') await context?.close() } catch { /* 忽略 */ }
    try { if (mode === 'cdp') await browser?.close() } catch { /* 忽略 */ }
  }
}
