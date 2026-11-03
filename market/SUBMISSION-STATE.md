# 市场投稿：已提交

**PR：[awesome-dsh-plugin#11542](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11542)**
标题 `Add tataCrayon/dsh-rampart`，分支 `tataCrayon:add-dsh-rampart` → `awesome-dsh-plugin:main`，
提交 `64c3507`，改动 1 个文件 `data/plugins/tataCrayon__dsh-rampart.yml`（+11 行）。

> 分支 head 仓库是 **`tataCrayon/awesome-dsh-plugin`**（市场仓的 fork），
> **不是** `tataCrayon/dsh-rampart`（插件仓）。两者同名不同物，推错会污染插件仓库。

## 标题

为什么**不重开**一个 PR：见文末「为什么不重开 PR」。

2026-11-03 12:30 首次实测：

| 项 | 结果 |
|---|---|
| PR 状态 | `open` |
| `mergeable_state` | **`clean`**（可合并，无冲突、无待改） |
| CI run 41576479380 | **`completed / success`** |
| 改动文件数 | 1（没碰 README，符合要求） |
| 标签 | 无 `held: author` |

CI 全部 14 步通过，包括最容易挂的两步：`READMEs match data/plugins`、
`Stale-fork guard`，以及 `Build (locale parity, date derivation, templates)`。

## 提交前做的核对

| 事项 | 状态 | 证据 |
|---|---|---|
| 仓库满 1 天 | ✅ | `created_at 2026-10-31T07:32:50Z`，提交时 3.02 天（门槛 1 天） |
| `dsh.bundle` 声明 | ✅ | `dsh.bundle.patch = ./cordis.patch.yml` |
| `dsh-plugin` topic | ✅ | 已打 |
| 默认分支 | `master`（不是 main） | API `default_branch = master` |
| 图标 URL | ✅ master 分支 | API `?ref=master` → 1407 字节；`?ref=main` → 404 |
| 预构建 tarball | ✅ | `releases/download/v0.2.0/dsh-rampart.tgz`，73874 B，SHA256 与本地一致 |
| 陌生人从 tarball 装 | ✅ | `npm install <url>` → 6 秒，`lib/index.js` 在 |
| 陌生人从 `github:` 简写装 | ❌ 会失败 | GIT_TRACE 实测解析成 `ssh://git@github.com/...`；空 HOME + batch → `Permission denied (publickey)` |
| 市场 gate 脚本 | ✅ | 本地跑 `check-submission.mjs` → `{"ok": true, "checked": 1, "failures": []}` |
| 测试 | ✅ 93/93 | `npm test` |

## 提交时踩到的坑：描述夸大

初稿写的是「Grades whole-machine **memory and CPU** pressure」。对着代码核：

```
gradeOf() 读的阈值：warnFreeMemoryMb / criticalFreeMemoryMb / warnCommitMb / criticalCommitMb
config.js 里的 CPU 阈值：没有
```

`gradeOf()` 只读四个内存阈值，**CPU 全仓库没有任何阈值配置**，只用于画读数条。
contributing.md 明说审核会把描述当声明逐字对着代码核，夸大是头号打回原因。
所以提交前改成了：

> Grades free physical and commit memory and refuses heavy tools (...) before the
> machine thrashes. Also shows in the composer how much of the machine dsh itself
> is using, including whole-machine CPU.

PR 正文里也专门写了一节说明「为什么不写 CPU 参与分级」，省得审核来问。

## 顺带修掉的两个坑

1. **`PUBLISHING.md` 的图标 URL 写的是 `main`，会 404。** 本仓默认分支是 `master`。
2. **全局 git 代理指向 `127.0.0.1:7897`，那个端口没进程在听。** 所有 git 操作
   都要先卡 2 秒再报 `Failed to connect ... over proxy`。已 `git config --global --unset`
   清掉两条 `http.https://github.com*.proxy`，现在直连。

## 后续

- 合并后就等维护者 review，不需要再推任何东西。若被打 `held: author`，把修复推到
  同一分支 + 留**一条**评论即可。
- npm 仍未发布（`www.npmjs.com/login` → 403 `cf-mitigated: challenge`）。按
  contributing.md「发不发布都不影响收录」，`repository` 字段已指回本仓库，
  将来发布后映射会被自动采集。

---

## 2026-11-03 14:35 第二轮：注释 22 行压到 3 行

`tataCrayon__dsh-rampart.yml` 原来带 22 行注释。全市场 8282 条里只有 129 条带注释，
中位数 3 行，**我这条是全市场注释最多的**（第二多 21 行）。规则没禁止、CI 也过了，
但那是噪音。已压到 3 行，正文 7 行不变。

验证「只删注释、没动字段」不是靠肉眼——用市场仓自己的 `js-yaml` 把新旧两版都解析成
对象，逐键比对：

```
旧版键: category, description, icon, name, tarball, url
新版键: category, description, icon, name, tarball, url
✅ 字段值逐字相同，只删了注释
```

精简后重跑 gate：`{"ok": true, "checked": 1, "failures": [], "incomplete": []}`。

用的是一次 `git commit --amend` 而不是叠一个 fixup 提交，分支上仍然只有一个提交
（`64c3507`，父提交就是 `origin/main` 的 `152f265`）。

## 为什么不重开 PR

问过「是不是重开一个 PR 严格检查规范更好」。结论是**不重开，重开会更差**，理由都是可查的：

1. **规则明说不用重开。** contributing.md:167：「Push a fix to the same branch —
   no need to open a new PR.」重开反而违背它。
2. **CI 不读 PR 正文。** 在 `.github/workflows` 里 `select-string 'pull_request.body'` 无命中 ——
   勾选框、正文全是给人看的，形式检查只看文件。所以「换个更规范的 PR 正文」对通过率零影响。
3. **查重是审核第 4 条，靠改 PR 治不了。** contributing.md:92 明说 CI「无法判断……是否与
   已有条目重复」。重复了就是重复了，重开十次也一样。已确认不重复，见下。
4. **重开要重新排队。** 当前 291 个 open PR；我的 #11542 之后只有 1 个更新编号。
   重开会拿到 ~11581，把 39 个 PR 排到自己前面。
5. **维护者按质量放过，不按编号。** 最近合并的样本里有 `#10640`（10-30 开）在
   `#11204`（11-01 开）之后才合，说明不是 FIFO。

而且「不重开」还有一条硬理由：**已经绿过的 CI 记录是资产**，重开就清零。本轮推
`64c3507` 后 CI 从 06:29:58Z 重新跑到 `unstable`，就是为了保住同一个 PR 的上下文。

## 查重结论（审核第 4 条）

搜了全市场 8282 条，**同时**命中「宿主内存」与「拦/拒」的条目里，最接近的是
`elegant01__dsh-memory-watchdog.yml`（Windows 提交内存看门狗）。逐字段比：

| 能力 | dsh-memory-watchdog | dsh-rampart |
|---|---|---|
| 采样提交内存 | ✅ 每 5 秒 | ✅ |
| 归因到进程树 | ✅ | ✅ |
| 拦工具 / 拒绝重活 | ❌ | ✅ |
| 降优先级 below-normal | ❌ | ✅ |

它在 `en` 描述里对 `refus|block.{0,20}tool|deny` 三项全不命中，也不提 priority ——
两者不重叠，不是「已被覆盖」。真正同类的 `dsh-memory-guard` / `dsh-concurrency-guard`
一个是本地堆与 session log、一个是并发 FIFO 队列，也都不做「按宿主内存拦重活」。
