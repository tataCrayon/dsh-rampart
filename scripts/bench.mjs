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
import { enumerateProcesses } from '../lib/tree-stats.js'
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

// 基准必须钉在 NORMAL 上量，否则结果取决于「当前进程恰好是什么优先级」。
// 实测同一段全表枚举：NORMAL 7.8 ms / BELOW_NORMAL 14.5 ms（×1.86）——
// 在混合核 CPU 上低优先级线程被排到 E 核，跑分直接翻倍。锚定住才能横向比较。
const ambientPriority = win32.available ? win32.getPriority() : null
if (win32.available && ambientPriority !== 0x20) win32.setPriority(0x20)

const report = {
  win32Available: win32.available === true,
  cores: os.cpus().length,
  ambientPriority,
}

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
  // minIntervalMs=0：量的是「真采一次」的成本。默认 1000 的缓存命中只要 0.1 µs，
  // 写成默认值会量到一堆缓存命中，看起来像采样变快了 100 倍 —— 那是假象。
  const sampler = new TreeSampler({ win32: () => win32, cores: os.cpus().length, minIntervalMs: 0 })
  const sample = await sampler.sample()
  // 注意区分两个数：整表进程数（每次枚举都要走一遍，是成本来源）与
  // 本棵子树的进程数（只影响读内存那一小段）。混在一起会让人误判复杂度。
  report.treeProcessCount = sample?.processCount ?? null
  report.tableProcessCount = enumerateProcesses(win32.api).length
  report.treeSample = stats(await timeIt(() => sampler.sample(), 60, 3))

  // 缓存命中单独报：这才是多窗口轮询时绝大多数请求的真实成本
  const cached = new TreeSampler({ win32: () => win32, cores: os.cpus().length })
  await cached.sample()
  report.treeCacheHit = stats(await timeIt(() => cached.sample(), 2000, 50))

  // 同一段枚举在 BELOW_NORMAL 下要多久 —— 这是「降优先级的隐性成本」，
  // 也是旧 README 里那个 14.6 ms 的真实出处（当时的基准跑在降级进程里）。
  if (win32.available) {
    win32.setPriority(0x4000)
    try {
      report.treeSampleBelow = stats(await timeIt(() => sampler.sample(), 30, 3))
    } finally {
      win32.setPriority(0x20)
    }
  }
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
  line(`TreeSampler 真采 (全表 ${report.tableProcessCount} 进程)`, report.treeSample)
  line('TreeSampler 缓存命中', report.treeCacheHit)
  line('decideCall() 纯函数', report.decide)
  if (report.treeSampleBelow) {
    console.log(
      `\n同一段枚举在 BELOW_NORMAL 下：中位 ${(report.treeSampleBelow.median / 1000).toFixed(2)} ms ` +
      `（×${(report.treeSampleBelow.median / report.treeSample.median).toFixed(2)}）`,
    )
  }
  if (report.ambientPriority !== null && report.ambientPriority !== 0x20) {
    console.log(`注意：本进程原本是 0x${report.ambientPriority.toString(16)}，基准已钉到 NORMAL 再量`)
  }
}
