/**
 * dsh-dock — 【任务动画】/【任务通知】/【运行状态】宿主半部回归测试（无外部依赖：node scripts/test-task-host.mjs）
 *
 * 覆盖从任务动画里拆出功能模块时的关键契约：
 *   1) 共享任务追踪（src/task-track.js）：三个功能都开只有一份会话事件订阅，逐个停用后正确退订；
 *   2) 配置路由各管自己的段：/dsh-dock/animation 只写 animation，/dsh-dock/notify 只写 notify；
 *      /dsh-dock/runstate 只读（没有任何配置方法，也不写 settings）；
 *   3) 任务结束时通知模块拿到完成记录并推送群机器人（钉钉/飞书事件筛选跟随 notifyOnComplete/notifyOnError）；
 *   4) 一次性迁移 migrateNotifyConfig：把老 animation 段里的通知配置搬进 notify 段，且只搬一次。
 */
import assert from 'node:assert/strict'
import { feature as animationFeature } from '../features/animation/host.js'
import { feature as notifyFeature } from '../features/notify/host.js'
import { feature as runStateFeature } from '../features/runstate/host.js'
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
    // 一次观测同时给标题与会话头（SessionHeader.origin/delegationDepth/parentSession
    // 是判定「主任务/子任务」的权威字段；sub 开头的会话 id 模拟子代理会话）
    readTitleSnapshot: async (id) => ({
      session: /^sub/.test(id)
        ? { title: '测试会话', origin: 'subagent', delegationDepth: 1, parentSession: 'root-1' }
        : { title: '测试会话' },
      title: { title: '测试会话' },
    }),
  }

  const ctx = {
    get(name) {
      if (name === 'settings') return settings
      // 浏览器信任栅栏：webServer 路由入口的守卫（rejectUntrustedRequest）先问它；
      // undefined = 放行（测试桩一律视为「受信且已登录」）。
      if (name === 'connection') return { requestRejection: () => undefined }
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

// ---------- 用例 1：共享追踪 + 各路由自己的配置段 ----------
const host = makeHost()
const disposeAnimation = animationFeature.setup(host.ctx)
assert.equal(host.listenerCount('session/event'), 1, '动画模块必须订阅会话事件')
const disposeNotify = notifyFeature.setup(host.ctx)
assert.equal(host.listenerCount('session/event'), 1, '两个模块共用一份追踪：会话事件只能订阅一次')
const disposeRunState = runStateFeature.setup(host.ctx)
assert.equal(host.listenerCount('session/event'), 1, '三个模块共用一份追踪：会话事件仍只能订阅一次')
assert.ok(host.routes.has('/dsh-dock/animation'), '/dsh-dock/animation 路由应注册')
assert.ok(host.routes.has('/dsh-dock/notify'), '/dsh-dock/notify 路由应注册')
assert.ok(host.routes.has('/dsh-dock/runstate'), '/dsh-dock/runstate 路由应注册')

// 会话开始：agent/status running + 一条 tool/call
host.emit('agent/status', { agent: { id: 'sess-1', options: { model: 'deepseek-chat', provider: 'deepseek' } }, status: 'running' })
host.emit('session/event', { id: 'sess-1' }, { type: 'tool/call', time: Date.now(), data: { name: 'bash' } })

const animStatus = (await host.call('/dsh-dock/animation', 'status')).body.data
const notifyStatus = (await host.call('/dsh-dock/notify', 'status')).body.data
const runStateStatus = (await host.call('/dsh-dock/runstate', 'status')).body.data
assert.equal(animStatus.active.length, 1)
assert.equal(notifyStatus.active.length, 1)
assert.equal(runStateStatus.active.length, 1, '运行状态模块应拿到同一份活跃任务')
assert.equal(animStatus.active[0].sessionId, 'sess-1')
assert.equal(runStateStatus.active[0].sessionId, 'sess-1')
assert.equal(animStatus.active[0].toolCalls, 1, '共享追踪应累计工具调用')
assert.equal(notifyStatus.active[0].phase, 'code', '工具阶段应共享到通知模块')
assert.equal(runStateStatus.active[0].phase, 'code', '工具阶段应共享到运行状态模块')
assert.equal(animStatus.config.effectMode, 'flow', '动画配置默认值')
assert.equal(notifyStatus.config.notifyStayMs, 8000, '通知配置默认值')
assert.equal(notifyStatus.config.notifyCards, true, '页内卡片总开关默认开')
assert.equal(notifyStatus.config.notifyOnStuck, true, '卡住提醒卡默认开')
assert.equal(notifyStatus.config.cardMode, 'detailed', '卡片口径默认详细（历史内容不缩水）')
assert.equal(notifyStatus.config.voiceMode, 'brief', '播报口径默认简洁')
assert.equal(notifyStatus.config.pushMode, 'detailed', '群机器人消息口径默认详细')
assert.deepEqual(notifyStatus.config.eventMatrix, {}, '事件矩阵默认空（全部回退旧字段）')
assert.equal(animStatus.config.dingtalkEnabled, undefined, '动画配置段不得混入通知字段')
assert.equal(runStateStatus.config, undefined, '运行状态模块没有配置段（只读快照）')

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
    notifyCards: false, notifyOnStuck: false, cardMode: 'medium',
    voiceNotify: true, voiceMode: 'detailed', voiceOnStuck: false, voiceRate: 3, voiceVolume: -2,
    voiceURI: '  zh-CN-Xiaoxiao  ',
    dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
    pushMode: 'medium',
    eventMatrix: { 'card:complete': false, 'sound:error': true, 'bogus:key': true, 'voice:stuck': 'x' },
  })
  assert.equal(saved.body.data.config.notifyOnError, false)
  // 页内卡片总开关 + 卡住提醒卡：布尔收下、回包带回、落 notify 段
  assert.equal(saved.body.data.config.notifyCards, false, '页内卡片总开关应接受并回传')
  assert.equal(saved.body.data.config.notifyOnStuck, false, '卡住提醒开关应接受并回传')
  assert.equal(saved.body.data.config.cardMode, 'medium', '卡片口径三挡应接受并回传')
  assert.equal(saved.body.data.config.soundEffect, 'bell')
  assert.equal(saved.body.data.config.effectMode, undefined, '通知路由必须忽略动画字段')
  // 语音播报字段：布尔/枚举收下，数值越界钳制（rate 面板上限 2，volume 夹进 [0,1]）
  assert.equal(saved.body.data.config.voiceNotify, true)
  assert.equal(saved.body.data.config.voiceMode, 'detailed')
  assert.equal(saved.body.data.config.voiceOnStuck, false)
  assert.equal(saved.body.data.config.voiceRate, 2, 'voiceRate 越界应钳到上限 2')
  assert.equal(saved.body.data.config.voiceVolume, 0, 'voiceVolume 越界应钳到下限 0')
  assert.equal(saved.body.data.config.voiceURI, 'zh-CN-Xiaoxiao', 'voiceURI 应 trim 后落盘（音色可选）')
  assert.equal(saved.body.data.config.pushMode, 'medium', '群机器人消息口径应接受并回传')
  assert.equal(saved.body.data.config.eventMatrix['card:complete'], false, '事件矩阵布尔值应接受')
  assert.equal(saved.body.data.config.eventMatrix['sound:error'], true, '事件矩阵布尔值应接受')
  assert.equal(saved.body.data.config.eventMatrix['bogus:key'], undefined, '事件矩阵白名单外的键应忽略')
  assert.equal(saved.body.data.config.eventMatrix['voice:stuck'], undefined, '事件矩阵非布尔值应忽略')
  const raw = host.settings.get(DOCK_NS)
  assert.equal(raw.notify.dingtalkEnabled, true)
  assert.equal(raw.notify.notifyCards, false, '页内卡片总开关应落 notify 段')
  assert.equal(raw.notify.notifyOnStuck, false, '卡住提醒开关应落 notify 段')
  assert.equal(raw.notify.cardMode, 'medium', '卡片口径应落 notify 段')
  assert.equal(raw.notify.pushMode, 'medium', '群机器人消息口径应落 notify 段')
  assert.equal(raw.notify.eventMatrix['card:complete'], false, '事件矩阵应落 notify 段')
  assert.equal(raw.notify.voiceNotify, true, '语音播报开关应落 notify 段')
  assert.equal(raw.notify.voiceURI, 'zh-CN-Xiaoxiao', '音色应落 notify 段')
  assert.equal(raw.animation.dingtalkEnabled, undefined)
  assert.equal(raw.animation.effectMode, 'stars', '通知保存不得覆盖动画段')
}
{
  // 口径字段的非法值：忽略（保持已存值），不报错也不写坏配置
  const junk = await host.call('/dsh-dock/notify', 'config', { cardMode: 'huge', voiceMode: 'loud' })
  assert.equal(junk.status, 200)
  assert.equal(junk.body.data.config.cardMode, 'medium', '非法卡片口径应被忽略')
  assert.equal(junk.body.data.config.voiceMode, 'detailed', '非法播报口径应被忽略')
}
{
  // 下面三条是「预期失败」的请求：宿主会照常 console.error，这里临时静音保持输出干净
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
    // 运行状态模块只读：没有任何配置方法（连 config 都 404），也不可能写 settings
    const before = host.mutateCount()
    const noCfg = await host.call('/dsh-dock/runstate', 'config', { anything: true })
    assert.equal(noCfg.status, 404, '运行状态模块不应有 config 方法')
    assert.equal(host.mutateCount(), before, '运行状态模块不得写 settings')
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
  const afterRunState = (await host.call('/dsh-dock/runstate', 'status')).body.data
  assert.equal(afterAnim.active.length, 0, '任务结束后活跃列表应清空')
  assert.equal(afterAnim.recent.length, 1, '完成记录应进入最近完成')
  assert.equal(afterNotify.recent[0].sessionId, 'sess-1', '两个模块共享同一份完成记录')
  assert.equal(afterRunState.recent[0].sessionId, 'sess-1', '运行状态模块共享同一份完成记录')
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

  // eventMatrix：显式关闭「完成 → 钉钉」后，即使 notifyOnComplete=true 也不推送
  await host.call('/dsh-dock/notify', 'config', { notifyOnError: true, eventMatrix: { 'dingtalk:complete': false } })
  host.emit('agent/status', { agent: { id: 'sess-m1' }, status: 'running' })
  host.emit('session/event', { id: 'sess-m1' }, {
    type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } },
  })
  host.emit('agent/status', { agent: { id: 'sess-m1' }, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pushed.length, 1, 'eventMatrix dingtalk:complete=false 时不应推送')

  // 矩阵重新打开 + pushMode=brief：应推送，且正文裁剪掉模型 / 回合 / Token 明细
  await host.call('/dsh-dock/notify', 'config', { eventMatrix: { 'dingtalk:complete': true }, pushMode: 'brief' })
  host.emit('agent/status', { agent: { id: 'sess-m2' }, status: 'running' })
  host.emit('session/event', { id: 'sess-m2' }, {
    type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } },
  })
  host.emit('agent/status', { agent: { id: 'sess-m2' }, status: 'idle' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(pushed.length, 2, '矩阵重新打开后完成事件应推送')
  const briefText = pushed[1].body.markdown.text
  assert.ok(!briefText.includes('**模型**'), 'pushMode=brief 不应带模型明细')
  assert.ok(!briefText.includes('**回合**'), 'pushMode=brief 不应带回合明细')
  assert.ok(!briefText.includes('**Token**'), 'pushMode=brief 不应带 Token 明细')
} finally {
  globalThis.fetch = realFetch
}
// ---------- 用例 3：引用计数——逐个停用后追踪才退订 ----------
disposeAnimation()
assert.equal(host.listenerCount('session/event'), 1, '动画停用后通知/运行状态仍需要追踪')
assert.equal(host.routes.has('/dsh-dock/animation'), false, '动画停用后其路由应注销')
assert.ok(host.routes.has('/dsh-dock/notify'), '通知路由不受动画停用影响')
host.emit('agent/status', { agent: { id: 'sess-3' }, status: 'running' })
assert.equal((await host.call('/dsh-dock/notify', 'status')).body.data.active.length, 1, '通知模块单独运行时仍能追踪任务')
disposeNotify()
assert.equal(host.listenerCount('session/event'), 1, '通知停用后运行状态仍需要追踪')
assert.equal(host.routes.has('/dsh-dock/notify'), false, '通知停用后其路由应注销')
assert.equal((await host.call('/dsh-dock/runstate', 'status')).body.data.active.length, 1, '运行状态模块单独运行时仍能追踪任务')
disposeRunState()
assert.equal(host.listenerCount('session/event'), 0, '三个模块都停用后必须退订会话事件')
assert.equal(host.routes.has('/dsh-dock/runstate'), false, '运行状态停用后其路由应注销')

// ---------- 用例 2b：PTC（run_code）长时子调用不当作卡住 + PTC 内 ask_user_question 挂起 ----------
// 真实会话（2026-11-06）里 run_code（Programmatic Tool Calling）一个工具就包住若干子调用：
// wait_agent 等子代理最长 600s、job_output 等后台任务 188s、ask_user_question 等用户 120s，
// 期间本会话零事件。此前只按外层 run_code 的「在飞调用」180s 上限判，超过就误报「卡住」，
// 任务随后却正常完成（用户反馈「完成了却报卡住」）。这里锁死追踪快照如实标出 PTC 程序在忙。
{
  const h = makeHost()
  const dNotify = notifyFeature.setup(h.ctx)
  try {
    h.emit('agent/status', { agent: { id: 'sess-ptc' }, status: 'running' })
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/call', time: Date.now(), data: { name: 'run_code', callId: 'c1' } })
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/ptc-dispatch-start', time: Date.now(), data: { name: 'wait_agent', subCallId: 'c1:ptc:1', arguments: { timeout_ms: 600000 } } })
    let st = (await h.call('/dsh-dock/notify', 'status')).body.data
    assert.equal(st.active.length, 1)
    assert.equal(st.active[0].ptcProgram, true, 'run_code 子调用期间应标记 PTC 程序在忙（卡住判定据此豁免）')
    assert.equal(st.active[0].ptcTool, 'wait_agent', '应记录当前 PTC 子调用名')
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/ptc-dispatch', time: Date.now(), data: { name: 'wait_agent', subCallId: 'c1:ptc:1' } })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    assert.equal(st.active[0].ptcTool, '', '子调用结束后清掉当前子调用名')
    assert.equal(st.active[0].ptcProgram, true, '子调用结束但程序仍在（可能还有后续子调用）')
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/result', time: Date.now(), data: { message: { toolCallId: 'c1', toolName: 'run_code' } } })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    assert.equal(st.active[0].ptcProgram, false, 'run_code 整体落地后清掉 PTC 忙标记')
    // PTC 内的 ask_user_question 也要进 questions（客户端弹「需回答」而不是「卡住」）
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/call', time: Date.now(), data: { name: 'run_code', callId: 'c2' } })
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/ptc-dispatch-start', time: Date.now(), data: { name: 'ask_user_question', subCallId: 'c2:ptc:1', arguments: { questions: [{ id: 'q1', header: '总开关层级', question: '选哪个层级？' }] } } })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    assert.equal(st.active[0].questions.length, 1, 'PTC 内 ask_user_question 应进入「提问挂起」')
    assert.equal(st.active[0].questions[0].header, '总开关层级')
    h.emit('session/event', { id: 'sess-ptc' }, { type: 'tool/ptc-dispatch', time: Date.now(), data: { name: 'ask_user_question', subCallId: 'c2:ptc:1' } })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    assert.equal(st.active[0].questions.length, 0, '提问回答落地后应移除挂起项')
    console.log('PTC host: ok（run_code 子调用标记在忙 + ask_user_question 挂起/恢复）')
  } finally {
    dNotify()
  }
}

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

// ---------- 用例 6：一次性迁移（宿主功能 id 旧键 models → modelconfig） ----------
// 真实事故：宿主【模型设置】id 曾叫 models、客户端叫 modelconfig，面板开关 POST 永远
// 404 被静默吞掉，宿主半部从不 setup → 目录接口整片 404。id 已改齐，这里锁死旧键迁移。
{
  const { migrateModelsFeatureId } = await import('../src/host-core.js')
  const legacy = makeHost()
  await legacy.settings.mutate(DOCK_NS, [{
    op: 'set', path: ['features'], value: { balance: true, models: true },
  }])
  const before = legacy.mutateCount()
  await migrateModelsFeatureId(legacy.ctx)
  const after = legacy.settings.get(DOCK_NS)
  assert.equal(legacy.mutateCount(), before + 1, '迁移应写一次 features 段')
  assert.equal(after.features.modelconfig, true, '旧 models 键的值应继承到 modelconfig')
  assert.equal(after.features.models, undefined, '旧 models 键应删除')
  assert.equal(after.features.balance, true, '其余功能开关不受影响')

  // 第二次调用：旧键已删，幂等早退，不重复写
  const before2 = legacy.mutateCount()
  await migrateModelsFeatureId(legacy.ctx)
  assert.equal(legacy.mutateCount(), before2, '迁移完成后不得重复写')

  // 新键已存在时不覆盖（多设备/手工配置优先）
  const both = makeHost()
  await both.settings.mutate(DOCK_NS, [{
    op: 'set', path: ['features'], value: { models: false, modelconfig: true },
  }])
  const before3 = both.mutateCount()
  await migrateModelsFeatureId(both.ctx)
  assert.equal(both.mutateCount(), before3, '新键已存在时不得写 settings')
  assert.equal(both.settings.get(DOCK_NS).features.modelconfig, true, '新键原值保留')
}

// ---------- 用例 7：卡住播报要用的快照字段——主/子任务归属（会话头）+ 最后动作 ----------
// 用户实测（2026-10-30）：主任务进行中突然播「任务卡住了」，屏幕上却看不到卡住的东西——
// 卡的是子任务会话，而播报完全不带身份。归属与最后动作由 task-track 从会话头
// （origin/delegationDepth/parentSession）与 tool/call 事件里取，这里锁死它们进快照。
{
  const h = makeHost()
  const dispose = notifyFeature.setup(h.ctx)
  try {
    h.emit('agent/status', { agent: { id: 'root-1' }, status: 'running' })
    h.emit('session/event', { id: 'root-1' }, { type: 'tool/call', time: Date.now(), data: { name: 'bash' } })
    h.emit('agent/status', { agent: { id: 'sub-1' }, status: 'running' })
    h.emit('session/event', { id: 'sub-1' }, { type: 'tool/call', time: Date.now(), data: { name: 'pwsh' } })
    await new Promise((resolve) => setTimeout(resolve, 20)) // 标题/会话头是异步读取
    const st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const root = st.active.find((x) => x.sessionId === 'root-1')
    const sub = st.active.find((x) => x.sessionId === 'sub-1')
    assert.ok(root && sub, '主/子两个会话都应被追踪')
    assert.equal(root.isSubtask, false, '根会话不得标成子任务')
    assert.equal(root.lastToolName, 'bash', '最后调用的工具名应进快照（卡住卡「最后动作」用）')
    assert.equal(sub.isSubtask, true, '会话头 origin=subagent / delegationDepth>0 应标为子任务')
    assert.equal(sub.parentSessionId, 'root-1', '父会话 id 应进快照（子任务卡跳转回退到主会话）')
    assert.equal(sub.lastToolName, 'pwsh', '子任务的最后动作也应进快照')
    // 桩没给会话头（旧宿主/只实现 readTitle 的桩）：不崩、按主任务处理
    assert.equal(sub.title, '测试会话', '标题仍应正常读到')
  } finally {
    dispose()
    assert.equal(h.listenerCount('session/event'), 0, '用例收尾必须退订（不留常驻监听）')
  }
}

// ---------- 用例 8：提问挂起（ask_user_question）要进快照，答完即出 ----------
// 真实事故（2026-11-01 用户反馈）：会话调 ask_user_question 后挂起等人选答案，
// 界面显示提问表单的同时，任务通知却播「主任务卡住了」并弹卡。根因是宿主追踪只把
// approval/asked 记成「等人」，提问不算——提问期间会话零事件（实测挂起 66 秒一条事件
// 都没有），18 秒安静就被卡住判定当成停滞。这里锁死：提问进 questions、答完移出，
// 且 questions 与 approvals 是**两条独立通道**（别互相覆盖）。
{
  const h = makeHost()
  const dispose = notifyFeature.setup(h.ctx)
  try {
    h.emit('agent/status', { agent: { id: 'q-1' }, status: 'running' })
    // 提问发出：参数里带 header / question / 多问
    h.emit('session/event', { id: 'q-1' }, {
      type: 'tool/call',
      time: Date.now(),
      data: {
        name: 'ask_user_question',
        callId: 'call_q1',
        arguments: JSON.stringify({
          questions: [
            { id: 'trust', header: '是否自动信任证书', question: '「自动安装证书」到什么程度？' },
            { id: 'default', header: '默认值', question: '脚本模式默认开还是关？' },
          ],
        }),
      },
    })
    let st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const q = st.active.find((x) => x.sessionId === 'q-1')
    assert.ok(q, '会话应被追踪')
    assert.equal(q.questions.length, 1, '挂起的提问应进快照（否则客户端无法判定「在等人」）')
    assert.equal(q.questions[0].id, 'call_q1', '提问以 callId 为键（回答落地时按它移除）')
    assert.equal(q.questions[0].header, '是否自动信任证书', '提问标题应进快照（卡片/播报要点名问什么）')
    assert.equal(q.questions[0].question, '「自动安装证书」到什么程度？', '问题正文应进快照')
    assert.equal(q.questions[0].count, 2, '同一批问了几问要能读到（「共 2 个问题」用）')
    // 未挂提问时字段照样在（客户端对老宿主/新宿主一套读取代码，不能因字段缺失崩）
    assert.equal(q.approvals.length, 0, '提问不应污染 approvals 通道')

    // 回答落地（tool/result）→ 提问移出
    h.emit('session/event', { id: 'q-1' }, {
      type: 'tool/result',
      time: Date.now(),
      data: { message: { toolCallId: 'call_q1', content: [{ type: 'text', text: '{"answers":[]}' }] } },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const q2 = st.active.find((x) => x.sessionId === 'q-1')
    assert.equal(q2.questions.length, 0, '回答落地后提问应移出快照（卡片随之收起）')

    // 参数不是合法 JSON：不崩、仍按「有一问在等人答」记（宁可少说一句，不要整条追踪崩）
    h.emit('session/event', { id: 'q-1' }, {
      type: 'tool/call', time: Date.now(),
      data: { name: 'ask_user_question', callId: 'call_q2', arguments: '{坏掉的 json' },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const q3 = st.active.find((x) => x.sessionId === 'q-1')
    assert.equal(q3.questions.length, 1, '参数解析失败也要记下「在等人」（解析异常不得打断追踪）')
    assert.equal(q3.questions[0].header, '', '解析失败时摘要留空，由客户端兜底')
  } finally {
    dispose()
    assert.equal(h.listenerCount('session/event'), 0, '用例收尾必须退订（不留常驻监听）')
  }
}

// ---------- 用例 9：压缩上下文 / 在飞调用要进快照（卡住判定的豁免信号） ----------
// 真实事故（2026-11-02 用户反馈）：界面明明在刷「思考中 / 运行命令 / 上下文已压缩」，
// 任务通知却反复弹「主任务卡住了」。拿实测会话（25 分钟 316 个事件）逐条回放：
// 25 次 ≥18 秒的停顿里 18 次落在 compaction/start → compaction/end 之间（最长 96.7 秒），
// 工具调用从发出到返回最长只有 7.5 秒。压缩期间会话零事件，但那是**正在干活**。
// 这里锁死：压缩窗口内置 compacting=true、结束后清除；在飞调用置 pendingTool、落地后清除。
{
  const h = makeHost()
  const dispose = notifyFeature.setup(h.ctx)
  try {
    h.emit('agent/status', { agent: { id: 'c-1' }, status: 'running' })
    h.emit('session/event', { id: 'c-1' }, { type: 'tool/call', time: Date.now(), data: { name: 'bash' } })
    let st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c0 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c0.pendingTool, 'bash', '在飞的工具调用应进快照（长命令期间靠它别误报卡住）')
    assert.ok(c0.toolStartedAt > 0, '在飞调用的起始时间应进快照（真挂死要能按上限报出来）')
    assert.equal(c0.compacting, false, '未压缩时 compacting 应为 false')

    // 调用落地 → 不再有在飞调用
    h.emit('session/event', { id: 'c-1' }, {
      type: 'tool/result', time: Date.now(), data: { message: { toolCallId: 'call_x' } },
    })
    // 压缩开始（实测载荷：compactionId + turn）
    h.emit('session/event', { id: 'c-1' }, {
      type: 'compaction/start', time: Date.now(), data: { compactionId: 'cmp_1', turn: 3 },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c1 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c1.pendingTool, '', '调用落地后在飞标记应清除')
    assert.equal(c1.compacting, true, '压缩窗口内应标成在忙（客户端据此豁免卡住）')
    assert.ok(c1.compactStartedAt > 0, '压缩起始时间应进快照（压缩永不结束要能按上限报出来）')

    // 压缩出摘要（llmStreamCall 表示还在等模型）→ 仍在压缩中
    h.emit('session/event', { id: 'c-1' }, {
      type: 'compaction/summary', time: Date.now(),
      data: { compactionId: 'cmp_1', summary: [], rawOutput: [], llmStreamCall: true },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c2 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c2.compacting, true, '出摘要不等于压缩结束（llmStreamCall 还要等模型）')

    // 压缩收尾 → 解除在忙
    h.emit('session/event', { id: 'c-1' }, {
      type: 'compaction/end', time: Date.now(), data: { compactionId: 'cmp_1', turn: 3 },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c3 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c3.compacting, false, '压缩结束后应解除在忙（之后真停滞仍要能报出来）')

    // compaction/prune 没有 compactionId（实测载荷只有 shadowedRange/shadowedSeqs/shadowedTokenCount）：
    // 不得当成压缩窗口，也不能崩
    h.emit('session/event', { id: 'c-1' }, {
      type: 'compaction/prune', time: Date.now(),
      data: { shadowedRange: { start: 1, end: 2 }, shadowedSeqs: [1, 2], shadowedTokenCount: 9 },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c4 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c4.compacting, false, '轻量修剪不产摘要，不算压缩窗口（否则会长期误豁免卡住）')

    // 连续两次压缩（实测有 end 后 +0.0 秒又 start）：标记要能重新置位
    h.emit('session/event', { id: 'c-1' }, {
      type: 'compaction/start', time: Date.now(), data: { compactionId: 'cmp_2', turn: 3 },
    })
    st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const c5 = st.active.find((x) => x.sessionId === 'c-1')
    assert.equal(c5.compacting, true, '紧接的第二次压缩应重新置位')
  } finally {
    dispose()
    assert.equal(h.listenerCount('session/event'), 0, '用例收尾必须退订（不留常驻监听）')
  }
}

// ---------- 用例 10：子任务完成 → 完成记录带归属；群推送标「子任务」并点名主任务（三挡） ----------
// 用户实测（2026-11-05）：结束的是派发的子任务，主任务还在跑，通知却报「任务完成」，
// 像整个任务结束了。这里锁死：完成记录带 isSubtask/parentSessionId/parentTitle，
// 钉钉/飞书推送的标题与正文标「子任务」并点名所属主任务（简洁挡也带归属）。
{
  const h = makeHost()
  const dispose = notifyFeature.setup(h.ctx)
  const pushed = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    pushed.push({ url, body: JSON.parse(init.body) })
    return { ok: true, status: 200, text: async () => JSON.stringify({ errcode: 0, code: 0 }) }
  }
  const realLog = console.log
  console.log = () => {} // 推送成功会打日志，静音保持输出干净
  try {
    await h.call('/dsh-dock/notify', 'config', {
      dingtalkEnabled: true, dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      feishuEnabled: true, feishuWebhook: 'https://open.feishu.cn/open-apis/bot/v2/hook/test',
    })
    // 主任务在跑 + 子任务派发：活跃快照应解析出主任务标题（完成卡归属行用）
    h.emit('agent/status', { agent: { id: 'root-1' }, status: 'running' })
    h.emit('agent/status', { agent: { id: 'sub-1' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const st = (await h.call('/dsh-dock/notify', 'status')).body.data
    const sub = st.active.find((x) => x.sessionId === 'sub-1')
    assert.equal(sub.parentTitle, '测试会话', '活跃快照应解析出主任务标题')

    // 三挡口径：子任务完成推送都要标「子任务完成」+ 主任务；简洁挡裁掉明细但保留归属
    for (const mode of ['brief', 'medium', 'detailed']) {
      await h.call('/dsh-dock/notify', 'config', { pushMode: mode })
      const sid = 'sub-' + mode
      h.emit('agent/status', { agent: { id: sid }, status: 'running' })
      await new Promise((resolve) => setTimeout(resolve, 20))
      h.emit('agent/status', { agent: { id: sid }, status: 'idle' })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const ding = pushed.filter((p) => /oapi\.dingtalk/.test(p.url))
    assert.equal(ding.length, 3, '三挡各推送一次钉钉')
    for (const p of ding) {
      assert.match(p.body.markdown.title, /^dsh 子任务完成/, '推送标题应标「子任务完成」')
      assert.ok(p.body.markdown.text.includes('**子任务**'), '正文应标子任务')
      assert.ok(p.body.markdown.text.includes('**主任务**: 测试会话'), '三挡都应点名所属主任务')
    }
    assert.ok(!ding[0].body.markdown.text.includes('**模型**'), 'brief 不带模型明细')
    assert.ok(ding[1].body.markdown.text.includes('**模型**'), 'medium 带模型明细')
    assert.ok(ding[2].body.markdown.text.includes('**Token**'), 'detailed 带 Token 明细')
    const feishu = pushed.filter((p) => /feishu/.test(p.url))
    assert.equal(feishu.length, 3, '三挡各推送一次飞书')
    assert.match(feishu[0].body.card.header.title.content, /子任务完成/, '飞书卡片标题应标「子任务完成」')

    // 完成记录带归属（客户端卡片/语音/系统通知的数据源）
    h.emit('agent/status', { agent: { id: 'sub-1' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rec = (await h.call('/dsh-dock/notify', 'status')).body.data.recent.find((r) => r.sessionId === 'sub-1')
    assert.equal(rec.isSubtask, true, '完成记录应标子任务')
    assert.equal(rec.parentSessionId, 'root-1', '完成记录应带父会话 id')
    assert.equal(rec.parentTitle, '测试会话', '完成记录应带主任务标题（主任务还在跑时取最新值）')

    // 主任务自己完成：仍是「任务完成」，不带主任务归属行
    h.emit('agent/status', { agent: { id: 'root-1' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rootRec = (await h.call('/dsh-dock/notify', 'status')).body.data.recent.find((r) => r.sessionId === 'root-1')
    assert.equal(rootRec.isSubtask, false, '主任务完成记录不得标子任务')
    const lastDing = [...pushed].reverse().find((p) => /oapi\.dingtalk/.test(p.url))
    assert.match(lastDing.body.markdown.title, /^dsh 任务完成/, '主任务完成推送仍是「任务完成」')
    assert.ok(!lastDing.body.markdown.text.includes('**主任务**'), '主任务推送不带归属行')

    // 父会话已归档（不在活跃列表）：子任务完成仍能从归档记录兜出主任务标题
    h.emit('agent/status', { agent: { id: 'sub-orphan' }, status: 'running' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    h.emit('agent/status', { agent: { id: 'sub-orphan' }, status: 'idle' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const orphan = (await h.call('/dsh-dock/notify', 'status')).body.data.recent.find((r) => r.sessionId === 'sub-orphan')
    assert.equal(orphan.parentTitle, '测试会话', '父会话已归档时主任务标题应有兜底')
  } finally {
    globalThis.fetch = realFetch
    console.log = realLog
    dispose()
    assert.equal(h.listenerCount('session/event'), 0, '用例收尾必须退订（不留常驻监听）')
  }
}

console.log('task/animation+notify+runstate host: ok (共享追踪 1 份订阅 + 配置路由隔离 + 只读运行状态 + 群机器人推送 + 一次性迁移 + 卡住快照字段 + 提问挂起快照 + 压缩/在飞豁免信号 + 子任务完成归属与三挡推送)')