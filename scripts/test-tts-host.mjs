// dsh-dock · 功能模块【语音朗读】宿主半部契约测试
//
// 锁三件事：
//   ① 路由入口挂了浏览器信任栅栏（401/403 时不进入业务、不落盘）；
//   ② /config 增量合并：只认白名单字段、类型不符忽略、数值越界钳制，并持久化到 tts 段；
//   ③ /status 同时下发配置与共享任务追踪快照（自动朗读靠它）。
import assert from 'node:assert/strict'
import { feature as ttsFeature, mergeTtsConfig, readTtsConfig } from '../features/tts/host.js'
import { seedDockConfig } from '../src/host-core.js'

function makeRes() {
  return {
    status: 0, body: null,
    writeHead(status) { this.status = status; return this },
    end(text) { this.body = text ? JSON.parse(text) : null; return this },
  }
}
function makeReq(url, method, payload) {
  const listeners = { data: [], end: [], error: [] }
  const req = {
    url, method, headers: {}, resume() {}, destroy() {},
    on(event, cb) { (listeners[event] || (listeners[event] = [])).push(cb); return req },
    __dispatch() {
      // payload 为 undefined 时不喂 data 事件（等价于真实的空请求体 → readBody 给 {}）
      if (payload === undefined) { for (const cb of listeners.end) cb(); return }
      const raw = JSON.stringify(payload)
      for (const cb of listeners.data) cb(Buffer.from(raw, 'utf8'))
      for (const cb of listeners.end) cb()
    },
  }
  return req
}
function makeCtx({ rejection = undefined, mutates = [] } = {}) {
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return rejection === 'absent' ? undefined : { requestRejection: () => rejection }
      if (name === 'webServer') {
        return { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
      }
      if (name === 'settings') {
        return {
          async mutate(ns, ops) { mutates.push({ ns, ops }) },
          describe() { return [{ ns: 'dsh-dock', revision: 1, user: {}, base: {}, value: {} }] },
        }
      }
      if (name === 'sessionQuery') return { readTitle: async () => '', readSession: async () => null }
      return undefined
    },
    effect(run) { const off = run(); return typeof off === 'function' ? off : () => {} },
    // 注入作用域按 cordis 习惯同时给出服务属性与 get()（宿主半部两种写法都可能用到）
    inject(_keys, cb) { cb(Object.assign(Object.create(ctx), { webServer: ctx.get('webServer'), sessionQuery: ctx.get('sessionQuery') })); return () => {} },
    on() { return () => {} },
  }
  return { ctx, routes }
}
async function call(handler, url, method = 'POST', payload) {
  const res = makeRes()
  const req = makeReq(url, method, payload)
  const pending = handler(req, res)
  req.__dispatch()
  await pending
  return res
}

// ---------- ① 信任栅栏 ----------
for (const rejection of [401, 403]) {
  const mutates = []
  const { ctx, routes } = makeCtx({ rejection, mutates })
  ttsFeature.setup(ctx)
  const res = await call(routes.get('/dsh-dock/tts'), '/dsh-dock/tts/config', 'POST', { autoPlay: true })
  assert.equal(res.status, rejection, `tts 路由应以 ${rejection} 拒绝`)
  assert.equal(res.body.error.code, 'untrusted')
  assert.equal(mutates.length, 0, '被拒绝的写请求不得落盘')
}
{
  const { ctx, routes } = makeCtx({ rejection: 'absent' })
  ttsFeature.setup(ctx)
  const res = await call(routes.get('/dsh-dock/tts'), '/dsh-dock/tts/status')
  assert.equal(res.status, 401, '缺少信任栅栏时必须 fail-closed')
}
console.log('tts route trust: ok（401 / 403 / 栅栏缺失 fail-closed，写请求不落盘）')

// ---------- ② 增量合并与钳制 ----------
{
  seedDockConfig({ tts: { autoPlay: false, rate: 1, maxSentences: 0 } })
  const { ctx } = makeCtx()
  const base = readTtsConfig(ctx)
  assert.equal(base.autoPlay, false, '默认不自动朗读')
  assert.equal(base.skipCode, true, '默认跳过代码块')

  const merged = mergeTtsConfig(Object.assign({}, base), {
    autoPlay: true,
    autoPlayOnFinish: 'yes',        // 类型不符 → 忽略
    rate: 99,                        // 越界 → 钳到 10
    pitch: -3,                       // 越界 → 钳到 0
    volume: 0.5,
    maxSentences: 4.7,               // 整数化（四舍五入）
    voiceURI: '  zh-CN-Xiaoxiao  ',  // trim
    unknownKey: 123,                 // 白名单外 → 忽略
  })
  assert.equal(merged.autoPlay, true)
  assert.equal(merged.autoPlayOnFinish, true, '非法类型应保留原值')
  assert.equal(merged.rate, 10, 'rate 应钳进 [0.1,10]')
  assert.equal(merged.pitch, 0, 'pitch 应钳进 [0,2]')
  assert.equal(merged.volume, 0.5)
  assert.equal(merged.maxSentences, 5, '句数上限应四舍五入取整')
  assert.equal(merged.voiceURI, 'zh-CN-Xiaoxiao')
  assert.equal(merged.unknownKey, undefined, '白名单外字段不得写进配置')
  console.log('tts config merge: ok（白名单 + 类型校验 + 数值钳制 + 取整 + trim）')
}

// ---------- ③ /status 下发配置 + 追踪快照；/config 落盘 tts 段 ----------
{
  seedDockConfig({ tts: { autoPlay: false } })
  const mutates = []
  const { ctx, routes } = makeCtx({ mutates })
  const dispose = ttsFeature.setup(ctx)
  const status = await call(routes.get('/dsh-dock/tts'), '/dsh-dock/tts/status')
  assert.equal(status.status, 200)
  assert.ok(status.body.ok)
  assert.ok(status.body.data.config && typeof status.body.data.config.rate === 'number', '/status 应带 config 段')
  assert.ok(Array.isArray(status.body.data.recent), '/status 应带共享任务追踪的 recent（自动朗读的触发源）')
  assert.ok(Array.isArray(status.body.data.active), '/status 应带 active')

  const saved = await call(routes.get('/dsh-dock/tts'), '/dsh-dock/tts/config', 'POST', { autoPlay: true, rate: 1.4 })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.data.config.autoPlay, true)
  assert.equal(saved.body.data.config.rate, 1.4)
  assert.equal(mutates.length, 1, '保存应恰好写一次 settings')
  assert.equal(mutates[0].ns, 'dsh-dock')
  assert.deepEqual(mutates[0].ops[0].path, ['tts'], '必须只写 tts 段，不能碰别的段')
  assert.equal(mutates[0].ops[0].value.autoPlay, true)

  const missing = await call(routes.get('/dsh-dock/tts'), '/dsh-dock/tts/nope')
  assert.equal(missing.status, 404, '未知 method 应 404')
  if (typeof dispose === 'function') dispose()
  console.log('tts host rpc: ok（/status 带配置与追踪快照、/config 只写 tts 段、未知 method 404）')
}

console.log('tts host: 全部通过')
