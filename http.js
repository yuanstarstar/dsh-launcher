// DSH启动器 v3 · 通用下载引擎
//
// 纯通用能力，不含任何具体游戏/平台专用逻辑：URL 改写由调用方通过 resolveUrl 回调提供
// （返回候选地址数组；默认原样使用）。职责：
//   1) keep-alive http/https Agent（maxSockets ≥ 并发），全局并发默认 16、上限 32。
//   2) ≥8MB 文件用 Range 分片多线程（4–8 段）并发下载，完成后整体 sha1 校验再 rename；
//      服务端不支持 Range（非 206）时自动回退单流。
//   3) 429/5xx/网络错误指数退避重试并尊重 Retry-After；同 dest 并发去重；.part + rename 原子落盘；
//      单流下载边写边算 sha1。
//   4) fetchText / fetchJson / downloadBuffer / downloadJson / downloadFile / downloadMany 一套接口。
//
// 零依赖：仅使用 Node 24 内置模块（http/https/fs/promises/crypto + 全局 fetch）。
import fsp from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_UA = 'dsh-launcher/3.0.0'
const DEFAULT_HEADERS = { 'user-agent': DEFAULT_UA, accept: '*/*' }

const DEFAULT_CONCURRENCY = 16
const MAX_CONCURRENCY = 32
const DEFAULT_RETRIES = 3

const BIG_FILE_LOG_BYTES = 4 * 1024 * 1024
const RANGE_MIN_BYTES = 8 * 1024 * 1024
const SEGMENT_TARGET_BYTES = 3 * 1024 * 1024
const SEGMENT_MIN = 4
const SEGMENT_MAX = 8
const BYTES_FLUSH = 64 * 1024

const DEFAULT_CONNECT_TIMEOUT_MS = 15000
const DEFAULT_IDLE_TIMEOUT_MS = 60000
const MAX_REDIRECTS = 5
const RETRY_AFTER_CAP_MS = 10000
const RANGE_TTL_MS = 10 * 60 * 1000

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
}

function shortUrl(url) {
  try {
    const parsed = new URL(String(url))
    const file = parsed.pathname.split('/').filter(Boolean).pop() || ''
    return `${parsed.host}/${file.length > 48 ? `${file.slice(0, 48)}…` : file}`
  } catch {
    return String(url)
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function dedupeUrls(list) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(list) ? list : [list]) {
    if (!item) continue
    const url = String(item)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push(url)
  }
  return out
}

/** 把 resolveUrl 回调的各种返回形态（字符串 / 对象 / 数组 / 混合）规整成 URL 数组。 */
function normalizeCandidates(value) {
  const list = Array.isArray(value) ? value : [value]
  const urls = []
  for (const item of list) {
    if (!item) continue
    if (typeof item === 'string') urls.push(item)
    else if (typeof item === 'object' && item.url) urls.push(String(item.url))
  }
  return dedupeUrls(urls)
}

function normalizeSha1(value) {
  const text = String(value || '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(text) ? text : null
}

function parseRetryAfter(value) {
  const raw = Array.isArray(value) ? value[0] : value
  if (raw == null) return 0
  const text = String(raw).trim()
  if (!text) return 0
  const seconds = Number(text)
  if (Number.isFinite(seconds)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, seconds * 1000))
  const at = Date.parse(text)
  if (!Number.isNaN(at)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - Date.now()))
  return 0
}

function isRetryableStatus(status) {
  const code = Number(status) || 0
  return code === 408 || code === 425 || code === 429 || code >= 500
}

function isCancelled(error) {
  return /任务已取消/.test(String(error?.message ?? error ?? ''))
}

function retryDelay(attempt, error) {
  const step = Math.min(5000, 300 * 2 ** Math.max(0, attempt - 1))
  const retryAfter = Number(error?.retryAfterMs) || 0
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(step, retryAfter)) + Math.floor(Math.random() * 150)
}

/** 恒定时间 sha1 比较。 */
export function sameSha1(a, b) {
  const x = String(a || '').trim().toLowerCase()
  const y = String(b || '').trim().toLowerCase()
  if (x.length !== 40 || y.length !== 40) return false
  let diff = 0
  for (let i = 0; i < 40; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i)
  return diff === 0
}

async function sha1File(filePath) {
  const hash = createHash('sha1')
  const handle = await fsp.open(filePath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (!bytesRead) break
      position += bytesRead
      hash.update(buffer.subarray(0, bytesRead))
    }
  } finally {
    await handle.close().catch(() => {})
  }
  return hash.digest('hex')
}

async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath)
  } catch {
    return null
  }
}

async function readJsonOrUndefined(filePath) {
  try {
    const text = await fsp.readFile(filePath, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function atomicWriteFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, filePath)
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

async function rmQuiet(filePath) {
  try {
    await fsp.rm(filePath, { force: true })
  } catch {
    /* ignore */
  }
}

function createSemaphore(limit) {
  const max = Math.max(1, Math.floor(Number(limit) || 1))
  let active = 0
  const queue = []
  function release() {
    const next = queue.shift()
    if (next) {
      // 槽位直接转移给等待者：active 保持不变（等待者接管释放者的名额）
      next()
      return
    }
    active = Math.max(0, active - 1)
  }
  function acquire() {
    if (active < max) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      queue.push(resolve)
    })
  }
  return {
    acquire,
    release,
    get active() {
      return active
    },
    get queued() {
      return queue.length
    },
    get limit() {
      return max
    },
  }
}

class HttpError extends Error {
  constructor(message, { url = null, status = null, retryAfterMs = 0, retryable = false, code = null } = {}) {
    super(String(message))
    this.name = 'HttpError'
    this.url = url
    this.status = status
    this.retryAfterMs = retryAfterMs
    this.retryable = retryable
    if (code) this.code = code
  }
}

function retryableError(message, extra = {}) {
  return new HttpError(message, { retryable: true, ...extra })
}

function statusError(status, url, headers) {
  const code = Number(status) || 0
  const retryAfter = parseRetryAfter(headers?.['retry-after'])
  return new HttpError(`服务端返回 HTTP ${code}`, {
    url,
    status: code,
    retryAfterMs: retryAfter,
    retryable: isRetryableStatus(code),
    code: `HTTP_${code}`,
  })
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'ABORT_ERR',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

function wrapNetError(error, url) {
  if (error instanceof HttpError) return error
  const code = String(error?.code || '')
  const message = String(error?.message || error || '网络错误')
  if (code === 'DSH_IDLE_TIMEOUT' || /停滞超时/.test(message)) {
    return retryableError(message, { url, code: 'IDLE_TIMEOUT' })
  }
  const retryable = NETWORK_ERROR_CODES.has(code) || /socket hang up|aborted|network|fetch failed|timeout/i.test(message)
  return new HttpError(`网络错误：${message}`, { url, retryable, code: code || 'NETWORK' })
}

function wrapStreamError(error, url) {
  if (error instanceof HttpError) return error
  if (isCancelled(error)) return error
  return wrapNetError(error, url)
}

function notify(task, message) {
  if (!task || typeof task.log !== 'function') return
  try {
    task.log(message)
  } catch {
    /* 日志失败不影响下载 */
  }
}

function setTotalBytes(task, total) {
  if (!task || typeof task !== 'object') return
  const size = Math.floor(Number(total) || 0)
  if (size > 0) task.__totalBytes = Math.max(Number(task.__totalBytes) || 0, size)
}

function createProgressMeter(task) {
  let pending = 0
  return {
    add(bytes) {
      if (!task || !bytes) return
      pending += bytes
      if (pending >= BYTES_FLUSH) this.flush()
    },
    flush() {
      if (!pending || !task) return
      const chunk = pending
      pending = 0
      if (typeof task.bytes === 'function') task.bytes(chunk)
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP 传输底层（keep-alive + 重定向）
// ---------------------------------------------------------------------------

function openStream(rawUrl, options = {}) {
  const {
    headers = {},
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    agents,
    stats,
  } = options
  return new Promise((resolve, reject) => {
    let finished = false
    const fail = (error) => {
      if (finished) return
      finished = true
      reject(error)
    }
    const visit = (urlText, redirectsLeft) => {
      if (finished) return
      let target
      try {
        target = new URL(urlText)
      } catch {
        fail(new HttpError(`无效的下载地址：${urlText}`, { url: urlText, retryable: false }))
        return
      }
      const isHttps = target.protocol === 'https:'
      if (!isHttps && target.protocol !== 'http:') {
        fail(new HttpError(`不支持的地址协议：${target.protocol}`, { url: urlText, retryable: false }))
        return
      }
      const transport = isHttps ? https : http
      let request
      try {
        request = transport.request(target, {
          method: 'GET',
          headers: { ...DEFAULT_HEADERS, ...headers },
          agent: isHttps ? agents.https : agents.http,
        })
      } catch (error) {
        fail(wrapNetError(error, urlText))
        return
      }
      if (stats) stats.requests += 1
      let timer = setTimeout(() => {
        request.destroy(
          retryableError(`建连超时（${Math.round(connectTimeoutMs / 1000)}s）：${shortUrl(urlText)}`, {
            url: urlText,
            code: 'CONNECT_TIMEOUT',
          }),
        )
      }, Math.max(1000, Number(connectTimeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS))
      const clearTimer = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
      }
      request.on('error', (error) => {
        clearTimer()
        fail(wrapNetError(error, urlText))
      })
      request.on('response', (response) => {
        clearTimer()
        if (finished) {
          try {
            response.destroy()
          } catch {
            /* ignore */
          }
          return
        }
        const status = Number(response.statusCode) || 0
        const location = response.headers?.location
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          try {
            response.resume()
          } catch {
            /* ignore */
          }
          let next
          try {
            next = new URL(location, target).href
          } catch {
            fail(new HttpError('服务端重定向地址无效', { url: urlText, status, retryable: false }))
            return
          }
          visit(next, redirectsLeft - 1)
          return
        }
        finished = true
        resolve({ req: request, res: response, status, headers: response.headers, url: urlText })
      })
      request.end()
    }
    visit(String(rawUrl), Math.max(0, Number(maxRedirects) || 0))
  })
}

const STOP_STREAM = Symbol('stop-stream')

function idleTimeoutError(idleTimeoutMs) {
  return retryableError(`下载停滞超时（${Math.max(1, Math.round(idleTimeoutMs / 1000))}s 无数据）`, {
    code: 'DSH_IDLE_TIMEOUT',
  })
}

async function consumeResponse(res, { idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, onChunk } = {}) {
  let timer = null
  const arm = () => {
    if (!(idleTimeoutMs > 0)) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        res.destroy(idleTimeoutError(idleTimeoutMs))
      } catch {
        /* ignore */
      }
    }, idleTimeoutMs)
  }
  arm()
  try {
    for await (const chunk of res) {
      arm()
      if (chunk && chunk.length) await onChunk(chunk)
    }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function discardResponse(res, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      try {
        res.destroy()
      } catch {
        /* ignore */
      }
      finish()
    }, Math.max(300, Number(timeoutMs) || 5000))
    res.on('end', finish)
    res.on('error', finish)
    res.on('aborted', finish)
    try {
      res.resume()
    } catch {
      finish()
    }
    if (res.complete) finish()
  })
}

// ---------------------------------------------------------------------------
// 创建下载器
// ---------------------------------------------------------------------------

/**
 * @param {object} [options]
 * @param {number}  [options.concurrency=16]   全局并发（上限 32）
 * @param {number}  [options.retries=3]        每个候选地址的最大重试次数
 * @param {Function}[options.logger]           调试日志回调 (line: string) => void
 * @param {Function}[options.resolveUrl]       候选地址回调 (url, ctx?) => string[] | {url,family?}[]（可返回 Promise）
 * @param {number}  [options.timeoutMs]        建连超时（默认 15000ms）
 * @param {number}  [options.idleTimeoutMs]    无数据超时（默认 60000ms）
 * @param {string}  [options.userAgent]        User-Agent（默认 dsh-launcher/3.0.0）
 */
export function createDownloader(options = {}) {
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, Math.floor(Number(options.concurrency) || DEFAULT_CONCURRENCY)),
  )
  const retries = Math.min(8, Math.max(1, Math.floor(Number(options.retries) || DEFAULT_RETRIES)))
  const logger = typeof options.logger === 'function' ? options.logger : null
  const resolveUrlOption = typeof options.resolveUrl === 'function' ? options.resolveUrl : null
  const defaultConnectTimeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_CONNECT_TIMEOUT_MS)
  const defaultIdleTimeoutMs = Math.max(1000, Number(options.idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS)
  const userAgent = typeof options.userAgent === 'string' && options.userAgent.trim()
    ? options.userAgent.trim()
    : DEFAULT_UA
  const baseHeaders = { ...DEFAULT_HEADERS, 'user-agent': userAgent }

  const agents = {
    http: new http.Agent({
      keepAlive: true,
      maxSockets: concurrency,
      maxFreeSockets: Math.min(8, concurrency),
      timeout: 30000,
    }),
    https: new https.Agent({
      keepAlive: true,
      maxSockets: concurrency,
      maxFreeSockets: Math.min(8, concurrency),
      timeout: 30000,
    }),
  }

  const sem = createSemaphore(concurrency)
  const inflight = new Map()
  const rangeCache = new Map()
  const stats = {
    requests: 0,
    downloads: 0,
    cachedHits: 0,
    failures: 0,
    retries: 0,
    bytes: 0,
    active: 0,
    peak: 0,
  }

  function devLog(message) {
    if (!logger) return
    try {
      logger(`[http] ${message}`)
    } catch {
      /* ignore */
    }
  }

  async function withSlot(fn) {
    await sem.acquire()
    stats.active += 1
    if (stats.active > stats.peak) stats.peak = stats.active
    try {
      return await fn()
    } finally {
      stats.active = Math.max(0, stats.active - 1)
      sem.release()
    }
  }

  // -------------------------------------------------------------------------
  // 候选地址（由调用方的 resolveUrl 提供；默认原样）
  // -------------------------------------------------------------------------

  function resolveUrls(url, ctx = {}) {
    const raw = String(url || '')
    if (!raw) return []
    if (!resolveUrlOption) return [raw]
    try {
      const produced = resolveUrlOption(raw, ctx)
      if (produced && typeof produced.then === 'function') {
        devLog('resolveUrl 返回了 Promise：同步接口无法等待，调用 downloadFile/downloadMany 时将使用异步结果')
        return [raw]
      }
      const list = normalizeCandidates(produced)
      return list.length ? list : [raw]
    } catch (error) {
      devLog(`候选地址回调失败，按原样使用：${error?.message || error}`)
      return [raw]
    }
  }

  async function resolveUrlsAsync(url, ctx = {}) {
    const raw = String(url || '')
    if (!raw) return []
    if (!resolveUrlOption) return [raw]
    try {
      const produced = await resolveUrlOption(raw, ctx)
      const list = normalizeCandidates(produced)
      return list.length ? list : [raw]
    } catch (error) {
      devLog(`候选地址回调失败，按原样使用：${error?.message || error}`)
      return [raw]
    }
  }

  function getSpeedReport() {
    // 通用下载器不做源测速：候选顺序由 resolveUrl 回调负责（调用方可自行测速后排序）。
    return {
      source: 'generic',
      concurrency,
      note: '通用下载器不做源测速；候选地址顺序由 resolveUrl 回调提供',
      at: null,
      ageMs: null,
      ttlMs: null,
      cached: false,
      kinds: {},
    }
  }

  // -------------------------------------------------------------------------
  // 文本 / JSON / Buffer
  // -------------------------------------------------------------------------

  async function requestWithFallback(urlOrUrls, opts = {}) {
    const urls = dedupeUrls(Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls])
    if (!urls.length) throw new HttpError('缺少请求地址', { retryable: false })
    const {
      timeoutMs = 20000,
      headers = {},
      retries: requestRetries = retries,
      parse,
    } = opts
    const maxRetries = Math.min(8, Math.max(0, Math.floor(Number(requestRetries) || 0)))
    let lastError = null
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index]
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          return await withSlot(async () => {
            stats.requests += 1
            let response
            try {
              response = await fetch(url, {
                method: 'GET',
                headers: { ...baseHeaders, ...headers },
                signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 20000)),
                redirect: 'follow',
              })
            } catch (error) {
              throw wrapNetError(error, url)
            }
            if (!response.ok) {
              const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
              try {
                await response.body?.cancel()
              } catch {
                /* ignore */
              }
              throw new HttpError(`服务端返回 HTTP ${response.status}`, {
                url,
                status: response.status,
                retryAfterMs,
                retryable: isRetryableStatus(response.status),
              })
            }
            if (!parse) return response
            try {
              return await parse(response, url)
            } catch (error) {
              if (error instanceof HttpError) throw error
              throw new HttpError(`解析响应失败：${error?.message || error}`, { url, retryable: false })
            }
          })
        } catch (error) {
          lastError = error
          const status = Number(error?.status) || 0
          const missing = status === 404 || status === 410
          const retryable = !missing && error?.retryable !== false
          const hasAttemptLeft = attempt < maxRetries
          if (!retryable || !hasAttemptLeft) break
          stats.retries += 1
          await sleep(retryDelay(attempt + 1, error))
        }
      }
    }
    throw lastError instanceof Error ? lastError : new HttpError(String(lastError || '请求失败'), { retryable: false })
  }

  async function fetchText(url, opts = {}) {
    return requestWithFallback(url, {
      ...opts,
      parse: async (response) => response.text(),
    })
  }

  function parseJsonResponse(response, url) {
    return response.text().then((text) => {
      try {
        return JSON.parse(text)
      } catch {
        throw new HttpError(`返回内容不是合法 JSON：${String(text).slice(0, 120)}`, { url, retryable: false })
      }
    })
  }

  async function fetchJson(url, opts = {}) {
    return requestWithFallback(url, {
      ...opts,
      parse: parseJsonResponse,
    })
  }

  async function downloadBuffer(url, opts = {}) {
    const { timeoutMs = 60000, maxBytes = 64 * 1024 * 1024, headers = {} } = opts
    const candidates = dedupeUrls(Array.isArray(url) ? url : [url])
    return requestWithFallback(candidates, {
      timeoutMs,
      headers: { 'accept-encoding': 'identity', ...headers },
      parse: async (response, requestUrl) => {
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > maxBytes) {
          try {
            await response.body?.cancel()
          } catch {
            /* ignore */
          }
          throw new HttpError(`响应过大（${declared} 字节 > 上限 ${maxBytes}）`, { url: requestUrl, retryable: false })
        }
        const chunks = []
        let total = 0
        for await (const chunk of response.body ?? []) {
          total += chunk.length
          if (total > maxBytes) {
            throw new HttpError(`响应超过上限 ${maxBytes} 字节`, { url: requestUrl, retryable: false })
          }
          chunks.push(Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
      },
    })
  }

  async function downloadJson(url, destPath, opts = {}) {
    const { timeoutMs = 20000, maxAgeMs = 60 * 60 * 1000, task, headers } = opts
    const dest = path.resolve(String(destPath))
    const cached = await readJsonOrUndefined(dest)
    if (cached !== undefined) {
      const info = await statOrNull(dest)
      if (info && Date.now() - info.mtimeMs <= maxAgeMs) {
        stats.cachedHits += 1
        return cached
      }
    }
    try {
      const data = await fetchJson(url, { timeoutMs, headers })
      await atomicWriteFile(dest, JSON.stringify(data, null, 2))
      notify(task, `已更新缓存：${path.basename(dest)}`)
      return data
    } catch (error) {
      if (cached !== undefined) {
        stats.cachedHits += 1
        notify(task, `网络失败，使用过期缓存：${path.basename(dest)}`)
        return cached
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // 单流下载
  // -------------------------------------------------------------------------

  async function checkCache(dest, expectedSha1, expectedSize) {
    const info = await statOrNull(dest)
    if (!info || !info.isFile()) return null
    if (expectedSize && Number(info.size) !== Number(expectedSize)) return null
    if (!expectedSha1) return { path: dest, bytes: info.size, sha1: null, cached: true }
    const actual = await sha1File(dest)
    if (!sameSha1(actual, expectedSha1)) return null
    return { path: dest, bytes: info.size, sha1: actual, cached: true }
  }

  async function appendAll(handle, buffer) {
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null)
      if (!bytesWritten) throw new HttpError('写入文件失败（磁盘未写入任何字节）', { retryable: false })
      offset += bytesWritten
    }
    return buffer.length
  }

  async function writeAllAt(handle, buffer, position) {
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset)
      if (!bytesWritten) throw new HttpError('写入文件失败（磁盘未写入任何字节）', { retryable: false })
      offset += bytesWritten
    }
    return buffer.length
  }

  async function downloadSingleStream(candidate, settings) {
    const {
      partFile,
      destFile,
      expectedSha1,
      expectedSize,
      task,
      connectTimeoutMs,
      idleTimeoutMs,
      headers,
    } = settings
    const meter = createProgressMeter(task)
    return withSlot(async () => {
      const { res, status } = await openStream(candidate, {
        headers: { ...baseHeaders, ...headers, 'accept-encoding': 'identity' },
        connectTimeoutMs,
        agents,
        stats,
      })
      try {
        if (status === 404 || status === 410) {
          await discardResponse(res)
          throw new HttpError(`资源不存在（HTTP ${status}）：${shortUrl(candidate)}`, {
            url: candidate,
            status,
            retryable: false,
          })
        }
        if (status !== 200 && status !== 206) {
          const error = statusError(status, candidate, res.headers)
          await discardResponse(res)
          throw error
        }
        const declared = Number(res.headers['content-length'])
        if (status === 200 && expectedSize && Number.isFinite(declared) && declared > 0 && declared !== expectedSize) {
          await discardResponse(res)
          throw retryableError(`下载体积与元数据不符（服务端声明 ${declared}，期望 ${expectedSize}）`, {
            url: candidate,
          })
        }
        const total = expectedSize || (Number.isFinite(declared) && declared > 0 ? declared : 0)
        if (total > 0) setTotalBytes(task, total)
        const hash = createHash('sha1')
        let handle = null
        let received = 0
        try {
          handle = await fsp.open(partFile, 'w')
          await consumeResponse(res, {
            idleTimeoutMs,
            onChunk: async (chunk) => {
              if (expectedSize && received + chunk.length > expectedSize) {
                throw retryableError('收到超出预期的数据（体积与元数据不符）', { url: candidate })
              }
              hash.update(chunk)
              await appendAll(handle, chunk)
              received += chunk.length
              stats.bytes += chunk.length
              meter.add(chunk.length)
            },
          })
        } finally {
          if (handle) await handle.close().catch(() => {})
        }
        if (total && received !== total) {
          throw retryableError(`下载字节数不符（收到 ${received}，期望 ${total}）`, { url: candidate })
        }
        const actualSha1 = hash.digest('hex')
        if (expectedSha1 && !sameSha1(actualSha1, expectedSha1)) {
          throw retryableError(`SHA1 校验失败（实际 ${actualSha1.slice(0, 12)}…，期望 ${expectedSha1.slice(0, 12)}…）`, {
            url: candidate,
          })
        }
        meter.flush()
        await fsp.rename(partFile, destFile)
        stats.downloads += 1
        return { path: destFile, bytes: received, sha1: actualSha1, cached: false }
      } catch (error) {
        throw wrapStreamError(error, candidate)
      }
    })
  }

  // -------------------------------------------------------------------------
  // 多段 Range 下载
  // -------------------------------------------------------------------------

  async function probeRangeSupport(candidate, { timeoutMs = 15000 } = {}) {
    return withSlot(async () => {
      const { res, status } = await openStream(candidate, {
        headers: { ...baseHeaders, range: 'bytes=0-0', 'accept-encoding': 'identity' },
        connectTimeoutMs: timeoutMs,
        agents,
        stats,
      })
      const contentRange = String(res.headers['content-range'] || '')
      await discardResponse(res, timeoutMs)
      if (status === 206) {
        const matched = /^bytes\s+0-0\/(\d+)/i.exec(contentRange)
        return { supports: true, status, total: matched ? Number(matched[1]) : 0 }
      }
      if (status >= 200 && status < 300) return { supports: false, status, total: 0 }
      return { supports: false, status, error: `HTTP ${status}` }
    })
  }

  async function downloadSegment(segment) {
    const {
      source: sourceUrl,
      start,
      length,
      handle,
      task,
      meter,
      controller,
      connectTimeoutMs,
      idleTimeoutMs,
      headers,
    } = segment
    const end = start + length - 1
    return withSlot(async () => {
      const { res, status } = await openStream(sourceUrl, {
        headers: {
          ...baseHeaders,
          ...headers,
          range: `bytes=${start}-${end}`,
          'accept-encoding': 'identity',
        },
        connectTimeoutMs,
        agents,
        stats,
      })
      try {
        if (status === 200) {
          await discardResponse(res)
          throw new HttpError('服务端忽略了 Range 请求（返回 200）', {
            url: sourceUrl,
            status,
            retryable: false,
            code: 'RANGE_IGNORED',
          })
        }
        if (status !== 206) {
          const error = statusError(status, sourceUrl, res.headers)
          await discardResponse(res)
          throw error
        }
        const contentRange = String(res.headers['content-range'] || '')
        const matched = /^bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(contentRange)
        if (!matched || Number(matched[1]) !== start) {
          await discardResponse(res)
          throw retryableError('分段响应区间与请求不一致（服务端行为异常）', { url: sourceUrl })
        }
        let written = 0
        try {
          await consumeResponse(res, {
            idleTimeoutMs,
            onChunk: async (chunk) => {
              if (controller.failed) throw controller.failed
              let data = chunk
              if (written + data.length > length) data = data.subarray(0, length - written)
              if (data.length) {
                await writeAllAt(handle, data, start + written)
                written += data.length
                stats.bytes += data.length
                meter.add(data.length)
              }
              if (written >= length) throw STOP_STREAM
            },
          })
        } catch (error) {
          if (error !== STOP_STREAM) throw error
          /* 本段已收满：主动结束响应 */
        }
        if (written !== length) {
          throw retryableError(`分段字节数不符（收到 ${written}，期望 ${length}）`, { url: sourceUrl })
        }
        return written
      } catch (error) {
        throw wrapStreamError(error, sourceUrl)
      }
    })
  }

  async function downloadMultiStream(candidates, settings) {
    const {
      partFile,
      destFile,
      expectedSha1,
      expectedSize,
      task,
      connectTimeoutMs,
      idleTimeoutMs,
      headers,
      quiet,
      attempts,
    } = settings
    const total = Number(expectedSize) || 0
    if (!total || total < RANGE_MIN_BYTES) {
      throw new HttpError('文件体积未知，不能分段下载', { retryable: false, code: 'RANGE_UNSUPPORTED' })
    }

    // 1) 选主源并确认 Range 能力（正向结果按 URL 缓存 10 分钟；负向结果不缓存，避免误判）
    let primary = null
    let lastProbeError = null
    for (const candidate of candidates) {
      const cached = rangeCache.get(candidate)
      if (cached && Date.now() - cached.at < RANGE_TTL_MS && cached.supports) {
        primary = candidate
        break
      }
      try {
        const info = await probeRangeSupport(candidate, { timeoutMs: 15000 })
        if (info.supports) {
          rangeCache.set(candidate, { supports: true, at: Date.now() })
          primary = candidate
          break
        }
        if (info.status === 404 || info.status === 410) continue
        lastProbeError = new HttpError(`分段能力探测失败（HTTP ${info.status}）`, {
          url: candidate,
          status: info.status,
          retryable: isRetryableStatus(info.status),
        })
      } catch (error) {
        lastProbeError = error
      }
    }
    if (!primary) {
      throw new HttpError(
        lastProbeError ? `未能建立分段下载（${lastProbeError.message}）` : '候选源均不支持 Range 分段下载',
        { retryable: false, code: 'RANGE_UNSUPPORTED' },
      )
    }

    const sources = dedupeUrls([primary, ...candidates])
    const segmentsCount = Math.min(
      SEGMENT_MAX,
      Math.max(SEGMENT_MIN, Math.ceil(total / SEGMENT_TARGET_BYTES)),
    )
    const meter = createProgressMeter(task)
    setTotalBytes(task, total)
    if (!quiet) notify(task, `分片下载：${segmentsCount} 段并发（${fmtBytes(total)}）`)
    devLog(`分片下载 ${path.basename(destFile)}：${segmentsCount} 段 / ${fmtBytes(total)}`)

    const handle = await fsp.open(partFile, 'w+')
    const controller = { failed: null }
    try {
      await handle.truncate(total)
      const segments = []
      for (let index = 0; index < segmentsCount; index += 1) {
        const start = Math.floor((index * total) / segmentsCount)
        const end = Math.floor(((index + 1) * total) / segmentsCount) - 1
        segments.push({ index, start, length: end - start + 1 })
      }
      const maxAttempts = Math.min(6, Math.max(3, Math.floor(Number(attempts) || retries) + 2))
      const tasks = segments.map((segment) =>
        (async () => {
          let lastError = null
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            if (controller.failed) throw controller.failed
            const sourceUrl = sources[(segment.index + attempt - 1) % sources.length]
            try {
              await downloadSegment({
                source: sourceUrl,
                start: segment.start,
                length: segment.length,
                handle,
                task,
                meter,
                controller,
                connectTimeoutMs,
                idleTimeoutMs,
                headers,
              })
              return
            } catch (error) {
              lastError = error
              if (isCancelled(error)) throw error
              if (attempt >= maxAttempts) throw error
              stats.retries += 1
              await sleep(retryDelay(attempt, error))
            }
          }
          throw lastError || new HttpError('分段下载失败', { retryable: true })
        })().catch((error) => {
          if (!controller.failed) controller.failed = error
          throw error
        }),
      )
      const settled = await Promise.allSettled(tasks)
      const rejected = settled.find((item) => item.status === 'rejected')
      if (rejected) throw rejected.reason
    } finally {
      await handle.close().catch(() => {})
    }

    const info = await statOrNull(partFile)
    if (!info || Number(info.size) !== total) {
      throw retryableError(`分段拼装体积不符（实际 ${info?.size ?? 0}，期望 ${total}）`, { url: candidates[0] })
    }
    const actualSha1 = await sha1File(partFile)
    if (expectedSha1 && !sameSha1(actualSha1, expectedSha1)) {
      throw retryableError(`SHA1 校验失败（实际 ${actualSha1.slice(0, 12)}…，期望 ${expectedSha1.slice(0, 12)}…）`, {
        url: candidates[0],
      })
    }
    meter.flush()
    await fsp.rename(partFile, destFile)
    stats.downloads += 1
    return { path: destFile, bytes: total, sha1: actualSha1, cached: false }
  }

  // -------------------------------------------------------------------------
  // downloadFile / downloadMany
  // -------------------------------------------------------------------------

  async function doDownloadFile(input, dest, opts = {}) {
    const expectedSha1 = normalizeSha1(opts.sha1)
    const expectedSize = Math.max(0, Math.floor(Number(opts.size) || 0))
    const task = opts.task || null
    const quiet = Boolean(opts.quiet)
    const connectTimeoutMs = Math.max(
      5000,
      Math.min(120000, Number(opts.timeoutMs) || defaultConnectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS),
    )
    const idleTimeoutMs = Math.max(5000, Number(opts.idleTimeoutMs) || defaultIdleTimeoutMs)
    const attempts = Math.min(8, Math.max(1, Math.floor(Number(opts.attempts) || retries)))
    const headers = opts.headers && typeof opts.headers === 'object' ? opts.headers : {}

    let candidates
    if (Array.isArray(input)) {
      candidates = dedupeUrls(input.filter(Boolean).map(String))
    } else {
      candidates = await resolveUrlsAsync(String(input), opts.ctx || {})
      if (!candidates.length) candidates = [String(input)]
    }
    if (!candidates.length) throw new Error('下载失败：没有可用的候选地址')

    const cached = await checkCache(dest, expectedSha1, expectedSize || undefined)
    if (cached) {
      stats.cachedHits += 1
      return cached
    }
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    const partFile = `${dest}.part`

    const bigFile = expectedSize >= RANGE_MIN_BYTES
    const verbose = !quiet && expectedSize >= BIG_FILE_LOG_BYTES
    if (verbose) {
      notify(task, `开始下载：${path.basename(dest)}（${fmtBytes(expectedSize)}）`)
      devLog(`开始下载 ${path.basename(dest)}（${fmtBytes(expectedSize)}）`)
    }

    let lastError = null
    if (bigFile) {
      for (let round = 1; round <= 2; round += 1) {
        try {
          const result = await downloadMultiStream(candidates, {
            partFile,
            destFile: dest,
            expectedSha1,
            expectedSize,
            task,
            connectTimeoutMs,
            idleTimeoutMs,
            headers,
            quiet,
            attempts,
          })
          if (verbose) notify(task, `下载完成：${path.basename(dest)}（${fmtBytes(result.bytes)}）`)
          return result
        } catch (error) {
          lastError = error
          await rmQuiet(partFile)
          if (isCancelled(error)) throw error
          if (error?.code === 'RANGE_UNSUPPORTED' || error?.code === 'RANGE_IGNORED') break
          if (!error?.retryable) break
          stats.retries += 1
          await sleep(retryDelay(round, error))
        }
      }
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          if (index > 0 && attempt === 1) devLog(`改用候选源：${shortUrl(candidate)}`)
          const result = await downloadSingleStream(candidate, {
            partFile,
            destFile: dest,
            expectedSha1,
            expectedSize,
            task,
            connectTimeoutMs,
            idleTimeoutMs,
            headers,
          })
          if (verbose) notify(task, `下载完成：${path.basename(dest)}（${fmtBytes(result.bytes)}）`)
          return result
        } catch (error) {
          lastError = error
          await rmQuiet(partFile)
          if (isCancelled(error)) throw error
          const status = Number(error?.status) || 0
          const missing = status === 404 || status === 410
          const retryable = !missing && error?.retryable !== false
          if (!retryable || attempt >= attempts) break
          stats.retries += 1
          await sleep(retryDelay(attempt, error))
        }
      }
    }

    stats.failures += 1
    const sourceLabels = dedupeUrls(candidates.map((candidate) => hostOf(candidate)).filter(Boolean)).join('、')
    throw new Error(
      `下载失败：${path.basename(dest)}；已尝试 ${candidates.length} 个候选地址（${sourceLabels || '无可用源'}）；最后错误：${
        lastError?.message || lastError || '未知错误'
      }`,
    )
  }

  async function downloadFile(input, destPath, opts = {}) {
    const dest = path.resolve(String(destPath))
    const key = process.platform === 'win32' ? dest.toLowerCase() : dest
    const running = inflight.get(key)
    if (running) return running
    const promise = doDownloadFile(input, dest, { ...opts }).finally(() => {
      inflight.delete(key)
    })
    inflight.set(key, promise)
    return promise
  }

  /** 合并后的任务对象：把单个文件进度转发给聚合任务（bytes 同时计入两者）。 */
  function combineTask(aggregate, itemTask) {
    if (!itemTask || itemTask === aggregate) return itemTask || aggregate
    return {
      log(line) {
        try {
          itemTask.log?.(line)
        } catch {
          /* ignore */
        }
      },
      items(done, total, label) {
        itemTask.items?.(done, total, label)
      },
      bytes(n) {
        itemTask.bytes?.(n)
        aggregate?.bytes?.(n)
      },
      setPhase(phase) {
        itemTask.setPhase?.(phase)
      },
    }
  }

  /**
   * 批量并行下载。items: [{ url, dest, sha1?, size?, ctx?, name?, task?, quiet? }]
   * 返回 { total, downloaded, cached, failed: [{index,dest,name,url,error,status}], bytes, results }。
   * 与 downloadFile 共享全局并发/去重，进度聚合到 task.bytes 与 task.items。
   */
  async function downloadMany(items, opts = {}) {
    const list = (Array.isArray(items) ? items : []).filter((item) => item && item.url && item.dest)
    const total = list.length
    const task = opts.task || null
    const label = opts.label || '下载文件'
    if (!total) return { total: 0, downloaded: 0, cached: 0, failed: [], bytes: 0, results: [] }
    const batchConcurrency = Math.max(
      1,
      Math.min(total, Math.floor(Number(opts.concurrency) || concurrency), concurrency),
    )
    if (task && typeof task.items === 'function') task.items(0, total, label)

    let done = 0
    let downloaded = 0
    let cached = 0
    let bytes = 0
    let next = 0
    let cancelledError = null
    const failed = []
    const results = new Array(total).fill(null)

    const reportProgress = () => {
      if (!task || typeof task.items !== 'function') return
      task.items(done, total, label)
    }

    const worker = async () => {
      for (;;) {
        if (cancelledError) return
        const index = next
        next += 1
        if (index >= total) return
        const item = list[index]
        try {
          const result = await downloadFile(item.url, item.dest, {
            task: combineTask(task, item.task || null),
            ctx: item.ctx,
            sha1: item.sha1,
            size: item.size,
            quiet: item.quiet ?? opts.quiet ?? true,
            attempts: item.attempts ?? opts.attempts,
            timeoutMs: item.timeoutMs ?? opts.timeoutMs,
            idleTimeoutMs: item.idleTimeoutMs ?? opts.idleTimeoutMs,
          })
          results[index] = result
          downloaded += 1
          bytes += Number(result?.bytes) || 0
          if (result?.cached) cached += 1
        } catch (error) {
          if (isCancelled(error)) {
            cancelledError = error
            return
          }
          failed.push({
            index,
            dest: item.dest,
            name: item.name || path.basename(String(item.dest)),
            url: item.url,
            error: error?.message || String(error),
            status: error?.status ?? null,
          })
        }
        done += 1
        reportProgress()
      }
    }

    const workers = Array.from({ length: batchConcurrency }, () => worker())
    await Promise.all(workers)
    if (cancelledError) throw cancelledError
    return { total, downloaded, cached, failed, bytes, results }
  }

  // -------------------------------------------------------------------------
  // 统计 / 关闭
  // -------------------------------------------------------------------------

  function getStats() {
    return {
      ...stats,
      inflight: inflight.size,
      concurrency,
      retries,
      queued: sem.queued,
    }
  }

  function resetStats() {
    stats.requests = 0
    stats.downloads = 0
    stats.cachedHits = 0
    stats.failures = 0
    stats.retries = 0
    stats.bytes = 0
    stats.peak = stats.active
  }

  function close() {
    try {
      agents.http.destroy()
    } catch {
      /* ignore */
    }
    try {
      agents.https.destroy()
    } catch {
      /* ignore */
    }
  }

  return {
    resolveUrls,
    fetchText,
    fetchJson,
    downloadBuffer,
    downloadJson,
    downloadFile,
    downloadMany,
    getSpeedReport,
    getStats,
    resetStats,
    close,
    // 只读配置（便于调用方/测试读取）
    concurrency,
    retries,
    userAgent,
  }
}

export default createDownloader
