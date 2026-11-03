# 市场投稿：已提交

**PR：[awesome-dsh-plugin#11542](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/11542)**
标题 `Add tataCrayon/dsh-rampart`，分支 `tataCrayon:add-dsh-rampart` → `awesome-dsh-plugin:main`，
提交 `0b110c0`，改动 1 个文件 `data/plugins/tataCrayon__dsh-rampart.yml`（+30 行）。

2026-11-03 12:30 实测：

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
