// dsh-dock · 功能模块【用量记录】· 客户端视图（v0.4.0，移植自 @wycto/dsh-token-usage client v6，适配 dock 嵌入）
//
// 嵌入功能坞面板的统计视图（无独立 overlay 外壳；全屏用 dock 弹窗自带的「最大化」）：
//  - 秒级时间范围查询 + 会话ID/提供商/模型(联动)/状态/推理强度 筛选，条件本地暂存
//  - 9 张 KPI 卡 + 分组统计表 + 明细表（点击表头排序、会话ID点击即筛选、100 行/页上下双分页）
//  - 状态列显示 HTTP 状态码徽章，行内【查看详情】弹窗展示完整信息；CSV 导出（中文表头，列序与明细表一致 + 合计行）
//  - 独立的「单价设置」子弹窗：按模型配置单价（支持多段分时价）并持久化，费用按自填单价重算
//  - 挂载即扫描历史+按暂存条件查询；挂载期间每 5s 静默自动刷新
//  - 查询等待动画：点「查询」后按钮转圈扫光 + 数据区顶部「记账小队清点」banner（轮换俏皮文案，
//    等久了换语气），旧数据压暗禁点；结果到位时闪一次「✓ 数据已更新」并让 KPI 卡回弹
// Host 通信：fetch('/dsh-dock/tokenlog/<method>')（见 features/tokenlog/host.js）。
import react, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { openPanel } from "../../src/shared.js";

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
			// 旧宿主进程没有用量路由（405/404）：给出可操作提示而非裸状态码
			if (res.status === 405 || res.status === 404) {
				throw new Error("宿主进程是旧版本（没有用量记录路由），重启 dsh web 后重试");
			}
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
// 金额记录在 RPC 中以 USD 传输；界面统一按人民币显示。
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
// 金额: CSV 里逐条导出时保精确(不做 ¥xx万/取整), 否则对账会丢分。
function fmtCostCnyExact(usd, rate) {
	const v = (Number(usd) || 0) * (Number(rate) > 0 ? Number(rate) : 7.2);
	return "¥" + v.toFixed(4);
}
function fmtDurCompact(ms) {
	if (ms === null || ms === undefined || isNaN(ms)) return "—";
	if (ms < 1000) return Math.round(ms) + "ms";
	if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
	if (ms < 3600000) return Math.round(ms / 60000) + "m";
	return (ms / 3600000).toFixed(1) + "h";
}
function startOfToday() {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}
function hourOf(ts) { return new Date(ts).getHours(); }

// ---------- CSV 导出 ----------
// 表头即「调用明细」表的中文列名, 列序/取值格式与页面完全一致(日期时间、千分位、命中%、¥xx.xxxx、
// 耗时 1.2s、状态徽章标签)。host 的 export 返回原始 rows, 由这里统一格式化, 保证界面与导出同源。
const EXPORT_COLUMNS = [
	["时间", (r) => fmtTime(r.time)],
	["会话ID", (r) => r.sessionId || ""],
	["提供商", (r) => r.provider || "—"],
	["模型", (r) => r.model || "—"],
	["输入(命中)", (r) => fmtNum(r.cacheReadTokens)],
	["输入(未命中)", (r) => fmtNum(r.inputTokens)],
	["命中%", (r) => (Number(r.cacheHitPercent) || 0) + "%"],
	["输出", (r) => fmtNum(r.outputTokens)],
	["推理", (r) => fmtNum(r.reasoningTokens)],
	["总额", (r) => fmtNum(r.totalTokens)],
	["金额（人民币）", (r, rate) => fmtCostCnyExact(r.cost, rate)],
	["强度", (r) => r.effort || "—"],
	["状态", (r) => statusInfo(r).label],
	["耗时", (r) => fmtDuration(r.llmMs)],
];
function csvCell(v) {
	const s = String(v === undefined || v === null ? "" : v);
	return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** rows → CSV 文本(不含 BOM)。末尾追加「合计」行: 调用数/各 Token 合计/金额合计, 与页面 KPI 卡口径一致。 */
function buildExportCsv(rows, rate) {
	const list = Array.isArray(rows) ? rows : [];
	const lines = [EXPORT_COLUMNS.map(([title]) => csvCell(title)).join(",")];
	for (const r of list) lines.push(EXPORT_COLUMNS.map(([, get]) => csvCell(get(r, rate))).join(","));
	if (list.length) {
		const sum = (k) => list.reduce((a, r) => a + (Number(r[k]) || 0), 0);
		const totalInput = sum("inputTokens") + sum("cacheReadTokens");
		const hitPct = totalInput > 0 ? Math.round((sum("cacheReadTokens") / totalInput) * 100) : 0;
		const totals = {
			"调用次数": String(list.length),
			"输入(命中)": fmtNum(sum("cacheReadTokens")),
			"输入(未命中)": fmtNum(sum("inputTokens")),
			"命中%": hitPct + "%",
			"输出": fmtNum(sum("outputTokens")),
			"推理": fmtNum(sum("reasoningTokens")),
			"总额": fmtNum(sum("totalTokens")),
			"金额（人民币）": fmtCostCnyExact(sum("cost"), rate),
		};
		lines.push(EXPORT_COLUMNS.map(([title]) => {
			if (title === "提供商") return csvCell("合计(" + list.length + " 条调用)");
			return csvCell(totals[title] === undefined ? "" : totals[title]);
		}).join(","));
	}
	return lines.join("\r\n");
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

// ---------- 图表统计（纯 CSS/SVG，无第三方图表库：视图由外壳直接渲染，依赖越少越稳） ----------
// 调色板按索引取色，循环使用；按值降序分配，颜色与排名绑定而不是与名字绑定。
const CHART_COLORS = ["#60a5fa", "#fbbf24", "#4ade80", "#f472b6", "#a78bfa", "#fb923c", "#2dd4bf", "#e879f9", "#94a3b8", "#f87171"];
function chartColor(i) { return CHART_COLORS[i % CHART_COLORS.length]; }
const CHART_METRICS = [
	["totalTokens", "总 Token", (v) => fmtCompact(v)],
	["calls", "调用次数", (v) => fmtNum(v)],
	["cost", "金额", (v, rate) => fmtCostCny(v, rate)],
	["outputTokens", "输出 Token", (v) => fmtCompact(v)],
];
const CHART_DIMS = [
	["model", "模型"],
	["provider", "提供商"],
	["status", "状态"],
	["effort", "推理强度"],
];
function emptyAgg() {
	return { calls: 0, totalTokens: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, cost: 0, llmMs: 0, timed: 0 };
}
function addToAgg(a, r) {
	a.calls += 1;
	a.totalTokens += Number(r.totalTokens) || 0;
	a.outputTokens += Number(r.outputTokens) || 0;
	a.inputTokens += Number(r.inputTokens) || 0;
	a.cacheReadTokens += Number(r.cacheReadTokens) || 0;
	a.reasoningTokens += Number(r.reasoningTokens) || 0;
	a.cost += Number(r.cost) || 0;
	if (typeof r.llmMs === "number") { a.llmMs += r.llmMs; a.timed += 1; }
}
/** records → [{key, ...agg}]，按 metric 降序。 */
function groupByKey(records, keyFn, metric) {
	const map = new Map();
	for (const r of records) {
		const k = keyFn(r);
		let a = map.get(k);
		if (!a) { a = emptyAgg(); a.key = k; map.set(k, a); }
		addToAgg(a, r);
	}
	return [...map.values()].sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
}

/** 环形占比图：SVG conic 扇区 + 中央合计 + 图例（最多 8 项，其余并入「其他」）。 */
function DonutChart({ items, metric, metricFmt, rate, centerLabel, emptyText }) {
	const total = items.reduce((s, it) => s + (Number(it[metric]) || 0), 0);
	if (!items.length || total <= 0) return <div className="dtok-chart-empty">{emptyText || "暂无数据"}</div>;
	const shown = items.slice(0, 8);
	const restSum = items.slice(8).reduce((s, it) => s + (Number(it[metric]) || 0), 0);
	if (restSum > 0) {
		const restAgg = Object.assign(emptyAgg(), { key: "其他(" + (items.length - 8) + "项)" });
		restAgg[metric] = restSum;
		shown.push(restAgg);
	}
	const R = 15.9155; // 周长 100 的半径
	let acc = 0;
	const segs = shown.map((it, i) => {
		const v = Number(it[metric]) || 0;
		const frac = v / total;
		const seg = (
			<circle key={it.key} cx="21" cy="21" r={R} fill="none"
				stroke={chartColor(i)} strokeWidth={frac > 0.02 ? 7 : 5}
				strokeDasharray={(frac * 100) + " " + (100 - frac * 100)}
				strokeDashoffset={String(25 - acc * 100)}>
				<title>{it.key + "：" + metricFmt(v, rate) + "（" + (frac * 100).toFixed(1) + "%）"}</title>
			</circle>
		);
		acc += frac;
		return seg;
	});
	return (
		<div className="dtok-donut-wrap">
			<svg className="dtok-donut" viewBox="0 0 42 42" role="img">
				<circle cx="21" cy="21" r={R} fill="none" stroke="var(--dsw-alias-border-l1)" strokeWidth="7" />
				{segs}
				<text x="21" y="19.5" textAnchor="middle" className="dtok-donut-v">{metricFmt(total, rate)}</text>
				<text x="21" y="26" textAnchor="middle" className="dtok-donut-l">{centerLabel}</text>
			</svg>
			<div className="dtok-legend">
				{shown.map((it, i) => {
					const v = Number(it[metric]) || 0;
					return (
						<div className="dtok-legend-row" key={it.key} title={it.key}>
							<span className="dtok-dot" style={{ background: chartColor(i) }} />
							<span className="dtok-legend-k">{it.key}</span>
							<span className="dtok-legend-v">{metricFmt(v, rate)} · {(v / total * 100).toFixed(1)}%</span>
						</div>
					);
				})}
			</div>
		</div>
	);
}

/** 横向条形图：行 = 分组（默认模型），条长 = 指标值（默认耗时）。 */
function HBarChart({ items, metric, metricFmt, rate, maxRows, emptyText }) {
	if (!items.length) return <div className="dtok-chart-empty">{emptyText || "暂无数据"}</div>;
	const shown = items.slice(0, maxRows || 12);
	const max = Math.max(...shown.map((it) => Number(it[metric]) || 0), 1e-9);
	return (
		<div className="dtok-hbars">
			{shown.map((it, i) => {
				const v = Number(it[metric]) || 0;
				const pct = Math.max(1.5, (v / max) * 100);
				return (
					<div className="dtok-hbar-row" key={it.key} title={it.key + "：" + metricFmt(v, rate)}>
						<span className="dtok-hbar-k">{it.key}</span>
						<span className="dtok-hbar-track">
							<span className="dtok-hbar-fill" style={{ width: pct + "%", background: chartColor(i) }} />
						</span>
						<span className="dtok-hbar-v">{metricFmt(v, rate)}</span>
					</div>
				);
			})}
		</div>
	);
}

/** 24 小时调用分布柱状图：柱高 = 指标值，hover 显示具体数值。 */
function HourChart({ hours, metric, metricFmt, rate, emptyText }) {
	const total = hours.reduce((s, h) => s + (Number(h[metric]) || 0), 0);
	if (total <= 0) return <div className="dtok-chart-empty">{emptyText || "暂无数据"}</div>;
	const max = Math.max(...hours.map((h) => Number(h[metric]) || 0), 1e-9);
	return (
		<div className="dtok-hours" role="img">
			{hours.map((h) => {
				const v = Number(h[metric]) || 0;
				const pct = v > 0 ? Math.max(2, (v / max) * 100) : 0;
				return (
					<span key={h.hour} className="dtok-hour-col" title={h.hour + " 时：" + metricFmt(v, rate)}>
						{pct > 0 ? <span className="dtok-hour-bar" style={{ height: pct + "%" }} /> : null}
					</span>
				);
			})}
		</div>
	);
}

/** 图表统计区：所有图都基于「当前筛选结果 records」客户端聚合，筛选一变图表即时联动。
 *  scope = "range"（整个时间范围）| "today"（records 里属于今天的部分）。 */
function ChartsPanel({ records, rate }) {
	const [metric, setMetric] = useState("totalTokens");
	const [dim, setDimLocal] = useState("model");
	const metricDef = CHART_METRICS.find((m) => m[0] === metric) || CHART_METRICS[0];
	const metricFmt = metricDef[2];
	const todayRecs = useMemo(() => {
		const t0 = startOfToday();
		return records.filter((r) => Number(r.time) >= t0);
	}, [records]);
	const todayByModel = useMemo(() => groupByKey(todayRecs, (r) => r.model || "(未知)", metric), [todayRecs, metric]);
	const byDim = useMemo(() => groupByKey(records, (r) => r[dim] || "(空)", metric), [records, dim, metric]);
	const modelTime = useMemo(() => groupByKey(records, (r) => r.model || "(未知)", "llmMs"), [records]);
	const timedCalls = useMemo(() => records.reduce((s, r) => s + (typeof r.llmMs === "number" ? 1 : 0), 0), [records]);
	const hours = useMemo(() => {
		const arr = [];
		for (let h = 0; h < 24; h++) { const a = emptyAgg(); a.hour = h; arr.push(a); }
		for (const r of records) addToAgg(arr[hourOf(r.time)], r);
		return arr;
	}, [records]);
	return (
		<div className="dtok-charts">
			<div className="dtok-chart-toolbar">
				<span className="dtok-chart-toolbar-label">指标</span>
				{CHART_METRICS.map(([id, label]) => (
					<button key={id} className={"dtok-btn tiny" + (metric === id ? " primary" : "")} onClick={() => setMetric(id)}>{label}</button>
				))}
				<span className="dtok-chart-toolbar-note">图表跟随上方筛选条件（时间 / 会话 / 提供商 / 模型 / 状态 / 强度）实时联动</span>
			</div>
			<div className="dtok-chart-grid">
				<div className="dtok-chart-card">
					<div className="dtok-chart-title">今日模型用量占比<span className="dtok-chart-sub">{metricDef[1]} · {todayRecs.length} 次调用</span></div>
					<DonutChart items={todayByModel} metric={metric} metricFmt={metricFmt} rate={rate} centerLabel={"今日" + metricDef[1]} emptyText="今日暂无调用" />
				</div>
				<div className="dtok-chart-card">
					<div className="dtok-chart-title">24 小时调用分布<span className="dtok-chart-sub">按小时聚合 · {metricDef[1]}</span></div>
					<HourChart hours={hours} metric={metric} metricFmt={metricFmt} rate={rate} />
				</div>
				<div className="dtok-chart-card">
					<div className="dtok-chart-title">模型耗时排行<span className="dtok-chart-sub">累计 LLM 耗时 · 已计时 {timedCalls} 次</span></div>
					<HBarChart items={modelTime} metric="llmMs" metricFmt={(v) => fmtDurCompact(v)} rate={rate} emptyText="暂无计时数据" />
				</div>
				<div className="dtok-chart-card">
					<div className="dtok-chart-title">
						分布统计
						<span className="dtok-chart-sub">
							{CHART_DIMS.map(([id, label]) => (
								<button key={id} className={"dtok-btn tiny" + (dim === id ? " primary" : "")} style={{ marginLeft: 4 }} onClick={() => setDimLocal(id)}>{label}</button>
							))}
						</span>
					</div>
					<HBarChart items={byDim} metric={metric} metricFmt={metricFmt} rate={rate} />
				</div>
			</div>
		</div>
	);
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
.dtok-btn.primary{background:var(--dk-accent);border-color:var(--dk-accent);color:#fff;}
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
.dtok-table td{padding:6px 10px;border-bottom:1px solid var(--dk-tdim);}
.dtok-table tr:hover td{background:var(--dk-hover-tint);}
.dtok-empty{text-align:center;color:var(--dsw-alias-label-secondary);padding:32px 0;font-size:13px;}
.dtok-sid{color:var(--dk-accent);cursor:pointer;text-decoration:underline dotted;}
.dtok-sid:hover{filter:brightness(1.25);}
.dtok-code{font-weight:700;font-family:ui-monospace,monospace;}
.dtok-code.ok{color:var(--dsw-alias-state-success-primary,#4ade80);}
.dtok-code.warn{color:var(--dk-warn);}
.dtok-code.err{color:var(--dsw-alias-state-error-primary,#f87171);}
.dtok-code.pend{color:var(--dsw-alias-label-tertiary,#94a3b8);}
.dtok-detail-link{color:var(--dk-accent);cursor:pointer;font-size:11px;}
.dtok-detail-link:hover{text-decoration:underline;}
.dtok-detail{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;}
.dtok-detail-card{background:var(--dsw-alias-bg-layer-2,#1c212b);border:1px solid var(--dsw-alias-border-l2,#3a4150);border-radius:12px;padding:20px 24px;max-width:640px;width:92%;max-height:80vh;overflow:auto;color:var(--dsw-alias-label-primary,#e8eaf0);}
.dtok-detail-card h3{margin:0 0 12px;font-size:15px;}
.dtok-detail-row{display:flex;gap:8px;padding:4px 0;font-size:12px;border-bottom:1px solid var(--dk-tdim);}
.dtok-detail-row .k{color:var(--dsw-alias-label-secondary,#9aa3b5);min-width:110px;flex-shrink:0;}
.dtok-detail-row .v{word-break:break-all;}
.dtok-sort-mark{opacity:0.6;margin-left:3px;}
.dtok-pager{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dtok-pager.top{margin:0;}
.dtok-pager.bottom{margin:0;}
.dtok-err{color:var(--dsw-alias-state-error-primary,#ff7a7a);font-size:12px;}
/* ---- 查询加载动画 ----
   数据量大时「查询」要等好几秒，旧版只有一行「加载中…」：用户既不确定点上没点上，
   也不知道数据什么时候换掉。这里用一段有趣的「记账小队清点」动画填满等待，并在结果
   真正到位时给一次「✓ 数据已更新」+ KPI 卡回弹，让「数据变了」这件事被看见。 */
.dtok-btn{transition:transform .08s ease,background .15s ease,filter .15s ease,border-color .15s ease;}
.dtok-btn.primary:not([disabled]):active{transform:scale(.95);}
.dtok-btn.loading{position:relative;overflow:hidden;opacity:1;cursor:progress;border-color:var(--dk-accent);}
.dtok-btn.loading::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;background:linear-gradient(100deg,transparent 18%,rgb(255 255 255 / .4) 50%,transparent 82%);transform:translateX(-130%);animation:dtok-btn-sheen 1.05s linear infinite;}
@keyframes dtok-btn-sheen{to{transform:translateX(130%);}}
.dtok-spin{display:inline-block;width:10px;height:10px;margin-right:5px;vertical-align:-1px;border:2px solid rgb(255 255 255 / .35);border-top-color:#fff;border-radius:50%;animation:dtok-rotate .7s linear infinite;}
.dtok-spin.inline{width:9px;height:9px;margin:0;vertical-align:0;border-color:rgb(127 127 127 / .35);border-top-color:var(--dk-accent);}
@keyframes dtok-rotate{to{transform:rotate(360deg);}}
/* 状态行里的「⟳ 加载中...」：转圈 + 省略号一个一个蹦出来，最经典的那种加载动画 */
.dtok-busy{display:inline-flex;align-items:center;gap:5px;}
.dtok-dots{display:inline-block;width:12px;text-align:left;}
.dtok-dots i{font-style:normal;opacity:0;animation:dtok-dot 1.2s linear infinite;}
.dtok-dots i:nth-child(2){animation-delay:.2s;}
.dtok-dots i:nth-child(3){animation-delay:.4s;}
@keyframes dtok-dot{0%{opacity:0;}25%,80%{opacity:1;}100%{opacity:0;}}
.dtok-body-inner{display:flex;flex-direction:column;gap:8px;min-width:0;transition:opacity .25s ease;}
.dtok-body-inner.busy{opacity:.45;pointer-events:none;}
.dtok-loading{position:sticky;top:0;z-index:6;display:flex;align-items:center;flex-wrap:wrap;gap:10px 12px;padding:9px 14px;border-radius:12px;border:1px solid var(--dk-accent);background:linear-gradient(180deg,rgb(255 255 255 / .07),rgb(0 0 0 / .1)),var(--dsw-alias-bg-layer-2,#1c212b);box-shadow:0 10px 26px rgb(0 0 0 / .3);animation:dtok-load-in .3s ease;}
@keyframes dtok-load-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
.dtok-load-scene{position:relative;display:flex;align-items:flex-end;gap:1px;height:30px;flex:none;padding:0 6px;}
.dtok-load-emoji{display:inline-block;font-size:19px;line-height:1;animation:dtok-hop 1.1s cubic-bezier(.36,.07,.19,.97) infinite;filter:drop-shadow(0 2px 3px rgb(0 0 0 / .3));}
.dtok-load-emoji.e2{animation-delay:.15s;}
.dtok-load-emoji.e3{animation-delay:.3s;}
@keyframes dtok-hop{0%,100%{transform:translateY(0) rotate(-5deg);}35%{transform:translateY(-9px) rotate(2deg) scale(1.1);}65%{transform:translateY(0) rotate(5deg);}}
.dtok-load-spark{position:absolute;font-size:11px;color:var(--dk-accent);animation:dtok-twinkle 1.4s ease-in-out infinite;}
.dtok-load-spark.s1{left:-2px;top:-4px;}
.dtok-load-spark.s2{right:-2px;top:2px;animation-delay:.6s;}
@keyframes dtok-twinkle{0%,100%{opacity:0;transform:scale(.4) rotate(0);}45%{opacity:1;transform:scale(1.2) rotate(90deg);}}
.dtok-load-msg{flex:1 1 170px;min-width:0;display:flex;flex-direction:column;gap:2px;}
.dtok-load-msg b{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(90deg,var(--dsw-alias-label-primary),var(--dk-accent),var(--dsw-alias-label-primary));background-size:220% 100%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:dtok-shine 2.6s linear infinite,dtok-msg-in .32s ease;}
@keyframes dtok-shine{0%{background-position:130% 0;}100%{background-position:-130% 0;}}
@keyframes dtok-msg-in{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
.dtok-load-sub{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dtok-load-sub.wait{color:var(--dk-warn);}
.dtok-load-track{position:relative;flex:0 1 140px;min-width:88px;height:6px;border-radius:999px;background:rgb(127 127 127 / .22);overflow:hidden;}
.dtok-load-fill{position:absolute;top:0;bottom:0;width:38%;border-radius:999px;background:linear-gradient(90deg,transparent,var(--dk-accent),transparent);animation:dtok-sweep 1.15s cubic-bezier(.45,.05,.55,.95) infinite;}
@keyframes dtok-sweep{0%{transform:translateX(-115%);}100%{transform:translateX(380%);}}
.dtok-cards.dtok-pop .dtok-card{animation:dtok-card-in .5s cubic-bezier(.2,.9,.3,1.3) both;animation-delay:calc(var(--i,0) * 45ms);}
@keyframes dtok-card-in{from{opacity:0;transform:translateY(7px) scale(.96);}to{opacity:1;transform:none;}}
.dtok-updated{font-size:11px;color:var(--dsw-alias-state-success-primary,#4ade80);animation:dtok-updated 2.4s ease forwards;}
@keyframes dtok-updated{0%{opacity:0;transform:translateY(-3px) scale(.85);}12%{opacity:1;transform:none;}70%{opacity:1;}100%{opacity:0;}}
@media (prefers-reduced-motion:reduce){
.dtok-load-emoji,.dtok-load-spark,.dtok-load-fill,.dtok-load-msg b,.dtok-btn.loading::after,.dtok-spin,.dtok-loading,.dtok-cards.dtok-pop .dtok-card{animation:none !important;}
.dtok-dots i{animation:none !important;opacity:1;}
.dtok-load-emoji{transform:none;}
.dtok-body-inner.busy{opacity:.75;}
.dtok-btn.primary:not([disabled]):active{transform:none;}
}
/* ---- 单价设置（子弹窗） ---- */
.dtok-pm-backdrop{position:fixed;inset:0;z-index:2100;background:rgba(15,17,21,.5);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;}
.dtok-pm{box-sizing:border-box;width:min(980px,calc(100vw - 32px));height:min(760px,calc(100vh - 32px));display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2,#1c212b);color:var(--dsw-alias-label-primary);box-shadow:0 20px 64px rgb(0 0 0 / .4);overflow:hidden;}
.dtok-pm.max{border-radius:10px;}
.dtok-pm-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:move;user-select:none;flex:none;background:var(--dsw-alias-bg-layer-1);}
.dtok-pm.max .dtok-pm-head{cursor:default;}
.dtok-pm-head b{font-size:14px;}
.dtok-pm-sub{font-size:11px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dtok-pm-ctrls{display:flex;gap:6px;flex:none;}
.dtok-pm-body{flex:1;min-height:0;overflow-y:auto;padding:12px 14px;}
.dtok-pm-resize{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;touch-action:none;}
.dtok-pm{position:relative;}
/* ---- 单价设置（表单内容） ---- */
.dtok-price{display:flex;flex-direction:column;gap:12px;}
.dtok-price-grid{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;}
.dtok-price-field{display:flex;flex-direction:column;gap:3px;}
.dtok-price-field label{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dtok-price-num{width:92px;}
.dtok-price input[type="text"],.dtok-price-num{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 6px;font-size:12px;font-family:inherit;}
.dtok-price .dtok-btn.tiny{padding:2px 8px;font-size:11px;}
.dtok-price-msg{font-size:12px;}
.dtok-price-msg.ok{color:var(--dsw-alias-state-success-primary,#4ade80);}
.dtok-price-msg.err{color:var(--dsw-alias-state-error-primary,#ff7a7a);}
.dtok-price-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.6;}
.dtok-prow{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;margin-bottom:8px;background:var(--dsw-alias-bg-layer-1);}
.dtok-prow-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;}
.dtok-pseg{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0;}
.dtok-pseg-name{font-size:11px;color:var(--dsw-alias-label-secondary);min-width:112px;}
.dtok-pseg-tilde{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dtok-src{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);}
.dtok-src.custom{color:var(--dsw-alias-state-success-primary,#4ade80);}
.dtok-src.fallback{color:var(--dk-warn);}
/* ---- 图表统计（纯 CSS/SVG） ---- */
.dtok-charts{display:flex;flex-direction:column;gap:10px;min-width:0;}
.dtok-chart-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}
.dtok-chart-toolbar-label{font-size:12px;color:var(--dsw-alias-label-secondary);flex:none;}
.dtok-chart-toolbar-note{font-size:11px;color:var(--dsw-alias-label-tertiary,#94a3b8);margin-left:auto;}
.dtok-chart-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px;}
.dtok-chart-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px;min-width:0;display:flex;flex-direction:column;gap:8px;}
.dtok-chart-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dtok-chart-sub{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary);}
.dtok-chart-empty{text-align:center;color:var(--dsw-alias-label-secondary);padding:28px 0;font-size:12px;}
.dtok-donut-wrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap;}
.dtok-donut{width:150px;height:150px;flex:none;}
.dtok-donut-v{font-size:6.5px;font-weight:700;fill:var(--dsw-alias-label-primary);}
.dtok-donut-l{font-size:3.6px;fill:var(--dsw-alias-label-secondary);}
.dtok-legend{flex:1;min-width:150px;display:flex;flex-direction:column;gap:3px;max-height:170px;overflow:auto;}
.dtok-legend-row{display:flex;align-items:center;gap:6px;font-size:11px;min-width:0;}
.dtok-dot{width:8px;height:8px;border-radius:50%;flex:none;}
.dtok-legend-k{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}
.dtok-legend-v{color:var(--dsw-alias-label-secondary);margin-left:auto;flex:none;}
.dtok-hbars{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;}
.dtok-hbar-row{display:flex;align-items:center;gap:8px;font-size:11px;min-width:0;}
.dtok-hbar-k{flex:0 1 34%;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dtok-hbar-track{flex:1;height:12px;border-radius:4px;background:rgb(127 127 127 / .16);overflow:hidden;min-width:40px;}
.dtok-hbar-fill{display:block;height:100%;border-radius:4px;transition:width .3s ease;}
.dtok-hbar-v{flex:none;color:var(--dsw-alias-label-secondary);min-width:52px;text-align:right;}
.dtok-hours{display:flex;align-items:flex-end;gap:3px;height:130px;padding-top:4px;}
.dtok-hour-col{flex:1;display:flex;align-items:flex-end;height:100%;min-width:0;}
.dtok-hour-bar{display:block;width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,var(--dk-accent),rgb(127 127 127 / .25));min-height:2px;transition:height .3s ease;}
.dtok-hour-col:hover .dtok-hour-bar{filter:brightness(1.3);}
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
		["输入 Token(缓存命中)", fmtNum(rec.cacheReadTokens)],
		["输入 Token(缓存未命中)", fmtNum(rec.inputTokens)],
		["输出 Token", fmtNum(rec.outputTokens)],
		["缓存写入 Token", fmtNum(rec.cacheWriteTokens)],
		["推理 Token", fmtNum(rec.reasoningTokens)],
		["计费输入", fmtNum(rec.billedInput)],
		["缓存命中率", rec.cacheHitPercent + "%"],
		["总 Token", fmtNum(rec.totalTokens)],
		["消耗金额(估算)", fmtCostCny(rec.cost, rateCny)],
		["计价来源", rec.pricingSource ? ({ custom: "自定义单价", official: "官网同步价", builtin: "内置默认价", fallback: "兜底单价" }[rec.pricingSource] || rec.pricingSource) : "—"],
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

// ---------- 单价设置 ----------
// 官网抓取的刊例价常与实际计费不符（第三方中转/折扣/自建端点），这里让用户按模型填写
// 真实单价并持久化到宿主 settings；保存后费用即时按新价重算（无需重扫历史）。
// 独立子弹窗（可最大化 / 拖动 / 缩放），与功能坞面板解耦，方便配置较长时段表。
function numStr(v) { return v === undefined || v === null ? "" : String(v); }

/** 时段草稿：一个 { start,end,input,output,cacheRead,cacheWrite } 的可编辑副本。 */
function segToDraft(s) {
	return {
		start: numStr(s && s.start), end: numStr(s && s.end),
		input: numStr(s && s.input), output: numStr(s && s.output),
		cacheRead: numStr(s && s.cacheRead), cacheWrite: numStr(s && s.cacheWrite),
	};
}
function rowToDraft(r) {
	return {
		match: r.match || "",
		input: numStr(r.input), output: numStr(r.output),
		cacheRead: numStr(r.cacheRead), cacheWrite: numStr(r.cacheWrite),
		// 旧数据可能是单段 peak（宿主已归一为 peaks，这里再兼容一次直连旧宿主的情况）
		peaks: (Array.isArray(r.peaks) && r.peaks.length ? r.peaks
			: (r.peak && typeof r.peak === "object" ? [r.peak] : [])).map(segToDraft),
	};
}
/** 默认新时段草稿：给一组常见值，减少手填。 */
function newSegDraft() { return segToDraft({ start: 9, end: 14, input: "", output: "", cacheRead: "", cacheWrite: "" }); }

// ---------- 单价设置子弹窗（独立于功能坞弹层的覆盖层，可最大化/拖动/缩放） ----------
// 挂在 document.body 上：功能坞弹层自身 z-index:200，子弹窗用更高层级；面板滚动不影响定位。
function PriceModal({ onClose, onSaved }) {
	const [maxed, setMaxed] = useState(false);
	const [geom, setGeom] = useState(null); // { x, y, w, h }；null = CSS 默认居中
	const dlgRef = useRef(null);
	const dragRef = useRef(null);

	// 拖动（标题栏）/ 缩放（右下角手柄）：用 window 级 pointer 监听，指针移出元素也不丢
	const startDrag = useCallback((e, kind) => {
		if (e.button !== undefined && e.button !== 0) return;
		if (kind === "move" && e.target && e.target.closest && e.target.closest("button,select,input,label,details,summary")) return;
		const node = dlgRef.current;
		if (!node) return;
		const rect = node.getBoundingClientRect();
		dragRef.current = { kind, startX: e.clientX, startY: e.clientY, left: rect.left, top: rect.top, w: rect.width, h: rect.height };
		if (e.preventDefault) e.preventDefault();
	}, []);
	useEffect(() => {
		const onMove = (ev) => {
			const d = dragRef.current;
			if (!d) return;
			const dx = ev.clientX - d.startX, dy = ev.clientY - d.startY;
			const vw = window.innerWidth, vh = window.innerHeight;
			if (d.kind === "move") {
				const x = Math.min(Math.max(0, d.left + dx), Math.max(0, vw - 80));
				const y = Math.min(Math.max(0, d.top + dy), Math.max(0, vh - 40));
				setGeom({ x: x, y: y, w: d.w, h: d.h });
			} else {
				const w = Math.max(560, Math.min(d.w + dx, vw - 16));
				const h = Math.max(360, Math.min(d.h + dy, vh - 16));
				setGeom({ x: d.left, y: d.top, w: w, h: h });
			}
		};
		const onUp = () => { dragRef.current = null; };
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		return () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
		};
	}, []);
	// Esc 关闭（子弹窗在弹层之上，先关自己）
	useEffect(() => {
		const onKey = (e) => { if (e.key === "Escape") onClose(); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	// 遮罩关闭必须「按下也在遮罩上」。
	// 从弹窗内按下、拖选/拖出后在遮罩松开时，click 会派发到共同祖先（遮罩），
	// 若无此标记会把框选误判成点外部关闭（2026-09-23 用户反馈）。
	const backdropDownRef = useRef(false);

	const style = maxed
		? { position: "fixed", left: 8, top: 8, right: 8, bottom: 8, width: "auto", height: "auto" }
		: geom
			? { position: "fixed", left: geom.x, top: geom.y, width: geom.w, height: geom.h }
			: null;
	// 挂到 document.body：功能坞弹层祖先带 backdrop-filter（会改变 fixed 定位的包含块），
	// 设置页祖先也不可控；portal 到 body 才能保证覆盖整屏、不被裁剪。
	// 无 document（测试沙箱）/无 createPortal 时退回就地渲染，行为不变。
	const portalTarget = typeof document !== "undefined" && document.body ? document.body : null;
	const overlay = (
		<div
			className="dtok-pm-backdrop"
			onPointerDown={(e) => { backdropDownRef.current = e.target === e.currentTarget; }}
			onClick={(e) => {
				if (!backdropDownRef.current) return;
				if (e.target !== e.currentTarget) return;
				onClose();
			}}
		>
			<div ref={dlgRef} className={"dtok-pm" + (maxed ? " max" : "")} style={style} onClick={(e) => e.stopPropagation()}>
				<div className="dtok-pm-head" onPointerDown={(e) => startDrag(e, "move")} onDoubleClick={() => setMaxed((v) => !v)}>
					<b>单价设置</b>
					<span className="dtok-pm-sub">人民币元 / 百万 tokens · 自定义单价优先于官网价与内置价</span>
					<span className="dtok-pm-ctrls">
						<button type="button" className="dtok-btn tiny" title={maxed ? "还原" : "最大化"} onClick={() => setMaxed((v) => !v)}>{maxed ? "❐" : "▢"}</button>
						<button type="button" className="dtok-btn tiny" title="关闭" onClick={onClose}>✕</button>
					</span>
				</div>
				<div className="dtok-pm-body">
					<PricingEditor onClose={onClose} onSaved={onSaved} embedded />
				</div>
				{maxed ? null : <div className="dtok-pm-resize" title="拖动缩放" onPointerDown={(e) => startDrag(e, "resize")} />}
			</div>
		</div>
	);
	return portalTarget && typeof react.createPortal === "function"
		? react.createPortal(overlay, portalTarget)
		: overlay;
}

function PricingEditor({ onClose, onSaved, embedded }) {
	const [cfg, setCfg] = useState(null);
	const [rows, setRows] = useState([]);
	const [rate, setRate] = useState("7.2");
	const [fetchOn, setFetchOn] = useState(true);
	const [fb, setFb] = useState({ input: "", output: "", cacheRead: "", cacheWrite: "" });
	const [newMatch, setNewMatch] = useState("");
	const [msg, setMsg] = useState(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		let cancel = false;
		rpcCall("pricing", {})
			.then((d) => {
				if (cancel) return;
				setCfg(d);
				setRate(numStr(d.usdCnyRate));
				setFetchOn(!!d.fetchOfficial);
				setFb({
					input: numStr(d.fallback && d.fallback.input), output: numStr(d.fallback && d.fallback.output),
					cacheRead: numStr(d.fallback && d.fallback.cacheRead), cacheWrite: numStr(d.fallback && d.fallback.cacheWrite),
				});
				setRows((d.pricing || []).map(rowToDraft));
			})
			.catch((e) => { if (!cancel) setMsg({ ok: false, text: String((e && e.message) || e) }); });
		return () => { cancel = true; };
	}, []);

	const patchRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? Object.assign({}, r, patch) : r)));
	const delRow = (i) => setRows((rs) => rs.filter((_, j) => j !== i));
	// 时段增删改：都作用在 rows[i].peaks 数组上
	const addSeg = (i) => setRows((rs) => rs.map((r, j) => (j === i ? Object.assign({}, r, { peaks: r.peaks.concat([newSegDraft()]) }) : r)));
	const delSeg = (i, k) => setRows((rs) => rs.map((r, j) => (j === i ? Object.assign({}, r, { peaks: r.peaks.filter((_, x) => x !== k) }) : r)));
	const patchSeg = (i, k, patch) => setRows((rs) => rs.map((r, j) => (j === i
		? Object.assign({}, r, { peaks: r.peaks.map((s, x) => (x === k ? Object.assign({}, s, patch) : s)) }) : r)));
	const addRow = (m) => {
		const match = String(m === undefined ? newMatch : m).trim();
		if (!match) return;
		if (rows.some((r) => r.match.toLowerCase() === match.toLowerCase())) { setMsg({ ok: false, text: "「" + match + "」已存在" }); return; }
		setRows((rs) => rs.concat([rowToDraft({ match: match, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })]));
		setNewMatch("");
		setMsg(null);
	};

	const save = () => {
		if (saving) return;
		const payload = { usdCnyRate: Number(rate), fetchOfficial: fetchOn };
		payload.pricing = rows.map((r) => {
			const out = {
				match: String(r.match || "").trim(),
				input: Number(r.input || 0), output: Number(r.output || 0),
				cacheRead: Number(r.cacheRead || 0), cacheWrite: Number(r.cacheWrite || 0),
			};
			const peaks = (r.peaks || []).map((s) => ({
				start: Number(s.start || 0), end: Number(s.end || 0),
				input: Number(s.input || 0), output: Number(s.output || 0),
				cacheRead: Number(s.cacheRead || 0), cacheWrite: Number(s.cacheWrite || 0),
			}));
			if (peaks.length) out.peaks = peaks;
			return out;
		});
		payload.fallback = {
			input: Number(fb.input || 0), output: Number(fb.output || 0),
			cacheRead: Number(fb.cacheRead || 0), cacheWrite: Number(fb.cacheWrite || 0),
		};
		setSaving(true); setMsg(null);
		rpcCall("setpricing", payload)
			.then((d) => {
				setCfg(d);
				setRows((d.pricing || []).map(rowToDraft));
				setMsg({ ok: true, text: "单价已保存，费用已按新价即时重算" });
				if (onSaved) onSaved();
			})
			.catch((e) => setMsg({ ok: false, text: String((e && e.message) || e) }))
			.finally(() => setSaving(false));
	};

	const configured = rows.map((r) => String(r.match).toLowerCase());
	const candidates = ((cfg && cfg.models) || []).filter((m) => configured.indexOf(String(m).toLowerCase()) < 0);
	const srcOf = (m) => (cfg && cfg.sourcesByModel && cfg.sourcesByModel[m]) || "";
	// 哪些已用模型当前走兜底价——提示用户优先补这些
	const onFallback = ((cfg && cfg.models) || []).filter((m) => srcOf(m) === "兜底");
	const num = (value, onChange, extra) => (
		<input className="dtok-price-num" type="number" min="0" step="0.01" value={value} onChange={(e) => onChange(e.target.value)} style={extra} />
	);
	// 时段价输入带占位提示（四个数值框从左到右含义不同，仅靠下方说明易填错）
	const segNum = (value, onChange, placeholder) => (
		<input className="dtok-price-num" type="number" min="0" step="0.01" value={value} placeholder={placeholder}
			onChange={(e) => onChange(e.target.value)} style={{ width: 80 }} />
	);
	const segLabel = (s) => {
		const a = numStr(s.start), b = numStr(s.end);
		if (a === "" || b === "") return "时段";
		return a + "~" + b + (Number(a) === Number(b) ? "（全天）" : Number(a) > Number(b) ? "（跨零点）" : "");
	};

	return (
		<div className={embedded ? "dtok-price emb" : "dtok-price"} onClick={(e) => e.stopPropagation()}>
			<div className="dtok-price-grid">
				<div className="dtok-price-field">
					<label>USD→CNY 汇率</label>
					{num(rate, setRate)}
				</div>
				<label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
					<input type="checkbox" checked={fetchOn} onChange={(e) => setFetchOn(e.target.checked)} />
					官网价目自动同步（关闭后仅用自定义/内置价）
				</label>
			</div>

			<div>
				<div className="dtok-section-title" style={{ margin: "0 0 4px" }}>按模型配置单价（{rows.length} 条）</div>
				{onFallback.length > 0 ? (
					<div className="dtok-price-hint">以下用过的模型当前走「兜底价」，建议优先补单价：{onFallback.join("、")}</div>
				) : null}
				{rows.length === 0 ? (
					<div className="dtok-price-hint">尚未配置自定义单价，当前使用官网同步价 / 内置价 / 兜底价。</div>
				) : rows.map((r, i) => (
					<div className="dtok-prow" key={i}>
						<div className="dtok-prow-head">
							<input className="dtok-input" style={{ maxWidth: 240 }} type="text" value={r.match} placeholder="模型匹配（子串）" onChange={(e) => patchRow(i, { match: e.target.value })} />
							<span className={"dtok-src " + (srcOf(r.match) === "自定义" ? "custom" : srcOf(r.match) === "兜底" ? "fallback" : "")}>当前来源：{srcOf(r.match) || "—"}</span>
							<button className="dtok-btn tiny" onClick={() => delRow(i)}>删除模型</button>
						</div>
						<div className="dtok-price-grid">
							<div className="dtok-price-field"><label>基准输入（缓存命中）</label>{num(r.cacheRead, (v) => patchRow(i, { cacheRead: v }))}</div>
							<div className="dtok-price-field"><label>基准输入（缓存未命中）</label>{num(r.input, (v) => patchRow(i, { input: v }))}</div>
							<div className="dtok-price-field"><label>基准输出</label>{num(r.output, (v) => patchRow(i, { output: v }))}</div>
							<div className="dtok-price-field"><label>基准缓存写入</label>{num(r.cacheWrite, (v) => patchRow(i, { cacheWrite: v }))}</div>
						</div>
						<div className="dtok-price-hint" style={{ marginTop: 2 }}>
							缓存写入＝未命中缓存、本次新建缓存的那部分输入（Claude 等按溢价单独收建缓存费）；DeepSeek 不收此项，填 0 即可。
						</div>
						<div className="dtok-price-hint" style={{ marginTop: 2 }}>
							分时段价（可多段，命中哪段用哪段；时段外回落到基准价。start&gt;end 表示跨零点，如 23~7；start=end 表示全天）
						</div>
						{r.peaks.length === 0 ? <div className="dtok-price-hint">（未设置分时段，按基准价计费）</div> : null}
						{r.peaks.map((s, k) => (
							<div className="dtok-pseg" key={k}>
								<span className="dtok-pseg-name">{segLabel(s)}</span>
								{num(s.start, (v) => patchSeg(i, k, { start: v }), { width: 56 })}
								<span className="dtok-pseg-tilde">~</span>
								{num(s.end, (v) => patchSeg(i, k, { end: v }), { width: 56 })}
								<span className="dtok-pseg-tilde">时</span>
								{segNum(s.cacheRead, (v) => patchSeg(i, k, { cacheRead: v }), "缓存命中")}
								{segNum(s.input, (v) => patchSeg(i, k, { input: v }), "未命中")}
								{segNum(s.output, (v) => patchSeg(i, k, { output: v }), "输出")}
								{segNum(s.cacheWrite, (v) => patchSeg(i, k, { cacheWrite: v }), "写入")}
								<button className="dtok-btn tiny" onClick={() => delSeg(i, k)}>删除时段</button>
							</div>
						))}
						<div className="dtok-price-hint" style={{ opacity: .85 }}>时段价从左到右：输入（命中）/ 输入（未命中）/ 输出 / 缓存写入</div>
						<button className="dtok-btn tiny" onClick={() => addSeg(i)}>+ 添加时段</button>
					</div>
				))}
				<div className="dtok-price-grid" style={{ marginTop: 6 }}>
					<div className="dtok-price-field" style={{ flex: "0 0 220px" }}>
						<label>新增模型匹配</label>
						<input className="dtok-input" style={{ maxWidth: 220 }} type="text" list="dtok-model-candidates" placeholder="如 deepseek-v4-flash 或某中转模型名" value={newMatch} onChange={(e) => setNewMatch(e.target.value)} />
						<datalist id="dtok-model-candidates">{candidates.map((m) => <option key={m} value={m} />)}</datalist>
					</div>
					<button className="dtok-btn" onClick={() => addRow()}>+ 添加</button>
				</div>
				<div className="dtok-price-hint">提示：匹配是「模型名包含该子串」，可只写关键片段（如 <code>v4-flash</code>）；越具体的条目建议放越前（当前按列表顺序命中）。</div>
			</div>

			<div>
				<div className="dtok-section-title" style={{ margin: "0 0 4px" }}>兜底单价（未匹配任何条目时使用）</div>
				<div className="dtok-price-grid">
					<div className="dtok-price-field"><label>输入（缓存命中）</label>{num(fb.cacheRead, (v) => setFb((s) => Object.assign({}, s, { cacheRead: v })))}</div>
					<div className="dtok-price-field"><label>输入（缓存未命中）</label>{num(fb.input, (v) => setFb((s) => Object.assign({}, s, { input: v })))}</div>
					<div className="dtok-price-field"><label>输出</label>{num(fb.output, (v) => setFb((s) => Object.assign({}, s, { output: v })))}</div>
					<div className="dtok-price-field"><label>缓存写入</label>{num(fb.cacheWrite, (v) => setFb((s) => Object.assign({}, s, { cacheWrite: v })))}</div>
				</div>
			</div>

			{cfg && cfg.builtin && cfg.builtin.length > 0 ? (
				<details>
					<summary className="dtok-price-hint" style={{ cursor: "pointer" }}>查看内置默认单价（{cfg.builtin.length} 条，自定义配置未命中时按此兜底）</summary>
					<div className="dtok-table-wrap" style={{ marginTop: 6 }}>
						<table className="dtok-table">
							<thead><tr><th>匹配</th><th>输入(命中)</th><th>输入(未命中)</th><th>输出</th><th>缓存写入</th><th>分时段</th></tr></thead>
							<tbody>
								{cfg.builtin.map((b) => (
									<tr key={b.match}>
										<td>{b.match}</td><td>{b.cacheRead}</td><td>{b.input}</td><td>{b.output}</td><td>{b.cacheWrite}</td>
										<td>{b.peaks && b.peaks.length ? b.peaks.map((s) => s.start + "~" + s.end).join("、") + "时" : "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</details>
			) : null}

			<div className="dtok-price-grid">
				<button className="dtok-btn primary" disabled={saving} onClick={save}>{saving ? "保存中…" : "保存单价"}</button>
				{msg ? <span className={"dtok-price-msg " + (msg.ok ? "ok" : "err")}>{msg.text}</span> : null}
			</div>
		</div>
	);
}

// ---------- 查询加载动画（数据多时要等几秒，用有梗的画面把等待变得好过一点） ----------
// 每 1.3s 换一句文案；等久了（第 4 句起）语气变一变，顺便给个「数据较多」的安抚。
const LOAD_MSGS = [
	"正在翻开账本",
	"正在一枚一枚数 Token",
	"正在给每条调用贴价签",
	"正在核对缓存命中率",
	"正在把单价乘进每一行",
	"正在把表格码整齐",
];
function LoadingBanner() {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick((t) => t + 1), 1300);
		return () => clearInterval(timer);
	}, []);
	const long = tick >= 4;
	return (
		<div className="dtok-loading" role="status" aria-live="polite">
			<span className="dtok-load-scene" aria-hidden="true">
				<span className="dtok-load-spark s1">✦</span>
				<span className="dtok-load-emoji e1">🧮</span>
				<span className="dtok-load-emoji e2">📒</span>
				<span className="dtok-load-emoji e3">🔍</span>
				<span className="dtok-load-spark s2">✦</span>
			</span>
			<span className="dtok-load-msg">
				<b key={tick}>{LOAD_MSGS[tick % LOAD_MSGS.length]}…</b>
				<span className={"dtok-load-sub" + (long ? " wait" : "")}>
					{long ? "数据较多，再等一小会儿，正在全力清点～" : "正在按当前条件重新统计，通常几秒内完成"}
				</span>
			</span>
			<span className="dtok-load-track" aria-hidden="true"><span className="dtok-load-fill" /></span>
		</div>
	);
}

// ---------- 主视图（嵌入 dock 面板内容区） ----------
export function TokenLogView(props) {
	// props.params.sessionId（chips 点击带入）：立即按该会话筛选并查询。
	// navAt：每次 chip 点击的时间戳——面板已打开时再次点击（即便同一会话）也触发重查。
	const navSession = props && props.params && props.params.sessionId ? props.params.sessionId : null;
	const navAt = props && props.params && props.params.navAt ? props.params.navAt : 0;
	// 挂载即视为「打开」：恢复上次暂存的条件(时间不选=显示全部记录); savedFilters 稳定快照, 仅初始化时读取一次
	const [savedFilters] = useState(loadSavedFilters);
	const [fromStr, setFromStr] = useState(() => (savedFilters && savedFilters.fromStr) || "");
	const [toStr, setToStr] = useState(() => (savedFilters && savedFilters.toStr) || "");
	const [provider, setProvider] = useState(() => (savedFilters && savedFilters.provider) || "");
	const [model, setModel] = useState(() => (savedFilters && savedFilters.model) || "");
	const [status, setStatus] = useState(() => (savedFilters && savedFilters.status) || "");
	const [effort, setEffort] = useState(() => (savedFilters && savedFilters.effort) || "");
	// 会话入口（chip/深链）带入的 sessionId 优先于暂存条件：下拉框初值即选中该会话
	const [sessionId, setSessionId] = useState(() => navSession || (savedFilters && savedFilters.sessionId) || "");
	const [dim, setDim] = useState(() => (savedFilters && savedFilters.dim) || "");
	const [sortKey, setSortKey] = useState("time");
	const [sortDir, setSortDir] = useState("desc");
	const [data, setData] = useState(null);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState("");
	const [page, setPage] = useState(0);
	const [detailRec, setDetailRec] = useState(null);
	// 「单价设置」折叠面板：默认收起（费用不准确时才需要展开调整）
	// 「单价设置」子弹窗：默认收起；支持经 params.openPricing 直接打开（深链/测试用）
	const [showPricing, setShowPricing] = useState(() => !!(props && props.params && props.params.openPricing));
	// 明细 | 图表 页签：图表全部基于当前筛选结果客户端聚合，不额外发请求。
	// params.charts 支持深链/测试直接落在图表页签。
	const [tab, setTab] = useState(() => (props && props.params && props.params.charts) ? "charts" : "detail");
	// 查询完成信号：loading 由 true→false 时记一次时间戳，用于「✓ 数据已更新」提示与 KPI 卡回弹。
	// 5 秒静默自动刷新不置 loading，所以轮询不会每 5 秒闪一下。
	const [fetchedAt, setFetchedAt] = useState(0);
	const [justUpdated, setJustUpdated] = useState(false);
	const wasLoadingRef = useRef(false);
	useEffect(() => {
		if (wasLoadingRef.current && !loading && !err) setFetchedAt(Date.now());
		wasLoadingRef.current = loading;
	}, [loading, err]);
	// 「✓ 数据已更新」亮 2.4s 后必须真卸载（只靠动画 forwards 会留下一个透明的占位元素，
	// 状态行会莫名多出一截空隙）；按 fetchedAt 重置计时，连续查询也不会提前熄灭。
	useEffect(() => {
		if (!fetchedAt) return;
		setJustUpdated(true);
		const timer = setTimeout(() => setJustUpdated(false), 2400);
		return () => clearTimeout(timer);
	}, [fetchedAt]);
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
		// 从会话入口点入时按带入的会话查（优先于暂存条件）：打开即出当前会话结果，
		// 不再需要手动点「查询」。只保留这一条初始查询，避免并发的会话查询被本链路覆盖。
		if (navSession) q.sessionId = navSession;
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

	// chips 定位：面板已打开时再次从会话入口点击 → 立即按该会话筛选查询。
	// 挂载时的首次带入已并入初始查询（sessionId 初值 + 挂载 effect），以 navAt 判同跳过，
	// 避免打开面板时同一条件跑两遍、且挂载查询链路较慢把会话结果覆盖回全量。
	const navAppliedRef = useRef(navAt);
	useEffect(() => {
		if (!navSession || navAppliedRef.current === navAt) return;
		navAppliedRef.current = navAt;
		setSessionId(navSession);
		setLoading(true); setErr("");
		rpcCall("query", Object.assign({}, buildQ(true), { sessionId: navSession }))
			.then((d) => { setData(d); setPage(0); })
			.catch((e) => setErr(String((e && e.message) || e)))
			.finally(() => setLoading(false));
	}, [navAt]);

	// USD→CNY 汇率: host 返回(默认 7.2, 可被 settings dsh-dock.tokenlog.usdCnyRate 覆盖)。
	// 必须在所有引用它的表达式(cards/summaryRows/detailRows/Detail/exportCsv)之前声明,
	// 否则 const 的 TDZ 会让组件渲染或导出直接抛错。
	const rateCny = (data && data.rateUsdCny) || 7.2;

	// 重置: 清空所有筛选(时间不选=显示全部记录), 并立即查询
	const resetFilters = useCallback(() => {		setFromStr(""); setToStr("");
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
				// host 返回结构化 rows 时本地格式化（中文表头、与页面同款取值/合计行）。
				// 旧宿主进程只回 csv 字段（英文表头）：回退到原样导出，避免导出空文件。
				const csv = d && Array.isArray(d.rows)
					? buildExportCsv(d.rows, (d && d.rateUsdCny) || rateCny)
					: String((d && d.csv) || "");
				// BOM 前置: 否则 Excel 按本地编码打开, 中文表头会乱码
				const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = "dsh-dock-tokenlog-" + Date.now() + ".csv";
				a.click();
				URL.revokeObjectURL(url);
			})
			.catch((e) => setErr(String((e && e.message) || e)));
	}, [buildQ, rateCny]);

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

	const cards = totals ? [
		{ v: fmtNum(totals.calls), l: "调用次数" },
		{ v: fmtCompact(totals.totalTokens), l: "总 Token" },
		{ v: fmtCompact(totals.cacheReadTokens), l: "输入(命中)" },
		{ v: fmtCompact(totals.inputTokens), l: "输入(未命中)" },
		{ v: totals.cacheHitPct + "%", l: "缓存命中率" },
		{ v: fmtCompact(totals.outputTokens), l: "输出" },
		{ v: fmtCostCny(totals.cost, rateCny), l: "消耗金额(估算·人民币)" },
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
			<td>{r.key}</td><td>{fmtNum(r.calls)}</td><td>{fmtCompact(r.cacheReadTokens)}</td>
			<td>{fmtCompact(r.inputTokens)}</td><td>{r.cacheHitPct + "%"}</td><td>{fmtCompact(r.outputTokens)}</td>
			<td>{fmtCompact(r.totalTokens)}</td>
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
				<td>{fmtNum(r.cacheReadTokens)}</td>
				<td>{fmtNum(r.inputTokens)}</td>
				<td>{r.cacheHitPercent + "%"}</td>
				<td>{fmtNum(r.outputTokens)}</td>
				<td>{fmtNum(r.reasoningTokens)}</td>
				<td>{fmtNum(r.totalTokens)}</td>
				<td title={r.pricingSource ? "计价来源：" + ({ custom: "自定义单价", official: "官网同步价", builtin: "内置默认价", fallback: "兜底单价" }[r.pricingSource] || r.pricingSource) : ""}>
					{fmtCostCny(r.cost, rateCny)}
					{r.pricingSource === "fallback" ? <span className="dtok-src fallback">{" "}兜底</span> : null}
				</td>
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
	bodyNodes.push(
		<div key="tabs" className="dtok-filter" style={{ padding: "2px 0 0", border: "none", background: "transparent", gap: 4 }}>
			<button className={"dtok-btn" + (tab === "detail" ? " primary" : "")} onClick={() => setTab("detail")}>明细</button>
			<button className={"dtok-btn" + (tab === "charts" ? " primary" : "")} onClick={() => setTab("charts")}>图表统计</button>
		</div>
	);
	if (tab === "charts") {
		bodyNodes.push(
			<ChartsPanel key={"charts-" + fetchedAt} records={records} rate={rateCny} />
		);
	} else {
	if (cards.length) bodyNodes.push(
		// key 带 fetchedAt：每次「手动查询 / 首次加载」拿到新数据时重建一次，KPI 卡重播回弹动画
		<div className={"dtok-cards" + (fetchedAt ? " dtok-pop" : "")} key={"cards-" + fetchedAt}>
			{cards.map((c, i) => <div className="dtok-card" key={c.l} style={{ "--i": String(i) }}><div className="v">{c.v}</div><div className="l">{c.l}</div></div>)}
		</div>
	);
	if (summaryRows.length) bodyNodes.push(
		<div key="sum" className="dtok-section-title">统计分组: {dim || "无"} ({summaryRows.length} 组)</div>,
		<div key="sumtab" className="dtok-table-wrap">
			<table className="dtok-table">
				<thead><tr>
					<th>维度</th><th>调用</th><th>输入(命中)</th><th>输入(未命中)</th><th>命中率</th><th>输出</th><th>总Token</th><th>金额（人民币）</th><th>耗时</th>
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
						{sortTh("输入(命中)", "cacheReadTokens")}{sortTh("输入(未命中)", "inputTokens")}{sortTh("命中%", "cacheHitPercent")}{sortTh("输出", "outputTokens")}
						{sortTh("推理", "reasoningTokens")}{sortTh("总额", "totalTokens")}{sortTh("金额（人民币）", "cost")}{sortTh("强度", "effort")}
						{sortTh("状态", "status")}{sortTh("耗时", "llmMs")}
					</tr></thead>
					<tbody>{detailRows}</tbody>
				</table>
			</div>
		);
		bodyNodes.push(pager("pager-bottom", "bottom"));
	}
	}

	return (
		<div className="dtok-root" onClick={(e) => e.stopPropagation()}>
			<div className="dtok-status">
				<span className="count">
					{loading ? (
						<span className="dtok-busy">
							<span className="dtok-spin inline" aria-hidden="true" />
							加载中<span className="dtok-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
						</span>
					) : (data ? data.counts.matching + " / " + data.counts.total + " 条" : "")}
				</span>
				{!loading && justUpdated && !err ? <span key={fetchedAt} className="dtok-updated">✓ 数据已更新</span> : null}
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
				<button className={"dtok-btn primary" + (loading ? " loading" : "")} disabled={loading} title="按当前条件查询" onClick={() => runQuery()}>
					{loading ? <span className="dtok-spin" aria-hidden="true" /> : null}{loading ? "查询中…" : "查询"}
				</button>
				<button className="dtok-btn" onClick={resetFilters}>重置</button>
				<button className="dtok-btn" onClick={exportCsv}>导出 CSV</button>
				<button className={"dtok-btn" + (showPricing ? " primary" : "")} onClick={() => setShowPricing(true)} title="配置各模型单价，费用按自填单价计算">单价设置</button>
			</div>
			{showPricing ? <PriceModal onClose={() => setShowPricing(false)} onSaved={runQuery} /> : null}
			<div className="dtok-status">
				{data && data.pricingInfo ? (
					<span>
						计价：{data.pricingInfo.hasCustom ? "自定义单价 " + data.pricingInfo.customCount + " 条" : "未配置自定义单价"}
							{" · 官网自动同步：" + (data.pricingInfo.fetchOfficial ? "开" : "关")}
							{data.pricingInfo.sources && data.pricingInfo.sources.length ? " · 本页涉及来源：" + data.pricingInfo.sources.join("/") : ""}
						</span>
					) : null}
				</div>
			<div className="dtok-body">
				{loading ? <LoadingBanner /> : null}
				{/* 加载期间旧数据整体压暗并禁用点击：既表明「这不是最新结果」，也避免照旧点进详情看错数 */}
				<div className={"dtok-body-inner" + (loading ? " busy" : "")}>{bodyNodes}</div>
			</div>
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
	return <span>今日 {fmtNum(t.calls)} 次调用 · {fmtCompact(t.totalTokens)} Token · {fmtCostCny(t.cost, snap.rate)}</span>;
}

// ---------- 会话输入区 chip：显示当前会话总 Token（10s 静默刷新），点击打开功能坞并按该会话筛选 ----------
export function TokenLogChip(props) {
	const sid = (props && props.sessionId) || (props && props.session && props.session.sessionId) || null;
	const [snap, setSnap] = useState({ totals: null, rate: 7.2, err: "" });
	useEffect(() => {
		if (!sid) return;
		let cancel = false;
		const load = () => rpcCall("query", { sessionId: sid })
			.then((d) => { if (!cancel) setSnap({ totals: d && d.totals, rate: (d && d.rateUsdCny) || 7.2, err: "" }); })
			.catch((e) => { if (!cancel) setSnap((s) => ({ totals: s.totals, rate: s.rate, err: String((e && e.message) || e) })); });
		load();
		const timer = setInterval(load, 10000);
		return () => { cancel = true; clearInterval(timer); };
	}, [sid]);
	if (!sid) return null;
	const t = snap.totals;
	// chip 文案用紧凑人民币金额（2 位小数），避免撑爆输入卡工具行；
	// 完整金额在 title 悬浮提示里。
	const label = snap.err && !t
		? (snap.err.includes("重启") ? "用量·需重启宿主" : "用量·失败")
		: (t ? "⛁ " + fmtCompact(t.totalTokens) + (t.cost > 0 ? " · " + fmtCostCny(t.cost, snap.rate) : "") : "⛁ …");
	const title = t
		? "本会话 " + fmtNum(t.calls) + " 次调用 · " + fmtNum(t.totalTokens) + " Token · " + fmtCostCny(t.cost, snap.rate) + "（估算）\n点击在功能坞查看用量记录"
		: (snap.err ? snap.err + "\n" : "") + "点击在功能坞查看用量记录";
	return (
		<button type="button" className={"dockchip" + (snap.err && !t ? " err" : "")} title={title} aria-label="会话用量"
			onClick={() => openPanel("tokenlog", { sessionId: sid, navAt: Date.now() })}>
			<span className="dockchip-dot" style={{ background: "var(--dk-warn)" }} />
			<span>{label}</span>
		</button>
	);
}

export const feature = {
	id: "tokenlog",
	name: "用量记录",
	order: 110,
	accent: "#fbbf24",
	description: "记录全部 LLM API 调用：秒级时间筛选、Token/费用统计（可配置各模型单价，持久保存并按自填单价计费；内置峰谷计价+官网价目自动同步作兜底）、分组汇总、明细检索与 CSV 导出",
	css,
	View: TokenLogView,
	HomeStat: TokenLogHomeStat,
	Chip: TokenLogChip,
};
