// dsh-dock · 功能模块【模型设置】· 宿主半部（v0.3.0 迁自 index.js，行为不变）
//
// GET  /dsh-dock/models —— 枚举全部已配置 Provider 的模型目录（含输入类型/思考强度）
// POST /dsh-dock/models —— 把面板编辑写回官方 settings（settings.mutate，热生效）
// 官方链路（集成不改内核）：
//   - 会话模型选择器按 model.reasoning.efforts 展示强度档；档位源自 Provider 配置：
//     · pi-ai 路由：每模型 reasoningEfforts（档位 → wire 值；off:null 表示"支持关闭、不发参数"；false = 不支持思考）
//     · deepseek 官方：连接级 thinking（enabled/disabled）+ reasoningEffort 默认档，全模型共享 Off/Low/High/Max
//   - 输入类型官方 schema 仅接受 text/image；「视频」等以 dockTags 标注随配置持久化（不参与请求路由）
//   - schemastery 保留未知字段（实测），dockTags 对官方校验透明
//   - POST 也收图片理解代理配置（visionProxy 分支，写 dsh-dock 自有命名空间）
import { DOCK_NS, sendJson, readBody, walkPath } from '../../src/host-core.js'

/** 官方 schema 接受的输入模态（写回配置的 input 只允许这两个）。 */
const HOST_MODALITIES = ['text', 'image']
/** pi-ai 支持的思考档位（升序）。 */
const PI_AI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** deepseek 官方支持的思考档位。 */
const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max']

/** deepseek-official 内置默认值（与 balance 模块同款兜底）。 */
const DEEPSEEK_DEFAULTS = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
}

function providerKindOf(entry) {
  if (entry.settingsNs === 'llm-deepseek') return 'deepseek'
  if (entry.settingsNs === 'llm-pi-ai') return 'pi-ai'
  return 'other'
}

/** 正整数或 undefined（目录数字字段透传）。 */
function posInt(v) {
  return Number.isInteger(v) && v > 0 ? v : undefined
}

/** 字符串数组透传（仅保留非空字符串）。 */
function strList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []
}

/** 把 pi-ai 模型条目归一为面板视图（raw = 原始条目，保存时原样回传保留未知字段）。 */
function piAiModelView(entry, routeDefaultInput) {
  const input = strList(entry.input).filter((m) => HOST_MODALITIES.includes(m))
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : undefined,
    contextWindow: posInt(entry.contextWindow),
    maxTokens: posInt(entry.maxTokens),
    input: input.length > 0 ? input : (strList(routeDefaultInput).length > 0 ? strList(routeDefaultInput) : ['text']),
    inputInherited: input.length === 0,
    efforts: raw.reasoningEfforts === undefined ? 'inherit' : raw.reasoningEfforts === false ? 'off' : 'custom',
    effortMap: raw.reasoningEfforts && typeof raw.reasoningEfforts === 'object' ? raw.reasoningEfforts : null,
    tags: strList(entry.dockTags),
    raw,
  }
}

/** 把 deepseek 目录模型归一为面板视图。 */
function deepSeekModelView(entry) {
  const input = strList(entry.inputModalities).filter((m) => HOST_MODALITIES.includes(m))
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : undefined,
    contextWindow: posInt(entry.contextWindow),
    maxTokens: posInt(entry.maxTokens),
    input: input.length > 0 ? input : ['text'],
    inputInherited: input.length === 0,
    tags: strList(entry.dockTags),
    raw,
  }
}

/**
 * 读模型目录：按"已配置"口径枚举 Provider，
 * 输出各 Provider 的模型列表（含输入类型 / 思考强度）与各 settings 命名空间的 revision。
 * （visionproxy 模块的目录兜底缓存也复用本函数）
 */
export function readModelDirectory(ctx) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const entries = (llm && llm.listConfigurableProviders ? llm.listConfigurableProviders() : []) || []
  let views = []
  try {
    views = (settings && settings.describe ? settings.describe({ redactSecrets: true }) : []) || []
  } catch {
    // settings 未挂载
  }
  const descOf = (ns) => views.find((v) => v && String(v.ns) === ns)

  let sel = null
  try {
    sel = (ctx.get('agentDefaultModel') && ctx.get('agentDefaultModel').currentSelection()) || null
  } catch {
    // 服务缺失
  }

  const providers = []
  for (const e of entries) {
    const kind = providerKindOf(e)
    if (kind === 'other') continue // 官方之外的适配器暂不编辑（无稳定 schema）
    const desc = descOf(e.settingsNs)
    if (!desc) continue
    const profileUser = desc.user ? walkPath(desc.user, e.settingsPath) : undefined
    const profileBase = desc.base ? walkPath(desc.base, e.settingsPath) : undefined
    const isDefaultProvider = !!(sel && sel.provider === e.provider)
    // deepseek 官方始终可编辑（schema 默认目录兜底）；其余按"已配置"口径
    const configured = kind === 'deepseek' || isDefaultProvider
      || (profileUser && typeof profileUser === 'object')
      || (profileBase && typeof profileBase === 'object')
    if (!configured) continue

    const resolved = walkPath(desc.value, e.settingsPath) // schema 默认已套上的合成视图
    if (kind === 'deepseek') {
      const section = resolved && typeof resolved === 'object' ? resolved : {}
      const models = Array.isArray(section.models) ? section.models : []
      providers.push({
        id: e.provider,
        displayName: (profileUser && profileUser.displayName) || e.displayName || e.provider,
        api: 'deepseek',
        baseURL: (profileUser && profileUser.baseURL) || section.baseURL || DEEPSEEK_DEFAULTS.baseURL,
        apiKeyEnv: (profileUser && profileUser.apiKeyEnv) || DEEPSEEK_DEFAULTS.apiKeyEnv,
        kind,
        settingsNs: e.settingsNs,
        settingsPath: [...e.settingsPath],
        thinking: section.thinking === 'disabled' ? 'disabled' : 'enabled',
        defaultEffort: DEEPSEEK_LEVELS.includes(section.reasoningEffort) ? section.reasoningEffort : undefined,
        effortLevels: DEEPSEEK_LEVELS.slice(),
        models: models.map(deepSeekModelView),
      })
    } else {
      const route = e.settingsPath[1] || e.provider
      const profile = (profileUser && typeof profileUser === 'object' ? profileUser
        : (profileBase && typeof profileBase === 'object' ? profileBase : resolved)) || {}
      const resolvedProfile = (resolved && typeof resolved === 'object' ? resolved : {}) || {}
      const models = Array.isArray(profile.models) ? profile.models : []
      providers.push({
        id: e.provider,
        route,
        displayName: profile.displayName || e.displayName || e.provider,
        api: typeof profile.api === 'string' ? profile.api : undefined,
        baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
        apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
        kind,
        settingsNs: e.settingsNs,
        settingsPath: [...e.settingsPath],
        defaultInput: strList(resolvedProfile.defaultInput),
        models: models.map((m) => piAiModelView(m && typeof m === 'object' ? m : { id: String(m) }, resolvedProfile.defaultInput)),
      })
    }
  }

  const revisions = {}
  for (const ns of ['llm-pi-ai', 'llm-deepseek']) {
    const d = descOf(ns)
    if (d && d.revision !== undefined) revisions[ns] = d.revision
  }
  return { generatedAt: Date.now(), default: sel, revisions, providers }
}

/**
 * 给目录视图补运行时视角的输入模态（llm.resolveModelInfo，与官方投影同源：
 * entry.input → 内置目录 → 路由默认）。面板据此展示「原图直发 vs 走视觉代理」，
 * 避免"条目留空但目录继承多模态"的模型被误分组。
 * 注意：功能启用后 llm.resolveModelInfo 被本插件包装（虚拟多模态），此处须取原函数保真。
 */
async function enrichRuntimeInput(ctx, dir) {
  const llm = ctx.get('llm')
  const resolve = llm && (llm.__dockOrigResolveModelInfo
    || (typeof llm.resolveModelInfo === 'function' ? llm.resolveModelInfo.bind(llm) : null))
  if (!resolve) return
  await Promise.all((dir.providers || []).flatMap((p) => (p.models || []).map(async (m) => {
    try {
      const info = await resolve(p.id, m.id)
      if (info && Array.isArray(info.inputModalities)) {
        m.runtimeInput = info.inputModalities.filter((x) => HOST_MODALITIES.includes(x))
      }
    } catch {
      // 单模型解析失败不影响整表（面板回退用 input 展示）
    }
  })))
}

/** 校验面板数字草稿并落到条目上（空 = 删除字段，继承默认）。 */
function setPosInt(entry, field, value) {
  if (value === undefined || value === null || value === '') {
    delete entry[field]
    return
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`模型 ${entry.id} 的 ${field} 须为正整数`)
  entry[field] = n
}

/**
 * 校验面板提交的模型草稿，产出写回 pi-ai 的模型条目（不合法直接抛错）。
 * 基于原条目（raw）合并编辑：未知字段（用户自配 compat/description 等）原样保留。
 * 启用思考（custom）时的兜底（2026-08-22 事故修复）：
 *   不在 pi-ai 内置目录里的模型没有 catalog compat，检测默认 supportsDeveloperRole=true，
 *   而 pi-ai 对 reasoning 模型会把 system 改写成 developer 角色 → 百炼等 OpenAI 兼容端点 400。
 *   故凡启用思考一律显式 supportsDeveloperRole:false（system 全端点通用）；
 *   百炼/阿里云家族 baseURL 再补 thinkingFormat:'qwen'（与目录内模型一致，思考参数用 qwen 格式）。
 */
function piAiModelWrite(m, p) {
  if (!m || typeof m.id !== 'string' || !m.id) throw new Error('模型 id 不能为空')
  const raw = m.raw && typeof m.raw === 'object' && !Array.isArray(m.raw) ? m.raw : {}
  const entry = Object.assign({}, raw)
  entry.id = m.id
  if (typeof m.name === 'string' && m.name) entry.name = m.name
  else delete entry.name
  setPosInt(entry, 'contextWindow', m.contextWindow)
  setPosInt(entry, 'maxTokens', m.maxTokens)
  const input = Array.isArray(m.input) ? m.input.filter((x) => HOST_MODALITIES.includes(x)) : []
  if (input.length > 0) entry.input = input // 留空 = 继承路由/目录默认
  else delete entry.input
  const tags = strList(m.tags)
  if (tags.length > 0) entry.dockTags = tags // 标注（如 video），官方校验忽略、随配置持久化
  else delete entry.dockTags
  if (m.effortsMode === 'off') {
    entry.reasoningEfforts = false
  } else if (m.effortsMode === 'custom') {
    const levels = m.effortLevels || {}
    const map = {}
    let real = 0
    for (const lv of PI_AI_LEVELS) {
      if (!levels[lv]) continue
      if (lv === 'off') map.off = null // 支持关闭：不发参数
      else { map[lv] = lv; real += 1 }
    }
    if (real === 0) throw new Error(`模型 ${m.id} 至少要勾选一个思考档位（off 之外）`)
    entry.reasoningEfforts = map
    // 目录路由（用户层未写 api/baseURL，靠 pi-ai 内置目录提供）视作 openai 兼容
    const apiOk = !p.api || (typeof p.api === 'string' && p.api.indexOf('openai') === 0)
    if (apiOk) {
      const compat = Object.assign({}, entry.compat)
      compat.supportsDeveloperRole = false
      // 百炼/阿里云家族（路由 id 或 baseURL 命中）思考参数用 qwen 格式，与目录内模型一致
      if (/qwen|dashscope|aliyuncs/i.test(String(p.route || '') + ' ' + String(p.baseURL || ''))) {
        compat.thinkingFormat = 'qwen'
      }
      entry.compat = compat
    }
  } else {
    delete entry.reasoningEfforts // inherit = 不写该字段，跟随内置目录
  }
  return entry
}

/** 校验并产出写回 deepseek 官方的目录模型条目（raw 未知字段保留）。 */
function deepSeekModelWrite(m) {
  if (!m || typeof m.id !== 'string' || !m.id) throw new Error('模型 id 不能为空')
  const raw = m.raw && typeof m.raw === 'object' && !Array.isArray(m.raw) ? m.raw : {}
  const entry = Object.assign({}, raw)
  entry.id = m.id
  if (typeof m.name === 'string' && m.name) entry.name = m.name
  else delete entry.name
  setPosInt(entry, 'contextWindow', m.contextWindow)
  setPosInt(entry, 'maxTokens', m.maxTokens)
  const input = Array.isArray(m.input) ? m.input.filter((x) => HOST_MODALITIES.includes(x)) : []
  if (input.includes('image')) entry.inputModalities = input // 纯文本留空走 schema 默认 ['text']
  else delete entry.inputModalities
  const tags = strList(m.tags)
  if (tags.length > 0) entry.dockTags = tags
  else delete entry.dockTags
  return entry
}

/**
 * 写回官方配置：按 Provider kind 生成 settings.mutate ops。
 * 校验失败/官方 schema 拒绝时抛错（路由层转 4xx 带信息）。
 */
async function writeModelConfig(ctx, body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不是 JSON 对象')

  const settings = ctx.get('settings')
  if (!settings || typeof settings.mutate !== 'function') throw new Error('settings 服务不可用或不可写')

  // 图片理解代理配置：独立于 Provider 目录的小分支
  if (body.visionProxy !== undefined) {
    const vp = body.visionProxy
    if (!vp || typeof vp !== 'object' || Array.isArray(vp)) throw new Error('visionProxy 格式不符')
    const value = {
      enabled: !!vp.enabled,
      provider: typeof vp.provider === 'string' ? vp.provider : '',
      model: typeof vp.model === 'string' ? vp.model : '',
    }
    if (value.enabled && (!value.provider || !value.model)) {
      const err = new Error('启用图片理解代理需要选择视觉模型')
      err.statusCode = 400
      throw err
    }
    const revision = body.revisions && typeof body.revisions[DOCK_NS] === 'number' ? body.revisions[DOCK_NS] : undefined
    try {
      await settings.mutate(DOCK_NS, [{ op: 'set', path: ['visionProxy'], value }], revision)
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      const err = new Error(`保存图片理解代理配置被拒绝：${msg}`)
      err.statusCode = /conflict|revision/i.test(msg) ? 409 : 400
      throw err
    }
    return { ok: true, savedAt: Date.now() }
  }

  const dir = readModelDirectory(ctx)
  if (typeof body.provider !== 'string' || !body.provider) {
    // 典型场景：新 Client（图片代理面板）打到旧 Host（无 visionProxy 分支）
    const err = new Error('请求缺少 provider——若正在保存图片代理配置，说明宿主进程是旧版本，重启 dsh web 后重试')
    err.statusCode = 400
    throw err
  }
  const p = dir.providers.find((x) => x.id === body.provider)
  if (!p) throw new Error(`未找到 Provider：${body.provider}`)
  if (p.kind === 'other') throw new Error('该 Provider 暂不支持编辑')
  if (!Array.isArray(body.models)) throw new Error('models 必须是数组')

  const seen = new Set()
  for (const m of body.models) {
    const id = m && typeof m.id === 'string' ? m.id : ''
    if (!id) throw new Error('模型 id 不能为空')
    if (seen.has(id)) throw new Error(`模型 id 重复：${id}`)
    seen.add(id)
  }

  const ops = []
  if (p.kind === 'deepseek') {
    ops.push({ op: 'set', path: ['models'], value: body.models.map(deepSeekModelWrite) })
    if (body.thinking === 'enabled' || body.thinking === 'disabled') {
      ops.push({ op: 'set', path: ['thinking'], value: body.thinking })
    }
    if (DEEPSEEK_LEVELS.includes(body.defaultEffort)) {
      ops.push({ op: 'set', path: ['reasoningEffort'], value: body.defaultEffort })
    }
  } else {
    const route = p.route
    if (!route) throw new Error('pi-ai 路由 key 缺失，无法写回')
    ops.push({ op: 'set', path: ['providers', route, 'models'], value: body.models.map((m) => piAiModelWrite(m, p)) })
  }

  const revision = body.revisions && typeof body.revisions[p.settingsNs] === 'number'
    ? body.revisions[p.settingsNs]
    : undefined
  try {
    await settings.mutate(p.settingsNs, ops, revision)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    const conflict = /conflict|revision/i.test(msg)
    const err = new Error(`写回官方配置被拒绝：${msg}`)
    err.statusCode = conflict ? 409 : 400
    throw err
  }
  return { ok: true, savedAt: Date.now() }
}

/** 功能注册表条目：index.js 组装 hostSetups 时使用。 */
export const feature = {
  id: 'models',
  name: '模型设置',
  description: '模型目录读写：编辑输入类型与思考强度，写回官方配置热生效',
  defaultEnabled: false,
  setup(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供模型设置路由')
    const handler = async (req, res) => {
      try {
        if (req.method === 'GET') {
          const payload = readModelDirectory(ctx)
          await enrichRuntimeInput(ctx, payload)
          // 附带图片理解代理配置与自有命名空间 revision（面板保存用）
          try {
            const settings = ctx.get('settings')
            const v = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : undefined
            payload.visionProxy = v && v.visionProxy
              ? { enabled: !!v.visionProxy.enabled, provider: String(v.visionProxy.provider || ''), model: String(v.visionProxy.model || '') }
              : { enabled: false, provider: '', model: '' }
            const desc = settings && typeof settings.describe === 'function'
              ? settings.describe({ redactSecrets: true }) : []
            for (const d of desc || []) {
              if (d && d.ns === DOCK_NS && d.revision !== undefined) payload.revisions[DOCK_NS] = d.revision
            }
          } catch {
            payload.visionProxy = { enabled: false, provider: '', model: '' }
          }
          sendJson(res, 200, payload)
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const result = await writeModelConfig(ctx, body)
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 405, { error: `不支持的请求方法：${req.method}` })
      } catch (e) {
        const status = e && e.statusCode ? e.statusCode : 500
        sendJson(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return webServer.register({ kind: 'exact', path: '/dsh-dock/models', handler })
  },
}
