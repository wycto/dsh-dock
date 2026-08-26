import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { feature } from '../features/mobile-relay/host.js'

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.removeListener('error', reject)
      resolve(server.address().port)
    })
  })
}

async function freePort() {
  const placeholder = createServer()
  const port = await listen(placeholder)
  placeholder.close()
  await once(placeholder, 'close')
  return port
}

async function rpc(base, method, payload = {}, cookie = '') {
  const response = await fetch(`${base}/dsh-dock/mobile-relay/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${body && body.error && body.error.message || body.error}`)
  return body.data
}

let registered = null
const mainServer = createServer((req, res) => {
  if (registered && String(req.url).startsWith('/dsh-dock/mobile-relay')) return registered.handler(req, res)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('mock DSH')
})
const mainPort = await listen(mainServer)
const gatewayPort = await freePort()

const dispose = feature.setup({
  inject(keys, callback) {
    if (keys.includes('sessionQuery')) callback({ sessionQuery: {}, on: () => () => {} })
    if (keys.includes('webServer')) callback({
      webServer: {
        host: '127.0.0.1', port: mainPort,
        register(route) { registered = route; return () => { registered = null } },
      },
      effect(run) { return run() },
    })
    return () => {}
  },
})

const mainBase = `http://127.0.0.1:${mainPort}`
const gatewayBase = `http://127.0.0.1:${gatewayPort}`

try {
  const network = await rpc(mainBase, 'network')
  assert.equal(network.defaultPort, 3081)
  assert.equal(network.main.port, mainPort)

  const started = await rpc(mainBase, 'start', { deviceId: 'desktop-test', port: gatewayPort })
  assert.equal(started.gateway.port, gatewayPort)
  assert.equal(started.pair.devices[0].role, 'desktop')

  const exchange = await fetch(gatewayBase + '/__dsh_mobile/connect', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: started.gatewayToken }),
  })
  assert.equal(exchange.status, 200)
  const cookie = (exchange.headers.get('set-cookie') || '').split(';')[0]
  const launch = (await exchange.json()).launch
  const [pairId, code] = launch.split('.')

  const joined = await rpc(gatewayBase, 'join', { pairId, code, deviceId: 'mobile-test', label: '测试手机' }, cookie)
  assert.equal(joined.pair.devices.length, 2)
  const mobileSession = { pairId, deviceId: 'mobile-test', secret: joined.secret }
  const status = await rpc(gatewayBase, 'status', mobileSession, cookie)
  assert.equal(status.pair.devices.some((item) => item.label === '测试手机'), true)

  await rpc(gatewayBase, 'end', mobileSession, cookie)
  await new Promise((resolve) => setTimeout(resolve, 150))
  await assert.rejects(fetch(gatewayBase + '/__dsh_mobile/health'))
  console.log(`mobile relay host: ok (main 127.0.0.1:${mainPort}, gateway 0.0.0.0:${gatewayPort})`)
} finally {
  dispose()
  await new Promise((resolve) => mainServer.close(resolve))
}
