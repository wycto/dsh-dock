// dsh-dock · 功能模块【远程访问】· 客户端视图
// 单实例架构：主 DSH 只监听 127.0.0.1；局域网/虚拟网设备经账号密码登录的网关
// 访问同一个 DSH（会话、任务进度实时一致）。本视图管理：开启/关闭入口、账号密码、
// 访问地址二维码；远程设备上经 window.__DSH_REMOTE__ 显示退出登录。
import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { openPanel, subscribePanel, panelNav } from '../../src/shared.js'

function rpc(method, payload) {
  return fetch('/dsh-dock/mobile-relay/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}))
    if (res.ok && body && body.ok) return body.data
    if (res.status === 404 || res.status === 405) throw new Error('宿主进程仍是旧版本，请重启 dsh web 后再试')
    throw new Error((body && body.error && body.error.message) || ('请求失败（' + res.status + '）'))
  })
}
function copy(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(value)
  return Promise.reject(new Error('当前浏览器不支持复制，请长按或手动复制'))
}

function RelayIcon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (name === 'link') return <svg {...common}><path d="M10.5 13.5a4 4 0 0 0 5.66.01l2-2a4 4 0 0 0-5.66-5.66l-1.15 1.14"/><path d="M13.5 10.5a4 4 0 0 0-5.66-.01l-2 2a4 4 0 0 0 5.66 5.66l1.15-1.14"/></svg>
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>
  if (name === 'close') return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>
  if (name === 'check') return <svg {...common}><path d="m5 12 4.2 4.2L19 6.5"/></svg>
  return <svg {...common}><circle cx="12" cy="12" r="8"/><path d="M12 8v4l2.5 2"/></svg>
}

function useCompact() {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 680px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 680px)')
    const update = () => setCompact(media.matches); update(); media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return compact
}

/** 远程访问卡片：入口开关、账号密码、访问地址二维码、退出登录。 */
function RemoteCard() {
  const compact = useCompact()
  const [lan, setLan] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [port, setPort] = useState('')
  const [address, setAddress] = useState('')
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [messageKind, setMessageKind] = useState('error')
  const [changing, setChanging] = useState(false)
  const [remote, setRemote] = useState(false)

  const notify = useCallback((text, kind) => { setMessage(text); setMessageKind(kind || 'error') }, [])

  const refresh = useCallback(async () => {
    try {
      const data = await rpc('lan')
      setLan(data)
      setAddress((prev) => prev || (data.addresses && data.addresses[0] ? data.addresses[0].address : ''))
      setUsername((prev) => prev || (data.username || ''))
    } catch (e) { notify(e && e.message ? e.message : String(e)) }
  }, [notify])
  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [refresh])
  useEffect(() => {
    // 页面经网关访问时（网关注入 health 探针可用），显示退出登录。
    fetch('/__dsh_auth/health', { method: 'POST' }).then((r) => setRemote(Boolean(r.ok))).catch(() => setRemote(false))
  }, [])

  const active = Boolean(lan && lan.gatewayActive)
  const gatewayPort = lan && lan.gatewayPort ? lan.gatewayPort : 3081
  // 未开启时的建议端口：跟随主实例端口（+1）。网关和主服务是同一台机器上的两个
  // 监听，结构上不能同端口；主端口只留给本机，网关端口给其他设备登录用。
  const suggestedPort = lan && lan.mainPort ? lan.mainPort + 1 : gatewayPort
  const lanLink = useMemo(() => (address && active ? 'http://' + address + ':' + gatewayPort : ''), [address, active, gatewayPort])
  useEffect(() => {
    let live = true
    if (!lanLink) { setQr(''); return () => { live = false } }
    QRCode.toDataURL(lanLink, { errorCorrectionLevel: 'M', margin: 2, width: 220, color: { dark: '#111827', light: '#ffffff' } })
      .then((value) => { if (live) setQr(value) }).catch(() => {})
    return () => { live = false }
  }, [lanLink])

  async function enable() {
    notify('')
    if (!lan.accountSet && (!username.trim() || password.length < 6)) {
      notify('首次开启请设置账号和至少 6 位的密码。'); return
    }
    setBusy('start')
    try {
      const payload = {}
      if (username.trim() && newPassword) { payload.username = username.trim(); payload.password = newPassword }
      else if (!lan.accountSet) { payload.username = username.trim(); payload.password = password }
      const numericPort = Number(port)
      if (Number.isInteger(numericPort) && numericPort >= 1024 && numericPort <= 65535) payload.port = numericPort
      const data = await rpc('lan/start', payload)
      setLan(data); setPassword(''); setNewPassword(''); setChanging(false)
      notify('远程访问已开启：设备访问下方地址并用账号密码登录。' + (data.needsRestart ? '（工作区目录的浏览选择需重启 dsh web 后可用）' : ''), 'success')
    } catch (e) { notify(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  async function disable() {
    notify('')
    setBusy('stop')
    try {
      const data = await rpc('lan/stop', {})
      setLan(data)
      notify('远程访问已关闭，已登录设备全部退出。' + (data.needsRestart ? '重启 dsh web 后恢复工作区原生选择器。' : ''), 'success')
    } catch (e) { notify(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  async function saveAuth() {
    notify('')
    if (!username.trim() || newPassword.length < 6) { notify('请填写账号和至少 6 位的新密码。'); return }
    setBusy('auth')
    try {
      const data = await rpc('auth/set', { username: username.trim(), password: newPassword })
      setLan(data); setPassword(''); setNewPassword(''); setChanging(false)
      notify('账号密码已更新，所有设备需重新登录。', 'success')
    } catch (e) { notify(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  function copyLink() {
    copy(lanLink).then(() => notify('地址已复制。', 'success')).catch((e) => notify(e.message))
  }
  function logout() {
    const info = typeof window !== 'undefined' ? window.__DSH_REMOTE__ : null
    if (info && info.logout) window.location.href = info.logout
  }

  return <section className={'dmr ' + (compact ? 'dmr-compact' : '')}>
    <div className="dmr-status-head"><div><span className="dmr-eyebrow"><i/> 远程访问</span><h3>{active ? '入口已开启' : '从任何设备访问这个 DSH'}</h3><p>{active ? '设备访问下方地址，用账号密码登录即可使用完整 DSH（与本机同一实例，任务进度实时一致）。' : '开启后，局域网/虚拟网设备访问网关地址并登录，即可使用与本机完全一致的 DSH。'}</p></div>{remote && <button type="button" className="dmr-secondary" onClick={logout}><RelayIcon name="close"/>退出登录</button>}</div>
    <ol className="dmr-steps"><li><span>1</span><div><strong>设置账号密码</strong><small>远程登录的唯一凭据，改密后所有设备重新登录。</small></div></li><li><span>2</span><div><strong>开启入口</strong><small>网关监听 0.0.0.0（默认主端口+1，可改），主实例保持仅本机。</small></div></li><li><span>3</span><div><strong>设备访问</strong><small>扫码或输入地址登录；异地组网（Tailscale 等）用组网 IP 直连。</small></div></li></ol>
    {!active ? <div className="dmr-network-grid">
      <label className="dmr-field"><span>账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" placeholder="登录账号"/></label>
      <label className="dmr-field"><span>密码</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" placeholder={lan && lan.accountSet ? '已设置，留空沿用' : '至少 6 位'}/></label>
    </div> : null}
    <div className="dmr-network-grid">
      <label className="dmr-field"><span>监听端口</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" type="number" min="1024" max="65535" placeholder={'默认 ' + suggestedPort} aria-describedby="dmr-lan-port-help"/><small id="dmr-lan-port-help">网关和主服务是同一台机器上的两个端口，不能相同：主实例 {lan && lan.mainPort ? lan.mainPort : '…'} 只留给本机，其他设备走网关端口登录。留空即用 {suggestedPort}（主端口+1）。</small></label>
      <div className="dmr-security"><strong>安全说明</strong><p>主实例保持仅监听 127.0.0.1：远程设备只能经这个登录网关进入，不存在免登录的直连路径。账号密码只发给自己；改密后所有设备需重新登录。</p></div>
    </div>
    {active ? <div className="dmr-share"><div className="dmr-share-layout"><div className="dmr-qr-card">{qr ? <img src={qr} alt="远程访问地址二维码" width="220" height="220"/> : <div className="dmr-qr-loading">正在生成二维码…</div>}<strong>扫码或输入地址</strong><small>打开后输入账号密码登录</small></div><div className="dmr-share-detail"><div><span className="dmr-eyebrow"><i/> 登录网关已运行</span><h4>{lanLink}</h4></div><div className="dmr-link" title={lanLink}>{lanLink}</div><div className="dmr-share-actions"><button type="button" className="dmr-primary" onClick={copyLink} disabled={!lanLink}><RelayIcon name="copy"/>复制地址</button><button type="button" className="dmr-secondary dmr-danger" onClick={disable} disabled={busy === 'stop'}><RelayIcon name="close"/>{busy === 'stop' ? '正在关闭…' : '关闭远程访问'}</button></div><small>已登录设备：{typeof lan.devices === 'number' ? lan.devices : 0} 台（改密或关闭入口即全部下线）</small><small>主实例保持仅本机（结构上不存在免登录直连）；账号密码只发给自己。若开启前已有旧服务器模式（0.0.0.0）配置，会一并移除并提示重启。</small></div></div></div>
      : <button type="button" className="dmr-primary" onClick={enable} disabled={busy === 'start'}>{busy === 'start' ? '正在开启…' : <><RelayIcon name="link"/>开启远程访问</>}</button>}
    {active ? <div className="dmr-section"><div className="dmr-section-head"><h4>修改账号密码</h4><button type="button" className="dmr-text-button" onClick={() => setChanging((v) => !v)}>{changing ? '收起' : '修改'}</button></div>{changing ? <div className="dmr-note"><div className="dmr-network-grid"><label className="dmr-field"><span>账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"/></label><label className="dmr-field"><span>新密码</span><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" placeholder="至少 6 位"/></label></div><button type="button" className="dmr-secondary" onClick={saveAuth} disabled={busy === 'auth' || !username.trim() || newPassword.length < 6}>{busy === 'auth' ? '保存中…' : '保存（所有设备重新登录）'}</button></div> : <p className="dmr-note">当前账号：{lan.username || '—'}。修改后所有已登录设备将被强制退出。</p>}</div> : null}
    {message ? <div className={'dmr-message ' + (messageKind === 'success' ? 'success' : 'error')} role="alert">{message}</div> : null}
  </section>
}

export function MobileRelayView() {
  return <RemoteCard/>
}

/**
 * 手机端会话抽屉（窄屏 ≤700px）：底部 Tab 栏「会话」页签拉出侧边栏 + 遮罩点击收起。
 *
 * 直接操作 document.body 下的 DOM（渲染返回 null）——若作为 overlayLayer 的子元素，
 * 会落入 overlayLayer（z 90）的堆叠上下文，遮罩压不住侧栏抽屉（z 80）、Tab 栏也盖不住内容；
 * 挂到 body 下 z 序才是设计值（遮罩 75 < 侧栏 80 < overlayLayer 90）。
 * 左缘浮动「抽屉把手」已移除（与底部 Tab 栏「会话」页签功能重复，还悬浮在内容上）。
 *
 * 与宿主 tapIndex 注入版（features/mobile-relay/host.js，重启 dsh web 后才生效）互斥：
 * window.__dshDockMobileDrawer 先到先得——宿主脚本在 <head> 先跑并置 'host'，本组件
 * 见旗标即整体让位（遮罩/底部 Tab/收起逻辑全归宿主）；宿主未就位（旧版无注入、
 * 或刷新早于重启）时本组件自建全套。本组件的价值是 client bundle 按内容 hash 服务、
 * 刷新页面即生效，无需重启。
 * ⚠️ 两个版本绝不能各建一套：曾出现双底部 Tab 栏（两套按钮叠在一起）与客户端 CSS
 * 覆盖宿主 place() 定位的回归。
 * 与旧版宿主行为脚本并存是安全的：收起链路同一事件内第二次 collapse() 因 aria-label
 * 已翻转而自然空转。
 */
export function MobileRelayOverlay() {
  // —— 预览版说明自动确认（独立 effect，与下方抽屉 chrome 的宿主互斥无关）——
  // 根因（dsh 0.2.0-rc.2 ui-settings-models/src/client/welcome-store.ts，文件头注释原文）：
  // 回环浏览器的确认走宿主持久化，一次确认永久生效；**远程（非回环）浏览器的设置 scope
  // 是 memory 模式，确认只存页面进程内存，刷新即丢**——所以从局域网/组网 IP 打开时
  // 「预览版说明」每次刷新都重弹，profile patch 里钉 welcomeNoticeVersion 也救不了
  // （memory 分支根本不读持久值）。这里在远程访问场景下替用户点一次「继续」：
  // 每次页面加载最多点一次，回环地址不介入（让 dsh 原生的一次性持久确认自然工作）。
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
    const host = (window.location && window.location.hostname) || ''
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.endsWith('.localhost')
    if (loopback) return undefined
    if (typeof MutationObserver === 'undefined') return undefined
    let done = false
    const tryDismiss = () => {
      if (done) return
      const dialogs = document.querySelectorAll('[role="dialog"]')
      for (const dialog of dialogs) {
        const text = (dialog.textContent || '')
        if (!/预览版说明|Preview Notice/.test(text)) continue
        const btn = [...dialog.querySelectorAll('button')].find((b) => {
          const t = (b.textContent || '').trim()
          return t === '继续' || t === 'Continue'
        })
        if (btn) {
          done = true
          btn.click()
          observer.disconnect()
        }
        break
      }
    }
    const observer = new MutationObserver(tryDismiss)
    observer.observe(document.body, { childList: true, subtree: true })
    tryDismiss()
    // 兜底停止：说明若 60 秒内没出现（未来版本改版/被官方移除），观察器自动退场
    const stopTimer = setTimeout(() => observer.disconnect(), 60000)
    return () => { clearTimeout(stopTimer); observer.disconnect() }
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
    const mq = window.matchMedia ? window.matchMedia('(max-width:700px)') : null
    if (!mq) return undefined
    // 宿主版接管中：整套 chrome 由宿主负责，本组件零副作用退出。
    if (window.__dshDockMobileDrawer === 'host') return undefined
    window.__dshDockMobileDrawer = 'client'

    const narrow = () => mq.matches
    const frameEl = () => document.querySelector('[class$="frame"]')
    const sidebarCollapsed = () => { const f = frameEl(); return !!f && f.hasAttribute('data-sidebar-collapsed') }
    const dialogOpen = () => !!document.querySelector('[role="dialog"][class*="panel"]')
    // 右侧详情面板：dsh 0.1.7 起 detailsCol 改名 rightbarCol，窄屏原生全屏展开
    // （data-sidebar-right-panel / data-sidebar-right-open，折叠钮 data-sidebar-right-toggle）。
    const rightOpen = () => !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')
    const collapse = () => { const b = document.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]'); if (b) b.click() }
    const expand = () => { const b = document.querySelector('button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]'); if (b) b.click() }
    const closeDetails = () => {
      const panel = document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')
      if (!panel) return
      const toggle = panel.querySelector('[data-sidebar-right-toggle]')
      if (toggle) toggle.click()
    }

    // 抽屉遮罩：侧栏展开（浮层态）时盖住页面，点击经全局捕获 handler 收起。
    // 左缘的浮动「抽屉把手」已移除：底部 Tab 栏的「会话」页签就是会话抽屉的唯一入口，
    // 把手悬浮在内容上还压过输入区左下角（用户实测截图），纯属重复。
    const scrim = document.createElement('div')
    scrim.className = 'dsh-mobile-scrim'
    document.body.appendChild(scrim)

    // ---- 仿 ZCode 手机端底部 Tab 栏：会话 / 插件 / 设置 ----
    // 「任务」「功能坞」合并为一个「插件」页签（用户反馈两个入口冗余）：插件面板里
    // 本来就有运行状态页，任务状态以角标显示在「插件」上——进行中蓝色数量、等待确认
    // 红色脉冲；有任务在跑时点「插件」直接落到运行状态页，否则进面板首页。
    // 挂 body（避开 overlayLayer 堆叠上下文），z 序 65：
    // 低于遮罩 75 / 侧栏抽屉 80 / 功能坞面板 200，这些打开时自然盖住 Tab 栏。
    // 走到这里说明宿主旗标不存在（宿主版未注入）——宿主版自建的 Tab 栏不会出现；
    // 兜底摘一次历史上可能残留的旧 Tab 栏，保证全程只有一份。
    document.querySelectorAll('.dsh-mobile-tabbar').forEach((el) => el.remove())
    const tabbar = document.createElement('nav')
    tabbar.className = 'dsh-mobile-tabbar'
    tabbar.setAttribute('aria-label', '底部导航')
    // 最近一次角标轮询看到的任务数（驱动「插件」页签的直达目标与角标显隐）。
    let tasksActive = 0
    let tasksWaiting = 0
    const tabDefs = [
      {
        id: 'sessions', label: '会话',
        icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
        act: () => expand(),
      },
      {
        id: 'dock', label: '插件',
        icon: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
        act: () => {
          // 始终打开、不再当开关用：若功能坞处于打开态但被原生全屏页/弹层（如从侧栏
          // 进的官方插件管理页）盖住，再点一下会把功能坞关掉、露出的反而是原生页——
          // 看起来就是「点插件出官方插件页」（用户实测截图）。关闭走面板自己的 ✕。
          // 配合手机端把功能坞面板 z 序抬到原生弹层之上（媒体查询内 2000）。
          openPanel((tasksActive > 0 || tasksWaiting > 0) ? 'runstate' : 'home')
        },
      },
      {
        id: 'settings', label: '设置',
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
        act: () => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '设置' || (x.textContent || '').trim() === '设置'); if (b) b.click() },
      },
    ]
    let tasksBadge = null
    const tabButtons = tabDefs.map((def) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'dsh-mobile-tab'
      b.dataset.tab = def.id
      b.innerHTML = def.icon + '<span>' + def.label + '</span>'
      b.addEventListener('click', () => def.act())
      if (def.id === 'dock') {
        tasksBadge = document.createElement('span')
        tasksBadge.className = 'dsh-mobile-tab-badge'
        tasksBadge.style.display = 'none'
        b.appendChild(tasksBadge)
      }
      tabbar.appendChild(b)
      return b
    })
    document.body.appendChild(tabbar)
    const syncTabs = () => {
      const expanded = !sidebarCollapsed()
      const settingsOpen = dialogOpen()
      for (const b of tabButtons) {
        const id = b.dataset.tab
        const on = (id === 'sessions' && expanded)
          || (id === 'dock' && panelNav.open)
          || (id === 'settings' && settingsOpen)
        b.classList.toggle('on', on)
      }
    }
    const unsubPanel = subscribePanel(syncTabs)

    // 「任务」角标：低频轮询 runstate 宿主路由（3s，仅窄屏 + 页面可见时发）；
    // 进行中 = 蓝色数量，等待确认 = 红色数量 + 脉冲。路由不存在（runstate 未启用
    // 或宿主旧版）时静默停轮询并摘掉角标，不报错不打扰。
    let runstateGone = false
    const pollTasks = () => {
      if (runstateGone || !tasksBadge || !narrow() || document.visibilityState === 'hidden' || !tabbar.isConnected) return
      fetch('/dsh-dock/runstate/status', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      }).then(async (res) => {
        if (res.status === 404 || res.status === 405) { runstateGone = true; tasksActive = 0; tasksWaiting = 0; tasksBadge.style.display = 'none'; return null }
        const body = await res.json().catch(() => null)
        if (!body) return null
        const active = (body.data && body.data.active) || []
        const waiting = active.filter((t) => t.approvals && t.approvals.length).length
        tasksActive = active.length
        tasksWaiting = waiting
        if (waiting > 0) {
          tasksBadge.textContent = String(waiting)
          tasksBadge.className = 'dsh-mobile-tab-badge wait'
          tasksBadge.style.display = ''
        } else if (active.length > 0) {
          tasksBadge.textContent = String(active.length)
          tasksBadge.className = 'dsh-mobile-tab-badge'
          tasksBadge.style.display = ''
        } else {
          tasksBadge.style.display = 'none'
        }
      }).catch(() => {})
    }
    const tasksTimer = setInterval(pollTasks, 3000)

    // 软键盘判定：visualViewport 与布局视口高度差超阈值视为键盘弹出（挂
    // html.dsh-dock-kbd，样式表随之隐藏 Tab 栏并收窄滚动体留白——打字时
    // 这两样只会挤占键盘上方的一线空间）。老内核没有 visualViewport 就跳过
    // （那些内核键盘行为是整页缩放，原生命中适配）。
    const vv = window.visualViewport || null
    const kbdSync = () => {
      if (!vv) return
      const kbd = vv.height > 0 && (window.innerHeight - vv.height) > 120
      document.documentElement.classList.toggle('dsh-dock-kbd', kbd)
    }

    const sync = () => {
      kbdSync()
      // 兜底摘除历史上可能残留的旧 Tab 栏（正常路径下走到这里说明宿主版未注入，
      // 不会有第二份；保险起见 sync 周期里也保持全局只有一份）。
      document.querySelectorAll('.dsh-mobile-tabbar').forEach((el) => { if (el !== tabbar) el.remove() })
      const on = narrow() && !!frameEl() && !dialogOpen()
      const collapsed = sidebarCollapsed()
      // 右侧详情面板（窄屏原生全屏，z 40）打开时：Tab 栏 65 比它高会压边，整体让位，
      // 面板收起（它自带折叠钮）后再回来。
      const right = rightOpen()
      if (scrim) scrim.style.display = on && !collapsed ? '' : 'none'
      // Tab 栏：窄屏且页面骨架就绪后常驻；功能坞面板/设置弹窗/右侧详情面板打开时隐藏（避免露边压内容）
      tabbar.style.display = narrow() && !!frameEl() && !panelNav.open && !right ? '' : 'none'
      syncTabs()
    }
    sync()
    pollTasks()
    // MutationObserver 跟属性翻转即时同步；1.5s 轮询覆盖路由重渲等一切边角
    const observer = typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : null
    if (observer) observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar-collapsed'], subtree: true })
    const timer = setInterval(sync, 1500)
    const onMq = () => sync()
    if (mq.addEventListener) mq.addEventListener('change', onMq)
    else if (mq.addListener) mq.addListener(onMq)
    window.addEventListener('resize', kbdSync)
    if (vv && vv.addEventListener) vv.addEventListener('resize', kbdSync)
    const onVisible = () => { if (document.visibilityState === 'visible') pollTasks() }
    document.addEventListener('visibilitychange', onVisible)

    // 捕获阶段统一处理（仅自建模式；宿主就位时宿主已有同款全局捕获）：
    // Tab 栏自身排除（否则页签动作会被"点外部收起"当场撤销）；
    // 遮罩不挂自己的 click——它的点击也走这里 collapse()，单一路径防止同一事件两次 toggle。
    const onClick = (e) => {
      if (!narrow()) return
      const t = e.target
      if (!t || !t.closest) return
      if (t.closest('.dsh-mobile-tabbar')) return
      const expanded = !!document.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]')
      const col = document.querySelector('[class*="sidebarCol"]')
      const inSidebar = col && col.contains(t)
      if (!expanded && !inSidebar) return
      if (inSidebar) {
        // 只有点「会话」才收抽屉：会话行的 data-row-key 以 session: 开头（0.1.7 结构，
        // ui-workspace Rows.tsx）；工作区文件夹行是 workspace: 开头——点它只是展开/收拢
        // 分组，不能收抽屉（旧的「无子 treeitem 即叶子」判定会误伤折叠状态的文件夹：
        // 折叠时其子节点不在 DOM 里）。搜索结果行无 data-row-key，回退按无子叶判定。
        const row = t.closest('[role="treeitem"]')
        const rowKey = (row && row.getAttribute('data-row-key')) || ''
        const sessionRow = (rowKey && rowKey.startsWith('session:'))
          || (row && !rowKey && !row.querySelector('[role="treeitem"]') && row.closest('[role="tree"]'))
        const fresh = t.closest('[class*="newSession"]')
        if (sessionRow || fresh) setTimeout(() => { collapse(); closeDetails() }, 300)
        else {
          // 侧栏入口（插件/自动化任务/设置/记忆/自动进化…）点击后会弹出面板，而面板
          // z 序常低于展开的抽屉——被盖住等于「点了没反应」（用户实测截图）。稍候
          // 探测：有面板弹出就收起抽屉让它露出来；目录折叠/搜索等不弹面板的点击不受影响。
          setTimeout(() => { if (document.querySelector('[role="dialog"]')) collapse() }, 260)
        }
        return
      }
      if (t.closest('[role="dialog"],[class*="dockm"],[class*="dgfab"],[class*="dgwin"],[class*="dgame"],[data-sidebar-right-panel]')) return
      collapse()
    }
    document.addEventListener('click', onClick, true)

    return () => {
      document.removeEventListener('click', onClick, true)
      if (observer) observer.disconnect()
      clearInterval(timer)
      clearInterval(tasksTimer)
      unsubPanel()
      if (mq.removeEventListener) mq.removeEventListener('change', onMq)
      else if (mq.removeListener) mq.removeListener(onMq)
      window.removeEventListener('resize', kbdSync)
      if (vv && vv.removeEventListener) vv.removeEventListener('resize', kbdSync)
      document.removeEventListener('visibilitychange', onVisible)
      document.documentElement.classList.remove('dsh-dock-kbd')
      if (scrim) scrim.remove()
      tabbar.remove()
      if (window.__dshDockMobileDrawer === 'client') delete window.__dshDockMobileDrawer
    }
  }, [])
  return null
}

export function MobileRelayHomeStat() {
  const [summary, setSummary] = useState('未开启，开启后可远程登录')
  useEffect(() => {
    const refresh = () => {
      rpc('lan').then((data) => {
        const devices = typeof data.devices === 'number' && data.devices > 0 ? ' · ' + data.devices + ' 台设备在线' : ''
        setSummary(data.gatewayActive ? '入口运行中 · 端口 ' + data.gatewayPort + devices : data.accountSet ? '账号已设置，入口未开启' : '未开启，开启后可远程登录')
      }).catch(() => {})
    }
    refresh()
    const timer = setInterval(refresh, 10000)
    return () => clearInterval(timer)
  }, [])
  return <span>{summary}</span>
}

export const feature = {
  id: 'mobile-relay', name: '远程访问', order: 80, accent: '#38bdf8',
  description: '账号密码登录的远程入口：所有设备访问同一个 DSH，任务进度实时一致', defaultEnabled: false,
  css: `
.dmr{--dmr-accent:var(--dk-accent,#2f6fed);--dmr-accent-soft:color-mix(in srgb,var(--dmr-accent) 13%,transparent);display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dmr h3,.dmr h4,.dmr p{margin:0}.dmr h3{font-size:17px;line-height:1.25;letter-spacing:-.01em}.dmr h4{font-size:13px}.dmr-hero,.dmr-status-head{display:flex;align-items:flex-start;gap:12px}.dmr-hero>div,.dmr-status-head>div{min-width:0;display:flex;flex-direction:column;gap:4px}.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dmr-hero-icon{width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:14px;background:var(--dmr-accent-soft);color:var(--dmr-accent);border:1px solid color-mix(in srgb,var(--dmr-accent) 35%,var(--dsw-alias-border-l1))}.dmr-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}.dmr-steps li{display:flex;gap:9px;padding:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px}.dmr-steps li>span{width:21px;height:21px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;font-size:11px;font-weight:700;color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-steps div{display:flex;flex-direction:column;gap:3px;min-width:0}.dmr-steps strong{font-size:12px}.dmr-steps small{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}.dmr-field{display:flex;flex-direction:column;gap:6px;font-weight:600}.dmr-field input,.dmr-field select,.dmr-note textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px 12px;min-height:44px;font:inherit;outline:none;transition:border-color .18s ease,box-shadow .18s ease}.dmr-field input:focus,.dmr-field select:focus,.dmr-note textarea:focus{border-color:var(--dmr-accent);box-shadow:0 0 0 3px var(--dmr-accent-soft)}.dmr-field small{font-weight:400}.dmr-network-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(150px,.6fr);gap:12px}.dmr-security{padding:12px 13px;border:1px solid color-mix(in srgb,var(--dk-warn) 48%,var(--dsw-alias-border-l1));border-radius:12px;background:color-mix(in srgb,var(--dk-warn) 9%,transparent)}.dmr-security strong{display:block;margin-bottom:4px;color:var(--dk-warn);font-size:12px}.dmr-security p{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button{font:inherit;touch-action:manipulation;cursor:pointer;transition:transform .15s ease,background .18s ease,border-color .18s ease,opacity .18s ease}.dmr-primary,.dmr-secondary{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;padding:9px 13px;font-weight:600}.dmr-primary{align-self:flex-start;border:1px solid var(--dmr-accent);background:var(--dmr-accent);color:#fff}.dmr-primary:hover{filter:brightness(1.05)}.dmr-secondary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.dmr-secondary:hover{border-color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-primary:active,.dmr-secondary:active,.dmr-icon-button:active{transform:scale(.98)}.dmr-primary:disabled,.dmr-secondary:disabled,.dmr-text-button:disabled,.dmr-icon-button:disabled{cursor:not-allowed;opacity:.5}.dmr-message{display:flex;align-items:flex-start;gap:7px;padding:10px 12px;border-radius:10px;font-size:12px}.dmr-message.success{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.dmr-message.error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.dmr-status-head{justify-content:space-between}.dmr-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dmr-accent)}.dmr-eyebrow i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px var(--dmr-accent-soft)}.dmr-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary)}.dmr-icon-button:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor}.dmr-share{display:flex;flex-direction:column;gap:9px;padding:13px;border:1px solid color-mix(in srgb,var(--dmr-accent) 32%,var(--dsw-alias-border-l1));border-radius:13px;background:var(--dmr-accent-soft)}.dmr-share-layout{display:grid;grid-template-columns:196px minmax(0,1fr);gap:16px;align-items:center}.dmr-qr-card{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px;border-radius:12px;background:#fff;color:#111827;text-align:center}.dmr-qr-card img{display:block;width:176px;height:176px;max-width:100%;object-fit:contain}.dmr-qr-card strong{font-size:12px}.dmr-qr-card small{color:#4b5563;font-size:10px}.dmr-qr-loading{display:grid;place-items:center;width:176px;height:176px;color:#64748b;font-size:12px}.dmr-share-detail{min-width:0;display:flex;flex-direction:column;gap:10px}.dmr-share-detail>div:first-child{display:flex;flex-direction:column;gap:4px}.dmr-link{padding:10px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-secondary)}.dmr-share-actions{display:flex;gap:8px;flex-wrap:wrap}.dmr-share-actions .dmr-primary{align-self:auto}.dmr-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dmr-overview-card{display:flex;flex-direction:column;gap:3px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.dmr-overview-card>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-overview-card strong{font-size:16px;letter-spacing:-.01em}.dmr-section{display:flex;flex-direction:column;gap:9px}.dmr-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.dmr-section-head small{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-text-button{border:0;background:transparent;color:var(--dmr-accent);padding:8px;min-height:36px;font-weight:600}.dmr-task-list{display:flex;flex-direction:column;gap:8px}.dmr-task{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dmr-task>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.dmr-task strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dmr-phase{flex:none;border-radius:999px;padding:3px 8px;font-size:11px;background:var(--dmr-accent-soft);color:var(--dmr-accent)}.dmr-phase.write{color:var(--dsw-alias-state-success-primary)}.dmr-phase.code{color:var(--dk-warn)}.dmr-phase.search{color:#0d9488}.dmr-empty{padding:18px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px}.dmr-note{display:flex;flex-direction:column;gap:9px;padding-top:2px}.dmr-note blockquote{margin:0;padding:10px 12px;border-left:3px solid var(--dmr-accent);border-radius:0 9px 9px 0;background:var(--dmr-accent-soft);white-space:pre-wrap;font-size:12px}.dmr-note textarea{min-height:88px;resize:vertical;line-height:1.5}.dmr-note .dmr-secondary{align-self:flex-start}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (max-width:680px){.dmr{gap:14px;font-size:14px}.dmr h3{font-size:18px}.dmr-steps{grid-template-columns:1fr;gap:8px}.dmr-steps li{padding:10px}.dmr-steps small,.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{font-size:12px}.dmr-network-grid{grid-template-columns:1fr;gap:10px}.dmr-field input,.dmr-field select{font-size:16px}.dmr-primary,.dmr-secondary{width:100%;font-size:14px}.dmr-share-layout{grid-template-columns:1fr;gap:12px}.dmr-qr-card{width:min(240px,100%);margin:0 auto}.dmr-qr-card img,.dmr-qr-loading{width:210px;height:210px}.dmr-share-actions{flex-direction:column}.dmr-share-actions .dmr-primary{width:100%}.dmr-overview{gap:8px}.dmr-overview-card{padding:11px}.dmr-status-head{gap:8px}.dmr-link{font-size:11px}.dmr-note textarea{font-size:16px;min-height:104px}.dmr-note .dmr-secondary{align-self:stretch}.dmr-compact .dmr-hero-icon{width:40px;height:40px;border-radius:13px}}@media (prefers-reduced-motion:reduce){.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button,.dmr-field input,.dmr-field select,.dmr-note textarea{transition:none}}.dmr-lan{flex:none;margin-top:6px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.dmr-lan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dmr-lan-title{min-width:0;display:flex;flex-direction:column;gap:4px}.dmr-lan-title p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dmr-lan-badge{flex:none;display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:700;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}.dmr-lan-badge.on{border-color:color-mix(in srgb,var(--dmr-accent) 45%,transparent);background:var(--dmr-accent-soft);color:var(--dmr-accent)}.dmr-lan-active,.dmr-lan-idle{display:flex;flex-direction:column;gap:12px}.dmr-lan-active .dmr-share-detail small strong{color:var(--dsw-alias-state-error-primary)}.dmr-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}.dmr-danger:hover{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
/* 抽屉遮罩：侧栏浮层展开时盖住页面。左缘浮动「抽屉把手」已移除——会话入口
 * 统一走底部 Tab 栏「会话」页签，把手悬浮在内容上还压过输入区（用户实测）。 */
@media (max-width:700px){.dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}
/* ---- 仿 ZCode 手机端：底部 Tab 栏 + 输入区吸附底部 ---- */
.dsh-mobile-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:65;display:flex;align-items:stretch;justify-content:space-around;padding:6px 8px calc(8px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c2230) 92%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,139,161,.25));touch-action:manipulation}
.dsh-mobile-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:48px;padding:4px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b95ab);font:600 11px/1.2 inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:10px}
.dsh-mobile-tab svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.dsh-mobile-tab.on{color:var(--dsw-alias-label-primary,#e6eaf2)}
.dsh-mobile-tab.on svg{color:var(--dk-accent,#4d9fff)}
.dsh-mobile-tab:active{transform:scale(.94)}
/* 「任务」页签角标：进行中=蓝（数量），等待确认=红（数量+脉冲）——接力场景里
 * 等待确认是最需要人介入的状态，一眼可见；数据来自 runstate 宿主路由低频轮询。 */
.dsh-mobile-tab{position:relative}
.dsh-mobile-tab-badge{position:absolute;top:0;right:calc(50% - 26px);box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:#4d9fff;color:#fff;font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}
.dsh-mobile-tab-badge.wait{background:#ef4444;animation:dsh-badge-pulse 1.2s ease-in-out infinite}
@keyframes dsh-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
@media (prefers-reduced-motion:reduce){.dsh-mobile-tab-badge.wait{animation:none}}
/* 输入区吸附到 Tab 栏上方：宿主把欢迎内容 justify-content:center 垂直居中，
 * 手机视口下输入卡片悬在中部、下方留出大片空白。改用「输入区 margin-top:auto」
 * 贴底，并给滚动体留出 Tab 栏高度的内边距，避免内容被 Tab 栏遮挡。
 * ⚠️ 绝不能给滚动体加 justify-content:flex-end/center 贴底：内容会被挤到滚动体
 * 起点之外，Chrome 不把起点方向溢出算进 scrollHeight（手机视口实测
 * scrollHeight==clientHeight、maxScroll==0），会话记录彻底滚不动、首条消息永远
 * 看不到。宿主半部旧版注入里还留着那条 flex-end（要重启 dsh web 才消失），这里
 * 用更高优先级的选择器显式复位：刷新页面即修好，不必等重启。 */
[class*="scrollBody"][data-conversation-scroll]{justify-content:flex-start !important;padding-bottom:calc(72px + env(safe-area-inset-bottom,0px)) !important}
[class*="scrollBody"]{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px)) !important}
[class*="scrollBody"]>[class*="composerSeat"]{margin-top:auto;padding-bottom:6px}
/* 输入区工具行上的 dsh-dock chip（用量/余额）：窄屏下 28cqw 的宽度上限把它们挤成
 * 「…」「余..」（手机实测），既读不出数值又白占输入行空间。手机端整组收起，数值在
 * 底部「功能坞」里看（用量/余额页信息更全）；桌面端不动。 */
.dockchip-row{display:none}
/* 收起的侧栏轨道（collapsed rail）在窄屏只剩 1px 占位，但轨道里的按钮
 * 仍会溢出贴在左边缘（功能坞/进化/设置三枚露出半边的圆钮）。隐藏整列，
 * 这些入口已由底部 Tab 栏接管；展开抽屉（z 80）不受影响。 */
[class*="sidebarCol"]:has([class*="collapsed"]){visibility:hidden}
/* 软键盘弹出（visualViewport 判定，挂 html.dsh-dock-kbd）：Tab 栏整体让位（打字时
 * 它只会挤占键盘上方的一线空间），滚动体留白收窄。选择器特异性高于上面的 72px
 * 留白规则，能压过去。宿主接管期间由宿主脚本同步置/摘这个类。 */
html.dsh-dock-kbd .dsh-mobile-tabbar{display:none !important}
html.dsh-dock-kbd [class*="scrollBody"]{padding-bottom:12px !important}
/* 功能坞面板在手机端抬到原生弹层之上：从侧栏进的官方插件管理页等原生弹层 z 序高于
 * 面板默认的 200，功能坞开在下面会被盖住——「插件」页签点了像没反应/露出原页面。 */
[class*="dockm-backdrop"]{z-index:2000 !important}}`,
  View: MobileRelayView, HomeStat: MobileRelayHomeStat, Overlay: MobileRelayOverlay,
}
