/**
 * dsh-subpages —— DSH 子页面宿主插件（宿主半）。
 *
 * 做三件事，全部长在 **DSH 自己的端口** 上（不新开监听）：
 *
 *   1. 网关：`<mount>/<id>/…` 反代到子页面自己的 http 服务，或直接投递静态文件；
 *   2. 门户：`<mount>/` 返回壳（导航栏 + iframe + hash 路由），`<mount>/_assets/*`
 *      提供公共前端库；
 *   3. 清单：`<mount>/_api/pages` 给壳用，同时通过 `ctx.subPages` 服务开放给其它插件。
 *
 * 安全模型（三条不变量，改动前先读）：
 *   - **复用 DSH 的鉴权**：每个请求先问 `ctx.connection.requestRejection(req)`，
 *     未认证返回 401/403 由 DSH 统一发。本插件**不自建任何凭据体系**。
 *   - **令牌只在服务端**：子页面的下游令牌由本插件在转发时注入请求头/查询串，
 *     浏览器可见的任何响应（清单、壳、错误页）都不含它。
 *   - **不新开端口**：只有 `ctx.webServer.register(...)`，没有 `listen`。
 *
 * @module dsh-subpages
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

import { SubPageRegistry } from './registry.mjs'
import { injectSharedStyle, proxyToPage, serveStatic } from './proxy.mjs'
import { DownstreamSessions } from './sessions.mjs'
import { readWebAsset, renderShell } from './assets.mjs'

/** Cordis 函数插件名（诊断里显示）。 */
export const name = 'subpages'

/** 依赖：DSH 的 web 服务器（挂在它的端口上）与连接服务（复用它鉴权）。 */
export const inject = ['webServer', 'connection']

/** 包根目录（本文件在 `<root>/lib/` 下）。 */
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))

/** 默认挂载前缀。 */
export const DEFAULT_MOUNT_PATH = '/subpages'

/**
 * 归一化挂载前缀：必须以 `/` 开头、不以 `/` 结尾（根除外）。
 * @param {unknown} raw - 配置值。
 * @returns {string} 归一化前缀。
 */
function normalizeMountPath(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MOUNT_PATH
  const trimmed = `/${raw.trim().replace(/^\/+|\/+$/gu, '')}`
  return trimmed === '/' ? DEFAULT_MOUNT_PATH : trimmed
}

/**
 * 判断路径是否为目录。
 * @param {string} path - 绝对路径。
 * @returns {Promise<boolean>} 是否存在且为目录。
 */
async function isDir(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 拼一个不带尾部斜杠的 URL 片段。
 * @param {string} base - 已归一化的前缀。
 * @param {string} suffix - 追加片段。
 * @returns {string} 拼接结果。
 */
function joinPath(base, suffix) {
  const clean = suffix.replace(/^\/+/u, '')
  return clean === '' ? base : `${base}/${clean}`
}

/**
 * 渲染一张错误/占位页（复用公共样式，保持视觉一致）。
 * @param {{ title: string, hint: string, code?: string }} params - 内容。
 * @returns {string} 完整 HTML。
 */
function statePage({ title, hint, code }) {
  const codeBlock = code === undefined ? '' : `<pre class="sp-state__code">${escapeHtml(code)}</pre>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="__ASSET_BASE__/subpage.css?v=2"></head>
<body><div class="sp-state" style="position:static;min-height:70vh">
<p class="sp-state__title">${escapeHtml(title)}</p>
<p class="sp-state__hint">${escapeHtml(hint)}</p>${codeBlock}
</div></body></html>`
}

/**
 * 最小 HTML 转义（错误页里会带上下游返回的短文本）。
 * @param {unknown} value - 待转义内容。
 * @returns {string} 转义结果。
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 探活一个子页面。**永不抛异常**：任何失败都等于「离线」。
 *
 * @param {object} page - 注册表条目。
 * @param {number} timeoutMs - 探活超时。
 * @returns {Promise<boolean>} 是否可用。
 */
async function probePage(page, timeoutMs) {
  if (page.target.kind === 'static') {
    return await isDir(page.target.dir)
  }
  const path = page.health ?? '/healthz'
  const url = new URL(`${page.target.url}${path.startsWith('/') ? path : `/${path}`}`)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise((resolve) => {
    const req = send(
      { protocol: url.protocol, hostname: url.hostname, port: url.port, method: 'GET', path: `${url.pathname}${url.search}` },
      (res) => { res.resume(); resolve(true) },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('probe timeout')) })
    req.on('error', () => resolve(false))
    req.end()
  })
}

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文（已注入 webServer / connection）。
 * @param {object} [config] - `cordis.patch.yml` 中本插件那一行的 config。
 */
export function apply(ctx, config = {}) {
  const mount = normalizeMountPath(config.mountPath)
  const timeoutMs = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
    ? Math.floor(config.requestTimeoutMs)
    : 15_000
  const probeTimeoutMs = Number.isFinite(config.probeTimeoutMs) && config.probeTimeoutMs > 0
    ? Math.floor(config.probeTimeoutMs)
    : 2000
  const webDir = join(packageRoot, 'web')

  const extraDirs = Array.isArray(config.pagesDirs)
    ? config.pagesDirs.filter((dir) => typeof dir === 'string' && dir.trim() !== '')
    : []
  // 下游会话（令牌换 cookie 后的持有者）：宿主代为持有，浏览器不接触任何凭证。
  const sessions = new DownstreamSessions()
  const registry = new SubPageRegistry({
    dirs: [join(packageRoot, 'pages'), ...extraDirs],
    logger: ctx.logger,
  })

  /**
   * 复用 DSH 的鉴权围栏。
   *
   * 注意：必须**以方法形式**调用（`connection.requestRejection(req)`）。抽成裸函数再调用
   * 会丢失 `this`，内部读不到 trustedHosts/browserAuth，于是每个请求都被判 403
   * ——dsh-pocket 踩过这个坑（它代码里有注释），这里同样避让。
   *
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @returns {401 | 403 | undefined} 拒绝码；undefined 表示放行。
   */
  function rejectionOf(req) {
    const connection = ctx.connection
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      // 没有围栏时**不 fail-open**：退回只信 loopback 的最小判据。
      const host = String(req.headers?.host ?? '').split(':')[0]
      return ['127.0.0.1', 'localhost', '::1'].includes(host) ? undefined : 403
    }
    try {
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }

  /**
   * 统一的响应结束器：先过鉴权，再交给 handler。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {(req: any, res: any) => void | Promise<void>} handler - 业务处理。
   */
  function guarded(req, res, handler) {
    const rejection = rejectionOf(req)
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
      return
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((error) => {
        ctx.logger.warn(`dsh-subpages: 处理 ${String(req.url)} 失败: ${String(error?.message ?? error)}`)
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('internal error')
        }
      })
  }

  /**
   * 发一张 HTML 状态页。
   *
   * 状态页自带 `__ASSET_BASE__` 占位符（复用同一份公共样式），这里在发送前替换成
   * 实际前缀——与壳共用占位符约定，避免两套拼接逻辑。
   *
   * @param {import('node:http').ServerResponse} res - 响应。
   * @param {number} status - 状态码。
   * @param {{ title: string, hint: string, code?: string }} body - 内容。
   */
  async function sendStatePage(res, status, body) {
    const html = statePage(body).split('__ASSET_BASE__').join(`${mount}/_assets`)
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
  }

  // ── 服务接口：让其它插件也能挂载子页面（不限于扫描目录） ──────────────
  const service = {
    /**
     * 运行时注册一个子页面。
     * @param {object} manifest - 与 subpage.json 同形。
     * @returns {Promise<{ ok: boolean, page?: object, error?: string }>} 结果。
     */
    async register(manifest) {
      const result = await registry.add(manifest, { dir: manifest?.dir ?? packageRoot })
      if (result.ok === true) {
        ctx.logger.info(`dsh-subpages: 运行时挂载子页面 ${result.page.id}（${result.page.title}）`)
        return { ok: true, page: result.page }
      }
      return result
    },
    /**
     * 卸载一个运行时子页面。
     * @param {string} id - 子页面 id。
     * @returns {boolean} 是否移除。
     */
    unregister(id) {
      return registry.remove(id)
    },
    /**
     * 列出已挂载子页面（浏览器可见投影，不含令牌）。
     * @returns {object[]} 清单。
     */
    list() {
      return registry.publicList()
    },
    /** 挂载前缀，便于其它插件拼链接。 */
    mountPath: mount,
  }

  const disposeService = ctx.reflect?.provide !== undefined
    ? ctx.reflect.provide('subPages', service)
    : undefined

  // ── 网关路由：一个前缀路由吃掉全部请求，内部分发 ─────────────────────
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: mount,
    handler: (req, res) => {
      const url = String(req.url ?? '')
      const rest = url.slice(mount.length).split('?')[0]

      // 1) 公共前端库
      if (rest === '/_assets' || rest.startsWith('/_assets/')) {
        guarded(req, res, async () => {
          const rel = rest.slice('/_assets'.length)
          const asset = await readWebAsset(webDir, rel)
          if (asset === null) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
            res.end('asset not found')
            return
          }
          res.writeHead(200, {
            'content-type': asset.contentType,
            'content-length': String(asset.body.length),
            'cache-control': 'no-store',
          })
          res.end(asset.body)
        })
        return
      }

      // 2) 清单 API（给壳用）
      if (rest === '/_api/pages' || rest.startsWith('/_api/')) {
        guarded(req, res, async () => {
          if (rest === '/_api/pages') {
            const payload = JSON.stringify({ pages: registry.publicList() })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(payload)
            return
          }
          const healthMatch = /^\/_api\/pages\/([^/]+)\/health$/u.exec(rest)
          if (healthMatch !== null) {
            const id = decodeURIComponent(healthMatch[1])
            const page = registry.get(id)
            if (page === undefined) {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ ok: false, reason: 'not-mounted' }))
              return
            }
            const ok = await probePage(page, probeTimeoutMs)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok, reason: ok ? 'ok' : 'offline' }))
            return
          }
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end('{"error":"unknown api"}')
        })
        return
      }

      // 3) 门户壳（含尾斜杠省略的等价形式）
      if (rest === '' || rest === '/' || rest === '/index.html') {
        guarded(req, res, async () => {
          const html = await renderShell(webDir, {
            assetBase: `${mount}/_assets`,
            apiBase: `${mount}/_api`,
            mountBase: mount,
          })
          // 明确禁止缓存：门户壳里嵌着子页面地址，旧壳会把人带进旧行为（实测踩过：
          // 修复前那版壳在 iframe 里表现为"一直载入中"）。
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
            'x-subpages-shell': '1',
          })
          res.end(html)
        })
        return
      }

      // 4) 子页面本体：/<id>/…
      const match = /^\/([^/]+)(\/.*)?$/u.exec(rest)
      const id = match === null ? '' : decodeURIComponent(match[1])
      const subPath = match?.[2] ?? '/'
      // 剥掉挂载前缀与 id 之后、**保留查询串**的路径：这是要转发给下游的那一段。
      const queryIndex = url.indexOf('?')
      const downstreamUrl = subPath + (queryIndex === -1 ? '' : url.slice(queryIndex))
      const page = id === '' ? undefined : registry.get(id)

      guarded(req, res, async () => {
        if (page === undefined) {
          await sendStatePage(res, 404, {
            title: `未挂载的子页面：${id}`,
            hint: '清单里没有这个 id。可能目录被删除、清单非法，或 id 与目录名不一致。',
            code: `GET ${mount}/_api/pages`,
          })
          return
        }
        if (page.target.kind === 'static') {
          await serveStatic({
            page,
            req,
            res,
            urlOverride: downstreamUrl,
            onNotFound: () => {
              void sendStatePage(res, 404, {
                title: `子页面文件不存在：${page.id}`,
                hint: '静态子页面的目录或文件缺失。',
                code: downstreamUrl,
              })
            },
          })
          return
        }
        proxyToPage({
          page,
          req,
          res,
          timeoutMs,
          urlOverride: downstreamUrl,
          // 下游不知道自己在网关后面：把它的根路径重定向补回公共前缀。
          publicBase: `${mount}/${page.id}`,
          sessions,
          // `style: inherit` 的子页面：在它返回的 HTML 里注入公共样式
          // （standalone 会被 injectSharedStyle 原样返回）。
          transformHtml: (html) => injectSharedStyle(html, {
            style: page.style,
            assetBase: `${mount}/_assets/subpage.css`,
            stripOwnStyle: page.stripOwnStyle === true,
          }),
          onError: (error) => {
            ctx.logger.warn(`dsh-subpages: 转发到子页面 ${page.id} 失败: ${String(error?.message ?? error)}`)
            if (res.writableEnded) return
            void sendStatePage(res, 502, {
              title: `子页面离线：${page.title || page.id}`,
              hint: '宿主活着，但连不上下游服务。请确认它的服务已启动后刷新。',
              code: `目标：${page.target.origin}｜原因：${String(error?.message ?? error)}`,
            })
          },
        })
      })
    },
  })

  // 扫描一次，把结果写进日志（缺清单只 warn，不影响装载）。
  void registry.scan().then(({ count, errors }) => {
    ctx.logger.info(
      `dsh-subpages: 网关挂在 ${mount}（DSH 端口），已挂载子页面 ${count} 个`
      + (errors.length > 0 ? `，${errors.length} 个清单有问题（见上文 warning）` : ''),
    )
  })

  ctx.effect(() => () => {
    disposeRoute()
    disposeService?.()
  }, 'dsh-subpages: gateway + service')
}
