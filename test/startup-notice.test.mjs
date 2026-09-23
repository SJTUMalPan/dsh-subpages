/**
 * 启动通告的测试。
 *
 * 关键行为都要钉住，因为这个功能的价值就是"每次启动都发对链接"：
 *   - 只认**新增**横幅（读旧横幅会把死链发到用户手机上，实盘踩过）；
 *   - 拼出的 URL 必须带端口与 token；
 *   - notify-hub 的凭据从它自己的 YAML 里读；
 *   - 投递失败只记日志、不抛异常（绝不影响 DSH 启动）；
 *   - 未显式启用时完全不动。
 *
 * 跑法：`cd dsh-subpages && npm test`
 */

import { createServer } from 'node:http'
import { appendFile, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildStartupBody,
  deliverStartupNotice,
  parseBanner,
  readNewBanner,
  readValueFromYaml,
  runStartupNotice,
  waitForBanner,
} from '../lib/startup-notice.mjs'

const opened = []
after(async () => { await Promise.all(opened.map((close) => close())) })

/** 起一个假 notify-hub，记录收到的请求体。 */
async function startSink({ status = 202, body = '{"message_id":1}' } = {}) {
  const seen = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({ url: req.url, raw: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body)
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const close = () => new Promise((r) => server.close(() => r()))
  opened.push(close)
  return { endpoint: `http://127.0.0.1:${server.address().port}`, seen }
}

/** 造一个临时日志文件。 */
async function makeLog(initial = '') {
  const dir = await mkdtemp(join(tmpdir(), 'startup-notice-'))
  const path = join(dir, 'dsh-web.log')
  await writeFile(path, initial)
  return { path, dir }
}

const BANNER = (port, token) => `dsh web: http://127.0.0.1:${port}/?token=${token}\n`

describe('parseBanner', () => {
  it('取最后一条横幅（日志可能含多次启动）', () => {
    const text = BANNER(3080, 'A'.repeat(43)) + 'noise\n' + BANNER(3080, 'B'.repeat(43))
    assert.deepEqual(parseBanner(text), { port: '3080', token: 'B'.repeat(43) })
  })

  it('没有横幅或 token 太短时返回 null', () => {
    assert.equal(parseBanner('nothing here'), null)
    assert.equal(parseBanner('dsh web: http://127.0.0.1:3080/?token=short'), null)
  })
})

describe('readNewBanner / waitForBanner', () => {
  it('只从起始偏移之后找，不会把旧横幅当成新的', async () => {
    const { path } = await makeLog(BANNER(3080, 'O'.repeat(43)))
    const size = (await stat(path)).size
    // 基线 = 当前长度 → 旧横幅在基线之前，不该被读到
    assert.equal(await readNewBanner(path, size), null)
    // 追加一条新的 → 只能读到新的
    await appendFile(path, BANNER(3080, 'N'.repeat(43)))
    assert.deepEqual(await readNewBanner(path, size), { port: '3080', token: 'N'.repeat(43) })
  })

  it('横幅迟到时会等待（竞态修复）', async () => {
    const { path } = await makeLog('')
    const banner = BANNER(3081, 'C'.repeat(43))
    setTimeout(() => { void appendFile(path, banner) }, 120)
    const got = await waitForBanner({ logPath: path, since: 0, waitMs: 3000 })
    assert.deepEqual(got, { port: '3081', token: 'C'.repeat(43) })
  })

  it('超时返回 null 且只记 warning', async () => {
    const { path } = await makeLog('')
    const warnings = []
    const got = await waitForBanner({
      logPath: path, since: 0, waitMs: 200,
      logger: { warn: (m) => warnings.push(m) },
      sleep: () => new Promise((r) => setTimeout(r, 20)),
    })
    assert.equal(got, null)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /未在 .* 里等到启动横幅/)
  })
})

describe('readValueFromYaml', () => {
  it('读点号路径（含行内流式映射）', async () => {
    const { dir } = await makeLog('')
    const file = join(dir, 'config.yaml')
    await writeFile(file, 'server:  { host: 127.0.0.1, auth_token: abc123 }\n')
    assert.equal(await readValueFromYaml(file, 'server.auth_token'), 'abc123')
    assert.equal(await readValueFromYaml(file, 'server.missing'), null)
    assert.equal(await readValueFromYaml('/nonexistent.yaml', 'a.b'), null)
  })
})

describe('deliverStartupNotice', () => {
  it('把带端口与 token 的链接投到 notify-hub，且请求体含该链接', async () => {
    const sink = await startSink()
    const banner = { port: '3080', token: 'T'.repeat(43) }
    const result = await deliverStartupNotice({
      banner, publicHost: '1.2.3.4', endpoint: sink.endpoint, token: 'nh-token',
    })
    assert.equal(result.ok, true)
    assert.equal(result.url, `http://1.2.3.4:3080/?token=${'T'.repeat(43)}`)
    assert.equal(sink.seen.length, 1)
    assert.match(sink.seen[0].url, /\/api\/v1\/messages\?token=nh-token/)
    const payload = JSON.parse(sink.seen[0].raw)
    assert.equal(payload.source, 'dsh-startup')
    assert.equal(payload.need_ack, false)
    assert.ok(payload.body.includes(`http://1.2.3.4:3080/?token=${'T'.repeat(43)}`), payload.body)
  })

  it('缺凭据时不发请求，只返回失败', async () => {
    const sink = await startSink()
    const result = await deliverStartupNotice({
      banner: { port: '3080', token: 'T'.repeat(43) }, publicHost: '1.2.3.4',
      endpoint: sink.endpoint, token: null,
    })
    assert.equal(result.ok, false)
    assert.equal(sink.seen.length, 0)
  })

  it('下游报错时不抛异常', async () => {
    const sink = await startSink({ status: 401, body: '{"detail":"unauthorized"}' })
    const result = await deliverStartupNotice({
      banner: { port: '3080', token: 'T'.repeat(43) }, publicHost: '1.2.3.4',
      endpoint: sink.endpoint, token: 'wrong',
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 401)
  })
})

describe('runStartupNotice', () => {
  it('未显式启用时什么都不做', async () => {
    const sink = await startSink()
    const { path } = await makeLog(BANNER(3080, 'X'.repeat(43)))
    const result = await runStartupNotice({
      config: { enabled: false, logPath: path, publicHost: '1.2.3.4', endpoint: sink.endpoint, tokenFile: undefined },
      logger: { info() {}, warn() {} },
      env: { DSH_NOTIFY_HUB_TOKEN: 'nh-token' },
      sleep: () => Promise.resolve(),
    })
    assert.equal(result.ok, false)
    assert.equal(sink.seen.length, 0)
  })

  it('端到端：等横幅 → 读 YAML 凭据 → 投递成功', async () => {
    const sink = await startSink()
    const { path, dir } = await makeLog('')
    const cfg = join(dir, 'notify-hub.yaml')
    await writeFile(cfg, 'server:  { host: 127.0.0.1, auth_token: nh-from-yaml }\n')
    // 横幅"迟到"，模拟插件先装载、banner 后打印（await 确保写入完成，避免测试竞态）
    setTimeout(() => { void appendFile(path, BANNER(3080, 'Z'.repeat(43))) }, 80)
    const result = await runStartupNotice({
      config: {
        enabled: true, logPath: path, publicHost: 'dsh.example.com',
        endpoint: sink.endpoint, tokenFile: cfg, tokenPath: 'server.auth_token', waitMs: 3000,
      },
      logger: { info() {}, warn() {} },
      env: {},
    })
    assert.equal(result.ok, true)
    assert.match(sink.seen[0].url, /token=nh-from-yaml/)
    const payload = JSON.parse(sink.seen[0].raw)
    assert.ok(payload.body.includes(`http://dsh.example.com:3080/?token=${'Z'.repeat(43)}`))
  })

  it('缺 publicHost 时不投递（宁可漏发，也不发一条错链接）', async () => {
    const sink = await startSink()
    const { path } = await makeLog('')
    // 横幅必须在"基线之后"出现（runStartupNotice 先取基线再等），否则不属于本次启动
    setTimeout(() => { void appendFile(path, BANNER(3080, 'Y'.repeat(43))) }, 80)
    const warnings = []
    const result = await runStartupNotice({
      config: { enabled: true, logPath: path, endpoint: sink.endpoint, waitMs: 2500 },
      logger: { info() {}, warn: (m) => warnings.push(m) },
      env: { DSH_NOTIFY_HUB_TOKEN: 'nh-token' },
      sleep: () => Promise.resolve(),
    })
    assert.equal(result.ok, false)
    assert.equal(sink.seen.length, 0)
    assert.ok(warnings.some((w) => /publicHost/.test(w)), warnings.join('\n'))
  })
})

describe('buildStartupBody', () => {
  it('正文含链接、端口与"点开即用"的说明', () => {
    const body = buildStartupBody({ url: 'http://h:3080/?token=t', port: '3080' })
    assert.ok(body.includes('http://h:3080/?token=t'))
    assert.ok(body.includes('3080'))
    assert.ok(body.includes('点开即用'))
  })
})
