/**
 * DSH 资源护栏插件的入口。
 *
 * ## 它解决什么问题
 *
 * DSH 的宿主进程是 Electron，模型跑长任务时会拉起子代理、pwsh/bash 子进程、
 * 后台 job、workflow 扇出。这些能力各有自己的上限（`maxActiveSubagents` 默认 8、
 * `maxParallelToolCalls` 默认 10），但**没有任何一个上限是按「这台机器还剩多少内存」
 * 来定的**。本机实测：物理 32 GB、可用长期在 2.7~3.3 GB（约 9%），
 * 提交内存同样只剩 3 GB 左右；在这个状态下再叠一层并行重活，整机就进入换页风暴。
 *
 * 内置 304 个包与社区插件里都没有「按机器压力限制 harness」的能力（详见
 * README 的调研结论），所以这里自己补一层**软护栏**：
 *
 *   1. 采样系统可用物理/提交内存，带迟滞地分成 normal / warn / critical 三级
 *   2. 进程级可逆降级：优先级降 BELOW_NORMAL、亲和性钉住少数核（子进程继承）
 *   3. 工具门禁：压力大时拦下「重活」（pwsh/bash/workflow/subagent…），轻工具照常
 *   4. 暴露 `resource_guard` 工具，让模型和用户都能查当前等级与被拦次数
 *
 * ## 它做不到什么（必须说清）
 *
 * - **不能给宿主进程加内存硬顶**。Job Object 的限额一旦附加就无法解除
 *   （Windows 没有移出 Job 的 API，见 `docs/decisions/005-资源护栏.md` 的实测记录），
 *   给 Electron 自己套上限等于把整个应用永久锁死。硬顶只能由外层启动器
 *   （`scripts/dsh-guarded.ps1`）在进程创建时施加。
 * - **不能抢占已经跑飞的工具**。`tools/pre-execute` 只能在调用**前**拒绝；
 *   已经在跑的 pwsh 命令只能靠 `freeze()`（可逆冻结）或用户取消。
 * - **不是安全边界**。它防的是「自己把自己卡死」，不是恶意进程。
 */

import { Config } from './config.js'
import { ResourceGuardian } from './guardian.js'
import { describeState } from './pressure.js'

export const name = 'resource-guard'

/**
 * 只依赖 `tools`（注册查询工具与 pre-execute 门禁）。
 * 其余能力（jobs / subagents / workflow）都按「有则用、无则跳过」处理，
 * 因为不同 profile 的组合不同，缺一个不该让护栏整体不加载。
 */
export const inject = ['tools']

export { Config }

/**
 * 安装护栏。
 * @param {any} ctx cordis 上下文。
 * @param {any} config 已校验配置。
 */
export function apply(ctx, config) {
  const guardian = new ResourceGuardian({
    config,
    log: (level, message) => {
      const logger = ctx.logger('resource-guard')
      if (logger?.[level]) logger[level](message)
    },
  })

  // 一切副作用都挂在 effect 上：插件被卸载/HMR 重载时自动撤销限制。
  ctx.effect(() => () => guardian.dispose(), 'resource-guard: restore reversible limits')

  // 后台采样：等级变化只写日志，真正的决策发生在每次工具调用前（保证读的是最新值）。
  if (config.enabled && config.sampleIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          guardian.tick()
        } catch (error) {
          ctx.logger?.warn?.(`resource-guard: sample failed: ${error.message}`)
        }
      }, config.sampleIntervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'resource-guard: pressure sampling')
  }

  // 启动：装可逆限制。失败只降级，不抛。
  guardian.start().catch((error) => {
    ctx.logger?.warn?.(`resource-guard: start failed: ${error.message}`)
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const decision = await guardian.gate(exec.name, exec.signal)
      if (decision.action === 'deny') {
        return {
          kind: 'deny',
          reason: decision.reason,
          info: { name: 'ResourceGuardDenied', code: 'RESOURCE_GUARD_DENIED' },
        }
      }
    } catch (error) {
      // 护栏自身出错时放行：宁可漏拦一次，也不要把模型卡死在一条假错误上。
      ctx.logger?.warn?.(`resource-guard: gate failed, allowing ${exec.name}: ${error.message}`)
    }
    return next()
  })

  ctx.tools.register(defineResourceGuardTool(guardian))
}

/**
 * 构造 `resource_guard` 工具定义。
 *
 * 这个工具同时是护栏的「取证接口」：模型在压力大时被拦住，可以调它拿到
 * 具体读数，再用这条读数决定是继续、降级还是停下汇报。
 * @param {ResourceGuardian} guardian 护栏实例。
 * @returns {object} 工具定义。
 */
export function defineResourceGuardTool(guardian) {
  return {
    name: 'resource_guard',
    description:
      'Read the local resource guard: current memory pressure grade, the exact free physical/commit memory, and how many heavy tool calls have been denied or delayed. Call it when a heavy tool was refused, or before starting a batch of heavy work, to decide whether the machine can take it.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          grade: { type: 'string' },
          rawGrade: { type: 'string' },
          summary: { type: 'string' },
          totalMb: { type: 'integer' },
          availPhysMb: { type: 'integer' },
          availCommitMb: { type: 'integer' },
          loadPercent: { type: 'integer' },
          deniedCalls: { type: 'integer' },
          delayedCalls: { type: 'integer' },
          samples: { type: 'integer' },
          frozenPids: { type: 'array', items: { type: 'integer' } },
          win32: { type: 'boolean' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => {
      const state = guardian.state()
      return {
        grade: state.grade,
        rawGrade: state.rawGrade,
        summary: describeState(state),
        totalMb: state.snapshot.totalMb,
        availPhysMb: state.snapshot.availPhysMb,
        availCommitMb: state.snapshot.availCommitMb,
        loadPercent: state.snapshot.loadPercent,
        deniedCalls: state.deniedCalls,
        delayedCalls: state.delayedCalls,
        samples: state.samples,
        frozenPids: state.frozenPids,
        win32: state.capabilities.win32,
      }
    },
    isConcurrencySafe: () => true,
  }
}
