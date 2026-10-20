/**
 * tools/register.mjs —— 注册解析钩子（Node 22 的 module.register 用法）
 * 用法：node --import ./tools/register.mjs selfcheck.mjs
 *
 * ⚠️ 第二个参数是 **parentURL**（基准），不是被注册模块的 URL ——
 *    第一版我写成 `pathToFileURL(import.meta.url)`，结果拼出一个
 *    `file:///…/file:/…` 的怪路径（ERR_MODULE_NOT_FOUND）。正确写法：
 */
import { register } from 'node:module'

register(new URL('./host-resolver.mjs', import.meta.url), import.meta.url)
