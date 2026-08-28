// dsh-dock · 远程访问安全网关
//
// 主 DSH 实例只监听 127.0.0.1（结构上不存在无登录的远程路径）；局域网/虚拟网设备
// 统一经本网关访问：未登录一律跳转登录页（账号 + 密码），登录成功发放 HttpOnly
// 会话 Cookie（7 天滑动过期），支持退出登录；登录失败按来源 IP 限速。上游即 DSH
// 主实例：绑定回环时把 Host/Origin 改写为回环（回环恒被信任），已绑 0.0.0.0 时
// 透传以走局域网信任派生。HTML 响应注入远程标记（window.__DSH_REMOTE__，供面板
// 显示退出按钮）与 crypto.randomUUID 兜底脚本引用。
import { createServer, request as httpRequest } from 'node:http'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'

const COOKIE_NAME = 'dsh_remote_session'
const LOGIN_PATH = '/__dsh_auth/login'
const LOGOUT_PATH = '/__dsh_auth/logout'
const HEALTH_PATH = '/__dsh_auth/health'
const COMPAT_PATH = '/__dsh_mobile/compat.js'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const MAX_LOGIN_BODY = 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024
const LOGIN_WINDOW_MS = 10 * 60 * 1000
const MAX_LOGIN_ATTEMPTS = 10

// LAN HTTP is not a browser secure context. Some browsers therefore expose
// crypto.getRandomValues() but omit crypto.randomUUID(), while the official DSH
// connection/workspace clients call randomUUID() directly. ES5, precondition-free
// fallback: defines randomUUID (and a getRandomValues last resort) as both an own
// property and on Crypto.prototype. Injected before every DSH bootstrap script.
const MOBILE_COMPAT_JS = `(function(){var g=typeof globalThis!=='undefined'?globalThis:(typeof window!=='undefined'?window:(typeof self!=='undefined'?self:undefined));if(!g)return;if(!g.crypto){try{g.crypto={}}catch(e){return}}var c=g.crypto;var nativeRng=typeof c.getRandomValues==='function'?c.getRandomValues.bind(c):null;function rng(bytes){if(nativeRng){nativeRng(bytes);return bytes}for(var i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256)&255;return bytes}function uuid(){var b=rng(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('')}function fill(array){rng(array);return array}function define(obj,name,value){if(!obj||typeof obj[name]==='function')return;try{Object.defineProperty(obj,name,{value:value,configurable:true})}catch(e){try{obj[name]=value}catch(e2){}}}define(c,'randomUUID',uuid);if(!nativeRng)define(c,'getRandomValues',fill);define(g.Crypto&&g.Crypto.prototype||null,'randomUUID',uuid);if(!nativeRng)define(g.Crypto&&g.Crypto.prototype||null,'getRandomValues',fill);if(typeof c.randomUUID!=='function'){var fresh={getRandomValues:fill,randomUUID:uuid};if(c.subtle)fresh.subtle=c.subtle;var keyOrigin=Object.create(null);for(var k in c){try{keyOrigin[k]=c[k]}catch(e3){}}for(var k2 in keyOrigin){if(typeof fresh[k2]==='undefined')fresh[k2]=keyOrigin[k2]}try{Object.defineProperty(g,'crypto',{value:fresh,configurable:true})}catch(e4){try{g.crypto=fresh}catch(e5){}}}})()`

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
      if (size > MAX_LOGIN_BODY) { reject(new Error('请求过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(new Error('请求格式错误')) }
    })
    req.on('error', reject)
  })
}
// 登录/退出页面：纯静态 HTML + CSS（表单原生 POST，无内联脚本）。
// 登录失败的错误态是另一个静态页面（?e=1 由服务端 303 带出）。
const PAGE_STYLE = `*{box-sizing:border-box}html{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;color-scheme:dark light;height:100%}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;background:radial-gradient(1200px 600px at 20% -10%,#1d4ed81f,transparent),radial-gradient(900px 500px at 110% 110%,#0ea5e921,transparent),#0f1115;color:#eef2f8}@media(prefers-color-scheme:light){body{background:radial-gradient(1200px 600px at 20% -10%,#3b82f614,transparent),radial-gradient(900px 500px at 110% 110%,#0ea5e918,transparent),#eef1f6;color:#16181d}}.card{width:min(400px,calc(100vw - 32px));padding:32px 28px;border:1px solid #ffffff14;border-radius:18px;background:#161a22e6;box-shadow:0 24px 80px #00000059;backdrop-filter:blur(10px)}@media(prefers-color-scheme:light){.card{background:#ffffffd9;border-color:#00000014;box-shadow:0 24px 70px #94a3b840}}.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.brand .icon{width:44px;height:44px;flex:none;display:grid;place-items:center;border-radius:13px;background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff;box-shadow:0 8px 24px #38bdf840}.brand .icon svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.brand h1{margin:0;font-size:18px;letter-spacing:.01em}.brand small{display:block;margin-top:2px;color:#8b93a3;font-size:12px;font-weight:400}label{display:block;margin-bottom:14px;font-size:13px;font-weight:600;color:#aab2c0}@media(prefers-color-scheme:light){label{color:#586173}}input{width:100%;margin-top:6px;padding:11px 13px;border:1px solid #ffffff1f;border-radius:11px;background:#0d1016;color:inherit;font:inherit;font-size:15px;outline:none;transition:border-color .15s,box-shadow .15s}@media(prefers-color-scheme:light){input{background:#f4f6fa;border-color:#0000001a}}input:focus{border-color:#38bdf8;box-shadow:0 0 0 3px #38bdf82e}button{width:100%;margin-top:6px;padding:12px;border:0;border-radius:11px;background:linear-gradient(135deg,#38bdf8,#6366f1);color:#fff;font:inherit;font-size:15px;font-weight:700;cursor:pointer;transition:filter .15s,transform .1s}button:hover{filter:brightness(1.07)}button:active{transform:scale(.99)}.error{margin:-4px 0 12px;padding:9px 12px;border-radius:10px;background:#ef44441f;color:#ff9d9d;font-size:13px;line-height:1.5}@media(prefers-color-scheme:light){.error{color:#c23434}}.noerror{display:none}.hint{margin:16px 0 0;color:#8b93a3;font-size:12px;line-height:1.6;text-align:center}.done{text-align:center}.done .ok{width:52px;height:52px;margin:4px auto 14px;display:grid;place-items:center;border-radius:50%;background:#22c55e26;color:#4ade80}.done .ok svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}.done p{margin:0 0 18px;color:#8b93a3;font-size:13px}`
const PAGE_ICON = `<span class="icon"><svg viewBox="0 0 24 24"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.14-1.14"/></svg></span>`

function loginPageHtml(withError) {
  const errorRow = withError
    ? `<div class="error" role="alert">账号或密码不正确，请重试。</div>`
    : `<div class="noerror"></div>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>DSH 远程访问</title><style>${PAGE_STYLE}</style></head><body><main class="card"><form method="POST" action="/__dsh_auth/login"><div class="brand">${PAGE_ICON}<div><h1>DSH 远程访问</h1><small>登录后可使用完整功能</small></div></div>${errorRow}<label>账号<input name="username" autocomplete="username" autofocus required></label><label>密码<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">登 录</button><p class="hint">仅限授权设备登录 · 会话 7 天内免重复登录</p></form></main></body></html>`
}

function logoutPageHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light"><title>已退出 · DSH 远程访问</title><meta http-equiv="refresh" content="2;url=/__dsh_auth/login"><style>${PAGE_STYLE}</style></head><body><main class="card done"><div class="ok"><svg viewBox="0 0 24 24"><path d="m5 12 4.2 4.2L19 6.5"/></svg></div><p>已退出登录。正在返回登录页…</p><button type="button" onclick="location.replace('/__dsh_auth/login')">立即返回</button></main></body></html>`
}
function passthroughProxyHeaders(headers) {
  // 上游绑定 0.0.0.0（服务器模式）：绑定即派生局域网 IP 信任（trustedHosts），
  // 信任栏阻（api-request-trust）校验的是请求自带的 Host/Origin 一致性——原样透传
  // Host、Origin 与 Cookie 即可通过；仅在 HTML 注入兼容层需要时去掉 accept-encoding。
  return { ...headers }
}

function spoofLoopbackHeaders(headers, loopbackAuthority) {
  // 上游仅绑回环（未开服务器模式）：局域网地址不在信任列表，必须把 Host/Origin
  // 一并改写成回环（回环恒被信任）。Cookie 仍原样透传（上游无 Cookie 需求）。
  const next = { ...headers, host: loopbackAuthority }
  if (next.origin) next.origin = 'http://' + loopbackAuthority
  // HTML must stay uncompressed so the proxy can inject the early compatibility script.
  delete next['accept-encoding']
  return next
}

function htmlInjectionHeaders(headers) {
  // HTML must stay uncompressed so the proxy can inject the early compatibility script.
  const next = { ...headers }
  delete next['accept-encoding']
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
 * 开启需要账号密码登录的远程访问网关。verifyLogin(username, password) 由宿主注入
 * （读 settings 中的加盐哈希做常量时间比对）；会话 Cookie 7 天滑动过期；
 * revokeAllSessions() 在账号密码变更时作废所有已登录设备。
 */
export function startProtectedLanGateway({ port, upstreamHost = '127.0.0.1', upstreamPort, spoofLoopback = false, verifyLogin, sessionTtlMs = SESSION_TTL_MS }) {
  return new Promise((resolve, reject) => {
    const sessions = new Map() // cookie secret -> { expiresAt, seenAt }
    const upgradedSockets = new Map() // client socket -> { cookie, upstreamSocket }
    const loginAttempts = new Map() // ip -> { count, firstAt }
    const loopbackAuthority = '127.0.0.1:' + upstreamPort

    function purge() {
      const stamp = now()
      const expired = []
      for (const [key, value] of sessions) if (value.expiresAt <= stamp) { sessions.delete(key); expired.push(key) }
      for (const [key, item] of loginAttempts) if (stamp - item.firstAt > LOGIN_WINDOW_MS) loginAttempts.delete(key)
      if (expired.length) {
        for (const [socket, value] of upgradedSockets) {
          if (expired.includes(value.cookie)) {
            if (value.upstreamSocket) value.upstreamSocket.destroy()
            socket.destroy()
          }
        }
      }
    }
    const purgeTimer = setInterval(purge, 60 * 1000)

    function sessionCookieOf(req) {
      return parseCookies(req.headers.cookie)[COOKIE_NAME] || null
    }
    function authorize(req) {
      purge()
      const cookie = sessionCookieOf(req)
      const session = cookie ? sessions.get(cookie) : null
      if (!session) return null
      session.expiresAt = now() + sessionTtlMs
      session.seenAt = now()
      return { cookie }
    }
    function loginAllowed(ip) {
      purge()
      const item = loginAttempts.get(ip)
      return !item || now() - item.firstAt > LOGIN_WINDOW_MS || item.count < MAX_LOGIN_ATTEMPTS
    }
    function recordLoginFail(ip) {
      const item = loginAttempts.get(ip) || { count: 0, firstAt: now() }
      if (now() - item.firstAt > LOGIN_WINDOW_MS) { item.count = 0; item.firstAt = now() }
      item.count++
      loginAttempts.set(ip, item)
    }
    function issueSession(res) {
      const cookie = secret()
      sessions.set(cookie, { expiresAt: now() + sessionTtlMs, seenAt: now() })
      res.setHeader('set-cookie', `${COOKIE_NAME}=${cookie}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(sessionTtlMs / 1000)}`)
    }
    function dropSession(req, res) {
      const cookie = sessionCookieOf(req)
      if (cookie) sessions.delete(cookie)
      res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    }
    function proxyHeaders(req) {
      const contentTypeHint = String(req.headers['content-type'] || '')
      const wantsHtml = req.method === 'GET' && !contentTypeHint
      // 先按上游信任形态决定 Host/Origin 策略，再叠加 HTML 注入所需的去压缩。
      const next = spoofLoopback
        ? spoofLoopbackHeaders(req.headers, loopbackAuthority)
        : passthroughProxyHeaders(req.headers)
      if (wantsHtml) delete next['accept-encoding']
      return next
    }
    function proxyHttp(req, res) {
      const upstream = httpRequest({
        hostname: upstreamHost, port: upstreamPort, method: req.method, path: req.url,
        headers: proxyHeaders(req),
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
      const url = new URL(req.url || '/', 'http://remote.internal')
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown'

      if (url.pathname === HEALTH_PATH) return sendJson(res, 200, { ok: true })

      if (url.pathname === LOGIN_PATH && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(loginPageHtml(url.searchParams.get('e') === '1'))
      }
      if (url.pathname === LOGIN_PATH && req.method === 'POST') {
        if (!loginAllowed(ip)) return sendJson(res, 429, { ok: false, error: '尝试次数过多，请 10 分钟后再试。' })
        let body
        try { body = await readSmallJson(req) } catch (error) { return sendJson(res, 400, { ok: false, error: error.message || String(error) }) }
        const username = String(body && body.username || '').trim()
        const password = String(body && body.password || '')
        let ok = false
        try { ok = Boolean(verifyLogin && await verifyLogin(username, password)) } catch { ok = false }
        if (!ok) {
          recordLoginFail(ip)
          return sendJson(res, 401, { ok: false, error: '账号或密码不正确。' })
        }
        loginAttempts.delete(ip)
        issueSession(res)
        return sendJson(res, 200, { ok: true, redirect: '/' })
      }
      if (url.pathname === LOGOUT_PATH) {
        dropSession(req, res)
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(logoutPageHtml())
      }

      if (!authorize(req)) {
        // 浏览器页面访问 → 跳登录页；接口/静态资源请求 → 401（登录后由页面自身发起）。
        if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
          res.writeHead(302, { location: LOGIN_PATH, 'cache-control': 'no-store' })
          return res.end()
        }
        return sendJson(res, 401, { ok: false, error: '未登录或会话已过期，请重新登录。' })
      }
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
      const connection = { cookie: authorized.cookie, upstreamSocket: null }
      upgradedSockets.set(socket, connection)
      const forgetSocket = () => upgradedSockets.delete(socket)
      socket.once('close', forgetSocket)
      const upstream = httpRequest({
        hostname: upstreamHost, port: upstreamPort, method: req.method, path: req.url,
        headers: proxyHeaders(req),
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
        revokeAllSessions() {
          sessions.clear()
          for (const [socket, value] of upgradedSockets) {
            if (value.upstreamSocket) value.upstreamSocket.destroy()
            socket.destroy()
          }
          upgradedSockets.clear()
        },
        close() {
          clearInterval(purgeTimer)
          sessions.clear()
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
