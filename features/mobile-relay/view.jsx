// dsh-dock · 功能模块【远程访问】· 客户端视图
// 单实例架构：主 DSH 只监听 127.0.0.1；局域网/虚拟网设备经账号密码登录的网关
// 访问同一个 DSH（会话、任务进度实时一致）。本视图管理：开启/关闭入口、账号密码、
// 访问地址二维码；远程设备上经 window.__DSH_REMOTE__ 显示退出登录。
import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'

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
    {active ? <div className="dmr-share"><div className="dmr-share-layout"><div className="dmr-qr-card">{qr ? <img src={qr} alt="远程访问地址二维码" width="220" height="220"/> : <div className="dmr-qr-loading">正在生成二维码…</div>}<strong>扫码或输入地址</strong><small>打开后输入账号密码登录</small></div><div className="dmr-share-detail"><div><span className="dmr-eyebrow"><i/> 登录网关已运行</span><h4>{lanLink}</h4></div><div className="dmr-link" title={lanLink}>{lanLink}</div><div className="dmr-share-actions"><button type="button" className="dmr-primary" onClick={copyLink} disabled={!lanLink}><RelayIcon name="copy"/>复制地址</button><button type="button" className="dmr-secondary dmr-danger" onClick={disable} disabled={busy === 'stop'}><RelayIcon name="close"/>{busy === 'stop' ? '正在关闭…' : '关闭远程访问'}</button></div><small>主实例保持仅本机（结构上不存在免登录直连）；账号密码只发给自己。若开启前已有旧服务器模式（0.0.0.0）配置，会一并移除并提示重启。</small></div></div></div>
      : <button type="button" className="dmr-primary" onClick={enable} disabled={busy === 'start'}>{busy === 'start' ? '正在开启…' : <><RelayIcon name="link"/>开启远程访问</>}</button>}
    {active ? <div className="dmr-section"><div className="dmr-section-head"><h4>修改账号密码</h4><button type="button" className="dmr-text-button" onClick={() => setChanging((v) => !v)}>{changing ? '收起' : '修改'}</button></div>{changing ? <div className="dmr-note"><div className="dmr-network-grid"><label className="dmr-field"><span>账号</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"/></label><label className="dmr-field"><span>新密码</span><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" placeholder="至少 6 位"/></label></div><button type="button" className="dmr-secondary" onClick={saveAuth} disabled={busy === 'auth' || !username.trim() || newPassword.length < 6}>{busy === 'auth' ? '保存中…' : '保存（所有设备重新登录）'}</button></div> : <p className="dmr-note">当前账号：{lan.username || '—'}。修改后所有已登录设备将被强制退出。</p>}</div> : null}
    {message ? <div className={'dmr-message ' + (messageKind === 'success' ? 'success' : 'error')} role="alert">{message}</div> : null}
  </section>
}

export function MobileRelayView() {
  return <RemoteCard/>
}

export function MobileRelayHomeStat() {
  const [summary, setSummary] = useState('未开启，开启后可远程登录')
  useEffect(() => {
    rpc('lan').then((data) => {
      setSummary(data.gatewayActive ? '入口运行中 · 端口 ' + data.gatewayPort : data.accountSet ? '账号已设置，入口未开启' : '未开启，开启后可远程登录')
    }).catch(() => {})
  }, [])
  return <span>{summary}</span>
}

export const feature = {
  id: 'mobile-relay', name: '远程访问', order: 80, accent: '#38bdf8',
  description: '账号密码登录的远程入口：所有设备访问同一个 DSH，任务进度实时一致', defaultEnabled: true,
  css: `
.dmr{--dmr-accent:var(--dk-accent,#2f6fed);--dmr-accent-soft:color-mix(in srgb,var(--dmr-accent) 13%,transparent);display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dmr h3,.dmr h4,.dmr p{margin:0}.dmr h3{font-size:17px;line-height:1.25;letter-spacing:-.01em}.dmr h4{font-size:13px}.dmr-hero,.dmr-status-head{display:flex;align-items:flex-start;gap:12px}.dmr-hero>div,.dmr-status-head>div{min-width:0;display:flex;flex-direction:column;gap:4px}.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dmr-hero-icon{width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:14px;background:var(--dmr-accent-soft);color:var(--dmr-accent);border:1px solid color-mix(in srgb,var(--dmr-accent) 35%,var(--dsw-alias-border-l1))}.dmr-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}.dmr-steps li{display:flex;gap:9px;padding:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px}.dmr-steps li>span{width:21px;height:21px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;font-size:11px;font-weight:700;color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-steps div{display:flex;flex-direction:column;gap:3px;min-width:0}.dmr-steps strong{font-size:12px}.dmr-steps small{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}.dmr-field{display:flex;flex-direction:column;gap:6px;font-weight:600}.dmr-field input,.dmr-field select,.dmr-note textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px 12px;min-height:44px;font:inherit;outline:none;transition:border-color .18s ease,box-shadow .18s ease}.dmr-field input:focus,.dmr-field select:focus,.dmr-note textarea:focus{border-color:var(--dmr-accent);box-shadow:0 0 0 3px var(--dmr-accent-soft)}.dmr-field small{font-weight:400}.dmr-network-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(150px,.6fr);gap:12px}.dmr-security{padding:12px 13px;border:1px solid color-mix(in srgb,var(--dk-warn) 48%,var(--dsw-alias-border-l1));border-radius:12px;background:color-mix(in srgb,var(--dk-warn) 9%,transparent)}.dmr-security strong{display:block;margin-bottom:4px;color:var(--dk-warn);font-size:12px}.dmr-security p{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button{font:inherit;touch-action:manipulation;cursor:pointer;transition:transform .15s ease,background .18s ease,border-color .18s ease,opacity .18s ease}.dmr-primary,.dmr-secondary{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;padding:9px 13px;font-weight:600}.dmr-primary{align-self:flex-start;border:1px solid var(--dmr-accent);background:var(--dmr-accent);color:#fff}.dmr-primary:hover{filter:brightness(1.05)}.dmr-secondary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.dmr-secondary:hover{border-color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-primary:active,.dmr-secondary:active,.dmr-icon-button:active{transform:scale(.98)}.dmr-primary:disabled,.dmr-secondary:disabled,.dmr-text-button:disabled,.dmr-icon-button:disabled{cursor:not-allowed;opacity:.5}.dmr-message{display:flex;align-items:flex-start;gap:7px;padding:10px 12px;border-radius:10px;font-size:12px}.dmr-message.success{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.dmr-message.error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.dmr-status-head{justify-content:space-between}.dmr-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dmr-accent)}.dmr-eyebrow i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px var(--dmr-accent-soft)}.dmr-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary)}.dmr-icon-button:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor}.dmr-share{display:flex;flex-direction:column;gap:9px;padding:13px;border:1px solid color-mix(in srgb,var(--dmr-accent) 32%,var(--dsw-alias-border-l1));border-radius:13px;background:var(--dmr-accent-soft)}.dmr-share-layout{display:grid;grid-template-columns:196px minmax(0,1fr);gap:16px;align-items:center}.dmr-qr-card{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px;border-radius:12px;background:#fff;color:#111827;text-align:center}.dmr-qr-card img{display:block;width:176px;height:176px;max-width:100%;object-fit:contain}.dmr-qr-card strong{font-size:12px}.dmr-qr-card small{color:#4b5563;font-size:10px}.dmr-qr-loading{display:grid;place-items:center;width:176px;height:176px;color:#64748b;font-size:12px}.dmr-share-detail{min-width:0;display:flex;flex-direction:column;gap:10px}.dmr-share-detail>div:first-child{display:flex;flex-direction:column;gap:4px}.dmr-link{padding:10px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-secondary)}.dmr-share-actions{display:flex;gap:8px;flex-wrap:wrap}.dmr-share-actions .dmr-primary{align-self:auto}.dmr-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dmr-overview-card{display:flex;flex-direction:column;gap:3px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.dmr-overview-card>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-overview-card strong{font-size:16px;letter-spacing:-.01em}.dmr-section{display:flex;flex-direction:column;gap:9px}.dmr-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.dmr-section-head small{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-text-button{border:0;background:transparent;color:var(--dmr-accent);padding:8px;min-height:36px;font-weight:600}.dmr-task-list{display:flex;flex-direction:column;gap:8px}.dmr-task{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dmr-task>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.dmr-task strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dmr-phase{flex:none;border-radius:999px;padding:3px 8px;font-size:11px;background:var(--dmr-accent-soft);color:var(--dmr-accent)}.dmr-phase.write{color:var(--dsw-alias-state-success-primary)}.dmr-phase.code{color:var(--dk-warn)}.dmr-phase.search{color:#0d9488}.dmr-empty{padding:18px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px}.dmr-note{display:flex;flex-direction:column;gap:9px;padding-top:2px}.dmr-note blockquote{margin:0;padding:10px 12px;border-left:3px solid var(--dmr-accent);border-radius:0 9px 9px 0;background:var(--dmr-accent-soft);white-space:pre-wrap;font-size:12px}.dmr-note textarea{min-height:88px;resize:vertical;line-height:1.5}.dmr-note .dmr-secondary{align-self:flex-start}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (max-width:680px){.dmr{gap:14px;font-size:14px}.dmr h3{font-size:18px}.dmr-steps{grid-template-columns:1fr;gap:8px}.dmr-steps li{padding:10px}.dmr-steps small,.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{font-size:12px}.dmr-network-grid{grid-template-columns:1fr;gap:10px}.dmr-field input,.dmr-field select{font-size:16px}.dmr-primary,.dmr-secondary{width:100%;font-size:14px}.dmr-share-layout{grid-template-columns:1fr;gap:12px}.dmr-qr-card{width:min(240px,100%);margin:0 auto}.dmr-qr-card img,.dmr-qr-loading{width:210px;height:210px}.dmr-share-actions{flex-direction:column}.dmr-share-actions .dmr-primary{width:100%}.dmr-overview{gap:8px}.dmr-overview-card{padding:11px}.dmr-status-head{gap:8px}.dmr-link{font-size:11px}.dmr-note textarea{font-size:16px;min-height:104px}.dmr-note .dmr-secondary{align-self:stretch}.dmr-compact .dmr-hero-icon{width:40px;height:40px;border-radius:13px}}@media (prefers-reduced-motion:reduce){.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button,.dmr-field input,.dmr-field select,.dmr-note textarea{transition:none}}.dmr-lan{flex:none;margin-top:6px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l1)}.dmr-lan-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dmr-lan-title{min-width:0;display:flex;flex-direction:column;gap:4px}.dmr-lan-title p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dmr-lan-badge{flex:none;display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:5px 10px;font-size:11px;font-weight:700;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}.dmr-lan-badge.on{border-color:color-mix(in srgb,var(--dmr-accent) 45%,transparent);background:var(--dmr-accent-soft);color:var(--dmr-accent)}.dmr-lan-active,.dmr-lan-idle{display:flex;flex-direction:column;gap:12px}.dmr-lan-active .dmr-share-detail small strong{color:var(--dsw-alias-state-error-primary)}.dmr-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,var(--dsw-alias-border-l2));color:var(--dsw-alias-state-error-primary)}.dmr-danger:hover{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}`,
  View: MobileRelayView, HomeStat: MobileRelayHomeStat,
}
