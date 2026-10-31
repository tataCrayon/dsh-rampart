/**
 * 端到端验收：用独立 DSH_HOME 真启动一次 headless profile，让插件在真实
 * tool registry 里跑一遍门禁，然后断言落盘的证据。
 *
 * 这不是「配置写对了」的验证。它证明的是：
 *   1. profile patch 里的包名真的能被 loader 解析
 *   2. 插件在真实工具清单（26 个内置工具）下不炸
 *   3. `pwsh` 真的被拒，且**命令的副作用没有发生**（用标记文件断言）
 *
 * ## 两个踩过的坑
 *
 * 1. **阈值必须钉死，不能跟着本机内存走。** 早先这里用「按本机实测调的」阈值
 *    （warn 3200 / critical 2600 MB）。机器空闲时可用物理 7.8 GB，等级就是 normal，
 *    门禁根本不触发 —— 于是这个「护栏能不能拦」的验收会随当天内存余量随机通过或失败。
 *    现在把阈值设成不可能达到的值，让 critical 成为**确定**状态。
 * 2. **fixture 自己修，不靠人手工摆。** junction 与 patch 都在 `.verify/`（不进仓库），
 *    改包名后旧 fixture 会指向一个不存在的名字。这里每次重建，保证可重复。
 *
 * 用法：
 *   node scripts/verify-profile.mjs
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const home = join(root, '.verify', 'dsh-home')
const profileDir = join(home, 'profiles', 'headless')
const patch = join(profileDir, 'cordis.patch.yml')
const link = join(profileDir, 'node_modules', 'dsh-rampart')
const packageName = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name
const denyResult = join(root, '.verify', 'deny-result.json')
const marker = join(root, '.verify', 'deny-marker.txt')

/**
 * 断言，失败即记账。
 * @param {boolean} condition 条件。
 * @param {string} message 说明。
 */
function check(condition, message) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${message}`)
  if (!condition) process.exitCode = 1
}

/**
 * 造一个包名 junction（已存在就跳过）。
 *
 * 不能用 `symlink` 类型：Node 在 Windows 上建目录符号链接要管理员权限，
 * junction 不需要。
 * @param {string} target 目标目录。
 * @param {string} at 链接路径。
 * @returns {boolean} 是否最终可用。
 */
function ensureJunction(target, at) {
  if (existsSync(at)) return true
  mkdirSync(join(at, '..'), { recursive: true })
  spawnSync('cmd', ['/c', 'mklink', '/J', at, target], { stdio: 'ignore' })
  return existsSync(at)
}

/**
 * 造 patch。**阈值钉死**，让 critical 与机器内存余量无关。
 * 注意 probe 那一行用绝对 file URL，它是本机的，不能进仓库。
 * @returns {string} YAML 文本。
 */
function patchText() {
  return `# 验收 profile 的用户层（headless）。自动生成，勿手改。
# 两行：真正的护栏插件（按包名解析），加一行探针（在真 composition 里断言注册结果）。
- insert:
    - id: rampart
      name: '${packageName}'
      config:
        # 故意设成不可能达到的阈值：本机可用物理永远小于 1 PB，
        # 所以等级**确定**是 critical，门禁必然拦。跟着实测内存走会让这条验收随机失败。
        warnFreeMemoryMb: 1000000000
        criticalFreeMemoryMb: 1000000000
        warnCommitMb: 0
        criticalCommitMb: 0
        escalateSamples: 1
        recoverSamples: 1
        sampleIntervalMs: 1000
        limitCores: 0
    - id: rampart-deny-probe
      name: 'file:///${join(root, 'scripts', 'verify-deny-probe.js').replaceAll('\\', '/')}'
`
}

// ── 1) 修 fixture ────────────────────────────────────────────────────────
mkdirSync(profileDir, { recursive: true })
if (!existsSync(join(profileDir, 'package.json'))) {
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-headless',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}
writeFileSync(patch, patchText(), 'utf8')

// 清掉改名前的旧链接，否则 loader 会看到两个同名插件的嫌疑
const stale = join(profileDir, 'node_modules', 'dsh-resource-guard')
if (existsSync(stale)) spawnSync('cmd', ['/c', 'rmdir', stale], { stdio: 'ignore' })

check(ensureJunction(root, link), `插件已以包名挂进 profile node_modules（${packageName}）`)

for (const stale of [denyResult, marker]) if (existsSync(stale)) unlinkSync(stale)

// ── 2) 真跑一次 ──────────────────────────────────────────────────────────
// 不用 `spawnSync(cmd, args, { shell: true })`：那个组合会触发 DEP0190（参数只拼接不转义），
// Node 把警告写 stderr，PowerShell 又会把 stderr 当失败 —— 于是「全 PASS 却退出码 1」。
// 把整条命令行交给 ComSpec、参数数组留空，两个问题一起没有。
const dshCli = process.env.DSH_CLI ?? 'dsh'
const result = spawnSync(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/s', '/c', `"${dshCli}" --profile headless --json probe`],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'headless' },
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    timeout: 180_000,
  },
)

const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`

// 兼容 `dsh` 未安装：给出可操作的说明，而不是一句「探针没写结果」
if (!existsSync(denyResult)) {
  const hint = /not recognized|不是内部或外部命令|ENOENT/.test(combined)
    ? '（`dsh` 命令不可用：检查 PATH，或设 DSH_CLI 指向 dsh.cmd）'
    : ''
  check(false, `探针没有写出 ${denyResult}${hint}\n${combined.slice(-2000)}`)
  process.exit(1)
}

check(!/did not activate/.test(combined), '没有插件条目加载失败')
check(/\[deny-probe\]/.test(combined), '探针在真实 composition 里执行了')

const record = JSON.parse(readFileSync(denyResult, 'utf8'))
const heavy = record.steps?.[0]
const readout = record.steps?.[1]

check(record.ready === true, 'pwsh 与 resource_guard 两个工具都注册出来了')
check(heavy?.name === 'pwsh', '第一步真的调用了 pwsh')
check(heavy?.isError === true, 'pwsh 被拒绝（isError）')
check(heavy?.errorCode === 'RESOURCE_GUARD_DENIED', `错误码为 RESOURCE_GUARD_DENIED（实际 ${heavy?.errorCode}）`)
check(record.markerExists === false, 'pwsh 的副作用没有发生（标记文件不存在）')
check(!existsSync(marker), '磁盘上确实没有标记文件')
check(readout?.name === 'resource_guard' && readout?.isError === false, 'resource_guard 工具可正常读取')

const payload = JSON.parse(readout.text)
check(payload.grade === 'critical', `返回了压力等级（${payload.grade}，钉死阈值后必须是 critical）`)
check(payload.deniedCalls >= 1, `计数被拦次数（${payload.deniedCalls}）`)
check(payload.win32 === true, 'Win32 能力层可用（真读了系统内存）')

console.log(`\n读数：${payload.summary}`)
console.log(process.exitCode ? '\n结果：FAIL' : '\n结果：PASS — 插件在真实 profile 里拦住重活，且副作用未发生')
