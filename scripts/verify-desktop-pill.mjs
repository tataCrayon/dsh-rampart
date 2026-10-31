/**
 * 验收「底部读数条」这半边在**真 web 服务**上能不能被浏览器加载。
 *
 * ## 为什么不能只靠现有桌面实例
 *
 * `dsh-client-modules` 会把「这个包不是客户端包」这个**否定结论按 Loader specifier
 * 缓存到进程结束**（`pkgMeta` 从不清理）。桌面宿主是在本插件加 `dsh.client` 之前
 * 启动的，所以它内存里存着 `null` —— 只有重启才能看到客户端半边。
 *
 * 重启会杀掉当前会话，所以这里另起一个**隔离的 DSH_HOME + 独立端口**的 web 实例，
 * 从干净状态验证。
 *
 * ## 两个踩过的坑（写在断言里，避免下次重犯）
 *
 * 1. **不能用 `stdio: 'pipe'` 收子进程输出** —— 本沙箱禁止子进程经管道回传（EPERM）。
 *    改成 `cmd /c "... > log 2>&1"`。
 * 2. **不能手拼 `/plugins/??<id>/client.js`** —— 路由只认识**已组合好的批次 URL**
 *    （`responses` / `batchResponses` 里按完整 `pathname+search` 查表）。
 *    正确的做法是从 `/` 的 HTML 里取真实 combo URL，再带着 cookie 去取。
 *
 * ## 断言什么
 *
 *   1. bundle 已构建（`lib/client.js` 在 junction 后可见）
 *   2. 首页 boot 图里**有** `dsh-rampart/client.js`
 *   3. 那条 combo URL 取回来 200，且字节里有我们的类名
 *   4. `/rampart/api/stats` 带 cookie 时 200 且字段齐全（真读数）
 *   5. `/rampart/api/gc` 能回收并给出「只回收 JS 堆」的说明
 *   6. 不带 cookie 时是 403（围栏生效），而不是 404
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const home = join(root, '.verify', 'dsh-home')
const profileDir = join(home, 'profiles', 'web')
const pluginLink = join(profileDir, 'node_modules', 'dsh-rampart')
const logPath = join(root, '.verify', 'pill-verify-web.log')

process.exitCode = 0

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
 * 让 OS 分配一个空闲端口。
 * @returns {Promise<number>} 端口号。
 */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

/**
 * 轮询直到条件成立或超时。
 * @param {() => Promise<boolean>} probe 探测。
 * @param {number} timeoutMs 超时。
 * @returns {Promise<boolean>} 是否成立。
 */
async function until(probe, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await probe()) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

// 1) 准备隔离 profile：一条 patch + 一个指向本仓的 junction
rmSync(profileDir, { recursive: true, force: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify({ name: 'dsh-profile-verify-web', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2)}\n`,
  'utf8',
)
writeFileSync(
  join(profileDir, 'cordis.patch.yml'),
  `# 只为本验收存在：一个隔离的 web profile，挂上护栏插件。\n- insert:\n    - id: rampart\n      name: 'dsh-rampart'\n      config:\n        showStatusPill: true\n        statusPillIntervalMs: 2000\n        sampleIntervalMs: 5000\n`,
  'utf8',
)

const junction = spawn('cmd', ['/c', 'mklink', '/J', pluginLink, root], { stdio: 'ignore' })
await new Promise((r) => junction.on('exit', r))
check(existsSync(join(pluginLink, 'lib', 'client.js')), '`lib/client.js` 已构建且在 junction 后可见')
if (!existsSync(join(pluginLink, 'lib', 'client.js'))) {
  console.log('\n结果：FAIL（先跑 npm run build:client）')
  process.exit(1)
}

const port = await freePort()
rmSync(logPath, { force: true })

// 2) 起服务。stdout/stderr 直接绑到**文件描述符**（不是管道）：
//    本沙箱禁止子进程经管道回传输出（`stdio: 'pipe'` 会 EPERM），
//    而把 `> file 2>&1` 交给 cmd 又会被 Node 的参数转义搅乱，所以 open 一个 fd 最干净。
//
//    另外不要用 `spawn(命令, 参数数组, { shell: true })` —— Node 会对这个组合发
//    DEP0190 警告（参数只拼接不转义），PowerShell 又会把 stderr 当失败，脚本看起来
//    「全 PASS 却退出码 1」。这里把整条命令行交给 ComSpec，参数数组留空。
const dshCli = process.env.DSH_CLI ?? 'dsh'
const logFd = openSync(logPath, 'w')
const child = spawn(
  process.env.ComSpec ?? 'cmd.exe',
  ['/d', '/s', '/c', `"${dshCli}" --profile web --no-open --port ${port}`],
  {
    cwd: root,
    env: { ...process.env, DSH_HOME: home, DSH_PROFILE: 'web' },
    stdio: ['ignore', logFd, logFd],
    windowsVerbatimArguments: true,
  },
)

/**
 * 读日志文件（可能还不存在）。
 * @returns {string} 日志内容。
 */
function readLog() {
  try {
    return readFileSync(logPath, 'utf8')
  } catch {
    return ''
  }
}

try {
  const started = await until(() => Promise.resolve(/\?token=/.test(readLog())), 150_000)
  check(started, 'web 服务已监听（日志里出现了带 token 的地址）')
  if (!started) throw new Error(`服务没起来。日志：\n${readLog().slice(-3000)}`)

  const log = readLog()
  check(!/did not activate/.test(log), '没有插件条目加载失败')
  check(!/declares dsh\.client but exports no/.test(log), '`dsh.client` 声明能被 `exports["./client"]` 满足')

  const base = `http://127.0.0.1:${port}`

  // 3) 换 cookie：GET /?token=… 会 303 到 ./ 并种下会话 cookie
  const tokenUrl = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)[0]
  const handshake = await fetch(tokenUrl, { redirect: 'manual' })
  check(handshake.status === 303, `token 握手返回 303（实际 ${handshake.status}）`)
  const cookies = handshake.headers.getSetCookie()
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
  check(cookies.length > 0, '握手种下了会话 cookie')

  const page = await fetch(`${base}/`, { headers: { cookie } })
  check(page.status === 200, `首页可读（实际 ${page.status}）`)
  const html = await page.text()

  // 4) boot 图里必须有我们 —— 这是「客户端半边被组合进去」的硬证据
  check(html.includes('dsh-rampart/client.js'), 'boot 图里有 dsh-rampart/client.js')

  const combos = [...html.matchAll(/(?:href|src)="(plugins\/\?\?[^"]+)"/g)].map((m) =>
    m[1].replace(/&amp;/g, '&'),
  )
  const ours = combos.filter((url) => url.includes('dsh-rampart/client.js'))
  check(ours.length === 1, `只有一条 combo 含我们的 bundle（实际 ${ours.length} 条）`)

  if (ours.length > 0) {
    const script = await fetch(`${base}/${ours[0]}`, { headers: { cookie } })
    const text = await script.text()
    check(script.status === 200, `combo 脚本可下载（实际 ${script.status}）`)
    check(text.includes('RGpill_pill'), '下载到的字节里有我们的 CSS 类名')
    check(text.includes('conversation.composer.dock'), 'bundle 里注册的是 composer.dock 槽位')
    check(text.includes('"dsh-rampart"'), 'bundle 的模块 id 就是包名')
  }

  // 5) 宿主路由：带 cookie 应当 200 且是真读数
  const statsResponse = await fetch(`${base}/rampart/api/stats`, { headers: { cookie } })
  const statsText = await statsResponse.text()
  check(statsResponse.status === 200, `GET /rampart/api/stats → ${statsResponse.status}（应当 200）`)
  let stats
  try {
    stats = JSON.parse(statsText)
  } catch {
    check(false, `stats 不是合法 JSON：${statsText.slice(0, 200)}`)
  }
  if (stats !== undefined) {
    check(stats.ok === true, 'stats.ok === true')
    check(typeof stats.guard?.grade === 'string', `带压力等级（${stats.guard?.grade}）`)
    check(stats.guard?.win32 === true, 'Win32 能力层可用（真读了系统内存）')
    check(stats.heap?.heapUsedMb > 0, `带本进程堆用量（${stats.heap?.heapUsedMb} MB）`)
    check(stats.tree !== null && stats.tree.processCount >= 1, `整树采样有数据（${stats.tree?.processCount} 个进程）`)
    check(
      typeof stats.tree?.commitMb === 'number' && stats.tree.commitMb > 0,
      `整树提交量有值（${stats.tree?.commitMb} MB）`,
    )
    check(stats.trustDegraded === false, '信任判定走的是 connection 服务（不是回环退化路径）')
  }

  const gcResponse = await fetch(`${base}/rampart/api/gc`, { method: 'POST', headers: { cookie } })
  const gc = await gcResponse.json().catch(() => ({}))
  check(gcResponse.status === 200 && gc.ok === true, `POST /rampart/api/gc 回收成功（freed ${gc.freedMb} MB）`)
  check(typeof gc.note === 'string' && gc.note.includes('JS 堆'), '回收结果说明了「只回收 JS 堆」')

  const unknown = await fetch(`${base}/rampart/api/nope`, { headers: { cookie } })
  check(unknown.status === 404, `未知子路径 404（实际 ${unknown.status}）`)

  // 6) 围栏：不带 cookie 必须 403，而不是 404 —— 404 说明路由根本没挂
  const fenced = await fetch(`${base}/rampart/api/stats`)
  check(fenced.status === 403, `不带 cookie → ${fenced.status}（应当 403，围栏生效而不是路由缺失）`)
} finally {
  spawn('cmd', ['/c', `taskkill /T /F /PID ${child.pid}`], { stdio: 'ignore' })
  await new Promise((r) => setTimeout(r, 2500))
}

console.log(process.exitCode ? '\n结果：FAIL' : '\n结果：PASS — 客户端 bundle 能进 boot 图并下载，宿主路由返回真读数')
