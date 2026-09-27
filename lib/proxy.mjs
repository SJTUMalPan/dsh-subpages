/**
 * 网关：把 `/subpages/<id>/…` 的请求落到看板上。
 *
 * 两种形态：
 *   - `proxy`：转发到看板自己的 http 服务（`target` 是 http(s) 地址）；
 *   - `static`：直接从看板目录读文件（`target` 是目录）。
 *
 * 不变量：
 *   - **令牌只在服务端**：注入到转发请求的请求头（或查询串），浏览器可见的任何响应里
 *     都不含它。本模块绝不把令牌写进响应体，也绝不写进日志。
 *   - **静态读取不越界**：解析后的路径必须仍在看板目录内（前缀穿越、`..`、绝对路径
 *     注入一律 404），这是本模块唯一的攻击面。
 *   - **下游挂了不影响宿主**：连接失败/超时返回 502 + 可读错误页，宿主进程照常。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { rewriteLocation } from './sessions.mjs'

/** 常见的 hop-by-hop 头：转发时必须丢掉，否则会破坏连接复用。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 扩展名 → Content-Type。够用即可，不引 mime 库。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
}

/**
 * 取扩展名对应的 Content-Type。
 *
 * 入参可能带查询串（`/a.css?v=1`）或 hash，先剥掉再取扩展名——否则 `.css?v=1`
 * 会被当成未知扩展名退化成 `application/octet-stream`，浏览器直接不认样式表。
 *
 * @param {string} path - 文件路径（可带查询串）。
 * @returns {string} MIME 类型。
 */
export function mimeOf(path) {
  const clean = String(path ?? '').split(/[?#]/u)[0]
  return MIME[extname(clean).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 归一化请求子路径：去掉查询串、折叠 `.` / `..`、保证以 `/` 开头。
 * @param {string} rawPath - `req.url` 形态的原始路径。
 * @returns {string} 以 `/` 开头的安全路径。
 */
export function subPathOf(rawPath) {
  const withoutQuery = rawPath.split('?')[0].split('#')[0]
  const normalized = normalize(decodeURIComponentSafe(withoutQuery)).replace(/\\/gu, '/')
  const withLeading = normalized.startsWith('/') ? normalized : `/${normalized}`
  return withLeading
}

/**
 * `decodeURIComponent` 的容错版：畸形百分号编码不让整个请求 500，原样返回。
 * @param {string} value - 原始字符串。
 * @returns {string} 解码结果。
 */
function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 把子路径解析到看板目录内的真实文件路径；越界返回 null。
 * @param {string} baseDir - 看板目录。
 * @param {string} subPath - `/` 开头的子路径。
 * @returns {string | null} 绝对路径；越界返回 null。
 */
export function resolveWithin(baseDir, subPath) {
  const target = resolve(join(baseDir, subPath))
  const base = resolve(baseDir)
  if (target === base) return target
  return target.startsWith(base + sep) ? target : null
}

/**
 * 构造转发用的请求头：过滤 hop-by-hop、改写 Host、注入下游令牌。
 *
 * @param {Record<string, unknown>} incoming - 原始请求头。
 * @param {object} page - 注册表条目。
 * @param {string | null} token - 已解析的令牌（可为 null）。
 * @returns {Record<string, string>} 转发头。
 */
export function forwardHeaders(incoming, page, token, sessionCookie = null) {
  /** @type {Record<string, string>} */
  const headers = {}
  for (const [key, value] of Object.entries(incoming)) {
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'host') continue
    if (value === undefined) continue
    headers[key] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  if (page.target.kind === 'proxy') headers.host = new URL(page.target.url).host
  if (sessionCookie !== null) headers.cookie = sessionCookie
  if (token !== null && page.auth !== null && page.auth.queryParam === null) {
    const scheme = page.auth.scheme
    headers[(page.auth.header ?? 'authorization').toLowerCase()] =
      scheme === '' ? token : `${scheme} ${token}`
  }
  return headers
}

/**
 * 构造转发目标 URL。
 * @param {object} page - 注册表条目。
 * @param {string} subPath - `/` 开头的子路径。
 * @param {string} rawUrl - 原始 `req.url`（用于保留查询串）。
 * @param {string | null} token - 令牌（查询串模式时使用）。
 * @returns {URL} 目标 URL。
 */
export function forwardUrl(page, subPath, rawUrl, token, hasSession = false) {
  const queryIndex = rawUrl.indexOf('?')
  const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)
  const base = page.target.url
  const suffix = subPath === '/' ? '/' : subPath
  const url = new URL(`${base}${suffix}${search}`)
  if (!hasSession && token !== null && page.auth !== null && page.auth.queryParam !== null) {
    url.searchParams.set(page.auth.queryParam, token)
  }
  return url
}

/**
 * 计算回写给浏览器的响应头：过滤 hop-by-hop，并把下游的 `Location` 补回挂载前缀。
 *
 * 为什么必须重写 `Location`：看板不知道自己被挂在 `/subpages/<id>` 下面，它的
 * 重定向目标通常是根路径（notify-hub 的令牌换 cookie 就是 `303 → /todos`）。
 * 原样回写会让浏览器跳出网关、撞到 DSH 自己的路由（表现为 404）。
 *
 * 只重写「以 / 开头」的目标：绝对 URL（跨域跳转）和相对路径不动。
 *
 * @param {Record<string, string | string[] | undefined>} incoming - 下游响应头。
 * @param {string} publicBase - 该看板对外的公共前缀，如 `/subpages/notify-hub`。
 * @returns {Record<string, string | string[]>} 可写回的响应头。
 */
export function responseHeaders(incoming, publicBase, { sessionStarted = false } = {}) {
  /** @type {Record<string, string | string[]>} */
  const headers = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    // 下游的会话 cookie 由宿主持有，绝不透给浏览器（否则凭证就出服务端了）。
    if (lower === 'set-cookie') continue
    if (lower === 'location' && typeof value === 'string') {
      headers[key] = rewriteLocation(value, { publicBase, sessionStarted })
      continue
    }
    headers[key] = value
  }
  return headers
}

/**
 * 把看板 HTML 里的**根路径绝对链接**改写到挂载前缀下。
 *
 * 为什么必须做：看板（如 notify-hub）页面里的链接是 `/todos`、`/messages` 这样的
 * 根路径。它们在 iframe 里被解析成 `<DSH 主机>/todos` —— 也就是打到 **DSH 自己的路由**
 * 上（404 空白页），而不是经网关到看板。实测复现：
 *   `404 GET http://127.0.0.1:3080/messages`（期望 `/subpages/notify-hub/messages`）。
 *
 * 只改这三类会发起请求的属性：`href` / `src` / `action`；
 * 只改以单个 `/` 开头的值——`//host/x`（协议相对）、`#anchor`、`mailto:` 等一律不动；
 * 已经带前缀的值保持幂等。
 *
 * @param {string} html - 看板返回的 HTML。
 * @param {{ publicBase: string }} options - 该看板对外的公共前缀。
 * @returns {string} 处理后的 HTML。
 */
export function rewriteRootPaths(html, { publicBase }) {
  if (typeof html !== 'string' || publicBase === '') return html
  const base = publicBase.replace(/\/+$/u, '')
  const attribute = /(\b(?:href|src|action)\s*=\s*)("([^"]*)"|'([^']*)')/giu
  return html.replace(attribute, (whole, prefix, quoted, doubleValue, singleValue) => {
    const value = doubleValue !== undefined ? doubleValue : singleValue
    if (typeof value !== 'string') return whole
    // 只处理「以单个 / 开头」的内部绝对路径
    if (!value.startsWith('/') || value.startsWith('//')) return whole
    if (value === base || value.startsWith(`${base}/`)) return whole // 幂等
    const quote = doubleValue !== undefined ? '"' : "'"
    return `${prefix}${quote}${base}${value}${quote}`
  })
}

/**
 * 把公共样式注入看板的 HTML（`style: inherit` 时）。
 *
 * 设计取舍（改之前先读）：
 *   - **不重写看板的标记**：宿主提供的是「约定」而不是强制改名。看板自己决定要不要
 *     把类名换成 `.sp-*`；不换也能拿到 Pico 的排版与深色基调，只是它自带的组件样式仍然
 *     生效——这是刻意的，不做「半亮半暗」的强迫改造。
 *   - **默认保留看板自带的 `<style>`**：删掉它会破坏它自己的组件类名。想彻底统一的
 *     看板可以显式声明 `stripOwnStyle`（那意味着它已按公共约定重写了标记）。
 *   - 没有 `</head>` 的碎片不注入：宁可不改，也不猜结构。
 *   - 幂等：已含该样式表引用的内容不重复注入。
 *
 * @param {string} html - 看板返回的 HTML 文本。
 * @param {{ style?: string, assetBase: string, stripOwnStyle?: boolean }} options - 注入策略。
 * @returns {string} 处理后的 HTML。
 */
export function injectSharedStyle(html, { style = 'standalone', assetBase, stripOwnStyle = false }) {
  if (style !== 'inherit') return html
  if (typeof html !== 'string' || !html.includes('</head>')) return html
  if (html.includes(assetBase)) return html

  const headIndex = html.indexOf('</head>')
  const head = html.slice(0, headIndex)
  const body = html.slice(headIndex)
  const tag = `<link rel="stylesheet" href="${assetBase}">`
  const cleaned = stripOwnStyle ? head.replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '') : head
  return `${cleaned}${tag}${body}`
}

/**
 * 把下游响应回写给浏览器：过滤 hop-by-hop、重写 Location，保留状态码与其余头。
 * @param {import('node:http').IncomingMessage} upstream - 下游响应。
 * @param {import('node:http').ServerResponse} res - 浏览器响应。
 * @param {string} publicBase - 该看板对外的公共前缀。
 */
function pipeResponse(upstream, res, publicBase, transformHtml, req, sessions, page, retry) {
  const sessionStarted = sessions !== undefined && upstream.headers['set-cookie'] !== undefined
  if (sessionStarted) sessions.capture(page.id, upstream.headers)

  // 会话失效（401/403）且本次是带着会话发的：丢掉会话，用令牌重来一次。
  const status = upstream.statusCode ?? 502

  // 下游把「看板首页」跳走（notify-hub 的 "/" 会 303 到 "/todos"）：在服务端跟一跳，
  // 让浏览器只看到一次 200。**必须在会话跳转判断之前**，否则会退化成 303 循环。
  const location = upstream.headers.location
  if (
    (status === 301 || status === 302 || status === 303)
    && retry !== undefined && retry !== null
    && typeof location === 'string' && location.startsWith('/')
    && !location.startsWith('//')
    && retry.followedRoot !== true
    && upstream.headers['set-cookie'] === undefined
  ) {
    upstream.resume()
    proxyToPage({
      page, req, res,
      timeoutMs: retry.timeoutMs,
      onError: retry.onError,
      urlOverride: location,
      publicBase,
      transformHtml,
      sessions,
      followedRoot: true,
    })
    return
  }

  if ((status === 401 || status === 403) && retry !== undefined && retry !== null && sessions !== undefined) {
    upstream.resume()
    sessions.drop(page.id)
    const { timeoutMs: retryTimeout = 15_000, onError: retryOnError, urlOverride: retryUrl } = retry
    proxyToPage({
      page, req, res,
      timeoutMs: retryTimeout,
      onError: retryOnError,
      urlOverride: retryUrl,
      publicBase,
      transformHtml,
      sessions,
      retried: true,
    })
    return
  }

  const headers = responseHeaders(upstream.headers, publicBase, { sessionStarted })
  const isHtml = typeof headers['content-type'] === 'string'
    && headers['content-type'].toLowerCase().includes('text/html')

  // 只有「HTML 导航响应 + 配了变换」才缓冲整份 body；其余一律流式转发，
  // 不为了让样式注入多付一次内存拷贝。
  if (transformHtml !== undefined && isHtml && isNavigate(req)) {
    const chunks = []
    upstream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    upstream.on('end', () => {
      const original = Buffer.concat(chunks).toString('utf8')
      let output = original
      try {
        output = transformHtml(original)
      } catch {
        output = original // 注入失败就原样返回，绝不因为样式而让页面 500
      }
      res.writeHead(status, { ...headers, 'content-length': String(Buffer.byteLength(output)) })
      res.end(output)
    })
    upstream.on('error', () => { if (!res.writableEnded) res.end() })
    return
  }

  res.writeHead(status, headers)
  upstream.pipe(res)
}

/**
 * 判断一次请求是不是「页面导航」（而不是 XHR / 静态资源请求）。
 *
 * 只给导航注入样式：XHR 拿的是 JSON、静态资源拿的是字节流，注入它们只会造成损坏。
 * 除 `Accept` 外还要求 `Sec-Fetch-Mode: navigate`（浏览器发的导航请求都带它），
 * 这样 `curl` 之类没有该头的客户端不会被误判。
 *
 * @param {import('node:http').IncomingMessage} req - 原始请求。
 * @returns {boolean} 是否按导航处理。
 */
export function isNavigate(req) {
  const accept = String(req?.headers?.accept ?? '')
  if (!accept.toLowerCase().includes('text/html')) return false
  const mode = req?.headers?.['sec-fetch-mode']
  return mode === undefined ? true : mode === 'navigate'
}

/**
 * 转发一个请求到看板的 http 服务。
 *
 * 凭证策略（三条，改之前先读）：
 *   1. 没有会话时：把清单里声明的令牌注入（请求头或查询串）；
 *   2. 下游用 `Set-Cookie` 开启会话时：宿主**收下该 cookie 并持有**，把跳转改写成
 *      「回到该看板根路径」——浏览器永远只看到一跳，不会跟随下游的换 cookie 跳转
 *      （那会造成重定向循环），也就拿不到任何凭证；
 *   3. 有会话时：只发 cookie，**不再注入令牌**；收到 401/403 则丢弃会话并用令牌重试一次。
 *
 * @param {object} params - 入参。
 * @param {object} params.page - 注册表条目。
 * @param {import('node:http').IncomingMessage} params.req - 原始请求。
 * @param {import('node:http').ServerResponse} params.res - 响应。
 * @param {number} params.timeoutMs - 转发超时。
 * @param {(error: unknown) => void} params.onError - 失败回调（由调用方渲染错误页）。
 * @param {string} [params.urlOverride] - 已剥掉挂载前缀与 id 的路径（含查询串）。
 * @param {string} [params.publicBase] - 该看板对外的公共前缀，用于重写 Location。
 * @param {(html: string) => string} [params.transformHtml] - 导航类 HTML 响应的变换。
 * @param {{ capture: Function, cookieFor: Function, drop: Function }} [params.sessions] - 会话存储。
 * @param {boolean} [params.retried] - 内部使用：标记这是会话失效后的重试，避免无限重试。
 * @returns {void}
 */
export function proxyToPage({
  page, req, res, timeoutMs, onError, urlOverride, publicBase = '', transformHtml, sessions, retried = false, followedRoot = false,
}) {
  const rawUrl = urlOverride ?? req.url ?? '/'
  const subPath = subPathOf(rawUrl)
  const sessionCookie = sessions?.cookieFor(page.id) ?? null
  const url = forwardUrl(page, subPath, rawUrl, page.token, sessionCookie !== null)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = send(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: (() => {
        const h = forwardHeaders(req.headers, page, sessionCookie === null ? page.token : null, sessionCookie)
        return h
      })(),
    },
    (upstreamRes) => {
      // 只在「还没重试过」时给出重试上下文；重试那一跳不能再重试（避免死循环）。
      // retried 之后不再重试；followedRoot 之后也不再把根跳转当成「首页跳转」处理。
      const retry = retried ? null : { timeoutMs, onError, urlOverride, followedRoot }
      pipeResponse(upstreamRes, res, publicBase, transformHtml, req, sessions, page, retry)
    },
  )

  upstream.setTimeout(timeoutMs, () => {
    upstream.destroy(new Error(`转发超时（${timeoutMs}ms）`))
  })
  upstream.on('error', (error) => { onError(error) })
  // 浏览器提前断开时别把下游连接挂着。
  res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
  req.pipe(upstream)
}

/**
 * 从看板目录读一个文件并回写（静态形态）。
 *
 * 目录请求（`/` 或目录路径）回落到清单里的 `index` 文件。
 *
 * @param {object} params - 入参。
 * @param {object} params.page - 注册表条目。
 * @param {import('node:http').IncomingMessage} params.req - 原始请求。
 * @param {import('node:http').ServerResponse} params.res - 响应。
 * @param {(status: number) => void} params.onNotFound - 未命中回调。
 * @param {string} [params.urlOverride] - 已剥掉挂载前缀与 id 的路径（含查询串）。
 * @returns {Promise<void>} 完成。
 */
export async function serveStatic({ page, req, res, onNotFound, urlOverride }) {
  const subPath = subPathOf(urlOverride ?? req.url ?? '/')
  const base = resolve(page.target.dir)
  let filePath = resolveWithin(base, subPath)
  if (filePath === null) { onNotFound(404); return }
  if (subPath.endsWith('/')) filePath = resolveWithin(base, `${subPath}${page.staticIndex}`) ?? filePath

  let info
  try {
    info = await stat(filePath)
  } catch {
    onNotFound(404)
    return
  }
  if (info.isDirectory()) {
    const indexPath = resolveWithin(base, `${subPath.replace(/\/?$/u, '/')}${page.staticIndex}`)
    if (indexPath === null) { onNotFound(404); return }
    try {
      info = await stat(indexPath)
      filePath = indexPath
    } catch {
      onNotFound(404)
      return
    }
  }

  res.writeHead(200, {
    'content-type': mimeOf(filePath),
    'content-length': String(info.size),
    // 看板常在被重新生成，禁掉缓存，刷新即见新版。
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(filePath).pipe(res)
}
