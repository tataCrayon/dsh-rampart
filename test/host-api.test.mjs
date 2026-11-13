import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MAX_RESERVE_MB, ROUTE_PREFIX, TreeSampler, createStatsHandler } from '../lib/host-api.js'

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

// ── /reserve：面板上调预占额度 ───────────────────────────────────────────

/**
 * 造一个只带请求体的假 IncomingMessage。
 *
 * 路由用 `req.on('data'|'end'|'error')` 读 body，所以这里只要一个能同步吐出
 * 片段的事件机就够了 —— 不需要真 socket，也就没有端口和清理问题。
 * @param {string} text 请求体文本。
 * @returns {object} 假请求。
 */
function bodyReq(text) {
  const listeners = new Map()
  const req = {
    method: 'POST',
    url: `${ROUTE_PREFIX}/reserve`,
    socket: {},
    on(event, fn) {
      listeners.set(event, fn)
      return req
    },
    destroy() {},
  }
  // 下一拍再发：路由是先挂监听、再 await 的，同步发会丢事件。
  queueMicrotask(() => {
    if (text.length > 0) listeners.get('data')?.(Buffer.from(text, 'utf8'))
    listeners.get('end')?.()
  })
  return req
}

/**
 * 造一个记账用的 setReserve / resetReserve。
 * @param {number} [baseline] 重置回落的基线。
 * @returns {object} 依赖与记账。
 */
function reserveSpies(baseline = 1024, ceiling = Number.POSITIVE_INFINITY) {
  const calls = []
  return {
    calls,
    setReserve: (mb) => {
      calls.push(mb)
      return mb
    },
    resetReserve: () => {
      calls.push(`reset:${baseline}`)
      return baseline
    },
    reserveCeiling: () => ceiling,
  }
}

test('POST /reserve 改额度：传数字就生效，并回显实际值与上限', async () => {
  const spies = reserveSpies()
  const { res, read } = fakeRes()
  await handler(spies)(bodyReq(JSON.stringify({ reserveMemoryMb: 2048 })), res)
  assert.equal(read().status, 200)
  assert.equal(read().body.reserveMb, 2048)
  assert.equal(read().body.requestedMb, 2048)
  assert.deepEqual(spies.calls, [2048])
})

test('POST /reserve 报出「当前空闲」这个上限，面板据此画出滑杆范围', async () => {
  // 空闲只有 1700 MB 时，面板不该允许拖到 4 GB —— 那多出来的是空气。
  const spies = reserveSpies(1024, 1700)
  const { res, read } = fakeRes()
  await handler(spies)(bodyReq(JSON.stringify({ reserveMemoryMb: 900 })), res)
  assert.equal(read().body.ceilingMb, 1700)
})

test('POST /reserve 的取值本身不被上限夹，只有固定天花板兜底', async () => {
  // 线高过 critical 是正当用法（临时把停重活的水位抬到 3 GB），不该被「空闲 − critical」
  // 这类推导拦下。这条守着 0.3.1 之前差点写错的那个上限。
  const spies = reserveSpies(1024, 4096)
  const { res, read } = fakeRes()
  await handler(spies)(bodyReq(JSON.stringify({ reserveMemoryMb: 3000 })), res)
  assert.equal(read().body.reserveMb, 3000, '3000 < 天花板，应原样生效')
  assert.equal(read().body.ceilingMb, 4096, '上限只由当前空闲与固定天花板决定')
})

test('POST /reserve 超过上限被夹住，不把重活线永久抬到天上', async () => {
  // 手滑把 1024 打成 102400 时，线会高过任何空闲，护栏拦下一切重活，
  // 看起来像「插件坏了」。夹到固定天花板比接受这个值更接近用户本意。
  const spies = reserveSpies()
  const { res, read } = fakeRes()
  await handler(spies)(bodyReq(JSON.stringify({ reserveMemoryMb: 102400 })), res)
  assert.equal(read().body.reserveMb, MAX_RESERVE_MB)
  assert.deepEqual(spies.calls, [MAX_RESERVE_MB])
})

test('POST /reserve 拒绝非法值：负数 / 字符串 / 缺字段都不落到护栏上', async () => {
  for (const payload of ['{"reserveMemoryMb": -1}', '{"reserveMemoryMb": "1024"}', '{}']) {
    const spies = reserveSpies()
    const { res, read } = fakeRes()
    await handler(spies)(bodyReq(payload), res)
    assert.equal(read().status, 400, `应当拒绝 ${payload}`)
    assert.deepEqual(spies.calls, [], '非法输入不能改到护栏')
  }
})

test('POST /reserve 拒绝坏 JSON 与超大 body', async () => {
  const spies = reserveSpies()
  const bad = fakeRes()
  await handler(spies)(bodyReq('not json'), bad.res)
  assert.equal(bad.read().status, 500)
  assert.deepEqual(spies.calls, [])

  const huge = fakeRes()
  await handler(spies)(bodyReq(`{"reserveMemoryMb":${'1'.repeat(9000)}}`), huge.res)
  assert.equal(huge.read().status, 500, '超限 body 必须被拒，而不是先攒进内存')
  assert.deepEqual(huge.calls ?? [], [])
})

test('DELETE /reserve 重置：回落到基线，且删除用户覆盖', async () => {
  const spies = reserveSpies(1536)
  const { res, read } = fakeRes()
  await handler(spies)(
    { method: 'DELETE', url: `${ROUTE_PREFIX}/reserve`, socket: {}, on() {}, destroy() {} },
    res,
  )
  assert.equal(read().status, 200)
  assert.equal(read().body.reserveMb, 1536)
  assert.equal(read().body.reset, true)
  assert.deepEqual(spies.calls, ['reset:1536'])
})

test('GET /reserve 被 405 挡住（跨站 <img> 不能改额度）', async () => {
  const spies = reserveSpies()
  const { res, read } = fakeRes()
  await handler(spies)({ method: 'GET', url: `${ROUTE_PREFIX}/reserve`, socket: {} }, res)
  assert.equal(read().status, 405)
  assert.deepEqual(spies.calls, [])
})

test('没有 setReserve 能力时 /reserve 回 501，而不是假装成功', async () => {
  const { res, read } = fakeRes()
  await handler({ setReserve: undefined })(
    { method: 'POST', url: `${ROUTE_PREFIX}/reserve`, socket: {}, on() {}, destroy() {} },
    res,
  )
  assert.equal(read().status, 501)
})
