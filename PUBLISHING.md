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
采样压力、到线就拦重活、把宿主降到 below-normal。名字短、念得出、npm 与 GitHub 都空着。

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
- [x] 72 条单测全绿（`npm test`）

**还差三步**：推到 GitHub → 发到 npm → 提市场条目。下面逐步给命令。

---

## 2. 推到 GitHub

```powershell
cd D:\Projects\MyProjects\dsh-resource-guard
git add -A
git commit -m "feat: 改名 dsh-rampart；读数条移到上下文环右侧；内存/CPU 改为单条分段占比"
git remote add origin https://github.com/tataCrayon/dsh-rampart.git   # 已有则跳过
git push -u origin master
```

凭据已在 Windows Credential Manager 里（`tataCrayon`，scope 含 `repo`），
全局配了 `http.https://github.com.proxy=http://127.0.0.1:7897`，push 会走代理。

---

## 3. 发到 npm

```powershell
npm login                       # 浏览器授权；本机当前是「未登录」状态
npm publish                     # prepublishOnly 会自动 build:client + test
npm view dsh-rampart version    # 确认
```

发布前自检（**必须全绿**，`npm publish` 也会跑一遍）：

```powershell
npm run build:client
npm test
npm pack --dry-run              # 看一眼真的会打包哪些文件
```

`package.json` 的 `files` 已收敛：只带 `lib/`、`client/source.js`、`cordis.patch.yml`、
启动壳的三个文件、`assets/icon-180.png`、`README.md`、`LICENSE`。
`deploy-desktop.md` 是本机现场记录，**不发布**（它含本机路径）。

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

## 6. 本机当前是「本地链接」安装，不是市场安装

现在的 desktop profile 用的是 junction：

```
…\profiles\desktop\node_modules\dsh-rampart → D:\Projects\MyProjects\dsh-resource-guard
```

**改名后这个 junction 还是旧名字 `dsh-resource-guard`，patch 里那行也还是旧包名**，
需要一次性改过来（HMR 会自己重组，但 `dsh-client-modules` 的模块元信息缓存
按 specifier 记住「不是客户端包」的否定结论，**改包名等于换 specifier，所以这次反而
不吃那个缓存**；仍建议重启一次确认）：

```powershell
$profile = "D:\Users\zigang.wang\.dsh\profiles\desktop"
cmd /c rmdir "$profile\node_modules\dsh-resource-guard"
cmd /c mklink /J "$profile\node_modules\dsh-rampart" "D:\Projects\MyProjects\dsh-resource-guard"
# 再把 cordis.patch.yml 末尾那条 insert 的 name 改成 dsh-rampart
```

装成市场版之后就把 junction 删掉，改由 `dsh plugin add dsh-rampart` 管理，
这样 Plugin Manager 能升级/卸载它。

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
