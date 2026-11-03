# dsh-rampart

给 DeepSeek Harness 加一层**内存压力护栏**：机器快被吃穿时先踩刹车，而不是等它卡死。
CPU 占比只显示、不参与分级 —— `gradeOf()` 只看四个内存阈值，见下文「分级依据」。

> **rampart** = 城墙的外围防御墙。采样压力、到线就拦重活、真到缺内存时把宿主降到 below-normal ——
> 都是在机器被压垮之前筑一道墙。

两层，各管一件事：

| 层 | 干什么 | 在哪 |
|---|---|---|
| **插件**（软） | 采样可用内存 → 分 normal/warn/critical → 降优先级、钉核、拦重活、给模型读数据 | `lib/` |
| **启动壳**（硬） | 给整棵 Electron 进程树套 Job Object 内存硬顶，撞上就被系统拒绝 | `scripts/launch.mjs` |

外加**输入框下方的一条读数**（`CPU 12% · DSH 1.2 GB`），排在 DSH 自己的上下文占用环
**右边**；点开是面板，用一根分段占比条回答「整机被谁吃了」，带一个「释放内存」按钮。
数据不走模型，是浏览器直接打宿主路由取的本机读数。

```powershell
dsh plugin --profile web add dsh-rampart
```

> ⚠️ 与 npm 上已存在的 `dsh-resource-guard`（另一个作者的本地模型内存信号量插件）
> **不是同一个东西**。本插件原名就是那个，为避让而改名。

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
cmd /c mklink /J "$profile\node_modules\dsh-rampart" "D:/Projects/MyProjects/dsh-resource-guard"

# 2) 在 profile patch 里插一行（desktop profile 的这一行已存在，追加到末尾即可）
```

`$profile\cordis.patch.yml` 追加：

```yaml
- insert:
    - id: rampart
      name: 'dsh-rampart'
```

桌面的 HMR 会监听 `cordis.patch.yml`，**保存后约 2 秒自动重组，不用重启应用**。

**B. 用绝对路径直插（不想动 node_modules 时）**

```yaml
- insert:
    - id: rampart
      name: 'file:///D:/Projects/MyProjects/dsh-resource-guard/lib/index.js'
```

这条路要求进程环境里有 `DSH_HOME` / `DSH_PROFILE_DIR`（桌面应用会设），插件靠它找到
DSH 自带的 `dsh-win32-process` 与 `koffi`；找不到就退化为纯观测模式并在日志里说明。

### 启动壳（想要硬顶才需要）

```powershell
cd D:/Projects/MyProjects/dsh-resource-guard
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
| `priority` | `on-pressure` | 压力到 warn 才降优先级，解除即恢复；可选 `below-normal`（启动即降）/ `unchanged` |
| `limitCores` | 0 | 钉住核数；0 = 不动亲和性 |
| `heavyTools` | pwsh/bash/shell/workflow/subagent/subagent_fork/send_message/web_fetch/web_search | 精确名单 |
| `heavyPatterns` | `['job_*']` | 通配名单 |
| `showStatusPill` | `true` | 是否挂输入框下方的读数条 + `/rampart/api/*` 路由 |
| `statusPillIntervalMs` | 2000 | 读数条轮询间隔；低于 500 会被夹到 500 |

### 分级依据（只有内存，没有 CPU）

`gradeOf()` 只读上面四个内存阈值，**CPU 不参与任何判定**：

| 输入 | 参与分级？ | 用在哪 |
|---|---|---|
| 可用物理内存 | ✅ | `warnFreeMemoryMb` / `criticalFreeMemoryMb` |
| 可用提交内存 | ✅ | `warnCommitMb` / `criticalCommitMb` |
| 整机 CPU 占比 | ❌ | 只画进读数条与面板 |
| DSH 进程树 CPU | ❌ | 只画进读数条与面板 |

这不是漏了，是刻意的：CPU 高只是慢，内存见底是整机进入换页风暴、连 shell 都拉不起来。
护栏要挡的是后者。Kubernetes 的节点压力驱逐也是同一个取舍 —— 宁可慢，不可死。
若确实要按 CPU 拦，把 `workflow` 之类的工具移出 `heavyTools` 名单是当前唯一的手段。

**为什么默认值这么保守**：本机实测物理 32 GB、可用长期 2.7~3.3 GB（约 9%），提交内存同量级。
误拦一条重活只是慢一点；漏拦一次重活是整机卡死。所以宁可早拦。

**但装的时候一定要按本机实测重定阈值。** 实测教训（详见 `deploy-desktop.md`）：
第一版用 `warnCommitMb: 4096` 装上去，`delayedCalls` 一路涨——因为这台机器**每一个**
采样点的可用提交都在 4 GB 以下，那不是「压力大」，那是正常水位。
改成低于实测最小值（2200）后，才只在真异常时才响。

调参口诀：**阈值要压在「常态低谷」之下**，留 1 GB 左右的余量给真正的突发。

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

## 输入框下方那条读数

排在 DSH 自己的 `154 tok/s`、`缓存命中 49%`、上下文占用环**之后**：

```
154 tok/s · 缓存命中 49% · 38% · CPU 12% · DSH 1.2 GB
```

- **normal** → 灰色（与内置统计条同一个 tertiary 前景色）
- **warn** → 变警示色
- **critical** → 前置一个实心点 + 警示色

> **为什么「排在上下文环右边」要靠 CSS 而不是 `order` 选项**：上下文环比 slot 更硬 ——
> 它是 `InputBar` 在 dock 末尾**硬编码**渲染的，不在 `conversation.composer.dock` 里，
> 所以 slot 的 `order` 管不到它。dock 是 flex 容器、slot 外壳是 `display:contents`，
> 我们的根 `<span>` 因此是 dock 的直接 flex item —— 给它 `order:1` 就落到默认 0 的环之后。
> 这个结论来自读 `dsh-client-ui-conversation` 的 bundle，不是猜的。

点开是面板。**面板底与上下文面板完全同源**：`--dsw-specific-menu`（半透明）+
`backdrop-filter: var(--dsw-menu-backdrop-filter)` + `--dsw-elevation-stroke-color` 让阴影带描边 ——
和 DSH 自己的上下文 / 统计 / todo 三块面板是同一组声明。只写 `background` 不写
`backdrop-filter` 会直接透出下面的对话文字，读数根本看不清（这就是上一版的问题）。

### 面板里的条：一根条回答「整机被谁吃了」

不是「DSH 一条、整机一条」两条并列 —— 那会让人以为是两件独立的事，而它们其实是
**同一根尺子上的三段**：

```
整机物理内存            18.4 GB / 31.6 GB · 58%
████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░
● DSH 5.1 GB   ● 其他已用 13.3 GB   ● 空闲 13.2 GB
```

- **蓝 = DSH 在用**（`--dsw-static-blue-450`，与 DSH 上下文面板同一个蓝）
- **灰 = 已经用掉、不可用**（`--dsw-static-neutral-bluish-400`）
- **留白 = 还能再吃**

整机 CPU 同理：`DSH 忙 / 其他忙 / 空闲`，分母是「所有逻辑核跑满」。
本进程 JS 堆单独一条（它有自己的上限，不是整机的分母）。

两个防错细节，都是踩出来的：

1. **百分比不夹成整数**（`shareOf` 保留一位小数）。0.4% 的 DSH 占用夹成 0 会被
   `filter(share > 0)` 整段丢掉 —— 「DSH 在用」这件事在图里直接消失，而它恰恰最该被看见。
2. **DSH 段先夹进整机已用再算「其他」**。DSH 的提交量可能**大于**整机已用物理
   （有换页、有共享页），不夹的话蓝色会溢出轨道，「其他已用」还会变成负数。

### 两个数分别是什么

| 显示 | 来源 | 含义 |
|---|---|---|
| `CPU 12%` | 宿主 `GetSystemTimes` 差值 ÷ (经过时间 × 核数) | 整机 CPU 占用，不是单核 |
| `DSH 1.2 GB` | 沿 `ppid` 找到同名的树根，把**每个成员的 `PagefileUsage`** 加起来 | 用提交量而不是工作集：与任务管理器"内存"列一致，被换页时不会塌成 0 |

树根是走出来的：从 `process.pid` 往上爬，只在父进程**映像名相同**且 pid 未访问时继续，
否则就停在当前进程。所以 Electron 的 main/GPU/renderer/tool 会自然形成一棵树。

### 「释放内存」到底做了什么

只对本进程的 **V8 堆**做一次强制 GC（`v8.setFlagsFromString('--expose-gc')` +
`vm.runInNewContext('gc')`，不需要启动参数）。实测：一次 ~3 ms，`heapUsed 33.2 → 4.4 MB`，
而 `rss` 只降 `96.6 → 95.0 MB`。

所以文案刻意分开写：**「只回收本进程 JS 堆；renderer 堆、Electron native 内存与系统缓存不动，
所以任务管理器里不一定看到变化」**，`freedMb` 也只报 `heapUsed` 的差，不报 RSS —— 报 RSS 会骗人。

### 数据怎么到浏览器

```
浏览器 ──GET /rampart/api/stats──▶ 宿主 webServer 路由 ──▶ GetSystemTimes / Toolhelp32 / GetProcessMemoryInfo
        ◀── { grade, guard, heap, tree } ──
```

- **不经过模型**，不花 token，不刷对话。
- 路由用 `ctx.connection.requestRejection(req)` 做信任判定（和 `dsh-better-sidebar` 同一道围栏），
  **不是**自己发明鉴权。没有 `connection` 服务时退化为「只允许本机回环」并写一条 warn。
- 请求 URL 必须是**页面同源的相对路径**：桌面 shell 的页面是 `dsh-app://app/`，
  `protocol.handle` 会把非静态路径同源转发到宿主；用宿主真实地址（`__DSH_TRANSPORT__.streamBaseUrl`）
  会跨源，而插件路由不发 CORS 头 → `Failed to fetch`。
- 路由取不到数时组件渲染 `null`，不是占位符 —— 宿主半边挂掉不该把编辑器底栏弄坏。

---

## 能力边界（必须说清）

1. **插件不能给宿主加内存硬顶。** Job Object 的限额一旦附加就**无法解除**（Windows 没有把进程移出 Job 的 API）。给 Electron 自己套上限 = 把它永久锁在那个上限里。所以硬顶只能在**创建时**由启动壳施加，这也是它必须是两层的原因。
2. **插件不能抢占已经跑飞的工具。** `tools/pre-execute` 只能在调用**前**拒绝。已经在跑的 pwsh 命令只能靠 `freeze()`（`NtSuspendProcess`，可逆冻结）或用户取消。
3. **硬顶撞上是「杀进程」而不是「返回错误」。** 实测：Job 整树上限撞上时 Node 表现是 `FATAL ERROR: Committing semi space failed ... JavaScript heap out of memory` + 退出码 134，**拿不到可捕获的异常**。所以软层阈值必须低于硬顶——撞上硬顶的一方没有纠正机会。
4. **`exec.arguments` 不能改写。** 只能拦，不能「帮你把命令改小」。
5. **不是安全边界。** 不防恶意进程，也不防 DSH 之外的软件吃内存。
6. **「释放内存」不是「释放整机内存」。** 它只回收本进程的 V8 堆。想真正把整机内存腾出来，
   得关掉占内存的程序；想限制 DSH 的内存天花板，得用启动壳的 Job 硬顶。
7. **读数有 2 秒延迟。** 采样间隔默认 `statusPillIntervalMs: 2000`，且宿主侧满树采样本身要 20~30 ms
   （458 个进程的 Toolhelp 快照 23 ms）。

---

## 实测证据

### 单元 / 集成测试（93 条全绿）

```powershell
npm test
# ℹ tests 93  ℹ pass 93  ℹ fail 0
```

覆盖：阈值分级、迟滞、重活判定、决策、配置校验、优先级/亲和性的**可逆性**（含
`on-pressure` 下「无压力不发 syscall」「降了必恢复」）、
以及在**真 cordis + 真 ToolRuntime** 里的门禁行为（critical 时工具体确实没执行——用副作用文件断言，不读返回值）。

### 性能：热路径开销

护栏挂在**每一次工具调用**上，所以它的开销必须小到看不见。`npm run bench`：

```powershell
npm run bench
# Win32 能力层：可用 · 逻辑核 24
# gate() 轻工具 read              中位   3.8~4.1 µs  p95  6.2~6.8 µs  最大   19~20 µs  (n=300)
# gate() 重活 pwsh                中位   3.4~3.8 µs  p95  9.0~9.9 µs  最大   73~80 µs  (n=300)
# tick() 单次采样                 中位   3.2 µs      p95  4.6~8.7 µs  最大  316~356 µs (n=300)
# TreeSampler 真采 (全表 410~428)  中位  8.4~9.2 ms   p95  9.5~12.5 ms 最大  10~14.7 ms (n=60)
# TreeSampler 缓存命中            中位   0.2 µs      p95  0.3 µs      最大  21~123 µs  (n=2000)
# decideCall() 纯函数             中位   0.3 µs      p95  0.5~1.1 µs  最大  106~115 µs (n=2000)
#
# 同一段枚举在 BELOW_NORMAL 下：中位 15.7~16.1 ms（×1.75~1.85）
```

> 数字给区间而不是单点，是因为它**随机器当时的进程数浮动**：`TreeSampler` 真采
> 从 410 进程的 8.4 ms 走到 428 进程的 9.2 ms，同一天两次跑就能差 10%。
> 报单点会让人以为这个数是常数，然后在别处量到 9 ms 时白查半天。

三句话读懂：

| 路径 | 频率 | 成本 | 结论 |
|---|---|---|---|
| `gate()` | 每次工具调用 | **~4 µs** | 相对一次 pwsh 冷启动（~380 ms）是 1/100000，可忽略 |
| `tick()` | 每 5 秒后台 + 每次 gate 内 | **~3.2 µs** | `GlobalMemoryStatusEx` 就是一次很短的 FFI 调用 |
| `TreeSampler` 真采 | 最多每 1 秒一次 | **~9 ms** | 一次 Toolhelp 全表快照遍历 410~428 个进程 |
| `TreeSampler` 缓存命中 | 其余所有面板请求 | **~0.2 µs** | 直接返回上次结果 |

> **基准必须钉住优先级再量。** 早先这一栏写的是 14.6 ms —— 那个数字是在 `priority: below-normal`
> 的子进程里跑出来的。同一段枚举在 NORMAL 下只要 8.5 ms（×1.90），因为低优先级线程被排到 E 核。
> `scripts/bench.mjs` 现在会先把优先级钉到 `0x20` 再量，并把 `BELOW_NORMAL` 的对照一起打出来。
> 教训：**测量环境没锁死，数字就只是那一次巧合**。

**为什么不能用「平均 8.5 ms」来判断影响**：平均值的分母是「一秒」，而真正的问题是
**事件循环停顿**——宿主进程同时负责流式输出 token、处理 HTTP、跑工具。同步的全表枚举
会把这些全部冻住 8.5 ms。用 `perf_hooks.monitorEventLoopDelay` 直接量（`setInterval(1)`
在 Windows 上量不出来，定时器粒度本身就是 15.6 ms，会把真实停顿完全淹没）：

| 场景 | p50 | p95 | p99 | 最大 |
|---|---|---|---|---|
| 不采样（对照） | 15.25 ms | 16.02 ms | 16.27 ms | 17.7 ms |
| 每 2 秒采一次 | 15.30 ms | 15.97 ms | 16.11 ms | 21.3 ms |
| 每 500 ms 采一次（4×） | 15.34 ms | 16.07 ms | 19.43 ms | 65.7 ms |

按线上节拍（2 秒一次），p95 与 p99 **和对照组没有区别**，只有最大值从 17.7 抬到 21.3 ms。
按 8.5 ms / 2 s 算，常驻成本约为**单核的 0.43%**。

#### 一个真的踩到的坑：采样频率曾随窗口数放大

第一版 `TreeSampler.sample()` 是**每个 `/stats` 请求都真采一次**。而浏览器侧每个窗口
各跑一个 `StatusPill`，各自 `setInterval` —— 于是开 4 个窗口就是 4×8.5 ms 的同步冻结，
8 个窗口实测 6 秒内累计冻结 **249 ms**（每 2 秒一次，肉眼可感的流式输出顿挫）。
接口看起来是「无状态、纯函数」，实际藏了一个 O(窗口数) 的放大器。

> 这组数字是当时在 `below-normal` 下测的，换成现在的 `on-pressure` 会一并缩到约一半，
> 但**放大器的结构性问题与优先级无关**，所以修法不变。

修法：`TreeSampler` 加 `minIntervalMs`（默认 1000），间隔内的请求直接返回上次结果，
并发请求共享同一个 Promise。效果（8 窗口 × 6 秒）：

```
旧：枚举 17 次 / 累计冻结 249 ms
新：枚举  3 次 / 累计冻结  45 ms
```

代价是读数最多陈 1 秒 —— 底栏本来就 2 秒刷一次，看不出来。`npm test` 里
`host-api.test.mjs` 与 `npm run soak` 各有一条守着「8 个并发轮询只枚举一次」。

**为什么不用更省的方案**：可以把 `statusPillIntervalMs` 调大，但面板的意义就在「实时」。
8.5 ms / 2 秒 = 单核 **0.43%** 换一个能实时看到「整机被谁吃了」的面板，是划算的；
嫌贵就调到 5000（成本减半，且不影响门禁本身）。

#### 常驻内存

`node --expose-gc` 前后差量（`scripts/measure-impact.mjs`）：

| 项 | heapUsed | RSS |
|---|---|---|
| import 整个护栏模块 | +0.02 MB | +0.04 MB |
| 一次采样后（留着快照算 CPU 差值） | +0.06 MB | +0.18 MB |
| 再采 50 次后 | +0.07 MB | +0.19 MB |
| 护栏自身 100 次 tick 后 | +0.13 MB | +0.28 MB |

**不到 1 MB**。快照序列化后只有 **297 字节** —— 因为 `top` 只留 5 条进程明细，
不是把 419 个进程全存下来。浏览器那半边打包后 30 kB（gzip 10.2 kB）。

采样过程中的瞬时分配（419 个进程对象）是短命对象，采完就进新生代回收，
所以在「采完再 GC」的口径下不用额外加一条 RSS 曲线 —— `npm run soak` 里
100 次采样后 heap Δ **0 MB** 验的就是这件事。

#### 一处「省了但不快」的优化，写在这里免得被误读

`readProcessUsage` / `readSystemTimes` 早先每个进程都现 `Buffer.alloc` 四五个读缓冲，
后来改成模块级复用（`lib/tree-stats.js` 的 `scratch`）。**它没有让采样变快**：

| 口径 | 现分配 | 复用 | 差 |
|---|---|---|---|
| 429 进程全表枚举（交替 12 轮取中位） | 10.90 ms | 11.02 ms | **−0.11 ms（噪声）** |
| 416 进程 × 60 轮枚举的 GC 次数 | **17 次** | **0 次** | −17 次 |
| 同上，堆峰值 | 7.69 MB | 6.30 MB | −1.39 MB |

墙钟收益是零 —— 416×60 次枚举才 2.4 万个 112 字节缓冲（约 2.7 MB），V8 随手就收掉了。
真正的收益只有「不在事件循环上制造垃圾」这一条，按 5 秒一轮采样算，一天省下约 300 次
新生代 GC。**写清楚是因为：不写清楚，后来的人会以为它让采样变快了，然后照着这个
思路继续做无收益的「优化」。**

反过来说，真正值得做的那两处**确实有量**（`npm run bench` 之外单独量的）：

| 优化 | 改动前 | 改动后 | 倍数 |
|---|---|---|---|
| `isHeavyTool` 现编译正则 → 按 policy 缓存 | 915 ns/次 | 33 ns/次 | **27.5×** |
| 多窗口并发采样的合并 | 8 窗口 → 17 次枚举 / 冻 249 ms | 3 次枚举 / 冻 45 ms | **5.5×** |

`isHeavyTool` 是每次工具调用都要过的路径，915 ns 相对一次 pwsh 冷启动仍然微不足道，
但它是「无理由的白付」——配置驱动的名单在插件生命周期内不会变，没有理由每个调用重编译一遍。

#### 一个真踩到的坑：below-normal 会让工具慢 2~3 倍

第一版把 `priority` 的默认值定成 `below-normal` —— 「降优先级换前台流畅」听起来无懈可击，
直到在这台机器上量了一次（i7-13700，**8 个 P 核 + 8 个 E 核**，交替 6 轮取中位）：

| 场景 | NORMAL | BELOW_NORMAL | 倍数 |
|---|---|---|---|
| 单线程计算 1000 万次 | 94 ms | 300 ms | **×3.18** |
| CPU 密集子进程（工具形态，~3 s 负载） | 8051 ms | 18237 ms | **×2.27** |
| 4 个并行 CPU 子进程 | 1664 ms | 3571 ms | **×2.15** |
| I/O 密集子进程 | 295 ms | 322 ms | ×1.09 |

排除掉其它解释，只剩一个：

1. 是同一个核上跑得慢（降频）？**不是** —— 钉到 P 核上两者都是 111 ms，钉到 E 核上都是 347 ms，各自 ×1.00。
2. 是不钉核时被排到 E 核？**是** —— 不钉核：NORMAL 94 ms / BELOW 300 ms = ×3.18。

Windows 的调度器倾向于把低优先级线程放到能效核（E 核）上。8 个 E 核的单线程性能只有 P 核的 1/3，
而**单线程 CPU 密集的工具根本用不到「多出来的核」**，所以这 3 倍是实打实要付的。
更麻烦的是**子进程继承优先级类**：DSH 拉起的 `pwsh`/`node` 一起慢（实测 ×2.68），
也就是你在这台机器上敲的每条命令、每个 subagent 都在付这笔钱。

而且「机器闲着就没事」这个辩解不成立：闲不闲跟排到哪个核是两回事，
只有在硬钉住核时才会看到 ×1.00。

**所以默认值改成了 `on-pressure`**：平时保持原优先级，进入 warn/critical 才降，压力解除立刻恢复。
之所以敢这么做，是因为恢复是**即时且彻底**的（实测切回 NORMAL 立刻 94 ms，1.00×，不需要等线程迁移）：

| 开关 | 行为 |
|---|---|
| `on-pressure`（默认） | 平时全速，`warn` 及以上才让位，回 `normal` 立刻恢复 |
| `below-normal` | 启动即永久降级（第一版行为），退出时恢复 |
| `unchanged` | 从不碰优先级 |

**这不是「优先级升高了会让前台卡」**——`on-pressure` 在压力大时仍然让位，只是不再无条件让位。
代价要付在真缺内存的时候，而不是全天候。

如果你确定自己只在「DSH 独占用整机」的场景跑，`below-normal` 依然是合理选择（它更早让位给前台）。
但如果你在混合核 CPU（Intel 12 代以后）上跑 CPU 密集的工具，务必先用 `npm run bench` 量一遍再决定。

### 可靠性：泄漏、并发与降级

```powershell
npm run soak
# 7000 次热路径调用后：heapUsed 5.3 → 5.4 MB（Δ 0.1），RSS Δ 3 MB
# PASS: 热路径无明显泄漏（heap Δ 0.1 MB < 8 MB）
# PASS: 采样计数准确（7000）
# PASS: 树采样无明显泄漏（heap Δ 0 MB < 8 MB）
# PASS: 8 个窗口同时轮询只复用缓存（新增枚举 0 次，期望 0）
# PASS: 8 个并发请求拿到同一份读数
# PASS: 200 个并发门禁全部放行（normal 等级）
# PASS: 并发下采样计数无丢失（200）
# PASS: 并发下没有误拦（denied=0）
# PASS: 迟滞生效，交错抖动时等级不跳变
# PASS: 连续 3 次越线后升级为 critical
# PASS: 连续 3 次回线后降回 normal
# PASS: dispose() 可重复调用（无异常）
```

```powershell
npm run verify:degrade
# PASS: 无能力层时仍能定级 / gate 不抛 / start-dispose 不抛
# PASS: 能力位如实报告 win32=false
```

**为什么这两条必须单独存在**：单元测试每次都是新实例，测不出「连续用几小时后护栏突然失灵」；
而市场用户很可能在 koffi 加载失败的环境里跑，那时**宁可退化为纯观测，也不能崩**。
代码里所有副作用都走「失败只降级」：`gate()` 自身抛错时放行（宁可漏拦一次，
也不要把模型卡死在一条假错误上）。

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
# PASS: 插件已以包名挂进 profile node_modules（dsh-rampart）
# PASS: 探针在真实 composition 里执行了
# PASS: pwsh 被拒绝（isError）
# PASS: 错误码为 RESOURCE_GUARD_DENIED
# PASS: pwsh 的副作用没有发生（标记文件不存在）
# PASS: 返回了压力等级（critical，钉死阈值后必须是 critical）
# PASS: 计数被拦次数（1）
```

即：headless profile 真加载插件 → 真调 `pwsh` → 被拦 → **命令的副作用文件确实没被创建**。

> 这条验收以前是**随机通过**的：它用「按本机实测调的」阈值，机器空闲时等级就是 `normal`，
> 门禁根本不触发。现在阈值钉成不可能达到的值，`critical` 是确定状态。
> 教训：**验收里的输入必须钉死，不能跟着环境走**。

### 底栏读数条（真 web 服务，隔离 profile）

```powershell
npm run verify:pill
# PASS: boot 图里有 dsh-rampart/client.js
# PASS: combo 脚本可下载（实际 200）
# PASS: 下载到的字节里有我们的 CSS 类名
# PASS: GET /rampart/api/stats → 200（应当 200）
# PASS: 带压力等级（normal）/ Win32 能力层可用 / 整树提交量有值（408 MB）
# PASS: POST /rampart/api/gc 回收成功（freed 66.7 MB）
# PASS: 不带 cookie → 403（围栏生效而不是路由缺失）
```

即：干净进程真加载客户端半边 → boot 图里真有这条 combo → 真下到字节 →
宿主路由真返回本机读数 → 真回收了一次堆。

### 真实桌面宿主（已装在本机，证据见 `deploy-desktop.md`）

- 拦下时我这个 agent 直接收到 `RESOURCE_GUARD_DENIED`，而不是「配置写对了」的推断
- `warn` 档 `delayedCalls` 涨了 → 门禁确实在真实调用链上
- `disabled: true` 后优先级从 `BelowNormal` 回到 `Normal`，改回来又变 `BelowNormal` → 可逆
- 优先级沿进程树继承：host `BelowNormal` → runner `BelowNormal` → powershell `BelowNormal`
  （**这正是它必须改成按需触发的原因** —— 继承让每一个工具进程都一起慢，见上文性能一节）
- `on-pressure` 下真机来回切：无压力 `0x20` → warn `0x4000` → 回线 `0x20` → dispose 仍 `0x20`

---

## 踩过的坑（留给下一个人）

| 坑 | 表现 | 真相 |
|---|---|---|
| Job 内存限额偏移 | `SetInformationJobObject` 返回 0 | x64 上 `ProcessMemoryLimit` 在 **112**、`JobMemoryLimit` 在 **120**（`BasicLimitInfo` 是 64 字节，不是 48）。写在 64/72 会被内核拒绝 |
| `AssignProcessToJobObject` | `ERROR_ACCESS_DENIED(5)` | 少 `PROCESS_TERMINATE(0x1)`。这个错误码完全指错方向，看起来像「没权限」 |
| 本进程已在 Job 里 | `CREATE_BREAKAWAY_FROM_JOB` 也返回 5 | DSH 的沙箱已把进程放进 Job。**不 breakaway 直接 assign 反而成功**（Windows 8+ 嵌套 Job） |
| 短命进程采样 | 峰值报 2 MB | 0.3 秒就结束的命令一次都采不到；要读 Job 的 `PeakProcessMemoryUsed` |
| schemastery 依赖 | `file://` 加载时报 `Cannot find module` | Node 从插件目录向上找 `node_modules`，那里没有 DSH 的包 |
| 加了 `dsh.client` 却看不到读数条 | 插件在跑，底栏什么都没有 | `dsh-client-modules` 把「这个包不是客户端包」这个**否定结论按 Loader specifier 缓存到进程结束**（`pkgMeta` 从不清理）。**第一次加 `dsh.client` 必须重启 Electron**，HMR 救不了 |
| 手拼 `/plugins/??<id>/client.js` 拿到 404 | 连内置包也 404 | 该路由只认识**已组合好的批次 URL**：`bundleResource` 用完整的 `pathname+search` 去 `responses` / `batchResponses` 查表。要从首页 HTML 里取真实 combo URL |
| 客户端 `fetch` 报 `Failed to fetch` | 宿主路由明明在，浏览器就是打不通 | 桌面 shell 的页面是 `dsh-app://app/`。用宿主真实地址（`streamBaseUrl`）就是跨源，而插件路由不发 CORS 头。必须用**页面同源的相对路径** |
| 路由返回 400 而不是 404/403 | 看起来像路径写错 | 在 `trustOf` 里直接写 `ctx.connection` —— cordis 里**访问未声明服务的属性本身会抛**，被 webserver 统一转成 400。要用 `ctx.get('connection')` 并包在 try 里 |
| 改了插件的 `lib/*.js` 却像没生效 | HMR 没反应 | HMR 只监视 profile 的 `cordis.patch.yml` / `package.json`。改插件代码后要 touch 一下 patch 才会重新 `import` |
| 面板半透明、读数看不清 | 数字后面透出对话正文 | `--dsw-specific-menu` 本身是半透明的（浅色 `#f8f9fa94` / 深色 `#43454a73`）。只写 `background` 不够，必须同时给 `backdrop-filter: var(--dsw-menu-backdrop-filter)` —— DSH 自己那三块面板都这么写 |
| 读数值想着「排在上下文环右边」，改 `order` 没用 | 还是在最左边 | 上下文环**不经过 slot**，是 `InputBar` 在 dock 末尾硬编码渲染的。slot 的 `order` 只在 slot 内部排序；要越过它得给自己加 CSS `order`（slot 外壳是 `display:contents`，我们的根节点就是 dock 的 flex item） |
| DSH 的占比在图上「消失」 | 明明在用，条里看不见蓝 | 百分比被夹成整数：0.4% → 0 → 被 `filter(share > 0)` 丢掉。占比要保留一位小数 |
| 「其他已用」算出负数 | 蓝段溢出轨道 | DSH 的提交量可能**大于**整机已用物理（换页 / 共享页）。必须先把 DSH 夹进「整机已用」，再算「其他 = 已用 − DSH」 |
| 验收脚本「全 PASS 却退出码 1」 | PowerShell 把 stderr 当失败 | `spawnSync(cmd, args, { shell: true })` 会发 DEP0190 警告到 stderr。改成把整条命令行交给 ComSpec、参数数组留空 |
| 门禁验收**随机**通过或失败 | 机器空闲时等级是 normal | 阈值跟着本机实测内存走，护栏就不触发。**验收的输入要钉死**：设成不可能达到的值，`critical` 才是确定状态 |

---

## 目录

```
lib/pressure.js    纯逻辑：分级、迟滞、重活判定、决策（无副作用，可单测）
lib/guardian.js    运行时：采样、装/撤可逆限制、门禁
lib/win32.js       Win32 能力层：内存读数、优先级、亲和性、冻结、Job
lib/config.js      StandardSchemaV1 配置校验
lib/index.js       插件入口：pre-execute 门禁 + resource_guard 工具 + 读数路由
lib/tree-stats.js  整树读数：Toolhelp 枚举、按提交量求和、CPU 按 GetSystemTimes 差值算
lib/host-api.js    /rampart/api 的 HTTP 处理器（stats / gc / 404 / 405）
lib/gc.js          本进程 V8 堆的强制回收（不需要 --expose-gc 启动参数）
client/source.js   浏览器半边：读数条 + 分段占比面板（ESM 源码，人读的那份）
lib/client.js      上面那份经 scripts/build-client.mjs 机械转换后的产物（serve 层加载这个）
scripts/build-client.mjs 只改 import/export 的构建脚本，转完会跑一次真语法校验
scripts/make-icon.py 生成 assets/icon-{1024,180}.png（深蓝底 + 白色城垛）
scripts/launch.mjs 启动壳 CLI
scripts/launcher.mjs 启动壳实现（Job 整树硬顶）
scripts/verify-*.mjs 真机验收（可逆性 / Job 内核语义 / 启动壳 / 真 profile / 读数条 / 降级）
scripts/bench.mjs  热路径性能基准（gate / tick / 整树采样 / 纯函数决策）
scripts/soak.mjs   可靠性浸泡（泄漏、并发门禁、迟滞抖动、dispose 幂等）
scripts/preview-panel.mjs 用无头 Chrome 把面板截成图（验观感，不跑 DSH）
scripts/*-probe.js 只在 .verify profile 里挂载的探针
scripts/probe-*.cjs 一次性诊断探针（错误码、偏移量），留着是因为它们是那些教训的证据
test/              72 条（pressure 19 / tree-stats 16 / guardian 14 / config 10 / integration 5 / client 契约 8）
```

发布相关的信息（命名取舍、npm/GitHub/市场三处各要什么、格式 1 索引示例）见
[`PUBLISHING.md`](PUBLISHING.md)。

## 一个必须改的地方：重活名单

默认名单是 `pwsh / bash / shell / workflow / subagent / subagent_fork / send_message / web_fetch / web_search / job_*`。
判断标准是「会不会拉子进程或扇出并发」。如果你的常用流程里有某个被误伤，在 patch 里覆盖：

```yaml
- id: rampart
  name: 'dsh-rampart'
  config:
    heavyTools: ['pwsh', 'bash']
    heavyPatterns: []
```

注意 `interrupt_agent` **故意不在名单里** —— 压力大时取消子代理是降压动作，不该被拦。

