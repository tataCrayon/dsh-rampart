/**
 * 可靠性探针：找泄漏、找「并发下会不会算错」。
 *
 * 为什么需要它：这个插件挂在**每次工具调用**和**每 2 秒的轮询**上，一旦有泄漏或
 * 状态被并发踩坏，问题不会立刻暴露，而是在用户连续用几小时后表现为「护栏突然失灵」。
 * 单元测试测不到这种行为——它们每次都是新实例。
 *
 * 跑法：`node scripts/soak.mjs`
 */

import { loadWin32 } from '../lib/win32.js'
import { ResourceGuardian } from '../lib/guardian.js'
import { Config } from '../lib/config.js'
import { TreeSampler } from '../lib/host-api.js'
import { GradeTracker } from '../lib/pressure.js'

const config = Config['~standard'].validate({}).value
const win32 = await loadWin32(process.env)

let failures = 0
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`)
  if (!ok) failures += 1
}

function mb(bytes) {
  return +(bytes / 1048576).toFixed(1)
}

// ── 1) 热路径泄漏：5000 次 tick + 2000 次 gate ──────────────────────────
{
  const guardian = new ResourceGuardian({ config })
  await guardian.init()
  global.gc?.()
  const before = process.memoryUsage()

  for (let i = 0; i < 5000; i += 1) guardian.tick()
  for (let i = 0; i < 2000; i += 1) await guardian.gate('read')

  global.gc?.()
  const after = process.memoryUsage()
  const heapDelta = after.heapUsed - before.heapUsed
  const rssDelta = after.rss - before.rss
  console.log(`  7000 次调用后：heapUsed ${mb(before.heapUsed)} → ${mb(after.heapUsed)} MB（Δ ${mb(heapDelta)}），RSS Δ ${mb(rssDelta)} MB`)
  // 阈值放宽到 8 MB：GC 时机不可控，但真有泄漏时 7000 次会是几十 MB 级
  check(Math.abs(heapDelta) < 8 * 1048576, `热路径无明显泄漏（heap Δ ${mb(heapDelta)} MB < 8 MB）`)
  check(guardian.state().samples === 7000, `采样计数准确（${guardian.state().samples}）`)
}

// ── 2) 树采样泄漏：100 次 enumerate（每次遍历全部进程） ─────────────────
{
  const sampler = new TreeSampler({ win32: () => win32, cores: 8 })
  await sampler.sample()
  global.gc?.()
  const before = process.memoryUsage()
  let last = null
  for (let i = 0; i < 100; i += 1) last = await sampler.sample()
  global.gc?.()
  const after = process.memoryUsage()
  const heapDelta = after.heapUsed - before.heapUsed
  console.log(`  100 次整树采样后：heapUsed Δ ${mb(heapDelta)} MB，最后一次 ${last?.processCount ?? 'null'} 进程`)
  check(Math.abs(heapDelta) < 8 * 1048576, `树采样无明显泄漏（heap Δ ${mb(heapDelta)} MB < 8 MB）`)
  check(last !== null && last.processCount >= 1, '树采样持续可用')
}

// ── 3) 并发门禁：200 个 gate 同时进来，结果不能互相污染 ─────────────────
{
  const guardian = new ResourceGuardian({ config })
  await guardian.init()
  const names = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 'read' : 'grep'))
  const results = await Promise.all(names.map((name) => guardian.gate(name)))
  check(results.every((r) => r.action === 'allow'), '200 个并发门禁全部放行（normal 等级）')
  check(guardian.state().samples === 200, `并发下采样计数无丢失（${guardian.state().samples}）`)
  check(guardian.deniedCalls === 0, `并发下没有误拦（denied=${guardian.deniedCalls}）`)
}

// ── 4) 迟滞状态机：临界抖动不能漏成随机放行 ─────────────────────────────
{
  const tracker = new GradeTracker({ escalateSamples: 3, recoverSamples: 3 })
  const grades = []
  for (let round = 0; round < 20; round += 1) {
    grades.push(tracker.observe('normal'))
    grades.push(tracker.observe('critical'))
  }
  // 每次只连续 1 次越线，永远达不到 3 次 → 应该一直停在 normal
  check(grades.every((g) => g === 'normal'), '交错抖动时等级不跳变（迟滞生效）')

  const real = new GradeTracker({ escalateSamples: 3, recoverSamples: 3 })
  let reached
  for (let i = 0; i < 3; i += 1) reached = real.observe('critical')
  check(reached === 'critical', '连续 3 次越线后升级为 critical')
  let back
  for (let i = 0; i < 3; i += 1) back = real.observe('normal')
  check(back === 'normal', '连续 3 次回线后降回 normal')
}

// ── 5) dispose 幂等：卸载两次不能抛 ────────────────────────────────────
{
  const guardian = new ResourceGuardian({ config: { ...config, limitCores: 0 } })
  await guardian.init()
  await guardian.start()
  let threw = null
  try {
    await guardian.dispose()
    await guardian.dispose()
  } catch (error) {
    threw = error.message
  }
  check(threw === null, `dispose() 可重复调用（${threw ?? '无异常'}）`)
}

console.log(failures === 0 ? '\n结果：PASS' : `\n结果：FAIL（${failures} 项）`)
process.exitCode = failures === 0 ? 0 : 1
