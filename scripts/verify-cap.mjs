/**
 * 真机验证：Job Object 的整树内存硬顶**真的会**拒绝分配。
 *
 * 只验证「SetInformationJobObject 返回 1」是不够的 —— 那只证明参数被接受。
 * 这里走完整链路：建 Job → 起子进程 → 加入 Job → 让子进程吃超限额 →
 * 断言它拿到分配失败且**父进程不受影响**。
 *
 * 这也同时验证了本仓库最重要的一条边界（见 docs/decisions/005-资源护栏.md）：
 * 限额只在子进程上，父子退出后 Job 关闭，不污染调用者。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'

if (!existsSync(MOD)) {
  console.error(`跳过：找不到 ${MOD}`)
  process.exit(0)
}

const mod = await import(pathToFileURL(MOD).href)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
}))

/**
 * 加入 Job 需要的访问权限。
 *
 * `PROCESS_SET_QUOTA | PROCESS_SET_INFORMATION` 是不够的 —— 实测（scripts/probe-access.cjs）
 * 少 `PROCESS_TERMINATE` 时 `AssignProcessToJobObject` 返回 `ERROR_ACCESS_DENIED(5)`，
 * 这个错误码完全不提示真正原因，很容易被误判成「权限不够」或「不支持嵌套 Job」。
 */
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 建一个指定整树内存上限的 Job。
 * @param {number} capMb 上限 MB。
 * @returns {any} Job 句柄。
 */
function makeJob(capMb) {
  const job = api.createJobObjectW(null, null)
  const info = Buffer.alloc(144)
  info.writeUInt32LE(0x0200 | 0x2000, 16) // JOB_MEMORY | KILL_ON_CLOSE
  info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120) // JobMemoryLimit
  const ok = api.setInformationJobObject(job, 9, info, info.length)
  if (ok === 0) throw new Error('SetInformationJobObject failed')
  return job
}

/**
 * 起一个「尝试分配 N MB 并写入」的子进程，可选地加入 Job。
 * @param {number} allocMb 尝试分配量。
 * @param {any} [job] Job 句柄；省略则不设限。
 * @returns {Promise<{code: number, out: string}>} 结果。
 */
function runAllocator(allocMb, job) {
  const script = `
    const bufs = []
    try {
      for (let i = 0; i < ${allocMb}; i += 1) bufs.push(Buffer.alloc(1024 * 1024, 1))
      console.log('ALLOC_OK ' + bufs.length)
    } catch (error) {
      console.log('ALLOC_FAIL ' + (error.code ?? error.name))
      process.exit(3)
    }
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    if (job) {
      const handle = api.openProcess(ACCESS, 0, child.pid)
      if (!handle) return reject(new Error(`OpenProcess(${child.pid}) failed`))
      const assigned = api.assignProcessToJobObject(job, handle) !== 0
      api.closeHandle(handle)
      if (!assigned) return reject(new Error('AssignProcessToJobObject failed'))
    }
    child.on('exit', (code) => resolve({ code: code ?? 0, out: out.trim() }))
  })
}

const CAP_MB = 768
const OVER_MB = 1400
const UNDER_MB = 400

console.log(`Job 整树上限 ${CAP_MB} MB`)

// 1) 不设 Job，分配 OVER_MB：应当成功（基线）
const baseline = await runAllocator(OVER_MB)
console.log(`基线（无限额）分配 ${OVER_MB} MB =>`, baseline.code, baseline.out)
assert.equal(baseline.code, 0, `基线应当成功，实际：${baseline.out}`)

// 2) 在 Job 里，分配 UNDER_MB：应当成功
const jobUnder = makeJob(CAP_MB)
const under = await runAllocator(UNDER_MB, jobUnder)
api.closeHandle(jobUnder)
console.log(`Job 内分配 ${UNDER_MB} MB =>`, under.code, under.out)
assert.equal(under.code, 0, `限额内应当成功，实际：${under.out}`)

// 3) 在 Job 里，分配 OVER_MB：应当失败
//
// 实测结论：整树内存上限撞上时，Node 的**表现不是可捕获的异常**，而是
// `FATAL ERROR: Committing semi space failed ... JavaScript heap out of memory`
// 加退出码 134（SIGABRT）。这比 MemoryError 更值得写进文档：
// 硬顶是一条「会杀死进程」的墙，不是「会让分配返回 null」的软限。
// 这也正是软层（插件）必须先动作的理由 —— 撞硬顶的一方拿不到纠正机会。
const jobOver = makeJob(CAP_MB)
const over = await runAllocator(OVER_MB, jobOver)
api.closeHandle(jobOver)
console.log(`Job 内分配 ${OVER_MB} MB => 退出码 ${over.code}；输出片段：`, over.out.slice(0, 200).replace(/\r?\n/g, ' / '))
assert.notEqual(over.code, 0, `超限应当失败（非零退出），实际退出码 ${over.code}`)
assert.match(
  over.out,
  /ALLOC_FAIL|heap out of memory|Committing semi space failed/i,
  `超限应当表现为分配失败或堆 OOM，实际：${over.out.slice(0, 300)}`,
)

// 4) 父进程（本脚本）不受影响：还能分配 256 MB
const after = Buffer.alloc(256 * 1024 * 1024, 1)
assert.equal(after.length, 256 * 1024 * 1024)
console.log('父进程分配 256 MB => OK（限额没有污染调用者）')

console.log('RESULT: PASS — Job 整树内存硬顶真的会拒绝分配，且不污染父进程')
