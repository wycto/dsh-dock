// dsh-dock · Host 半部（Node 侧入口）· v0.9.0 模块化架构
//
// 功能坞 = hub + 一个个独立功能模块（像 dsh 本身由小包组成）：
//   - 每个功能是一个 features/<id>/ 目录：host.js（宿主半部）+ view.js(x)（客户端视图），
//     可整体拎出单独打包发布（scripts/extract-feature.mjs 生成独立包骨架）；
//   - 独立发布的功能包装回本插件后，经 client 半部的 dockBridge 注册进面板菜单；
//   - 本文件只做组装：import 各模块的 feature 描述符，统一生命周期（开关/错误隔离/卸载清理），
//     不含任何具体功能逻辑。
//
// 功能清单（宿主半部；客户端菜单次序由 view 模块的 order 字段决定）：
//   - models      模型设置（v0.3.0）：模型目录读 + 官方配置写
//   - visionproxy 图片理解代理（v0.3.1）：纯文本模型收图自动走视觉模型识别
//   - balance     模型余额（v0.2.0）：各 Provider 账户余额/配额
//   - tokenlog    用量记录（v0.4.0）：LLM 调用记账与统计（移植自 @wycto/dsh-token-usage）
//   - animation   任务动画（v0.5.0）：会话任务追踪 + 动效配置持久化（参照 @wycto/dsh-task-pulse）
//   - notify      任务通知：完成/异常/需确认通知 + 提示音/系统通知/钉钉飞书推送（从任务动画拆出）
//   - runstate    运行状态：进行中任务与最近完成一览（从任务动画拆出；只读，无配置段）
//   - mobile-relay 手机接力（未发布）：扫码反向代理接力 + 局域网电脑直连（0.0.0.0）
import { DOCK_NS, DockConfig, sendJson, readBody, migrateNotifyConfig } from './src/host-core.js'
import { feature as fModels } from './features/modelconfig/host.js'
import { feature as fVisionProxy } from './features/visionproxy/host.js'
import { feature as fBalance } from './features/balance/host.js'
import { feature as fTokenlog } from './features/tokenlog/host.js'
import { feature as fAnimation } from './features/animation/host.js'
import { feature as fNotify } from './features/notify/host.js'
import { feature as fRunState } from './features/runstate/host.js'
import { feature as fMobileRelay } from './features/mobile-relay/host.js'

export const name = 'dsh-dock'

// 硬依赖 webServer（路由注册）+ llm（图片理解代理包装）+ settings（自有命名空间读写）。
export const inject = ['webServer', 'llm', 'settings']

/** 测试钩子：清空识别缓存（冒烟在用例间隔离；实现在 visionproxy 模块）。 */
export { __clearDescribeCache } from './features/visionproxy/host.js'

// 宿主进程健壮性护栏：Node 对已半脱离 HTTP 管理的 socket 上到达的传输层重置
// 没有兜底监听——手机锁屏/切后台、页面跳转中断请求等日常 RST 会以未捕获异常
// 打崩整个 dsh web（实测：Error: read ECONNRESET, Emitted 'error' on Socket）。
// 这里只吞 ECONNRESET/EPIPE 这类纯传输层错误（连接本身已死，吞掉等价于 nginx
// 对客户端断连的处理），其余未捕获异常照常抛出。
if (typeof process !== 'undefined' && typeof process.on === 'function' && !process.listenerCount('uncaughtException')) {
  process.on('uncaughtException', (err) => {
    const code = err && err.code
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      console.error('[dsh-dock] swallowed transport error:', code, (err && err.message) || err)
      return
    }
    throw err
  })
}

export function apply(ctx) {
  // ---- 功能注册表（Host 侧）：每个条目来自对应功能模块的 feature 描述符 ----
  // defaultEnabled：与 Client 半部保持一致。已接入的功能默认打开，
  // 规划中的功能缺省 false，等实现后移除 roadmap 并打开。
  const FEATURES = [
    fModels,
    fVisionProxy,
    fBalance,
    fTokenlog,
    fAnimation,
    fNotify,
    fRunState,
    fMobileRelay,
  ]

  const state = new Map()
  for (const f of FEATURES) state.set(f.id, { enabled: false, dispose: null, error: null })

  /** 读宿主侧功能开关表（settings 持久化；settings 未挂载时回退 defaultEnabled）。 */
  function persistedFeatureMap() {
    try {
      const settings = ctx.get('settings')
      const v = settings && typeof settings.get === 'function' ? settings.get(DOCK_NS) : null
      if (v && typeof v === 'object' && v.features && typeof v.features === 'object') return v.features
    } catch {
      // settings 未挂载
    }
    return null
  }

  // 每个功能的 Host 半部安装函数：setup 返回 disposer，关闭功能时调用。
  function setEnabled(id, enabled) {
    const st = state.get(id)
    if (!st || st.enabled === enabled) return
    st.enabled = enabled
    st.error = null
    if (enabled) {
      const f = FEATURES.find((x) => x.id === id)
      if (f && typeof f.setup === 'function') {
        try {
          st.dispose = f.setup(ctx) || null
        } catch (err) {
          st.error = String((err && err.message) || err)
          console.error('[dsh-dock] feature setup failed:', id, err)
        }
      }
    } else if (st.dispose) {
      try {
        st.dispose()
      } catch (err) {
        console.error('[dsh-dock] feature dispose failed:', id, err)
      }
      st.dispose = null
    }
  }

  // 自有 settings 命名空间（dsh-dock）：功能开关与各功能配置的持久化；
  // 读取走 settings.get（内存 resolved 值，写入经 settings.mutate，均热生效）。
  // 宿主侧初始开关也在这里应用：settings 命名空间注册完成后才能读到持久化开关表
  // （apply() 同步执行时注册尚未生效，读到的永远是空值）。
  let initialTogglesApplied = false
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(DOCK_NS, DockConfig, {})
    // 一次性迁移：通知配置从 animation 段搬到 notify 段（【任务通知】独立成模块）。
    // 必须在任何面板保存动作之前跑——animation 模块保存时整段写回，旧字段会被覆盖丢失。
    migrateNotifyConfig(sctx)
    if (initialTogglesApplied) return
    initialTogglesApplied = true
    const persisted = persistedFeatureMap()
    for (const f of FEATURES) {
      const saved = persisted ? persisted[f.id] : undefined
      setEnabled(f.id, typeof saved === 'boolean' ? saved : !!f.defaultEnabled)
    }
  })

  // 功能开关管理路由（无条件注册）：GET 查询各功能宿主侧状态；POST 同步开关——
  // 浏览器面板 toggle 经此写入 settings（跨浏览器/重启保持）并即时 setup/dispose 宿主半部。
  {
    const webServer = ctx.get('webServer')
    if (webServer) {
      webServer.register({
        kind: 'exact',
        path: '/dsh-dock/features',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const body = await readBody(req)
              const id = body && typeof body.id === 'string' ? body.id : ''
              const enabled = !!(body && body.enabled)
              if (!state.has(id)) return sendJson(res, 404, { ok: false, error: { message: `未知功能：${id}` } })
              setEnabled(id, enabled)
              const settings = ctx.get('settings')
              if (settings && typeof settings.mutate === 'function') {
                const features = Object.assign({}, persistedFeatureMap() || {}, { [id]: enabled })
                await settings.mutate(DOCK_NS, [{ op: 'set', path: ['features'], value: features }])
              }
            }
            const persisted = persistedFeatureMap() || {}
            sendJson(res, 200, {
              ok: true,
              data: {
                features: Array.from(state.entries()).map(([id, st]) => ({
                  id,
                  enabled: st.enabled,
                  error: st.error,
                })),
                persisted,
              },
            })
          } catch (e) {
            sendJson(res, 500, { ok: false, error: { message: e instanceof Error ? e.message : String(e) } })
          }
        },
      })
    }
  }

  console.log('[dsh-dock] host half loaded; features registered:', FEATURES.map((f) => f.id).join(', '))

  // 插件卸载/更新时兜底清理仍在运行的功能
  ctx.effect(() => () => {
    for (const st of state.values()) {
      if (st.dispose) {
        try {
          st.dispose()
        } catch (err) {
          /* ignore */
        }
      }
    }
  })
}
