/**
 * 启动通告：每次 DSH 启动时，把「带 token 的访问链接」投递到 notify-hub 并转发到飞书。
 *
 * 为什么以插件形式做：插件是**每次 DSH 启动都会装载**的东西——无论 DSH 是被
 * keepalive 拉起、被脚本重启、还是手动启动，它都会执行。放在启动脚本里则只在
 * 那条路径上生效，换个方式启动就漏了。
 *
 * token 的唯一来源是启动横幅（`dsh web: http://127.0.0.1:<port>/?token=<t>`）：
 * DSH 把启动 token 存在连接服务的**进程私有 WeakMap** 里，插件无法从内存取到，
 * 也没有落盘文件（已核实）。所以这里读启动日志——并且**只从本次启动新增的字节里读**，
 * 否则会把上一次启动的旧 token 当成新的发出去（那就是一条死链，实测踩过）。
 *
 * 全部失败都只记日志：启动通告是锦上添花，绝不能因为读不到日志或飞书不通而影响 DSH 启动。
 */

import { readFile, stat } from 'node:fs/promises'

import { readTokenFromFile } from './registry.mjs'

/** 从托管 YAML 读点号路径的值：复用 registry 的实现，避免同一逻辑两份拷贝（曾因此行为不一致）。 */
export const readValueFromYaml = readTokenFromFile

/** 默认启动横幅所在文件（`run-dsh.sh` 把 `dsh web` 的输出重定向到这里）。 */
export const DEFAULT_WEB_LOG = '/tmp/dsh-web.log'

/** 等待横幅出现的上限：插件可能先于横幅打印完成装载（实测竞态，必须等）。 */
const DEFAULT_WAIT_MS = 30_000

/** 轮询间隔。 */
const POLL_MS = 1_000

/**
 * 从一段文本里抽出**最后一条**启动横幅。
 *
 * @param {string} text - 待搜索文本。
 * @returns {{ port: string, token: string } | null} 端口与 token。
 */
export function parseBanner(text) {
  const pattern = /dsh web: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]{20,})/g
  let last = null
  for (const match of String(text ?? '').matchAll(pattern)) {
    last = { port: match[1], token: match[2] }
  }
  return last
}

/**
 * 读**新增**部分里的启动横幅：先记下起始字节偏移，只在之后追加的内容里找。
 *
 * @param {string} logPath - 日志文件路径。
 * @param {number} since - 起始字节偏移（0 表示从头）。
 * @returns {Promise<{ port: string, token: string } | null>} 横幅；没出现返回 null。
 */
export async function readNewBanner(logPath, since = 0) {
  let text
  try {
    const info = await stat(logPath)
    if (info.size <= since) return null
    const handle = await readFile(logPath)
    text = handle.subarray(since).toString('utf8')
  } catch {
    return null
  }
  return parseBanner(text)
}

/**
 * 日志当前字节数；读不到按 0 处理（等价于从头找）。
 * @param {string} logPath - 日志路径。
 * @returns {Promise<number>} 字节数。
 */
export async function logSize(logPath) {
  try {
    return (await stat(logPath)).size
  } catch {
    return 0
  }
}

/**
 * 等到出现「本次启动」的横幅为止。
 *
 * @param {{ logPath: string, since: number, waitMs?: number, logger?: object, sleep?: (ms: number) => Promise<void> }} params - 参数。
 * @returns {Promise<{ port: string, token: string } | null>} 横幅或 null。
 */
export async function waitForBanner({ logPath, since, waitMs = DEFAULT_WAIT_MS, logger, sleep }) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => { setTimeout(resolve, ms) }))
  const deadline = Date.now() + waitMs
  for (;;) {
    const banner = await readNewBanner(logPath, since)
    if (banner !== null) return banner
    if (Date.now() >= deadline) {
      logger?.warn?.(`dsh-subpages: ${waitMs}ms 内未在 ${logPath} 里等到启动横幅，跳过启动通告`)
      return null
    }
    await pause(POLL_MS)
  }
}

/**
 * 组装启动通告的正文。
 * @param {{ url: string, port: string, startedAt?: string }} params - 参数。
 * @returns {string} 正文。
 */
export function buildStartupBody({ url, port, startedAt }) {
  return [
    'DSH 刚刚启动，访问链接如下（点开即用，无需再输令牌）：',
    '',
    url,
    '',
    `端口：${port}${startedAt === undefined ? '' : `｜启动时间：${startedAt}`}`,
    '若打不开，等 20 秒重试（DSH 可能仍在初始化）。',
  ].join('\n')
}

/**
 * 投递启动通告。
 *
 * @param {object} params - 参数。
 * @param {object} params.page - 注册表条目（提供 tokenFile 之类的凭据来源）。
 * @param {string | null} params.token - notify-hub 的访问令牌。
 * @param {string | null} params.endpoint - notify-hub 地址。
 * @param {{ port: string, token: string }} params.banner - 启动横幅。
 * @param {string} params.publicHost - 对外主机（IP 或域名）。
 * @param {number} [params.timeoutMs] - HTTP 超时。
 * @param {Date} [params.now] - 注入时间（测试用）。
 * @param {typeof fetch} [params.fetchImpl] - 注入 fetch（测试用）。
 * @param {object} [params.logger] - 日志。
 * @returns {Promise<{ ok: boolean, status?: number, error?: string, url?: string }>} 结果。
 */
export async function deliverStartupNotice({
  banner, publicHost, endpoint, token, timeoutMs = 10_000, now = new Date(), fetchImpl = fetch, logger,
}) {
  if (endpoint === null || token === null) {
    logger?.warn?.('dsh-subpages: 启动通告缺少 notify-hub 地址或令牌，跳过')
    return { ok: false, error: 'missing endpoint or token' }
  }
  const url = `http://${publicHost}:${banner.port}/?token=${banner.token}`
  const payload = {
    source: 'dsh-startup',
    title: 'DSH 已启动（新链接）',
    body: buildStartupBody({ url, port: banner.port, startedAt: now.toISOString() }),
    level: 'info',
    need_ack: false,
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(`${endpoint}/api/v1/messages?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      logger?.warn?.(`dsh-subpages: 启动通告投递失败 HTTP ${response.status}: ${text.slice(0, 160)}`)
      return { ok: false, status: response.status, error: text.slice(0, 160), url }
    }
    logger?.info?.(`dsh-subpages: 启动通告已投递（${response.status}），链接：${url.replace(banner.token, '<token>')}`)
    return { ok: true, status: response.status, url }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(error?.message ?? error)
    logger?.warn?.(`dsh-subpages: 启动通告投递异常：${reason}`)
    return { ok: false, error: reason, url }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动通告的完整流程：等横幅 → 找 notify-hub 凭据 → 投递。
 *
 * @param {object} params - 参数。
 * @param {object} params.config - 插件配置里的 `startupNotice` 段。
 * @param {object} params.logger - 日志。
 * @param {Record<string, string | undefined>} params.env - 环境变量。
 * @param {(ms: number) => Promise<void>} [params.sleep] - 注入 sleep（测试用）。
 * @param {typeof fetch} [params.fetchImpl] - 注入 fetch（测试用）。
 * @returns {Promise<{ ok: boolean }>} 结果。
 */
export async function runStartupNotice({ config = {}, logger, env = process.env, sleep, fetchImpl }) {
  if (config.enabled === false) {
    logger?.info?.('dsh-subpages: 启动通告已配置为关闭')
    return { ok: false }
  }
  const logPath = typeof config.logPath === 'string' && config.logPath !== ''
    ? config.logPath
    : DEFAULT_WEB_LOG
  // 必须在**等待之前**取偏移：插件可能先于横幅打印装载，那时文件里还没有本次横幅。
  const since = await logSize(logPath)
  const banner = await waitForBanner({
    logPath, since, waitMs: config.waitMs ?? DEFAULT_WAIT_MS, logger, sleep,
  })
  if (banner === null) return { ok: false }

  const host = typeof config.publicHost === 'string' && config.publicHost !== ''
    ? config.publicHost
    : (env.DSH_PUBLIC_HOST ?? '')

  const endpoint = typeof config.endpoint === 'string' && config.endpoint !== ''
    ? config.endpoint.replace(/\/+$/u, '')
    : 'http://127.0.0.1:8000'
  const token = config.tokenFile !== undefined
    ? await readValueFromYaml(config.tokenFile, config.tokenPath ?? 'server.auth_token')
    : (env.DSH_NOTIFY_HUB_TOKEN ?? null)

  if (host === '') {
    logger?.warn?.('dsh-subpages: 未配置 publicHost（或 DSH_PUBLIC_HOST），无法拼出对外链接，跳过启动通告')
    return { ok: false }
  }

  const result = await deliverStartupNotice({
    banner, publicHost: host, endpoint, token, logger, fetchImpl,
    timeoutMs: config.timeoutMs ?? 10_000,
  })
  if (result.ok === true) {
    // 顺带让用户知道：飞书里能直接点开的那个链接。
    logger?.info?.(`dsh-subpages: 启动通告 OK（host=${host} port=${banner.port}）`)
  }
  return { ok: result.ok === true }
}
