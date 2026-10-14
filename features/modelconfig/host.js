// dsh-dock · 功能模块【模型设置】· 宿主半部
//
// GET  /dsh-dock/models —— 读模型目录（各 Provider 的模型、输入模态、思考强度）
// POST /dsh-dock/models —— 把面板对**单个模型**的编辑写回官方 settings（热生效）
//
// 边界（Provider 配置拆出后）：本模块只管模型条目自身的属性——输入模态
// （text/image）与思考强度/默认档。Provider 自身的增删改、API Key、拉取上游模型
// 列表属于【模型提供商】（features/providerconfig/），两个功能可各自启停。
//
// 官方链路（集成不改内核）：
//   - 会话模型选择器按 model.reasoning.efforts 展示强度档；档位源自 Provider 配置：
//     · pi-ai 路由：每模型 reasoningEfforts（档位 → wire 值；off:null 表示"支持关闭、不发参数"；false = 不支持思考）
//     · deepseek 官方：连接级 thinking（enabled/disabled）+ reasoningEffort 默认档，全模型共享 Off/Low/High/Max
//   - 输入类型官方 schema 仅接受 text/image；「视频」等以 dockTags 标注随配置持久化（不参与请求路由）
//   - schemastery 保留未知字段（实测），dockTags 对官方校验透明
//   - POST 也收图片理解代理配置（visionProxy 分支，写 dsh-dock 自有命名空间）
import { DOCK_NS, sendJson, readBody, rejectUntrustedRequest, readDockRoot, mutateDockSection } from '../../src/host-core.js'
import {
  DEEPSEEK_LEVELS,
  readModelDirectory,
  enrichRuntimeInput,
  piAiModelWrite,
  deepSeekModelWrite,
} from '../../src/model-directory.js'

/**
 * 写回官方配置：按 Provider kind 生成 settings.mutate ops。
 * 校验失败/官方 schema 拒绝时抛错（路由层转 4xx 带信息）。
 */
async function writeModelConfig(ctx, body) {
  if (!body || typeof body !== 'object') throw new Error('请求体不是 JSON 对象')

  const settings = ctx.get('settings')
  if (!settings || typeof settings.mutate !== 'function') throw new Error('settings 服务不可用或不可写')

  // 图片理解代理配置：独立于模型目录的小分支（该功能的界面挂在【模型设置】页内，
  // 拆出 Provider 配置时未动它，仍是同一条 POST 的旁路）。
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
      await mutateDockSection(ctx, ['visionProxy'], value, revision)
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
  id: 'modelconfig',
  name: '模型设置',
  description: '模型目录：编辑各模型的输入模态与思考强度，写回官方配置热生效',
  defaultEnabled: false,
  setup(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供模型设置路由')
    const handler = async (req, res) => {
      if (rejectUntrustedRequest(ctx, req, res)) return
      try {
        if (req.method === 'GET') {
          const payload = readModelDirectory(ctx)
          await enrichRuntimeInput(ctx, payload)
          // 附带图片理解代理配置与自有命名空间 revision（面板保存用）
          try {
            const v = readDockRoot(ctx)
            payload.visionProxy = v && v.visionProxy
              ? { enabled: !!v.visionProxy.enabled, provider: String(v.visionProxy.provider || ''), model: String(v.visionProxy.model || '') }
              : { enabled: false, provider: '', model: '' }
            const settings = ctx.get('settings')
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
          sendJson(res, 200, await writeModelConfig(ctx, body))
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
