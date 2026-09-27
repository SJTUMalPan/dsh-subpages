# pages/ —— 看板挂载点

**约定：`pages/` 下每一项都是 submodule 指针**（git 里表现为 `160000 commit`），
每块看板的清单 `subpage.json` 放在**它自己的仓库根目录**。

这样做的理由：看板的"怎么挂载"与"看板是什么"始终在同一个仓库、同一次提交里，
不会出现"清单在这个仓库、页面在另一个仓库"的割裂；对使用者来说，加一块看板
永远是同一套动作（`git submodule add`）。

```
pages/
├── README.md          ← 本文件（约定的唯一说明处）
├── notify-hub/        → git@github.com:SJTUMalPan/notify-hub.git     （代理形态）
└── usage-stats/       → git@github.com:SJTUMalPan/dsh-usage-stats.git（静态形态）
```

## 形态由清单里的 `target` 决定（不影响上面那条约定）

| 形态 | `target` | 网关做什么 | 看板本体在哪 |
|---|---|---|---|
| **代理** | `http://127.0.0.1:<port>` | 反代 + 复用 DSH 鉴权 + 服务端注入令牌 | 看板自己的服务（如 notify-hub 的 8000） |
| **静态** | `./build` 之类的相对目录 | 直接投递文件（带路径穿越防护） | submodule 里的静态产物 |

两种形态都满足"清单在各自仓库根目录"，所以 `pages/` 下看到的永远是一个指针 ——
**这不是缺文件**：`git submodule update --init` 之后清单就会出现。

## 清单字段（`subpage.json`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 否 | 缺省用目录名；必须 kebab-case（进 URL 路径段） |
| `title` / `icon` / `order` / `description` | 否 | 门户展示用 |
| `target` | **是** | 代理形态填 http 地址；静态形态填相对目录 |
| `index` | 否 | 静态形态的默认文件，缺省 `index.html` |
| `health` | 否 | 代理形态的探活路径，缺省 `/healthz` |
| `style` | 否 | `inherit`（宿主注入公共样式）或 `standalone` |
| `stripOwnStyle` | 否 | 仅 `inherit` 有意义：压掉看板自带的 `<style>` |
| `hidden` | 否 | 不在导航栏显示 |
| `auth` | 否 | 下游凭据：`tokenEnv`，或 `tokenFile` + `tokenPath`，配 `header`/`scheme` 或 `queryParam` |

**清单要开源，所以不要写死机器路径**：`tokenFile` 与静态 `target` 支持
`$VAR` / `${VAR}` 与环境无关的 `~` 展开，例如：

```json
"auth": { "tokenFile": "$NOTIFY_HUB_CONFIG", "tokenPath": "server.auth_token", "queryParam": "token" }
```

## 加一块新看板

```bash
# 看板仓库根目录先放好 subpage.json（内容见上表），然后：
git submodule add <repo-url> pages/<id>
# 提交指针；重启 dsh web 后出现在门户里（清单是启动时扫描的）
```

> **submodule 体型提示**：网关只需要清单，但 submodule 默认会拉整个仓库。
> 对 notify-hub 这种大仓库，建议用稀疏检出只取清单：
>
> ```bash
> git submodule update --init --depth 1 --filter=blob:none pages/notify-hub
> git -C pages/notify-hub sparse-checkout set --no-cone /subpage.json
> ```
>
> 另外：submodule 内容**不会**随 `dsh plugin add github:…` 的归档过来（codeload 丢子模块），
> 用那种方式部署时需要对每个 submodule 执行一次 `git submodule update --init`。
