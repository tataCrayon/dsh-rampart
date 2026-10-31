/**
 * 插件入口的公开类型。实现全部是 JS（无构建步骤），这里只声明对外契约，
 * 供 TypeScript 使用者与 IDE 补全。
 */

/** 插件名，cordis 用它做 fiber 诊断与日志名。 */
export declare const name: 'rampart'

/** 依赖的服务：只要求 tools。 */
export declare const inject: readonly ['tools']

/** StandardSchemaV1 形态的配置校验器。 */
export declare const Config: {
  '~standard': {
    version: 1
    vendor: string
    validate(input: unknown):
      | { value: GuardConfig }
      | { issues: Array<{ path: string[]; message: string }> }
  }
}

/** 已校验的插件配置。 */
export interface GuardConfig {
  /** 总开关；关掉只保留查询工具。 */
  enabled: boolean
  /** 可用物理内存低于此值进入 warn（只降速 + 提醒）。 */
  warnFreeMemoryMb: number
  /** 可用物理内存低于此值进入 critical（拦重活）。 */
  criticalFreeMemoryMb: number
  /** 可用提交内存低于此值进入 warn；0 表示不检查。 */
  warnCommitMb: number
  /** 可用提交内存低于此值进入 critical；0 表示不检查。 */
  criticalCommitMb: number
  /** 连续多少轮采样越线才升级。 */
  escalateSamples: number
  /** 连续多少轮采样回线才降级。 */
  recoverSamples: number
  /** 后台采样间隔；0 表示只在工具调用前采样。 */
  sampleIntervalMs: number
  /**
   * 进程优先级策略。
   *
   * - `on-pressure`（默认）：平时保持原优先级，进入 warn/critical 才降，
   *   压力解除立刻恢复。**这是默认值**，因为降优先级在混合核 CPU 上是拿
   *   2~3 倍 CPU 时间换前台响应，没压力时白花。
   * - `below-normal`：启动即永久降级，退出时才恢复。
   * - `unchanged`：从不碰优先级。
   */
  priority: 'unchanged' | 'on-pressure' | 'below-normal'
  /** 钉住的核数；0 表示不动亲和性。 */
  limitCores: number
  /** warn 等级下重活的额外等待。 */
  warnDelayMs: number
  /** critical 等级下重活被放行时的等待。 */
  criticalDelayMs: number
  /** warn 等级是否也直接拦重活。 */
  denyHeavyOnWarn: boolean
  /** critical 等级是否拦重活。 */
  denyHeavyOnCritical: boolean
  /** 精确的重活工具名单。 */
  heavyTools: string[]
  /** 通配匹配的重活工具名。 */
  heavyPatterns: string[]
}

/** 压力等级。 */
export type Grade = 'normal' | 'warn' | 'critical'

/** 插件安装函数。 */
export declare function apply(ctx: unknown, config: GuardConfig): void

/** 导出 `resource_guard` 工具的构造函数，供测试替换护栏实例。 */
export declare function defineResourceGuardTool(guardian: unknown): object
