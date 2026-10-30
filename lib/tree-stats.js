/**
 * 整棵 DSH 进程树的资源读数（内存 + CPU）。
 *
 * ## 为什么不用 PowerShell
 *
 * 第一版打算 `Get-CimInstance Win32_Process` 每 2 秒拉一次，实测**单次 600~900ms**，
 * 而且每次都要起一个 pwsh 子进程 —— 一个「监控 CPU 占用的功能」自己先把 CPU 吃掉。
 * 改成直接调 kernel32：Toolhelp 快照 + `K32GetProcessMemoryInfo` + `GetProcessTimes`，
 * 全树 6 个进程约 3~8ms（本机实测），可以放心每 2 秒采一次。
 *
 * ## 为什么是「整棵树」而不是宿主自己
 *
 * Electron 是多进程的：真正吃内存的是 renderer，真正干重活的是 sandbox 里拉起的
 * pwsh / node。只看宿主进程（`process.pid`）会得到一个常年 200 MB 的假读数。
 *
 * ## CPU 的两个口径
 *
 *   - `cpuPercent`：**整机**占用率（所有核加起来），与任务管理器一致
 *   - `treeCpuPercent`：DSH 这棵树占整机的比例
 *
 * 只给前者会让人以为「CPU 高是 DSH 干的」；只给后者会看不出机器到底忙不忙。
 */

/** Toolhelp 快照常量。 */
const TH32CS_SNAPPROCESS = 0x0002

/** `PROCESSENTRY32W` 结构体大小（字节）。 */
const PROCESS_ENTRY_SIZE = 568

/** `PROCESSENTRY32W.szExeFile` 的偏移与容量。 */
const EXE_NAME_OFFSET = 44
const EXE_NAME_CHARS = 260

/**
 * `PROCESSENTRY32W.cntThreads` 的偏移。
 *
 * 结构体在 x64 上有对齐填充：dwSize(0) cntUsage(4) th32ProcessID(8)
 * th32DefaultHeapID(16, 8 字节) th32ModuleID(24) **cntThreads(28)**
 * th32ParentProcessID(32) pcPriClassBase(36) dwFlags(40) szExeFile(44)。
 * 写成 24 会读到 th32ModuleID（实测恒为 0，看着像「所有进程都没线程」）。
 */
const THREAD_COUNT_OFFSET = 28

/** `PROCESSENTRY32W.th32ParentProcessID` 的偏移。 */
const PARENT_PID_OFFSET = 32

/** `PROCESSENTRY32W.th32ProcessID` 的偏移。 */
const PID_OFFSET = 8

/** `PROCESS_MEMORY_COUNTERS_EX` 结构体大小（字节）。 */
const MEMORY_COUNTERS_EX_SIZE = 112

/** 打开进程所需的最小权限：QUERY_LIMITED_INFORMATION | QUERY_INFORMATION。 */
const ACCESS_QUERY = 0x1000 | 0x0400

/**
 * 读一个 FILETIME（100ns 为单位）为 Number。
 *
 * 直接用 BigInt 会污染后续算术；FILETIME 的实际值远小于 2^53（100ns 计数，
 * 地球年龄也就 ~1.4e21 / 1e7 ≈ 1.4e14），Number 足够精确。
 * @param {Buffer} buffer 结构体。
 * @param {number} offset 偏移。
 * @returns {number} 计数。
 */
function readFiletime(buffer, offset) {
  return Number(buffer.readBigUInt64LE(offset))
}

/**
 * 把 `PROCESSENTRY32W` 里的固定宽字符数组转成字符串。
 * @param {Buffer} entry 结构体。
 * @returns {string} 映像名。
 */
function readExeName(entry) {
  const bytes = entry.subarray(EXE_NAME_OFFSET, EXE_NAME_OFFSET + EXE_NAME_CHARS * 2)
  let end = 0
  while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end += 2
  return bytes.subarray(0, end).toString('utf16le')
}

/**
 * 枚举当前所有进程。
 *
 * Toolhelp 比 `Get-CimInstance` 快两个数量级，代价是拿不到命令行 —— 所以只能按
 * 「进程映像名 + 父子关系」推断进程树。对本用途足够：Electron 的所有子进程都是
 * 同一个 exe。
 * @param {any} api Win32 绑定（含 createToolhelp32Snapshot / process32FirstW / process32NextW）。
 * @returns {Array<{pid: number, ppid: number, name: string, threads: number}>} 进程列表。
 */
export function enumerateProcesses(api) {
  const snapshot = api.createToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
  if (!snapshot) return []
  const entry = Buffer.alloc(PROCESS_ENTRY_SIZE)
  entry.writeUInt32LE(PROCESS_ENTRY_SIZE, 0)
  const processes = []
  try {
    let ok = api.process32FirstW(snapshot, entry)
    while (ok) {
      processes.push({
        pid: entry.readUInt32LE(PID_OFFSET),
        ppid: entry.readUInt32LE(PARENT_PID_OFFSET),
        threads: entry.readUInt32LE(THREAD_COUNT_OFFSET),
        name: readExeName(entry),
      })
      ok = api.process32NextW(snapshot, entry)
    }
  } finally {
    api.closeHandle(snapshot)
  }
  return processes
}

/**
 * 找到当前进程所属那棵「同名进程树」的根。
 *
 * 插件跑在 Electron 的某个子进程里（desktop-host，`--expose-internals` 那个），
 * 沿父链走到最顶上的同名进程就是 Electron 主进程。遇到异名或环就停 ——
 * 前者是父子链断了（父进程已退出），后者是极端情况下的脏数据。
 * @param {Array<{pid: number, ppid: number, name: string}>} processes 全部进程。
 * @param {number} pid 起点进程。
 * @returns {number} 根进程 pid；起点不在表里时返回起点本身。
 */
export function resolveTreeRoot(processes, pid) {
  const byPid = new Map(processes.map((item) => [item.pid, item]))
  const start = byPid.get(pid)
  if (start === undefined) return pid
  const seen = new Set([start.pid])
  let root = start
  for (;;) {
    const parent = byPid.get(root.ppid)
    if (parent === undefined || parent.name !== start.name || seen.has(parent.pid)) break
    seen.add(parent.pid)
    root = parent
  }
  return root.pid
}

/**
 * 收集一棵子树（含根）。
 * @param {Array<{pid: number, ppid: number}>} processes 全部进程。
 * @param {number} rootPid 根进程。
 * @returns {Array<object>} 子树成员。
 */
export function collectSubtree(processes, rootPid) {
  const byParent = new Map()
  for (const item of processes) {
    if (!byParent.has(item.ppid)) byParent.set(item.ppid, [])
    byParent.get(item.ppid).push(item)
  }
  const collected = []
  const visited = new Set()
  const queue = processes.filter((item) => item.pid === rootPid)
  while (queue.length > 0) {
    const node = queue.shift()
    if (visited.has(node.pid)) continue
    visited.add(node.pid)
    collected.push(node)
    queue.push(...(byParent.get(node.pid) ?? []))
  }
  return collected
}

/**
 * 读一个进程的提交内存（PagefileUsage）、工作集与累计 CPU 时间。
 *
 * 用 `PagefileUsage`（= 私有提交）而不是工作集：任务管理器的「内存」列就是它，
 * 而且它不会因为被换页出去而突然掉到 0。
 * @param {any} api Win32 绑定。
 * @param {number} pid 进程 id。
 * @returns {{commitMb: number, workingSetMb: number, cpuMs: number} | null} 读数；打不开时 null。
 */
export function readProcessUsage(api, pid) {
  const handle = api.openProcess(ACCESS_QUERY, 0, pid)
  if (!handle) return null
  try {
    const memory = Buffer.alloc(MEMORY_COUNTERS_EX_SIZE)
    memory.writeUInt32LE(MEMORY_COUNTERS_EX_SIZE, 0)
    const memoryOk = api.getProcessMemoryInfo(handle, memory, MEMORY_COUNTERS_EX_SIZE) !== 0

    const created = Buffer.alloc(8)
    const exited = Buffer.alloc(8)
    const kernel = Buffer.alloc(8)
    const user = Buffer.alloc(8)
    const timesOk = api.getProcessTimes(handle, created, exited, kernel, user) !== 0

    return {
      workingSetMb: memoryOk ? Number(memory.readBigUInt64LE(16)) / 1048576 : 0,
      commitMb: memoryOk ? Number(memory.readBigUInt64LE(72)) / 1048576 : 0,
      cpuMs: timesOk ? (readFiletime(kernel, 0) + readFiletime(user, 0)) / 10_000 : 0,
    }
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 读整机 CPU 累计时间（idle / kernel / user，单位 100ns）。
 * @param {any} api Win32 绑定。
 * @returns {{idleMs: number, kernelMs: number, userMs: number} | null} 读数。
 */
export function readSystemTimes(api) {
  const idle = Buffer.alloc(8)
  const kernel = Buffer.alloc(8)
  const user = Buffer.alloc(8)
  if (api.getSystemTimes(idle, kernel, user) === 0) return null
  return {
    idleMs: readFiletime(idle, 0) / 10_000,
    kernelMs: readFiletime(kernel, 0) / 10_000,
    userMs: readFiletime(user, 0) / 10_000,
  }
}

/**
 * 采一次整棵进程树的资源快照。
 * @param {any} api Win32 绑定。
 * @param {number} pid 起点进程（通常是 `process.pid`）。
 * @param {number} [cores] 逻辑核数，用于把 CPU 时间差换算成百分比。
 * @returns {object} 快照。
 */
export function sampleTree(api, pid, cores = 1) {
  const processes = enumerateProcesses(api)
  const rootPid = resolveTreeRoot(processes, pid)
  const members = collectSubtree(processes, rootPid)

  let commitMb = 0
  let workingSetMb = 0
  let cpuMs = 0
  const details = []
  for (const member of members) {
    const usage = readProcessUsage(api, member.pid)
    if (usage === null) continue
    commitMb += usage.commitMb
    workingSetMb += usage.workingSetMb
    cpuMs += usage.cpuMs
    details.push({ pid: member.pid, name: member.name, threads: member.threads, commitMb: usage.commitMb })
  }

  details.sort((left, right) => right.commitMb - left.commitMb)
  return {
    at: Date.now(),
    rootPid,
    processCount: members.length,
    measuredCount: details.length,
    commitMb,
    workingSetMb,
    cpuMs,
    system: readSystemTimes(api),
    cores,
    top: details.slice(0, 5),
  }
}

/**
 * 由前后两次快照算 CPU 占比。
 *
 * 分母取「整机 CPU 时间差」而不是「本进程时间差」，这样得到的是任务管理器口径的
 * 整机占用率；`treePercent` 再给出「这棵树占了多少」。
 * @param {object} previous 上一次快照。
 * @param {object} current 本次快照。
 * @returns {{cpuPercent: number, treePercent: number, elapsedMs: number}} 占比（0~100，保留一位）。
 */
export function computeCpu(previous, current) {
  const elapsedMs = current.at - previous.at
  if (previous.system === null || current.system === null || elapsedMs <= 0) {
    return { cpuPercent: 0, treePercent: 0, elapsedMs }
  }

  // GetSystemTimes：kernel 时间已包含 idle，所以 busy = kernel + user - idle
  const totalDelta
    = current.system.kernelMs + current.system.userMs - previous.system.kernelMs - previous.system.userMs
  const idleDelta = current.system.idleMs - previous.system.idleMs
  const busyDelta = Math.max(0, totalDelta - idleDelta)
  const treeDelta = Math.max(0, current.cpuMs - previous.cpuMs)

  // 整机 100% = 所有逻辑核跑满，所以分母要乘核数
  const capacity = elapsedMs * Math.max(1, current.cores)
  const round = (value) => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
  return {
    cpuPercent: round((busyDelta / capacity) * 100),
    treePercent: round((treeDelta / capacity) * 100),
    elapsedMs,
  }
}
