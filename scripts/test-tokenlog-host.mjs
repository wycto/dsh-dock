/**
 * dsh-dock — 【用量记录】宿主半部「单价配置」回归测试（无外部依赖：node scripts/test-tokenlog-host.mjs）
 *
 * 背景：费用原来只有「官网抓取价 → 内置表 → 兜底」三级，且抓取价优先级最高；官网刊例与
 * 实际计费（第三方中转、折扣、自建端点）常有出入，用户改不了。本次新增「自定义单价」并
 * 持久化到 settings 的 dsh-dock.tokenlog 段，且优先级最高、费用在查询时按当前单价重算。
 *
 * 覆盖契约：
 *   1) 自定义单价优先于官网抓取价；清空后回落到官网价 → 内置价 → 兜底价；
 *   2) 改价后无需重扫历史，查询结果按新价重算（withCost）；
 *   3) setpricing 校验：空匹配 / '*' / 负单价一律 4xx 拒绝，不落盘；
 *   4) pricingUrl 出站前校验：本机/内网/保留地址或被禁协议时，不发起请求（SSRF 防护）；
 *   5) pricing 路由能读回当前生效配置（含 builtin/custom 列表与来源标注）。
 */
import assert from 'node:assert/strict'
import { feature as tokenlogFeature } from '../features/tokenlog/host.js'
import { DOCK_NS } from '../src/host-core.js'

const OFFICIAL_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>定价</title></head><body>
<h1>模型价格</h1><!-- padding so the parser's "SPA shell too small" guard (>500 bytes) does not skip this fixture -->
<p>以下为官方刊例价（人民币元 / 百万 tokens）。${'详细说明。'.repeat(120)}</p>
<table>
<tr><th>模型</th><th>缓存命中</th><th>缓存未命中</th><th>输出</th></tr>
<tr><td>deepseek-v4-flash</td><td>0.05</td><td>1.5</td><td>4.5</td></tr>
</table>
</body></html>`

// ---------- 宿主桩：settings（内存）+ webServer（路由槽）+ sessionQuery（事件总线） ----------
function makeHost(seedSettings) {
  const settingsStore = new Map()
  const routes = new Map() // path -> { handler, route }
  const sessionListeners = new Map()
  let mutateCount = 0
  if (seedSettings) settingsStore.set(DOCK_NS, JSON.parse(JSON.stringify(seedSettings)))

  const settings = {
    get(ns) {
      const v = settingsStore.get(ns)
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
    },
    async mutate(ns, ops) {
      mutateCount++
      const value = settingsStore.get(ns) ? JSON.parse(JSON.stringify(settingsStore.get(ns))) : {}
      for (const op of ops) {
        assert.equal(op.op, 'set')
        value[op.path[0]] = JSON.parse(JSON.stringify(op.value))
      }
      settingsStore.set(ns, value)
    },
  }

  const sessionQuery = {
    async listSessions() { return [] },
    async readSession() { return { events: [] } },
  }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      return undefined
    },
    inject(keys, callback) {
      const cleanups = []
      if (keys.includes('settings')) callback({ settings, effect: (run) => { const off = run(); cleanups.push(off); return off } })
      if (keys.includes('sessionQuery')) {
        const sqCtx = {
          sessionQuery,
          on(event, handler) {
            if (!sessionListeners.has(event)) sessionListeners.set(event, new Set())
            sessionListeners.get(event).add(handler)
            const off = () => sessionListeners.get(event).delete(handler)
            cleanups.push(off)
            return off
          },
          effect(run) { const off = run(); cleanups.push(off); return off },
        }
        callback(sqCtx)
      }
      if (keys.includes('webServer')) {
        const wsCtx = {
          webServer: {
            register(route) {
              routes.set(route.path, route)
              const off = () => routes.delete(route.path)
              cleanups.push(off)
              return off
            },
          },
          effect(run) { const off = run(); cleanups.push(off); return off },
        }
        callback(wsCtx)
      }
      return () => { for (const fn of cleanups.splice(0)) { try { if (typeof fn === 'function') fn() } catch { /* ignore */ } } }
    },
  }

  return {
    ctx, settings, routes,
    mutateCount: () => mutateCount,
    emit(event, ...args) {
      const set = sessionListeners.get(event)
      if (!set) return
      for (const handler of [...set]) handler(...args)
    },
    async call(method, payload = {}) {
      const route = routes.get('/dsh-dock/tokenlog')
      if (!route) throw new Error('route not registered: /dsh-dock/tokenlog')
      const handler = route.handler
      const listeners = { data: [], end: [], error: [] }
      const req = {
        url: '/dsh-dock/tokenlog/' + method,
        on(evt, cb) { (listeners[evt] || (listeners[evt] = [])).push(cb); return req },
      }
      const res = {
        status: 0, body: null,
        writeHead(status) { res.status = status; return res },
        end(text) { res.body = JSON.parse(text); return res },
      }
      const pending = handler(req, res)
      for (const cb of listeners.data) cb(Buffer.from(JSON.stringify(payload), 'utf8'))
      for (const cb of listeners.end) cb()
      await pending
      return { status: res.status, body: res.body }
    },
  }
}

/** 造一条 LLM 调用记录：request/header 定模型，step/start + assistant/message 出用量。 */
function emitCall(host, { sessionId, model, seq, time, input = 1_000_000, output = 1_000_000, cacheRead = 0, cacheWrite = 0 }) {
  host.emit('session/event', { id: sessionId }, {
    type: 'request/header', time, seq: seq, data: { header: { config: { provider: 'test', model } } },
  })
  host.emit('session/event', { id: sessionId }, { type: 'step/start', time: time - 1000, seq: seq + 1, data: { turn: 1, step: 1 } })
  host.emit('session/event', { id: sessionId }, {
    type: 'assistant/message', time, seq: seq + 2,
    data: { turn: 1, step: 1, usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, reasoningTokens: 0 } },
  })
}

const realFetch = globalThis.fetch
const fetchedUrls = []
globalThis.fetch = async (url) => {
  fetchedUrls.push(String(url))
  return { ok: true, status: 200, text: async () => OFFICIAL_HTML }
}
// 拦截定时器：启动时的抓取定时器不应让测试进程悬挂
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

try {
  // ---------- 用例 1：自定义单价优先于官网抓取价，且查询即时重算 ----------
  {
    const host = makeHost()
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 30)) // 等启动抓取完成（走桩 fetch）

    // 官网价：input 1.5 / output 4.5（CNY/百万 tokens）
    emitCall(host, { sessionId: 's1', model: 'deepseek-v4-flash', seq: 1, time: Date.now() })
    let q = (await host.call('query', {})).body.data
    assert.equal(q.records.length, 1, '应采集到 1 条记录')
    // 官网 1.5*1 + 4.5*1 = 6 CNY → USD = 6/7.2
    assert.ok(Math.abs(q.records[0].cost - 6 / 7.2) < 1e-9, '官网抓取价应生效')
    assert.equal(q.records[0].pricingSource, 'official', '来源应为官网')

    // 配置自定义单价：input 10 / output 20 → 30 CNY
    const saved = await host.call('setpricing', {
      usdCnyRate: 7.2, fetchOfficial: true,
      pricing: [{ match: 'deepseek-v4-flash', input: 10, output: 20, cacheRead: 0, cacheWrite: 0 }],
      fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    assert.equal(saved.status, 200, 'setpricing 应成功')
    assert.equal(saved.body.data.pricing.length, 1)

    // 关键：不重扫历史，查询即按新价重算
    q = (await host.call('query', {})).body.data
    assert.ok(Math.abs(q.records[0].cost - 30 / 7.2) < 1e-9, '自定义单价应生效且即时重算')
    assert.equal(q.records[0].pricingSource, 'custom', '来源应为自定义')
    assert.ok(Math.abs(q.totals.cost - 30 / 7.2) < 1e-9, '汇总金额也应重算')
    assert.equal(q.pricingInfo.hasCustom, true)
    assert.equal(q.pricingInfo.customCount, 1)

    // 清空自定义 → 回落官网价
    await host.call('setpricing', { pricing: [], fetchOfficial: true })
    q = (await host.call('query', {})).body.data
    assert.equal(q.records[0].pricingSource, 'official', '清空自定义后应回落官网价')

    // 关闭官网同步 + 清空自定义 → 内置表（deepseek-v4-flash 在内置表中）
    await host.call('setpricing', { pricing: [], fetchOfficial: false })
    q = (await host.call('query', {})).body.data
    assert.equal(q.records[0].pricingSource, 'builtin', '应回落到内置价')
    assert.ok(Math.abs(q.records[0].cost - (1.5 + 4.5) / 7.2) < 1e-9, '内置价 1.5/4.5 生效')

    // 未匹配模型 → 兜底价
    emitCall(host, { sessionId: 's2', model: 'some-unknown-model', seq: 10, time: Date.now() })
    q = (await host.call('query', { model: 'some-unknown-model' })).body.data
    assert.equal(q.records.length, 1)
    assert.equal(q.records[0].pricingSource, 'fallback', '未知模型应走兜底')

    dispose()
  }

  // ---------- 用例 3b：多段分时价（含跨零点、半点边界、旧单段 peak 兼容） ----------
  {
    const host = makeHost()
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 20))

    // 基准 input 100；分时段：00:00~08:30 优惠价 1；09:00~14:00 高价 5
    const saved = await host.call('setpricing', {
      usdCnyRate: 1, fetchOfficial: false,
      pricing: [{
        match: 'multi', input: 100, output: 100, cacheRead: 0, cacheWrite: 0,
        peaks: [
          { start: 0, end: 8.5, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          { start: 9, end: 14, input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
        ],
      }],
      fallback: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.data.pricing[0].peaks.length, 2, '应保留两段分时价（宿主不得合并/丢弃）')
    assert.equal(saved.body.data.pricing[0].peaks[0].end, 8.5, '半点边界（08:30）应原样保留，不被取整')

    const at = (h, m = 0) => new Date(2026, 0, 15, h, m, 0, 0).getTime()
    // 03:00 → 命中优惠段（1 CNY/百万）
    emitCall(host, { sessionId: 'm1', model: 'multi', seq: 1, time: at(3), input: 1_000_000, output: 0 })
    // 08:15 → 仍在优惠段（< 8.5）
    emitCall(host, { sessionId: 'm2', model: 'multi', seq: 1, time: at(8, 15), input: 1_000_000, output: 0 })
    // 08:45 → 已过 8.5，且未到 9 → 回落基准价 100
    emitCall(host, { sessionId: 'm3', model: 'multi', seq: 1, time: at(8, 45), input: 1_000_000, output: 0 })
    // 10:00 → 命中高价段（5）
    emitCall(host, { sessionId: 'm4', model: 'multi', seq: 1, time: at(10), input: 1_000_000, output: 0 })

    const bySid = {}
    for (const r of (await host.call('query', {})).body.data.records) bySid[r.sessionId] = r
    assert.ok(Math.abs(bySid['m1'].cost - 1) < 1e-9, '03:00 应用优惠段价 1')
    assert.ok(Math.abs(bySid['m2'].cost - 1) < 1e-9, '08:15 仍在优惠段')
    assert.ok(Math.abs(bySid['m3'].cost - 100) < 1e-9, '08:45 时段外应回落基准价 100')
    assert.ok(Math.abs(bySid['m4'].cost - 5) < 1e-9, '10:00 应用高价段 5')

    // 跨零点：23:00~07:00 一段价 7，覆盖 00:30（DeepSeek 优惠时段的形态）
    await host.call('setpricing', {
      pricing: [{
        match: 'night', input: 100, output: 100, cacheRead: 0, cacheWrite: 0,
        peaks: [{ start: 23, end: 7, input: 7, output: 7, cacheRead: 0, cacheWrite: 0 }],
      }],
    })
    emitCall(host, { sessionId: 'n1', model: 'night', seq: 1, time: at(2), input: 1_000_000, output: 0 })   // 段内（凌晨）
    emitCall(host, { sessionId: 'n2', model: 'night', seq: 1, time: at(23, 30), input: 1_000_000, output: 0 }) // 段内（深夜）
    emitCall(host, { sessionId: 'n3', model: 'night', seq: 1, time: at(12), input: 1_000_000, output: 0 })  // 段外
    const nightBySid = {}
    for (const r of (await host.call('query', { model: 'night' })).body.data.records) nightBySid[r.sessionId] = r
    assert.ok(Math.abs(nightBySid['n1'].cost - 7) < 1e-9, '跨零点段应覆盖凌晨 02:00')
    assert.ok(Math.abs(nightBySid['n2'].cost - 7) < 1e-9, '跨零点段应覆盖深夜 23:30')
    assert.ok(Math.abs(nightBySid['n3'].cost - 100) < 1e-9, '跨零点段外应回落基准价')

    dispose()
  }

  // ---------- 用例 3c：旧版单段 peak 数据在读取时归一到 peaks（向后兼容） ----------
  {
    const host = makeHost({
      tokenlog: {
        fetchOfficial: false, usdCnyRate: 1,
        pricing: [{ match: 'legacy', input: 100, output: 100, cacheRead: 0, cacheWrite: 0,
          peak: { start: 9, end: 14, input: 3, output: 3, cacheRead: 0, cacheWrite: 0 } }],
      },
    })
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 20))
    // 面板读回应已经把 peak 归一成 peaks 数组（前端只处理 peaks）
    const cfg = (await host.call('pricing', {})).body.data
    assert.equal(cfg.pricing.length, 1)
    assert.ok(Array.isArray(cfg.pricing[0].peaks) && cfg.pricing[0].peaks.length === 1, '旧 peak 应归一为单元素 peaks')

    const at = (h) => new Date(2026, 0, 15, h, 0, 0, 0).getTime()
    emitCall(host, { sessionId: 'L1', model: 'legacy', seq: 1, time: at(10), input: 1_000_000, output: 0 })
    emitCall(host, { sessionId: 'L2', model: 'legacy', seq: 1, time: at(20), input: 1_000_000, output: 0 })
    const bySid = {}
    for (const r of (await host.call('query', {})).body.data.records) bySid[r.sessionId] = r
    assert.ok(Math.abs(bySid['L1'].cost - 3) < 1e-9, '旧 peak 段内(10:00)应按段价 3')
    assert.ok(Math.abs(bySid['L2'].cost - 100) < 1e-9, '旧 peak 段外(20:00)应按基准价 100')
    dispose()
  }

  // ---------- 用例 3d：分时段参数非法时 4xx 拒绝 ----------
  {
    const host = makeHost()
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 20))
    const before = host.mutateCount()
    const bad = [
      { pricing: [{ match: 'x', input: 1, output: 1, peaks: [{ start: -1, end: 5, input: 1, output: 1 }] }], label: '时段起点负数' },
      { pricing: [{ match: 'x', input: 1, output: 1, peaks: [{ start: 1, end: 25, input: 1, output: 1 }] }], label: '时段终点超 24' },
      { pricing: [{ match: 'x', input: 1, output: 1, peaks: [{ start: 1, end: 5, input: -1, output: 1 }] }], label: '时段内负单价' },
      { pricing: [{ match: 'x', input: 1, output: 1, peaks: [{ start: 'a', end: 5, input: 1, output: 1 }] }], label: '时段时刻非数字' },
    ]
    for (const b of bad) {
      const r = await host.call('setpricing', b)
      assert.ok(r.status >= 400 && r.status < 500, b.label + ' 应被拒绝（4xx），实际 ' + r.status)
    }
    assert.equal(host.mutateCount(), before, '非法分时段配置不得落盘')
    dispose()
  }

  // ---------- 用例 4：pricing 路由读回生效配置 + 非法单价被拒 ----------
  {
    const host = makeHost()
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 20))

    const before = host.mutateCount()
    const bad = [
      { pricing: [{ match: '', input: 1, output: 1 }], label: '空匹配' },
      { pricing: [{ match: '*', input: 1, output: 1 }], label: '通配 *' },
      { pricing: [{ match: 'x', input: -1, output: 1 }], label: '负单价' },
      { usdCnyRate: 0, label: '汇率为 0' },
      { fallback: { input: -5, output: 0, cacheRead: 0, cacheWrite: 0 }, label: '负兜底价' },
    ]
    for (const b of bad) {
      const r = await host.call('setpricing', b)
      assert.ok(r.status >= 400 && r.status < 500, b.label + ' 应被拒绝（4xx），实际 ' + r.status)
    }
    assert.equal(host.mutateCount(), before, '非法输入不得落盘')

    const ok = await host.call('setpricing', {
      usdCnyRate: 7.5, fetchOfficial: false,
      pricing: [{ match: 'glm-4', input: 3, output: 9, cacheRead: 1, cacheWrite: 7 }],
      fallback: { input: 2, output: 6, cacheRead: 0.4, cacheWrite: 4 },
    })
    assert.equal(ok.status, 200)
    const cfg = ok.body.data
    assert.equal(cfg.usdCnyRate, 7.5)
    assert.equal(cfg.fetchOfficial, false)
    assert.equal(cfg.pricing[0].match, 'glm-4')
    assert.ok(Array.isArray(cfg.builtin) && cfg.builtin.length > 0, '应带回内置价表供面板展示')

    // pricing 路由读回同一份
    const read = (await host.call('pricing', {})).body.data
    assert.equal(read.usdCnyRate, 7.5)
    assert.equal(read.pricing.length, 1)
    assert.equal(read.fallback.input, 2)

    dispose()
  }

  // ---------- 用例 3：pricingUrl 出站前校验（SSRF 防护） ----------
  {
    // 本机/内网/保留地址 + 非 http(s) 协议：都不应发起 fetch
    const cases = [
      { url: 'http://127.0.0.1:9999/pricing', label: '环回' },
      { url: 'http://localhost/pricing', label: 'localhost' },
      { url: 'http://192.168.1.1/pricing', label: '私网 192.168' },
      { url: 'http://10.0.0.5/pricing', label: '私网 10.' },
      { url: 'http://169.254.1.1/pricing', label: 'link-local' },
      { url: 'file:///etc/passwd', label: 'file 协议' },
    ]
    for (const c of cases) {
      fetchedUrls.length = 0
      const host = makeHost({ tokenlog: { pricingUrl: c.url, fetchOfficial: true } })
      const dispose = tokenlogFeature.setup(host.ctx)
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(fetchedUrls.length, 0, c.label + '：不得对本机/内网/非法协议地址发起请求')
      dispose()
    }

    // 正常外网地址应发起抓取
    fetchedUrls.length = 0
    const host = makeHost({ tokenlog: { pricingUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing', fetchOfficial: true } })
    const dispose = tokenlogFeature.setup(host.ctx)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(fetchedUrls.length, 1, '合法 https 地址应发起一次抓取')
    dispose()
  }
} finally {
  globalThis.fetch = realFetch
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
}

console.log('tokenlog host: ok (自定义单价优先 + 查询即重算 + 参数校验 4xx + pricingUrl SSRF 防护)')
