/**
 * 原生弹窗（Windows 用 wscript + VBScript，不弹黑窗口）。
 *
 * 为什么不用面板提示：使用者要的是「我看得见」的警告 —— 他多半不在 DSH 页面上。
 * 这里只做最小实现：能弹、能等回答、等不到就超时放行。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const VQ = (s) => '"' + String(s).replace(/"/g, '""') + '"'

/** VBS 里换行要写成字符串拼接，不能塞裸换行 */
function vbsLines(text) {
  const parts = String(text).split(/\r?\n/).map((l) => VQ(l))
  return parts.join(' & vbCrLf & ')
}

/**
 * @returns {'yes'|'no'|'shown'|'timeout'|'unsupported'}
 */
export function popup({ title = '刷 Pixiv', text = '', yesno = false, timeoutSec = 0, log = () => {} } = {}) {
  if (process.platform !== 'win32') {
    log('非 Windows，跳过弹窗')
    return 'unsupported'
  }
  let dir
  try {
    dir = mkdtempSync(join(tmpdir(), 'pxdlg-'))
  } catch (e) {
    log(`弹窗失败（临时目录）：${e?.message ?? e}`)
    return 'unsupported'
  }
  const out = join(dir, 'answer.txt')
  const vbs = join(dir, 'box.vbs')
  const buttons = yesno ? 4 : 0
  const script = [
    'On Error Resume Next',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `r = MsgBox ${vbsLines(text)}, ${buttons + 64}, ${VQ(title)}`,
    `Set o = fso.CreateTextFile(${VQ(out)}, True)`,
    'o.Write CStr(r)',
    'o.Close',
  ].join('\r\n')
  try {
    writeFileSync(vbs, script, 'utf8')
  } catch (e) {
    log(`弹窗失败（写脚本）：${e?.message ?? e}`)
    return 'unsupported'
  }

  let child = null
  try {
    child = spawn('wscript.exe', ['//nologo', vbs], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch (e) {
    log(`弹窗失败（wscript）：${e?.message ?? e}`)
    return 'unsupported'
  }
  if (!yesno) return 'shown'
  if (!timeoutSec) timeoutSec = 90

  // 等使用者点按钮：每 400ms 看一眼答案文件
  const deadline = Date.now() + timeoutSec * 1000
  const sleepArr = new Int32Array(new SharedArrayBuffer(4))
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      try {
        const v = readFileSync(out, 'utf8').trim()
        if (v === '6') return 'yes'
        if (v === '7') return 'no'
      } catch {
        /* 还在写 */
      }
    }
    Atomics.wait(sleepArr, 0, 0, 400)
  }
  try {
    if (child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* 已经点掉了 */
  }
  log(`弹窗等了 ${timeoutSec}s 没人应，按「不回滚」继续`)
  return 'timeout'
}
