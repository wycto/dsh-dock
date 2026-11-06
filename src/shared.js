// dsh-dock · 客户端共享工具（外壳与功能模块共用；提取功能模块独立成包时随包复制）
import react from "react";

/**
 * 功能视图错误边界：视图渲染抛错时降级为一行错误提示，不拖垮整块面板 UI。
 *
 * ⚠️ 内置视图也必须包（v0.9.9 起）：宿主把每个插槽条目包在 SlotErrorBoundary 里，
 * 条目内任何渲染抛错都会被宿主换成空 div——表现为「点开功能坞界面整个没了」而侧栏
 * 入口按钮仍是选中态。v0.9.3~0.9.8 的 animation 视图就是这样被一个 ReferenceError 打没的。
 * label 用于提示里点明是哪个功能；调用处应带 key（切换功能时重建，否则错误态会跟着串页）。
 */
export class FeatureBoundary extends react.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
	}
	static getDerivedStateFromError(error) {
		return { error: error };
	}
	componentDidCatch(error) {
		console.error("[dsh-dock] 功能视图渲染出错：", error);
	}
	render() {
		if (this.state.error) {
			const msg = this.state.error && this.state.error.message ? this.state.error.message : String(this.state.error);
			const who = this.props && this.props.label ? "「" + this.props.label + "」" : "功能视图";
			return react.createElement("div", { className: "dockm-note dockm-err" },
				who + "渲染出错：" + msg + "（已隔离，不影响面板其他功能；详情见浏览器控制台）");
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
	// 宿主侧持久化开关（settings，跨浏览器/重启）优先：拉过来覆盖本地默认值。
	// localStorage 里已有记录的 id 视为用户在这台浏览器已表态，保持本地值；
	// 若宿主从未收到过该功能的开关，则把本浏览器的选择补推一次（见 syncFeatureStateFromHost）。
	syncFeatureStateFromHost(defs);
}

/** 从宿主 dsh-dock/features 拉取持久化开关，覆盖尚未本地表态的功能默认值。
 * 路由一律用文档相对路径（不带前导斜杠）：DSH 的 index.html 带 <base href="./">，
 * 子路径反代（如 /ui/）下自动解析为 /ui/dsh-dock/...，根挂载下即 dsh-dock/...。
 * 写死前导斜杠会绕过反代挂载前缀，请求被 302 打回应用入口，宿主接口整片失败。
 * 拉取失败（宿主旧版本无此路由）静默降级——沿用本地默认。 */
function syncFeatureStateFromHost(defs) {
	if (typeof fetch !== "function") return;
	fetch("dsh-dock/features").then(async (res) => {
		if (!res.ok) return;
		const data = await res.json().catch(() => null);
		const persisted = data && data.ok && data.data && data.data.persisted;
		if (!persisted || typeof persisted !== "object") return;
		let changed = false;
		for (const f of defs) {
			const local = featurePersist.map[f.id];
			const host = persisted[f.id];
			if (local === undefined) {
				// 本浏览器没表态：跟随宿主持久化值
				if (typeof host === "boolean") {
					const st = stateOf(f.id);
					if (st.enabled !== host) { st.enabled = host; changed = true; }
				}
				continue;
			}
			// 本浏览器已表态，但宿主从未收到过这个功能的开关（persisted 里根本没有它）：
			// 补推一次本浏览器的选择。否则会出现「面板显示已启用、宿主侧却从未 setup」——
			// 该功能的路由整片 404，面板还会误报「宿主进程是旧版本」。宿主刚升级、
			// 或新功能刚拆出来时最容易踩（「任务通知」拆分时就是这样：点开关时宿主
			// 还是旧进程 → POST 404 → 开关只留在浏览器本地，重启后宿主永远不知道）。
			// 注意只在「宿主没有记录」时补推：宿主已显式记过 false 说明是别处关掉的，
			// 不能拿本浏览器的旧值去覆盖（多设备场景）。
			if (typeof host !== "boolean") pushFeatureEnabledToHost(f.id, local);
		}
		if (changed) notifyState();
	}).catch(() => { /* 宿主不可达时用本地默认 */ });
}

/** 把开关同步到宿主（settings 持久化 + 宿主半部即时 setup/dispose）。失败只 warn 不打断：
 * 宿主侧开关只影响路由注册等 Host 能力，本地 UI 状态仍然即时生效。
 * （注意 fetch 对 404 这类 HTTP 错误是正常 resolve，必须查 res.ok——曾因 id 不一致
 * 开关永远 404 而这里毫无声息，排查了两个版本才发现。） */
function pushFeatureEnabledToHost(id, enabled) {
	if (typeof fetch !== "function") return;
	fetch("dsh-dock/features", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, enabled }),
	}).then((res) => {
		if (!res.ok) console.warn(`[dsh-dock] 功能开关同步宿主失败：${id}=${enabled} → HTTP ${res.status}（宿主不认识该 id 或插件未就绪）`);
	}).catch(() => { /* 宿主旧版本或不可达：本地开关仍生效（仅本浏览器） */ });
}
export function toggleFeature(id) {
	const st = stateOf(id);
	st.enabled = !st.enabled;
	featurePersist.map[id] = st.enabled;
	persistFeatureEnabled();
	pushFeatureEnabledToHost(id, st.enabled);
	notifyState();
}
/** 取功能开关（外部功能默认启用；未登记的 id 惰性建项）。 */
export function stateOf(id) {
	let st = featureState.get(id);
	if (!st) { st = { enabled: true, error: null }; featureState.set(id, st); }
	return st;
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

// ---- 等人介入（等待确认 / 等待回答）的统一口径 ----
// 宿主快照里有两类「任务停在原地等人」：
//   approvals —— 工具等待批准（approval/asked → approval/decided）；
//   questions —— 提问等待回答（tool/call ask_user_question → tool/result）。
// 两者语义相同（不动手就不会继续），但来源与文案不同。历史教训（2026-11-01 用户反馈）：
// 只有 approvals 被当成「等人」，提问挂起期间会话零事件，18 秒后被卡住判定误报成
// 「主任务卡住了」——界面在报卡住，实际是等人选答案。凡「是否在等人」的判断都走
// 这里的统一口径，别各处各写一份（漏一处就又是一次误报）。
/** 任务等待批准的审批项（缺字段时给空数组，老宿主快照没有该字段）。 */
export function taskApprovals(task) {
	return task && Array.isArray(task.approvals) ? task.approvals : [];
}
/** 任务等待回答的提问（缺字段时给空数组，老宿主快照没有该字段）。 */
export function taskQuestions(task) {
	return task && Array.isArray(task.questions) ? task.questions : [];
}
/** 任务是否停在原地等人（等批准或等回答）。 */
export function taskWaiting(task) {
	return taskApprovals(task).length > 0 || taskQuestions(task).length > 0;
}
/** 等人介入的项数（审批项 + 提问数），标题、横幅与角标共用。 */
export function waitingCountOf(active) {
	return (active || []).reduce((n, t) => n + taskApprovals(t).length + taskQuestions(t).length, 0);
}

// ---- 「还在动」与「真的停了」的统一口径 ----
// 卡住判定误报过两次，毛病是同一个：只看「最后一个事件的时间」，把「会话在忙但事件
// 暂时没落地」当成停滞。
//   · 2026-11-01：提问挂起等用户答（零事件）→ 误报「主任务卡住了」（由 taskWaiting 兜住）。
//   · 2026-11-02：压缩上下文 / 等模型回包（零事件）→ 25 分钟里误报 18 次，最长 96.7 秒，
//     全部落在 compaction/start → compaction/end 之间（实测会话，工具调用最长只有 7.5 秒）。
// 所以「还在动」要看三类信号，并且只在这里定义一次（notify 的卡住判定与 animation 的
// 卡住姿态都走这里，别各处各写一份）：
//   1) 最近活动时间 = max(lastActivityAt, lastMotionAt, phaseAt)：流式输出（assistant/chunk）
//      只刷 lastMotionAt，漏掉它就会把正在刷字的会话当停滞；
//   2) 有在飞的工具调用（pendingTool）：长命令（构建 / 全量测试）期间没有事件，但确实在跑；
//   3) 正在压缩上下文（compacting）：compaction 全程同样零事件。
// 后两类给一个上限（TASK_BUSY_MS）：真挂死（工具永不返回 / 压缩永不结束）仍要能报出来，
// 不能因为「有在飞的调用」就永远不报。
/** 卡住阈值：编程阶段多久没动静算停滞（宿主可用 stuckMs 覆盖）。 */
export const TASK_STALL_MS = 18000;
/** 「在飞」信号的有效上限：超过这个时长仍无任何事件，就按真停滞处理。 */
export const TASK_BUSY_MS = 180000;

function numOf(v) {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 任务最近一次「有动静」的时间：取活动时间、流式动作时间、阶段切换时间三者最大值。 */
export function taskActivityAt(task) {
	if (!task) return 0;
	return Math.max(numOf(task.lastActivityAt), numOf(task.lastMotionAt), numOf(task.phaseAt));
}

/** 任务是否「正在忙」（有在飞的工具调用 / 正在压缩上下文），与耗时无关的那部分信号。 */
export function taskBusy(task, now, capMs) {
	if (!task) return false;
	// PTC（Programmatic Tool Calling / run_code）程序执行期间整体算「在忙」：一次程序会串起若干
	// 子调用（wait_agent 等子代理 / job_output 等后台任务 / bash 长命令 / ask_user_question 等人），
	// 这些子调用可阻塞数分钟且期间零事件，属于在干活/等人，不能按停滞处理。子调用各有自身超时
	// （程序不会无限静默），因此这里不设上限（与「主任务在等子任务」同一口径）。
	if (task.ptcProgram === true) return true;
	const at = typeof now === "number" ? now : Date.now();
	const cap = typeof capMs === "number" && capMs > 0 ? capMs : TASK_BUSY_MS;
	if (task.compacting === true) {
		const since = numOf(task.compactStartedAt);
		if (!since || at - since < cap) return true;
	}
	if (typeof task.pendingTool === "string" && task.pendingTool) {
		const since = numOf(task.toolStartedAt);
		if (!since || at - since < cap) return true;
	}
	return false;
}

/**
 * 卡住判定：返回已停滞时长（毫秒），不算卡住时返回 0。
 * 等人介入、有在飞调用、正在压缩上下文一律返回 0（那都不是卡住）。
 */
export function taskStalled(task, now, thresholdMs) {
	if (!task || taskWaiting(task) || taskBusy(task, now)) return 0;
	const at = typeof now === "number" ? now : Date.now();
	const limit = typeof thresholdMs === "number" && thresholdMs > 0 ? thresholdMs : TASK_STALL_MS;
	const lastAct = taskActivityAt(task);
	if (!lastAct) return 0;
	const stalled = at - lastAct;
	return stalled >= limit ? stalled : 0;
}

