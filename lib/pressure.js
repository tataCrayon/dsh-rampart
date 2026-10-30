/**
 * 资源护栏的纯逻辑层：内存压力采样、分级、迟滞、重活判定。
 *
 * 这一层不接触 cordis，也不接触 Win32 —— 所有输入都是普通对象，
 * 因此可以被 node:test 直接单测（见 test/guard.test.mjs）。
 *
 * ## 为什么分级要做迟滞
 *
 * 系统可用内存是抖动的：一次 GC、一次浏览器换页，就能让采样值在阈值上下
 * 反复穿越。没有迟滞时，护栏会在一秒内「拦截 → 放行 → 拦截」反复横跳，
 * 模型看到的是随机失败。所以升级要连续 N 次越线、降级也要连续 N 次回到线下。
 */

/** 三级压力。`normal` 放行，`warn` 只提醒，`critical` 拦重活。 */
export const GRADES = Object.freeze(['normal', 'warn', 'critical'])

/** 默认的低优先级类常量（Windows PROCESS_SET_INFORMATION）。 */
export const BELOW_NORMAL_PRIORITY_CLASS = 0x0000_4000

/**
 * 把字节换算成 MB，向下取整。
 * @param {number} bytes 字节数；非有限值返回 0。
 * @returns {number} MB 数。
 */
export function toMb(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes / 1_048_576) : 0
}

/**
 * 采样快照归一化：把不同来源（Win32 / Node）的读数压成同一个形状。
 * @param {object} input 原始读数。
 * @param {number} [input.totalMb] 物理内存总量。
 * @param {number} [input.availPhysMb] 可用物理内存。
 * @param {number} [input.availCommitMb] 可用提交内存（0 表示未知）。
 * @param {number} [input.loadPercent] 调用方给定的负载百分比。
 * @returns {{totalMb: number, availPhysMb: number, availCommitMb: number, loadPercent: number, at: number}} 归一化快照。
 */
export function normalizeSnapshot(input) {
  const totalMb = Math.max(0, Math.floor(input.totalMb ?? 0))
  const availPhysMb = Math.max(0, Math.floor(input.availPhysMb ?? 0))
  const availCommitMb = Math.max(0, Math.floor(input.availCommitMb ?? 0))
  const loadPercent = Number.isFinite(input.loadPercent)
    ? Math.round(input.loadPercent)
    : totalMb > 0
      ? Math.round(((totalMb - availPhysMb) / totalMb) * 100)
      : 0
  return { totalMb, availPhysMb, availCommitMb, loadPercent, at: Date.now() }
}

/**
 * 按阈值给一份快照定级，不含迟滞。
 * @param {object} snapshot {@link normalizeSnapshot} 的输出。
 * @param {object} thresholds 阈值集合。
 * @returns {'normal'|'warn'|'critical'} 瞬时等级。
 */
export function gradeOf(snapshot, thresholds) {
  const phys = snapshot.availPhysMb
  const commit = snapshot.availCommitMb
  // commit 为 0 表示这一项拿不到，不能当成「内存耗尽」。
  const commitKnown = commit > 0
  if (phys > 0 && phys <= thresholds.criticalFreeMemoryMb) return 'critical'
  if (commitKnown && commit <= thresholds.criticalCommitMb) return 'critical'
  if (phys > 0 && phys <= thresholds.warnFreeMemoryMb) return 'warn'
  if (commitKnown && commit <= thresholds.warnCommitMb) return 'warn'
  return 'normal'
}

/**
 * 带迟滞的等级跟踪器：越线要连续 `escalateSamples` 次，回落要连续 `recoverSamples` 次。
 */
export class GradeTracker {
  /**
   * @param {object} [options] 迟滞参数。
   * @param {number} [options.escalateSamples] 升级所需的连续越线次数，至少 1。
   * @param {number} [options.recoverSamples] 降级所需的连续回线次数，至少 1。
   */
  constructor(options = {}) {
    this.escalateSamples = Math.max(1, Math.floor(options.escalateSamples ?? 2))
    this.recoverSamples = Math.max(1, Math.floor(options.recoverSamples ?? 2))
    this.grade = 'normal'
    this.pending = 'normal'
    this.streak = 0
  }

  /**
   * 吃一份快照，返回迟滞后的等级。
   * @param {'normal'|'warn'|'critical'} raw 本轮的瞬时等级。
   * @returns {'normal'|'warn'|'critical'} 迟滞后的等级。
   */
  observe(raw) {
    if (raw === this.grade) {
      this.pending = raw
      this.streak = 0
      return this.grade
    }
    if (raw === this.pending) {
      this.streak += 1
    } else {
      this.pending = raw
      this.streak = 1
    }
    const needed = GRADES.indexOf(raw) > GRADES.indexOf(this.grade)
      ? this.escalateSamples
      : this.recoverSamples
    if (this.streak >= needed) {
      this.grade = raw
      this.streak = 0
    }
    return this.grade
  }
}

/**
 * 把 `*` 通配模式编译成锚定的正则；其余正则元字符按字面量处理。
 * @param {string} pattern 模式串。
 * @returns {RegExp} 锚定正则。
 */
export function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * 判定一个工具是否算「重活」：默认名单 + 通配模式。
 * @param {string} toolName 工具名。
 * @param {object} policy 判定策略。
 * @param {readonly string[]} policy.heavyTools 精确名单。
 * @param {readonly string[]} [policy.heavyPatterns] 通配模式。
 * @returns {boolean} 是否重活。
 */
export function isHeavyTool(toolName, policy) {
  if (policy.heavyTools.includes(toolName)) return true
  return (policy.heavyPatterns ?? []).some((pattern) => wildcardToRegExp(pattern).test(toolName))
}

/**
 * 决定一次工具调用要不要被拦。
 *
 * 三种结果：
 *   `allow`  —— 放行
 *   `deny`   —— 直接拒绝（返回给模型的是一条可读的原因）
 *   `delay`  —— 先等 `delayMs` 再放行（压力没那么大时，用慢一点换稳一点）
 *
 * 拒绝原因里刻意带上**当前读数**与**下一步动作**：模型被拦住时最怕的是
 * 只拿到一句「禁止」，那会让它反复重试同一条命令。带上证据它才会改策略。
 *
 * @param {object} input 决策输入。
 * @param {string} input.grade 当前等级。
 * @param {string} input.toolName 工具名。
 * @param {object} input.policy 判定策略。
 * @param {number} [input.delayMs] 降速毫秒数，0 表示不降速。
 * @param {object} [input.snapshot] 当前内存快照，用于把读数写进拒绝原因。
 * @returns {{action: 'allow'|'deny'|'delay', reason?: string, delayMs?: number}} 决策。
 */
export function decideCall(input) {
  const { grade, toolName, policy, snapshot } = input
  if (grade === 'normal') return { action: 'allow' }
  if (!isHeavyTool(toolName, policy)) return { action: 'allow' }

  const denyNow = grade === 'critical'
    ? policy.denyHeavyOnCritical !== false
    : policy.denyHeavyOnWarn === true
  if (denyNow) {
    const evidence = snapshot === undefined
      ? ''
      : `（可用物理 ${snapshot.availPhysMb} MB / 总 ${snapshot.totalMb} MB，占用 ${snapshot.loadPercent}%` +
        `${snapshot.availCommitMb > 0 ? `，可用提交 ${snapshot.availCommitMb} MB` : ''}）`
    const advice =
      '机器已接近卡死临界点，继续跑会拖垮整台机器。请改用轻量动作（read/grep/write/todo_write 等），' +
      '或调用 resource_guard 查看实时读数后向用户汇报并等待。'
    return {
      action: 'deny',
      reason: `资源护栏：${toolName} 属于重活，当前内存压力为 ${grade}${evidence}。${advice}`,
    }
  }
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? 0))
  return delayMs > 0 ? { action: 'delay', delayMs } : { action: 'allow' }
}

/**
 * 一份人读的压力摘要，用于工具返回值与日志。
 * @param {object} state 护栏状态。
 * @returns {string} 摘要文本。
 */
export function describeState(state) {
  const s = state.snapshot
  const commit = s.availCommitMb > 0 ? `${s.availCommitMb} MB` : '未知'
  return [
    `等级 ${state.grade}（瞬时 ${state.rawGrade}）`,
    `可用物理 ${s.availPhysMb} MB / 总量 ${s.totalMb} MB（占用 ${s.loadPercent}%）`,
    `可用提交 ${commit}`,
    `已拦 ${state.deniedCalls} 次，降速 ${state.delayedCalls} 次，采样 ${state.samples} 次`,
  ].join('；')
}
