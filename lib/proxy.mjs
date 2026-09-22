/**
 * 网关：把 `/subpages/<id>/…` 的请求落到子页面上。
 *
 * 两种形态：
 *   - `proxy`：转发到子页面自己的 http 服务（`target` 是 http(s) 地址）；
 *   - `static`：直接从子页面目录读文件（`target` 是目录）。
 *
 * 不变量：
 *   - **令牌只在服务端**：注入到转发请求的请求头（或查询串），浏览器可见的任何响应里
 *     都不含它。本模块绝不把令牌写进响应体，也绝不写进日志。
 *   - **静态读取不越界**：解析后的路径必须仍在子页面目录内（前缀穿越、`..`、绝对路径
 *     注入一律 404），这是本模块唯一的攻击面。
 *   - **下游挂了不影响宿主**：连接失败/超时返回 502 + 可读错误页，宿主进程照常。
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

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
 * 把子路径解析到子页面目录内的真实文件路径；越界返回 null。
 * @param {string} baseDir - 子页面目录。
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
export function forwardHeaders(incoming, page, token) {
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
export function forwardUrl(page, subPath, rawUrl, token) {
  const queryIndex = rawUrl.indexOf('?')
  const search = queryIndex === -1 ? '' : rawUrl.slice(queryIndex)
  const base = page.target.url
  const suffix = subPath === '/' ? '/' : subPath
  const url = new URL(`${base}${suffix}${search}`)
  if (token !== null && page.auth !== null && page.auth.queryParam !== null) {
    url.searchParams.set(page.auth.queryParam, token)
  }
  return url
}

/**
 * 计算回写给浏览器的响应头：过滤 hop-by-hop，并把下游的 `Location` 补回挂载前缀。
 *
 * 为什么必须重写 `Location`：子页面不知道自己被挂在 `/subpages/<id>` 下面，它的
 * 重定向目标通常是根路径（notify-hub 的令牌换 cookie 就是 `303 → /todos`）。
 * 原样回写会让浏览器跳出网关、撞到 DSH 自己的路由（表现为 404）。
 *
 * 只重写「以 / 开头」的目标：绝对 URL（跨域跳转）和相对路径不动。
 *
 * @param {Record<string, string | string[] | undefined>} incoming - 下游响应头。
 * @param {string} publicBase - 该子页面对外的公共前缀，如 `/subpages/notify-hub`。
 * @returns {Record<string, string | string[]>} 可写回的响应头。
 */
export function responseHeaders(incoming, publicBase) {
  /** @type {Record<string, string | string[]>} */
  const headers = {}
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    if (lower === 'location' && typeof value === 'string' && value.startsWith('/')) {
      headers[key] = `${publicBase}${value}`
      continue
    }
    headers[key] = value
  }
  return headers
}

/**
 * 把下游响应回写给浏览器：过滤 hop-by-hop、重写 Location，保留状态码与其余头。
 * @param {import('node:http').IncomingMessage} upstream - 下游响应。
 * @param {import('node:http').ServerResponse} res - 浏览器响应。
 * @param {string} publicBase - 该子页面对外的公共前缀。
 */
function pipeResponse(upstream, res, publicBase) {
  res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers, publicBase))
  upstream.pipe(res)
}

/**
 * 转发一个请求到子页面的 http 服务。
 *
 * @param {object} params - 入参。
 * @param {object} params.page - 注册表条目。
 * @param {import('node:http').IncomingMessage} params.req - 原始请求。
 * @param {import('node:http').ServerResponse} params.res - 响应。
 * @param {number} params.timeoutMs - 转发超时。
 * @param {(error: unknown) => void} params.onError - 失败回调（由调用方渲染错误页）。
 * @param {string} [params.urlOverride] - 已剥掉挂载前缀与 id 的路径（含查询串）。
 *   网关必须传它：`req.url` 还是 `/subpages/<id>/...`，直接转发会把前缀带给下游。
 * @param {string} [params.publicBase] - 该子页面对外的公共前缀，用于重写 Location。
 * @returns {void}
 */
export function proxyToPage({ page, req, res, timeoutMs, onError, urlOverride, publicBase = '' }) {
  const rawUrl = urlOverride ?? req.url ?? '/'
  const subPath = subPathOf(rawUrl)
  const url = forwardUrl(page, subPath, rawUrl, page.token)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const upstream = send(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path: `${url.pathname}${url.search}`,
      headers: forwardHeaders(req.headers, page, page.token),
    },
    (upstreamRes) => { pipeResponse(upstreamRes, res, publicBase) },
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
 * 从子页面目录读一个文件并回写（静态形态）。
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
    // 子页面常在被重新生成，禁掉缓存，刷新即见新版。
    'cache-control': 'no-store',
  })
  if (req.method === 'HEAD') { res.end(); return }
  createReadStream(filePath).pipe(res)
}
