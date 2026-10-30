/**
 * 运行时护栏的行为测试：用假的 win32 能力层驱动真实的 ResourceGuardian。
 *
 * 这里只验证「副作用是否可逆」与「门禁是否按等级动作」——Win32 真实调用
 * 由 `scripts/` 下的探针在真机上验证（`npm run probe:win32`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ResourceGuardian, lowestBitsMask } from '../lib/guardian.js'
import { GradeTracker } from '../lib/pressure.js'

/**
 * 造一份完整的默认配置。
 * @param {object} [overrides] 覆盖项。
 * @returns {object} 配置。
 */
function config(overrides = {}) {
  return {
    enabled: true,
    warnFreeMemoryMb: 2048,
    criticalFreeMemoryMb: 1024,
    warnCommitMb: 3072,
    criticalCommitMb: 1536,
    escalateSamples: 1,
    recoverSamples: 1,
    sampleIntervalMs: 5000,
    priority: 'below-normal',
    limitCores: 2,
    warnDelayMs: 10,
    criticalDelayMs: 0,
    denyHeavyOnWarn: false,
    denyHeavyOnCritical: true,
    heavyTools: ['pwsh'],
    heavyPatterns: ['job_*'],
    ...overrides,
  }
}

/**
 * 造一个可编程的假能力层，记录每一次副作用调用。
 * @param {object} [options] 初始状态。
 * @returns {object} 假能力层。
 */
function fakeWin32(options = {}) {
  const calls = []
  const state = {
    priority: 0x20,
    affinity: 0b1111_1111n,
    systemAffinity: 0b1111_1111n,
    memory: { totalMb: 32768, availPhysMb: 8192, availCommitMb: 8192, loadPercent: 25 },
    ...options,
  }
  return {
    calls,
    state,
    available: true,
    memoryStatus() {
      return { ...state.memory }
    },
    getPriority() {
      return state.priority
    },
    setPriority(cls) {
      calls.push(['setPriority', cls])
      state.priority = cls
      return true
    },
    getAffinity() {
      return { process: state.affinity, system: state.systemAffinity }
    },
    setAffinity(mask) {
      calls.push(['setAffinity', mask])
      state.affinity = mask
      return true
    },
    suspend(pid) {
      calls.push(['suspend', pid])
      return true
    },
    resume(pid) {
      calls.push(['resume', pid])
      return true
    },
    makeJob: () => ({}),
  }
}

test('lowestBitsMask：取最低的 N 个可用核', () => {
  assert.equal(lowestBitsMask(0b1111_1111n, 2), 0b0000_0011n)
  assert.equal(lowestBitsMask(0b0000_1100n, 2), 0b0000_1100n, '只取可用位')
  assert.equal(lowestBitsMask(0b0000_0010n, 8), 0b0000_0010n, '可用核不足时全给')
  assert.equal(lowestBitsMask(0n, 4), 0n)
})

test('start：降优先级并记下恢复动作，dispose 后恢复原值', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ limitCores: 0 }), env: {} })
  guardian.win32 = win32

  await guardian.start()
  assert.equal(win32.state.priority, 0x4000, '降到 BELOW_NORMAL')

  await guardian.dispose()
  assert.equal(win32.state.priority, 0x20, '恢复原优先级')
})

test('start：limitCores>0 时钉核，dispose 后恢复原掩码', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ priority: 'unchanged' }), env: {} })
  guardian.win32 = win32

  await guardian.start()
  assert.equal(win32.state.affinity, 0b11n, '只留最低两核')

  await guardian.dispose()
  assert.equal(win32.state.affinity, 0b1111_1111n, '恢复原掩码')
})

test('dispose：幂等，重复调用不再重复恢复', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ limitCores: 0 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  await guardian.dispose()
  const restores = win32.calls.filter(([name]) => name === 'setPriority').length
  await guardian.dispose()
  assert.equal(
    win32.calls.filter(([name]) => name === 'setPriority').length,
    restores,
    '第二次 dispose 不应再改优先级',
  )
})

test('start：能力层不可用时静默跳过，不抛错', async () => {
  const guardian = new ResourceGuardian({ config: config(), env: {} })
  guardian.win32 = { available: false, error: 'nope' }
  await guardian.start()
  await guardian.dispose()
  assert.equal(guardian.state().capabilities.win32, false)
})

test('gate：normal 等级放行重活且不计数', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 8192, availCommitMb: 8192, loadPercent: 25 } })
  const guardian = new ResourceGuardian({ config: config(), env: {} })
  guardian.win32 = win32
  await guardian.gate('pwsh')
  const state = guardian.state()
  assert.equal(state.deniedCalls, 0)
  assert.equal(state.delayedCalls, 0)
})

test('gate：critical 等级拦重活并计数', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 500, availCommitMb: 8192, loadPercent: 98 } })
  const guardian = new ResourceGuardian({ config: config(), env: {} })
  guardian.win32 = win32
  const decision = await guardian.gate('pwsh')
  assert.equal(decision.action, 'deny')
  assert.equal(guardian.state().deniedCalls, 1)
})

test('gate：critical 等级仍放行轻工具', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 500, availCommitMb: 8192, loadPercent: 98 } })
  const guardian = new ResourceGuardian({ config: config(), env: {} })
  guardian.win32 = win32
  const decision = await guardian.gate('read')
  assert.equal(decision.action, 'allow')
})

test('gate：enabled=false 时完全不拦', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 100, availCommitMb: 100, loadPercent: 99 } })
  const guardian = new ResourceGuardian({ config: config({ enabled: false }), env: {} })
  guardian.win32 = win32
  const decision = await guardian.gate('pwsh')
  assert.equal(decision.action, 'allow')
  assert.equal(guardian.state().samples, 0, '关掉后连采样都不做')
})

test('gate：warn 等级按 warnDelayMs 等待后放行', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 1500, availCommitMb: 8192, loadPercent: 95 } })
  const guardian = new ResourceGuardian({ config: config({ warnDelayMs: 30 }), env: {} })
  guardian.win32 = win32
  const started = Date.now()
  const decision = await guardian.gate('pwsh')
  const elapsed = Date.now() - started
  assert.equal(decision.action, 'allow')
  assert.ok(elapsed >= 25, `应至少等待 30ms，实际 ${elapsed}ms`)
  assert.equal(guardian.state().delayedCalls, 1)
})

test('gate：降速等待可被 signal 取消', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 1500, availCommitMb: 8192, loadPercent: 95 } })
  const guardian = new ResourceGuardian({ config: config({ warnDelayMs: 5000 }), env: {} })
  guardian.win32 = win32
  const controller = new AbortController()
  const pending = guardian.gate('pwsh', controller.signal)
  controller.abort(new Error('user cancelled'))
  await assert.rejects(pending, /user cancelled/)
})

test('freeze/thaw：记录被冻结的 pid 并可在 dispose 时恢复', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config(), env: {} })
  guardian.win32 = win32
  assert.equal(guardian.freeze(4242), true)
  assert.deepEqual(guardian.state().frozenPids, [4242])
  await guardian.dispose()
  assert.deepEqual(guardian.state().frozenPids, [])
  assert.ok(win32.calls.some(([name, pid]) => name === 'resume' && pid === 4242))
})

test('迟滞：连续两次越线才真正拦截', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 500, availCommitMb: 8192, loadPercent: 98 } })
  const guardian = new ResourceGuardian({
    config: config({ escalateSamples: 2 }),
    env: {},
  })
  guardian.win32 = win32
  assert.equal((await guardian.gate('pwsh')).action, 'allow', '第一次越线还不拦')
  assert.equal((await guardian.gate('pwsh')).action, 'deny', '第二次才拦')
})

test('GradeTracker 与 Guardian 共用同一套迟滞参数', () => {
  const tracker = new GradeTracker({ escalateSamples: 4, recoverSamples: 5 })
  assert.equal(tracker.escalateSamples, 4)
  assert.equal(tracker.recoverSamples, 5)
})
