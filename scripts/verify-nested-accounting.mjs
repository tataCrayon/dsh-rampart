/**
 * 最后一条不确定点：外层 Job 的**整树内存上限**，算不算「嵌套 Job 里的进程」？
 *
 * 为什么必须验：DSH 的沙箱子进程（`subprocess-local` 拉起的 pwsh / node）都在
 * 自己的 Job 里。如果外层 Job 不把嵌套 Job 的成员记进账，硬顶就只约束 Electron
 * 自己，真正吃内存的活儿全在账外 —— 硬顶等于没用。
 *
 * ## 拓扑（复刻 DSH 的真实结构）
 *
 *   本进程 ──(自加入)──> 外层 Job(4096 MB)
 *        └─ spawn ──> 中间进程 ──(自加入)──> 内层 Job(无限制)
 *                          └─ spawn ──> hog（吃 250 MB）
 *
 * 若外层记账含内层成员，峰值应 ≥ 200 MB；否则只有几十 MB。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 建一个带整树内存上限的 Job。
 * @param {number} capMb 上限 MB。
 * @returns {any} Job 句柄。
 */
function makeJob(capMb) {
  const job = api.createJobObjectW(null, null)
  const info = Buffer.alloc(144)
  info.writeUInt32LE(0x0200, 16) // JOB_OBJECT_LIMIT_JOB_MEMORY
  info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120)
  assert.notEqual(api.setInformationJobObject(job, 9, info, info.length), 0, 'SetInformationJobObject')
  return job
}

/**
 * 读 Job 峰值整树提交量。
 * @param {any} job Job 句柄。
 * @returns {number} MB。
 */
function peakMb(job) {
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return Number(ext.readBigUInt64LE(136)) / 1048576
}

const dir = mkdtempSync(join(tmpdir(), 'rg-nest-'))
const middleScript = join(dir, 'middle.js')

// 中间进程：建内层 Job → 自加入 → spawn hog（复刻 sandbox 的做法）
writeFileSync(middleScript, `
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const req = createRequire(${JSON.stringify('D:/Projects/MyProjects/dsh-resource-guard/package.json')})
const mod = req(${JSON.stringify(MOD)})
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
}))

const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400
const inner = api.createJobObjectW(null, null)
const handle = api.openProcess(ACCESS, 0, process.pid)
api.assignProcessToJobObject(inner, handle)
api.closeHandle(handle)

spawn(process.execPath, ['-e', "const b=[];for(let i=0;i<250;i+=1)b.push(Buffer.alloc(1048576,1));setTimeout(()=>{},4000)"], {
  stdio: 'ignore',
})
setTimeout(() => process.exit(0), 5000)
`, 'utf8')

const outer = makeJob(4096)
const self = api.openProcess(ACCESS, 0, process.pid)
assert.notEqual(api.assignProcessToJobObject(outer, self), 0, 'self join outer')
api.closeHandle(self)

// 自己在 Job 内 → spawn 出来的中间进程一出生就是外层成员，无需再 assign
const middle = spawn(process.execPath, [middleScript], { stdio: 'ignore' })
void middle

await new Promise((r) => setTimeout(r, 4500))
const value = peakMb(outer)
console.log(`外层 Job 峰值整树提交：${value.toFixed(1)} MB（其中内层 hog 占 250 MB）`)

api.closeHandle(outer)

assert.ok(value >= 200, `嵌套 Job 成员的提交量应当计入外层，实测仅 ${value.toFixed(1)} MB`)
console.log('RESULT: PASS — 外层 Job 记账包含嵌套 Job 里的进程，沙箱拉起的 pwsh/node 也在硬顶之内')
