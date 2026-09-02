import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

async function rpc(base, method, payload = {}) {
  const response = await fetch(`${base}/dsh-dock/mobile-relay/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (!response.ok) throw new Error(`${response.status}: ${body && body.error && body.error.message || body.error}`)
  return body.data
}

// 远程访问开关写进这个临时补丁层（绝不触碰真实 ~/.dsh）。
const patchFile = join(tmpdir(), `dsh-dock-remote-patch-test-${process.pid}.yml`)
process.env.DSH_DOCK_PATCH_FILE = patchFile

let registered = null
const mainServer = createServer((req, res) => {
  if (registered && String(req.url).startsWith('/dsh-dock/mobile-relay')) return registered.handler(req, res)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('mock DSH')
})
const mainPort = await listen(mainServer)
const gatewayPort = await freePort()

// settings/webServer 桩（两个 setup 实例共用：内存 settings + 路由注册槽）。
function injectMock(keys, callback) {
  if (keys.includes('settings')) {
    // settings 桩：内存态 DockConfig，仅支持本测试用到的 remoteAuth.set 操作。
    const store = new Map()
    callback({
      settings: {
        get(ns) {
          const value = store.get(ns)
          return value ? JSON.parse(JSON.stringify(value)) : undefined
        },
        async mutate(ns, ops) {
          let value = store.get(ns) || {}
          for (const op of ops) {
            if (op.op !== 'set') throw new Error('unsupported test op: ' + op.op)
            value = { ...value, [op.path[0]]: JSON.parse(JSON.stringify(op.value)) }
          }
          store.set(ns, value)
        },
      },
    })
  }
  if (keys.includes('webServer')) callback({
    webServer: {
      host: '127.0.0.1', port: mainPort,
      tapIndex() { return () => {} },
      register(route) { registered = route; return () => { registered = null } },
    },
    effect(run) { return run() },
  })
  return () => {}
}

const dispose = feature.setup({ inject: injectMock })
let healDispose = () => {}

const mainBase = `http://127.0.0.1:${mainPort}`
const gatewayBase = `http://127.0.0.1:${gatewayPort}`

try {
  // 初始：未设账号、入口未开、无补丁。
  const before = await rpc(mainBase, 'lan')
  assert.equal(before.gatewayActive, false)
  assert.equal(before.accountSet, false)
  assert.equal(before.patchApplied, false)
  assert.equal(before.webserverActive, false)

  // 未设账号就开启 → 400 提示先设置账号密码。
  await assert.rejects(rpc(mainBase, 'lan/start', {}), /请先设置远程访问的账号和密码/)

  // 开启：带账号密码 → 网关运行 + 浏览模式补丁写入 + 旧服务器模式行清理。
  const started = await rpc(mainBase, 'lan/start', { username: 'wzy', password: 'secret-pass', port: gatewayPort })
  assert.equal(started.gatewayActive, true)
  assert.equal(started.gatewayPort, gatewayPort)
  assert.equal(started.accountSet, true)
  assert.equal(started.username, 'wzy')
  assert.equal(started.patchApplied, true)
  const patchText = readFileSync(patchFile, 'utf8')
  assert.match(patchText, /directory-picker-browse/)
  // browse 行必须包在 insert 块里：DSH 补丁语义对未知 id 的普通行整行跳过，
  // 平铺写入会因 directoryPicker 服务无人提供而让 /api 整面 404。
  assert.match(patchText, /insert:/)
  assert.doesNotMatch(patchText, /webserver/)

  // 登录链路：未登录 302 → 错误密码 401 → 正确密码 200 → 会话访问上游。
  const gate = await fetch(gatewayBase + '/', { headers: { accept: 'text/html' }, redirect: 'manual' })
  assert.equal(gate.status, 302)
  const badLogin = await fetch(gatewayBase + '/__dsh_auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wzy', password: 'wrong' }),
  })
  assert.equal(badLogin.status, 401)
  const login = await fetch(gatewayBase + '/__dsh_auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wzy', password: 'secret-pass' }),
  })
  assert.equal(login.status, 200)
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  const ok = await fetch(gatewayBase + '/', { headers: { cookie } })
  assert.equal(ok.status, 200)
  assert.equal(await ok.text(), 'mock DSH')

  // 修改密码（auth/set）：旧会话作废，新密码生效。
  await rpc(mainBase, 'auth/set', { username: 'wzy2', password: 'new-secret' })
  const oldSession = await fetch(gatewayBase + '/', { headers: { cookie, accept: 'text/html' }, redirect: 'manual' })
  assert.equal(oldSession.status, 302)
  const relogin = await fetch(gatewayBase + '/__dsh_auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wzy2', password: 'new-secret' }),
  })
  assert.equal(relogin.status, 200)
  const oldPassword = await fetch(gatewayBase + '/__dsh_auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'wzy', password: 'secret-pass' }),
  })
  assert.equal(oldPassword.status, 401)

  // 再次开启（幂等）：补丁仍只有一份 browse 行。
  await rpc(mainBase, 'lan/start', { port: gatewayPort })
  const again = readFileSync(patchFile, 'utf8')
  assert.equal(again.match(/- id: directory-picker-browse/g).length, 1)

  // 默认端口跟主实例走（主端口+1）；与主端口相同则拒绝（同一台机器不能同端口）。
  // 先停掉已运行的网关：默认端口仅在"没有运行中的网关"时生效，且 freePort 分配的
  // gatewayPort 可能恰好等于 mainPort+1（此时带显式端口的 lan/start 已占住网关，
  // 再发默认端口请求会撞 409）——这不是产品缺陷，是同一用例内的先后依赖。
  await rpc(mainBase, 'lan/stop', {})
  const defaulted = await rpc(mainBase, 'lan/start', {})
  assert.equal(defaulted.gatewayPort, mainPort + 1)
  await assert.rejects(rpc(mainBase, 'lan/start', { port: mainPort }), /不能与 DSH 主服务端口/)

  // 关闭：网关停、补丁行清空。
  const stopped = await rpc(mainBase, 'lan/stop', {})
  assert.equal(stopped.gatewayActive, false)
  assert.equal(stopped.patchApplied, false)
  assert.equal(stopped.needsRestart, true)
  assert.doesNotMatch(readFileSync(patchFile, 'utf8'), /directory-picker-browse/)
  await assert.rejects(fetch(gatewayBase + '/__dsh_auth/health'))

  // 旧版坏形态自愈：平铺 browse 行（DSH 会整行跳过，auto 又被停用 → directoryPicker
  // 无人提供，/api 整面 404）必须在插件加载时无损改写为 insert 形态。
  // 放在最后：自愈需要重新 setup 一个实例（会接管路由槽，不影响已断言过的流程）。
  writeFileSync(patchFile, [
    '- id: directory-picker',
    '  disabled: true',
    '- id: directory-picker-browse',
    "  name: '@deepseek-ai/dsh-host-directory-picker-browse'",
    '- id: ui-directory-picker-browse',
    "  name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'",
    '',
  ].join('\n'), 'utf8')
  healDispose = feature.setup({ inject: injectMock })
  const healed = readFileSync(patchFile, 'utf8')
  assert.match(healed, /insert:/)
  assert.equal(healed.match(/- id: directory-picker-browse/g).length, 1)

  console.log(`remote access host: ok (main 127.0.0.1:${mainPort}, gateway 0.0.0.0:${gatewayPort}, credentials + patch roundtrip)`)
} finally {
  healDispose()
  dispose()
  rmSync(patchFile, { force: true })
  await new Promise((resolve) => mainServer.close(resolve))
}
