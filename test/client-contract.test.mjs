/**
 * 客户端 bundle 的契约测试。
 *
 * 这半边没有构建期类型检查，也没有办法在测试里跑真 DOM，所以测的是「契约」：
 *
 *   1. `lib/client.js` 是 loader 认得的形状（`__ModuleLoader__.load({id, factory})`）
 *   2. 导出了客户端插件必须有的 `apply` / `inject`
 *   3. `inject` 里声明了 `slots` 与 `locale`（少一个运行时就不加载）
 *   4. 注册进 `conversation.composer.dock`，且 id 不是内置的 `activity`/`usage`
 *   5. 路由地址是**同源相对路径**（写成宿主绝对地址会被 CORS 拦掉）
 *
 * 最后一条是踩过的坑：桌面 shell 的页面是 `dsh-app://app/`，宿主插件路由不发
 * `Access-Control-Allow-*`，跨源 `fetch` 直接被浏览器拒掉。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * 用假的 loader 执行 bundle，取回注册记录。
 * @returns {any} 注册记录。
 */
function loadBundle() {
  const captured = []
  const sandbox = { __ModuleLoader__: { load: (record) => captured.push(record) } }
  // eslint-disable-next-line no-new-func
  new Function('window', bundle)(sandbox)
  assert.equal(captured.length, 1, '一个 bundle 应当只注册一个模块')
  return captured[0]
}

/**
 * 用假的 `require` 执行 factory，取回导出。
 * 只替身 react 的三个入口：真实运行时里它们由宿主提供。
 * @returns {any} 导出对象。
 */
function materialize() {
  const record = loadBundle()
  const reactStub = {
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
  }
  const jsxStub = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  }
  const require = (id) => {
    if (id === 'react') return reactStub
    if (id === 'react/jsx-runtime') return jsxStub
    throw new Error(`bundle 不应该 require(${id})`)
  }
  return record.factory(require)
}

test('bundle 的 id 与包名一致（serve 层按它拼 /plugins/<id>/client.js）', () => {
  assert.equal(loadBundle().id, 'dsh-rampart')
})

test('factory 是函数，且只在 factory 里碰 react（顶层不许有副作用）', () => {
  assert.equal(typeof loadBundle().factory, 'function')
  const head = bundle.slice(0, bundle.indexOf('factory:'))
  assert.ok(!head.includes('require('), '顶层不允许 require；否则 loadCache 之前的执行就炸')
})

test('导出 apply 与 inject', () => {
  const exported = materialize()
  assert.equal(typeof exported.apply, 'function')
  assert.ok(Array.isArray(exported.inject))
  assert.deepEqual(exported.inject, ['slots', 'locale'], 'inject 声明变化会直接影响运行时是否加载')
})

test('注册进 conversation.composer.dock，且 id 不与内置的 activity / usage 冲撞', () => {
  const exported = materialize()
  const registrations = []
  const ctx = {
    effect: (factory) => {
      const disposer = factory()
      assert.equal(typeof disposer, 'function', 'effect 回调必须返回 disposer')
      return disposer
    },
    locale: { register: (ns, dicts) => {
      assert.equal(ns, 'guard')
      assert.ok(dicts.zh['guard.title'], '中文词典必须含标题')
      assert.ok(dicts.en['guard.title'], '英文词典必须含标题')
      return () => {}
    } },
    slots: {
      inject: (name, factory) => {
        factory()
        return () => {}
      },
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
  }
  exported.apply(ctx, { statusPillIntervalMs: 3000 })
  assert.equal(registrations.length, 1, '应当只注册一个条目')
  const [{ options, component }] = registrations
  assert.equal(options.name, 'conversation.composer.dock')
  assert.equal(options.id, 'rampart')
  assert.ok(options.order >= 2, '必须排在 activity(0) / usage(1) 之后')
  assert.equal(options.locale, 'guard')
  assert.equal(typeof component, 'function')
  assert.equal(typeof options.inject, 'function', '需要 inject 把轮询间隔传进组件')
  assert.deepEqual(options.inject(), { intervalMs: 3000 })
})

test('读数是同源相对路径，不是宿主绝对地址', () => {
  const exported = materialize()
  // apiBase 在非 DOM 环境下返回空串，路由拼出来必须仍是相对路径
  const source = readFileSync(new URL('../client/source.js', import.meta.url), 'utf8')
  assert.ok(source.includes("new URL('rampart/api/stats', apiBase())"), '必须用相对路径拼路由')
  assert.ok(source.includes("new URL('rampart/api/gc', apiBase())"), 'GC 路由同样必须是相对路径')
  assert.ok(!/https?:\/\/127\.0\.0\.1/.test(source), '不允许硬编码宿主地址（会跨源被拦）')

  // 注释里提到 streamBaseUrl 是在解释「为什么不用它」，所以只查代码行
  const codeLines = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
  assert.ok(
    codeLines.every((line) => !line.includes('streamBaseUrl')),
    '代码里不能用 streamBaseUrl 发 HTTP 请求（跨源）',
  )

  assert.equal(typeof exported.formatMb, 'function')
  assert.equal(exported.formatMb(1024), '1.0 GB')
  assert.equal(exported.formatMb(860), '860 MB')
  assert.equal(exported.formatMb(0), '—')
})

test('面板的用量条是「一根条多段占比」，且行标记不用 dl/dt/dd', () => {
  const exported = materialize()
  assert.ok(exported.CSS.includes('.RGpill_bar{'), '必须有占比条轨道样式')
  assert.ok(exported.CSS.includes('.RGpill_seg'), '必须有分段填充样式')
  assert.ok(exported.CSS.includes('.RGpill_tintDsh'), 'DSH 那一段必须有独立色（蓝）')
  assert.ok(exported.CSS.includes('.RGpill_tintUsed'), '「其他已用」必须有灰段')
  assert.ok(exported.CSS.includes('backdrop-filter:var(--dsw-menu-backdrop-filter)'), '面板必须有毛玻璃底衬，否则半透明底会透出正文')

  const source = readFileSync(new URL('../client/source.js', import.meta.url), 'utf8')
  // 无障碍：进度条要有 role 与 aria-valuenow，否则读屏软件只能念一个空 div
  assert.ok(source.includes("role: 'progressbar'"), '用量条必须是 progressbar 角色')
  assert.ok(source.includes("'aria-valuenow'"), '用量条必须报 aria-valuenow')

  // 回归：dl 里混装 div 是非法结构，会让行距忽大忽小
  assert.ok(!source.includes("jsxs('dl'"), '不要用 dl 装 div')
  assert.ok(!source.includes("jsx('dt'"), '不要用 dt')
  assert.ok(!source.includes("jsx('dd'"), '不要用 dd')

  // 三条条的分母必须显式给出：只画进度条不写总量等于没说
  assert.ok(source.includes('guard.meterMemory'), '必须有整机物理内存这条')
  assert.ok(source.includes('guard.meterCpu'), '必须有整机 CPU 这条')
  assert.ok(source.includes('guard.meterHeap'), '必须有「JS 堆 / 堆上限」这条')
})

test('DSH 占用与整机用量画进同一根条，且 DSH 段不与「已用」重复计', () => {
  const exported = materialize()

  // 百分比不能夹成整数：0.4% 的 DSH 占用会被丢成 0 段
  assert.equal(exported.shareOf(140, 32000), 0.4)
  assert.equal(exported.shareOf(32000, 32000), 100)
  assert.equal(exported.shareOf(1, 0), 0, '总量为 0 时不能除零')

  const source = readFileSync(new URL('../client/source.js', import.meta.url), 'utf8')
  // 内存：DSH 先夹进「整机已用」，再算「其他已用」，避免同一段被算两次
  assert.ok(source.includes('Math.min(dshMb ?? 0, usedPhysMb)'), 'DSH 占用必须先夹进整机已用')
  assert.ok(source.includes('usedPhysMb - dshPhysMb'), '「其他已用」必须是已用减 DSH')
  // CPU：同理，DSH 忙不能超过整机忙
  assert.ok(source.includes('Math.min(busyPercent, tree?.treePercent ?? 0)'), 'DSH CPU 必须先夹进整机忙')
})

test('读数条挪到上下文占用环右边（靠 CSS order，不是 slot order）', () => {
  const exported = materialize()
  assert.ok(exported.CSS.includes('.RGpill_anchor{order:1'), '上下文环是 InputBar 硬编码在 dock 末尾的，只能用 CSS order 越过它')
  assert.ok(exported.CSS.includes('display:inline-flex'), '根节点必须是 flex item，否则 order 不生效')
})

/**
 * 在一个干净的全局环境里跑一段异步代码。
 *
 * `fetchStats` 依赖全局 `fetch` 与全局 `document`（用来拼同源地址）。默认环境里
 * `document` 不存在，`new URL(相对路径, '')` 会直接抛错 → 被 catch 成 null，
 * 于是「超时」这条测试会**假通过**。所以必须先把 document 装上。
 * @param {(helpers: object) => Promise<void>} body 测试体。
 * @returns {Promise<void>}
 */
async function withGlobals(body) {
  const original = { fetch: globalThis.fetch, document: globalThis.document }
  const calls = []
  globalThis.document = { baseURI: 'http://127.0.0.1:1/' }
  try {
    await body({
      calls,
      /** 装一个假的 fetch。 */
      setFetch: (impl) => {
        globalThis.fetch = async (url, init) => {
          calls.push({ url: String(url), init })
          return impl(url, init)
        }
      },
    })
  } finally {
    globalThis.fetch = original.fetch
    if (original.document === undefined) delete globalThis.document
    else globalThis.document = original.document
  }
}

test('请求有硬超时：宿主不响应时读数链不会永久停在半路', async () => {
  const exported = materialize()
  await withGlobals(async ({ setFetch }) => {
    setFetch(() => new Promise(() => {})) // 永不 resolve，模拟宿主 / 代理吞掉连接
    const started = Date.now()
    const result = await exported.fetchStats(undefined, 40)
    const elapsed = Date.now() - started
    assert.equal(result, null, '超时后必须返回 null（保持上一份读数），不能挂住')
    assert.ok(elapsed < 2000, `必须在超时后很快返回，实际 ${elapsed}ms`)
  })
})

test('超时之外，正常响应仍然照常解析（证明上一条不是空过）', async () => {
  const exported = materialize()
  await withGlobals(async ({ setFetch, calls }) => {
    setFetch(() => ({ ok: true, json: async () => ({ ok: true, guard: { grade: 'warn' } }) }))
    const result = await exported.fetchStats(undefined, 40)
    assert.deepEqual(result, { ok: true, guard: { grade: 'warn' } })
    assert.equal(calls.length, 1)
    assert.ok(calls[0].url.endsWith('/rampart/api/stats'), `请求地址不对：${calls[0].url}`)
    assert.ok(calls[0].init.signal instanceof AbortSignal, '必须带可取消信号')
  })
})

test('组件卸载时立刻取消在途请求，不等超时', async () => {
  const exported = materialize()
  await withGlobals(async ({ setFetch }) => {
    let observed = null
    setFetch((_url, init) => {
      observed = init.signal
      return new Promise(() => {})
    })
    const controller = new AbortController()
    const pending = exported.fetchStats(controller.signal, 60_000)
    // 让 fetch 先启动，再模拟卸载
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()
    const started = Date.now()
    assert.equal(await pending, null)
    assert.ok(Date.now() - started < 500, '卸载后必须立刻返回，而不是等 60 秒超时')
    assert.equal(observed?.aborted, true, '在途请求应当被 abort')
  })
})

test('「释放内存」也受超时保护，卡住时按钮不会永远停在处理中', async () => {
  const exported = materialize()
  await withGlobals(async ({ setFetch }) => {
    setFetch(() => new Promise(() => {}))
    const result = await exported.requestGc(40)
    assert.equal(result.ok, false, '超时必须回一个失败对象，好让界面收尾')
    assert.match(result.error, /abort|timeout/i)
  })
})

test('ensureStyles 在 HMR 后会用新内容替换旧样式标签，而不是「有就跳过」', () => {
  const exported = materialize()
  const tags = []
  const original = { document: globalThis.document }
  globalThis.document = {
    querySelector: () => tags[0] ?? null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (tag) => tags.push(tag) },
  }
  try {
    exported.ensureStyles()
    assert.equal(tags.length, 1, '第一次应当插入一份')
    const first = tags[0].textContent
    // 模拟 HMR：标签还在，但内容已经过期
    tags[0].textContent = 'stale'
    exported.ensureStyles()
    assert.equal(tags.length, 1, '不应重复插入标签')
    assert.equal(tags[0].textContent, first, '过期内容必须被就地换回新 CSS')
  } finally {
    if (original.document === undefined) delete globalThis.document
    else globalThis.document = original.document
  }
})
