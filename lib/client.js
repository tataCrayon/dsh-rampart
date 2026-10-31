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
		.RGpill_tintFree{--meter-tint:var(--dsw-alias-interactive-bg-hover)}
		.RGpill_action{box-sizing:border-box;width:100%;margin-top:10px;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
		.RGpill_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
		.RGpill_action:disabled{opacity:.55;cursor:default}
		.RGpill_note{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
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
		 * 注入样式（幂等：同 id 只插一次）。
		 * @returns {void}
		 */
		function ensureStyles() {
		  if (typeof document === 'undefined') return
		  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
		  const tag = document.createElement('style')
		  tag.dataset.plugin = 'dsh-rampart'
		  tag.dataset.pluginCss = STYLE_TAG_ID
		  tag.textContent = CSS
		  document.head.appendChild(tag)
		}

		/**
		 * 拉一次读数。
		 * @param {AbortSignal} signal 取消信号。
		 * @returns {Promise<object | null>} 读数；失败时 null。
		 */
		async function fetchStats(signal) {
		  try {
		    const response = await fetch(new URL('rampart/api/stats', apiBase()).href, {
		      method: 'GET',
		      headers: { accept: 'application/json' },
		      signal,
		    })
		    if (!response.ok) return null
		    const payload = await response.json()
		    return payload?.ok === true ? payload : null
		  } catch {
		    return null
		  }
		}

		/**
		 * 触发一次「释放内存」。
		 * @returns {Promise<object>} 结果（失败也返回对象，便于直接显示）。
		 */
		async function requestGc() {
		  try {
		    const response = await fetch(new URL('rampart/api/gc', apiBase()).href, {
		      method: 'POST',
		      headers: { accept: 'application/json' },
		      body: '',
		    })
		    return await response.json()
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

		  // ── 内存：整机物理 = DSH 提交 + 其他已用 + 空闲 ─────────────────────────
		  // DSH 的「提交量」可能大于「整机已用物理」（有换页、有共享页），所以先夹一次；
		  // 夹完仍然可能出现 DSH > 已用（提交比物理占用高），那是正常的，别让蓝色溢出轨道。
		  const totalMb = Math.max(0, guard.totalMb ?? 0)
		  const freePhysMb = Math.max(0, guard.availPhysMb ?? 0)
		  const usedPhysMb = Math.max(0, totalMb - freePhysMb)
		  const dshPhysMb = Math.max(0, Math.min(dshMb ?? 0, usedPhysMb))
		  const otherPhysMb = Math.max(0, usedPhysMb - dshPhysMb)

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
		                      key: 'free',
		                      label: translate('guard.legendFree'),
		                      tint: 'Free',
		                      share: shareOf(freePhysMb, totalMb),
		                      text: formatMb(freePhysMb),
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
		                    row('guard.commit', formatMb(guard.availCommitMb)),
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
		              ],
		            }),
		          })
		        : null,
		    ],
		  })
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
		  'guard.legendFree': '空闲',
		  'guard.commit': '整机可用提交内存',
		  'guard.tree': 'DSH 进程树',
		  'guard.treeValue': '{count} 进程 · {size}',
		  'guard.denied': '已拦 / 降速',
		  'guard.collect': '释放内存',
		  'guard.collecting': '回收中…',
		  'guard.note': '只回收本进程 JS 堆，不动 renderer 与系统缓存。',
		  'guard.done': '回收 {freed} MB（{ms}ms）。任务管理器里不一定有变化，这是正常的。',
		  'guard.failed': '回收失败',
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
		  'guard.legendFree': 'Free',
		  'guard.commit': 'Free commit memory',
		  'guard.tree': 'DSH process tree',
		  'guard.treeValue': '{count} processes · {size}',
		  'guard.denied': 'Denied / delayed',
		  'guard.collect': 'Free memory',
		  'guard.collecting': 'Collecting…',
		  'guard.note': 'Collects this process JS heap only; renderers and OS cache are untouched.',
		  'guard.done': 'Freed {freed} MB in {ms} ms. Task Manager may not change; that is expected.',
		  'guard.failed': 'Collect failed',
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
		exports.fetchStats = fetchStats;
		exports.requestGc = requestGc;
		exports.percentOf = percentOf;
		exports.stackedMeter = stackedMeter;
		exports.StatusPill = StatusPill;
		exports.zh = zh;
		exports.en = en;
		exports.apply = apply;
		return module.exports;
	}
});
