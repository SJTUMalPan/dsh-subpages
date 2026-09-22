/**
 * 静态资源：把 `web/` 下的文件服务给浏览器，并把门户壳模板里的占位符替换成实际路径。
 *
 * 占位符替换而不是模板引擎：壳只有三个变量，引入模板引擎（哪怕很小的）都是净负债，
 * 而且模板引擎的转义规则在这里没有用武之地——三个值都由宿主生成、不含用户输入。
 */

import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { mimeOf } from './proxy.mjs'

/** 壳模板里的占位符。 */
const PLACEHOLDERS = {
  __ASSET_BASE__: 'assetBase',
  __API_BASE__: 'apiBase',
  __MOUNT_BASE__: 'mountBase',
}

/**
 * 读 `web/` 下的一个文件；越界返回 null。
 * @param {string} webDir - `web/` 的绝对路径。
 * @param {string} relPath - 相对于 `web/` 的路径（可带前导 `/`）。
 * @returns {Promise<{ body: Buffer, contentType: string } | null>} 文件内容与类型。
 */
export async function readWebAsset(webDir, relPath) {
  const clean = relPath.replace(/^\/+/u, '')
  if (clean === '' || clean.includes('\0')) return null
  const base = resolve(webDir)
  const target = resolve(join(base, clean))
  if (target !== base && !target.startsWith(base + sep)) return null
  try {
    const body = await readFile(target)
    // 传完整路径而不是扩展名：mimeOf 内部自己取 extname（传扩展名会被再切一次而落空）。
    return { body, contentType: mimeOf(target) }
  } catch {
    return null
  }
}

/**
 * 渲染门户壳：读模板 + 替换三个路径占位符。
 * @param {string} webDir - `web/` 的绝对路径。
 * @param {{ assetBase: string, apiBase: string, mountBase: string }} values - 路径取值。
 * @returns {Promise<string>} 渲染后的 HTML。
 */
export async function renderShell(webDir, values) {
  const template = await readFile(join(webDir, 'shell.html'), 'utf8')
  let html = template
  for (const [placeholder, key] of Object.entries(PLACEHOLDERS)) {
    html = html.split(placeholder).join(values[key])
  }
  return html
}
