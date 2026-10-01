// dsh-dock · 功能模块【手机适配】· 客户端视图（纯 Client 功能，无宿主半部）
//
// 职责：手机/窄屏下的排版与触控兜底。dsh 布局自身在 <1024px（SIDEBAR_AUTO_COLLAPSE）
// 已有窄屏抽屉，本模块只补它没管的四件事：
//   1. 输入类控件字号拉到 16px —— iOS Safari 聚焦任何 <16px 的输入框都会强制放大页面，
//      聊天输入框 14px 字号让手机端每点一次输入框整页就缩放一次，是最影响体验的一件事；
//   2. 触控基础：去点按高亮、touch-action: manipulation（消双击缩放判定延迟），
//      纯图标按钮(唯一子元素为 svg)面积兜底到 ≥36px（实测一批 28×28 的工具钮手机上很难点中）；
//   3. 代码块横向滚动 + 行内代码换行（窄屏不撑破版面）；
//   4. 浮动侧栏开关（FAB）：拇指可达的 44px 圆钮，经 dsh 官方 ctx.layout.toggleSidebar()
//      驱动窄屏抽屉（自己不发状态，只调官方动作，和侧栏右上角的折叠钮行为完全一致）；
//      顺带给 viewport meta 补 viewport-fit=cover，standalone 模式下 env(safe-area-*) 才有值。
//
// 开关协议（关键）：dsh-dock 的 css 字段会「无条件」并入全局 <style>（外壳 fullDockCss
// 不区分功能启停），所以本模块所有全局样式都必须挂在 body[data-dk-mobile="1"] 属性下——
// 该属性由 Overlay 在「功能启用 && 视口命中」时打上、其余情况摘除。停用功能 = 属性消失 =
// 全部样式一秒还原，不需要任何 !important 互相拆台。
//
// 命中条件：窗口宽 ≤820px，或 主指针为粗触且无悬停（真手机/平板）。桌面触屏（主指针 fine）
// 不会误命中；桌面把窗口拖窄到 820px 以下也会命中——这是有意的，方便桌面调试手机效果。
//
// ⚠️ 命名空间用 dkmob- 前缀：dkm- 已被【模型设置】模块占用，撞了会互相覆盖样式。
import react from "react";
import { useEffect, useState } from "react";

/** 视口命中条件（任一即视为手机形态）。 */
const MOBILE_QUERY_NARROW = "(max-width: 820px)";
const MOBILE_QUERY_COARSE = "(pointer: coarse) and (hover: none)";

// 浮动侧栏按钮的显示偏好（localStorage 持久化，按浏览器来源各自记忆——手机上关掉
// 不影响桌面）。缺省显示：功能启用 + 视口命中时，首次就来一个可用的拇指开关。
const MOBILE_STORE_KEY = "dsh-dock/mobile/v1";
const mobilePref = { floating: true };
try {
	if (typeof localStorage !== "undefined") {
		const raw = localStorage.getItem(MOBILE_STORE_KEY);
		const obj = raw ? JSON.parse(raw) : null;
		if (obj && typeof obj === "object" && typeof obj.floating === "boolean") mobilePref.floating = obj.floating;
	}
} catch { /* localStorage 不可用时用默认值 */ }

const prefListeners = new Set();
function notifyPref() {
	for (const fn of prefListeners) {
		try { fn(); } catch { /* 订阅者渲染失败不影响其他 */ }
	}
}
/** 浮动侧栏按钮当前是否显示。 */
export function floatingShown() {
	return mobilePref.floating !== false;
}
/** 设置浮动侧栏按钮显示偏好（立即生效并持久化）。 */
export function setFloatingShown(value) {
	mobilePref.floating = value !== false;
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(MOBILE_STORE_KEY, JSON.stringify(mobilePref));
	} catch { /* 持久化失败静默 */ }
	notifyPref();
}
function subscribePref(fn) {
	prefListeners.add(fn);
	return () => { prefListeners.delete(fn); };
}

/** 当前视口是否命中手机形态（SSR/无 window 时恒 false）。 */
export function mobileActive() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia(MOBILE_QUERY_NARROW).matches || window.matchMedia(MOBILE_QUERY_COARSE).matches;
	} catch { return false; }
}

// —— Overlay：功能启用期间常驻挂载，负责属性开关、viewport meta 与浮动按钮 ——
// 属性管理放 effect 里（含卸载清理）：功能停用 → Overlay 卸载 → 属性摘除 → 全局样式失效。
//
// ⚠️ 与【远程访问】(mobile-relay) 的手机 chrome 互斥协调：窄屏 ≤700px 且远程访问启用时，
// 它的 Overlay 会自建「抽屉把手 + 底部 Tab 栏」整套 chrome，并经 window.__dshDockMobileDrawer
// 旗标（'host' | 'client'，先到先得）声明归属。本模块见到旗标即让出浮动按钮——侧栏开合
// 已有把手负责，两个浮标并排是重复 UI；CSS 兜底层不受影响，互补生效。功能坞面板开关
// 全局重渲染时本组件会跟着重渲染，旗标消失（远程访问被停用）后浮动按钮自动回来。
export function MobileOverlay(props) {
	const ctx = props && props.ctx;
	const [active, setActive] = useState(() => mobileActive());
	const [floating, setFloating] = useState(() => floatingShown());

	// 视口命中监听（matchMedia change；老内核降级 addListener）
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
		let mqs = [];
		try {
			mqs = [window.matchMedia(MOBILE_QUERY_NARROW), window.matchMedia(MOBILE_QUERY_COARSE)];
		} catch { return undefined; }
		const update = () => setActive(mqs.some((mq) => mq.matches));
		update();
		for (const mq of mqs) {
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
			else if (typeof mq.addListener === "function") mq.addListener(update);
		}
		return () => {
			for (const mq of mqs) {
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
				else if (typeof mq.removeListener === "function") mq.removeListener(update);
			}
		};
	}, []);

	// body 属性 = 本模块全部全局样式的总开关；顺带补 viewport-fit=cover（幂等）。
	// 只补不删：cover 在非 standalone 环境无副作用，删了反而让用户自己在 PWA 里的布局抖一次。
	useEffect(() => {
		if (typeof document === "undefined") return undefined;
		if (active) {
			document.body.setAttribute("data-dk-mobile", "1");
			try {
				const meta = document.querySelector('meta[name="viewport"]');
				if (meta && !/(^|,)\s*viewport-fit\s*=/.test(meta.content || "")) {
					meta.setAttribute("content", (meta.content || "width=device-width, initial-scale=1") + ", viewport-fit=cover");
				}
			} catch { /* meta 缺失不致命 */ }
		} else {
			document.body.removeAttribute("data-dk-mobile");
		}
		return () => { document.body.removeAttribute("data-dk-mobile"); };
	}, [active]);

	// 偏好变化（功能设置页里的开关）实时反映到浮动按钮
	useEffect(() => subscribePref(() => setFloating(floatingShown())), []);

	// 远程访问手机 chrome 的工作带宽（≤700px）。旗标在但视口出了它的带（700~820px 区间）
	// 时它的元素只是被 sync 隐藏、仍在 DOM 里——此时浮动按钮必须回归，否则这个区间
	// 没有任何侧栏浮标。监听 700px 边界，跨线即重渲染。
	const [relayBand, setRelayBand] = useState(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
		try { return window.matchMedia("(max-width: 700px)").matches; } catch { return false; }
	});
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
		let mq = null;
		try { mq = window.matchMedia("(max-width: 700px)"); } catch { return undefined; }
		const update = () => setRelayBand(mq.matches);
		update();
		if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
		else if (typeof mq.addListener === "function") mq.addListener(update);
		return () => {
			if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
			else if (typeof mq.removeListener === "function") mq.removeListener(update);
		};
	}, []);

	if (!active || !floating) return null;
	// 远程访问的手机 chrome 在场且视口在它的带内：把手/底部 Tab 已提供侧栏开合，让位
	const relayChromeActive = typeof window !== "undefined" && window.__dshDockMobileDrawer != null && relayBand;
	if (relayChromeActive) return null;
	const onToggle = () => {
		try {
			const layout = ctx && ctx.get ? ctx.get("layout") : null;
			if (layout && typeof layout.toggleSidebar === "function") layout.toggleSidebar();
			else console.warn("[dsh-dock] 手机适配：ctx.layout.toggleSidebar 不可用（dsh 版本过旧？）");
		} catch (err) {
			console.error("[dsh-dock] 手机适配：切换侧栏失败：", err);
		}
	};
	return react.createElement("button", {
		type: "button",
		className: "dkmob-fab",
		"aria-label": "开关侧栏",
		title: "开关侧栏",
		onClick: onToggle,
	}, react.createElement("svg", { width: 20, height: 20, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
		react.createElement("rect", { x: 1.5, y: 2.5, width: 13, height: 11, rx: 2 }),
		react.createElement("line", { x1: 6, y1: 2.5, x2: 6, y2: 13.5 })));
}

// —— 功能页：状态一览 + 浮动按钮开关 + 说明 ——
function useViewportSize() {
	const [size, setSize] = useState(() => (typeof window === "undefined" ? null : { w: window.innerWidth, h: window.innerHeight }));
	useEffect(() => {
		if (typeof window === "undefined") return undefined;
		const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return size;
}

function MobileView() {
	const [active, setActive] = useState(() => mobileActive());
	const [floating, setFloating] = useState(() => floatingShown());
	const size = useViewportSize();
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
		let mqs = [];
		try {
			mqs = [window.matchMedia(MOBILE_QUERY_NARROW), window.matchMedia(MOBILE_QUERY_COARSE)];
		} catch { return undefined; }
		const update = () => setActive(mqs.some((mq) => mq.matches));
		update();
		for (const mq of mqs) {
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
			else if (typeof mq.addListener === "function") mq.addListener(update);
		}
		return () => {
			for (const mq of mqs) {
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
				else if (typeof mq.removeListener === "function") mq.removeListener(update);
			}
		};
	}, []);
	return react.createElement("div", { className: "dkmob-root" },
		react.createElement("div", { className: "dkmob-row" },
			react.createElement("span", { className: "dkmob-label" }, "手机模式"),
			react.createElement("span", { className: "dkmob-state" + (active ? " on" : "") }, active ? "已命中" : "未命中"),
			react.createElement("span", { className: "dkmob-dim" },
				size ? size.w + "×" + size.h + "px" : "",
				"（≤820px 宽，或主指针为触屏无悬停时命中；桌面把窗口拖窄也会命中，方便调试）")),
		react.createElement("div", { className: "dkmob-row" },
			react.createElement("span", { className: "dkmob-label" }, "浮动侧栏按钮"),
			react.createElement("button", {
				type: "button",
				className: "dock-sw" + (floating ? " on" : ""),
				role: "switch",
				"aria-checked": floating,
				"aria-label": (floating ? "隐藏" : "显示") + "浮动侧栏按钮",
				title: floating ? "隐藏左下角的浮动侧栏开关" : "显示左下角的浮动侧栏开关",
				onClick: () => setFloatingShown(!floating),
			}),
			react.createElement("span", { className: "dkmob-dim" }, "44px 圆钮固定在左下角，调用 dsh 官方 toggleSidebar 开合窄屏抽屉；不需要时可在此关闭。")),
		react.createElement("div", { className: "dkmob-note" },
			"生效中的优化：输入类控件字号拉到 16px（避免 iOS 聚焦缩放整页）· 纯图标按钮面积兜底 ≥36px · ",
			"去掉点按高亮与双击缩放判定 · 代码块横向滚动、行内代码自动换行 · viewport meta 补 viewport-fit=cover",
			"（standalone 全屏时给圆角/刘海留安全区）。停用本功能即全部还原。"));
}

// —— 首页概要：一行说清当前命中状态 ——
function MobileStat() {
	const [active, setActive] = useState(() => mobileActive());
	const [floating, setFloating] = useState(() => floatingShown());
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
		let mqs = [];
		try {
			mqs = [window.matchMedia(MOBILE_QUERY_NARROW), window.matchMedia(MOBILE_QUERY_COARSE)];
		} catch { return undefined; }
		const update = () => setActive(mqs.some((mq) => mq.matches));
		update();
		for (const mq of mqs) {
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
			else if (typeof mq.addListener === "function") mq.addListener(update);
		}
		return () => {
			for (const mq of mqs) {
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
				else if (typeof mq.removeListener === "function") mq.removeListener(update);
			}
		};
	}, []);
	useEffect(() => subscribePref(() => setFloating(floatingShown())), []);
	if (!active) return react.createElement("span", null, "当前视口未命中手机形态，样式未注入");
	return react.createElement("span", null, "手机模式生效中 · 浮动侧栏按钮" + (floating ? "显示" : "已隐藏"));
}

// —— 样式：FAB 自身样式（随功能启停）+ 全局兜底（全部挂在 body[data-dk-mobile="1"] 下，
//     见文件头的开关协议说明。!important 只用在输入字号上：dsh 组件层对输入框有自己的
//     字号声明，具体度相同的层叠顺序对插件的 <style> 插入时机敏感，这里以内容正确性优先）——
const css = [
	// 浮动侧栏按钮：44px 触控面积（Apple HIG 最低建议），token 取主题变量自动适配亮暗色；
	// z-index 190 压在功能坞弹层（dockm-backdrop，200）之下，弹层打开时被遮罩盖住不误触。
	".dkmob-fab{position:fixed;left:calc(env(safe-area-inset-left,0px) + 62px);bottom:calc(env(safe-area-inset-bottom,0px) + 74px);z-index:190;width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;justify-content:center;padding:0;box-shadow:0 4px 14px rgb(0 0 0 / .22);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:transform .12s var(--ds-ease-in-out),background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
	".dkmob-fab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dkmob-fab:active{transform:scale(.94);}",
	// 输入类控件 16px：防 iOS 聚焦自动放大（<16px 的输入框聚焦时 Safari 强制缩放页面）
	'body[data-dk-mobile="1"] :is(textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="password"], input[type="number"], input[type="email"], [contenteditable="true"]){font-size:16px !important;}',
	// 触控基础：去点按高亮、消双击缩放判定
	'body[data-dk-mobile="1"] :is(button, [role="button"]){-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
	// 纯图标按钮面积兜底：实测窄屏下一批 28×28 的工具钮很难点中；36px 是不引起行高剧变的上限。
	// 只收「唯一子元素是 svg」的按钮，避免撑坏带文字的行内控件；排除远程访问的抽屉把手
	// （.dsh-mobile-drawer-btn 贴边设计 30px 宽，被撑到 36 会破坏边缘吸附观感）与本模块 FAB。
	'body[data-dk-mobile="1"] button:has(> svg:only-child):not(.dsh-mobile-drawer-btn):not(.dkmob-fab){min-width:36px;min-height:36px;}',
	// 代码块横向滚动、行内代码换行：窄屏不撑破版面
	'body[data-dk-mobile="1"] pre{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
	'body[data-dk-mobile="1"] code{overflow-wrap:anywhere;}',
	'body[data-dk-mobile="1"] pre code{overflow-wrap:normal;}',
	// iOS 横竖屏切换时的字号自动膨胀关掉（:has 挂到 html 上；dsh 自身样式已依赖 :has，基线足够）
	'html:has(body[data-dk-mobile="1"]){-webkit-text-size-adjust:100%;text-size-adjust:100%;}',
	// 功能页自身
	".dkmob-root{display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;}",
	".dkmob-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dkmob-label{font-weight:600;flex:none;}",
	".dkmob-state{flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 10px;font-size:11px;}",
	".dkmob-state.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}",
	".dkmob-dim{color:var(--dsw-alias-label-secondary);font-size:12px;}",
	".dkmob-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
].join("\n");

export const feature = {
	id: "mobile",
	name: "手机适配",
	order: 170,
	accent: "#34d399",
	description: "手机/窄屏排版与触控兜底：16px 输入防 iOS 缩放、图标按钮触控面积、代码块滚动、浮动侧栏开关",
	defaultEnabled: true,
	css,
	Overlay: MobileOverlay,
	View: MobileView,
	HomeStat: MobileStat,
};
