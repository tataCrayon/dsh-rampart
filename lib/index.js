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
 *   2. 进程级可逆降级：压力到 warn 才降优先级（回 normal 即恢复）、亲和性钉住少数核（子进程继承）
 *   3. 工具门禁：压力大时拦下「重活」（pwsh/bash/workflow/subagent…），轻工具照常
 *   4. 暴露 `resource_guard` 工具，让模型和用户都能查当前等级与被拦次数
 *
 * ## 它做不到什么（必须说清）
 *
 * - **不能给宿主进程加内存硬顶**。Job Object 的限额一旦附加就无法解除
 *   （Windows 没有移出 Job 的 API，实测记录见 `deploy-desktop.md`），
 *   给 Electron 自己套上限等于把整个应用永久锁死。硬顶只能由外层启动器
 *   （`dsh-guarded.cmd` → `scripts/launch.mjs`）在进程创建时施加。
 * - **不能抢占已经跑飞的工具**。`tools/pre-execute` 只能在调用**前**拒绝；
 *   已经在跑的 pwsh 命令只能靠 `freeze()`（可逆冻结）或用户取消。
 * - **不是安全边界**。它防的是「自己把自己卡死」，不是恶意进程。
 */

import os from 'node:os'
import { Config } from './config.js'
import { ResourceGuardian } from './guardian.js'
import { collectGarbage, heapUsage } from './gc.js'
import { ROUTE_PREFIX, MAX_RESERVE_MB, TreeSampler, createStatsHandler, trustOf } from './host-api.js'
import { describeState } from './pressure.js'
import { clearReserveOverride, loadReserveOverride, resolveReserveFile, saveReserveOverride } from './reserve-store.js'

export const name = 'rampart'

/**
 * 只依赖 `tools`（注册查询工具与 pre-execute 门禁）。
 * 其余能力（jobs / subagents / workflow / webServer / connection）都按「有则用、无则跳过」
 * 处理，因为不同 profile 的组合不同，缺一个不该让护栏整体不加载。
 */
export const inject = ['tools']

export { Config }

/**
 * 安装护栏。
 * @param {any} ctx cordis 上下文。
 * @param {any} config 已校验配置。
 */
export function apply(ctx, config) {
  /**
   * 往宿主日志写一行。
   *
   * 统一走 `ctx.logger('rampart')`（具名）而不是 `ctx.logger?.warn?.()`（默认 logger）：
   * 后者能让调用成功，但日志落在宿主默认命名空间下，排查时**看不出是哪个插件说的**。
   * 另外 `ctx.logger` 在 cordis 里是个可调用对象（同时挂着 `.warn` 等方法），
   * 两种写法都能跑，这里选前者只为让来源可辨。
   * @param {string} level 等级。
   * @param {string} message 内容。
   */
  const log = (level, message) => {
    const logger = ctx.logger('rampart')
    if (logger?.[level]) logger[level](message)
  }

  const guardian = new ResourceGuardian({ config, log })

  // 用户层覆盖优先于 patch 基线：patch 是「这个 profile 的统一配置」，
  // 覆盖文件是「这台机器/这个人现在的选择」。读失败只回落，不报错。
  const override = loadReserveOverride(process.env)
  if (override !== undefined && override.value !== guardian.reserveMb) {
    guardian.setReserve(override.value)
    log('info', `rampart: 预占额度取用户覆盖 ${override.value} MB（patch 基线 ${guardian.baseReserveMb} MB）`)
  }

  // 一切副作用都挂在 effect 上：插件被卸载/HMR 重载时自动撤销限制。
  ctx.effect(() => () => guardian.dispose(), 'rampart: restore reversible limits')

  // 后台采样：等级变化只写日志，真正的决策发生在每次工具调用前（保证读的是最新值）。
  if (config.enabled && config.sampleIntervalMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          guardian.tick()
        } catch (error) {
          log('warn', `rampart: sample failed: ${error.message}`)
        }
      }, config.sampleIntervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'rampart: pressure sampling')
  }

  // 启动：装可逆限制。失败只降级，不抛。
  guardian.start().catch((error) => {
    log('warn', `rampart: start failed: ${error.message}`)
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
      log('warn', `rampart: gate failed, allowing ${exec.name}: ${error.message}`)
    }
    return next()
  })

  ctx.tools.register(defineResourceGuardTool(guardian))

  // 底栏读数接口：有 webServer 才挂（CLI-only profile 没有 GUI，不需要）。
  if (config.showStatusPill) {
    installStatsRoute(ctx, config, guardian, log)
  }
}

/**
 * 挂上底栏读数路由。
 *
 * 用 `ctx.inject` 而不是顶层 `inject` 声明 `webServer`：桌面与 CLI 两套 profile 的
 * 服务组合不同，把它写成硬依赖会让没 webServer 的 profile 整个插件不加载。
 * @param {any} ctx cordis 上下文。
 * @param {any} config 已校验配置。
 * @param {ResourceGuardian} guardian 护栏实例。
 * @param {(level: string, message: string) => void} log 日志出口。
 */
function installStatsRoute(ctx, config, guardian, log) {
  // 同时声明 webServer 与 connection：前者是硬需求（没有它就没路由），
  // 后者只用于「这个请求可不可信」的判定，缺了会退化成回环判定。
  // 之所以在这里用 ctx.inject 而不是顶层 inject，是因为桌面与 CLI 两套 profile
  // 的服务组合不同，写成硬依赖会让没 webServer 的 profile 整个插件不加载。
  ctx.inject(['webServer'], (webCtx) => {
    const sampler = new TreeSampler({
      win32: () => guardian.init(),
      cores: os.cpus().length,
    })
    let degradedLogged = false
    /** 是否真的处于弱化判定（与「有没有记过日志」是两件事，不能共用一个布尔）。 */
    let trustDegraded = false

    const handler = createStatsHandler({
      sampler,
      guard: () => {
        const state = guardian.state()
        return {
          grade: state.grade,
          rawGrade: state.rawGrade,
          heavyGrade: state.heavyGrade,
          // 重活视角的可用量（已扣预占）：底栏的「重活还能吃多少」用这两个数，
          // 与门禁判定同源，避免面板说「还有 7 GB」而工具却已经被拦。
          availPhysMb: state.heavySnapshot.availPhysMb,
          availPhysMbRaw: state.snapshot.availPhysMb,
          availCommitMb: state.heavySnapshot.availCommitMb,
          availCommitMbRaw: state.snapshot.availCommitMb,
          reserveMb: state.reserveMb,
          reserveConfiguredMb: state.reserveConfiguredMb,
          reserveCeilingMb: state.reserveCeilingMb,
          baseReserveMb: state.baseReserveMb,
          // 覆盖是否真的落盘了：环境里没有 profile/home 目录时只能内存生效，
          // 面板要据此把「重置」和提示文案区分开（否则用户以为设置丢了）。
          reservePersisted: resolveReserveFile(process.env) !== undefined,
          summary: describeState(state),
          totalMb: state.snapshot.totalMb,
          loadPercent: state.snapshot.loadPercent,
          deniedCalls: state.deniedCalls,
          delayedCalls: state.delayedCalls,
          samples: state.samples,
          priority: config.priority,
          limitCores: config.limitCores,
          enabled: config.enabled,
          win32: state.capabilities.win32,
        }
      },
      heap: heapUsage,
      collect: () => collectGarbage('ui'),
      log,
      trustDegraded: () => trustDegraded,
      /**
       * 就地改预占：先改内存里的生效值，再尝试落盘。
       *
       * 顺序是刻意的：**先改再存**。落盘失败（目录不可写、没有 profile 目录）
       * 仍然要立刻生效 —— 用户点的是「调预占」，不是「调并持久化」，把功能
       * 绑在磁盘权限上等于在没有 profile 目录的环境里直接坏掉。
       * @param {number} mb 新的预占额度。
       * @returns {number} 实际生效的额度。
       */
      setReserve: (mb) => {
        const applied = guardian.setReserve(mb)
        const saved = saveReserveOverride(applied, process.env)
        if (!saved.ok) log('warn', `rampart: 预占额度 ${applied} MB 只在本次运行生效（未落盘：${saved.error}）`)
        else log('info', `rampart: 预占额度改为 ${applied} MB（已保存到 ${saved.path}）`)
        return applied
      },
      /** 重置：删掉用户覆盖，回落到 patch 基线。 */
      resetReserve: () => {
        const cleared = clearReserveOverride(process.env)
        if (!cleared.ok) log('warn', `rampart: 删除预占覆盖失败（${cleared.error}）`)
        return guardian.setReserve(guardian.baseReserveMb)
      },
      /** 当前允许的最大预占额度：跟着当前空闲走，再受固定天花板约束。 */
      reserveCeiling: () => guardian.reserveCeiling(MAX_RESERVE_MB),
    })

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            // 处理函数里抛任何东西都会被 webserver 统一转成 400，看起来像
            // 「路径写错了」。所以这里自己兜住，并留下能定位的日志。
            try {
              const trust = trustOf(webCtx, req)
              // 判定结果每一次请求都要更新：只置 true 不置 false 的话，
              // 后续恢复了 connection 服务，读数里仍然谎报「已弱化」。
              trustDegraded = trust.degraded
              if (trust.degraded && !degradedLogged) {
                degradedLogged = true
                log('warn', 'rampart: 没有 connection 服务，底栏读数路由退化为「只允许本机回环」判定')
              }
              if (!trust.trusted) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
                return
              }
              return handler(req, res)
            } catch (error) {
              log('warn', `rampart: 读数路由失败（${error.message}）`)
              if (!res.headersSent) {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              }
              res.end(JSON.stringify({ ok: false, error: error.message }))
              return undefined
            }
          },
        }),
      'rampart: status pill route',
    )
  })
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
          heavyGrade: { type: 'string' },
          summary: { type: 'string' },
          totalMb: { type: 'integer' },
          availPhysMb: { type: 'integer' },
          availPhysMbRaw: { type: 'integer' },
          availCommitMb: { type: 'integer' },
          availCommitMbRaw: { type: 'integer' },
          reserveMb: { type: 'integer' },
          reserveConfiguredMb: { type: 'integer' },
          reserveCeilingMb: { type: 'integer' },
          reserveBaselineMb: { type: 'integer' },
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
        heavyGrade: state.heavyGrade,
        summary: describeState(state),
        totalMb: state.snapshot.totalMb,
        // 两组数都给：`availPhysMb` 是重活能用的额度（已扣预占），
        // `availPhysMbRaw` 是系统真实可用。只给前者会让模型以为系统只剩这么点。
        availPhysMb: state.heavySnapshot.availPhysMb,
        availPhysMbRaw: state.snapshot.availPhysMb,
        availCommitMb: state.heavySnapshot.availCommitMb,
        availCommitMbRaw: state.snapshot.availCommitMb,
        reserveMb: state.reserveMb,
        // 面板上填的值与它当前的上限（= 当前空闲）：两者都给，模型才能解释
        // 「为什么填了 2 GB 却按 1.7 GB 算」。
        reserveConfiguredMb: state.reserveConfiguredMb,
        reserveCeilingMb: state.reserveCeilingMb,
        // 基线（patch 里写的那个）：模型据此能说清「当前值是面板调过的还是配置里的」。
        reserveBaselineMb: state.baseReserveMb,
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
