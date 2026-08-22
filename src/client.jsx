// dsh-dock · Client 半部（浏览器外壳，源码入口；构建为根目录 client.js）
//
// v0.4.0 模块化架构：外壳只负责面板本身（入口按钮/居中弹窗/设置页/首页总揽），
// 每个功能是一个 features/<id>/view.js(x) 模块（自带描述符 + 视图 + 样式），在此 import 组装。
// 菜单次序由各模块 order 字段决定（首页固定第一，tokenlog=10 → 第二个菜单）。
//
// 外部功能桥（dockBridge）：独立发布的功能包（scripts/extract-feature.mjs 生成的骨架）
// 在浏览器端 require("dsh-dock").dockBridge.register(def) 把自己的视图注册进本面板；
// dock 未安装时该包走自己的独立面板——「单独成包发布」与「完美集成功能坞」两全。
//
// 面板挂载在 settings.section：设置 → 功能坞；侧栏底部另有「功能坞」入口按钮
// （sidebar.footer.action），点击弹出居中功能面板（shell.overlay）。
// 弹层窗口：默认大窗，支持最大化/最小化、标题栏拖动、右下角缩放（几何页内记忆）。
import react from "react";
import { FeatureBoundary } from "./shared.js";
import { feature as fTokenlog } from "../features/tokenlog/view.jsx";
import { feature as fModelconfig } from "../features/modelconfig/view.js";
import { feature as fHeartbeat } from "../features/heartbeat/view.js";
import { feature as fTheme } from "../features/theme/view.js";
import { feature as fBalance } from "../features/balance/view.js";

const name = "dsh-dock";
const DOCK_VERSION = "0.4.0";

// ---- 内置功能注册表：新功能 = features/<id>/ 加模块 + 这里 import 一行 ----
const BUILTIN_FEATURES = [fTokenlog, fModelconfig, fHeartbeat, fTheme, fBalance];
// 规划占位（路线图）：接入后移除并建 features/<id>/ 模块
const PLANNED_FEATURES = [
	{ id: "animation", name: "任务动画", order: 130, accent: "#f472b6", planned: true, description: "接入路线图 0.5.0：任务进度动画与通知" },
];
const PLANNED_NOTES = {
	animation: "待接入（路线图 0.5.0）：任务进度动画与完成通知。",
};

// ---- 外部功能注册表（dockBridge 回装通道） ----
const externalDefs = [];
const externalListeners = new Set();
function notifyExternal() {
	for (const fn of externalListeners) fn();
}
/**
 * 外部功能桥：独立功能包经 require("dsh-dock").dockBridge 注册视图。
 * def: { id, name, order?, accent?, description?, css?, View, HomeStat?, package? }
 * 返回注销函数。重复 id 视为更新（HMR/重注册场景）。
 */
const dockBridge = {
	version: DOCK_VERSION,
	register(def) {
		if (!def || typeof def !== "object" || typeof def.id !== "string" || !def.id || typeof def.View !== "function") {
			console.error("[dsh-dock] dockBridge.register 参数不符（需 { id, name, View }）:", def);
			return () => {};
		}
		const entry = {
			id: def.id,
			name: String(def.name || def.id),
			order: typeof def.order === "number" ? def.order : 500,
			accent: typeof def.accent === "string" ? def.accent : "#94a3b8",
			description: String(def.description || ""),
			css: typeof def.css === "string" ? def.css : "",
			View: def.View,
			HomeStat: typeof def.HomeStat === "function" ? def.HomeStat : null,
			external: true,
			package: typeof def.package === "string" ? def.package : "",
		};
		const i = externalDefs.findIndex((x) => x.id === entry.id);
		if (i >= 0) externalDefs[i] = entry;
		else externalDefs.push(entry);
		if (entry.css) ensureCss(); // 外部样式后到：重算并更新已注入的 <style>
		notifyExternal();
		return () => {
			const j = externalDefs.indexOf(entry);
			if (j >= 0) { externalDefs.splice(j, 1); notifyExternal(); }
		};
	},
	features() {
		return externalDefs.map((x) => Object.assign({}, x));
	},
};

// ---- 菜单模块表（内置 + 外部，按 order 升序；同序稳定保持注册顺序） ----
function allModules() {
	return BUILTIN_FEATURES.concat(PLANNED_FEATURES, externalDefs)
		.slice()
		.sort((a, b) => ((a.order || 500) - (b.order || 500)));
}

// ---- 开关状态：浏览器内存态，随页面生命周期 ----
const state = new Map();
for (const f of BUILTIN_FEATURES) state.set(f.id, { enabled: f.defaultEnabled !== false, error: null });
for (const f of PLANNED_FEATURES) state.set(f.id, { enabled: false, error: null });
function stateOf(id) {
	let st = state.get(id);
	if (!st) { st = { enabled: true, error: null }; state.set(id, st); } // 外部功能默认启用
	return st;
}
function toggleFeature(id) {
	const st = stateOf(id);
	st.enabled = !st.enabled;
}

// ---- 样式：外壳样式 + 各功能模块自带样式（css 字段）合并注入一个 <style> ----
// ⚠️ 变量名不得用 CSS：浏览器存在全局 window.CSS 命名空间，bundle 任何作用域解析歧义
// 都会把标识符解析成该全局对象（无 .join），曾导致插件应用失败、整页启动崩溃。
const SHELL_CSS = [
	".dock-root{display:flex;flex-direction:column;gap:12px;padding:4px 0;color:var(--dsw-alias-label-primary);font-size:13px;}",
	".dock-intro{color:var(--dsw-alias-label-secondary);line-height:1.6;}",
	".dock-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}",
	".dock-card-head{display:flex;align-items:center;gap:8px;}",
	".dock-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:none;}",
	".dock-dot.on{background:var(--dsw-alias-state-success-primary);}",
	".dock-dot.err{background:var(--dsw-alias-state-error-primary);}",
	".dock-name{font-weight:600;flex:none;}",
	".dock-desc{color:var(--dsw-alias-label-secondary);flex:1;}",
	".dock-switch{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;cursor:pointer;font-size:12px;}",
	".dock-switch.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}",
	".dock-badge{flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-size:12px;}",
	".dock-body{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px;}",
	// 侧栏入口按钮（docke2- 前缀）+ 功能坞弹出面板（dockm- 前缀，仿 dsh 设置的居中模态：遮罩 + 对话框，左导航 + 右内容）
	".docke2-btn{box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:10px;height:32px;font-family:inherit;font-size:13px;line-height:32px;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
	".docke2-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".docke2-btn.docke2-on{color:var(--dsw-alias-accent,#4d9fff);background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 12%,transparent));}",
	".docke2-label{white-space:nowrap;overflow:hidden;}",
	".dockm-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);backdrop-filter:blur(4px);pointer-events:auto;animation:dockm-fade .15s var(--ds-ease-in-out);}",
	"@keyframes dockm-fade{from{opacity:0}to{opacity:1}}",
	".dockm-dialog{box-sizing:border-box;position:relative;width:min(1080px,calc(100vw - 32px));height:min(700px,calc(100vh - 32px));display:flex;flex-direction:column;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 20px 64px rgb(0 0 0 / .32);overflow:hidden;animation:dockm-pop .18s var(--ds-ease-in-out);}",
	"@keyframes dockm-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}",
	".dockm-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:move;user-select:none;touch-action:none;}",
	".dockm-title{font-weight:600;font-size:14px;}",
	".dockm-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;}",
	".dockm-ctrls{margin-left:auto;flex:none;display:flex;align-items:center;gap:2px;}",
	".dockm-close{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;}",
	".dockm-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dockm-win{cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;}",
	".dockm-win:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dockm-dialog.dockm-max{border-radius:12px;}",
	".dockm-dialog.dockm-min{height:auto;min-height:0;}",
	".dockm-dialog.dockm-min .dockm-body{display:none;}",
	".dockm-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;z-index:3;touch-action:none;}",
	".dockm-body{flex:1;min-height:0;display:flex;}",
	".dockm-nav{flex:none;width:176px;display:flex;flex-direction:column;gap:2px;padding:10px 8px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);}",
	".dockm-nav-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:none;background:transparent;border-radius:10px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;text-align:left;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
	".dockm-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dockm-nav-item.on{background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 12%,transparent));color:var(--dsw-alias-label-primary);font-weight:600;}",
	".dockm-nav-item .dockm-badge{margin-left:auto;}",
	".dockm-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
	".dockm-badge{flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
	".dockm-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px;overflow-y:auto;}",
	".dockm-content-head{display:flex;flex-direction:column;gap:4px;}",
	".dockm-name{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;}",
	".dockm-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dockm-view{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
	".dockm-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
	".dockm-err{color:var(--dsw-alias-state-error-primary);}",
	".dockm-foot{margin-top:auto;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;flex-wrap:wrap;}",
	".dockm-switch{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 12px;font-family:inherit;font-size:12px;margin-left:auto;}",
	".dockm-switch:hover{color:var(--dsw-alias-label-primary);}",
	".dockm-switch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	// 首页总揽（dockh- 前缀）：导航首项图标 + 模块卡片网格
	".dockm-navhome{display:inline-flex;align-items:center;color:var(--dsw-alias-accent,#4d9fff);flex:none;}",
	".dockh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;}",
	".dockh-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s var(--ds-ease-in-out);}",
	".dockh-card:hover,.dockh-card:focus-visible{border-color:var(--dsw-alias-accent,#4d9fff);outline:none;}",
	".dockh-head{display:flex;align-items:center;gap:8px;}",
	".dockh-name{font-weight:600;flex:none;}",
	".dockh-badge{margin-left:auto;flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
	".dockh-badge.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	".dockh-badge.off{border-style:dashed;}",
	".dockh-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}",
	".dockh-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dockh-foot{display:flex;align-items:center;gap:8px;}",
	".dockh-go{color:var(--dsw-alias-label-tertiary);font-size:11px;}"
].join("\n");

let dockCssTag = null;
function fullDockCss() {
	const parts = [SHELL_CSS];
	for (const f of BUILTIN_FEATURES) if (f.css) parts.push(f.css);
	for (const f of externalDefs) if (f.css) parts.push(f.css);
	return parts.join("\n");
}
// 样式全局注入一次（入口按钮与右下角浮层挂在设置页之外，不能依赖页内 <style>）。
// 这里用 SHELL_CSS 唯一命名，并做防御：注入永不抛错、失败只降级不打断启动；
// 外部功能注册携带样式时可重算更新（外部样式后到）。
function ensureCss() {
	if (typeof document === "undefined") return;
	try {
		if (!dockCssTag || !dockCssTag.isConnected) {
			if (document.querySelector('style[data-plugin-css="dsh-dock"]')) {
				dockCssTag = document.querySelector('style[data-plugin-css="dsh-dock"]');
			} else {
				dockCssTag = document.createElement("style");
				dockCssTag.dataset.pluginCss = "dsh-dock";
				document.head.appendChild(dockCssTag);
			}
		}
		dockCssTag.textContent = fullDockCss();
	} catch (e) {
		console.error("[dsh-dock] ensureCss failed:", e && e.message ? e.message : String(e));
	}
}

// ---- 外部功能变化订阅 hook（弹层/设置页重渲染用） ----
function useExternalVersion() {
	const [, bump] = react.useReducer((n) => n + 1, 0);
	react.useEffect(() => {
		externalListeners.add(bump);
		return () => { externalListeners.delete(bump); };
	}, []);
}

// ---- 侧栏入口按钮与弹层共享的面板开关（浏览器内存态，随页面生命周期） ----
const panelState = { open: false, listeners: new Set() };
let lastGeom = { x: null, y: null, w: null, h: null };
function setPanelOpen(value) {
	panelState.open = !!value;
	for (const fn of panelState.listeners) fn();
}
function subscribePanel(fn) {
	panelState.listeners.add(fn);
	return () => { panelState.listeners.delete(fn); };
}

function DockIcon() {
	return react.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
		react.createElement("rect", { x: 2.5, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 9, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 2.5, y: 9, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 9, y: 9, width: 4.4, height: 4.4, rx: 1.2 }));
}

function DockEntry(props) {
	const wide = !!props.wide;
	const [open, setOpen] = react.useState(panelState.open);
	react.useEffect(() => subscribePanel(() => setOpen(panelState.open)), []);
	return react.createElement("button", {
		type: "button",
		className: "docke2-btn" + (open ? " docke2-on" : ""),
		style: wide
			// 与设置按钮精确同框：设置 trigger 宽栏 = 42px 高、margin-top 4 → 下移 46px、高度同为 42，
			// 使本按钮的四条边与设置按钮完全重合（同一水平线）；rail = 36px、margin-top 8 → 下移 44px、高 36 亦然。
			// zIndex 保证盖在满宽设置按钮之上（其右侧为空白区，不遮齿轮图标）
			? { marginLeft: "auto", transform: "translateY(46px)", zIndex: 1, height: 42, lineHeight: "42px", padding: "0 12px" }
			: { transform: "translateY(44px)", zIndex: 1, width: 36, height: 36, justifyContent: "center", padding: 0 },
		title: "功能坞",
		"aria-label": "功能坞",
		"aria-expanded": open,
		onClick: () => setPanelOpen(!open)
	}, react.createElement(DockIcon, null), wide ? react.createElement("span", { className: "docke2-label" }, "功能坞") : null);
}

// ---- 功能坞弹出面板：shell.overlay（仿 dsh 设置：居中模态 = 遮罩 + 对话框） ----
// 左侧导航：首项「首页」总揽（默认选中），其后是各功能模块（order 升序）；planned 模块只占位展示
function DockModal() {
	// 默认关闭；SSR/无浏览器环境下默认展开内容（便于冒烟测试渲染整棵弹层树）
	const [open, setOpen] = react.useState(panelState.open || typeof document === "undefined");
	react.useEffect(() => subscribePanel(() => setOpen(panelState.open)), []);
	const [active, setActive] = react.useState("home");
	const [, force] = react.useReducer((n) => n + 1, 0);
	useExternalVersion();
	// ---- 窗口几何：普通（默认居中大窗）/最大化/最小化；拖动标题栏移动、右下角缩放 ----
	// lastGeom 记住本页生命周期内最后一次几何，重开弹层时还原
	const [win, setWin] = react.useState(() => ({ mode: "normal", x: null, y: null, w: null, h: null }));
	const dlgRef = react.useRef(null);
	react.useEffect(() => {
		if (lastGeom.w) setWin({ mode: "normal", x: lastGeom.x, y: lastGeom.y, w: lastGeom.w, h: lastGeom.h });
	}, []);
	function beginDrag(e, type) {
		if (win.mode !== "normal" || e.button !== 0) return;
		if (type === "move" && e.target && e.target.closest && e.target.closest("button,select,input")) return;
		const node = dlgRef.current;
		if (!node || typeof window === "undefined") return;
		const rect = node.getBoundingClientRect();
		const startX = e.clientX, startY = e.clientY;
		const origin = { left: rect.left, top: rect.top, w: rect.width, h: rect.height };
		const clampX = (v) => Math.min(Math.max(8, v), window.innerWidth - origin.w - 8);
		const clampY = (v) => Math.min(Math.max(8, v), window.innerHeight - origin.h - 8);
		const onMove = (ev) => {
			const dx = ev.clientX - startX, dy = ev.clientY - startY;
			if (type === "move") setWin((s) => Object.assign({}, s, { x: clampX(origin.left + dx), y: clampY(origin.top + dy) }));
			else setWin((s) => Object.assign({}, s, {
				w: Math.max(640, Math.min(origin.w + dx, window.innerWidth - 16)),
				h: Math.max(420, Math.min(origin.h + dy, window.innerHeight - 16))
			}));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setWin((s) => { lastGeom = { x: s.x, y: s.y, w: s.w, h: s.h }; return s; });
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}
	if (!open) return null;
	const MODULES = allModules();
	const isHome = active === "home";
	const mod = isHome ? null : (MODULES.find((m) => m.id === active) || MODULES[0]);
	const st = mod ? stateOf(mod.id) : null;
	// 外部包视图包错误边界；视图统一收到 { ctx } props（需要 timer/theme 服务的模块自行取用）
	const View = mod ? mod.View : null;
	const viewNode = mod && View
		? react.createElement("div", { className: "dockm-view" },
			react.createElement(mod.external ? FeatureBoundary : react.Fragment, null,
				react.createElement(View, { ctx: ctxRef.current, feature: mod })))
		: null;
	const enabledCount = MODULES.filter((m) => { const s = stateOf(m.id); return !!(s && s.enabled); }).length;
	// 最大化：铺满视口（留 10px 边）；被拖过/缩放过：固定坐标；否则 CSS 默认居中
	const dialogStyle = win.mode === "max"
		? { position: "fixed", left: 10, top: 10, right: 10, bottom: 10, width: "auto", height: "auto" }
		: (win.x != null || win.y != null || win.w != null || win.h != null)
			? {
				position: "fixed",
				left: win.x != null ? win.x : undefined,
				top: win.y != null ? win.y : undefined,
				width: win.w != null ? win.w : undefined,
				height: win.mode === "min" ? "auto" : (win.h != null ? win.h : undefined)
			}
			: null;
	return react.createElement("div", { className: "dockm-backdrop", onClick: () => setPanelOpen(false) },
		react.createElement("div", {
			className: "dockm-dialog" + (win.mode === "max" ? " dockm-max" : "") + (win.mode === "min" ? " dockm-min" : ""),
			style: dialogStyle,
			ref: dlgRef,
			onClick: (e) => e.stopPropagation()
		},
			react.createElement("div", {
				className: "dockm-head",
				onPointerDown: (e) => beginDrag(e, "move"),
				onDoubleClick: () => setWin((s) => Object.assign({}, s, { mode: s.mode === "max" ? "normal" : "max" }))
			},
				react.createElement(DockIcon, null),
				react.createElement("span", { className: "dockm-title" }, "功能坞"),
				react.createElement("span", { className: "dockm-sub" }, "dsh-dock · 也可在 设置 → 功能坞 打开管理页"),
				react.createElement("span", { className: "dockm-ctrls" },
					react.createElement("button", {
						type: "button",
						className: "dockm-win",
						title: win.mode === "min" ? "还原" : "最小化",
						onClick: () => setWin((s) => Object.assign({}, s, { mode: s.mode === "min" ? "normal" : "min" }))
					}, "▁"),
					react.createElement("button", {
						type: "button",
						className: "dockm-win",
						title: win.mode === "max" ? "还原" : "最大化",
						onClick: () => setWin((s) => Object.assign({}, s, { mode: s.mode === "max" ? "normal" : "max" }))
					}, win.mode === "max" ? "❐" : "▢"),
					react.createElement("button", { type: "button", className: "dockm-close", "aria-label": "关闭", title: "关闭", onClick: () => setPanelOpen(false) }, "✕"))),
			react.createElement("div", { className: "dockm-body" },
				react.createElement("nav", { className: "dockm-nav", "aria-label": "功能模块" },
					react.createElement("button", {
						type: "button",
						key: "home",
						className: "dockm-nav-item" + (isHome ? " on" : ""),
						onClick: () => setActive("home")
					},
						react.createElement("span", { className: "dockm-navhome" }, react.createElement(DockIcon, null)),
						react.createElement("span", null, "首页")),
					MODULES.map((m) =>
						react.createElement("button", {
							type: "button",
							key: m.id,
							className: "dockm-nav-item" + (m.id === active ? " on" : ""),
							onClick: () => setActive(m.id)
						},
							react.createElement("span", { className: "dockm-dot", style: { background: m.accent } }),
							react.createElement("span", null, m.name),
							m.planned ? react.createElement("span", { className: "dockm-badge" }, "规划中") : null,
							m.external ? react.createElement("span", { className: "dockm-badge" }, "外部") : null))),
				react.createElement("div", { className: "dockm-content" },
					react.createElement("div", { className: "dockm-content-head" },
						react.createElement("div", { className: "dockm-name" },
							isHome
								? react.createElement("span", { className: "dockm-navhome" }, react.createElement(DockIcon, null))
								: react.createElement("span", { className: "dockm-dot", style: { background: mod.accent } }),
							isHome ? "首页" : mod.name,
							!isHome && mod.planned ? react.createElement("span", { className: "dockm-badge" }, "规划中") : null,
							!isHome && mod.external ? react.createElement("span", { className: "dockm-badge" }, "外部包" + (mod.package ? " · " + mod.package : "")) : null),
						react.createElement("div", { className: "dockm-desc" },
							isHome
								? "所有子功能总揽：运行状态、概要与快捷开关，点击卡片进入对应功能页。"
								: mod.description)),
					isHome
						? react.createElement("div", { className: "dockm-view" }, react.createElement(HomeView, { ctx: ctxRef.current, onOpen: setActive, onToggle: force }))
						: mod.planned
							? react.createElement("div", { className: "dockm-note" }, PLANNED_NOTES[mod.id] || "待接入：见 README 路线图")
							: st && st.enabled && viewNode
								? viewNode
								: st && st.error
									? react.createElement("div", { className: "dockm-note dockm-err" }, "功能出错：" + st.error)
									: react.createElement("div", { className: "dockm-note" }, "该功能当前为停用状态（记忆态随页面生命周期，0.5.0 起持久化）"),
					react.createElement("div", { className: "dockm-foot" },
						react.createElement("span", null, isHome
							? "功能坞 v" + DOCK_VERSION + " · 共 " + MODULES.length + " 个功能模块，" + enabledCount + " 个已启用"
							: "功能坞 v" + DOCK_VERSION + " · 新功能按路线图追加"),
						!isHome && mod && !mod.planned && st
							? react.createElement("button", {
								type: "button",
								className: "dockm-switch" + (st.enabled ? " on" : ""),
								onClick: () => { toggleFeature(mod.id); force(); }
							}, st.enabled ? "已启用（点击停用）" : "已停用（点击启用）")
							: null))),
			win.mode === "normal"
				? react.createElement("div", { className: "dockm-resize", onPointerDown: (e) => beginDrag(e, "size") })
				: null));
}

// ---- 首页总揽：每个功能模块一张卡片（状态徽章 + 运行概要 + 快捷开关），点击进入对应功能 ----
function HomeView(props) {
	const ctx = props && props.ctx;
	const [, force] = react.useReducer((n) => n + 1, 0);
	useExternalVersion();
	const open = (id) => { if (props && typeof props.onOpen === "function") props.onOpen(id); };
	return react.createElement("div", { className: "dockh-grid" },
		allModules().map((m) => {
			const st = stateOf(m.id);
			const enabled = !!(st && st.enabled);
			const Stat = m.HomeStat;
			const statNode = m.planned
				? react.createElement("span", null, PLANNED_NOTES[m.id] || "待接入：见 README 路线图")
				: enabled && Stat
					? react.createElement(m.external ? FeatureBoundary : react.Fragment, null,
						react.createElement(Stat, { ctx: ctx }))
					: react.createElement("span", null, "已停用，启用后在此展示运行概要");
			return react.createElement("div", {
				key: m.id,
				className: "dockh-card",
				role: "button",
				tabIndex: 0,
				onClick: () => open(m.id),
				onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(m.id); } }
			},
				react.createElement("div", { className: "dockh-head" },
					react.createElement("span", { className: "dockm-dot", style: { background: m.accent } }),
					react.createElement("span", { className: "dockh-name" }, m.name),
					m.external ? react.createElement("span", { className: "dockh-badge", title: m.package || undefined }, "外部") : null,
					react.createElement("span", { className: "dockh-badge" + (m.planned ? "" : enabled ? " on" : " off") },
						m.planned ? "规划中" : enabled ? "已启用" : "已停用")),
				react.createElement("div", { className: "dockh-desc" }, m.description),
				react.createElement("div", { className: "dockh-stat" }, statNode),
				react.createElement("div", { className: "dockh-foot" },
					react.createElement("span", { className: "dockh-go" }, "查看详情 →"),
					m.planned ? null : react.createElement("button", {
						type: "button",
						className: "dockm-switch" + (enabled ? " on" : ""),
						onClick: (e) => {
							e.stopPropagation();
							toggleFeature(m.id);
							// onToggle = DockModal 的 force：连带刷新弹层脚注的「N 个已启用」统计
							if (props && typeof props.onToggle === "function") props.onToggle();
							force();
						}
					}, enabled ? "停用" : "启用")));
		}));
}

// ---- 设置页管理面板（settings.section）：所有功能模块卡片一览 ----
function DockPanel() {
	const ctx = ctxRef.current;
	const [, force] = react.useReducer((n) => n + 1, 0);
	useExternalVersion();
	const toggle = (id) => {
		toggleFeature(id);
		force();
	};
	return react.createElement("div", { className: "dock-root" },
		react.createElement("div", { className: "dock-intro" },
			"功能坞（dsh-dock）· 所有小功能集中在这一个面板里管理。v0.4.0 起每个功能是独立模块（features/<id>/），",
			"可单独提取打包发布（scripts/extract-feature.mjs）；独立发布的功能包装回后经 dockBridge 注册进本面板。"),
		allModules().map((f) => {
			const st = stateOf(f.id);
			const View = f.View;
			const viewNode = (!f.planned && st.enabled && View)
				? react.createElement("div", { className: "dock-body" },
					react.createElement(f.external ? FeatureBoundary : react.Fragment, null,
						react.createElement(View, { ctx: ctx, feature: f })))
				: null;
			return react.createElement("div", { className: "dock-card", key: f.id },
				react.createElement("div", { className: "dock-card-head" },
					react.createElement("span", { className: "dock-dot" + (st.error ? " err" : st.enabled ? " on" : "") }),
					react.createElement("span", { className: "dock-name" }, f.name),
					react.createElement("span", { className: "dock-desc" }, f.description + (f.external ? "（来自外部包" + (f.package ? " " + f.package : "") + "）" : "")),
					f.planned
						? react.createElement("span", { className: "dock-badge" }, "规划中")
						: react.createElement("button", {
							className: "dock-switch" + (st.enabled ? " on" : ""),
							onClick: () => toggle(f.id)
						}, st.enabled ? "已启用" : "已停用")),
				f.planned
					? react.createElement("div", { className: "dock-body" }, PLANNED_NOTES[f.id] || "待接入：见 README 路线图")
					: st.error ? react.createElement("div", { className: "dock-body dockm-err" }, "功能出错：" + st.error) : null,
				viewNode);
		}));
}

// ---- 插件应用：注册三处 UI（入口按钮 / 弹层 / 设置页），注入样式 ----
// ctx 以 ref 供视图组件使用（timer/theme 等服务按需自取；重装/HMR 时更新）
const ctxRef = { current: null };

export function apply(ctx) {
	ctxRef.current = ctx;
	ensureCss();
	const slots = ctx.get("slots");
	if (slots === undefined) return;

	slots.inject("sidebar.footer.action", () => slots.register(
		{ name: "sidebar.footer.action", id: "dsh-dock", order: 1, label: "功能坞" },
		(props) => react.createElement(DockEntry, props)));
	slots.inject("shell.overlay", () => slots.register(
		{ name: "shell.overlay", id: "dsh-dock-panel", order: 21, label: "功能坞面板" },
		() => react.createElement(DockModal, null)));
	slots.inject("settings.section", () => slots.register(
		{ name: "settings.section", id: "dsh-dock", order: 90, label: "功能坞" },
		() => react.createElement(DockPanel, null)));
}

export const inject = ["timer"];
export { dockBridge };