import assert from 'node:assert/strict'
import { feature } from '../features/mobile/host.js'

// dsh-dock · 【手机适配】宿主半部契约测试
//
// 手机端排版/行为从【远程访问】整体迁到本模块——远程访问只保留远程入口。
// 本测试钉住 tapIndex 注入页必须含有的窄屏 chrome（布局样式 + 行为脚本）、
// 滚动兜底（设置弹层 min-height:0、滚动体 touch-action:pan-y）、
// 无底部 Tab 栏 / 无左缘浮动抽屉按钮（会话入口 = 左上角汉堡菜单）、
// 以及「点文件夹不收抽屉」的点击路由。
// 客户端半部（features/mobile/view.js）的同款契约见 scripts/test-client-views.mjs。

const indexTransforms = []
const mockCtx = {
  inject(keys, callback) {
    assert.deepEqual(keys, ['webServer'], '手机适配宿主半部只应注入 webServer')
    callback({
      webServer: {
        host: '127.0.0.1',
        port: 3999,
        tapIndex(fn) { indexTransforms.push(fn); return () => {} },
      },
      effect(run) { return run() },
    })
    return () => {}
  },
}

const dispose = feature.setup(mockCtx)
try {
  assert.ok(indexTransforms.length > 0, 'tapIndex transform must be registered')
  const sample = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'
  const once1 = indexTransforms.reduce((html, fn) => fn(html), sample)
  const twice = indexTransforms.reduce((html, fn) => fn(html), once1)

  // —— 标记与幂等 ——
  assert.match(once1, /data-dsh-mobile-layout/, '缺窄屏排版样式注入')
  assert.match(once1, /data-dsh-mobile-behave/, '缺窄屏行为脚本注入')
  assert.equal(countOf(twice, 'data-dsh-mobile-layout'), 1, 'injection must be idempotent')
  assert.equal(countOf(twice, 'data-dsh-mobile-behave'), 1)

  // —— 与【远程访问】解耦：注入页只含窄屏 chrome，不含 LAN crypto 兜底（那归远程访问）——
  assert.doesNotMatch(once1, /data-dsh-lan-compat/, '手机适配不应注入 LAN crypto 兜底（归远程访问）')

  // —— 不得有底部 Tab 栏、不得有左缘浮动抽屉把手 ——
  // 用户要求：底部常驻三入口（会话/插件/设置）太占页面空间，改为左上角汉堡菜单。
  // 会话入口 = 汉堡按钮（转发原生「打开侧边栏」）；插件/设置等入口在抽屉里，不重复提供。
  assert.doesNotMatch(once1, /\.dsh-mobile-tabbar\s*\{/, '底部 Tab 栏样式必须移除（用户要求改为左上角汉堡菜单）')
  assert.doesNotMatch(once1, /\.dsh-mobile-tab\s*\{/, '底部 Tab 页签样式必须移除')
  assert.doesNotMatch(once1, /dsh-mobile-tab-badge/, '「插件」页签角标必须随 Tab 栏一并移除')
  assert.doesNotMatch(once1, /TAB_DEFS/, '不得残留 Tab 定义表')
  assert.doesNotMatch(once1, /dsh-mobile-drawer-btn/)
  assert.doesNotMatch(once1, /dsh-dock-drawer-top|dsh-dock-drawer-off|dkmob-fab/, '不得残留浮动侧栏按钮')

  // —— 左上角汉堡菜单 + 抽屉遮罩 ——
  assert.match(once1, /dsh-mobile-scrim/, '缺抽屉遮罩')
  assert.match(once1, /\.dsh-mobile-burger\{/, '缺左上角汉堡菜单样式')
  // 三条横线（汉堡语义）：三个 path，y 递增且等距。
  assert.match(once1, /M4 7h16"\/><path d="M4 12h16"\/><path d="M4 17h16"/, '汉堡图标不是三条横线')
  assert.match(once1, /className="dsh-mobile-burger"/, '缺汉堡按钮元素创建')
  // 按钮必须够大（触控面积）且**贴**左上角（安全区避让，但不再额外内缩 8px）。
  assert.match(once1, /\.dsh-mobile-burger\{[^}]*width:44px;height:44px/, '汉堡按钮触控面积不足 44×44')
  assert.match(once1, /\.dsh-mobile-burger\{[^}]*left:env\(safe-area-inset-left,0px\)/, '汉堡没有避让左侧安全区')
  assert.match(once1, /\.dsh-mobile-burger\{[^}]*top:env\(safe-area-inset-top,0px\)/, '汉堡没有避让顶部安全区（刘海）')
  // ⚠️ 视觉契约：页面左上角本来是空的，原生同类控件是**裸图标**。汉堡不得做成
  // 白底圆角卡片 + 阴影 + 模糊（用户实测反馈「没有贴合边缘，很突兀」）。
  assert.match(once1, /\.dsh-mobile-burger\{[^}]*background:transparent/, '汉堡不得有底色卡片（用户要求贴合原生裸图标，不悬浮）')
  assert.match(once1, /\.dsh-mobile-burger\{[^}]*border:0/, '汉堡不得有边框')
  assert.doesNotMatch(once1, /\.dsh-mobile-burger\{[^}]*box-shadow/, '汉堡不得有投影（会显得像悬浮异物）')
  assert.doesNotMatch(once1, /\.dsh-mobile-burger\{[^}]*backdrop-filter/, '汉堡不得有毛玻璃底')
  assert.match(once1, /打开侧边栏/, '汉堡没有转发原生「打开侧边栏」')
  assert.match(once1, /aria-expanded/, '汉堡没有维护展开态语义')
  // —— 待确认任务角标：挂汉堡右上角（替代底部 Tab 栏「插件」页签上的角标）——
  assert.match(once1, /dsh-mobile-burger-badge/, '汉堡没有待确认任务角标（底部 Tab 栏移除后该提醒丢失了）')
  assert.match(once1, /dsh-mobile-burger-badge\.wait/, '角标缺少「等待确认」红色脉冲态')
  assert.match(once1, /dsh-burger-badge-pulse/, '缺角标脉冲动画')
  assert.match(once1, /dsh-dock\/runstate\/status/, '角标没有轮询 runstate 路由')
  assert.match(once1, /badge\.hidden\s*=\s*true/, '角标没有在无任务时隐藏')
  assert.match(once1, /runstateGone/, 'runstate 路由不存在时没有静默停轮询（会一直 405）')
  // 功能停用时宿主根本不注册 runstate 路由 —— 必须看【运行状态】置的旗标再决定轮询，
  // 否则会先打一次必然 405 的请求（控制台噪音，与用量记录 chip 当年同一个毛病）。
  assert.match(once1, /__dshDockRunstate/, '角标轮询没有看 __dshDockRunstate 旗标（功能停用时会打一次无谓 405）')
  assert.match(once1, /visualViewport/, '软键盘判定没有用 visualViewport')

  // —— 「哪都滑不动」回归钉（本轮核心修复）——
  // a) 设置弹层：内容列必须 min-height:0，否则被内容撑高、父级 overflow:hidden 裁掉，
  //    列内 [class*=options] 滚不动（无头 390×844 实测：加 min-height:0 后 scrollTop 0→425）。
  assert.match(
    once1,
    /\[role="dialog"\]\[class\*="panel"\]>\[class\*="content"\]\{flex:1 1 auto!important;width:auto!important;min-width:0!important;min-height:0!important/,
    '设置弹层内容列没有 min-height:0（窄屏设置页会滑不动）',
  )
  // b) 通用滚动兜底：纵向滚动体声明 touch-action:pan-y + iOS 惯性滚动，
  //    避免祖先合成层/触控声明把触摸滚动吃掉。
  assert.match(once1, /touch-action:pan-y/, '纵向滚动体没有声明 touch-action:pan-y（触控滚动兜底）')
  assert.match(once1, /-webkit-overflow-scrolling:touch/, '缺 iOS 惯性滚动声明')

  // —— 滚动体贴底协议（历史回归钉）——
  // 绝不能给滚动体加 justify-content:flex-end/center 贴底（内容从起点溢出，Chrome 不算进
  // scrollHeight，会话记录彻底滚不动）；贴底只能用输入区自己的 margin-top:auto。
  assert.doesNotMatch(once1, /\[class\*="scrollBody"\][^{}]*\{[^}]*justify-content:\s*(?:flex-end|center)/, '滚动体不得设 flex-end/center（会让会话记录滚不动）')
  assert.match(once1, /\[class\*="scrollBody"\]>\[class\*="composerSeat"\]\{margin-top:auto/, '输入区贴底必须走 margin-top:auto')
  assert.match(once1, /html:not\(\.dsh-dock-kbd\) \[class\*="scrollBody"\]/, '滚动体留白没有区分键盘弹出态')
  assert.match(once1, /html\.dsh-dock-kbd \[class\*="scrollBody"\]/, '缺键盘弹出态的收窄留白规则')

  // —— 底部留白只留安全区（用户要求：少留一点，多给会话区显示内容）——
  // 底部 Tab 栏移除后，滚动体内边距与输入区内边距都成了纯浪费。真实实例 390×844
  // 像素扫描实测：卡片下方空白带 51px，其中 30px 是这两条（24+6），收掉后降到 21px
  // （剩下的 21px 是 dsh 自带的卡片下边距，保留作呼吸感）。钉死，别再把硬留白加回来。
  assert.doesNotMatch(once1, /padding-bottom:calc\(\d+px \+ env\(safe-area-inset-bottom/, '滚动体底部不得有硬留白（Tab 栏时代的遗留，会白占会话区）')
  // 宿主半部没有 data-conversation-scroll 复位规则（那条只存在于客户端半部），此处按本半部实际声明断言。
  assert.match(once1, /html:not\(\.dsh-dock-kbd\) \[class\*="scrollBody"\]\{padding-bottom:env\(safe-area-inset-bottom,0px\)!important\}/, '滚动体底部留白应只剩安全区')
  assert.match(once1, /\[class\*="scrollBody"\]>\[class\*="composerSeat"\]\{margin-top:auto;padding-bottom:0\}/, '输入区不应再自带底部内边距')

  // —— 输入区 chip 窄屏收起（28cqw 上限挤成「余..」）——
  assert.match(once1, /\.dockchip-row\{display:none\}/)

  // —— 设置弹层挂在侧栏列内部：列隐藏不能连坐弹层（否则点设置是空气弹层）——
  assert.match(once1, /\[class\*="sidebarCol"\]:has\(\[class\*="collapsed"\]\) \[role="dialog"\]\{visibility:visible\}/)

  // —— 收起轨道必须 display:none 主隐藏（dsh 0.2.0 的 WorkspaceBrowser 给自己的
  //    headerActions/sectionLabel 显式 visibility:visible，会从列级 hidden 里「透」出来，
  //    手机实测左缘游离按钮）；display 不可被后代翻转。但只能打在轨道根节点上——
  //    frame 是 0px+1fr+0px 三轨网格，列 display:none 会从网格流里摘掉、中列顶进 0px 轨
  //    （实测整页空屏）。弹层打开时豁免（保空气弹层修复）。——
  assert.match(once1, /\[class\*="sidebarCol"\]:has\(\[class\*="collapsed"\]\):not\(:has\(\[role="dialog"\]\)\) \[class\*="root"\]\[class\*="collapsed"\]\{display:none!important\}/)

  // —— 功能坞面板必须抬到原生弹层之上 ——
  assert.match(once1, /\[class\*="dockm-backdrop"\]\{z-index:2000!important\}/, '手机端没有把功能坞面板抬到原生弹层之上')

  // —— 「点会话才收抽屉」点击路由 ——
  // 会话行以 data-row-key="session:" 开头；工作区文件夹是 workspace: 开头——点文件夹
  // 只展开/收拢分组，绝不收抽屉（用户实测「点文件夹抽屉被收起」）。文件夹分支必须
  // 在「面板弹出即收起」探测之前 return，否则文件夹会被误判成侧栏入口。
  assert.match(once1, /rowKey\.indexOf\("session:"\)===0/, '会话行识别没有按 data-row-key 的 session: 前缀')
  assert.match(once1, /if\(rowKey\.indexOf\("workspace:"\)===0\)return/, '缺工作区文件夹的早退分支（点文件夹会被误收抽屉/误探测）')
  assert.doesNotMatch(once1, /var leaf=row&&!row\.querySelector/, '残留旧的「无子 treeitem 即叶子」判定')
  // 侧栏入口（插件/自动化任务/设置…）弹出的面板 z 序低于展开的抽屉——点击后必须
  // 探测面板并收起抽屉，否则面板被盖住等于「点了没反应」（用户实测截图）。
  assert.match(once1, /setTimeout\(function\(\)\{if\(document\.querySelector\('\[role="dialog"\]'\)\)collapse\(\)\},260\)/, '侧栏入口点击后没有「面板弹出即收起抽屉」的探测')

  console.log('mobile host: ok（tapIndex 注入含窄屏 chrome + 滚动兜底 + 点击路由，且与远程访问解耦）')
} finally {
  dispose()
}
function countOf(text, needle) { return text.split(needle).length - 1 }
