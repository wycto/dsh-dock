// dsh-dock · 功能模块【MCP 管理】宿主半部契约测试
//
// 锁住这些行为：
//   ① 只改 `# >>> dsh-dock MCP manager` 托管块：用户手写行/注释/`!!js` 表达式原样保留；
//   ② 写盘后调用 hmr.reconcileProfile(ids) 热应用；应用失败必须把文件回滚；
//   ③ 校验：serverName 正则/唯一、transport 必填项、与手写 mcp-client 行冲突；
//   ④ 启停用行上的 disabled；删除 = 从托管块移除（清空时整块消失）；
//   ⑤ 无 HMR 时只保存并返回 restartRequired。
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feature as mcpFeature } from '../features/mcpconfig/host.js'

const BEGIN = '# >>> dsh-dock MCP manager (machine-managed; do not edit by hand)'
const END = '# <<< dsh-dock MCP manager'

const USER_PATCH = `# 用户手写内容：注释、!!js 表达式都要保留
- id: llm-pi-ai
  config:
    providers:
      acme:
        apiKeyEnv: !!js process.env.ACME_KEY
        baseURL: https://acme.example/v1
`

function makeRes() {
  return {
    status: 0, body: null,
    writeHead(status) { this.status = status; return this },
    end(text) { this.body = text ? JSON.parse(text) : null; return this },
  }
}

function makeReq(method, payload) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method, url: '/dsh-dock/mcpconfig', headers: {}, resume() {}, destroy() {},
    on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); return req },
    __dispatch() {
      if (payload === undefined) { for (const cb of listeners.end) cb(); return }
      for (const cb of listeners.data) cb(Buffer.from(JSON.stringify(payload), 'utf8'))
      for (const cb of listeners.end) cb()
    },
  }
  return req
}

function makeCtx({ patchPath, hmrMode = 'ok', loaderEntries = [], toolNames = [] } = {}) {
  const routes = new Map()
  const calls = { reconcile: [] }
  const hmr = hmrMode === 'absent' ? undefined : {
    async runExclusive(fn) { return fn() },
    async reconcileProfile(ids) {
      calls.reconcile.push(ids)
      // 只让第一次应用失败，回滚时的那次 reconcile 正常（贴近真实：坏行导致的失败可回滚）
      if (hmrMode === 'throw' && calls.reconcile.length === 1) throw new Error('reconcile boom')
      return { applied: true }
    },
  }
  const ctx = {
    get(name) {
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'webServer') {
        return { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      }
      if (name === 'profileContext') return { patchPath }
      if (name === 'hmr') return hmr
      if (name === 'loader') return { entries: () => loaderEntries }
      if (name === 'tools') return { definitions: () => toolNames.map((n) => ({ name: n })) }
      return undefined
    },
    effect(run) { const off = run(); return typeof off === 'function' ? off : () => {} },
    on() { return () => {} },
  }
  return { ctx, routes, calls }
}

async function call(handler, method, payload) {
  const res = makeRes()
  const req = makeReq(method, payload)
  const pending = handler(req, res)
  req.__dispatch()
  await pending
  return res
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-dock-mcp-'))
const patchPath = join(dir, 'cordis.patch.yml')
writeFileSync(patchPath, USER_PATCH, { mode: 0o600 })
const read = () => readFileSync(patchPath, 'utf8')
const liveEntries = (serverName, { disabled = false, state = 'active' } = {}) => ([{
  options: { id: 'dock-mcp-' + serverName, name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport: 'stdio' } },
  disabled,
  fiber: { state },
}])

async function main() {
  // ---------- ① 空列表 + 用户内容不受影响 ----------
  {
    const { ctx, routes } = makeCtx({ patchPath })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'GET')
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.servers, [], '初始没有托管服务器')
    assert.equal(res.body.hmrAvailable, true)

    const before = read()
    const save = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', {
      action: 'save',
      servers: [{
        serverName: 'xiaomi_ocr', transport: 'stdio', command: '/usr/bin/python3',
        args: ['/www/wwwroot/xiaomi-ocr/mcp_ocr.py'], env: {}, cwd: '/www/wwwroot/xiaomi-ocr',
        enabled: true, failOnStartupError: false, toolCallTimeoutMs: 300000,
      }],
    })
    assert.equal(save.status, 200, JSON.stringify(save.body))
    assert.equal(save.body.applied, true)
    const after = read()
    assert.ok(after.includes(BEGIN) && after.includes(END), '托管块已写入')
    assert.ok(after.includes('dock-mcp-xiaomi_ocr'), '行 id 正确')
    assert.ok(after.includes('# 用户手写内容'), '用户注释保留')
    assert.ok(after.includes('!!js process.env.ACME_KEY'), '!!js 表达式保留')
    assert.ok(after.includes('https://acme.example/v1'), '用户配置保留')
    assert.notEqual(before, after)
  }
  console.log('① 写入托管块 / 保留用户内容：ok')

  // ---------- ② 热应用调用 + 实时状态 ----------
  {
    const { ctx, routes, calls } = makeCtx({
      patchPath,
      loaderEntries: liveEntries('xiaomi_ocr'),
      toolNames: ['mcp__xiaomi_ocr__ocr_image', 'mcp__xiaomi_ocr__ocr_health'],
    })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'GET')
    assert.equal(res.status, 200)
    assert.equal(res.body.servers.length, 1)
    const s = res.body.servers[0]
    assert.equal(s.serverName, 'xiaomi_ocr')
    assert.equal(s.transport, 'stdio')
    assert.equal(s.enabled, true)
    assert.equal(s.state, 'active', JSON.stringify(s))
    assert.equal(s.toolCount, 2)
    assert.ok(s.tools.includes('mcp__xiaomi_ocr__ocr_image'))

    const save = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', {
      action: 'save', servers: [{ ...s, args: s.args }],
    })
    assert.equal(save.status, 200)
    assert.deepEqual(calls.reconcile.at(-1), ['dock-mcp-xiaomi_ocr'], 'reconcile 用托管行 id')
  }
  console.log('② 热应用 reconcileProfile(ids) / 状态与工具数：ok')

  // ---------- ③ 校验 ----------
  {
    const { ctx, routes } = makeCtx({ patchPath })
    mcpFeature.setup(ctx)
    const handler = routes.get('/dsh-dock/mcpconfig')
    const base = { transport: 'stdio', command: 'npx', enabled: true }
    const cases = [
      { servers: [{ ...base, serverName: 'bad name!' }], why: 'serverName 非法' },
      { servers: [{ ...base, serverName: 'a' }, { ...base, serverName: 'a' }], why: 'serverName 重复' },
      { servers: [{ ...base, serverName: 'x', command: '' }], why: 'stdio 缺 command' },
      { servers: [{ serverName: 'h', transport: 'streamable-http', url: 'ftp://x', enabled: true }], why: 'url 非法' },
      { servers: [{ ...base, serverName: 'e', env: { 'BAD-NAME': '1' } }], why: 'env 名非法' },
    ]
    const before = read()
    for (const c of cases) {
      const res = await call(handler, 'POST', { action: 'save', servers: c.servers })
      assert.equal(res.status, 400, `${c.why} 应 400，实际 ${res.status}`)
      assert.equal(res.body.ok, false)
    }
    assert.equal(read(), before, '校验失败不得写盘')
  }
  console.log('③ 校验（正则/重复/必填/url/env）：ok')

  // ---------- ④ 启停（disabled 行） ----------
  {
    const { ctx, routes } = makeCtx({ patchPath, loaderEntries: liveEntries('xiaomi_ocr', { disabled: true, state: 'active' }) })
    mcpFeature.setup(ctx)
    const handler = routes.get('/dsh-dock/mcpconfig')
    const res0 = await call(handler, 'GET')
    const s = res0.body.servers[0]
    const save = await call(handler, 'POST', { action: 'save', servers: [{ ...s, enabled: false }] })
    assert.equal(save.status, 200, JSON.stringify(save.body))
    assert.ok(read().includes('disabled: true'), '停用写为 disabled: true')
    const res1 = await call(handler, 'GET')
    assert.equal(res1.body.servers[0].enabled, false)
    assert.equal(res1.body.servers[0].state, 'disabled')
    // 再启用
    const back = await call(handler, 'POST', { action: 'save', servers: [{ ...res1.body.servers[0], enabled: true }] })
    assert.equal(back.status, 200)
    assert.ok(!read().includes('disabled: true'), '启用后移除 disabled')
  }
  console.log('④ 启停（disabled 行）：ok')

  // ---------- ⑤ 应用失败回滚 ----------
  {
    const before = read()
    const { ctx, routes } = makeCtx({ patchPath, hmrMode: 'throw' })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', {
      action: 'save', servers: [{ serverName: 'rollback_test', transport: 'stdio', command: 'npx', enabled: true }],
    })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.equal(res.body.rolledBack, true)
    assert.equal(read(), before, '失败必须回滚文件')
  }
  console.log('⑤ 应用失败回滚：ok')

  // ---------- ⑥ 删除全部：托管块消失 ----------
  {
    const { ctx, routes, calls } = makeCtx({ patchPath })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', { action: 'save', servers: [] })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    const text = read()
    assert.ok(!text.includes(BEGIN) && !text.includes(END), '空列表时整块移除')
    assert.ok(text.includes('# 用户手写内容') && text.includes('!!js process.env.ACME_KEY'), '用户内容仍在')
    assert.deepEqual(calls.reconcile.at(-1), [])
  }
  console.log('⑥ 删除全部（整块移除，保留用户内容）：ok')

  // ---------- ⑦ 与手写 mcp-client 行冲突 ----------
  {
    writeFileSync(patchPath, USER_PATCH + `- insert:\n    - id: manual-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: foo\n        transport: stdio\n        command: npx\n`, { mode: 0o600 })
    const { ctx, routes } = makeCtx({ patchPath })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', {
      action: 'save', servers: [{ serverName: 'foo', transport: 'stdio', command: 'npx', enabled: true }],
    })
    assert.equal(res.status, 400, JSON.stringify(res.body))
    assert.match(res.body.error, /手写/)
  }
  console.log('⑦ 与手写 mcp-client 行冲突：ok')

  // ---------- ⑧ 无 HMR：只保存 + restartRequired ----------
  {
    writeFileSync(patchPath, USER_PATCH, { mode: 0o600 })
    const { ctx, routes } = makeCtx({ patchPath, hmrMode: 'absent' })
    mcpFeature.setup(ctx)
    const res = await call(routes.get('/dsh-dock/mcpconfig'), 'POST', {
      action: 'save', servers: [{ serverName: 'no_hmr', transport: 'stdio', command: 'npx', enabled: true }],
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.applied, false)
    assert.equal(res.body.restartRequired, true)
    assert.ok(read().includes('dock-mcp-no_hmr'))
  }
  console.log('⑧ 无 HMR：保存 + restartRequired：ok')

  console.log('\nall mcpconfig host tests passed')
}

try {
  await main()
} finally {
  rmSync(dir, { recursive: true, force: true })
}
