// 诊断二：Job 成员自己 spawn 的孩子，会不会自动进同一个 Job？
//
// 这决定了启动壳对 Electron 到底有没有用：如果 renderer / gpu 这些「main 启动后才
// spawn 的后代」不进 Job，那 JobMemoryLimit 只约束 main 一个进程，硬顶等于没有。
//
// 同时读 Job 记账（ActiveProcesses / TotalProcesses / PeakJobMemoryUsed），
// 确认「不进 Job」和「不记账」是两件事。
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
  queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 读一个进程是否在指定（或任意）Job 里。
 * @param {number} pid 进程 id。
 * @param {any} [job] Job 句柄；省略则查「任意 Job」。
 * @returns {boolean | string} 结果。
 */
const inJob = (pid, job) => {
  const handle = api.openProcess(ACCESS, 0, pid)
  if (!handle) return 'open-failed'
  try {
    const out = Buffer.alloc(4)
    return api.isProcessInJob(handle, job ?? null, out) ? out.readInt32LE(0) === 1 : 'query-failed'
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 读 Job 记账。
 * @param {any} job Job 句柄。
 * @returns {object} 记账字段。
 */
const accounting = (job) => {
  const basic = Buffer.alloc(48)
  api.queryInformationJobObject(job, 1, basic, 48, null)
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return {
    activeProcesses: basic.readUInt32LE(40),
    totalProcesses: basic.readUInt32LE(44),
    peakJobMemoryMb: Number(ext.readBigUInt64LE(136)) / 1048576,
  }
}

const dir = mkdtempSync(join(tmpdir(), 'rg-grand-'))
const report = join(dir, 'report.json')
const mainScript = join(dir, 'main.js')

const alloc = 'const b=[];for(let i=0;i<200;i++)b.push(Buffer.alloc(1048576,1));'
writeFileSync(mainScript, `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
${alloc}
const grand = spawn(process.execPath, ['-e', ${JSON.stringify(`${alloc}setTimeout(()=>{},6000)`)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ mainPid: process.pid, grandPid: grand.pid }))
setTimeout(() => {}, 6000)
`, 'utf8')

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16)
info.writeBigUInt64LE(2048n * 1024n * 1024n, 120)
console.log('set 2048MB job limit:', api.setInformationJobObject(job, 9, info, 144))

const main = spawn(process.execPath, [mainScript], { stdio: 'ignore' })
const handle = api.openProcess(ACCESS, 0, main.pid)
console.log('assign main        :', api.assignProcessToJobObject(job, handle))
api.closeHandle(handle)

await new Promise((r) => setTimeout(r, 2500))
const { mainPid, grandPid } = JSON.parse(readFileSync(report, 'utf8'))
console.log('main  in our job   :', inJob(mainPid, job))
console.log('grand in our job   :', inJob(grandPid, job), '  <-- 关键')
console.log('grand in ANY job   :', inJob(grandPid))
console.log('job accounting     :', JSON.stringify(accounting(job)))

main.kill()
try {
  process.kill(grandPid)
} catch {
  /* 已退出 */
}
api.closeHandle(job)
