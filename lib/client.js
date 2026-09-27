/**
 * dsh-subpages 客户端半（预构建的闭包工厂产物）。
 *
 * 为什么手写而不用构建链：这一半只做一件事——在 DSH 侧边栏底部放一个按钮，点了用
 * 新标签页打开 `/subpages/`。为 30 行代码引入 tsdown/esbuild + 一条构建流水线，
 * 与「依赖尽量少、换机器就能装」冲突；而且**宿主模块表已经提供了 react 与
 * ui-slots**（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES），
 * 所以闭包工厂这种形态可以手写。
 *
 * 形态说明：产物不是 ESM 模块，而是 `window.__ModuleLoader__.load({ id, factory })`
 * ——factory 收到注入的 require，用于解析外部依赖。DSH 会自动在
 * `/plugins/<id>/client.js` 上服务本文件（`packages/client/modules/src/index.ts`）。
 *
 * 与宿主半的分工：客户端半**不做**任何数据请求、不渲染看板内容（那是壳的 iframe 的
 * 事）。它只是一个入口按钮，所以即使这一半加载失败，宿主网关仍完全可用。
 */

window.__ModuleLoader__.load({
  id: 'dsh-subpages',
  factory: (require) => {
    const React = require('react')
    const slots = require('@deepseek-ai/dsh-client-ui-slots')

    const PORTAL_PATH = '/subpages/'

    /**
     * 侧边栏底部的入口按钮。
     *
     * 用 `<a target="_blank">` 而不是 `window.open`：前者是浏览器原生行为，
     * 中键/右键「新标签页打开」都自然可用，也不需要弹窗权限。
     */
    function SubPagesEntry() {
      return React.createElement(
        'a',
        {
          href: PORTAL_PATH,
          target: '_blank',
          rel: 'noopener',
          title: '看板（在新标签页打开）',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            padding: '6px 10px',
            borderRadius: '6px',
            color: 'var(--dsw-alias-label-secondary, #9aa2ad)',
            fontSize: '13px',
            textDecoration: 'none',
            lineHeight: 1.4,
          },
          onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-hover, rgba(255,255,255,.06))' },
          onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
        },
        React.createElement('span', { 'aria-hidden': 'true' }, '▦'),
        React.createElement('span', null, '看板'),
      )
    }

    return {
      name: 'subpages',
      inject: ['slots'],
      /**
       * 注册入口按钮。`sidebar.footer.action` 是 DSH 侧边栏底部的动作座位
       * （与「设置」同排），它是 list 槽，可以放任意组件。
       */
      apply(ctx) {
        const slot = ctx.slots ?? slots
        if (slot === undefined || typeof slot.inject !== 'function') return
        slot.inject('sidebar.footer.action', () => slot.register({
          name: 'sidebar.footer.action',
          id: 'subpages-entry',
          order: 10,
        }, SubPagesEntry))
      },
    }
  },
})
