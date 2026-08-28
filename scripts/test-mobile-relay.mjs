import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createRequire } from 'node:module'
import { startProtectedLanGateway } from '../features/mobile-relay/gateway.js'

// qrcode 经 CJS require 解析：仓库 checkout 无 node_modules，运行时用
// NODE_PATH 指向任意装了 qrcode 的 node_modules（或仓库内 junction）。
const QRCode = createRequire(import.meta.url)('qrcode')

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

const upstreamUpgrades = new Set()
const upstream = createServer((req, res) => {
  if (req.url === '/app') {
    const page = '<!doctype html><html><head><script>window.booted=true</script></head><body>DSH</body></html>'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(Buffer.byteLength(page)) })
    res.end(page)
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ path: req.url, host: req.headers.host, origin: req.headers.origin || '', cookie: req.headers.cookie || '' }))
})
upstream.on('upgrade', (req, socket) => {
  upstreamUpgrades.add(socket)
  socket.once('close', () => upstreamUpgrades.delete(socket))
  socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\ngateway-websocket-ok')
  socket.resume()
})

const upstreamPort = await listen(upstream)

// 凭据校验桩（宿主用 settings 哈希比对，这里同语义）。
const ACCOUNT = { username: 'wzy', password: 'secret-pass' }
async function verifyLogin(username, password) {
  return username === ACCOUNT.username && password === ACCOUNT.password
}

// spoofLoopback=true：主实例保持仅本机时的真实形态（Host/Origin 改写为回环）。
const gateway = await startProtectedLanGateway({ port: 0, upstreamPort, spoofLoopback: true, verifyLogin })
const base = `http://127.0.0.1:${gateway.port}`

async function login(username, password) {
  const res = await fetch(base + '/__dsh_auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  return { res, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}

function websocketProbe(port, cookie) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket proxy timeout')) }, 3000)
    let output = ''
    let settled = false
    socket.on('connect', () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: dsh-test',
        `Cookie: ${cookie}`,
        '', '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (!settled && output.includes('\r\n\r\n') && output.includes('gateway-websocket-ok')) {
        settled = true; clearTimeout(timer); resolve({ socket, output })
      }
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

try {
  // 未登录：页面 → 302 登录页；接口 → 401。
  const gate = await fetch(base + '/', { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(gate.status, 302)
  assert.match(gate.headers.get('location') || '', /\/__dsh_auth\/login/)
  const gateApi = await fetch(base + '/api/session.list', { method: 'POST', redirect: 'manual' })
  assert.equal(gateApi.status, 401)

  // 登录页可访问且含表单。
  const loginPage = await fetch(base + '/__dsh_auth/login')
  assert.equal(loginPage.status, 200)
  const loginHtml = await loginPage.text()
  assert.match(loginHtml, /账号/)
  assert.match(loginHtml, /__dsh_auth\/login/)

  // 错误凭据 → 401；正确凭据 → 会话 Cookie。
  const bad = await login(ACCOUNT.username, 'wrong')
  assert.equal(bad.res.status, 401)
  const good = await login(ACCOUNT.username, ACCOUNT.password)
  assert.equal(good.res.status, 200)
  assert.match(good.cookie, /^dsh_remote_session=/)

  // 登录后：页面带远程标记与兼容脚本注入；Host/Origin 已改写为回环；Cookie 透传。
  const page = await fetch(base + '/app', { headers: { cookie: good.cookie } })
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /<head><script data-dsh-mobile-compat src="\/__dsh_mobile\/compat\.js"><\/script><script>/)
  const probe = await (await fetch(base + '/probe', {
    headers: { cookie: good.cookie, origin: `http://127.0.0.1:${gateway.port}` },
  })).json()
  assert.equal(probe.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(probe.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(probe.cookie, good.cookie)

  // 授权二维码（把地址发给设备）。
  assert.match(await QRCode.toDataURL(`http://127.0.0.1:${gateway.port}`, { errorCorrectionLevel: 'M' }), /^data:image\/png;base64,/)

  // WebSocket 管道（带会话）。
  const upgraded = await websocketProbe(gateway.port, good.cookie)
  assert.match(upgraded.output, /101 Switching Protocols/)
  const upgradedClosed = { promise: null, socket: upgraded.socket }

  // 退出登录：会话作废，再次访问回到 302 登录页。
  const logout = await fetch(base + '/__dsh_auth/logout', { headers: { cookie: good.cookie } })
  assert.equal(logout.status, 200)
  assert.match(await logout.text(), /已退出登录/)
  const afterLogout = await fetch(base + '/', { headers: { cookie: good.cookie, accept: 'text/html' }, redirect: 'manual' })
  assert.equal(afterLogout.status, 302)

  // revokeAllSessions：账号变更作废所有会话。
  const again = await login(ACCOUNT.username, ACCOUNT.password)
  gateway.revokeAllSessions()
  const revoked = await fetch(base + '/', { headers: { cookie: again.cookie, accept: 'text/html' }, redirect: 'manual' })
  assert.equal(revoked.status, 302)

  upgradedClosed.socket.destroy()
  console.log(`remote access gateway: ok (127.0.0.1:${gateway.port} -> 127.0.0.1:${upstreamPort}, login/logout/spoof/ws)`)
} finally {
  await gateway.close()
  for (const socket of upstreamUpgrades) socket.destroy()
  await new Promise((resolve) => upstream.close(resolve))
}
