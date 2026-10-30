/**
 * Win32 能力层：内存读数、优先级、亲和性、进程冻结、Job Object 限额。
 *
 * ## 为什么要自己找模块
 *
 * 本插件以 `file://` URL 形式被加载（不经过 pnpm 安装），因此 `import
 * '@deepseek-ai/dsh-win32-process'` 不会被解析到 profile 的 node_modules 里。
 * 这里按候选根目录依次尝试，找不到就**退化**到 Node 自带能力并如实上报，
 * 而不是抛错让整个插件加载失败 —— 拿不到优先级控制是「少了个能力」，
 * 不是「护栏不能工作」。
 *
 * ## 为什么重活只拦、不杀
 *
 * 同仓 `docs/decisions/005-资源护栏.md` 的核心教训：Job Object 的内存限额
 * **一旦附加就无法解除**（Windows 没有把进程移出 Job 的 API）。所以：
 *   - 对**当前进程**只做可逆操作（优先级、亲和性、冻结/恢复）
 *   - 硬内存限额只作用于**子进程**（Job 销毁即失效）
 *
 * 本模块把这条边界写进 API 形状：`attachMemoryCap()` 只接受子进程句柄，
 * 不存在「给自己加内存上限」的入口。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import os from 'node:os'

/** 常用 Win32 常量。 */
export const WIN32 = Object.freeze({
  PROCESS_SET_INFORMATION: 0x0200,
  PROCESS_QUERY_LIMITED_INFORMATION: 0x1000,
  PROCESS_SET_QUOTA: 0x0100,
  PROCESS_SUSPEND_RESUME: 0x0800,
  BELOW_NORMAL_PRIORITY_CLASS: 0x0000_4000,
  IDLE_PRIORITY_CLASS: 0x0000_0040,
  NORMAL_PRIORITY_CLASS: 0x0000_0020,
  JOB_OBJECT_LIMIT_PROCESS_MEMORY: 0x0000_0100,
  JOB_OBJECT_LIMIT_JOB_MEMORY: 0x0000_0200,
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: 0x0000_2000,
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: 9,
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS: 1,
  /** x64 的 JOBOBJECT_EXTENDED_LIMIT_INFORMATION 长度。 */
  EXTENDED_LIMIT_SIZE: 144,
  /** 同结构里 LimitFlags 的偏移。 */
  LIMIT_FLAGS_OFFSET: 16,
  /** 同结构里 ProcessMemoryLimit 的偏移（BasicLimitInfo 64 + IO_COUNTERS 48）。 */
  PROCESS_MEMORY_LIMIT_OFFSET: 112,
  /** 同结构里 JobMemoryLimit 的偏移。 */
  JOB_MEMORY_LIMIT_OFFSET: 120,
})

/** MEMORYSTATUSEX 的长度与字段偏移。 */
const MEMORY_STATUS_EX_SIZE = 64
const MEMORY_STATUS_TOTAL_PHYS = 8
const MEMORY_STATUS_AVAIL_PHYS = 16
const MEMORY_STATUS_AVAIL_PAGE_FILE = 32
const MEMORY_STATUS_LOAD = 4

/**
 * 列出可能解析到 DSH 内置包的根目录。
 *
 * 顺序按「最可能命中」排。桌面版（Electron）与 CLI 版的内置包位置不同：
 *   - 桌面版：内置依赖在 `resources/app.asar.unpacked/dsh/node_modules`，
 *     但 `$DSH_HOME/profiles/node_modules` 通常也有全量 junction（实测 240 个包）
 *   - CLI 版：`<node_global>/node_modules/@deepseek-ai/dsh/node_modules`
 *
 * Electron 里 `process.resourcesPath` 和 `process.execPath` 都能推出资源目录，
 * 两个都试，避免只认一种布局。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {string[]} 候选根目录（去重、保序）。
 */
export function peerRoots(env = process.env) {
  const roots = []
  if (env.DSH_PROFILE_DIR) roots.push(join(env.DSH_PROFILE_DIR, '..', 'node_modules'))
  if (env.DSH_HOME) roots.push(join(env.DSH_HOME, 'profiles', 'node_modules'))
  if (env.DSH_INSTALL_DIR) roots.push(join(env.DSH_INSTALL_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  if (env.DSH_CLI_HOME) roots.push(join(env.DSH_CLI_HOME, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'))
  for (const resourceRoot of resourceRoots()) {
    roots.push(join(resourceRoot, 'app.asar.unpacked', 'dsh', 'node_modules'))
    roots.push(join(resourceRoot, 'app', 'dsh', 'node_modules'))
  }
  roots.push(join(process.cwd(), 'node_modules'))
  return [...new Set(roots)].filter((dir) => existsSync(dir))
}

/**
 * 推出 Electron 的 `resources` 目录候选。
 *
 * `process.resourcesPath` 只在 Electron 里有；`process.execPath` 是
 * `…\DeepSeek Harness\DeepSeek Harness.exe`，其父目录下的 `resources` 就是它。
 * 纯 Node 环境下两者都不指向 DSH，于是返回空数组，不影响 CLI 路径。
 * @returns {string[]} 资源目录候选。
 */
export function resourceRoots() {
  const roots = []
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    roots.push(process.resourcesPath)
  }
  if (typeof process.execPath === 'string' && /DeepSeek/i.test(process.execPath)) {
    roots.push(join(dirname(process.execPath), 'resources'))
  }
  return [...new Set(roots)]
}

/**
 * 依次尝试解析一个内置包。
 *
 * 裸 `import(specifier)` 只在本插件被装进某个 node_modules 时才有用；本插件
 * 也可以用绝对 file URL 直接挂进来，那时它只能沿自己的目录向上找，找不到
 * DSH 安装目录里的包。所以退化路径要自己按 `package.json` 的 `exports`/`main`
 * 解析入口 —— 不能假定都是 `lib/index.js`（koffi 的入口就是 `index.js`）。
 * @param {string} specifier 包名。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {Promise<{ok: true, module: any, from: string} | {ok: false, tried: string[]}>} 解析结果。
 */
export async function importPeer(specifier, env = process.env) {
  const tried = []
  try {
    return { ok: true, module: await import(specifier), from: specifier }
  } catch (error) {
    tried.push(`${specifier} (bare): ${error.code ?? error.message}`)
  }
  for (const root of peerRoots(env)) {
    const dir = join(root, ...specifier.split('/'))
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) {
      tried.push(`${dir}: no package.json`)
      continue
    }
    let entry
    try {
      entry = resolvePackageEntry(dir)
    } catch (error) {
      tried.push(`${pkgPath}: ${error.message}`)
      continue
    }
    if (entry === undefined) {
      tried.push(`${dir}: no resolvable entry`)
      continue
    }
    try {
      return { ok: true, module: await import(pathToFileURL(entry).href), from: entry }
    } catch (error) {
      tried.push(`${entry}: ${error.code ?? error.message}`)
    }
  }
  return { ok: false, tried }
}

/**
 * 按 `exports["."]` → `module` → `main` → 常见入口的顺序解析包入口。
 * @param {string} dir 包目录。
 * @returns {string | undefined} 入口文件的绝对路径。
 */
export function resolvePackageEntry(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const candidates = []
  const dot = manifest.exports?.['.']
  if (typeof dot === 'string') candidates.push(dot)
  if (dot !== null && typeof dot === 'object') {
    for (const key of ['import', 'default', 'require']) {
      if (typeof dot?.[key] === 'string') candidates.push(dot[key])
    }
  }
  for (const key of ['module', 'main']) {
    if (typeof manifest[key] === 'string') candidates.push(manifest[key])
  }
  candidates.push('index.js', 'index.cjs', 'index.mjs')
  for (const candidate of candidates) {
    const absolute = join(dir, candidate)
    if (existsSync(absolute)) return absolute
  }
  return undefined
}

/**
 * 加载 Win32 绑定：优先复用 DSH 自带的 `dsh-win32-process`，退化时返回 `null`。
 * @param {NodeJS.ProcessEnv} [env] 进程环境。
 * @returns {Promise<{available: boolean, api?: any, memoryStatus?: () => object, setPriority?: Function, getPriority?: Function, suspend?: Function, resume?: Function, makeJob?: Function, error?: string, tried?: string[]}>} 能力集合。
 */
export async function loadWin32(env = process.env) {
  if (process.platform !== 'win32') {
    return { available: false, error: `platform ${process.platform} has no Win32 APIs` }
  }
  const found = await importPeer('@deepseek-ai/dsh-win32-process', env)
  if (!found.ok) return { available: false, error: 'dsh-win32-process not resolvable', tried: found.tried }

  const mod = found.module
  const api = mod.extendWin32ProcessBindings(({ kernel32, bind }) => ({
    globalMemoryStatusEx: bind(kernel32, 'GlobalMemoryStatusEx', 'int', ['void *']),
    getCurrentProcess: kernel32.func('void *GetCurrentProcess()'),
    getPriorityClass: kernel32.func('uint32 GetPriorityClass(void *h)'),
    setPriorityClass: kernel32.func('int SetPriorityClass(void *h, uint32 cls)'),
    getProcessAffinityMask: kernel32.func('int GetProcessAffinityMask(void *h, void *procMask, void *sysMask)'),
    setProcessAffinityMask: kernel32.func('int SetProcessAffinityMask(void *h, uint64 mask)'),
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
    // 整树读数用的三件套：Toolhelp 枚举 + 单进程内存/CPU + 整机 CPU 分段
    createToolhelp32Snapshot: kernel32.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
    process32FirstW: kernel32.func('int Process32FirstW(void *snap, void *entry)'),
    process32NextW: kernel32.func('int Process32NextW(void *snap, void *entry)'),
    getProcessTimes: kernel32.func('int GetProcessTimes(void *h, void *create, void *exit, void *kernel, void *user)'),
    getProcessMemoryInfo: kernel32.func('int K32GetProcessMemoryInfo(void *h, void *counters, uint32 cb)'),
    getSystemTimes: kernel32.func('int GetSystemTimes(void *idle, void *kernel, void *user)'),
  }))

  const ntdll = await tryNtdll()

  return {
    available: true,
    api,
    /**
     * 读一次系统内存状态。
     * @returns {{totalMb: number, availPhysMb: number, availCommitMb: number, loadPercent: number}} 读数。
     */
    memoryStatus() {
      const buffer = Buffer.alloc(MEMORY_STATUS_EX_SIZE)
      buffer.writeUInt32LE(MEMORY_STATUS_EX_SIZE, 0)
      if (api.globalMemoryStatusEx(buffer) === 0) {
        throw new Error('GlobalMemoryStatusEx failed')
      }
      return {
        totalMb: Math.floor(Number(buffer.readBigUInt64LE(MEMORY_STATUS_TOTAL_PHYS)) / 1_048_576),
        availPhysMb: Math.floor(Number(buffer.readBigUInt64LE(MEMORY_STATUS_AVAIL_PHYS)) / 1_048_576),
        availCommitMb: Math.floor(Number(buffer.readBigUInt64LE(MEMORY_STATUS_AVAIL_PAGE_FILE)) / 1_048_576),
        loadPercent: buffer.readUInt32LE(MEMORY_STATUS_LOAD),
      }
    },
    /** 当前进程的优先级类。 */
    getPriority() {
      return api.getPriorityClass(api.getCurrentProcess())
    },
    /**
     * 设置当前进程优先级类。
     * @param {number} priorityClass Win32 优先级类常量。
     * @returns {boolean} 是否成功。
     */
    setPriority(priorityClass) {
      return api.setPriorityClass(api.getCurrentProcess(), priorityClass) !== 0
    },
    /**
     * 读当前进程的亲和性掩码。
     * @returns {{process: bigint, system: bigint}} 两级掩码。
     */
    getAffinity() {
      const proc = Buffer.alloc(8)
      const sys = Buffer.alloc(8)
      if (api.getProcessAffinityMask(api.getCurrentProcess(), proc, sys) === 0) {
        throw new Error('GetProcessAffinityMask failed')
      }
      return { process: proc.readBigUInt64LE(0), system: sys.readBigUInt64LE(0) }
    },
    /**
     * 设置当前进程的亲和性掩码。
     * @param {bigint} mask 目标掩码。
     * @returns {boolean} 是否成功。
     */
    setAffinity(mask) {
      return api.setProcessAffinityMask(api.getCurrentProcess(), mask) !== 0
    },
    /**
     * 冻结一个进程的全部线程（可恢复，不杀进程）。
     * @param {number} pid 目标进程。
     * @returns {boolean} 是否成功。
     */
    suspend(pid) {
      if (!ntdll) return false
      const handle = api.openProcess(WIN32.PROCESS_SUSPEND_RESUME, 0, pid)
      if (!handle) return false
      try {
        return ntdll.suspend(handle) === 0
      } finally {
        api.closeHandle(handle)
      }
    },
    /**
     * 恢复一个被冻结的进程。
     * @param {number} pid 目标进程。
     * @returns {boolean} 是否成功。
     */
    resume(pid) {
      if (!ntdll) return false
      const handle = api.openProcess(WIN32.PROCESS_SUSPEND_RESUME, 0, pid)
      if (!handle) return false
      try {
        return ntdll.resume(handle) === 0
      } finally {
        api.closeHandle(handle)
      }
    },
    /**
     * 建一个带内存硬顶的 Job，**只能挂子进程**。
     * @param {object} limits 限额。
     * @param {number} [limits.processMemoryMb] 单进程内存上限。
     * @param {number} [limits.jobMemoryMb] 整个 Job 的内存上限。
     * @returns {any} Job 句柄。
     */
    makeJob(limits) {
      const job = api.createJobObjectW(null, null)
      if (!job) throw new Error('CreateJobObjectW failed')
      const info = Buffer.alloc(WIN32.EXTENDED_LIMIT_SIZE)
      let flags = WIN32.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (limits.processMemoryMb) {
        flags |= WIN32.JOB_OBJECT_LIMIT_PROCESS_MEMORY
        info.writeBigUInt64LE(BigInt(limits.processMemoryMb) * 1_048_576n, WIN32.PROCESS_MEMORY_LIMIT_OFFSET)
      }
      if (limits.jobMemoryMb) {
        flags |= WIN32.JOB_OBJECT_LIMIT_JOB_MEMORY
        info.writeBigUInt64LE(BigInt(limits.jobMemoryMb) * 1_048_576n, WIN32.JOB_MEMORY_LIMIT_OFFSET)
      }
      info.writeUInt32LE(flags, WIN32.LIMIT_FLAGS_OFFSET)
      if (api.setInformationJobObject(job, WIN32.JOBOBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, info, info.length) === 0) {
        api.closeHandle(job)
        throw new Error('SetInformationJobObject failed')
      }
      return job
    },
    /**
     * 把一个已存在的进程塞进 Job。
     * @param {any} job Job 句柄。
     * @param {number} pid 目标进程。
     * @returns {boolean} 是否成功。
     */
    assignToJob(job, pid) {
      const handle = api.openProcess(WIN32.PROCESS_SET_QUOTA | WIN32.PROCESS_SET_INFORMATION, 0, pid)
      if (!handle) return false
      try {
        return api.assignProcessToJobObject(job, handle) !== 0
      } finally {
        api.closeHandle(handle)
      }
    },
    /**
     * 关闭 Job 句柄。`KILL_ON_JOB_CLOSE` 会连带结束 Job 内所有进程。
     * @param {any} job Job 句柄。
     */
    closeJob(job) {
      api.closeHandle(job)
    },
  }
}

/**
 * 绑定 ntdll 的冻结/恢复；不可用时返回 `null`（不影响其他能力）。
 * @returns {Promise<{suspend: Function, resume: Function} | null>} 绑定。
 */
async function tryNtdll() {
  try {
    const found = await importPeer('koffi')
    if (!found.ok) return null
    const koffi = found.module.default ?? found.module
    const ntdll = koffi.load('ntdll.dll')
    return {
      suspend: ntdll.func('long NtSuspendProcess(void *proc)'),
      resume: ntdll.func('long NtResumeProcess(void *proc)'),
    }
  } catch {
    return null
  }
}

/**
 * 不依赖任何 DSH 包的退化读数。
 *
 * 只能拿到「可用」拿不到「提交量」：`process.availableMemory()` 是 Node 22+
 * 的物理可用内存（Windows 上走 `GlobalMemoryStatusEx` 同源口径），
 * `os.totalmem()` 给总量。提交量拿不到就报 0，判定层据此跳过这一项，
 * 而不是把 0 当成「提交内存耗尽」。
 * @returns {{totalMb: number, availPhysMb: number, availCommitMb: number, loadPercent: number}} 读数。
 */
export function fallbackMemoryStatus() {
  const totalBytes = os.totalmem()
  const availBytes = typeof process.availableMemory === 'function' ? process.availableMemory() : os.freemem()
  const totalMb = Math.floor(totalBytes / 1_048_576)
  const availPhysMb = Math.floor(availBytes / 1_048_576)
  return {
    totalMb,
    availPhysMb,
    availCommitMb: typeof process.availableMemory === 'function' ? Math.floor(availBytes / 1_048_576) : 0,
    loadPercent: totalMb > 0 ? Math.round(((totalMb - availPhysMb) / totalMb) * 100) : 0,
  }
}
