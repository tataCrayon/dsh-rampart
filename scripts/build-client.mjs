/**
 * 把 `client/source.js`（ESM）机械地转成 DSH 客户端 bundle（`__ModuleLoader__.load` 包裹的 CJS）。
 *
 * ## 为什么不用打包器
 *
 * 这个插件只有一个文件、三十几行 UI 代码、三个 react 依赖，全部由宿主提供。
 * 上 tsdown / rolldown 意味着几十 MB 的 devDependencies、一份锁文件，以及
 * 「别人改一行要先 pnpm install」的门槛。这里做的事只有一件：
 *
 *   1. 去掉 `import`（react 改从 factory 的 `require` 取）
 *   2. 去掉 `export`（改成 `exports.xxx =`）
 *   3. 套上 `window.__ModuleLoader__.load({id, factory})`
 *
 * ## 为什么不是「字符串拼接就完事」
 *
 * 因为不可靠。所以转完之后**真的用 `new Function` 跑一遍语法检查**，
 * 再把 bundle 落到 `lib/client.js`；构建失败会非零退出，不会留下一个坏文件。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ROOT = dirname(import.meta.dirname)

/** 打包 id：必须与 package.json 的 name 一致（serve 层按它拼 `/plugins/<id>/client.js`）。 */
export const BUNDLE_ID = 'dsh-resource-guard'

/**
 * 把源码里的 `import ... from 'x'` 收集出来。
 * @param {string} source 源码。
 * @returns {Array<{raw: string, bindings: string, from: string}>} 导入声明。
 */
export function collectImports(source) {
  const found = []
  const pattern = /^import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]\s*;?\s*$/gm
  let match = pattern.exec(source)
  while (match !== null) {
    found.push({ raw: match[0], bindings: match[1].trim(), from: match[2] })
    match = pattern.exec(source)
  }
  return found
}

/**
 * 把 `import { a, b as c } from 'x'` 变成 `const { a, b: c } = require('x')`；
 * `import d from 'x'` 变成 `const d = require('x').default ?? require('x')`。
 * @param {{bindings: string, from: string}} spec 导入声明。
 * @returns {string} 替换后的语句。
 */
export function toRequire(spec) {
  const specifier = JSON.stringify(spec.from)
  if (spec.bindings.startsWith('{')) {
    const names = spec.bindings
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => {
        const [original, alias] = item.split(/\s+as\s+/)
        return alias === undefined ? original : `${original}: ${alias}`
      })
      .join(', ')
    return `const { ${names} } = require(${specifier});`
  }
  if (spec.bindings.startsWith('*')) {
    const alias = spec.bindings.replace(/^\*\s+as\s+/, '')
    return `const ${alias} = require(${specifier});`
  }
  return `const ${spec.bindings} = require(${specifier});`
}

/**
 * 把 `export function x` / `export const x` / `export { ... }` 转成 `exports.x = ...`。
 *
 * 只处理这个项目实际用到的三种形态；遇到 `export default` 直接报错 ——
 * 悄悄忽略会生成一个「看起来能跑、实际上什么都没导出」的 bundle。
 * @param {string} source 源码。
 * @returns {string} 转换后的源码。
 */
export function rewriteExports(source) {
  if (/^\s*export\s+default\b/m.test(source)) {
    throw new Error('client bundle 不支持 export default；请用具名导出')
  }
  let output = source
    .replace(/^export\s+async\s+function\s+([A-Za-z_$][\w$]*)/gm, 'async function $1')
    .replace(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm, 'function $1')
    .replace(/^export\s+const\s+([A-Za-z_$][\w$]*)/gm, 'const $1')
    .replace(/^export\s+let\s+([A-Za-z_$][\w$]*)/gm, 'let $1')

  // 收集所有具名声明，最后统一挂到 exports 上
  const exported = new Set()
  const declaration = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)/gm
  let match = declaration.exec(output)
  while (match !== null) {
    exported.add(match[1] ?? match[2])
    match = declaration.exec(output)
  }

  // `export { a, b }` 单独出现时，只登记、不删声明
  const listPattern = /^export\s+\{([^}]*)\}\s*;?\s*$/gm
  let list = listPattern.exec(output)
  while (list !== null) {
    for (const item of list[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).pop()
      if (name.length > 0) exported.add(name)
    }
    list = listPattern.exec(output)
  }
  output = output.replace(listPattern, '')

  if (output === source.replace(listPattern, '')) {
    throw new Error('client bundle 里没有找到任何导出声明')
  }
  return { code: output, exported: [...exported] }
}

/**
 * 组装最终的 bundle 文本。
 * @param {string} source 源码。
 * @returns {string} bundle。
 */
export function bundleFrom(source) {
  const imports = collectImports(source)
  let code = source
  for (const spec of imports) {
    code = code.replace(spec.raw, toRequire(spec))
  }
  const rewritten = rewriteExports(code)
  const assignment = rewritten.exported
    .map((name) => `\t\texports.${name} = ${name};`)
    .join('\n')

  return `window.__ModuleLoader__.load({
\ttagId: ${JSON.stringify(`${BUNDLE_ID}/client`)},
\tid: ${JSON.stringify(BUNDLE_ID)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${rewritten.code
  .split('\n')
  .map((line) => (line.length === 0 ? line : `\t\t${line}`))
  .join('\n')}
${assignment}
\t\treturn module.exports;
\t}
});
`
}

/**
 * 语法检查：真的执行一次 factory 的解析（不调用它）。
 * @param {string} bundle bundle 文本。
 * @returns {void}
 */
export function assertParses(bundle) {
  // 用一个假的 __ModuleLoader__ 接住 load()，只解析 factory 的函数体
  const captured = []
  const sandbox = { __ModuleLoader__: { load: (record) => captured.push(record) } }
  const window = sandbox
  void window
  // eslint-disable-next-line no-new-func
  new Function('window', bundle)(sandbox)
  if (captured.length !== 1) throw new Error(`bundle 应当只注册一个模块，实际 ${captured.length}`)
  if (captured[0].id !== BUNDLE_ID) throw new Error(`bundle id 应为 ${BUNDLE_ID}，实际 ${captured[0].id}`)
  if (typeof captured[0].factory !== 'function') throw new Error('bundle 缺少 factory 函数')
}

/**
 * 构建并落盘。
 * @returns {{path: string, bytes: number}} 结果。
 */
export function build() {
  const sourcePath = join(ROOT, 'client', 'source.js')
  const targetPath = join(ROOT, 'lib', 'client.js')
  const bundle = bundleFrom(readFileSync(sourcePath, 'utf8'))
  assertParses(bundle)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, bundle, 'utf8')
  return { path: targetPath, bytes: Buffer.byteLength(bundle, 'utf8') }
}

if (process.argv[1]?.endsWith('build-client.mjs') === true) {
  try {
    const result = build()
    console.log(`已生成 ${result.path}（${result.bytes} 字节）`)
  } catch (error) {
    console.error(`构建失败：${error.message}`)
    process.exit(1)
  }
}
