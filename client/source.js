/**
 * 浏览器侧：输入框下方那条内存 / CPU 读数。
 *
 * ## 位置与观感
 *
 * 挂在 `conversation.composer.dock` —— DSH 自己把那三个统计 pill（`154 tok/s`、
 * `缓存命中 49%`、`38%`）放在这里。我们的读数并排放在它们右边，字号、前景色、
 * `tabular-nums` 都跟着它们走，让人一眼看出「这是同一类东西」。
 *
 * ## 为什么自己轮询，而不是走 `slots.register` 的 `hooks`
 *
 * `hooks` 只能拿到 DSH 已投影好的会话数据，拿不到「读机器状态」。所以用 `fetch`
 * 打宿主路由（`/resource-guard/api/stats`）—— 与 dsh-better-sidebar 取数同一个路子，
 * 不经过模型、不花钱、不刷对话。
 *
 * ## 为什么这里写 ESM 而不是直接写成品 bundle
 *
 * 成品必须是 `window.__ModuleLoader__.load({id, factory})` 包起来的 CJS。
 * 手写那个壳子能跑，但改一行要人肉维护两份。所以这里写 ESM，由
 * `scripts/build-client.mjs` 做「只改 import/export」的机械转换，转完还要过语法校验 ——
 * 不是靠约定。
 */

import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

/** 与 DSH 内置统计条一致的样式；行内写死是为了免掉一次 CSS 构建。 */
const CSS = `
.RGpill_anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.RGpill_pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.RGpill_pill svg{flex:none;width:14px;height:14px}
button.RGpill_pill{cursor:pointer}
button.RGpill_pill:hover,button.RGpill_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.RGpill_label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.RGpill_warn{color:var(--dsw-alias-state-warning-primary,#b8860b)}
.RGpill_critical{color:var(--dsw-alias-state-error-primary,#d33)}
.RGpill_dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.RGpill_panel{position:fixed;z-index:1200;width:344px;max-width:calc(100vw - 24px);box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);padding:10px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.RGpill_row{display:flex;justify-content:space-between;gap:12px;padding:2px 0}
.RGpill_row dt{color:var(--dsw-alias-label-tertiary)}
.RGpill_row dd{margin:0;font-variant-numeric:tabular-nums}
.RGpill_title{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:6px}
.RGpill_badge{border-radius:var(--dsw-radius-sm);padding:0 6px;font-weight:500;font-size:11px}
.RGpill_rule{height:1px;background:var(--dsw-alias-border-l1);margin:8px 0}
.RGpill_action{box-sizing:border-box;width:100%;margin-top:8px;padding:5px 10px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}
.RGpill_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.RGpill_action:disabled{opacity:.55;cursor:default}
.RGpill_note{margin-top:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
`

const STYLE_TAG_ID = 'resource-guard/StatusPill.css'

/** 依赖的客户端服务。 */
export const inject = ['slots', 'locale']

/**
 * 把 MB 变成人读的字符串。
 * @param {number} mb 兆字节。
 * @returns {string} 例如 `1.0 GB` / `860 MB`。
 */
export function formatMb(mb) {
  if (!Number.isFinite(mb) || mb <= 0) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/**
 * 取路由基址：页面自己的 base。
 *
 * 桌面 shell 把 `dsh-app://app/` 下的非静态路径同源转发到宿主，所以 HTTP 必须落在
 * 页面的 base 上。用 `__DSH_TRANSPORT__.streamBaseUrl`（宿主真实地址）会因为跨源
 * 被浏览器直接拒掉 —— 插件路由不发 CORS 头。
 * @returns {string} 基址；非 DOM 环境返回空串。
 */
export function apiBase() {
  return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
}

/**
 * 注入样式（幂等：同 id 只插一次）。
 * @returns {void}
 */
export function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_TAG_ID}"]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-resource-guard'
  tag.dataset.pluginCss = STYLE_TAG_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

/**
 * 拉一次读数。
 * @param {AbortSignal} signal 取消信号。
 * @returns {Promise<object | null>} 读数；失败时 null。
 */
export async function fetchStats(signal) {
  try {
    const response = await fetch(new URL('resource-guard/api/stats', apiBase()).href, {
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
export async function requestGc() {
  try {
    const response = await fetch(new URL('resource-guard/api/gc', apiBase()).href, {
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
 * 主组件：一行读数 + 可展开的面板。
 * @param {object} props 属性。
 * @param {number} [props.intervalMs] 轮询间隔。
 * @param {(key: string) => string} [props.t] 本地化函数。
 * @returns {any} React 节点。
 */
export function StatusPill({ intervalMs = 2000, t }) {
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
  if (cpuPercent !== null) parts.push(`${cpuPercent}%`)
  if (dshMb !== null) parts.push(formatMb(dshMb))
  if (parts.length === 0) return null

  const readout = parts.join(' · ')
  const warned = grade === 'warn'
  const critical = grade === 'critical'
  const ariaLabel = `${translate('guard.aria')}：${readout}`

  const panelPosition = () => {
    const rect = anchorRef.current?.getBoundingClientRect?.()
    if (rect === undefined) return { top: 0, left: 0 }
    const width = 344
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    return { top: Math.max(12, rect.top - 8), left, transform: 'translateY(-100%)' }
  }

  /**
   * 造一行「键 → 值」。
   * @param {string} labelKey 词典键。
   * @param {string} value 值文本。
   * @returns {any} React 节点。
   */
  const row = (labelKey, value) =>
    jsxs('div', {
      className: 'RGpill_row',
      children: [
        jsx('dt', { children: translate(labelKey) }),
        jsx('dd', { children: value }),
      ],
    })

  return jsxs('span', {
    ref: anchorRef,
    className: 'RGpill_anchor',
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
                jsxs('dl', {
                  style: { margin: 0 },
                  children: [
                    row('guard.machine', formatMb(guard.availPhysMb)),
                    row('guard.commit', formatMb(guard.availCommitMb)),
                    row('guard.cpu', `${cpuPercent === null ? '—' : cpuPercent}%`),
                  ],
                }),
                jsx('div', { className: 'RGpill_rule' }),
                jsxs('div', {
                  style: { margin: 0 },
                  children: [
                    row('guard.tree', `${tree?.processCount ?? 0} 进程 · ${formatMb(dshMb)}`),
                    row('guard.treeCpu', `${tree?.treePercent ?? 0}%`),
                    row('guard.denied', `${guard.deniedCalls ?? 0} / ${guard.delayedCalls ?? 0}`),
                  ],
                }),
                jsx('div', { className: 'RGpill_rule' }),
                jsxs('dl', {
                  style: { margin: 0 },
                  children: [row('guard.heap', `${stats.heap?.heapUsedMb ?? 0} / ${stats.heap?.heapLimitMb ?? 0} MB`)],
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
  'guard.machine': '整机可用物理内存',
  'guard.commit': '整机可用提交内存',
  'guard.cpu': '整机 CPU',
  'guard.tree': 'DSH 进程树',
  'guard.treeCpu': 'DSH CPU 占比',
  'guard.denied': '已拦 / 降速',
  'guard.heap': '本进程 JS 堆',
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
  'guard.machine': 'Free physical memory',
  'guard.commit': 'Free commit memory',
  'guard.cpu': 'Machine CPU',
  'guard.tree': 'DSH process tree',
  'guard.treeCpu': 'DSH CPU share',
  'guard.denied': 'Denied / delayed',
  'guard.heap': 'This process · JS heap',
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
export function apply(ctx, config) {
  const intervalMs = Number(config?.statusPillIntervalMs ?? 2000)
  ctx.effect(() => ctx.locale.register('guard', { zh, en }), 'resource-guard: dictionaries')
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.composer.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.composer.dock',
            id: 'resource-guard',
            // 排在 activity(0) / usage(1) 之后，成为这一行的第三块
            order: 2,
            locale: 'guard',
            inject: () => ({ intervalMs }),
          },
          StatusPill,
        ),
      ),
    'resource-guard: composer dock pill',
  )
}
