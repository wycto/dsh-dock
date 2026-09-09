// dsh-dock · 功能模块【任务通知】· 宿主半部
//
// 职责：通知配置持久化 + 群机器人推送（钉钉/飞书，宿主侧直发——浏览器关着也能推）。
// 会话级任务追踪在 src/task-track.js（与【任务动画】共享一份数据）；
// 页内卡片 / 提示音 / 浏览器系统通知在浏览器半部（features/notify/view.jsx）。
//
// RPC（webServer HTTP 路由，前缀 /dsh-dock/notify/）：
//   POST /status —— 活跃任务 + 最近完成 + 通知配置（客户端据此弹卡片、响提示音）
//   POST /config —— 增量更新通知配置字段并持久化到 settings（dsh-dock 命名空间 notify 段）
//   POST /test   —— 群机器人连通性测试（payload.target: 'dingtalk'（默认）| 'feishu'）
//
// 配置模型（schemastery schema 见 src/host-core.js DockConfig.notify）：
//   notifyOnComplete / notifyOnError / notifyOnConfirm / notifyStayMs /
//   systemNotify / soundNotify / soundEffect / dingtalkEnabled / dingtalkWebhook /
//   feishuEnabled / feishuWebhook
// 模块启停由功能坞的 features.notify 开关负责（独立菜单项），本模块不再有第二个总开关。
import { DOCK_NS, SOUND_EFFECTS, sendJson, readBody } from '../../src/host-core.js'
import { acquireTaskTracker } from '../../src/task-track.js'

// 默认配置（schema 默认值一致；settings.get 未挂载时的兜底）
function defaultConfig() {
  return {
    notifyOnComplete: true,
    notifyOnError: true,
    notifyOnConfirm: true,
    notifyStayMs: 8000,
    systemNotify: false,
    soundNotify: true,
    soundEffect: 'chime',
    dingtalkEnabled: false,
    dingtalkWebhook: '',
    feishuEnabled: false,
    feishuWebhook: '',
    // 迁移标记（schema 默认 false）：settings 不可用时的兜底取 true——迁移由
    // src/host-core.js migrateNotifyConfig 统一负责，这里只是原样带回，不影响通知行为。
    migratedFromAnimation: true,
  }
}

// 读 settings 里的 notify 配置（resolved 值已含 schema 默认），异常时回退默认
function readConfig(ctx) {
  const cfg = defaultConfig()
  try {
    const settings = ctx.get('settings')
    const v = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : null
    const n = v && typeof v === 'object' && v.notify && typeof v.notify === 'object' ? v.notify : null
    if (n) {
      for (const key of Object.keys(cfg)) {
        if (n[key] !== undefined) cfg[key] = n[key]
      }
      if (!SOUND_EFFECTS.includes(cfg.soundEffect)) cfg.soundEffect = 'chime'
    }
  } catch { /* settings 未挂载，用默认 */ }
  return cfg
}

function truncate(str, max = 160) {
  if (!str) return ''
  return String(str).length > max ? String(str).slice(0, max) + '…' : str
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

const END_REASON_LABELS = {
  completed: '✅ 完成',
  aborted: '⛔ 已中止',
  blocked: '🚧 受阻',
  error: '❌ 出错',
  'max-tokens': '⏹ 达到输出上限',
  interrupted: '⚡ 中断',
}

// 钉钉与飞书共用的消息正文（各端再按各自 markdown 方言拼接）
function buildMessageLines(t) {
  const success = !t.endReason || t.endReason === 'completed'
  const reasonLabel = END_REASON_LABELS[t.endReason] || '✅ 完成'
  const models = t.models.length > 0 ? t.models.join(', ') : '未知'
  const lines = []
  lines.push(`### ${success ? '✅' : '📢'} dsh 任务${success ? '完成' : '结束'}`)
  lines.push(`**任务**: ${t.title}`)
  lines.push(`**模型**: ${models}${t.provider ? `（${t.provider}）` : ''}`)
  lines.push(`**耗时**: ${fmtDurCn(t.duration)}（${fmtClockOf(t.startTime)} → ${fmtClockOf(t.endTime)}）`)
  lines.push(`**回合**: ${t.turns} · 步骤 ${t.steps}${t.toolCalls ? ` · 工具 ${t.toolCalls} 次` : ''}`)
  lines.push(`**Token**: 输入 ${t.inputTokens.toLocaleString()} / 输出 ${t.outputTokens.toLocaleString()} / 总计 ${t.totalTokens.toLocaleString()}`)
  lines.push(`**结果**: ${reasonLabel}${t.errorMessage ? `：${truncate(t.errorMessage, 120)}` : ''}`)
  if (t.lastText) {
    lines.push(`> ${truncate(t.lastText, 200)}`)
  }
  lines.push('---')
  lines.push(`*由 dsh-dock 任务通知发送 · ${fmtDateClockOf(t.endTime)}*`)
  return {
    title: `dsh 任务${success ? '完成' : '结束'}：${truncate(t.title, 40)}`,
    success,
    lines,
  }
}

function buildDingtalkMessage(t) {
  const { title, lines } = buildMessageLines(t)
  return {
    title,
    // 钉钉 markdown 不渲染单个 \n，行之间必须用空行分隔才能换行
    text: lines.join('\n\n'),
  }
}

// 飞书 interactive 卡片：标题进 header，正文走 lark_md（支持 **加粗** 与 \n 换行，不支持 ### 标题）
function buildFeishuMessage(t) {
  const { title, success, lines } = buildMessageLines(t)
  const body = lines.filter((l) => !l.startsWith('### ')).join('\n')
  return {
    title,
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: success ? 'green' : 'orange',
        title: { tag: 'plain_text', content: title },
      },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: body } },
      ],
    },
  }
}

// 发送飞书 interactive 卡片；成功 = HTTP 200 且业务码 code/StatusCode === 0
async function sendFeishu(webhook, title, card) {
  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card }),
    })
    const raw = await res.text()
    let data = null
    try { data = JSON.parse(raw) } catch { /* 非 JSON 响应体 */ }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${truncate(raw, 120)}` }
    // 新版返回 { code, msg }，旧版返回 { StatusCode, StatusMessage }
    const code = data && typeof data === 'object'
      ? (typeof data.code === 'number' ? data.code : data.StatusCode)
      : undefined
    if (typeof code === 'number' && code !== 0) {
      return { ok: false, error: `飞书 code ${code}：${data.msg || data.StatusMessage || ''}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) }
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

export const feature = {
  id: 'notify',
  name: '任务通知',
  description: '任务完成/异常/需确认通知：页内卡片、提示音、系统通知、钉钉/飞书推送（独立开关）',
  defaultEnabled: false,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // 会话级任务追踪（与【任务动画】共享一份）
    const lease = acquireTaskTracker(ctx)
    disposers.push(() => lease.release())
    const tracker = lease.tracker

    // ===== 群机器人推送（宿主侧直发，异步不阻塞；事件筛选跟随 notifyOnComplete/notifyOnError） =====
    async function pushDingtalkIfNeeded(record) {
      try {
        const cfg = readConfig(ctx)
        if (!cfg.dingtalkEnabled || !cfg.dingtalkWebhook) return
        const success = !record.endReason || record.endReason === 'completed'
        if (success ? !cfg.notifyOnComplete : !cfg.notifyOnError) return
        const { title, text } = buildDingtalkMessage(record)
        const r = await sendDingtalk(cfg.dingtalkWebhook, title, text)
        if (r.ok) console.log('[dsh-dock] notify dingtalk pushed:', title)
        else console.error('[dsh-dock] notify dingtalk push failed:', r.error)
      } catch (e) {
        console.error('[dsh-dock] notify dingtalk push error:', e && e.message)
      }
    }

    async function pushFeishuIfNeeded(record) {
      try {
        const cfg = readConfig(ctx)
        if (!cfg.feishuEnabled || !cfg.feishuWebhook) return
        const success = !record.endReason || record.endReason === 'completed'
        if (success ? !cfg.notifyOnComplete : !cfg.notifyOnError) return
        const { title, card } = buildFeishuMessage(record)
        const r = await sendFeishu(cfg.feishuWebhook, title, card)
        if (r.ok) console.log('[dsh-dock] notify feishu pushed:', title)
        else console.error('[dsh-dock] notify feishu push failed:', r.error)
      } catch (e) {
        console.error('[dsh-dock] notify feishu push error:', e && e.message)
      }
    }

    disposers.push(tracker.onFinish((record) => {
      pushDingtalkIfNeeded(record)
      pushFeishuIfNeeded(record)
    }))

    // ===== RPC 路由 =====
    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/notify',
        async handler(req, res) {
          try {
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const method = url.pathname.replace(/^\/dsh-dock\/notify\/?/, '').split('/')[0] || ''
            const payload = await readBody(req)

            if (method === 'status') {
              return sendJson(res, 200, {
                ok: true,
                data: Object.assign({}, tracker.snapshot(Date.now()), { config: readConfig(ctx) }),
              })
            }

            if (method === 'config') {
              // 增量合并：只接受已知字段，类型不符忽略；整体写回 notify 段
              const cfg = readConfig(ctx)
              const p = payload || {}
              if (typeof p.notifyOnComplete === 'boolean') cfg.notifyOnComplete = p.notifyOnComplete
              if (typeof p.notifyOnError === 'boolean') cfg.notifyOnError = p.notifyOnError
              if (typeof p.notifyOnConfirm === 'boolean') cfg.notifyOnConfirm = p.notifyOnConfirm
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
              if (typeof p.feishuEnabled === 'boolean') cfg.feishuEnabled = p.feishuEnabled
              if (typeof p.feishuWebhook === 'string') {
                const hook = p.feishuWebhook.trim()
                if (hook && !/^https?:\/\//i.test(hook)) {
                  const err = new Error('飞书 Webhook 地址需以 http(s):// 开头')
                  err.statusCode = 400
                  throw err
                }
                cfg.feishuWebhook = hook
              }

              const settings = ctx.get('settings')
              if (!settings || typeof settings.mutate !== 'function') {
                throw new Error('settings 服务不可用，配置无法持久化')
              }
              try {
                await settings.mutate(DOCK_NS, [{ op: 'set', path: ['notify'], value: cfg }])
              } catch (e) {
                const err = new Error('保存配置被拒绝：' + ((e && e.message) || String(e)))
                err.statusCode = 400
                throw err
              }
              console.log('[dsh-dock] notify config saved:', 'dingtalk=' + cfg.dingtalkEnabled, 'feishu=' + cfg.feishuEnabled)
              return sendJson(res, 200, { ok: true, data: { config: cfg, savedAt: Date.now() } })
            }

            // 机器人连通性测试：payload.target 指定 'dingtalk'（默认）或 'feishu'，用当前已保存的 Webhook 发一条测试消息
            if (method === 'test') {
              const target = (payload && payload.target) === 'feishu' ? 'feishu' : 'dingtalk'
              const cfgNow = readConfig(ctx)
              const webhook = target === 'feishu' ? cfgNow.feishuWebhook : cfgNow.dingtalkWebhook
              if (!webhook) {
                const err = new Error(`请先填写并保存${target === 'feishu' ? '飞书' : '钉钉'} Webhook 地址`)
                err.statusCode = 400
                throw err
              }
              let r
              if (target === 'feishu') {
                const text = [
                  '**这是一条来自 dsh-dock 任务通知的测试消息。**',
                  '',
                  `**时间**: ${fmtDateClockOf(Date.now())}`,
                  '',
                  '看到这条消息说明飞书 Webhook 配置正确。',
                  '',
                  '---',
                  '*由 dsh-dock 任务通知发送*',
                ].join('\n')
                const card = {
                  config: { wide_screen_mode: true },
                  header: {
                    template: 'blue',
                    title: { tag: 'plain_text', content: '🧪 dsh 任务通知测试' },
                  },
                  elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
                }
                r = await sendFeishu(webhook, 'dsh 任务通知测试', card)
              } else {
                const text = [
                  '### 🧪 dsh 任务通知测试',
                  '',
                  '这是一条来自 dsh-dock 任务通知的测试消息。',
                  '',
                  `**时间**: ${fmtDateClockOf(Date.now())}`,
                  '',
                  '> 看到这条消息说明钉钉 Webhook 配置正确。',
                  '',
                  '---',
                  '*由 dsh-dock 任务通知发送*',
                ].join('\n')
                r = await sendDingtalk(webhook, 'dsh 任务通知测试', text)
              }
              if (!r.ok) console.error(`[dsh-dock] notify ${target} test failed:`, r.error)
              return sendJson(res, 200, { ok: true, data: { sent: r.ok, error: r.ok ? '' : r.error } })
            }

            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (e) {
            const status = e && e.statusCode ? e.statusCode : 500
            console.error('[dsh-dock] notify HTTP error:', status, e && e.message)
            return sendJson(res, status, {
              ok: false,
              error: { code: status >= 500 ? 'internal' : 'bad-request', message: (e && e.message) || String(e) },
            })
          }
        },
      }), 'dsh-dock notify: /dsh-dock/notify HTTP route')
    }))

    return dispose
  },
}
