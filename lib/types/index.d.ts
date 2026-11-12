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
  /**
   * 为轻活预占的内存额度（MB），默认 1024，0 表示关闭。
   *
   * 语义是**额度划拨**，不是真实占用：它从「重活准入」的读数里扣掉这么多可用量
   * （`availPhysMb - reserveMemoryMb`），于是重活会在系统还剩这一块时就先被拦，
   * 把最后一块留给 `read`/`grep`/`write`/汇报。进程本身一个字节都不多占，
   * 因此永远可逆、也不会因为预占本身导致 OOM。
   *
   * 只影响 `gate()` 的重活判定与读数展示：`grade`/`rawGrade`（整机压力等级、
   * 降优先级时机）仍按系统真实读数走。
   *
   * 这个字段是**基线**：面板上调整的值存在用户层（profile 目录下的
   * `rampart.reserve.json`），优先级高于它；面板「重置」即回落到这里的值。
   */
  reserveMemoryMb: number
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
