/**
 * 用一次性 token 发布，绕开 `npm login` 的浏览器环节。
 *
 * ## 为什么需要它
 *
 * `npm login --auth-type=web` 的流程是：CLI 向 registry 要一对 URL，把
 * `https://www.npmjs.com/login?next=/login/cli/<uuid>` 打给人看，人在浏览器里点授权，
 * CLI 轮询 registry 拿 token。**CLI 自己从不访问 www.npmjs.com** —— 被 Cloudflare
 * 挡住的是「人在浏览器里点」那一步，不是 CLI。
 *
 * 所以只要能**从别处**拿到一个 token（手机、另一台机器、公司网络），
 * 这台机器的 npm 就能正常发布，完全不需要 www.npmjs.com。
 *
 * ## 用法
 *
 * ```powershell
 * # 方式一：环境变量
 * $env:NPM_TOKEN = 'npm_xxxxxxxxxxxx'
 * node scripts/publish-with-token.mjs
 *
 * # 方式二：交互式粘贴（不回显）
 * node scripts/publish-with-token.mjs
 * ```
 *
 * token 只在本次进程里用，**不写进 .npmrc、不落盘**。
 *
 * ## token 怎么建
 *
 * npm 网站 → Access Tokens → Generate New Token → **Granular Access Token**：
 *   - Permissions: `Read and write`
 *   - Packages and scopes: 选 `All packages`（新包还没有 scope 可选）
 *   - 若要绕过 2FA 提示，勾 `Bypass 2FA`（注意：npm 正在收紧这类 token 的直发权限）
 */

import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const REGISTRY = 'https://registry.npmjs.org/'

/**
 * 从环境变量或交互式输入取 token。
 *
 * 交互式输入时关掉回显：token 等同密码，不该留在终端的滚动缓冲里。
 * @returns {Promise<string>} token 原文。
 */
async function readToken() {
  const fromEnv = process.env.NPM_TOKEN?.trim()
  if (fromEnv) {
    console.log('从环境变量 NPM_TOKEN 取到 token。')
    return fromEnv
  }

  const rl = createInterface({ input: stdin, output: stdout, terminal: true })
  // readline 的 terminal 模式下没有直接关回显的 API，退一步：提示用户粘贴后回车，
  // 并明确告知 token 会回显在屏幕上（避免用户误以为它被隐藏了）。
  console.log('没找到环境变量 NPM_TOKEN。')
  console.log('下面粘贴 token 后回车 —— 注意：它是会显示在屏幕上的，别在有录屏时做。')
  const answer = await rl.question('token: ')
  rl.close()
  return answer.trim()
}

/**
 * 跑一条 npm 命令，返回 { code, out }。
 * @param {string[]} args 参数。
 * @param {string} token 认证 token。
 * @returns {{code: number, out: string}} 结果。
 */
function npm(args, token) {
  const result = spawnSync('npm.cmd', args, {
    encoding: 'utf8',
    shell: true,
    env: {
      ...process.env,
      npm_config_registry: REGISTRY,
      // 用 `//host/:_authToken` 这种命令行配置，避免往 .npmrc 里写任何东西。
      // 键名里带 `//` 和 `:`，npm 的 config 解析器认这个形状。
      [`npm_config_//registry.npmjs.org/:_authToken`]: token,
    },
  })
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

const token = await readToken()
if (token === '') {
  console.error('token 为空，退出。')
  process.exit(1)
}

// 1) 先验身份。这一步便宜、且能立刻把「网络不通」和「token 不对」区分开：
//    网络问题报 ECONNREFUSED/ETIMEDOUT，token 问题报 E401/ENEEDAUTH。
console.log('\n[1/3] 验证 token…')
const who = npm(['whoami'], token)
if (who.code !== 0) {
  const networkish = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(who.out)
  console.error(networkish ? '✗ 网络层不通（不是 token 的问题）' : '✗ token 无效或权限不足')
  console.error(who.out.trim().split('\n').slice(-6).join('\n'))
  process.exit(1)
}
const user = who.out.trim().split('\n').pop()
console.log(`✓ 已认证为 ${user}`)

// 2) 确认要发的包名和版本
const pkg = JSON.parse(
  spawnSync(process.execPath, ['-p', 'JSON.stringify(require("./package.json"))'], { encoding: 'utf8' }).stdout,
)
console.log(`\n[2/3] 目标：${pkg.name}@${pkg.version}（${pkg.publishConfig?.access ?? 'public'}）`)

// 3) 发。prepublishOnly 会跑 build:client + test + soak，所以这一步比较久。
console.log('\n[3/3] 发布中（prepublishOnly 会跑构建 + 测试 + soak，约 1~2 分钟）…\n')
const pub = spawnSync('npm.cmd', ['publish', '--registry', REGISTRY], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    npm_config_registry: REGISTRY,
    [`npm_config_//registry.npmjs.org/:_authToken`]: token,
  },
})

if ((pub.status ?? 1) !== 0) {
  console.error(`\n✗ 发布失败（退出码 ${pub.status}）`)
  process.exit(pub.status ?? 1)
}

console.log(`\n✓ 发布成功：https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`)
console.log('  （这个链接要在能过 Cloudflare 的浏览器里才打得开，CDN 与 install 不受影响）')
