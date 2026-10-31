/**
 * 出一个「面板长什么样」的静态预览图（不需要跑 DSH）。
 *
 * 为什么值得存在：面板的问题（半透明底透出正文、占比看不清）只有**看**才发现得了，
 * 单元测试只能断言 CSS 里有那几行。这里把 `client/source.js` 里的 CSS 原样抽出来，
 * 配上 DSH 浅/深两套真实 token 值，用无头 Chrome 截一张图。
 *
 * 局限说清楚：用的 DOM 是手写的同 className 结构，不是 React 渲染出来的 ——
 * 它验的是**观感**，集成验的是 `scripts/verify-desktop-pill.mjs`。两者都要有。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outDir = join(root, '.verify', 'preview')
mkdirSync(outDir, { recursive: true })

/** 从源码里抽出 CSS 模板串。 */
function extractCss() {
  const source = readFileSync(join(root, 'client', 'source.js'), 'utf8')
  const start = source.indexOf('const CSS = `')
  const end = source.indexOf('\n`\n', start)
  return source.slice(start + 'const CSS = `'.length, end)
}

/** DSH 主题里我们实际用到的那几个 token（浅色 / 深色）。 */
const TOKENS_LIGHT = `
  --dsw-radius-sm: 6px; --dsw-radius-lg: 12px;
  --dsw-alias-label-primary: #1a1d21; --dsw-alias-label-secondary: #4d5259;
  --dsw-alias-label-tertiary: #81858c;
  --dsw-alias-border-l1: #0000000f; --dsw-alias-border-l2: #0000001f;
  --dsw-alias-interactive-bg-hover: #2631480f;
  --dsw-alias-state-warning-primary: #b8860b; --dsw-alias-state-error-primary: #d33;
  --dsw-static-blue-450: #4d93f8; --dsw-static-neutral-bluish-400: #adb2b8;
  --dsw-menu-surface-fill: #f8f9fa94; --dsw-specific-menu: var(--dsw-menu-surface-fill);
  --dsw-menu-backdrop-filter: blur(40px) saturate(150%);
  --dsw-elevation-prominent: 0 8px 24px #00000026, 0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsh-content-font-size-secondary: 13px; --dsh-content-font-delta-secondary: 0px;
  background: #edeff2;
`

const TOKENS_DARK = `
  --dsw-radius-sm: 6px; --dsw-radius-lg: 12px;
  --dsw-alias-label-primary: #f2f3f5; --dsw-alias-label-secondary: #c3c7cc;
  --dsw-alias-label-tertiary: #adb2b8;
  --dsw-alias-border-l1: #ffffff14; --dsw-alias-border-l2: #ffffff1f;
  --dsw-alias-interactive-bg-hover: #ffffff14;
  --dsw-alias-state-warning-primary: #d8a319; --dsw-alias-state-error-primary: #f2555a;
  --dsw-static-blue-450: #4d93f8; --dsw-static-neutral-bluish-400: #adb2b8;
  --dsw-menu-surface-fill: #43454a73; --dsw-specific-menu: var(--dsw-menu-surface-fill);
  --dsw-menu-backdrop-filter: blur(40px) saturate(150%);
  --dsw-elevation-prominent: 0 8px 24px #00000066, 0 0 0 .5px var(--dsw-elevation-stroke-color);
  --dsh-content-font-size-secondary: 13px; --dsh-content-font-delta-secondary: 0px;
  background: #14161a;
`

/** 面板本体（与 StatusPill 的 JSX 同结构）。 */
function panelHtml() {
  const legend = (tint, label, text) =>
    `<span class="RGpill_legendItem"><i class="RGpill_swatch RGpill_tint${tint}"></i>${label} ${text}</span>`

  const meter = (title, right, segments) => `
    <div class="RGpill_meter">
      <div class="RGpill_meterHead"><span>${title}</span><b>${right}</b></div>
      <div class="RGpill_bar" role="progressbar">
        ${segments.map((s) => `<span class="RGpill_seg RGpill_tint${s.tint}" style="width:${s.share}%"></span>`).join('')}
      </div>
      <div class="RGpill_legend">${segments.map((s) => legend(s.tint, s.label, s.text)).join('')}</div>
    </div>`

  return `
  <div class="RGpill_panel">
    <div class="RGpill_title"><span>资源护栏</span><span class="RGpill_badge">normal</span></div>
    <div class="RGpill_rule"></div>
    ${meter('整机物理内存', '18.4 GB / 31.6 GB · 58%', [
      { tint: 'Dsh', label: 'DSH', text: '5.1 GB', share: 16.1 },
      { tint: 'Used', label: '其他已用', text: '13.3 GB', share: 42.1 },
      { tint: 'Free', label: '空闲', text: '13.2 GB', share: 41.8 },
    ])}
    ${meter('整机 CPU', '27%', [
      { tint: 'Dsh', label: 'DSH', text: '9%', share: 9 },
      { tint: 'Used', label: '其他已用', text: '18%', share: 18 },
      { tint: 'Free', label: '空闲', text: '73%', share: 73 },
    ])}
    ${meter('本进程 JS 堆', '216 MB / 4.0 GB · 5%', [
      { tint: 'Used', label: '其他已用', text: '216 MB', share: 5.3 },
    ])}
    <div class="RGpill_rule"></div>
    <div>
      <div class="RGpill_row"><span class="RGpill_key">整机可用提交内存</span><span class="RGpill_val">7.4 GB</span></div>
      <div class="RGpill_row"><span class="RGpill_key">DSH 进程树</span><span class="RGpill_val">14 进程 · 5.1 GB</span></div>
      <div class="RGpill_row"><span class="RGpill_key">已拦 / 降速</span><span class="RGpill_val">0 / 0</span></div>
    </div>
    <button type="button" class="RGpill_action">释放内存</button>
    <div class="RGpill_note">只回收本进程 JS 堆，不动 renderer 与系统缓存。</div>
  </div>`
}

/** 造一页预览：面板叠在「对话正文」上面 —— 半透明底的问题只有这样才能暴露。 */
function page(tokens, title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
html,body{margin:0;height:100%}
body{${tokens};font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif;color:var(--dsw-alias-label-primary)}
.backdrop{box-sizing:border-box;padding:34px 40px;height:100%;font-size:14px;line-height:26px;color:#8b9099}
.backdrop p{margin:0 0 14px;max-width:660px}
.wrap{position:relative;height:100%}
.RGpill_panel{position:absolute!important;left:40px;top:40px}
</style>
<style>${extractCss()}</style>
<div class="backdrop">
<div class="wrap">
  <p>heredoc 正文用来验证面板底衬：这一句必须被毛玻璃糊住，一个字都不该透出来。</p>
  <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.</p>
  <p>第二段正文，继续压在面板下面，用来检查对比度是否够。</p>
  ${panelHtml()}
</div>
</div>`
}

const browser = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((candidate) => {
    try {
      readFileSync(candidate)
      return true
    } catch {
      return false
    }
  })

if (browser === undefined) {
  console.error('找不到 Chrome / Edge，跳过错觉预览')
  process.exit(1)
}

for (const [name, tokens] of [['light', TOKENS_LIGHT], ['dark', TOKENS_DARK]]) {
  const htmlPath = join(outDir, `panel-${name}.html`)
  const pngPath = join(outDir, `panel-${name}.png`)
  writeFileSync(htmlPath, page(tokens, `panel ${name}`), 'utf8')
  execFileSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--screenshot=${pngPath}`,
    '--window-size=460,560',
    `file:///${htmlPath.replaceAll('\\', '/')}`,
  ], { stdio: 'ignore' })
  console.log(`已生成 ${pngPath}`)
}
