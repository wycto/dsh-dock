/**
 * dsh-dock — 【任务动画】/【任务通知】宿主半部回归测试（无外部依赖：node scripts/test-task-notify-host.mjs）
 *
 * 覆盖把通知从任务动画拆出时的四个关键契约：
 *   1) 共享任务追踪（src/task-track.js）：两个功能都开只有一份会话事件订阅，逐个停用后正确退订；
 *   2) 两条路由各管自己的配置段：/dsh-dock/animation 只写 animation，/dsh-dock/notify 只写 notify；
 *   3) 任务结束时通知模块拿到完成记录并推送群机器人（钉钉/飞书事件筛选跟随 notifyOnComplete/notifyOnError）；
 *   4) 一次性迁移 migrateNotifyConfig：把老 animation 段里的通知配置搬进 notify 段，且只搬一次。
 */
import assert from 'node:assert/strict'
import { feature as animationFeature } from '../features/animation/host.js'
import { feature as notifyFeature } from '../features/notify/host.js'
import { migrateNotifyConfig, DOCK_NS } from '../src/host-core.js'

// ---------- 宿主桩：settings（内存）+ webServer（路由槽）+ sessionQuery（事件总线） ----------
function makeHost() {
  const settingsStore = new Map()
  const routes = new Map() // path -> handler
  const sessionListeners = new Map() // event -> Set(handler)
  let mutateCount = 0

  const settings = {
    get(ns) {
      const v = settingsStore.get(ns)
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
    },
    async mutate(ns, ops) {
      mutateCount++
      const value = settingsStore.get(ns) || {}
      for (const op of ops) {
        assert.equal(op.op, 'set')
        value[op.path[0]] = JSON.parse(JSON.stringify(op.value))
      }
      settingsStore.set(ns, value)
    },
  }

  const sessionQuery = {
    readTitle: async () => ({ title: '测试会话' }),
    readSession: async () => ({ header: { title: '测试会话' } }),
  }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      return undefined
    },
    inject(keys, callback) {
      const cleanups = []
      if (keys.includes('settings')) callback({ settings, effect: (run) => run() })
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
        }
        callback(sqCtx)
      }
      if (keys.includes('webServer')) {
        const wsCtx = {
          webServer: {
            register(route) {
              routes.set(route.path, route.handler)
              const off = () => routes.delete(route.path)
              cleanups.push(off)
              return off
            },
          },
          effect(run) { const off = run(); return off },
        }
        callback(wsCtx)
      }
      return () => { for (const fn of cleanups.splice(0)) fn() }
    },
  }

  return {
    ctx, settings, routes, sessionListeners,
    mutateCount: () => mutateCount,
    emit(event, ...args) {
      const set = sessionListeners.get(event)
      if (!set) return
      for (const handler of [...set]) handler(...args)
    },
    listenerCount(event) { return (sessionListeners.get(event) || new Set()).size },
    async call(path, method, payload = {}) {
      const handler = routes.get(path)
      if (!handler) throw new Error('route not registered: ' + path)
      // 最小 req/res 桩：readBody 在 handler 同步段里就完成订阅，之后手动派发 data/end
      const listeners = { data: [], end: [], error: [] }
      const req = {
        url: path + '/' + method,
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

// ---------- 用例 1：共享追踪 + 两条路由各自的配置段 ----------
const host = makeHost()
const disposeAnimation = animationFeature.setup(host.ctx)
assert.equal(host.listenerCount('session/event'), 1, '动画模块必须订阅会话事件')
const disposeNotify = notifyFeature.setup(host.ctx)
assert.equal(host.listenerCount('session/event'), 1, '两个模块共用一份追踪：会话事件只能订阅一次')
assert.ok(host.routes.has('/dsh-dock/animation'), '/dsh-dock/animation 路由应注册')
assert.ok(host.routes.has('/dsh-dock/notify'), '/dsh-dock/notify 路由应注册')

// 会话开始：agent/status running + 一条 tool/call
host.emit('agent/status', { agent: { id: 'sess-1', options: { model: 'deepseek-chat', provider: 'deepseek' } }, status: 'running' })
host.emit('session/event', { id: 'sess-1' }, { type: 'tool/call', time: Date.now(), data: { name: 'bash' } })

const animStatus = (await host.call('/dsh-dock/animation', 'status')).body.data
const notifyStatus = (await host.call('/dsh-dock/notify', 'status')).body.data
assert.equal(animStatus.active.length, 1)
assert.equal(notifyStatus.active.length, 1)
assert.equal(animStatus.active[0].sessionId, 'sess-1')
assert.equal(animStatus.active[0].toolCalls, 1, '共享追踪应累计工具调用')
assert.equal(notifyStatus.active[0].phase, 'code', '工具阶段应共享到通知模块')
assert.equal(animStatus.config.effectMode, 'flow', '动画配置默认值')
assert.equal(notifyStatus.config.notifyStayMs, 8000, '通知配置默认值')
assert.equal(animStatus.config.dingtalkEnabled, undefined, '动画配置段不得混入通知字段')

// 配置写入：各自只认自己的字段
{
  const saved = await host.call('/dsh-dock/animation', 'config', { effectMode: 'stars', dingtalkEnabled: true, notifyStayMs: 15000 })
  assert.equal(saved.body.data.config.effectMode, 'stars')
  assert.equal(saved.body.data.config.dingtalkEnabled, undefined, '动画路由必须忽略通知字段')
  const raw = host.settings.get(DOCK_NS)
  assert.equal(raw.animation.effectMode, 'stars')
  assert.equal(raw.notify, undefined, '动画保存不得写 notify 段')
}
{
  const saved = await host.call('/dsh-dock/notify', 'config', {
    notifyOnError: false, soundEffect: 'bell', dingtalkEnabled: true,
    dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
  })
  assert.equal(saved.body.data.config.notifyOnError, false)
  assert.equal(saved.body.data.config.soundEffect, 'bell')
  assert.equal(saved.body.data.config.effectMode, undefined, '通知路由必须忽略动画字段')
  const raw = host.settings.get(DOCK_NS)
  assert.equal(raw.notify.dingtalkEnabled, true)
  assert.equal(raw.animation.dingtalkEnabled, undefined)
  assert.equal(raw.animation.effectMode, 'stars', '通知保存不得覆盖动画段')
}
{
  // 下面两条是「预期失败」的请求：宿主会照常 console.error，这里临时静音保持输出干净
  const realError = console.error
  console.error = () => {}
  try {
    // Webhook 校验：非 http(s) 地址必须 400，而不是静默存下
    const bad = await host.call('/dsh-dock/notify', 'config', { feishuWebhook: 'not-a-url' })
    assert.equal(bad.status, 400)
    assert.match(bad.body.error.message, /http\(s\):\/\//)
    // 未填 Webhook 就发测试消息 → 400 提示
    const test = await host.call('/dsh-dock/notify', 'test', { target: 'feishu' })
    assert.equal(test.status, 400)
    assert.match(test.body.error.message, /请先填写并保存飞书 Webhook/)
  } finally {
    console.error = realError
  }
}

// ---------- 用例 2：任务结束 → 共享归档 + 群机器人推送（事件筛选跟随开关） ----------
const pushed = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  pushed.push({ url, body: JSON.parse(init.body) })
  return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0 }) }
}
try {
  host.emit('agent/status', { agent: { id: 'sess-1' }, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 20)) // 推送是异步的
  const afterAnim = (await host.call('/dsh-dock/animation', 'status')).body.data
  const afterNotify = (await host.call('/dsh-dock/notify', 'status')).body.data
  assert.equal(afterAnim.active.length, 0, '任务结束后活跃列表应清空')
  assert.equal(afterAnim.recent.length, 1, '完成记录应进入最近完成')
  assert.equal(afterNotify.recent[0].sessionId, 'sess-1', '两个模块共享同一份完成记录')
  assert.equal(pushed.length, 1, '钉钉推送应发出一次')
  assert.match(pushed[0].url, /oapi\.dingtalk\.com/)
  assert.match(pushed[0].body.markdown.text, /sess|任务完成|任务结束/, '推送正文应含任务信息')

  // notifyOnError=false：异常结束不推送（事件筛选跟随开关）
  await host.call('/dsh-dock/notify', 'config', { notifyOnError: false })
  host.emit('agent/status', { agent: { id: 'sess-2' }, status: 'running' })
  host.emit('session/event', { id: 'sess-2' }, {
    type: 'turn/end', time: Date.now(), data: { reason: { kind: 'error', error: { message: 'boom' } } },
  })
  host.emit('agent/status', { agent: { id: 'sess-2' }, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pushed.length, 1, 'notifyOnError=false 时异常结束不应推送')
} finally {
  globalThis.fetch = realFetch
}

// ---------- 用例 3：引用计数——逐个停用后追踪才退订 ----------
disposeAnimation()
assert.equal(host.listenerCount('session/event'), 1, '动画停用后通知仍需要追踪')
assert.equal(host.routes.has('/dsh-dock/animation'), false, '动画停用后其路由应注销')
assert.ok(host.routes.has('/dsh-dock/notify'), '通知路由不受动画停用影响')
host.emit('agent/status', { agent: { id: 'sess-3' }, status: 'running' })
assert.equal((await host.call('/dsh-dock/notify', 'status')).body.data.active.length, 1, '通知模块单独运行时仍能追踪任务')
disposeNotify()
assert.equal(host.listenerCount('session/event'), 0, '两个模块都停用后必须退订会话事件')
assert.equal(host.routes.has('/dsh-dock/notify'), false, '通知停用后其路由应注销')

// ---------- 用例 4：一次性迁移（老 animation 段的通知配置搬进 notify 段） ----------
{
  const legacy = makeHost()
  legacy.settings.get(DOCK_NS) // 触发内存段初始化（undefined）
  await legacy.settings.mutate(DOCK_NS, [{
    op: 'set', path: ['animation'], value: {
      animationEnabled: true, effectMode: 'robot', robotScale: 1.7,
      notifyEnabled: true, notifyOnComplete: false, notifyOnError: true, notifyOnConfirm: false,
      notifyStayMs: 15000, systemNotify: true, soundNotify: false, soundEffect: 'bell',
      dingtalkEnabled: true, dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=legacy',
      feishuEnabled: true, feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy',
    },
  }])
  const before = legacy.mutateCount()
  await migrateNotifyConfig(legacy.ctx)
  const after = legacy.settings.get(DOCK_NS)
  assert.equal(legacy.mutateCount(), before + 1, '迁移应写一次 notify 段')
  assert.equal(after.notify.migratedFromAnimation, true)
  assert.equal(after.notify.notifyOnComplete, false, '旧完成通知开关应保留')
  assert.equal(after.notify.notifyOnConfirm, false, '旧需确认开关应保留')
  assert.equal(after.notify.notifyStayMs, 15000)
  assert.equal(after.notify.systemNotify, true)
  assert.equal(after.notify.soundNotify, false)
  assert.equal(after.notify.soundEffect, 'bell')
  assert.equal(after.notify.dingtalkEnabled, true)
  assert.equal(after.notify.dingtalkWebhook, 'https://oapi.dingtalk.com/robot/send?access_token=legacy')
  assert.equal(after.notify.feishuWebhook, 'https://open.feishu.cn/open-apis/bot/v2/hook/legacy')
  assert.equal(after.animation.effectMode, 'robot', '动画段本身不受影响')

  // 第二次调用：标记已置位，不再写 settings（避免每次启动都写盘）
  const before2 = legacy.mutateCount()
  await migrateNotifyConfig(legacy.ctx)
  assert.equal(legacy.mutateCount(), before2, '迁移标记置位后不得重复写')
}

// ---------- 用例 5：全新安装（没有旧 animation 段）不写盘、不置标记 ----------
// 这条防的是「settings 命名空间尚未生效时读到空值 → 误把空迁移当完成」导致旧配置丢失。
{
  const fresh = makeHost()
  const before = fresh.mutateCount()
  await migrateNotifyConfig(fresh.ctx)
  assert.equal(fresh.mutateCount(), before, '没有旧配置可搬时不得写 settings')
  assert.equal(fresh.settings.get(DOCK_NS), undefined, '不应凭空创建 notify 段')
}

console.log('task/notify host: ok (共享追踪 1 份订阅 + 双路由配置隔离 + 群机器人推送 + 一次性迁移)')
