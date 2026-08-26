// dsh-dock · Host 半部（Node 侧入口）· v0.4.0 模块化架构
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
//   - animation   任务动画（v0.5.0）：会话任务追踪 + 动效/通知配置持久化（参照 @wycto/dsh-task-pulse）
import { DOCK_NS, DockConfig } from './src/host-core.js'
import { feature as fModels } from './features/modelconfig/host.js'
import { feature as fVisionProxy } from './features/visionproxy/host.js'
import { feature as fBalance } from './features/balance/host.js'
import { feature as fTokenlog } from './features/tokenlog/host.js'
import { feature as fAnimation } from './features/animation/host.js'

export const name = 'dsh-dock'

// 硬依赖 webServer（路由注册）+ llm（图片理解代理包装）+ settings（自有命名空间读写）。
export const inject = ['webServer', 'llm', 'settings']

/** 测试钩子：清空识别缓存（冒烟在用例间隔离；实现在 visionproxy 模块）。 */
export { __clearDescribeCache } from './features/visionproxy/host.js'

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
  ]

  const state = new Map()
  for (const f of FEATURES) state.set(f.id, { enabled: false, dispose: null, error: null })

  // 自有 settings 命名空间（dsh-dock）：图片理解代理等插件配置的持久化；
  // 读取走 settings.get（内存 resolved 值，写入经 settings.mutate，均热生效）
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.register(DOCK_NS, DockConfig, {})
  })

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

  // 默认启用已实现的功能（与 Client 半部 defaultEnabled 对齐）。
  // Client 侧功能开关已 localStorage 持久化（v0.5.0）；Host↔Client 的开关双向同步仍未打通，
  // 在此之前 Host 侧开关以本处 defaultEnabled 为准（面板停用某功能只影响浏览器侧 UI）。
  for (const f of FEATURES) {
    if (f.defaultEnabled) setEnabled(f.id, true)
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
