// dsh-dock · 功能模块【手机接力】· 宿主半部
//
// 不复制或迁移 DSH 会话：手机与电脑都连接同一个 DSH 宿主时，会话本来就是同一份。
// 本模块只负责短时配对、在线状态、实时任务摘要和接力备注，避免把任务状态再做成一套
// 容易分叉的副本。所有配对凭据均只存内存，宿主重启后自动失效。
import { randomBytes } from 'node:crypto'
import { readBody, sendJson } from '../../src/host-core.js'
import { lanAddresses, startProtectedLanGateway } from './gateway.js'

const PAIR_TTL_MS = 10 * 60 * 1000
const PRESENCE_TTL_MS = 45 * 1000
const NOTE_MAX_LENGTH = 1200
const MAX_JOIN_ATTEMPTS = 8
const DEFAULT_GATEWAY_PORT = 3081

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
  return url.pathname.replace(/^\/dsh-dock\/mobile-relay\/?/, '').split('/')[0] || ''
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
      void stopGateway()
    }
  },
}
