/**
 * 热路径性能基准：量「护栏给每次工具调用加了多少开销」和「面板每次轮询花了多久」。
 *
 * 三个被测点，按被调用频次排序：
 *   1. `gate()` —— **每次工具调用**都会走。它在里面又调一次 `tick()`（真读一次系统内存），
 *      所以这是唯一会随使用量线性增长的路径。
 *   2. `TreeSampler.sample()` —— 面板每 2 秒轮询一次 `/stats`，每次枚举全部进程。
 *   3. `decideCall()` —— 纯函数，用来确认逻辑层不是瓶颈。
 *
 * 跑法：`node scripts/bench.mjs [--json]`
 * 判据不是「绝对值好看」，而是「相对一次 pwsh 调用可忽略」：一条 pwsh 冷启动 ~200 ms，
 * 护栏若在 1 ms 量级就是噪声。
 */

import { loadWin32 } from '../lib/win32.js'
import { ResourceGuardian } from '../lib/guardian.js'
import { Config } from '../lib/config.js'
import { decideCall } from '../lib/pressure.js'
import { TreeSampler } from '../lib/host-api.js'
import os from 'node:os'

const asJson = process.argv.includes('--json')

/** 稳定统计：去掉首尾极端值后取中位数与 p95，避免 GC 尖峰误导。 */
function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return {
    n: sorted.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
  }
}

/** 跑 `rounds` 次，返回每次的微秒耗时。 */
async function timeIt(fn, rounds, warmup = 20) {
  for (let i = 0; i < warmup; i += 1) await fn()
  const out = []
  for (let i = 0; i < rounds; i += 1) {
    const t0 = process.hrtime.bigint()
    await fn()
    out.push(Number(process.hrtime.bigint() - t0) / 1000)
  }
  return out
}

const config = Config['~standard'].validate({}).value
const win32 = await loadWin32(process.env)

const report = { win32Available: win32.available === true, cores: os.cpus().length }

// ── 1) gate()：每次工具调用都要走 ──────────────────────────────────────
{
  const guardian = new ResourceGuardian({ config })
  await guardian.init()
  // 轻工具：normal 等级下直接放行，这是最常见的形态
  report.gateLight = stats(await timeIt(() => guardian.gate('read'), 300))
  // 重活：走决定逻辑（normal 下也放行，但路径更长）
  report.gateHeavy = stats(await timeIt(() => guardian.gate('pwsh'), 300))
  report.gateSamples = guardian.state().samples
}

// ── 2) tick()：单独量一次采样 ──────────────────────────────────────────
{
  const guardian = new ResourceGuardian({ config })
  await guardian.init()
  report.tick = stats(await timeIt(() => guardian.tick(), 300))
}

// ── 3) TreeSampler.sample()：面板轮询 ──────────────────────────────────
{
  const sampler = new TreeSampler({ win32: () => win32, cores: os.cpus().length })
  const sample = await sampler.sample()
  report.treeProcessCount = sample?.processCount ?? null
  report.treeSample = stats(await timeIt(() => sampler.sample(), 60, 3))
}

// ── 4) decideCall()：纯函数 ───────────────────────────────────────────
{
  const policy = { ...config }
  report.decide = stats(await timeIt(
    () => decideCall({ grade: 'critical', toolName: 'pwsh', policy, snapshot: { availPhysMb: 800, totalMb: 32381, loadPercent: 97, availCommitMb: 900 } }),
    2000,
    200,
  ))
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`Win32 能力层：${report.win32Available ? '可用' : '不可用'} · 逻辑核 ${report.cores}\n`)
  const line = (label, s) => console.log(
    `${label.padEnd(26)} 中位 ${s.median.toFixed(1).padStart(7)} µs   p95 ${s.p95.toFixed(1).padStart(7)} µs   最大 ${s.max.toFixed(1).padStart(8)} µs  (n=${s.n})`,
  )
  line('gate() 轻工具 read', report.gateLight)
  line('gate() 重活 pwsh', report.gateHeavy)
  line('tick() 单次采样', report.tick)
  line(`TreeSampler.sample() (${report.treeProcessCount} 进程)`, report.treeSample)
  line('decideCall() 纯函数', report.decide)
}
