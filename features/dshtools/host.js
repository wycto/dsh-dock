// dsh-dock · 功能模块【DSH功能】· 宿主半部
//
// 给 DSH 自带界面补充能力的开关集合。结构是「分组 × 勾选项」，和面板里其它功能一样
// 由功能开关统一启停；组内每一项都是独立勾选，不勾选就完全不介入（客户端不显示入口）。
//
//   GET  /dsh-dock/dshtools  → { ok, groups:[{ id, name, description, items:[{ key, name, description, value }] }] }
//   POST /dsh-dock/dshtools  { group, key, value:boolean } → 同上（写回 settings 的 dshtools 段）
//   GET  /dsh-dock/download?path=/abs/file → 流式下载原文件（Content-Disposition: attachment）
//
// 为什么要单独一条下载路由：DSH 内置的右键「下载」走的是 Remote 整文件读取
// （workspaceFiles.readBytes），默认上限 maxFileBytes = 32 MiB，超过直接失败
// （workspace-file/too-large），前端只弹一句「无法保存文件」。这条路由按块
// readByteRange 流式发送，不受该上限影响，也不把整份文件读进内存。
//
// 新增一项能力：在 DSH_TOOL_GROUPS 对应分组下加一项（key/name/description/default），
// 客户端页面会自动多出这个勾选框；宿主按 settingValue(ctx, group, key) 决定行为。
import { isAbsolute } from 'node:path'
import { readBody, readDockRoot, mutateDockSection, rejectUntrustedRequest, sendJson } from '../../src/host-core.js'

/** 内置「下载」Remote 的整文件默认上限（packages/api/workspace-files 的 maxFileBytes）。 */
export const LARGE_FILE_BYTES = 32 * 1024 * 1024

/** 流式分块大小：1 MiB。足够小，16 路并发下载也只占十几 MiB 内存。 */
const CHUNK_BYTES = 1024 * 1024

/**
 * 分组清单：客户端页面渲染与宿主行为共用同一份键名。
 * 默认值 = 首次运行（settings 里还没有记录）时的勾选状态。
 */
export const DSH_TOOL_GROUPS = [
  {
    id: 'fileContextMenu',
    name: '文件右键',
    description: '文件卡片、文件树右键菜单里的补充项。',
    items: [
      {
        key: 'streamingDownload',
        name: '大文件下载（流式）',
        description: '右键「下载」改由本模块流式发送原文件，不再受 32 MiB 预览读取上限限制；大文件另提供「下载（大文件）」入口。',
        default: true,
      },
    ],
  },
]

/** 当前勾选值：清单里的每一项都有值（缺省用 default），未知键忽略。 */
export function readDshtoolsValues(ctx) {
  const root = readDockRoot(ctx)
  const saved = root && typeof root === 'object' && root.dshtools && typeof root.dshtools === 'object'
    ? root.dshtools
    : {}
  const values = {}
  for (const group of DSH_TOOL_GROUPS) {
    const row = saved[group.id] && typeof saved[group.id] === 'object' ? saved[group.id] : {}
    const out = {}
    for (const item of group.items) {
      out[item.key] = typeof row[item.key] === 'boolean' ? row[item.key] : item.default
    }
    values[group.id] = out
  }
  return values
}

/**
 * 读单项勾选值。
 * @param {object} ctx Cordis context
 * @param {string} groupId 分组 id（DSH_TOOL_GROUPS[i].id）
 * @param {string} key 功能项 key
 * @returns {boolean|undefined} 未登记的分组/键返回 undefined
 */
export function settingValue(ctx, groupId, key) {
  const row = readDshtoolsValues(ctx)[groupId]
  return row ? row[key] : undefined
}

/** 清单 + 当前值，客户端直接渲染这份结构。 */
function groupsPayload(ctx) {
  const values = readDshtoolsValues(ctx)
  return DSH_TOOL_GROUPS.map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    items: group.items.map((item) => ({
      key: item.key,
      name: item.name,
      description: item.description,
      value: values[group.id][item.key] === true,
    })),
  }))
}

/** 设置读写路由（GET 读、POST 单项切换）。 */
async function handleSettings(ctx, req, res) {
  try {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, groups: groupsPayload(ctx) })
      return
    }
    if (req.method === 'POST') {
      const body = await readBody(req)
      const groupId = body && typeof body.group === 'string' ? body.group : ''
      const key = body && typeof body.key === 'string' ? body.key : ''
      const value = body ? body.value : undefined
      const group = DSH_TOOL_GROUPS.find((g) => g.id === groupId)
      const item = group && group.items.find((i) => i.key === key)
      if (!group || !item) {
        sendJson(res, 400, { ok: false, error: '未知的分组或功能项' })
        return
      }
      if (typeof value !== 'boolean') {
        sendJson(res, 400, { ok: false, error: 'value 必须是布尔值' })
        return
      }
      // 整段回写：清单里未知的旧键由 readDshtoolsValues 过滤，不会把设置写脏。
      const current = readDshtoolsValues(ctx)
      const next = {}
      for (const g of DSH_TOOL_GROUPS) next[g.id] = { ...current[g.id] }
      next[groupId][key] = value
      await mutateDockSection(ctx, ['dshtools'], next)
      sendJson(res, 200, { ok: true, groups: groupsPayload(ctx) })
      return
    }
    sendJson(res, 405, { ok: false, error: `不支持的请求方法：${req.method}` })
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

/** 取路径最后一段作建议文件名（兼容 Windows 分隔符）。 */
function baseName(path) {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return name.length > 0 ? name : 'download'
}

/** RFC 5987 编码：非 ASCII 文件名（中文等）必须走 filename*。 */
function rfc5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** attachment 头：ASCII 兜底 + filename* 真名。 */
function contentDisposition(name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${rfc5987(name)}`
}

/** 写响应并等背压解除；连接提前关闭也 resolve，避免挂死。 */
function drain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.once('drain', done)
    res.once('close', done)
  })
}

/** 已开始响应后的失败只能断开连接（头已发出，改不了状态码）。 */
function fail(res, status, message) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  sendJson(res, status, { ok: false, error: { code: 'download-failed', message } })
}

/**
 * GET/HEAD /dsh-dock/download?path=/abs/file
 * 流式发送原文件；路径可读性由 ctx.fs 的读取策略决定（与 DSH 的 /api/file 同一套）。
 */
async function handleDownload(ctx, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: '只支持 GET / HEAD' } }))
    return
  }
  const fs = ctx.get('fs')
  if (!fs || typeof fs.readByteRange !== 'function' || typeof fs.resolve !== 'function' || typeof fs.stat !== 'function') {
    fail(res, 503, '文件系统服务不可用，无法下载')
    return
  }
  let url
  try {
    url = new URL(req.url || '/', 'http://dsh.invalid')
  } catch {
    fail(res, 400, '请求地址无法解析')
    return
  }
  // 客户端启动探针：只证明「路由已注册 + 过了信任栅栏」，不读任何文件。
  // 探测通过后客户端才接管 DSH 自带的「下载」，宿主旧版本时保持原行为。
  if (url.searchParams.has('probe')) {
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
    return
  }
  const path = url.searchParams.get('path')
  if (path === null || path.length === 0) {
    fail(res, 400, '缺少 path 参数')
    return
  }
  if (path.includes('\0') || !isAbsolute(path)) {
    fail(res, 400, 'path 必须是绝对路径')
    return
  }
  const abort = new AbortController()
  let settled = false
  const onClose = () => { if (!settled) abort.abort() }
  res.on('close', onClose)
  try {
    const target = await fs.resolve(path, { signal: abort.signal })
    const info = await fs.stat(target, abort.signal)
    if (info === undefined) {
      fail(res, 404, '文件不存在')
      return
    }
    if (info.type !== 'file') {
      fail(res, 403, '不是普通文件')
      return
    }
    const size = typeof info.size === 'number' ? info.size : undefined
    const headers = {
      'content-type': 'application/octet-stream',
      'content-disposition': contentDisposition(baseName(path)),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...(size === undefined ? {} : { 'content-length': String(size) }),
    }
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    if (size === 0) {
      res.end()
      return
    }
    let offset = 0
    for (;;) {
      if (abort.signal.aborted) break
      const length = size === undefined ? CHUNK_BYTES : Math.min(CHUNK_BYTES, size - offset)
      if (length <= 0) break
      const chunk = await fs.readByteRange(target, { offset, length }, abort.signal)
      if (!chunk || chunk.length === 0) break
      const last = chunk.length < length
      if (!res.write(chunk)) await drain(res)
      offset += chunk.length
      if (last) break
    }
    res.end()
  } catch (error) {
    if (abort.signal.aborted) {
      res.destroy()
      return
    }
    // 与 DSH 的 /api/file 同一套错误→状态码映射：读不到/越权不伪装成 500。
    const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
    const status = code === 'FS_NOT_FOUND'
      ? 404
      : code === 'FS_PERMISSION_DENIED' || code === 'FS_SANDBOX_DENIED'
        ? 403
        : 500
    fail(res, status, error instanceof Error ? error.message : String(error))
  } finally {
    settled = true
    res.off('close', onClose)
  }
}

/** 功能注册表条目：index.js 组装 FEATURES 时使用。 */
export const feature = {
  id: 'dshtools',
  name: 'DSH功能',
  description: '给 DSH 自带界面补充能力（文件右键等），按分组勾选启用',
  defaultEnabled: true,
  setup(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供 DSH功能路由')
    const disposers = [
      webServer.register({
        kind: 'exact',
        auth: 'required',
        path: '/dsh-dock/dshtools',
        // 信任栅栏必须挂在注册点旁边（静态约定见 scripts/test-route-trust-host.mjs）
        handler: (req, res, peer) => {
          if (rejectUntrustedRequest(ctx, req, res, peer)) return
          void handleSettings(ctx, req, res)
        },
      }),
      webServer.register({
        kind: 'exact',
        auth: 'required',
        path: '/dsh-dock/download',
        handler: (req, res, peer) => {
          if (rejectUntrustedRequest(ctx, req, res, peer)) return
          void handleDownload(ctx, req, res)
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 已卸载 */ }
      }
    }
  },
}
