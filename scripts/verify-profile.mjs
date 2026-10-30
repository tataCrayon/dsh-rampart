/**
 * 端到端验收：用独立 DSH_HOME 真启动一次 headless profile，让插件在真实
 * tool registry 里跑一遍门禁，然后断言落盘的证据。
 *
 * 这不是「配置写对了」的验证。它证明的是：
 *   1. profile patch 里的包名（或绝对 file URL）真的能被 loader 解析
 *   2. 插件在真实工具清单（26 个内置工具）下不炸
 *   3. `pwsh` 真的被拒，且**命令的副作用没有发生**（用标记文件断言）
 *
 * 用法：
 *   node scripts/verify-profile.mjs
 * 前置：`.verify/dsh-home/profiles/headless` 已初始化，且其 patch 指向本插件 + probe-deny.js。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const home = join(root, '.verify', 'dsh-home')
const profileDir = join(home, 'profiles', 'headless')
const patch = join(profileDir, 'cordis.patch.yml')
const denyResult = join(root, '.verify', 'deny-result.json')
const marker = join(root, '.verify', 'deny-marker.txt')

/**
 * 断言，失败即退出。
 * @param {boolean} condition 条件。
 * @param {string} message 说明。
 */
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`)
  if (!condition) process.exitCode = 1
}

check(existsSync(patch), `profile patch 存在：${patch}`)
check(existsSync(join(profileDir, 'node_modules', 'dsh-resource-guard')), '插件已以包名挂进 profile node_modules')

if (existsSync(denyResult)) rmSync(denyResult)
if (existsSync(marker)) rmSync(marker)

const result = spawnSync(
  process.env.DSH_CLI ?? 'dsh',
  ['--profile', 'headless', '--json', 'probe'],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'headless' },
    encoding: 'utf8',
    // `dsh` 在 Windows 上是 dsh.ps1/.cmd，必须经 shell 才能找到；参数是常量字符串，
    // 不涉及用户输入，因此 shell:true 在这里没有注入面。
    shell: true,
    timeout: 180_000,
  },
)

const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
check(!/did not activate/.test(combined), '没有插件条目加载失败')
check(/\[deny-probe\]/.test(combined), '探针在真实 composition 里执行了')

if (!existsSync(denyResult)) {
  check(false, `探针没有写出 ${denyResult}`)
  process.exit(1)
}

const record = JSON.parse(readFileSync(denyResult, 'utf8'))
const heavy = record.steps?.[0]
const readout = record.steps?.[1]

check(heavy?.name === 'pwsh', '第一步真的调用了 pwsh')
check(heavy?.isError === true, 'pwsh 被拒绝（isError）')
check(heavy?.errorCode === 'RESOURCE_GUARD_DENIED', `错误码为 RESOURCE_GUARD_DENIED（实际 ${heavy?.errorCode}）`)
check(record.markerExists === false, 'pwsh 的副作用没有发生（标记文件不存在）')
check(!existsSync(marker), '磁盘上确实没有标记文件')
check(readout?.name === 'resource_guard' && readout?.isError === false, 'resource_guard 工具可正常读取')

const payload = JSON.parse(readout.text)
check(typeof payload.grade === 'string', `返回了压力等级（${payload.grade}）`)
check(payload.deniedCalls >= 1, `计数被拦次数（${payload.deniedCalls}）`)
check(payload.win32 === true, 'Win32 能力层可用（真读了系统内存）')

console.log(`\n读数：${payload.summary}`)
console.log(process.exitCode ? '\n结果：FAIL' : '\n结果：PASS — 插件在真实 profile 里拦住重活，且副作用未发生')
