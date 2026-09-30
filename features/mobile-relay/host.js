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
import { DOCK_NS, readBody, sendJson, readDockRoot, mutateDockSection } from '../../src/host-core.js'
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
// 3) 侧栏栅格归零后，原生「打开侧边栏」按钮随窄轨一起被裁掉——会话入口由底部 Tab 栏
//    「会话」页签承担（点击转发原生 toggle）；再补抽屉遮罩（.dsh-mobile-scrim，点击即
//    收起，阻断滚动穿透）。左缘浮动「抽屉把手」已移除：与 Tab 栏功能重复，还悬浮在
//    内容上压过输入区（用户实测截图）。
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
  // 右侧详情列：dsh 0.1.7 起 detailsCol 改名 rightbarCol（data-rightbar-col），且窄屏
  // （<768px）原生就把面板切成全屏（data-sidebar-right-panel="fullscreen"，自身 100vw
  // 盖满视口），不再需要旧版「固定到右缘抽屉」的兜底规则。
  // ⚠️ 实测原生全屏态两个缺陷（手机上双重曝光）：① 面板背景透明——会话页 Hero 从缝隙里
  // 整屏透出来，两层内容叠花；② 面板/panelBody 是 pointer-events:none，空隙处的点击
  // 穿透到下层（能误点到 Hero 卡片和底部 Tab）。这里补不透明背景 + 拦截穿透；z 88 把
  // 底部 Tab(65)/抽屉把手(70) 压在面板下，配合行为脚本 rightOpen 时主动隐藏（双保险）。
  '  [class*="rightbarCol"]{min-width:0}',
  '  [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]{z-index:88!important;pointer-events:auto!important;background:var(--dsw-alias-bg-layer-2,rgb(22,24,28))!important}',
  '  [class*="overlayLayer"]{z-index:90!important}',
  // 抽屉遮罩：侧栏浮层展开时盖住页面。左缘浮动「抽屉把手」已移除——与底部 Tab 栏
  // 「会话」页签功能重复，还悬浮在内容上压过输入区（用户实测截图）。
  '  .dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}',
  // ---- 仿 ZCode 手机端：底部 Tab 栏 + 输入区吸附底部 ----
  // Tab 栏 z 序 65：低于遮罩 75 / 抽屉 80 / overlayLayer 90 / 功能坞面板 200，
  // 这些浮层打开时自然盖住 Tab 栏。功能坞面板打开时另由行为脚本整体隐藏（防露边）。
  '  .dsh-mobile-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:65;display:flex;align-items:stretch;justify-content:space-around;padding:6px 8px calc(8px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c2230) 92%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,139,161,.25));touch-action:manipulation}',
  '  .dsh-mobile-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:48px;padding:4px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b95ab);font-size:11px;font-weight:600;line-height:1.2;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:10px}',
  '  .dsh-mobile-tab svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
  '  .dsh-mobile-tab.on{color:var(--dsw-alias-label-primary,#e6eaf2)}',
  '  .dsh-mobile-tab.on svg{color:#4d9fff}',
  '  .dsh-mobile-tab:active{transform:scale(.94)}',
  // 「任务」页签角标：进行中=蓝（数量），等待确认=红（数量 + 脉冲）——接力场景里
  // 等待确认是最需要人介入的状态，一眼可见；数据来自 runstate 宿主路由的低频轮询。
  '  .dsh-mobile-tab{position:relative}',
  '  .dsh-mobile-tab-badge{position:absolute;top:0;right:calc(50% - 26px);box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:#4d9fff;color:#fff;font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}',
  '  .dsh-mobile-tab-badge.wait{background:#ef4444;animation:dsh-badge-pulse 1.2s ease-in-out infinite}',
  '  @keyframes dsh-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}',
  '  @media (prefers-reduced-motion:reduce){.dsh-mobile-tab-badge.wait{animation:none}}',
  // 输入区吸附到 Tab 栏上方：宿主把欢迎内容 justify-content:center 垂直居中，
  // 手机视口下输入卡片悬在中部、下方留出大片空白。改用「输入区 margin-top:auto」
  // 贴底，并给滚动体留出 Tab 栏高度的内边距，避免内容被 Tab 栏遮挡。
  //
  // ⚠️ 绝不能再给滚动体加 justify-content:flex-end/center 来贴底：那会把内容挤到
  // 滚动体起点之外，而 Chrome 不把起点方向的溢出算进 scrollHeight（手机视口实测
  // scrollHeight==clientHeight、maxScroll==0），结果是会话记录完全滚不动、首条消息
  // 永远停在视口上方 2000px 处。auto 外边距只在有剩余空间时生效、不产生起点溢出，
  // 欢迎页照样贴底——见 scripts/test-mobile-relay-host.mjs 的回归断言。
  //
  // 软键盘弹出（visualViewport 判定，行为脚本挂 html.dsh-dock-kbd）：Tab 栏
  // 整体让位（打字时它只会挤占键盘上方的一线空间），滚动体留白收窄。
  '  html:not(.dsh-dock-kbd) [class*="scrollBody"]{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))!important}',
  '  html.dsh-dock-kbd [class*="scrollBody"]{padding-bottom:12px!important}',
  '  html.dsh-dock-kbd .dsh-mobile-tabbar{display:none!important}',
  '  [class*="scrollBody"]>[class*="composerSeat"]{margin-top:auto;padding-bottom:6px}',
  // 输入区工具行上的 dsh-dock chip（用量/余额）：窄屏下 28cqw 的宽度上限把它们挤成
  // 「…」「余..」（手机实测），既读不出数值又白占输入行空间。手机端整组收起，数值在
  // 底部「功能坞」里看（用量/余额页信息更全）；桌面端不动。
  '  .dockchip-row{display:none}',
  // 收起的侧栏轨道（collapsed rail）在窄屏只剩 1px 占位，但轨道里的按钮
  // 仍会溢出贴在左边缘（功能坞/进化/设置三枚露出半边的圆钮）。隐藏整列，
  // 这些入口已由底部 Tab 栏接管；展开抽屉（z 80）不受影响。
  '  [class*="sidebarCol"]:has([class*="collapsed"]){visibility:hidden}',
  // ⚠️ 设置/插件管理弹层挂在侧栏列内部（footArea → settingsArea → overlay → panel），
  // 上面隐藏整列会把它连坐隐藏——点「设置」得到一个 390×844 的空气弹层（属性齐全但不绘制）。
  // visibility 可被后代覆盖，弹层关闭态会整体卸载（DOM 里没有 [role=dialog]），所以强制
  // 显示只在弹层真正打开时命中，是安全的；列本身继续隐藏，轨道按钮照旧被藏住。
  '  [class*="sidebarCol"]:has([class*="collapsed"]) [role="dialog"]{visibility:visible}',
  // 功能坞面板在手机端抬到原生弹层之上：从侧栏进的官方插件管理页等原生弹层 z 序高于
  // 面板默认的 200，功能坞开在下面会被盖住——底部「插件」页签点了像没反应/露出原页面。
  '  [class*="dockm-backdrop"]{z-index:2000!important}',
  '}',
].join('\n')
const MOBILE_LAYOUT_MARKER = 'data-dsh-mobile-layout'
// 窄屏行为补丁：侧边栏浮层化后，原生的"保持展开"会一直挡住半屏——
// 点会话行/新会话后自动收起；点侧栏外的页面区域也收起（浮层语义）。
// 侧栏内的其他点击（工作区折叠、搜索、功能坞入口）保持原生行为不收。
// 会话入口在底部 Tab 栏「会话」页签（点击转发原生「打开侧边栏」toggle）；另建抽屉
// 遮罩（点击经全局捕获 handler 收起，单一路径防止同一事件两次 toggle）。左缘浮动
// 「抽屉把手」已移除（与 Tab 栏功能重复）。注入点在 <head> 后，body 尚未解析，
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
  'function closeDetails(){var d=document.querySelector(\'[data-sidebar-right-panel][data-sidebar-right-open]\');if(!d)return;var c=d.querySelector(\'[data-sidebar-right-toggle]\');if(c)c.click()}',
  'var scrim=null,tabbar=null,badge=null,runstateGone=false,tasksActive=0,tasksWaiting=0;',
  // 打开功能坞（可再点进指定页面）：宿主版没有客户端的 openPanel 总线，先点侧栏
  // 轨道上的功能坞按钮开面板，再在面板里找文字匹配的导航按钮点进去（找不到就停在
  // 面板首页——宿主版「插件」页签的降级导航路径）。
  'function openDockPage(page){',
  '  var b=document.querySelector("button.docke2-rail,button[class*=\'docke2-btn\'][class*=\'docke2-rail\']");',
  '  if(b){var col=b.closest(\'[class*="sidebarCol"]\');if(col)col.style.visibility="";b.click();if(col)setTimeout(function(){col.style.visibility=""},0)}',
  '  if(!page)return;',
  '  setTimeout(function(){',
  '    var panel=document.querySelector(".dockm-backdrop");if(!panel)return;',
  '    var bs=panel.querySelectorAll("button");',
  '    for(var i=0;i<bs.length;i++){var tx=bs[i].textContent||"";if(tx.indexOf(page)>=0&&bs[i].offsetParent){bs[i].click();return}}',
  '  },120);',
  '}',
  // 「任务」「功能坞」合并为「插件」页签（与客户端自建版同款）：有任务在跑/等确认时
  // 直接落到运行状态页，否则进面板首页。
  'function openDockSmart(){openDockPage((tasksActive>0||tasksWaiting>0)?"运行状态":null)}',
  'var TAB_DEFS=[',
  '  {id:"sessions",label:"会话",icon:\'<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>\',act:function(){expand()}},',
  '  {id:"dock",label:"插件",icon:\'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>\',act:function(){openDockSmart()}},',
  '  {id:"settings",label:"设置",icon:\'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>\',act:function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++){if(bs[i].getAttribute("aria-label")==="设置"){bs[i].click();return}}}}',
  '];',
  'function syncTabs(){',
  '  if(!tabbar)return;',
  '  var expanded=!sidebarCollapsed();',
  '  var settingsOpen=dialogOpen();',
  '  var dockOpen=!!document.querySelector(".dockm-backdrop");',
  '  var bs=tabbar.querySelectorAll(".dsh-mobile-tab");',
  '  for(var i=0;i<bs.length;i++){',
  '    var id=bs[i].dataset.tab;',
  '    var on=(id==="sessions"&&expanded)||(id==="dock"&&dockOpen)||(id==="settings"&&settingsOpen);',
  '    if(on)bs[i].classList.add("on");else bs[i].classList.remove("on");',
  '  }',
  '}',
  'function ensureChrome(){',
  '  if(!scrim){scrim=document.createElement("div");scrim.className="dsh-mobile-scrim";document.body.appendChild(scrim)}',
  '  if(!tabbar){',
  '    tabbar=document.createElement("nav");tabbar.className="dsh-mobile-tabbar";tabbar.setAttribute("aria-label","底部导航");',
  '    for(var i=0;i<TAB_DEFS.length;i++){',
  '      (function(def){',
  '        var b=document.createElement("button");b.type="button";b.className="dsh-mobile-tab";b.dataset.tab=def.id;',
  '        b.innerHTML=def.icon+"<span>"+def.label+"</span>";',
  '        b.addEventListener("click",function(){def.act()});',
  '        if(def.id==="dock"){badge=document.createElement("span");badge.className="dsh-mobile-tab-badge";badge.style.display="none";b.appendChild(badge)}',
  '        tabbar.appendChild(b);',
  '      })(TAB_DEFS[i]);',
  '    }',
  '    document.body.appendChild(tabbar);',
  '  }',
  '}',
  // 「插件」页签上的任务角标轮询（低频、页面可见且窄屏才发）：进行中=蓝、等待确认=红+脉冲。
  // runstate 路由不存在（功能未启用/宿主旧版）时静默停轮询。
  'function pollTasks(){',
  '  if(runstateGone||!badge||!narrow()||document.visibilityState==="hidden"||!tabbar||!tabbar.isConnected)return;',
  '  fetch("/dsh-dock/runstate/status",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){',
  '    if(r.status===404||r.status===405){runstateGone=true;tasksActive=0;tasksWaiting=0;badge.style.display="none";return null}',
  '    return r.json()',
  '  }).then(function(body){',
  '    if(!body||!badge)return;',
  '    var active=(body.data&&body.data.active)||[],wait=0;',
  '    for(var i=0;i<active.length;i++){var ap=active[i].approvals;if(ap&&ap.length)wait++}',
  '    tasksActive=active.length;tasksWaiting=wait;',
  '    if(wait>0){badge.textContent=String(wait);badge.className="dsh-mobile-tab-badge wait";badge.style.display=""}',
  '    else if(active.length>0){badge.textContent=String(active.length);badge.className="dsh-mobile-tab-badge";badge.style.display=""}',
  '    else{badge.style.display="none"}',
  '  }).catch(function(){})',
  '}',
  // 软键盘判定：visualViewport 与布局视口高度差超阈值视为键盘弹出（挂 html.dsh-dock-kbd，
  // 样式表隐藏 Tab 栏并收窄滚动体留白）。
  'var vv=window.visualViewport||null;',
  'function kbdSync(){',
  '  var kbd=false;',
  '  if(vv&&vv.height>0)kbd=(window.innerHeight-vv.height)>120;',
  '  var de=document.documentElement;',
  '  if(de.classList.toggle)de.classList.toggle("dsh-dock-kbd",kbd);',
  '  else if(kbd)de.classList.add("dsh-dock-kbd");else de.classList.remove("dsh-dock-kbd");',
  '}',
  'function syncChrome(){',
  '  kbdSync();',
  '  if(!scrim)return;',
  '  var on=narrow()&&!!frameEl()&&!dialogOpen();',
  '  var col=sidebarCollapsed();',
  '  var dockOpen=!!document.querySelector(".dockm-backdrop");',
  // 右侧详情面板在窄屏是原生全屏（z 40），而 Tab 栏 65 比它高会压边——
  // 面板打开时整体让位，收起（面板自带的折叠按钮）后再回来。
  '  var rightOpen=!!document.querySelector(\'[data-sidebar-right-panel][data-sidebar-right-open]\');',
  '  scrim.style.display=on&&!col?"":"none";',
  // Tab 栏：窄屏且页面骨架就绪后常驻；功能坞面板/右侧详情面板打开时隐藏（它们
  // 或是全屏模态、或是原生全屏面板，Tab 栏 z 序更高会盖住内容边缘）；宿主设置弹窗 z 序更高，自然盖住。
  '  if(tabbar)tabbar.style.display=narrow()&&!!frameEl()&&!dockOpen&&!rightOpen?"":"none";',
  '  syncTabs();',
  '}',
  'function boot(){',
  '  ensureChrome();syncChrome();',
  '  if(typeof MutationObserver!=="undefined"){new MutationObserver(function(){syncChrome()}).observe(document.documentElement,{attributes:true,attributeFilter:["data-sidebar-collapsed"],subtree:true})}',
  '  setInterval(syncChrome,1500);',
  '  setInterval(pollTasks,3000);pollTasks();',
  '  var onMq=function(){syncChrome()};',
  '  if(mq.addEventListener)mq.addEventListener("change",onMq);else if(mq.addListener)mq.addListener(onMq);',
  '  if(vv&&vv.addEventListener)vv.addEventListener("resize",kbdSync);',
  '  window.addEventListener("resize",kbdSync);',
  '}',
  'if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();',
  'document.addEventListener("click",function(e){',
  '  if(!narrow())return;',
  '  var t=e.target;',
  '  if(!t||!t.closest)return;',
  '  if(t.closest(".dsh-mobile-tabbar"))return;',
  '  var expanded=!!document.querySelector(\'button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]\');',
  '  var col=document.querySelector(\'[class*="sidebarCol"]\');',
  '  var inSidebar=col&&col.contains(t);',
  '  if(!expanded&&!inSidebar)return;',
  '  if(inSidebar){',
  // 只有点「会话」才收抽屉：会话行 data-row-key 以 session: 开头（0.1.7 结构，ui-workspace
  // Rows.tsx）；工作区文件夹行是 workspace: 开头——点它只是展开/收拢分组，不能收抽屉
  // （旧「无子 treeitem 即叶子」判定会误伤折叠状态的文件夹：折叠时子节点不在 DOM 里）。
  // 搜索结果行无 data-row-key，回退按无子叶判定。
  '    var row=t.closest(\'[role="treeitem"]\');',
  '    var rowKey=(row&&row.getAttribute("data-row-key"))||"";',
  '    var sessionRow=(rowKey&&rowKey.indexOf("session:")===0)||(row&&!rowKey&&!row.querySelector(\'[role="treeitem"]\')&&row.closest(\'[role="tree"]\'));',
  '    var fresh=t.closest(\'[class*="newSession"]\');',
  '    if(sessionRow||fresh){setTimeout(function(){collapse();closeDetails()},300);return}',
  // 侧栏入口（插件/自动化任务/设置/记忆/自动进化…）点击后会弹出面板，而面板 z 序
  // 常低于展开的抽屉——被盖住等于「点了没反应」（用户实测截图）。稍候探测：有面板
  // 弹出就收起抽屉让它露出来；目录折叠/搜索等不弹面板的点击不受影响。
  '    setTimeout(function(){if(document.querySelector(\'[role="dialog"]\'))collapse()},260);',
  '    return',
  '  }',
  '  if(t.closest(\'[role="dialog"],[class*="dockm"],[class*="dgfab"],[class*="dgwin"],[class*="dgame"],[data-sidebar-right-panel]\'))return;',
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
  // 宿主半部必须随插件加载（网关路由/账号服务都在这里），techfunway-dsh 等部署
  // 完全依赖它——保持默认开启。v0.9.6 起面板开关会同步到宿主：显式停用会连网关
  // 一起关掉（并持久化，重启后仍停用），部署环境请勿在面板里关闭本功能。
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    let gateway = null
    let gatewayStarting = null

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
      try {
        const value = readDockRoot(ctx)
        const auth = value && value.remoteAuth
        return auth && auth.username && auth.passwordHash && auth.salt ? auth : null
      } catch {
        return null
      }
    }
    async function saveAuth(username, password) {
      const settings = ctx.get('settings')
      if (!settings || typeof settings.mutate !== 'function') {
        const error = new Error('settings 服务未就绪，无法保存账号')
        error.statusCode = 500
        throw error
      }
      const salt = randomBytes(16).toString('hex')
      await mutateDockSection(ctx, ['remoteAuth'], {
        username, salt, passwordHash: hashPassword(salt, password),
      })
      // 账号密码变更：作废所有已登录设备，强制重新登录。
      if (gateway) gateway.revokeAllSessions()
    }
    async function verifyLogin(username, password) {
      const auth = getAuth()
      if (!auth) return false
      return sameText(username, auth.username) && sameText(hashPassword(auth.salt, password), auth.passwordHash)
    }

    // 上游会话自动兑换：dsh web 自身还有一层启动令牌认证（首次访问 /?token= 换
    // 30 天会话 Cookie，绑定回环 authority）。网关与主实例同进程，直接取
    // connection.authenticatedUrl 生成的带令牌地址，服务端完成兑换并返回 Cookie
    // 对，由网关在代理时自动附带——远程浏览器只需网关账号登录，无需再手动访问
    // 令牌地址。老版本 dsh 没有 connection 服务时返回空，网关退回官方行为。
    async function mintUpstreamSession(mainPort) {
      try {
        const connection = ctx.get('connection')
        if (!connection || typeof connection.authenticatedUrl !== 'function') return null
        const url = connection.authenticatedUrl(`http://127.0.0.1:${mainPort}`)
        const res = await fetch(url, { redirect: 'manual' })
        const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean)
        for (const raw of cookies) {
          const pair = String(raw).split(';')[0].trim()
          if (pair.includes('=')) return pair
        }
        return null
      } catch { return null }
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
      let saved = null
      try {
        const root = readDockRoot(ctx)
        saved = root && root.remoteGateway ? root.remoteGateway : null
      } catch { saved = null }
      return {
        gatewayActive: Boolean(gateway),
        gatewayPort: gateway ? gateway.port : null,
        gatewayEnabled: Boolean(saved && saved.enabled),
        mainPort: webServer.port,
        addresses: lanAddresses(),
        /** 经网关登录的会话数（手机/平板各占一条；面板据此显示在线设备数）。 */
        devices: gateway && typeof gateway.sessionCount === 'function' ? gateway.sessionCount() : 0,
        patchApplied: applied,
        webserverActive,
        accountSet: Boolean(auth),
        username: auth ? auth.username : '',
        patchPath: file,
      }
    }

    /** 持久化网关开关（remoteGateway 段）：dsh web 重启后据此自动拉起。 */
    async function persistGatewayState(enabled, port) {
      try {
        await mutateDockSection(ctx, ['remoteGateway'], {
          enabled: Boolean(enabled),
          port: Number.isInteger(port) && port > 0 ? port : 0,
        })
      } catch (error) {
        console.warn('[dsh-dock] 远程访问开关状态保存失败:', (error && error.message) || String(error))
      }
    }

    async function stopGateway() {
      const current = gateway
      gateway = null
      gatewayStarting = null
      if (current) await current.close()
    }

    /** 远程访问网关：上游即主实例；主实例保持仅本机，远程一律经账号登录进入。 */
    async function ensureGateway(webServer, requestedPort, mintUpstreamCookie) {
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
          mintUpstreamCookie: typeof mintUpstreamCookie === 'function' ? mintUpstreamCookie : undefined,
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
              const started = await ensureGateway(wsCtx.webServer, payload && payload.port, () => mintUpstreamSession(wsCtx.webServer.port))
              // 记住「开过」：重启 dsh web 后凭此自动拉起（账号存在才拉）。
              await persistGatewayState(true, started.port)
              return sendJson(res, 200, { ok: true, data: { ...lanStatus(wsCtx.webServer), needsRestart: changed } })
            }
            if (method === 'lan/stop') {
              const file = serverPatchFile()
              const list = readPatchList(file)
              const wasPort = gateway ? gateway.port : 0
              await stopGateway()
              await persistGatewayState(false, wasPort)
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

      // ── 网关自动拉起 ──
      // 面板开过远程访问（remoteGateway.enabled=true）就持久记住：dsh web 重启后
      // 只要账号还在，直接把网关重新监听起来，局域网设备不用等进面板再点一次。
      // 门禁语义不变：未登录一律 302 到登录页；账号被清掉则只日志提醒不拉起。
      void (async () => {
        try {
          const root = readDockRoot(ctx)
          const saved = root && root.remoteGateway
          if (!saved || !saved.enabled) return
          if (!getAuth()) {
            console.warn('[dsh-dock] 远程访问曾开启但账号不存在，网关未自动拉起（请在面板重新设置账号）')
            return
          }
          // 目录选择器浏览模式补丁若被清掉则补回（幂等；重启生效，网关本身不受影响）。
          try {
            const file = serverPatchFile()
            const list = readPatchList(file) || []
            if (!serverPatchApplied(list) || legacyWebserverRowPresent(list)) {
              writePatchList(file, upsertRemotePatches(list))
            }
          } catch { /* 补丁层异常不阻断网关 */ }
          const started = await ensureGateway(wsCtx.webServer, saved.port || undefined, () => mintUpstreamSession(wsCtx.webServer.port))
          console.log(`[dsh-dock] 远程访问网关已自动拉起: http://<本机IP>:${started.port}`)
        } catch (error) {
          console.warn('[dsh-dock] 远程访问网关自动拉起失败:', (error && error.message) || String(error))
        }
      })()
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
