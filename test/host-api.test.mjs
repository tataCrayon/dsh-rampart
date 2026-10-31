import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TreeSampler } from '../lib/host-api.js'

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
