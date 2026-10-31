/**
 * 宿主侧的读数接口：给浏览器那半边（输入框下方的内存/CPU 小条）供数。
 *
 * ## 为什么用自建路由，而不是塞进工具调用
 *
 * 底栏要**定时刷新**（默认 2 秒）。走工具调用意味着每次都进模型上下文、每次都花钱、
 * 还会把对话刷满 —— 那不是「显示读数」，那是「让模型替我读表」。
 * 自建一条本地路由只跑在 GUI 里，与模型无关。
 *
 * ## 安全边界
 *
 * 只认 `ctx.connection.requestRejection(req)` 判为可信的请求（与 dsh-better-sidebar
 * 同一个 fence）。跨源页面拿不到读数，GUI 自己能拿到。缺少 `connection` 服务时
 * 退化为「只允许本机回环」，并在日志里说明这是弱化判定。
 *
 * ## 暴露了什么，没暴露什么
 *
 * 暴露：整机内存、整机与整树的 CPU、DSH 进程树的提交量、护栏等级、本进程堆用量。
 * 不暴露：任何文件路径、命令行、会话内容。进程明细只有 pid + 映像名 + 提交量。
 */

import { computeCpu, sampleTree } from './tree-stats.js'

/** 路由前缀。 */
export const ROUTE_PREFIX = '/rampart/api'

/**
 * 判断请求是否来自可信来源。
 *
 * 优先用 connection 服务的官方判定；它不存在时退化为「来源必须是本机回环」。
 * 这个退化路径不是等价物（不校验 Origin、也不识别反向代理前缀），所以调用方
 * 应当把 `degraded: true` 透出去。
 * @param {any} ctx cordis 上下文。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @returns {{trusted: boolean, degraded: boolean}} 判定结果。
 */
export function trustOf(ctx, req) {
  // 用 `ctx.get(name)` 而不是 `ctx.connection`：cordis 里**访问未声明服务的属性本身
  // 就会抛** `cannot get required service "connection"`。抛在路由外层会被 webserver
  // 统一转成 400，看起来像「路径写错了」，实际是服务没声明。
  // 踩过：这条 400 让我以为是路由前缀没挂上。
  let connection
  try {
    connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  } catch {
    connection = undefined
  }

  if (typeof connection?.requestRejection === 'function') {
    try {
      return { trusted: connection.requestRejection(req) === undefined, degraded: false }
    } catch {
      return { trusted: false, degraded: false }
    }
  }
  const remote = req.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  return { trusted: loopback, degraded: true }
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应。
 * @param {number} status 状态码。
 * @param {object} payload 内容。
 * @returns {void}
 */
export function writeJson(res, status, payload) {
  // 读数是给本机 GUI 实时看的，禁止任何中间层缓存。
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/**
 * 整树采样器：留着上一次快照，用来算 CPU 差值；并按最短间隔合并重复请求。
 *
 * CPU 占用率天然是差值量，单次快照算不出来 —— 第一次调用只能给 0。
 */
export class TreeSampler {
  /**
   * @param {object} options 选项。
   * @param {() => Promise<any>} options.win32 取 Win32 能力集合（可能不可用）。
   * @param {number} options.cores 逻辑核数。
   * @param {number} [options.pid] 起点进程，默认当前进程。
   * @param {number} [options.minIntervalMs] 两次真实采样之间的最短间隔，默认 1000。
   */
  constructor(options) {
    this.getWin32 = options.win32
    this.cores = Math.max(1, options.cores ?? 1)
    this.pid = options.pid ?? process.pid
    this.previous = null
    this.minIntervalMs = options.minIntervalMs ?? 1000
    /** @type {object | null} 上一次真实采样的结果（含 cpu）。 */
    this.cached = null
    /** @type {number} 上一次真实采样的时刻（Date.now）。 */
    this.cachedAt = 0
    /** @type {Promise<object | null> | null} 正在进行的采样，用于合并并发请求。 */
    this.inflight = null
  }

  /**
   * 采一次样，带 CPU 差值。
   *
   * ## 为什么要有最短间隔
   *
   * 整树采样是**同步**的 Win32 全表枚举：412 进程实测 17 ms，期间事件循环完全冻住
   * （不流式输出、不处理 HTTP）。而 `sample()` 是**每个 `/stats` 请求都调一次**的 ——
   * 用户开两个窗口就是两倍，开八个窗口就是 8×17 ms，实测 8 并发累计 148 ms。
   * 拿它去驱动一个「显示读数」的底栏，等于让观察本身成为抖动来源。
   *
   * 于是加一层合并：`minIntervalMs` 内的重复请求直接返回上次结果，
   * 并发的请求共享同一个 Promise。代价是读数最多陈 1 秒，而底栏本来就 2 秒刷一次，
   * 人眼看不出来；收益是采样频率与窗口数解耦。
   *
   * 注意 CPU 占比是**差值量**：`previous` 只在真实采样时推进，所以复用缓存不会把
   * 分母算错（复用的那份 cpu 是它采样当时算好的，与 elapsedMs 自洽）。
   * @returns {Promise<object | null>} 读数；Win32 不可用或采样失败时 null。
   */
  async sample() {
    if (this.inflight !== null) return this.inflight
    if (this.cached !== null && Date.now() - this.cachedAt < this.minIntervalMs) {
      return this.cached
    }

    this.inflight = this.collect().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * 真正跑一次整树采样并推进差值基准。
   * @returns {Promise<object | null>} 读数；Win32 不可用或采样失败时 null。
   */
  async collect() {
    let win32
    try {
      win32 = await this.getWin32()
    } catch {
      return null
    }
    if (win32?.available !== true) return null

    let current
    try {
      current = sampleTree(win32.api, this.pid, this.cores)
    } catch {
      return null
    }

    const cpu = this.previous === null
      ? { cpuPercent: 0, treePercent: 0, elapsedMs: 0 }
      : computeCpu(this.previous, current)
    this.previous = current
    const payload = { ...current, cpu }
    this.cached = payload
    this.cachedAt = Date.now()
    return payload
  }
}

/**
 * 造路由处理器。
 * @param {object} options 依赖。
 * @param {TreeSampler} options.sampler 树采样器。
 * @param {() => object} options.guard 取护栏状态。
 * @param {() => object} options.heap 取本进程堆用量。
 * @param {() => object} options.collect 执行一次强制 GC。
 * @param {(level: string, message: string) => void} [options.log] 日志。
 * @param {() => boolean} [options.trustDegraded] 是否处于弱化信任判定。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器。
 */
export function createStatsHandler(options) {
  return async function handle(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://dsh.internal')
    } catch {
      writeJson(res, 400, { ok: false, error: 'bad-url' })
      return
    }
    const action = url.pathname.slice(ROUTE_PREFIX.length)

    // 逐路由校验方法，而不是「GET/POST 都放行」：`/stats` 是只读端点，
    // 允许 POST 等于给未来的跨站表单留了一条能触发整表枚举的口子。
    if (action === '/stats' && req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (action === '/gc' && req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    if (action !== '/stats' && action !== '/gc') {
      writeJson(res, 404, { ok: false, error: 'not-found' })
      return
    }

    try {
      if (action === '/stats') {
        const tree = await options.sampler.sample()
        writeJson(res, 200, {
          ok: true,
          at: Date.now(),
          trustDegraded: options.trustDegraded?.() === true,
          guard: options.guard(),
          heap: options.heap(),
          tree: tree === null
            ? null
            : {
                rootPid: tree.rootPid,
                processCount: tree.processCount,
                commitMb: Math.round(tree.commitMb),
                workingSetMb: Math.round(tree.workingSetMb),
                cpuPercent: tree.cpu.cpuPercent,
                treePercent: tree.cpu.treePercent,
                top: tree.top.map((item) => ({
                  pid: item.pid,
                  name: item.name,
                  commitMb: Math.round(item.commitMb),
                })),
              },
        })
        return
      }

      if (action === '/gc') {
        const result = options.collect()
        writeJson(res, result.ok ? 200 : 500, result)
        return
      }

      writeJson(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      options.log?.('warn', `资源护栏：${action} 失败（${error.message}）`)
      writeJson(res, 500, { ok: false, error: error.message })
    }
  }
}
