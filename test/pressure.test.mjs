/**
 * 纯逻辑单测：分级、迟滞、重活判定、决策。不接触 Win32、不接触 cordis。
 *
 * 为什么这些用例值得写：护栏的核心风险不是「拦不住」，而是「乱拦」——
 * 一次抖动就拒绝模型的重活，比没有护栏更糟。所以每条阈值规则都要有
 * Given-When-Then 可判定的断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  GradeTracker,
  applyReserve,
  decideCall,
  gradeOf,
  isHeavyTool,
  normalizeSnapshot,
  reserveCeilingMb,
  wildcardToRegExp,
} from '../lib/pressure.js'

/** 一份可用的默认阈值，与插件默认配置一致。 */
const THRESHOLDS = {
  warnFreeMemoryMb: 2048,
  criticalFreeMemoryMb: 1024,
  warnCommitMb: 3072,
  criticalCommitMb: 1536,
}

/**
 * 造一份快照。
 * @param {number} availPhysMb 可用物理内存。
 * @param {number} [availCommitMb] 可用提交内存。
 * @returns {object} 归一化快照。
 */
function snap(availPhysMb, availCommitMb = 8192) {
  return normalizeSnapshot({ totalMb: 32768, availPhysMb, availCommitMb })
}

test('gradeOf：可用物理归零必须是最严重的 critical', () => {
  // 早先的实现用 `phys > 0` 当「这一项拿得到」，于是物理内存真的归零时
  // 判定反而退回 normal —— 最该拦的那一刻不拦。
  assert.equal(gradeOf(snap(0, 0), THRESHOLDS), 'critical')
})

test('gradeOf：总量未知（读不到）时才算「拿不到」，不编造等级', () => {
  const unknown = normalizeSnapshot({ availPhysMb: 0, availCommitMb: 0 })
  assert.equal(unknown.totalMb, 0)
  assert.equal(gradeOf(unknown, THRESHOLDS), 'normal')
})

test('normalizeSnapshot：按总量与可用量算出占用百分比', () => {
  const s = normalizeSnapshot({ totalMb: 32768, availPhysMb: 2048, availCommitMb: 4096 })
  assert.equal(s.loadPercent, 94)
  assert.equal(s.totalMb, 32768)
})

test('normalizeSnapshot：总量未知时不编造百分比', () => {
  const s = normalizeSnapshot({ availPhysMb: 1000 })
  assert.equal(s.loadPercent, 0)
})

test('gradeOf：三级阈值按可用物理内存判定', () => {
  assert.equal(gradeOf(snap(8000), THRESHOLDS), 'normal')
  assert.equal(gradeOf(snap(2048), THRESHOLDS), 'warn', '等于阈值也算 warn')
  assert.equal(gradeOf(snap(1500), THRESHOLDS), 'warn')
  assert.equal(gradeOf(snap(1024), THRESHOLDS), 'critical', '等于阈值就算 critical')
  assert.equal(gradeOf(snap(300), THRESHOLDS), 'critical')
})

test('gradeOf：提交内存也能单独触发升级', () => {
  assert.equal(gradeOf(snap(8000, 2000), THRESHOLDS), 'warn')
  assert.equal(gradeOf(snap(8000, 900), THRESHOLDS), 'critical')
})

test('gradeOf：提交量为 0 表示拿不到，不能当成耗尽', () => {
  assert.equal(gradeOf(snap(8000, 0), THRESHOLDS), 'normal')
})

test('gradeOf：commit 阈值为 0 表示关闭该项检查', () => {
  const disabled = { ...THRESHOLDS, warnCommitMb: 0, criticalCommitMb: 0 }
  assert.equal(gradeOf(snap(8000, 10), disabled), 'normal')
})

test('GradeTracker：升级要连续越线，单次抖动不算', () => {
  const tracker = new GradeTracker({ escalateSamples: 2, recoverSamples: 2 })
  assert.equal(tracker.observe('warn'), 'normal', '第一次越线还不升级')
  assert.equal(tracker.observe('warn'), 'warn', '第二次越线才升级')
})

test('GradeTracker：越线后又回线，连续计数要清零', () => {
  const tracker = new GradeTracker({ escalateSamples: 2, recoverSamples: 2 })
  tracker.observe('warn')
  assert.equal(tracker.observe('normal'), 'normal')
  assert.equal(tracker.observe('warn'), 'normal', '计数被重置，需重新攒两次')
})

test('GradeTracker：降级同样要连续回线', () => {
  const tracker = new GradeTracker({ escalateSamples: 1, recoverSamples: 3 })
  assert.equal(tracker.observe('critical'), 'critical')
  assert.equal(tracker.observe('normal'), 'critical')
  assert.equal(tracker.observe('normal'), 'critical')
  assert.equal(tracker.observe('normal'), 'normal')
})

test('GradeTracker：normal → critical 的跳级也要满足次数', () => {
  const tracker = new GradeTracker({ escalateSamples: 3, recoverSamples: 1 })
  assert.equal(tracker.observe('critical'), 'normal')
  assert.equal(tracker.observe('critical'), 'normal')
  assert.equal(tracker.observe('critical'), 'critical')
})

test('wildcardToRegExp：只把 * 当通配，其余元字符按字面量', () => {
  assert.ok(wildcardToRegExp('job_*').test('job_list'))
  assert.ok(!wildcardToRegExp('job_*').test('my_job_list'), '模式是锚定的')
  assert.ok(wildcardToRegExp('a.b').test('a.b'))
  assert.ok(!wildcardToRegExp('a.b').test('axb'), '点号不是任意字符')
})

test('isHeavyTool：精确名单与通配模式都生效', () => {
  const policy = { heavyTools: ['pwsh', 'bash'], heavyPatterns: ['job_*'] }
  assert.equal(isHeavyTool('pwsh', policy), true)
  assert.equal(isHeavyTool('job_kill', policy), true)
  assert.equal(isHeavyTool('read', policy), false)
  assert.equal(isHeavyTool('todo_write', policy), false)
})

test('decideCall：normal 等级放行一切', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  assert.deepEqual(decideCall({ grade: 'normal', toolName: 'pwsh', policy }), { action: 'allow' })
})

test('decideCall：warn 默认只降速不拦', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  assert.deepEqual(
    decideCall({ grade: 'warn', toolName: 'pwsh', policy, delayMs: 400 }),
    { action: 'delay', delayMs: 400 },
  )
})

test('decideCall：warn 下开了 denyHeavyOnWarn 就拦', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnWarn: true }
  const d = decideCall({ grade: 'warn', toolName: 'pwsh', policy })
  assert.equal(d.action, 'deny')
  assert.match(d.reason, /pwsh/)
})

test('decideCall：critical 默认拦重活，且原因可读', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  const d = decideCall({ grade: 'critical', toolName: 'pwsh', policy })
  assert.equal(d.action, 'deny')
  assert.match(d.reason, /pwsh/)
  assert.match(d.reason, /内存/)
})

test('decideCall：critical 但显式关掉拦截时放行', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: false }
  assert.deepEqual(decideCall({ grade: 'critical', toolName: 'pwsh', policy }), { action: 'allow' })
})

test('decideCall：轻工具在任何等级都不受影响', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  for (const grade of ['normal', 'warn', 'critical']) {
    assert.deepEqual(decideCall({ grade, toolName: 'read', policy }), { action: 'allow' })
  }
})

// ── 预占额度（reserveMemoryMb）────────────────────────────────────────────

test('applyReserve：可用量扣掉额度，原始值留在 *BeforeReserve 上', () => {
  const shifted = applyReserve(snap(3000, 5000), 1024)
  assert.equal(shifted.availPhysMb, 1976)
  assert.equal(shifted.availCommitMb, 3976)
  assert.equal(shifted.availPhysMbBeforeReserve, 3000, '原始读数必须留着，否则拒绝原因没法交代')
  assert.equal(shifted.availCommitMbBeforeReserve, 5000)
  assert.equal(shifted.reserveMb, 1024)
})

test('applyReserve：额度为 0 时是恒等变换（不改变判定结果）', () => {
  const base = snap(3000, 5000)
  const shifted = applyReserve(base, 0)
  assert.equal(shifted.availPhysMb, base.availPhysMb)
  assert.equal(shifted.availCommitMb, base.availCommitMb)
  assert.equal(gradeOf(shifted, THRESHOLDS), gradeOf(base, THRESHOLDS))
})

test('applyReserve：额度超过当前空闲时被夹到空闲，而不是把重活额度归零', () => {
  // 空闲 600 MB 却要预占 2048 MB：多出来的 1448 MB 是空气。旧实现会扣成 0，
  // 于是重活视角永远 critical，用户看到的是「还有 600 MB 却什么都调不动」。
  const shifted = applyReserve(snap(600, 900), 2048)
  assert.equal(shifted.reserveMb, 600, '实际生效额度被夹到空闲')
  assert.equal(shifted.reserveConfiguredMb, 2048, '填进去的原值要留着，面板才能说清为什么不够')
  assert.equal(shifted.availPhysMb, 0)
  assert.equal(shifted.availCommitMb, 300, '提交量按夹后的 600 扣，而不是按 2048 扣成 0')
  assert.equal(shifted.loadPercent, 100)
})

test('reserveCeilingMb：上限就是当前可用物理，再受固定天花板约束', () => {
  assert.equal(reserveCeilingMb(snap(1700, 8192)), 1700)
  assert.equal(reserveCeilingMb(snap(1700, 8192), 8192), 1700, '空闲比天花板小时取空闲')
  assert.equal(reserveCeilingMb(snap(9000, 8192), 8192), 8192, '空闲比天花板大时取天花板')
  // 总量读不到（非 Win32 / 能力层缺失）：没有可信空闲值，不能把上限压成 0，
  // 否则所有非 Windows 环境下「调大预占」都会失败。
  assert.equal(reserveCeilingMb(normalizeSnapshot({ availPhysMb: 0 }), 8192), 8192)
})

test('applyReserve：提交量未知（0）不能被减成「耗尽」', () => {
  // commit=0 的含义是「这一项拿不到」。若直接减额度，0 会被夹成 0，
  // 而 gradeOf 把 commit>0 当已知 —— 这条守着「未知不等于耗尽」。
  const shifted = applyReserve(snap(3000, 0), 1024)
  assert.equal(shifted.availCommitMb, 0)
  assert.equal(gradeOf(shifted, THRESHOLDS), 'warn', '只看物理：3000-1024=1976 < warn 2048')
})

test('预占的意义：系统还够用时，重活先被拦下（把最后一块留给轻活）', () => {
  // 原始 2600 MB 在 warn 阈值（2048）之上，本该放行；
  // 扣掉 1024 后剩 1576 MB，已经越过 warn 线。
  const base = snap(2600, 8192)
  assert.equal(gradeOf(base, THRESHOLDS), 'normal')
  assert.equal(gradeOf(applyReserve(base, 1024), THRESHOLDS), 'warn')

  // 再紧一点：原始读数仍是 normal，重活视角已是 critical。
  const tighter = snap(2000, 8192)
  assert.equal(gradeOf(tighter, THRESHOLDS), 'warn')
  assert.equal(gradeOf(applyReserve(tighter, 1024), THRESHOLDS), 'critical')
})

test('decideCall：拒绝原因必须交代预占，否则读数与判定自相矛盾', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  const shifted = applyReserve(snap(2000, 8192), 1024)
  const decision = decideCall({ grade: 'critical', toolName: 'pwsh', policy, snapshot: shifted })
  assert.equal(decision.action, 'deny')
  assert.match(decision.reason, /1024 MB 为轻活预占/)
  assert.match(decision.reason, /原始可用物理 2000 MB/)
})

test('decideCall：没开预占时不说预占的事', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  const decision = decideCall({ grade: 'critical', toolName: 'pwsh', policy, snapshot: applyReserve(snap(800), 0) })
  assert.equal(decision.action, 'deny')
  assert.ok(!decision.reason.includes('预占'))
})
