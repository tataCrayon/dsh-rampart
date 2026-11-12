/**
 * 资源护栏的纯逻辑层：内存压力采样、分级、迟滞、重活判定。
 *
 * 这一层不接触 cordis，也不接触 Win32 —— 所有输入都是普通对象，
 * 因此可以被 node:test 直接单测（见 test/pressure.test.mjs）。
 *
 * ## 为什么分级要做迟滞
 *
 * 系统可用内存是抖动的：一次 GC、一次浏览器换页，就能让采样值在阈值上下
 * 反复穿越。没有迟滞时，护栏会在一秒内「拦截 → 放行 → 拦截」反复横跳，
 * 模型看到的是随机失败。所以升级要连续 N 次越线、降级也要连续 N 次回到线下。
 */

/** 三级压力。`normal` 放行，`warn` 只提醒，`critical` 拦重活。 */
export const GRADES = Object.freeze(['normal', 'warn', 'critical'])

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
 * 算出预占额度的合法上限：**当前可用物理内存**。
 *
 * ## 为什么上限是「可用」而不是某个固定数
 *
 * 预占是从空闲里划出来留给轻活的那一块。现在只剩 1.7 GB 空闲却预占 2 GB，语义上
 * 说不通 —— 那 2 GB 里有一半根本不存在，扣完之后重活额度被夹到 0，护栏就变成
 * 「无条件拦下一切重活」，而不是「按比例留出一块」。用户看到的现象是：明明机器
 * 还有 1.7 GB，pwsh 却永远调不动，只能去把预占关掉。
 *
 * 所以上限跟着**当前空闲**走，并在读数里如实给出：空闲变小时上限跟着变小，
 * 已经存着的更大值会被说明成「已被空闲夹住」，而不是悄悄失效。
 *
 * 固定天花板 `MAX_RESERVE_MB` 仍然保留，取两者较小值：它挡的是「手滑多打一位数」，
 * 与运行时的内存水位是两件不同的事。
 * @param {object} snapshot {@link normalizeSnapshot} 的输出（原始读数）。
 * @param {number} [ceilingMb] 固定天花板，默认不额外限制。
 * @returns {number} 当前允许的最大预占额度（MB）。
 */
export function reserveCeilingMb(snapshot, ceilingMb = Number.POSITIVE_INFINITY) {
  const free = Math.max(0, Math.floor(snapshot?.availPhysMb ?? 0))
  // 总量读不到（非 Windows / 能力层缺失）时没有可信的空闲值，不该把上限压成 0 ——
  // 那会让「调大预占」在所有非 Win32 环境里都失败，而插件在那里本来只是纯观测。
  const known = (snapshot?.totalMb ?? 0) > 0
  return known ? Math.min(free, Math.floor(ceilingMb)) : Math.floor(ceilingMb)
}

/**
 * 把「给轻活预占的内存」从一份快照的可用量里划走。
 *
 * ## 为什么是「划额度」而不是「真占内存」
 *
 * 真去分配 X MB 并常驻，能挡住别人抢，但代价是 DSH 自己常年多吃 X MB、
 * 物理页还可能被系统换出去 —— 一个为了防卡死而先吃掉内存的组件，很难说清
 * 它到底是帮忙还是添乱。而这里要解决的真实问题很窄：
 *
 *   **重活把最后一点内存吃光之后，模型连 read/write/汇报都做不了。**
 *
 * 所以只改「重活准入」这一道闸的读数：可用量先扣掉 `reserveMb`，再拿去定级。
 * 内存没有任何实际占用，因此永远可逆、随时可调、不会因为预占本身导致 OOM。
 *
 * ## 为什么保留原始读数
 *
 * 拒绝原因里必须同时给出「扣除前」和「扣除后」。只给扣除后的数会让模型看到
 * 「可用物理 7923 MB」却被告知 critical，它只会以为护栏坏了，然后重试。
 * `reserveMb === 0` 时也照样带上原始字段，让上层不必分两种形状处理。
 * @param {object} snapshot {@link normalizeSnapshot} 的输出。
 * @param {number} [reserveMb] 预占额度，0 或未给表示不预占。
 * @returns {object} 新的快照对象（原对象不被修改），多出 `reserveMb` 与 `*BeforeReserve`。
 */
export function applyReserve(snapshot, reserveMb) {
  const asked = Math.max(0, Math.floor(reserveMb ?? 0))
  // 预占不能超过当前空闲：那多出来的部分根本不存在。夹住而不是让重活额度归零，
  // 否则「空闲 1.7 GB、预占 2 GB」会让护栏永远 critical，用户只能把预占关掉。
  const reserve = Math.min(asked, reserveCeilingMb(snapshot))
  const commit = snapshot.availCommitMb
  const availPhysMb = Math.max(0, snapshot.availPhysMb - reserve)
  return {
    ...snapshot,
    reserveMb: reserve,
    reserveConfiguredMb: asked,
    availPhysMbBeforeReserve: snapshot.availPhysMb,
    availCommitMbBeforeReserve: commit,
    loadPercentBeforeReserve: snapshot.loadPercent,
    availPhysMb,
    loadPercent: snapshot.totalMb > 0
      ? Math.round(((snapshot.totalMb - availPhysMb) / snapshot.totalMb) * 100)
      : snapshot.loadPercent,
    // commit 为 0 表示「拿不到」，不能拿它去减：否则 0 - reserve 会被夹成 0，
    // 反而让「未知」变成「耗尽」，直接误判成 critical。
    availCommitMb: commit > 0 ? Math.max(0, commit - reserve) : 0,
  }
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
  // 「拿不到」用 totalMb === 0 表示，而不是 phys === 0。写成 `phys > 0` 会漏掉最该
  // 报 critical 的那一刻：可用物理内存真的归零时，判定反而回到 normal。
  const physKnown = snapshot.totalMb > 0
  // commit 为 0 表示这一项拿不到，不能当成「内存耗尽」。
  const commitKnown = commit > 0
  if (physKnown && phys <= thresholds.criticalFreeMemoryMb) return 'critical'
  if (commitKnown && commit <= thresholds.criticalCommitMb) return 'critical'
  if (physKnown && phys <= thresholds.warnFreeMemoryMb) return 'warn'
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
 * 编译后的重活判定规则，按 policy 对象缓存。
 *
 * `isHeavyTool` 在**每次工具调用**前都会被调一次；早先的实现每次现编译一遍正则，
 * 于是每个工具调用都要付一次 `new RegExp` 的分配与解析成本。policy 是配置对象，
 * 一个插件实例只有一份，天然适合按对象缓存。
 *
 * 约定：**policy 里的名单视为不可变**（配置文件在插件生命周期内不会原地改），
 * 需要改就换一个新对象 —— cordis 热重载正是这么做的。
 * @type {WeakMap<object, {exact: Set<string>, patterns: RegExp[]}>}
 */
const heavyRulesCache = new WeakMap()

/**
 * 取一份 policy 编译后的规则（必要时现编译并缓存）。
 * @param {object} policy 判定策略。
 * @returns {{exact: Set<string>, patterns: RegExp[]}} 编译结果。
 */
function heavyRulesOf(policy) {
  const cached = heavyRulesCache.get(policy)
  if (cached !== undefined) return cached
  const rules = {
    exact: new Set(policy.heavyTools ?? []),
    patterns: (policy.heavyPatterns ?? []).map(wildcardToRegExp),
  }
  heavyRulesCache.set(policy, rules)
  return rules
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
  const rules = heavyRulesOf(policy)
  if (rules.exact.has(toolName)) return true
  return rules.patterns.some((pattern) => pattern.test(toolName))
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
        `${snapshot.availCommitMb > 0 ? `，可用提交 ${snapshot.availCommitMb} MB` : ''}` +
        reserveNote(snapshot)
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
 * 把预占额度写成一句括号补充，没有预占时返回空串。
 *
 * 拒绝原因里必须交代「为什么 7923 MB 还叫 critical」—— 模型看到原始读数很宽松
 * 却被告知压力大，唯一合理的解释就是这里写着「其中 X MB 留给了轻活」。
 * @param {object} snapshot 含 `reserveMb` 的快照。
 * @returns {string} 括号补充或空串。
 */
function reserveNote(snapshot) {
  const reserve = Math.max(0, Math.floor(snapshot.reserveMb ?? 0))
  if (reserve === 0) return ''
  return `，其中 ${reserve} MB 为轻活预占（原始可用物理 ${snapshot.availPhysMbBeforeReserve} MB）`
}

/**
 * 一份人读的压力摘要，用于工具返回值与日志。
 *
 * 预占打开时**两个数都写**：`900 MB（原始 1924 MB）`。只写扣除后的数，用户会
 * 以为系统真的只剩这么点，然后在任务管理器里对不上账。
 * @param {object} state 护栏状态。
 * @returns {string} 摘要文本。
 */
export function describeState(state) {
  // 门禁看的是扣除预占后的读数，摘要就跟门禁一致；没有那份时退化到原始快照。
  const s = state.heavySnapshot ?? state.snapshot
  const reserve = Math.max(0, Math.floor(s.reserveMb ?? 0))
  const suffix = reserve === 0 ? '' : `（原始 ${s.availPhysMbBeforeReserve} MB，预占 ${reserve} MB 给轻活）`
  const commit = s.availCommitMb > 0 ? `${s.availCommitMb} MB` : '未知'
  return [
    `等级 ${state.grade}（瞬时 ${state.rawGrade}）`,
    `重活可用物理 ${s.availPhysMb} MB / 总量 ${s.totalMb} MB（占用 ${s.loadPercent}%）${suffix}`,
    `可用提交 ${commit}`,
    `已拦 ${state.deniedCalls} 次，降速 ${state.delayedCalls} 次，采样 ${state.samples} 次`,
  ].join('；')
}
