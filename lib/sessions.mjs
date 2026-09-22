/**
 * 下游会话存储：宿主替浏览器完成「令牌 → 会话 cookie」的交换并持有它。
 *
 * 为什么必须这么做（踩过的坑）：
 *   像 notify-hub 这类服务在认证通过后会 **303 到根路径**并下发会话 cookie。
 *   如果宿主每个请求都注入令牌、又把这个 303 原样透给浏览器，浏览器就会跟随一个
 *   指向网关自身的跳转，形成**重定向循环**。而且这类服务「已认证」的表现就是
 *   「不再带令牌」，靠改写 `Location` 去修补是打地鼠。
 *
 *   正确做法是让浏览器永远只看到一跳：宿主发现下游在用 Set-Cookie 开启会话时，
 *   把该 cookie 收进本存储、把跳转改写成「跳回该子页面根路径」，后续请求由宿主附上
 *   cookie。结果是：浏览器里既没有令牌、也没有下游 cookie，凭证全在服务端。
 *
 * 单进程内存存储（DSH 是长驻进程）。会话失效的处理方式是丢弃并重试一次。
 */

/** 每个子页面一条会话记录。 */
export class DownstreamSessions {
  constructor() {
    /** @type {Map<string, { cookie: string, at: number }>} */
    this.byId = new Map()
  }

  /**
   * 记录一次响应里的 Set-Cookie。
   *
   * @param {string} pageId - 子页面 id。
   * @param {Record<string, string | string[] | undefined>} headers - 下游响应头。
   * @returns {boolean} 是否记下了新会话。
   */
  capture(pageId, headers) {
    const raw = headers['set-cookie']
    if (raw === undefined) return false
    const list = Array.isArray(raw) ? raw : [raw]
    const pairs = []
    for (const item of list) {
      // 只取 name=value 段：属性（Path/HttpOnly/SameSite…）由宿主自己决定怎么写回。
      const pair = String(item).split(';', 1)[0]?.trim()
      if (pair !== undefined && pair !== '' && pair.includes('=')) pairs.push(pair)
    }
    if (pairs.length === 0) return false
    // 同名 cookie 以最后一条为准（与浏览器行为一致）。
    const merged = new Map()
    for (const pair of pairs) {
      const eq = pair.indexOf('=')
      merged.set(pair.slice(0, eq), pair)
    }
    this.byId.set(pageId, { cookie: [...merged.values()].join('; '), at: Date.now() })
    return true
  }

  /**
   * 取某子页面当前的会话 cookie 串。
   * @param {string} pageId - 子页面 id。
   * @returns {string | null} `a=1; b=2` 形态；无会话返回 null。
   */
  cookieFor(pageId) {
    return this.byId.get(pageId)?.cookie ?? null
  }

  /**
   * 丢弃某子页面的会话（下游返回 401/403 时调用，下轮重新用令牌交换）。
   * @param {string} pageId - 子页面 id。
   * @returns {boolean} 是否确实丢弃了。
   */
  drop(pageId) {
    return this.byId.delete(pageId)
  }
}

/**
 * 把下游的 Location 改写成浏览器应当访问的地址。
 *
 * 两条规则，顺序不能变：
 *   1. **会话开启跳转**（下游带 Set-Cookie 的 3xx）：一律拉回该子页面的根路径——
 *      下游跳它的根路径意味着「回到你的首页」，而在网关后面，它的首页就是
 *      `<publicBase>/`。这是打断重定向循环的那一刀。
 *   2. 其余以 `/` 开头的跳转：补上公共前缀，且**幂等**（下游已经带了前缀就不再拼，
 *      否则会出现 `/subpages/x/subpages/x/…`）。
 *
 * @param {string} location - 下游给出的 Location。
 * @param {{ publicBase: string, sessionStarted?: boolean }} options - 上下文。
 * @returns {string} 可回写给浏览器的 Location。
 */
export function rewriteLocation(location, { publicBase, sessionStarted = false }) {
  if (typeof location !== 'string' || !location.startsWith('/')) return location
  if (publicBase === '') return location
  // 会话开启跳转：拉回该子页面根路径，浏览器只走一跳。
  if (sessionStarted) return `${publicBase}/`
  // 根路径跳转同理：在网关后面，子页面的 "/" 就是它的首页，再跳一次是多余的
  // （notify-hub 的 "/" 会 303 到 "/todos"，照搬会让浏览器多走一跳、还容易绕成环）。
  if (location === '/' || location === '') return `${publicBase}/`
  const already = location === publicBase || location.startsWith(`${publicBase}/`)
  return already ? location : `${publicBase}${location}`
}
