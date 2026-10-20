// dsh-dock · 功能模块【任务通知】· 客户端视图
//
// 三部分：
//  1. View      —— 功能坞面板页：通知事件 / 呈现方式 / 钉钉推送 / 飞书推送 四组设置；
//  2. HomeStat  —— 首页总揽概要（当前通知事件与推送通道）；
//  3. Overlay   —— 全局浮层（shell.overlay 常驻，功能启用即挂载）：轮询 Host 状态，
//                  任务结束弹通知卡片（可选提示音与浏览器系统通知），工具等待确认时弹常驻提醒卡。
//                  结束卡常驻到「看过」（点卡直达会话 / 点进会话 / 手动 ✕），≥3 张叠放收纳。
//
// 与【任务动画】【运行状态】完全独立：动效在 features/animation/、任务状态一览在
// features/runstate/，本模块只管通知（页内卡片 / 提示音 / 系统通知 / 钉钉飞书群机器人推送）。
// 模块启停 = 功能坞里的开关（独立菜单项），本页不再有第二个总开关。
//
// Host 通信：fetch('dsh-dock/notify/<method>')（见 features/notify/host.js）。
import { useState, useEffect, useRef, useCallback } from "react";

// ---------- Host RPC 桥接 ----------
function rpcCall(method, args) {
	return fetch("dsh-dock/notify/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args === undefined ? {} : args),
	})
		.then(async (res) => {
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.ok === true) return data.data;
			// 宿主侧没有通知路由（405/404）：两种可能——宿主进程是旧版本，或本功能在宿主侧
			// 还没 setup（开关没同步过去）。给可操作提示，而不是裸状态码。
			if (res.status === 405 || res.status === 404) {
				throw new Error("宿主侧没有「任务通知」接口：宿主进程可能是旧版本，或该功能在宿主侧未启用（重启 dsh web，或把功能坞里的开关关掉再打开）");
			}
			if (data && data.ok === false) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
			throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""));
		});
}

// ---------- 结束原因 / 阶段 ----------
const END_LABELS = {
	completed: { label: "完成", cls: "ok" },
	error: { label: "出错", cls: "err" },
	aborted: { label: "已中止", cls: "warn" },
	blocked: { label: "受阻", cls: "warn" },
	"max-tokens": { label: "达输出上限", cls: "warn" },
	interrupted: { label: "中断", cls: "warn" },
};
function endInfo(reason) {
	return END_LABELS[reason] || END_LABELS.completed;
}
function isSuccessReason(reason) {
	return !reason || reason === "completed";
}

// 工具名 → 中文场景（"需确认"通知里说清楚是什么在等确认）
function toolLabel(name) {
	const n = String(name || "").toLowerCase();
	if (/bash|shell|terminal|cmd|pwsh|powershell|exec/.test(n)) return "执行命令";
	if (/write|edit|patch|apply|create|mkdir|remove|delete/.test(n)) return "修改文件";
	if (/web|fetch|browser|navigate|search/.test(n)) return "访问网页";
	return "";
}

// ---------- 格式化 ----------
function fmtNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }
// 毫秒 → "3分21秒" / "1小时2分"
function fmtDur(ms) {
	const s = Math.max(0, Math.round((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	if (h > 0) return h + "小时" + m + "分" + sec + "秒";
	if (m > 0) return m + "分" + sec + "秒";
	return sec + "秒";
}
function fmtTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	const p = (x) => String(x).padStart(2, "0");
	return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function truncate(str, max) {
	if (!str) return "";
	return String(str).length > max ? String(str).slice(0, max) + "…" : str;
}

// ---------- 提示音（WebAudio 合成；macOS/Windows 通用，无音频文件） ----------
// 音效库：每种含完成音（done）、异常音（err）与确认音（ask）三套音符序列。
// 音符 [频率, 起始秒, 时长秒, 波形?]，波形缺省 sine。确认音双音上扬、偏长，
// 听感是"来人搭话"，和完成音的收束感、异常音的下坠感区分开。
const SOUND_LIBRARY = {
	chime:  { name: "清脆双音", notes: { done: [[659.25, 0, .14], [880, .13, .24]], err: [[220, 0, .16], [164.81, .15, .3]], ask: [[587.33, 0, .16], [880, .19, .34]] } },
	ding:   { name: "叮",       notes: { done: [[987.77, 0, .35]], err: [[246.94, 0, .4]], ask: [[783.99, 0, .18], [1174.66, .2, .42]] } },
	coin:   { name: "金币",     notes: { done: [[988, 0, .08], [1319, .08, .35], [988, 0, .08, "square"], [1319, .08, .3, "square"]], err: [[196, 0, .12], [147, .11, .35]], ask: [[880, 0, .09], [1108.73, .1, .12], [1318.51, .22, .3]] } },
	bell:   { name: "钟声",     notes: { done: [[523.25, 0, .5], [659.25, .02, .45], [783.99, .04, .4]], err: [[174.61, 0, .5], [130.81, .05, .5]], ask: [[659.25, 0, .4], [523.25, .05, .55]] } },
	pulse:  { name: "脉冲",     notes: { done: [[440, 0, .09], [440, .14, .09], [440, .28, .16]], err: [[174.61, 0, .1], [174.61, .14, .1], [174.61, .28, .18]], ask: [[523.25, 0, .09], [523.25, .15, .09], [659.25, .3, .22]] } },
	arp:    { name: "琶音",     notes: { done: [[523.25, 0, .12], [659.25, .09, .12], [783.99, .18, .12], [1046.5, .27, .3]], err: [[392, 0, .12], [329.63, .1, .12], [261.63, .2, .12], [196, .3, .32]], ask: [[440, 0, .11], [554.37, .12, .11], [659.25, .24, .11], [880, .36, .34]] } },
};
// AudioContext 按需创建（浏览器自动播放策略：首次用户交互后才能出声，静默失败不报错）
let soundCtx = null;
function playTone(seq) {
	try {
		if (typeof window === "undefined" || !window.AudioContext && !window.webkitAudioContext) return;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!soundCtx) soundCtx = new AC();
		if (soundCtx.state === "suspended") { soundCtx.resume().catch(() => {}); }
		const t0 = soundCtx.currentTime;
		for (const [f, at, dur, wave] of seq) {
			const osc = soundCtx.createOscillator();
			const gain = soundCtx.createGain();
			osc.type = wave || "sine";
			osc.frequency.value = f;
			gain.gain.setValueAtTime(0, t0 + at);
			gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
			osc.connect(gain).connect(soundCtx.destination);
			osc.start(t0 + at);
			osc.stop(t0 + at + dur + 0.05);
		}
	} catch { /* 音频不可用静默 */ }
}
// 按音效播放：完成音 / 异常音 / 确认音（未知音效回退 chime）
function playDoneSound(success, effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(success ? lib.notes.done : lib.notes.err);
}
function playAskSound(effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(lib.notes.ask || lib.notes.done);
}
// 试听：完成音 + 异常音 连播（间隔 0.55s）
function previewSound(effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(lib.notes.done);
	const delayed = lib.notes.err.map(([f, at, dur, wave]) => [f, at + 0.55, dur, wave]);
	playTone(delayed);
}

// ---------- 共享快照：浮层（轮询） / 面板页 / 首页概要共用一份数据 ----------
const notifyStore = {
	snap: { status: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	emit() { for (const fn of this.listeners) fn(); },
	applyConfig(cfg) {
		if (this.snap.status) {
			this.snap = Object.assign({}, this.snap, { status: Object.assign({}, this.snap.status, { config: cfg }) });
			this.emit();
		}
	},
	refresh() {
		if (this.snap.loading) return Promise.resolve();
		this.snap = Object.assign({}, this.snap, { loading: true });
		this.emit();
		return rpcCall("status")
			.then((data) => {
				this.snap = { status: data, loading: false, error: null };
				this.emit();
			})
			.catch((e) => {
				this.snap = Object.assign({}, this.snap, { loading: false, error: (e && e.message) || String(e) });
				this.emit();
			});
	},
};
function useNotify() {
	const [snap, setSnap] = useState(notifyStore.snap);
	useEffect(() => notifyStore.subscribe(() => setSnap(notifyStore.snap)), []);
	return snap;
}

// ---------- 通知卡片 ----------
// 需确认卡片的"看过"计时：页面在前台被看到这么久就自动收起。
// 提醒的意义是"把人叫回来"，人已经在页面上看见它就算送达；一直堆着得一个个点 ✕ 反而是骚扰。
// 页面在后台时不倒计时（回来后才开始算），鼠标停在卡片上也算"正在看"，暂停计时。
const CONFIRM_LINGER_MS = 8000;
function pageVisible() {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

// 当前正在看的会话标题（侧栏高亮行）。与【任务动画】的 currentSessionTitle 同款判定：
// dsh 会话树行 = role="treeitem" + aria-selected，行文本即标题；侧栏在左，
// 跳过正文区可能出现的同名高亮节点（右上搜索结果等）。
function currentSelectedSessionTitle() {
	if (typeof document === "undefined" || typeof window === "undefined") return "";
	if (typeof document.querySelectorAll !== "function") return "";
	for (const el of document.querySelectorAll('[role="treeitem"][aria-selected="true"]')) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0 && r.right <= window.innerWidth * .35) {
			const text = (el.textContent || "").trim();
			if (text) return text;
		}
	}
	return "";
}
// 标题模糊对齐（与任务动画 taskOnScreen 同规则）：相等或互为子串即算同一会话
function titleMatches(a, b) {
	return !!a && !!b && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}

// 点卡片跳转会话：在侧栏会话树里找标题对上的一行，点它（优先行内的 a/button）。
// 判定与 currentSelectedSessionTitle 同口径（左缘 35vw 内、可见）；找不到可见行
// （抽屉收起 / 手机端 / 会话被删）返回 false，调用方保持卡片不收起。
function openSessionByTitle(title) {
	if (typeof document === "undefined" || typeof window === "undefined") return false;
	if (typeof document.querySelectorAll !== "function" || !title) return false;
	for (const el of document.querySelectorAll('[role="treeitem"]')) {
		const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
		if (!r || r.width <= 0 || r.height <= 0 || r.right > window.innerWidth * .35) continue;
		if (!titleMatches((el.textContent || "").trim(), title)) continue;
		const link = typeof el.querySelector === "function" ? el.querySelector("a,button") : null;
		const target = link || el;
		if (typeof target.click === "function") { target.click(); return true; }
		return false;
	}
	return false;
}

function Toast(props) {
	const t = props.t;
	const [closing, setClosing] = useState(!!t.closing);
	const close = useCallback(() => { setClosing(true); }, []);
	const hoveringRef = useRef(false);
	// 点卡片 = 跳转到对应会话。结束卡跳成功就地收起（这一看就把通知的活干完了）；
	// 需确认卡只跳转不收——审批没处理完它就该在。找不到可见会话行（抽屉收起/
	// 手机端/会话已删）不收起，卡片原样保留。
	const jump = useCallback(() => {
		if (!t.sessionTitle) return;
		if (openSessionByTitle(t.sessionTitle) && t.kind !== "confirm") setClosing(true);
	}, [t.sessionTitle, t.kind]);
	// 外部要求收起（审批已处理 / 已点进会话）走同一套淡出动画
	useEffect(() => { if (t.closing && !closing) setClosing(true); }, [t.closing, closing]);
	// 结束卡没有任何自动消失：没点开看过就一直挂着（后台弹的同样挂着），
	// 多了靠叠放收纳（.stacked 样式），不靠丢。
	// 需确认卡保留「看过计时」（lingerMs，前台可见 + 没悬停才走）：审批处理完
	// 会由对账收起，人在前台看过 8 秒也收——只有它维持"看过即消失"。
	const lingerRef = useRef(null);
	useEffect(() => {
		if (!t.lingerMs) return;
		let timer = null;
		const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
		const start = () => {
			if (timer || hoveringRef.current || !pageVisible()) return;
			timer = setTimeout(close, t.lingerMs);
		};
		const resume = () => { stop(); start(); };
		const onVisibility = () => { if (pageVisible()) start(); else stop(); };
		lingerRef.current = { stop, resume };
		start();
		if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
		return () => {
			stop();
			lingerRef.current = null;
			if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
		};
	}, []);
	useEffect(() => {
		if (!closing) return;
		const timer = setTimeout(() => props.onClose(t.id), 240);
		return () => clearTimeout(timer);
	}, [closing]);
	const markColor = t.kind === "success"
		? "var(--dk-ok)"
		: t.kind === "error"
			? "var(--dk-err)"
			: "var(--dk-warn)";
	// 叠放收起态（collapsed）：只留标题条，正文隐藏；悬停卡片栈时整体展开
	return (
		<div className={"dknt-toast" + (t.kind === "confirm" ? " dknt-toast-confirm" : "")
				+ (t.sessionTitle ? " clickable" : "")
				+ (props.collapsed ? " collapsed" : "")
				+ (closing ? " out" : "")}
			onClick={t.sessionTitle ? jump : undefined}
			onMouseEnter={() => { hoveringRef.current = true; const l = lingerRef.current; if (l) l.stop(); }}
			onMouseLeave={() => { hoveringRef.current = false; const l = lingerRef.current; if (l) l.resume(); }}>
			<div className="dknt-toast-head">
				<span className="dknt-toast-mark" style={{ background: markColor }} />
				<span className="dknt-toast-title" title={t.sessionTitle || t.title}>
					{t.kind === "confirm" ? "✋ " : ""}{props.collapsed ? (t.sessionTitle || t.title) : t.title}
					{!props.collapsed && t.sessionTitle && t.kind !== "confirm" ? " · " + t.sessionTitle : ""}
				</span>
				<button type="button" className="dknt-toast-close" aria-label="关闭"
					onClick={(e) => { if (e && e.stopPropagation) e.stopPropagation(); close(); }}>✕</button>
			</div>
			{!props.collapsed && t.body ? <div className="dknt-toast-body">{t.body}</div> : null}
		</div>
	);
}

// ---------- 全局浮层：轮询 + 通知（功能启用即常驻） ----------
export function NotifyOverlay(props) {
	const snap = useNotify();
	const [toasts, setToasts] = useState([]);
	const [stackHover, setStackHover] = useState(false); // 卡片栈被悬停（叠放时整体展开）
	const prevActiveRef = useRef(null);
	const remindedApprovalsRef = useRef(new Map()); // sessionId -> 提醒过的 approvalId 集合
	const toastSeqRef = useRef(0);

	const pushToast = useCallback((toast) => {
		// 上限 12：结束卡现在常驻到看过才收，4 张容易见底；多了靠叠放收纳而不是丢弃。
		setToasts((prev) => prev.concat([toast]).slice(-12));
	}, []);

	// 轮询：任务中 850ms，实时捕捉结束/待确认；空闲 6s / 出错 15s；页面切回立即刷新。
	useEffect(() => {
		let stopped = false;
		let timer = null;
		const loop = async () => {
			await notifyStore.refresh();
			if (stopped) return;
			const s = notifyStore.snap;
			timer = setTimeout(loop, s.error ? 15000 : (s.status && s.status.active && s.status.active.length > 0 ? 850 : 6000));
		};
		loop();
		const onVisible = () => {
			if (!stopped && typeof document !== "undefined" && document.visibilityState === "visible") notifyStore.refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, []);

	// 任务结束检测：上一轮活跃、本轮消失 → 通知 + 提示音 + 系统通知（找最近完成记录补全信息）
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const prev = prevActiveRef.current;
		if (prev) {
			const currIds = new Set(st.active.map((x) => x.sessionId));
			for (const task of prev) {
				if (currIds.has(task.sessionId)) continue;
				const record = (st.recent || []).find((r) => r.sessionId === task.sessionId) || null;
				handleTaskEnd(task, record, st.config || {});
			}
		}
		prevActiveRef.current = st.active.slice();
	}, [snap.status]);

	// ===== 需确认检测：工具等待用户批准时通知（页内卡片 + 确认音 + 后台系统通知） =====
	// host 从会话流 approval/asked 收集待确认项，approval/decided 后移除；
	// 这里对"任务首次出现待确认"触发一次提醒，已提醒过的会话不再重复打扰。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const cfg = st.config || {};
		const activeIds = new Set(st.active.map((x) => x.sessionId));
		for (const [sid, seen] of remindedApprovalsRef.current) {
			if (!activeIds.has(sid)) remindedApprovalsRef.current.delete(sid);
		}
		for (const task of st.active) {
			const approvals = Array.isArray(task.approvals) ? task.approvals : [];
			if (approvals.length === 0) continue;
			let seen = remindedApprovalsRef.current.get(task.sessionId);
			if (!seen) { seen = new Set(); remindedApprovalsRef.current.set(task.sessionId, seen); }
			const fresh = approvals.filter((a) => a && !seen.has(a.id));
			if (fresh.length === 0) continue;
			for (const a of fresh) seen.add(a.id);
			// 提醒开关在"收到新确认项"时检查，保证开关中途打开对下一项生效
			if (cfg.notifyOnConfirm === false) continue;
			const toolName = fresh[0].toolName || "";
			const scene = toolLabel(toolName);
			const lines = [
				"任务：" + (task.title || "(无标题)"),
				"工具：" + (toolName || "未知") + (scene ? "（" + scene + "）" : ""),
			];
			if (fresh[0].reason) lines.push("说明：" + truncate(fresh[0].reason, 140));
			lines.push(fresh.length > 1 ? "共 " + fresh.length + " 项等待你的确认" : "请在会话里确认后继续");
			pushToast({
				id: ++toastSeqRef.current,
				kind: "confirm",
				title: "任务需要确认",
				body: lines.join("\n"),
				// 点卡片直达该会话去处理审批（需确认卡跳转后不收起——审批没处理完它就该在）
				sessionTitle: task.title || "",
				// 卡片与这批审批项绑定：approval/decided 后宿主把它们移出 approvals，
				// 下面的对账 effect 据此自动收起卡片（处理完就不该再占着右上角）。
				approvalKeys: fresh.filter((a) => a && a.id).map((a) => task.sessionId + "|" + a.id),
				// 在前台看见它超过 8 秒就自动收起，不用手动点 ✕
				lingerMs: CONFIRM_LINGER_MS,
			});
			if (cfg.soundNotify !== false) playAskSound(cfg.soundEffect);
			if (cfg.systemNotify && typeof document !== "undefined" && document.hidden
				&& typeof Notification !== "undefined" && Notification.permission === "granted") {
				try {
					new Notification("dsh 任务需要确认", {
						body: (task.title || "(无标题)") + " · " + (toolName || "工具") + " 等待确认",
						tag: "dsh-dock-approval-" + task.sessionId,
					});
				} catch { /* 系统通知失败不影响页面内通知 */ }
			}
		}
	}, [snap.status]);

	// 审批项消失（approval/decided 后宿主把它移出 approvals）→ 对应需确认卡自动收起。
	// 只标记 closing 走淡出，不直接删：与手动点 ✕ 的退场一致。
	// 卡片绑定的 approvalKeys 全部不在仍待确认的集合里才收；空 keys（老数据）不动。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const live = new Set();
		for (const task of st.active) {
			const approvals = Array.isArray(task.approvals) ? task.approvals : [];
			for (const a of approvals) if (a && a.id) live.add(task.sessionId + "|" + a.id);
		}
		setToasts((prev) => {
			let changed = false;
			const next = prev.map((x) => {
				if (x.kind !== "confirm" || x.closing) return x;
				const keys = Array.isArray(x.approvalKeys) ? x.approvalKeys : [];
				if (keys.length === 0 || keys.some((k) => live.has(k))) return x;
				changed = true;
				return Object.assign({}, x, { closing: true });
			});
			return changed ? next : prev;
		});
	}, [snap.status]);

	// 结束卡（完成/异常）的"看过即收"：用户点进那个会话（侧栏高亮行标题与卡片
	// 绑定的 sessionTitle 对上）就视为已看到结果，卡片自动收起。结束卡没有超时
	// 自毁——没看过就一直挂着；这条巡检是它唯一的自动出口（另有手动 ✕ 与点卡跳转）。
	// 侧栏选中没有事件可订阅，用轻量轮询（500ms 一次 querySelectorAll）；页面在
	// 后台不检查（回来时若仍停在该会话，收起发生在切回后）。
	useEffect(() => {
		const timer = setInterval(() => {
			if (!pageVisible()) return;
			const current = currentSelectedSessionTitle();
			if (!current) return;
			setToasts((prev) => {
				let changed = false;
				const next = prev.map((x) => {
					if (x.kind === "confirm" || x.closing || !x.sessionTitle) return x;
					if (!titleMatches(x.sessionTitle, current)) return x;
					changed = true;
					return Object.assign({}, x, { closing: true });
				});
				return changed ? next : prev;
			});
		}, 500);
		return () => clearInterval(timer);
	}, []);

	const handleTaskEnd = (task, record, cfg) => {
		const reason = (record && record.endReason) || "";
		const success = isSuccessReason(reason);
		const info = endInfo(reason);
		const wanted = success ? cfg.notifyOnComplete : cfg.notifyOnError;
		if (wanted === false) return;
		const models = record && record.models && record.models.length ? record.models.join(", ")
			: (task.models && task.models.length ? task.models.join(", ") : "未知模型");
		const provider = (record && record.provider) || task.provider || "";
		const startTs = (record && record.startTime) || task.startTime;
		const endTs = (record && record.endTime) || Date.now();
		const lines = [
			"任务：" + ((record && record.title) || task.title || "(无标题)"),
			"模型：" + models + (provider ? "（" + provider + "）" : ""),
			"耗时：" + fmtDur((record && record.duration) || (endTs - startTs))
				+ "（" + fmtTime(startTs) + " → " + fmtTime(endTs) + "）",
			"回合 " + ((record && record.turns) || task.turns || 0)
				+ " · 步骤 " + ((record && record.steps) || task.steps || 0)
				+ (((record && record.toolCalls) || task.toolCalls) ? " · 工具 " + ((record && record.toolCalls) || task.toolCalls) + " 次" : ""),
			"Token：输入 " + fmtNum((record && record.inputTokens) || task.inputTokens)
				+ " / 输出 " + fmtNum((record && record.outputTokens) || task.outputTokens),
		];
		if (record && record.lastText) lines.push("摘要：" + truncate(record.lastText, 140));
		if (!success && record && record.errorMessage) lines.push("错误：" + truncate(record.errorMessage, 120));
		const title = success ? "任务完成" : "任务" + info.label;
		pushToast({
			id: ++toastSeqRef.current,
			kind: success ? "success" : (info.cls === "err" ? "error" : "warn"),
			title,
			body: lines.join("\n"),
			// 绑定会话标题：点卡片直达该会话；用户点进这个会话（侧栏选中）也视为
			// 看到了结果，巡检 effect 据此自动收起卡片。没看过就一直挂着。
			sessionTitle: (record && record.title) || task.title || "",
		});
		// 提示音：任务结束时播放（完成/异常配套音）；与系统通知独立开关
		if (cfg.soundNotify !== false) playDoneSound(success, cfg.soundEffect);
		// 系统通知：仅页面处于后台时推送，避免前台重复打扰
		if (cfg.systemNotify && typeof document !== "undefined" && document.hidden
			&& typeof Notification !== "undefined" && Notification.permission === "granted") {
			try {
				new Notification("dsh " + title, {
					body: ((record && record.title) || task.title || "(无标题)") + " · " + fmtDur((record && record.duration) || (endTs - startTs)),
					tag: "dsh-dock-notify-" + task.sessionId,
				});
			} catch { /* 系统通知失败不影响页面内通知 */ }
		}
	};

	// Host 不可用（旧宿主未重启等）：浮层整体静默，面板页会给提示
	if (!snap.status) return null;
	if (toasts.length === 0) return null;
	// 卡片多了叠放收纳：≥3 张时只完整展开最新一张，其余收成"只剩标题条"；
	// 鼠标移到卡片栈上整体展开，移开收回。跳转/收起对每张卡照常可用。
	const stack = toasts.length >= 3 && !stackHover;
	return (
		<div className={"dknt-toasts" + (stack ? " stacked" : "")}
			onMouseEnter={() => setStackHover(true)}
			onMouseLeave={() => setStackHover(false)}>
			{toasts.map((t, i) => (
				<Toast key={t.id} t={t} collapsed={stack && i < toasts.length - 1}
					onClose={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))} />
			))}
		</div>
	);
}

// ---------- 面板页 ----------
function NotifyView(props) {
	const snap = useNotify();
	const [cfg, setCfg] = useState(null); // null = 尚未加载
	const [saveErr, setSaveErr] = useState("");
	const [testing, setTesting] = useState(false);
	const [testState, setTestState] = useState(null); // { ok, msg } 钉钉测试结果
	const [feishuTesting, setFeishuTesting] = useState(false);
	const [feishuTestState, setFeishuTestState] = useState(null); // { ok, msg } 飞书测试结果
	const cfgRef = useRef(null);
	const pendingSavesRef = useRef(0); // 进行中的保存（轮询回包不覆盖乐观值）
	const editingWebhookRef = useRef(false); // 钉钉 Webhook 输入中（轮询不覆盖草稿）
	const editingFeishuRef = useRef(false); // 飞书 Webhook 输入中（轮询不覆盖草稿）
	// 拉到新配置（含保存回包）后同步本地编辑态；保存中/输入中不覆盖
	useEffect(() => {
		const c = snap.status && snap.status.config;
		if (!c) return;
		if (pendingSavesRef.current > 0 || editingWebhookRef.current || editingFeishuRef.current) return;
		if (c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	}, [snap.status]);
	// 面板打开时兜底拉一次（浮层通常已在轮询）
	useEffect(() => {
		if (!notifyStore.snap.status) notifyStore.refresh();
	}, []);
	// 乐观更新 + 立即持久化（每个开关独立保存）
	const patch = (p) => {
		setSaveErr("");
		setCfg(Object.assign({}, cfg, p));
		pendingSavesRef.current++;
		return rpcCall("config", p)
			.then((d) => {
				pendingSavesRef.current--;
				notifyStore.applyConfig(d && d.config);
			})
			.catch((e) => {
				pendingSavesRef.current--;
				setSaveErr("保存失败：" + ((e && e.message) || String(e)));
			});
	};
	// Webhook 草稿保存：清编辑态后立即对齐一次（同步 effect 在编辑期被跳过）
	const saveWebhook = async () => {
		if (!editingWebhookRef.current) return;
		const hook = String(cfg.dingtalkWebhook || "").trim();
		await patch({ dingtalkWebhook: hook });
		editingWebhookRef.current = false;
		const c = notifyStore.snap.status && notifyStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	};
	const saveFeishuWebhook = async () => {
		if (!editingFeishuRef.current) return;
		const hook = String(cfg.feishuWebhook || "").trim();
		await patch({ feishuWebhook: hook });
		editingFeishuRef.current = false;
		const c = notifyStore.snap.status && notifyStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	};
	// 钉钉测试：草稿未保存先保存，再发测试消息
	const runDingtalkTest = async () => {
		setTesting(true);
		setTestState(null);
		try {
			if (editingWebhookRef.current) {
				const hook = String(cfg.dingtalkWebhook || "").trim();
				if (!hook) throw new Error("请先填写 Webhook 地址");
				const d = await rpcCall("config", { dingtalkWebhook: hook });
				notifyStore.applyConfig(d && d.config);
				editingWebhookRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setCfg(Object.assign({}, cfg, { dingtalkWebhook: hook }));
			}
			const r = await rpcCall("test");
			setTestState(r && r.sent
				? { ok: true, msg: "测试消息已发送，去群里看看" }
				: { ok: false, msg: (r && r.error) || "发送失败" });
		} catch (e) {
			setTestState({ ok: false, msg: (e && e.message) || String(e) });
		} finally {
			setTesting(false);
		}
	};
	// 飞书测试：草稿未保存先保存，再发测试消息
	const runFeishuTest = async () => {
		setFeishuTesting(true);
		setFeishuTestState(null);
		try {
			if (editingFeishuRef.current) {
				const hook = String(cfg.feishuWebhook || "").trim();
				if (!hook) throw new Error("请先填写 Webhook 地址");
				const d = await rpcCall("config", { feishuWebhook: hook });
				notifyStore.applyConfig(d && d.config);
				editingFeishuRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setCfg(Object.assign({}, cfg, { feishuWebhook: hook }));
			}
			const r = await rpcCall("test", { target: "feishu" });
			setFeishuTestState(r && r.sent
				? { ok: true, msg: "测试消息已发送，去群里看看" }
				: { ok: false, msg: (r && r.error) || "发送失败" });
		} catch (e) {
			setFeishuTestState({ ok: false, msg: (e && e.message) || String(e) });
		} finally {
			setFeishuTesting(false);
		}
	};
	const enableSystemNotify = async (next) => {
		if (next && typeof Notification !== "undefined" && Notification.permission !== "granted") {
			try {
				const perm = await Notification.requestPermission(); // 开关点击即用户手势
				if (perm !== "granted") {
					setSaveErr("浏览器未授权系统通知（可在地址栏权限设置里重新允许）");
					return;
				}
			} catch {
				setSaveErr("浏览器不支持系统通知");
				return;
			}
		}
		patch({ systemNotify: next });
	};

	const permNote = typeof Notification === "undefined"
		? "当前浏览器不支持系统通知"
		: Notification.permission === "granted" ? "已授权 · 仅页面后台时推送"
			: Notification.permission === "denied" ? "已被浏览器拒绝（需在浏览器权限设置里重新允许）" : "未授权 · 开启时会请求授权，仅页面后台时推送";

	const rows = [];
	if (!cfg) {
		rows.push(<div key="load" className="dknt-note">{snap.error ? "状态不可用：" + snap.error : (snap.loading ? "正在拉取通知状态…" : "等待通知状态")}</div>);
	} else {
		rows.push(
			<div key="events" className="dknt-sec">
				<div className="dknt-sec-head">
					<span className="dknt-sec-title">通知事件</span>
					<span className="dknt-sec-sub">哪些时刻提醒你；与【任务动画】的动效互不依赖</span>
				</div>
				<div className="dknt-rows-narrow">
					<div className="dknt-row">
						<span className="dknt-row-label">完成通知</span>
						<button type="button" className={"dknt-miniswitch" + (cfg.notifyOnComplete ? " on" : "")}
							onClick={() => patch({ notifyOnComplete: !cfg.notifyOnComplete })}>
							{cfg.notifyOnComplete ? "开" : "关"}
						</button>
						<span className="dknt-row-sub">任务正常完成时通知</span>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">异常通知</span>
						<button type="button" className={"dknt-miniswitch" + (cfg.notifyOnError ? " on" : "")}
							onClick={() => patch({ notifyOnError: !cfg.notifyOnError })}>
							{cfg.notifyOnError ? "开" : "关"}
						</button>
						<span className="dknt-row-sub">出错 / 中止 / 达输出上限时通知</span>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">需确认提醒</span>
						<button type="button" className={"dknt-miniswitch" + (cfg.notifyOnConfirm !== false ? " on" : "")}
							onClick={() => patch({ notifyOnConfirm: cfg.notifyOnConfirm === false })}>
							{cfg.notifyOnConfirm !== false ? "开" : "关"}
						</button>
						<span className="dknt-row-sub">工具等待你批准时弹卡片并响确认音（处理完自动收起；在前台看到 8 秒后也自动收起）</span>
					</div>
				</div>
			</div>,
			<div key="style" className="dknt-sec">
				<div className="dknt-sec-head">
					<span className="dknt-sec-title">提醒方式</span>
					<span className="dknt-sec-sub">页内卡片、提示音、浏览器系统通知可自由组合</span>
				</div>
				<div className="dknt-rows-narrow">
					<div className="dknt-row">
						<span className="dknt-row-label">卡片收纳</span>
						<span className="dknt-row-sub">结束卡片不再超时自动消失：没看过就一直挂着（后台跑完的切回来也在）；点卡片直达对应会话，或点进该会话，卡片自动收起。超过 2 张自动叠放成标题条，鼠标移上去整体展开。需确认卡片不走这套（处理完/前台看到 8 秒即收，见上）</span>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">系统通知</span>
						<button type="button" className={"dknt-miniswitch" + (cfg.systemNotify ? " on" : "")}
							onClick={() => enableSystemNotify(!cfg.systemNotify)}>
							{cfg.systemNotify ? "开" : "关"}
						</button>
						<span className="dknt-row-sub">{permNote}</span>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">提示音</span>
						<button type="button" className={"dknt-miniswitch" + (cfg.soundNotify !== false ? " on" : "")}
							onClick={() => patch({ soundNotify: cfg.soundNotify === false })}>
							{cfg.soundNotify !== false ? "开" : "关"}
						</button>
						<span className="dknt-row-sub">任务结束/需确认时播放（试听为先播完成音、后播异常音）</span>
					</div>
					{cfg.soundNotify !== false ? (
						<div className="dknt-sounds">
							{Object.keys(SOUND_LIBRARY).map((key) => (
								<button type="button" key={key}
									className={"dknt-sound" + (cfg.soundEffect === key ? " on" : "")}
									onClick={() => patch({ soundEffect: key })}>
									<span className="dknt-sound-name">
										{SOUND_LIBRARY[key].name}
										{cfg.soundEffect === key ? <span className="dknt-sound-cur">✓</span> : null}
									</span>
									<span className="dknt-sound-play" role="button" tabIndex={0}
										title={"试听 " + SOUND_LIBRARY[key].name}
										onClick={(e) => { e.stopPropagation(); previewSound(key); }}
										onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); previewSound(key); } }}>▶</span>
								</button>
							))}
						</div>
					) : null}
				</div>
			</div>,
			<div key="dingtalk" className="dknt-sec">
				<div className="dknt-sec-head">
					<span className="dknt-sec-title">钉钉推送</span>
					<span className="dknt-sec-sub">任务结束推送到钉钉群机器人（宿主直发，浏览器关着也能推；事件跟随上方完成/异常开关）</span>
					<span className="dknt-sec-sw">
						<span className={"dknt-sec-swlabel" + (cfg.dingtalkEnabled ? " on" : "")}>{cfg.dingtalkEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.dingtalkEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.dingtalkEnabled} aria-label="开关钉钉推送"
							title={cfg.dingtalkEnabled ? "关闭钉钉推送" : "开启钉钉推送"}
							onClick={() => patch({ dingtalkEnabled: !cfg.dingtalkEnabled })} />
					</span>
				</div>
				{cfg.dingtalkEnabled ? <div className="dknt-rows-narrow">
					<div className="dknt-row dknt-row-webhook">
						<span className="dknt-row-label">Webhook</span>
						<input type="text" className="dknt-input" spellCheck={false}
							value={cfg.dingtalkWebhook || ""}
							placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
							onChange={(e) => {
								editingWebhookRef.current = true;
								setCfg(Object.assign({}, cfg, { dingtalkWebhook: e.target.value }));
							}} />
						<button type="button" className="dknt-btn" disabled={!editingWebhookRef.current}
							onClick={saveWebhook}>
							{editingWebhookRef.current ? "保存" : "已保存"}
						</button>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">连通测试</span>
						<button type="button" className="dknt-btn" disabled={testing} onClick={runDingtalkTest}>
							{testing ? "发送中…" : "发送测试消息"}
						</button>
						{testState ? <span className={"dknt-row-sub" + (testState.ok ? " dknt-ok" : " dknt-err")}>
							{testState.ok ? "✓ " : "✗ "}{testState.msg}
						</span> : <span className="dknt-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
					</div>
					<div className="dknt-note">机器人创建：钉钉群 → 设置 → 智能群助手 → 添加机器人 → 自定义（Webhook），
						安全设置选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
				</div> : <div className="dknt-note">未开启——任务结束不推送钉钉。</div>}
			</div>,
			<div key="feishu" className="dknt-sec">
				<div className="dknt-sec-head">
					<span className="dknt-sec-title">飞书推送</span>
					<span className="dknt-sec-sub">任务结束推送到飞书群机器人（宿主直发，浏览器关着也能推；事件跟随上方完成/异常开关）</span>
					<span className="dknt-sec-sw">
						<span className={"dknt-sec-swlabel" + (cfg.feishuEnabled ? " on" : "")}>{cfg.feishuEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.feishuEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.feishuEnabled} aria-label="开关飞书推送"
							title={cfg.feishuEnabled ? "关闭飞书推送" : "开启飞书推送"}
							onClick={() => patch({ feishuEnabled: !cfg.feishuEnabled })} />
					</span>
				</div>
				{cfg.feishuEnabled ? <div className="dknt-rows-narrow">
					<div className="dknt-row dknt-row-webhook">
						<span className="dknt-row-label">Webhook</span>
						<input type="text" className="dknt-input" spellCheck={false}
							value={cfg.feishuWebhook || ""}
							placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
							onChange={(e) => {
								editingFeishuRef.current = true;
								setCfg(Object.assign({}, cfg, { feishuWebhook: e.target.value }));
							}} />
						<button type="button" className="dknt-btn" disabled={!editingFeishuRef.current}
							onClick={saveFeishuWebhook}>
							{editingFeishuRef.current ? "保存" : "已保存"}
						</button>
					</div>
					<div className="dknt-row">
						<span className="dknt-row-label">连通测试</span>
						<button type="button" className="dknt-btn" disabled={feishuTesting} onClick={runFeishuTest}>
							{feishuTesting ? "发送中…" : "发送测试消息"}
						</button>
						{feishuTestState ? <span className={"dknt-row-sub" + (feishuTestState.ok ? " dknt-ok" : " dknt-err")}>
							{feishuTestState.ok ? "✓ " : "✗ "}{feishuTestState.msg}
						</span> : <span className="dknt-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
					</div>
					<div className="dknt-note">机器人创建：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人（获取 Webhook 地址）；
						安全设置如选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
				</div> : <div className="dknt-note">未开启——任务结束不推送飞书。</div>}
			</div>
		);
	}
	if (saveErr) rows.push(<div key="err" className="dknt-note dknt-err">{saveErr}</div>);
	// 任务运行状态（进行中 / 最近完成 / 等待确认）已独立成左侧「运行状态」菜单项，这里只留一句指路
	rows.push(
		<div key="hint" className="dknt-note">
			任务运行状态（进行中任务、等待确认与最近完成）已独立成左侧「运行状态」菜单；本页只负责结束与需确认时的提醒。
		</div>
	);
	return <div className="dknt-root">{rows}</div>;
}

// ---------- 首页总揽概要 ----------
// 任务进行中 / 空闲这类任务信息归【运行状态】模块，这里只报通知自身的状态：
// 通知事件 + 提醒方式 + 已开启的推送通道，与面板页开关一一对应。
function NotifyStat(props) {
	const snap = useNotify(props && props.ctx);
	const cfg = snap.status && snap.status.config;
	if (snap.error) return <span className="dknt-err">通知状态不可用（宿主需重启加载通知路由）</span>;
	if (!cfg) return <span>等待通知配置…</span>;
	const events = [cfg.notifyOnComplete ? "完成" : "", cfg.notifyOnError ? "异常" : "", cfg.notifyOnConfirm !== false ? "需确认" : ""].filter(Boolean);
	const extras = [cfg.soundNotify !== false ? "提示音" : "", cfg.systemNotify ? "系统通知" : ""].filter(Boolean);
	const push = [cfg.dingtalkEnabled ? "钉钉" : "", cfg.feishuEnabled ? "飞书" : ""].filter(Boolean);
	return <span>{(events.length ? "通知：" + events.join("/") : "通知事件全关")
		+ (extras.length ? " · " + extras.join("/") : "")
		+ (push.length ? " · 推送：" + push.join("/") : "")}</span>;
}

// ---------- 样式（dknt- 前缀；全部走主题变量，暗/亮色自适应） ----------
const css = [
	// 通知卡片栈（右上角，不遮 dsh 自身 UI）
	".dknt-toasts{position:fixed;top:16px;right:16px;z-index:7;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 32px));}",
	".dknt-toast{border-radius:12px;padding:12px 14px;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 36px rgb(0 0 0 / .22);animation:dknt-toast-in .32s var(--ds-ease-in-out);}",
	".dknt-toast.out{animation:dknt-toast-out .24s var(--ds-ease-in-out) forwards;}",
	"@keyframes dknt-toast-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}",
	"@keyframes dknt-toast-out{to{opacity:0;transform:translateX(10px)}}",
	".dknt-toast-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
	".dknt-toast-mark{width:8px;height:8px;border-radius:50%;flex:none;}",
	".dknt-toast-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dknt-toast-close{cursor:pointer;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;width:22px;height:22px;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;}",
	".dknt-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dknt-toast-body{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;white-space:pre-line;word-break:break-word;}",
	// 需确认卡片：琥珀描边 + 缓慢呼吸光晕，常驻提醒直到用户处理
	".dknt-toast-confirm{border-color:color-mix(in srgb,var(--dk-warn) 55%,transparent);animation:dknt-toast-in .32s var(--ds-ease-in-out),dknt-confirm-glow 2.4s ease-in-out 0.4s infinite;}",
	"@keyframes dknt-confirm-glow{0%,100%{box-shadow:0 10px 36px rgb(0 0 0 / .22),0 0 0 0 color-mix(in srgb,var(--dk-warn) 30%,transparent)}50%{box-shadow:0 10px 36px rgb(0 0 0 / .22),0 0 14px 2px color-mix(in srgb,var(--dk-warn) 32%,transparent)}}",
	"@media (prefers-reduced-motion:reduce){.dknt-toast,.dknt-toast-confirm{animation:none}}",
	// 可跳转卡片：指针 + 悬停提亮（点卡片直达对应会话）
	".dknt-toast.clickable{cursor:pointer;}",
	".dknt-toast.clickable:hover{border-color:var(--dk-accent);}",
	// 叠放收纳：≥3 张时旧卡收成"只剩标题条"，悬停卡片栈整体展开
	".dknt-toasts.stacked{gap:4px;}",
	".dknt-toast.collapsed{padding:6px 14px;opacity:.85;margin-left:14px;}",
	".dknt-toast.collapsed .dknt-toast-head{margin-bottom:0;}",
	// 面板页布局
	".dknt-root{display:flex;flex-direction:column;gap:10px;}",
	".dknt-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dknt-err{color:var(--dsw-alias-state-error-primary);}",
	".dknt-ok{color:var(--dsw-alias-state-success-primary);}",
	".dknt-sec{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
	".dknt-sec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dknt-sec-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:none;}",
	".dknt-sec-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:120px;}",
	".dknt-sec-sw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;}",
	".dknt-sec-swlabel{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
	".dknt-sec-swlabel.on{color:var(--dsw-alias-state-success-primary);}",
	// 子选项行
	".dknt-rows-narrow{display:flex;flex-direction:column;gap:6px;}",
	".dknt-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}",
	".dknt-row-label{flex:none;min-width:60px;color:var(--dsw-alias-label-primary);}",
	".dknt-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-miniswitch{cursor:pointer;flex:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 12px;font-family:inherit;font-size:11px;line-height:18px;}",
	".dknt-miniswitch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	// 音效选择卡（名称 + 播放键；选中态描边）
	".dknt-sounds{display:flex;gap:6px;flex-wrap:wrap;}",
	".dknt-sound{flex:1;min-width:104px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-family:inherit;transition:border-color .15s var(--ds-ease-in-out);}",
	".dknt-sound:hover{border-color:var(--dk-accent);}",
	".dknt-sound.on{border-color:var(--dk-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dk-accent) 40%,transparent);}",
	".dknt-sound-name{font-size:12px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:5px;}",
	".dknt-sound-cur{color:var(--dk-accent);font-size:11px;}",
	".dknt-sound-play{flex:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);}",
	".dknt-sound-play:hover{color:var(--dsw-alias-label-primary);border-color:currentColor;}",
	".dknt-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;}",
	".dknt-input:focus{outline:none;border-color:var(--dk-accent);}",
	".dknt-row-webhook{flex-wrap:nowrap;}",
	".dknt-row-webhook .dknt-input{min-width:0;}",
	".dknt-btn{cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 12px;font-family:inherit;font-size:12px;}",
	".dknt-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	".dknt-btn[disabled]{opacity:.5;cursor:default;}",
].join("\n");

export const feature = {
	id: "notify",
	name: "任务通知",
	order: 140,
	accent: "#f59e0b",
	description: "任务完成/异常/需确认通知：页内卡片、提示音、系统通知、钉钉/飞书群机器人推送（独立开关）",
	css,
	View: NotifyView,
	HomeStat: NotifyStat,
	Overlay: NotifyOverlay,
};
