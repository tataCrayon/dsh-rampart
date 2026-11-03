/**
 * 真集成测试：用真实的 cordis Context + 真实的 `@deepseek-ai/dsh-tools` ToolRuntime
 * 挂上本插件，验证 `tools/pre-execute` 门禁在真实工具流水线里生效。
 *
 * 为什么要真集成而不只做单测：单测只能证明「决策函数算得对」，
 * 证明不了「注册表真的会因为我返回 deny 而拒绝执行工具体」。
 * 这里注册一个会写文件的假重活工具，断言：critical 时文件没被创建、
 * 模型拿到的是 RESOURCE_GUARD_DENIED；normal 时文件被创建。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as guardPlugin from '../lib/index.js'

/**
 * 宿主依赖：这三个包由 DSH 本体提供，本仓库**不声明**也不打包它们。
 *
 * 所以它们只在「装了 DSH 的机器」上解析得到。这里动态导入而不是静态导入，
 * 是为了在没有宿主的环境（比如干净 CI runner）里把这一组测试**标记为跳过**
 * 而不是整份文件加载失败 —— 后者会让 `npm test` 直接红，看起来像代码坏了，
 * 实际只是缺一个测试环境。
 *
 * 只吞 ERR_MODULE_NOT_FOUND。别的错误（语法错、导出名错）照旧抛出去，
 * 不能被这个 try 顺手藏起来。
 */
let Context
let SystemPrompt
let ToolRuntime
/** false 表示照常跑；字符串表示跳过的原因（node:test 会把它打出来）。 */
let hostSkip = false

try {
  ;({ Context } = await import('@deepseek-ai/cordis'))
  ;({ default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt'))
  ;({ default: ToolRuntime } = await import('@deepseek-ai/dsh-tools'))
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  hostSkip =
    '需要宿主依赖 @deepseek-ai/cordis + dsh-system-prompt + dsh-tools（只有装了 DSH 的机器才有）。' +
    `实际缺失：${error.message.split('\n')[0]}`
}

/**
 * 组装一个只装了 systemPrompt + tools + 护栏的 composition。
 *
 * `ToolRuntime` 声明了 `static inject = ["systemPrompt"]`，缺这个服务时
 * 整个 tools 行不会激活、`ctx.tools` 是 undefined —— 所以必须一起挂。
 * @param {object} overrides 护栏配置覆盖项。
 * @returns {Promise<{ctx: any}>} 组装结果。
 */
async function compose(overrides) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(guardPlugin, {
    // 采样间隔设 0 关掉后台定时器，让测试只走 tools/pre-execute 里的同步采样
    sampleIntervalMs: 0,
    escalateSamples: 1,
    recoverSamples: 1,
    ...overrides,
  })
  return { ctx }
}

/**
 * 注册一个会真实写文件的假重活工具。
 *
 * 用文件是否存在作为「工具体有没有真的执行」的判据 —— 比读返回值可信，
 * 因为 block/deny 路径同样会产生一条错误结果，只有副作用能区分。
 * @param {any} ctx cordis 上下文。
 * @param {string} name 工具名。
 * @param {string} marker 副作用文件路径。
 */
function registerMarkerTool(ctx, name, marker) {
  ctx.tools.register({
    name,
    description: 'test-only heavy tool that leaves a marker file',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(marker, 'executed', 'utf8')
      return { ok: true }
    },
  })
}

/**
 * 跑一次工具调用。
 * @param {any} ctx cordis 上下文。
 * @param {string} name 工具名。
 * @returns {Promise<{isError: boolean, text: string}>} 结果摘要。
 */
async function call(ctx, name) {
  const result = await ctx.tools.execute({
    callId: `call-${Math.random().toString(16).slice(2)}`,
    name,
    arguments: {},
    signal: new AbortController().signal,
  })
  const text = (result.content ?? []).map((block) => block.text ?? '').join('\n')
  return { isError: result.isError === true, text }
}

test('critical 压力下：重活工具被拒，工具体没有执行', { skip: hostSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-int-'))
  const marker = join(dir, 'heavy.marker')
  // 阈值设到必然越线：可用内存低于 1 MB 才算正常
  const { ctx } = await compose({
    criticalFreeMemoryMb: 999_999_999,
    warnFreeMemoryMb: 999_999_999,
  })
  registerMarkerTool(ctx, 'pwsh', marker)

  const result = await call(ctx, 'pwsh')
  assert.equal(result.isError, true, '应当返回错误结果')
  assert.match(result.text, /资源护栏|RESOURCE_GUARD|拦/, `错误文本应说明原因，实际：${result.text}`)
  assert.equal(existsSync(marker), false, '工具体绝不能执行')
  await ctx.dispose?.()
})

test('normal 压力下：同一个重活工具正常执行', { skip: hostSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-int-'))
  const marker = join(dir, 'heavy.marker')
  const { ctx } = await compose({
    criticalFreeMemoryMb: 1,
    warnFreeMemoryMb: 1,
    warnCommitMb: 0,
    criticalCommitMb: 0,
  })
  registerMarkerTool(ctx, 'pwsh', marker)

  const result = await call(ctx, 'pwsh')
  assert.equal(result.isError, false, `应当成功，实际：${result.text}`)
  assert.equal(existsSync(marker), true, '工具体应当执行')
  await ctx.dispose?.()
})

test('critical 压力下：轻工具不受影响（模型仍能收尾）', { skip: hostSkip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rg-int-'))
  const marker = join(dir, 'light.marker')
  const { ctx } = await compose({
    criticalFreeMemoryMb: 999_999_999,
    warnFreeMemoryMb: 999_999_999,
    heavyTools: ['pwsh'],
  })
  registerMarkerTool(ctx, 'read', marker)

  const result = await call(ctx, 'read')
  assert.equal(result.isError, false, `轻工具应当放行，实际：${result.text}`)
  assert.equal(existsSync(marker), true)
  await ctx.dispose?.()
})

test('resource_guard 工具：返回可读读数与被拦计数', { skip: hostSkip }, async () => {
  const { ctx } = await compose({
    criticalFreeMemoryMb: 999_999_999,
    warnFreeMemoryMb: 999_999_999,
  })
  registerMarkerTool(ctx, 'pwsh', join(mkdtempSync(join(tmpdir(), 'rg-int-')), 'x.marker'))
  await call(ctx, 'pwsh')

  const result = await call(ctx, 'resource_guard')
  assert.equal(result.isError, false)
  assert.match(result.text, /"deniedCalls": 1/)
  assert.match(result.text, /"summary"/)
  assert.match(result.text, /"grade"/)
  await ctx.dispose?.()
})

test('护栏被 dispose 后恢复进程优先级（不污染宿主）', { skip: hostSkip }, async () => {
  const { ctx } = await compose({ sampleIntervalMs: 0 })
  const priorityBefore = process.env.__RG_PRIORITY_PROBE__ ?? null
  await ctx.dispose?.()
  // 这里只断言「dispose 不抛错且进程仍能正常分配内存」——
  // 具体优先级恢复由 test/guardian.test.mjs 的 fake 断言 + 真机探针覆盖。
  const chunk = Buffer.alloc(64 * 1024 * 1024)
  assert.equal(chunk.length, 64 * 1024 * 1024)
  assert.equal(priorityBefore, null)
})
