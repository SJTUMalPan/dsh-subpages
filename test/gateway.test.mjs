/**
 * dsh-subpages 的测试。
 *
 * 原则：**不用 mock 断言自己的对象**。网关的每条断言都走真实 HTTP：
 *   - 宿主上下文是一个最小桩（只实现本插件真正用到的 `webServer.register` /
 *     `connection.requestRejection` / `logger` / `effect` / `reflect.provide`），
 *     正是为了让「注册了什么路由、是否先过鉴权」可被观测；
 *   - 假下游是一个真的 `node:http` 服务端，用来观察**宿主转发出去的请求头**；
 *   - 静态看板与门户壳真实落盘再读。
 *
 * 跑法：`cd dsh-subpages && npm test`
 */

import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeManifest,
  publicPage,
  readTokenFromFile,
  scanPagesDir,
  SubPageRegistry,
  expandEnvPlaceholders,
} from '../lib/registry.mjs'
import { forwardHeaders, injectSharedStyle, resolveWithin, responseHeaders, rewriteRootPaths, subPathOf } from '../lib/proxy.mjs'
import { readWebAsset, renderShell } from '../lib/assets.mjs'
import { apply } from '../lib/index.js'
import { parseBanner, readValueFromYaml, buildStartupBody, runStartupNotice, deliverStartupNotice } from '../lib/startup-notice.mjs'

// ── 测试脚手架 ────────────────────────────────────────────────────────────

/** 起一个记录请求的假下游服务。 */
async function startUpstream(handler) {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') })
      if (handler) handler(req, res, seen[seen.length - 1])
      else { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('upstream-ok') }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { origin: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) }
}

/** 起一个临时 pages 目录，写入若干看板清单。 */
async function makePages(specs) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-subpages-'))
  for (const [id, manifest, files] of specs) {
    const dir = join(root, id)
    await mkdir(dir, { recursive: true })
    if (manifest !== null) await writeFile(join(dir, 'subpage.json'), JSON.stringify(manifest, null, 2))
    for (const [name, content] of Object.entries(files ?? {})) {
      await mkdir(join(dir, name.split('/').slice(0, -1).join('/') || '.'), { recursive: true })
      await writeFile(join(dir, name), content)
    }
  }
  return root
}

/**
 * 造一个最小 DSH 上下文桩，并把本插件装进去。
 * @returns {{ ctx: object, routes: object[], provide: object }}
 */
function makeCtx({ hold = false } = {}) {
  const routes = []
  const provided = {}
  const warnings = []
  const ctx = {
    logger: { info() {}, warn(...a) { warnings.push(a.join(' ')) }, error(...a) { warnings.push(a.join(' ')) } },
    connection: {
      // 记录调用次数即可证明「每个请求都先过鉴权」。
      calls: 0,
      requestRejection() {
        this.calls += 1
        return hold ? 401 : undefined
      },
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) }
      },
    },
    effect(fn) { const dispose = fn(); return () => { if (typeof dispose === 'function') dispose() } },
    reflect: { provide(name, value) { provided[name] = value; return () => { delete provided[name] } } },
  }
  return { ctx, routes, provided, warnings }
}

/** 把一次请求打进注册好的路由，返回 { status, headers, body }。 */
function callRoute(route, { method = 'GET', url = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    // 用真的 Readable 当请求体：网关会调用 req.pipe(upstream) 转发，
    // 桩对象做不到「管道结束 → upstream.end()」，会一路卡到转发超时（假的 502）。
    const req = Readable.from([])
    Object.assign(req, { method, url, headers: { host: '127.0.0.1:3080', ...headers } })
    const chunks = []
    const res = {
      statusCode: 0, headers: {}, writableEnded: false,
      writeHead(status, hdrs) { this.statusCode = status; Object.assign(this.headers, hdrs ?? {}); return this },
      write(chunk) { if (chunk !== undefined) chunks.push(Buffer.from(chunk)); return true },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        this.writableEnded = true
        clearTimeout(timer)
        resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks).toString('utf8') })
      },
      // pipe() 会挂 'close'/'error'/'finish' 监听：桩必须支持 on/once，
      // 否则 upstream.pipe(res) 抛 TypeError，表现为假的 502。
      on() { return this },
      once() { return this },
      removeListener() { return this },
      emit() { return true },
    }
    const timer = setTimeout(() => { if (!res.writableEnded) reject(new Error('路由超时未响应')) }, 5000)
    void route.handler(req, res)
  })
}

const opened = []
after(async () => { await Promise.all(opened.map((c) => c())) })

/** 起假下游并登记清理。 */
async function openUpstream(handler) {
  const up = await startUpstream(handler)
  opened.push(up.close)
  return up
}

// ── 配置与令牌解析 ────────────────────────────────────────────────────────

describe('readTokenFromFile', () => {
  it('能从托管 YAML 里取出点号路径的值（含行内注释与引号）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tok-'))
    const file = join(dir, 'config.yaml')
    await writeFile(file, [
      '# 注释行不应干扰',
      'server:  { host: 127.0.0.1, port: 8000, log_level: INFO, auth_token: abc123 }',
      'reminders:',
      '  at: "21:00"                 # 北京时间',
      '  timezone: "Asia/Shanghai"',
      'nested:',
      '  deep:',
      '    token: deep-value',
    ].join('\n'))
    assert.equal(await readTokenFromFile(file, 'server.auth_token'), 'abc123')
    assert.equal(await readTokenFromFile(file, 'reminders.at'), '21:00')
    assert.equal(await readTokenFromFile(file, 'reminders.timezone'), 'Asia/Shanghai')
    assert.equal(await readTokenFromFile(file, 'nested.deep.token'), 'deep-value')
    assert.equal(await readTokenFromFile(file, 'nope.missing'), null)
  })

  it('文件不存在或路径为空时返回 null，不抛异常', async () => {
    assert.equal(await readTokenFromFile('/nonexistent/x.yaml', 'a.b'), null)
    assert.equal(await readTokenFromFile('/etc/hostname', ''), null)
  })
})

describe('normalizeManifest / publicPage', () => {
  const dir = '/tmp/pages/demo'

  it('接受合法清单并归一化默认值', () => {
    const result = normalizeManifest({ target: 'http://127.0.0.1:8000/' }, { dir, id: 'demo' })
    assert.equal(result.ok, true)
    assert.equal(result.page.id, 'demo')
    assert.equal(result.page.title, 'demo')
    assert.equal(result.page.order, 100)
    assert.equal(result.page.style, 'inherit')
    assert.equal(result.page.target.kind, 'proxy')
    assert.equal(result.page.target.url, 'http://127.0.0.1:8000')
    assert.equal(result.page.target.origin, 'http://127.0.0.1:8000')
  })

  it('拒绝非法 id、缺 target、坏 URL、半截 auth', () => {
    assert.equal(normalizeManifest({ id: 'Bad Id', target: 'http://x' }, { dir, id: 'x' }).ok, false)
    assert.equal(normalizeManifest({}, { dir, id: 'x' }).ok, false)
    assert.match(normalizeManifest({ target: 'http://[' }, { dir, id: 'x' }).error, /target/)
    assert.match(
      normalizeManifest({ target: 'http://x', auth: { tokenFile: '/a/b.yaml' } }, { dir, id: 'x' }).error,
      /tokenPath/,
    )
  })

  it('相对 target 解析成看板目录内的静态目录', () => {
    const result = normalizeManifest({ target: './dist' }, { dir, id: 'demo' })
    assert.equal(result.ok, true)
    assert.equal(result.page.target.kind, 'static')
    assert.equal(result.page.target.dir, '/tmp/pages/demo/dist')
  })

  it('publicPage 投影**不含**令牌与内部字段', () => {
    const result = normalizeManifest(
      { target: 'http://127.0.0.1:8000', auth: { tokenEnv: 'SECRET_TOKEN' } },
      { dir, id: 'demo' },
    )
    const page = { ...result.page, token: 'super-secret-value' }
    const projected = publicPage(page)
    const serialized = JSON.stringify(projected)
    assert.equal(serialized.includes('super-secret-value'), false)
    assert.equal(serialized.includes('SECRET_TOKEN'), false)
    assert.deepEqual(Object.keys(projected).sort(), [
      'description', 'health', 'hidden', 'icon', 'id', 'order', 'style', 'target', 'title',
    ])
  })
})

describe('expandEnvPlaceholders', () => {
  it('展开 $VAR 与 ${VAR} 两种写法', () => {
    const env = { A: 'one', B: '/x/y.yaml' }
    assert.equal(expandEnvPlaceholders('$A', env), 'one')
    assert.equal(expandEnvPlaceholders('${A}', env), 'one')
    assert.equal(expandEnvPlaceholders('$A/$B', env), 'one//x/y.yaml')
    assert.equal(expandEnvPlaceholders('/p/${A}/q', env), '/p/one/q')
  })

  it('未定义的变量展开为空串（让"没配"表现为可诊断的取不到，而不是假路径）', () => {
    assert.equal(expandEnvPlaceholders('$MISSING', {}), '')
    assert.equal(expandEnvPlaceholders('/a/${MISSING}/b', {}), '/a//b')
  })

  it('不含 $ 的字符串原样返回（不做无谓处理）', () => {
    assert.equal(expandEnvPlaceholders('/plain/path.yaml', {}), '/plain/path.yaml')
    assert.equal(expandEnvPlaceholders('', {}), '')
  })
})

describe('扫描时解析令牌来源（含占位与 ~）', () => {
  it('tokenFile 用 $VAR 占位，按运行环境展开', async () => {
    const root = await makePages([
      ['svc', { target: 'http://127.0.0.1:9001', auth: { tokenFile: '$MYCFG', tokenPath: 'server.auth_token' } }, {}],
    ])
    const cfgDir = await mkdtemp(join(tmpdir(), 'svc-cfg-'))
    const cfg = join(cfgDir, 'config.yaml')
    await writeFile(cfg, 'server:  { host: 127.0.0.1, auth_token: from-placeholder }\n')
    const { pages } = await scanPagesDir(root, { env: { MYCFG: cfg } })
    assert.equal(pages[0].token, 'from-placeholder')
  })

  it('占位变量未定义时不报错，只是取不到令牌（可诊断的降级）', async () => {
    const root = await makePages([
      ['svc', { target: 'http://127.0.0.1:9001', auth: { tokenFile: '$UNDEFINED_VAR_X', tokenPath: 'server.auth_token' } }, {}],
    ])
    const warnings = []
    const { pages } = await scanPagesDir(root, { env: {}, logger: { warn: (m) => warnings.push(m) } })
    assert.equal(pages[0].token, null)
    assert.ok(warnings.some((w) => /取不到令牌/.test(w)), warnings.join('\n'))
  })
})

describe('auth 的候选来源（tokenFileCandidates）', () => {
  it('按顺序尝试：第一个取不到就退到下一个', async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), 'cand-'))
    const good = join(cfgDir, 'config.yaml')
    await writeFile(good, 'server:  { auth_token: from-second-candidate }\n')
    const root = await makePages([
      ['svc', {
        target: 'http://127.0.0.1:9001',
        auth: { tokenFileCandidates: ['/nonexistent/first.yaml', good], tokenPath: 'server.auth_token' },
      }, {}],
    ])
    const { pages } = await scanPagesDir(root, { env: {} })
    assert.equal(pages[0].token, 'from-second-candidate')
  })

  it('占位变量未定义时跳过该候选（不当成路径去读）', async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), 'cand2-'))
    const good = join(cfgDir, 'config.yaml')
    await writeFile(good, 'server:  { auth_token: fallback-hit }\n')
    const root = await makePages([
      ['svc', {
        target: 'http://127.0.0.1:9001',
        auth: { tokenFileCandidates: ['$UNDEFINED_XYZ', good], tokenPath: 'server.auth_token' },
      }, {}],
    ])
    const { pages } = await scanPagesDir(root, { env: {} })
    assert.equal(pages[0].token, 'fallback-hit')
  })

  it('tokenFile 优先于 candidates', async () => {
    const cfgDir = await mkdtemp(join(tmpdir(), 'cand3-'))
    const first = join(cfgDir, 'a.yaml')
    const second = join(cfgDir, 'b.yaml')
    await writeFile(first, 'server:  { auth_token: from-primary }\n')
    await writeFile(second, 'server:  { auth_token: from-candidate }\n')
    const root = await makePages([
      ['svc', {
        target: 'http://127.0.0.1:9001',
        auth: { tokenFile: first, tokenFileCandidates: [second], tokenPath: 'server.auth_token' },
      }, {}],
    ])
    const { pages } = await scanPagesDir(root, { env: {} })
    assert.equal(pages[0].token, 'from-primary')
  })
})

describe('候选来源的相对路径解析', () => {
  it('相对路径按清单所在目录解析（不是进程 cwd）', async () => {
    const root = await makePages([
      ['svc', {
        target: 'http://127.0.0.1:9001',
        auth: { tokenFileCandidates: ['./config.yaml'], tokenPath: 'server.auth_token' },
      }, { 'config.yaml': 'server:  { auth_token: relative-to-manifest }\n' }],
    ])
    const { pages } = await scanPagesDir(root, { env: {} })
    assert.equal(pages[0].token, 'relative-to-manifest')
  })
})

describe('scanPagesDir', () => {
  it('扫描出合法清单；坏清单只记错误不抛异常', async () => {
    const root = await makePages([
      ['alpha', { target: 'http://127.0.0.1:9001', title: 'A', order: 20 }, {}],
      ['beta', { target: 'http://127.0.0.1:9002', title: 'B', order: 10 }, {}],
      ['broken', null, {}],
      ['badjason', null, {}],
    ])
    await writeFile(join(root, 'badjason', 'subpage.json'), '{ not json')
    const { pages, errors } = await scanPagesDir(root, { env: {} })
    assert.deepEqual(pages.map((p) => p.id), ['beta', 'alpha'])
    assert.equal(errors.length, 2)
    assert.deepEqual(errors.map((e) => e.id).sort(), ['badjason', 'broken'])
  })

  it('目录不存在时返回空结果而不是抛异常', async () => {
    const { pages, errors } = await scanPagesDir('/nonexistent/pages-dir', { env: {} })
    assert.deepEqual(pages, [])
    assert.deepEqual(errors, [])
  })
})

describe('SubPageRegistry', () => {
  it('运行时 register / list / remove，且拒绝重复 id', async () => {
    const registry = new SubPageRegistry({ dirs: [], env: {} })
    const first = await registry.register?.call?.(registry) ?? await registry.add({ id: 'x', target: 'http://127.0.0.1:1' })
    assert.equal(first.ok, true)
    assert.equal((await registry.add({ id: 'x', target: 'http://127.0.0.1:2' })).ok, false)
    assert.deepEqual(registry.publicList().map((p) => p.id), ['x'])
    assert.equal(registry.remove('x'), true)
    assert.equal(registry.remove('x'), false)
  })
})

// ── 纯函数：路径与转发头 ──────────────────────────────────────────────────

describe('路径与转发头', () => {
  it('subPathOf 折叠 .. 且保持前导斜杠', () => {
    assert.equal(subPathOf('/a/b/../c?x=1'), '/a/c')
    assert.equal(subPathOf('/'), '/')
  })

  it('resolveWithin 拒绝越界路径', () => {
    assert.equal(resolveWithin('/base', '/f.txt'), '/base/f.txt')
    assert.equal(resolveWithin('/base', '/../../etc/passwd'), null)
    assert.equal(resolveWithin('/base', '/sub/../../etc/passwd'), null)
  })

  it('forwardHeaders 丢弃 hop-by-hop、改写 Host、按 scheme 注入令牌', () => {
    const page = {
      target: { kind: 'proxy', url: 'http://127.0.0.1:8000', origin: 'http://127.0.0.1:8000' },
      auth: { header: 'Authorization', scheme: 'Bearer', queryParam: null },
    }
    const headers = forwardHeaders(
      { host: 'dsh.example:3080', connection: 'keep-alive', 'transfer-encoding': 'chunked', accept: '*/*' },
      page,
      'tok-123',
    )
    assert.equal(headers.host, '127.0.0.1:8000')
    assert.equal(headers.connection, undefined)
    assert.equal(headers['transfer-encoding'], undefined)
    assert.equal(headers.authorization, 'Bearer tok-123')
    assert.equal(headers.accept, '*/*')
  })

  it('responseHeaders 把下游的根路径重定向补回公共前缀', () => {
    const base = '/subpages/notify-hub'
    // notify-hub 令牌换 cookie 时的真实形态
    assert.equal(responseHeaders({ location: '/todos' }, base).location, '/subpages/notify-hub/todos')
    // 绝对 URL（跨域）与相对路径不动
    assert.equal(responseHeaders({ location: 'https://other.example/x' }, base).location, 'https://other.example/x')
    // 幂等：下游已经带了前缀时不再重复拼（否则 303 会自指 → 浏览器重定向循环）
    assert.equal(responseHeaders({ location: '/subpages/notify-hub/todos' }, base).location, '/subpages/notify-hub/todos')
    assert.equal(responseHeaders({ location: '/subpages/notify-hub' }, base).location, '/subpages/notify-hub')
    assert.equal(responseHeaders({ location: '/todos' }, '').location, '/todos')
    // 看板自己的「根路径跳转」在网关后面是多余的：直接落在看板首页
    assert.equal(responseHeaders({ location: '/' }, base).location, '/subpages/notify-hub/')
    assert.equal(responseHeaders({ location: 'next.html' }, base).location, 'next.html')
    // hop-by-hop 仍被丢弃，其余头保留
    const headers = responseHeaders({ 'transfer-encoding': 'chunked', 'content-type': 'text/html' }, base)
    assert.equal(headers['transfer-encoding'], undefined)
    assert.equal(headers['content-type'], 'text/html')
  })

  it('injectSharedStyle：inherit 时注入公共样式，并可选压掉看板自带样式', () => {
    const html = '<html><head><style>body{background:#fff}</style></head><body>x</body></html>'
    const asset = '/subpages/_assets/subpage.css'

    // standalone：一个字都不改
    assert.equal(injectSharedStyle(html, { style: 'standalone', assetBase: asset }), html)

    // inherit：注入 <link>，但保留看板自己的样式（不破坏它的组件类名）
    const kept = injectSharedStyle(html, { style: 'inherit', assetBase: asset })
    assert.ok(kept.includes(`<link rel="stylesheet" href="${asset}">`), kept.slice(0, 200))
    assert.ok(kept.includes('<style>body{background:#fff}</style>'), '默认不应删除看板样式')

    // inherit + stripOwnStyle：把自己的 <style> 压掉（由看板显式选择）
    const stripped = injectSharedStyle(html, { style: 'inherit', assetBase: asset, stripOwnStyle: true })
    assert.equal(stripped.includes('<style>'), false)
    assert.ok(stripped.includes(`href="${asset}"`))
    // 注入位置必须在 </head> 之前
    assert.ok(stripped.indexOf(`href="${asset}"`) < stripped.indexOf('</head>'))

    // 没有 </head> 的碎片不做注入（宁可不改，也不猜）
    assert.equal(injectSharedStyle('<div>x</div>', { style: 'inherit', assetBase: asset }), '<div>x</div>')
    // 已经是 inherit 且已有该样式表时不重复注入
    const once = injectSharedStyle(html, { style: 'inherit', assetBase: asset })
    assert.equal(injectSharedStyle(once, { style: 'inherit', assetBase: asset }).split(asset).length - 1, 1)
  })

  it('rewriteRootPaths：把根路径链接改写到挂载前缀下（否则打到 DSH 自己的路由）', () => {
    const base = '/subpages/notify-hub'
    const html = [
      '<a href="/todos">待办</a>',
      "<a href='/messages'>消息</a>",
      '<form method="post" action="/todos/3/done">',
      '<img src="/logo.png">',
      '<a href="//cdn.example.com/x.js">外站</a>',
      '<a href="#top">锚点</a>',
      '<a href="mailto:a@b.c">邮件</a>',
      '<a href="https://x.example/y">绝对 URL</a>',
      '<a href="/subpages/notify-hub/todos">已带前缀</a>',
    ].join('\n')
    const out = rewriteRootPaths(html, { publicBase: base })
    assert.ok(out.includes('href="/subpages/notify-hub/todos"'), out)
    assert.ok(out.includes("href='/subpages/notify-hub/messages'"), out)
    assert.ok(out.includes('action="/subpages/notify-hub/todos/3/done"'), out)
    assert.ok(out.includes('src="/subpages/notify-hub/logo.png"'), out)
    // 不该被动到的
    assert.ok(out.includes('href="//cdn.example.com/x.js"'))
    assert.ok(out.includes('href="#top"'))
    assert.ok(out.includes('href="mailto:a@b.c"'))
    assert.ok(out.includes('href="https://x.example/y"'))
    // 幂等：已带前缀的不再重复拼
    assert.equal(out.includes('/subpages/notify-hub/subpages/notify-hub'), false)
    // 前缀为空时原样返回
    assert.equal(rewriteRootPaths(html, { publicBase: '' }), html)
  })

  it('forwardHeaders 在 queryParam 模式下不写认证头', () => {
    const page = {
      target: { kind: 'proxy', url: 'http://127.0.0.1:8000', origin: 'http://127.0.0.1:8000' },
      auth: { header: 'Authorization', scheme: 'Bearer', queryParam: 'token' },
    }
    const headers = forwardHeaders({ host: 'x' }, page, 'tok-123')
    assert.equal(headers.authorization, undefined)
  })
})

// ── 静态资源 ──────────────────────────────────────────────────────────────

describe('公共资源与门户壳', () => {
  it('能读到公共样式，越界路径返回 null', async () => {
    const webDir = new URL('../web/', import.meta.url).pathname
    const css = await readWebAsset(webDir, '/subpage.css')
    assert.notEqual(css, null)
    assert.match(css.contentType, /text\/css/)
    assert.match(css.body.toString('utf8'), /pico\.classless/)
    assert.equal(await readWebAsset(webDir, '/../../etc/passwd'), null)
  })

  it('门户壳的占位符被替换成实际路径', async () => {
    const webDir = new URL('../web/', import.meta.url).pathname
    const html = await renderShell(webDir, {
      assetBase: '/subpages/_assets', apiBase: '/subpages/_api', mountBase: '/subpages',
    })
    assert.equal(html.includes('__ASSET_BASE__'), false)
    assert.equal(html.includes('__API_BASE__'), false)
    assert.equal(html.includes('__MOUNT_BASE__'), false)
    assert.match(html, /\/subpages\/_assets\/subpage\.css/)  // 允许带 ?v= 版本串
  })

  it('Pico 已本地化：不依赖任何外网 CDN 才能取到样式', async () => {
    const webDir = new URL('../web/', import.meta.url).pathname
    const pico = await readWebAsset(webDir, '/vendor/pico.classless.min.css')
    assert.notEqual(pico, null)
    assert.ok(pico.body.length > 10_000, `Pico 体积异常：${pico.body.length}`)
    // 公共样式自身不得引用任何 http(s) 资源（字体、图片都必须走本地或系统字体）。
    const own = await readWebAsset(webDir, '/subpage.css')
    assert.equal(/url\(\s*['"]?https?:/iu.test(own.body.toString('utf8')), false)
  })
})

// ── 网关（端到端，真实 HTTP） ─────────────────────────────────────────────

describe('网关', () => {
  /** 装好插件并返回可用的上下文与路由。 */
  async function setup({ pages, hold = false, config = {}, upstream } = {}) {
    // 令牌来自环境变量（registry 默认读 process.env）。
    process.env.SVC_TOKEN = 'SVC_TOKEN'
    const up = await openUpstream(upstream)
    const specs = pages ?? [
      ['svc', { target: up.origin, title: '服务型', order: 10, auth: { tokenEnv: 'SVC_TOKEN' } }, {}],
      ['static-one', { target: './public', title: '静态型', order: 20 }, { 'public/index.html': '<h1>static</h1>', 'public/a.txt': 'A' }],
      ['inherit-one', { target: ':UPSTREAM:', title: '继承型', order: 40, style: 'inherit' }, {}],
      ['solo-one', { target: ':UPSTREAM:', title: '自带样式型', order: 50, style: 'standalone' }, {}],
      ['offline', { target: 'http://127.0.0.1:1', title: '离线型', order: 30 }, {}],
    ]
    // 占位符替换对「默认清单」与「显式传入的清单」一视同仁——否则默认清单里的
    // inherit-one 会指向字面量 :UPSTREAM:，测试表现为假的 404 / 离线。
    for (const spec of specs) {
      if (spec[1]?.target === ':UPSTREAM:') spec[1].target = up.origin
    }
    const root = await makePages(specs)
    const { ctx, routes, provided } = makeCtx({ hold })
    apply(ctx, { pagesDir: root, probeTimeoutMs: 300, requestTimeoutMs: 2000, ...config })
    // apply 里的 scan 是异步的，等一拍让它落定。
    await new Promise((r) => setTimeout(r, 50))
    return { up, routes, ctx, provided, route: routes[0] }
  }

  it('在 DSH 的 webServer 上注册前缀路由，不新开端口', async () => {
    const { routes, route } = await setup()
    assert.equal(routes.length, 1)
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/subpages')
  })

  it('通过 ctx.subPages 暴露挂载接口', async () => {
    const { provided } = await setup()
    assert.equal(typeof provided.subPages?.register, 'function')
    assert.equal(typeof provided.subPages?.unregister, 'function')
    assert.equal(provided.subPages?.mountPath, '/subpages')
    const added = await provided.subPages.register({ id: 'runtime-one', target: 'http://127.0.0.1:9999' })
    assert.equal(added.ok, true)
    assert.equal(provided.subPages.list().some((p) => p.id === 'runtime-one'), true)
  })

  it('未认证一律 401（且每个请求都问过 connection）', async () => {
    const { route, ctx } = await setup({ hold: true })
    const res = await callRoute(route, { url: '/subpages/_api/pages' })
    assert.equal(res.status, 401)
    assert.equal(ctx.connection.calls, 1)
  })

  it('已认证时返回清单，且清单里**不含**令牌', async () => {
    const { route, up } = await setup()
    const res = await callRoute(route, { url: '/subpages/_api/pages' })
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    // 只断言本用例挂载的三个（运行时注册的条目会留在注册表里，与本用例无关）。
    const ids = body.pages.map((p) => p.id)
    for (const expected of ['svc', 'static-one', 'offline']) {
      assert.ok(ids.includes(expected), `清单里缺 ${expected}：${ids.join(',')}`)
    }
    // 关键不变量：令牌（以及承载它的环境变量名）绝不出现在浏览器可见响应里。
    assert.equal(res.body.includes('SVC_TOKEN'), false)
    assert.equal(res.body.includes('token'), false)
    void up
  })

  it('门户壳可达且占位符已替换', async () => {
    const { route } = await setup()
    for (const url of ['/subpages', '/subpages/', '/subpages/index.html']) {
      const res = await callRoute(route, { url })
      assert.equal(res.status, 200, `url=${url}`)
      assert.match(res.body, /sp-shell/)
      assert.equal(res.body.includes('__ASSET_'), false)
    }
  })

  it('公共样式可经网关取到', async () => {
    const { route } = await setup()
    const res = await callRoute(route, { url: '/subpages/_assets/subpage.css' })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'] ?? '', /text\/css/)
    assert.match(res.body, /sp-nav/)
  })

  it('反代到看板：路径去掉前缀、主机被改写、**令牌由宿主注入**', async () => {
    const { route, up } = await setup()
    const res = await callRoute(route, { url: '/subpages/svc/api/v1/todos?status=pending', headers: { authorization: 'Bearer BROWSER-VALUE' } })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'upstream-ok')
    assert.equal(up.seen.length, 1)
    assert.equal(up.seen[0].url, '/api/v1/todos?status=pending')
    assert.equal(up.seen[0].headers.host, new URL(up.origin).host.replace('127.0.0.1', '127.0.0.1'))
    // 浏览器带来的同名头被宿主的下游令牌覆盖——这是「令牌只在服务端」的落地证据。
    assert.equal(up.seen[0].headers.authorization, 'Bearer SVC_TOKEN')
  })

  it('静态看板按目录投递，且拒绝路径穿越', async () => {
    const { route } = await setup()
    const index = await callRoute(route, { url: '/subpages/static-one/' })
    assert.equal(index.status, 200)
    assert.match(index.body, /static/)
    const file = await callRoute(route, { url: '/subpages/static-one/a.txt' })
    assert.equal(file.status, 200)
    assert.equal(file.body, 'A')
    const escape = await callRoute(route, { url: '/subpages/static-one/../../../../etc/passwd' })
    assert.equal(escape.status, 404)
  })

  it('style=inherit 的看板：HTML 响应被注入公共样式', async () => {
    const upstream = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>t</title><style>.card{color:red}</style></head><body>hi</body></html>')
    }
    const { route } = await setup({ upstream })
    const res = await callRoute(route, {
      url: '/subpages/inherit-one/',
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    assert.equal(res.status, 200)
    assert.ok(res.body.includes('/subpages/_assets/subpage.css'), '未注入公共样式')
    // 默认保留看板自带样式（不破坏它的组件类名）
    assert.ok(res.body.includes('.card{color:red}'))
    // 注入位置在 </head> 之前
    assert.ok(res.body.indexOf('subpage.css') < res.body.indexOf('</head>'))
  })

  it('style=standalone 的看板：HTML 一字不改', async () => {
    const upstream = (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head></head><body>hi</body></html>')
    }
    const { route } = await setup({ upstream })
    const res = await callRoute(route, {
      url: '/subpages/solo-one/',
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.includes('subpage.css'), false)
    assert.equal(res.body, '<html><head></head><body>hi</body></html>')
  })

  it('下游用 Set-Cookie 开启会话：宿主收下 cookie、改写跳转，浏览器只走一跳', async () => {
    // 模拟 notify-hub：带令牌的请求回 303 + Set-Cookie，并跳向它自己的根路径。
    const seen = []
    const upstream = (req, res) => {
      seen.push({ url: req.url, cookie: req.headers.cookie })
      if (req.headers.cookie === undefined) {
        res.writeHead(303, {
          location: '/todos',
          'set-cookie': 'nh_session=abc123; HttpOnly; Path=/; SameSite=Lax',
        })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head></head><body>会话已建立</body></html>')
    }
    const { route } = await setup({ upstream })

    // 第一跳：浏览器只看到「跳回该看板根路径」，且**没有** set-cookie
    const first = await callRoute(route, {
      url: '/subpages/svc/',
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    assert.equal(first.status, 303)
    assert.equal(first.headers.location, '/subpages/svc/')
    assert.equal(first.headers['set-cookie'], undefined, '下游 cookie 不得透给浏览器')

    // 第二跳：宿主用持有的 cookie 请求下游，拿到真正的页面
    const second = await callRoute(route, {
      url: '/subpages/svc/',
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    })
    assert.equal(second.status, 200)
    assert.match(second.body, /会话已建立/)
    assert.equal(seen[1].cookie, 'nh_session=abc123', '第二跳应带上宿主持有的会话 cookie')
    // 有会话之后不再注入令牌（否则下游又会发起换 cookie 跳转）
    assert.equal(seen[1].url.includes('token='), false)
  })

  it('会话失效（401）时宿主丢弃会话并用令牌重试一次', async () => {
    const seen = []
    let first = true
    const upstream = (req, res) => {
      // svc 的认证方式是请求头（tokenEnv → Authorization: Bearer …）
      seen.push({ url: req.url, cookie: req.headers.cookie, auth: req.headers.authorization })
      if (first) {
        first = false
        res.writeHead(200, { 'set-cookie': 'nh_session=stale; Path=/' })
        res.end('ok')
        return
      }
      if (req.headers.cookie === 'nh_session=stale') {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('retried-with-token')
    }
    const { route } = await setup({ upstream })
    await callRoute(route, { url: '/subpages/svc/' })              // 建立（过期）会话
    const res = await callRoute(route, { url: '/subpages/svc/' })  // 触发 401 → 丢弃会话重试
    assert.equal(res.status, 200)
    assert.equal(res.body, 'retried-with-token')
    assert.equal(seen[2].cookie, undefined, '重试必须丢掉过期会话')
    assert.equal(seen[2].auth, 'Bearer SVC_TOKEN', '重试应改用令牌')
  })

  it('未注册 id 返回 404 且是明确的错误页', async () => {
    const { route } = await setup()
    const res = await callRoute(route, { url: '/subpages/nope/' })
    assert.equal(res.status, 404)
    assert.match(res.body, /未挂载的看板/)
  })

  it('下游离线返回 502 + 可读错误页，宿主不受影响', async () => {
    const { route } = await setup()
    const res = await callRoute(route, { url: '/subpages/offline/' })
    assert.equal(res.status, 502)
    assert.match(res.body, /看板离线/)
    // 宿主仍然可用：紧接着请求清单应当正常。
    const list = await callRoute(route, { url: '/subpages/_api/pages' })
    assert.equal(list.status, 200)
  })

  it('探活接口如实报告在线/离线', async () => {
    const { route } = await setup()
    const online = await callRoute(route, { url: '/subpages/_api/pages/svc/health' })
    assert.deepEqual(JSON.parse(online.body), { ok: true, reason: 'ok' })
    const offline = await callRoute(route, { url: '/subpages/_api/pages/offline/health' })
    assert.deepEqual(JSON.parse(offline.body), { ok: false, reason: 'offline' })
    const missing = await callRoute(route, { url: '/subpages/_api/pages/nope/health' })
    assert.deepEqual(JSON.parse(missing.body), { ok: false, reason: 'not-mounted' })
  })

  it('未显式启用时不产生启动通告（不能默认打开）', async () => {
    const { ctx, warnings } = makeCtx()
    // 不传 startupNotice：apply 应立即返回，不留任何等横幅的后台任务。
    // pagesDir 指向空目录，避免扫到包内自带的看板。
    apply(ctx, { pagesDir: await mkdtemp(join(tmpdir(), 'dsh-subpages-empty-')), startupNotice: undefined })
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(warnings.length, 0, '未启用时不该去等横幅或告警')
  })

  it('mountPath 可配置', async () => {
    const { route } = await setup({ config: { mountPath: 'portal' } })
    assert.equal(route.path, '/portal')
    const res = await callRoute(route, { url: '/portal/_api/pages' })
    assert.equal(res.status, 200)
  })
})
