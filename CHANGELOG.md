# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.1.0 — 2026-09-23

首个可用版本。目标：把独立开发的下级网页应用挂到 **DSH 自己的端口**上，用一个统一门户
访问，并且**不新开任何监听端口**。

### 宿主能力

- **网关**：`ctx.webServer.register({ kind: 'prefix' })` 注册 `<mountPath>/…`，
  与 DSH 主界面共用端口与登录态（实测：3080 上只有一个监听进程）。
- **复用 DSH 鉴权**：每个请求先调 `ctx.connection.requestRejection(req)`，
  未认证由 DSH 统一返回 401/403；本插件不自建任何凭据体系。
- **两种子页面形态**：
  - `target` 是 http(s) 地址 → 反向代理到子页面自己的服务；
  - `target` 是路径 → 直接投递静态文件（含路径穿越防护）。
- **下游会话代持**：下游用 `Set-Cookie` 开启会话时，宿主收下 cookie 并持有，
  把跳转改写成「回到该子页面根路径」；后续请求带 cookie、不再注入令牌。
  结果是**浏览器里既没有令牌、也没有下游 cookie**，凭证全在服务端。
- **同源跳转归一**：下游的根路径跳转（`/` → `/todos`）与 `Location` 前缀
  在服务端处理，浏览器只看到一跳；`Location` 重写幂等，不会绕成循环。
- **链接改写**：子页面 HTML 里的根路径 `href`/`src`/`action` 自动改写到挂载前缀下
  ——否则它们会打到 DSH 自己的路由上（404 空白 iframe）。
- **公共前端库**：`<mountPath>/_assets/subpage.css` = Pico 2 classless（本地 vendor）
  + 深色 token 层 + OS 字体栈（不内嵌任何字体文件）+ `sp-*` 组件类名。
  `style: inherit`（默认）时宿主自动注入到子页面导航类 HTML 响应里。
- **门户壳**：导航栏 + iframe + hash 路由，URL 可收藏、刷新不丢
  （补上 DSH 客户端缺失的可收藏地址）。
- **清单与接口**：扫 `pages/*/subpage.json` 自动挂载，另有 `ctx.subPages`
  供其它插件运行时注册/卸载。
- **明确错误页**：未注册 id → 404 页、下游离线 → 502 页、静态文件缺失 → 404 页。
- **启动通告**：每次 DSH 启动把「带 token 的访问链接」投递到 notify-hub（→ 飞书），
  需显式 `startupNotice.enabled: true`。

### 首个接入的子页面

- **notify-hub（待办）**：`pages/notify-hub/subpage.json`，令牌直接从它自己的
  `config.yaml` 读（`tokenFile` + `tokenPath`），不新增配置。

### 已知边界

- `main` 面板与 DSH 侧边栏的「子页面」入口**没有 URL 路由**：DSH 客户端本身没有路由，
  入口是侧边栏底部的按钮（新标签页打开门户）。
- 下游返回**绝对 URL** 的重定向不会被改写（只改写以 `/` 开头的）。
- submodule 形态的子页面尚未接入：`dsh plugin add github:` 的 codeload 归档会丢
  submodule 内容，需要额外的产物层设计。
