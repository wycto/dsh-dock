// dsh-dock · 功能模块【模型提供商】· 宿主半部
//
// GET  /dsh-dock/providerconfig —— Provider 列表（端点 / API Key 条目 / 密钥是否已配置 / 模型数）
// POST /dsh-dock/providerconfig —— action=listModels  拉取上游模型列表（GET {baseURL}/models）
//                                 action=create|update|delete  维护 llm-pi-ai 的 providers 字典
//
// 为什么单独成模块：Provider 的增删改与凭据写入是**配置面**的操作（会写官方 settings
// 与本地凭据库），与「调模型的模态类型/思考强度」是两件事。拆开后可以只开【模型设置】
// 而不开【模型提供商】——不需要改 Provider 的部署（例如只用官方 DeepSeek 端点）就不必
// 把写凭据、发起出站请求的路由挂在进程里，攻击面随功能一起关掉。
//
// 模型条目的整形（piAiModelWrite）与目录读取（readModelDirectory）都在 src/model-directory.js，
// 与【模型设置】共用同一份口径，两条入口写出的条目必须一致。
import { sendJson, readBody, rejectUntrustedRequest } from '../../src/host-core.js'
import { PI_AI_APIS, ROUTE_KEY_RE, readModelDirectory, piAiModelWrite } from '../../src/model-directory.js'
// 凭据引用（apiKeyEnv → 本地凭据库条目）。注意：只从本模块取 credentialRef；
// 不同 dsh 版本导出的辅助函数不一致（isCredentialRefName 在运行期并不存在），
// 非法环境变量名一律用 try/catch + credentialRef 兜住。
import { credentialRef } from '@deepseek-ai/dsh-credentials'

/**
 * 并行补 Provider 的 apiKeyConfigured：apiKeyEnv 指向的条目是否已在本地凭据库配置。
 * 凭据库不可用 / 环境变量名非法时一律降级为 false（不抛错，避免整表 500）。
 */
async function enrichApiKeyStatus(ctx, dir) {
  const credentials = ctx.get('credentials')
  if (!credentials || typeof credentials.describe !== 'function') return
  await Promise.all((dir.providers || []).filter((p) => p.kind === 'pi-ai').map(async (p) => {
    if (typeof p.apiKeyEnv !== 'string' || !p.apiKeyEnv) { p.apiKeyConfigured = false; return }
    try {
      const d = await credentials.describe(credentialRef(p.apiKeyEnv))
      p.apiKeyConfigured = !!(d && d.configured)
    } catch {
      p.apiKeyConfigured = false
    }
  }))
}

/**
 * 拉取 Provider 的可用模型列表：OpenAI 兼容端点 GET {baseURL}/models。
 * Key 优先用请求里刚填的明文（还没保存就能先拉列表），否则回退到已配置的凭据库条目。
 * 只做「列目录」，不代表该模型真能调用（额度/权限以上游为准）。
 *
 * 注意：baseURL 由调用方给出（新建 Provider 时还没落盘），因此这是**有意的出站请求**；
 * 提供它的前提是它已经被浏览器信任栅栏挡过一道（见 rejectUntrustedRequest）。
 */
async function fetchProviderModels(ctx, body) {
  const bad = (msg) => { const e = new Error(msg); e.statusCode = 400; return e }
  const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\//i.test(baseURL)) throw bad('请先填写合法的 baseURL（http:// 或 https://）')
  let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!key && typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim()) {
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const got = await credentials.resolve(credentialRef(body.apiKeyEnv.trim()))
        key = typeof got === 'string' ? got : (got && typeof got.value === 'string' ? got.value : '')
      } catch { key = '' }
    }
  }
  const headers = { accept: 'application/json' }
  if (key) {
    if (body.api === 'anthropic-messages') {
      headers['x-api-key'] = key
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.authorization = 'Bearer ' + key
    }
  }
  let res
  try {
    res = await fetch(baseURL + '/models', { headers, signal: AbortSignal.timeout(20000) })
  } catch (e) {
    const err = new Error(`请求 ${baseURL}/models 失败：${(e && e.message) || String(e)}`)
    err.statusCode = 400
    throw err
  }
  let text = ''
  try { text = await res.text() } catch { text = '' }
  if (!res.ok) {
    const err = new Error(`上游返回 HTTP ${res.status}${text ? '：' + text.slice(0, 240) : ''}`)
    err.statusCode = 400
    throw err
  }
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON：下面按空列表处理 */ }
  let list = []
  if (Array.isArray(json)) list = json
  else if (json && Array.isArray(json.data)) list = json.data
  else if (json && Array.isArray(json.models)) list = json.models
  const models = list.map((x) => {
    if (typeof x === 'string') return { id: x }
    const o = x && typeof x === 'object' ? x : {}
    return { id: String(o.id || o.model || o.name || ''), name: typeof o.name === 'string' ? o.name : undefined }
  }).filter((m) => m.id)
  return { ok: true, count: models.length, models, fetchedAt: Date.now() }
}

/**
 * Provider 级增 / 改 / 删（走 llm-pi-ai 的 providers 字典，不改内核）。
 *   body.action = 'create' | 'update' | 'delete'
 *   body.route  = providers 字典的 key（= 路由 id）
 *   body.profile = { displayName, api, baseURL, apiKeyEnv, defaultInput, models: [草稿...] }
 *   body.apiKey  = 可选明文 Key（写本地凭据库，不落到配置文件）
 *   body.revisions['llm-pi-ai'] = GET 拿到的 revision（乐观锁，撞车 409）
 * 未在 profile 里出现的未知字段？——不会：base 以原 profile 为基础合并，用户自配的
 * compat / description 等原样保留，只覆盖面板负责的那几个键。
 */
async function writeProviderConfig(ctx, body) {
  const settings = ctx.get('settings')
  if (!settings || typeof settings.mutate !== 'function') throw new Error('settings 服务不可用或不可写')
  const action = body.action
  const route = typeof body.route === 'string' ? body.route.trim() : ''
  const revision = body.revisions && typeof body.revisions['llm-pi-ai'] === 'number'
    ? body.revisions['llm-pi-ai'] : undefined
  const bad = (msg) => { const e = new Error(msg); e.statusCode = 400; return e }

  if (action === 'delete') {
    if (!route) throw bad('请求缺少 route')
    const dir = readModelDirectory(ctx)
    const p = (dir.providers || []).find((x) => (x.route || x.id) === route)
    if (!p) throw bad(`未找到 Provider：${route}`)
    if (p.kind !== 'pi-ai') throw bad('内置 Provider（如 DeepSeek 官方）不能删除，只能编辑其模型')
    try {
      await settings.mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', p.route || route] }], revision)
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      const err = new Error(`删除被拒绝：${msg}`)
      err.statusCode = /conflict|revision/i.test(msg) ? 409 : 400
      throw err
    }
    return { ok: true, deleted: p.route || route, savedAt: Date.now() }
  }

  if (action !== 'create' && action !== 'update') throw bad(`不支持的 action：${action}`)
  if (!route || !ROUTE_KEY_RE.test(route)) throw bad('路由 key 非法：须以字母数字开头，只能含字母、数字与 . _ -')
  const src = body.profile && typeof body.profile === 'object' && !Array.isArray(body.profile) ? body.profile : {}
  const api = typeof src.api === 'string' ? src.api : ''
  if (PI_AI_APIS.indexOf(api) < 0) throw bad(`api 非法：只支持 ${PI_AI_APIS.join(' / ')}`)
  const baseURL = typeof src.baseURL === 'string' ? src.baseURL.trim() : ''
  if (!/^https?:\/\//i.test(baseURL)) throw bad('baseURL 非法：须以 http:// 或 https:// 开头')
  let apiKeyEnv = typeof src.apiKeyEnv === 'string' ? src.apiKeyEnv.trim() : ''
  if (apiKeyEnv) {
    try { credentialRef(apiKeyEnv) } catch { throw bad('apiKeyEnv 非法：须是合法的环境变量名（如 MODELSCOPE_API_KEY）') }
  }
  const models = Array.isArray(src.models) ? src.models : []
  if (models.length === 0) throw bad('至少需要一个模型')
  const seen = new Set()
  for (const m of models) {
    const id = m && typeof m.id === 'string' ? m.id.trim() : ''
    if (!id) throw bad('模型 id 不能为空')
    if (seen.has(id)) throw bad(`模型 id 重复：${id}`)
    seen.add(id)
  }

  const base = Object.assign({}, src)
  delete base.models
  const displayName = typeof src.displayName === 'string' ? src.displayName.trim() : ''
  if (displayName) base.displayName = displayName; else delete base.displayName
  base.api = api
  base.baseURL = baseURL
  if (apiKeyEnv) base.apiKeyEnv = apiKeyEnv; else delete base.apiKeyEnv
  base.models = models.map((m) => piAiModelWrite(
    Object.assign({}, m, { id: String(m.id).trim() }),
    { api, route, baseURL }
  ))

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (apiKey) {
    if (!apiKeyEnv) {
      // Key 填了但 apiKeyEnv 留空：按路由 key 自动生成凭据库条目名（与客户端 dkmEnvFromRoute 一致），
      // 不再要求用户现编一个环境变量名
      const s = String(route || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
      apiKeyEnv = (s ? (/^[0-9]/.test(s) ? 'KEY_' + s : s) : 'PROVIDER') + '_API_KEY'
      base.apiKeyEnv = apiKeyEnv
    }
    const credentials = ctx.get('credentials')
    if (!credentials || typeof credentials.set !== 'function') throw bad('凭据库不可用，无法保存 API Key')
    try {
      await credentials.set(credentialRef(apiKeyEnv), apiKey)
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      const err = new Error(`写入本地凭据库失败：${msg}`)
      err.statusCode = 400
      throw err
    }
  }

  try {
    await settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value: base }], revision)
  } catch (e) {
    const msg = e && e.message ? e.message : String(e)
    const err = new Error(`写回官方配置被拒绝：${msg}`)
    err.statusCode = /conflict|revision/i.test(msg) ? 409 : 400
    throw err
  }
  return { ok: true, route, created: action === 'create', savedAt: Date.now() }
}

/** 功能注册表条目：index.js 组装 hostSetups 时使用。 */
export const feature = {
  id: 'providerconfig',
  name: '模型提供商',
  description: '管理模型 Provider 的端点与 API Key（增删改 + 拉取上游模型列表）',
  defaultEnabled: false,
  setup(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供模型提供商路由')
    const handler = async (req, res) => {
      if (rejectUntrustedRequest(ctx, req, res)) return
      try {
        if (req.method === 'GET') {
          const payload = readModelDirectory(ctx)
          await enrichApiKeyStatus(ctx, payload)
          sendJson(res, 200, payload)
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          const action = body && typeof body === 'object' ? body.action : undefined
          const result = action === 'listModels'
            ? await fetchProviderModels(ctx, body)
            : await writeProviderConfig(ctx, body)
          sendJson(res, 200, result)
          return
        }
        sendJson(res, 405, { error: `不支持的请求方法：${req.method}` })
      } catch (e) {
        const status = e && e.statusCode ? e.statusCode : 500
        sendJson(res, status, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return webServer.register({ kind: 'exact', path: '/dsh-dock/providerconfig', handler })
  },
}
