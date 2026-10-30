/**
 * 真机验证：Job 的**整树**内存上限，到底算不算「之后才 spawn 的后代」。
 *
 * 为什么这条最关键：Electron 是 main + renderer + gpu + utility 的多进程结构，
 * renderer 都是在 main 起来之后才 spawn 的。如果 JobMemoryLimit 只约束被显式加入
 * Job 的那一个进程，启动壳的「子进程自动继承」假设就是错的，硬顶等于没有。
 *
 * ## 两个已经踩过的坑（都让这条验证**假通过**过）
 *
 * 1. **串行分配撑不爆上限。** 第一版 3 × 300 MB 是一个一个跑的，峰值只有 300 MB，
 *    768 MB 的上限当然不触发。
 * 2. **竞态：孩子比 assign 先出生。** 第二版改成并发，但父进程一起来就 spawn，
 *    我们的 `AssignProcessToJobObject` 往往还没执行完 —— 那些孩子不算 Job 成员，
 *    自然不受限。所以这里必须**握手**：父进程先报 pid 并等信号，加入 Job 后才 spawn。
 *
 * 3. **撞墙是 `FATAL ERROR ... heap out of memory`，退出码 134，不可捕获。**
 *    所以断言只能看退出码，不能指望它吐出可读错误。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
if (!existsSync(MOD)) {
  console.log(`SKIP: 找不到 ${MOD}`)
  process.exit(0)
}

const mod = await import(pathToFileURL(MOD).href)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 轮询等一个文件出现。
 * @param {string} file 文件路径。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {Promise<boolean>} 是否出现。
 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * 读 Job 的峰值整树提交量。
 * @param {any} job Job 句柄。
 * @returns {number} 峰值 MB。
 */
function peakJobMb(job) {
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return Number(ext.readBigUInt64LE(136)) / 1048576
}

const dir = mkdtempSync(join(tmpdir(), 'rg-tree-'))
const reportFile = join(dir, 'children.json')
const hog = join(dir, 'hog.js')
const parentScript = join(dir, 'parent.js')
const readyFile = join(dir, 'ready')
const goFile = join(dir, 'go')

// 逐块分配并触碰，保证提交量真的被记账
writeFileSync(hog, `
  const mb = Number(process.argv[2])
  const chunks = []
  for (let i = 0; i < mb; i += 1) chunks.push(Buffer.alloc(1024 * 1024, 1))
  setTimeout(() => { console.log('OK ' + mb) }, 2500)
`, 'utf8')

// 父进程：报 pid → 等 go → 并发 spawn 3 个 → 全部结束后落盘
writeFileSync(parentScript, `
  const { spawn } = require('node:child_process')
  const { writeFileSync, existsSync } = require('node:fs')
  const one = (mb) => new Promise((resolve) => {
    const c = spawn(process.execPath, [${JSON.stringify(hog)}, String(mb)], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d.toString() })
    c.on('exit', (code) => resolve({ mb, code, out: out.trim() }))
  })
  writeFileSync(${JSON.stringify(readyFile)}, String(process.pid))
  const wait = setInterval(() => {
    if (!existsSync(${JSON.stringify(goFile)})) return
    clearInterval(wait)
    Promise.all([one(300), one(300), one(300)]).then((r) => {
      writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(r))
      process.exit(0)
    })
  }, 50)
`, 'utf8')

const CAP = 768
const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16) // JOB_OBJECT_LIMIT_JOB_MEMORY
info.writeBigUInt64LE(BigInt(CAP) * 1_048_576n, 120)
assert.notEqual(api.setInformationJobObject(job, 9, info, info.length), 0, 'SetInformationJobObject')

const parent = spawn(process.execPath, [parentScript], { stdio: 'ignore' })
assert.ok(await waitForFile(readyFile, 5000), '父进程应当在 5s 内报到')

const handle = api.openProcess(ACCESS, 0, parent.pid)
assert.ok(handle, 'openProcess(parent)')
assert.notEqual(api.assignProcessToJobObject(job, handle), 0, 'assign parent to job')
api.closeHandle(handle)

// 握手后再放行：此刻父进程已是 Job 成员，它 spawn 的孩子才会继承
writeFileSync(goFile, '1')
console.log(`Job 整树上限 ${CAP} MB —— 3 个 300 MB 子进程**并发**（合计 900 MB），应当有进程撞墙`)

await new Promise((resolve) => parent.on('exit', resolve))
const children = JSON.parse(readFileSync(reportFile, 'utf8'))
const peak = peakJobMb(job)
api.closeHandle(job)

console.log('子进程结果：', JSON.stringify(children))
console.log(`Job 峰值整树提交：${peak.toFixed(1)} MB（上限 ${CAP} MB）`)

const failed = children.filter((child) => child.code !== 0).length
assert.ok(failed >= 1, `并发超过整树上限时至少一个子进程必须失败，实际 ${failed} 个`)
assert.ok(peak >= CAP * 0.95, `Job 应记账到接近上限的峰值，实际 ${peak.toFixed(1)} MB`)
console.log('RESULT: PASS — Job 整树上限计入「加入后才 spawn 的后代」，多进程 Electron 被正确约束')
