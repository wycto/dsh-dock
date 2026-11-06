// dsh-dock · 功能模块【MCP 管理】· 宿主半部
//
// GET  /dsh-dock/mcpconfig —— 列出本模块托管的 MCP 服务器（含实时状态与已注册工具）
// POST /dsh-dock/mcpconfig —— action=save：全量写回 profile patch 的机器托管块并热应用
//
// 背景：DSH 的 MCP 服务器是 cordis 插件行（每台服务器一行
// `name: '@deepseek-ai/dsh-mcp-client'` + 一份 config），真相源是当前 profile 的
// `cordis.patch.yml`。DSH 自身没有 MCP 管理界面，所以本模块接管其中**一段带标记的
// 机器托管块**：只改 `# >>> dsh-dock MCP manager` 与 `# <<< dsh-dock MCP manager`
// 之间的内容，用户手写的其它行/注释/!!js 表达式一律不动。
//
// 生效链路（实测可用）：写盘 → `ctx.hmr.reconcileProfile(ids)` 原地重组合
// （dsh-hmr 精确监听 profile patch 文件）→ 新增行 import 并启动、改动行只重启该行、
// 删除行 dispose 工具并杀掉子进程。无需重启 dsh。失败则把旧文本写回并再 reconcile 一次。
//
// 为什么不用 settings/configEditor 写：config-editor 只能改「已存在的条目」，
// 不能新增/删除插件行；MCP 服务器数量是动态的，必须自己维护 insert 行。
import { readFile } from 'node:fs/promises'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { sendJson, readBody, rejectUntrustedRequest } from '../../src/host-core.js'

/** 托管块的 MCP 插件包名（与 DSH 内置 MCP 客户端一致）。 */
const MCP_ROW_NAME = '@deepseek-ai/dsh-mcp-client'
/** 本模块写入的行 id 前缀：id = dock-mcp-<serverName>。 */
const ROW_ID_PREFIX = 'dock-mcp-'
const BEGIN = '# >>> dsh-dock MCP manager (machine-managed; do not edit by hand)'
const END = '# <<< dsh-dock MCP manager'
/** mcp-client 的 serverName 约束（packages/mcp/mcp-client/src/index.ts）。 */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
/** 默认单次工具调用超时（与 mcp-client 一致）。 */
const DEFAULT_TOOL_TIMEOUT_MS = 60000

/**
 * 与 DSH 自己的 patch 方言一致的 YAML schema：保住 profile patch 里已有的
 * `!!js` 表达式（值为 {__jsExpr} 占位，dump 时还原），否则整份文件解析失败就没法改。
 */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (d) => typeof d === 'string',
  construct: (d) => ({ __jsExpr: d }),
  predicate: (v) => v instanceof Object && '__jsExpr' in v,
  represent: (v) => v.__jsExpr,
})
const PATCH_SCHEMA = yaml.JSON_SCHEMA.extend(JsExpr)

/** 同一进程内的写串行（config-editor / settings / plugin-manager 都写同一文件）。 */
let writeChain = Promise.resolve()
function serialWrite(fn) {
  const run = writeChain.then(fn, fn)
  writeChain = run.catch(() => {})
  return run
}

function patchPathOf(ctx) {
  const pc = (typeof ctx.get === 'function' ? ctx.get('profileContext') : null) || ctx.profileContext
  if (!pc || typeof pc.patchPath !== 'string' || !pc.patchPath) {
    throw Object.assign(new Error('当前不是 profile 启动，读不到 cordis.patch.yml；MCP 管理不可用'), { statusCode: 400 })
  }
  return pc.patchPath
}

function hmrOf(ctx) {
  const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : null
  if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') return null
  return hmr
}

/** 读 patch 文件；不存在时按空数组处理（与 DSH 的 loadOptionalPatches 一致）。 */
async function readPatchText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (e) {
    if (e && e.code === 'ENOENT') return '[]\n'
    throw e
  }
}

/** 解析成 patch 数组；解析失败直接抛（绝不覆盖用户文件）。 */
function parsePatchList(text) {
  const parsed = yaml.load(text, { schema: PATCH_SCHEMA })
  if (parsed === null || parsed === undefined) return []
  if (!Array.isArray(parsed)) throw new Error('cordis.patch.yml 顶层不是数组，拒绝写入')
  return parsed
}

/** 把文件拆成「托管块之前 / 托管块 / 托管块之后」三段。 */
function splitManagedBlock(text) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start < 0 || end < 0 || end < start) return { head: text, block: null, tail: '' }
  return {
    head: text.slice(0, start),
    block: text.slice(start, end + END.length),
    tail: text.slice(end + END.length),
  }
}

/** 从托管块里取服务器定义（只认本模块的行）。 */
function serversFromBlock(patchList) {
  const servers = []
  for (const patch of patchList) {
    const rows = Array.isArray(patch && patch.insert) ? patch.insert : []
    for (const row of rows) {
      if (!row || row.name !== MCP_ROW_NAME) continue
      const cfg = row.config && typeof row.config === 'object' ? row.config : {}
      if (typeof cfg.serverName !== 'string') continue
      servers.push({
        serverName: cfg.serverName,
        transport: cfg.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        command: typeof cfg.command === 'string' ? cfg.command : '',
        args: Array.isArray(cfg.args) ? cfg.args.filter((x) => typeof x === 'string') : [],
        env: cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env) ? cfg.env : {},
        cwd: typeof cfg.cwd === 'string' ? cfg.cwd : '',
        url: typeof cfg.url === 'string' ? cfg.url : '',
        headers: cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers) ? cfg.headers : {},
        enabled: row.disabled !== true,
        failOnStartupError: cfg.failOnStartupError === true,
        toolCallTimeoutMs: Number.isFinite(cfg.toolCallTimeoutMs) ? cfg.toolCallTimeoutMs : DEFAULT_TOOL_TIMEOUT_MS,
      })
    }
  }
  return servers
}

/** 由服务器定义生成托管块文本（与读回逻辑严格对称）。 */
function renderBlock(servers) {
  if (servers.length === 0) return ''
  const rows = servers.map((s) => {
    const config = s.transport === 'streamable-http'
      ? {
          serverName: s.serverName,
          transport: 'streamable-http',
          url: s.url,
          headers: s.headers || {},
          failOnStartupError: !!s.failOnStartupError,
          toolCallTimeoutMs: s.toolCallTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
        }
      : {
          serverName: s.serverName,
          transport: 'stdio',
          command: s.command,
          args: s.args || [],
          env: s.env || {},
          ...(s.cwd ? { cwd: s.cwd } : {}),
          failOnStartupError: !!s.failOnStartupError,
          toolCallTimeoutMs: s.toolCallTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
        }
    const row = { id: ROW_ID_PREFIX + s.serverName, name: MCP_ROW_NAME, config }
    if (!s.enabled) row.disabled = true
    return row
  })
  const body = yaml.dump([{ insert: rows }], { schema: PATCH_SCHEMA, lineWidth: -1 }).trimEnd()
  return `${BEGIN}\n${body}\n${END}\n`
}

/** 校验整份服务器列表（写盘前；错误信息直接展示给用户）。 */
function validateServers(list, existingPatchList) {
  const bad = (msg) => { throw Object.assign(new Error(msg), { statusCode: 400 }) }
  if (!Array.isArray(list)) bad('servers 必须是数组')
  if (list.length > 64) bad('最多管理 64 台 MCP 服务器')
  const seen = new Set()
  const out = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') bad('服务器条目必须是对象')
    const serverName = typeof raw.serverName === 'string' ? raw.serverName.trim() : ''
    if (!SERVER_NAME_RE.test(serverName)) bad(`serverName 非法：「${serverName}」须匹配 ${SERVER_NAME_RE}`)
    if (seen.has(serverName)) bad(`serverName 重复：${serverName}`)
    seen.add(serverName)
    const transport = raw.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
    const common = {
      serverName,
      transport,
      enabled: raw.enabled !== false,
      failOnStartupError: raw.failOnStartupError === true,
      toolCallTimeoutMs: Number.isFinite(raw.toolCallTimeoutMs) && raw.toolCallTimeoutMs > 0
        ? Math.floor(raw.toolCallTimeoutMs)
        : DEFAULT_TOOL_TIMEOUT_MS,
    }
    if (transport === 'stdio') {
      const command = typeof raw.command === 'string' ? raw.command.trim() : ''
      if (!command) bad(`「${serverName}」是 stdio 传输，command 必填`)
      const args = Array.isArray(raw.args) ? raw.args.map((x) => String(x)) : []
      if (args.length > 64) bad(`「${serverName}」args 过多`)
      const env = {}
      const srcEnv = raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env) ? raw.env : {}
      for (const [k, v] of Object.entries(srcEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) bad(`「${serverName}」环境变量名非法：${k}`)
        env[k] = String(v)
      }
      out.push({ ...common, command, args, env, cwd: typeof raw.cwd === 'string' ? raw.cwd.trim() : '' })
    } else {
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (!/^https?:\/\//i.test(url)) bad(`「${serverName}」是 HTTP 传输，url 须以 http:// 或 https:// 开头`)
      const headers = {}
      const srcHeaders = raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers) ? raw.headers : {}
      for (const [k, v] of Object.entries(srcHeaders)) headers[String(k)] = String(v)
      out.push({ ...common, url, headers })
    }
  }
  // 与文件里**其它**区段（用户手写、非本托管块）的 serverName / id 冲突检查。
  const foreignServers = new Set()
  const foreignIds = new Set()
  for (const patch of existingPatchList) {
    if (!patch || typeof patch !== 'object') continue
    if (typeof patch.id === 'string') foreignIds.add(patch.id)
    const rows = Array.isArray(patch.insert) ? patch.insert : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      if (typeof row.id === 'string') foreignIds.add(row.id)
      if (row.name === MCP_ROW_NAME) {
        const n = row.config && row.config.serverName
        if (typeof n === 'string') foreignServers.add(n)
      }
    }
  }
  for (const s of out) {
    if (foreignServers.has(s.serverName)) {
      bad(`serverName「${s.serverName}」已被 cordis.patch.yml 里手写的 mcp-client 行占用，请换一个名字`)
    }
    if (foreignIds.has(ROW_ID_PREFIX + s.serverName)) {
      bad(`行 id「${ROW_ID_PREFIX}${s.serverName}」与该文件其它区段的 id 冲突，请换一个 serverName`)
    }
  }
  return out
}

/** 原子写：同目录临时文件 + rename（保留 0600，profile patch 原权限）。 */
async function writeTextAtomic(path, text) {
  const tmp = join(join(path, '..'), `.cordis.patch.yml.dsh-dock-${process.pid}-${Date.now()}.tmp`)
  await writeFile(tmp, text, { mode: 0o600 })
  try {
    await rename(tmp, path)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 清理失败忽略 */ }
    throw e
  }
}

/** 写托管块并热应用；失败回滚文件。返回 { changed, applied, restartRequired, warnings }。 */
async function applyServers(ctx, servers) {
  const path = patchPathOf(ctx)
  return serialWrite(async () => {
    const before = await readPatchText(path)
    const parsed = parsePatchList(before) // 不可解析就抛，绝不覆盖
    const { head, tail } = splitManagedBlock(before)
    const block = renderBlock(servers)
    const next = servers.length === 0
      ? `${head}${tail}`.replace(/\n{3,}$/, '\n')
      : `${head}${block}${tail}`
    if (next === before) return { changed: false, applied: true, warnings: [] }

    // 写后自检：解析必须仍然成功、托管块行数正确（防止把用户文件写坏）。
    const check = parsePatchList(next)
    const written = serversFromBlock(check)
    if (written.length !== servers.length) throw new Error('写后自检失败：托管块行数与请求不一致，未落盘')

    const hmr = hmrOf(ctx)
    if (!hmr) {
      await writeTextAtomic(path, next)
      return { changed: true, applied: false, restartRequired: true, warnings: ['当前 profile 未启用 HMR：已保存到 cordis.patch.yml，重启 DSH 后生效'] }
    }

    await writeTextAtomic(path, next)
    const ids = servers.map((s) => ROW_ID_PREFIX + s.serverName)
    try {
      await hmr.runExclusive(() => hmr.reconcileProfile(ids))
      return { changed: true, applied: true, warnings: [] }
    } catch (error) {
      // 回滚文件 + 再 reconcile 一次（HMR 自己不会回滚）
      let rolledBack = true
      try {
        await writeTextAtomic(path, before)
        await hmr.runExclusive(() => hmr.reconcileProfile([]))
      } catch {
        rolledBack = false
      }
      const err = new Error(`应用失败${rolledBack ? '，已回滚' : '，且回滚失败（请手动检查 cordis.patch.yml）'}：${(error && error.message) || error}`)
      err.statusCode = 400
      err.rolledBack = rolledBack
      err.needsRestart = !rolledBack
      throw err
    }
  })
}

/** 实时状态：Loader 行（disabled / fiber 状态）+ 已注册工具名。 */
function liveStatus(ctx, servers) {
  const status = new Map(servers.map((s) => [s.serverName, { state: 'unknown', error: null, tools: [] }]))
  let entries = []
  try {
    const loader = typeof ctx.get === 'function' ? ctx.get('loader') : null
    if (loader && typeof loader.entries === 'function') entries = Array.from(loader.entries())
  } catch { /* loader 不可用：保持 unknown */ }
  const byId = new Map()
  for (const entry of entries) {
    const opts = entry && entry.options ? entry.options : {}
    const id = typeof opts.id === 'string' ? opts.id : ''
    if (!id.startsWith(ROW_ID_PREFIX)) continue
    if (opts.name !== MCP_ROW_NAME) continue
    const cfg = opts.config && typeof opts.config === 'object' ? opts.config : {}
    const serverName = typeof cfg.serverName === 'string' ? cfg.serverName : ''
    if (!serverName) continue
    byId.set(id, { entry, serverName })
  }
  let toolNames = []
  try {
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : null
    if (tools && typeof tools.definitions === 'function') toolNames = tools.definitions().map((d) => d && d.name).filter(Boolean)
  } catch { /* tools 不可用 */ }
  for (const [id, { entry, serverName }] of byId) {
    const slot = status.get(serverName) || { state: 'unknown', error: null, tools: [] }
    let disabled = false
    try { disabled = entry.disabled === true } catch { disabled = false }
    let fiberState = ''
    try { fiberState = String((entry.fiber && entry.fiber.state) || '') } catch { fiberState = '' }
    const st = disabled ? 'disabled'
      : /fail/i.test(fiberState) ? 'failed'
      : /active|run/i.test(fiberState) ? 'active'
      : 'inactive'
    slot.state = st
    slot.error = (entry.fiber && entry.fiber.error && String(entry.fiber.error.message || entry.fiber.error)) || null
    slot.tools = toolNames.filter((n) => n.startsWith(`mcp__${serverName}__`))
    status.set(serverName, slot)
  }
  return status
}

function listPayload(ctx, patchText, patchList) {
  const { block } = splitManagedBlock(patchText)
  const servers = block ? serversFromBlock(parsePatchList(block)) : []
  const live = liveStatus(ctx, servers)
  const warnings = []
  const hmr = hmrOf(ctx)
  if (!hmr) warnings.push('当前 profile 未启用 HMR：修改会写入 cordis.patch.yml，但需要重启 DSH 才生效')
  return {
    ok: true,
    patchPath: (() => { try { return patchPathOf(ctx) } catch { return '' } })(),
    hmrAvailable: !!hmr,
    servers: servers.map((s) => {
      const st = live.get(s.serverName) || { state: 'unknown', error: null, tools: [] }
      return { ...s, state: st.state, error: st.error, tools: st.tools, toolCount: st.tools.length }
    }),
    warnings,
  }
}

/** 功能注册表条目：index.js 组装 FEATURES 时使用。 */
export const feature = {
  id: 'mcpconfig',
  name: 'MCP管理',
  description: '管理 DSH 使用的 MCP 服务器（增删改 / 启停 / 工具状态），写回 cordis.patch.yml 并热应用',
  defaultEnabled: false,
  setup(ctx) {
    const webServer = ctx.get('webServer')
    if (webServer === undefined) throw new Error('webServer 服务不可用，无法提供 MCP 管理路由')
    const handler = async (req, res) => {
      if (rejectUntrustedRequest(ctx, req, res)) return
      try {
        if (req.method === 'GET') {
          const path = patchPathOf(ctx)
          const text = await readPatchText(path)
          parsePatchList(text) // 不可解析时直接报错给面板，避免面板把文件写坏
          sendJson(res, 200, listPayload(ctx, text))
          return
        }
        if (req.method === 'POST') {
          const body = await readBody(req)
          if (!body || typeof body !== 'object') {
            sendJson(res, 400, { ok: false, error: '请求体不是 JSON 对象' })
            return
          }
          const action = body.action || 'save'
          if (action !== 'save') {
            sendJson(res, 400, { ok: false, error: `不支持的 action：${action}` })
            return
          }
          const path = patchPathOf(ctx)
          const before = await readPatchText(path)
          const parsedBefore = parsePatchList(before)
          const { head: outerHead, tail: outerTail } = splitManagedBlock(before)
          const outerList = parsePatchList(`${outerHead}${outerTail}`.trim() || '[]')
          const servers = validateServers(body.servers, outerList)
          const result = await applyServers(ctx, servers)
          sendJson(res, 200, { ok: true, ...result })
          return
        }
        sendJson(res, 405, { ok: false, error: `不支持的请求方法：${req.method}` })
      } catch (e) {
        const status = e && e.statusCode ? e.statusCode : 500
        sendJson(res, status, {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          ...(e && e.rolledBack !== undefined ? { rolledBack: e.rolledBack } : {}),
          ...(e && e.needsRestart ? { needsRestart: true } : {}),
        })
      }
    }
    return webServer.register({ kind: 'exact', path: '/dsh-dock/mcpconfig', handler })
  },
}
