/**
 * tools/host-resolver.mjs —— 预检用的 ESM 解析钩子
 * ============================================================================
 * 目的：让**普通 node** 也能 import 我们插件的 `index.js`（它 import 了
 * `@deepseek-ai/schemastery` / `@deepseek-ai/dsh-tools`，这两个包只有宿主里有）。
 *
 * 为什么不用 junction/symlink：沙箱里 `New-Item -ItemType Junction` 被拒（Access is denied）。
 * 为什么用宿主**同一份**包：`defineTool` 的 schema 校验规则就是宿主那份的规则 —— 预检要的就是它。
 * ⚠️ 入口要看各自的 `exports['.']` —— schemastery 的 ESM 入口是 `lib/index.mjs`（不是 index.js）。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'

// 自动探测宿主那份包在哪（不写死任何人的路径 ✓）；探测不到就让人显式给 DSH_HOST_MODULES
const HOST = process.env.DSH_HOST_MODULES || [
  process.env.APPDATA && process.env.APPDATA + '/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
].filter(Boolean).find((p) => existsSync(p))

const cache = new Map()

// ⚠️ 不在模块顶层抛错：selfcheck 现在直接 import（不再裸 import @deepseek-ai/*），
//    这个钩子只在显式 `--import ./tools/register.mjs` 时才需要。
function entryOf(name) {
  if (!HOST) throw new Error('host-resolver: 找不到 dsh 的 node_modules；请设 DSH_HOST_MODULES=<.../@deepseek-ai>')
  if (cache.has(name)) return cache.get(name)
  const dir = `${HOST}/${name}`
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const dot = pkg.exports?.['.']
  const rel = typeof dot === 'string'
    ? dot
    : (dot?.import || dot?.default || pkg.module || pkg.main)
  if (!rel) throw new Error(`host-resolver: 找不到 ${name} 的入口`)
  const url = `file:///${dir}/${String(rel).replace(/^\.\//, '')}`
  cache.set(name, url)
  return url
}

export async function resolve(specifier, context, next) {
  if (!HOST) return next(specifier, context)
  const m = /^@deepseek-ai\/([^/]+)$/.exec(specifier)
  if (m) return { url: entryOf(m[1]), shortCircuit: true }
  return next(specifier, context)
}
