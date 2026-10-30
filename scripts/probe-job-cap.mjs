// 诊断三：把「整树上限」到底有没有生效这件事量出来。
//
// 上一版 verify-tree-accounting 断言失败（3 个 300 MB 子进程全过），但 probe-job-inherit
// 证明后代确实会继承 Job。所以要么是「没并发」，要么是「记账不含后代」。
// 这个探针从**外部**每 200 ms 读一次 Job 记账，把过程摊开看。
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
 * 读 Job 记账（含当前已提交量）。
 * @param {any} job Job 句柄。
 * @returns {object} 记账。
 */
const accounting = (job) => {
  const basic = Buffer.alloc(48)
  api.queryInformationJobObject(job, 1, basic, 48, null)
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return {
    active: basic.readUInt32LE(40),
    limitMb: Number(ext.readBigUInt64LE(120)) / 1048576,
    processMb: Number(ext.readBigUInt64LE(112)) / 1048576,
    peakJobMb: Number(ext.readBigUInt64LE(136)) / 1048576,
  }
}

const dir = mkdtempSync(join(tmpdir(), 'rg-cap-'))
const hog = join(dir, 'hog.js')
// 逐块分配并**触碰**，确保提交记账真的增加；每块打印一次进度，便于看在哪一步断
writeFileSync(hog, `
  const mb = Number(process.argv[2])
  const chunks = []
  for (let i = 0; i < mb; i += 1) {
    chunks.push(Buffer.alloc(1024 * 1024, 1))
    if (i % 100 === 0) process.stdout.write('.')
  }
  console.log(' OK ' + mb)
  setTimeout(() => {}, 4000)
`, 'utf8')

const parentScript = join(dir, 'parent.js')
writeFileSync(parentScript, `
  const { spawn } = require('node:child_process')
  const kids = [0, 1, 2].map(() => spawn(process.execPath, [${JSON.stringify(hog)}, '300'], { stdio: ['ignore', 'pipe', 'inherit'] }))
  kids.forEach((k, i) => {
    let out = ''
    k.stdout.on('data', (d) => { out += d.toString() })
    k.on('exit', (code) => console.log('kid' + i + ' exit=' + code + ' out=' + out.trim()))
  })
  setTimeout(() => {}, 4000)
`, 'utf8')

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16)
info.writeBigUInt64LE(768n * 1024n * 1024n, 120)
console.log('set limit:', api.setInformationJobObject(job, 9, info, 144), '| readback:', JSON.stringify(accounting(job)))

const parent = spawn(process.execPath, [parentScript], { stdio: ['ignore', 'inherit', 'inherit'] })
const handle = api.openProcess(ACCESS, 0, parent.pid)
console.log('assign   :', api.assignProcessToJobObject(job, handle))
api.closeHandle(handle)

// 外部轮询：看进程数什么时候变成 4，峰值什么时候越过 768
for (let i = 0; i < 14; i += 1) {
  await new Promise((r) => setTimeout(r, 250))
  process.stdout.write(`  t=${(i + 1) * 250}ms ${JSON.stringify(accounting(job))}\n`)
}

await new Promise((r) => parent.on('exit', r))
api.closeHandle(job)
