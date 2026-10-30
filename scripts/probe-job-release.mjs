/**
 * 关键问题：Job 的最后一个句柄关掉之后，**已在 Job 内**的进程还被限额约束吗？
 *
 * 这决定了硬顶能不能「事后施加到正在跑的 DSH 上」而不必重启：
 *   - 若关句柄仍受限 → 一旦施加就拆不掉，只能靠重启换一个干净进程（原设计结论）
 *   - 若关句柄即释放 → 施加是**可撤销**的：杀掉持有句柄的守护进程，限额随之消失
 *
 * 第二个结果会推翻「硬顶必须从启动壳起」这条约束，且对用户好得多（不用关应用）。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400
const CAP_MB = 300

const dir = mkdtempSync(join(tmpdir(), 'rg-release-'))
const script = join(dir, 'worker.js')
const report = join(dir, 'report.json')

// 工作进程：先吃 150 MB，然后等我方发信号（文件出现）再尝试再吃 200 MB。
// 若限额还在，第二次分配会撞墙（FATAL ERROR，退出码 134）。
writeFileSync(script, `
  const { writeFileSync, existsSync } = require('node:fs')
  const first = []
  for (let i = 0; i < 150; i += 1) first.push(Buffer.alloc(1048576, 1))
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ phase: 'first-ok', pid: process.pid }))
  const timer = setInterval(() => {
    if (!existsSync(${JSON.stringify(join(dir, 'go'))})) return
    clearInterval(timer)
    const second = []
    try {
      for (let i = 0; i < 200; i += 1) second.push(Buffer.alloc(1048576, 1))
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ phase: 'second-ok', alloc: 350 }))
    } catch (error) {
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ phase: 'second-failed', error: String(error) }))
    }
    setTimeout(() => process.exit(0), 500)
  }, 100)
`, 'utf8')

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16) // 只设 JOB_MEMORY，**不设** KILL_ON_JOB_CLOSE
info.writeBigUInt64LE(BigInt(CAP_MB) * 1_048_576n, 120)
assert.notEqual(api.setInformationJobObject(job, 9, info, info.length), 0, 'SetInformationJobObject')

const worker = spawn(process.execPath, [script], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200))

const handle = api.openProcess(ACCESS, 0, worker.pid)
assert.notEqual(api.assignProcessToJobObject(job, handle), 0, 'assign worker')
api.closeHandle(handle)
console.log(`worker ${worker.pid} 已加入 ${CAP_MB} MB 的 Job，当前吃了 150 MB`)

// 关掉 Job 句柄：这是我们唯一持有的句柄，关掉即「Job 被销毁」
api.closeHandle(job)
console.log('已关闭 Job 句柄（若限额随之释放，worker 应能再吃 200 MB）')

writeFileSync(join(dir, 'go'), '1')
await new Promise((resolve) => worker.on('exit', resolve))

const result = JSON.parse(readFileSync(report, 'utf8'))
console.log('worker 报告：', JSON.stringify(result))

if (result.phase === 'second-ok') {
  console.log('RESULT: PASS — 关掉最后一个 Job 句柄后限额释放，硬顶是**可撤销**的')
  console.log('        意义：可以把硬顶事后加到正在运行的 DSH 上，撤销只需杀掉守护进程，不必重启应用')
} else {
  console.log(`RESULT: FAIL — 句柄关了仍受限（${result.phase}），硬顶一旦施加不可撤，必须重启才能换干净进程`)
}
