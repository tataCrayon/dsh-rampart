/**
 * 守卫守护进程：把内存硬顶**附加到已经在跑的**进程树上，且随时可撤销。
 *
 * ## 为什么这条路可行（两条实测结论）
 *
 * 1. `AssignProcessToJobObject` 对**已经在运行**的进程有效 —— 不必从创建时施加。
 * 2. 关掉 Job 的**最后一个句柄**后，限额随即释放（`probe-job-release.mjs` 实测：
 *    worker 在句柄关闭后又能多分配 200 MB）。
 *
 * 所以「杀守护进程」= 撤销硬顶。这推翻了 README 早期写的「硬顶一旦施加就拆不掉、
 * 必须重启才能换干净进程」—— 那句只对「Job 句柄一直被持有」成立。
 *
 * ## 它做什么
 *
 * 1. 找到目标进程树（默认 DeepSeek Harness.exe 全家族）
 * 2. 建一个只带 `JobMemoryLimit` 的 Job（**不设** KILL_ON_JOB_CLOSE）
 * 3. 把树上每个进程 `AssignProcessToJobObject`
 * 4. 持句柄 + 定期重扫，把新冒出来的进程也加进去
 * 5. 收到退出信号或被杀 → 句柄关闭 → 限额释放
 *
 * ## 它刻意不做什么
 *
 * - 不设 `KILL_ON_JOB_CLOSE`：那会让守护进程一退出就杀光整棵树
 * - 不设 `ProcessMemoryLimit`：那是单进程上限，会让某个 renderer 先死而整机仍被吃穿
 * - 不动优先级/亲和性：那是插件的活
 *
 * 用法：
 *   node scripts/guard-daemon.mjs --attach --cap 6144
 *   node scripts/guard-daemon.mjs --status
 *   node scripts/guard-daemon.mjs --release
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const STATE = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/guard-daemon.json'
const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400 // TERMINATE|SET_QUOTA|SET_INFO|SUSPEND_RESUME
const POLL_MS = 2000

/**
 * 列出目标进程。
 * @param {string} [name] 进程映像名。
 * @returns {Array<{pid: number, ppid: number, type: string, commitMb: number}>} 进程列表。
 */
export async function listTargets(name = 'DeepSeek Harness.exe') {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.PageFileUsage)|$($_.CommandLine)" }`,
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, commit, cmd = ''] = line.split('|')
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        commitMb: Math.round(Number(commit) / 1024),
        type: /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'main',
      }
    })
}

/**
 * 加载 Win32 绑定。
 * @returns {Promise<any>} 绑定集合。
 */
export async function bindings() {
  const mod = await import(pathToFileURL(MOD).href)
  return mod.extendWin32ProcessBindings(({ kernel32 }) => ({
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
    isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
    queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
    setPriorityClass: kernel32.func('int SetPriorityClass(void *h, uint32 cls)'),
  }))
}

/**
 * 建一个只带整树内存上限的 Job。
 *
 * 刻意**不设** `KILL_ON_JOB_CLOSE`：句柄一关就杀光整棵树，那是灾难而不是保护。
 * @param {any} api 绑定集合。
 * @param {number} capMb 上限 MB。
 * @returns {any} Job 句柄。
 */
export function createCapJob(api, capMb) {
  const job = api.createJobObjectW(null, null)
  if (!job) throw new Error('CreateJobObjectW failed')
  const info = Buffer.alloc(144)
  info.writeUInt32LE(0x0200, 16) // JOB_OBJECT_LIMIT_JOB_MEMORY
  info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120) // JobMemoryLimit @120
  if (api.setInformationJobObject(job, 9, info, info.length) === 0) {
    api.closeHandle(job)
    throw new Error('SetInformationJobObject failed')
  }
  return job
}

/**
 * 读 Job 记账。
 * @param {any} api 绑定集合。
 * @param {any} job Job 句柄。
 * @returns {{activeProcesses: number, limitMb: number, peakJobMb: number}} 记账。
 */
export function readAccounting(api, job) {
  const basic = Buffer.alloc(48)
  api.queryInformationJobObject(job, 1, basic, 48, null)
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return {
    activeProcesses: basic.readUInt32LE(40),
    limitMb: Number(ext.readBigUInt64LE(120)) / 1048576,
    peakJobMb: Number(ext.readBigUInt64LE(136)) / 1048576,
  }
}

/**
 * 把一个 pid 加入 Job。
 * @param {any} api 绑定集合。
 * @param {any} job Job 句柄。
 * @param {number} pid 进程 id。
 * @returns {'joined' | 'already' | 'failed'} 结果。
 */
export function joinPid(api, job, pid) {
  const handle = api.openProcess(ACCESS, 0, pid)
  if (!handle) return 'failed'
  try {
    const inJob = Buffer.alloc(4)
    if (api.isProcessInJob(handle, job, inJob) && inJob.readInt32LE(0) === 1) return 'already'
    return api.assignProcessToJobObject(job, handle) !== 0 ? 'joined' : 'failed'
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 给一个进程降优先级（子进程会继承）。
 * @param {any} api 绑定集合。
 * @param {number} pid 进程 id。
 * @returns {boolean} 是否成功。
 */
export function lowerPriority(api, pid) {
  const handle = api.openProcess(0x0200, 0, pid)
  if (!handle) return false
  try {
    return api.setPriorityClass(handle, 0x0000_4000) !== 0 // BELOW_NORMAL
  } finally {
    api.closeHandle(handle)
  }
}

// ---------- CLI ----------

/**
 * 取 `--flag value` 形式的值。
 * @param {string} flag 标志名。
 * @returns {string | undefined} 值。
 */
function valueOf(flag) {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

/**
 * 读状态文件。
 * @returns {object | null} 状态。
 */
function readState() {
  if (!existsSync(STATE)) return null
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 判断某个 pid 是否还活着。
 * @param {number} pid 进程 id。
 * @returns {boolean} 是否活着。
 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (process.argv.includes('--status')) {
  const state = readState()
  if (!state) {
    console.log('未在守护中（没有状态文件）')
    process.exit(0)
  }
  const running = alive(state.daemonPid)
  console.log(`守护进程 pid ${state.daemonPid}：${running ? '运行中，硬顶生效中' : '已退出，硬顶已释放'}`)
  console.log(`整树上限 ${state.capMb} MB；已纳入 ${state.joined.length} 个进程；峰值 ${(state.peakJobMb ?? 0).toFixed(1)} MB`)
  process.exit(0)
}

if (process.argv.includes('--release')) {
  const state = readState()
  if (!state) {
    console.log('未在守护中，无需释放')
    process.exit(0)
  }
  if (!alive(state.daemonPid)) {
    console.log('守护进程已不在运行，硬顶已释放')
    process.exit(0)
  }
  process.kill(state.daemonPid)
  console.log(`已通知守护进程 ${state.daemonPid} 退出，硬顶随之释放`)
  process.exit(0)
}

if (!process.argv.includes('--attach')) {
  console.log(`用法：
  node scripts/guard-daemon.mjs --attach [--cap <MB>] [--cap-percent <n>] [--low-priority] [--target <映像名>]
  node scripts/guard-daemon.mjs --status
  node scripts/guard-daemon.mjs --release
`)
  process.exit(process.argv.includes('--help') ? 0 : 1)
}

const api = await bindings()
const totalMb = Math.floor(os.totalmem() / 1_048_576)
const capMb = Number(valueOf('--cap') ?? 0)
const capPercent = Number(valueOf('--cap-percent') ?? 0)
const limitMb = capMb > 0 ? capMb : Math.max(3072, Math.round((totalMb * (capPercent > 0 ? capPercent : 55)) / 100))
const targetName = valueOf('--target') ?? 'DeepSeek Harness.exe'
const lowPriority = process.argv.includes('--low-priority')

const targets = await listTargets(targetName)
if (targets.length === 0) {
  console.error(`没找到运行中的 ${targetName}，无法附加`)
  process.exit(1)
}

const job = createCapJob(api, limitMb)
const joined = []
for (const target of targets) {
  if (joinPid(api, job, target.pid) !== 'failed') joined.push(target.pid)
  if (lowPriority) lowerPriority(api, target.pid)
}

mkdirSync(dirname(STATE), { recursive: true })
const state = {
  at: new Date().toISOString(),
  daemonPid: process.pid,
  target: targetName,
  capMb: limitMb,
  lowPriority,
  joined,
  peakJobMb: readAccounting(api, job).peakJobMb,
}

/**
 * 落盘状态。
 * @returns {void}
 */
function persist() {
  writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

persist()
console.log(`已附加到 ${joined.length}/${targets.length} 个 ${targetName} 进程，整树上限 ${limitMb} MB`)
console.log(`当前整树提交约 ${targets.reduce((sum, t) => sum + t.commitMb, 0)} MB（上限的 ${((targets.reduce((sum, t) => sum + t.commitMb, 0) / limitMb) * 100).toFixed(0)}%）`)
console.log(`撤销：node scripts/guard-daemon.mjs --release（或杀掉 pid ${process.pid}）`)

/**
 * 定期重扫：把新出现的进程也纳入，并更新峰值。
 * @returns {Promise<void>}
 */
async function poll() {
  const current = await listTargets(targetName)
  let added = 0
  for (const target of current) {
    if (joinPid(api, job, target.pid) === 'joined') {
      added += 1
      if (!state.joined.includes(target.pid)) state.joined.push(target.pid)
    }
    if (lowPriority) lowerPriority(api, target.pid)
  }
  state.peakJobMb = readAccounting(api, job).peakJobMb
  if (added > 0) persist()
}

const timer = setInterval(() => {
  poll().catch(() => {})
}, POLL_MS)

/**
 * 收尾：落盘 → 关句柄 → 限额释放。
 * @returns {void}
 */
function shutdown() {
  clearInterval(timer)
  state.peakJobMb = readAccounting(api, job).peakJobMb
  state.releasedAt = new Date().toISOString()
  persist()
  api.closeHandle(job)
  console.log('已释放硬顶（Job 句柄关闭）')
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGHUP', shutdown)

await new Promise(() => {})
