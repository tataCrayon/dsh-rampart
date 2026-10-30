# dsh-resource-guard

给 DeepSeek Harness 加一层**内存/CPU 压力护栏**：机器快被吃穿时先踩刹车，而不是等它卡死。

两层，各管一件事：

| 层 | 干什么 | 在哪 |
|---|---|---|
| **插件**（软） | 采样可用内存 → 分 normal/warn/critical → 降优先级、钉核、拦重活、给模型读数据 | `lib/` |
| **启动壳**（硬） | 给整棵 Electron 进程树套 Job Object 内存硬顶，撞上就被系统拒绝 | `scripts/launch.mjs` |

---

## 为什么要自己写

先把「有没有现成的」查清楚了，结论是**没有**：

**内置**：本机 `@deepseek-ai/dsh@0.2.1-rc.2` 下 304 个包，逐个读 `description` 与 README，**没有一声明对 harness 或子进程施加内存/CPU 上限**。最接近的三处都不是 cap：

- `dsh-win32-process` 是唯一用 Job Object 的包，但 144 字节缓冲里只写 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`（偏移 16），**从不设** `ProcessMemoryLimit` / `JobMemoryLimit` / CPU rate；
- `dsh-output-retention` / `dsh-spill` / `dsh-compaction` cap 的是**回给模型的 token**，不是进程内存；
- `dsh-timeout` 只做时间算术，README 明写 "no termination"；`dsh-tool-call-timeout-policy` 是协作式超时，管不了不配合取消的进程。

**社区**：`awesome-dsh-plugin.com/plugins.json` 7723 条（2026-10-29 快照）逐条筛完，只有三类相关，都不是 cap：

- `dsh-code-runtime-container`：cgroup 硬限，但**只约束 Code Mode 里跑的程序**，不管 harness 本体；
- `dsh-memory-watchdog`：临界时**重启整个桌面应用**（默认关闭），不是限制；
- `dsh-system-monitor-plugin` 等 8 个：只监控展示，不动作。

所以本仓库补这两层。**注意它防的是「自己把自己卡死」，不是恶意进程，也不是安全边界。**

---

## 装法

### 插件

插件是普通 cordis 插件，两种装法。

**A. 按包名装（推荐，能被 Plugin Manager 管到）**

```powershell
# 1) 把本目录链进 profile 的 node_modules
$profile = "D:\Users\zigang.wang\.dsh\profiles\desktop"
cmd /c mklink /J "$profile\node_modules\dsh-resource-guard" "D:\Projects\MyProjects\dsh-resource-guard"

# 2) 在 profile patch 里插一行（desktop profile 的这一行已存在，追加到末尾即可）
```

`$profile\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: resource-guard
      name: 'dsh-resource-guard'
```

桌面的 HMR 会监听 `cordis.patch.yml`，**保存后约 2 秒自动重组，不用重启应用**。

**B. 用绝对路径直插（不想动 node_modules 时）**

```yaml
- insert:
    - id: resource-guard
      name: 'file:///D:/Projects/MyProjects/dsh-resource-guard/lib/index.js'
```

这条路要求进程环境里有 `DSH_HOME` / `DSH_PROFILE_DIR`（桌面应用会设），插件靠它找到
DSH 自带的 `dsh-win32-process` 与 `koffi`；找不到就退化为纯观测模式并在日志里说明。

### 启动壳（想要硬顶才需要）

```powershell
cd D:\Projects\MyProjects\dsh-resource-guard
node scripts\launch.mjs --dry-run          # 先看会施加多少
node scripts\launch.mjs                    # 默认按总内存 55% 给硬顶（本机 32 GB → 17810 MB）
node scripts\launch.mjs --cap 12000 --low-priority
```

或双击 `dsh-guarded.cmd`。

---

## 配置

只能写在 patch 的 `config` 里（`Config` 自己实现 StandardSchemaV1，没有 schemastery 的表单渲染）。
全部字段与默认值见 `lib/config.js`，最常改的是四个阈值：

| 字段 | 默认 | 含义 |
|---|---|---|
| `warnFreeMemoryMb` | 2048 | 可用物理内存低于此值进入 warn（只降速 + 提醒） |
| `criticalFreeMemoryMb` | 1024 | 低于此值进入 critical（**拦**重活） |
| `warnCommitMb` | 3072 | 可用提交内存低于此值进入 warn；`0` 关闭该项 |
| `criticalCommitMb` | 1536 | 低于此值进入 critical；`0` 关闭该项 |
| `priority` | `below-normal` | 降优先级；子进程会继承（实测） |
| `limitCores` | 0 | 钉住核数；0 = 不动亲和性 |
| `heavyTools` | pwsh/bash/shell/workflow/subagent/subagent_fork/send_message/web_fetch/web_search | 精确名单 |
| `heavyPatterns` | `['job_*']` | 通配名单 |

**为什么默认值这么保守**：本机实测物理 32 GB、可用长期 2.7~3.3 GB（约 9%），提交内存同量级。
误拦一条重活只是慢一点；漏拦一次重活是整机卡死。所以宁可早拦。

**为什么「轻工具永不拦」**：压力大时更不该阻止模型 `read`/`grep`/`write`/`todo_write` —— 收尾、汇报、保存状态都是轻活。

---

## 模型看到什么

被拦时返回一条结构化错误（`RESOURCE_GUARD_DENIED`），**带实测读数与下一步建议**，
而不是一句「禁止」——后者会让模型反复重试同一条命令：

```
资源护栏：pwsh 属于重活，当前内存压力为 critical（可用物理 3832 MB / 总 32381 MB，
占用 88%，可用提交 5330 MB）。机器已接近卡死临界点，继续跑会拖垮整台机器。
请改用轻量动作（read/grep/write/todo_write 等），或调用 resource_guard 查看实时读数后
向用户汇报并等待。
```

另有一个 `resource_guard` 工具：

```json
{
  "grade": "critical", "rawGrade": "critical",
  "summary": "等级 critical（瞬时 critical）；可用物理 3014 MB / 总量 32381 MB（占用 90%）；可用提交 3725 MB；已拦 1 次，降速 0 次，采样 3 次",
  "totalMb": 32381, "availPhysMb": 3014, "availCommitMb": 3725, "loadPercent": 90,
  "deniedCalls": 1, "delayedCalls": 0, "samples": 3, "frozenPids": [], "win32": true
}
```

---

## 能力边界（必须说清）

1. **插件不能给宿主加内存硬顶。** Job Object 的限额一旦附加就**无法解除**（Windows 没有把进程移出 Job 的 API）。给 Electron 自己套上限 = 把它永久锁在那个上限里。所以硬顶只能在**创建时**由启动壳施加，这也是它必须是两层的原因。
2. **插件不能抢占已经跑飞的工具。** `tools/pre-execute` 只能在调用**前**拒绝。已经在跑的 pwsh 命令只能靠 `freeze()`（`NtSuspendProcess`，可逆冻结）或用户取消。
3. **硬顶撞上是「杀进程」而不是「返回错误」。** 实测：Job 整树上限撞上时 Node 表现是 `FATAL ERROR: Committing semi space failed ... JavaScript heap out of memory` + 退出码 134，**拿不到可捕获的异常**。所以软层阈值必须低于硬顶——撞上硬顶的一方没有纠正机会。
4. **`exec.arguments` 不能改写。** 只能拦，不能「帮你把命令改小」。
5. **不是安全边界。** 不防恶意进程，也不防 DSH 之外的软件吃内存。

---

## 实测证据

### 单元 / 集成测试（48 条全绿）

```powershell
npm test
# ℹ tests 48  ℹ pass 48  ℹ fail 0
```

覆盖：阈值分级、迟滞、重活判定、决策、配置校验、优先级/亲和性的**可逆性**、
以及在**真 cordis + 真 ToolRuntime** 里的门禁行为（critical 时工具体确实没执行——用副作用文件断言，不读返回值）。

### Win32 真机探针

```powershell
npm run verify
# RESULT: PASS — 优先级与亲和性装上后能完整恢复
# RESULT: PASS — Job 整树内存硬顶真的会拒绝分配，且不污染父进程
# RESULT: PASS — 启动壳的整树硬顶在真实 spawn 路径上生效，且不污染调用者
```

### 真 DSH profile 端到端

```powershell
npm run verify:profile
# [deny-probe] heavy isError=true marker=false
# steps[0].errorCode = RESOURCE_GUARD_DENIED
# steps[1].name = resource_guard（读得到 grade=critical 与 deniedCalls=1）
```

即：headless profile 真加载插件 → 真调 `pwsh` → 被拦 → **命令的副作用文件确实没被创建**。

---

## 踩过的坑（留给下一个人）

| 坑 | 表现 | 真相 |
|---|---|---|
| Job 内存限额偏移 | `SetInformationJobObject` 返回 0 | x64 上 `ProcessMemoryLimit` 在 **112**、`JobMemoryLimit` 在 **120**（`BasicLimitInfo` 是 64 字节，不是 48）。写在 64/72 会被内核拒绝 |
| `AssignProcessToJobObject` | `ERROR_ACCESS_DENIED(5)` | 少 `PROCESS_TERMINATE(0x1)`。这个错误码完全指错方向，看起来像「没权限」 |
| 本进程已在 Job 里 | `CREATE_BREAKAWAY_FROM_JOB` 也返回 5 | DSH 的沙箱已把进程放进 Job。**不 breakaway 直接 assign 反而成功**（Windows 8+ 嵌套 Job） |
| 短命进程采样 | 峰值报 2 MB | 0.3 秒就结束的命令一次都采不到；要读 Job 的 `PeakProcessMemoryUsed` |
| schemastery 依赖 | `file://` 加载时报 `Cannot find module` | Node 从插件目录向上找 `node_modules`，那里没有 DSH 的包 |

---

## 目录

```
lib/pressure.js    纯逻辑：分级、迟滞、重活判定、决策（无副作用，可单测）
lib/guardian.js    运行时：采样、装/撤可逆限制、门禁
lib/win32.js       Win32 能力层：内存读数、优先级、亲和性、冻结、Job
lib/config.js      StandardSchemaV1 配置校验
lib/index.js       插件入口：pre-execute 门禁 + resource_guard 工具
scripts/launch.mjs 启动壳 CLI
scripts/launcher.mjs 启动壳实现（Job 整树硬顶）
scripts/verify-*.mjs 真机验收
test/              48 条测试
```
