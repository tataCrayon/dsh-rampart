/**
 * 验证探针（仅在 .verify profile 里挂载）：在真实 DSH composition 里真的调一次重活工具，
 * 记录护栏的裁决，落盘给 `scripts/verify-profile.mjs` 断言。
 *
 * 两个必须处理的时序问题（都踩过）：
 *   1. cordis 按**服务可用性**激活，`tools` 服务出现得早、工具逐条注册得晚。
 *      固定 `setTimeout(300)` 会时快时慢 —— 曾出现过 `UNKNOWN_TOOL: pwsh`（还有人被这
 *      条假失败骗过一次）。所以这里轮询到目标工具真的出现再动手。
 *   2. 护栏的 `start()` 是异步的（要 `import()` Win32 绑定），能力位可能还没就绪。
 */

import { existsSync, rmSync, writeFileSync } from 'node:fs'

const OUT = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/deny-result.json'
const MARKER = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/deny-marker.txt'

export const name = 'rampart-deny-probe'
export const inject = ['tools']

/**
 * 反复轮询直到条件成立或超时。
 * @param {() => boolean} predicate 条件。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {Promise<boolean>} 是否在超时前成立。
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * 调一次工具，返回归一化结果。
 * @param {any} ctx cordis 上下文。
 * @param {string} name 工具名。
 * @param {object} args 参数。
 * @returns {Promise<object>} 归一化结果。
 */
async function invoke(ctx, name, args) {
  try {
    const result = await ctx.tools.execute({
      callId: `probe-${name}-${Date.now()}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    const text = (result.content ?? []).map((block) => block.text ?? '').join('\n')
    return {
      name,
      isError: result.isError === true,
      errorCode: result.error?.info?.code ?? null,
      text: text.slice(0, 600),
    }
  } catch (cause) {
    return { name, threw: `${cause.name}: ${cause.message}` }
  }
}

export async function apply(ctx) {
  const names = () => (ctx.tools.schemas?.() ?? []).map((tool) => tool.name)
  const ready = await waitFor(() => names().includes('pwsh') && names().includes('resource_guard'), 10_000)

  if (existsSync(MARKER)) rmSync(MARKER)
  const record = { at: new Date().toISOString(), ready, steps: [], tools: names() }

  record.steps.push(await invoke(ctx, 'pwsh', {
    command: `Set-Content -Path '${MARKER}' -Value executed`,
    description: 'probe marker',
  }))
  record.markerExists = existsSync(MARKER)

  record.steps.push(await invoke(ctx, 'resource_guard', {}))

  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  const heavy = record.steps[0]
  process.stderr.write(
    `[deny-probe] ready=${ready} heavy isError=${heavy.isError} code=${heavy.errorCode} marker=${record.markerExists}\n`,
  )
}
