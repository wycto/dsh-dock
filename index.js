// dsh-dock · Host 半部（Node 侧入口）
//
// v0.1.0 基础框架：
//   - 功能注册表（FEATURES）：与 Client 半部注册表同构，规划中的功能已登记；
//   - 每功能独立生命周期（hostSetups 返回 disposer，开关只影响自己）；
//   - 函数级错误隔离：单个功能 setup 抛错只标记 error，不影响其他功能。
//
// 路线图：
//   - 0.2.0 接入模型余额：在 hostSetups.balance 里实现余额拉取，
//     Client↔Host 联通（typert）随本版本一起打通；
//   - 0.3.0 接入 Token 用量记录：hostSetups.tokenlog 监听事件记账；
//   - 0.4.0 接入任务动画。
export const name = 'dsh-dock'

export function apply(ctx) {
  // ---- 功能注册表（Host 侧）----
  // defaultEnabled 缺省为 false：v0.1.0 只有示例功能，真实功能按路线图接入后打开。
  const FEATURES = [
    {
      id: 'balance',
      name: '模型余额',
      roadmap: '0.2.0',
      description: '拉取所有模型 Provider 账户余额',
    },
    {
      id: 'tokenlog',
      name: 'Token 用量记录',
      roadmap: '0.3.0',
      description: '记录全部 LLM API 调用并统计',
    },
    {
      id: 'animation',
      name: '任务动画',
      roadmap: '0.4.0',
      description: '任务进度动画与通知',
    },
  ]

  const state = new Map()
  for (const f of FEATURES) state.set(f.id, { enabled: false, dispose: null, error: null })

  // 每个功能的 Host 半部安装函数：返回 disposer，关闭功能时调用。
  // 接入时在此实现，例如：
  //   balance: () => {
  //     const stop = ctx.interval(pullBalance, 60_000)
  //     return () => stop()
  //   },
  const hostSetups = {}

  function setEnabled(id, enabled) {
    const st = state.get(id)
    if (!st || st.enabled === enabled) return
    st.enabled = enabled
    st.error = null
    if (enabled) {
      const setup = hostSetups[id]
      if (setup) {
        try {
          st.dispose = setup() || null
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