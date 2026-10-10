// dsh-dock · 插件级兼容注入：远程（非回环）浏览器的「预览版说明」自动确认
//
// 根因（dsh 0.2.0 ui-settings-models/src/client/welcome-store.ts，文件头注释原文）：
// 回环浏览器的确认走宿主持久化，一次确认永久生效；**远程（非回环）浏览器的设置 scope
// 是 memory 模式，确认只存页面进程内存，刷新即丢**——所以从局域网/组网 IP 打开时
// 「预览版说明」每次刷新都重弹，profile patch 里钉 welcomeNoticeVersion 也救不了
// （memory 分支根本不读持久值）。
//
// 归属：这是「非回环浏览器」这一访问形态的兼容问题，与任何一个功能模块的职责都不重合——
// 【远程访问】只保留远程入口本身（用户要求），而关掉远程访问、主实例经 patch 层绑 0.0.0.0
// 的直连形态（公司部署）同样会每次重弹。所以挂在插件级（index.js 注册 tapIndex），
// 不随任何功能开关启停；回环地址自我短路，让 dsh 原生的一次性持久确认自然工作。
//
// 与【远程访问】网关的关系：网关代理的页面由网关对连接 bundle 做回环自判改写，
// 确认可持久化、弹窗首次确认后不再出现，本脚本找不到弹窗即零副作用；直连形态下
// 本脚本每次页面加载最多替用户点一次「继续」。dsh 未来若让远程确认可持久化，
// 弹窗不再出现，本脚本自动空转，无需随版本跟进。
//
// 注入点在 <head> 之后，body 尚未解析：观察器一律推迟到 DOMContentLoaded 再挂。
const WELCOME_ACK_JS = [
  ';(function(){',
  'if (window.__dshDockWelcomeAck) return;',
  'window.__dshDockWelcomeAck = "host";',
  'var host = (window.location && window.location.hostname) || "";',
  'if (host === "127.0.0.1" || host === "localhost" || host === "::1" || host.slice(-10) === ".localhost") return;',
  'if (typeof MutationObserver === "undefined") return;',
  'var done = false;',
  'var observer = null;',
  'function tryDismiss() {',
  '  if (done || !document.body) return;',
  '  var dialogs = document.querySelectorAll(\'[role="dialog"]\');',
  '  for (var i = 0; i < dialogs.length; i++) {',
  '    if (!/预览版说明|Preview Notice/.test(dialogs[i].textContent || "")) continue;',
  '    var buttons = dialogs[i].querySelectorAll("button");',
  '    for (var j = 0; j < buttons.length; j++) {',
  '      var label = (buttons[j].textContent || "").replace(/^\\s+|\\s+$/g, "");',
  '      if (label === "继续" || label === "Continue") {',
  '        done = true;',
  '        buttons[j].click();',
  '        if (observer) observer.disconnect();',
  '        return;',
  '      }',
  '    }',
  '    break;',
  '  }',
  '}',
  'function start() {',
  '  observer = new MutationObserver(tryDismiss);',
  '  observer.observe(document.body, { childList: true, subtree: true });',
  '  tryDismiss();',
  // 兜底停止：说明若 60 秒内没出现（未来版本改版/被官方移除），观察器自动退场
  '  setTimeout(function () { if (observer) observer.disconnect(); }, 60000);',
  '}',
  'if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);',
  'else start();',
  '})();',
].join('\n')
const WELCOME_ACK_MARKER = 'data-dsh-dock-welcome-ack'
export { WELCOME_ACK_MARKER }

/** 把「预览版说明」自动确认脚本内联注入 index.html 的 <head> 之后（幂等）。 */
export function injectWelcomeAck(html) {
  if (html.includes(WELCOME_ACK_MARKER)) return html
  const match = /<head(?:\s[^>]*)?>/i.exec(html)
  const script = `<script ${WELCOME_ACK_MARKER}>${WELCOME_ACK_JS}</script>`
  if (!match) return script + html
  const at = match.index + match[0].length
  return html.slice(0, at) + script + html.slice(at)
}
