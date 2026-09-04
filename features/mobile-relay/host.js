// dsh-dock · 功能模块【手机接力】· 宿主半部
//
// 「服务器模式」（单实例架构）：所有设备访问同一个 DSH 进程，会话、任务进度、
// 设置、功能坞完全一致——这就是"dsh 装在服务器上，任何设备打开都一样"的形态。
//
//   - 开启：插件把 `- id: webserver / config: {host:'0.0.0.0', port}` 写进用户的
//     profile 补丁层（~/.dsh/profiles/web/cordis.patch.yml，DSH 官方补丁语义），
//     重启 `dsh web` 后主实例直接绑定 0.0.0.0。绑定后 DSH 自身派生局域网信任
//     （connection 行 trustedHosts = 局域网 IPv4），目录选择器自动切浏览模式；
//     手机接力的网关上游也直接指向主实例——不再有第二个进程，自然不存在
//     任务状态在不同实例间不同步的问题。
//   - 兼容兜底：局域网 http 非安全上下文，部分浏览器缺 crypto.randomUUID（DSH
//     客户端生成消息/RPC ID 直接调用）。通过 webServer.tapIndex 在 index.html
//     内联注入 ES5 兜底；回环/安全上下文下脚本自我短路零副作用。
//
// 配对状态、在线设备与接力备注只存内存；会话数据始终只有 ~/.dsh 这一份。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import { DOCK_NS, readBody, sendJson } from '../../src/host-core.js'
import { lanAddresses, startProtectedLanGateway } from './gateway.js'

function dshHome() { return process.env.DSH_HOME || join(homedir(), '.dsh') }
/** 远程访问开关所在的用户补丁层（web profile 专属；测试可用环境变量指到临时文件）。 */
function serverPatchFile() {
  return process.env.DSH_DOCK_PATCH_FILE || join(dshHome(), 'profiles', 'web', 'cordis.patch.yml')
}

// 与 DSH include 插件同款的 !!js 表达式标签：用户补丁层可能含 !!js 表达式，
// 读写必须无损往返，否则一次开关操作就会破坏用户手工配置。
const JsExprType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => ({ __jsExpr: data }),
  represent: (data) => data['__jsExpr'],
})
const patchYamlSchema = yaml.JSON_SCHEMA.extend(JsExprType)

function readPatchList(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    const err = new Error('读取局域网服务补丁失败：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
  try {
    const data = yaml.load(text, { schema: patchYamlSchema })
    return Array.isArray(data) ? data : []
  } catch (error) {
    const err = new Error('局域网服务补丁不是合法的补丁列表：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
}
function writePatchList(file, list) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, yaml.dump(list, { schema: patchYamlSchema }), 'utf8')
  } catch (error) {
    const err = new Error('写入局域网服务补丁失败：' + ((error && error.message) || String(error)))
    err.statusCode = 500
    throw err
  }
}
// 补丁层的扁平行视图：insert 块（{insert:[…]}）展开成行，其余原样。
// DSH 补丁语义里，非 insert 行只能改已存在 id 的 config/disabled——想新增行必须包
// insert（applyEntryPatches 对未知 id 的普通行只告警后跳过，对 name 不一致的行同样
// 整行跳过）。展开后统一按行检测/清理，兼容旧版写坏的平铺文件。
function patchRows(list) {
  if (!Array.isArray(list)) return []
  return list.flatMap((row) => (row && Array.isArray(row.insert)) ? row.insert : [row])
}
function serverPatchApplied(list) {
  // 远程访问补丁：目录选择器钉死为浏览模式（远程设备不能弹本机对话框）。
  return patchRows(list).some((row) => row && row.id === 'directory-picker-browse')
}
function legacyWebserverRowPresent(list) {
  // 旧「服务器模式」残留：0.0.0.0 的 webserver 覆盖行。账号认证架构下主实例必须回到仅本机，
  // 否则局域网设备可以绕过登录网关直连。
  return patchRows(list).some((row) => row && row.id === 'webserver'
    && row.config && row.config.host === '0.0.0.0')
}
function stripRemoteRows(list) {
  // 清掉全部远程访问相关行：平铺的 browse 行、webserver 行、auto 钉死行，以及
  // insert 块里的 browse 行（块清空则整块移除，块里混有用户自己的行则只摘除 browse）。
  return list
    .map((row) => {
      if (!(row && Array.isArray(row.insert))) return row
      const rest = row.insert.filter((item) => !(item && (item.id === 'directory-picker-browse' || item.id === 'ui-directory-picker-browse')))
      return rest.length ? { insert: rest } : null
    })
    .filter((row) => row && !(row.id === 'webserver'
      || row.id === 'directory-picker' || row.id === 'directory-picker-browse' || row.id === 'ui-directory-picker-browse'))
}
function upsertRemotePatches(list) {
  const cleaned = stripRemoteRows(list)
  cleaned.push(
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
  )
  return cleaned
}
function removeRemotePatches(list) {
  return stripRemoteRows(list)
}

// LAN HTTP 不是浏览器安全上下文：部分浏览器在 http://<局域网IP> 下只暴露
// crypto.getRandomValues() 而省略 crypto.randomUUID()，而 DSH 的 connection /
// conversation 客户端直接调用 randomUUID() 生成消息 ID 与 RPC ID——缺失时整个
// 客户端引导失败（会话列表、工作区等全部不可用）。下面这段与手机接力网关同款、
// 局域网 http 不是浏览器安全上下文：部分浏览器（老内核/加固内核）在 http://<局域网IP>
// 下缺失 crypto.randomUUID（DSH 的 connection/conversation 客户端生成消息与 RPC ID
// 直接调用它，缺失则整个客户端瘫痪——会话列表、设置目录、工作区全不可用）。
// 这段 ES5 兜底无前置条件：randomUUID 与 getRandomValues 都补齐（实例属性 +
// Crypto.prototype 双路径）；crypto 被整体冻结的极端浏览器则替换整个对象。
// 回环/安全上下文下 randomUUID 原生存在，脚本自我短路零副作用。
const LAN_COMPAT_JS = "(function(){var g=typeof globalThis!=='undefined'?globalThis:(typeof window!=='undefined'?window:(typeof self!=='undefined'?self:undefined));if(!g)return;if(!g.crypto){try{g.crypto={}}catch(e){return}}var c=g.crypto;var nativeRng=typeof c.getRandomValues==='function'?c.getRandomValues.bind(c):null;function rng(bytes){if(nativeRng){nativeRng(bytes);return bytes}for(var i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256)&255;return bytes}function uuid(){var b=rng(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]+256).toString(16).slice(1));return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10).join('')}function fill(array){rng(array);return array}function define(obj,name,value){if(!obj||typeof obj[name]==='function')return;try{Object.defineProperty(obj,name,{value:value,configurable:true})}catch(e){try{obj[name]=value}catch(e2){}}}define(c,'randomUUID',uuid);if(!nativeRng)define(c,'getRandomValues',fill);define(g.Crypto&&g.Crypto.prototype||null,'randomUUID',uuid);if(!nativeRng)define(g.Crypto&&g.Crypto.prototype||null,'getRandomValues',fill);if(typeof c.randomUUID!=='function'){var fresh={getRandomValues:fill,randomUUID:uuid};if(c.subtle)fresh.subtle=c.subtle;var keyOrigin=Object.create(null);for(var k in c){try{keyOrigin[k]=c[k]}catch(e3){}}for(var k2 in keyOrigin){if(typeof fresh[k2]==='undefined')fresh[k2]=keyOrigin[k2]}try{Object.defineProperty(g,'crypto',{value:fresh,configurable:true})}catch(e4){try{g.crypto=fresh}catch(e5){}}}})()"
const LAN_COMPAT_MARKER = 'data-dsh-lan-compat'
// 手机端排版补丁（窄屏媒体查询护栏，桌面零影响）：
// 1) 设置弹窗官方只有"左导航+右内容"两栏，窄屏内容栏被压到不足百像素（一字一行）；
//    改纵向堆叠：导航横排在上、内容占满。
// 2) 侧边栏展开是 grid 栅格挤占会话区（窄屏会话区只剩 ~110px）；改为浮层覆盖。
// 3) 侧栏栅格归零后，原生「打开侧边栏」按钮随窄轨一起被裁掉——补贴左边缘的抽屉把手
//    （.dsh-mobile-drawer-btn，行为脚本创建，点击转发原生 toggle，位置在趣味游戏
//    浮标正上方、兜底左侧中部）与抽屉遮罩（.dsh-mobile-scrim，点击即收起，阻断滚动穿透）。
// 类名用语义后缀匹配（哈希前缀随 DSH 版本会变，后缀稳定）；DSH 升级改了结构时
// 选择器自然失效，不影响其他功能。
const MOBILE_LAYOUT_CSS = [
  '@media (max-width:700px){',
  '  [role="dialog"][class*="panel"]{flex-direction:column;width:100vw!important;max-width:100vw!important;height:100vh!important;height:100dvh!important;max-height:none!important;border-radius:0!important}',
  '  [role="dialog"][class*="panel"]>[class*="nav"]{flex:none!important;width:auto!important;height:auto!important;flex-direction:row;align-items:center;gap:2px;padding:6px 8px;overflow-x:auto;border-bottom:1px solid color-mix(in srgb,gray 25%,transparent)}',
  '  [role="dialog"][class*="panel"] [class*="navList"]{flex-direction:row;overflow-x:auto;gap:2px}',
  '  [role="dialog"][class*="panel"] [class*="navTitle"]{flex:none;white-space:nowrap;margin-right:6px}',
  '  [role="dialog"][class*="panel"]>[class*="nav"] [class*="navCell"]{flex:none}',
  '  [role="dialog"][class*="panel"]>[class*="content"]{flex:1 1 auto!important;width:auto!important;min-width:0!important;max-width:none!important}',
  '  [class$="frame"]{grid-template-columns:0px minmax(0,1fr) 0px!important}',
  '  [class$="_handle"]{display:none!important}',
  '  [class$="frame"]:not([data-sidebar-collapsed]) [class*="sidebarCol"]{position:fixed!important;top:0!important;bottom:0!important;left:0!important;width:min(85vw,320px)!important;z-index:80!important;box-shadow:0 12px 48px rgba(0,0,0,.45)}',
  '  [class$="frame"]:not([data-details-collapsed="true"]) [class*="detailsCol"]{position:fixed!important;top:0!important;bottom:0!important;right:0!important;left:auto!important;width:min(85vw,320px)!important;z-index:85!important;box-shadow:-12px 0 48px rgba(0,0,0,.45)}',
  '  [class*="overlayLayer"]{z-index:90!important}',
  // 抽屉把手：贴左边缘（同趣味游戏浮标的边缘吸附语言），top 由 place() 动态设定
  // （趣味游戏浮标正上方，兜底左侧中部）；z 序 70 < 遮罩 75 < 侧栏 80 < overlayLayer 90，
  // 面板/弹窗打开时自然被盖，无需额外隐藏逻辑。
  '  .dsh-mobile-drawer-btn{position:fixed;left:0;top:38vh;z-index:70;box-sizing:border-box;width:30px;height:48px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l1,rgba(127,139,161,.35));border-left:none;border-radius:0 12px 12px 0;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c2230) 88%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary,#e6eaf2);box-shadow:4px 0 18px rgba(0,0,0,.28);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}',
  '  .dsh-mobile-drawer-btn:active{transform:scale(.94)}',
  '  .dsh-mobile-drawer-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}',
  '  .dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}',
  '}',
].join('\n')
const MOBILE_LAYOUT_MARKER = 'data-dsh-mobile-layout'
// 窄屏行为补丁：侧边栏浮层化后，原生的"保持展开"会一直挡住半屏——
// 点会话行/新会话后自动收起；点侧栏外的页面区域也收起（浮层语义）。
// 侧栏内的其他点击（工作区折叠、搜索、功能坞入口）保持原生行为不收。
// 另创建抽屉按钮（窄屏 + 侧栏收起时才显示，点击转发原生「打开侧边栏」toggle；
// 侧栏展开或设置弹窗打开时自动隐藏）与抽屉遮罩（点击经全局捕获 handler 收起，
// 单一路径防止同一事件两次 toggle）。注入点在 <head> 后，body 尚未解析，
// DOM 创建一律推迟到 DOMContentLoaded；显隐同步走 MutationObserver（属性翻转即时）
// + 低速轮询（覆盖路由重渲等一切边角）。
const MOBILE_BEHAVIOR_JS = [
  ';(function(){',
  'var mq=window.matchMedia?window.matchMedia("(max-width:700px)"):null;',
  'if(!mq)return;',
  // 与 dsh-dock 客户端 Overlay 版（features/mobile-relay/view.jsx，刷新即生效）互斥：
  // 本脚本在 <head> 先执行，存在即接管；客户端版看到旗标自动让位。
  'if(window.__dshDockMobileDrawer)return;',
  'window.__dshDockMobileDrawer="host";',
  'function narrow(){return mq.matches}',
  'function frameEl(){return document.querySelector(\'[class$="frame"]\')}',
  'function sidebarCollapsed(){var f=frameEl();return !!f&&f.hasAttribute("data-sidebar-collapsed")}',
  'function dialogOpen(){return !!document.querySelector(\'[role="dialog"][class*="panel"]\')}',
  'function collapse(){var b=document.querySelector(\'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]\');if(b)b.click()}',
  'function expand(){var b=document.querySelector(\'button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]\');if(b)b.click()}',
  'function closeDetails(){var d=document.querySelector(\'[class*="detailsCol"]\');if(!d||!d.getBoundingClientRect().width)return;var c=d.querySelector(\'button[aria-label="关闭详情"]\');if(c)c.click()}',
  'var fab=null,scrim=null;',
  'function ensureChrome(){',
  '  if(!fab){fab=document.createElement("button");fab.type="button";fab.className="dsh-mobile-drawer-btn";fab.setAttribute("aria-label","打开会话列表");fab.innerHTML=\'<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h10"/></svg>\';fab.addEventListener("click",function(){expand()});document.body.appendChild(fab)}',
  '  if(!scrim){scrim=document.createElement("div");scrim.className="dsh-mobile-scrim";document.body.appendChild(scrim)}',
  '}',
  // 把手定位：贴着趣味游戏浮标（.dgfab，可拖拽）正上方；浮标太靠上时改放它下面
  // （避开顶栏标题），被拖走/隐藏/不存在时兜底左侧中部（38% 视高）。
  'function place(){',
  '  if(!fab)return;',
  '  var vh=window.innerHeight,top=null;',
  '  var g=document.querySelector(".dgfab");',
  '  if(g&&!g.classList.contains("dgfab-hide")&&g.getBoundingClientRect){',
  '    var r=g.getBoundingClientRect();',
  '    if(r&&r.height>0&&r.top>0){',
  '      top=r.top-fab.offsetHeight-8;',
  '      if(top<64)top=r.bottom+8;',
  '      if(top+fab.offsetHeight>vh-16)top=null;',
  '    }',
  '  }',
  '  if(top==null)top=Math.round(vh*.38);',
  '  fab.style.top=top+"px";',
  '}',
  'function syncChrome(){',
  '  if(!fab||!scrim)return;',
  '  var on=narrow()&&!!frameEl()&&!dialogOpen();',
  '  var col=sidebarCollapsed();',
  '  var showFab=on&&col;',
  '  fab.style.display=showFab?"":"none";',
  '  if(showFab)place();',
  '  scrim.style.display=on&&!col?"":"none";',
  '}',
  'function boot(){',
  '  ensureChrome();syncChrome();',
  '  if(typeof MutationObserver!=="undefined"){new MutationObserver(function(){syncChrome()}).observe(document.documentElement,{attributes:true,attributeFilter:["data-sidebar-collapsed"],subtree:true})}',
  '  setInterval(syncChrome,1500);',
  '  var onMq=function(){syncChrome()};',
  '  if(mq.addEventListener)mq.addEventListener("change",onMq);else if(mq.addListener)mq.addListener(onMq);',
  '  window.addEventListener("resize",place);',
  '}',
  'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();',
  'document.addEventListener("click",function(e){',
  '  if(!narrow())return;',
  '  var t=e.target;',
  '  if(!t||!t.closest)return;',
  '  if(t.closest(".dsh-mobile-drawer-btn"))return;',
  '  var expanded=!!document.querySelector(\'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]\');',
  '  var col=document.querySelector(\'[class*="sidebarCol"]\');',
  '  var inSidebar=col&&col.contains(t);',
  '  if(!expanded&&!inSidebar)return;',
  '  if(inSidebar){',
  '    var row=t.closest(\'[role="treeitem"]\');',
  '    var leaf=row&&!row.querySelector(\'[role="treeitem"]\')&&row.closest(\'[role="tree"]\');',
  '    var fresh=t.closest(\'[class*="newSession"]\');',
  '    if(leaf||fresh)setTimeout(function(){collapse();closeDetails()},300);',
  '    return',
  '  }',
  '  if(t.closest(\'[role="dialog"],[class*="dockm"],[class*="dgfab"],[class*="dgwin"],[class*="dgame"],[class*="detailsCol"]\'))return;',
  '  collapse()',
  '},true)',
  '})();',
].join('\n')
const MOBILE_BEHAVIOR_MARKER = 'data-dsh-mobile-behave'
/** 把兼容脚本、移动端排版样式与行为脚本内联注入 index.html 的 <head> 之后（幂等）。 */
function injectLanCompat(html) {
  let out = html
  const match = /<head(?:\s[^>]*)?>/i.exec(out)
  const at = match ? match.index + match[0].length : 0
  const parts = []
  if (!out.includes(LAN_COMPAT_MARKER)) parts.push(`<script ${LAN_COMPAT_MARKER}>${LAN_COMPAT_JS}</script>`)
  if (!out.includes(MOBILE_LAYOUT_MARKER)) parts.push(`<style ${MOBILE_LAYOUT_MARKER}>${MOBILE_LAYOUT_CSS}</style>`)
  if (!out.includes(MOBILE_BEHAVIOR_MARKER)) parts.push(`<script ${MOBILE_BEHAVIOR_MARKER}>${MOBILE_BEHAVIOR_JS}</script>`)
  if (!parts.length) return out
  const injected = parts.join('')
  return at > 0 ? out.slice(0, at) + injected + out.slice(at) : injected + out
}
function routeMethod(req) {
  const url = new URL(req.url || '/', 'http://dsh.internal')
  return url.pathname.replace(/^\/dsh-dock\/mobile-relay\/?/, '').replace(/\/+$/, '')
}

export const feature = {
  id: 'mobile-relay',
  name: '远程访问',
  description: '账号密码登录的远程入口：局域网/虚拟网设备访问同一个 DSH，任务进度实时一致',
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    let gateway = null
    let gatewayStarting = null
    let settingsCtx = null

    // 自愈：早期版本把 browse 行平铺写进补丁层——DSH 会把未知 id 的普通补丁行整行
    // 跳过（且 auto 已被停用），结果 directoryPicker 服务无人提供，/api 整面 404，
    // 重启时更会因条目未激活直接起不来。这里把旧形态无损改写成 insert 形态。
    try {
      const file = serverPatchFile()
      const list = readPatchList(file)
      if (list && list.some((row) => row && (row.id === 'directory-picker-browse' || row.id === 'ui-directory-picker-browse'))) {
        writePatchList(file, upsertRemotePatches(list))
      }
    } catch { /* 补丁层不可读时交给 lanStatus 的错误呈现，不在启动路径上放大 */ }

    disposers.push(ctx.inject(['settings'], (sctx) => { settingsCtx = sctx }))

    // ── 浏览模式目录选择器的 Windows 跨盘补全 ──
    // 官方 browse 后端从主目录起步，只能列出当前盘内的子目录，面包屑在主目录之上
    // 全部折叠——Windows 开着远程访问时，选工作区根本到不了其他磁盘。
    // 这里在运行时包装 browse 能力的 list()：主目录层级注入全部盘符入口，盘根目录
    // 注入其他盘符入口，远程浏览即可像资源管理器一样跨盘选工作区。非 Windows 或
    // 非浏览模式（原生对话框本身可跨盘）零改动。
    const DRIVE_SCAN_TTL = 5000
    let driveScan = { at: 0, letters: null }
    function sameWinPath(a, b) {
      return a.replace(/[\\/]+/g, '\\').toLowerCase() === b.replace(/[\\/]+/g, '\\').toLowerCase()
    }
    function winDriveLetterOf(p) {
      return /^[A-Za-z]:[\\/]?$/.test(p) ? p.slice(0, 1).toUpperCase() : null
    }
    async function windowsDrivePaths() {
      if (driveScan.letters && Date.now() - driveScan.at < DRIVE_SCAN_TTL) return driveScan.letters
      const probes = []
      for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
        probes.push(stat(letter + ':\\').then(() => letter, () => null))
      }
      const letters = (await Promise.all(probes)).filter(Boolean).sort()
      driveScan = { at: Date.now(), letters }
      return letters
    }
    disposers.push(ctx.inject(['directoryPicker'], (dpCtx) => {
      if (process.platform !== 'win32') return
      const picker = dpCtx.directoryPicker
      if (!picker || typeof picker.capability !== 'function') return
      let cap
      try { cap = picker.capability() } catch { return }
      if (!cap || cap.kind !== 'browse' || typeof cap.list !== 'function' || cap.__dshDockDrives) return
      cap.__dshDockDrives = true
      const origList = cap.list
      cap.list = async (path, signal) => {
        const listing = await origList(path, signal)
        try {
          const target = String((listing && listing.path) || '')
          const atHome = sameWinPath(target, String(listing.home || '\u0000'))
          const driveRoot = winDriveLetterOf(target)
          // 只在主目录与盘根两级注入：这两级是跨盘的必经之地，其余层级保持官方原样
          if (atHome || driveRoot) {
            const letters = await windowsDrivePaths()
            const rows = letters
              .filter((letter) => !driveRoot || letter !== driveRoot)
              .map((letter) => ({ name: letter + ':\\', path: letter + ':\\', hidden: false }))
            if (rows.length) listing.entries = atHome ? rows.concat(listing.entries) : listing.entries.concat(rows)
          }
        } catch { /* 盘符探测失败保持原列表，不让补全拖垮选目录 */ }
        return listing
      }
    }))

    // ── 远程访问账号（settings 持久化；密码只存加盐哈希） ──
    function hashPassword(salt, password) {
      return createHash('sha256').update(String(salt) + '\u0000' + String(password), 'utf8').digest('hex')
    }
    function sameText(a, b) {
      const ba = Buffer.from(String(a || ''))
      const bb = Buffer.from(String(b || ''))
      return ba.length > 0 && ba.length === bb.length && timingSafeEqual(ba, bb)
    }
    function getAuth() {
      if (!settingsCtx) return null
      const value = settingsCtx.settings.get(DOCK_NS)
      const auth = value && value.remoteAuth
      return auth && auth.username && auth.passwordHash && auth.salt ? auth : null
    }
    async function saveAuth(username, password) {
      if (!settingsCtx || typeof settingsCtx.settings.mutate !== 'function') {
        const error = new Error('settings 服务未就绪，无法保存账号')
        error.statusCode = 500
        throw error
      }
      const salt = randomBytes(16).toString('hex')
      await settingsCtx.settings.mutate(DOCK_NS, [{
        op: 'set',
        path: ['remoteAuth'],
        value: { username, salt, passwordHash: hashPassword(salt, password) },
      }])
      // 账号密码变更：作废所有已登录设备，强制重新登录。
      if (gateway) gateway.revokeAllSessions()
    }
    async function verifyLogin(username, password) {
      const auth = getAuth()
      if (!auth) return false
      return sameText(username, auth.username) && sameText(hashPassword(auth.salt, password), auth.passwordHash)
    }

    /** 远程访问状态：网关、账号、浏览模式补丁、旧服务器模式残留。 */
    function lanStatus(webServer) {
      const file = serverPatchFile()
      let applied = false
      let webserverActive = false
      try {
        const list = readPatchList(file)
        applied = serverPatchApplied(list)
        webserverActive = legacyWebserverRowPresent(list)
      } catch { applied = false }
      const auth = getAuth()
      return {
        gatewayActive: Boolean(gateway),
        gatewayPort: gateway ? gateway.port : null,
        mainPort: webServer.port,
        addresses: lanAddresses(),
        patchApplied: applied,
        webserverActive,
        accountSet: Boolean(auth),
        username: auth ? auth.username : '',
        patchPath: file,
      }
    }

    async function stopGateway() {
      const current = gateway
      gateway = null
      gatewayStarting = null
      if (current) await current.close()
    }

    /** 远程访问网关：上游即主实例；主实例保持仅本机，远程一律经账号登录进入。 */
    async function ensureGateway(webServer, requestedPort) {
      // 默认端口跟主实例走（主端口+1）：网关和主服务是同一台机器上的两个监听，
      // 结构上不能同端口；跟随主端口让"哪个口是哪个"一目了然。
      const port = Number(requestedPort === undefined || requestedPort === null || requestedPort === ''
        ? webServer.port + 1 : requestedPort)
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        const error = new Error('局域网端口需为 1024 到 65535 之间的整数')
        error.statusCode = 400
        throw error
      }
      if (port === webServer.port) {
        const error = new Error(`局域网端口不能与 DSH 主服务端口 ${webServer.port} 相同`)
        error.statusCode = 400
        throw error
      }
      if (gateway && gateway.port === port) return gateway
      if (gateway) {
        const error = new Error(`局域网网关已在 ${gateway.port} 端口运行，请先关闭当前手机连接`)
        error.statusCode = 409
        throw error
      }
      // 上游即主实例：单实例架构下所有设备看到的就是同一个进程，任务状态天然同步。
      // 主实例保持仅本机 → 网关把 Host/Origin 改写成回环（回环恒被信任），
      // 远程设备必须先经过账号登录，不存在绕过登录的直连路径。
      if (!gatewayStarting) {
        gatewayStarting = startProtectedLanGateway({
          port,
          upstreamHost: '127.0.0.1',
          upstreamPort: webServer.port,
          spoofLoopback: true,
          verifyLogin,
        })
          .then((started) => { gateway = started; gatewayStarting = null; return started })
          .catch((error) => { gatewayStarting = null; throw error })
      }
      try { return await gatewayStarting }
      catch (cause) {
        const error = new Error(cause && cause.code === 'EADDRINUSE'
          ? `端口 ${port} 已被占用，请换一个端口`
          : '无法开启局域网网关：' + ((cause && cause.message) || String(cause)))
        error.statusCode = 400
        throw error
      }
    }


    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      // 服务器模式下的主实例同样服务局域网浏览器：注入 crypto.randomUUID 兜底，
      // 修复非安全上下文下 DSH 客户端引导失败。回环/安全上下文下脚本自我短路，
      // 对本机使用零副作用。
      if (typeof wsCtx.webServer.tapIndex === 'function') {
        disposers.push(wsCtx.effect(() => wsCtx.webServer.tapIndex(injectLanCompat)))
      }
      wsCtx.effect(() => wsCtx.webServer.register({
        kind: 'prefix',
        path: '/dsh-dock/mobile-relay',
        async handler(req, res) {
          try {
            const method = routeMethod(req)
            const payload = await readBody(req)
            if (method === 'lan') {
              return sendJson(res, 200, { ok: true, data: lanStatus(wsCtx.webServer) })
            }
            if (method === 'auth/set') {
              // 设置/修改远程访问账号密码；改完作废所有已登录会话。
              const username = String((payload && payload.username) || '').trim()
              const password = String((payload && payload.password) || '')
              if (!username || username.length > 64) {
                const error = new Error('账号需为 1 到 64 个字符')
                error.statusCode = 400
                throw error
              }
              if (password.length < 6 || password.length > 128) {
                const error = new Error('密码至少 6 位、至多 128 位')
                error.statusCode = 400
                throw error
              }
              await saveAuth(username, password)
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer) } })
            }
            if (method === 'lan/start') {
              // 开启远程访问：网关监听 0.0.0.0（唯一远程入口，登录后才放行）；
              // 同时移除旧服务器模式行（主实例必须回到仅本机）并把目录选择器钉为浏览模式。
              const username = String((payload && payload.username) || '').trim()
              const password = String((payload && payload.password) || '')
              if (username && password) {
                if (!username || username.length > 64) {
                  const error = new Error('账号需为 1 到 64 个字符')
                  error.statusCode = 400
                  throw error
                }
                if (password.length < 6 || password.length > 128) {
                  const error = new Error('密码至少 6 位、至多 128 位')
                  error.statusCode = 400
                  throw error
                }
                await saveAuth(username, password)
              }
              if (!getAuth()) {
                const error = new Error('请先设置远程访问的账号和密码')
                error.statusCode = 400
                throw error
              }
              const file = serverPatchFile()
              const list = readPatchList(file) || []
              const changed = !serverPatchApplied(list) || legacyWebserverRowPresent(list)
              writePatchList(file, upsertRemotePatches(list))
              await ensureGateway(wsCtx.webServer, payload && payload.port)
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: changed } })
            }
            if (method === 'lan/stop') {
              const file = serverPatchFile()
              const list = readPatchList(file)
              await stopGateway()
              if (list === null) {
                return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: false } })
              }
              const changed = serverPatchApplied(list) || legacyWebserverRowPresent(list)
              if (changed) writePatchList(file, removeRemotePatches(list))
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: changed } })
            }
            return sendJson(res, 404, { ok: false, error: { code: 'method-not-found', message: 'unknown method: ' + method } })
          } catch (error) {
            const status = error && error.statusCode ? error.statusCode : 500
            if (status >= 500) console.error('[dsh-dock] mobile relay HTTP error:', error && error.message)
            return sendJson(res, status, { ok: false, error: { code: status >= 500 ? 'internal' : 'bad-request', message: (error && error.message) || String(error) } })
          }
        },
      }), 'dsh-dock mobile relay: /dsh-dock/mobile-relay HTTP route')
    }))

    return () => {
      while (disposers.length) {
        const dispose = disposers.pop()
        try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
      }
      void stopGateway()
    }
  },
}
