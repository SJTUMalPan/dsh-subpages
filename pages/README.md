# pages/ —— 看板的挂载点

每个子目录 = 一块看板。宿启动时扫 `pages/*/subpage.json`，按清单里的 `target` 分两种形态。

## 两种形态（决定了你在 git 里看到什么）

| 形态 | 清单里的 `target` | 本仓库里长什么样 | 例子 |
|---|---|---|---|
| **代理** | `http://127.0.0.1:<port>` | **只有一个 `subpage.json`** | `notify-hub/` |
| **静态** | `./build` 之类的相对目录 | **一个 submodule 指针**（内容在它自己的仓库里） | `usage-stats/` |

### 为什么代理形态只有一个 json

看板的**页面本体在它自己的工程里**（notify-hub 的 Jinja 模板在 notify-hub 仓库、由它自己的服务
在 8000 端口渲染），网关只负责反代 + 复用 DSH 鉴权 + 服务端注入令牌。所以这里需要的**只是那份
清单**，不需要它的源码——把整个 notify-hub 仓库塞成 submodule 对网关毫无用处（服务早就在跑）。

### 为什么静态形态是 submodule

既然后端没有服务，页面就必须**由本仓库投递文件**，那内容就得随仓库走、可独立开发独立发布，
所以用 submodule（`usage-stats/` → `git@github.com:SJTUMalPan/dsh-usage-stats.git`）。
它的清单也在**它自己的仓库根目录**（`subpage.json`），本仓库只记一个提交指针——这就是为什么
远端仓库里 `pages/usage-stats` 只显示成一个指针、看不到 json。

## 什么时候用哪种

- **看板有后端服务**（要读库、要聚合、要实时）→ 代理形态：把清单放进本仓库即可，页面留在它自己的工程。
- **看板是纯前端产物**（静态 HTML/JS/CSS）→ 静态形态：做成 submodule，让页面源码随 submodule 走。

## 加一块新看板

**代理形态**

```bash
mkdir -p pages/<id> && cat > pages/<id>/subpage.json <<'JSON'
{ "id": "<id>", "title": "标题", "target": "http://127.0.0.1:9000", "health": "/healthz",
  "auth": { "tokenFile": "/path/to/downstream.yaml", "tokenPath": "server.auth_token", "queryParam": "token" } }
JSON
```

**静态形态**

```bash
git submodule add <repo-url> pages/<id>     # 子模块仓库根目录放 subpage.json
```

两种情况都要**重启 dsh web** 才会出现在门户里（清单是启动时扫描的）。

> 注意：submodule 的内容**不会**被 `dsh plugin add github:…` 的归档带上（codeload 丢子模块）。
> 用那种方式部署时，需要在 profile 目录里对子模块执行一次 `git submodule update --init`。
