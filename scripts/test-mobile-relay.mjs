import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { once } from 'node:events'
import vm from 'node:vm'
import QRCode from 'qrcode'
import { startProtectedLanGateway } from '../features/mobile-relay/gateway.js'

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
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
const gateway = await startProtectedLanGateway({ port: 0, upstreamPort })
const base = `http://127.0.0.1:${gateway.port}`

try {
  const unauthenticated = await fetch(base + '/')
  assert.equal(unauthenticated.status, 401)

  const connectPage = await fetch(base + '/__dsh_mobile/connect')
  assert.equal(connectPage.status, 200)
  assert.match(connectPage.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)

  const token = gateway.issue('pair-1', 'pair-1.A1B2C3D4E5', Date.now() + 60_000)
  const scanLink = `${base}/__dsh_mobile/connect#${token}`
  assert.match(await QRCode.toDataURL(scanLink, { errorCorrectionLevel: 'M' }), /^data:image\/png;base64,/)
  const exchange = await fetch(base + '/__dsh_mobile/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  })
  assert.equal(exchange.status, 200)
  assert.equal((await exchange.json()).launch, 'pair-1.A1B2C3D4E5')
  const cookie = (exchange.headers.get('set-cookie') || '').split(';')[0]
  assert.match(cookie, /^dsh_mobile_session=/)

  const replay = await fetch(base + '/__dsh_mobile/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  })
  assert.equal(replay.status, 403)

  const proxied = await fetch(base + '/probe', {
    headers: { cookie, origin: `http://127.0.0.1:${gateway.port}` },
  })
  assert.equal(proxied.status, 200)
  const probe = await proxied.json()
  assert.equal(probe.path, '/probe')
  assert.equal(probe.host, `127.0.0.1:${upstreamPort}`)
  assert.equal(probe.origin, `http://127.0.0.1:${upstreamPort}`)
  assert.equal(probe.cookie, '')

  const htmlResponse = await fetch(base + '/app', { headers: { cookie } })
  const html = await htmlResponse.text()
  assert.equal(htmlResponse.status, 200)
  assert.match(html, /<head><script data-dsh-mobile-compat src="\/__dsh_mobile\/compat\.js"><\/script><script>/)
  assert.equal(htmlResponse.headers.get('content-length'), null)
  const compatResponse = await fetch(base + '/__dsh_mobile/compat.js', { headers: { cookie } })
  const compatJs = await compatResponse.text()
  const browser = { crypto: { getRandomValues(bytes) { for (let i = 0; i < bytes.length; i++) bytes[i] = i * 17 + 3; return bytes } } }
  vm.runInNewContext(compatJs, browser)
  assert.equal(typeof browser.crypto.randomUUID, 'function')
  assert.match(browser.crypto.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

  const upgraded = await websocketProbe(gateway.port, cookie)
  assert.match(upgraded.output, /101 Switching Protocols/)

  const upgradedClosed = once(upgraded.socket, 'close')
  gateway.revokePair('pair-1')
  await upgradedClosed
  const revoked = await fetch(base + '/', { headers: { cookie } })
  assert.equal(revoked.status, 401)
  console.log(`mobile relay gateway: ok (127.0.0.1:${gateway.port} -> 127.0.0.1:${upstreamPort})`)
} finally {
  await gateway.close()
  for (const socket of upstreamUpgrades) socket.destroy()
  await new Promise((resolve) => upstream.close(resolve))
}
