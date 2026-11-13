/**
 * 运行时护栏的行为测试：用假的 win32 能力层驱动真实的 ResourceGuardian。
 *
 * 这里只验证「副作用是否可逆」与「门禁是否按等级动作」——Win32 真实调用
 * 由 `scripts/` 下的探针在真机上验证（`npm run verify` 系列）。
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
    reserveMemoryMb: 0,
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

test('start：below-normal 模式启动即降优先级，dispose 后恢复原值', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ priority: 'below-normal', limitCores: 0 }), env: {} })
  guardian.win32 = win32

  await guardian.start()
  assert.equal(win32.state.priority, 0x4000, '降到 BELOW_NORMAL')

  await guardian.dispose()
  assert.equal(win32.state.priority, 0x20, '恢复原优先级')
})

test('on-pressure：压力正常时不动优先级（不白付 2~3 倍 CPU）', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ priority: 'on-pressure', limitCores: 0 }), env: {} })
  guardian.win32 = win32

  await guardian.start()
  assert.equal(win32.state.priority, 0x20, '没压力就保持 NORMAL')
  assert.equal(win32.calls.filter(([name]) => name === 'setPriority').length, 0, '一次 syscall 都不该发生')
})

test('on-pressure：升到 warn 才降，回到 normal 立刻恢复', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ priority: 'on-pressure', limitCores: 0 }), env: {} })
  guardian.win32 = win32
  await guardian.start()

  win32.state.memory = { totalMb: 32768, availPhysMb: 1500, availCommitMb: 8192, loadPercent: 95 }
  guardian.tick()
  assert.equal(win32.state.priority, 0x4000, 'warn 时让位')

  win32.state.memory = { totalMb: 32768, availPhysMb: 8192, availCommitMb: 8192, loadPercent: 25 }
  guardian.tick()
  assert.equal(win32.state.priority, 0x20, '压力解除立刻拿回全速')
})

test('on-pressure：重复 tick 不重复发同一个 syscall', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 500, availCommitMb: 8192, loadPercent: 98 } })
  const guardian = new ResourceGuardian({ config: config({ priority: 'on-pressure', limitCores: 0 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  for (let i = 0; i < 5; i += 1) guardian.tick()
  assert.equal(
    win32.calls.filter(([name]) => name === 'setPriority').length,
    1,
    '持续高压只降一次，不该每 tick 都刷',
  )
})

test('on-pressure：dispose 时若仍处于降级状态，要恢复', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 500, availCommitMb: 8192, loadPercent: 98 } })
  const guardian = new ResourceGuardian({ config: config({ priority: 'on-pressure', limitCores: 0 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  assert.equal(win32.state.priority, 0x4000)

  await guardian.dispose()
  assert.equal(win32.state.priority, 0x20, '卸载也必须还原')
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

test('预占：重活线抬高只影响重活视角，整机等级与降优先级时机仍按真实读数', async () => {
  // 可用 2600 MB、预占线 2300：原始读数在 normal（> warn 2048），重活线抬到 2300 后
  // 2600 仍高于线 → 也不会被拦。这一条守的是「抬线 ≠ 假装机器更紧张」：
  // 整机等级、降优先级时机都不许被预占带着走。
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2600, availCommitMb: 8192, loadPercent: 92 } })
  const guardian = new ResourceGuardian({
    config: config({ reserveMemoryMb: 2300, warnDelayMs: 0, priority: 'on-pressure' }),
    env: {},
  })
  guardian.win32 = win32
  await guardian.start()

  assert.equal(guardian.state().grade, 'normal', '整机等级不该被预占抬高')
  assert.equal(win32.state.priority, 0x20, '也就不会因为预占去降优先级')
  assert.equal(guardian.state().heavyGrade, 'normal', '2600 > 线 2300，重活也不该紧张')
  assert.equal((await guardian.gate('pwsh')).action, 'allow')
})

test('预占：线画得比 critical 高时，重活 critical 提前到「原始读数还是 normal」的时候', async () => {
  // 可用 2600、预占线 2600（> critical 1024 也 > warn 2048 之外仍 normal）。
  // 空闲 2600 正好压线 → 重活视角 critical，而整机等级仍是 normal。
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2600, availCommitMb: 8192, loadPercent: 92 } })
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 2600 }), env: {} })
  guardian.win32 = win32
  await guardian.start()

  assert.equal(guardian.state().grade, 'normal', '原始读数 2600 > warn 2048')
  const decision = await guardian.gate('pwsh')
  assert.equal(decision.action, 'deny', '空闲正好等于预占线 → 重活停')
  assert.match(decision.reason, /预占线为 2600 MB/)
})

test('预占：轻工具不受重活线影响，照常放行', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2500, availCommitMb: 8192, loadPercent: 94 } })
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 2600 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  assert.equal((await guardian.gate('read')).action, 'allow')
  assert.equal((await guardian.gate('write')).action, 'allow')
})

test('预占：两条迟滞链互不打断（后台 tick 与 gate 交替喂不同等级也能升级）', async () => {
  // 这是最容易写错的地方：共用一个 tracker 时，后台每 5 秒喂一次原始等级、
  // 每次 gate 再喂一次重活等级，两者的 pending 不同就会反复清零连击，
  // 表现为「预占开着时 critical 永远不触发」。
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2600, availCommitMb: 8192, loadPercent: 94 } })
  const guardian = new ResourceGuardian({
    config: config({ reserveMemoryMb: 2600, escalateSamples: 3, recoverSamples: 3 }),
    env: {},
  })
  guardian.win32 = win32
  await guardian.start()

  for (let round = 0; round < 3; round += 1) {
    guardian.tick() // 原始读数正常（2600 > warn），喂的是「重活该升级」那一侧的连击
    await guardian.gate('read')
  }
  const decision = await guardian.gate('pwsh')
  assert.equal(decision.action, 'deny', '连续 3 次重活视角 critical 后必须拦住')
})

test('预占：reserveMemoryMb=0 时行为与未加该选项前完全一致', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2000, availCommitMb: 8192, loadPercent: 94 } })
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 0 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  assert.equal(guardian.state().grade, guardian.state().heavyGrade, '不开预占时两条链结果必须相同')
  assert.equal(guardian.state().reserveMb, 0)
  const shifted = guardian.state().heavySnapshot
  assert.equal(shifted.availPhysMb, shifted.availPhysMbBeforeReserve)
})

test('setReserve：改了立刻生效，不等下一轮采样', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2400, availCommitMb: 8192, loadPercent: 93 } })
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 256 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  assert.equal(guardian.state().heavySnapshot.availPhysMb, 2144)

  // 面板是 2 秒轮询的：只改字段、等下一轮 tick 才重算的话，用户点完什么都看不见。
  const applied = guardian.setReserve(1500)
  assert.equal(applied, 1500)
  assert.equal(guardian.state().heavySnapshot.availPhysMb, 900, '必须当场重算')
  assert.equal(guardian.state().reserveMb, 1500)
  assert.equal(guardian.state().grade, 'normal', '整机等级仍按原始读数（2400 > warn 2048），不被预占抬高')
  assert.equal(guardian.state().baseReserveMb, 256, '基线要留着，重置时回落用')
})

test('setReserve：预占超过当前空闲时，生效值被夹住并把上限报出来', async () => {
  // 空闲 1.7 GB 想画 2 GB 的线：多出来的 0.3 GB 不存在。夹到空闲而不是照报 2 GB。
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 1700, availCommitMb: 8192, loadPercent: 95 } })
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 512 }), env: {} })
  guardian.win32 = win32
  await guardian.start()

  guardian.setReserve(2048)
  const state = guardian.state()
  assert.equal(state.reserveCeilingMb, 1700, '上限就是当前空闲')
  assert.equal(state.reserveMb, 1700, '生效值被夹到空闲')
  assert.equal(state.reserveConfiguredMb, 2048, '填的值要留着，面板才能解释「为什么不是 2 GB」')
  assert.equal(state.heavySnapshot.availPhysMb, 0, '夹到空闲后没有剩余')
  assert.equal(guardian.reserveCeiling(8192), 1700, '固定天花板比空闲大时仍取空闲')
})

test('setReserve：非法输入夹到 0，不留下 NaN', async () => {
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ reserveMemoryMb: 1024 }), env: {} })
  guardian.win32 = win32
  await guardian.start()
  assert.equal(guardian.setReserve(Number.NaN), 0)
  assert.equal(guardian.state().reserveMb, 0)
  assert.equal(guardian.setReserve(-5), 0)
})

test('setReserve：把线抬到当前空闲之上，重活立刻被拦下（不需要重启/重载）', async () => {
  // 空闲 2600：线画到 2600 就是「现在就不许重活再吃」，而整机等级仍是 original normal。
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2600, availCommitMb: 8192, loadPercent: 92 } })
  const guardian = new ResourceGuardian({
    config: config({ reserveMemoryMb: 0, criticalFreeMemoryMb: 1024 }),
    env: {},
  })
  guardian.win32 = win32
  await guardian.start()
  assert.equal((await guardian.gate('pwsh')).action, 'allow', '不预占时系统还够用')

  guardian.setReserve(2600) // 线 = 当前空闲
  const decision = await guardian.gate('pwsh')
  assert.equal(decision.action, 'deny')
  assert.match(decision.reason, /预占线为 2600 MB/)
})

test('setReserve：重置回基线后，重活重新放行', async () => {
  const win32 = fakeWin32({ memory: { totalMb: 32768, availPhysMb: 2600, availCommitMb: 8192, loadPercent: 92 } })
  const guardian = new ResourceGuardian({
    config: config({ reserveMemoryMb: 0, criticalFreeMemoryMb: 1024 }),
    env: {},
  })
  guardian.win32 = win32
  await guardian.start()
  guardian.setReserve(2600)
  assert.equal((await guardian.gate('pwsh')).action, 'deny')

  guardian.setReserve(guardian.baseReserveMb)
  assert.equal((await guardian.gate('pwsh')).action, 'allow', '回落到基线后重活应当可用')
})

test('start 与 dispose 竞争：init 还没回来就被卸载，不得留下限制', async () => {
  // 真实场景：HMR 热重载恰好落在插件首次加载的窗口里。早先的实现会在 dispose
  // 之后继续往下跑，把优先级/亲和性按上去，而再没有人来撤 —— 「一切可逆」的
  // 承诺在这里断掉。实测过一次（.scratch/probe-dispose-race.mjs）。
  const win32 = fakeWin32()
  const guardian = new ResourceGuardian({ config: config({ priority: 'below-normal' }), env: {} })
  guardian.init = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    guardian.win32 = win32
    return win32
  }

  const starting = guardian.start()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await guardian.dispose()
  await starting

  assert.equal(win32.state.priority, 0x20, '优先级不该被按下去')
  assert.equal(win32.state.affinity, 0b1111_1111n, '亲和性也不该被改')
  assert.deepEqual(
    win32.calls.filter(([name]) => name === 'setPriority' || name === 'setAffinity'),
    [],
    '一次副作用调用都不该留下',
  )
})
