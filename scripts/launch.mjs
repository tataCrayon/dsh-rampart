/**
 * 启动壳 CLI：`node scripts/launch.mjs [--app <exe>] [--cap <MB>] [--cap-percent <n>] [--low-priority] [--dry-run] [-- <app args>]`
 *
 * 用 Node 而不是 PowerShell 写，是为了和插件共用同一套 Win32 绑定
 * （`dsh-win32-process` + koffi），避免两个实现各自踩一次 offset 坑。
 */

import os from 'node:os'
import { launchGuarded, planCapMb, resolveHostExecutable } from './launcher.mjs'

/**
 * 解析极简 CLI 参数。
 * @param {string[]} argv 参数列表。
 * @returns {object} 解析结果。
 */
function parse(argv) {
  const options = { lowPriority: false, dryRun: false, args: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      options.args = argv.slice(index + 1)
      break
    } else if (arg === '--app') {
      options.app = argv[++index]
    } else if (arg === '--cap') {
      options.capMb = Number(argv[++index])
    } else if (arg === '--cap-percent') {
      options.capPercent = Number(argv[++index])
    } else if (arg === '--low-priority') {
      options.lowPriority = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

const options = parse(process.argv.slice(2))

if (options.help) {
  console.log(`用法：node scripts/launch.mjs [选项] [-- 应用参数]

  --app <exe>         DeepSeek Harness 可执行文件路径（默认自动查找）
  --cap <MB>          整棵进程树的内存硬顶（默认按总内存 55%，下限 3072）
  --cap-percent <n>   按总内存百分比算硬顶（被 --cap 覆盖）
  --low-priority      同时把主进程降到 BELOW_NORMAL
  --dry-run           只打印将要施加的限额，不启动
`)
  process.exit(0)
}

const totalMb = Math.floor(os.totalmem() / 1_048_576)
const capMb = Number.isFinite(options.capMb)
  ? options.capMb
  : planCapMb({ percent: options.capPercent ?? 55, totalMb })

if (options.dryRun) {
  console.log(`总内存 ${totalMb} MB；将施加整树硬顶 ${capMb} MB（${((capMb / totalMb) * 100).toFixed(0)}%）`)
  console.log(`目标应用：${resolveHostExecutable(options.app)}`)
  process.exit(0)
}

console.log(`[dsh-guarded] 总内存 ${totalMb} MB，整树硬顶 ${capMb} MB，启动中…`)
try {
  const result = await launchGuarded({
    app: options.app,
    capMb,
    lowPriority: options.lowPriority,
    args: options.args,
  })
  console.log(`[dsh-guarded] 退出码 ${result.exitCode}（pid ${result.pid}，硬顶 ${result.capMb} MB）`)
  process.exit(result.exitCode)
} catch (error) {
  console.error(`[dsh-guarded] 启动失败：${error.message}`)
  process.exit(1)
}
