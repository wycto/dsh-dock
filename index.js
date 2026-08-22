// dsh-dock · Host 半部（Node 侧入口）
//
// v0.3.0 模型设置（已接入）：
//   - hostSetups.models：/dsh-dock/models GET 读模型目录（输入类型/思考强度），
//     POST 把面板编辑写回官方 settings（settings.mutate，热生效）；
//   - 集成官方链路而非另起炉灶：pi-ai 每模型 reasoningEfforts（档位→wire 值）、
//     deepseek 连接级 thinking/reasoningEffort；输入模态官方仅收 text/image，
//     「视频」等以 dockTags 标注持久化（不参与请求路由）。
//
// v0.2.0 模型余额（已接入）：
//   - hostSetups.balance：在回环 webServer 上注册 /dsh-dock/balance 路由，
//     枚举所有已配置的模型 Provider，按余额策略查询各账号余额/配额，
//     返回归一化 JSON 给浏览器半身（同源 fetch，无需 typert，详见 docs/session-notes.md）；
//   - 余额策略表沿用 @wycto/dsh-balance-panel@0.1.1 的实现（MIT，同作者），
//     后续若两个包并存，数据源与视图互相独立，互不冲突。
//
// v0.1.0 基础框架：
//   - 功能注册表（FEATURES）：与 Client 半部注册表同构，规划中的功能已登记；
//   - 每功能独立生命周期（hostSetups 返回 disposer，开关只影响自己）；
//   - 函数级错误隔离：单个功能 setup 抛错只标记 error，不影响其他功能。
//
// 路线图：
//   - 0.4.0 接入 Token 用量记录：hostSetups.tokenlog 监听事件记账；
//   - 0.5.0 接入任务动画。
import { credentialRef } from '@deepseek-ai/dsh-credentials'

export const name = 'dsh-dock'

// 硬依赖 webServer：余额功能要注册 /dsh-dock/balance 路由。
// 0.1.0 框架未声明 inject，apply 在 webServer 就绪前执行导致取不到服务；
// 随 0.2.0 第一个真实 Host 功能一起补上（与 @wycto/dsh-balance-panel 一致）。
export const inject = ['webServer']

// ---------------------------------------------------------------------------
// 余额策略表（v0.2.0 模型余额 · 沿用 dsh-balance-panel@0.1.1，官方 Bearer 计费接口）
// ---------------------------------------------------------------------------

/** deepseek-official 内置默认值（适配器默认配置的镜像，配置缺失时兜底）。 */
const DEEPSEEK_DEFAULTS = {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  baseURL: 'https://api.deepseek.com',
}

function parseDeepSeek(body) {
  const infos = body && Array.isArray(body.balance_infos) ? body.balance_infos : []
  if (infos.length === 0) return { status: 'error', message: '无法识别的余额响应' }
  const entry = infos.find((i) => i && i.currency === 'CNY') || infos[0]
  const total = Number(entry && entry.total_balance)
  if (!Number.isFinite(total)) return { status: 'error', message: '余额不是数字' }
  return {
    status: 'ok',
    kind: 'currency',
    available: body.is_available !== false,
    infos: [{
      currency: typeof entry.currency === 'string' ? entry.currency : 'CNY',
      totalBalance: String(total),
      grantedBalance: String(Number(entry.granted_balance) || 0),
      toppedUpBalance: String(Number(entry.topped_up_balance) || 0),
    }],
  }
}

function parseStepFun(body) {
  const balance = Number(body && body.balance)
  if (!Number.isFinite(balance)) return { status: 'error', message: '无法识别的 StepFun 账户响应' }
  return {
    status: 'ok',
    kind: 'currency',
    infos: [{
      currency: 'CNY',
      totalBalance: String(balance),
      grantedBalance: String(Number(body.total_voucher_balance) || 0),
      toppedUpBalance: String(Number(body.total_cash_balance) || 0),
    }],
  }
}

function parseKimiCoding(body) {
  const usage = body && body.usage
  const limit = Number(usage && usage.limit)
  const used = Number(usage && usage.used)
  const remaining = Number(usage && usage.remaining)
  if (!Number.isFinite(limit) || !Number.isFinite(used) || !Number.isFinite(remaining)) {
    return { status: 'error', message: '无法识别的 Kimi 配额响应' }
  }
  const dims = [{
    window: 'weekly',
    limit,
    used,
    remaining,
    resetTime: typeof usage.resetTime === 'string' ? usage.resetTime : null,
  }]
  const limits = Array.isArray(body.limits) ? body.limits : []
  if (limits.length > 0 && limits[0] && limits[0].detail) {
    const d = limits[0].detail
    const hLimit = Number(d.limit)
    const hUsed = Number(d.used)
    const hRemaining = Number(d.remaining)
    if (Number.isFinite(hLimit) && Number.isFinite(hUsed) && Number.isFinite(hRemaining)) {
      dims.push({
        window: 'hourly',
        limit: hLimit,
        used: hUsed,
        remaining: hRemaining,
        resetTime: typeof d.resetTime === 'string' ? d.resetTime : null,
      })
    }
  }
  return {
    status: 'ok',
    kind: 'quota',
    unit: 'requests',
    limit,
    used,
    remaining,
    resetTime: typeof usage.resetTime === 'string' ? usage.resetTime : null,
    dims,
  }
}

function parseOpenRouter(body) {
  const data = body && body.data
  if (!data) return { status: 'error', message: '无法识别的 OpenRouter 响应' }
  // OpenRouter 返回的是美分
  const limitCents = Number(data.limit)
  const usageCents = Number(data.usage)
  if (!Number.isFinite(limitCents)) return { status: 'error', message: 'OpenRouter limit 不是数字' }
  const balance = limitCents > 0 ? (limitCents - usageCents) / 100 : 0
  return {
    status: 'ok',
    kind: 'currency',
    infos: [{ currency: 'USD', totalBalance: String(Math.max(0, balance)) }],
  }
}

function parseMiniMax(body) {
  const remaining = Number(body && (body.data ?? body.remaining))
  const total = Number(body && (body.total ?? body.limit))
  if (!Number.isFinite(remaining)) return { status: 'error', message: '无法识别的 MiniMax 响应' }
  return {
    status: 'ok',
    kind: 'quota',
    unit: 'requests',
    limit: Number.isFinite(total) ? total : 0,
    used: Number.isFinite(total) && Number.isFinite(remaining) ? Math.max(0, total - remaining) : 0,
    remaining,
    dims: [],
  }
}

function parseXai(body) {
  const balance = Number(body && (body.balance ?? body.total_granted))
  if (!Number.isFinite(balance)) return { status: 'error', message: '无法识别的 xAI 响应' }
  return {
    status: 'ok',
    kind: 'currency',
    infos: [{ currency: 'USD', totalBalance: String(balance) }],
  }
}

/** 策略表：key 为规范 provider id，aliases 为别名。 */
const STRATEGIES = {
  deepseek: {
    suffix: '/user/balance',
    defaultBaseURL: 'https://api.deepseek.com',
    defaultKeyEnv: 'DEEPSEEK_API_KEY',
    parse: parseDeepSeek,
    aliases: ['deepseek-official'],
  },
  stepfun: {
    suffix: '/accounts',
    defaultBaseURL: 'https://api.stepfun.com/v1',
    defaultKeyEnv: 'STEPFUN_API_KEY',
    parse: parseStepFun,
  },
  'kimi-coding': {
    suffix: '/v1/usages',
    defaultBaseURL: 'https://api.kimi.com/coding',
    defaultKeyEnv: 'KIMI_API_KEY',
    parse: parseKimiCoding,
    aliases: ['kimi'],
  },
  openrouter: {
    suffix: '/api/v1/auth/key',
    defaultBaseURL: 'https://openrouter.ai',
    defaultKeyEnv: 'OPENROUTER_API_KEY',
    parse: parseOpenRouter,
  },
  minimax: {
    suffix: '/v1/token_plan/remains',
    defaultBaseURL: 'https://api.minimax.chat',
    defaultKeyEnv: 'MINIMAX_API_KEY',
    parse: parseMiniMax,
  },
  xai: {
    suffix: '/v1/dashboard/billing/credit_grants',
    defaultBaseURL: 'https://api.x.ai',
    defaultKeyEnv: 'XAI_API_KEY',
    parse: parseXai,
    aliases: ['grok'],
  },
}

/** provider id 别名 → 规范 key（大小写不敏感）。 */
const KNOWN_IDS = new Map()
for (const [canonical, s] of Object.entries(STRATEGIES)) {
  KNOWN_IDS.set(canonical.toLowerCase(), canonical)
  for (const alias of s.aliases || []) KNOWN_IDS.set(alias.toLowerCase(), canonical)
}

/** baseURL 家族 → 规范 key（自定义别名指向已知端点时自动命中）。 */
const URL_MATCHERS = [
  [/api\.deepseek\.com/i, 'deepseek'],
  [/api\.stepfun\.com/i, 'stepfun'],
  [/api\.kimi\.com/i, 'kimi-coding'],
  [/openrouter\.ai/i, 'openrouter'],
  [/api\.minimax\.chat/i, 'minimax'],
  [/api\.x\.ai/i, 'xai'],
  [/platform\.stepfun\.com/i, 'stepfun'],
]

/** 无 API 余额接口、需登录控制台查看的 Provider（id → 控制台 URL）。 */
const LOGIN_REQUIRED_BY_ID = {
  'qwen-token-plan-cn': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
  'qwen-token-plan': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
  'qwen-coding-plan': 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal',
  xiaomi: 'https://platform.xiaomimimo.com/console/balance',
}

const LOGIN_REQUIRED_URLS = [
  [/bailian\.console\.aliyun\.com|dashscope|aliyuncs\.com/i, 'https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal'],
  [/xiaomimimo\.com/i, 'https://platform.xiaomimimo.com/console/balance'],
]

function stripSlash(url) {
  return String(url).replace(/\/+$/, '')
}

/**
 * 解析 Provider 的余额查询策略：先按 id（含别名）精确匹配，再按 baseURL 家族匹配。
 * @returns {object|undefined} { url, keyEnv, parse }
 */
function matchStrategy(providerId, profile) {
  const canonical = KNOWN_IDS.get(String(providerId).toLowerCase())
  if (canonical !== undefined) {
    const s = STRATEGIES[canonical]
    const baseURL = profile && typeof profile.baseURL === 'string' ? profile.baseURL : s.defaultBaseURL
    const keyEnv = profile && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : s.defaultKeyEnv
    return { url: `${stripSlash(baseURL)}${s.suffix}`, keyEnv, parse: s.parse }
  }
  const baseURL = profile && typeof profile.baseURL === 'string' ? profile.baseURL : undefined
  if (baseURL !== undefined) {
    for (const [pattern, key] of URL_MATCHERS) {
      if (pattern.test(baseURL)) {
        const s = STRATEGIES[key]
        if (s) {
          return {
            url: `${stripSlash(baseURL)}${s.suffix}`,
            keyEnv: profile && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : s.defaultKeyEnv,
            parse: s.parse,
          }
        }
      }
    }
  }
  return undefined
}

/** 解析"需登录查看"的 Provider 控制台地址。 */
function matchLoginRequired(providerId, profile) {
  const byId = LOGIN_REQUIRED_BY_ID[String(providerId).toLowerCase()]
  if (byId !== undefined) return byId
  const baseURL = profile && typeof profile.baseURL === 'string' ? profile.baseURL : undefined
  if (baseURL !== undefined) {
    for (const [pattern, url] of LOGIN_REQUIRED_URLS) {
      if (pattern.test(baseURL)) return url
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Provider 枚举与余额查询
// ---------------------------------------------------------------------------

/** 沿 settingsPath 走一层对象（user/base/value 都可用）。 */
function walkPath(node, path) {
  for (const key of path || []) {
    node = node && typeof node === 'object' ? node[key] : undefined
  }
  return node
}

/** 从 profile 里提取模型 id 列表（字符串或 {id|name} 均可）。 */
function modelsOf(profile) {
  if (!profile || !Array.isArray(profile.models)) return []
  return profile.models
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter((x) => typeof x === 'string' && x)
}

/**
 * 枚举**已配置**的 Provider：settings 的 user 层（用户自己写的）或 base 层
 * （部署层声明）里有该 Provider 的 profile，或者是默认模型选中的 Provider。
 * 模型只取用户实际配置的；schema 默认模型列表不会带出。
 */
function collectProviders(ctx) {
  const llm = ctx.get('llm')
  const settings = ctx.get('settings')
  const entries = (llm && llm.listConfigurableProviders ? llm.listConfigurableProviders() : []) || []
  let views = []
  try {
    views = (settings && settings.describe ? settings.describe({ redactSecrets: true }) : []) || []
  } catch {
    // settings 未挂载
  }

  let sel = null
  try {
    sel = (ctx.get('agentDefaultModel') && ctx.get('agentDefaultModel').currentSelection()) || null
  } catch {
    // 服务缺失
  }

  const out = new Map()
  for (const e of entries) {
    const desc = views.find((v) => v && String(v.ns) === e.settingsNs)
    const profileUser = desc ? walkPath(desc.user, e.settingsPath) : undefined
    const profileBase = desc ? walkPath(desc.base, e.settingsPath) : undefined
    const isDefaultProvider = !!(sel && sel.provider === e.provider)

    const configured = isDefaultProvider
      || (profileUser && typeof profileUser === 'object')
      || (profileBase && typeof profileBase === 'object')
    if (!configured) continue

    const userModels = modelsOf(profileUser)
    const baseModels = modelsOf(profileBase)
    let models = userModels.length > 0 ? userModels : baseModels
    if (models.length === 0 && isDefaultProvider && sel && sel.model) models = [sel.model]

    const profile = profileUser && typeof profileUser === 'object'
      ? profileUser
      : (profileBase && typeof profileBase === 'object' ? profileBase : undefined)

    const isDeepseek = e.provider === 'deepseek-official' || e.provider === 'deepseek'
    let apiKeyEnv = profile && typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
    let baseURL = profile && typeof profile.baseURL === 'string' ? profile.baseURL : undefined
    let api = profile && typeof profile.api === 'string' ? profile.api : undefined
    if (isDeepseek) {
      apiKeyEnv = apiKeyEnv || DEEPSEEK_DEFAULTS.apiKeyEnv
      baseURL = baseURL || DEEPSEEK_DEFAULTS.baseURL
      api = api || 'deepseek'
    }

    out.set(e.provider, {
      id: e.provider,
      displayName: (profile && typeof profile.displayName === 'string' && profile.displayName) || e.displayName || e.provider,
      apiKeyEnv,
      baseURL,
      api,
      models,
      profile: profile || undefined,
    })
  }

  // 默认 Provider 若不在目录里，用内置默认兜底
  if (sel && sel.provider && !out.has(sel.provider)) {
    const isDeepseek = sel.provider === 'deepseek-official' || sel.provider === 'deepseek'
    out.set(sel.provider, {
      id: sel.provider,
      displayName: sel.provider,
      apiKeyEnv: isDeepseek ? DEEPSEEK_DEFAULTS.apiKeyEnv : undefined,
      baseURL: isDeepseek ? DEEPSEEK_DEFAULTS.baseURL : undefined,
      api: isDeepseek ? 'deepseek' : undefined,
      models: sel.model ? [sel.model] : [],
      profile: undefined,
    })
  }
  return { providers: Array.from(out.values()), default: sel }
}

/** 用宿主全局 fetch 发起带认证头的 GET 并解析 JSON。 */
async function httpGetJson(url, auth, key) {
  if (typeof fetch !== 'function') {
    return { ok: false, error: '宿主进程没有全局 fetch' }
  }
  const headers = {}
  if (auth === 'bearer' && key) headers.authorization = `Bearer ${key}`
  let res
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
  if (!res.ok) return { ok: false, error: `余额接口 HTTP ${res.status}` }
  try {
    return { ok: true, body: await res.json() }
  } catch {
    return { ok: false, error: '余额接口返回了非 JSON 内容' }
  }
}

async function resolveKey(ctx, keyEnv) {
  if (!keyEnv) return null
  try {
    const credentials = ctx.get('credentials')
    const hit = credentials ? await credentials.resolve(credentialRef(keyEnv)) : null
    return hit && hit.value ? hit.value : null
  } catch {
    return null
  }
}

async function queryEndpoint(ctx, spec, entry) {
  if (spec.keyEnv && !spec.key) {
    return { status: 'no-credential', message: `凭证 ${spec.keyEnv} 未配置` }
  }
  const res = await httpGetJson(spec.url, spec.auth, spec.key)
  if (!res.ok) return { status: 'error', message: res.error }
  const parsed = spec.parse(res.body)
  if (parsed.status === 'ok') entry.credentialConfigured = true
  return parsed
}

/** 查询单个 Provider 的余额/配额/登录地址，产出给前端的归一化条目。 */
async function queryProviderBalance(ctx, p) {
  const entry = {
    id: p.id,
    displayName: p.displayName,
    apiKeyEnv: p.apiKeyEnv || null,
    baseURL: p.baseURL || null,
    api: p.api || null,
    models: p.models || [],
    credentialConfigured: false,
    balance: null,
  }
  // 先报告密钥配置状态（describe 不读取值）
  if (p.apiKeyEnv) {
    try {
      const credentials = ctx.get('credentials')
      const info = credentials ? await credentials.describe(credentialRef(p.apiKeyEnv)) : null
      entry.credentialConfigured = !!(info && info.configured)
    } catch {
      // 保持 false
    }
  }

  // 1) 自定义 balance 配置优先
  const custom = p.profile && typeof p.profile.balance === 'object' && p.profile.balance !== null
    ? p.profile.balance
    : null
  if (custom && typeof custom.endpoint === 'string' && custom.endpoint) {
    entry.balance = await queryEndpoint(ctx, {
      url: /^https?:\/\//.test(custom.endpoint)
        ? custom.endpoint
        : `${(p.baseURL || '').replace(/\/+$/, '')}${custom.endpoint}`,
      auth: custom.auth === 'none' ? 'none' : 'bearer',
      keyEnv: p.apiKeyEnv,
      parse: parseDeepSeek,
      key: p.apiKeyEnv ? await resolveKey(ctx, p.apiKeyEnv) : null,
    }, entry)
    return entry
  }

  // 2) 内置策略表（id 别名 + baseURL 家族）
  const strat = matchStrategy(p.id, p.profile)
  if (strat) {
    entry.balance = await queryEndpoint(ctx, {
      url: strat.url,
      auth: 'bearer',
      keyEnv: strat.keyEnv,
      parse: strat.parse,
      key: await resolveKey(ctx, strat.keyEnv),
    }, entry)
    return entry
  }

  // 3) 登录跳转（无 API 接口但有控制台）
  const consoleUrl = matchLoginRequired(p.id, p.profile)
  if (consoleUrl) {
    entry.balance = { status: 'login-required', consoleUrl }
    return entry
  }

  // 4) 不支持
  entry.balance = { status: 'unsupported', message: '该 Provider 没有已知的余额查询接口' }
  return entry
}

/** 汇总全部 Provider 的余额视图。 */
async function queryAll(ctx) {
  const collected = collectProviders(ctx)
  const providers = []
  for (const p of collected.providers) {
    try {
      providers.push(await queryProviderBalance(ctx, p))
    } catch (e) {
      providers.push({
        id: p.id,
        displayName: p.displayName,
        apiKeyEnv: p.apiKeyEnv || null,
        baseURL: p.baseURL || null,
        api: p.api || null,
        models: p.models || [],
        credentialConfigured: false,
        balance: { status: 'error', message: e && e.message ? e.message : String(e) },
      })
    }
  }
  return { generatedAt: Date.now(), default: collected.default, providers }
}

/** 序列化 JSON 响应。 */
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// 模型设置（v0.3.0）：模型目录读 + 官方配置写
//   GET  /dsh-dock/models —— 枚举全部已配置 Provider 的模型目录（含输入类型/思考强度）
//   POST /dsh-dock/models —— 把面板编辑写回官方 settings（settings.mutate，热生效）
// 官方链路（集成不改内核）：
//   - 会话模型选择器按 model.reasoning.efforts 展示强度档；档位源自 Provider 配置：
//     · pi-ai 路由：每模型 reasoningEfforts（档位 → wire 值；off:null 表示"支持关闭、不发参数"；false = 不支持思考）
//     · deepseek 官方：连接级 thinking（enabled/disabled）+ reasoningEffort 默认档，全模型共享 Off/Low/High/Max
//   - 输入类型官方 schema 仅接受 text/image；「视频」等以 dockTags 标注随配置持久化（不参与请求路由）
//   - schemastery 保留未知字段（实测），dockTags 对官方校验透明
// ---------------------------------------------------------------------------

/** 官方 schema 接受的输入模态（写回配置的 input 只允许这两个）。 */
const HOST_MODALITIES = ['text', 'image']
/** pi-ai 支持的思考档位（升序）。 */
const PI_AI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** deepseek 官方支持的思考档位。 */
const DEEPSEEK_LEVELS = ['off', 'low', 'high', 'max']

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

/** 把 pi-ai 模型条目归一为面板视图。 */
function piAiModelView(entry, routeDefaultInput) {
  const input = strList(entry.input).filter((m) => HOST_MODALITIES.includes(m))
  const raw = entry.reasoningEfforts
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : undefined,
    contextWindow: posInt(entry.contextWindow),
    maxTokens: posInt(entry.maxTokens),
    input: input.length > 0 ? input : (strList(routeDefaultInput).length > 0 ? strList(routeDefaultInput) : ['text']),
    inputInherited: input.length === 0,
    efforts: raw === undefined ? 'inherit' : raw === false ? 'off' : 'custom',
    effortMap: raw && typeof raw === 'object' ? raw : null,
    tags: strList(entry.dockTags),
  }
}

/** 把 deepseek 目录模型归一为面板视图。 */
function deepSeekModelView(entry) {
  const input = strList(entry.inputModalities).filter((m) => HOST_MODALITIES.includes(m))
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' ? entry.name : undefined,
    contextWindow: posInt(entry.contextWindow),
    maxTokens: posInt(entry.maxTokens),
    input: input.length > 0 ? input : ['text'],
    inputInherited: input.length === 0,
    tags: strList(entry.dockTags),
  }
}

/**
 * 读模型目录：按 collectProviders 同样的"已配置"口径枚举 Provider，
 * 输出各 Provider 的模型列表（含输入类型 / 思考强度）与各 settings 命名空间的 revision。
 */
function readModelDirectory(ctx) {
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

/** 校验面板提交的模型草稿，产出写回 pi-ai 的模型条目（不合法直接抛错）。 */
function piAiModelWrite(m) {
  if (!m || typeof m.id !== 'string' || !m.id) throw new Error('模型 id 不能为空')
  const entry = { id: m.id }
  if (typeof m.name === 'string' && m.name) entry.name = m.name
  if (m.contextWindow !== undefined && m.contextWindow !== null && m.contextWindow !== '') {
    const n = Number(m.contextWindow)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`模型 ${m.id} 的上下文窗口须为正整数`)
    entry.contextWindow = n
  }
  if (m.maxTokens !== undefined && m.maxTokens !== null && m.maxTokens !== '') {
    const n = Number(m.maxTokens)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`模型 ${m.id} 的最大输出须为正整数`)
    entry.maxTokens = n
  }
  const input = Array.isArray(m.input) ? m.input.filter((x) => HOST_MODALITIES.includes(x)) : []
  if (input.length > 0) entry.input = input // 留空 = 继承路由/目录默认
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
  } // inherit = 不写该字段，跟随内置目录
  const tags = strList(m.tags)
  if (tags.length > 0) entry.dockTags = tags // 标注（如 video），官方校验忽略、随配置持久化
  return entry
}

/** 校验并产出写回 deepseek 官方的目录模型条目。 */
function deepSeekModelWrite(m) {
  if (!m || typeof m.id !== 'string' || !m.id) throw new Error('模型 id 不能为空')
  const entry = { id: m.id }
  if (typeof m.name === 'string' && m.name) entry.name = m.name
  if (m.contextWindow !== undefined && m.contextWindow !== null && m.contextWindow !== '') {
    const n = Number(m.contextWindow)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`模型 ${m.id} 的上下文窗口须为正整数`)
    entry.contextWindow = n
  }
  if (m.maxTokens !== undefined && m.maxTokens !== null && m.maxTokens !== '') {
    const n = Number(m.maxTokens)
    if (!Number.isInteger(n) || n <= 0) throw new Error(`模型 ${m.id} 的最大输出须为正整数`)
    entry.maxTokens = n
  }
  const input = Array.isArray(m.input) ? m.input.filter((x) => HOST_MODALITIES.includes(x)) : []
  if (input.includes('image')) entry.inputModalities = input // 纯文本留空走 schema 默认 ['text']
  const tags = strList(m.tags)
  if (tags.length > 0) entry.dockTags = tags
  return entry
}

/**
 * 写回官方配置：按 Provider kind 生成 settings.mutate ops。
 * 校验失败/官方 schema 拒绝时抛错（路由层转 4xx 带信息）。
 */
async function writeModelConfig(ctx, body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不是 JSON 对象')
  const dir = readModelDirectory(ctx)
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

  const settings = ctx.get('settings')
  if (!settings || typeof settings.mutate !== 'function') throw new Error('settings 服务不可用或不可写')

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
    ops.push({ op: 'set', path: ['providers', route, 'models'], value: body.models.map(piAiModelWrite) })
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

/** 解析 POST 请求体 JSON（限长 2MB）。 */
function readBody(req) {
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

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export function apply(ctx) {
  // ---- 功能注册表（Host 侧）----
  // defaultEnabled：与 Client 半部注册表保持一致。已接入的功能默认打开，
  // 规划中的功能缺省 false，等实现后移除 roadmap 并打开。
  const FEATURES = [
    {
      id: 'models',
      name: '模型设置',
      description: '模型目录读写：编辑输入类型与思考强度，写回官方配置热生效',
      defaultEnabled: true,
    },
    {
      id: 'balance',
      name: '模型余额',
      description: '拉取所有模型 Provider 账户余额并展示',
      defaultEnabled: true,
    },
    {
      id: 'tokenlog',
      name: 'Token 用量记录',
      roadmap: '0.4.0',
      description: '记录全部 LLM API 调用并统计',
    },
    {
      id: 'animation',
      name: '任务动画',
      roadmap: '0.5.0',
      description: '任务进度动画与通知',
    },
  ]

  const state = new Map()
  for (const f of FEATURES) state.set(f.id, { enabled: false, dispose: null, error: null })

  // 每个功能的 Host 半部安装函数：返回 disposer，关闭功能时调用。
  // balance：在回环 webServer 上挂 /dsh-dock/balance 路由，查询即请求时执行，
  //   密钥全程留在进程内不出 Host（credentials.resolve 只取用不输出）。
  // models：挂 /dsh-dock/models（GET 读目录 / POST 写回官方 settings，热生效）。
  const hostSetups = {
    balance: () => {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供余额查询路由')
      const handler = async (req, res) => {
        try {
          sendJson(res, 200, await queryAll(ctx))
        } catch (e) {
          sendJson(res, 500, {
            error: e instanceof Error ? e.message : String(e),
            providers: [],
          })
        }
      }
      return webServer.register({ kind: 'exact', path: '/dsh-dock/balance', handler })
    },
    models: () => {
      const webServer = ctx.get('webServer')
      if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供模型设置路由')
      const handler = async (req, res) => {
        try {
          if (req.method === 'GET') {
            sendJson(res, 200, readModelDirectory(ctx))
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

  function setEnabled(id, enabled) {
    const st = state.get(id)
    if (!st || st.enabled === enabled) return
    st.enabled = enabled
    st.error = null
    if (enabled) {
      const setup = hostSetups[id]
      if (setup) {
        try {
          st.dispose = setup() || null
        } catch (err) {
          st.error = String((err && err.message) || err)
          console.error('[dsh-dock] feature setup failed:', id, err)
        }
      }
    } else if (st.dispose) {
      try {
        st.dispose()
      } catch (err) {
        console.error('[dsh-dock] feature dispose failed:', id, err)
      }
      st.dispose = null
    }
  }

  // 默认启用已实现的功能（与 Client 半部 defaultEnabled 对齐）。
  // 目前 Host↔Client 的开关同步在 0.5.0（持久化 + 双侧注册表打通）落地，
  // 在此之前 Host 侧开关以本处 defaultEnabled 为准。
  for (const f of FEATURES) {
    if (f.defaultEnabled) setEnabled(f.id, true)
  }

  console.log('[dsh-dock] host half loaded; features registered:', FEATURES.map((f) => f.id).join(', '))

  // 插件卸载/更新时兜底清理仍在运行的功能
  ctx.effect(() => () => {
    for (const st of state.values()) {
      if (st.dispose) {
        try {
          st.dispose()
        } catch (err) {
          /* ignore */
        }
      }
    }
  })
}