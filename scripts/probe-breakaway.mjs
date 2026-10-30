// 诊断六：Chromium 给 renderer/gpu 起子进程时会不会用 CREATE_BREAKAWAY_FROM_JOB 逃走？
//
// 这是「Job 硬顶对 Electron 到底有没有用」的最后一环：后代默认继承 Job（probe-job-inherit
// 已证），但 CREATE_BREAKAWAY_FROM_JOB 可以显式逃离 —— 前提是父 Job 允许 breakaway。
// 我们的 Job 不设 JOB_OBJECT_LIMIT_BREAKAWAY_OK，所以 breakaway 创建应当直接失败。
//
// 直接调 CreateProcessW 验证这一点（Node 的 spawn 不给传 creationFlags）。
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  getLastError: kernel32.func('uint32 GetLastError()'),
  createProcessW: kernel32.func(
    'int CreateProcessW(str16 app, str16 cmd, void *pa, void *ta, int inherit, uint32 flags, void *env, str16 cwd, void *si, void *pi)',
  ),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400
const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000
const ERROR_ACCESS_DENIED = 5

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16) // 只设 JOB_MEMORY，**不设** BREAKAWAY_OK
info.writeBigUInt64LE(4096n * 1024n * 1024n, 120)
console.log('set job (no BREAKAWAY_OK):', api.setInformationJobObject(job, 9, info, 144))

const self = api.openProcess(ACCESS, 0, process.pid)
console.log('self join job            :', api.assignProcessToJobObject(job, self))
api.closeHandle(self)

/**
 * 用 koffi 直接调 CreateProcessW，带指定的 creationFlags。
 * @param {number} flags 创建标志。
 * @returns {{ok: boolean, error: number, pid: number}} 结果。
 */
function createProcess(flags) {
  const buf = Buffer.alloc(104)
  buf.writeUInt32LE(104, 0)
  const pi = Buffer.alloc(24)
  const ok = api.createProcessW(null, 'cmd.exe /c exit 0', null, null, 0, flags, null, null, buf, pi)
  return { ok: ok !== 0, error: ok !== 0 ? 0 : api.getLastError(), pid: pi.readUInt32LE(0) }
}

const plain = createProcess(0)
console.log('CreateProcessW (plain)          :', JSON.stringify(plain))
const escape = createProcess(CREATE_BREAKAWAY_FROM_JOB)
console.log('CreateProcessW (BREAKAWAY)      :', JSON.stringify(escape))

if (plain.pid) {
  try {
    process.kill(plain.pid)
  } catch {
    /* 已退出 */
  }
}
if (escape.pid) {
  try {
    process.kill(escape.pid)
  } catch {
    /* 已退出 */
  }
}
api.closeHandle(job)

if (escape.ok) {
  console.log('RESULT: FAIL — 子进程能 breakaway 出 Job，硬顶可被绕过')
  process.exit(1)
}
if (escape.error !== ERROR_ACCESS_DENIED) {
  console.log(`RESULT: WARN — breakaway 确实失败，但错误码是 ${escape.error} 而非预期的 5`)
  process.exit(0)
}
console.log('RESULT: PASS — Job 未授权 breakaway 时，CREATE_BREAKAWAY_FROM_JOB 直接 ERROR_ACCESS_DENIED(5)')
console.log('        即 Chromium 无法把 renderer/gpu 移出 Job，整树硬顶不可绕过')
