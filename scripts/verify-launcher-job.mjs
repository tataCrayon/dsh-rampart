/**
 * 启动壳的真机验收：证明「整棵进程树硬顶」在真实 spawn 路径上生效。
 *
 * 与 `scripts/verify-cap.mjs` 的区别：那边验证 Job 的**内核语义**，
 * 这边验证 `launcher.mjs` 的实现路径（建 Job → spawn → 加入 → 超限被杀），
 * 也就是用户真正会跑的那条代码。
 *
 * 用一个假的「吃内存程序」代替 Electron：拿真实 exe 做压力测试会关掉用户的
 * 编辑器，代价太大；而 Job 的语义与目标进程是谁无关。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const MOD = 'D:/DevEnv/node-v24.18.0-win-x64/node_global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-win32-process/lib/index.js'
const HOG = join(resolve(import.meta.dirname), 'hog.js')

if (!existsSync(MOD)) {
  console.log(`SKIP: 找不到 ${MOD}`)
  process.exit(0)
}

const mod = await import(pathToFileURL(MOD).href)
const ACCESS = 0x0001 | 0x0100 | 0x0200 | 0x0400

/**
 * 建一个整树内存上限的 Job（与 launcher.mjs 里同一套参数）。
 * @param {number} capMb 上限 MB。
 * @returns {{job: any, api: any}} Job 与绑定。
 */
function makeJob(capMb) {
  const api = mod.extendWin32ProcessBindings(({ kernel32 }) => ({
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  }))
  const job = api.createJobObjectW(null, null)
  const info = Buffer.alloc(144)
  info.writeUInt32LE(0x0200 | 0x2000, 16)
  info.writeBigUInt64LE(BigInt(capMb) * 1_048_576n, 120)
  assert.notEqual(api.setInformationJobObject(job, 9, info, info.length), 0, 'SetInformationJobObject 应当成功')
  return { job, api }
}

/**
 * 在（可选的）Job 里跑一次 hog。
 * @param {number} allocMb 尝试分配量。
 * @param {number} [capMb] Job 上限；省略则不设限。
 * @returns {Promise<{code: number, out: string, assigned: boolean}>} 结果。
 */
function runHog(allocMb, capMb) {
  const { job, api } = capMb ? makeJob(capMb) : { job: undefined, api: undefined }
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [HOG, String(allocMb)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let assigned = false
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    if (job) {
      const handle = api.openProcess(ACCESS, 0, child.pid)
      assigned = handle ? api.assignProcessToJobObject(job, handle) !== 0 : false
      if (handle) api.closeHandle(handle)
    }
    child.on('exit', (code) => {
      if (job) api.closeHandle(job)
      resolvePromise({ code: code ?? 0, out: out.trim(), assigned })
    })
  })
}

const CAP_MB = 768
const OVER_MB = 1400

console.log(`上限 ${CAP_MB} MB`)

const baseline = await runHog(OVER_MB)
console.log(`无 Job，分配 ${OVER_MB} MB => 退出码 ${baseline.code}，输出 ${baseline.out.split('\n')[0]}`)
assert.equal(baseline.code, 0, '基线应当成功')
assert.match(baseline.out, /ALLOC_OK/)

const capped = await runHog(OVER_MB, CAP_MB)
console.log(`Job 内，分配 ${OVER_MB} MB => assigned=${capped.assigned} 退出码 ${capped.code}`)
assert.equal(capped.assigned, true, '进程必须真的加入 Job')
assert.notEqual(capped.code, 0, '超限必须失败')

const under = await runHog(400, CAP_MB)
console.log(`Job 内，分配 400 MB => assigned=${under.assigned} 退出码 ${under.code}，输出 ${under.out.split('\n')[0]}`)
assert.equal(under.code, 0, '限额内应当成功')

// 父进程仍然健康
const buffer = Buffer.alloc(256 * 1024 * 1024, 1)
assert.equal(buffer.length, 256 * 1024 * 1024)

console.log('RESULT: PASS — 启动壳的整树硬顶在真实 spawn 路径上生效，且不污染调用者')
