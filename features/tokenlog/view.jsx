// dsh-dock · 功能模块【用量记录】· 客户端视图（v0.4.0，移植自 @wycto/dsh-token-usage client v6，适配 dock 嵌入）
//
// 嵌入功能坞面板的统计视图（无独立 overlay 外壳；全屏用 dock 弹窗自带的「最大化」）：
//  - 秒级时间范围查询 + 会话ID/提供商/模型(联动)/状态/推理强度 筛选，条件本地暂存
//  - 9 张 KPI 卡 + 分组统计表 + 明细表（点击表头排序、会话ID点击即筛选、100 行/页上下双分页）
//  - 状态列显示 HTTP 状态码徽章，行内【查看详情】弹窗展示完整信息；CSV 导出
//  - 挂载即扫描历史+按暂存条件查询；挂载期间每 5s 静默自动刷新
// Host 通信：fetch('/dsh-dock/tokenlog/<method>')（见 features/tokenlog/host.js）。
import { useState, useEffect, useCallback, useMemo } from "react";

// ---------- Host RPC 桥接 ----------
function rpcCall(method, args) {
	return fetch("/dsh-dock/tokenlog/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args === undefined ? {} : args),
	})
		.then(async (res) => {
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.ok === true) return data.data;
			if (data && data.ok === false) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
			throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""));
		});
}

// ---------- 格式化 ----------
function fmtNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }
function fmtCompact(n) {
	n = Number(n) || 0;
	if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
	if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
	return String(Math.round(n));
}
function fmtCost(n) {
	const v = Number(n) || 0;
	if (v >= 10) return "$" + v.toFixed(2);
	if (v >= 0.01) return "$" + v.toFixed(4);
	return "$" + v.toFixed(6);
}
// 人民币金额: USD 按汇率换算, 默认 7.2(host 返回 rateUsdCny 可覆盖)
function fmtCostCny(usd, rate) {
	const v = (Number(usd) || 0) * (Number(rate) > 0 ? Number(rate) : 7.2);
	if (v >= 10000) return "¥" + (v / 10000).toFixed(2) + "万";
	if (v >= 100) return "¥" + v.toFixed(0);
	return "¥" + v.toFixed(2);
}
function fmtDuration(ms) {
	if (ms === null || ms === undefined || isNaN(ms)) return "—";
	if (ms < 1000) return Math.round(ms) + "ms";
	if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
	return Math.floor(ms / 60000) + "m" + Math.round((ms % 60000) / 1000) + "s";
}
function fmtTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	const p = (x) => String(x).padStart(2, "0");
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

// ---------- 筛选条件暂存(本地) ----------
// 打开视图时恢复上次保存的条件; 从未保存过则时间范围不选(显示全部记录)。
const STORE_KEY = "dsh-dock/tokenlog/filters/v1";
const FILTER_FIELDS = ["fromStr", "toStr", "provider", "model", "status", "effort", "sessionId", "dim"];
function loadSavedFilters() {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(STORE_KEY);
		if (!raw) return null;
		const obj = JSON.parse(raw);
		if (!obj || typeof obj !== "object") return null;
		const out = {};
		for (const k of FILTER_FIELDS) out[k] = typeof obj[k] === "string" ? obj[k] : "";
		return out;
	} catch (e) { return null; }
}
function saveFilters(f) {
	try {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(STORE_KEY, JSON.stringify(f));
	} catch (e) { /* localStorage 不可用时静默 */ }
}
function shortId(sid) {
	if (!sid) return "";
	if (sid.length <= 16) return sid;
	return sid.slice(0, 8) + "…" + sid.slice(-6);
}
function statusInfo(r) {
	if (r.status === "completed") return { code: 200, label: "200", cls: "ok", title: "成功" };
	if (r.status === "max-tokens") return { code: 200, label: "200", cls: "warn", title: "完成(达到输出上限)" };
	if (r.status === "error") return { code: r.statusCode || 500, label: String(r.statusCode || 500), cls: "err", title: r.errorMsg || r.errorCode || "调用失败" };
	if (r.status === "aborted") return { code: 499, label: "499", cls: "warn", title: "已取消" };
	if (r.status === "blocked") return { code: 403, label: "403", cls: "warn", title: "已阻止" };
	if (r.status === "interrupted") return { code: 500, label: "500", cls: "warn", title: "中断" };
	return { code: 0, label: "…", cls: "pend", title: "进行中" };
}

// ---------- 样式（dtok- 前缀，dock 面板内自适应：宽度铺满、表格横向滚动） ----------
const css = `
.dtok-root{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;}
.dtok-status{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}
.dtok-status .count{color:var(--dsw-alias-label-primary);}
.dtok-filter{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}
.dtok-filter label{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:none;}
.dtok-input,.dtok-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;max-width:170px;}
.dtok-input[type="datetime-local"]{width:158px;}
.dtok-btn{cursor:pointer;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:4px 12px;font-size:12px;font-family:inherit;flex:none;}
.dtok-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.dtok-btn[disabled]{opacity:.5;cursor:default;}
.dtok-btn.primary{background:var(--dsw-alias-accent,#2f6fed);border-color:var(--dsw-alias-accent,#2f6fed);color:#fff;}
.dtok-btn.primary:hover{filter:brightness(1.1);}
.dtok-body{display:flex;flex-direction:column;gap:8px;min-width:0;}
.dtok-cards{display:flex;gap:8px;flex-wrap:wrap;}
.dtok-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 14px;min-width:112px;}
.dtok-card .v{font-size:18px;font-weight:700;color:var(--dsw-alias-label-primary);}
.dtok-card .l{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px;}
.dtok-section-title{font-size:13px;font-weight:600;margin:6px 0 0;color:var(--dsw-alias-label-primary);}
.dtok-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;max-width:100%;}
.dtok-table{border-collapse:collapse;width:100%;font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-primary);}
.dtok-table th{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);text-align:left;padding:7px 10px;position:sticky;top:0;z-index:1;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;user-select:none;cursor:pointer;}
.dtok-table th:hover{color:var(--dsw-alias-label-primary);}
.dtok-table td{padding:6px 10px;border-bottom:1px solid rgba(122,132,152,0.12);}
.dtok-table tr:hover td{background:rgba(80,110,180,0.10);}
.dtok-empty{text-align:center;color:var(--dsw-alias-label-secondary);padding:32px 0;font-size:13px;}
.dtok-sid{color:var(--dsw-alias-accent,#7ab8ff);cursor:pointer;text-decoration:underline dotted;}
.dtok-sid:hover{filter:brightness(1.25);}
.dtok-code{font-weight:700;font-family:ui-monospace,monospace;}
.dtok-code.ok{color:var(--dsw-alias-state-success-primary,#4ade80);}
.dtok-code.warn{color:var(--dsw-alias-state-warning-primary,#fbbf24);}
.dtok-code.err{color:var(--dsw-alias-state-error-primary,#f87171);}
.dtok-code.pend{color:var(--dsw-alias-label-tertiary,#94a3b8);}
.dtok-detail-link{color:var(--dsw-alias-accent,#7ab8ff);cursor:pointer;font-size:11px;}
.dtok-detail-link:hover{text-decoration:underline;}
.dtok-detail{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;}
.dtok-detail-card{background:var(--dsw-alias-bg-layer-2,#1c212b);border:1px solid var(--dsw-alias-border-l2,#3a4150);border-radius:12px;padding:20px 24px;max-width:640px;width:92%;max-height:80vh;overflow:auto;color:var(--dsw-alias-label-primary,#e8eaf0);}
.dtok-detail-card h3{margin:0 0 12px;font-size:15px;}
.dtok-detail-row{display:flex;gap:8px;padding:4px 0;font-size:12px;border-bottom:1px solid rgba(122,132,152,0.1);}
.dtok-detail-row .k{color:var(--dsw-alias-label-secondary,#9aa3b5);min-width:110px;flex-shrink:0;}
.dtok-detail-row .v{word-break:break-all;}
.dtok-sort-mark{opacity:0.6;margin-left:3px;}
.dtok-pager{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dtok-pager.top{margin:0;}
.dtok-pager.bottom{margin:0;}
.dtok-err{color:var(--dsw-alias-state-error-primary,#ff7a7a);font-size:12px;}
`;

// ---------- 详情弹窗 ----------
function Detail({ rec, onClose, rate }) {
	const st = statusInfo(rec);
	const rateCny = Number(rate) > 0 ? Number(rate) : 7.2;
	const rows = [
		["会话 ID", rec.sessionId],
		["时间", fmtTime(rec.time)],
		["提供商", rec.provider],
		["模型", rec.model],
		["状态码", st.label + " (" + st.title + ")"],
		["错误信息", rec.errorMsg || "—"],
		["错误码", rec.errorCode || "—"],
		["Request ID", rec.requestId || "—"],
		["输入 Token(未缓存)", fmtNum(rec.inputTokens)],
		["输出 Token", fmtNum(rec.outputTokens)],
		["缓存命中 Token", fmtNum(rec.cacheReadTokens)],
		["缓存写入 Token", fmtNum(rec.cacheWriteTokens)],
		["推理 Token", fmtNum(rec.reasoningTokens)],
		["计费输入", fmtNum(rec.billedInput)],
		["缓存命中率", rec.cacheHitPercent + "%"],
		["总 Token", fmtNum(rec.totalTokens)],
		["消耗金额(估算)", fmtCost(rec.cost) + " ≈ " + fmtCostCny(rec.cost, rateCny)],
		["推理强度", rec.effort || "—"],
		["耗时", fmtDuration(rec.llmMs)],
		["Turn / Step", rec.turn + " / " + rec.step],
	];
	return (
		<div className="dtok-detail" onClick={onClose}>
			<div className="dtok-detail-card" onClick={(e) => e.stopPropagation()}>
				<h3>调用详情</h3>
				{rows.map(([k, v]) => (
					<div className="dtok-detail-row" key={k}>
						<span className="k">{k}</span>
						<span className="v">{v}</span>
					</div>
				))}
				<button className="dtok-btn" style={{ marginTop: 12 }} onClick={onClose}>关闭</button>
			</div>
		</div>
	);
}

// ---------- 主视图（嵌入 dock 面板内容区） ----------
export function TokenLogView() {
	// 挂载即视为「打开」：恢复上次暂存的条件(时间不选=显示全部记录); savedFilters 稳定快照, 仅初始化时读取一次
	const [savedFilters] = useState(loadSavedFilters);
	const [fromStr, setFromStr] = useState(() => (savedFilters && savedFilters.fromStr) || "");
	const [toStr, setToStr] = useState(() => (savedFilters && savedFilters.toStr) || "");
	const [provider, setProvider] = useState(() => (savedFilters && savedFilters.provider) || "");
	const [model, setModel] = useState(() => (savedFilters && savedFilters.model) || "");
	const [status, setStatus] = useState(() => (savedFilters && savedFilters.status) || "");
	const [effort, setEffort] = useState(() => (savedFilters && savedFilters.effort) || "");
	const [sessionId, setSessionId] = useState(() => (savedFilters && savedFilters.sessionId) || "");
	const [dim, setDim] = useState(() => (savedFilters && savedFilters.dim) || "");
	const [sortKey, setSortKey] = useState("time");
	const [sortDir, setSortDir] = useState("desc");
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [page, setPage] = useState(0);
	const [detailRec, setDetailRec] = useState(null);
	const pageSize = 100;

	// 暂存筛选条件: 任一筛选变化即写入 localStorage, 下次打开恢复同样条件
	useEffect(() => {
		saveFilters({ fromStr, toStr, provider, model, status, effort, sessionId, dim });
	}, [fromStr, toStr, provider, model, status, effort, sessionId, dim]);

	// 挂载时: 扫描历史后按暂存条件查询(未设置时间则不限制, 显示全部记录)
	useEffect(() => {
		let cancel = false;
		setLoading(true); setErr("");
		const q = {};
		if (savedFilters) {
			if (savedFilters.fromStr) q.from = new Date(savedFilters.fromStr).getTime();
			if (savedFilters.toStr) q.to = new Date(savedFilters.toStr).getTime();
			if (savedFilters.provider) q.provider = savedFilters.provider;
			if (savedFilters.model) q.model = savedFilters.model;
			if (savedFilters.status) q.status = savedFilters.status;
			if (savedFilters.effort) q.effort = savedFilters.effort;
			if (savedFilters.sessionId) q.sessionId = savedFilters.sessionId;
			if (savedFilters.dim) q.dim = savedFilters.dim;
		}
		rpcCall("scan", {})
			.then(() => (cancel ? null : rpcCall("query", q)))
			.then((d) => {
				if (cancel) return;
				setData(d);
			})
			.catch((e) => { if (!cancel) setErr(String((e && e.message) || e)); })
			.finally(() => { if (!cancel) setLoading(false); });
		return () => { cancel = true; };
	}, [savedFilters]);

	const buildQ = useCallback((withDim, dimOverride) => {
		const q = {};
		if (fromStr) q.from = new Date(fromStr).getTime();
		if (toStr) q.to = new Date(toStr).getTime();
		if (provider) q.provider = provider;
		if (model) q.model = model;
		if (status) q.status = status;
		if (effort) q.effort = effort;
		if (sessionId) q.sessionId = sessionId;
		const dimNow = dimOverride !== undefined ? dimOverride : dim;
		if (withDim && dimNow) q.dim = dimNow;
		return q;
	}, [fromStr, toStr, provider, model, status, effort, sessionId, dim]);

	// dimOverride：分组按钮点击时按「即将切换到」的维度立即查询（闭包里的 dim 还是旧值）
	const runQuery = useCallback((dimOverride) => {
		setLoading(true); setErr("");
		rpcCall("query", buildQ(true, dimOverride))
			.then((d) => { setData(d); setPage(0); })
			.catch((e) => setErr(String((e && e.message) || e)))
			.finally(() => setLoading(false));
	}, [buildQ]);

	// 重置: 清空所有筛选(时间不选=显示全部记录), 并立即查询
	const resetFilters = useCallback(() => {
		setFromStr(""); setToStr("");
		setProvider(""); setModel(""); setStatus(""); setEffort(""); setSessionId(""); setDim("");
		setLoading(true); setErr("");
		rpcCall("query", {})
			.then((d) => { setData(d); setPage(0); })
			.catch((e) => setErr(String((e && e.message) || e)))
			.finally(() => setLoading(false));
	}, []);

	const exportCsv = useCallback(() => {
		rpcCall("export", buildQ(false))
			.then((d) => {
				const blob = new Blob([d.csv], { type: "text/csv;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = "dsh-dock-tokenlog-" + Date.now() + ".csv";
				a.click();
				URL.revokeObjectURL(url);
			})
			.catch((e) => setErr(String((e && e.message) || e)));
	}, [buildQ]);

	// 自动刷新: 挂载期间每 5s 按当前筛选静默刷新(不闪烁 loading)。
	// 注意: 依赖数组 [buildQ] 在声明时即求值, 必须放在 buildQ 定义之后(否则 TDZ 崩溃)。
	useEffect(() => {
		const timer = setInterval(() => {
			rpcCall("query", buildQ(true))
				.then((d) => { setData(d); setErr(""); })
				.catch(() => {});
		}, 5000);
		return () => clearInterval(timer);
	}, [buildQ]);

	const toggleSort = useCallback((key) => {
		if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
		else { setSortKey(key); setSortDir("asc"); }
	}, [sortKey, sortDir]);

	const records = (data && data.records) || [];
	const totals = data && data.totals;
	const sessionIds = (data && data.sessionIds) || [];
	const sorted = useMemo(() => {
		const arr = records.slice();
		const key = sortKey;
		const dir = sortDir === "asc" ? 1 : -1;
		arr.sort((a, b) => {
			const av = a[key]; const bv = b[key];
			if (av === null || av === undefined || av === "") return 1;
			if (bv === null || bv === undefined || bv === "") return -1;
			if (typeof av === "string") return av.localeCompare(String(bv)) * dir;
			return (Number(av) - Number(bv)) * dir;
		});
		return arr;
	}, [records, sortKey, sortDir]);
	const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
	const pageSafe = Math.min(page, pageCount - 1);
	const pageRows = sorted.slice(pageSafe * pageSize, (pageSafe + 1) * pageSize);

	// USD→CNY 汇率: host 返回(默认 7.2, 可被 settings dsh-dock-tokenlog.usdCnyRate 覆盖)。
	// 注意: 必须在本文件所有引用它的表达式(cards/summaryRows/detailRows/Detail)之前声明。
	const rateCny = (data && data.rateUsdCny) || 7.2;

	const cards = totals ? [
		{ v: fmtNum(totals.calls), l: "调用次数" },
		{ v: fmtCompact(totals.totalTokens), l: "总 Token" },
		{ v: fmtCompact(totals.inputTokens), l: "输入(未缓存)" },
		{ v: fmtCompact(totals.cacheReadTokens), l: "缓存命中" },
		{ v: totals.cacheHitPct + "%", l: "缓存命中率" },
		{ v: fmtCompact(totals.outputTokens), l: "输出" },
		{ v: fmtCost(totals.cost), l: "消耗金额(估算)" },
		{ v: fmtCostCny(totals.cost, rateCny), l: "消耗金额(¥)" },
		{ v: fmtDuration(totals.llmMs), l: "累计耗时" + (totals.timed ? " (" + totals.timed + "步)" : "") },
	] : [];

	const opts = (arr) => (arr || []).map((x) => <option key={x || "(none)"} value={x}>{x || "(空)"}</option>);

	// 模型下拉联动: 选中提供商后只显示该提供商下的模型; 未选提供商显示全部模型。
	// modelsByProvider 由 host 返回({provider: [models]})。
	const modelChoices = provider && data && data.modelsByProvider
		? (data.modelsByProvider[provider] || [])
		: (data && data.models) || [];

	const summaryRows = (data && data.summary || []).map((r) => (
		<tr key={r.key}>
			<td>{r.key}</td><td>{fmtNum(r.calls)}</td><td>{fmtCompact(r.inputTokens)}</td>
			<td>{fmtCompact(r.cacheReadTokens)}</td><td>{r.cacheHitPct + "%"}</td><td>{fmtCompact(r.outputTokens)}</td>
			<td>{fmtCompact(r.totalTokens)}</td>
			<td>{fmtCost(r.cost)}</td>
			<td>{fmtCostCny(r.cost, rateCny)}</td>
			<td>{fmtDuration(r.llmMs)}</td>
		</tr>
	));

	const sortTh = (label, key) => (
		<th onClick={() => toggleSort(key)} title="点击排序">
			{label}{sortKey === key ? <span className="dtok-sort-mark">{sortDir === "asc" ? "▲" : "▼"}</span> : null}
		</th>
	);

	const detailRows = pageRows.map((r) => {
		const st = statusInfo(r);
		return (
			<tr key={r.id}>
				<td>{fmtTime(r.time)}</td>
				<td><span className="dtok-sid" title="点击按此会话筛选" onClick={() => { setSessionId(r.sessionId); runQuery(); }}>{shortId(r.sessionId)}</span></td>
				<td>{r.provider || "—"}</td>
				<td>{r.model || "—"}</td>
				<td>{fmtNum(r.inputTokens)}</td>
				<td>{fmtNum(r.cacheReadTokens)}</td>
				<td>{r.cacheHitPercent + "%"}</td>
				<td>{fmtNum(r.outputTokens)}</td>
				<td>{fmtNum(r.reasoningTokens)}</td>
				<td>{fmtNum(r.totalTokens)}</td>
				<td>{fmtCost(r.cost)}</td>
				<td>{fmtCostCny(r.cost, rateCny)}</td>
				<td>{r.effort || "—"}</td>
				<td>
					<div><span className={"dtok-code " + st.cls}>{st.label}</span></div>
					<div><a className="dtok-detail-link" onClick={() => setDetailRec(r)}>查看详情</a></div>
				</td>
				<td>{fmtDuration(r.llmMs)}</td>
			</tr>
		);
	});

	const bodyNodes = [];
	if (err) bodyNodes.push(<div key="err" className="dtok-err">错误: {err}</div>);
	if (cards.length) bodyNodes.push(
		<div className="dtok-cards" key="cards">
			{cards.map((c) => <div className="dtok-card" key={c.l}><div className="v">{c.v}</div><div className="l">{c.l}</div></div>)}
		</div>
	);
	if (summaryRows.length) bodyNodes.push(
		<div key="sum" className="dtok-section-title">统计分组: {dim || "无"} ({summaryRows.length} 组)</div>,
		<div key="sumtab" className="dtok-table-wrap">
			<table className="dtok-table">
				<thead><tr>
					<th>维度</th><th>调用</th><th>输入</th><th>缓存</th><th>命中率</th><th>输出</th><th>总Token</th><th>金额</th><th>金额(¥)</th><th>耗时</th>
				</tr></thead>
				<tbody>{summaryRows}</tbody>
			</table>
		</div>
	);
	bodyNodes.push(<div key="dimtitle" className="dtok-section-title">按维度统计</div>);
	bodyNodes.push(
		<div key="dimrow" className="dtok-filter" style={{ padding: "4px 0 0", border: "none", background: "transparent" }}>
			{["", "provider", "model", "status", "effort"].map((d) => (
				<button key={d} className={"dtok-btn" + (dim === d ? " primary" : "")} onClick={() => { setDim(d); runQuery(d); }}>{d === "" ? "无分组" : d}</button>
			))}
		</div>
	);
	bodyNodes.push(<div key="dettitle" className="dtok-section-title">调用明细</div>);
	if (sorted.length === 0) {
		bodyNodes.push(<div key="empty" className="dtok-empty">{loading ? "加载中…" : "无匹配记录"}</div>);
	} else {
		// 分页控件: 明细表上方+下方各一份, 免去翻页时滑到底部
		const pager = (key, cls) => (
			<div key={key} className={"dtok-pager " + cls}>
				<button className="dtok-btn" disabled={pageSafe <= 0} onClick={() => setPage(pageSafe - 1)}>上一页</button>
				<span>第 {pageSafe + 1} / {pageCount} 页 · 共 {sorted.length} 条</span>
				<button className="dtok-btn" disabled={pageSafe >= pageCount - 1} onClick={() => setPage(pageSafe + 1)}>下一页</button>
			</div>
		);
		bodyNodes.push(pager("pager-top", "top"));
		bodyNodes.push(
			<div key="detail" className="dtok-table-wrap">
				<table className="dtok-table">
					<thead><tr>
						{sortTh("时间", "time")}{sortTh("会话ID", "sessionId")}{sortTh("提供商", "provider")}{sortTh("模型", "model")}
						{sortTh("输入", "inputTokens")}{sortTh("缓存", "cacheReadTokens")}{sortTh("命中%", "cacheHitPercent")}{sortTh("输出", "outputTokens")}
						{sortTh("推理", "reasoningTokens")}{sortTh("总额", "totalTokens")}{sortTh("金额", "cost")}{sortTh("金额(¥)", "cost")}{sortTh("强度", "effort")}
						{sortTh("状态", "status")}{sortTh("耗时", "llmMs")}
					</tr></thead>
					<tbody>{detailRows}</tbody>
				</table>
			</div>
		);
		bodyNodes.push(pager("pager-bottom", "bottom"));
	}

	return (
		<div className="dtok-root" onClick={(e) => e.stopPropagation()}>
			<div className="dtok-status">
				<span className="count">{loading ? "加载中…" : (data ? data.counts.matching + " / " + data.counts.total + " 条" : "")}</span>
				<span>全屏请用面板右上角「最大化」；面板打开期间每 5 秒自动刷新</span>
			</div>
			<div className="dtok-filter">
				<label>起</label>
				<input className="dtok-input" type="datetime-local" step="1" value={fromStr} onChange={(e) => setFromStr(e.target.value)} />
				<label>止</label>
				<input className="dtok-input" type="datetime-local" step="1" value={toStr} onChange={(e) => setToStr(e.target.value)} />
				<label>会话</label>
				<select className="dtok-select" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
					<option value="">全部</option>{opts(sessionIds)}
				</select>
				<label>提供商</label>
				<select className="dtok-select" value={provider} onChange={(e) => { setProvider(e.target.value); setModel("") }}>
					<option value="">全部</option>{opts(data && data.providers)}
				</select>
				<label>模型</label>
				<select className="dtok-select" value={model} onChange={(e) => setModel(e.target.value)}>
					<option value="">全部</option>{opts(modelChoices)}
				</select>
				<label>状态</label>
				<select className="dtok-select" value={status} onChange={(e) => setStatus(e.target.value)}>
					<option value="">全部</option>{opts(data && data.statuses)}
				</select>
				<label>推理强度</label>
				<select className="dtok-select" value={effort} onChange={(e) => setEffort(e.target.value)}>
					<option value="">全部</option>{opts(data && data.efforts)}
				</select>
				<button className="dtok-btn primary" onClick={runQuery}>查询</button>
				<button className="dtok-btn" onClick={resetFilters}>重置</button>
				<button className="dtok-btn" onClick={exportCsv}>导出 CSV</button>
			</div>
			<div className="dtok-body">{bodyNodes}</div>
			{detailRec ? <Detail rec={detailRec} onClose={() => setDetailRec(null)} rate={rateCny} /> : null}
		</div>
	);
}

// ---------- 首页总揽卡片：今日调用 / 今日 Token / 今日花费 ----------
function todayStart() {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
function TokenLogHomeStat() {
	const [snap, setSnap] = useState({ totals: null, rate: 7.2, err: "" });
	useEffect(() => {
		let cancel = false;
		const load = () => rpcCall("query", { from: todayStart() })
			.then((d) => { if (!cancel) setSnap({ totals: d && d.totals, rate: (d && d.rateUsdCny) || 7.2, err: "" }); })
			.catch((e) => { if (!cancel) setSnap((s) => ({ totals: s.totals, rate: s.rate, err: String((e && e.message) || e) })); });
		load();
		const timer = setInterval(load, 60000);
		return () => { cancel = true; clearInterval(timer); };
	}, []);
	if (!snap.totals) return <span>{snap.err ? "用量查询失败（点击进入查看）" : "正在拉取今日用量…"}</span>;
	const t = snap.totals;
	return <span>今日 {fmtNum(t.calls)} 次调用 · {fmtCompact(t.totalTokens)} Token · {fmtCost(t.cost)}（{fmtCostCny(t.cost, snap.rate)}）</span>;
}

export const feature = {
	id: "tokenlog",
	name: "用量记录",
	order: 110,
	accent: "#fbbf24",
	description: "记录全部 LLM API 调用：秒级时间筛选、Token/费用统计（峰谷计价+官网价目自动同步）、分组汇总、明细检索与 CSV 导出",
	css,
	View: TokenLogView,
	HomeStat: TokenLogHomeStat,
};
