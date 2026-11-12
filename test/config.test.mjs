/**
 * 配置校验的单元测试。
 *
 * 理由：`Config` 是本插件唯一由「外部输入」决定行为的地方（profile patch 里手写的
 * 阈值）。它出错的表现最隐蔽——阈值写反了不会报错，只会让护栏永不触发或永远触发。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, DEFAULTS } from '../lib/config.js'

/**
 * 校验一份配置。
 * @param {unknown} input 原始输入。
 * @returns {{value?: object, issues?: object[]}} 结果。
 */
function check(input) {
  return Config['~standard'].validate(input)
}

test('空配置补出完整默认值', () => {
  const result = check({})
  assert.ok(result.value, JSON.stringify(result.issues))
  assert.equal(result.value.enabled, true)
  assert.equal(result.value.warnFreeMemoryMb, DEFAULTS.warnFreeMemoryMb)
  assert.equal(result.value.criticalFreeMemoryMb, DEFAULTS.criticalFreeMemoryMb)
  assert.equal(result.value.priority, 'on-pressure')
  assert.deepEqual(result.value.heavyTools, [...DEFAULTS.heavyTools])
})

test('undefined / null 等同空对象', () => {
  assert.equal(check(undefined).value.warnFreeMemoryMb, DEFAULTS.warnFreeMemoryMb)
  assert.equal(check(null).value.warnFreeMemoryMb, DEFAULTS.warnFreeMemoryMb)
})

test('非对象输入被拒绝', () => {
  assert.ok(check('nope').issues)
  assert.ok(check([1, 2]).issues)
})

test('阈值写反时拒绝加载（critical 不应高于 warn）', () => {
  const result = check({ warnFreeMemoryMb: 500, criticalFreeMemoryMb: 1000 })
  assert.ok(result.issues, '必须报错而不是静默接受')
  assert.match(result.issues[0].message, /critical/)
  assert.deepEqual(result.issues[0].path, ['criticalFreeMemoryMb'])
})

test('提交量阈值写反时也拒绝', () => {
  const result = check({ warnCommitMb: 1000, criticalCommitMb: 2000 })
  assert.ok(result.issues)
  assert.deepEqual(result.issues[0].path, ['criticalCommitMb'])
})

test('提交量阈值允许全为 0（关闭该项检查）', () => {
  const result = check({ warnCommitMb: 0, criticalCommitMb: 0 })
  assert.ok(result.value)
  assert.equal(result.value.warnCommitMb, 0)
})

test('非法类型被拒绝而不是被强转', () => {
  assert.ok(check({ warnFreeMemoryMb: '2048' }).issues, '字符串不应当被当成数字')
  assert.ok(check({ escalateSamples: 0 }).issues, '采样次数至少 1')
  assert.ok(check({ heavyTools: ['ok', ''] }).issues, '不允许空工具名')
  assert.ok(check({ heavyTools: 'pwsh' }).issues, '必须是数组')
})

test('priority 只接受三个值', () => {
  assert.ok(check({ priority: 'high' }).issues)
  assert.equal(check({ priority: 'unchanged' }).value.priority, 'unchanged')
  assert.equal(check({ priority: 'on-pressure' }).value.priority, 'on-pressure')
  assert.equal(check({ priority: 'below-normal' }).value.priority, 'below-normal')
})

test('显式布尔开关不做隐式强转', () => {
  assert.equal(check({ denyHeavyOnCritical: false }).value.denyHeavyOnCritical, false)
  assert.equal(check({}).value.denyHeavyOnCritical, true, '默认是拦')
  assert.equal(check({ denyHeavyOnWarn: true }).value.denyHeavyOnWarn, true)
  assert.equal(check({ denyHeavyOnWarn: 0 }).value.denyHeavyOnWarn, false, '非 true 值一律 false')
})

test('defaults 常量覆盖全部配置项，且与实际默认值一致', () => {
  const value = check({}).value
  assert.deepEqual(
    Object.keys(DEFAULTS).sort(),
    Object.keys(value).sort(),
    'DEFAULTS 漏了字段就说明它已经和真实默认值漂了',
  )
  for (const [key, expected] of Object.entries(DEFAULTS)) {
    assert.deepEqual(value[key], expected, `${key} 默认值不一致`)
  }
})

test('DEFAULTS 是冻结的副本，改它不会污染后续校验', () => {
  assert.throws(() => {
    DEFAULTS.priority = 'unchanged'
  }, TypeError)
  assert.equal(check({}).value.priority, 'on-pressure')
})

test('预占额度默认 1024 MB，0 表示关闭，负数被拒', () => {
  assert.equal(check({}).value.reserveMemoryMb, 1024)
  assert.equal(check({ reserveMemoryMb: 0 }).value.reserveMemoryMb, 0, '0 是「关闭」，必须被接受')
  assert.equal(check({ reserveMemoryMb: 4096 }).value.reserveMemoryMb, 4096)
  assert.ok(check({ reserveMemoryMb: -1 }).issues, '负数没有意义，应当拒绝')
  assert.ok(check({ reserveMemoryMb: '1024' }).issues, '字符串不做隐式强转（与其它数值字段一致）')
})
