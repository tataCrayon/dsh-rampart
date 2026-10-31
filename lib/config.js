/**
 * 配置校验：自己实现 StandardSchemaV1，不依赖 `@deepseek-ai/schemastery`。
 *
 * ## 为什么不用 schemastery
 *
 * 用官方 `z` 看起来更「原生」（它能把字段渲染成 Web 设置页的表单），但代价是
 * 插件必须在模块加载时就解析到 `@deepseek-ai/schemastery`。而本插件可以用
 * **绝对 file URL** 插进 profile（见 README 的安装方式 A），Node 会从插件所在
 * 目录向上找 `node_modules` —— 那里没有 DSH 的包。
 *
 * 于是只有两条路：给插件目录建一堆 junction（安装/升级 DSH 后就会断），
 * 或者不依赖。这里选后者：cordis 对 `Config` 的要求只有「有 `~standard`.validate」
 * （见 `cordis/lib/index.js` 的 `resolveConfig`），校验本身只有几十行。
 *
 * 代价说清楚：字段不会出现在 Web 设置表单里，只能改 patch 的 `config`。
 * 对本插件是可接受的 —— 它的参数是「阈值」，改一次管很久。
 */

/**
 * 校验一个可选数字字段。
 * @param {unknown} value 待校验值。
 * @param {number} fallback 缺省值。
 * @param {number} min 允许的最小值。
 * @returns {number} 校验后的数字。
 * @throws {TypeError} 类型错误或越界时。
 */
function numberField(value, fallback, min) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`expected a finite number, got ${typeof value}`)
  }
  if (value < min) throw new TypeError(`expected a number >= ${min}, got ${value}`)
  return value
}

/**
 * 校验一个非空字符串数组字段。
 * @param {unknown} value 待校验值。
 * @param {readonly string[]} fallback 缺省值。
 * @returns {string[]} 校验后的数组。
 * @throws {TypeError} 类型错误时。
 */
function stringArrayField(value, fallback) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new TypeError('expected an array of non-empty strings')
  }
  return [...value]
}

/**
 * 校验一个枚举字段。
 * @param {unknown} value 待校验值。
 * @param {string} fallback 缺省值。
 * @param {readonly string[]} allowed 允许值。
 * @returns {string} 校验后的值。
 * @throws {TypeError} 不在允许集合内时。
 */
function oneOfField(value, fallback, allowed) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`expected one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
  return value
}

/** 默认重活名单：这些工具会拉子进程或扇出并发，压力大时最先该停。 */
export const DEFAULT_HEAVY_TOOLS = Object.freeze([
  'pwsh',
  'bash',
  'shell',
  'workflow',
  'subagent',
  'subagent_fork',
  'send_message',
  'web_fetch',
  'web_search',
])

/**
 * 插件配置的 StandardSchemaV1 实现。
 *
 * 默认值按本机实测的 32 GB / 可用 3 GB 场景定，且刻意偏保守：
 * 误拦一条重活只是慢一点，漏拦一次重活是整机卡死。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-rampart',
    /**
     * 校验并补默认值。
     * @param {unknown} input 原始配置。
     * @returns {{value: object} | {issues: Array<{path: string[], message: string}>}} 校验结果。
     */
    validate(input) {
      const raw = input === undefined || input === null ? {} : input
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ path: [], message: 'config must be an object' }] }
      }
      try {
        const source = /** @type {Record<string, unknown>} */ (raw)
        const warnFree = numberField(source.warnFreeMemoryMb, 2048, 1)
        const criticalFree = numberField(source.criticalFreeMemoryMb, 1024, 1)
        if (criticalFree > warnFree) {
          return {
            issues: [{
              path: ['criticalFreeMemoryMb'],
              message: `critical (${criticalFree}) must not exceed warn (${warnFree})`,
            }],
          }
        }
        const warnCommit = numberField(source.warnCommitMb, 3072, 0)
        const criticalCommit = numberField(source.criticalCommitMb, 1536, 0)
        if (warnCommit > 0 && criticalCommit > warnCommit) {
          return {
            issues: [{
              path: ['criticalCommitMb'],
              message: `critical commit (${criticalCommit}) must not exceed warn commit (${warnCommit})`,
            }],
          }
        }
        return {
          value: {
            enabled: source.enabled === undefined ? true : Boolean(source.enabled),
            warnFreeMemoryMb: warnFree,
            criticalFreeMemoryMb: criticalFree,
            warnCommitMb: warnCommit,
            criticalCommitMb: criticalCommit,
            escalateSamples: Math.floor(numberField(source.escalateSamples, 2, 1)),
            recoverSamples: Math.floor(numberField(source.recoverSamples, 3, 1)),
            sampleIntervalMs: Math.floor(numberField(source.sampleIntervalMs, 5000, 0)),
            priority: oneOfField(source.priority, 'on-pressure', ['unchanged', 'on-pressure', 'below-normal']),
            limitCores: Math.floor(numberField(source.limitCores, 0, 0)),
            warnDelayMs: Math.floor(numberField(source.warnDelayMs, 400, 0)),
            criticalDelayMs: Math.floor(numberField(source.criticalDelayMs, 0, 0)),
            denyHeavyOnWarn: source.denyHeavyOnWarn === true,
            denyHeavyOnCritical: source.denyHeavyOnCritical === undefined
              ? true
              : Boolean(source.denyHeavyOnCritical),
            heavyTools: stringArrayField(source.heavyTools, DEFAULT_HEAVY_TOOLS),
            heavyPatterns: stringArrayField(source.heavyPatterns, ['job_*']),
            showStatusPill: source.showStatusPill === undefined ? true : Boolean(source.showStatusPill),
            statusPillIntervalMs: Math.floor(numberField(source.statusPillIntervalMs, 2000, 500)),
          },
        }
      } catch (error) {
        return { issues: [{ path: [], message: /** @type {Error} */ (error).message }] }
      }
    },
  },
}

/**
 * 插件实际生效的默认配置，供测试与文档引用。
 *
 * 直接从 `Config` 校验一份空配置得到，而不是手抄一份常量：手抄的那份一定会漂
 * （少 fields 时测试看不出来，读者却以为那就是全部默认值）。
 */
export const DEFAULTS = Object.freeze({ ...Config['~standard'].validate({}).value })
