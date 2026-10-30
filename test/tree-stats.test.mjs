import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectSubtree,
  computeCpu,
  enumerateProcesses,
  resolveTreeRoot,
  sampleTree,
} from '../lib/tree-stats.js'

/**
 * 造一个假能力集合，模拟 Toolhelp 的返回序列。
 * @param {Array<{pid: number, ppid: number, name: string, threads?: number}>} processes 进程表。
 * @returns {any} 能力集合。
 */
function fakeApi(processes) {
  let index = -1
  return {
    createToolhelp32Snapshot: () => 1,
    process32FirstW: (_snap, entry) => {
      index = 0
      // 空表时 First 就该返回 0：真实 Toolhelp 对空快照也是这个行为
      return processes.length === 0 ? 0 : writeEntry(entry, processes[index])
    },
    process32NextW: (_snap, entry) => {
      index += 1
      return index < processes.length ? writeEntry(entry, processes[index]) : 0
    },
    closeHandle: () => {},
  }
}

/**
 * 把一条进程记录写进 PROCESSENTRY32W 形状的缓冲。
 * @param {Buffer} entry 缓冲。
 * @param {{pid: number, ppid: number, name: string, threads?: number}} record 记录。
 * @returns {number} 1 表示成功。
 */
function writeEntry(entry, record) {
  entry.writeUInt32LE(568, 0)
  entry.writeUInt32LE(record.pid, 8)
  entry.writeUInt32LE(record.threads ?? 4, 28)
  entry.writeUInt32LE(record.ppid, 32)
  const name = Buffer.from(`${record.name}\0`, 'utf16le')
  name.copy(entry, 44)
  return 1
}

test('enumerateProcesses 读 pid / ppid / 线程数 / 映像名', () => {
  const api = fakeApi([
    { pid: 100, ppid: 4, name: 'main.exe', threads: 12 },
    { pid: 200, ppid: 100, name: 'renderer.exe', threads: 3 },
  ])
  const found = enumerateProcesses(api)
  assert.equal(found.length, 2)
  assert.deepEqual(found[0], { pid: 100, ppid: 4, threads: 12, name: 'main.exe' })
  assert.deepEqual(found[1], { pid: 200, ppid: 100, threads: 3, name: 'renderer.exe' })
})

test('enumerateProcesses 在读线程数时不会误读 th32ModuleID（=0）', () => {
  // 回归测试：偏移写成 24 会读到 th32ModuleID，实测它恒为 0，
  // 于是所有进程看起来都「没有线程」。这里用一个非零值把它钉住。
  const api = fakeApi([{ pid: 1, ppid: 0, name: 'x.exe', threads: 9 }])
  assert.equal(enumerateProcesses(api)[0].threads, 9)
})

test('enumerateProcesses 对空快照返回空数组', () => {
  const api = fakeApi([])
  assert.deepEqual(enumerateProcesses(api), [])
})

test('enumerateProcesses 在 CreateToolhelp32Snapshot 失败时返回空数组', () => {
  assert.deepEqual(enumerateProcesses({ createToolhelp32Snapshot: () => null }), [])
})

test('resolveTreeRoot 沿同名父链走到顶', () => {
  const processes = [
    { pid: 10, ppid: 1, name: 'app.exe' },
    { pid: 20, ppid: 10, name: 'app.exe' },
    { pid: 30, ppid: 20, name: 'app.exe' },
    { pid: 1, ppid: 0, name: 'explorer.exe' },
  ]
  assert.equal(resolveTreeRoot(processes, 30), 10)
})

test('resolveTreeRoot 遇到异名父进程就停（父子链在宿主外部断开）', () => {
  const processes = [
    { pid: 10, ppid: 1, name: 'app.exe' },
    { pid: 20, ppid: 10, name: 'app.exe' },
    { pid: 1, ppid: 0, name: 'explorer.exe' },
  ]
  // 起点是 20，父 10 同名 → 继续；10 的父是 explorer.exe（异名）→ 停在 10
  assert.equal(resolveTreeRoot(processes, 20), 10)
})

test('resolveTreeRoot 在起点不在表里时原样返回', () => {
  assert.equal(resolveTreeRoot([], 999), 999)
})

test('resolveTreeRoot 不会因自环而死循环', () => {
  const processes = [
    { pid: 5, ppid: 5, name: 'loop.exe' },
    { pid: 6, ppid: 5, name: 'loop.exe' },
  ]
  assert.equal(resolveTreeRoot(processes, 6), 5)
})

test('collectSubtree 收全后代且不重复', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'root.exe' },
    { pid: 2, ppid: 1, name: 'root.exe' },
    { pid: 3, ppid: 1, name: 'root.exe' },
    { pid: 4, ppid: 2, name: 'root.exe' },
  ]
  const members = collectSubtree(processes, 1).map((item) => item.pid).sort()
  assert.deepEqual(members, [1, 2, 3, 4])
})

test('collectSubtree 只返回根的那棵子树', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'a.exe' },
    { pid: 2, ppid: 1, name: 'a.exe' },
    { pid: 9, ppid: 0, name: 'b.exe' },
  ]
  assert.deepEqual(collectSubtree(processes, 1).map((item) => item.pid).sort(), [1, 2])
})

test('computeCpu 按整机能力算百分比，而不是按单核', () => {
  // 2 秒、8 核 → 能力 16000 毫秒；busy 1600 毫秒 → 10%
  const previous = { at: 0, cpuMs: 0, system: { idleMs: 0, kernelMs: 0, userMs: 0 }, cores: 8 }
  const current = {
    at: 2000,
    cpuMs: 800,
    system: { idleMs: 14400, kernelMs: 8000, userMs: 8000 },
    cores: 8,
  }
  const cpu = computeCpu(previous, current)
  assert.equal(cpu.cpuPercent, 10, `整机应 10%，实际 ${cpu.cpuPercent}`)
  assert.equal(cpu.treePercent, 5, `本树应 5%，实际 ${cpu.treePercent}`)
  assert.equal(cpu.elapsedMs, 2000)
})

test('computeCpu 在缺系统读数时给 0 而不是 NaN', () => {
  const cpu = computeCpu({ at: 0, cpuMs: 0, system: null, cores: 4 }, { at: 1000, cpuMs: 5, system: null, cores: 4 })
  assert.deepEqual(cpu, { cpuPercent: 0, treePercent: 0, elapsedMs: 1000 })
})

test('computeCpu 对时间倒流（at 变早）给 0', () => {
  const cpu = computeCpu(
    { at: 2000, cpuMs: 0, system: { idleMs: 0, kernelMs: 0, userMs: 0 }, cores: 4 },
    { at: 1000, cpuMs: 0, system: { idleMs: 0, kernelMs: 0, userMs: 0 }, cores: 4 },
  )
  assert.equal(cpu.cpuPercent, 0)
})

test('computeCpu 结果被夹在 0~100 之间（计数器回绕不会给出负值或 300%）', () => {
  const cpu = computeCpu(
    { at: 0, cpuMs: 0, system: { idleMs: 0, kernelMs: 0, userMs: 0 }, cores: 1 },
    { at: 100, cpuMs: 100_000, system: { idleMs: 0, kernelMs: 100, userMs: 100 }, cores: 1 },
  )
  assert.ok(cpu.cpuPercent >= 0 && cpu.cpuPercent <= 100, `cpuPercent 越界：${cpu.cpuPercent}`)
  assert.ok(cpu.treePercent >= 0 && cpu.treePercent <= 100, `treePercent 越界：${cpu.treePercent}`)
})

test('sampleTree 把整棵树的提交量加起来，并按大小排序 top', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'root.exe', threads: 4 },
    { pid: 2, ppid: 1, name: 'root.exe', threads: 4 },
    { pid: 3, ppid: 1, name: 'root.exe', threads: 4 },
  ]
  const usage = new Map([
    [1, { commitMb: 10, workingSetMb: 20, cpuMs: 100 }],
    [2, { commitMb: 300, workingSetMb: 400, cpuMs: 200 }],
    [3, { commitMb: 50, workingSetMb: 60, cpuMs: 300 }],
  ])
  const api = {
    ...fakeApi(processes),
    openProcess: (_access, _inherit, pid) => (usage.has(pid) ? pid : null),
    getProcessMemoryInfo: (handle, buffer) => {
      const record = usage.get(handle)
      buffer.writeUInt32LE(112, 0)
      buffer.writeBigUInt64LE(BigInt(Math.round(record.workingSetMb * 1_048_576)), 16)
      buffer.writeBigUInt64LE(BigInt(Math.round(record.commitMb * 1_048_576)), 72)
      return 1
    },
    getProcessTimes: (handle, _c, _e, kernel, user) => {
      const record = usage.get(handle)
      kernel.writeBigUInt64LE(BigInt(record.cpuMs * 10_000), 0)
      user.writeBigUInt64LE(0n, 0)
      return 1
    },
    getSystemTimes: (idle, kernel, user) => {
      idle.writeBigUInt64LE(0n, 0)
      kernel.writeBigUInt64LE(0n, 0)
      user.writeBigUInt64LE(0n, 0)
      return 1
    },
  }
  const tree = sampleTree(api, 1, 8)
  assert.equal(tree.rootPid, 1)
  assert.equal(tree.processCount, 3)
  assert.equal(tree.measuredCount, 3)
  assert.equal(Math.round(tree.commitMb), 360)
  assert.equal(Math.round(tree.cpuMs), 600)
  assert.equal(tree.top[0].pid, 2, '提交量最大的进程应排第一')
  assert.equal(Math.round(tree.top[0].commitMb), 300)
})

test('sampleTree 跳过打不开的进程，不把整次采样搞崩', () => {
  const processes = [
    { pid: 1, ppid: 0, name: 'root.exe', threads: 4 },
    { pid: 2, ppid: 1, name: 'root.exe', threads: 4 },
  ]
  const api = {
    ...fakeApi(processes),
    openProcess: (_access, _inherit, pid) => (pid === 1 ? pid : null),
    getProcessMemoryInfo: (handle, buffer) => {
      assert.equal(handle, 1)
      buffer.writeBigUInt64LE(0n, 16)
      buffer.writeBigUInt64LE(20n * 1_048_576n, 72)
      return 1
    },
    getProcessTimes: (_h, _c, _e, kernel, user) => {
      kernel.writeBigUInt64LE(0n, 0)
      user.writeBigUInt64LE(0n, 0)
      return 1
    },
    getSystemTimes: (idle, kernel, user) => {
      idle.writeBigUInt64LE(0n, 0)
      kernel.writeBigUInt64LE(0n, 0)
      user.writeBigUInt64LE(0n, 0)
      return 1
    },
  }
  const tree = sampleTree(api, 1, 4)
  assert.equal(tree.processCount, 2, '进程数仍应包含打不开的那个')
  assert.equal(tree.measuredCount, 1, '只有能量到的那个计入读数')
  assert.equal(Math.round(tree.commitMb), 20)
})
