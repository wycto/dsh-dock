// dsh-dock · 宿主共享内核：各功能模块（features/*/host.js）共用的常量与工具。
// 放在 src/ 而非 features/：不属于任何单个功能；提取功能模块独立成包时按需随包复制。
import z from '@deepseek-ai/schemastery'

/** dsh-dock 自有 settings 命名空间（插件级配置，如图片理解代理）。 */
export const DOCK_NS = 'dsh-dock'

/** 自有命名空间的 schema（当前仅图片理解代理配置）。 */
export const DockConfig = z.object({
  visionProxy: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
})

/** 沿 settingsPath 走一层对象（user/base/value 都可用）。 */
export function walkPath(node, path) {
  for (const key of path || []) {
    node = node && typeof node === 'object' ? node[key] : undefined
  }
  return node
}

/** 序列化 JSON 响应。 */
export function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** 解析 POST 请求体 JSON（限长 2MB）。 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}
