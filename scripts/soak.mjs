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

/**
 * Win32 能力是否真的可用。
 *
 * 这份脚本有两组断言：热路径/门禁/迟滞（纯 JS，任何平台都能跑）和整树采样
 * （必须真的能调 Win32）。后者在「装了宿主但没装 `dsh-win32-process`」的环境里
 * 会以 `Cannot create proxy with a non-object as target` 这种毫无线索的方式挂掉 ——
 * 报错指向 Proxy，不指向缺依赖。所以先探一下，缺能力就把那组标成 SKIP，
 * 而不是让它伪装成代码缺陷。
 */
const hasWin32 = win32.available === true
if (!hasWin32) {
  console.log(`SKIP: Win32 能力不可用（${win32.error ?? 'unknown'}），整树采样相关断言跳过。`)
  console.log('      要跑全量：npm install --no-save @deepseek-ai/dsh-win32-process@0.2.1-rc.2')
}

let failures = 0
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${message}`)
  if (!ok) failures += 1
}

/** 只在真有 Win32 能力时才断言；否则打印 SKIP 且不计入失败。 */
function checkTree(ok, message) {
  if (!hasWin32) {
    console.log(`SKIP: ${message}`)
    return
  }
  check(ok, message)
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
  checkTree(Math.abs(heapDelta) < 8 * 1048576, `树采样无明显泄漏（heap Δ ${mb(heapDelta)} MB < 8 MB）`)
  checkTree(last !== null && last.processCount >= 1, '树采样持续可用')
}

// ── 2b) 多窗口轮询：并发请求必须合并，不能各自冻结一次事件循环 ────────────
{
  // 每个窗口一个 StatusPill，各自独立 setInterval 打 /stats。旧实现是「每次请求都
  // 真采一次」，8 个窗口就是 8×15 ms 的同步冻结；这条守住「与窗口数解耦」。
  let enumerations = 0
  // 没有 Win32 时 win32.api 是 undefined，包一层 Proxy 会抛
  // 「Cannot create proxy with a non-object as target」—— 那是缺依赖，不是缺陷。
  const counting = hasWin32
    ? {
        ...win32,
        api: new Proxy(win32.api, {
          get(target, key) {
            const value = target[key]
            if (key !== 'createToolhelp32Snapshot') return value
            return (...args) => {
              enumerations += 1
              return value.apply(target, args)
            }
          },
        }),
      }
    : win32
  const sampler = new TreeSampler({ win32: async () => counting, cores: 8, minIntervalMs: 1000 })
  await sampler.sample()
  const base = enumerations
  const waves = await Promise.all(Array.from({ length: 8 }, () => sampler.sample()))
  const afterBurst = enumerations - base
  checkTree(afterBurst === 0, `8 个窗口同时轮询只复用缓存（新增枚举 ${afterBurst} 次，期望 0）`)
  checkTree(new Set(waves).size === 1, '8 个并发请求拿到同一份读数')
}
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
