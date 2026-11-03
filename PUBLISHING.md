# 发布到插件市场：完整流程与现状

> 这一份是**发布操作手册**，不是设计文档。设计理由看 `README.md`。
> 目标市场有两个，且是**两件独立的事**：
>
> | 市场 | 入口 | 需要什么 |
> |---|---|---|
> | **DSH 官方 Discover**（`Plugins → Discover → Index sources`） | 一段 format-1 JSON 索引 | 索引源里能被读到；条目按 `npm` 或 `git` 安装 |
> | **社区目录**（dsh-market / awesome-dsh-plugin） | `awesome-dsh-plugin.com/plugins.json` | 一个 PR：`data/plugins/<owner>__<repo>.yml` |
>
> 两者的共同前提是同一个：**仓库里有真代码、`package.json` 里声明了 `dsh.bundle`、
> 并且能被 `dsh plugin add` 装上**。这个前提本仓库已经满足。

---

## 0. 命名：为什么叫 dsh-rampart

原名 `dsh-resource-guard` **在 npm 上已被占用**（`meliodascz89`，2026-09 起发到 0.1.7，
是另一个作者做的「本地模型内存信号量」插件）。同名仓库也已在 GitHub 上存在。

`rampart` = 城墙的**外围防御墙**。插件干的事正是这个：在机器被压垮之前先筑一道墙 ——
采样压力、到线就拦重活、真缺内存时把宿主降到 below-normal。名字短、念得出、npm 与 GitHub 都空着。

| | 值 |
|---|---|
| npm 包名 | `dsh-rampart` |
| GitHub 仓库 | `https://github.com/tataCrayon/dsh-rampart` |
| 插件 id（patch 里那一行） | `rampart` |
| 模块 id（`export const name`） | `rampart` |
| 读数路由 | `/rampart/api/{stats,gc}` |
| 模型可见的工具 | `resource_guard`（**故意没改名**，见下） |

**为什么工具名保留 `resource_guard`**：它是**对外契约**。已经在用的会话、README、
以及被拦时回给模型的提示词都按这个名字写。改名会让老会话里的工具调用变成未知工具，
而这个收益只有「看着整齐」—— 不值得。包名/路由/id 是新的，工具名是兼容的。

---

## 1. 已经做完了什么（2026-10-31）

- [x] 包名、仓库地址、`author`、`license`、`homepage`、`bugs`、`publishConfig` 补齐
- [x] `engines.dsh: ">=0.2.1-rc.1"` —— 市场靠它算兼容性；**故意不写 `os: ["win32"]`**
      （写了会让非 Windows 机器连装都装不上，而这个插件在非 Windows 上是「退化为纯观测」，
      不是不能装）
- [x] `dsh.bundle.patch` + `cordis.patch.yml` + `dsh.client` 三件套齐
- [x] `LICENSE`（MIT）、`assets/icon-180.png`（市场卡片图标）、`assets/icon-1024.png`（宣传图）
- [x] GitHub 仓库 `tataCrayon/dsh-rampart` 已建，`dsh-plugin` 等 topic 已打
- [x] **代码已推到 master**，`c89453d2eaa38ed116dd7d5b3c1184bfa3d380c3`
- [x] 93 条单测全绿（`npm test`）；`npm run verify` 四条全 PASS、
      `verify:pill` 与 `verify:profile` 全 PASS
- [x] `npm publish --dry-run` 通过：20 个文件、72.5 kB 包、192.9 kB 解包（不含 `.scratch/`）

**还差两步**：发到 npm、提市场条目。下面逐步给命令。

---

## 2. 推到 GitHub（已完成）

```powershell
cd D:\Projects\MyProjects\dsh-resource-guard
git add -A
git commit -m "..."
git push -u origin master
```

远端 `origin` 已设为 `https://github.com/tataCrayon/dsh-rampart.git`。
凭据在 Windows Credential Manager 里（`tataCrayon`，scope 含 `repo`），
全局配了 `http.https://github.com.proxy=http://127.0.0.1:7897`，push 会走代理。

> **`gh` CLI 没装成也不用装。** 建仓库这件事直接用已存的 git 凭据打
> `POST /user/repos` 就够了（本次就是这么建的）：
>
> ```powershell
> $t = ("protocol=https`nhost=github.com`n`n" | git credential fill |
>       Select-String '^password=').Line -replace '^password=',''
> Invoke-RestMethod -Uri https://api.github.com/user/repos -Method Post `
>   -Headers @{ Authorization = "token $t"; 'user-agent' = 'dsh-rampart' } `
>   -Body (@{ name='dsh-rampart'; description='...'; private=$false } | ConvertTo-Json)
> ```
>
> 打 topic 用 `PUT /repos/{owner}/{repo}/topics`，body `{ "names": [...] }`。

---

## 3. 发到 npm

**当前状态：`dsh-rampart` 名字可用（`registry.npmjs.org` 返回 404），但本机没登录**（`npm whoami` → `ENEEDAUTH`）。

```powershell
cd D:\Projects\MyProjects\dsh-resource-guard
npm login                       # 浏览器授权
npm publish                     # prepublishOnly 会自动 build:client + test
npm view dsh-rampart version    # 确认
```

### 3.1 如果 `npm login` 的浏览器那一步打不开（本机 2026-10-31 实测）

先分清**卡在哪一段**，三处端点是独立的，混在一起就会误判成「npm 全被墙了」：

| 端点 | 用途 | 本机实测 |
|---|---|---|
| `registry.npmjs.org` | 一切读写（含 publish、CLI 全部请求） | **200，240~850 ms** |
| `www.npmjs.com` | 只有「人在浏览器里点授权」这一步 | **403，`cf-mitigated: challenge`** |
| `registry.npmjs.org/-/user/org.couchdb.user:*` | legacy 登录 | **401 + `WWW-Authenticate: OTP`**（活着） |

判定方法（不用登录，30 秒出结果）：

```powershell
npm ping                                    # 200/PONG → registry 通
npm publish --dry-run=false --//registry.npmjs.org/:_authToken=fake
# 报 E404/E401（服务端返回）→ 网络通，只差真 token
# 报 ECONNREFUSED/ETIMEDOUT  → 才是网络问题
```

**关键事实**：`npm login --auth-type=web` 的 CLI **自己从不访问 `www.npmjs.com`**。
它向 registry 要一对 URL，把 `https://www.npmjs.com/login?next=/login/cli/<uuid>` 打给人看，
然后**轮询 registry 上的 `doneUrl`** 拿 token（源码：`npm-profile/lib/index.js:39-95`）。
被 Cloudflare managed challenge 挡住的是**浏览器那一步**，不是 CLI。

所以有两条互不依赖的路：

**路 A：在别处建一个 token（本机全程不需要 `www.npmjs.com`）**

token 可以在手机、另一台机器、或任何能过 Cloudflare 的浏览器里建
（npm 网站 → Access Tokens → Generate → **Granular**，`Read and write` + `All packages`），
然后：

```powershell
$env:NPM_TOKEN = 'npm_xxxxxxxxxxxx'
node scripts/publish-with-token.mjs
```

这个脚本不写 `.npmrc`、不落盘，token 只在本次进程里用；它先 `whoami` 验身份，
好把「网络不通」和「token 不对」分开报（已用假 token 验证会正确报 `token 无效`）。

**路 B：换一个能过挑战的网络去点那一下**

`www.npmjs.com` 的 403 是 Cloudflare 的人机校验，datacenter/共享出口 IP 很容易被挑中
（本机走直连与走 7897 代理都 403，落点先是 LAX 后是 HKG）。换手机热点、换家宽、
或换一个住宅 IP 出口的节点，通常就过了。真实浏览器窗口里一般能自动通过。

**不要做的三件事**：

- ❌ **把 registry 换成 `registry.npmmirror.com`**：它是只读镜像，`PUT` 返回 **422**，发不出去。
- ❌ **发到 GitHub Packages**：用户 `npm i dsh-rampart` 装不到，得额外配 scope + registry + 凭证。
- ❌ **改依赖里的 GitHub 地址**：本项目 `dependencies` 是**空的**，只有一个 peer
  `@deepseek-ai/cordis`，全仓没有任何 `git@` / `github:` 形态的依赖。
  `url."https://github.com/".insteadOf git@github.com:` 这类配置对本仓**零影响** ——
  这里根本没有 GitHub 依赖可切换，它解决的是另一类问题（`npm install` 拉 git 依赖超时）。

**首次发布之后**就可以不再碰 token：在 npm 网站给包配 **Trusted Publishing**（GitHub OIDC），
之后 `.github/workflows/` 里的 `npm publish` 走 OIDC 免密钥。
但它要求**包已经存在**才能配，所以首发这一步绕不开 token。

发布前自检（**必须全绿**，`npm publish` 也会跑一遍）：

```powershell
npm run build:client
npm test
npm pack --dry-run              # 看一眼真的会打包哪些文件
```

本次实测的 `npm pack --dry-run`：**20 个文件、72.5 kB 包 / 192.9 kB 解包**。

`package.json` 的 `files` 已收敛：只带 `lib/`、`client/source.js`、`cordis.patch.yml`、
启动壳的三个文件、`assets/icon-180.png`、`README.md`、`LICENSE`。
`deploy-desktop.md` / `PUBLISHING.md` 是本机现场记录，**不发布**（含本机路径）。

> 不发 npm 也能用，而且是**市场接受**的做法：把 `npm pack` 的产物传到 GitHub Release，
> 条目里用 `tarball:` 指向它即可（`tarball` 是条目的一等字段，市场站点会优先展示
> 它而不是 git 命令）。`npm pack` 不需要登录 —— 实测在未登录状态下也能产出完整包。
>
> 反过来，**只给 git 源对陌生人不友好**：npm 把 `github:owner/repo` 解析成
> `ssh://git@github.com/owner/repo.git`（本仓用 `GIT_TRACE=1` 实测），没配 GitHub SSH
> 密钥的人直接 `Permission denied (publickey)`。所以 tarball 不是锦上添花，是必需。

---

## 4. 提市场条目（社区目录）

只需要**一个文件**，不要手改 README（那两个 README 是脚本生成的）：

`awesome-dsh-plugin` 仓库 → `data/plugins/tataCrayon__dsh-rampart.yml`：

```yaml
url: https://github.com/tataCrayon/dsh-rampart
name: tataCrayon/dsh-rampart
category: dev
tarball: https://github.com/tataCrayon/dsh-rampart/releases/download/v0.2.0/dsh-rampart.tgz
description:
  en: 'Grades free physical and commit memory and refuses heavy tools (shell, workflow, subagent) before the machine thrashes. Also shows in the composer how much of the machine dsh itself is using, including whole-machine CPU.'
  zh: '按可用物理内存与提交内存分级，到线就拦重活（shell、workflow、subagent）。并在输入框旁显示 DSH 自己占用了整机多少资源，含整机 CPU 占比。'
icon: https://raw.githubusercontent.com/tataCrayon/dsh-rampart/master/assets/icon-180.png
```

要点：
- 描述里含 `: ` 必须加引号（否则 YAML 解析成嵌套键）—— 上面已经包了。
- `category` 取**实际做的事**：`dev`（开发与运行时）。不是 `ui`（UI 只是它的一半）。
- 分支是 **`master`**，不是 `main`。两个 `icon` URL 都踩过：写 `main` 会 404
  （API 实测 `contents/assets/icon-180.png?ref=main` → 404，`?ref=master` → 1407 字节）。
- `tarball` 的资产名**不要带版本号**，靠 `/releases/download/v0.2.0/` 这个路径钉版本。
  带版本号又挂在 `/releases/latest/` 下的写法，下次发版就 404 —— 市场脚本
  `probe-tarballs.mjs` 会专门把这种标成「会在下次发版时烂掉」。
- 仓库需**创建满 1 天**（已于 2026-11-01 15:32 北京时间满足）、有真代码、带 `dsh-plugin` topic。
- **描述必须与代码逐字对得上，审核真的会数。** 这里踩过一次：初稿写的是
  「Grades whole-machine memory **and CPU** pressure」，但 `gradeOf()` 只读四个
  阈值 —— `warnFreeMemoryMb` / `criticalFreeMemoryMb` / `warnCommitMb` /
  `criticalCommitMb`，`config.js` 里**没有任何 CPU 阈值**。CPU 全仓只用于显示。
  按初稿提交就是夸大，会被打回。改成「分级看内存、CPU 只显示」才对得上。

---

## 5. 加进自己的 Discover（不用等市场收录）

**Plugins → Discover → Index sources** 里加一条自己维护的索引即可。最小可用的
format-1 索引（放 GitHub Pages / jsDelivr / 任意 https 静态托管）：

```json
{
  "format": 1,
  "title": { "en": "tataCrayon plugins", "zh": "个人插件源" },
  "plugins": [
    {
      "name": "dsh-rampart",
      "title": { "en": "Rampart", "zh": "资源护栏" },
      "description": {
        "en": "Memory pressure guard: grades free physical and commit memory, refuses heavy tools, and shows how much of the machine dsh uses.",
        "zh": "内存压力护栏：按可用物理/提交内存分级、拦重活，并显示 dsh 占用了整机多少。"
      },
      "icon": "https://raw.githubusercontent.com/tataCrayon/dsh-rampart/master/assets/icon-180.png",
      "author": "tataCrayon",
      "homepage": "https://github.com/tataCrayon/dsh-rampart",
      "repository": { "url": "https://github.com/tataCrayon/dsh-rampart" },
      "versions": [
        {
          "version": "0.2.0",
          "publishTimestamp": 1793491200,
          "source": {
            "type": "git",
            "url": "https://github.com/tataCrayon/dsh-rampart",
            "commit": "cf75370d73e03df81460b05237c381d4c8a5fa65"
          },
          "engines": { "dsh": ">=0.2.1-rc.1" }
        }
      ]
    }
  ]
}
```

`publishTimestamp` 是**Unix 秒**（不是毫秒）。`source.type: "git"` 也可以，
但要给 40 位小写 commit SHA 和 `url`（`.git` 结尾、https、无查询串）。

---

## 5.1 改名后本机活体验证（2026-10-31）

改包名相当于换 Loader specifier，所以这次**不吃** `dsh-client-modules` 那条
「这个包不是客户端包」的否定缓存 —— 保存 patch 后宿主半边立刻重组了：

```
GET /rampart/api/stats        -> 403   # 路由已挂，被 connection 围栏挡（正确）
GET /resource-guard/api/stats -> 404   # 旧前缀已经不存在
```

403 而不是 404 是关键区别：404 说明路由根本没挂，403 说明**路由在、只是没带会话 cookie**
（和 `npm run verify:pill` 里那条「不带 cookie → 403」同一个道理）。

桌面 profile 已同步：旧 junction 删除、新 junction 建好、patch 里 `id: rampart` /
`name: 'dsh-rampart'`。

---

## 6. 本机当前是「本地链接」安装，不是市场安装

现在的 desktop profile 用的是 junction：

```
…\profiles\desktop\node_modules\dsh-rampart → D:\Projects\MyProjects\dsh-resource-guard
```

**改名已一次性完成**（2026-10-31）：旧 junction `dsh-resource-guard` 已删，
新 junction 已建，patch 里的 `id` / `name` 已改成 `rampart` / `dsh-rampart`。
`deploy-desktop.md` 里记的是旧名字，那是当时的现场记录，保留不改。

装成市场版之后就把 junction 删掉，改由 `dsh plugin add dsh-rampart` 管理，
这样 Plugin Manager 能升级/卸载它。

**然后再也不用动这里。** 下面这些是当时执行的命令，留作参考：

```powershell
$profile = "D:\Users\zigang.wang\.dsh\profiles\desktop"
cmd /c rmdir "$profile\node_modules\dsh-resource-guard"
cmd /c mklink /J "$profile\node_modules\dsh-rampart" "D:\Projects\MyProjects\dsh-resource-guard"
# 再把 cordis.patch.yml 末尾那条 insert 的 id / name 改成 rampart / dsh-rampart
```

⚠️ **别用 `Set-Content` / `Out-File` 改那个 patch。** 它含中文注释，PowerShell 的
默认编码会把 UTF-8 写成 GBK，`js-yaml` 一读就报 `duplicated mapping key`，
整个 profile 直接起不来（本次踩了，从 `.bak` 恢复的）。要用 Node 的
`readFileSync(p,'utf8')` → `writeFileSync(p,t,'utf8')`。

---

## 7. 常见被拒原因（对照自查）

| 被拒原因 | 本仓库状态 |
|---|---|
| 只声明 `dsh.client`，没有 `dsh.bundle` | ✅ 两个都有 |
| 没有 `cordis.patch.yml` | ✅ 有，且与包名一致 |
| 占位仓库 / 纯 README | ✅ 有实现、有 93 条测试、有真机验收脚本 |
| 仓库创建不满 1 天 | ✅ 2026-10-31 07:32:50Z 建，已满 1.97 天 |
| 描述夸大 | ✅ 描述里的三件事都能在代码里指出来 |
| 缺 `dsh-plugin` topic | ✅ 已打 |

---

## 8. 用 GitHub Actions 发布（绕开本机 VPN 与 Cloudflare）

### 为什么不能在本机发

本机要访问 npm 必须经过 VPN，而 VPN 出口是共享 IP，实测两条路都断：

```
registry.npmjs.org 直连            → 超时（ETIMEDOUT）
www.npmjs.com/login 经代理          → 403 + Cf-Mitigated: challenge
registry.npmjs.org 经代理           → 时通时不通（SSL handshake failed / HTTP 000）
```

而 `npm login --auth-type=legacy` 这条路**已经被 npm 服务端关了**：

```
npm notice Account creation via legacy auth is unavailable. Please set your
         auth-type to "web" or visit https://www.npmjs.com/signup
npm error code E403
```

所以发布搬到 GitHub Actions。runner 在微软云上，出口 IP 干净，不经过本机网络、不需要代理、也不需要浏览器的授权环节。

### 文件

`.github/workflows/publish.yml`，两个触发条件，**push 到 master 不会自动发**：

| 触发 | 行为 |
|---|---|
| push tag `v*` | 真发布（tag 必须等于 `package.json` 的 version，否则 Preflight 拒绝） |
| 手动 `workflow_dispatch` | 默认 `dry_run: true`，只打包不真发 |

### 为什么必须 `windows-latest`

不是随便选的。`lib/win32.js` 的 `loadWin32()` 在非 Windows 平台直接返回
`{ available: false }`，于是 `scripts/soak.mjs` 里「树采样持续可用」那条断言
（要求 `processCount >= 1`）在 ubuntu runner 上必然失败。
换成 Linux 不是省钱，是测不到真东西。

### 唯一需要你手做的一步：加 secret

自动化能覆盖到「拿到 token 之后」的全部，但**造 token 这一步做不到** ——
它必须在 `www.npmjs.com` 上完成，而那正是被 Cloudflare 挡住的地方。

所以需要你在**任意一台能打开 npm 网站的机器**（手机开 VPN 也行）上：

1. 登录 npm
2. 头像 → **Access Tokens** → **Generate New Token** → **Classic Token**
3. 类型选 **Automation**（专给 CI 用，不会弹 2FA）
4. 复制那串 `npm_…`（只显示一次）

然后回到仓库网页：

**Settings → Secrets and variables → Actions → New repository secret**

- Name: `NPM_TOKEN`
- Secret: 粘贴

或者用 `gh` 一条命令：

```powershell
gh secret set NPM_TOKEN --repo tataCrayon/dsh-rampart
```

### 发布步骤

```powershell
# 1) 先手动跑一次 dry run，确认七步全绿（不会真发）
gh workflow run publish.yml --repo tataCrayon/dsh-rampart -f dry_run=true

# 2) 看日志
gh run list --workflow=publish.yml --repo tataCrayon/dsh-rampart --limit 3

# 3) 真发
gh workflow run publish.yml --repo tataCrayon/dsh-rampart -f dry_run=false
```

### 为什么带 `--provenance`

`permissions.id-token: write` + `npm publish --provenance` 会让 npm 生成一份可验证的
构建证明，把「这个 tarball 由这个仓库的这次提交构建」写进 registry 元数据。
对陌生人来说这是「它确实来自源码」的凭据，成本只有几行配置。

### 为什么带 `--ignore-scripts`

`package.json` 的 `prepublishOnly` 会跑 `build:client && test && soak`。workflow 里
这三步已经**分别**跑过了（失败时日志能分清是哪一步挂的）。再让 npm 跑一遍不只慢一倍，
还会让真实失败被埋在 `prepublishOnly` 这一层包装里。

### 宿主依赖：为什么在 CI 里临时装

集成测试 `test/integration.test.mjs` 要真起一个 cordis `Context` + 真 `ToolRuntime`，
所以它 import 了三个**由 DSH 本体提供**的包：

```
@deepseek-ai/cordis
@deepseek-ai/dsh-tools
@deepseek-ai/dsh-system-prompt
```

它们刻意**不在** `package.json` 的 `dependencies` 里 —— 声明它们等于把插件钉死在
某一版宿主上。所以 workflow 用 `npm install --no-save` 临时装，不写进清单、不生成
lockfile。

**版本精确钉到本机 DSH 0.2.1-rc.2 内部实际带的版本**，不是 `@latest`：

| 包 | CI 装 | 注意 |
|---|---|---|
| `@deepseek-ai/cordis` | `4.0.5` | 与 `package.json` 的 peer 范围一致 |
| `@deepseek-ai/dsh-tools` | `0.2.1-rc.2` | **`latest` 是 `0.0.1-rc.1`**，差了一个大版本 |
| `@deepseek-ai/dsh-system-prompt` | `0.2.1-rc.2` | 同上 |

`dsh-tools` / `dsh-system-prompt` 的 `dist-tags.latest` 停在 `0.0.1-rc.1`，而真实宿主里
是 `0.2.1-rc.2`。装 `@latest` 会拿到一个 API 不兼容的老版本，集成测试会以「查不到某个
导出」的方式失败 —— 看起来像插件坏了，其实是装错了宿主。所以这里写死版本。

### 测试在缺宿主时是跳过，不是失败

`test/integration.test.mjs` 用动态 `import()` 拿这三个包，**只吞 `ERR_MODULE_NOT_FOUND`**：

- 有宿主依赖 → 5 条集成测试真跑
- 没有 → 5 条标 `skipped` 并打印缺哪个包，退出码 0（不把整份套件弄挂）
- 语法错 / 导出名改错 → 照旧抛错，不会被当成「环境缺失」藏起来

这条分支两边都验过：

| 环境 | 结果 |
|---|---|
| 本机（DSH 全局装） | `tests 5 / pass 5 / skipped 0` |
| 空 `node_modules` | `tests 5 / pass 0 / skipped 5`，退出码 0 |
| 完整隔离副本 + 三个宿主包 | `npm test` → `tests 93 / pass 93 / fail 0` |

### 验证它真的成了

```powershell
# 不需要浏览器，registry API 就够
curl.exe -sS https://registry.npmjs.org/dsh-rampart | Select-Object -First 1
# 或
npm view dsh-rampart version dist.tarball dist.integrity
```

`npm view` 走的是 registry，不走 www.npmjs.com，所以本机 VPN 下也能查。

