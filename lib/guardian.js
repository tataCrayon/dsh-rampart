/**
 * 护栏状态机的运行时实现：把采样、分级、可逆限制、工具闸拼在一起。
 *
 * 与 `pressure.js` 的分工：那边是纯函数（可单测），这边负责副作用
 * （读系统内存、改优先级、冻结进程），因此它的每个副作用都必须**可逆**，
 * 且必须在 `dispose()` 里被撤销。
 */

import { GradeTracker, applyReserve, decideCall, describeState, gradeOf, heavyThresholds, normalizeSnapshot, reserveCeilingMb } from './pressure.js'
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
    /** patch 里的基线预占额度。用户没覆盖时就是它生效。 */
    this.baseReserveMb = Math.max(0, Math.floor(options.config.reserveMemoryMb ?? 0))
    /**
     * 当前生效的预占额度（MB）。
     *
     * 单独存一份而不是每次读 `this.config.reserveMemoryMb`：面板上调预占**不能**
     * 走 patch 重载 —— 那会把 guardian 整个重建、清掉迟滞状态与被拦计数，
     * 还会重新装一遍优先级/亲和性。这里就地改一个数字，下一轮采样立即按新值算。
     */
    this.reserveMb = this.baseReserveMb
    this.win32 = undefined
    this.tracker = new GradeTracker({
      escalateSamples: options.config.escalateSamples,
      recoverSamples: options.config.recoverSamples,
    })
    // 重活单独一条迟滞链：它的判定阈值被预占线抬高了，与「整机压力」不是同一个量。
    // 共用一个 tracker 会让两条阈值序列互相打断连击，表现为「明明一直越线却升不了级」。
    this.heavyTracker = new GradeTracker({
      escalateSamples: options.config.escalateSamples,
      recoverSamples: options.config.recoverSamples,
    })
    this.snapshot = normalizeSnapshot({})
    /** 展示用的「重活还能再吃多少」：不参与判定，只给面板与工具读数。 */
    this.heavySnapshot = normalizeSnapshot({})
    this.rawGrade = 'normal'
    this.rawHeavyGrade = 'normal'
    this.heavyGrade = 'normal'
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
    /**
     * 生命周期代号。`start()` 在 `await init()` 之后要回头看这个代号有没有变过：
     * 变了说明中途被 `dispose()`（HMR 重载）打断，此时**不能再装限制**，
     * 否则限制按上去就没人撤了。踩过：热重载恰好落在首次加载的窗口里，
     * 优先级被留在了 BELOW_NORMAL。
     * @type {number}
     */
    this.generation = 0
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
    const generation = this.generation
    const win32 = await this.init()
    // `init()` 里有一次动态 import，可能耗时几十毫秒；这期间插件可能已经被卸载
    // （HMR 重载、profile 切换）。此时再装限制就是泄漏，必须原样返回。
    if (generation !== this.generation || !this.started) return
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
   *
   * 迟滞数的是**采样次数**，而 `gate()` 每次工具调用都会真采一次（3 µs 量级，
   * 与一次 pwsh 冷启动的 200 ms 相比是噪声）。所以模型一口气发 N 个工具调用会
   * 推进 N 次迟滞 —— 这是刻意的：判定用的永远是**此刻**的读数，而不是最多 5 秒前
   * 的旧值。突发扇出时升级快一点不是误拦，因为那时内存确实正被它们吃掉。
   *
   * ## 预占只抬高「重活 critical 线」，不动整体等级
   *
   * `snapshot` 保留**原始**读数；`heavySnapshot` 只是展示用的「重活还能再吃多少」
   * （空闲 − 预占）。真正参与判定的是 `heavyThresholds(...)`：把 critical 那条线抬到
   * `max(critical, 预占)`，再拿**原始**读数去套。
   *
   * 这两件事必须分开：如果直接拿「空闲 − 预占」去套没变过的 critical，拦截线就变成
   * 「critical + 预占」，旋钮越大可用性越差 —— 0.3.0 的 bug 正是这个。
   * 而整体等级（以及降优先级这类全局副作用）仍按原始读数走：预占的语义是「给轻活留一块」，
   * 不是「假装机器更紧张」。等级也虚高的话，底栏会长期报 warn，用户只会去调阈值压它。
   * @returns {{grade: string, snapshot: object}} 当前状态。
   */
  tick() {
    this.samples += 1
    this.snapshot = sampleOnce(this.win32)
    this.heavySnapshot = applyReserve(this.snapshot, this.reserveMb)
    this.rawGrade = gradeOf(this.snapshot, this.config)
    const before = this.tracker.grade
    const grade = this.tracker.observe(this.rawGrade)
    if (grade !== before) {
      const level = grade === 'normal' ? 'info' : 'warn'
      this.log(level, `资源护栏：等级 ${before} → ${grade}（${describeState(this.state())}）`)
    }
    // 重活那条链跟着**同一串采样**推进：后台定时器与 gate() 都走这里，所以两条链
    // 拿到的是完全相同的采样序列。若改成「只在 gate() 里喂重活链」，后台 tick 与
    // gate 会交替喂不同读数，`pending` 被反复改写、连击永远攒不满 —— 表现是
    // 「预占开着时升级再也不触发」。两条链各自完整，才谈得上互不打扰。
    this.rawHeavyGrade = this.heavyGradeNow()
    this.heavyGrade = this.heavyTracker.observe(this.rawHeavyGrade)
    this.applyPriority(grade)
    return { grade, snapshot: this.snapshot }
  }

  /**
   * 用当前的原始读数与预占线算一次「重活视角」的瞬时等级（无副作用、不推进迟滞）。
   *
   * 判定输入是**原始空闲**，阈值是抬高后的那条线 —— 见 `tick()` 里的说明。
   * @returns {'normal'|'warn'|'critical'} 瞬时等级。
   */
  heavyGradeNow() {
    const thresholds = heavyThresholds(this.config, this.heavySnapshot?.reserveMb ?? this.reserveMb)
    return gradeOf(this.snapshot, thresholds)
  }

  /**
   * 取「重活视角」的等级与读数：等级走它自己那条迟滞链，读数是展示用的剩余量。
   *
   * 只读不推进状态。预占为 0 时两条链的输入完全一致，因此两个等级永远相等，
   * 行为与引入预占之前等价。
   * @returns {{grade: string, snapshot: object}} 重活视角。
   */
  heavyView() {
    return { grade: this.heavyTracker.grade, snapshot: this.heavySnapshot }
  }

  /**
   * 就地改预占额度（面板上的旋钮用它）。
   *
   * 改完**立即**用上一次的原始重新算一遍重活快照，不等下一轮 `tick()`：
   * 面板是 2 秒轮询的，等下一轮只是把「点了没反应」延长两秒；而这里必须
   * 立刻能看出效果，否则用户会以为按钮坏了、连点几次。
   *
   * 存的是**填进去的值**，不是夹过的值：空闲是浮动的，今天 1.7 GB 就只存 1.7 GB
   * 的话，明天机器空了也回不到用户想要的 2 GB。夹只发生在算重活额度那一步
   * （`applyReserve`），并由 `state()` 同时报出生效值与填写值。
   *
   * 不重置迟滞：`heavyTracker` 保持原样，只是下一轮喂进去的瞬时等级变了。
   * 重置会让「调大预占」变成一次瞬时的判定跳变，反而更抖。
   * @param {number} mb 新的预占额度（MB），负数按 0 处理。
   * @returns {number} 记下的额度（可能大于当前空闲，生效值见 `state()`）。
   */
  setReserve(mb) {
    this.reserveMb = Math.max(0, Math.floor(Number.isFinite(mb) ? mb : 0))
    this.heavySnapshot = applyReserve(this.snapshot, this.reserveMb)
    this.rawHeavyGrade = this.heavyGradeNow()
    this.heavyGrade = this.heavyTracker.observe(this.rawHeavyGrade)
    return this.reserveMb
  }

  /**
   * 当前允许设定的最大预占额度：**当前可用物理**（再受固定天花板约束）。
   *
   * 线可以高过 critical 阈值（那正是它的用途），但不能高过当前空闲：画在 5 GB 而机器
   * 只有 3.5 GB，等于宣布「此刻重活已经越线」，还报出一个不存在的数。
   * @param {number} [ceilingMb] 固定天花板。
   * @returns {number} 上限（MB）。
   */
  reserveCeiling(ceilingMb = Number.POSITIVE_INFINITY) {
    return reserveCeilingMb(this.snapshot, ceilingMb)
  }

  /**
   * 重活真正的拦截线（MB）：`max(criticalFreeMemoryMb, 预占线)`。
   *
   * 这是给面板与工具读的唯一权威数字。用户要判断的从来不是「预占填了多少」，
   * 而是「空闲剩多少时重活会被停」。0.3.0 的 bug 就藏在这两个数被说成同一个的
   * 地方 —— 那时它其实是 `critical + 预占`。
   * @returns {number} 拦截线（MB）。
   */
  heavyDenyBelowMb() {
    return heavyThresholds(this.config, this.reserveMb).criticalFreeMemoryMb
  }

  /**
   * 工具调用前的门禁。
   *
   * 只拦「重活」，轻工具（读文件、写待办、搜代码）永远放行 —— 压力大时
   * 更不该阻止模型收尾、汇报和保存状态。
   *
   * 决策用的是**重活视角**的等级（生效拦截线 = `max(critical, 预占)`）与展示读数，
   * 预占额度由 `setReserve()` 就地调，不需要重建护栏。
   * @param {string} toolName 工具名。
   * @param {AbortSignal} [signal] 调用方取消信号。
   * @returns {Promise<{action: 'allow'|'deny', reason?: string}>} 决策。
   */
  async gate(toolName, signal) {
    if (!this.config.enabled) return { action: 'allow' }
    this.tick()
    const heavy = this.heavyView()
    const decision = decideCall({
      grade: heavy.grade,
      toolName,
      policy: this.config,
      delayMs: heavy.grade === 'warn' ? this.config.warnDelayMs : this.config.criticalDelayMs,
      snapshot: heavy.snapshot,
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
      // 重活视角：扣过预占额度，且有自己的迟滞链。底栏与 resource_guard 都要显示它 ——
      // 否则会出现「工具被拦了，但读数说 normal」这种自相矛盾的画面。
      heavyGrade: this.heavyTracker.grade,
      rawHeavyGrade: this.rawHeavyGrade,
      snapshot: this.snapshot,
      heavySnapshot: this.heavySnapshot,
      /** 生效值：被当前空闲夹过，真正参与判定的那个数。 */
      reserveMb: this.heavySnapshot.reserveMb ?? this.reserveMb,
      /** 填进去的值（可能大于当前空闲）。两者不同即说明被夹住了。 */
      reserveConfiguredMb: this.reserveMb,
      reserveCeilingMb: this.reserveCeiling(),
      baseReserveMb: this.baseReserveMb,
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
    this.generation += 1
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
