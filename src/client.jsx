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
import {
	FeatureBoundary,
	initFeatureState, stateOf, toggleFeature, subscribeFeatureState,
	chipShown, setChipShown,
	panelNav, openPanel, setPanelOpen, navigatePanel, subscribePanel,
} from "./shared.js";
import { feature as fTokenlog } from "../features/tokenlog/view.jsx";
import { feature as fModelconfig } from "../features/modelconfig/view.js";
import { feature as fHeartbeat } from "../features/heartbeat/view.js";
import { feature as fTheme } from "../features/theme/view.js";
import { feature as fBalance } from "../features/balance/view.js";
import { feature as fAnimation } from "../features/animation/view.jsx";
import { feature as fMobileRelay } from "../features/mobile-relay/view.jsx";

const name = "dsh-dock";
const DOCK_VERSION = "0.6.0";

// ---- 内置功能注册表：新功能 = features/<id>/ 加模块 + 这里 import 一行 ----
const BUILTIN_FEATURES = [fTokenlog, fModelconfig, fHeartbeat, fTheme, fBalance, fAnimation, fMobileRelay];
// 规划占位（路线图）：接入后移除并建 features/<id>/ 模块
const PLANNED_FEATURES = [];
const PLANNED_NOTES = {};

// ---- 外部功能注册表（dockBridge 回装通道） ----
const externalDefs = [];
const externalListeners = new Set();
function notifyExternal() {
	for (const fn of externalListeners) fn();
}
/**
 * 外部功能桥：独立功能包经 require("dsh-dock").dockBridge 注册视图。
 * def: { id, name, order?, accent?, description?, css?, View, HomeStat?, Overlay?, package? }
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
			Overlay: typeof def.Overlay === "function" ? def.Overlay : null,
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

// ---- 开关状态与面板导航总线在 src/shared.js（会话区 chips 与面板共用，避免外壳↔模块循环依赖） ----

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
	// 侧栏入口按钮（docke2- 前缀）：与 dsh 设置按钮（.VOzbGW_trigger）几何逐条对齐——
	// 宽栏同为整宽左对齐行按钮（高 42、margin 4/-2、padding 0 10px 0 8px、圆角 12），窄栏同为 36 圆钮居中，
	// 使两按钮上下成列、左右边缘完全对齐（此前右对齐/叠放都会错位）。
	".docke2-btn{box-sizing:border-box;cursor:pointer;display:flex;align-items:center;gap:8px;border:none;background:transparent;color:var(--dsw-alias-label-primary);border-radius:12px;width:calc(100% + 4px);height:42px;margin:4px -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;line-height:22px;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
	".docke2-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	".docke2-btn.docke2-on{color:var(--dsw-alias-accent,#4d9fff);background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 12%,transparent));}",
	".docke2-btn.docke2-rail{width:36px;height:36px;margin:8px 0 10px;padding:0;border-radius:50%;justify-content:center;gap:0;}",
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
	".dockh-badge{flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
	// 状态标识（非交互：圆点+文字，与可点的开关一眼区分）
	".dockh-status{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
	".dockh-sdot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-state-success-primary,#34d399);box-shadow:0 0 4px color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d399) 55%,transparent);}",
	".dockh-status.off .dockh-sdot{background:transparent;border:1.5px solid var(--dsw-alias-label-tertiary);box-shadow:none;opacity:.75;}",
	".dockh-status.plan .dockh-sdot{background:transparent;border:1.5px dashed var(--dsw-alias-label-tertiary);box-shadow:none;}",
	// iOS 风滑动开关（首页卡片 / 弹层页脚 / 设置页共用的启停控件）
	".dock-sw{flex:none;position:relative;width:34px;height:19px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;transition:background .18s var(--ds-ease-in-out),border-color .18s var(--ds-ease-in-out);}",
	".dock-sw::after{content:\"\";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .35);transition:transform .18s var(--ds-ease-in-out);}",
	".dock-sw:hover{border-color:var(--dsw-alias-accent,#4d9fff);}",
	".dock-sw.on{background:var(--dsw-alias-state-success-primary,#34d399);border-color:transparent;}",
	".dock-sw.on::after{transform:translateX(15px);}",
	// 弹层页脚：文字标签 + 开关 成组
	".dockm-foot-sw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;}",
	".dockm-foot-swlabel{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
".dockm-foot-swlabel.on{color:var(--dsw-alias-state-success-primary);}",
	// 窄屏：功能坞是一级工作台而不是被压扁的桌面弹窗。全屏承接安全区，导航改横向，
	// 禁用桌面拖拽/缩放，所有导航和关闭动作保持至少 44px 的可点击面积。
	"@media (max-width:680px){.dockm-backdrop{align-items:stretch;justify-content:stretch;background:var(--dsw-alias-bg-layer-2);backdrop-filter:none}.dockm-dialog,.dockm-dialog.dockm-max{position:fixed!important;left:0!important;top:0!important;right:auto!important;bottom:auto!important;width:100dvw!important;height:100dvh!important;min-height:100dvh;border:0;border-radius:0;box-shadow:none}.dockm-dialog.dockm-min .dockm-body{display:flex}.dockm-head{min-height:60px;box-sizing:border-box;padding:calc(env(safe-area-inset-top) + 8px) 12px 8px;cursor:default;touch-action:manipulation}.dockm-sub,.dockm-win,.dockm-resize{display:none}.dockm-title{font-size:16px}.dockm-close{width:44px;height:44px;font-size:17px}.dockm-body{flex-direction:column;min-height:0}.dockm-nav{box-sizing:border-box;width:auto;max-width:100%;min-height:56px;flex-direction:row;gap:6px;padding:6px 10px;overflow-x:auto;overflow-y:hidden;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1);scrollbar-width:none;overscroll-behavior-x:contain}.dockm-nav::-webkit-scrollbar{display:none}.dockm-nav-item{flex:none;min-height:44px;padding:0 12px;font-size:13px;touch-action:manipulation}.dockm-nav-item .dockm-badge{display:none}.dockm-content{padding:16px max(16px,env(safe-area-inset-right)) calc(20px + env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));gap:14px;overscroll-behavior:contain}.dockm-content-head{gap:5px}.dockm-name{font-size:16px}.dockm-desc{font-size:13px;line-height:1.55}.dockm-foot{padding-top:12px;font-size:11px}.dockm-foot-sw{width:100%;margin-left:0;justify-content:space-between}.dock-sw{width:44px;height:26px}.dock-sw::after{top:3px;left:3px;width:18px;height:18px}.dock-sw.on::after{transform:translateX(18px)}.dockh-grid{grid-template-columns:1fr;gap:10px}.dockh-card{padding:12px}.dockh-desc{font-size:13px}.dockh-go{font-size:12px}}",
	"@media (prefers-reduced-motion:reduce){.dockm-backdrop,.dockm-dialog{animation:none}.dockm-nav-item,.dockm-close,.dockm-win,.dock-sw{transition:none}}",
	".dockh-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}",
	".dockh-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dockh-foot{display:flex;align-items:center;gap:8px;}",
	".dockh-go{color:var(--dsw-alias-label-tertiary);font-size:11px;}",
	// 会话输入区工具行 chips（dockchip- 前缀）：余额/用量随身小控件，挂在模型选择器左侧
	// 溢出兼容（两层防护，缺一不可）：
	//  1) 宽度上限：宿主 .row 是 flex-wrap:wrap 且换行优先于收缩，chips 一长 tools 整行变宽，
	//     右侧模型选择器/发送键被挤到第二行（左右错位）。宿主 .row 带 container-type:inline-size，
	//     用容器单位 cqw 让上限随输入卡宽度自适应（窄卡少占、宽卡多占）；不支持 cqw 的老内核退回固定值。
	//     注意：旧上限 min(280px,36cqw) 仍偏宽——标准 780px 输入卡下（.row 内容约 762px），
	//     add 钮(28)+工作区选择器(~214)+chips(280) 已与右侧模型选择器+发送键（~345px）合计超宽，
	//     即便 chips 未截断 .row 也会换行把模型选择器/发送键挤到第二行。实测把上限收到 189px
	//     （≈25cqw）并使 chips 内距收紧（padding 2px 6px、gap 2px）后，实测 4~6M 用量 + 余额
	//     两 chip 可完整显示且不再换行；超限时仍被省略号截断，完整值在 title 悬浮提示里。
	//  2) 截断：超限部分用省略号截断（完整数值在 title 悬浮提示里），防 chips 凸出输入卡圆角（悬空）。
	".dockchip-row{display:inline-flex;align-items:center;gap:2px;min-width:0;flex:0 1 auto;overflow:hidden;max-width:189px;}",
	"@supports (width:1cqw){.dockchip-row{max-width:min(189px,25cqw);}}",
	".dockchip{display:inline-flex;align-items:center;gap:5px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;padding:2px 6px;font-family:inherit;font-size:11px;line-height:18px;white-space:nowrap;min-width:0;overflow:hidden;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
	".dockchip > span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}",
	".dockchip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dockchip .dockchip-dot{width:6px;height:6px;border-radius:50%;flex:none;}",
	".dockchip.err{color:var(--dsw-alias-state-error-primary);}"
].join("\n");

let dockCssTag = null;
let initialCssSchedule = null;
function cancelInitialCssSchedule() {
	if (!initialCssSchedule || typeof window === "undefined") return;
	if (initialCssSchedule.type === "idle" && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(initialCssSchedule.id);
	if (initialCssSchedule.type === "timer") window.clearTimeout(initialCssSchedule.id);
	initialCssSchedule = null;
}
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
	cancelInitialCssSchedule();
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
// 刷新页时宿主内容优先绘制：功能坞样式很大，首帧同步解析会让整页短暂停顿。
// 首次注入延后到浏览器空闲期；之后的外部模块注册仍走 ensureCss() 立即更新。
function scheduleInitialCss() {
	if (typeof document === "undefined" || initialCssSchedule || (dockCssTag && dockCssTag.isConnected)) return;
	const run = () => {
		initialCssSchedule = null;
		ensureCss();
	};
	if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
		initialCssSchedule = { type: "idle", id: window.requestIdleCallback(run, { timeout: 350 }) };
	} else {
		initialCssSchedule = { type: "timer", id: setTimeout(run, 48) };
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

// ---- 弹层窗口几何记忆（页面生命周期内）：拖动/缩放后记住位置与尺寸，重开还原 ----
let lastGeom = { x: null, y: null, w: null, h: null };

function DockIcon(props) {
	const size = (props && props.size) || 16;
	return react.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
		react.createElement("rect", { x: 2.5, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 9, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 2.5, y: 9, width: 4.4, height: 4.4, rx: 1.2 }),
		react.createElement("rect", { x: 9, y: 9, width: 4.4, height: 4.4, rx: 1.2 }));
}

function DockEntry(props) {
	const wide = !!props.wide;
	const [open, setOpen] = react.useState(panelNav.open);
	react.useEffect(() => subscribePanel(() => setOpen(panelNav.open)), []);
	return react.createElement("button", {
		type: "button",
		className: "docke2-btn" + (open ? " docke2-on" : "") + (wide ? "" : " docke2-rail"),
		title: "功能坞",
		"aria-label": "功能坞",
		"aria-expanded": open,
		onClick: () => setPanelOpen(!open)
	}, react.createElement(DockIcon, { size: wide ? 16 : 18 }), wide ? react.createElement("span", { className: "docke2-label" }, "功能坞") : null);
}

// ---- 功能坞弹出面板：shell.overlay（仿 dsh 设置：居中模态 = 遮罩 + 对话框） ----
// 左侧导航：首项「首页」总揽（默认选中），其后是各功能模块（order 升序）；planned 模块只占位展示
function DockModal() {
	// 默认关闭；SSR/无浏览器环境下默认展开内容（便于冒烟测试渲染整棵弹层树）
	// 导航总线（open/active/params）驱动：chips 点击 openPanel(...) 即可打开并定位
	const [nav, setNav] = react.useState({ open: panelNav.open, active: panelNav.active, params: panelNav.params });
	react.useEffect(() => subscribePanel(() => setNav({ open: panelNav.open, active: panelNav.active, params: panelNav.params })), []);
	const open = nav.open || typeof document === "undefined";
	const active = nav.active;
	const setActive = navigatePanel;
	const navParams = nav.params;
	const [, force] = react.useReducer((n) => n + 1, 0);
	useExternalVersion();
	// ---- 窗口几何：普通（默认居中大窗）/最大化/最小化；拖动标题栏移动、右下角缩放 ----
	// lastGeom 记住本页生命周期内最后一次几何，重开弹层时还原
	const [win, setWin] = react.useState(() => ({ mode: "normal", x: null, y: null, w: null, h: null }));
	const dlgRef = react.useRef(null);
	const contentRef = react.useRef(null);
	react.useEffect(() => {
		if (lastGeom.w) setWin({ mode: "normal", x: lastGeom.x, y: lastGeom.y, w: lastGeom.w, h: lastGeom.h });
	}, []);
	// 切换左侧模块时总是从新页面顶部开始，避免把上一页的滚动位置带进小游戏等短页面。
	react.useEffect(() => {
		if (open && contentRef.current) contentRef.current.scrollTop = 0;
	}, [active, open]);
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
	// 外部包视图包错误边界；视图统一收到 { ctx, feature, params } props
	//（params 来自导航总线：如 { provider } 高亮余额行、{ sessionId } 按会话筛选用量）
	const View = mod ? mod.View : null;
	const viewNode = mod && View
		? react.createElement("div", { className: "dockm-view" },
			react.createElement(mod.external ? FeatureBoundary : react.Fragment, null,
				react.createElement(View, { ctx: ctxRef.current, feature: mod, params: navParams })))
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
				react.createElement("div", { className: "dockm-content", ref: contentRef },
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
							: react.createElement("div", { className: "dockm-note" }, "该功能当前为停用状态（开关已持久化，重启后保持）"),
					react.createElement("div", { className: "dockm-foot" },
						react.createElement("span", null, isHome
							? "功能坞 v" + DOCK_VERSION + " · 共 " + MODULES.length + " 个功能模块，" + enabledCount + " 个已启用"
							: "功能坞 v" + DOCK_VERSION + " · 新功能按路线图追加"),
						!isHome && mod && !mod.planned && st
							? react.createElement("span", { className: "dockm-foot-sw" },
								react.createElement("span", { className: "dockm-foot-swlabel" + (st.enabled ? " on" : "") }, st.enabled ? "已启用" : "已停用"),
								react.createElement("button", {
									type: "button",
									className: "dock-sw" + (st.enabled ? " on" : ""),
									role: "switch",
									"aria-checked": !!st.enabled,
									"aria-label": (st.enabled ? "停用" : "启用") + mod.name,
									title: st.enabled ? "停用「" + mod.name + "」" : "启用「" + mod.name + "」",
									onClick: () => { toggleFeature(mod.id); force(); }
								}))
							: null,
						!isHome && mod && typeof mod.Chip === "function"
							? react.createElement("span", { className: "dockm-foot-sw" },
								react.createElement("span", { className: "dockm-foot-swlabel" + (chipShown(mod.id) ? " on" : "") }, "会话页小控件"),
								react.createElement("button", {
									type: "button",
									className: "dock-sw" + (chipShown(mod.id) ? " on" : ""),
									role: "switch",
									"aria-checked": chipShown(mod.id),
									"aria-label": (chipShown(mod.id) ? "隐藏" : "显示") + mod.name + "的会话页小控件",
									title: "控制会话输入区（模型选择器左侧）是否显示本功能的随身小控件",
									onClick: () => { setChipShown(mod.id, !chipShown(mod.id)); force(); }
								}))
							: null))),
			win.mode === "normal"
				? react.createElement("div", { className: "dockm-resize", onPointerDown: (e) => beginDrag(e, "size") })
				: null));
}

// ---- 首页总揽：每个功能模块一张卡片（状态标识 + 运行概要 + 启停开关），点卡片进对应功能 ----
// 交互约定：状态是「圆点+文字」纯标识（不可点）；启停是 iOS 滑动开关（明显可点）；点卡片其余区域跳详情页。
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
					// 状态标识：圆点 + 文字（纯展示，与开关视觉区分）
					react.createElement("span", { className: "dockh-status" + (m.planned ? " plan" : enabled ? "" : " off") },
						react.createElement("span", { className: "dockh-sdot" }),
						react.createElement("span", null, m.planned ? "规划中" : enabled ? "运行中" : "已停用")),
					// 启停开关（规划中的功能不显示）
					m.planned ? null : react.createElement("button", {
						type: "button",
						className: "dock-sw" + (enabled ? " on" : ""),
						role: "switch",
						"aria-checked": enabled,
						"aria-label": (enabled ? "停用" : "启用") + m.name,
						title: enabled ? "停用「" + m.name + "」" : "启用「" + m.name + "」",
						onClick: (e) => {
							e.stopPropagation();
							toggleFeature(m.id);
							// onToggle = DockModal 的 force：连带刷新弹层脚注的「N 个已启用」统计
							if (props && typeof props.onToggle === "function") props.onToggle();
							force();
						}
					})),
				react.createElement("div", { className: "dockh-desc" }, m.description),
				react.createElement("div", { className: "dockh-stat" }, statNode),
				react.createElement("div", { className: "dockh-foot" },
					react.createElement("span", { className: "dockh-go" }, "查看详情 →")));
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
						type: "button",
						className: "dock-sw" + (st.enabled ? " on" : ""),
						role: "switch",
						"aria-checked": st.enabled,
						"aria-label": (st.enabled ? "停用" : "启用") + f.name,
						title: st.enabled ? "停用「" + f.name + "」" : "启用「" + f.name + "」",
						onClick: () => toggle(f.id)
					}),
					!f.planned && typeof f.Chip === "function"
						? react.createElement("span", { className: "dockm-foot-sw" },
							react.createElement("span", { className: "dockm-foot-swlabel" + (chipShown(f.id) ? " on" : "") }, "会话页小控件"),
							react.createElement("button", {
								type: "button",
								className: "dock-sw" + (chipShown(f.id) ? " on" : ""),
								role: "switch",
								"aria-checked": chipShown(f.id),
								"aria-label": (chipShown(f.id) ? "隐藏" : "显示") + f.name + "的会话页小控件",
								title: "控制会话输入区（模型选择器左侧）是否显示本功能的随身小控件",
								onClick: () => { setChipShown(f.id, !chipShown(f.id)); force(); }
							}))
						: null),
				f.planned
					? react.createElement("div", { className: "dock-body" }, PLANNED_NOTES[f.id] || "待接入：见 README 路线图")
					: st.error ? react.createElement("div", { className: "dock-body dockm-err" }, "功能出错：" + st.error) : null,
				viewNode);
		}));
}

// ---- 会话输入区工具行 chips：已启用功能的随身小控件（模型选择器左侧） ----
// 功能模块在 feature 描述符上挂可选 Chip 组件（props: { ctx, session, sessionId, input, feature }），
// 启用即在 conversation.input.left 渲染；点击通常经 openPanel(...) 打开功能坞定位到对应功能页。
function DockChips(props) {
	const [, force] = react.useReducer((n) => n + 1, 0);
	react.useEffect(() => subscribeFeatureState(() => force()), []);
	const items = [];
	for (const f of allModules()) {
		if (f.planned || !stateOf(f.id).enabled || !chipShown(f.id) || typeof f.Chip !== "function") continue;
		items.push(react.createElement(f.Chip, {
			key: f.id, ctx: props.ctx, feature: f,
			session: props.session, sessionId: props.sessionId, input: props.input,
		}));
	}
	if (items.length === 0) return null;
	return react.createElement("div", { className: "dockchip-row" }, items);
}

// ---- 功能全局浮层：模块可在描述符上挂 Overlay 组件（props: { ctx, feature }） ----
// 与 Chip（会话输入区小控件）不同，Overlay 是常驻整页挂载的全局 UI（如任务动画的动效与通知栈），
// 只要所属功能启用就渲染（功能停用即卸载，浮层自身负责按数据状态决定显示什么）。
function FeatureOverlays() {
	const [, force] = react.useReducer((n) => n + 1, 0);
	useExternalVersion();
	react.useEffect(() => subscribeFeatureState(() => force()), []);
	const items = [];
	for (const f of allModules()) {
		if (f.planned || !stateOf(f.id).enabled || typeof f.Overlay !== "function") continue;
		items.push(react.createElement(FeatureBoundary, { key: f.id },
			react.createElement(f.Overlay, { ctx: ctxRef.current, feature: f })));
	}
	if (items.length === 0) return null;
	return react.createElement(react.Fragment, null, items);
}

// ---- 插件应用：注册四处 UI（入口按钮 / 弹层 / 设置页 / 会话区 chips），注入样式 ----
// ctx 以 ref 供视图组件使用（timer/theme 等服务按需自取；重装/HMR 时更新）
const ctxRef = { current: null };

export function apply(ctx) {
	ctxRef.current = ctx;
	scheduleInitialCss();
	initFeatureState(BUILTIN_FEATURES.concat(PLANNED_FEATURES));
	const slots = ctx.get("slots");
	if (slots === undefined) return;

	slots.inject("sidebar.footer.action", () => slots.register(
		{ name: "sidebar.footer.action", id: "dsh-dock", order: 1, label: "功能坞" },
		(props) => react.createElement(DockEntry, props)));
	slots.inject("shell.overlay", () => slots.register(
		{ name: "shell.overlay", id: "dsh-dock-panel", order: 21, label: "功能坞面板" },
		() => react.createElement(DockModal, null)));
	// 功能全局浮层（任务动画的动效与通知等）：已启用功能的 Overlay 常驻挂载
	slots.inject("shell.overlay", () => slots.register(
		{ name: "shell.overlay", id: "dsh-dock-feature-overlays", order: 22, label: "功能坞全局浮层" },
		() => react.createElement(FeatureOverlays, null)));
	slots.inject("settings.section", () => slots.register(
		{ name: "settings.section", id: "dsh-dock", order: 90, label: "功能坞" },
		() => react.createElement(DockPanel, null)));
	// 会话输入卡工具行左端（模型选择器左侧）：已启用功能的随身小控件
	slots.inject("conversation.input.left", () => slots.register(
		{ name: "conversation.input.left", id: "dsh-dock-chips", order: 10, label: "功能坞" },
		(zone) => react.createElement(DockChips, Object.assign({}, zone, { ctx: ctxRef.current }))));
	// 手机接力链接使用 fragment，避免配对码进入服务器日志或 Referer。插件加载后立即消费并
	// 清掉 fragment，再自动打开对应功能；DSH 会话本身仍由宿主原生会话服务继续承接。
	try {
		if (typeof window !== "undefined") {
			const match = window.location.hash.match(/(?:^#|&)dsh-mobile-relay=([^&]+)/);
			if (match) {
				const launch = decodeURIComponent(match[1]);
				if (/^[A-Za-z0-9_-]+\.[A-F0-9]{10}$/i.test(launch)) {
					sessionStorage.setItem("dsh-dock/mobile-relay/launch/v1", launch);
					window.history.replaceState(null, "", window.location.pathname + window.location.search);
					setTimeout(() => openPanel("mobile-relay"), 0);
				}
			}
		}
	} catch { /* 私密模式禁用 storage/history 时保持手动入口可用 */ }
}

export const inject = ["timer"];
export { dockBridge };
