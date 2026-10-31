/**
 * 护栏状态机的运行时实现：把采样、分级、可逆限制、工具闸拼在一起。
 *
 * 与 `pressure.js` 的分工：那边是纯函数（可单测），这边负责副作用
 * （读系统内存、改优先级、冻结进程），因此它的每个副作用都必须**可逆**，
 * 且必须在 `dispose()` 里被撤销。
 */

import { GradeTracker, decideCall, describeState, gradeOf, normalizeSnapshot } from './pressure.js'
import { WIN32, fallbackMemoryStatus, loadWin32 } from './win32.js'

/**
 * 采样并归一化一次系统压力。
 * @param {object | undefined} win32 {@link loadWin32} 的返回值。
 * @returns {object} 归一化快照。
 */
export function sampleOnce(win32) {
  try {
    const raw = win32?.available ? win32.memoryStatus() : fallbackMemoryStatus()
    return normalizeSnapshot(raw)
  } catch {
    return normalizeSnapshot(fallbackMemoryStatus())
  }
}

/**
 * 护栏主体。
 *
 * 生命周期只有三段：`start()` 装可逆限制、`tick()` 采样更新等级、`dispose()` 全部撤销。
 * 任何一步失败都只降级能力、不中断插件（护栏自己崩掉比没有护栏更糟）。
 */
export class ResourceGuardian {
  /**
   * @param {object} options 构造参数。
   * @param {object} options.config 已校验的插件配置。
   * @param {(level: string, message: string) => void} [options.log] 日志回调。
   * @param {NodeJS.ProcessEnv} [options.env] 进程环境，测试时注入。
   */
  constructor(options) {
    this.config = options.config
    this.log = options.log ?? (() => {})
    this.env = options.env ?? process.env
    this.win32 = undefined
    this.tracker = new GradeTracker({
      escalateSamples: options.config.escalateSamples,
      recoverSamples: options.config.recoverSamples,
    })
    this.snapshot = normalizeSnapshot({})
    this.rawGrade = 'normal'
    this.deniedCalls = 0
    this.delayedCalls = 0
    this.samples = 0
    this.restore = []
    this.started = false
    this.frozenPids = new Set()
    /** @type {boolean} 当前是否已经降过优先级（用于避免重复 syscall）。 */
    this.priorityLowered = false
    /** @type {number | undefined} 降级前的原始优先级类，恢复时用。 */
    this.priorityFull = undefined
  }

  /** 初始化能力层（只做一次，可重复调用）。 */
  async init() {
    if (this.win32 !== undefined) return this.win32
    this.win32 = await loadWin32(this.env)
    if (!this.win32.available) {
      this.log('warn', `资源护栏：Win32 能力不可用（${this.win32.error}），退化为纯观测模式`)
    }
    return this.win32
  }

  /**
   * 装可逆限制：降优先级、钉核。
   *
   * 两项都必须在 `dispose()` 里恢复。实测（本机 Node 24 + Windows）：
   * 子进程会**继承**当前优先级类，所以这一项对 harness 拉起的 pwsh/node 同样生效。
   * @returns {Promise<void>}
   */
  async start() {
    if (this.started) return
    this.started = true
    const win32 = await this.init()
    if (!win32.available) return

    // 只有 `below-normal`（永远降）在启动时就动手；`on-pressure` 要等 tick 定级。
    if (this.config.priority === 'below-normal') {
      this.applyPriority('warn', '启动即降')
    }

    const cores = this.config.limitCores
    if (cores > 0) {
      try {
        const { process: procMask, system: sysMask } = win32.getAffinity()
        const target = lowestBitsMask(sysMask, cores)
        if (target !== procMask && win32.setAffinity(target)) {
          this.restore.push(() => win32.setAffinity(procMask))
          this.log('info', `资源护栏：亲和性 0x${procMask.toString(16)} → 0x${target.toString(16)}（限 ${cores} 核）`)
        }
      } catch (error) {
        this.log('warn', `资源护栏：设置亲和性失败（${error.message}）`)
      }
    }

    this.tick()
  }

  /**
   * 按当前等级决定要不要降优先级。
   *
   * ## 为什么必须是「按需降」而不是「启动就降」
   *
   * 本机实测（i7-13700，8 P 核 + 8 E 核；6 轮交错取中位）：
   *
   * | 场景 | NORMAL | BELOW_NORMAL | 倍数 |
   * |---|---|---|---|
   * | 单线程计算 | 94 ms | 300 ms | **×3.18** |
   * | CPU 密集子进程（工具形态） | 8051 ms | 18237 ms | **×2.27** |
   * | 4 个并行 CPU 子进程 | 1664 ms | 3571 ms | **×2.15** |
   * | I/O 密集子进程 | 295 ms | 322 ms | ×1.09 |
   *
   * 原因不是「同一个核上跑得慢」——钉在 P 核上两者都是 111 ms，钉在 E 核上都是 347 ms。
   * 是**调度器把低优先级线程优先放到 E 核**：8 个 E 核单线程性能只有 P 核的 1/3。
   * 所以这是一笔「用 2~3 倍 CPU 时间换前台响应」的交易，只在真的缺内存时才划算。
   *
   * 恢复是**即时且彻底**的（实测切回 NORMAL 立刻回到 94 ms，1.00×，不需要等待迁移），
   * 所以动态升降是安全的 —— 平时拿回全部速度，压力上来再让位。
   * @param {string} grade 当前等级。
   * @param {string} [reason] 日志里说明为什么动。
   * @returns {void}
   */
  applyPriority(grade, reason = '') {
    const mode = this.config.priority
    if (mode === 'unchanged') return
    if (!this.win32?.available) return

    const shouldLower = mode === 'below-normal' || grade !== 'normal'
    if (shouldLower === this.priorityLowered) return

    try {
      if (shouldLower) {
        this.priorityFull = this.win32.getPriority()
        if (!this.win32.setPriority(WIN32.BELOW_NORMAL_PRIORITY_CLASS)) {
          this.log('warn', '资源护栏：SetPriorityClass 失败，继续使用默认优先级')
          return
        }
        this.priorityLowered = true
        const suffix = reason === '' ? '' : `（${reason}）`
        this.log('info', `资源护栏：优先级 0x${this.priorityFull.toString(16)} → BELOW_NORMAL${suffix}`)
        return
      }
      if (this.win32.setPriority(this.priorityFull)) {
        this.priorityLowered = false
        this.log('info', `资源护栏：优先级恢复 0x${this.priorityFull.toString(16)}（压力解除）`)
      }
    } catch (error) {
      this.log('warn', `资源护栏：设置优先级失败（${error.message}）`)
    }
  }

  /**
   * 采样一次并按迟滞更新等级。
   * @returns {{grade: string, snapshot: object}} 当前状态。
   */
  tick() {
    this.samples += 1
    this.snapshot = sampleOnce(this.win32)
    this.rawGrade = gradeOf(this.snapshot, this.config)
    const before = this.tracker.grade
    const grade = this.tracker.observe(this.rawGrade)
    if (grade !== before) {
      const level = grade === 'normal' ? 'info' : 'warn'
      this.log(level, `资源护栏：等级 ${before} → ${grade}（${describeState(this.state())}）`)
    }
    this.applyPriority(grade)
    return { grade, snapshot: this.snapshot }
  }

  /**
   * 工具调用前的门禁。
   *
   * 只拦「重活」，轻工具（读文件、写待办、搜代码）永远放行 —— 压力大时
   * 更不该阻止模型收尾、汇报和保存状态。
   * @param {string} toolName 工具名。
   * @param {AbortSignal} [signal] 调用方取消信号。
   * @returns {Promise<{action: 'allow'|'deny', reason?: string}>} 决策。
   */
  async gate(toolName, signal) {
    if (!this.config.enabled) return { action: 'allow' }
    const { grade } = this.tick()
    const decision = decideCall({
      grade,
      toolName,
      policy: this.config,
      delayMs: grade === 'warn' ? this.config.warnDelayMs : this.config.criticalDelayMs,
      snapshot: this.snapshot,
    })
    if (decision.action === 'delay') {
      this.delayedCalls += 1
      await sleep(decision.delayMs, signal)
      return { action: 'allow' }
    }
    if (decision.action === 'deny') {
      this.deniedCalls += 1
      return { action: 'deny', reason: decision.reason }
    }
    return { action: 'allow' }
  }

  /**
   * 冻结一个进程（可逆，不杀）。
   * @param {number} pid 目标进程。
   * @returns {boolean} 是否成功。
   */
  freeze(pid) {
    if (!this.win32?.available) return false
    const ok = this.win32.suspend(pid)
    if (ok) this.frozenPids.add(pid)
    return ok
  }

  /**
   * 恢复一个被冻结的进程。
   * @param {number} pid 目标进程。
   * @returns {boolean} 是否成功。
   */
  thaw(pid) {
    if (!this.win32?.available) return false
    const ok = this.win32.resume(pid)
    if (ok) this.frozenPids.delete(pid)
    return ok
  }

  /**
   * 供工具与日志使用的状态快照。
   * @returns {object} 状态快照。
   */
  state() {
    return {
      grade: this.tracker.grade,
      rawGrade: this.rawGrade,
      snapshot: this.snapshot,
      deniedCalls: this.deniedCalls,
      delayedCalls: this.delayedCalls,
      samples: this.samples,
      frozenPids: [...this.frozenPids],
      priorityLowered: this.priorityLowered,
      capabilities: {
        win32: this.win32?.available === true,
        suspend: typeof this.win32?.suspend === 'function',
        jobLimit: typeof this.win32?.makeJob === 'function',
      },
    }
  }

  /**
   * 撤销所有可逆限制。幂等；必须能重复调用而不出错。
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.priorityLowered) {
      try {
        this.win32?.setPriority(this.priorityFull)
      } catch (error) {
        this.log('warn', `资源护栏：恢复优先级失败（${error.message}）`)
      }
      this.priorityLowered = false
    }
    for (const pid of [...this.frozenPids]) this.thaw(pid)
    for (const undo of this.restore.reverse()) {
      try {
        undo()
      } catch (error) {
        this.log('warn', `资源护栏：恢复失败（${error.message}）`)
      }
    }
    this.restore = []
    this.started = false
  }
}

/**
 * 从系统掩码里取最低的 N 个核。
 *
 * 「最低」是刻意的：高编号核在部分本子上是超线程的兄弟核，低编号核先占用
 * 更不容易和前台程序抢。母项目的资源护栏用的是同一策略。
 * @param {bigint} sysMask 系统可用掩码。
 * @param {number} cores 需要的核数。
 * @returns {bigint} 目标掩码。
 */
export function lowestBitsMask(sysMask, cores) {
  let chosen = 0n
  let picked = 0
  for (let bit = 0n; bit < 64n; bit += 1n) {
    if ((sysMask & (1n << bit)) === 0n) continue
    chosen |= 1n << bit
    picked += 1
    if (picked >= cores) break
  }
  return chosen
}

/**
 * 可被取消的等待。
 * @param {number} ms 等待毫秒数。
 * @param {AbortSignal} [signal] 取消信号。
 * @returns {Promise<void>} 等待完成或被取消。
 */
function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve()
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
