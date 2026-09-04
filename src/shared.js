// dsh-dock · 客户端共享工具（外壳与功能模块共用；提取功能模块独立成包时随包复制）
import react from "react";

/**
 * 功能视图错误边界：外部功能包注册进来的视图渲染抛错时降级为错误提示，
 * 不拖垮整个功能坞面板（内置视图不包——它们与外壳同包发布、同生命周期）。
 */
export class FeatureBoundary extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error: error };
	}
	render() {
		if (this.state.error) {
			const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
			return react.createElement("div", { className: "dockm-note dockm-err" },
				"功能视图渲染出错：" + msg + "（该功能来自外部包，不影响面板其他功能）");
		}
		return this.props.children;
	}
}

// ---- 功能开关状态（外壳面板与会话区 chips 共用；每功能开关 localStorage 持久化，重启后保持） ----
const featureState = new Map();
const stateListeners = new Set();
function notifyState() {
	for (const fn of stateListeners) fn();
}
// 开关持久化（dsh-dock/features/v1）：id -> boolean；未记录过的功能用模块默认值
const FEATURE_STORE_KEY = "dsh-dock/features/v1";
const featurePersist = { map: {} };
try {
	if (typeof localStorage !== "undefined") {
		const raw = localStorage.getItem(FEATURE_STORE_KEY);
		const obj = raw ? JSON.parse(raw) : null;
		if (obj && typeof obj === "object") featurePersist.map = obj;
	}
} catch { /* localStorage 不可用时用默认值 */ }
function persistFeatureEnabled() {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(FEATURE_STORE_KEY, JSON.stringify(featurePersist.map));
	} catch { /* 持久化失败静默 */ }
}
/** 外壳 apply 时初始化内置功能的默认开关（持久化过的值优先于模块默认）。
 * 默认全部停用、按需开启：仅当模块显式声明 defaultEnabled: true 才默认启用。 */
export function initFeatureState(defs) {
	for (const f of defs) {
		if (featureState.has(f.id)) continue;
		let enabled = !f.planned && f.defaultEnabled === true;
		const saved = featurePersist.map[f.id];
		if (typeof saved === "boolean") enabled = saved;
		featureState.set(f.id, { enabled, error: null });
	}
}
/** 取功能开关（外部功能默认启用；未登记的 id 惰性建项）。 */
export function stateOf(id) {
	let st = featureState.get(id);
	if (!st) { st = { enabled: true, error: null }; featureState.set(id, st); }
	return st;
}
export function toggleFeature(id) {
	const st = stateOf(id);
	st.enabled = !st.enabled;
	featurePersist.map[id] = st.enabled;
	persistFeatureEnabled();
	notifyState();
}
export function subscribeFeatureState(fn) {
	stateListeners.add(fn);
	return () => { stateListeners.delete(fn); };
}

// ---- 会话页 chips 显示开关（每功能；localStorage 持久化，缺省显示） ----
// 与功能启用正交：功能启用决定面板页与宿主功能，本开关只控制会话输入区的随身小控件。
const CHIP_STORE_KEY = "dsh-dock/chips/v1";
const chipVisible = { map: {} };
try {
	if (typeof localStorage !== "undefined") {
		const raw = localStorage.getItem(CHIP_STORE_KEY);
		const obj = raw ? JSON.parse(raw) : null;
		if (obj && typeof obj === "object") chipVisible.map = obj;
	}
} catch { /* localStorage 不可用时用默认值 */ }
function persistChipVisible() {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(CHIP_STORE_KEY, JSON.stringify(chipVisible.map));
	} catch { /* 持久化失败静默 */ }
}
/** 功能的会话页 chip 是否显示（未记录过的功能默认显示）。 */
export function chipShown(id) {
	return chipVisible.map[id] !== false;
}
/** 设置功能的会话页 chip 显示开关（立即生效并持久化）。 */
export function setChipShown(id, value) {
	chipVisible.map[id] = value !== false;
	persistChipVisible();
	notifyState();
}

// ---- 面板导航总线：功能坞外任何位置（会话区 chips 等）可请求打开面板并跳到某功能 ----
// openPanel("balance", { provider })   → 打开功能坞并定位到模型余额页，高亮指定 Provider
// openPanel("tokenlog", { sessionId }) → 打开功能坞并定位到用量记录页，按会话筛选
export const panelNav = { open: false, active: "home", params: null };
const navListeners = new Set();
function notifyNav() {
	for (const fn of navListeners) fn();
}
export function openPanel(active, params) {
	panelNav.open = true;
	panelNav.active = typeof active === "string" && active ? active : "home";
	panelNav.params = params && typeof params === "object" ? params : null;
	notifyNav();
}
export function setPanelOpen(value) {
	panelNav.open = !!value;
	if (!value) panelNav.params = null;
	notifyNav();
}
/** 面板内切换功能页（不携带参数）。 */
export function navigatePanel(active) {
	panelNav.active = typeof active === "string" && active ? active : "home";
	notifyNav();
}
export function subscribePanel(fn) {
	navListeners.add(fn);
	return () => { navListeners.delete(fn); };
}
