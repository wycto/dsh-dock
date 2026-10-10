// dsh-dock · 功能模块【手机适配】· 宿主半部
//
// 职责：窄屏（≤700px）下的排版与交互兜底，经 webServer.tapIndex 内联注入 index.html。
// 本模块从【远程访问】整体接管手机端适配——远程访问只保留「账号密码登录的
// 远程入口」本身（网关、账号、二维码、令牌兑换），手机端排版/Tab 栏/抽屉/遮罩/软键盘
// 全归这里。因此：
//   - 只有【手机适配】启用时才有手机端 chrome（含未开远程访问的本机窄屏）；
//   - 停用【手机适配】= 整套窄屏排版还原，与远程访问开关互不影响。
//
// 注入三件事（幂等，均可重复调用）：
//   1) MOBILE_LAYOUT_CSS：窄屏排版——设置/功能坞弹层纵向堆叠、侧栏浮层化、底部 Tab 栏、
//      抽屉遮罩、滚动体留白、滚动兜底（见下）；
//   2) MOBILE_BEHAVIOR_JS：窄屏行为——遮罩显隐、Tab 栏页签动作、任务角标轮询、软键盘让位、
//      「点会话收抽屉、点文件夹不收」的全局捕获。
// 客户端半部（features/mobile/view.js）在宿主脚本缺位时自建同一套 chrome，两者用
// window.__dshDockMobileDrawer 先到先得互斥，绝不各建一套（曾出现双 Tab 栏与 CSS 互相覆盖）。
//
// ⚠️ 滚动兜底（本轮修复的核心）：手机上出现「哪都滑不动」。实测两处独立根因——
//   a) 设置弹层：本模块把 [role=dialog][class*=panel] 改成 flex-direction:column + height:100vh，
//      内容列是默认 min-height:auto 的 flex item，于是被内容撑高（实测 1216px 塞在 844px 里），
//      再被父级 overflow:hidden 裁掉，列内的 [class*=options] 滚不动。补 min-height:0 后
//      实测 scrollTop 0 → 425。详见 MOBILE_LAYOUT_CSS 内注释与 scripts/test-mobile-host.mjs。
//   b) 通用兜底：给所有纵向滚动体显式声明 touch-action:pan-y + iOS 惯性滚动，避免祖先的
//      合成层/触控声明把触摸滚动吃掉（无头 390×844 实测：会话长文 50000px、侧栏列表、
//      功能坞内容均可滚动）。
//
// 类名用语义后缀匹配（哈希前缀随 DSH 版本会变，后缀稳定）；DSH 升级改了结构时选择器
// 自然失效，不影响其他功能。
const MOBILE_LAYOUT_CSS = [
  '@media (max-width:700px){',
  // ── 设置/插件管理弹层：官方只有「左导航 + 右内容」两栏，窄屏内容栏被压到不足百像素
  //    （一字一行）。改纵向堆叠：导航横排在上、内容占满。
  //    ⚠️ min-height:0 是本轮的关键修复：内容列若是默认 min-height:auto，会被内容撑高、
  //    再被 .panel 的 overflow:hidden 裁掉，列内滚动容器（[class*=options]）因此滚不动。
  '  [role="dialog"][class*="panel"]{flex-direction:column;width:100vw!important;max-width:100vw!important;height:100vh!important;height:100dvh!important;max-height:none!important;border-radius:0!important}',
  '  [role="dialog"][class*="panel"]>[class*="nav"]{flex:none!important;width:auto!important;height:auto!important;flex-direction:row;align-items:center;gap:2px;padding:6px 8px;overflow-x:auto;border-bottom:1px solid color-mix(in srgb,gray 25%,transparent)}',
  '  [role="dialog"][class*="panel"] [class*="navList"]{flex-direction:row;overflow-x:auto;gap:2px}',
  '  [role="dialog"][class*="panel"] [class*="navTitle"]{flex:none;white-space:nowrap;margin-right:6px}',
  '  [role="dialog"][class*="panel"]>[class*="nav"] [class*="navCell"]{flex:none}',
  '  [role="dialog"][class*="panel"]>[class*="content"]{flex:1 1 auto!important;width:auto!important;min-width:0!important;min-height:0!important;max-width:none!important}',
  // ── 侧栏：窄屏不再用 grid 栅格挤占会话区（会话区只剩 ~110px），改为浮层覆盖。
  '  [class$="frame"]{grid-template-columns:0px minmax(0,1fr) 0px!important}',
  '  [class$="_handle"]{display:none!important}',
  '  [class$="frame"]:not([data-sidebar-collapsed]) [class*="sidebarCol"]{position:fixed!important;top:0!important;bottom:0!important;left:0!important;width:min(85vw,320px)!important;z-index:80!important;box-shadow:0 12px 48px rgba(0,0,0,.45)}',
  // 右侧详情列：dsh 0.1.7 起 detailsCol 改名 rightbarCol（data-rightbar-col），且窄屏
  // （<768px）原生就把面板切成全屏（data-sidebar-right-panel="fullscreen"，自身 100vw
  // 盖满视口），不再需要旧版「固定到右缘抽屉」的兜底规则。
  // ⚠️ 实测原生全屏态两个缺陷（手机上双重曝光）：① 面板背景透明——会话页 Hero 从缝隙里
  // 整屏透出来，两层内容叠花；② 面板/panelBody 是 pointer-events:none，空隙处的点击
  // 穿透到下层（能误点到 Hero 卡片和底部 Tab）。这里补不透明背景 + 拦截穿透；z 88 把
  // 底部 Tab(65) 压在面板下，配合行为脚本 rightOpen 时主动隐藏（双保险）。
  '  [class*="rightbarCol"]{min-width:0}',
  '  [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]{z-index:88!important;pointer-events:auto!important;background:var(--dsw-alias-bg-layer-2,rgb(22,24,28))!important}',
  '  [class*="overlayLayer"]{z-index:90!important}',
  // ── 抽屉遮罩：侧栏浮层展开时盖住页面，点击收起（阻断滚动穿透，故 touch-action:none）。
  //    会话入口统一走底部 Tab 栏「会话」页签，不设左缘浮动把手。
  '  .dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}',
  // ── 仿 ZCode 手机端：底部 Tab 栏（会话 / 插件 / 设置）。
  //    z 序 65：低于遮罩 75 / 抽屉 80 / overlayLayer 90 / 功能坞面板 200，
  //    这些浮层打开时自然盖住 Tab 栏。功能坞面板打开时另由行为脚本整体隐藏（防露边）。
  '  .dsh-mobile-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:65;display:flex;align-items:stretch;justify-content:space-around;padding:6px 8px calc(8px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c2230) 92%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,139,161,.25));touch-action:manipulation}',
  '  .dsh-mobile-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:48px;padding:4px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b95ab);font-size:11px;font-weight:600;line-height:1.2;font-family:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:10px}',
  '  .dsh-mobile-tab svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
  '  .dsh-mobile-tab.on{color:var(--dsw-alias-label-primary,#e6eaf2)}',
  '  .dsh-mobile-tab.on svg{color:#4d9fff}',
  '  .dsh-mobile-tab:active{transform:scale(.94)}',
  // 「插件」页签角标：进行中=蓝（数量），等待确认=红（数量 + 脉冲）——接力场景里
  // 等待确认是最需要人介入的状态，一眼可见；数据来自 runstate 宿主路由的低频轮询。
  '  .dsh-mobile-tab{position:relative}',
  '  .dsh-mobile-tab-badge{position:absolute;top:0;right:calc(50% - 26px);box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:#4d9fff;color:#fff;font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}',
  '  .dsh-mobile-tab-badge.wait{background:#ef4444;animation:dsh-badge-pulse 1.2s ease-in-out infinite}',
  '  @keyframes dsh-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}',
  '  @media (prefers-reduced-motion:reduce){.dsh-mobile-tab-badge.wait{animation:none}}',
  // ── 输入区吸附到 Tab 栏上方：欢迎内容原生是 justify-content:center 垂直居中，
  //    手机视口下输入卡片悬在中部、下方留出大片空白。改用「输入区 margin-top:auto」贴底，
  //    并给滚动体留出 Tab 栏高度的内边距，避免内容被 Tab 栏遮挡。
  //
  //    ⚠️ 绝不能再给滚动体加 justify-content:flex-end/center 来贴底：那会把内容挤到
  //    滚动体起点之外，而 Chrome 不把起点方向的溢出算进 scrollHeight（手机视口实测
  //    scrollHeight==clientHeight、maxScroll==0），结果是会话记录完全滚不动、首条消息
  //    永远停在视口上方。auto 外边距只在有剩余空间时生效、不产生起点溢出。
  //
  //    软键盘弹出（visualViewport 判定，行为脚本挂 html.dsh-dock-kbd）：Tab 栏整体让位，
  //    滚动体留白收窄。
  '  html:not(.dsh-dock-kbd) [class*="scrollBody"]{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))!important}',
  '  html.dsh-dock-kbd [class*="scrollBody"]{padding-bottom:12px!important}',
  '  html.dsh-dock-kbd .dsh-mobile-tabbar{display:none!important}',
  '  [class*="scrollBody"]>[class*="composerSeat"]{margin-top:auto;padding-bottom:6px}',
  // ── 滚动兜底（见文件头 a/b 两条根因）：所有纵向滚动体显式声明可纵向平移 + iOS 惯性滚动，
  //    避免祖先合成层/触控声明把触摸滚动吃掉；overscroll-behavior 防滚动穿透到外层。
  '  [class*="scrollBody"],[class*="sidebarCol"] [class*="list"],[role="dialog"] [class*="options"],[class*="dockm-content"]{-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;touch-action:pan-y}',
  // 输入区工具行上的 dsh-dock chip（用量/余额）：窄屏下 28cqw 的宽度上限把它们挤成
  // 「…」「余..」（手机实测），既读不出数值又白占输入行空间。手机端整组收起，数值在
  // 底部「插件」里看（用量/余额页信息更全）；桌面端不动。
  '  .dockchip-row{display:none}',
  // 收起的侧栏轨道（collapsed rail）在窄屏只剩 1px 占位，但轨道里的按钮仍会溢出贴在
  // 左边缘（添加工作区/搜索/功能坞/设置等露出半边）。这些入口已由底部 Tab 栈接管；
  // 展开抽屉（z 80）不受影响。
  '  [class*="sidebarCol"]:has([class*="collapsed"]){visibility:hidden}',
  // ⚠️ 列级 visibility:hidden 在 dsh 0.2.0 上挡不住：工作区浏览器为了展开/收拢动画给自己的
  // headerActions/sectionLabel 显式声明 visibility:visible（ui-workspace WorkspaceBrowser.module.css），
  // visibility 可被后代覆盖，轨道里的「添加工作区」等按钮就从隐藏列里「透」出来（实测手机
  // 截图左缘游离按钮）。display:none 不可被后代翻转——但只能打在**轨道根节点**上，绝不能
  // 打在列上：frame 是「侧栏轨 0px + 中列 1fr + 右轨 0px」的网格，列 display:none 会从网格
  // 流里摘掉，自动放置把中列顶进 0px 轨（实测中列宽 0、整页空屏）。轨道根（类名同时含
  // root 与 collapsed 两个语义后缀）隐藏后列还在流里占着 0px 轨，中列照常 1fr。
  // 弹层打开时豁免（:not(:has([role="dialog"]))）：设置/插件管理弹层挂在列内部
  // （footArea → settingsArea → overlay → panel），display:none 会把它连坐成空气弹层；
  // 此时退回上面的 visibility 机制（由下面那条 [role=dialog] 强制可见），窄屏弹层本身
  // 100vw×100dvh 全屏，透出的轨道也在它下面。
  '  [class*="sidebarCol"]:has([class*="collapsed"]):not(:has([role="dialog"])) [class*="root"][class*="collapsed"]{display:none!important}',
  // ⚠️ 设置/插件管理弹层挂在侧栏列内部（footArea → settingsArea → overlay → panel），
  // 上面隐藏整列会把它连坐隐藏——点「设置」得到一个 390×844 的空气弹层（属性齐全但不绘制）。
  // visibility 可被后代覆盖，弹层关闭态会整体卸载（DOM 里没有 [role=dialog]），所以强制
  // 显示只在弹层真正打开时命中，是安全的；列本身继续隐藏，轨道按钮照旧被藏住。
  '  [class*="sidebarCol"]:has([class*="collapsed"]) [role="dialog"]{visibility:visible}',
  // 功能坞面板在手机端抬到原生弹层之上：从侧栏进的官方插件管理页等原生弹层 z 序高于
  // 面板默认的 200，功能坞开在下面会被盖住——「插件」页签点了像没反应/露出原页面。
  '  [class*="dockm-backdrop"]{z-index:2000!important}',
  '}',
].join('\n')
const MOBILE_LAYOUT_MARKER = 'data-dsh-mobile-layout'

// 窄屏行为补丁：侧边栏浮层化后，原生的「保持展开」会一直挡住半屏——
// 点会话行/新会话后自动收起；点侧栏外的页面区域也收起（浮层语义）。
// 点工作区文件夹**不收**（只展开/收拢分组）；点侧栏入口（插件/设置…）等面板弹出后再收，
// 避免面板被抽屉盖住（等于「点了没反应」）。会话入口在底部 Tab 栏「会话」页签。
// 注入点在 <head> 后，body 尚未解析，DOM 创建一律推迟到 DOMContentLoaded；
// 显隐同步走 MutationObserver（属性翻转即时）+ 低速轮询（覆盖路由重渲等一切边角）。
const MOBILE_BEHAVIOR_JS = [
  ';(function(){',
  'var mq=window.matchMedia?window.matchMedia("(max-width:700px)"):null;',
  'if(!mq)return;',
  // 与 dsh-dock 客户端 Overlay 版（features/mobile/view.js，刷新即生效）互斥：
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
  // 「任务」「功能坞」合并为「插件」页签：有任务在跑/等确认时直接落到运行状态页，否则进面板首页。
  'function openDockSmart(){openDockPage((tasksActive>0||tasksWaiting>0)?"运行状态":null)}',
  'var TAB_DEFS=[',
  '  {id:"sessions",label:"会话",icon:\'<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>\',act:function(){expand()}},',
  '  {id:"dock",label:"插件",icon:\'<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>\',act:function(){openDockSmart()}},',
  '  {id:"settings",label:"设置",icon:\'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>\',act:function(){var bs=document.querySelectorAll("button");for(var i=0;i<bs.length;i++){var a=bs[i].getAttribute("aria-label")||"";if(a==="设置"||a==="Settings"){bs[i].click();return}}}}',
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
  '  fetch("dsh-dock/runstate/status",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){',
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
  // 兜底摘除历史上可能残留的旧 Tab 栏（正常路径下走到这里说明客户端版未自建，不会有第二份）。
  '  var old=document.querySelectorAll(".dsh-mobile-tabbar");for(var i=0;i<old.length;i++){if(old[i]!==tabbar)old[i].remove()}',
  '  var on=narrow()&&!!frameEl()&&!dialogOpen();',
  '  var col=sidebarCollapsed();',
  '  var dockOpen=!!document.querySelector(".dockm-backdrop");',
  // 右侧详情面板在窄屏是原生全屏（z 40），而 Tab 栏 65 比它高会压边——
  // 面板打开时整体让位，收起（面板自带的折叠按钮）后再回来。
  '  var rightOpen=!!document.querySelector(\'[data-sidebar-right-panel][data-sidebar-right-open]\');',
  // 遮罩只在「抽屉真的展开」时显示；收起态必须 display:none——它是全屏 touch-action:none
  // 浮层，残留一份会让整页都滑不动（本轮「哪都滑不动」的放大因素之一）。
  '  scrim.style.display=(on&&!col)?"":"none";',
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
  // 只有点「会话」才收抽屉：会话行 data-row-key 以 session: 开头（dsh 0.1.7+ 结构，
  // ui-workspace Rows.tsx）；工作区文件夹行是 workspace: 开头——点它只是展开/收拢分组，
  // 绝不能收抽屉（用户实测「点文件夹抽屉被收起」）。搜索结果行无 data-row-key，回退按无子叶判定。
  '    var row=t.closest(\'[role="treeitem"]\');',
  '    var rowKey=(row&&row.getAttribute("data-row-key"))||"";',
  '    var sessionRow=(rowKey&&rowKey.indexOf("session:")===0)||(row&&!rowKey&&!row.querySelector(\'[role="treeitem"]\')&&row.closest(\'[role="tree"]\'));',
  '    if(sessionRow||t.closest(\'[class*="newSession"]\')){setTimeout(function(){collapse();closeDetails()},300);return}',
  // 工作区文件夹：只展开/收拢分组——既不收抽屉，也不做「面板弹出即收起」探测（那会把
  // 文件夹点击误判成侧栏入口）。
  '    if(rowKey.indexOf("workspace:")===0)return;',
  // 侧栏入口（插件/自动化任务/设置/记忆/自动进化…）点击后会弹出面板，而面板 z 序
  // 常低于展开的抽屉——被盖住等于「点了没反应」（用户实测截图）。稍候探测：有面板
  // 弹出就收起抽屉让它露出来；目录折叠/搜索等不弹面板的点击不受影响。
  '    setTimeout(function(){if(document.querySelector(\'[role="dialog"]\'))collapse()},260);',
  '    return;',
  '  }',
  '  if(t.closest(\'[role="dialog"],[class*="dockm"],[class*="dgfab"],[class*="dgwin"],[class*="dgame"],[data-sidebar-right-panel]\'))return;',
  '  collapse()',
  '},true)',
  '})();',
].join('\n')
const MOBILE_BEHAVIOR_MARKER = 'data-dsh-mobile-behave'

/** 把窄屏排版样式与行为脚本内联注入 index.html 的 <head> 之后（幂等）。 */
export function injectMobile(html) {
  let out = html
  const match = /<head(?:\s[^>]*)?>/i.exec(out)
  const at = match ? match.index + match[0].length : 0
  const parts = []
  if (!out.includes(MOBILE_LAYOUT_MARKER)) parts.push(`<style ${MOBILE_LAYOUT_MARKER}>${MOBILE_LAYOUT_CSS}</style>`)
  if (!out.includes(MOBILE_BEHAVIOR_MARKER)) parts.push(`<script ${MOBILE_BEHAVIOR_MARKER}>${MOBILE_BEHAVIOR_JS}</script>`)
  if (!parts.length) return out
  const injected = parts.join('')
  return at > 0 ? out.slice(0, at) + injected + out.slice(at) : injected + out
}

export const feature = {
  id: 'mobile',
  name: '手机适配',
  description: '手机/窄屏排版与触控兜底：窄屏弹层纵排、侧栏浮层 + 底部 Tab 栏、抽屉遮罩、软键盘让位、滚动兜底',
  // 与客户端半部一致：默认启用。宿主半部只负责把窄屏排版/行为注入 index.html，
  // 与【远程访问】完全解耦——没开远程访问的本机窄屏同样生效。
  defaultEnabled: true,
  setup(ctx) {
    const disposers = []
    disposers.push(ctx.inject(['webServer'], (wsCtx) => {
      if (typeof wsCtx.webServer.tapIndex !== 'function') {
        console.warn('[dsh-dock] 手机适配：webServer.tapIndex 不可用（dsh 版本过旧），窄屏排版未注入')
        return
      }
      disposers.push(wsCtx.effect(() => wsCtx.webServer.tapIndex(injectMobile)))
    }))
    return () => {
      while (disposers.length) {
        const dispose = disposers.pop()
        try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
      }
    }
  },
}
