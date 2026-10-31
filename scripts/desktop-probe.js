/**
 * 桌面 profile 取证探针（临时，用完从 patch 里删）。
 *
 * 只在 `.verify` 里出现的证据不算数——那是 headless 环境。这个探针挂在**真实的
 * Electron 宿主进程**里，能证明插件真的进了宿主 composition，而且门禁真的在
 * 拦截我在这个会话里发的每一次工具调用。
 *
 * 它每 10 秒重写一次读数，因此可以「一边干活一边看计数涨」：
 *   - `delayedCalls` 增长 → 门禁在真实调用链上生效（warn 等级下每次重活 +400ms）
 *   - `deniedCalls` 增长 → 已升级到 critical 并真的拦住了
 *
 * 注意：它**不**自己造一次 pwsh 调用。真宿主里由我这个 agent 的调用充当样本，
 * 比探针自己伪造更可信。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const OUT = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/desktop-live.json'

export const name = 'rampart-desktop-probe'
export const inject = ['tools']

/**
 * 反复轮询直到条件成立或超时。
 * @param {() => boolean} predicate 条件。
 * @param {number} timeoutMs 超时毫秒。
 * @returns {Promise<boolean>} 是否成立。
 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

/**
 * 调一次工具，返回归一化结果。
 * @param {any} ctx cordis 上下文。
 * @param {string} name 工具名。
 * @returns {Promise<object>} 归一化结果。
 */
async function invoke(ctx, name) {
  try {
    const result = await ctx.tools.execute({
      callId: `desktop-probe-${Date.now()}`,
      name,
      arguments: {},
      signal: new AbortController().signal,
    })
    const text = (result.content ?? []).map((block) => block.text ?? '').join('\n')
    return { isError: result.isError === true, errorCode: result.error?.info?.code ?? null, text: text.slice(0, 900) }
  } catch (cause) {
    return { threw: `${cause.name}: ${cause.message}` }
  }
}

export async function apply(ctx) {
  const names = () => (ctx.tools.schemas?.() ?? []).map((tool) => tool.name)
  await waitFor(() => names().includes('resource_guard'), 15_000)
  mkdirSync(dirname(OUT), { recursive: true })

  /**
   * 采一次样并落盘。
   * @returns {Promise<void>}
   */
  const sample = async () => {
    const readout = await invoke(ctx, 'resource_guard')
    let payload = null
    try {
      payload = JSON.parse(readout.text)
    } catch {
      payload = null
    }
    const record = {
      at: new Date().toISOString(),
      pid: process.pid,
      execPath: process.execPath,
      toolCount: names().length,
      hasResourceGuard: names().includes('resource_guard'),
      readoutError: readout.isError ?? false,
      ...(payload ?? { rawText: readout.text, threw: readout.threw }),
    }
    writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }

  await sample()
  const timer = setInterval(() => {
    sample().catch(() => {})
  }, 10_000)
  timer.unref?.()
  ctx.effect(() => () => clearInterval(timer), 'desktop-probe: stop sampling')
}
