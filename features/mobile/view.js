// dsh-dock · 功能模块【手机适配】· 客户端视图（唯一实现）
//
// 这一版刻意「做减法」：手机适配的全部逻辑都放在客户端这一半，宿主半部
// （features/mobile/host.js）只剩一个开关占位。原因有三：
//
//   1) 关闭要彻底。旧版把排版样式与行为脚本经 webServer.tapIndex 内联注入 index.html，
//      必须重启 dsh web 才能彻底摘除；现在改成「Overlay 挂载时才注入、卸载时立刻移除」，
//      关闭开关 = Overlay 卸载 = <style> 元素、body 属性、遮罩/按钮、监听器、观察器、
//      定时器全部一并消失，页面 <head> 不残留任何标记，也不动 <meta viewport>。
//   2) 不与 dsh 原生布局打架。dsh 自身（<768px）已是抽屉模式、设置弹层已是单列、
//      账号卡片排版正常。旧版强行 position:fixed + 100vw + flex-direction 覆盖，
//      反而把好好的原生排版改坏（账号名一字一行、查询用量/充值被裁）。
//      这一版只补原生没做的事，且用「行为检测」决定是否兜底旧版：
//        · 设置弹层：仅当实测仍是「左导航 + 右内容」两栏时才加 data-dsh-mobile-stack
//          改为纵向堆叠（现代 dsh 已单列 → 检测为已堆叠 → 不加，原生排版不动）；
//        · 侧栏：仅当 <768 却仍是静态轨道（旧版 dsh 无抽屉模式）时才浮层化 + 注入
//          汉堡/遮罩（现代 dsh 有 data-sidebar-drawer → 不动，用原生抽屉）。
//   3) 单一来源。样式只此一份（MOBILE_CSS），不存在「宿主一份、客户端一份」对不齐。
//
// 只保留真正常见的手机痛点优化：
//   · 输入类控件字号 16px —— iOS 聚焦 <16px 输入框会强制整页放大；
//   · 触控基础：去点按高亮、touch-action:manipulation（消双击缩放判定延迟）；
//   · 原生侧栏开关点击热区扩到 44×44（图标位置视觉不变）；
//   · 代码块横向滚动、行内代码换行；
//   · 会话输入行上 dsh-dock 的随身小控件（余额/用量 chip）在手机上整组收起——
//     窄屏下它们被压成「余额…」既读不出数值又白占输入行；
//   · 设置弹层内容区补安全区内边距、滚动体补底部安全区。
//
// 命中：窗口宽 ≤767px，或主指针为粗触且无悬停（真机/平板）。
import react from "react";
import { useEffect, useState } from "react";

/** 与 dsh 原生窄屏断点对齐（SIDEBAR_DRAWER_BREAKPOINT=768）：<768 才做抽屉/单列兜底。 */
const MOBILE_QUERY = "(max-width: 767px)";
/** 粗指针且无悬停：真机/平板（不含桌面鼠标）；用于「不分宽度的触控优化」。 */
const COARSE_QUERY = "(pointer: coarse) and (hover: none)";

/** 当前视口是否命中手机形态（SSR/无 window 时恒 false）。 */
export function mobileActive() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia(MOBILE_QUERY).matches || window.matchMedia(COARSE_QUERY).matches;
	} catch { return false; }
}

// —— 运行时样式（挂载时注入、卸载时移除；全部选择器再以 body[data-dk-mobile="1"] 兜底，
//    即便某帧 body 属性先被摘掉也不会误伤原生排版） ——
const MOBILE_CSS = [
	'/* 触控与输入：粗指针真机（不分宽度） */',
	'@media (pointer: coarse) and (hover: none){',
	'  body[data-dk-mobile="1"] :is(textarea,input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="password"],input[type="number"],input[type="email"],[contenteditable="true"]){font-size:16px !important;}',
	'  body[data-dk-mobile="1"] :is(button,[role="button"]){-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
	'}',
	'@media (max-width:767px){',
	'  body[data-dk-mobile="1"] :is(textarea,input:not([type]),input[type="text"],input[type="search"],input[type="url"],input[type="password"],input[type="number"],input[type="email"],[contenteditable="true"]){font-size:16px !important;}',
	'  body[data-dk-mobile="1"] :is(button,[role="button"]){-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
	'  body[data-dk-mobile="1"] pre{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
	'  body[data-dk-mobile="1"] code{overflow-wrap:anywhere;}',
	'  body[data-dk-mobile="1"] pre code{overflow-wrap:normal;}',
	'  body[data-dk-mobile="1"] .dockchip-row{display:none;}',
	'  body[data-dk-mobile="1"] [data-sidebar-opener]{position:relative;}',
	'  body[data-dk-mobile="1"] [data-sidebar-opener]::after{content:"";position:absolute;left:50%;top:50%;width:44px;height:44px;transform:translate(-50%,-50%);}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"] [class*="options"]{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));}',
	'  body[data-dk-mobile="1"] [class*="scrollBody"]{padding-bottom:env(safe-area-inset-bottom,0px) !important;}',
	'  /* 功能坞面板（.dockm-*）挂在 .overlayLayer(z20) 内，而手机抽屉 .sidebarCol 是 z71——面板虽是全屏却被抽屉盖住。把 overlayLayer 抬到抽屉之上，功能坞/全局浮层才能全屏盖住抽屉。 */',
	'  body[data-dk-mobile="1"] [class*="overlayLayer"]{z-index:100 !important;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack]{display:flex !important;flex-direction:column !important;width:100vw !important;max-width:100vw !important;height:100dvh !important;max-height:none !important;border-radius:0 !important;overflow:hidden !important;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack] > [class*="header"]{order:0;flex:none;width:auto !important;height:auto !important;padding:8px 12px !important;justify-content:flex-end !important;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack] > [class*="navTitle"]{order:1;flex:none;width:auto !important;padding:2px 16px 8px !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack] > nav{order:2;flex:none;width:auto !important;height:auto !important;padding:0 8px 8px !important;overflow-x:auto;overflow-y:hidden;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack] > nav [class*="navList"]{flex-direction:row !important;}',
	'  body[data-dk-mobile="1"] [role="dialog"][class*="panel"][data-dsh-mobile-stack] > [class*="options"]{order:3;flex:1 1 auto !important;min-height:0 !important;width:auto !important;overflow-y:auto !important;padding-bottom:max(16px,env(safe-area-inset-bottom,0px)) !important;}',
	'  body[data-dk-mobile="1"][data-dsh-mobile-legacy] [class$="frame"]{grid-template-columns:0px minmax(0,1fr) 0px !important;}',
	'  body[data-dk-mobile="1"][data-dsh-mobile-legacy] [class$="frame"] [class*="sidebarCol"]{position:fixed !important;top:0 !important;bottom:0 !important;left:0 !important;width:min(86vw,300px) !important;z-index:80 !important;box-shadow:0 12px 48px rgba(0,0,0,.45);transform:none !important;visibility:visible !important;transition:transform .22s ease !important;}',
	'  body[data-dk-mobile="1"][data-dsh-mobile-legacy] [class$="frame"][data-sidebar-collapsed] [class*="sidebarCol"]{transform:translateX(-105%) !important;visibility:hidden !important;transition:transform .22s ease, visibility 0s linear .22s !important;}',
	'  body[data-dk-mobile="1"] .dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);touch-action:none;}',
	'  body[data-dk-mobile="1"] .dsh-mobile-burger{position:fixed;left:calc(4px + env(safe-area-inset-left,0px));top:calc(4px + env(safe-area-inset-top,0px));z-index:66;box-sizing:border-box;width:44px;height:44px;display:flex;align-items:center;justify-content:center;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary,#e6eaf2);-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
	'  body[data-dk-mobile="1"] .dsh-mobile-burger svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;}',
	'  body[data-dk-mobile="1"] .dsh-mobile-burger:active{background:color-mix(in srgb,currentColor 12%,transparent);}',
	'  body[data-dk-mobile="1"][data-dsh-mobile-legacy] [class$="frame"] header:has([class*="titleRow"]){padding-left:calc(48px + env(safe-area-inset-left,0px));}',
	'  html.dsh-dock-kbd body[data-dk-mobile="1"] .dsh-mobile-burger{display:none !important;}',
	'}',
].join('\n');

const STYLE_ATTR = 'data-dsh-mobile-runtime';
const BODY_ATTR = 'data-dk-mobile';
const LEGACY_ATTR = 'data-dsh-mobile-legacy';

// 运行时装配：把样式注入 <head>、给 body 打属性、按需兜底旧版 dsh 的弹层/抽屉，
// 并返回一个「连一点痕迹都不留」的清理函数。挂载即生效、卸载即还原，无需重启 dsh web。
// 单例：重复挂载（React StrictMode 双调 effect、或多半部误触）时先清理上一份，保证全程只有一套。
let currentDispose = null;
function applyRuntime() {
	if (typeof window === 'undefined' || typeof document === 'undefined') return function () {};
	const doc = document;
	const body = doc.body;
	if (!body) return function () {};
	if (currentDispose) { try { currentDispose(); } catch (e) {} currentDispose = null; }

	body.setAttribute(BODY_ATTR, '1');
	let styleEl = doc.querySelector('style[' + STYLE_ATTR + ']');
	if (!styleEl) {
		styleEl = doc.createElement('style');
		styleEl.setAttribute(STYLE_ATTR, '');
		styleEl.textContent = MOBILE_CSS;
		doc.head.appendChild(styleEl);
	}

	const mql = window.matchMedia ? window.matchMedia(MOBILE_QUERY) : null;
	const vv = window.visualViewport || null;
	const phone = function () { return !!(mql && mql.matches); };
	const frame = function () { return doc.querySelector('[class$="frame"]'); };
	const isCollapsed = function () { const f = frame(); return !!(f && f.hasAttribute('data-sidebar-collapsed')); };
	let scrim = null;
	let burger = null;
	let observer = null;
	let timer = 0;

	function sidebarOpenToggle() {
		const b = doc.querySelector('[data-sidebar-opener]') || doc.querySelector('[data-sidebar-toggle]');
		if (b && typeof b.click === 'function') b.click();
	}
	function clearStack() {
		const panels = doc.querySelectorAll('[role="dialog"][class*="panel"][data-dsh-mobile-stack]');
		for (let i = 0; i < panels.length; i++) panels[i].removeAttribute('data-dsh-mobile-stack');
	}
	// 设置弹层：只在「左导航与右内容并排」时兜底成纵向堆叠；已是单列（现代 dsh）则什么都不做。
	function dialogStackSync() {
		const panel = doc.querySelector('[role="dialog"][class*="panel"]');
		if (!panel) return;
		let nav = null;
		let opt = null;
		const kids = panel.children;
		for (let i = 0; i < kids.length; i++) {
			const k = kids[i];
			if (!nav && k.tagName === 'NAV') nav = k;
			if (!opt && k.className && String(k.className).indexOf('options') >= 0) opt = k;
		}
		if (!nav || !opt) { panel.removeAttribute('data-dsh-mobile-stack'); return; }
		const a = nav.getBoundingClientRect();
		const b = opt.getBoundingClientRect();
		if (!a.width || !b.width) return;
		const sideBySide = b.left >= a.right - 8 && b.top < a.bottom - 4 && b.bottom > a.top + 4;
		if (sideBySide) panel.setAttribute('data-dsh-mobile-stack', '1');
		else panel.removeAttribute('data-dsh-mobile-stack');
	}
	function removeChrome() {
		if (scrim) { scrim.remove(); scrim = null; }
		if (burger) { burger.remove(); burger = null; }
		body.removeAttribute(LEGACY_ATTR);
	}
	function ensureChrome() {
		if (!scrim) {
			scrim = doc.createElement('div');
			scrim.className = 'dsh-mobile-scrim';
			scrim.style.display = 'none';
			scrim.addEventListener('click', function () { if (!isCollapsed()) sidebarOpenToggle(); });
			body.appendChild(scrim);
		}
		if (!burger) {
			burger = doc.createElement('button');
			burger.type = 'button';
			burger.className = 'dsh-mobile-burger';
			burger.setAttribute('aria-label', '打开会话列表');
			burger.setAttribute('aria-expanded', 'false');
			burger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/></svg>';
			burger.addEventListener('click', function () { sidebarOpenToggle(); });
			body.appendChild(burger);
		}
	}
	// 旧版 dsh（<768 无 data-sidebar-drawer，侧栏仍是静态轨道）才浮层化 + 注入汉堡/遮罩。
	function legacySync() {
		const f = frame();
		const legacy = !!f && phone() && !f.hasAttribute('data-sidebar-drawer');
		if (!legacy) { removeChrome(); return; }
		body.setAttribute(LEGACY_ATTR, '1');
		ensureChrome();
		const collapsed = isCollapsed();
		if (scrim) scrim.style.display = collapsed ? 'none' : '';
		if (burger) {
			burger.style.display = '';
			burger.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
		}
	}
	function kbdSync() {
		if (!vv) return;
		const kbd = vv.height > 0 && (window.innerHeight - vv.height) > 120;
		const de = doc.documentElement;
		if (kbd) de.classList.add('dsh-dock-kbd');
		else de.classList.remove('dsh-dock-kbd');
	}
	let dockAutoClosed = false;
	function dockOpen() { return !!doc.querySelector('.dockm-dialog'); }
	function tick() {
		try {
			kbdSync();
			if (phone()) {
				// 功能坞面板打开时自动收起抽屉，否则抽屉会盖在面板左侧、且中列处于 inert。
				const dopen = dockOpen();
				if (dopen && !isCollapsed() && !dockAutoClosed) { dockAutoClosed = true; sidebarOpenToggle(); }
				if (!dopen) dockAutoClosed = false;
				dialogStackSync();
				legacySync();
			}
			else { clearStack(); removeChrome(); dockAutoClosed = false; }
		} catch (e) { /* 任何一步失败都不影响页面 */ }
	}

	tick();
	if (typeof MutationObserver !== 'undefined') {
		observer = new MutationObserver(function () { tick(); });
		try {
			observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-sidebar-drawer'], subtree: true });
			observer.observe(body, { childList: true, subtree: true });
		} catch (e) { /* observe 失败就只靠定时器 */ }
	}
	timer = window.setInterval(tick, 1200);
	const onResize = function () { tick(); };
	window.addEventListener('resize', onResize);
	if (vv && vv.addEventListener) vv.addEventListener('resize', kbdSync);
	if (mql && mql.addEventListener) mql.addEventListener('change', tick);
	else if (mql && mql.addListener) mql.addListener(tick);

	const dispose = function () {
		if (currentDispose === dispose) currentDispose = null;
		try { if (observer) observer.disconnect(); } catch (e) {}
		if (timer) window.clearInterval(timer);
		window.removeEventListener('resize', onResize);
		if (vv && vv.removeEventListener) vv.removeEventListener('resize', kbdSync);
		if (mql && mql.removeEventListener) mql.removeEventListener('change', tick);
		else if (mql && mql.removeListener) mql.removeListener(tick);
		try { doc.documentElement.classList.remove('dsh-dock-kbd'); } catch (e) {}
		try { clearStack(); } catch (e) {}
		removeChrome();
		try { body.removeAttribute(BODY_ATTR); } catch (e) {}
		try { if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl); } catch (e) {}
	};
	currentDispose = dispose;
	return dispose;
}

// —— Overlay：功能启用期间常驻；active 时挂载运行时、非 active 时什么也不做 ——
export function MobileOverlay() {
	const [active, setActive] = useState(function () { return mobileActive(); });
	useEffect(function () {
		if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
		let mqs = [];
		try { mqs = [window.matchMedia(MOBILE_QUERY), window.matchMedia(COARSE_QUERY)]; } catch (e) { return undefined; }
		const update = function () { setActive(mqs.some(function (m) { return m.matches; })); };
		update();
		for (let i = 0; i < mqs.length; i++) {
			const m = mqs[i];
			if (m.addEventListener) m.addEventListener('change', update);
			else if (m.addListener) m.addListener(update);
		}
		return function () {
			for (let i = 0; i < mqs.length; i++) {
				const m = mqs[i];
				if (m.removeEventListener) m.removeEventListener('change', update);
				else if (m.removeListener) m.removeListener(update);
			}
		};
	}, []);
	useEffect(function () {
		if (!active) return undefined;
		return applyRuntime();
	}, [active]);
	return null;
}

// —— 功能页：一行说清当前命中状态与兜底对象 ——
function useViewport() {
	const [size, setSize] = useState(function () {
		return typeof window === 'undefined' ? null : { w: window.innerWidth, h: window.innerHeight };
	});
	useEffect(function () {
		if (typeof window === 'undefined') return undefined;
		const update = function () { setSize({ w: window.innerWidth, h: window.innerHeight }); };
		window.addEventListener('resize', update);
		return function () { window.removeEventListener('resize', update); };
	}, []);
	return size;
}

function MobileView() {
	const size = useViewport();
	const [active, setActive] = useState(function () { return mobileActive(); });
	const [drawer, setDrawer] = useState(false);
	useEffect(function () {
		if (typeof window === 'undefined') return undefined;
		const tick = function () {
			setActive(mobileActive());
			const f = document.querySelector('[class$="frame"]');
			setDrawer(!!(f && f.hasAttribute('data-sidebar-drawer')));
		};
		tick();
		const t = setInterval(tick, 1000);
		return function () { clearInterval(t); };
	}, []);
	const mode = !active ? '未命中' : (window.matchMedia && window.matchMedia(MOBILE_QUERY).matches ? (drawer ? '抽屉模式（原生）' : '旧版兜底（浮层抽屉）') : '仅触控优化');
	return react.createElement('div', { className: 'dkmob-root' },
		react.createElement('div', { className: 'dkmob-row' },
			react.createElement('span', { className: 'dkmob-label' }, '手机模式'),
			react.createElement('span', { className: 'dkmob-state' + (active ? ' on' : '') }, active ? '已命中' : '未命中'),
			react.createElement('span', { className: 'dkmob-dim' }, size ? size.w + '×' + size.h + 'px' : '')),
		react.createElement('div', { className: 'dkmob-row' },
			react.createElement('span', { className: 'dkmob-label' }, '当前形态'),
			react.createElement('span', { className: 'dkmob-state' + (active ? ' on' : '') }, mode)),
		react.createElement('div', { className: 'dkmob-note' },
			'生效中的优化：输入类控件字号 16px（防 iOS 聚焦整页缩放）· 原生侧栏开关热区扩到 44×44 · ',
			'去点按高亮与双击缩放判定 · 代码块横向滚动 / 行内代码换行 · 会话输入行的余额/用量 chip 收起 · ',
			'设置弹层内容安全区内边距。旧版 dsh（<768 仍是两栏弹层或静态图标轨道）会自动兜底为单列 / 浮层抽屉。',
			'关闭本功能即全部还原——运行时样式、body 属性、遮罩/按钮与所有监听器一并移除，页面不残留任何注入。'));
}

function MobileStat() {
	const active = mobileActive();
	if (!active) return react.createElement('span', null, '当前视口未命中手机形态，未启用任何优化');
	return react.createElement('span', null, '手机模式生效中（16px 输入 / 触控热区 / 代码滚动 / 弹层兜底）');
}

// —— 样式：模块自身仅样式为空（运行时样式由 Overlay 注入/卸载，关闭后零残留）；
//    View 自身的小样式随全局 <style> 注入，命名空间 dkmob- 避免与其他模块冲突。 ——
const css = [
	'.dkmob-root{display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;}',
	'.dkmob-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
	'.dkmob-label{font-weight:600;flex:none;}',
	'.dkmob-state{flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 10px;font-size:11px;}',
	'.dkmob-state.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}',
	'.dkmob-dim{color:var(--dsw-alias-label-secondary);font-size:12px;}',
	'.dkmob-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}',
].join('\n');

export const feature = {
	id: 'mobile',
	name: '手机适配',
	order: 170,
	accent: '#34d399',
	description: '手机/窄屏体验优化：16px 输入防缩放、触控热区、代码块滚动、会话 chip 收起、设置弹层单列与旧版抽屉兜底；关闭后零残留',
	defaultEnabled: false,
	css,
	Overlay: MobileOverlay,
	View: MobileView,
	HomeStat: MobileStat,
};
