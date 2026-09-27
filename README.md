# dsh-subpages

**DSH 看板宿主**：把独立开发的下级网页应用挂到 DSH 自己的端口上，用一个统一的门户访问它们。

- **不新开监听端口**：网关是 DSH `webServer` 上的一个前缀路由（默认 `/subpages`），
  跟 DSH 主界面共用同一个端口与登录态。
- **看板独立开发**：每个看板是独立仓库/目录，自己监听本地端口（或纯静态），
  宿主只做 HTTP 转发。
- **一键挂载**：放一个目录 + 一份 `subpage.json`，重启 `dsh web` 即可，**不用改宿主代码**。
- **真 URL**：`/subpages/notify-hub/todos` 可收藏、可深链、刷新不丢
  （DSH 客户端自身没有路由，这一点是它补上的）。

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
dsh plugin --profile web add /workspace/deepseek_workspace/dsh-subpages

# 别的机器（锁 commit）
dsh plugin --profile web add "git+https://github.com/<你>/dsh-subpages#<sha>"
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
    "tokenFile": "/root/notify-hub-run/config.yaml",
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
      publicHost: 47.109.102.36                 # 对外主机（IP 或域名）
      tokenFile: /root/notify-hub-run/config.yaml
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
