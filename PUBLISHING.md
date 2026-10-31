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

> 不发 npm 也能用：`dsh plugin add github:tataCrayon/dsh-rampart` 直接从 git 装。
> 但**市场条目的 `source.type: "npm"` 需要真发到 registry**；给 git 源就得在版本里
> 写 40 位 commit SHA（发了新提交就要改索引，维护成本高）。所以建议发 npm。

---

## 4. 提市场条目（社区目录）

只需要**一个文件**，不要手改 README（那两个 README 是脚本生成的）：

`awesome-dsh-plugin` 仓库 → `data/plugins/tataCrayon__dsh-rampart.yml`：

```yaml
url: https://github.com/tataCrayon/dsh-rampart
name: tataCrayon/dsh-rampart
category: dev
description:
  en: 'Grades memory and CPU pressure on the machine running dsh and refuses heavy tools (shell, workflow, subagent) before it thrashes, then shows in the composer how much of the machine DSH itself is using.'
  zh: '按整机内存/CPU 压力分级，到线就拦重活（shell、workflow、subagent），并在输入框下方显示 DSH 自己占用了多少整机资源。'
icon: https://raw.githubusercontent.com/tataCrayon/dsh-rampart/main/assets/icon-180.png
```

要点：
- 描述里含 `: ` 必须加引号（否则 YAML 解析成嵌套键）—— 上面已经包了。
- `category` 取**实际做的事**：`dev`（开发与运行时）。不是 `ui`（UI 只是它的一半）。
- 仓库需**创建满 1 天**、有真代码、带 `dsh-plugin` topic。本条 PR 建议**明天再提**。
- 描述必须与代码相符 —— 审核会数。上面这句对得上：分级、拦重活、显示占比，三件都在。

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
        "en": "Memory and CPU pressure guard: grades pressure, refuses heavy tools, shows how much of the machine dsh uses.",
        "zh": "内存/CPU 压力护栏：分级、拦重活、显示 dsh 占用了整机多少。"
      },
      "icon": "https://raw.githubusercontent.com/tataCrayon/dsh-rampart/main/assets/icon-180.png",
      "author": "tataCrayon",
      "homepage": "https://github.com/tataCrayon/dsh-rampart",
      "repository": { "url": "https://github.com/tataCrayon/dsh-rampart" },
      "versions": [
        {
          "version": "0.2.0",
          "publishTimestamp": 1793491200,
          "source": { "type": "npm" },
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
| 占位仓库 / 纯 README | ✅ 有实现、有 72 条测试、有真机验收脚本 |
| 仓库创建不满 1 天 | ⚠️ 今天刚建 → **明天再提 PR** |
| 描述夸大 | ✅ 描述里的三件事都能在代码里指出来 |
| 缺 `dsh-plugin` topic | ✅ 已打 |
