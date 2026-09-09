// dsh-dock · 宿主共享内核：各功能模块（features/*/host.js）共用的常量与工具。
// 放在 src/ 而非 features/：不属于任何单个功能；提取功能模块独立成包时按需随包复制。
import z from '@deepseek-ai/schemastery'

/** dsh-dock 自有 settings 命名空间（插件级配置，如图片理解代理）。 */
export const DOCK_NS = 'dsh-dock'

/** 自有命名空间的 schema（功能开关 + 图片理解代理 + 任务动画/任务通知配置 + 远程访问账号）。
 *  运行状态模块只读共享追踪、不写配置，因此没有自己的段。 */
export const DockConfig = z.object({
  // 宿主侧功能开关（id -> boolean）：客户端面板 toggle 即时同步过来，
  // 重启 dsh 后按此表决定宿主半部 setup 哪些功能（路由注册、事件订阅等）。
  features: z.dict(z.boolean()).default({}),
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
  // 【任务动画】模块：只放动画本身（动效开关/模式/桌面伙伴大小）。
  // 通知相关的字段已全部迁往下面的 notify 段（见 migrateNotifyConfig）；
  // 旧值不在 schema 里也会被 schemastery 原样保留，迁移读得到。
  animation: z.object({
    animationEnabled: z.boolean().default(true),
    effectMode: z.string().default('flow'),
    // 桌面伙伴场景缩放（0.85~2.2；浮层右下角也可直接拖动缩放）
    robotScale: z.number().default(1.35),
  }).default({}),
  // 【任务通知】模块：页内卡片 / 提示音 / 浏览器系统通知 / 群机器人推送。
  // 模块自身的启停由 features.notify 开关负责（独立菜单项），这里只放通知行为配置。
  notify: z.object({
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
    // 一次性迁移标记：animation 段的旧通知配置已搬到本段（搬完置 true，避免每次启动重复写）
    migratedFromAnimation: z.boolean().default(false),
  }).default({}),
})

/** 通知配置字段清单（schema、迁移、客户端默认值三处共用同一份键名）。 */
export const NOTIFY_FIELDS = [
  'notifyOnComplete', 'notifyOnError', 'notifyOnConfirm', 'notifyStayMs',
  'systemNotify', 'soundNotify', 'soundEffect',
  'dingtalkEnabled', 'dingtalkWebhook', 'feishuEnabled', 'feishuWebhook',
]

/**
 * 一次性迁移：通知配置从 settings 的 animation 段搬到 notify 段
 * （【任务通知】独立成功能模块，配置也该由它自己拥有）。
 *
 * 为什么必须搬：animation 模块保存配置时整段写回，旧字段会被覆盖丢失；
 * 迁移在插件加载时（settings 注册回调里）先跑，早于任何面板保存动作。
 * 取值规则：animation 段的旧值优先（拆分前它就是用户的真实选择），notify 段保留其余键。
 */
export async function migrateNotifyConfig(ctx) {
  try {
    const settings = ctx.get('settings')
    if (!settings || typeof settings.get !== 'function' || typeof settings.mutate !== 'function') return
    const root = settings.get(DOCK_NS)
    const notify = root && typeof root === 'object' && root.notify && typeof root.notify === 'object' ? root.notify : null
    if (notify && notify.migratedFromAnimation === true) return
    const animation = root && typeof root === 'object' && root.animation && typeof root.animation === 'object' ? root.animation : null
    const legacy = {}
    let copied = 0
    for (const key of NOTIFY_FIELDS) {
      if (animation && animation[key] !== undefined) { legacy[key] = animation[key]; copied++ }
    }
    // 没有可搬的旧字段（全新安装 / 已搬完）就不写盘，也不置标记——
    // 避免 settings 命名空间尚未生效时误把「空迁移」当完成（那会丢掉旧配置）。
    if (copied === 0) return
    const next = Object.assign({}, notify || {}, legacy, { migratedFromAnimation: true })
    await settings.mutate(DOCK_NS, [{ op: 'set', path: ['notify'], value: next }])
    console.log('[dsh-dock] notify config migrated from animation section; fields copied:', copied)
  } catch (e) {
    console.warn('[dsh-dock] notify config migration skipped:', (e && e.message) || String(e))
  }
}

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
