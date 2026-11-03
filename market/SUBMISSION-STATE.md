# 市场投稿：当前进度与续作步骤

> 写这份是因为提交到一半时本机内存压力进了 critical（可用物理 1.2~1.7 GB / 32 GB，
> 占用 94~97%），护栏开始拦 `pwsh`。下面的东西都已做完并验证过，只有最后两步要跑命令。

## 已经做完、且有实测证据的

| 事项 | 状态 | 证据 |
|---|---|---|
| 仓库满 1 天 | ✅ | `created_at 2026-10-31T07:32:50Z`，距今 1.97 天（门槛 1 天） |
| `dsh.bundle` 声明 | ✅ | `dsh.bundle.patch = ./cordis.patch.yml` |
| `dsh-plugin` topic | ✅ | 已打 |
| 默认分支 | `master`（不是 main） | API `default_branch = master` |
| 图标 URL 可访问 | ✅ master 分支 | API `contents/assets/icon-180.png?ref=master` → 1407 字节；`?ref=main` → 404 |
| 预构建 tarball 已上传 | ✅ | `releases/download/v0.2.0/dsh-rampart.tgz`，73874 B，SHA256 与本地一致 |
| 陌生人能从 tarball 装 | ✅ | `npm install <tarball URL>` → 6s 装完，`lib/index.js` 在 |
| 陌生人从 `github:` 简写装 | ❌ 会失败 | GIT_TRACE 实测解析成 `ssh://git@github.com/...`；空 HOME + batch mode → `Permission denied (publickey)` |
| 市场自己的 gate 脚本 | ✅ 通过 | `check-submission.mjs` → `{ok: true, checked: 1, failures: []}` |
| 条目字段解析 | ✅ | `entries.mjs` 读出 category/tarball/description 全对 |
| 测试 | ✅ 93/93 | `npm test` |

## 已经推到 fork 的

- fork：`tataCrayon/awesome-dsh-plugin`（默认分支 main）
- 分支：`add-dsh-rampart`
- 提交：`0b110c0 Add tataCrayon/dsh-rampart`（**但这次 push 被中断，未确认落地**）
- 分支内容：只加 `data/plugins/tataCrayon__dsh-rampart.yml`，不碰 README

**续作第一步就是确认它到底推上去了没有：**

```powershell
git ls-remote --heads https://github.com/tataCrayon/awesome-dsh-plugin.git add-dsh-rampart
```

- 返回 `0b110c0...` → 已推上去，直接开 PR。
- 返回 `a802582...`（旧提交）或空 → 重新推：

```powershell
cd "$env:TEMP\market-gate-test"   # 市场仓库的浅克隆，分支已 checkout
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill
$t = ($cred -split "`n" | Where-Object { $_ -match '^password=' }) -replace '^password=',''
git remote add fork "https://x-access-token:$t@github.com/tataCrayon/awesome-dsh-plugin.git"
git push fork add-dsh-rampart --force
git remote remove fork      # 立刻删，别让 token 留在 .git/config
```

## 还差的两步

1. **开 PR**：`tataCrayon:add-dsh-rampart` → `awesome-dsh-plugin:main`
   标题：`Add tataCrayon/dsh-rampart`
   正文勾选 PR 模板的四项（一个文件 / 有 dsh.bundle / 仓库满 1 天 / category 合法 / 无夸大 / 有 topic）。

2. **把本仓库未提交的改动提交掉**（都改了内容，还没 commit）：
   - `market/tataCrayon__dsh-rampart.yml` —— 描述改写（去掉「按 CPU 分级」的夸大）
   - `PUBLISHING.md` —— 修正 main→master、加 tarball、测试数 72→93、补「描述与代码逐字对应」
   - `README.md` —— 标题去 CPU、新增「分级依据（只有内存，没有 CPU）」小节

## 关键教训（别再踩）

- **描述会被逐字对着代码核。** 初稿写「Grades memory **and CPU** pressure」，但
  `gradeOf()` 只读 `warnFreeMemoryMb` / `criticalFreeMemoryMb` / `warnCommitMb` /
  `criticalCommitMb` 四个内存阈值，`config.js` 里没有任何 CPU 阈值。CPU 全仓只用于显示。
  这是夸大，会被打回。已改成「分级看内存、CPU 只显示」。
- **图标分支是 master。** `PUBLISHING.md` 旧模板写的是 `main`，照抄会 404。
- **`github:` 简写走 SSH，不走 HTTPS。** 市场卡片给陌生人的命令就是它，
  所以 `tarball:` 不是可选项。
