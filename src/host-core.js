// dsh-dock · 宿主共享内核：各功能模块（features/*/host.js）共用的常量与工具。
// 放在 src/ 而非 features/：不属于任何单个功能；提取功能模块独立成包时按需随包复制。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import yaml from 'js-yaml'
import z from '@deepseek-ai/schemastery'

/** dsh-dock 自有 settings 命名空间 = profile 条目 id（cordis.patch.yml 的 id）。 */
export const DOCK_NS = 'dsh-dock'

/** 自有命名空间的 schema（功能开关 + 图片理解代理 + 任务动画/任务通知配置 + 远程访问账号）。
 *  运行状态模块只读共享追踪、不写配置，因此没有自己的段。
 *
 *  dsh ≥ 0.1.7-alpha.1：settings 服务改为 SettingsForms——
 *  ① 插件必须导出同名 Config（否则 mutate 报 No configurable plugin entry）；
 *  ② ns 是 profile 条目 id（此处 DOCK_NS=cordis.patch.yml 的 id）；
 *  ③ 活编辑路径必须落在 .volatile() 字段上，否则 write 抛 not volatile。
 *  每个顶层段整体 volatile：段内任意 path 可被面板 mutate，无需逐字段标记。 */
export const DockConfig = z.object({
  // 宿主侧功能开关（id -> boolean）：客户端面板 toggle 即时同步过来，
  // 重启 dsh 后按此表决定宿主半部 setup 哪些功能（路由注册、事件订阅等）。
  features: z.dict(z.boolean()).default({}).volatile(),
  remoteAuth: z.object({
    /** 远程访问登录账号（明文用户名；密码只存加盐哈希）。 */
    username: z.string().default(''),
    passwordHash: z.string().default(''),
    salt: z.string().default(''),
  }).default({}).volatile(),
  /** 远程访问网关的持久化状态：enabled=上次是否在跑；port=自选端口（0=主端口+1）。
   *  dsh web 重启后按此自动拉起网关（账号存在才拉），免得每次重启都要进面板点一次。 */
  remoteGateway: z.object({
    enabled: z.boolean().default(false),
    /** 网关端口（0 = 跟随默认的主端口+1）；面板「开启远程访问」时回写。 */
    port: z.natural().default(0),
  }).default({}).volatile(),
  /** settings.yaml.imported 全量恢复（migrateImportedSections）是否已执行过的一次性标记。 */
  importedRestored: z.boolean().default(false).volatile(),
  visionProxy: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().default(''),
    model: z.string().default(''),
  }).default({}).volatile(),
  // 【用量记录】模块的单价配置：官网抓取的刊例价常与实际计费不符（第三方/中转、
  // 折扣、自建端点等），这里保存用户自填单价并优先用于费用估算。
  // 详见 features/tokenlog/host.js 的 resolvePricing（优先级：自定义 > 官网 > 内置 > 兜底）。
  tokenlog: z.object({
    /** USD→CNY 汇率（金额内部以 USD 记录，界面按人民币展示）。 */
    usdCnyRate: z.number().default(7.2),
    /** 是否仍抓取官网刊例价，作为「自定义单价」未命中时的兜底。 */
    fetchOfficial: z.boolean().default(true),
    /** 官网价目地址（仅 http/https，且拒绝本机/内网/保留地址）。 */
    pricingUrl: z.string().default('https://api-docs.deepseek.com/zh-cn/quick_start/pricing'),
    /** 官网价目抓取间隔（小时）。 */
    pricingFetchIntervalHours: z.number().default(24),
    /** 用户自定义单价（人民币元/百万 tokens）：命中即用、优先级最高，按数组顺序匹配。 */
    pricing: z.array(z.object({
      match: z.string().default(''),
      input: z.number().default(0),
      output: z.number().default(0),
      cacheRead: z.number().default(0),
      cacheWrite: z.number().default(0),
      /** 分时段价（可多段，如 DeepSeek 的高峰/优惠时段）：命中某段用该段价，否则用上面的基准价。
       *  start/end 为本地小时数 0~24；start>end 表示跨零点；单段等价旧的 peak。
       *  days：日期类型——all=每天（默认）；workday=仅工作日（非周末且非下方 holidays）；
       *  nonworkday=仅周末或节假日。用于「周末/节假日谷价、仅工作日高峰」这类计价。 */
      peaks: z.array(z.object({
        start: z.number().default(0),
        end: z.number().default(0),
        input: z.number().default(0),
        output: z.number().default(0),
        cacheRead: z.number().default(0),
        cacheWrite: z.number().default(0),
        days: z.string().default('all'),
      })).default([]),
    })).default([]),
    /** 法定节假日：单日 YYYY-MM-DD 或区间 YYYY-MM-DD~YYYY-MM-DD（含两端）。
     *  供 peaks.days=workday/nonworkday 判断；周末（周六/周日）始终视为非工作日。 */
    holidays: z.array(z.string()).default([]),
    /** 未匹配任何条目的模型所用兜底单价。 */
    fallback: z.object({
      input: z.number().default(2.16),
      output: z.number().default(6.48),
      cacheRead: z.number().default(0.43),
      cacheWrite: z.number().default(4.32),
    }).default({}),
  }).default({}).volatile(),
  // 【任务动画】模块：只放动画本身（动效开关/模式/桌面伙伴大小）。
  // 通知相关的字段已全部迁往下面的 notify 段（见 migrateNotifyConfig）；
  // 旧值不在 schema 里也会被 schemastery 原样保留，迁移读得到。
  animation: z.object({
    animationEnabled: z.boolean().default(true),
    effectMode: z.string().default('flow'),
    // 桌面伙伴场景缩放（0.85~2.2；浮层右下角也可直接拖动缩放）
    robotScale: z.number().default(1.35),
  }).default({}).volatile(),
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
  }).default({}).volatile(),
})

// ── 本地配置镜像（替代已移除的 settings.get） ─────────────────────────────
// apply(ctx, config) 绑定带 volatile 引用的 Config；每次操作前 plainify 一次取快照。
// settings.mutate 成功后由调用方/ volatile-update 刷新。测试桩可用 seedDockConfig 注入。

/** @type {null | Record<string, unknown>} */
let dockConfigBound = null

/** 是否为 cosmokit Volatile 引用（跨副本用 Symbol 协议识别，不依赖包导入）。 */
function isVolatileRef(value) {
  return typeof value === 'object' && value !== null && Symbol.for('cosmokit.volatile.write') in value
}

/** 递归解开 volatile 引用 → 可 JSON 化的普通对象。 */
export function plainifyDockConfig(value) {
  if (isVolatileRef(value)) return plainifyDockConfig(value.get())
  if (Array.isArray(value)) return value.map(plainifyDockConfig)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = plainifyDockConfig(v)
    return out
  }
  return value
}

/** 由 index.js apply 挂载/刷新：持有 Config 引用并在 loader/volatile-update 后重读。 */
export function bindDockConfig(config) {
  dockConfigBound = config === undefined || config === null ? null : plainifyDockConfig(config)
  return dockConfigBound
}

/** 测试/本地桩：直接写入镜像（绕过宿主 settings）。 */
export function seedDockConfig(value) {
  dockConfigBound = value === undefined || value === null ? null : plainifyDockConfig(value)
}

/**
 * 读自有命名空间根对象。优先级：
 * 1) apply 绑定的 Config 镜像（新宿主活值）
 * 2) 测试/旧宿主的 settings.get（若仍存在）
 * 3) settings.describe 里 ns=DOCK_NS 的 value（SettingsForms 读路径）
 * 4) null（调用方回退默认）
 */
export function readDockRoot(ctx) {
  if (dockConfigBound) return dockConfigBound
  try {
    const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
    if (settings) {
      if (typeof settings.get === 'function') {
        const v = settings.get(DOCK_NS)
        if (v && typeof v === 'object') return v
      }
      if (typeof settings.describe === 'function') {
        const views = settings.describe({ redactSecrets: false }) || []
        const hit = views.find((d) => d && d.ns === DOCK_NS && d.value && typeof d.value === 'object')
        if (hit) return hit.value
      }
    }
  } catch { /* settings 未挂载 */ }
  return null
}

/**
 * 写自有命名空间一段（走 SettingsForms.mutate；成功后同步本地镜像）。
 * @param {object} ctx Cordis context
 * @param {string[]} path 段路径（如 ['animation']）
 * @param {unknown} value 整段值
 * @param {number} [expectedRevision] describe 的 revision（乐观锁，可选）
 */
export async function mutateDockSection(ctx, path, value, expectedRevision) {
  const settings = ctx && typeof ctx.get === 'function' ? ctx.get('settings') : null
  if (!settings || typeof settings.mutate !== 'function') {
    throw new Error('settings 服务不可用，配置无法持久化')
  }
  await settings.mutate(DOCK_NS, [{ op: 'set', path, value }], expectedRevision)
  if (dockConfigBound) {
    const next = { ...dockConfigBound }
    let node = next
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i]
      const child = node[key] && typeof node[key] === 'object' && !Array.isArray(node[key]) ? { ...node[key] } : {}
      node[key] = child
      node = child
    }
    if (path.length > 0) next[path[path.length - 1]] = value
    else Object.assign(next, value)
    dockConfigBound = next
  }
  return value
}

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
    const root = readDockRoot(ctx)
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
    await mutateDockSection(ctx, ['notify'], next)
    console.log('[dsh-dock] notify config migrated from animation section; fields copied:', copied)
  } catch (e) {
    console.warn('[dsh-dock] notify config migration skipped:', (e && e.message) || String(e))
  }
}

/**
 * 一次性迁移：宿主侧【模型设置】功能 id 从 models 改为 modelconfig（与客户端视图 id 对齐）。
 *
 * 为什么必须迁：面板开关按客户端 id（modelconfig）POST /dsh-dock/features，
 * 旧宿主 id 叫 models → 永远「未知功能」404（客户端静默吞掉），开关表里因此
 * 只可能出现 API 手工写入的 models 键。新键未落盘时继承旧值并删掉旧键；
 * 判断条件本身幂等（迁完后 models 键不存在，直接早退），无需额外标记位。
 */
export async function migrateModelsFeatureId(ctx) {
  try {
    const root = readDockRoot(ctx)
    const features = root && typeof root === 'object' && root.features && typeof root.features === 'object' ? root.features : null
    if (!features || typeof features.models !== 'boolean' || typeof features.modelconfig === 'boolean') return
    const next = Object.assign({}, features, { modelconfig: features.models })
    delete next.models
    await mutateDockSection(ctx, ['features'], next)
    console.log('[dsh-dock] feature id migrated: features.models -> features.modelconfig =', features.models)
  } catch (e) {
    console.warn('[dsh-dock] models feature id migration skipped:', (e && e.message) || String(e))
  }
}

/**
 * 一次性迁移：旧 settings.yaml 已被宿主改名为 settings.yaml.imported；
 * 当时 dsh-dock 尚未导出 Config，importLegacyDocument 对本段 update 会失败，
 * 功能开关表停在 imported 文件里。配置可写后把 features 补写进 profile。
 */
export async function migrateImportedFeatures(ctx) {
  try {
    const root = readDockRoot(ctx)
    const features = root && typeof root === 'object' && root.features && typeof root.features === 'object' ? root.features : null
    if (features && Object.keys(features).length > 0) return
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'settings.yaml.imported')
    if (!existsSync(file)) return
    const text = readFileSync(file, 'utf8')
    // 极简 YAML：仅取 dsh-dock.features 下的 `key: true|false` 行（避免引入完整解析器）
    const lines = text.split(/\r?\n/)
    let inDock = false
    let inFeatures = false
    const imported = {}
    for (const line of lines) {
      if (/^dsh-dock:\s*$/.test(line)) { inDock = true; inFeatures = false; continue }
      if (inDock && /^\S/.test(line) && !/^dsh-dock:/.test(line)) { inDock = false; inFeatures = false }
      if (inDock && /^\s{2}features:\s*$/.test(line)) { inFeatures = true; continue }
      if (inDock && inFeatures && /^\s{2}\S/.test(line)) { inFeatures = false }
      if (inDock && inFeatures) {
        const m = /^\s{4}([A-Za-z0-9_-]+):\s*(true|false)\s*$/.exec(line)
        if (m) imported[m[1]] = m[2] === 'true'
      }
    }
    if (Object.keys(imported).length === 0) return
    await mutateDockSection(ctx, ['features'], imported)
    console.log('[dsh-dock] features imported from settings.yaml.imported:', imported)
  } catch (e) {
    console.warn('[dsh-dock] imported features migration skipped:', (e && e.message) || String(e))
  }
}

/** 深比较（JSON 化配置快照之间的相等判断）。 */
function sameValue(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
  }
  return false
}

/** schema 缺省值的普通对象快照（用来判断「现网这一段用户从没写过」）。
 *  schemastery 没有 parse()：走 Standard Schema validate 取值，volatile 读写器交给 plainify 解开。 */
function dockDefaults() {
  try {
    const standard = DockConfig['~standard'] || DockConfig[Symbol.for('standard.schema')]
    if (!standard || typeof standard.validate !== 'function') return null
    const result = standard.validate({})
    if (!result || result.issues || !result.value) return null
    return plainifyDockConfig(result.value)
  } catch {
    return null
  }
}

/** 只保留 schema 认识的顶层键：imported 旧文件可能带已废弃字段（如 animation 段里的
 *  旧通知字段），整段原样写会被 mutate 校验拒绝——丢字段会让整次恢复失败。
 *  值原样透传（嵌套结构交 schema 处理），这里只做顶层白名单。 */
function sanitizeSection(value, template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = {}
  for (const key of Object.keys(template)) {
    if (Object.hasOwn(value, key)) out[key] = value[key]
  }
  return out
}

/**
 * 一次性全量恢复：`~/.dsh/settings.yaml` 被 dsh 升级改名为 `settings.yaml.imported`
 * 并尝试导入 profile 时，dsh-dock 当时还没导出 Config → 整段导入失败，账号
 * （remoteAuth）、通知、动画、图片代理等配置全部停在 imported 文件里；后来只补迁了
 * features（见 migrateImportedFeatures），于是「远程访问账号丢失、网关开不起来」。
 *
 * 这里把整段补回来，规则保守：
 * - `features`：逐键补缺（现网已有的键绝不覆盖）；
 * - 其余 schema 认识的段：仅当现网该段仍等于 schema 缺省值（= 用户从未在此写过）
 *   才整段恢复，现网有任何改动一律以现网为准（不覆盖新配置）；
 * - 执行过写入或确认无 imported 文档后置 `importedRestored` 标记，仅跑一次。
 */
export async function migrateImportedSections(ctx) {
  try {
    const root = readDockRoot(ctx)
    if (root && root.importedRestored === true) return
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const file = join(home, 'settings.yaml.imported')
    if (!existsSync(file)) return
    let data = null
    try {
      data = yaml.load(readFileSync(file, 'utf8'))
    } catch (error) {
      console.warn('[dsh-dock] settings.yaml.imported 不是合法 YAML，跳过恢复:', (error && error.message) || String(error))
      return
    }
    const section = data && typeof data === 'object' && !Array.isArray(data) ? data[DOCK_NS] : null
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      await mutateDockSection(ctx, ['importedRestored'], true)
      return
    }
    const defaults = dockDefaults()
    const live = root && typeof root === 'object' ? root : {}
    const writes = []
    const importedFeatures = section.features && typeof section.features === 'object' ? section.features : null
    if (importedFeatures) {
      const merged = live.features && typeof live.features === 'object' ? { ...live.features } : {}
      let added = 0
      for (const [key, value] of Object.entries(importedFeatures)) {
        if (typeof value === 'boolean' && typeof merged[key] !== 'boolean') {
          merged[key] = value
          added++
        }
      }
      if (added > 0) writes.push(['features', merged])
    }
    if (defaults) {
      for (const key of Object.keys(section)) {
        if (key === 'features') continue
        if (!Object.hasOwn(defaults, key)) continue
        // 现网缺该段（= 从没写过）或仍等于 schema 缺省 → 恢复；现网有用户改动一律不覆盖。
        if (live[key] !== undefined && !sameValue(live[key], defaults[key])) continue
        writes.push([key, sanitizeSection(section[key], defaults[key])])
      }
    }
    // 逐段独立落盘：一个段被拒（schema 不认/写盘瞬时失败）不拖死其余段——
    // 尤其 remoteAuth 必须尽量恢复，否则远程访问账号一直起不来。
    const restored = []
    const failed = []
    for (const [path, value] of writes) {
      try {
        await mutateDockSection(ctx, [path], value)
        restored.push(path)
      } catch (error) {
        failed.push(path)
        console.warn(`[dsh-dock] 恢复 ${path} 段失败:`, (error && error.message) || String(error))
      }
    }
    // 全部落盘（或本来就无事可做）才置一次性标记；有失败则下次启动重试。
    if (failed.length === 0) await mutateDockSection(ctx, ['importedRestored'], true)
    if (restored.length > 0) {
      console.log('[dsh-dock] restored from settings.yaml.imported:', restored.join(', '))
    }
  } catch (e) {
    console.warn('[dsh-dock] imported section restore skipped:', (e && e.message) || String(e))
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
