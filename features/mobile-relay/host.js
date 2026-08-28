// dsh-dock · 功能模块【手机接力】· 宿主半部
//
// 不复制或迁移 DSH 会话：手机与电脑都连接同一个 DSH 宿主时，会话本来就是同一份。
// 本模块只负责短时配对、在线状态、实时任务摘要和接力备注，避免把任务状态再做成一套
// 容易分叉的副本。所有配对凭据均只存内存，宿主重启后自动失效。
//
// 局域网电脑直连（0.0.0.0）：
//   DSH 的 CLI 出于安全拒绝 `--host 0.0.0.0`（浏览器表层无登录认证，直开等于把代码执行
//   能力交给同网任何人），但 webServer 行本身支持 0.0.0.0 绑定，且绑定后 DSH 会自动
//   派生局域网信任、把目录选择器切成浏览器浏览模式——即「以 0.0.0.0 启动」的完整效果。
//   本模块用一条补丁覆盖 webServer 行的 host，另起一个同资料（同 ~/.dsh、同会话与工作区）
//   的 dsh web 实例绑到 0.0.0.0 指定端口；主实例继续只监听 127.0.0.1。
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, closeSync, writeFileSync } from 'node:fs'
import { createServer, request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readBody, sendJson } from '../../src/host-core.js'
import { lanAddresses, startProtectedLanGateway } from './gateway.js'

const PAIR_TTL_MS = 10 * 60 * 1000
const PRESENCE_TTL_MS = 45 * 1000
const NOTE_MAX_LENGTH = 1200
const MAX_JOIN_ATTEMPTS = 8
const DEFAULT_GATEWAY_PORT = 3081
const DEFAULT_LAN_DIRECT_PORT = 3082
const LAN_DIR_NAME = 'dsh-dock-lan'
const LAN_READY_TIMEOUT_MS = 25 * 1000
const LAN_STOP_GRACE_MS = 4 * 1000

/** 当前进程是否是「局域网直连」子实例（由本模块 spawn 时注入的环境标记）。 */
function isLanChildInstance() {
  return process.env.DSH_DOCK_LAN_CHILD === '1'
}
function lanDir() { return join(homedir(), '.dsh', LAN_DIR_NAME) }
function lanPatchPath(port) { return join(lanDir(), `lan-${port}.patch.yml`) }
function lanLogPath(port) { return join(lanDir(), `lan-${port}.log`) }
function lanPatchContent(port) {
  return `# dsh-dock · 手机接力「局域网电脑直连（0.0.0.0）」生成补丁 —— 勿手改
# 覆盖 webServer 行的绑定主机：效果等同 \`dsh web --host 0.0.0.0\`（CLI 出于安全拒绝该旗标）。
# 绑定 0.0.0.0 后 DSH 自动派生局域网信任，并把目录选择器切换为浏览器浏览模式。
- id: webserver
  config:
    host: '0.0.0.0'
    port: ${port}
`
}
/** 定位 dsh CLI 入口：优先使用启动本进程的入口，退回按包解析。 */
function dshEntry() {
  const argv1 = process.argv && process.argv[1]
  if (argv1 && existsSync(argv1)) return argv1
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  }
}
/** 预检端口：能在 0.0.0.0 上绑定才算空闲（EADDRINUSE 抛 400）。 */
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        const err = new Error(`端口 ${port} 已被占用，请换一个端口`)
        err.statusCode = 400
        reject(err)
      } else {
        const err = new Error('端口预检失败：' + ((error && error.message) || String(error)))
        err.statusCode = 400
        reject(err)
      }
    })
    probe.listen(port, '0.0.0.0', () => probe.close(() => resolve()))
  })
}

// LAN HTTP 不是浏览器安全上下文：部分浏览器在 http://<局域网IP> 下只暴露
// crypto.getRandomValues() 而省略 crypto.randomUUID()，而 DSH 的 connection /
// conversation 客户端直接调用 randomUUID() 生成消息 ID 与 RPC ID——缺失时整个
// 客户端引导失败（会话列表、工作区等全部不可用）。下面这段与手机接力网关同款、
// 标准兼容的 UUID v4 兜底，在直连子实例的 index.html <head> 里内联注入，先于
// 任何 DSH 引导脚本执行；本机回环（127.0.0.1 是安全上下文）下 randomUUID 已存在，
// 脚本自我短路，零副作用。
const LAN_COMPAT_JS = "(()=>{const c=globalThis.crypto;if(!c||typeof c.randomUUID==='function'||typeof c.getRandomValues!=='function')return;const make=()=>{const b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};try{Object.defineProperty(c,'randomUUID',{value:make,configurable:true})}catch{try{c.randomUUID=make}catch{}}})()"
const LAN_COMPAT_MARKER = 'data-dsh-lan-compat'
/** 把兼容脚本内联注入 index.html 的 <head> 之后（幂等）。 */
function injectLanCompat(html) {
  if (html.includes(LAN_COMPAT_MARKER)) return html
  const script = `<script ${LAN_COMPAT_MARKER}>${LAN_COMPAT_JS}</script>`
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  if (!match) return script + html
  const at = match.index + match[0].length
  return html.slice(0, at) + script + html.slice(at)
}
/** 轮询子实例直到 HTTP 可响应；子进程提前退出时带上日志尾部报错。 */
function waitForLanReady(port, child, logPath) {
  const deadline = Date.now() + LAN_READY_TIMEOUT_MS
  const logTail = () => {
    try {
      const text = readFileSync(logPath, 'utf8')
      return text.slice(-2000).trim()
    } catch { return '' }
  }
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (child.exitCode !== null) {
        const err = new Error('局域网直连实例启动失败（进程已退出）：\n' + (logTail() || '无日志输出'))
        err.statusCode = 500
        reject(err)
        return
      }
      const probe = httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 }, (res) => {
        res.resume()
        resolve()
      })
      probe.on('error', () => {
        if (Date.now() > deadline) {
          const err = new Error('局域网直连实例启动超时：\n' + (logTail() || '无日志输出'))
          err.statusCode = 500
          reject(err)
        } else {
          setTimeout(attempt, 300)
        }
      })
      probe.on('timeout', () => probe.destroy())
      probe.end()
    }
    attempt()
  })
}

function now() { return Date.now() }
function cleanText(value, max) { return String(value || '').replace(/\u0000/g, '').trim().slice(0, max) }
function publicId() { return randomBytes(9).toString('base64url') }
function joinCode() { return randomBytes(5).toString('hex').toUpperCase() }
function phaseOf(event) {
  if (event && event.type === 'assistant/chunk') {
    const type = event.data && event.data.chunk && event.data.chunk.type
    if (type === 'reasoning-delta') return 'think'
    if (type === 'text-delta') return 'write'
  }
  if (event && event.type === 'tool/call') {
    const name = String(event.data && event.data.name || '').toLowerCase()
    return /web|search|fetch|grep|glob|find|read|ls$|^ls|tree|locate/.test(name) ? 'search' : 'code'
  }
  return ''
}
function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((x) => x && x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text).join(' ').replace(/\s+/g, ' ').trim()
}
function routeMethod(req) {
  const url = new URL(req.url || '/', 'http://dsh.internal')
  return url.pathname.replace(/^\/dsh-dock\/mobile-relay\/?/, '').replace(/\/+$/, '')
}

export const feature = {
  id: 'mobile-relay',
  name: '手机接力',
  description: '安全反向代理与扫码接力，同步当前任务状态和备注',
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    const pairs = new Map()
    const tasks = new Map()
    const joinAttempts = new Map()
    let gateway = null
    let gatewayStarting = null
    // ── 局域网电脑直连（0.0.0.0）状态 ──
    let lanChild = null
    let lanPort = 0
    let lanStartedAt = 0
    let lanStopping = false

    // 直连子实例自身（环境标记存在时）监视主进程：主进程退出后子实例随之退出，避免孤儿进程。
    if (isLanChildInstance()) {
      const parentPid = Number(process.env.DSH_DOCK_LAN_PARENT_PID || 0)
      if (parentPid && parentPid !== process.pid) {
        const watcher = setInterval(() => {
          if (process.ppid !== parentPid) {
            clearInterval(watcher)
            console.log('[dsh-dock] 主实例已退出，局域网直连实例随之退出')
            process.exit(0)
          }
        }, 5000)
        disposers.push(() => clearInterval(watcher))
      }
    }

    function lanStatus() {
      const alive = Boolean(lanChild && lanChild.exitCode === null)
      return {
        active: alive,
        port: lanPort,
        pid: alive && lanChild.pid ? lanChild.pid : null,
        startedAt: lanStartedAt,
        addresses: lanAddresses(),
        defaultPort: DEFAULT_LAN_DIRECT_PORT,
        child: isLanChildInstance(),
        logPath: lanPort ? lanLogPath(lanPort) : '',
      }
    }

    async function stopLanDirect() {
      const child = lanChild
      if (!child || lanStopping) return { active: false, pid: child ? child.pid : null }
      lanStopping = true
      lanChild = null
      lanPort = 0
      lanStartedAt = 0
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      const killer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, LAN_STOP_GRACE_MS)
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, LAN_STOP_GRACE_MS + 1500))])
      clearTimeout(killer)
      lanStopping = false
      return { active: false, pid: child.pid }
    }

    async function startLanDirect(webServer, requestedPort) {
      if (isLanChildInstance()) {
        const error = new Error('当前已是局域网直连实例，无需（也不能）再开启一层直连')
        error.statusCode = 400
        throw error
      }
      const port = Number(requestedPort === undefined ? DEFAULT_LAN_DIRECT_PORT : requestedPort)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        const error = new Error('局域网端口需为 1024 到 65535 之间的整数')
        error.statusCode = 400
        throw error
      }
      if (port === webServer.port) {
        const error = new Error(`直连端口不能与 DSH 主服务端口 ${webServer.port} 相同`)
        error.statusCode = 400
        throw error
      }
      if (gateway && gateway.port === port) {
        const error = new Error(`端口 ${port} 正在被手机接力网关使用，请换一个端口`)
        error.statusCode = 409
        throw error
      }
      if (lanChild && lanChild.exitCode === null) {
        const error = new Error(`局域网直连已在 ${lanPort} 端口运行，请先关闭当前直连`)
        error.statusCode = 409
        throw error
      }
      await assertPortFree(port)

      mkdirSync(lanDir(), { recursive: true })
      const patchPath = lanPatchPath(port)
      const logPath = lanLogPath(port)
      try { writeFileSync(patchPath, lanPatchContent(port), 'utf8') } catch (error) {
        const err = new Error('无法写入直连补丁：' + ((error && error.message) || String(error)))
        err.statusCode = 500
        throw err
      }

      const entry = dshEntry()
      const args = ['--profile', 'web', '--patch', patchPath, '--port', String(port), '--no-open']
      let logFd
      try {
        logFd = openSync(logPath, 'a')
      } catch { logFd = 1 }
      let child
      try {
        child = spawn(process.execPath, [entry, ...args], {
          env: {
            ...process.env,
            DSH_DOCK_LAN_CHILD: '1',
            DSH_DOCK_LAN_PARENT_PID: String(process.pid),
          },
          stdio: ['ignore', logFd, logFd],
          cwd: process.cwd(),
        })
      } catch (error) {
        const err = new Error('无法启动局域网直连实例：' + ((error && error.message) || String(error)))
        err.statusCode = 500
        throw err
      }
      lanChild = child
      lanPort = port
      lanStartedAt = now()
      child.once('exit', () => {
        if (logFd !== 1) { try { closeSync(logFd) } catch { /* ignore */ } }
        if (lanChild === child) {
          lanChild = null
          lanPort = 0
          lanStartedAt = 0
        }
      })

      try {
        await waitForLanReady(port, child, logPath)
      } catch (error) {
        if (lanChild === child) {
          lanChild = null
          lanPort = 0
          lanStartedAt = 0
        }
        if (child.exitCode === null) child.kill('SIGTERM')
        throw error
      }
      return { ...lanStatus(), pid: child.pid }
    }

    async function stopGateway() {
      const current = gateway
      gateway = null
      gatewayStarting = null
      if (current) await current.close()
    }

    async function ensureGateway(webServer, requestedPort) {
      const port = Number(requestedPort === undefined ? DEFAULT_GATEWAY_PORT : requestedPort)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        const error = new Error('局域网端口需为 1024 到 65535 之间的整数')
        error.statusCode = 400
        throw error
      }
      if (port === webServer.port) {
        const error = new Error(`局域网端口不能与 DSH 主服务端口 ${webServer.port} 相同`)
        error.statusCode = 400
        throw error
      }
      if (gateway && gateway.port === port) return gateway
      if (gateway) {
        const error = new Error(`局域网网关已在 ${gateway.port} 端口运行，请先关闭当前手机连接`)
        error.statusCode = 409
        throw error
      }
      if (!gatewayStarting) {
        gatewayStarting = startProtectedLanGateway({ port, upstreamHost: '127.0.0.1', upstreamPort: webServer.port })
          .then((started) => { gateway = started; gatewayStarting = null; return started })
          .catch((error) => { gatewayStarting = null; throw error })
      }
      try { return await gatewayStarting }
      catch (cause) {
        const error = new Error(cause && cause.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用，请换一个端口`
          : '无法开启局域网网关：' + ((cause && cause.message) || String(cause)))
        error.statusCode = 400
        throw error
      }
    }

    function purge() {
      const stamp = now()
      for (const [id, pair] of pairs) {
        for (const [deviceId, device] of pair.devices) {
          if (stamp - device.seenAt > PRESENCE_TTL_MS) pair.devices.delete(deviceId)
        }
        if (pair.joinExpiresAt <= stamp && pair.devices.size === 0) {
          pairs.delete(id)
          if (gateway) gateway.revokePair(id)
        }
      }
      for (const [key, stampAt] of joinAttempts) if (stamp - stampAt.firstAt > PAIR_TTL_MS) joinAttempts.delete(key)
      if (gateway) gateway.purge()
      if (gateway && pairs.size === 0) void stopGateway()
    }
    const purgeTimer = setInterval(purge, 15 * 1000)
    disposers.push(() => clearInterval(purgeTimer))

    function taskSnapshot() {
      const stamp = now()
      return [...tasks.values()].filter((task) => task.running).map((task) => ({
        sessionId: task.sessionId,
        title: task.title || task.firstPrompt || '(等待任务标题)',
        phase: task.phase || 'think',
        startedAt: task.startedAt,
        elapsed: stamp - task.startedAt,
        lastActivityAt: task.lastActivityAt,
      })).sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    }
    function visiblePair(pair) {
      const devices = [...pair.devices.values()].map((device) => ({
        id: device.id,
        role: device.role,
        label: device.label,
        seenAt: device.seenAt,
      })).sort((a, b) => b.seenAt - a.seenAt)
      return {
        id: pair.id,
        expiresAt: pair.joinExpiresAt,
        note: pair.note,
        noteAt: pair.noteAt,
        noteFrom: pair.noteFrom,
        devices,
        tasks: taskSnapshot(),
        now: now(),
      }
    }
    function requirePair(payload) {
      const pairId = cleanText(payload && payload.pairId, 48)
      const deviceId = cleanText(payload && payload.deviceId, 80)
      const secret = cleanText(payload && payload.secret, 160)
      const pair = pairs.get(pairId)
      if (!pair) {
        const error = new Error('配对不存在，请在电脑端重新开启连接')
        error.statusCode = 410
        throw error
      }
      const device = pair.devices.get(deviceId)
      if (!device || device.secret !== secret) {
        const error = new Error('此设备未完成配对，请重新打开手机接力链接')
        error.statusCode = 403
        throw error
      }
      device.seenAt = now()
      return { pair, device }
    }
    function joinRateKey(req) {
      return (req.socket && req.socket.remoteAddress) || 'unknown'
    }
    function recordFailedJoin(req) {
      const key = joinRateKey(req)
      const item = joinAttempts.get(key) || { count: 0, firstAt: now() }
      if (now() - item.firstAt > PAIR_TTL_MS) { item.count = 0; item.firstAt = now() }
      item.count++
      joinAttempts.set(key, item)
      return item.count
    }
    function canJoin(req) {
      const item = joinAttempts.get(joinRateKey(req))
      return !item || now() - item.firstAt > PAIR_TTL_MS || item.count < MAX_JOIN_ATTEMPTS
    }

    // 任务状态只取最小必要字段。真正的会话内容仍由 DSH 的既有会话服务管理，
    // 这样手机继续输入后不会和电脑产生两个任务副本。
    disposers.push(ctx.inject(['sessionQuery'], (sqCtx) => {
      const sessionQuery = sqCtx.sessionQuery
      const titleFor = async (task) => {
        try {
          const snapshot = sessionQuery && typeof sessionQuery.readTitle === 'function'
            ? await sessionQuery.readTitle(task.sessionId) : null
          if (snapshot && snapshot.title && tasks.get(task.sessionId) === task) task.title = snapshot.title
        } catch { /* 标题缺失时以首条输入兜底 */ }
      }
      disposers.push(sqCtx.on('agent/status', (payload) => {
        const agent = payload && payload.agent
        const sid = agent && agent.id ? String(agent.id) : ''
        if (!sid) return
        if (payload.status === 'running') {
          let task = tasks.get(sid)
          if (!task) {
            task = { sessionId: sid, title: '', firstPrompt: '', phase: 'think', startedAt: now(), lastActivityAt: now(), running: true }
            tasks.set(sid, task)
            titleFor(task)
          }
          task.running = true
          task.lastActivityAt = now()
        } else if (payload.status === 'idle') {
          const task = tasks.get(sid)
          if (task) { task.running = false; task.lastActivityAt = now() }
        }
      }))
      disposers.push(sqCtx.on('agent/disposed', (payload) => {
        const sid = payload && payload.agent && payload.agent.id ? String(payload.agent.id) : ''
        const task = tasks.get(sid)
        if (task) { task.running = false; task.lastActivityAt = now() }
      }))
      disposers.push(sqCtx.on('session/event', (session, event) => {
        const sid = typeof session === 'object' && session ? String(session.id || '') : String(session || '')
        const task = tasks.get(sid)
        if (!task) return
        const phase = phaseOf(event)
        if (phase) task.phase = phase
        if (!task.firstPrompt && event && event.type === 'user/message') {
          const text = extractText(event.data && event.data.content)
          if (text) task.firstPrompt = text.slice(0, 120)
        }
        task.lastActivityAt = (event && event.time) || now()
      }))
    }))

    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      // 直连子实例（0.0.0.0）：向 index.html 注入 crypto.randomUUID 兜底，修复
      // 非安全上下文下 DSH 客户端引导失败。仅子实例注册，主实例（回环）不受影响。
      if (isLanChildInstance() && typeof wsCtx.webServer.tapIndex === 'function') {
        disposers.push(wsCtx.effect(() => wsCtx.webServer.tapIndex(injectLanCompat)))
      }
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/mobile-relay',
        async handler(req, res) {
          try {
            const method = routeMethod(req)
            const payload = await readBody(req)
            purge()
            if (method === 'network') {
              return sendJson(res, 200, { ok: true, data: {
                addresses: lanAddresses(),
                defaultPort: DEFAULT_GATEWAY_PORT,
                main: { host: wsCtx.webServer.host, port: wsCtx.webServer.port },
                gateway: gateway ? { active: true, port: gateway.port, addresses: gateway.addresses } : { active: false },
              } })
            }
            if (method === 'lan') {
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(), main: { host: wsCtx.webServer.host, port: wsCtx.webServer.port } } })
            }
            if (method === 'lan/start') {
              const data = await startLanDirect(wsCtx.webServer, payload && payload.port)
              return sendJson(res, 200, { ok: true, data: { ...data, main: { host: wsCtx.webServer.host, port: wsCtx.webServer.port } } })
            }
            if (method === 'lan/stop') {
              const data = await stopLanDirect()
              return sendJson(res, 200, { ok: true, data })
            }
            if (method === 'start') {
              const activeGateway = await ensureGateway(wsCtx.webServer, payload && payload.port)
              const id = publicId()
              const code = joinCode()
              const desktopId = cleanText(payload && payload.deviceId, 80) || publicId()
              const desktopSecret = publicId() + publicId()
              const pair = {
                id, code, joinExpiresAt: now() + PAIR_TTL_MS, note: '', noteAt: 0, noteFrom: '', devices: new Map(),
              }
              pair.devices.set(desktopId, { id: desktopId, secret: desktopSecret, role: 'desktop', label: '电脑端', seenAt: now() })
              pairs.set(id, pair)
              const gatewayToken = activeGateway.issue(id, `${id}.${code}`, pair.joinExpiresAt)
              return sendJson(res, 200, { ok: true, data: {
                pairId: id, code, secret: desktopSecret, expiresAt: pair.joinExpiresAt, gatewayToken,
                gateway: { active: true, port: activeGateway.port, addresses: activeGateway.addresses },
                pair: visiblePair(pair),
              } })
            }
            if (method === 'join') {
              if (!canJoin(req)) {
                const error = new Error('尝试次数过多，请稍后重试或在电脑端重新生成链接')
                error.statusCode = 429
                throw error
              }
              const pairId = cleanText(payload && payload.pairId, 48)
              const code = cleanText(payload && payload.code, 32).toUpperCase()
              const pair = pairs.get(pairId)
              if (!pair || pair.joinExpiresAt <= now() || code !== pair.code) {
                recordFailedJoin(req)
                const error = new Error('连接码无效或已过期，请回到电脑端重新开启')
                error.statusCode = 403
                throw error
              }
              const deviceId = cleanText(payload && payload.deviceId, 80) || publicId()
              const secret = publicId() + publicId()
              pair.devices.set(deviceId, { id: deviceId, secret, role: 'mobile', label: cleanText(payload && payload.label, 32) || '手机端', seenAt: now() })
              return sendJson(res, 200, { ok: true, data: { pairId, secret, expiresAt: pair.joinExpiresAt, pair: visiblePair(pair) } })
            }
            if (method === 'status') {
              const { pair } = requirePair(payload)
              return sendJson(res, 200, { ok: true, data: { pair: visiblePair(pair) } })
            }
            if (method === 'note') {
              const { pair, device } = requirePair(payload)
              const note = cleanText(payload && payload.note, NOTE_MAX_LENGTH)
              if (!note) {
                const error = new Error('请先写下接力内容')
                error.statusCode = 400
                throw error
              }
              pair.note = note
              pair.noteAt = now()
              pair.noteFrom = device.role === 'mobile' ? '手机端' : '电脑端'
              return sendJson(res, 200, { ok: true, data: { pair: visiblePair(pair) } })
            }
            if (method === 'end') {
              const { pair } = requirePair(payload)
              pairs.delete(pair.id)
              if (gateway) gateway.revokePair(pair.id)
              const shouldStopGateway = pairs.size === 0
              sendJson(res, 200, { ok: true, data: { ended: true } })
              // 手机端的关闭请求本身也经过网关。先完成响应，再异步停止监听，
              // 避免 server.close() 等待当前请求、当前请求又等待 close() 的死锁。
              if (shouldStopGateway) setTimeout(() => { void stopGateway() }, 50)
              return
            }
            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (error) {
            const status = error && error.statusCode ? error.statusCode : 500
            if (status >= 500) console.error('[dsh-dock] mobile relay HTTP error:', error && error.message)
            return sendJson(res, status, { ok: false, error: { code: status >= 500 ? 'internal' : 'bad-request', message: (error && error.message) || String(error) } })
          }
        },
      }), 'dsh-dock mobile relay: /dsh-dock/mobile-relay HTTP route')
    }))

    return () => {
      while (disposers.length) {
        const dispose = disposers.pop()
        try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
      }
      pairs.clear()
      tasks.clear()
      void stopLanDirect()
      void stopGateway()
    }
  },
}
