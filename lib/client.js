window.__ModuleLoader__.load({
	tagId: "dsh-rampart/client",
	id: "dsh-rampart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/**
		 * 浏览器侧：输入框下方那条内存 / CPU 读数。
		 *
		 * ## 位置与观感
		 *
		 * 挂在 `conversation.composer.dock` —— DSH 自己把那几个统计 pill（`154 tok/s`、
		 * `缓存命中 49%`）放在这里。但 DSH 的**上下文占用环**（`38%`）不经过 slot，它是
		 * `InputBar` 在 dock 末尾硬编码渲染的，排在所有 slot 条目之后。
		 *
		 * 所以「排到上下文环右边」不能靠 `order` 选项（那只管 slot 内部排序），只能用
		 * CSS：dock 是 flex 容器，slot 外壳是 `display:contents`，我们的根 `<span>` 因此
		 * 是 dock 的直接 flex item —— 给它 `order:1` 就落到默认 0 的上下文环之后。
		 *
		 * 字号、前景色、`tabular-nums` 都跟着内置统计条走，让人一眼看出「这是同一类东西」。
		 *
		 * ## 面板为什么与上下文面板同底
		 *
		 * `--dsw-specific-menu` 是**半透明**的（浅色主题 `#f8f9fa94`），只配 `background`
		 * 不配 `backdrop-filter` 会直接看到下面的对话文字，读数根本看不清。DSH 自己那三块
		 * 面板（上下文 / 统计 / todo）都是「半透明底 + `backdrop-filter: var(--dsw-menu-backdrop-filter)`
		 * + 用 `--dsw-elevation-stroke-color` 让阴影带描边」。这里照抄同一组声明，
		 * 不去发明新配色。
		 *
		 * ## 为什么自己轮询，而不是走 `slots.register` 的 `hooks`
		 *
		 * `hooks` 只能拿到 DSH 已投影好的会话数据，拿不到「读机器状态」。所以用 `fetch`
		 * 打宿主路由（`/rampart/api/stats`）—— 与 dsh-better-sidebar 取数同一个路子，
		 * 不经过模型、不花钱、不刷对话。
		 *
		 * ## 为什么这里写 ESM 而不是直接写成品 bundle
		 *
		 * 成品必须是 `window.__ModuleLoader__.load({id, factory})` 包起来的 CJS。
		 * 手写那个壳子能跑，但改一行要人肉维护两份。所以这里写 ESM，由
		 * `scripts/build-client.mjs` 做「只改 import/export」的机械转换，转完还要过语法校验 ——
		 * 不是靠约定。
		 */

		const { useEffect, useRef, useState } = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");
		/** 与 DSH 内置统计条一致的样式；行内写死是为了免掉一次 CSS 构建。 */
		const CSS = `
		.RGpill_anchor{order:1;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
		.RGpill_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
		.RGpill_pill svg{flex:none;width:14px;height:14px}
		button.RGpill_pill{cursor:pointer}
		button.RGpill_pill:hover,button.RGpill_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
		.RGpill_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
		.RGpill_warn{color:var(--dsw-alias-state-warning-primary,#b8860b)}
		.RGpill_critical{color:var(--dsw-alias-state-error-primary,#d33)}
		.RGpill_dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
		.RGpill_panel{position:fixed;z-index:1100;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px}
		.RGpill_row{display:flex;justify-content:space-between;gap:12px;padding:2px 0}
		.RGpill_row .RGpill_key{color:var(--dsw-alias-label-tertiary)}
		.RGpill_row .RGpill_val{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
		.RGpill_title{display:flex;align-items:center;justify-content:space-between;font-weight:600;color:var(--dsw-alias-label-primary)}
		.RGpill_badge{border-radius:var(--dsw-radius-sm);padding:0 6px;font-weight:500;font-size:11px}
		.RGpill_rule{height:1px;background:var(--dsw-alias-border-l1);margin:10px 0}
		.RGpill_meter{margin:10px 0 0}
		.RGpill_meterHead{display:flex;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-tertiary)}
		.RGpill_meterHead b{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
		.RGpill_bar{corner-shape:round;display:flex;gap:1px;height:6px;margin-top:6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}
		.RGpill_seg{flex:none;min-width:2px;height:100%;border-radius:1px;background:var(--meter-tint,var(--dsw-alias-label-tertiary));transition:width .3s ease}
		.RGpill_legend{display:flex;flex-wrap:wrap;gap:2px 10px;margin-top:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
		.RGpill_legendItem{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
		.RGpill_swatch{vertical-align:baseline;display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--meter-tint)}
		.RGpill_tintDsh{--meter-tint:var(--dsw-static-blue-450)}
		.RGpill_tintUsed{--meter-tint:var(--dsw-static-neutral-bluish-400)}
		.RGpill_tintReserve{--meter-tint:var(--dsw-alias-state-warning-primary,#b8860b)}
		.RGpill_tintFree{--meter-tint:var(--dsw-alias-interactive-bg-hover)}
		.RGpill_action{box-sizing:border-box;width:100%;margin-top:10px;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
		.RGpill_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
		.RGpill_action:disabled{opacity:.55;cursor:default}
		.RGpill_note{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
		.RGpill_reserve{margin-top:2px}
		.RGpill_reserve b{font-variant-numeric:tabular-nums;font-weight:500}
		.RGpill_range{box-sizing:border-box;width:100%;margin:6px 0 2px;accent-color:var(--dsw-alias-state-warning-primary,#b8860b)}
		.RGpill_controls{display:flex;align-items:center;gap:6px;margin-top:2px}
		.RGpill_number{box-sizing:border-box;width:72px;padding:2px 6px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums}
		.RGpill_unit{color:var(--dsw-alias-label-tertiary);font-size:11px}
		.RGpill_mini{box-sizing:border-box;padding:2px 8px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
		.RGpill_mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
		.RGpill_mini:disabled{opacity:.55;cursor:default}
		`

		const STYLE_TAG_ID = 'rampart/StatusPill.css'

		/** 依赖的客户端服务。 */
		const inject = ['slots', 'locale']

		/**
		 * 把 MB 变成人读的字符串。
		 * @param {number} mb 兆字节。
		 * @returns {string} 例如 `1.0 GB` / `860 MB`。
		 */
		function formatMb(mb) {
		  if (!Number.isFinite(mb) || mb <= 0) return '—'
		  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
		}

		/**
		 * 把一段占用量换算成占整机的百分比（0~100，一位小数）。
		 *
		 * 刻意**不**夹到整数：0.4% 的 DSH 占用夹成 0 会被 `filter(share > 0)` 整段丢掉，
		 * 于是「DSH 在用」这件事在图上直接消失，而它恰恰是最该被看见的那一段。
		 * @param {number} part 部分量。
		 * @param {number} whole 总量。
		 * @returns {number} 百分比。
		 */
		function shareOf(part, whole) {
		  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0 || part <= 0) return 0
		  return Math.round(Math.min(100, (part / whole) * 100) * 10) / 10
		}

		/**
		 * 取路由基址：页面自己的 base。
		 *
		 * 桌面 shell 把 `dsh-app://app/` 下的非静态路径同源转发到宿主，所以 HTTP 必须落在
		 * 页面的 base 上。用 `__DSH_TRANSPORT__.streamBaseUrl`（宿主真实地址）会因为跨源
		 * 被浏览器直接拒掉 —— 插件路由不发 CORS 头。
		 * @returns {string} 基址；非 DOM 环境返回空串。
		 */
		function apiBase() {
		  return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
		}

		/**
		 * 注入样式（幂等：同 id 只插一次，内容变了就地更新）。
		 *
		 * ## 为什么不是「有就跳过」
		 *
		 * 因为 HMR。改样式时模块会重新求值、组件重新挂载，但上一份 `<style>` 标签还挂在
		 * `document.head` 里，而这里如果只判断「存在就 return」，改完 CSS 刷新页面**看不到
		 * 任何变化** —— 排查半天才发现是被旧标签顶了。所以存在时还要比对内容，不一样就换掉。
		 * @returns {void}
		 */
		function ensureStyles() {
		  if (typeof document === 'undefined') return
		  const selector = `style[data-plugin-css="${STYLE_TAG_ID}"]`
		  const existing = document.querySelector(selector)
		  if (existing !== null) {
		    if (existing.textContent !== CSS) existing.textContent = CSS
		    return
		  }
		  const tag = document.createElement('style')
		  tag.dataset.plugin = 'dsh-rampart'
		  tag.dataset.pluginCss = STYLE_TAG_ID
		  tag.textContent = CSS
		  document.head.appendChild(tag)
		}

		/**
		 * 一次读数的最长等待时间（毫秒）。
		 *
		 * 轮询是「上一次拿到结果之后才排下一次」的自调度链（见 `StatusPill`），这样不会
		 * 堆积请求。代价是：**只要有一次 fetch 永不返回，整条链就停在那儿**，底栏从此
		 * 冻在最后一个数上，而且看不出是坏的。宿主重启、路由挂掉、代理吞掉连接都会这样。
		 */
		const FETCH_TIMEOUT_MS = 8000

		/**
		 * 带硬超时地拉一次 URL。
		 *
		 * 不直接用 `AbortSignal.timeout` + `AbortSignal.any`：那需要两个 API 都存在，
		 * 而且 `any` 缺失时还得退化 —— 三条路径里两条是死的。这里一个 controller
		 * 加一个定时器，所有浏览器都一样。
		 *
		 * ## 为什么还要 race 一次
		 *
		 * 光靠 `abort()` 只是**请求发出方的意图**：它保证不了对端一定把 promise 结掉。
		 * 宿主重启、连接被中间层吃掉、某些 fetch 实现忽略 signal 时，`await fetch(...)`
		 * 会一直悬着。而 `StatusPill` 的轮询是自调度链（拿到结果才排下一次），一次悬住
		 * 就是底栏永久冻死。所以这里不指望 fetch 守约：超时和外部取消都各自 reject
		 * 一个 promise，与 fetch 赛跑。
		 * @param {string} url 地址。
		 * @param {RequestInit} init 请求参数。
		 * @param {AbortSignal} [outer] 调用方信号（组件卸载时用它提前取消）。
		 * @param {number} [timeoutMs] 超时毫秒数，只给测试缩短用。
		 * @returns {Promise<Response>} 响应。
		 */
		async function fetchWithTimeout(url, init, outer, timeoutMs = FETCH_TIMEOUT_MS) {
		  const controller = new AbortController()
		  let timer
		  let onOuterAbort
		  const stopped = new Promise((_resolve, reject) => {
		    timer = setTimeout(() => {
		      controller.abort()
		      reject(new Error(`timeout after ${timeoutMs}ms`))
		    }, timeoutMs)
		    onOuterAbort = () => {
		      controller.abort()
		      reject(new Error('aborted'))
		    }
		    if (outer?.aborted === true) onOuterAbort()
		    else outer?.addEventListener('abort', onOuterAbort, { once: true })
		  })
		  // 输了比赛也要把这个 rejection 消化掉，否则未处理的 rejection 会冒到控制台。
		  stopped.catch(() => {})
		  try {
		    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), stopped])
		  } finally {
		    clearTimeout(timer)
		    outer?.removeEventListener('abort', onOuterAbort)
		  }
		}

		/**
		 * 拉一次读数。
		 * @param {AbortSignal} [signal] 取消信号。
		 * @param {number} [timeoutMs] 超时毫秒数，只给测试缩短用。
		 * @returns {Promise<object | null>} 读数；失败时 null。
		 */
		async function fetchStats(signal, timeoutMs) {
		  try {
		    const response = await fetchWithTimeout(
		      new URL('rampart/api/stats', apiBase()).href,
		      { method: 'GET', headers: { accept: 'application/json' } },
		      signal,
		      timeoutMs,
		    )
		    if (!response.ok) return null
		    const payload = await response.json()
		    return payload?.ok === true ? payload : null
		  } catch {
		    return null
		  }
		}

		/**
		 * 触发一次「释放内存」。
		 * @param {number} [timeoutMs] 超时毫秒数，只给测试缩短用。
		 * @returns {Promise<object>} 结果（失败也返回对象，便于直接显示）。
		 */
		async function requestGc(timeoutMs) {
		  try {
		    // GC 要等同步回收跑完才返回，可以慢，但不能没有上限：一个卡住的请求会让
		    // 按钮永远停在「处理中」。
		    const response = await fetchWithTimeout(
		      new URL('rampart/api/gc', apiBase()).href,
		      { method: 'POST', headers: { accept: 'application/json' }, body: '' },
		      undefined,
		      timeoutMs,
		    )
		    return await response.json()
		  } catch (error) {
		    return { ok: false, error: String(error) }
		  }
		}

		/**
		 * 改预占额度。
		 *
		 * 传 `undefined` 表示「重置」—— 删掉用户层覆盖、回落到 patch 基线。两个动作共用一个
		 * 函数，因为它们的失败处理完全一样（超时/403/写盘失败都要让界面能收尾）。
		 * @param {number | undefined} mb 新的额度（MB）；`undefined` 表示重置。
		 * @param {number} [timeoutMs] 超时毫秒数，只给测试缩短用。
		 * @returns {Promise<object>} 结果（失败也返回对象，便于直接显示）。
		 */
		async function requestReserve(mb, timeoutMs) {
		  const reset = mb === undefined
		  try {
		    const response = await fetchWithTimeout(
		      new URL('rampart/api/reserve', apiBase()).href,
		      {
		        method: reset ? 'DELETE' : 'POST',
		        headers: { accept: 'application/json', 'content-type': 'application/json' },
		        body: reset ? undefined : JSON.stringify({ reserveMemoryMb: mb }),
		      },
		      undefined,
		      timeoutMs,
		    )
		    const payload = await response.json().catch(() => ({}))
		    return response.ok
		      ? { ...payload, requestedMb: mb }
		      : { ok: false, status: response.status, error: payload?.error ?? `HTTP ${response.status}` }
		  } catch (error) {
		    return { ok: false, error: String(error) }
		  }
		}

		/**
		 * 算百分比，夹在 0~100。
		 * @param {number} used 已用。
		 * @param {number} total 总量。
		 * @returns {number} 0~100 的整数。
		 */
		function percentOf(used, total) {
		  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0
		  return Math.max(0, Math.min(100, Math.round((used / total) * 100)))
		}

		/**
		 * 造一条「整机总量 = 多段占用」的占比条。
		 *
		 * 为什么不给每项各画一条：DSH 占用、整机已用、整机可用三个数共用**同一个分母**
		 * （整机物理内存 / 整机 CPU）。分开画会让人以为这是三件独立的事，实际它们是同一根
		 * 尺子上的三段。画成一根条之后，「这台机器还剩多少」是一眼的事。
		 *
		 * 语义是**已经用掉的灰、DSH 自己在用的蓝、剩下的留白**：灰就是「不可用」，
		 * 蓝是「这里面有我」，留白是「还能再吃」。
		 *
		 * @param {object} input 参数。
		 * @param {string} input.title 左侧说明（已翻译）。
		 * @param {string} input.right 右侧总数读数。
		 * @param {Array<{key: string, label: string, tint: 'Dsh'|'Used'|'Free', share: number, text: string}>} input.segments 分段（free 段只进图例，不画）。
		 * @param {boolean} [input.legend] 是否显示图例，默认显示。
		 * @returns {any} React 节点。
		 */
		function stackedMeter(input) {
		  const used = input.segments
		    .filter((segment) => segment.tint !== 'Free')
		    .reduce((sum, segment) => sum + segment.share, 0)
		  const drawn = input.segments.filter((segment) => segment.tint !== 'Free' && segment.share > 0)
		  return jsxs('div', {
		    className: 'RGpill_meter',
		    children: [
		      jsxs('div', {
		        className: 'RGpill_meterHead',
		        children: [
		          jsx('span', { children: input.title }),
		          jsx('b', { children: input.right }),
		        ],
		      }),
		      jsxs('div', {
		        className: 'RGpill_bar',
		        role: 'progressbar',
		        'aria-label': input.title,
		        'aria-valuenow': Math.round(Math.min(100, used)),
		        'aria-valuemin': 0,
		        'aria-valuemax': 100,
		        'aria-valuetext': input.segments.map((segment) => `${segment.label} ${segment.text}`).join('，'),
		        children: drawn.map((segment) =>
		          jsx(
		            'span',
		            {
		              className: `RGpill_seg RGpill_tint${segment.tint}`,
		              style: { width: `${segment.share}%` },
		            },
		            segment.key,
		          ),
		        ),
		      }),
		      input.legend === false
		        ? null
		        : jsx('div', {
		            className: 'RGpill_legend',
		            children: input.segments.map((segment) =>
		              jsxs(
		                'span',
		                {
		                  className: 'RGpill_legendItem',
		                  children: [
		                    jsx('i', {
		                      className: `RGpill_swatch RGpill_tint${segment.tint}`,
		                      'aria-hidden': true,
		                    }),
		                    `${segment.label} ${segment.text}`,
		                  ],
		                },
		                `legend-${segment.key}`,
		              ),
		            ),
		          }),
		    ],
		  })
		}

		/**
		 * 主组件：一行读数 + 可展开的面板。
		 * @param {object} props 属性。
		 * @param {number} [props.intervalMs] 轮询间隔。
		 * @param {(key: string) => string} [props.t] 本地化函数。
		 * @returns {any} React 节点。
		 */
		function StatusPill({ intervalMs = 2000, t }) {
		  const [stats, setStats] = useState(null)
		  const [open, setOpen] = useState(false)
		  const [busy, setBusy] = useState(false)
		  const [gcResult, setGcResult] = useState(null)
		  const [reserveBusy, setReserveBusy] = useState(false)
		  const [reserveResult, setReserveResult] = useState(null)
		  /** 输入框里的临时值（MB）。null = 跟随服务端读数，不覆盖。 */
		  const [draftReserve, setDraftReserve] = useState(null)
		  const anchorRef = useRef(null)
		  const panelRef = useRef(null)
		  const translate = typeof t === 'function' ? t : (key) => key

		  useEffect(() => {
		    ensureStyles()
		    const controller = new AbortController()
		    let timer
		    const tick = async () => {
		      const next = await fetchStats(controller.signal)
		      if (controller.signal.aborted) return
		      if (next !== null) setStats(next)
		      timer = setTimeout(tick, intervalMs)
		    }
		    tick()
		    return () => {
		      controller.abort()
		      clearTimeout(timer)
		    }
		  }, [intervalMs])

		  useEffect(() => {
		    if (!open) return undefined
		    const onPointerDown = (event) => {
		      if (anchorRef.current?.contains?.(event.target) === true) return
		      if (panelRef.current?.contains?.(event.target) === true) return
		      setOpen(false)
		    }
		    const onKeyDown = (event) => {
		      if (event.key === 'Escape') setOpen(false)
		    }
		    document.addEventListener('pointerdown', onPointerDown, true)
		    document.addEventListener('keydown', onKeyDown)
		    return () => {
		      document.removeEventListener('pointerdown', onPointerDown, true)
		      document.removeEventListener('keydown', onKeyDown)
		    }
		  }, [open])

		  if (stats === null) return null

		  const tree = stats.tree
		  const guard = stats.guard ?? {}
		  const grade = String(guard.grade ?? 'normal')
		  const cpuPercent = tree === null || tree === undefined ? null : Math.round(tree.cpuPercent)
		  const dshMb = tree === null || tree === undefined ? null : tree.commitMb

		  const parts = []
		  if (cpuPercent !== null) parts.push(`CPU ${cpuPercent}%`)
		  if (dshMb !== null) parts.push(`DSH ${formatMb(dshMb)}`)
		  if (parts.length === 0) return null

		  const readout = parts.join(' · ')
		  const warned = grade === 'warn'
		  const critical = grade === 'critical'
		  const ariaLabel = `${translate('guard.aria')}：${readout}`

		  const panelPosition = () => {
		    const rect = anchorRef.current?.getBoundingClientRect?.()
		    if (rect === undefined) return { top: 0, left: 0 }
		    const width = 320
		    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
		    return { top: Math.max(12, rect.top - 8), left, transform: 'translateY(-100%)' }
		  }

		  /**
		   * 造一行「键 → 值」。
		   *
		   * 用 `span` 而不是 `dt`/`dd`：`dl` 里混装 `div` 是非法结构，浏览器会重新排布，
		   * 表现是行距忽大忽小。全部用 `span` + flex 就没有这个问题。
		   * @param {string} labelKey 词典键。
		   * @param {string} value 值文本。
		   * @returns {any} React 节点。
		   */
		  const row = (labelKey, value) =>
		    jsxs('div', {
		      className: 'RGpill_row',
		      children: [
		        jsx('span', { className: 'RGpill_key', children: translate(labelKey) }),
		        jsx('span', { className: 'RGpill_val', children: value }),
		      ],
		    })

		  // ── 内存：整机物理 = DSH 提交 + 其他已用 + 轻活预占 + 空闲 ───────────────
		  // DSH 的「提交量」可能大于「整机已用物理」（有换页、有共享页），所以先夹一次；
		  // 夹完仍然可能出现 DSH > 已用（提交比物理占用高），那是正常的，别让蓝色溢出轨道。
		  //
		  // 预占那一段**从空闲里切出来**，不从「已用」里切：预占一个字节都没占用，
		  // 把它画进「已用」等于对用户谎报内存。它是「还剩这么多，但留给轻活」。
		  const totalMb = Math.max(0, guard.totalMb ?? 0)
		  const freePhysMb = Math.max(0, guard.availPhysMbRaw ?? guard.availPhysMb ?? 0)
		  const usedPhysMb = Math.max(0, totalMb - freePhysMb)
		  const dshPhysMb = Math.max(0, Math.min(dshMb ?? 0, usedPhysMb))
		  const otherPhysMb = Math.max(0, usedPhysMb - dshPhysMb)
		  const reserveMb = Math.max(0, Math.min(guard.reserveMb ?? 0, freePhysMb))

		  // ── CPU：整机忙 = DSH 忙 + 其他忙，剩下是空闲 ──────────────────────────
		  const busyPercent = Math.max(0, Math.min(100, cpuPercent ?? 0))
		  const dshCpuPercent = Math.max(0, Math.min(busyPercent, tree?.treePercent ?? 0))
		  const otherCpuPercent = Math.max(0, busyPercent - dshCpuPercent)

		  const heapUsedMb = stats.heap?.heapUsedMb ?? 0
		  const heapLimitMb = stats.heap?.heapLimitMb ?? 0

		  return jsxs('span', {
		    ref: anchorRef,
		    className: 'RGpill_anchor',
		    'data-composer-stat': 'rampart',
		    children: [
		      jsx('button', {
		        type: 'button',
		        className: `RGpill_pill${critical ? ' RGpill_critical' : warned ? ' RGpill_warn' : ''}`,
		        'aria-label': ariaLabel,
		        'aria-haspopup': 'dialog',
		        'aria-expanded': open,
		        title: guard.summary ?? readout,
		        onClick: () => setOpen(!open),
		        children: [
		          critical ? jsx('span', { className: 'RGpill_dot' }) : null,
		          jsx('span', { className: 'RGpill_label', children: readout }),
		        ],
		      }),
		      open
		        ? jsx('div', {
		            ref: panelRef,
		            className: 'RGpill_panel',
		            role: 'dialog',
		            'aria-label': ariaLabel,
		            style: panelPosition(),
		            children: jsxs('div', {
		              children: [
		                jsxs('div', {
		                  className: 'RGpill_title',
		                  children: [
		                    jsx('span', { children: translate('guard.title') }),
		                    jsx('span', { className: 'RGpill_badge', children: grade }),
		                  ],
		                }),
		                jsx('div', { className: 'RGpill_rule' }),
		                stackedMeter({
		                  title: translate('guard.meterMemory'),
		                  right: `${formatMb(usedPhysMb)} / ${formatMb(totalMb)} · ${percentOf(usedPhysMb, totalMb)}%`,
		                  segments: [
		                    {
		                      key: 'dsh',
		                      label: translate('guard.legendDsh'),
		                      tint: 'Dsh',
		                      share: shareOf(dshPhysMb, totalMb),
		                      text: formatMb(dshPhysMb),
		                    },
		                    {
		                      key: 'other',
		                      label: translate('guard.legendUsed'),
		                      tint: 'Used',
		                      share: shareOf(otherPhysMb, totalMb),
		                      text: formatMb(otherPhysMb),
		                    },
		                    {
		                      key: 'reserve',
		                      label: translate('guard.legendReserve'),
		                      tint: 'Reserve',
		                      share: shareOf(reserveMb, totalMb),
		                      text: formatMb(reserveMb),
		                    },
		                    {
		                      key: 'free',
		                      label: translate('guard.legendFree'),
		                      tint: 'Free',
		                      share: shareOf(Math.max(0, freePhysMb - reserveMb), totalMb),
		                      text: formatMb(Math.max(0, freePhysMb - reserveMb)),
		                    },
		                  ],
		                }),
		                tree === null || tree === undefined
		                  ? null
		                  : stackedMeter({
		                      title: translate('guard.meterCpu'),
		                      right: `${Math.round(busyPercent)}%`,
		                      segments: [
		                        {
		                          key: 'dsh',
		                          label: translate('guard.legendDsh'),
		                          tint: 'Dsh',
		                          share: dshCpuPercent,
		                          text: `${Math.round(dshCpuPercent)}%`,
		                        },
		                        {
		                          key: 'other',
		                          label: translate('guard.legendUsed'),
		                          tint: 'Used',
		                          share: otherCpuPercent,
		                          text: `${Math.round(otherCpuPercent)}%`,
		                        },
		                        {
		                          key: 'free',
		                          label: translate('guard.legendFree'),
		                          tint: 'Free',
		                          share: Math.max(0, 100 - busyPercent),
		                          text: `${Math.round(Math.max(0, 100 - busyPercent))}%`,
		                        },
		                      ],
		                    }),
		                stackedMeter({
		                  title: translate('guard.meterHeap'),
		                  right: `${formatMb(heapUsedMb)} / ${formatMb(heapLimitMb)} · ${percentOf(heapUsedMb, heapLimitMb)}%`,
		                  legend: false,
		                  segments: [
		                    {
		                      key: 'used',
		                      label: translate('guard.legendUsed'),
		                      tint: 'Used',
		                      share: shareOf(heapUsedMb, heapLimitMb),
		                      text: formatMb(heapUsedMb),
		                    },
		                  ],
		                }),
		                jsx('div', { className: 'RGpill_rule' }),
		                jsxs('div', {
		                  style: { margin: 0 },
		                  children: [
		                    row(
		                      'guard.heavyFree',
		                      reserveMb === 0
		                        ? formatMb(guard.availPhysMb ?? 0)
		                        : translate('guard.heavyFreeValue')
		                            .replace('{heavy}', formatMb(guard.availPhysMb ?? 0))
		                            .replace('{total}', formatMb(freePhysMb)),
		                    ),
		                    row('guard.commit', formatMb(guard.availCommitMbRaw ?? guard.availCommitMb)),
		                    row(
		                      'guard.tree',
		                      translate('guard.treeValue')
		                        .replace('{count}', String(tree?.processCount ?? 0))
		                        .replace('{size}', formatMb(dshMb ?? 0)),
		                    ),
		                    row('guard.denied', `${guard.deniedCalls ?? 0} / ${guard.delayedCalls ?? 0}`),
		                  ],
		                }),
		                jsx('button', {
		                  type: 'button',
		                  className: 'RGpill_action',
		                  disabled: busy,
		                  onClick: async () => {
		                    setBusy(true)
		                    const result = await requestGc()
		                    setBusy(false)
		                    setGcResult(result)
		                  },
		                  children: busy ? translate('guard.collecting') : translate('guard.collect'),
		                }),
		                jsx('div', {
		                  className: 'RGpill_note',
		                  children:
		                    gcResult === null
		                      ? translate('guard.note')
		                      : gcResult.ok === true
		                        ? translate('guard.done')
		                            .replace('{freed}', String(gcResult.freedMb))
		                            .replace('{ms}', String(gcResult.tookMs))
		                        : `${translate('guard.failed')}：${gcResult.error ?? 'unknown'}`,
		                }),
		                jsx('div', { className: 'RGpill_rule' }),
		                reserveEditor({
		                  translate,
		                  guard,
		                  reserveMb,
		                  busy: reserveBusy,
		                  result: reserveResult,
		                  draft: draftReserve,
		                  onDraft: setDraftReserve,
		                  onSubmit: async (mb) => {
		                    setReserveBusy(true)
		                    const result = await requestReserve(mb)
		                    setReserveBusy(false)
		                    setReserveResult(result)
		                    if (result.ok === true) setDraftReserve(null)
		                  },
		                }),
		              ],
		            }),
		          })
		        : null,
		    ],
		  })
		}

		/**
		 * 预占额度的调节区：一个滑杆 + 数字框 + 「重置」。
		 *
		 * ## 为什么是「滑杆 + 输入框」而不是只有滑杆
		 *
		 * 滑杆适合「感觉一下多少合适」，但它的精度取决于轨道宽度（320px 面板上大约
		 * 128 MB 一格），想精确填 1536 就只能靠输入框。两者绑定同一个值，谁改都算数。
		 *
		 * ## 为什么步进是 256 MB
		 *
		 * 预占本身是个粗旋钮：它决定「重活在还剩多少时让路」，差 100 MB 对判定没有意义。
		 * 步进 256 让滑杆从 0 到 4096 只用 16 格，手指能落在想落的位置上。
		 *
		 * @param {object} props 属性。
		 * @param {(key: string) => string} props.translate 本地化函数。
		 * @param {object} props.guard 护栏读数。
		 * @param {number} props.reserveMb 当前生效额度（已按空闲夹过）。
		 * @param {boolean} props.busy 是否有请求在飞。
		 * @param {object | null} props.result 上一次保存结果。
		 * @param {number | null} props.draft 输入框临时值。
		 * @param {(mb: number | null) => void} props.onDraft 改临时值。
		 * @param {(mb: number | undefined) => Promise<void>} props.onSubmit 保存；`undefined` 表示重置。
		 * @returns {any} React 节点。
		 */
		function reserveEditor({ translate, guard, reserveMb, busy, result, draft, onDraft, onSubmit }) {
		  const current = Math.round(guard.reserveMb ?? reserveMb)
		  // 填进去的值：用户上次填 2048、如今上限降到 1.7 GB 时，输入框仍应显示 2048，
		  // 否则用户会以为自己填错了，再去重填一遍。
		  const configured = Math.round(guard.reserveConfiguredMb ?? current)
		  const baseline = Math.round(guard.baseReserveMb ?? 0)
		  // 上限 = 「当前空闲 − critical 阈值」（宿主算好的）。滑杆与输入框都用它，
		  // 所以「把线画在比 critical 更激进的位置」在界面上就不可能发生 —— 那条线一旦
		  // 高过当前空闲，等于宣布「此刻重活已经越线」，滑到最右就全被拦了。
		  const ceiling = Math.max(0, Math.round(guard.reserveCeilingMb ?? 0))
		  const value = draft ?? configured
		  const clamped = ceiling > 0 && configured > ceiling
		  // 重活真正的拦截线：max(critical, 预占)。用户最需要知道的就是这个数 ——
		  // 它决定「空闲还剩多少时重活会被停掉」，而不是滑杆上的预占值本身。
		  const denyBelow = Math.round(guard.heavyDenyBelowMb ?? 0)
		  const note = reserveNoteText({ translate, result, baseline, current, ceiling, denyBelow, clamped })
		  return jsxs('div', {
		    className: 'RGpill_reserve',
		    children: [
		      jsxs('div', {
		        className: 'RGpill_row',
		        children: [
		          jsx('span', { className: 'RGpill_key', children: translate('guard.reserveLabel') }),
		          jsxs('span', {
		            className: 'RGpill_val',
		            children: [
		              formatMb(current),
		              ceiling > 0 ? ` / ${formatMb(ceiling)}` : '',
		            ],
		          }),
		        ],
		      }),
		      jsx('input', {
		        type: 'range',
		        className: 'RGpill_range',
		        min: 0,
		        // 滑杆的刻度跟着空闲走：空闲 1.7 GB 时还能拖到 4 GB，是明摆着在骗人。
		        max: Math.max(1, ceiling),
		        // 步进取上限的 1/16（约 100 MB），空闲很小的机器上也不至于一格跳完整个轨道。
		        step: Math.max(16, Math.round(ceiling / 16)),
		        value: Math.min(ceiling, value),
		        'aria-label': translate('guard.reserveLabel'),
		        disabled: busy,
		        onChange: (event) => onDraft(Number(event.target.value)),
		      }),
		      jsxs('div', {
		        className: 'RGpill_controls',
		        children: [
		          jsx('input', {
		            type: 'number',
		            className: 'RGpill_number',
		            min: 0,
		            max: ceiling,
		            step: 64,
		            value,
		            'aria-label': translate('guard.reserveInput'),
		            disabled: busy,
		            onChange: (event) => {
		              // 空串是「正在删掉重填」，直接当 0 会让光标跳位；用 NaN 表示未填完，
		              // 提交按钮据此禁用，用户看到的是「还差一个数」而不是一个假错误。
		              const raw = event.target.value
		              onDraft(raw === '' ? Number.NaN : Number(raw))
		            },
		          }),
		          jsx('span', { className: 'RGpill_unit', children: 'MB' }),
		          jsx('button', {
		            type: 'button',
		            className: 'RGpill_mini',
		            disabled: busy || !Number.isFinite(value) || value > ceiling,
		            onClick: () => onSubmit(value),
		            children: busy ? translate('guard.saving') : translate('guard.reserveSave'),
		          }),
		          jsx('button', {
		            type: 'button',
		            className: 'RGpill_mini',
		            disabled: busy || current === baseline,
		            title: translate('guard.reserveResetHint').replace('{base}', String(baseline)),
		            onClick: () => onSubmit(undefined),
		            children: translate('guard.reserveReset'),
		          }),
		        ],
		      }),
		      jsx('div', { className: 'RGpill_note', children: note }),
		    ],
		  })
		}

		/**
		 * 生成预占区下面那行说明。
		 *
		 * 三种状态必须能区分开，否则用户看不出「我改的到底生效了没有」：
		 * 保存失败 → 报错；保存成功 → 报新值；没有结果 → 解释这个旋钮在做什么。
		 * @param {object} input 参数。
		 * @returns {string} 说明文本。
		 */
		function reserveNoteText({ translate, result, baseline, current, ceiling, denyBelow = 0, clamped = false }) {
		  if (result !== null && result !== undefined) {
		    if (result.ok !== true) return `${translate('guard.reserveFailed')}：${describeFailure(result)}`
		    // 被夹住时必须说清楚：否则用户会以为「我明明填了 2 GB，为什么还是 1.7 GB」。
		    const reduced = typeof result.reserveMb === 'number'
		      && typeof result.requestedMb === 'number'
		      && result.reserveMb < result.requestedMb
		    if (reduced) {
		      return translate('guard.reserveClamped')
		        .replace('{asked}', String(result.requestedMb))
		        .replace('{mb}', String(result.reserveMb))
		    }
		    return translate('guard.reserveSaved').replace('{mb}', String(result.reserveMb))
		  }
		  const base = translate('guard.reserveBase').replace('{mb}', String(baseline))
		  const soft = clamped || baseline !== current
		    ? translate('guard.reserveOverridden').replace('{base}', String(baseline))
		    : translate('guard.reserveNote').replace('{mb}', String(current))
		  const limit = ceiling > 0 ? translate('guard.reserveCeiling').replace('{mb}', String(ceiling)) : ''
		  // 「重活会在空闲 ≤ X 时被停」比「预占是 Y」更接近用户真正要判断的事。
		  const deny = denyBelow > 0 ? translate('guard.reserveDenyBelow').replace('{mb}', formatMb(denyBelow)) : ''
		  const held = clamped
		    ? translate('guard.reserveHeld').replace('{mb}', formatMb(ceiling))
		    : ''
		  return [soft, base, limit, deny, held].filter((part) => part !== '').join(' ')
		}

		/**
		 * 把一次失败的响应翻译成人能看懂的一句话。
		 *
		 * ## 为什么不能直接把 `error` 原样贴出来
		 *
		 * 面板上曾经显示过「保存失败：not found」—— 那句话是**别的层**的措辞：
		 * 桌面 shell 把 `dsh-app://app/` 下的未知路径交给宿主 fallback，而 fallback
		 * 对没认领的路径回的就是 `not found`。用户看到的结论会是「插件坏了」，
		 * 真相却是「这个请求没走到我们的路由上」。
		 *
		 * 所以这里按状态码把自己能确定的事说清楚，并把「可能是哪一层拦的」写出来：
		 * 403 是围栏（cookie/同源），404 是路由没挂上（多数是宿主没重载新代码），
		 * 501 是宿主版本太老、还没有这个能力。
		 * @param {object} result 失败响应体（可能只有 `error`，也可能连 error 都没有）。
		 * @returns {string} 说明文本。
		 */
		function describeFailure(result) {
		  const raw = typeof result?.error === 'string' ? result.error : ''
		  const status = Number(result?.status)
		  if (status === 403) return '请求被围栏拒绝（页面不是同源，或 cookie 丢了）'
		  if (status === 404) return '宿主没有这个接口：多半是宿主还在跑旧代码，需要重载插件'
		  if (status === 501) return '宿主版本不支持改预占（缺少 setReserve 能力）'
		  if (status === 405) return '请求方法不对（改值用 POST，重置用 DELETE）'
		  return raw === '' ? '未知错误' : raw
		}

		/** 中文词典。 */
		const zh = {
		  'guard.title': '资源护栏',
		  'guard.aria': '资源护栏读数',
		  'guard.meterMemory': '整机物理内存',
		  'guard.meterCpu': '整机 CPU',
		  'guard.meterHeap': '本进程 JS 堆',
		  'guard.legendDsh': 'DSH',
		  'guard.legendUsed': '其他已用',
		  'guard.legendReserve': '预占',
		  'guard.legendFree': '空闲',
		  'guard.heavyFree': '重活可用物理',
		  'guard.heavyFreeValue': '{heavy}（原始 {total}）',
		  'guard.commit': '整机可用提交内存',
		  'guard.tree': 'DSH 进程树',
		  'guard.treeValue': '{count} 进程 · {size}',
		  'guard.denied': '已拦 / 降速',
		  'guard.collect': '释放内存',
		  'guard.collecting': '回收中…',
		  'guard.note': '只回收本进程 JS 堆，不动 renderer 与系统缓存。',
		  'guard.done': '回收 {freed} MB（{ms}ms）。任务管理器里不一定有变化，这是正常的。',
		  'guard.failed': '回收失败',
		  'guard.reserveLabel': '预占线',
		  'guard.reserveInput': '预占线（MB）',
		  'guard.reserveSave': '保存',
		  'guard.saving': '保存中…',
		  'guard.reserveReset': '重置',
		  'guard.reserveResetHint': '回落到 patch 基线 {base} MB',
		  'guard.reserveNote': '这是一条线：空闲掉到 {mb} MB 以下就停重活，这一块留给 read/grep/write 与汇报。',
		  'guard.reserveOverridden': '当前是面板调过的值，重置可回落到 patch 基线。',
		  'guard.reserveBase': '基线 {mb} MB。',
		  'guard.reserveCeiling': '上限 {mb} MB（= 当前空闲 − critical 阈值）。',
		  'guard.reserveDenyBelow': '重活会在空闲 ≤ {mb} 时被停（取预占线与 critical 中更保守的那个）。',
		  'guard.reserveHeld': '填的值超过上限，实际按 {mb} 生效（空闲回升后会自动用满）。',
		  'guard.reserveClamped': '已保存，但超过上限被夹到 {mb} MB（填的是 {asked} MB）。',
		  'guard.reserveSaved': '已保存：预占线 {mb} MB，下一轮采样生效。',
		  'guard.reserveFailed': '保存失败',
		}

		/** 英文词典。 */
		const en = {
		  'guard.title': 'Resource guard',
		  'guard.aria': 'Resource guard readout',
		  'guard.meterMemory': 'Machine memory',
		  'guard.meterCpu': 'Machine CPU',
		  'guard.meterHeap': 'This process · JS heap',
		  'guard.legendDsh': 'DSH',
		  'guard.legendUsed': 'Used',
		  'guard.legendReserve': 'Reserved',
		  'guard.legendFree': 'Free',
		  'guard.heavyFree': 'Free for heavy tools',
		  'guard.heavyFreeValue': '{heavy} (raw {total})',
		  'guard.commit': 'Free commit memory',
		  'guard.tree': 'DSH process tree',
		  'guard.treeValue': '{count} processes · {size}',
		  'guard.denied': 'Denied / delayed',
		  'guard.collect': 'Free memory',
		  'guard.collecting': 'Collecting…',
		  'guard.note': 'Collects this process JS heap only; renderers and OS cache are untouched.',
		  'guard.done': 'Freed {freed} MB in {ms} ms. Task Manager may not change; that is expected.',
		  'guard.failed': 'Collect failed',
		  'guard.reserveLabel': 'Reserve floor',
		  'guard.reserveInput': 'Reserve floor (MB)',
		  'guard.reserveSave': 'Save',
		  'guard.saving': 'Saving…',
		  'guard.reserveReset': 'Reset',
		  'guard.reserveResetHint': 'Falls back to the patch baseline of {base} MB',
		  'guard.reserveNote': 'This is a floor: heavy tools stop once free memory drops below {mb} MB, keeping that slice for read/grep/write and reporting.',
		  'guard.reserveOverridden': 'Set from this panel; reset to fall back to the patch baseline.',
		  'guard.reserveBase': 'Baseline {mb} MB.',
		  'guard.reserveCeiling': 'Cap {mb} MB (= free minus the critical threshold).',
		  'guard.reserveDenyBelow': 'Heavy tools stop at {mb} MB free or below (whichever of the floor and the critical threshold is more cautious).',
		  'guard.reserveHeld': 'Above the cap, so {mb} is used instead (the full value applies once more is free).',
		  'guard.reserveClamped': 'Saved, but clamped to {mb} MB by the cap (asked {asked} MB).',
		  'guard.reserveSaved': 'Saved: reserve floor {mb} MB, applied on the next sample.',
		  'guard.reserveFailed': 'Save failed',
		}

		/**
		 * 客户端插件体。
		 * @param {any} ctx 客户端上下文。
		 * @param {object} [config] 插件配置（来自同一条 patch 的 `config` 块）。
		 * @returns {void}
		 */
		function apply(ctx, config) {
		  const intervalMs = Number(config?.statusPillIntervalMs ?? 2000)
		  ctx.effect(() => ctx.locale.register('guard', { zh, en }), 'rampart: dictionaries')
		  ctx.effect(
		    () =>
		      ctx.slots.inject('conversation.composer.dock', () =>
		        ctx.slots.register(
		          {
		            name: 'conversation.composer.dock',
		            id: 'rampart',
		            // 排在 activity(0) / usage(1) 之后；上下文环不经过 slot，靠 CSS `order` 越过它，
		            // 见文件头的「位置与观感」。
		            order: 2,
		            locale: 'guard',
		            inject: () => ({ intervalMs }),
		          },
		          StatusPill,
		        ),
		      ),
		    'rampart: composer dock pill',
		  )
		}

		exports.CSS = CSS;
		exports.STYLE_TAG_ID = STYLE_TAG_ID;
		exports.inject = inject;
		exports.formatMb = formatMb;
		exports.shareOf = shareOf;
		exports.apiBase = apiBase;
		exports.ensureStyles = ensureStyles;
		exports.FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS;
		exports.fetchWithTimeout = fetchWithTimeout;
		exports.fetchStats = fetchStats;
		exports.requestGc = requestGc;
		exports.requestReserve = requestReserve;
		exports.percentOf = percentOf;
		exports.stackedMeter = stackedMeter;
		exports.StatusPill = StatusPill;
		exports.reserveEditor = reserveEditor;
		exports.reserveNoteText = reserveNoteText;
		exports.describeFailure = describeFailure;
		exports.zh = zh;
		exports.en = en;
		exports.apply = apply;
		return module.exports;
	}
});
