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
const indexTransforms = []
const mainServer = createServer((req, res) => {
  if (registered && String(req.url).startsWith('/dsh-dock/mobile-relay')) return registered.handler(req, res)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('mock DSH')
})
const mainPort = await listen(mainServer)
const gatewayPort = await freePort()

// settings/webServer 桩（两个 setup 实例共用：内存 settings + 路由注册槽）。
// settings 桩提到外层：0.1.7 起宿主半部经 ctx.get('settings') 做就绪检查（saveAuth 等），
// mock ctx 也必须提供同一个服务对象，否则 auth/set 必 500。
// store 同样外置：跨 setup 实例（模拟 dsh web 重启）保留 remoteGateway/账号状态，
// 这样「重启自动拉起」用例才验得到持久化语义。
const settingsStore = new Map()
const settingsService = {
  get(ns) {
    const value = settingsStore.get(ns)
    return value ? JSON.parse(JSON.stringify(value)) : undefined
  },
  async mutate(ns, ops) {
    let value = settingsStore.get(ns) || {}
    for (const op of ops) {
      if (op.op !== 'set') throw new Error('unsupported test op: ' + op.op)
      value = { ...value, [op.path[0]]: JSON.parse(JSON.stringify(op.value)) }
    }
    settingsStore.set(ns, value)
  },
}
const mockCtx = {
  inject: injectMock,
  get(key) { return key === 'settings' ? settingsService : undefined },
}
function injectMock(keys, callback) {
  if (keys.includes('settings')) {
    callback({ settings: settingsService })
  }
  if (keys.includes('webServer')) callback({
    webServer: {
      host: '127.0.0.1', port: mainPort,
      tapIndex(fn) { indexTransforms.push(fn); return () => {} },
      register(route) { registered = route; return () => { registered = null } },
    },
    effect(run) { return run() },
  })
  return () => {}
}

const dispose = feature.setup(mockCtx)
let healDispose = () => {}
let autoDispose = () => {}

// 手机端适配注入（tapIndex）：必须含遮罩与 UUID 兜底，不得再出现抽屉把手，且幂等。
assert.ok(indexTransforms.length > 0, 'tapIndex transform must be registered')
{
  const sample = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
  const once1 = indexTransforms.reduce((html, fn) => fn(html), sample)
  assert.match(once1, /data-dsh-lan-compat/)
  assert.match(once1, /data-dsh-mobile-layout/)
  // 左缘浮动「抽屉把手」已移除（用户实测截图：与底部 Tab 栏「会话」页签功能重复，
  // 还悬浮在内容上压过输入区）——注入页不得再出现把手元素/样式。
  assert.doesNotMatch(once1, /dsh-mobile-drawer-btn/)
  assert.doesNotMatch(once1, /dsh-dock-drawer-top|dsh-dock-drawer-off/)
  assert.match(once1, /dsh-mobile-scrim/)
  assert.match(once1, /data-dsh-mobile-behave/)
  assert.match(once1, /打开侧边栏/)
  // 设置弹层挂在侧栏列内部：列隐藏不能连坐弹层（否则点设置是空气弹层）
  assert.match(once1, /\[class\*="sidebarCol"\]:has\(\[class\*="collapsed"\]\) \[role="dialog"\]\{visibility:visible\}/)
  const twice = indexTransforms.reduce((html, fn) => fn(html), once1)
  assert.equal(countOf(twice, 'data-dsh-mobile-layout'), 1, 'injection must be idempotent')
  assert.equal(countOf(twice, 'data-dsh-mobile-behave'), 1)
  assert.equal(countOf(twice, 'data-dsh-lan-compat'), 1)

  // 手机端「会话记录滑不动」回归钉（用户实测缺陷）。为了让欢迎页的输入卡贴底，早期
  // 给滚动体加了 justify-content:flex-end——内容因此从滚动体起点溢出，而 Chrome 不把
  // 起点方向的溢出算进 scrollHeight（手机视口实测 scrollHeight==clientHeight、
  // maxScroll==0），会话记录彻底滑不动、首条消息永远停在视口外。贴底只能用输入区
  // 自己的 margin-top:auto：有剩余空间才生效，不制造起点溢出。
  assert.doesNotMatch(once1, /\[class\*="scrollBody"\][^{}]*\{[^}]*justify-content:\s*(?:flex-end|center)/, '滚动体不得设 flex-end/center（会让会话记录滚不动）')
  assert.match(once1, /\[class\*="scrollBody"\]>\[class\*="composerSeat"\]\{margin-top:auto/, '输入区贴底必须走 margin-top:auto')
  // 输入区工具行的 chip 窄屏收起（28cqw 上限把它们挤成「余..」，读不出数值）
  assert.match(once1, /\.dockchip-row\{display:none\}/)
  // 「插件」页签（任务/功能坞并入）+ 等待确认角标 + 软键盘让位（与客户端半部同款契约，
  // 两半部必须一起改）。
  assert.doesNotMatch(once1, /\{id:"tasks"/, '不应再有独立「任务」页签（应并入「插件」）')
  assert.match(once1, /\{id:"dock",label:"插件"/, 'Tab 栏缺「插件」页签')
  // 功能坞面板必须抬到原生弹层之上（官方插件管理页等 z 高于面板默认 200，会盖住功能坞）
  assert.match(once1, /\[class\*="dockm-backdrop"\]\{z-index:2000!important\}/, '手机端没有把功能坞面板抬到原生弹层之上')
  assert.match(once1, /dsh-mobile-tab-badge/, '缺「插件」页签任务角标样式/元素')
  assert.match(once1, /\/dsh-dock\/runstate\/status/, '角标没有轮询 runstate 路由')
  assert.match(once1, /visualViewport/, '软键盘判定没有用 visualViewport')
  // 侧栏入口（插件/自动化任务/设置…）弹出的面板 z 序低于展开的抽屉——点击后必须
  // 探测面板并收起抽屉，否则面板被盖住等于「点了没反应」（用户实测截图）。
  assert.match(once1, /setTimeout\(function\(\)\{if\(document\.querySelector\('\[role="dialog"\]'\)\)collapse\(\)\},260\)/, '侧栏入口点击后没有「面板弹出即收起抽屉」的探测')
  // 点工作区文件夹不能收抽屉（只展开/收拢分组）：会话行以 data-row-key="session:" 开头，
  // 文件夹行是 workspace: 开头——旧的「无子 treeitem 即叶子」判定会误伤折叠状态的文件夹
  // （折叠时子节点不在 DOM 里），用户实测「点文件夹抽屉被收起」。
  assert.match(once1, /rowKey\.indexOf\("session:"\)===0/, '会话行识别没有按 data-row-key 的 session: 前缀（点文件夹会被误收抽屉）')
  assert.doesNotMatch(once1, /var leaf=row&&!row\.querySelector/, '残留旧的「无子 treeitem 即叶子」判定')
  assert.match(once1, /html:not\(\.dsh-dock-kbd\) \[class\*="scrollBody"\]/, '滚动体留白没有区分键盘弹出态')
  assert.match(once1, /html\.dsh-dock-kbd \[class\*="scrollBody"\]/, '缺键盘弹出态的收窄留白规则')
}
function countOf(text, needle) { return text.split(needle).length - 1 }

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
  assert.equal(started.gatewayEnabled, true, 'lan/start 必须持久化「远程访问已开启」')
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
  assert.equal(stopped.gatewayEnabled, false, 'lan/stop 必须清掉「远程访问已开启」标记')
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
  healDispose = feature.setup(mockCtx)
  const healed = readFileSync(patchFile, 'utf8')
  assert.match(healed, /insert:/)
  assert.equal(healed.match(/- id: directory-picker-browse/g).length, 1)

  // 重启自动拉起（模拟 dsh web 重启）：remoteGateway.enabled=true 且账号还在 →
  // 新实例 setup 时把网关直接监听回同一端口，不必进面板再点一次。
  await settingsService.mutate('dsh-dock', [{ op: 'set', path: ['remoteGateway'], value: { enabled: true, port: gatewayPort } }])
  autoDispose = feature.setup(mockCtx)
  let autoActive = false
  for (let i = 0; i < 60 && !autoActive; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      autoActive = (await rpc(mainBase, 'lan')).gatewayActive === true
    } catch { /* 路由切换的瞬时窗口 */ }
  }
  const autoStatus = await rpc(mainBase, 'lan')
  assert.equal(autoActive, true, '开过远程访问后重启应自动拉起网关')
  assert.equal(autoStatus.gatewayPort, gatewayPort, '自动拉起应复用上次端口')

  console.log(`remote access host: ok (main 127.0.0.1:${mainPort}, gateway 0.0.0.0:${gatewayPort}, credentials + patch roundtrip)`)
} finally {
  autoDispose()
  healDispose()
  dispose()
  rmSync(patchFile, { force: true })
  await new Promise((resolve) => mainServer.close(resolve))
}
