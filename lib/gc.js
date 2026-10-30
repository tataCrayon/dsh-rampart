/**
 * 「释放内存」：对本进程的 JS 堆做一次强制 GC。
 *
 * ## 为什么需要这招
 *
 * IDEA 的「Free Memory」按钮同理：它不改变程序逻辑，只是让 JVM 立刻做一次全量 GC，
 * 把已经不可达的垃圾立刻还回去，而不是等下一次自动回收。
 *
 * Node 默认不暴露 `global.gc`（要 `--expose-gc` 启动参数）。但 **v8.setFlagsFromString
 * 可以在运行时打开它**，再用一个干净 context 取出来 —— 这是 V8 自身提供的口子，
 * 不需要重启进程、不需要改启动命令。
 *
 * ## 实测（本机 Node 24 + Windows）
 *
 * 制造 ~29 MB 垃圾后调用：heapUsed 33.2 MB → 4.4 MB，耗时 3ms。
 * `rss` 几乎不掉（96.6 → 95.0 MB）—— 因为 V8 把页留在自己的池子里备用。
 * **这一点必须在 UI 上说清**，否则用户点了按钮看到任务管理器没变化，会以为功能坏了。
 *
 * ## 边界
 *
 * - 只影响**当前进程**的 JS 堆。renderer 的堆、Electron 的 native 内存、OS 文件缓存
 *   一概不动。
 * - 不缩容：不调用 `v8.setHeapSnapshotNearHeapLimit` 之类，也不 `trim`，因为它对
 *   「机器卡不卡」基本没帮助，反而让下一次分配变慢。
 */

import v8 from 'node:v8'
import vm from 'node:vm'

/**
 * 取出强制 GC 函数（失败返回 null）。
 *
 * 取到之后缓存在模块作用域：`vm.runInNewContext('gc')` 每次都要建一个 context，
 * 没必要重复付这个成本。
 * @returns {(() => void) | null} GC 函数。
 */
let cachedGc
export function resolveGc() {
  if (cachedGc !== undefined) return cachedGc
  if (typeof globalThis.gc === 'function') {
    cachedGc = globalThis.gc
    return cachedGc
  }
  try {
    v8.setFlagsFromString('--expose-gc')
    const candidate = vm.runInNewContext('gc')
    cachedGc = typeof candidate === 'function' ? candidate : null
  } catch {
    cachedGc = null
  }
  return cachedGc
}

/**
 * 读本进程的堆与 RSS 用量。
 * @returns {{heapUsedMb: number, heapTotalMb: number, rssMb: number, externalMb: number, heapLimitMb: number}} 读数。
 */
export function heapUsage() {
  const usage = process.memoryUsage()
  const heap = v8.getHeapStatistics()
  const toMb = (bytes) => Math.round((bytes / 1_048_576) * 10) / 10
  return {
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    rssMb: toMb(usage.rss),
    externalMb: toMb(usage.external),
    heapLimitMb: toMb(heap.heap_size_limit),
  }
}

/**
 * 强制回收一次，返回回收前后的读数。
 *
 * 读数里的 `freedMb` 是 **heapUsed** 的差值，不是 RSS 的差值 —— 后者几乎不动，
 * 拿它当「释放了多少」会误导。
 * @param {string} [reason] 触发来源（`ui` / `pressure` / `tool`），用于日志。
 * @returns {{ok: boolean, reason: string, before: object, after: object, freedMb: number, tookMs: number, note: string, error?: string}} 结果。
 */
export function collectGarbage(reason = 'manual') {
  const started = Date.now()
  const before = heapUsage()
  const gc = resolveGc()
  if (gc === null) {
    return {
      ok: false,
      reason,
      before,
      after: before,
      freedMb: 0,
      tookMs: Date.now() - started,
      note: '当前运行时不允许强制 GC（global.gc 与 v8.setFlagsFromString 都不可用）',
      error: 'gc-unavailable',
    }
  }

  try {
    gc()
  } catch (error) {
    return {
      ok: false,
      reason,
      before,
      after: heapUsage(),
      freedMb: 0,
      tookMs: Date.now() - started,
      note: '强制 GC 抛错',
      error: error.message,
    }
  }

  const after = heapUsage()
  return {
    ok: true,
    reason,
    before,
    after,
    freedMb: Math.round((before.heapUsedMb - after.heapUsedMb) * 10) / 10,
    tookMs: Date.now() - started,
    note: '只回收本进程的 JS 堆；renderer 堆、Electron native 内存与系统缓存不动，所以任务管理器里不一定看到变化',
  }
}
