# dsh-subpages

**DSH 看板宿主**：把一个个独立开发的小网页应用，变成 DSH 里的「看板」——挂在 DSH 自己的
端口下、共用 DSH 的登录态、用一个门户统一进入。不必为新页面单独开端口、单独配域名、
单独做一套鉴权。

好处：

- **不新开监听端口、不新增暴露面**：网关只是 DSH `webServer` 上的一个前缀路由
  （默认 `/subpages`），与主界面共用端口；每个请求先过 DSH 自己的鉴权，
  浏览器侧看不到下游令牌，下游也拿不到 DSH 凭据。
- **看板各管各的**：每块看板是独立仓库（自选技术栈、自己发版、自己鉴权），宿主只做转发与
  门户；`git submodule add <看板仓库> pages/<id>` + 重启 `dsh web` 即挂上，**不改宿主代码**。
  清单 `subpage.json` 放在看板**自己的仓库根目录**，`pages/` 下一律是 submodule 指针——
  详见 [`pages/README.md`](pages/README.md)。
- **风格统一**：内置公共样式表（Pico classless + 深色 token + `sp-*` 组件类），
  看板引一个 `<link>` 就跟门户一致，不必自己搭一套设计系统。
- **真 URL**：`/subpages/notify-hub/todos` 可收藏、可深链、刷新不丢
  （DSH 客户端自身没有路由，这一点是它补上的）。

## 自带的两个看板（`pages/`，均为 submodule）

| 看板 | 独立仓库 | 挂载形态 | 是什么 |
|---|---|---|---|
| **待办** | [SJTUMalPan/notify-hub](https://github.com/SJTUMalPan/notify-hub) | **代理**：它自带 FastAPI 服务；宿主把浏览器带来的 `?token=` 换成服务端持有的会话，浏览器全程看不到令牌 | 消息汇聚与待办跟踪：各进程投递消息 → 分类 → 落待办 → 飞书 / webhook / 邮件推送，超时未确认会提醒 |
| **用量** | [SJTUMalPan/dsh-usage-stats](https://github.com/SJTUMalPan/dsh-usage-stats) | **静态**：宿主直接投递生成好的单文件仪表盘 | DSH 各工程 / 会话 / 步骤的 token、缓存与花费统计（零依赖离线工具 + 单文件 HTML，`standalone` 样式） |

它们刚好覆盖宿主的**两种形态**（代理 / 静态）与**两种样式策略**（`inherit` / `standalone`），
所以既是能用的页面，也是照抄即可的接入范例。

## 架构

```
浏览器 ──> DSH :3080 /subpages/            门户壳（导航栏 + iframe + hash 路由）
                   /subpages/_assets/*      公共前端库（subpage.css）
                   /subpages/_api/pages     已挂载清单（壳用）
                   /subpages/<id>/*   ──►   看板自己的 http 服务（127.0.0.1:<port>）
            每个请求先过 DSH 鉴权（connection.requestRejection），不自建凭据体系
```

## 安装

```bash
# 本机开发（符号链接，改完即生效）
dsh plugin --profile web add "$PWD"     # 在仓库根目录执行

# 从 GitHub 装（别人/别的机器；插件市场里也能直接装）
dsh plugin --profile web add github:SJTUMalPan/dsh-subpages

# 锁 commit（可复现）
dsh plugin --profile web add "git+https://github.com/SJTUMalPan/dsh-subpages#<sha>"
```

装完**重启** `dsh web`。之后侧边栏底部会出现「看板」按钮，点开即门户。

卸载：`dsh plugin --profile web remove dsh-subpages`

## 挂载一个看板

在 `pages/` 下建一个目录，放 `subpage.json`：

```json
{
  "id": "notify-hub",
  "title": "待办",
  "icon": "inbox",
  "order": 10,
  "target": "http://127.0.0.1:8000",
  "health": "/healthz",
  "style": "standalone",
  "auth": {
    "tokenFile": "~/notify-hub-run/config.yaml",
    "tokenPath": "server.auth_token",
    "queryParam": "token"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 缺省用目录名。必须 kebab-case（会进 URL 路径段） |
| `title` | 否 | 导航栏显示名，缺省用 `id` |
| `order` | 否 | 导航排序，缺省 100 |
| `target` | **是** | `http://…` 表示反向代理到该服务；相对/绝对路径表示静态目录 |
| `index` | 否 | 静态形态的默认文件，缺省 `index.html` |
| `health` | 否 | 代理形态的探活路径，缺省 `/healthz` |
| `style` | 否 | `inherit`（**默认**，宿主在导航类 HTML 响应里注入公共样式）或 `standalone`（完全不注入） |
| `stripOwnStyle` | 否 | 仅 `inherit` 有意义：压掉看板自带的 `<style>`（前提是它已按公共约定重写标记） |
| `hidden` | 否 | 为 `true` 时不在导航栏显示（仍可直接访问） |
| `auth` | 否 | 下游凭据，见下 |

### auth：令牌只留在服务端

宿主还会替浏览器完成「令牌 → 会话 cookie」的交换并**持有该 cookie**：下游用 `Set-Cookie`
开启会话时，宿主收下它、把跳转改写成「回到该看板根路径」，后续请求附带 cookie 而不再
注入令牌；cookie 失效（401/403）时丢弃并重试一次。结果是浏览器**既看不到令牌、也拿不到
下游 cookie**，凭证全在服务端。下游把首页跳走（如 `/` → `/todos`）也由宿主在服务端跟掉，
浏览器始终只看到一次 200。


```json
"auth": { "tokenEnv": "MY_SERVICE_TOKEN", "header": "Authorization", "scheme": "Bearer" }
"auth": { "tokenFile": "/path/config.yaml", "tokenPath": "server.auth_token", "queryParam": "token" }
```

- `tokenEnv`：从环境变量取；
- `tokenFile` + `tokenPath`：直接从下游服务已有的 YAML 配置里按点号路径取——
  **不需要你再抄一份令牌到环境变量**；
- `header` + `scheme`（默认 `Authorization: Bearer …`）或 `queryParam`（拼进查询串，
  兼容只认 `?token=` 的服务）。

**令牌永远不会出现在浏览器可见的任何响应里**：不进清单 JSON、不进 HTML、不进 URL。
这条有测试守着（`test/gateway.test.mjs` 里断言响应体不含令牌值与环境变量名）。

## 信任模型（**挂载前必读**）

一句话：**挂一个看板 = 让它的前端代码在 DSH 的源（origin）里跑**。看板目录是
submodule，等于「别人的代码」；这里把边界说清楚，免得把它当成沙箱。

### 1. iframe 是**同源**的，不是隔离层

门户壳里的 iframe 用
`sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"`。
`allow-same-origin` + `allow-scripts` 的组合意味着：**框架内页面与 DSH 同源、且能执行脚本**，
于是它可以：

- 用 DSH 的凭据（Cookie 随请求自动带上）读写 DSH 自己的 HTTP 接口；
- 读 DSH 源下的 `localStorage` / `sessionStorage` / `indexedDB`；
- 反过来操作父窗口的 DOM。

因此：**只挂你自己信任的看板**（自己的仓库、自己审计过的 submodule）。
第三方看板应当部署在**独立源**上（另一个端口 + 另一个域名），
以「跨源代理」形态接入——本插件不做跨源隔离，也不声称做到了。

### 2. 宿主替浏览器保管下游凭据（令牌不下发）

- 下游令牌只从**服务端**（环境变量或下游自己的配置文件）读，不进清单 JSON、不进 HTML、
  不进浏览器可见的 URL；浏览器带 `?token=` 进来时，该参数在转发前被**剥掉**。
- 下游的会话 cookie 由宿主进程持有（按看板 id 存一份），浏览器拿不到它。
- **这份会话是进程级的**：同一个看板的所有访问者共用同一个下游会话。
  下游若把 cookie 当作「某个人已登录」的证据，本插件不满足该假设——
  下游自己的鉴权仍按「一个受信任客户端」看待。
- 转发头走**白名单**（`FORWARD_ALLOW`）：`cookie` / `authorization` 等**不会**从浏览器
  透传给下游，避免把 DSH 侧凭据泄露给看板后端。

### 3. 静态形态的路径边界

静态看板的文件只能来自该看板自己的目录：路径解析后做 `realpath` 校验，
`../` 与符号链接都逃不出去。但**这不妨碍第 1 条**——静态看板的 JS 依然是同源脚本。

### 4. 谁负责什么

| 边界 | 由谁负责 |
|---|---|
| 门户与网关路由要不要登录 | DSH 自己（`connection.requestRejection`），本插件不自建凭据体系 |
| 看板后端的鉴权与数据权限 | 看板自己（如 notify-hub 的 `server.auth_token`） |
| 看板前端能对 DSH 做什么 | **没有技术限制**——靠「只挂可信代码」这条纪律 |
| 看板之间的相互影响 | 各自独立进程；同源脚本能力见第 1 条 |

## 看板的两种形态

**代理形态**（有后端服务）：看板自己起服务监听本地端口，宿主转发。

**静态形态**（纯前端）：`target` 指向一个目录，宿主直接投递文件（带路径穿越防护）。
静态看板引用公共样式即可风格统一：

```html
<link rel="stylesheet" href="/subpages/_assets/subpage.css">
```

公共样式 = Pico 2 classless（本地 vendor，10 KB gzip）+ 深色 token 层 + OS 字体栈
（**不内嵌任何字体文件**）。可直接用的组件类名：`.sp-page` `.sp-card` `.sp-list`
`.sp-row` `.sp-toolbar` `.sp-btn` `.sp-empty` `.sp-badge`。

## 运行时挂载（给其它 DSH 插件）

除了扫目录，宿主还通过 `ctx.subPages` 开放接口：

```js
await ctx.subPages.register({ id: 'x', title: 'X', target: 'http://127.0.0.1:9000' })
ctx.subPages.list()        // 浏览器可见投影
ctx.subPages.unregister('x')
ctx.subPages.mountPath     // '/subpages'
```

## 配置

写在 profile 的 `cordis.patch.yml` 里（或安装后改插件行的 `config`）：

```yaml
- id: subpages
  config:
    mountPath: /subpages        # 网关前缀
    pagesDirs: [/abs/extra]     # 额外扫描目录（默认只用包内 pages/）
    requestTimeoutMs: 15000     # 转发超时
    probeTimeoutMs: 2000        # 探活超时
```

## 启动通告（把访问链接发到飞书）

每次 DSH 启动时，把「带 token 的访问链接」投递到 notify-hub（它再转发到飞书/其它渠道），
手机上点开即用。配置在 profile 的插件行里（本仓库 `cordis.patch.yml` 已给出可用样例）：

```yaml
- id: subpages
  config:
    startupNotice:
      enabled: true                             # 必须显式打开
      publicHost: dsh.example.com               # 对外主机（IP 或域名，按需替换）
      tokenFile: ~/notify-hub-run/config.yaml  # 支持 ~ 与环境变量展开
      tokenPath: server.auth_token              # 凭据直接读下游自己的配置，不新增一份
      logPath: /tmp/dsh-web.log                 # 启动横幅所在文件
```

要点与坑：

- token 的唯一来源是启动横幅（DSH 把它存在连接服务的进程私有状态里，插件取不到内存，
  也没有落盘文件），所以这里读启动日志——并且**只认本次启动新增的字节**，
  否则会把上一次启动的旧 token 发出去（一条死链）。
- 插件可能先于横幅打印完成装载，所以会**等横幅**（默认 30 秒），且这段等待不阻塞启动。
- 未配置 `publicHost` 时**不投递**：宁可漏发，也不发一条错链接。

手动重启（重启完成后同样会把新链接发到飞书）：

```bash
setsid nohup bash /workspace/dsh-restart-notify.sh >/dev/null 2>&1 < /dev/null &
```

## 排障

| 现象 | 原因与处理 |
|---|---|
| 侧边栏没有「看板」按钮 | 客户端半没加载。确认 profile 里有 `dsh-subpages` 且**重启过** `dsh web` |
| 门户显示「还没有挂载任何看板」 | `pages/` 下没有带 `subpage.json` 的目录，或清单非法（启动日志有 warning） |
| 显示「未挂载的看板：x」 | 清单 `id` 与访问的 id 不一致，或清单非法被跳过 |
| 显示「看板离线」 | 下游服务没起，或 `target` 写错。点右上「刷新」重试；`health` 路径也可核对 |
| 看板里的链接跳出网关（404） | 下游返回了**绝对 URL** 的重定向（宿主只重写以 `/` 开头的 `Location`）。需要下游改用相对跳转。链接类（`href`/`src`/`action`）宿主会自动改写，无需下游配合 |
| 门户里「一直载入中」 | 已修（`[hidden]` 被作者 `display` 覆盖）。若仍复现，用 `<mountPath>/?debug=1` 看诊断面板：fetch 状态码、iframe 的 load/error、内容长度 |
| 401 | DSH 登录态失效。刷新 DSH 页面重新登录即可——网关复用 DSH 鉴权，没有第二套凭据 |

## 开发

```bash
cd dsh-subpages && npm test    # = node --test test/*.test.mjs
```

测试用**真实 HTTP**：假下游是 `node:http` 服务端，宿主上下文是最小桩（可观测「注册了什么
路由」「是否先过鉴权」）。覆盖：路由注册、鉴权拦截、清单投影不含令牌、反代路径改写与
令牌注入、`Location` 重写、静态投递与路径穿越、未挂载 404、下游离线 502、探活。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | Cordis 插件：注册网关路由、扫描注册表、暴露 `ctx.subPages` |
| `lib/registry.mjs` | 清单校验/扫描/排序 + 令牌解析 + 浏览器可见投影 |
| `lib/proxy.mjs` | 反代、静态投递、请求头与响应头策略（令牌注入、Location 重写） |
| `lib/assets.mjs` | 公共资源投递与门户壳模板渲染 |
| `lib/sessions.mjs` | 下游会话代持 + `Location` 改写（幂等、根路径归一） |
| `lib/startup-notice.mjs` | 启动通告：等新增横幅 → 读凭据 → 投递到 notify-hub |
| `lib/client.js` | 客户端半（手写闭包工厂）：侧边栏入口按钮 |
| `web/shell.html` | 门户壳：导航栏 + iframe + hash 路由 |
| `web/subpage.css` | 公共前端库（token 层 + 组件类名） |
| `pages/<id>/subpage.json` | 挂载一个看板 |
