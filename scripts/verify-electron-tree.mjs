/**
 * 真机验证：硬顶对**真实 Electron 进程树**到底管不管用。
 *
 * 前面已分别证过：后代自动继承 Job（probe-job-inherit）、并发超额被内核拒绝
 * （verify-tree-accounting）、未授权 breakaway 时逃不出 Job（probe-breakaway）。
 * 这里把它们合起来，对真的 `DeepSeek Harness.exe` 验：
 *   1. 用启动壳的方式（自加入 Job → spawn）起一个隔离 user-data-dir 的第二实例
 *   2. 断言 main / gpu / utility / renderer **全部**在 Job 内
 *   3. 再给一个吃不饱的硬顶，断言内核真的挡（表现为 Job 峰值触顶、进程数下降）
 *
 * ## 为什么要「分离进程」跑
 *
 * 在 DSH 宿主里杀一堆 Electron 进程会把宿主自己的 Job 记账搞乱，sandbox 报
 * `Windows Job runner exited ... before proving its managed range empty`。
 * 所以本脚本以 WMI 拉起子进程跑，每个阶段一个独立进程 + 独立标记目录。
 *
 * ## 三次写错的地方（都让验证「假通过」过）
 *
 * 1. 串行分配撑不爆上限 → 必须并发
 * 2. 孩子比 assign 先出生，不算 Job 成员 → 必须自加入 Job 后再 spawn
 * 3. 用固定标记扫进程会扫到上一阶段的残留 → 每阶段唯一标记 + 杀完要等它真的消失
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const APP = 'D:/AI/DeepSeek Harness/DeepSeek Harness.exe'
const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const SANDBOX = 'D:/Projects/MyProjects/dsh-resource-guard/.verify/electron-tree'
// 匹配标记时要排除宿主的 subprocess runner：踩过 —— 我用 WMI 拉起 `node ... --mark dbg2`，
// 宿主为那条命令起的 `runner.js -- powershell ...` 里也含 "--mark dbg2"，
// 结果 treeOf 把宿主自己的沙箱子进程当成了「测试实例」。
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 执行一条 PowerShell 并取回文本。
 * @param {string} command 命令。
 * @returns {string} 输出。
 */
function ps(command) {
  return execFileSync('powershell', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true })
}

/**
 * 尽力执行一条 PowerShell：失败不抛，用于清理类操作。
 *
 * 踩过：`Invoke-CimMethod Terminate` 对已退出的进程会返回非零退出码，
 * `execFileSync` 直接抛 —— 清理阶段不该因为「目标已经没了」而失败。
 * @param {string} command 命令。
 * @returns {void}
 */
function psSoft(command) {
  try {
    ps(`$ErrorActionPreference = 'SilentlyContinue'; ${command}`)
  } catch {
    /* 清理类操作，失败即忽略 */
  }
}

/**
 * 列出某个标记实例的所有进程。
 * @param {string} mark 唯一标记（出现在 user-data-dir 里）。
 * @returns {Array<{pid: number, type: string, commitMb: number, ppid: number}>} 进程列表。
 */
function treeOf(mark) {
  const out = ps(
    `Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Where-Object { $_.CommandLine -like '*${mark}*' -and $_.CommandLine -notlike '*runner.js*' } | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.PageFileUsage)|$($_.CommandLine)" }`,
  )
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [pid, ppid, commit, cmd = ''] = line.split('|')
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        commitMb: Math.round(Number(commit) / 1024),
        type: /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'main',
      }
    })
}

/**
 * 杀掉某个标记实例的整棵树，并等到进程真的消失。
 * @param {string} mark 唯一标记。
 * @param {number} [timeoutMs] 等待上限。
 * @returns {Promise<number>} 残留进程数。
 */
async function killTree(mark, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const left = treeOf(mark)
    if (left.length === 0) return 0
    psSoft(
      left
        .map(
          (p) =>
            `Invoke-CimMethod -ClassName Win32_Process -MethodName Terminate -Arguments @{ ProcessId = ${p.pid} } -ErrorAction SilentlyContinue | Out-Null`,
        )
        .join('; '),
    )
    await new Promise((r) => setTimeout(r, 800))
  }
  return treeOf(mark).length
}

/**
 * 判断进程是否在 Job 内。
 * @param {any} api 绑定。
 * @param {any} job Job 句柄。
 * @param {number} pid 进程 id。
 * @returns {boolean} 是否在 Job 内。
 */
function inJob(api, job, pid) {
  const handle = api.openProcess(ACCESS, 0, pid)
  if (!handle) return false
  try {
    const out = Buffer.alloc(4)
    return api.isProcessInJob(handle, job, out) ? out.readInt32LE(0) === 1 : false
  } finally {
    api.closeHandle(handle)
  }
}

/**
 * 读 Job 记账。
 * @param {any} api 绑定。
 * @param {any} job Job 句柄。
 * @returns {{activeProcesses: number, limitMb: number, peakJobMb: number}} 记账。
 */
function accounting(api, job) {
  const basic = Buffer.alloc(48)
  api.queryInformationJobObject(job, 1, basic, 48, null)
  const ext = Buffer.alloc(144)
  api.queryInformationJobObject(job, 9, ext, 144, null)
  return {
    activeProcesses: basic.readUInt32LE(40),
    limitMb: Number(ext.readBigUInt64LE(120)) / 1048576,
    peakJobMb: Number(ext.readBigUInt64LE(136)) / 1048576,
  }
}

/**
 * 加载 Win32 绑定。
 * @returns {Promise<any>} 绑定集合。
 */
async function bindings() {
  const mod = await import('file:///' + MOD)
  return mod.extendWin32ProcessBindings(({ kernel32 }) => ({
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
    isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
    queryInformationJobObject: kernel32.func('int QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)'),
    // 整树原子击杀：比逐个 Terminate 可靠（实测 Terminate 会被已退出进程的返回码搞乱）
    terminateJobObject: kernel32.func('int TerminateJobObject(void *job, uint32 code)'),
  }))
}

// ---------- 子模式：单个阶段 ----------

if (process.argv.includes('--child')) {
  const mark = process.argv[process.argv.indexOf('--mark') + 1]
  const capMb = Number(process.argv[process.argv.indexOf('--cap') + 1])
  const outFile = join(SANDBOX, `${mark}.json`)
  const result = { mark, capMb, tree: [], accounting: null, error: null }
  const api = await bindings()
  let job = null

  try {
    const userDataDir = join(SANDBOX, mark)
    mkdirSync(userDataDir, { recursive: true })

    job = api.createJobObjectW(null, null)
    const info = Buffer.alloc(144)
    info.writeUInt32LE(0x0200, 16) // JOB_OBJECT_LIMIT_JOB_MEMORY
    info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120)
    assert.notEqual(api.setInformationJobObject(job, 9, info, info.length), 0, 'SetInformationJobObject')

    // 自己先进 Job，再 spawn：孩子一出生就是成员，没有窗口期
    const self = api.openProcess(ACCESS, 0, process.pid)
    assert.notEqual(api.assignProcessToJobObject(job, self), 0, 'self join')
    api.closeHandle(self)

    const env = { ...process.env }
    // 坑：宿主带着 ELECTRON_RUN_AS_NODE=1，继承下去 Electron 会当 node 跑，
    // 报 `bad option: --user-data-dir=...` 后静默退出。
    delete env.ELECTRON_RUN_AS_NODE
    delete env.DSH_SHELL

    const child = spawn(APP, [`--user-data-dir=${userDataDir}`], { stdio: 'ignore', windowsHide: true, env })

    // 等进程树长起来（上限 cap 太小时长不出来是预期结果，不是错误）
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      const tree = treeOf(mark)
      if (tree.length >= 4) break
      if (!tree.some((p) => p.pid === child.pid) && tree.length === 0 && Date.now() > deadline - 15_000) break
    }

    const tree = treeOf(mark)
    result.tree = tree.map((p) => ({ ...p, inJob: inJob(api, job, p.pid) }))
    result.accounting = accounting(api, job)
  } catch (error) {
    result.error = `${error.name}: ${error.message}`
  } finally {
    mkdirSync(SANDBOX, { recursive: true })
    writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    // 不在子进程里做清理：它自己就是 Job 成员，TerminateJobObject 会连它一起杀，
    // 结果文件写不完（实测）。Job 没设 KILL_ON_JOB_CLOSE，所以子进程退出后
    // Electron 还活着，由父进程按 pid 清。
    process.exit(0)
  }
}

// ---------- 父模式：逐阶段用分离进程跑，再汇总判定 ----------

const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`
const selfPath = new URL(import.meta.url).pathname.replace(/^\//, '').replace(/\//g, '\\')

/**
 * 用 WMI 拉起一个分离阶段并等它落盘。
 * @param {number} capMb 该阶段的硬顶。
 * @returns {Promise<object>} 阶段结果。
 */
async function runPhase(capMb) {
  // 标记必须唯一且只出现在这一阶段：避免扫到别的阶段残留（踩过）
  const mark = `rgtree-${stamp}-${capMb}`
  const outFile = join(SANDBOX, `${mark}.json`)
  rmSync(outFile, { force: true })
  rmSync(join(SANDBOX, mark), { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })

  const command = `cmd.exe /c node "${selfPath}" --child --mark ${mark} --cap ${capMb}`
  ps(
    `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${command.replace(/'/g, "''")}' } | Out-Null`,
  )

  const deadline = Date.now() + 120_000
  let parsed = null
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      parsed = JSON.parse(readFileSync(outFile, 'utf8'))
      break
    } catch {
      /* 还没写完 */
    }
  }
  if (parsed === null) throw new Error(`阶段 cap=${capMb} 超时未出结果`)

  // 清理由父进程做：子进程是 Job 成员，让它自己 TerminateJobObject 会把自己也杀掉，
  // 结果文件就写不完（实测）。
  parsed.leftover = await killTree(mark)
  try {
    rmSync(join(SANDBOX, mark), { recursive: true, force: true })
  } catch {
    /* 目录可能还被握着，不影响判定 */
  }
  return parsed
}

const full = await runPhase(3072)
if (full.error) {
  console.log(`阶段一报错：${full.error}`)
  process.exit(1)
}
console.log('整树成员：', JSON.stringify(full.tree.map((p) => ({ pid: p.pid, type: p.type, inJob: p.inJob })), null, 2))
console.log('Job 记账：', JSON.stringify(full.accounting))

const outside = full.tree.filter((p) => !p.inJob)
assert.equal(outside.length, 0, `这些进程没进 Job：${JSON.stringify(outside)}`)
assert.ok(full.tree.some((p) => p.type === 'renderer'), '应当看到 renderer')
assert.ok(full.tree.some((p) => p.type === 'gpu-process'), '应当看到 gpu-process')
assert.ok(full.tree.some((p) => p.type === 'utility'), '应当看到 utility')
assert.equal(full.leftover, 0, `阶段一收尾后仍有 ${full.leftover} 个残留进程`)

const capped = await runPhase(200)
if (capped.error) {
  console.log(`阶段二报错：${capped.error}`)
  process.exit(1)
}
console.log('硬顶 200 MB 时：', JSON.stringify({ tree: capped.tree.length, accounting: capped.accounting }))
assert.equal(capped.leftover, 0, `阶段二收尾后仍有 ${capped.leftover} 个残留进程`)

// 200 MB 连 main + gpu 都不够：要么树长不全，要么峰值触顶（两者都证明内核在挡）
const cappedHit = capped.accounting.peakJobMb >= 190 || capped.tree.length < full.tree.length
assert.ok(cappedHit, `200 MB 硬顶应当限制住整树：峰值 ${capped.accounting.peakJobMb} MB，进程数 ${capped.tree.length}/${full.tree.length}`)

rmSync(SANDBOX, { recursive: true, force: true })
console.log('RESULT: PASS — 真实 Electron 的 main/renderer/gpu/utility 全在 Job 内；硬顶调小后内核真的挡')
