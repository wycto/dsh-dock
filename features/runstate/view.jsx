// dsh-dock · 功能模块【运行状态】· 客户端视图
//
// 两部分：
//  1. View     —— 功能坞面板页：进行中任务（阶段 / 耗时 / 回合 / 工具 / Token / 等待确认）与最近完成一览；
//  2. HomeStat —— 首页总揽概要（N 个任务进行中 / 等待确认 / 空闲 · 最近完成…）。
//
// 只读页面：数据全部来自宿主侧会话级任务追踪（src/task-track.js，与【任务动画】【任务通知】
// 共用同一份实例），本模块不写任何配置——动效在 features/animation/、结束与确认提醒在
// features/notify/。没有全局浮层，因此只在面板打开时轮询，关闭面板即零开销。
//
// Host 通信：fetch('/dsh-dock/runstate/status')（见 features/runstate/host.js）。
import { useState, useEffect } from "react";

// ---------- Host RPC 桥接 ----------
function rpcCall(method, args) {
	return fetch("/dsh-dock/runstate/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args === undefined ? {} : args),
	})
		.then(async (res) => {
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.ok === true) return data.data;
			// 宿主侧没有运行状态路由（405/404）：宿主进程可能是旧版本，或本功能在宿主侧未 setup
			if (res.status === 405 || res.status === 404) {
				throw new Error("宿主侧没有「运行状态」接口：宿主进程可能是旧版本，或该功能在宿主侧未启用（重启 dsh web，或把功能坞里的开关关掉再打开）");
			}
			if (data && data.ok === false) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
			throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""));
		});
}

// ---------- 结束原因 / 阶段（与宿主追踪的字段一一对应） ----------
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
const PHASE_LABELS = { think: "思考中", write: "输出中", code: "编写代码", search: "查资料" };
function phaseLabel(p) { return PHASE_LABELS[p] || "工作中"; }
// 阶段配色（与任务动画的徽标同源，便于一眼对上）
const PHASE_COLORS = { think: "#2f6fed", write: "#0d9488", code: "#b45309", search: "#0e7490" };
function phaseColor(p) { return PHASE_COLORS[p] || "#2f6fed"; }

// ---------- 格式化 ----------
function fmtCompact(n) {
	n = Number(n) || 0;
	if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
	return String(Math.round(n));
}
// 毫秒 → "3分21秒" / "1小时2分"
function fmtDur(ms) {
	const s = Math.max(0, Math.round((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	if (h > 0) return h + "小时" + m + "分" + sec + "秒";
	if (m > 0) return m + "分" + sec + "秒";
	return sec + "秒";
}
// 毫秒 → "12:34" / "1:02:11"（进行中任务的计时）
function fmtClock(ms) {
	const s = Math.max(0, Math.floor((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	const p = (x) => String(x).padStart(2, "0");
	return h > 0 ? h + ":" + p(m) + ":" + p(sec) : p(m) + ":" + p(sec);
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

// ---------- 共享快照：面板页与首页概要共用一份数据 ----------
const runStateStore = {
	snap: { status: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	emit() { for (const fn of this.listeners) fn(); },
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
function useRunState() {
	const [snap, setSnap] = useState(runStateStore.snap);
	useEffect(() => runStateStore.subscribe(() => setSnap(runStateStore.snap)), []);
	return snap;
}

// 等待确认的审批项总数（标题、横幅与首页概要共用；任何分支之外都能引用）
function waitingOf(active) {
	return (active || []).reduce((n, t) => n + (Array.isArray(t.approvals) ? t.approvals.length : 0), 0);
}

// ---------- 任务卡 ----------
function TaskCard(props) {
	const t = props.t;
	const info = endInfo(t.endReason);
	const waiting = !props.done && Array.isArray(t.approvals) && t.approvals.length > 0;
	return (
		<div className="dkrs-task">
			<div className="dkrs-task-head">
				<span className="dkrs-task-title" title={t.title}>{t.title || "(无标题)"}</span>
				{props.done ? <span className={"dkrs-tag " + info.cls}>{info.label}</span>
					: waiting ? <span className="dkrs-tag warn">等待确认</span>
						: <span className="dkrs-tag on">{phaseLabel(t.phase)}</span>}
			</div>
			<div className="dkrs-task-meta">
				<span>{(t.models && t.models.length ? t.models.join(", ") : "未知") + (t.provider ? "（" + t.provider + "）" : "")}</span>
				<span>{props.done ? fmtDur(t.duration) : fmtClock(t.elapsed)}</span>
				{"turns" in t ? <span>{"回合 " + (t.turns || 0) + " · 步骤 " + (t.steps || 0) + (t.toolCalls ? " · 工具 " + t.toolCalls : "")}</span> : null}
				{t.totalTokens ? <span>{"↧" + fmtCompact(t.inputTokens) + " ↥" + fmtCompact(t.outputTokens)}</span> : null}
				{props.done && t.endTime ? <span>{fmtTime(t.endTime)}</span> : null}
			</div>
			{waiting ? (
				<div className="dkrs-task-wait">
					{t.approvals.map((a, i) => (a && a.toolName ? a.toolName : "未知工具") + (a && a.reason ? "：" + truncate(a.reason, 80) : "")).join("；")}
				</div>
			) : null}
			{props.done && t.errorMessage ? <div className="dkrs-task-err">{truncate(t.errorMessage, 120)}</div> : null}
		</div>
	);
}

// ---------- 面板页 ----------
function RunStateView() {
	const snap = useRunState();
	const st = snap.status;
	const active = st && st.active ? st.active : [];
	const recent = st && st.recent ? st.recent.slice(0, 10) : [];
	const waitingCount = waitingOf(active);
	// 面板打开期间自动刷新：有任务 2s（阶段/耗时/待确认跟得上），空闲 8s，出错 15s。
	// 本模块没有常驻浮层，所以关掉面板即停止轮询。
	useEffect(() => {
		let stopped = false;
		let timer = null;
		const loop = async () => {
			await runStateStore.refresh();
			if (stopped) return;
			const s = runStateStore.snap;
			timer = setTimeout(loop, s.error ? 15000 : (s.status && s.status.active && s.status.active.length > 0 ? 2000 : 8000));
		};
		loop();
		return () => { stopped = true; if (timer) clearTimeout(timer); };
	}, []);

	const sub = snap.error ? "状态拉取失败：" + snap.error
		: !st ? (snap.loading ? "正在拉取任务状态…" : "等待任务状态")
			: waitingCount > 0 ? waitingCount + " 项等待确认 · " + active.length + " 个任务进行中"
				: active.length > 0 ? active.length + " 个任务进行中"
					: recent.length > 0 ? "空闲 · 显示最近完成" : "空闲 · 暂无任务记录";

	return (
		<div className="dkrs-root">
			<div className="dkrs-sec">
				<div className="dkrs-sec-head">
					<span className="dkrs-sec-title">运行状态</span>
					<span className="dkrs-sec-sub">{sub}</span>
					<button type="button" className="dkrs-refresh" onClick={() => runStateStore.refresh()}>
						{snap.loading ? "刷新中…" : "刷新"}
					</button>
				</div>
				{waitingCount > 0 ? (
					<div className="dkrs-waitbanner">✋ {waitingCount} 项等待确认：任务停在需要你批准的步骤上，请在会话里处理后继续。</div>
				) : null}
				{active.length > 0 ? (
					<div className="dkrs-tasks">{active.map((t) => <TaskCard key={t.sessionId} t={t} />)}</div>
				) : null}
				{!snap.error && active.length === 0 && recent.length === 0
					? <div className="dkrs-note">发起新会话任务后，这里会显示进行中与最近完成的任务（动效见左侧「任务动画」，提醒见「任务通知」）。</div> : null}
				{active.length === 0 && recent.length > 0 ? <div className="dkrs-note">当前没有进行中的任务。</div> : null}
				{recent.length > 0 ? (
					<>
						<div className="dkrs-done-title">最近完成</div>
						<div className="dkrs-tasks dkrs-tasks-done">
							{recent.map((t) => <TaskCard key={t.sessionId + ":" + t.endTime} t={t} done />)}
						</div>
					</>
				) : null}
				<div className="dkrs-note dkrs-foot">
					本页只读：数据来自宿主侧会话级任务追踪，与「任务动画」「任务通知」共用同一份（三个功能可各自启停）。
					动效在「任务动画」，结束 / 需确认提醒在「任务通知」。
				</div>
			</div>
		</div>
	);
}

// ---------- 首页总揽概要 ----------
function RunStateStat(props) {
	const snap = useRunState();
	// 首页卡片没有常驻轮询（本模块无浮层）：首次进入拉一次，之后随面板页刷新。
	useEffect(() => { if (!runStateStore.snap.status) runStateStore.refresh(); }, []);
	const st = snap.status;
	if (snap.error) return <span className="dkrs-err">运行状态不可用（宿主需重启加载运行状态路由）</span>;
	if (!st) return <span>等待任务状态…</span>;
	const active = st.active || [];
	const waiting = waitingOf(active);
	if (waiting > 0) return <span className="dkrs-warn">✋ {waiting} 项等待确认 · {active.length} 个任务进行中</span>;
	if (active.length > 0) {
		return <span>{active.length + " 个任务进行中 · " + fmtDur(Math.max(...active.map((x) => x.elapsed || 0)))}</span>;
	}
	const last = (st.recent || [])[0];
	return <span>{last ? "空闲 · 最近完成 " + truncate(last.title, 24) : "空闲 · 暂无任务记录"}</span>;
}

// ---------- 样式（dkrs- 前缀；全部走主题变量，暗/亮色自适应） ----------
const css = [
	".dkrs-root{display:flex;flex-direction:column;gap:10px;}",
	".dkrs-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dkrs-err{color:var(--dsw-alias-state-error-primary);}",
	".dkrs-warn{color:var(--dk-warn);}",
	".dkrs-foot{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;font-size:11px;}",
	".dkrs-sec{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
	".dkrs-sec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dkrs-sec-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:none;}",
	".dkrs-sec-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:120px;}",
	".dkrs-refresh{cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px 10px;font-family:inherit;font-size:12px;}",
	".dkrs-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	// 等待确认横幅：琥珀描边，常驻在列表上方（任务卡各自也带「等待确认」标签）
	".dkrs-waitbanner{border:1px solid color-mix(in srgb,var(--dk-warn) 45%,transparent);background:color-mix(in srgb,var(--dk-warn) 10%,transparent);color:var(--dk-warn);border-radius:8px;padding:6px 10px;font-size:12px;line-height:1.6;}",
	".dkrs-done-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);}",
	// 任务列表
	".dkrs-tasks{display:flex;flex-direction:column;gap:6px;}",
	".dkrs-tasks-done{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:6px;}",
	".dkrs-task{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;display:flex;flex-direction:column;gap:3px;}",
	".dkrs-task-head{display:flex;align-items:center;gap:8px;min-width:0;}",
	".dkrs-task-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkrs-task-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkrs-task-wait{font-size:11px;color:var(--dk-warn);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkrs-task-err{font-size:11px;color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkrs-tag{flex:none;font-size:10px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
	".dkrs-tag.on{color:var(--dk-accent);border-color:currentColor;}",
	".dkrs-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	".dkrs-tag.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
	".dkrs-tag.warn{color:var(--dk-warn);border-color:currentColor;}",
].join("\n");

export const feature = {
	id: "runstate",
	name: "运行状态",
	order: 150,
	accent: "#38bdf8",
	description: "任务运行状态一览：进行中任务的阶段 / 耗时 / Token / 等待确认与最近完成记录（只读）",
	css,
	View: RunStateView,
	HomeStat: RunStateStat,
};
