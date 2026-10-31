import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROUTE_PREFIX, TreeSampler, createStatsHandler } from '../lib/host-api.js'

/**
 * 造一个能力集合，并记录被真实枚举了几次。
 *
 * 这里不模拟 Toolhelp 的字节布局（那是 tree-stats.test.mjs 的事），只关心
 * 「采样器有没有重复干同一件事」—— 所以直接数 `createToolhelp32Snapshot`。
 * @returns {{win32: () => Promise<any>, calls: () => number}} 能力集合与计数器。
 */
function countingWin32() {
  let enumerations = 0
  const api = {
    createToolhelp32Snapshot: () => {
      enumerations += 1
      return 1
    },
    process32FirstW: () => 0,
    process32NextW: () => 0,
    closeHandle: () => {},
    openProcess: () => null,
    getProcessTimes: () => 0,
    getProcessMemoryInfo: () => 0,
    getSystemTimes: () => 0,
  }
  return {
    win32: async () => ({ available: true, api }),
    calls: () => enumerations,
  }
}

test('最短间隔内的重复采样直接复用缓存，不再枚举进程', async () => {
  const fake = countingWin32()
  const sampler = new TreeSampler({ win32: fake.win32, cores: 4, minIntervalMs: 10_000 })

  const first = await sampler.sample()
  assert.equal(fake.calls(), 1, '第一次必须真采')
  assert.equal(first.allow, undefined)
  assert.equal(typeof first.commitMb, 'number')

  const second = await sampler.sample()
  assert.equal(fake.calls(), 1, '间隔内不该再枚举')
  assert.equal(second, first, '缓存命中的应当是同一个对象，省一次序列化')
})

test('过了最短间隔就重新采样', async () => {
  const fake = countingWin32()
  const sampler = new TreeSampler({ win32: fake.win32, cores: 4, minIntervalMs: 0 })

  await sampler.sample()
  await sampler.sample()
  await sampler.sample()
  assert.equal(fake.calls(), 3, 'minIntervalMs=0 时每次都要真采')
})

test('并发请求共享同一次采样，不会各自冻结一次事件循环', async () => {
  const fake = countingWin32()
  const sampler = new TreeSampler({ win32: fake.win32, cores: 4, minIntervalMs: 0 })

  // 8 个请求同时到达：真实场景就是用户开了 8 个窗口
  const results = await Promise.all(Array.from({ length: 8 }, () => sampler.sample()))
  assert.equal(fake.calls(), 1, '并发必须合并成一次枚举')
  assert.equal(new Set(results).size, 1, '8 个请求应当拿到同一份读数')
})

test('缓存不会让 CPU 差值的分母失真', async () => {
  const fake = countingWin32()
  const sampler = new TreeSampler({ win32: fake.win32, cores: 4, minIntervalMs: 10_000 })

  const first = await sampler.sample()
  assert.equal(first.cpu.elapsedMs, 0, '第一次没有差值基准')

  const second = await sampler.sample()
  // 复用缓存时 cpu 是采样当时算好的那份，与它自己的 elapsedMs 自洽 ——
  // 不能出现「新的 at 配旧的 cpu」这种错位。
  assert.equal(second.at, first.at)
  assert.deepEqual(second.cpu, first.cpu)
})

test('Win32 不可用时返回 null，且不留下会卡住后续请求的 inflight', async () => {
  const sampler = new TreeSampler({
    win32: async () => ({ available: false, error: 'no win32' }),
    cores: 4,
  })
  assert.equal(await sampler.sample(), null)
  assert.equal(sampler.inflight, null, 'inflight 必须被清掉，否则后续永远等不到')
  assert.equal(await sampler.sample(), null)
})

test('取能力集合时抛错也不留下 inflight', async () => {
  const sampler = new TreeSampler({
    win32: async () => {
      throw new Error('koffi not found')
    },
    cores: 4,
  })
  assert.equal(await sampler.sample(), null)
  assert.equal(sampler.inflight, null)
})

/**
 * 造一个只记录「写了什么状态码」的假响应。
 * @returns {{res: object, read: () => {status: number, body: any}}} 假响应与读数。
 */
function fakeRes() {
  const seen = { status: 0, body: null }
  return {
    res: {
      writeHead: (status) => {
        seen.status = status
      },
      end: (body) => {
        seen.body = JSON.parse(body)
      },
    },
    read: () => seen,
  }
}

/**
 * 造一个最小可用的路由处理器。
 * @param {object} [overrides] 覆盖项。
 * @returns {(req: object, res: object) => Promise<void>} 处理器。
 */
function handler(overrides = {}) {
  return createStatsHandler({
    sampler: { sample: async () => null },
    guard: () => ({ grade: 'normal' }),
    heap: () => ({ heapUsedMb: 1 }),
    collect: () => ({ ok: true }),
    ...overrides,
  })
}

test('/stats 只接受 GET：POST 会被 405 挡住，也不会触发整表枚举', async () => {
  let sampled = 0
  const handle = handler({ sampler: { sample: async () => {
    sampled += 1
    return null
  } } })
  const { res, read } = fakeRes()
  await handle({ method: 'POST', url: `${ROUTE_PREFIX}/stats`, socket: {} }, res)
  assert.equal(read().status, 405)
  assert.equal(sampled, 0, '被挡住的请求不该真的去枚举进程')
})

test('/gc 只接受 POST：GET 会被 405 挡住，也不会真的 GC', async () => {
  let collected = 0
  const handle = handler({ collect: () => {
    collected += 1
    return { ok: true }
  } })
  const { res, read } = fakeRes()
  await handle({ method: 'GET', url: `${ROUTE_PREFIX}/gc`, socket: {} }, res)
  assert.equal(read().status, 405)
  assert.equal(collected, 0, 'GET 不该触发一次全量 GC')
})

test('未知路径统一 404，且不影响合法路径', async () => {
  const { res, read } = fakeRes()
  await handler()({ method: 'GET', url: `${ROUTE_PREFIX}/nope`, socket: {} }, res)
  assert.equal(read().status, 404)

  const ok = fakeRes()
  await handler()({ method: 'GET', url: `${ROUTE_PREFIX}/stats`, socket: {} }, ok.res)
  assert.equal(ok.read().status, 200)
  assert.equal(ok.read().body.ok, true)
})
