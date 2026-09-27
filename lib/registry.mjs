/**
 * 看板注册表：扫描 `pages/<id>/subpage.json` 建表，并提供 `ctx.subPages` 背后的
 * 增删查能力。
 *
 * 设计约束（改代码前先读）：
 *   - **不引入任何第三方依赖**：subpage.json 是极小的扁平 JSON，用 JSON.parse +
 *     逐字段校验即可，不为了读 8 个字段引入 yaml/zod。
 *   - **一个坏清单不能拖垮其它看板**：单个目录清单非法只记 warning 并跳过，
 *     绝不 throw（页面上表现为「该看板未挂载」，而不是整个插件装载失败）。
 *   - **顺序稳定**：按 (order, id) 排序，保证导航栏顺序可预测、可 diff。
 *   - **凭据只在服务端**：令牌在这里解析成内存值，只用于转发请求的请求头，
 *     永远不进清单响应体、不进 URL、不进日志。
 */

import { readFile, readdir, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

/** 清单文件名。 */
export const MANIFEST_NAME = 'subpage.json'

/** id 只允许 kebab-case，因为它要进 URL 路径段。 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 判断路径是否存在（不区分文件/目录）。
 * @param {string} path - 绝对路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 从清单对象里取字符串字段。
 * @param {Record<string, unknown>} raw - 清单原文。
 * @param {string} key - 字段名。
 * @returns {string | null} 去空白后的字符串；缺失或非字符串返回 null。
 */
function str(raw, key) {
  const value = raw[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * 校验并归一化一份清单。
 *
 * @param {unknown} raw - JSON.parse 的结果。
 * @param {{ dir: string, id: string }} context - 所在目录与目录名（id 的兜底来源）。
 * @returns {{ ok: true, page: object } | { ok: false, error: string }} 结果。
 */
export function normalizeManifest(raw, context) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '清单必须是 JSON 对象' }
  }
  const record = /** @type {Record<string, unknown>} */ (raw)

  const id = str(record, 'id') ?? context.id
  if (!ID_PATTERN.test(id)) {
    return { ok: false, error: `id ${JSON.stringify(id)} 不是 kebab-case（只允许小写字母、数字、连字符）` }
  }

  const title = str(record, 'title') ?? id
  const orderRaw = record.order
  const order = typeof orderRaw === 'number' && Number.isFinite(orderRaw) ? orderRaw : 100

  // target：http(s) 地址 = 反向代理；相对/绝对路径 = 静态目录
  const targetRaw = str(record, 'target')
  if (targetRaw === null) return { ok: false, error: '缺少 target（看板的 http 地址或静态目录）' }
  let target
  if (/^https?:\/\//iu.test(targetRaw)) {
    let url
    try {
      url = new URL(targetRaw)
    } catch {
      return { ok: false, error: `target 不是合法 URL: ${targetRaw}` }
    }
    target = { kind: 'proxy', url: targetRaw.replace(/\/+$/u, ''), origin: url.origin }
  } else {
    const expanded = expandEnvPlaceholders(targetRaw, context.env ?? process.env)
    const dir = isAbsolute(expanded) ? expanded : resolve(context.dir, expanded)
    target = { kind: 'static', dir }
  }

  const staticIndex = str(record, 'index') ?? 'index.html'

  // auth：可选。tokenEnv 优先，tokenFile + tokenPath 作为「不新增配置」的兜底。
  let auth = null
  const authRaw = record.auth
  if (authRaw !== undefined && authRaw !== null) {
    if (typeof authRaw !== 'object' || Array.isArray(authRaw)) {
      return { ok: false, error: 'auth 必须是对象' }
    }
    const a = /** @type {Record<string, unknown>} */ (authRaw)
    const tokenEnv = str(a, 'tokenEnv')
    const tokenFile = str(a, 'tokenFile')
    const tokenPath = str(a, 'tokenPath')
    const header = str(a, 'header') ?? (str(a, 'queryParam') ? null : 'Authorization')
    const scheme = str(a, 'scheme') ?? 'Bearer'
    const queryParam = str(a, 'queryParam')
    // tokenFileCandidates：按顺序尝试多个来源，用于「先在环境变量指的位置找，
    // 找不到再退回约定默认路径」这类可移植清单（开源清单不该把某一台机器的布局写死）。
    const candidates = Array.isArray(a.tokenFileCandidates)
      ? a.tokenFileCandidates.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim())
      : []
    const tokenFiles = tokenFile !== null ? [tokenFile, ...candidates] : candidates
    if (tokenEnv === null && tokenFiles.length === 0) {
      return { ok: false, error: 'auth 需要 tokenEnv、tokenFile 或 tokenFileCandidates 之一' }
    }
    if (tokenFiles.length > 0 && tokenPath === null) {
      return { ok: false, error: 'auth.tokenPath 必填（如 server.auth_token），它指明在配置文件里的哪个键' }
    }
    auth = { tokenEnv, tokenFile, tokenFiles, tokenPath, header, scheme, queryParam }
  }

  const health = str(record, 'health')
  const icon = str(record, 'icon')
  const description = str(record, 'description')
  const style = str(record, 'style') === 'standalone' ? 'standalone' : 'inherit'
  const hidden = record.hidden === true
  // 仅对 style=inherit 有意义：压掉看板自带的 <style>（它得先按公共约定重写标记）。
  const stripOwnStyle = record.stripOwnStyle === true

  return {
    ok: true,
    page: {
      id,
      title,
      order,
      icon,
      description,
      style,
      hidden,
      stripOwnStyle,
      dir: context.dir,
      target,
      staticIndex,
      auth,
      health,
      source: 'scan',
      /** 令牌解析结果；只在内存里，绝不外传。 */
      token: null,
      error: null,
    },
  }
}

/**
 * 在 YAML 行内流式映射里按**剩余路径**取值。
 *
 * 为什么需要它：notify-hub 的配置就是这种写法
 * （`server: { host: …, auth_token: … }`）。而且流式映射可能出现在**中间层**
 * （路径的最后一段藏在里面），所以参数是路径数组而不是单个键。
 *
 * @param {string} text - 花括号内的内容（不含花括号）。
 * @param {string[]} path - 剩余要匹配的键路径（至少一段）。
 * @returns {string | null} 值（去引号）；找不到返回 null。
 */
function valueInFlowMap(text, path) {
  if (path.length === 0) return null
  const [key, ...restPath] = path
  let depth = 0
  let current = ''
  const parts = []
  for (const char of text) {
    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current); current = ''; continue }
    current += char
  }
  parts.push(current)

  for (const part of parts) {
    const match = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(part)
    if (match === null || match[1] !== key) continue
    const raw = match[2].replace(/#.*$/u, '').trim()
    if (restPath.length === 0) {
      const value = raw.replace(/^['"]|['"]$/gu, '').trim()
      return value === '' ? null : value
    }
    if (!raw.startsWith('{')) continue
    return valueInFlowMap(raw.replace(/^\{/u, '').replace(/\}\s*$/u, ''), restPath)
  }
  return null
}

/**
 * 读取配置文件里某个点号路径的值。
 *
 * 只解析「缩进即层级」的托管 YAML 子集（键、标量、嵌套块、行内注释、行内流式映射），
 * 目的是让插件能直接复用下游服务已有的那份配置，而不是让用户再抄一份令牌到环境变量里。
 * 解析不出来时返回 null——**绝不抛异常**，因为「读不到」的后果只是转发会拿到 401，
 * 不该让插件装载失败。
 *
 * @param {string} file - 配置文件绝对路径。
 * @param {string} dottedPath - 形如 `server.auth_token`。
 * @returns {Promise<string | null>} 值（去引号、去空白）；取不到返回 null。
 */
export async function readTokenFromFile(file, dottedPath) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return null
  }
  const wanted = dottedPath.split('.').filter(Boolean)
  if (wanted.length === 0) return null

  /**
   * 当前路径栈。**只压入「真值行」**，容器行（`key:` / `key: {}`）不入栈——
   * 容器不是路径的一段值，压进去会让长度判断永远差一层。
   */
  // 只压入「已经匹配上的前缀」。取值条件是：当前行正好补齐了 wanted 的最后一段。
  // 用绝对深度比较（stack.length + 1 === wanted.length），不用任何相对偏移——这类
  // 偏移量写错过两次，代价是半小时排查。
  const stack = []
  for (const line of text.split(/\r?\n/u)) {
    const withoutComment = line.replace(/(^|\s)#.*$/u, '')
    if (withoutComment.trim() === '') continue
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(withoutComment)
    if (match === null) continue

    const indent = match[1].length
    const key = match[2]
    const rest = match[3].trim()

    // 结束所有缩进不浅于当前行的层级。
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()

    // 当前行必须是「当前期望的那一段」，否则与目标路径无关。
    if (key !== wanted[stack.length]) continue

    const isFlowMap = rest.startsWith('{')
    const isContainer = rest === '' || rest === '{}'

    // 补齐了最后一段：取标量，或从行内流式映射里按剩余路径取。
    if (stack.length + 1 === wanted.length) {
      if (isFlowMap) {
        const inner = rest.replace(/^\{/u, '').replace(/\}\s*$/u, '')
        return valueInFlowMap(inner, [wanted[wanted.length - 1]])
      }
      if (isContainer) continue
      const value = rest.replace(/^['"]|['"]$/gu, '').trim()
      return value === '' ? null : value
    }

    // 还差几段：当前行是容器（块状或流式）才继续下钻。
    if (isFlowMap) {
      // 流式映射可能一口气包住剩余全部路径：直接按剩余路径取值。
      const inner = rest.replace(/^\{/u, '').replace(/\}\s*$/u, '')
      const value = valueInFlowMap(inner, wanted.slice(stack.length + 1))
      if (value !== null) return value
      continue
    }
    if (isContainer) stack.push({ key, indent })
  }
  return null
}

/**
 * 解析一个看板的令牌（若声明了 auth）。
 * @param {object} page - 注册表条目。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {Promise<string | null>} 令牌；未配置或取不到返回 null。
 */
/**
 * 展开字符串里的环境变量占位：`$VAR` 与 `${VAR}`。
 *
 * 为什么需要它：看板清单是要提交进各自仓库、给别人用的，而"下游配置文件在哪"
 * 是**每台机器不同**的。写死绝对路径等于把某个人的机器布局固化进开源仓库
 * （本仓库早期就这么干过：`tokenFile: /root/notify-hub-run/config.yaml`）。
 * 约定：清单里写 `$NOTIFY_HUB_CONFIG` 这类占位，宿主按运行环境展开。
 *
 * 未定义的变量展开为空串（而不是保留字面量）：这样"没配"表现为可诊断的
 * 「取不到令牌」告警，而不是一个看起来像路径的假值。
 *
 * @param {string} value - 原始字符串。
 * @param {Record<string, string | undefined>} env - 环境变量表。
 * @returns {string} 展开后的字符串。
 */
export function expandEnvPlaceholders(value, env) {
  if (typeof value !== 'string' || !value.includes('$')) return value
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_m, name) => env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/gu, (_m, name) => env[name] ?? '')
}

export async function resolveToken(page, env) {
  if (page.auth === null) return null
  if (page.auth.tokenEnv !== null) {
    const value = env[page.auth.tokenEnv]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  for (const raw of page.auth.tokenFiles ?? []) {
    let file = expandEnvPlaceholders(raw, env)
    if (file === '') continue // 占位变量未定义 → 直接试下一个候选，而不是当成路径
    // 支持 `~`：清单是给别人用的，"下游配置在哪"常见写法就是 ~/xxx/config.yaml。
    if (file === '~' || file.startsWith('~/')) {
      file = join(homedir(), file.replace(/^~\/?/u, ''))
    }
    // 相对路径按**清单所在目录**解析（与 notify-hub 自己解析 db_path/rules_path 的约定一致）。
    // 不能按进程 cwd：那会让 `./config.yaml` 落到 DSH 的工作目录，静默找不到（实测踩过）。
    if (!isAbsolute(file)) file = resolve(page.dir, file)
    const token = await readTokenFromFile(file, page.auth.tokenPath)
    if (token !== null) return token
  }
  return null
}

/**
 * 对外暴露的清单投影：**只含 id / title / icon / order / description / style / health**。
 *
 * 这是「令牌不进浏览器」这条不变量的实现点：任何新增字段都必须先问一句
 * 「浏览器需要看到它吗」。
 *
 * @param {object} page - 注册表条目。
 * @returns {object} 可安全序列化给浏览器的对象。
 */
export function publicPage(page) {
  return {
    id: page.id,
    title: page.title,
    icon: page.icon,
    order: page.order,
    description: page.description,
    style: page.style,
    hidden: page.hidden,
    health: page.health,
    // 只暴露代理形态的对外地址；静态形态的目录路径属于宿主内部信息，不外传。
    // （早期实现这里对静态形态也返回 null，语义上没问题，但读者会以为是缺字段。）
    target: page.target.kind === 'proxy' ? page.target.origin : undefined,
  }
}

/**
 * 扫描一个目录下的所有看板清单。
 *
 * @param {string} dir - 含若干 `<id>/subpage.json` 的目录。
 * @param {{ logger?: object, env?: Record<string, string | undefined> }} [options] - 日志与环境变量。
 * @returns {Promise<{ pages: object[], errors: { id: string, error: string }[] }>} 结果。
 */
export async function scanPagesDir(dir, options = {}) {
  const logger = options.logger ?? null
  const env = options.env ?? process.env
  const pages = []
  const errors = []

  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code !== 'ENOENT' && logger !== null) {
      logger.warn?.(`dsh-subpages: 无法读取看板目录 ${dir}: ${String(error?.message ?? error)}`)
    }
    return { pages, errors }
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const pageDir = join(dir, entry.name)
    const manifestPath = join(pageDir, MANIFEST_NAME)
    if (!(await exists(manifestPath))) {
      // 目录存在但没有清单：报告出来，但**不打扰日志**——正在开发的目录很常见，
      // 而页面上的「未挂载」表现已经足够诊断。
      errors.push({ id: entry.name, error: `缺少 ${MANIFEST_NAME}` })
      continue
    }

    let raw
    try {
      raw = JSON.parse(await readFile(manifestPath, 'utf8'))
    } catch (error) {
      const message = `清单解析失败: ${String(error?.message ?? error)}`
      errors.push({ id: entry.name, error: message })
      logger?.warn?.(`dsh-subpages: ${pageDir}/${MANIFEST_NAME} ${message}`)
      continue
    }

    const result = normalizeManifest(raw, { dir: pageDir, id: entry.name, env })
    if (!result.ok) {
      errors.push({ id: entry.name, error: result.error })
      logger?.warn?.(`dsh-subpages: ${pageDir}/${MANIFEST_NAME} 非法：${result.error}`)
      continue
    }

    result.page.token = await resolveToken(result.page, env)
    if (result.page.auth !== null && result.page.token === null) {
      // 不阻断挂载：令牌缺失时页面照常可见，只是转发会拿到下游的 401。
      // 这样「配置漏了」表现为可诊断的 401，而不是「页面凭空消失」。
      logger?.warn?.(
        `dsh-subpages: 看板 ${result.page.id} 声明了 auth 但取不到令牌`
        + `（tokenEnv=${String(result.page.auth.tokenEnv)} tokenFile=${String(result.page.auth.tokenFile)}）`,
      )
    }
    pages.push(result.page)
  }

  pages.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  return { pages, errors }
}

/**
 * 注册表：扫描 + 运行时增删（`ctx.subPages` 的实现后端）。
 */
export class SubPageRegistry {
  /**
   * @param {{ dirs?: string[], logger?: object, env?: Record<string, string | undefined> }} [options] - 目录与日志。
   */
  constructor(options = {}) {
    this.dirs = options.dirs ?? []
    this.logger = options.logger ?? null
    this.env = options.env ?? process.env
    /** @type {Map<string, object>} */
    this.pages = new Map()
    this.scanned = false
  }

  /**
   * 扫描全部目录并重建注册表（运行时注册的条目会被保留）。
   * @returns {Promise<{ count: number, errors: { id: string, error: string }[] }>} 结果。
   */
  async scan() {
    const errors = []
    const found = []
    for (const dir of this.dirs) {
      const result = await scanPagesDir(dir, { logger: this.logger, env: this.env })
      found.push(...result.pages)
      errors.push(...result.errors)
    }
    for (const page of found) {
      if (this.pages.has(page.id)) {
        const existing = this.pages.get(page.id)
        if (existing.source === 'scan') {
          this.logger?.warn?.(`dsh-subpages: 看板 id 冲突，后者被忽略：${page.id}（${page.dir}）`)
          errors.push({ id: page.id, error: `id 重复：${page.dir}` })
        }
        continue
      }
      this.pages.set(page.id, page)
    }
    this.scanned = true
    return { count: found.length, errors }
  }

  /**
   * 运行时注册（供 `ctx.subPages.register` 使用）。
   * @param {object} manifest - 与 subpage.json 同形的对象。
   * @param {{ dir?: string }} [context] - 可选上下文。
   * @returns {Promise<{ ok: true, page: object } | { ok: false, error: string }>} 结果。
   */
  async add(manifest, context = {}) {
    const dir = context.dir ?? process.cwd()
    const candidate = typeof manifest?.id === 'string' ? manifest.id : ''
    const result = normalizeManifest(manifest, { dir, id: candidate, env: this.env })
    if (!result.ok) return result
    if (this.pages.has(result.page.id)) {
      return { ok: false, error: `看板 id 已存在：${result.page.id}` }
    }
    result.page.source = 'runtime'
    result.page.token = await resolveToken(result.page, this.env)
    this.pages.set(result.page.id, result.page)
    return { ok: true, page: result.page }
  }

  /**
   * 移除一个条目。
   * @param {string} id - 看板 id。
   * @returns {boolean} 是否真的移除了。
   */
  remove(id) {
    return this.pages.delete(id)
  }

  /**
   * 按 id 取条目。
   * @param {string} id - 看板 id。
   * @returns {object | undefined} 条目。
   */
  get(id) {
    return this.pages.get(id)
  }

  /**
   * 全部条目（已排序）。
   * @returns {object[]} 条目数组。
   */
  list() {
    return [...this.pages.values()].sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id))
  }

  /**
   * 浏览器可见的清单（不含令牌等敏感字段）。
   * @returns {object[]} 投影数组。
   */
  publicList() {
    return this.list().map(publicPage)
  }
}
