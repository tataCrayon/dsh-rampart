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
  heavyThresholds,
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

test('applyReserve：读数展示「重活还能再吃多少」= 空闲 − 预占', () => {
  const shifted = applyReserve(snap(3000, 5000), 1024)
  assert.equal(shifted.availPhysMb, 1976, '展示值 = 3000 − 1024')
  assert.equal(shifted.availPhysMbBeforeReserve, 3000, '原始读数必须留着，否则拒绝原因没法交代')
  assert.equal(shifted.availCommitMbBeforeReserve, 5000)
  assert.equal(shifted.reserveMb, 1024)
})

test('applyReserve：提交内存不受预占影响（它是另一个资源池）', () => {
  // 早先一并扣提交量，导致「可用提交」凭空缩水，和任务管理器对不上账。
  const shifted = applyReserve(snap(3000, 5000), 1024)
  assert.equal(shifted.availCommitMb, 5000)
})

test('applyReserve：额度为 0 时是恒等变换（不改变判定结果）', () => {
  const base = snap(3000, 5000)
  const shifted = applyReserve(base, 0)
  assert.equal(shifted.availPhysMb, base.availPhysMb)
  assert.equal(shifted.availCommitMb, base.availCommitMb)
  assert.equal(gradeOf(shifted, THRESHOLDS), gradeOf(base, THRESHOLDS))
})

test('applyReserve：额度超过当前空闲时被夹到空闲', () => {
  // 空闲 600 MB 却要预占 2048 MB：多出来的 1448 MB 是空气。夹住而不是报 2048，
  // 否则读数会显示一个机器上根本不存在的字数。
  const shifted = applyReserve(snap(600, 900), 2048)
  assert.equal(shifted.reserveMb, 600, '实际生效额度被夹到空闲')
  assert.equal(shifted.reserveConfiguredMb, 2048, '填进去的原值要留着，面板才能说清为什么不够')
  assert.equal(shifted.availPhysMb, 0, '夹到空闲后没有剩余')
  assert.equal(shifted.availCommitMb, 900, '提交量不参与夹')
})

test('reserveCeilingMb：上限是当前空闲，再受固定天花板约束', () => {
  // 线可以高过 critical（那正是它的用途），但不能高过当前空闲 —— 否则读数会显示一个
  // 机器上根本不存在的数，且等价于宣布「此刻已经越线」。
  assert.equal(reserveCeilingMb(snap(5000, 8192), 8192), 5000)
  assert.equal(reserveCeilingMb(snap(5000, 8192), 2560), 2560, '固定天花板更小时取天花板')
  assert.equal(reserveCeilingMb(snap(1700, 8192), 8192), 1700, '空闲更小时取空闲')
  // 总量读不到（非 Win32 / 能力层缺失）：没有可信空闲值，不能把上限压成 0，
  // 否则所有非 Windows 环境下「调大预占」都会失败。
  assert.equal(reserveCeilingMb(normalizeSnapshot({ availPhysMb: 0 }), 8192), 8192)
})

test('applyReserve：提交量未知（0）不能被当成「耗尽」', () => {
  // commit=0 的含义是「这一项拿不到」。减成 0 或比水位线都会把「未知」变成「耗尽」。
  // 用一份空闲足够高的快照：那样物理这条线不会盖住提交这条线的结论。
  const shifted = applyReserve(snap(9000, 0), 1024)
  assert.equal(shifted.availCommitMb, 0)
  assert.equal(gradeOf(shifted, THRESHOLDS), 'normal', '提交未知时只看物理：9000 高于两条线')
})

test('heavyThresholds：拦截线取 max(critical, 预占)，不是相加', () => {
  // 这是今天那个 bug 的正面断言。本机实配 critical 1800、预占 2262：
  // 旧实现把「空闲 − 预占」喂给没变过的 critical，拦截线变成 1800 + 2262 = 4062 MB。
  // 注意这里的 THRESHOLDS.criticalFreeMemoryMb 是 1024，所以用 1800 的配置来断言。
  const real = { ...THRESHOLDS, criticalFreeMemoryMb: 1800 }
  assert.equal(heavyThresholds(real, 2262).criticalFreeMemoryMb, 2262)
  assert.equal(heavyThresholds(real, 1024).criticalFreeMemoryMb, 1800, '预占更小时以 critical 为准')
  assert.equal(heavyThresholds(real, 0).criticalFreeMemoryMb, 1800, '不开预占时阈值原样')
  // warn 线不动：预占只决定「什么时候停」，不该顺手改「什么时候降速」
  assert.equal(heavyThresholds(real, 2262).warnFreeMemoryMb, real.warnFreeMemoryMb)
})

test('预占的意义：把线画在预占上，机器还剩 4 GB 时照样放行重活', () => {
  const real = { ...THRESHOLDS, criticalFreeMemoryMb: 1800, warnFreeMemoryMb: 3000 }
  const heavyCfg = heavyThresholds(real, 2262)
  // 4000/3000 在 warn 区间（>2262 且 <3000 的是 2400 与 2262 也都在线下），都不该 critical
  for (const free of [4000, 3000, 2400, 2263]) {
    assert.notEqual(gradeOf(snap(free, 8192), heavyCfg), 'critical', `空闲 ${free} MB 高于预占线，不该拦重活`)
  }
  assert.equal(gradeOf(snap(2262, 8192), heavyCfg), 'critical', '正好压线就拦（≤ 阈值）')
  // critical 比预占线更保守时，最终由 critical 决定。
  // 注意 warn 线：1900 在 warn(3000) 之下会是 warn —— 用的是「不 critical」而不是「normal」。
  const tighter = heavyThresholds(real, 1024)
  assert.notEqual(gradeOf(snap(1900, 8192), tighter), 'critical', '1900 高于 critical 1800，不该拦')
  assert.equal(gradeOf(snap(1700, 8192), tighter), 'critical')
})

test('decideCall：拒绝原因必须交代预占线，否则读数与判定自相矛盾', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  const shifted = applyReserve(snap(2000, 8192), 1024)
  const decision = decideCall({ grade: 'critical', toolName: 'pwsh', policy, snapshot: shifted })
  assert.equal(decision.action, 'deny')
  assert.match(decision.reason, /预占线为 1024 MB/)
  assert.match(decision.reason, /原始可用物理 2000 MB/)
})

test('decideCall：没开预占时不说预占的事', () => {
  const policy = { heavyTools: ['pwsh'], denyHeavyOnCritical: true }
  const decision = decideCall({ grade: 'critical', toolName: 'pwsh', policy, snapshot: applyReserve(snap(800), 0) })
  assert.equal(decision.action, 'deny')
  assert.ok(!decision.reason.includes('预占'))
})
