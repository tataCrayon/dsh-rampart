# dsh-resource-guard

给 DeepSeek Harness 加一层**内存/CPU 压力护栏**：机器快被吃穿时先踩刹车，而不是等它卡死。

两层，各管一件事：

| 层 | 干什么 | 在哪 |
|---|---|---|
| **插件**（软） | 采样可用内存 → 分 normal/warn/critical → 降优先级、钉核、拦重活、给模型读数据 | `lib/` |
| **启动壳**（硬） | 给整棵 Electron 进程树套 Job Object 内存硬顶，撞上就被系统拒绝 | `scripts/launch.mjs` |

外加**输入框下方的一条读数**（`CPU 12% · DSH 1.2 GB`），点开是 IDEA 式的详情面板，
带一个「释放内存」按钮。数据不走模型，是浏览器直接打宿主路由取的本机读数。

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
| `showStatusPill` | `true` | 是否挂输入框下方的读数条 + `/resource-guard/api/*` 路由 |
| `statusPillIntervalMs` | 2000 | 读数条轮询间隔；低于 500 会被夹到 500 |

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

## 底栏读数条（IDEA 那套）

输入框下面，跟着 DSH 自己的 `154 tok/s`、`缓存命中 49%` 并排放一条：

```
CPU 12% · DSH 1.2 GB
```

- **normal** → 灰色（与内置统计条同一个 tertiary 前景色）
- **warn** → 变警示色
- **critical** → 前置一个实心点 + 警示色

点开是面板：整机可用物理/提交、整机 CPU、DSH 进程树（进程数 + 提交量 + CPU 占比）、
已拦/降速计数、本进程 JS 堆，以及一个 **「释放内存」** 按钮。

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
浏览器 ──GET /resource-guard/api/stats──▶ 宿主 webServer 路由 ──▶ GetSystemTimes / Toolhelp32 / GetProcessMemoryInfo
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

### 单元 / 集成测试（69 条全绿）

```powershell
npm test
# ℹ tests 69  ℹ pass 69  ℹ fail 0
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

### 底栏读数条（真 web 服务，隔离 profile）

```powershell
npm run verify:pill
# PASS: boot 图里有 dsh-resource-guard/client.js
# PASS: combo 脚本可下载（实际 200）
# PASS: 下载到的字节里有我们的 CSS 类名
# PASS: GET /resource-guard/api/stats → 200（应当 200）
# PASS: 带压力等级（normal）/ Win32 能力层可用 / 整树提交量有值（408 MB）
# PASS: POST /resource-guard/api/gc 回收成功（freed 66.7 MB）
# PASS: 不带 cookie → 403（围栏生效而不是路由缺失）
```

即：干净进程真加载客户端半边 → boot 图里真有这条 combo → 真下到字节 →
宿主路由真返回本机读数 → 真回收了一次堆。

### 真实桌面宿主（已装在本机，证据见 `deploy-desktop.md`）

- 拦下时我这个 agent 直接收到 `RESOURCE_GUARD_DENIED`，而不是「配置写对了」的推断
- `warn` 档 `delayedCalls` 涨了 → 门禁确实在真实调用链上
- `disabled: true` 后优先级从 `BelowNormal` 回到 `Normal`，改回来又变 `BelowNormal` → 可逆
- 优先级沿进程树继承：host `BelowNormal` → runner `BelowNormal` → powershell `BelowNormal`

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

---

## 目录

```
lib/pressure.js    纯逻辑：分级、迟滞、重活判定、决策（无副作用，可单测）
lib/guardian.js    运行时：采样、装/撤可逆限制、门禁
lib/win32.js       Win32 能力层：内存读数、优先级、亲和性、冻结、Job
lib/config.js      StandardSchemaV1 配置校验
lib/index.js       插件入口：pre-execute 门禁 + resource_guard 工具 + 读数路由
lib/tree-stats.js  整树读数：Toolhelp 枚举、按提交量求和、CPU 按 GetSystemTimes 差值算
lib/host-api.js    /resource-guard/api 的 HTTP 处理器（stats / gc / 404 / 405）
lib/gc.js          本进程 V8 堆的强制回收（不需要 --expose-gc 启动参数）
client/source.js   浏览器半边：底栏读数条 + IDEA 式面板（ESM 源码，人读的那份）
lib/client.js      上面那份经 scripts/build-client.mjs 机械转换后的产物（serve 层加载这个）
scripts/build-client.mjs 只改 import/export 的构建脚本，转完会跑一次真语法校验
scripts/launch.mjs 启动壳 CLI
scripts/launcher.mjs 启动壳实现（Job 整树硬顶）
scripts/verify-*.mjs 真机验收（可逆性 / Job 内核语义 / 启动壳 / 真 profile / 底栏读数条）
scripts/verify-deny-probe.js 只在 .verify profile 里挂载的探针
scripts/probe-*.cjs 一次性诊断探针（错误码、偏移量），留着是因为它们是那些教训的证据
test/              69 条（pressure 19 / tree-stats 16 / guardian 14 / config 10 / integration 5 / client 契约 5）
```

## 一个必须改的地方：重活名单

默认名单是 `pwsh / bash / shell / workflow / subagent / subagent_fork / send_message / web_fetch / web_search / job_*`。
判断标准是「会不会拉子进程或扇出并发」。如果你的常用流程里有某个被误伤，在 patch 里覆盖：

```yaml
- id: resource-guard
  name: 'dsh-resource-guard'
  config:
    heavyTools: ['pwsh', 'bash']
    heavyPatterns: []
```

注意 `interrupt_agent` **故意不在名单里** —— 压力大时取消子代理是降压动作，不该被拦。

