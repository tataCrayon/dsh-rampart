# 装到 desktop profile：实测记录与调试过程

> 这一份是**装完之后的现场记录**，不是设计文档。设计理由看 `README.md`，
> 本案的决策背景看剪映仓库的 `docs/decisions/007-DSH资源护栏独立仓库.md`。

安装时间：2026-10-30 19:00 前后（HMR 实时生效，未重启 Electron）。

---

## 1. 装了什么

| 位置 | 内容 |
|---|---|
| `D:\Users\zigang.wang\.dsh\profiles\desktop\node_modules\dsh-resource-guard` | 指向本仓库的 junction（`mklink /J`） |
| `…\profiles\desktop\cordis.patch.yml` 末尾 | 一条 `insert`，`id: resource-guard`，名称 `dsh-resource-guard` |
| 备份 | `cordis.patch.yml.bak-resource-guard-20261030-184919` |

**没有**改 `package.json`、**没有**重启应用。DSH 的 HMR 监听 profile patch，
保存后约 2 秒 live recomposition。

## 2. 最终配置（按本机实测调过两轮）

```yaml
warnFreeMemoryMb: 3000      # 可用物理 < 3.0 GB → warn（重活 +400ms）
criticalFreeMemoryMb: 1800  # 可用物理 < 1.8 GB → critical（拦重活）
warnCommitMb: 2200          # 可用提交 < 2.2 GB → warn
criticalCommitMb: 1400      # 可用提交 < 1.4 GB → critical
escalateSamples: 3          # 连续 3 次越线才升级（5s 一次 → 约 15s）
recoverSamples: 3
sampleIntervalMs: 5000
priority: below-normal
limitCores: 0               # 不钉核
```

### 为什么第一版阈值不对

第一版用了 `warn 3072 / critical 2048 / warnCommit 4096 / criticalCommit 2560`，
结果装完立刻长期停在 **warn**：`delayedCalls` 一路涨到 19，每次 pwsh 调用都白等 400ms。

原因是**阈值压在了常态区间之内**。5 分钟基线（30 个样本，10s 一次）：

| 指标 | min | p10 | 中位 | p90 | max |
|---|---|---|---|---|---|
| 可用物理 MB | 3038 | 3269 | 3646 | 3907 | 3915 |
| 可用提交 MB | **2282** | 2619 | 2899 | 3066 | 3085 |

提交可用 `warn=4096` 意味着**每一个样本都越线**——那不是「压力大」，那是这台机器的
正常水位。改到 `warnCommit=2200`（低于实测 min）后才只在真异常时响。

**这条教训写进 README 了**：阈值必须按本机实测分布定，不能按「感觉 4 GB 很多了」定。

## 3. 调试：三档都真验过

在真实 Electron 宿主里（pid 59480）通过临时探针 `scripts/desktop-probe.js` 取证，
它每 10s 调一次 `resource_guard` 落盘。**取证完已从 patch 删除。**

### 3.1 normal（日常）

```json
{ "grade": "normal", "availPhysMb": 3239, "availCommitMb": 2549,
  "deniedCalls": 0, "delayedCalls": 0, "hasResourceGuard": true }
```

`pwsh` 正常放行。

### 3.2 warn（我把它逼出来的）

把 `warnCommitMb` 临时抬到 999999、`criticalCommitMb` 压到 1，让它只能停在 warn：

```json
{ "grade": "warn", "deniedCalls": 0, "delayedCalls": 1, "samples": 16 }
```

`delayedCalls` 从 0 涨到 1 —— 说明门禁确实走在我这个会话的真实调用链上，
而不是只在测试里成立。

### 3.3 critical（真的被拦）

把 `warnFreeMemoryMb` / `criticalFreeMemoryMb` 一起抬到 999999 / 999998
（**两个必须一起抬**：只抬 critical 会被 `Config` 的
`critical <= warn` 校验拒掉，条目保持旧配置，看着像「HMR 没生效」，实际是校验没过）。

然后我这个 agent 调用 `pwsh` 就被拦了，原文：

```
Error: 资源护栏：pwsh 属于重活，当前内存压力为 critical（可用物理 3707 MB / 总 32381 MB，
占用 88%，可用提交 3058 MB）。机器已接近卡死临界点，继续跑会拖垮整台机器。
请改用轻量动作（read/grep/write/todo_write 等），或调用 resource_guard 查看实时读数后
向用户汇报并等待。
```

同时 `resource_guard` 仍可调（它不在重活名单里）：

```json
{ "grade": "critical", "deniedCalls": 1, "samples": 18 }
```

恢复阈值后 `pwsh` 立刻可用 —— 说明拦截是**跟着读数走**的，不是一次性锁死。

### 3.4 卸载即还原

把那条 insert 改成 `disabled: true`，进程优先级从 `BelowNormal` 回到 `Normal`；
再改回来，又变成 `BelowNormal`。这条最容易写错（`dispose()` 没恢复会留下永久低优先级），
已验证可逆。

## 4. 优先级继承（实机确认）

```
59480  DeepSeek Harness.exe (host)          BelowNormal   ← 护栏设的
└─ 56764  runner.js                          BelowNormal   ← 继承
   └─ 54416  powershell.exe                  BelowNormal   ← 继承
```

所以「只降宿主」就够了，不需要逐个给孩子设 —— 这条在 005 里没写，这次实测补上。

## 5. 已知限制（不是 bug，是边界）

1. **拦的是「调用前」，不是「运行中」。** 已经在跑的 pwsh 命令拦不住，只能靠
   `freeze()`（`NtSuspendProcess`，可逆）或用户取消。
2. **硬顶没启用。** 装的是插件（软层）。要用整树内存硬顶得从启动壳启动：
   `node scripts\launch.mjs`。现在这套没有硬顶，极端情况下（单次分配 10 GB）
   Electron 仍可能被系统杀掉。
3. **门槛的代价**：warn 下每条重活 +400ms。觉得碍事就把 `warnDelayMs` 调 0，
   或干脆把 `warnFreeMemoryMb` 再压低，让它只在 critical 前一步才动。
4. **不改寄主行为之外的任何东西**：不接管 pwsh、不改工具参数、不改并发设置。

## 6. 下次要调时

改 `D:\Users\zigang.wang\.dsh\profiles\desktop\cordis.patch.yml` 里那条 insert 的
`config`，保存即生效（约 2 秒）。**改完立刻看 `resource_guard` 的 `grade`**：

- 长期 `warn` → 阈值压太紧，抬高或关掉 `warnDelayMs`
- 从不 `critical` → 阈值太松，压到实测 min 附近
- 想验证拦截 → 临时把 `warnFreeMemoryMb` 和 `criticalFreeMemoryMb` **一起**抬到天上
