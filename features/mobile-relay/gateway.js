// dsh-dock · 手机接力局域网安全网关
//
// DSH 0.1.1-rc.2 有意拒绝直接绑定 0.0.0.0：浏览器表层尚无登录认证，直接开放
// 会把代码执行能力交给同一网络里的任何人。本文件提供一个最小认证反向代理：主 DSH
// 继续只监听 127.0.0.1，手机凭 256-bit 一次性链接换取 HttpOnly 会话后才能访问。
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'

const COOKIE_NAME = 'dsh_mobile_session'
const CONNECT_PATH = '/__dsh_mobile/connect'
const HEALTH_PATH = '/__dsh_mobile/health'
const COMPAT_PATH = '/__dsh_mobile/compat.js'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const MAX_CONNECT_BODY = 4096
const MAX_HTML_BYTES = 2 * 1024 * 1024

// LAN HTTP is not a browser secure context. Some mobile browsers therefore expose
// crypto.getRandomValues() but omit crypto.randomUUID(), while the official DSH
// connection/workspace clients call randomUUID() directly. This tiny standards-compatible
// UUID v4 fallback is injected before every DSH bootstrap script through the proxy only.
const MOBILE_COMPAT_JS = `(()=>{const c=globalThis.crypto;if(!c||typeof c.randomUUID==='function'||typeof c.getRandomValues!=='function')return;const make=()=>{const b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};try{Object.defineProperty(c,'randomUUID',{value:make,configurable:true})}catch{try{c.randomUUID=make}catch{}}})()`

function secret() { return randomBytes(32).toString('base64url') }
function now() { return Date.now() }
function isPrivateIpv4(ip) {
  const p = String(ip).split('.').map(Number)
  return p.length === 4 && (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168))
}
function interfacePriority(name) {
  if (/^en0$/.test(name)) return 100
  if (/^en\d+$/.test(name)) return 90
  if (/^(eth|enp|wlan|wl)/.test(name)) return 80
  if (/^bridge/.test(name)) return 20
  if (/^(utun|tun|tap)/.test(name)) return 10
  return 50
}

/** 当前可用于手机连接的非回环 IPv4，私网地址优先。 */
export function lanAddresses() {
  const rows = []
  const table = networkInterfaces()
  for (const [name, list] of Object.entries(table)) {
    for (const item of list || []) {
      if (!item || item.internal || item.family !== 'IPv4') continue
      rows.push({ address: item.address, interface: name, private: isPrivateIpv4(item.address) })
    }
  }
  return rows.sort((a, b) => Number(b.private) - Number(a.private)
    || interfacePriority(b.interface) - interfacePriority(a.interface)
    || a.interface.localeCompare(b.interface))
}

function parseCookies(header) {
  const result = {}
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=')
    if (at <= 0) continue
    result[part.slice(0, at).trim()] = part.slice(at + 1).trim()
  }
  return result
}
function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(value))
}
function readSmallJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_CONNECT_BODY) { reject(new Error('请求过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('请求格式错误')) }
    })
    req.on('error', reject)
  })
}
function connectHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>连接 DSH</title><style>html{font-family:system-ui,-apple-system,sans-serif;color-scheme:dark light}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom);background:#111318;color:#f4f6fa}.card{box-sizing:border-box;width:min(420px,calc(100vw - 32px));padding:28px;border:1px solid #30343d;border-radius:18px;background:#1c1f26;box-shadow:0 18px 60px #0007;text-align:center}.icon{width:48px;height:48px;margin:0 auto 16px;display:grid;place-items:center;border-radius:15px;background:#38bdf822;color:#38bdf8}.icon svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#abb1bd;line-height:1.6;font-size:14px}.error{margin-top:16px;padding:10px 12px;border-radius:10px;background:#ef44441a;color:#ff8b8b;text-align:left}[hidden]{display:none}@media(prefers-color-scheme:light){body{background:#f1f4f8;color:#16181d}.card{background:#fff;border-color:#d8dde6}.card p{color:#586173}}</style></head><body><main class="card"><div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14"/></svg></div><h1>正在安全连接</h1><p id="status">验证一次性链接并进入 DSH…</p><div id="error" class="error" role="alert" hidden></div></main><script>(()=>{const status=document.getElementById('status'),error=document.getElementById('error'),token=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'',location.pathname);if(!token){status.textContent='连接链接不完整';error.hidden=false;error.textContent='请回到电脑端重新复制手机接力链接。';return}fetch(${JSON.stringify(CONNECT_PATH)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok||!d.ok)throw new Error(d.error||'连接验证失败');status.textContent='验证成功，正在打开任务…';location.replace('/#dsh-mobile-relay='+encodeURIComponent(d.launch))}).catch(e=>{status.textContent='无法连接';error.hidden=false;error.textContent=e&&e.message?e.message:String(e)})})()</script></body></html>`
}
function rewriteProxyHeaders(headers, upstreamAuthority) {
  const next = { ...headers, host: upstreamAuthority }
  delete next.cookie
  // HTML must stay uncompressed so the proxy can inject the early compatibility script.
  delete next['accept-encoding']
  if (next.origin) next.origin = 'http://' + upstreamAuthority
  return next
}
function injectMobileCompat(html) {
  if (html.includes('data-dsh-mobile-compat')) return html
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  const script = `<script data-dsh-mobile-compat src="${COMPAT_PATH}"></script>`
  if (!match) return script + html
  const at = match.index + match[0].length
  return html.slice(0, at) + script + html.slice(at)
}
function writeUpgradeHead(socket, response) {
  const lines = [`HTTP/1.1 ${response.statusCode || 101} ${response.statusMessage || 'Switching Protocols'}`]
  for (let i = 0; i < response.rawHeaders.length; i += 2) lines.push(response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1])
  socket.write(lines.join('\r\n') + '\r\n\r\n')
}

/**
 * 开启一个需要一次性链接认证的局域网代理。返回的 issue() 生成只在 fragment 中传输的令牌。
 */
export function startProtectedLanGateway({ port, upstreamHost = '127.0.0.1', upstreamPort }) {
  return new Promise((resolve, reject) => {
    const pending = new Map() // gateway token -> { pairId, launch, expiresAt }
    const sessions = new Map() // cookie secret -> { pairId, expiresAt, seenAt }
    const upgradedSockets = new Map() // client socket -> { sessionId, pairId, upstreamSocket }
    const authority = upstreamHost + ':' + upstreamPort

    function purge() {
      const stamp = now()
      for (const [key, value] of pending) if (value.expiresAt <= stamp) pending.delete(key)
      const expiredSessions = new Set()
      for (const [key, value] of sessions) {
        if (value.expiresAt <= stamp) { sessions.delete(key); expiredSessions.add(key) }
      }
      if (expiredSessions.size) {
        for (const [socket, value] of upgradedSockets) {
          if (expiredSessions.has(value.sessionId)) {
            if (value.upstreamSocket) value.upstreamSocket.destroy()
            socket.destroy()
          }
        }
      }
    }
    function authorize(req) {
      purge()
      const value = parseCookies(req.headers.cookie)[COOKIE_NAME]
      const session = value ? sessions.get(value) : null
      if (!session) return null
      session.seenAt = now()
      return { ...session, sessionId: value }
    }
    function proxyHttp(req, res) {
      const upstream = httpRequest({
        hostname: upstreamHost, port: upstreamPort, method: req.method, path: req.url,
        headers: rewriteProxyHeaders(req.headers, authority),
      }, (upstreamRes) => {
        const contentType = String(upstreamRes.headers['content-type'] || '').toLowerCase()
        if (!contentType.includes('text/html')) {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
          upstreamRes.pipe(res)
          return
        }
        const chunks = []
        let size = 0
        upstreamRes.on('data', (chunk) => {
          size += chunk.length
          if (size <= MAX_HTML_BYTES) chunks.push(chunk)
        })
        upstreamRes.on('end', () => {
          if (size > MAX_HTML_BYTES) {
            if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'DSH 页面过大，无法注入手机兼容层。' })
            return
          }
          const headers = { ...upstreamRes.headers }
          delete headers['content-length']
          delete headers['content-encoding']
          headers['cache-control'] = 'no-store'
          res.writeHead(upstreamRes.statusCode || 502, headers)
          res.end(injectMobileCompat(Buffer.concat(chunks).toString('utf8')))
        })
      })
      upstream.on('error', (error) => {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: 'DSH 主服务连接失败：' + error.message })
        else res.destroy(error)
      })
      req.pipe(upstream)
    }

    const server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://dsh-mobile.internal')
      if (url.pathname === HEALTH_PATH) return sendJson(res, 200, { ok: true })
      if (url.pathname === CONNECT_PATH && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        })
        return res.end(connectHtml())
      }
      if (url.pathname === CONNECT_PATH && req.method === 'POST') {
        try {
          const body = await readSmallJson(req)
          const token = String(body && body.token || '')
          const grant = pending.get(token)
          if (!grant || grant.expiresAt <= now()) return sendJson(res, 403, { ok: false, error: '一次性链接无效或已过期，请在电脑端重新开启。' })
          pending.delete(token)
          const sessionId = secret()
          sessions.set(sessionId, { pairId: grant.pairId, expiresAt: now() + SESSION_TTL_MS, seenAt: now() })
          return sendJson(res, 200, { ok: true, launch: grant.launch }, {
            'set-cookie': `${COOKIE_NAME}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`,
          })
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: error.message || String(error) })
        }
      }
      if (!authorize(req)) return sendJson(res, 401, { ok: false, error: '手机连接未认证或已过期，请使用电脑端生成的接力链接重新进入。' })
      if (url.pathname === COMPAT_PATH && req.method === 'GET') {
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        return res.end(MOBILE_COMPAT_JS)
      }
      return proxyHttp(req, res)
    })

    server.on('upgrade', (req, socket, head) => {
      const authorized = authorize(req)
      if (!authorized) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
      const connection = { sessionId: authorized.sessionId, pairId: authorized.pairId, upstreamSocket: null }
      upgradedSockets.set(socket, connection)
      const forgetSocket = () => upgradedSockets.delete(socket)
      socket.once('close', forgetSocket)
      const upstream = httpRequest({
        hostname: upstreamHost, port: upstreamPort, method: req.method, path: req.url,
        headers: rewriteProxyHeaders(req.headers, authority),
      })
      upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
        connection.upstreamSocket = upstreamSocket
        writeUpgradeHead(socket, response)
        if (head && head.length) upstreamSocket.write(head)
        if (upstreamHead && upstreamHead.length) socket.write(upstreamHead)
        socket.once('close', () => upstreamSocket.destroy())
        upstreamSocket.once('close', () => socket.destroy())
        socket.pipe(upstreamSocket).pipe(socket)
      })
      upstream.on('response', (response) => {
        socket.end(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`)
      })
      upstream.on('error', () => socket.destroy())
      upstream.end()
    })
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject)
      const listened = server.address()
      const listenedPort = listened && typeof listened === 'object' ? listened.port : port
      resolve({
        port: listenedPort,
        addresses: lanAddresses(),
        issue(pairId, launch, expiresAt) {
          const token = secret()
          pending.set(token, { pairId, launch, expiresAt })
          return token
        },
        revokePair(pairId) {
          for (const [key, value] of pending) if (value.pairId === pairId) pending.delete(key)
          for (const [key, value] of sessions) if (value.pairId === pairId) sessions.delete(key)
          for (const [socket, value] of upgradedSockets) {
            if (value.pairId !== pairId) continue
            if (value.upstreamSocket) value.upstreamSocket.destroy()
            socket.destroy()
          }
        },
        purge,
        close() {
          pending.clear(); sessions.clear()
          for (const [socket, value] of upgradedSockets) {
            if (value.upstreamSocket) value.upstreamSocket.destroy()
            socket.destroy()
          }
          upgradedSockets.clear()
          return new Promise((done) => server.close(() => done()))
        },
      })
    })
  })
}
