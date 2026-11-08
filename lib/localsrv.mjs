/**
 * lib/localsrv.mjs —— 只监听 127.0.0.1 的小服务
 * ============================================================================
 * 为什么需要它：
 *   预览页是**浏览器里打开的本地页面**，勾完直接下载必须能打到插件里来。
 *   file:// 页面跨源调不了宿主接口（桌面版没有 TCP 端口），所以插件自己起一个
 *   回环端口，把「页面 / 缩略图 / 点头落盘」三件事放在同源上。
 *
 * 安全：
 *   · 只 bind 127.0.0.1
 *   · URL 里带随机 token，没有 token 一律 404
 *   · POST 只认 /p/<round>/approve
 * ============================================================================
 */
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import { pageFile, roundSlug, latestRound, writeRoundPage, thumbsDir } from './picks.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function raw(res, code, buf, type) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-cache' })
  res.end(buf)
}

function readBody(req) {
  return new Promise((resolve) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > 256 * 1024) { req.destroy(); resolve({}); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const t = Buffer.concat(chunks).toString('utf8')
      try { resolve(t ? JSON.parse(t) : {}) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * @param {object} o
 * @param {string} o.home
 * @param {Function} o.getCfg   () => cfg
 * @param {Function} o.approve  ({ items, round, note }) => Promise<object>
 * @param {Function} [o.log]
 */
export async function startLocalServer({ home, getCfg, approve, log = () => {} }) {
  // token 存盘：重启之后预览页链接不变，可以收藏
  const tokFile = join(home, 'preview-token.txt')
  let token = ''
  try { token = readFileSync(tokFile, 'utf8').trim() } catch { /* 第一次 */ }
  if (!/^[a-f0-9]{8,64}$/.test(token)) {
    token = randomBytes(9).toString('hex')
    try { writeFileSync(tokFile, token, 'utf8') } catch { /* 写不了就每次随机 */ }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const p = decodeURIComponent(url.pathname)
      const method = (req.method || 'GET').toUpperCase()

      if (p === '/health') return json(res, 200, { ok: true, app: 'pixiv-duty' })

      if (!p.startsWith(`/${token}/`)) return json(res, 404, { ok: false, error: 'not found' })
      const rest = p.slice(token.length + 2)

      // 点头落盘
      const mApprove = rest.match(/^p\/([^/]+)\/approve$/)
      if (mApprove && method === 'POST') {
        const roundId = mApprove[1]
        const body = await readBody(req)
        const cfg = getCfg()
        const r = await approve({ items: body.items ?? body.ids ?? [], round: body.round || roundId, note: body.note || '' })
        try { writeRoundPage({ cfg, home, roundId: body.round || roundId }) } catch { /* ignore */ }
        return json(res, 200, r)
      }

      // 预览页
      const mPage = rest.match(/^p\/([^/]+)$/)
      if (mPage && method === 'GET') {
        const cfg = getCfg()
        const f = pageFile(cfg, home, mPage[1])
        if (!existsSync(f)) return raw(res, 404, Buffer.from('这一轮没有预览页了', 'utf8'), MIME['.html'])
        return raw(res, 200, readFileSync(f), MIME['.html'])
      }

      // 缩略图
      const mThumb = rest.match(/^p\/([^/]+)\/thumbs\/(.+)$/)
      if (mThumb && method === 'GET') {
        const cfg = getCfg()
        const file = mThumb[2].replace(/[\\/]/g, '')
        const f = join(thumbsDir(cfg, home, mThumb[1]), file)
        if (!existsSync(f)) return raw(res, 404, Buffer.alloc(0), 'text/plain')
        return raw(res, 200, readFileSync(f), MIME[extname(f).toLowerCase()] || 'application/octet-stream')
      }

      if (rest === 'latest' && method === 'GET') {
        const rid = latestRound(getCfg(), home)
        if (!rid) return raw(res, 404, Buffer.from('还没有任何一轮', 'utf8'), MIME['.html'])
        res.writeHead(302, { location: `/${token}/p/${roundSlug(rid)}` })
        return res.end()
      }

      return json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      log(`预览服务出错：${e?.message ?? e}`)
      return json(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  })

  const wanted = Number(getCfg()?.previewPort || 0)
  let port = 0
  const listen = (p) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(p, '127.0.0.1', () => resolve(server.address().port))
  })
  try {
    port = await listen(wanted && wanted > 1024 ? wanted : 0)
  } catch {
    port = await listen(0)
  }

  const origin = `http://127.0.0.1:${port}/${token}`
  log(`预览服务 ${origin}`)
  return {
    origin,
    port,
    token,
    dispose: () => new Promise((r) => server.close(() => r())),
  }
}
