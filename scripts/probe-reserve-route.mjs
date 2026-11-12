/**
 * 探针：宿主里那条 /rampart/api/reserve 到底在不在。
 *
 * 用 `node scripts/probe-reserve-route.mjs [baseUrl]` 跑。只读性质：POST 一个 2048，
 * 成功后立刻 DELETE 回基线，不在磁盘上留下覆盖文件。
 */

const base = process.argv[2] ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:49475'

/**
 * 发一个请求并打印状态与响应体前若干字节。
 * @param {string} method HTTP 方法。
 * @param {string} path 路径。
 * @param {object} [body] 请求体。
 * @returns {Promise<void>} 完成后返回。
 */
async function probe(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  console.log(`${method.padEnd(6)} ${path.padEnd(28)} ${response.status}  ${text.slice(0, 120)}`)
  return { status: response.status, text }
}

const stats = await probe('GET', '/rampart/api/stats')
const reserve = await probe('POST', '/rampart/api/reserve', { reserveMemoryMb: 2048 })
await probe('DELETE', '/rampart/api/reserve')
const unknown = await probe('GET', '/rampart/api/nope')

const routeExists = reserve.status !== 404 || !/not found/i.test(reserve.text)
console.log(`\nreserve 路由存在：${routeExists}`)
console.log(`stats 路由存在：${stats.status !== 404 || !/not found/i.test(stats.text)}`)
console.log(`未知路径仍 404/403：${unknown.status === 404 || unknown.status === 403}`)
