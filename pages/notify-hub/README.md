# notify-hub 看板的挂载入口

本目录**只有一份清单**，没有页面源码——这是刻意的，见 [`../README.md`](../README.md)。

- 看板页面由 **notify-hub 自己的服务**渲染（Jinja 模板在 notify-hub 仓库），监听 `127.0.0.1:8000`；
- 网关做三件事：反代到它、复用 DSH 登录态、在服务端注入它的访问令牌
  （凭据在本目录 `subpage.json` 的 `auth` 里，指向 notify-hub 自己的 `config.yaml`）；
- `style: inherit`：宿主会往它的页面里注入公共样式，所以它在门户里与其它看板视觉一致。

改这里只会影响"怎么挂载"，不会影响 notify-hub 本身；反之，notify-hub 的模板/样式改动
也不需要动这个目录。
