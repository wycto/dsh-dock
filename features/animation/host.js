// dsh-dock · 功能模块【任务动画】· 宿主半部
//
// 职责：动画配置持久化（动效开关 / 模式 / 桌面伙伴大小）+ 状态路由。
// 会话级任务追踪在 src/task-track.js（与【任务通知】共用一份数据）；
// 通知（页内卡片 / 提示音 / 系统通知 / 钉钉飞书推送）在 features/notify/，两个功能各自独立启停。
//
// RPC（webServer HTTP 路由，前缀 /dsh-dock/animation/）：
//   POST /status —— 活跃任务 + 最近完成 + 动画配置（客户端据此渲染动效）
//   POST /config —— 增量更新动画配置字段并持久化到 settings（dsh-dock 命名空间 animation 段）
//
// 配置模型（schemastery schema 见 src/host-core.js DockConfig.animation）：
//   animationEnabled / effectMode / robotScale
import { DOCK_NS, ANIMATION_MODES, sendJson, readBody } from '../../src/host-core.js'
import { acquireTaskTracker } from '../../src/task-track.js'

// 默认配置（schema 默认值一致；settings.get 未挂载时的兜底）
function defaultConfig() {
  return {
    animationEnabled: true,
    effectMode: 'flow',
    robotScale: 1.35,
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
    }
  } catch { /* settings 未挂载，用默认 */ }
  return cfg
}

export const feature = {
  id: 'animation',
  name: '任务动画',
  description: '19 种任务运行动画（速度随任务活动联动，配置持久化；通知见「任务通知」）',
  defaultEnabled: false,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // 会话级任务追踪（与【任务通知】共享一份；两个功能都停用后自动退订会话事件）
    const lease = acquireTaskTracker(ctx)
    disposers.push(() => lease.release())
    const tracker = lease.tracker

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
              return sendJson(res, 200, {
                ok: true,
                data: Object.assign({}, tracker.snapshot(Date.now()), { config: readConfig(ctx) }),
              })
            }

            if (method === 'config') {
              // 增量合并：只接受已知字段，类型不符忽略；整体写回 animation 段
              const cfg = readConfig(ctx)
              const p = payload || {}
              if (typeof p.animationEnabled === 'boolean') cfg.animationEnabled = p.animationEnabled
              if (typeof p.effectMode === 'string' && ANIMATION_MODES.includes(p.effectMode)) cfg.effectMode = p.effectMode
              if (typeof p.robotScale === 'number' && Number.isFinite(p.robotScale)) {
                cfg.robotScale = Math.max(0.85, Math.min(2.2, Math.round(p.robotScale * 100) / 100))
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
              console.log('[dsh-dock] animation config saved:', cfg.effectMode, 'anim=' + cfg.animationEnabled)
              return sendJson(res, 200, { ok: true, data: { config: cfg, savedAt: Date.now() } })
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
