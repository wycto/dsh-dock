// dsh-dock · 功能模块【任务动画】· 宿主半部（v0.5.0，参照 @wycto/dsh-task-pulse lib/index.js 会话级追踪，同作者 MIT）
//
// 职责：会话级任务追踪（开始/结束/回合/步骤/工具/Token/结束原因）+ RPC + 配置持久化。
// 不做动画（那是浏览器半部的事），也不做钉钉推送（dock 版走浏览器通知，见 view.jsx）。
//
// RPC（webServer HTTP 路由，前缀 /dsh-dock/animation/）：
//   POST /status —— 活跃任务 + 最近完成 + 配置（客户端据此渲染动画/通知）
//   POST /config —— 增量更新配置字段并持久化到 settings（dsh-dock 命名空间 animation 段）
//
// 配置模型（schemastery schema 见 src/host-core.js DockConfig.animation）：
//   animationEnabled / effectMode / notifyEnabled / notifyOnComplete /
//   notifyOnError / notifyStayMs / systemNotify
// 动画与通知是两个独立开关，可只开其一；全部经 settings 持久化，重启后恢复。
import { DOCK_NS, ANIMATION_MODES, SOUND_EFFECTS, sendJson, readBody } from '../../src/host-core.js'

// 默认配置（schema 默认值一致；settings.get 未挂载时的兜底）
function defaultConfig() {
  return {
    animationEnabled: true,
    effectMode: 'flow',
    notifyEnabled: true,
    notifyOnComplete: true,
    notifyOnError: true,
    notifyStayMs: 8000,
    systemNotify: false,
    soundNotify: true,
    soundEffect: 'chime',
    dingtalkEnabled: false,
    dingtalkWebhook: '',
  }
}

// 读 settings 里的 animation 配置（resolved 值已含 schema 默认），异常时回退默认
function readConfig(ctx) {
  const cfg = defaultConfig()
  try {
    const settings = ctx.get('settings')
    const v = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : null
    const a = v && typeof v === 'object' && v.animation && typeof v.animation === 'object' ? v.animation : null
    if (a) {
      for (const key of Object.keys(cfg)) {
        if (a[key] !== undefined) cfg[key] = a[key]
      }
      if (!ANIMATION_MODES.includes(cfg.effectMode)) cfg.effectMode = 'flow'
      if (!SOUND_EFFECTS.includes(cfg.soundEffect)) cfg.soundEffect = 'chime'
    }
  } catch { /* settings 未挂载，用默认 */ }
  return cfg
}

export const feature = {
  id: 'animation',
  name: '任务动画',
  description: '任务运行动画与完成通知（动画/通知独立开关，配置持久化）',
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // ===== 会话级任务追踪（agent/status 驱动开始/结束，session/event 补统计） =====
    const activeSessions = new Map() // sessionId -> 追踪记录
    const completedSessions = [] // 最近完成（新→旧）
    const MAX_COMPLETED = 30

    function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0 }

    function extractText(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join(' ').replace(/\s+/g, ' ').trim()
    }

    function truncate(str, max = 160) {
      if (!str) return ''
      return String(str).length > max ? String(str).slice(0, max) + '…' : str
    }

    // ===== 任务阶段追踪（供桌面机器人等动效感知当前在干嘛） =====
    // 流级实时同步（assistant/chunk，每 token 一条）：
    //   reasoning-delta = 思考流 → think；text-delta = 正文输出流 → write
    // 事件级：step/start = 思考；tool/call 按工具名分类：检索类 = search，其余 = code。
    function phaseOfToolName(name) {
      const n = String(name || '').toLowerCase()
      if (/web|search|fetch|grep|glob|find|read|ls$|^ls|tree|locate/.test(n)) return 'search'
      return 'code'
    }

    // 会话标题：官方标题服务，取不到回退首条用户输入（firstPrompt）
    async function getSessionTitle(sessionId, sessionQuery) {
      try {
        if (!sessionQuery) return ''
        if (typeof sessionQuery.readTitle === 'function') {
          const snap = await sessionQuery.readTitle(sessionId)
          if (snap && snap.title) return snap.title
        }
        if (typeof sessionQuery.readSession === 'function') {
          const snap = await sessionQuery.readSession(sessionId)
          if (snap && snap.header && snap.header.title) return snap.header.title
        }
      } catch { /* 标题取不到就用 firstPrompt 兜底 */ }
      return ''
    }

    function addActiveSession(sid, sessionQuery, extra = {}) {
      if (activeSessions.has(sid)) return activeSessions.get(sid)
      console.log('[dsh-dock] animation: task started', sid.substring(0, 8))
      const record = {
        startTime: Date.now(),
        title: '',
        turns: 0,
        steps: 0,
        toolCalls: 0,
        models: new Set(),
        provider: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        endReason: '',
        errorMessage: '',
        lastText: '',
        firstPrompt: '',
        phase: 'think',
        phaseAt: Date.now(),
        lastActivityAt: Date.now(),
        ...extra,
      }
      activeSessions.set(sid, record)
      getSessionTitle(sid, sessionQuery).then((title) => {
        const s = activeSessions.get(sid)
        if (s) s.title = title
      })
      return record
    }

    // 任务结束：归档 + 供客户端通知（通知由浏览器侧 diff 触发，这里只出数据）
    function finishSession(sid) {
      const session = activeSessions.get(sid)
      if (!session) return
      activeSessions.delete(sid)
      const endTime = Date.now()
      const duration = endTime - session.startTime
      console.log('[dsh-dock] animation: task finished', {
        sid: sid.substring(0, 8),
        duration,
        endReason: session.endReason || 'completed',
      })
      const record = {
        sessionId: sid,
        title: session.title || truncate(session.firstPrompt, 60) || '(无标题)',
        duration,
        turns: session.turns,
        steps: session.steps,
        toolCalls: session.toolCalls,
        models: [...session.models],
        provider: session.provider,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        totalTokens: session.totalTokens,
        reasoningTokens: session.reasoningTokens,
        cacheReadTokens: session.cacheReadTokens,
        endReason: session.endReason,
        errorMessage: session.errorMessage,
        lastText: session.lastText,
        startTime: session.startTime,
        endTime,
      }
      completedSessions.unshift(record)
      if (completedSessions.length > MAX_COMPLETED) completedSessions.pop()
      // 钉钉群机器人推送（宿主侧直发，异步不阻塞；事件筛选跟随 notifyOnComplete/notifyOnError）
      pushDingtalkIfNeeded(record)
    }

    // ===== 钉钉群机器人推送（参照 @wycto/dsh-task-pulse 同款 markdown 消息） =====
    const END_REASON_LABELS = {
      completed: '✅ 完成',
      aborted: '⛔ 已中止',
      blocked: '🚧 受阻',
      error: '❌ 出错',
      'max-tokens': '⏹ 达到输出上限',
      interrupted: '⚡ 中断',
    }

    function fmtDurCn(ms) {
      const s = Math.max(0, Math.round((ms || 0) / 1000))
      const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
      if (h > 0) return `${h}小时${m}分${sec}秒`
      if (m > 0) return `${m}分${sec}秒`
      return `${sec}秒`
    }
    function pad2(n) { return String(n).padStart(2, '0') }
    function fmtClockOf(ts) {
      const d = new Date(ts)
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    }
    function fmtDateClockOf(ts) {
      const d = new Date(ts)
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtClockOf(ts)}`
    }

    function buildDingtalkMessage(t) {
      const success = !t.endReason || t.endReason === 'completed'
      const reasonLabel = END_REASON_LABELS[t.endReason] || '✅ 完成'
      const models = t.models.length > 0 ? t.models.join(', ') : '未知'
      const lines = []
      lines.push(`### ${success ? '✅' : '📢'} dsh 任务${success ? '完成' : '结束'}`)
      lines.push('')
      lines.push(`**任务**: ${t.title}`)
      lines.push(`**模型**: ${models}${t.provider ? `（${t.provider}）` : ''}`)
      lines.push(`**耗时**: ${fmtDurCn(t.duration)}（${fmtClockOf(t.startTime)} → ${fmtClockOf(t.endTime)}）`)
      lines.push(`**回合**: ${t.turns} · 步骤 ${t.steps}${t.toolCalls ? ` · 工具 ${t.toolCalls} 次` : ''}`)
      lines.push(`**Token**: 输入 ${t.inputTokens.toLocaleString()} / 输出 ${t.outputTokens.toLocaleString()} / 总计 ${t.totalTokens.toLocaleString()}`)
      lines.push(`**结果**: ${reasonLabel}${t.errorMessage ? `：${truncate(t.errorMessage, 120)}` : ''}`)
      if (t.lastText) {
        lines.push('')
        lines.push(`> ${truncate(t.lastText, 200)}`)
      }
      lines.push('')
      lines.push('---')
      lines.push(`*由 dsh-dock 任务动画发送 · ${fmtDateClockOf(t.endTime)}*`)
      return {
        title: `dsh 任务${success ? '完成' : '结束'}：${truncate(t.title, 40)}`,
        text: lines.join('\n'),
      }
    }

    // 发送钉钉 markdown 消息；成功 = HTTP 200 且业务码 errcode === 0
    async function sendDingtalk(webhook, title, text) {
      try {
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } }),
        })
        const raw = await res.text()
        let data = null
        try { data = JSON.parse(raw) } catch { /* 非 JSON 响应体 */ }
        if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${truncate(raw, 120)}` }
        if (data && typeof data.errcode === 'number' && data.errcode !== 0) {
          return { ok: false, error: `钉钉 errcode ${data.errcode}：${data.errmsg || ''}` }
        }
        return { ok: true }
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) }
      }
    }

    async function pushDingtalkIfNeeded(record) {
      try {
        const cfg = readConfig(ctx)
        if (!cfg.dingtalkEnabled || !cfg.dingtalkWebhook) return
        const success = !record.endReason || record.endReason === 'completed'
        if (success ? !cfg.notifyOnComplete : !cfg.notifyOnError) return
        const { title, text } = buildDingtalkMessage(record)
        const r = await sendDingtalk(cfg.dingtalkWebhook, title, text)
        if (r.ok) console.log('[dsh-dock] animation dingtalk pushed:', title)
        else console.error('[dsh-dock] animation dingtalk push failed:', r.error)
      } catch (e) {
        console.error('[dsh-dock] animation dingtalk push error:', e && e.message)
      }
    }

    function handleSessionEvent(sessionQuery, session, event) {
      const sid = typeof session === 'object' && session ? (session.id || '') : String(session || '')
      if (!sid || !event || !event.type) return

      if (event.type === 'step/start') {
        const s = addActiveSession(sid, sessionQuery, { startTime: event.time || Date.now() })
        s.steps++
        s.phase = 'think' // 新步骤：模型正在推理下一步
        s.phaseAt = event.time || Date.now()
        s.lastActivityAt = s.phaseAt
        if (event.data && event.data.turn !== undefined) {
          s.turns = Math.max(s.turns, num(event.data.turn) + 1)
        }
        return
      }
      const s = activeSessions.get(sid)
      if (!s) return
      const now = event.time || Date.now()
      // 流级阶段：chunk 高频到达（每 token 一条），只做最廉价的阶段切换
      if (event.type === 'assistant/chunk') {
        const ctype = event.data && event.data.chunk && event.data.chunk.type
        if (ctype === 'reasoning-delta') {
          s.phase = 'think'
          s.phaseAt = now
        } else if (ctype === 'text-delta') {
          s.phase = 'write'
          s.phaseAt = now
        }
        s.lastActivityAt = now
        return
      }
      if (event.type === 'turn/end' && event.data && event.data.reason) {
        const reason = event.data.reason
        s.endReason = (reason.kind || 'completed')
        if (reason.kind === 'error' && reason.error) {
          const msg = (reason.error && (reason.error.message || reason.error.code)) || ''
          s.errorMessage = typeof msg === 'string' ? msg : String(msg)
        }
      } else if (event.type === 'tool/call') {
        s.toolCalls++
        s.phase = phaseOfToolName(event.data && event.data.name)
        s.phaseAt = now
      } else if (event.type === 'user/message') {
        if (!s.firstPrompt && event.data && event.data.content) {
          const text = extractText(event.data.content)
          if (text) s.firstPrompt = text
        }
      } else if (event.type === 'assistant/message' && event.data) {
        const usage = event.data.usage
        if (usage) {
          s.inputTokens += num(usage.inputTokens)
          s.outputTokens += num(usage.outputTokens)
          s.totalTokens += num(usage.inputTokens) + num(usage.outputTokens)
          s.reasoningTokens += num(usage.reasoningTokens)
          s.cacheReadTokens += num(usage.cacheReadTokens)
        }
        if (event.data.message && event.data.message.content) {
          const text = extractText(event.data.message.content)
          if (text) s.lastText = text
        }
        // 完整消息落盘后不改阶段：下一步要么 tool/call（code/search）要么收尾，
        // 维持 chunk 推导出的最后状态，避免"输完还显示思考中"的回跳
      } else if (event.type === 'request/context' && event.data) {
        if (event.data.provider) s.provider = event.data.provider
        if (event.data.model) s.models.add(event.data.model)
      } else if (event.type === 'request/header' && event.data && event.data.header && event.data.header.config) {
        const c = event.data.header.config
        if (c.provider) s.provider = c.provider
        if (c.model) s.models.add(c.model)
      }
      if (event.type !== 'request/header' && event.type !== 'request/context') s.lastActivityAt = now
    }

    function handleAgentStatus(sessionQuery, agent, status) {
      const sid = agent && agent.id ? String(agent.id) : ''
      if (!sid) return
      if (status === 'running') {
        const record = addActiveSession(sid, sessionQuery)
        if (agent.options) {
          if (agent.options.model) record.models.add(agent.options.model)
          if (agent.options.provider) record.provider = agent.options.provider
        }
      } else if (status === 'idle') {
        finishSession(sid)
      }
    }

    // 不能在 setup 时软获取 sessionQuery（可能早于服务激活，见 tokenlog 模块同款注释），用 inject 等就绪
    disposers.push(ctx.inject(['sessionQuery'], (sqCtx) => {
      const sessionQuery = sqCtx.sessionQuery
      disposers.push(sqCtx.on('session/event', (session, event) => {
        try {
          handleSessionEvent(sessionQuery, session, event)
        } catch (err) {
          console.error('[dsh-dock] animation handle event error', err)
        }
      }))
      disposers.push(sqCtx.on('agent/status', (payload) => {
        try {
          handleAgentStatus(sessionQuery, payload && payload.agent, payload && payload.status)
        } catch (err) {
          console.error('[dsh-dock] animation handle agent/status error', err)
        }
      }))
      // agent 销毁兜底归档（会话直接关闭时也产出完成记录）
      disposers.push(sqCtx.on('agent/disposed', (payload) => {
        try {
          const sid = payload && payload.agent && payload.agent.id ? String(payload.agent.id) : ''
          if (sid) finishSession(sid)
        } catch (err) {
          console.error('[dsh-dock] animation handle agent/disposed error', err)
        }
      }))
    }))

    // ===== RPC 路由 =====
    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/animation',
        async handler(req, res) {
          try {
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const method = url.pathname.replace(/^\/dsh-dock\/animation\/?/, '').split('/')[0] || ''
            const payload = await readBody(req)

            if (method === 'status') {
              const now = Date.now()
              const active = []
              for (const [sid, s] of activeSessions) {
                active.push({
                  sessionId: sid,
                  title: s.title || truncate(s.firstPrompt, 60) || '(无标题)',
                  startTime: s.startTime,
                  elapsed: now - s.startTime,
                  turns: s.turns,
                  steps: s.steps,
                  toolCalls: s.toolCalls,
                  models: [...s.models],
                  provider: s.provider,
                  inputTokens: s.inputTokens,
                  outputTokens: s.outputTokens,
                  totalTokens: s.totalTokens,
                  phase: s.phase,
                  phaseAt: s.phaseAt,
                  lastActivityAt: s.lastActivityAt,
                })
              }
              return sendJson(res, 200, {
                ok: true,
                data: {
                  now,
                  active,
                  recent: completedSessions.slice(0, 20),
                  config: readConfig(ctx),
                },
              })
            }

            if (method === 'config') {
              // 增量合并：只接受已知字段，类型不符忽略；整体写回 animation 段
              const cfg = readConfig(ctx)
              const p = payload || {}
              if (typeof p.animationEnabled === 'boolean') cfg.animationEnabled = p.animationEnabled
              if (typeof p.effectMode === 'string' && ANIMATION_MODES.includes(p.effectMode)) cfg.effectMode = p.effectMode
              if (typeof p.notifyEnabled === 'boolean') cfg.notifyEnabled = p.notifyEnabled
              if (typeof p.notifyOnComplete === 'boolean') cfg.notifyOnComplete = p.notifyOnComplete
              if (typeof p.notifyOnError === 'boolean') cfg.notifyOnError = p.notifyOnError
              if (typeof p.notifyStayMs === 'number' && Number.isFinite(p.notifyStayMs)) {
                cfg.notifyStayMs = Math.max(0, Math.min(600000, Math.round(p.notifyStayMs)))
              }
              if (typeof p.systemNotify === 'boolean') cfg.systemNotify = p.systemNotify
              if (typeof p.soundNotify === 'boolean') cfg.soundNotify = p.soundNotify
              if (typeof p.soundEffect === 'string' && SOUND_EFFECTS.includes(p.soundEffect)) cfg.soundEffect = p.soundEffect
              if (typeof p.dingtalkEnabled === 'boolean') cfg.dingtalkEnabled = p.dingtalkEnabled
              if (typeof p.dingtalkWebhook === 'string') {
                const hook = p.dingtalkWebhook.trim()
                if (hook && !/^https?:\/\//i.test(hook)) {
                  const err = new Error('钉钉 Webhook 地址需以 http(s):// 开头')
                  err.statusCode = 400
                  throw err
                }
                cfg.dingtalkWebhook = hook
              }

              const settings = ctx.get('settings')
              if (!settings || typeof settings.mutate !== 'function') {
                throw new Error('settings 服务不可用，配置无法持久化')
              }
              try {
                await settings.mutate(DOCK_NS, [{ op: 'set', path: ['animation'], value: cfg }])
              } catch (e) {
                const err = new Error('保存配置被拒绝：' + ((e && e.message) || String(e)))
                err.statusCode = 400
                throw err
              }
              console.log('[dsh-dock] animation config saved:', cfg.effectMode, 'anim=' + cfg.animationEnabled, 'notify=' + cfg.notifyEnabled)
              return sendJson(res, 200, { ok: true, data: { config: cfg, savedAt: Date.now() } })
            }

            // 钉钉连通性测试：用当前已保存的 Webhook 发一条测试消息
            if (method === 'test') {
              const cfgNow = readConfig(ctx)
              if (!cfgNow.dingtalkWebhook) {
                const err = new Error('请先填写并保存钉钉 Webhook 地址')
                err.statusCode = 400
                throw err
              }
              const text = [
                '### 🧪 dsh 任务动画测试',
                '',
                '这是一条来自 dsh-dock 任务动画的测试消息。',
                '',
                `**时间**: ${fmtDateClockOf(Date.now())}`,
                '',
                '> 看到这条消息说明钉钉 Webhook 配置正确。',
                '',
                '---',
                '*由 dsh-dock 任务动画发送*',
              ].join('\n')
              const r = await sendDingtalk(cfgNow.dingtalkWebhook, 'dsh 任务动画测试', text)
              if (!r.ok) console.error('[dsh-dock] animation dingtalk test failed:', r.error)
              return sendJson(res, 200, { ok: true, data: { sent: r.ok, error: r.ok ? '' : r.error } })
            }

            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (e) {
            const status = e && e.statusCode ? e.statusCode : 500
            console.error('[dsh-dock] animation HTTP error:', status, e && e.message)
            return sendJson(res, status, {
              ok: false,
              error: { code: status >= 500 ? 'internal' : 'bad-request', message: (e && e.message) || String(e) },
            })
          }
        },
      }), 'dsh-dock animation: /dsh-dock/animation HTTP route')
    }))

    return dispose
  },
}
