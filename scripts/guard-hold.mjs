/**
 * 硬顶持有者：一个长期存活的进程，持着 Job 句柄，把整树内存上限钉在 DSH 上，
 * 并定期把「谁在 Job 内」的证据写到磁盘 —— 因为重启之后我这个会话就没了，
 * 只能靠落盘证据回看。
 *
 * ## 为什么必须单独一个进程持句柄
 *
 * Job 的限额跟着**句柄**走：
 *   - 句柄在 → 限额在
 *   - 关掉最后一个句柄 → 限额立即释放（`probe-job-release.mjs` 实测）
 *
 * 于是「拉起 DSH 的那个进程」必须一直活着，而且：
 *   1. 不能是 DSH 的子进程（否则会被一起杀）
 *   2. **不能设** `KILL_ON_JOB_CLOSE`（自己崩了会顺手杀光 DSH）
 *
 * 本进程退出（正常/被杀/崩溃）只导致**限额释放**，DSH 继续正常运行。
 *
 * 用法：`node scripts/guard-hold.mjs --cap 8192`
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { descendantsOf, listTargets, resolveHostExecutable } from './guard-hold-lib.mjs'

const STATE = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/guard-hold.json'
const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400
const POLL_MS = 5000

/**
 * 取 `--flag value` 形式参数。
 * @param {string} flag 标志名。
 * @param {string} [fallback] 缺省值。
 * @returns {string | undefined} 值。
 */
function valueOf(flag, fallback) {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : fallback
}

const capMb = Number(valueOf('--cap', '8192'))
const app = resolveHostExecutable(valueOf('--app'))
// 按目标映像名取进程树：写死 'DeepSeek Harness.exe' 时，一旦 --app 换成别的
// （比如用 notepad 做冒烟测试），子树永远是空的，看着像「覆盖率 0%」。
const imageName = app.split(/[\\/]/).pop()

const mod = await import(pathToFileURL(MOD).href)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
  queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
}))

const job = api.createJobObjectW(null, null)
if (!job) {
  process.stderr.write('[guard-hold] CreateJobObjectW 失败\n')
  process.exit(1)
}

const info = Buffer.alloc(144)
// 只设 JOB_MEMORY。刻意**不设** KILL_ON_JOB_CLOSE(0x2000)：
// 本进程退出时应当只释放限额，而不是顺手杀光整棵树。
info.writeUInt32LE(0x0200, 16)
info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120)
if (api.setInformationJobObject(job, 9, info, info.length) === 0) {
  process.stderr.write('[guard-hold] SetInformationJobObject 失败\n')
  process.exit(1)
}

// 自加入：随后 spawn 的 Electron 一出生就是 Job 成员，没有 assign 窗口期。
// 访问位必须含 PROCESS_TERMINATE(0x1)，少它会得到误导性的 ERROR_ACCESS_DENIED(5)。
const self = api.openProcess(ACCESS, 0, process.pid)
const joined = self !== null && api.assignProcessToJobObject(job, self) !== 0
if (self) api.closeHandle(self)

const env = { ...process.env }
// 坑：宿主带着 ELECTRON_RUN_AS_NODE=1，继承下去 Electron 会当 node 跑，
// 报 `bad option` 后静默退出。
delete env.ELECTRON_RUN_AS_NODE
delete env.DSH_SHELL

const child = spawn(app, [], { stdio: 'ignore', windowsHide: false, env, detached: false })

mkdirSync(dirname(STATE), { recursive: true })

/**
 * 读 Job 记账。
 * @returns {{activeProcesses: number, limitMb: number, peakJobMb: number}} 记账。
 */
function accounting() {
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
 * 判断一个 pid 是否在本 Job 内。
 * @param {number} pid 进程 id。
 * @returns {boolean} 是否在内。
 */
function inJob(pid) {
  const handle = api.openProcess(ACCESS, 0, pid)
  if (!handle) return false
  try {
    const out = Buffer.alloc(4)
    return api.isProcessInJob(handle, job, out) ? out.readInt32LE(0) === 1 : false
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 扫一遍 DSH 子树，确认每个进程都在 Job 内，并把结论落盘。
 *
 * 必须按 pid 递归取子树：用映像名扫到的包含**别的** DSH 实例（比如测试用的
 * 第二实例），把它们算进覆盖率会得出错误的 0%。
 * @returns {Promise<void>}
 */
async function snapshot() {
  const all = await listTargets(imageName)
  const tree = descendantsOf(all, child.pid)
  const members = tree.map((proc) => ({ pid: proc.pid, type: proc.type, inJob: inJob(proc.pid) }))
  writeFileSync(
    STATE,
    `${JSON.stringify({
      at: new Date().toISOString(),
      holderPid: process.pid,
      dshPid: child.pid,
      capMb,
      selfJoined: joined,
      app,
      accounting: accounting(),
      tree: members,
      covered: members.filter((m) => m.inJob).length,
      total: members.length,
    }, null, 2)}\n`,
    'utf8',
  )
}

await snapshot()
const timer = setInterval(() => {
  snapshot().catch(() => {})
}, POLL_MS)

process.stderr.write(
  `[guard-hold] pid ${process.pid} 持有 ${capMb} MB 整树硬顶（selfJoined=${joined}），DSH pid ${child.pid}\n`,
)

/**
 * 收尾：关句柄 → 限额释放（不杀 DSH）。
 * @returns {void}
 */
function release() {
  clearInterval(timer)
  try {
    api.closeHandle(job)
  } catch {
    /* 已经关了 */
  }
  process.exit(0)
}

process.on('SIGINT', release)
process.on('SIGTERM', release)
process.on('SIGHUP', release)
child.on('exit', release)

await new Promise(() => {})
