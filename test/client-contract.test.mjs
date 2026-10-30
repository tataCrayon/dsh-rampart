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
  assert.equal(loadBundle().id, 'dsh-resource-guard')
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
  assert.equal(options.id, 'resource-guard')
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
  assert.ok(source.includes("new URL('resource-guard/api/stats', apiBase())"), '必须用相对路径拼路由')
  assert.ok(source.includes("new URL('resource-guard/api/gc', apiBase())"), 'GC 路由同样必须是相对路径')
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
