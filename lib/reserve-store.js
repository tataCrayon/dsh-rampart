/**
 * 预占额度的用户层持久化。
 *
 * ## 为什么要有这一层
 *
 * `reserveMemoryMb` 写在 profile 的 `cordis.patch.yml` 里，改一次要手改 YAML、
 * 还可能被 HMR 打断一半。而它恰恰是一个「今天机器紧张就调大、明天宽松就调小」的
 * 旋钮 —— 属于**用户层**，不是部署层。
 *
 * DSH 自己的配置就是分层的：schema 默认 → 组合包 → profile patch → 运行时覆盖。
 * 这里照同一套语义补一层：
 *
 *   patch 的 `reserveMemoryMb`  = 基线（随 profile 走，可被团队统一）
 *   本文件的 `reserveMemoryMb`  = 用户覆盖（面板上调出来的，优先级更高）
 *
 * 面板上「重置」= 删掉覆盖，回落到 patch 基线。这样两层都不会互相偷偷改掉对方。
 *
 * ## 为什么是 JSON 而不是写回 YAML
 *
 * 写回 `cordis.patch.yml` 要重排注释、缩进、锚点，还得跟 DSH 自己的 patch 写入
 * 抢同一个文件 —— 一个护栏插件去改宿主的配置文件，出错面太大。独立一个小 JSON
 * 只装一个数字，坏了也只是「回到基线」，不会让 profile 起不来。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 覆盖文件的文件名。 */
export const RESERVE_FILE_NAME = 'rampart.reserve.json'

/**
 * 算出覆盖文件的位置。
 *
 * 优先 profile 目录：覆盖值天然是「这个 profile 的设置」，和 patch 放在一起，
 * 用户想手工看/删也找得到。没有 profile 目录时（file:// 直挂、CLI 单文件场景）
 * 退到 `$DSH_HOME/storages/`；两者都没有就返回 undefined —— 那时只能内存生效，
 * 调用方要把 `persisted: false` 如实报出去。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {string | undefined} 绝对路径，或 undefined 表示无处可写。
 */
export function resolveReserveFile(env = process.env) {
  if (env.DSH_PROFILE_DIR) return join(env.DSH_PROFILE_DIR, RESERVE_FILE_NAME)
  if (env.DSH_HOME) return join(env.DSH_HOME, 'storages', RESERVE_FILE_NAME)
  return undefined
}

/**
 * 读用户覆盖值。
 *
 * 任何异常都当成「没有覆盖」：文件不存在、JSON 写坏了、字段类型不对、负数。
 * 这不是宽容，是**缺省安全** —— 覆盖值只可能让预占变大或变小，读不出来时
 * 回落到 patch 基线是正确的，而抛错会让整个插件加载失败。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {{value: number, path: string} | undefined} 覆盖值与来源路径。
 */
export function loadReserveOverride(env = process.env) {
  const path = resolveReserveFile(env)
  if (path === undefined || !existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const value = parsed?.reserveMemoryMb
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
    return { value: Math.floor(value), path }
  } catch {
    return undefined
  }
}

/**
 * 写用户覆盖值（原子替换）。
 *
 * 先写 `.tmp` 再 `rename`：面板上的调节是连点出来的，写一半断电/被杀会留下
 * 半个 JSON，下次读就是「解析失败 → 回落基线」，用户的设置凭空消失。
 * `rename` 在同一分区是原子的，要么旧值要么新值。
 * @param {number} mb 预占额度（MB）。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {{ok: true, path: string} | {ok: false, error: string}} 结果。
 */
export function saveReserveOverride(mb, env = process.env) {
  const path = resolveReserveFile(env)
  if (path === undefined) return { ok: false, error: 'no-profile-dir' }
  const value = Math.max(0, Math.floor(mb))
  const temp = `${path}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, `${JSON.stringify({ reserveMemoryMb: value, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
    return { ok: true, path }
  } catch (error) {
    // 残留的 .tmp 不会被读，但留着会让人以为「写成功了但没生效」。
    try {
      if (existsSync(temp)) unlinkSync(temp)
    } catch {
      /* 清理失败不影响主流程 */
    }
    return { ok: false, error: /** @type {Error} */ (error).message }
  }
}

/**
 * 删除用户覆盖值，回落到 patch 基线。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {{ok: boolean, error?: string}} 结果；本来就没有覆盖也算成功。
 */
export function clearReserveOverride(env = process.env) {
  const path = resolveReserveFile(env)
  if (path === undefined) return { ok: false, error: 'no-profile-dir' }
  try {
    if (existsSync(path)) unlinkSync(path)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: /** @type {Error} */ (error).message }
  }
}
