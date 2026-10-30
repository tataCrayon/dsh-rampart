/**
 * `guard-hold` 的公共部分：找宿主可执行文件、列 DSH 进程树。
 *
 * 拆出来的原因：`guard-hold.mjs` 自己会被 Job 约束，不适合再 `import` 一堆
 * 带副作用的模块；`restart-guarded.mjs` 也要用同一套「找进程」逻辑。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 找到 DSH 的 Electron 主程序。
 * @param {string} [explicit] 显式路径。
 * @returns {string} 可执行文件路径。
 * @throws {Error} 找不到时。
 */
export function resolveHostExecutable(explicit) {
  const candidates = [
    explicit,
    process.env.DSH_APP_PATH,
    'D:/AI/DeepSeek Harness/DeepSeek Harness.exe',
    `${process.env.LOCALAPPDATA ?? ''}/Programs/DeepSeek Harness/DeepSeek Harness.exe`,
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `找不到 DeepSeek Harness.exe；请用 --app 指定，或设置 DSH_APP_PATH。试过：${candidates.join(' | ')}`,
  )
}

/**
 * 列出所有目标进程。
 *
 * 用 `ConvertTo-Json` 而不是自拼分隔符：Electron 的 CommandLine 里既有 `|`
 * 也有换行，按分隔符切会把一条记录切碎，还产生 `pid: null` 的幽灵条目（踩过）。
 * @param {string} [name] 进程映像名。
 * @returns {Promise<Array<{pid: number, ppid: number, type: string, commitMb: number, cmd: string}>>} 进程列表。
 */
export async function listTargets(name = 'DeepSeek Harness.exe') {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='${name.replace(/'/g, "''")}'" | ` +
        'Select-Object ProcessId,ParentProcessId,PageFileUsage,CommandLine | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', windowsHide: true },
  )

  const text = out.trim()
  if (text.length === 0) return []
  const parsed = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .filter((row) => Number.isFinite(Number(row.ProcessId)))
    .map((row) => {
      const cmd = row.CommandLine ?? ''
      return {
        pid: Number(row.ProcessId),
        ppid: Number(row.ParentProcessId),
        commitMb: Math.round(Number(row.PageFileUsage ?? 0) / 1024),
        type: /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'main',
        cmd,
      }
    })
}

/**
 * 只保留某个 pid 的后代（含自身）。
 * @param {Array<{pid: number, ppid: number}>} nodes 全部进程。
 * @param {number} rootPid 根进程 id。
 * @returns {Array<object>} 该棵子树。
 */
export function descendantsOf(nodes, rootPid) {
  const byParent = new Map()
  for (const node of nodes) {
    if (!byParent.has(node.ppid)) byParent.set(node.ppid, [])
    byParent.get(node.ppid).push(node)
  }
  const collected = []
  const queue = nodes.filter((node) => node.pid === rootPid)
  const seen = new Set()
  while (queue.length > 0) {
    const node = queue.shift()
    if (seen.has(node.pid)) continue
    seen.add(node.pid)
    collected.push(node)
    queue.push(...(byParent.get(node.pid) ?? []))
  }
  return collected
}
