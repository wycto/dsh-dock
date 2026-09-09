// dsh-dock · 功能模块【运行状态】· 宿主半部
//
// 职责：把会话级任务追踪的快照下发给客户端。追踪本身在 src/task-track.js
// （与【任务动画】【任务通知】共用一份数据，引用计数共享）；本模块只读——
// 没有自己的 settings 配置段，也不写盘（启停由功能坞的 features.runstate 开关负责）。
//
// RPC（webServer HTTP 路由，前缀 /dsh-dock/runstate/）：
//   POST /status —— 活跃任务 + 最近完成（客户端据此渲染运行状态页与首页概要）
//
// 数据形状由客户端消费，字段改动要同时看：features/runstate/view.jsx、
// features/animation/view.jsx、features/notify/view.jsx。
import { sendJson, readBody } from '../../src/host-core.js'
import { acquireTaskTracker } from '../../src/task-track.js'

export const feature = {
  id: 'runstate',
  name: '运行状态',
  description: '任务运行状态一览：进行中任务（阶段 / 耗时 / 回合 / Token / 等待确认）与最近完成',
  defaultEnabled: false,
  setup(ctx) {
    const disposers = []
    const dispose = () => {
      while (disposers.length > 0) {
        const fn = disposers.pop()
        try { if (typeof fn === 'function') fn() } catch { /* 停用清理失败不阻断 */ }
      }
    }

    // 会话级任务追踪（与【任务动画】【任务通知】共享一份；三个功能都停用后自动退订会话事件）
    const lease = acquireTaskTracker(ctx)
    disposers.push(() => lease.release())
    const tracker = lease.tracker

    // ===== RPC 路由 =====
    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/runstate',
        async handler(req, res) {
          try {
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const method = url.pathname.replace(/^\/dsh-dock\/runstate\/?/, '').split('/')[0] || ''
            await readBody(req) // 读空请求体，避免连接上残留未消费数据

            if (method === 'status') {
              return sendJson(res, 200, { ok: true, data: tracker.snapshot(Date.now()) })
            }

            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (e) {
            const status = e && e.statusCode ? e.statusCode : 500
            console.error('[dsh-dock] runstate HTTP error:', status, e && e.message)
            return sendJson(res, status, {
              ok: false,
              error: { code: status >= 500 ? 'internal' : 'bad-request', message: (e && e.message) || String(e) },
            })
          }
        },
      }), 'dsh-dock runstate: /dsh-dock/runstate HTTP route')
    }))

    return dispose
  },
}
