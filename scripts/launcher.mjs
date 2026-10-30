/**
 * 启动壳（Host 侧）：在**进程创建时**给整棵 DSH 进程树套一个 Job Object 内存硬顶。
 *
 * ## 为什么必须是「启动壳」而不是插件
 *
 * Job Object 的限额一旦附加就**无法解除**（Windows 没有把进程移出 Job 的 API，
 * 见 `docs/decisions/005-资源护栏.md` 的实测）。所以：
 *   - 给已经跑起来的 Electron 自己加限额 = 把它永久锁死在某个上限里，插件绝不能做
 *   - 在**创建时**给一个新进程树加限额 = 进程树退出、Job 句柄关闭，限额随之消失，安全
 *
 * ## 为什么限的是「JobMemoryLimit」而不是「ProcessMemoryLimit」
 *
 * Electron 是多进程的：main / renderer / gpu / utility 各占一块。给每个进程单独设上限
 * 会让某个 renderer 先撞墙（表现为白屏或崩溃），而整机仍然被吃穿。
 * JobMemoryLimit 限的是**整棵树的总提交量**，更贴近「这台机器还剩多少」这个问题。
 *
 * ## 它怎么和插件配合
 *
 * 启动壳管「绝对不许越过」的硬顶，插件管「越接近越慢、重活先停」的软降级。
 * 硬顶撞上时 Electron 会先 OOM 崩溃（数据可能丢），所以软层必须先动作——
 * 这也是插件默认阈值（warn 2 GB / critical 1 GB）比硬顶低一档的原因。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

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
  throw new Error(`找不到 DeepSeek Harness.exe；请用 --app 指定，或设置 DSH_APP_PATH。试过：${candidates.join(' | ')}`)
}

/**
 * 按「可用内存的百分比」算一个不会误杀的硬顶。
 *
 * 刻意留出余量：硬顶不是目标值，是最后一道墙。低于 1.5 GB 的话 Electron 光启动
 * 就会撞墙（实测 renderer + gpu 起步就要 600 MB 上下），所以有下限保护。
 * @param {object} [options] 计算参数。
 * @param {number} [options.percent] 占总内存的百分比，默认 55。
 * @param {number} [options.floorMb] 下限，默认 3072。
 * @param {number} [options.totalMb] 覆盖总内存读数（测试用）。
 * @returns {number} 硬顶 MB。
 */
export function planCapMb(options = {}) {
  const percent = options.percent ?? 55
  const floorMb = options.floorMb ?? 3072
  const totalMb = options.totalMb ?? Math.floor(os.totalmem() / 1_048_576)
  return Math.max(floorMb, Math.round((totalMb * percent) / 100))
}

/**
 * 加载 Win32 绑定（与插件同一套：优先复用 DSH 自带包）。
 * @returns {Promise<any>} 绑定集合。
 */
async function loadBindings() {
  const candidates = [
    'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js',
  ]
  if (process.env.DSH_CLI_HOME) {
    candidates.unshift(`${process.env.DSH_CLI_HOME}/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js`)
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const mod = await import(pathToFileURL(candidate).href)
    return mod
  }
  throw new Error('找不到 dsh-win32-process；启动壳需要它来建 Job Object。')
}

/**
 * 加入 Job 所需的进程访问权限。
 *
 * 少 `PROCESS_TERMINATE` 会得到 `ERROR_ACCESS_DENIED(5)`（实测，见 scripts/probe-self-join-error.mjs），
 * 而那个错误码完全指错方向：看起来像「没权限」，实际是权限位不完整。
 */
const PROCESS_ACCESS_FOR_JOB = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 建一个带整树内存上限的 Job。
 * @param {any} mod dsh-win32-process 模块。
 * @param {number} capMb 总内存上限。
 * @returns {{job: any, api: any}} Job 句柄与绑定。
 */
function createJob(mod, capMb) {
  const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
    setPriorityClass: kernel32.func('int SetPriorityClass(void *h, uint32 cls)'),
    isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
  }))
  const job = api.createJobObjectW(null, null)
  if (!job) throw new Error('CreateJobObjectW failed')

  const info = Buffer.alloc(144)
  // 只设「整树内存上限」+「关句柄即杀」。不设 ProcessMemoryLimit：那是单进程上限，
  // 会让某个 renderer 先死而整机仍被吃穿。
  info.writeUInt32LE(0x0200 | 0x2000, 16)
  info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120) // JobMemoryLimit @120
  if (api.setInformationJobObject(job, 9, info, info.length) === 0) {
    api.closeHandle(job)
    throw new Error('SetInformationJobObject failed')
  }
  return { job, api }
}

/**
 * 构造子进程环境：去掉会让 Electron 变成「纯 Node」的那几个变量。
 *
 * 踩过的坑：本机 DSH 宿主里带着 `ELECTRON_RUN_AS_NODE=1`（harness 用它跑 node 脚本），
 * 如果直接继承，`DeepSeek Harness.exe --user-data-dir=...` 会被当成 node 启动，
 * 报 `bad option: --user-data-dir=...` 然后静默退出——看起来像「Electron 起不来」。
 * @returns {NodeJS.ProcessEnv} 清理后的环境。
 */
function childEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.DSH_SHELL
  return env
}

/**
 * 把启动壳自己放进 Job —— 这样随后 spawn 的 Electron 一出生就是 Job 成员。
 *
 * 为什么不能「先 spawn 再 assign」：那中间有个窗口期，Electron 的 renderer / gpu
 * 往往在 assign 之前就生出来了，这些孩子**不算** Job 成员，硬顶直接漏掉。
 * 实测（scripts/probe-job-tree.mjs）：外部 spawn 的进程 `IsProcessInJob` 为 false。
 *
 * Windows 8+ 支持嵌套 Job，所以即使启动壳本身已在别的 Job 里（例如被沙箱包着），
 * 这一句仍然成立。
 * @param {any} api 绑定集合。
 * @param {any} job Job 句柄。
 * @returns {boolean} 是否成功加入。
 */
function joinSelf(api, job) {
  const handle = api.openProcess(PROCESS_ACCESS_FOR_JOB, 0, process.pid)
  if (!handle) return false
  try {
    return api.assignProcessToJobObject(job, handle) !== 0
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 启动并施加硬顶。
 * @param {object} options 启动参数。
 * @param {string} [options.app] 应用路径。
 * @param {number} capMb 内存硬顶 MB。
 * @param {boolean} [options.lowPriority] 是否降到 BELOW_NORMAL。
 * @param {string[]} [options.args] 传给应用的参数。
 * @returns {Promise<{pid: number, capMb: number, exitCode: number, inherited: boolean}>} 退出结果。
 */
export async function launchGuarded(options) {
  const app = resolveHostExecutable(options.app)
  const capMb = options.capMb ?? planCapMb()
  const mod = await loadBindings()
  const { job, api } = createJob(mod, capMb)

  // 自己先降优先级：子进程会继承优先级类，省掉一次「起来后才降」的窗口。
  if (options.lowPriority) {
    try {
      const self = api.openProcess(0x0200, 0, process.pid)
      if (self) {
        api.setPriorityClass(self, 0x0000_4000)
        api.closeHandle(self)
      }
    } catch {
      /* 低优先级是锦上添花 */
    }
  }

  const joined = joinSelf(api, job)

  // 启动壳已在 Job 内 → 孩子一出生就继承，无窗口期；否则退化为起完再 assign。
  const child = spawn(app, options.args ?? [], {
    stdio: options.stdio ?? 'inherit',
    detached: false,
    windowsHide: false,
    env: childEnv(),
  })

  const inherited = joined
    ? true
    : (() => {
        const handle = api.openProcess(PROCESS_ACCESS_FOR_JOB, 0, child.pid)
        if (!handle) return false
        try {
          return api.assignProcessToJobObject(job, handle) !== 0
        } finally {
          api.closeHandle(handle)
        }
      })()

  if (!inherited) {
    process.stderr.write(`[dsh-guarded] 警告：pid ${child.pid} 未进入 Job，硬顶未生效\n`)
  } else {
    process.stderr.write(`[dsh-guarded] 硬顶 ${capMb} MB 已施加（pid ${child.pid}）\n`)
  }

  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0))
  })
  // KILL_ON_JOB_CLOSE：这里关掉句柄会顺带清掉可能残留的子进程。
  api.closeHandle(job)
  return { pid: child.pid, capMb, exitCode, inherited }
}
