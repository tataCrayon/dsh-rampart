// 诊断：进程加入 Job 后，它再 spawn 的后代到底算不算进 Job？
// 读 IsProcessInJob + Job 的 PeakJobMemoryUsed，定位「整树上限没生效」的原因。
import { spawn } from 'node:child_process'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
  queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
  getCurrentProcess: kernel32.func('void *GetCurrentProcess()'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 读一个进程是否在指定（或任意）Job 里。
 * @param {any} handle 进程句柄。
 * @param {any} [job] Job 句柄；省略则查「任意 Job」。
 * @returns {boolean | 'err'} 结果。
 */
const inJob = (handle, job) => {
  const out = Buffer.alloc(4)
  const ok = api.isProcessInJob(handle, job ?? null, out)
  return ok ? out.readInt32LE(0) === 1 : 'err'
}

/**
 * 读一段 Job 信息缓冲。
 * @param {any} job Job 句柄。
 * @param {number} cls 信息类。
 * @param {number} len 缓冲长度。
 * @returns {Buffer} 缓冲。
 */
const read = (job, cls, len) => {
  const b = Buffer.alloc(len)
  api.queryInformationJobObject(job, cls, b, len, null)
  return b
}

/**
 * 生成一个「吃 N MB 后挂住」的脚本。
 * @param {number} mb 分配量。
 * @returns {string} 脚本源。
 */
const allocScript = (mb) => `
  const b = []
  for (let i = 0; i < ${mb}; i++) b.push(Buffer.alloc(1048576, 1))
  console.log('alloc-done ${mb}')
  setTimeout(() => {}, 8000)
`

console.log('self in any job :', inJob(api.getCurrentProcess()))

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16)
info.writeBigUInt64LE(768n * 1024n * 1024n, 120)
console.log('set job limit   :', api.setInformationJobObject(job, 9, info, 144))

const parent = spawn(process.execPath, ['-e', allocScript(300)], { stdio: ['ignore', 'pipe', 'inherit'] })
const h = api.openProcess(ACCESS, 0, parent.pid)
console.log('parent in job before assign:', inJob(h, job))
console.log('assign parent   :', api.assignProcessToJobObject(job, h))
console.log('parent in job after assign :', inJob(h, job))

const acc = read(job, 1, 48)
console.log('active processes:', acc.readUInt32LE(40))
const ext = read(job, 9, 144)
console.log('peakProcessMem MB:', Number(ext.readBigUInt64LE(128)) / 1048576)
console.log('peakJobMem MB    :', Number(ext.readBigUInt64LE(136)) / 1048576)

// 关键问题：Job 内进程自己 spawn 的孩子，是否自动进同一个 Job？
const child = spawn(process.execPath, ['-e', allocScript(300)], { stdio: ['ignore', 'pipe', 'inherit'] })
const ch = api.openProcess(ACCESS, 0, child.pid)
console.log('child spawned by US in job:', inJob(ch, job), '(expect false — we spawned it, not a job member)')

await new Promise((r) => setTimeout(r, 3000))
const acc2 = read(job, 1, 48)
const ext2 = read(job, 9, 144)
console.log('--- after 3s ---')
console.log('active processes:', acc2.readUInt32LE(40))
console.log('peakProcessMem MB:', Number(ext2.readBigUInt64LE(128)) / 1048576)
console.log('peakJobMem MB    :', Number(ext2.readBigUInt64LE(136)) / 1048576)

child.kill()
parent.kill()
api.closeHandle(ch)
api.closeHandle(h)
api.closeHandle(job)
