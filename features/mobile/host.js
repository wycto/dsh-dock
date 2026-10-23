// dsh-dock · 功能模块【手机适配】· 宿主半部
//
// 职责：窄屏（≤700px）下的排版与交互兜底，经 webServer.tapIndex 内联注入 index.html。
// 本模块从【远程访问】整体接管手机端适配——远程访问只保留「账号密码登录的
// 远程入口」本身（网关、账号、二维码、令牌兑换），手机端排版/汉堡菜单/抽屉/遮罩/软键盘
// 全归这里。因此：
//   - 只有【手机适配】启用时才有手机端 chrome（含未开远程访问的本机窄屏）；
//   - 停用【手机适配】= 整套窄屏排版还原，与远程访问开关互不影响。
//
// ⚠️ 底部 Tab 栏（会话/插件/设置三入口）已按用户要求移除：它常驻占掉视口底部一条
// （48px + 安全区），在 390×844 上约 8% 的纵向空间，且与抽屉本身语义重复。会话入口改为
// 左上角汉堡菜单（三条横线，44×44）——点开左侧会话抽屉；插件/设置/运行状态等入口本来
// 就在抽屉里（原生侧栏 rail），展开抽屉即可达。
//
// 注入三件事（幂等，均可重复调用）：
//   1) MOBILE_LAYOUT_CSS：窄屏排版——设置/功能坞弹层纵向堆叠、侧栏浮层化、左上角汉堡菜单、
//      抽屉遮罩、滚动体留白、滚动兜底（见下）；
//   2) MOBILE_BEHAVIOR_JS：窄屏行为——遮罩显隐、汉堡按钮（展开抽屉）、软键盘让位、
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
  //    会话入口统一走左上角汉堡菜单，不设左缘浮动把手、不再有底部常驻 Tab 栏。
  '  .dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}',
  // ── 左上角汉堡菜单（三条横线，44×44 触控面积，避让刘海/圆角安全区）。
  //    z 序 66：高于正文，低于遮罩 75 / 抽屉 80 / overlayLayer 90 / 功能坞面板 200，
  //    这些浮层打开时自然盖住汉堡。
  //    ⚠️ 视觉上刻意「不贴合卡片」：页面左上角本来就是空的，原生同类控件（右上的侧栏开关）
  //    是**裸图标**——无底色、无边框、无阴影。早期版本做成白底圆角卡片 + 阴影 + 模糊，
  //    悬浮在白底页面上像一块贴上去的异物（用户实测反馈「没有贴合边缘，很突兀」）。
  //    现在与原生同款：透明底、无边框无阴影，只留图标；点按才给极轻的底色反馈。
  '  .dsh-mobile-burger{position:fixed;left:env(safe-area-inset-left,0px);top:env(safe-area-inset-top,0px);z-index:66;box-sizing:border-box;width:44px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:0;background:transparent;color:var(--dsw-alias-label-primary,#e6eaf2);cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;transition:color .15s ease}',
  '  .dsh-mobile-burger svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round}',
  '  .dsh-mobile-burger.on{color:#4d9fff}',
  '  .dsh-mobile-burger:active{background:color-mix(in srgb,currentColor 12%,transparent)}',
  // 待确认任务角标：挂在汉堡右上角。底部 Tab 栏移除前这个提醒挂在「插件」页签上，
  // 现在改挂汉堡——小圆点/数字锚在按钮右上角，不占布局、不破坏裸图标观感。
  // 等待确认（要人介入）= 红点 + 脉冲；进行中 = 蓝色数字（弱一级）。
  '  .dsh-mobile-burger-badge{position:absolute;top:4px;right:4px;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#4d9fff;color:#fff;font:700 9px/16px inherit;font-variant-numeric:tabular-nums;text-align:center;pointer-events:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#12151b)}',
  '  .dsh-mobile-burger-badge[hidden]{display:none}',
  '  .dsh-mobile-burger-badge.wait{background:#ef4444;animation:dsh-burger-badge-pulse 1.2s ease-in-out infinite}',
  '  @keyframes dsh-burger-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}',
  '  @media (prefers-reduced-motion:reduce){.dsh-mobile-burger-badge.wait{animation:none}}',
  // ── 给标题让出汉堡宽度（用户实测：标题被汉堡压住——截图里「更新所有仓库代码」的首字
  //    直接叠在三条横线上）。汉堡是 fixed 定位（贴安全区、44×44），**不占布局**，而原生
  //    标题从头部的 padding-left:20px 起排——真实实例 390×844 逐字实测：会话标题首字
  //    x=28、汉堡右缘 44 → **重叠 16px**；插件页/自动化任务页的页头（自身 padding-left:0，
  //    靠外层容器给 24px）首字 x=24 → 重叠 20px。
  //    改法照原生排版习惯走：**给容器补内边距**，而不是给汉堡加底色/加宽（那是把问题搬到
  //    视觉上）。与客户端半部（features/mobile/view.js）逐字同款，改一处必须同步另一处。
  '  header:has([class*="titleRow"]){padding-left:calc(44px + env(safe-area-inset-left,0px))}',
  '  [class$="_pageHead"],[class$="_pageHeading"]{padding-left:calc(28px + env(safe-area-inset-left,0px));gap:4px}',
  // ── 输入区吸附到视口底部：欢迎内容原生是 justify-content:center 垂直居中，
  //    手机视口下输入卡片悬在中部、下方留出大片空白。改用「输入区 margin-top:auto」贴底。
  //    底部 Tab 栏已移除，滚动体留白从 72px（Tab 栏高度 + 安全区）进一步收到
  //    **只剩安全区**：真实实例 390×844 像素扫描实测，输入卡片下方还有 51px 空白带，
  //    其中 24px 是下面这条滚动体内边距、6px 是 composerSeat 的内边距——都是 Tab 栏时代的
  //    遗留，没有底栏后纯属浪费；收掉后这 30px 直接变成会话区可显示的正文。
  //    dsh 自带的 ~21px 卡片下边距保留，视觉仍有呼吸感、不会贴死屏幕边缘。
  //
  //    ⚠️ 绝不能再给滚动体加 justify-content:flex-end/center 来贴底：那会把内容挤到
  //    滚动体起点之外，而 Chrome 不把起点方向的溢出算进 scrollHeight（手机视口实测
  //    scrollHeight==clientHeight、maxScroll==0），结果是会话记录完全滚不动、首条消息
  //    永远停在视口上方。auto 外边距只在有剩余空间时生效、不产生起点溢出。
  //
  //    软键盘弹出（visualViewport 判定，行为脚本挂 html.dsh-dock-kbd）：汉堡让位。
  '  html:not(.dsh-dock-kbd) [class*="scrollBody"]{padding-bottom:env(safe-area-inset-bottom,0px)!important}',
  '  html.dsh-dock-kbd [class*="scrollBody"]{padding-bottom:env(safe-area-inset-bottom,0px)!important}',
  '  html.dsh-dock-kbd .dsh-mobile-burger{display:none!important}',
  '  [class*="scrollBody"]>[class*="composerSeat"]{margin-top:auto;padding-bottom:0}',
  // ── 滚动兜底（见文件头 a/b 两条根因）：所有纵向滚动体显式声明可纵向平移 + iOS 惯性滚动，
  //    避免祖先合成层/触控声明把触摸滚动吃掉；overscroll-behavior 防滚动穿透到外层。
  '  [class*="scrollBody"],[class*="sidebarCol"] [class*="list"],[role="dialog"] [class*="options"],[class*="dockm-content"]{-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;touch-action:pan-y}',
  // 输入区工具行上的 dsh-dock chip（用量/余额）：窄屏下 28cqw 的宽度上限把它们挤成
  // 「…」「余..」（手机实测），既读不出数值又白占输入行空间。手机端整组收起，数值在
  // 功能坞（抽屉里进）看；桌面端不动。
  '  .dockchip-row{display:none}',
  // 收起的侧栏轨道（collapsed rail）在窄屏只剩 1px 占位，但轨道里的按钮仍会溢出贴在
  // 左边缘（添加工作区/搜索/功能坞/设置等露出半边）。这些入口已由汉堡菜单 + 抽屉接管；
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
// 避免面板被抽屉盖住（等于「点了没反应」）。会话入口是左上角汉堡菜单。
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
  'var scrim=null,burger=null,badge=null,runstateGone=false;',
  // 左上角汉堡菜单：语义上就是原「会话」页签——点开左侧会话抽屉。插件/设置/运行状态等
  // 入口本来就在抽屉里（原生侧栏 rail），展开即可达，不重复提供。
  'function ensureChrome(){',
  '  if(!scrim){scrim=document.createElement("div");scrim.className="dsh-mobile-scrim";document.body.appendChild(scrim)}',
  // 兜底摘除历史上可能残留的旧 chrome（旧 Tab 栏），保证全程只有一份。
  '  var old=document.querySelectorAll(".dsh-mobile-tabbar");for(var i=0;i<old.length;i++)old[i].remove();',
  '  if(!burger){',
  '    burger=document.createElement("button");burger.type="button";burger.className="dsh-mobile-burger";',
  '    burger.setAttribute("aria-label","打开会话列表");burger.setAttribute("aria-expanded","false");',
  '    burger.innerHTML=\'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg><span class="dsh-mobile-burger-badge" hidden></span>\';',
  '    badge=burger.querySelector(".dsh-mobile-burger-badge");',
  '    burger.addEventListener("click",function(){expand()});',
  '    document.body.appendChild(burger);',
  '  }',
  '}',
  'function syncBurger(){',
  '  if(!burger)return;',
  '  var expanded=!sidebarCollapsed();',
  '  burger.setAttribute("aria-expanded",expanded?"true":"false");',
  '  if(expanded)burger.classList.add("on");else burger.classList.remove("on");',
  '}',
  // 待确认任务角标：挂汉堡右上角（替代底部 Tab 栏「插件」页签上那个角标）。
  // 等待确认=红点脉冲（要人介入），进行中=蓝色数字。runstate 路由不存在时静默停轮询。
  // ⚠️ 宿主注入脚本拿不到客户端的功能开关，因此靠【运行状态】注册路由时置的旗标
  // window.__dshDockRunstate（features/runstate/host.js）判断：功能停用时宿主根本不注册
  // 该路由，无条件轮询会先打一次必然 405/404 的请求（控制台一条噪音），
  // 与【用量记录】chip 当年同一个毛病。旗标缺失/为假就完全不轮询。
  'function pollTasks(){',
  '  if(runstateGone||!badge||!narrow()||document.visibilityState==="hidden"||!burger||!burger.isConnected)return;',
  '  if(!window.__dshDockRunstate){badge.hidden=true;return}',
  '  fetch("dsh-dock/runstate/status",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(function(r){',
  '    if(r.status===404||r.status===405){runstateGone=true;badge.hidden=true;return null}',
  '    return r.json()',
  '  }).then(function(body){',
  '    if(!body||!badge)return;',
  '    var active=(body.data&&body.data.active)||[],wait=0;',
  '    for(var i=0;i<active.length;i++){var ap=active[i].approvals;if(ap&&ap.length)wait+=ap.length}',
  '    if(wait>0){badge.textContent=wait>99?"99+":String(wait);badge.className="dsh-mobile-burger-badge wait";badge.hidden=false;burger.setAttribute("title",wait+" 个任务等待你确认")}',
  '    else if(active.length>0){badge.textContent=active.length>99?"99+":String(active.length);badge.className="dsh-mobile-burger-badge";badge.hidden=false;burger.setAttribute("title",active.length+" 个任务进行中")}',
  '    else{badge.hidden=true;burger.removeAttribute("title")}',
  '  }).catch(function(){})',
  '}',
  // 软键盘判定：visualViewport 与布局视口高度差超阈值视为键盘弹出（挂 html.dsh-dock-kbd，
  // 样式表隐藏汉堡并收窄滚动体留白）。
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
  // 右侧详情面板在窄屏是原生全屏（z 40），而汉堡 66 比它高会压边——
  // 面板打开时整体让位，收起（面板自带的折叠按钮）后再回来。
  '  var rightOpen=!!document.querySelector(\'[data-sidebar-right-panel][data-sidebar-right-open]\');',
  // 遮罩只在「抽屉真的展开」时显示；收起态必须 display:none——它是全屏 touch-action:none
  // 浮层，残留一份会让整页都滑不动。
  '  scrim.style.display=(on&&!col)?"":"none";',
  // 汉堡：窄屏且页面骨架就绪后常驻；右侧详情面板打开时隐藏（原生全屏面板会压边）。
  '  if(burger)burger.style.display=narrow()&&!!frameEl()&&!rightOpen?"":"none";',
  '  syncBurger();',
  '}',
  'function boot(){',
  '  ensureChrome();syncChrome();',
  '  if(typeof MutationObserver!=="undefined"){new MutationObserver(function(){syncChrome()}).observe(document.documentElement,{attributes:true,attributeFilter:["data-sidebar-collapsed"],subtree:true})}',
  '  setInterval(syncChrome,1500);',
  // 角标轮询：低频 3s，仅窄屏 + 页面可见时发；路由不存在则静默停。
  '  setInterval(pollTasks,3000);pollTasks();',
  '  document.addEventListener("visibilitychange",function(){if(document.visibilityState==="visible")pollTasks()});',
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
  '  if(t.closest(".dsh-mobile-burger"))return;',
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
  description: '手机/窄屏排版与触控兜底：窄屏弹层纵排、侧栏浮层 + 左上角汉堡菜单、抽屉遮罩、软键盘让位、滚动兜底',
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
