/**
 * 把 `npm pack` 产出的 tgz 传到 GitHub Release，作为市场条目的预构建包。
 *
 * ## 为什么走 Release 而不是等 npm
 *
 * 市场对 npm 的措辞是「推荐（Recommended）」，不是必需。它真正要求的只有三件事：
 * 声明 `dsh.bundle`、仓库满 1 天、有真代码。都满足了就收。
 *
 * 反过来，只给 git 源是有实际代价的：npm 把 `github:owner/repo` 解析成
 * `ssh://git@github.com/...`（本仓用 GIT_TRACE 实测过），没配 GitHub SSH 密钥的人
 * 直接 `Permission denied (publickey)`。所以配上 tarball 不是锦上添花，
 * 是让陌生人真的装得上。
 *
 * 资产名保持不带版本号，用 `releases/download/v<version>/` 钉住 tag ——
 * 这是市场 contributing.md 里点名的两种不腐烂写法之一。
 *
 * 用法：
 *   node scripts/release-tarball.mjs            # 只校验，不创建
 *   node scripts/release-tarball.mjs --create   # 真的创建 release 并上传
 *
 * ## 为什么到处用 exitCode 而不是 process.exit()
 *
 * Windows 上 fetch 的句柄还开着时调 process.exit()，libuv 会在
 * `!(handle->flags & UV_HANDLE_CLOSING)` 上断言崩溃，把真正的结论埋进噪音里。
 * 设置 exitCode 让事件循环自然排空，输出干净。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const OWNER = 'tataCrayon'
const REPO = 'dsh-rampart'
const SHOULD_CREATE = process.argv.includes('--create')

/**
 * 从 git 的 credential helper 取 GitHub token —— 本机 push 能用，说明它在。
 * @returns {string} token 原文。
 */
function githubToken() {
  const out = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('git credential 里没有 password')
  return line.slice('password='.length)
}

/**
 * 薄薄一层 GitHub API。
 * @param {string} path 以 / 开头的路径。
 * @param {object} [init] fetch 的额外选项。
 * @returns {Promise<Response>} 原始响应，由调用方判断状态码。
 */
function makeApi(token) {
  return (path, init = {}) =>
    fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-rampart-release',
        ...init.headers,
      },
    })
}

/** 建 release，成功返回它，失败返回 null 并已打印原因。 */
async function createRelease(api, { tag, pkg, tarballUrl }) {
  const res = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: `${pkg.name} ${tag}`,
      body: [
        '预构建包，供插件市场直接安装（不需要经过 npm registry）：',
        '',
        '```',
        `dsh plugin --profile web add "${tarballUrl}"`,
        '```',
      ].join('\n'),
      draft: false,
      prerelease: false,
    }),
  })
  if (!res.ok) {
    console.error(`创建失败 HTTP ${res.status}：${await res.text()}`)
    return null
  }
  const release = await res.json()
  console.log(`✓ release 建好：${release.html_url}`)
  return release
}

/** 上传资产，成功返回 true。 */
async function uploadAsset(token, release, { assetPath, assetName }) {
  const bytes = readFileSync(assetPath)
  // GitHub 要原始字节 + 明确的 content-type，不能用 JSON。
  const res = await fetch(
    `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/gzip',
        'content-length': String(bytes.length),
        'user-agent': 'dsh-rampart-release',
      },
      body: bytes,
    },
  )
  if (!res.ok) {
    // 资产上传失败时 release 已经存在了，说清楚怎么收尾，别让人以为没建。
    console.error(`上传失败 HTTP ${res.status}：${await res.text()}`)
    console.error(`release 已建好但没资产，手工补：${release.html_url}`)
    return false
  }
  const asset = await res.json()
  console.log(`✓ 资产已上传：${asset.name}  ${asset.size} B  state=${asset.state}`)
  return true
}

async function main() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const tag = `v${pkg.version}`
  const assetPath = new URL(`../${pkg.name}-${pkg.version}.tgz`, import.meta.url)
  const assetName = `${pkg.name}.tgz`
  const tarballUrl = `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${assetName}`

  if (!existsSync(assetPath)) {
    console.error(`找不到 ${pkg.name}-${pkg.version}.tgz，先跑 npm pack。`)
    return 1
  }

  const token = githubToken()
  const api = makeApi(token)

  console.log(`tag        ${tag}`)
  console.log(`asset      ${assetName}  (${readFileSync(assetPath).length} B)`)
  console.log(`tarball    ${tarballUrl}`)

  // 已存在就复用，不重复建 —— 这个脚本会被反复跑。
  const existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${tag}`)
  if (existing.ok) {
    const rel = await existing.json()
    console.log(`\nrelease 已存在：${rel.html_url}（${rel.assets.length} 个资产）`)
    for (const a of rel.assets) console.log(`  - ${a.name}  ${a.size} B  ${a.state}`)
    return 0
  }

  if (!SHOULD_CREATE) {
    console.log('\n（未加 --create，什么都不做）')
    return 0
  }

  console.log('\n创建 release…')
  const release = await createRelease(api, { tag, pkg, tarballUrl })
  if (!release) return 1

  const ok = await uploadAsset(token, release, { assetPath, assetName })
  if (!ok) return 1

  console.log(`\n下一步：把这个 URL 填进市场条目的 tarball 字段 —— ${tarballUrl}`)
  return 0
}

process.exitCode = await main()
