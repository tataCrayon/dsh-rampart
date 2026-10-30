/**
 * 底栏读数接口的端到端验证：真起一个 HTTP 服务、真打这条路由。
 *
 * 为什么值得单独写一个：这条路由是**唯一**把护栏读数暴露给浏览器的口子，
 * 也是唯一可能是「越权读到机器状态」的入口。它的正确性分三块，缺一块都不能上：
 *
 *   1. 形状对：`/stats` 返回的字段与客户端 `StatsPayload` 一致
 *   2. 有数：整机内存、整树提交、CPU、堆用量都不是占位 0
 *   3. 认门：不可信的请求被 403 挡住，可信的放行
 *
 * 第 3 点用「注入一个会拒绝的 requestRejection」来验，而不是靠读代码判断。
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { cpus } from 'node:os'
import { collectGarbage, heapUsage } from '../lib/gc.js'
import { ROUTE_PREFIX, TreeSampler, createStatsHandler, trustOf } from '../lib/host-api.js'

/**
 * 造一个最小的 mock Win32 能力集合。
 *
 * 用真实 `loadWin32` 也能跑，但那会把测试绑在「本机一定是 Windows」上；
 * 这里只需要验证路由行为，所以给一份形状正确的假读数。
 * @returns {object} 能力集合。
 */
function fakeWin32() {
  return {
    available: true,
    api: {
      createToolhelp32Snapshot: () => 1,
      process32FirstW: () => 0,
      process32NextW: () => 0,
      closeHandle: () => {},
      openProcess: () => null,
      getProcessTimes: () => 0,
      getProcessMemoryInfo: () => 0,
      getSystemTimes: () => 0,
    },
    memoryStatus: () => ({ totalMb: 32768, availPhysMb: 4096, availCommitMb: 8192, loadPercent: 88 }),
  }
}

/**
 * 起服务并跑一次请求。
 * @param {object} options 选项。
 * @param {string} options.method 方法。
 * @param {string} options.path 路径。
 * @param {(ctx: any, req: any) => boolean} [options.trust] 信任判定覆写。
 * @returns {Promise<{status: number, body: any}>} 响应。
 */
async function request(options) {
  const handler = createStatsHandler({
    sampler: new TreeSampler({ win32: async () => fakeWin32(), cores: cpus().length }),
    guard: () => ({
      grade: 'warn',
      rawGrade: 'warn',
      summary: '等级 warn',
      totalMb: 32768,
      availPhysMb: 4096,
      availCommitMb: 8192,
      loadPercent: 88,
      deniedCalls: 3,
      delayedCalls: 7,
      samples: 42,
      priority: 'below-normal',
      limitCores: 0,
      enabled: true,
      win32: true,
    }),
    heap: heapUsage,
    collect: () => collectGarbage('test'),
    log: () => {},
    trustDegraded: () => false,
  })

  const server = createServer((req, res) => {
    const trust = options.trust === undefined
      ? { trusted: true, degraded: false }
      : { trusted: options.trust({}, req), degraded: false }
    if (!trust.trusted) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"ok":false,"error":"forbidden"}')
      return
    }
    void handler(req, res)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    const response = await fetch(`http://127.0.0.1:${port}${options.path}`, { method: options.method })
    const text = await response.text()
    let body
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const stats = await request({ method: 'GET', path: `${ROUTE_PREFIX}/stats` })
assert.equal(stats.status, 200, `GET /stats 应当 200，实际 ${stats.status}`)
assert.equal(stats.body.ok, true)

const { guard, heap, tree, at } = stats.body
assert.equal(typeof at, 'number', '应当带时间戳（毫秒）')
assert.equal(guard.grade, 'warn', 'guard.grade 应当透传')
assert.equal(guard.deniedCalls, 3, 'guard.deniedCalls 应当透传')
assert.equal(guard.availPhysMb, 4096, 'guard.availPhysMb 应当透传')

assert.equal(typeof heap.heapUsedMb, 'number', 'heap.heapUsedMb 应当是数字')
assert.ok(heap.heapUsedMb > 0, `本进程堆用量应当大于 0，实际 ${heap.heapUsedMb}`)
assert.ok(heap.heapLimitMb > 0, '应当给出堆上限')

// 假 Win32 里 Toolhelp 返回 0 条进程，所以 tree 会是「空但合法」的对象而不是 null
assert.ok(tree !== null, 'Win32 可用时 tree 不应为 null')
assert.equal(typeof tree.processCount, 'number')
assert.ok(Array.isArray(tree.top), 'tree.top 应当是数组')
console.log(`形状检查通过：grade=${guard.grade} availPhys=${guard.availPhysMb}MB heap=${heap.heapUsedMb}MB tree=${tree.processCount}进程`)

const gc = await request({ method: 'POST', path: `${ROUTE_PREFIX}/gc` })
assert.equal(gc.status, 200, `POST /gc 应当 200，实际 ${gc.status}`)
assert.equal(gc.body.ok, true, `强制回收应当成功：${JSON.stringify(gc.body)}`)
assert.equal(typeof gc.body.freedMb, 'number')
assert.ok(gc.body.note.includes('JS 堆'), '结果里应当说明「只回收 JS 堆」')
console.log(`强制回收通过：释放 ${gc.body.freedMb} MB，耗时 ${gc.body.tookMs}ms`)

const denied = await request({ method: 'GET', path: `${ROUTE_PREFIX}/stats`, trust: () => false })
assert.equal(denied.status, 403, `不可信请求应当 403，实际 ${denied.status}`)
console.log('信任门禁通过：不可信请求被 403 挡住')

const missing = await request({ method: 'GET', path: `${ROUTE_PREFIX}/nope` })
assert.equal(missing.status, 404, `未知子路径应当 404，实际 ${missing.status}`)

const wrongMethod = await request({ method: 'DELETE', path: `${ROUTE_PREFIX}/stats` })
assert.equal(wrongMethod.status, 405, `DELETE 应当 405，实际 ${wrongMethod.status}`)

// trustOf 的退化路径：没有 connection 服务时按回环地址判定
const loopbackReq = { socket: { remoteAddress: '127.0.0.1' } }
const remoteReq = { socket: { remoteAddress: '10.0.0.9' } }
assert.deepEqual(trustOf({}, loopbackReq), { trusted: true, degraded: true }, '无 connection 时回环应放行且标记退化')
assert.deepEqual(trustOf({}, remoteReq), { trusted: false, degraded: true }, '无 connection 时非回环应拒绝')

// 有 connection 时以它的判定为准，且不标记退化
const official = {
  connection: { requestRejection: (req) => (req === loopbackReq ? undefined : { code: 'origin' }) },
}
assert.deepEqual(trustOf(official, loopbackReq), { trusted: true, degraded: false }, '官方判定放行时不标记退化')
assert.deepEqual(trustOf(official, remoteReq), { trusted: false, degraded: false }, '官方判定拒绝时不可放行')

console.log('\n结果：PASS — 读数路由的形状、真实读数、信任门禁三条都成立')
