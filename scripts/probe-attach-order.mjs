// 诊断十二（决定性）：在**真实 DSH 树**上把加入顺序反过来 —— 先加子进程、后加主进程。
//
// 假设：`AssignProcessToJobObject` 报 ERROR_ACCESS_DENIED(5) 的真正原因是
// 「父进程已经在我们的 Job 里，再把它早已存在的孩子加进同一个 Job 会形成环/重复」。
// 若假设成立，先加所有孩子再加祖先应当全部成功 —— 而附加操作必须按「叶子→根」的顺序做。
import { execFileSync } from 'node:child_process'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const mod = await import('file:///' + MOD)
const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
  openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  isProcessInJob: kernel32.func('int IsProcessInJob(void *proc, void *job, void *result)'),
  getLastError: kernel32.func('uint32 GetLastError()'),
}))
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 列出 DSH 进程树（含父子关系）。
 * @returns {Array<{pid: number, ppid: number, type: string}>} 进程列表。
 */
function tree() {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }`],
    { encoding: 'utf8', windowsHide: true },
  )
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, ppid, cmd = ''] = line.split('|')
    return { pid: Number(pid), ppid: Number(ppid), type: /--type=([\w-]+)/.exec(cmd)?.[1] ?? 'main' }
  })
}

/**
 * 按「深度从深到浅」排序，保证先加叶子。
 * @param {Array<object>} nodes 进程列表。
 * @returns {Array<object>} 排序结果。
 */
function leavesFirst(nodes) {
  const byParent = new Map()
  for (const node of nodes) {
    if (!byParent.has(node.ppid)) byParent.set(node.ppid, [])
    byParent.get(node.ppid).push(node)
  }
  const depthOf = (node, seen = new Set()) => {
    if (seen.has(node.pid)) return 0
    seen.add(node.pid)
    const parent = nodes.find((n) => n.pid === node.ppid)
    return parent ? depthOf(parent, seen) + 1 : 0
  }
  return [...nodes].sort((a, b) => depthOf(b) - depthOf(a))
}

/**
 * 尝试把一个进程加入 Job。
 * @param {any} job Job 句柄。
 * @param {number} pid 进程 id。
 * @returns {string} 结果。
 */
function tryJoin(job, pid) {
  const handle = api.openProcess(ACCESS, 0, pid)
  if (!handle) return `open-err${api.getLastError()}`
  try {
    const ok = api.assignProcessToJobObject(job, handle)
    return ok ? 'ok' : `err${api.getLastError()}`
  } finally {
    api.closeHandle(handle)
  }
}

const nodes = tree()
console.log(`DSH 树共 ${nodes.length} 个进程`)
const ordered = leavesFirst(nodes)

const job = api.createJobObjectW(null, null)
const info = Buffer.alloc(144)
info.writeUInt32LE(0x0200, 16)
info.writeBigUInt64LE(4096n * 1048576n, 120)
api.setInformationJobObject(job, 9, info, info.length)

console.log('\n按「叶子 → 根」顺序加入：')
let okCount = 0
for (const node of ordered) {
  const result = tryJoin(job, node.pid)
  if (result === 'ok') okCount += 1
  console.log(`  pid ${String(node.pid).padEnd(7)} ${node.type.padEnd(12)} → ${result}`)
}
console.log(`\n成功 ${okCount}/${ordered.length}`)
api.closeHandle(job)
console.log('句柄已关，限额释放（未对系统留下任何改变）')
