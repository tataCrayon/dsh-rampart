/**
 * 浏览器侧（`dsh.client` 那一半）的类型声明。
 *
 * 这个包没有构建期类型检查（客户端代码是一份手写 ESM 经机械转换得到的），
 * 所以这里的声明就是契约本身：改动 `client/source.js` 的导出时，
 * 这份文件必须同步 —— `test/client-contract.test.mjs` 会断言两者一致。
 */

import type { Context } from '@deepseek-ai/cordis'

/** 组件属性。 */
export interface StatusPillProps {
  /** 轮询间隔毫秒。 */
  intervalMs?: number
  /** 本地化函数（`ctx.locale` 提供的 `t`）。 */
  t?: (key: string) => string
}

/** 宿主 `/rampart/api/stats` 的响应。 */
export interface StatsPayload {
  ok: true
  at: number
  trustDegraded: boolean
  guard: {
    grade: string
    rawGrade: string
    summary: string
    totalMb: number
    availPhysMb: number
    availCommitMb: number
    loadPercent: number
    deniedCalls: number
    delayedCalls: number
    samples: number
    priority: string
    limitCores: number
    enabled: boolean
    win32: boolean
  }
  heap: {
    heapUsedMb: number
    heapTotalMb: number
    rssMb: number
    externalMb: number
    heapLimitMb: number
  }
  tree: null | {
    rootPid: number
    processCount: number
    commitMb: number
    workingSetMb: number
    cpuPercent: number
    treePercent: number
    top: Array<{ pid: number; name: string; commitMb: number }>
  }
}

/** 强制回收的响应。 */
export interface CollectPayload {
  ok: boolean
  reason: string
  before: StatsPayload['heap']
  after: StatsPayload['heap']
  freedMb: number
  tookMs: number
  note: string
  error?: string
}

export declare const name: string

export declare const inject: string[]

/** 把 MB 变成人读字符串。 */
export declare function formatMb(mb: number): string

/** 取路由基址。 */
export declare function apiBase(): string

/** 幂等注入样式。 */
export declare function ensureStyles(): void

/** 拉一次读数。 */
export declare function fetchStats(signal: AbortSignal): Promise<StatsPayload | null>

/** 触发强制回收。 */
export declare function requestGc(): Promise<CollectPayload>

/** 输入框下方的读数条。 */
export declare function StatusPill(props: StatusPillProps): unknown

/** 客户端插件体。 */
export declare function apply(ctx: Context, config?: { statusPillIntervalMs?: number }): void
