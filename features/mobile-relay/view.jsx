// dsh-dock · 功能模块【手机接力】· 客户端视图
// 手机和电脑均轮询同一个短时配对记录；业务会话继续由 DSH 原生会话服务负责同步。
import { useCallback, useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'

const DEVICE_KEY = 'dsh-dock/mobile-relay/device/v1'
const SESSION_KEY = 'dsh-dock/mobile-relay/session/v1'
const LAUNCH_KEY = 'dsh-dock/mobile-relay/launch/v1'

function rpc(method, payload) {
  return fetch('/dsh-dock/mobile-relay/' + method, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}),
  }).then(async (res) => {
    const body = await res.json().catch(() => ({}))
    if (res.ok && body && body.ok) return body.data
    if (res.status === 404 || res.status === 405) throw new Error('宿主进程仍是旧版本，请重启 dsh web 后再开启局域网连接')
    throw new Error((body && body.error && body.error.message) || ('请求失败（' + res.status + '）'))
  })
}
function deviceId() {
  let id = ''
  try { id = localStorage.getItem(DEVICE_KEY) || '' } catch { /* memory only */ }
  if (!id) {
    id = (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2))
    try { localStorage.setItem(DEVICE_KEY, id) } catch { /* memory only */ }
  }
  return id
}
function readSession() {
  try { const raw = sessionStorage.getItem(SESSION_KEY); return raw ? JSON.parse(raw) : null } catch { return null }
}
function saveSession(value) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)) } catch { /* memory state still works */ } }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY) } catch { /* ignore */ } }
function fmtDuration(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000)); const min = Math.floor(sec / 60); const rest = sec % 60
  return min > 0 ? min + ' 分 ' + String(rest).padStart(2, '0') + ' 秒' : rest + ' 秒'
}
function fmtTime(value) { return value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '' }
function phaseLabel(phase) { return ({ think: '正在思考', write: '正在输出', code: '正在开发', search: '正在查资料' })[phase] || '进行中' }
function copy(value) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(value)
  return Promise.reject(new Error('当前浏览器不支持复制，请长按或手动复制'))
}

function RelayIcon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }
  if (name === 'phone') return <svg {...common}><rect x="7" y="2.5" width="10" height="19" rx="2.2"/><path d="M10 18.5h4"/></svg>
  if (name === 'link') return <svg {...common}><path d="M10.5 13.5a4 4 0 0 0 5.66.01l2-2a4 4 0 0 0-5.66-5.66l-1.15 1.14"/><path d="M13.5 10.5a4 4 0 0 0-5.66-.01l-2 2a4 4 0 0 0 5.66 5.66l1.15-1.14"/></svg>
  if (name === 'copy') return <svg {...common}><rect x="8" y="8" width="11" height="12" rx="1.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/></svg>
  if (name === 'check') return <svg {...common}><path d="m5 12 4.2 4.2L19 6.5"/></svg>
  if (name === 'arrow') return <svg {...common}><path d="M5 12h13"/><path d="m14 7 5 5-5 5"/></svg>
  if (name === 'close') return <svg {...common}><path d="m6 6 12 12M18 6 6 18"/></svg>
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

export function MobileRelayView() {
  const compact = useCompact()
  const [session, setSession] = useState(readSession)
  const [pair, setPair] = useState(null)
  const [network, setNetwork] = useState(null)
  const [port, setPort] = useState(3081)
  const [selectedAddress, setSelectedAddress] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const mobile = session && session.role === 'mobile'

  const setCurrent = useCallback((next) => { setSession(next); next ? saveSession(next) : clearSession() }, [])
  useEffect(() => {
    if (session) return
    rpc('network').then((data) => {
      setNetwork(data)
      if (data && data.defaultPort) setPort(data.defaultPort)
      const first = data && data.addresses && data.addresses[0]
      if (first) setSelectedAddress(first.address)
    }).catch((e) => setError(e && e.message ? e.message : String(e)))
  }, [session])
  const refresh = useCallback(async (candidate = session) => {
    if (!candidate) return
    try {
      const result = await rpc('status', candidate)
      setPair(result.pair); setError('')
    } catch (e) {
      const message = e && e.message ? e.message : String(e)
      setError(message)
      if (/过期|未完成配对/.test(message)) setCurrent(null)
    }
  }, [session, setCurrent])

  useEffect(() => { if (session) refresh(session) }, [session, refresh])
  useEffect(() => {
    if (!session) return
    const timer = setInterval(() => refresh(session), 2500)
    return () => clearInterval(timer)
  }, [session, refresh])
  useEffect(() => {
    if (session) return
    let launch = ''
    try { launch = sessionStorage.getItem(LAUNCH_KEY) || '' } catch { /* ignore */ }
    if (!launch) return
    try { sessionStorage.removeItem(LAUNCH_KEY) } catch { /* ignore */ }
    const [pairId, code] = launch.split('.')
    if (!pairId || !code) return
    setBusy('join')
    rpc('join', { pairId, code, deviceId: deviceId(), label: '手机端' })
      .then((data) => { setCurrent({ pairId, secret: data.secret, role: 'mobile', deviceId: deviceId() }); setPair(data.pair); setNotice('已连接到电脑端，任务状态会持续同步。') })
      .catch((e) => setError(e && e.message ? e.message : String(e)))
      .finally(() => setBusy(''))
  }, [session, setCurrent])

  const mobileLink = useMemo(() => {
    if (!session || !session.gatewayToken || !session.gatewayAddress || !session.gatewayPort) return ''
    return 'http://' + session.gatewayAddress + ':' + session.gatewayPort + '/__dsh_mobile/connect#' + session.gatewayToken
  }, [session])
  useEffect(() => {
    let active = true
    if (!mobileLink) { setQrDataUrl(''); return () => { active = false } }
    QRCode.toDataURL(mobileLink, {
      errorCorrectionLevel: 'M', margin: 2, width: 260,
      color: { dark: '#111827', light: '#ffffff' },
    }).then((value) => { if (active) setQrDataUrl(value) })
      .catch((e) => { if (active) setError('二维码生成失败：' + (e && e.message ? e.message : String(e))) })
    return () => { active = false }
  }, [mobileLink])

  async function start() {
    setError(''); setNotice('')
    const numericPort = Number(port)
    if (!selectedAddress) { setError('没有检测到可用的局域网 IPv4 地址，请先连接 Wi-Fi 或有线网络。'); return }
    if (!Number.isInteger(numericPort) || numericPort < 1024 || numericPort > 65535) { setError('局域网端口需为 1024 到 65535 之间的整数。'); return }
    setBusy('start')
    try {
      const data = await rpc('start', { deviceId: deviceId(), port: numericPort })
      const next = {
        pairId: data.pairId, secret: data.secret, code: data.code, role: 'desktop', deviceId: deviceId(),
        gatewayToken: data.gatewayToken, gatewayPort: data.gateway.port, gatewayAddress: selectedAddress,
      }
      setCurrent(next); setPair(data.pair)
      setNotice('受保护的局域网反向代理已开启。手机扫码即可进入同一 DSH。')
    } catch (e) { setError(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  async function sendNote(event) {
    event.preventDefault(); if (!session || !note.trim()) return
    setBusy('note'); setError('')
    try { const data = await rpc('note', Object.assign({}, session, { note })); setPair(data.pair); setNote(''); setNotice('接力备注已同步。') }
    catch (e) { setError(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  async function end() {
    if (!session) return
    setBusy('end')
    try { await rpc('end', session); setCurrent(null); setPair(null); setNotice('手机连接已关闭。') }
    catch (e) { setError(e && e.message ? e.message : String(e)) } finally { setBusy('') }
  }
  function copyLink() { copy(mobileLink).then(() => setNotice('连接链接已复制。')).catch((e) => setError(e.message)) }

  if (!session) return <section className={'dmr ' + (compact ? 'dmr-compact' : '')}>
    <div className="dmr-hero"><span className="dmr-hero-icon"><RelayIcon name="phone" size={22}/></span><div><h3>把开发任务接到手机</h3><p>主 DSH 继续仅限本机；开启局域网反向代理后，通过一次性二维码安全接入。</p></div></div>
    <ol className="dmr-steps"><li><span>1</span><div><strong>确认 IP 与端口</strong><small>自动识别电脑局域网 IPv4，默认使用独立端口 3081。</small></div></li><li><span>2</span><div><strong>开启反向代理</strong><small>代理 HTTP 与 WebSocket，未认证设备无法访问。</small></div></li><li><span>3</span><div><strong>手机扫码接力</strong><small>扫码进入原会话，电脑端同步看到开发进度。</small></div></li></ol>
    <div className="dmr-network-grid">
      <label className="dmr-field"><span>局域网 IP</span><select value={selectedAddress} onChange={(e) => setSelectedAddress(e.target.value)} disabled={!network || !network.addresses || !network.addresses.length}>{network && network.addresses && network.addresses.length ? network.addresses.map((item) => <option key={item.interface + item.address} value={item.address}>{item.address} · {item.interface}</option>) : <option value="">{network ? '未检测到地址' : '正在检测网络…'}</option>}</select><small>手机需与电脑位于可互访的同一局域网。</small></label>
      <label className="dmr-field"><span>监听端口</span><input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" type="number" min="1024" max="65535" aria-describedby="dmr-port-help"/><small id="dmr-port-help">主服务仍为 127.0.0.1:3080；手机入口建议使用 3081。</small></label>
    </div>
    <div className="dmr-security"><strong>安全说明</strong><p>链接相当于临时登录凭据，只发给自己的手机。验证令牌 10 分钟后失效；关闭连接会立即撤销手机会话并停止端口监听。</p></div>
    <button type="button" className="dmr-primary" onClick={start} disabled={busy === 'start' || !selectedAddress}>{busy === 'start' ? '正在开启反向代理…' : <><RelayIcon name="link"/>开启反向代理并生成二维码</>}</button>
    {error && <div className="dmr-message error" role="alert">{error}</div>}{notice && <div className="dmr-message success" aria-live="polite"><RelayIcon name="check"/>{notice}</div>}
  </section>

  const onlineMobiles = pair && pair.devices ? pair.devices.filter((device) => device.role === 'mobile') : []
  return <section className={'dmr ' + (compact ? 'dmr-compact' : '')}>
    <div className="dmr-status-head"><div><span className="dmr-eyebrow"><i/> {mobile ? '已连接到电脑' : '手机连接已开启'}</span><h3>{mobile ? '可以在这里继续开发' : '等待手机接入'}</h3><p>{mobile ? '任务状态和接力备注会自动同步。继续开发请回到当前 DSH 会话输入区。' : '将下面的安全链接发到手机；连接在 ' + fmtTime(pair && pair.expiresAt) + ' 前有效。'}</p></div><button type="button" className="dmr-icon-button" onClick={end} disabled={busy === 'end'} title="关闭手机连接" aria-label="关闭手机连接"><RelayIcon name="close"/></button></div>
    {!mobile && <div className="dmr-share"><div className="dmr-share-layout"><div className="dmr-qr-card">{qrDataUrl ? <img src={qrDataUrl} alt="手机接力一次性连接二维码" width="260" height="260"/> : <div className="dmr-qr-loading" aria-live="polite">正在生成二维码…</div>}<strong>使用手机相机扫码</strong><small>手机与电脑需在同一局域网</small></div><div className="dmr-share-detail"><div><span className="dmr-eyebrow"><i/> 反向代理已运行</span><h4>{session.gatewayAddress}:{session.gatewayPort} → 127.0.0.1:3080</h4></div><div className="dmr-link" title={mobileLink}>{mobileLink || '局域网入口未就绪'}</div><div className="dmr-share-actions"><button type="button" className="dmr-primary" onClick={copyLink} disabled={!mobileLink}><RelayIcon name="copy"/>复制连接链接</button></div><small>二维码和链接只可成功验证一次，10 分钟后失效。如需另一台手机，请关闭后重新开启。</small></div></div></div>}
    <div className="dmr-overview"><div className="dmr-overview-card"><span>设备状态</span><strong>{mobile ? '手机已接力' : onlineMobiles.length ? onlineMobiles.length + ' 台手机在线' : '等待手机'}</strong><small>{mobile ? '保持此页面打开即可同步状态' : onlineMobiles.length ? '状态每 2.5 秒刷新' : '连接码仅在当前配对窗口有效'}</small></div><div className="dmr-overview-card"><span>进行中的任务</span><strong>{pair && pair.tasks ? pair.tasks.length : '—'}</strong><small>{pair && pair.tasks && pair.tasks.length ? '与 DSH 当前会话共用同一任务' : '开始任务后会自动显示在这里'}</small></div></div>
    <div className="dmr-section"><div className="dmr-section-head"><h4>实时任务</h4><button type="button" className="dmr-text-button" onClick={() => refresh()} disabled={busy}>刷新</button></div>{pair && pair.tasks && pair.tasks.length ? <div className="dmr-task-list">{pair.tasks.map((task) => <article key={task.sessionId} className="dmr-task"><span className={'dmr-phase ' + task.phase}>{phaseLabel(task.phase)}</span><div><strong>{task.title}</strong><small>已运行 {fmtDuration(task.elapsed)} · 最近活动 {fmtTime(task.lastActivityAt)}</small></div></article>)}</div> : <div className="dmr-empty">当前没有正在运行的任务。启动任务后，手机和电脑都会看到同一份状态。</div>}</div>
    <form className="dmr-note" onSubmit={sendNote}><div className="dmr-section-head"><h4>接力备注</h4>{pair && pair.noteAt ? <small>{pair.noteFrom} · {fmtTime(pair.noteAt)}</small> : null}</div>{pair && pair.note ? <blockquote>{pair.note}</blockquote> : <p>把当前进度、下一步或需要注意的事项留给另一台设备。</p>}<label><span className="sr-only">接力备注</span><textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength="1200" placeholder={mobile ? '例如：我已在手机查看到构建错误，下一步请在电脑运行测试。' : '例如：已经完成接口修改，手机端继续检查页面交互。'} /></label><button className="dmr-secondary" disabled={!note.trim() || busy === 'note'}>{busy === 'note' ? '正在同步…' : <><RelayIcon name="arrow"/>同步备注</>}</button></form>
    {error && <div className="dmr-message error" role="alert">{error}</div>}{notice && <div className="dmr-message success" aria-live="polite"><RelayIcon name="check"/>{notice}</div>}
  </section>
}

export function MobileRelayHomeStat() {
  const [summary, setSummary] = useState('可在手机继续当前任务')
  useEffect(() => {
    const session = readSession(); if (!session) return
    rpc('status', session).then((data) => { const p = data.pair; setSummary((p.tasks || []).length ? (p.tasks.length + ' 个任务同步中') : '手机已连接，等待任务') }).catch(() => setSummary('连接已失效，请重新配对'))
  }, [])
  return <span>{summary}</span>
}

export const feature = {
  id: 'mobile-relay', name: '手机接力', order: 80, accent: '#38bdf8',
  description: '安全反向代理与扫码接力，同步当前任务状态和备注', defaultEnabled: true,
  css: `
.dmr{--dmr-accent:#38bdf8;--dmr-accent-soft:color-mix(in srgb,var(--dmr-accent) 13%,transparent);display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dmr h3,.dmr h4,.dmr p{margin:0}.dmr h3{font-size:17px;line-height:1.25;letter-spacing:-.01em}.dmr h4{font-size:13px}.dmr-hero,.dmr-status-head{display:flex;align-items:flex-start;gap:12px}.dmr-hero>div,.dmr-status-head>div{min-width:0;display:flex;flex-direction:column;gap:4px}.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55}.dmr-hero-icon{width:42px;height:42px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:14px;background:var(--dmr-accent-soft);color:var(--dmr-accent);border:1px solid color-mix(in srgb,var(--dmr-accent) 35%,var(--dsw-alias-border-l1))}.dmr-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0;padding:0;list-style:none}.dmr-steps li{display:flex;gap:9px;padding:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:12px}.dmr-steps li>span{width:21px;height:21px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:50%;font-size:11px;font-weight:700;color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-steps div{display:flex;flex-direction:column;gap:3px;min-width:0}.dmr-steps strong{font-size:12px}.dmr-steps small{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.45}.dmr-field{display:flex;flex-direction:column;gap:6px;font-weight:600}.dmr-field input,.dmr-field select,.dmr-note textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:10px;padding:10px 12px;min-height:44px;font:inherit;outline:none;transition:border-color .18s ease,box-shadow .18s ease}.dmr-field input:focus,.dmr-field select:focus,.dmr-note textarea:focus{border-color:var(--dmr-accent);box-shadow:0 0 0 3px var(--dmr-accent-soft)}.dmr-field small{font-weight:400}.dmr-network-grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(150px,.6fr);gap:12px}.dmr-security{padding:12px 13px;border:1px solid color-mix(in srgb,#f59e0b 38%,var(--dsw-alias-border-l1));border-radius:12px;background:color-mix(in srgb,#f59e0b 8%,transparent)}.dmr-security strong{display:block;margin-bottom:4px;color:#f59e0b;font-size:12px}.dmr-security p{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.55}.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button{font:inherit;touch-action:manipulation;cursor:pointer;transition:transform .15s ease,background .18s ease,border-color .18s ease,opacity .18s ease}.dmr-primary,.dmr-secondary{min-height:44px;display:inline-flex;align-items:center;justify-content:center;gap:8px;border-radius:10px;padding:9px 13px;font-weight:600}.dmr-primary{align-self:flex-start;border:1px solid var(--dmr-accent);background:var(--dmr-accent);color:#062238}.dmr-primary:hover{filter:brightness(1.05)}.dmr-secondary{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}.dmr-secondary:hover{border-color:var(--dmr-accent);background:var(--dmr-accent-soft)}.dmr-primary:active,.dmr-secondary:active,.dmr-icon-button:active{transform:scale(.98)}.dmr-primary:disabled,.dmr-secondary:disabled,.dmr-text-button:disabled,.dmr-icon-button:disabled{cursor:not-allowed;opacity:.5}.dmr-message{display:flex;align-items:flex-start;gap:7px;padding:10px 12px;border-radius:10px;font-size:12px}.dmr-message.success{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}.dmr-message.error{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}.dmr-status-head{justify-content:space-between}.dmr-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--dmr-accent)}.dmr-eyebrow i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px var(--dmr-accent-soft)}.dmr-icon-button{display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:transparent;color:var(--dsw-alias-label-secondary)}.dmr-icon-button:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor}.dmr-share{display:flex;flex-direction:column;gap:9px;padding:13px;border:1px solid color-mix(in srgb,var(--dmr-accent) 32%,var(--dsw-alias-border-l1));border-radius:13px;background:var(--dmr-accent-soft)}.dmr-share-layout{display:grid;grid-template-columns:196px minmax(0,1fr);gap:16px;align-items:center}.dmr-qr-card{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:5px;padding:10px;border-radius:12px;background:#fff;color:#111827;text-align:center}.dmr-qr-card img{display:block;width:176px;height:176px;max-width:100%;object-fit:contain}.dmr-qr-card strong{font-size:12px}.dmr-qr-card small{color:#4b5563;font-size:10px}.dmr-qr-loading{display:grid;place-items:center;width:176px;height:176px;color:#64748b;font-size:12px}.dmr-share-detail{min-width:0;display:flex;flex-direction:column;gap:10px}.dmr-share-detail>div:first-child{display:flex;flex-direction:column;gap:4px}.dmr-link{padding:10px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--dsw-alias-label-secondary)}.dmr-share-actions{display:flex;gap:8px;flex-wrap:wrap}.dmr-share-actions .dmr-primary{align-self:auto}.dmr-overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.dmr-overview-card{display:flex;flex-direction:column;gap:3px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}.dmr-overview-card>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-overview-card strong{font-size:16px;letter-spacing:-.01em}.dmr-section{display:flex;flex-direction:column;gap:9px}.dmr-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.dmr-section-head small{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dmr-text-button{border:0;background:transparent;color:var(--dmr-accent);padding:8px;min-height:36px;font-weight:600}.dmr-task-list{display:flex;flex-direction:column;gap:8px}.dmr-task{display:flex;align-items:flex-start;gap:9px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}.dmr-task>div{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.dmr-task strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dmr-phase{flex:none;border-radius:999px;padding:3px 8px;font-size:11px;background:var(--dmr-accent-soft);color:var(--dmr-accent)}.dmr-phase.write{color:var(--dsw-alias-state-success-primary)}.dmr-phase.code{color:#f59e0b}.dmr-phase.search{color:#14b8a6}.dmr-empty{padding:18px 12px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:12px}.dmr-note{display:flex;flex-direction:column;gap:9px;padding-top:2px}.dmr-note blockquote{margin:0;padding:10px 12px;border-left:3px solid var(--dmr-accent);border-radius:0 9px 9px 0;background:var(--dmr-accent-soft);white-space:pre-wrap;font-size:12px}.dmr-note textarea{min-height:88px;resize:vertical;line-height:1.5}.dmr-note .dmr-secondary{align-self:flex-start}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media (max-width:680px){.dmr{gap:14px;font-size:14px}.dmr h3{font-size:18px}.dmr-steps{grid-template-columns:1fr;gap:8px}.dmr-steps li{padding:10px}.dmr-steps small,.dmr-hero p,.dmr-status-head p,.dmr-field small,.dmr-share small,.dmr-overview-card small,.dmr-task small,.dmr-note p{font-size:12px}.dmr-network-grid{grid-template-columns:1fr;gap:10px}.dmr-field input,.dmr-field select{font-size:16px}.dmr-primary,.dmr-secondary{width:100%;font-size:14px}.dmr-share-layout{grid-template-columns:1fr;gap:12px}.dmr-qr-card{width:min(240px,100%);margin:0 auto}.dmr-qr-card img,.dmr-qr-loading{width:210px;height:210px}.dmr-share-actions{flex-direction:column}.dmr-share-actions .dmr-primary{width:100%}.dmr-overview{gap:8px}.dmr-overview-card{padding:11px}.dmr-status-head{gap:8px}.dmr-link{font-size:11px}.dmr-note textarea{font-size:16px;min-height:104px}.dmr-note .dmr-secondary{align-self:stretch}.dmr-compact .dmr-hero-icon{width:40px;height:40px;border-radius:13px}}@media (prefers-reduced-motion:reduce){.dmr-primary,.dmr-secondary,.dmr-text-button,.dmr-icon-button,.dmr-field input,.dmr-field select,.dmr-note textarea{transition:none}}
`,
  View: MobileRelayView, HomeStat: MobileRelayHomeStat,
}
