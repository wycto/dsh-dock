// dsh-dock · 宿主共享内核：各功能模块（features/*/host.js）共用的常量与工具。
// 放在 src/ 而非 features/：不属于任何单个功能；提取功能模块独立成包时按需随包复制。
import z from '@deepseek-ai/schemastery'

/** dsh-dock 自有 settings 命名空间（插件级配置，如图片理解代理）。 */
export const DOCK_NS = 'dsh-dock'

/** 自有命名空间的 schema（图片理解代理 + 任务动画配置 + 远程访问账号）。 */
export const DockConfig = z.object({
  remoteAuth: z.object({
    /** 远程访问登录账号（明文用户名；密码只存加盐哈希）。 */
    username: z.string().default(''),
    passwordHash: z.string().default(''),
    salt: z.string().default(''),
  }).default({}),
  visionProxy: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}),
  animation: z.object({
    // 动画与通知两个独立开关（可只开其一）
    animationEnabled: z.boolean().default(true),
    effectMode: z.string().default('flow'),
    // 桌面伙伴场景缩放（0.85~2.2；浮层右下角也可直接拖动缩放）
    robotScale: z.number().default(1.35),
    notifyEnabled: z.boolean().default(true),
    notifyOnComplete: z.boolean().default(true),
    notifyOnError: z.boolean().default(true),
    // 工具等待用户确认/批准时提醒（dsh 会话流 approval/asked → decided）
    notifyOnConfirm: z.boolean().default(true),
    // 通知停留毫秒数（0 = 常驻直到手动关闭）
    notifyStayMs: z.number().default(8000),
    // 浏览器系统通知（页面后台时推送）
    systemNotify: z.boolean().default(false),
    // 任务结束提示音（WebAudio 合成，macOS/Windows 通用，无音频文件依赖）
    soundNotify: z.boolean().default(true),
    // 提示音音效（完成场景音名；异常音由音效包内配套）
    soundEffect: z.string().default('chime'),
    // 钉钉群机器人推送（宿主侧直发，浏览器关着也能推；事件跟随 notifyOnComplete/notifyOnError）
    dingtalkEnabled: z.boolean().default(false),
    dingtalkWebhook: z.string().default(''),
    // 飞书群机器人推送（宿主侧直发，浏览器关着也能推；事件跟随 notifyOnComplete/notifyOnError）
    feishuEnabled: z.boolean().default(false),
    feishuWebhook: z.string().default(''),
  }).default({}),
})

/** 任务动画 effectMode 合法值（客户端动画模式）。 */
export const ANIMATION_MODES = [
  'flow', 'breathe', 'ring', 'orbit', 'robot', 'matrix', 'stars', 'aurora', 'space',
  'nebula', 'warp', 'radar', 'constellation', 'fireflies', 'ocean', 'prism', 'circuit', 'gravity', 'lantern',
]

/** 提示音 soundEffect 合法值（客户端音效库键名）。 */
export const SOUND_EFFECTS = ['chime', 'ding', 'coin', 'bell', 'pulse', 'arp']

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
