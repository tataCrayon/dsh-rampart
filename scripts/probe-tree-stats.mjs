// 临时验证 tree-stats：在真实 Electron 宿主外跑一遍，确认性能与读数形状。
import { cpus } from 'node:os'
import { sampleTree, computeCpu } from '../lib/tree-stats.js'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  createToolhelp32Snapshot: kernel32.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
  process32FirstW: kernel32.func('int Process32FirstW(void *snap, void *entry)'),
  process32NextW: kernel32.func('int Process32NextW(void *snap, void *entry)'),
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  getProcessTimes: kernel32.func('int GetProcessTimes(void *h, void *create, void *exit, void *kernel, void *user)'),
  getProcessMemoryInfo: kernel32.func('int K32GetProcessMemoryInfo(void *h, void *counters, uint32 cb)'),
  getSystemTimes: kernel32.func('int GetSystemTimes(void *idle, void *kernel, void *user)'),
}))

const cores = cpus().length
const started = Date.now()
const first = sampleTree(api, process.pid, cores)
console.log(`采样耗时 ${Date.now() - started}ms`)
console.log(JSON.stringify(first, (_key, value) => (typeof value === 'bigint' ? Number(value) : value), 2))

await new Promise((resolve) => setTimeout(resolve, 2000))
const second = sampleTree(api, process.pid, cores)
console.log('CPU 占比：', JSON.stringify(computeCpu(first, second)))

// 再跑 20 次看稳定性与耗时
const t0 = Date.now()
for (let i = 0; i < 20; i += 1) sampleTree(api, process.pid, cores)
console.log(`20 次采样共 ${Date.now() - t0}ms（平均 ${((Date.now() - t0) / 20).toFixed(1)}ms）`)
