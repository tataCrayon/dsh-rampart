/**
 * 回答三个具体问题，用测量而不是估计：
 *
 *   1. **会不会卡住 DSH？** —— 平均值 17 ms 不代表没影响。真正的问题是
 *      **事件循环停顿**：宿主进程同时负责流式输出 token、处理 HTTP、渲染 IPC。
 *      同步的 Win32 全表枚举会把这些全部冻住 17 ms。用「1 ms 定时器的实际漂移」
 *      直接量出来。
 *   2. **本身占多少内存？** —— 加载插件前后宿主进程的 RSS / heap 差。
 *   3. **会不会让工具变慢？** —— normal 下 gate 的净开销；warn 下 `warnDelayMs`
 *      是**故意**加的等待，要单独标出来，别混进「开销」里。
 */

import { loadWin32 } from '../lib/win32.js'
import { sampleTree } from '../lib/tree-stats.js'
import { TreeSampler } from '../lib/host-api.js'
import { ResourceGuardian } from '../lib/guardian.js'
import { Config } from '../lib/config.js'
import os from 'node:os'

const win32 = await loadWin32(process.env)
const api = win32.api
const cores = os.cpus().length

/**
 * 在「定时器应该每 1 ms 触发一次」的前提下，量最大延迟。
 * 定时器被推迟多久 = 事件循环被阻塞多久。
 * @param {() => void} work 每轮要执行的同步工作。
 * @param {number} rounds 轮数。
 * @returns {Promise<{maxStall: number, p95Stall: number, samples: number[]}>} 停顿统计（毫秒）。
 */
async function measureStall(work, rounds) {
  const stalls = []
  let last = process.hrtime.bigint()
  await new Promise((resolve) => {
    let i = 0
    const timer = setInterval(() => {
      const now = process.hrtime.bigint()
      const gapMs = Number(now - last) / 1e6 - 1 // 减去期望的 1 ms
      stalls.push(gapMs)
      last = now
      work()
      i += 1
      if (i >= rounds) {
        clearInterval(timer)
        resolve()
      }
    }, 1)
  })
  const sorted = [...stalls].sort((a, b) => a - b)
  return {
    maxStall: sorted.at(-1),
    p95Stall: sorted[Math.floor(sorted.length * 0.95)],
    samples: stalls,
  }
}

function fmt(n) {
  return `${n.toFixed(1)} ms`
}

console.log('=== 1) 事件循环停顿 ===')
console.log(`本机进程数 ${(await import('../lib/tree-stats.js')).enumerateProcesses(api).length}，逻辑核 ${cores}\n`)

// 基线：什么都不做时的定时器漂移（Node 自身噪声）
const baseline = await measureStall(() => {}, 40)
console.log(`基线（不做任何事）        最大停顿 ${fmt(baseline.maxStall)}  p95 ${fmt(baseline.p95Stall)}`)

// 一次整树采样，每次定时器触发都做
const oneSample = await measureStall(() => sampleTree(api, process.pid, cores), 30)
console.log(`每次触发都做整树采样      最大停顿 ${fmt(oneSample.maxStall)}  p95 ${fmt(oneSample.p95Stall)}`)

// 真实形态：每 2 秒一次（模拟面板轮询节拍）
console.log('\n按真实节拍（每 2 秒一次采样）连续跑 10 秒：')
const sampler = new TreeSampler({ win32: () => win32, cores })
await sampler.sample()
const stalls = []
let last = process.hrtime.bigint()
const deadline = Date.now() + 10_000
await new Promise((resolve) => {
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    stalls.push(Number(now - last) / 1e6 - 20)
    last = now
    if (Date.now() > deadline) {
      clearInterval(timer)
      resolve()
    }
  }, 20)
})
const sortedStalls = [...stalls].sort((a, b) => a - b)
console.log(`  20 ms 定时器最大漂移 ${fmt(sortedStalls.at(-1))}  p95 ${fmt(sortedStalls[Math.floor(sortedStalls.length * 0.95)])}`)

console.log('\n=== 2) 插件自身内存 ===')
global.gc?.()
const before = process.memoryUsage()
const guardian = new ResourceGuardian({ config: Config['~standard'].validate({}).value })
await guardian.init()
await guardian.start()
for (let i = 0; i < 200; i += 1) guardian.tick()
const withGuardian = process.memoryUsage()
console.log(`  300 次采样后 heapUsed  Δ ${((withGuardian.heapUsed - before.heapUsed) / 1048576).toFixed(2)} MB`)
console.log(`  300 次采样后 RSS       Δ ${((withGuardian.rss - before.rss) / 1048576).toFixed(2)} MB`)
await guardian.dispose()

const sampler2 = new TreeSampler({ win32: () => win32, cores })
await sampler2.sample()
const withSampler = process.memoryUsage()
console.log(`  一次整树样本常驻       Δ ${((withSampler.heapUsed - before.heapUsed) / 1048576).toFixed(2)} MB`)

console.log('\n=== 3) 工具调用的净开销 ===')
const g2 = new ResourceGuardian({ config: Config['~standard'].validate({}).value })
await g2.init()
for (let i = 0; i < 200; i += 1) await g2.gate('read')
const t0 = process.hrtime.bigint()
for (let i = 0; i < 1000; i += 1) await g2.gate('read')
console.log(`  normal 下 gate(read)   ${(Number(process.hrtime.bigint() - t0) / 1e6 / 1000 * 1000).toFixed(1)} µs/call`)

// warn 档的 delay 是**故意**的，单独标出来
const warnConfig = Config['~standard'].validate({ warnDelayMs: 400 }).value
const g3 = new ResourceGuardian({ config: warnConfig })
await g3.init()
const t1 = process.hrtime.bigint()
const decision = await g3.gate('pwsh')
console.log(`  warn 下 gate(pwsh)     ${(Number(process.hrtime.bigint() - t1) / 1e6).toFixed(0)} ms（含 warnDelayMs 400 ms 的故意等待）`)
