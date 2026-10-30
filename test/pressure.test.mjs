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
  decideCall,
  gradeOf,
  isHeavyTool,
  normalizeSnapshot,
  toMb,
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

test('toMb：字节转 MB 向下取整，异常输入归零', () => {
  assert.equal(toMb(1_048_576), 1)
  assert.equal(toMb(1_048_575), 0)
  assert.equal(toMb(0), 0)
  assert.equal(toMb(-5), 0)
  assert.equal(toMb(Number.NaN), 0)
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
