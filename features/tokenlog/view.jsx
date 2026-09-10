// dsh-dock · 功能模块【用量记录】· 客户端视图（v0.4.0，移植自 @wycto/dsh-token-usage client v6，适配 dock 嵌入）
//
// 嵌入功能坞面板的统计视图（无独立 overlay 外壳；全屏用 dock 弹窗自带的「最大化」）：
//  - 秒级时间范围查询 + 会话ID/提供商/模型(联动)/状态/推理强度 筛选，条件本地暂存
//  - 9 张 KPI 卡 + 分组统计表 + 明细表（点击表头排序、会话ID点击即筛选、100 行/页上下双分页）
//  - 状态列显示 HTTP 状态码徽章，行内【查看详情】弹窗展示完整信息；CSV 导出
//  - 独立的「单价设置」子弹窗：按模型配置单价（支持多段分时价）并持久化，费用按自填单价重算
//  - 挂载即扫描历史+按暂存条件查询；挂载期间每 5s 静默自动刷新
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
		<div className="dtok-pm-backdrop" onClick={onClose}>
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
							<div className="dtok-price-field"><label>基准输入</label>{num(r.input, (v) => patchRow(i, { input: v }))}</div>
							<div className="dtok-price-field"><label>基准输出</label>{num(r.output, (v) => patchRow(i, { output: v }))}</div>
							<div className="dtok-price-field"><label>基准缓存命中</label>{num(r.cacheRead, (v) => patchRow(i, { cacheRead: v }))}</div>
							<div className="dtok-price-field"><label>基准缓存写入</label>{num(r.cacheWrite, (v) => patchRow(i, { cacheWrite: v }))}</div>
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
								{segNum(s.input, (v) => patchSeg(i, k, { input: v }), "输入")}
								{segNum(s.output, (v) => patchSeg(i, k, { output: v }), "输出")}
								{segNum(s.cacheRead, (v) => patchSeg(i, k, { cacheRead: v }), "缓存命中")}
								{segNum(s.cacheWrite, (v) => patchSeg(i, k, { cacheWrite: v }), "缓存写入")}
								<button className="dtok-btn tiny" onClick={() => delSeg(i, k)}>删除时段</button>
							</div>
						))}
						<div className="dtok-price-hint" style={{ opacity: .85 }}>时段价从左到右：输入 / 输出 / 缓存命中 / 缓存写入</div>
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
					<div className="dtok-price-field"><label>输入</label>{num(fb.input, (v) => setFb((s) => Object.assign({}, s, { input: v })))}</div>
					<div className="dtok-price-field"><label>输出</label>{num(fb.output, (v) => setFb((s) => Object.assign({}, s, { output: v })))}</div>
					<div className="dtok-price-field"><label>缓存命中</label>{num(fb.cacheRead, (v) => setFb((s) => Object.assign({}, s, { cacheRead: v })))}</div>
					<div className="dtok-price-field"><label>缓存写入</label>{num(fb.cacheWrite, (v) => setFb((s) => Object.assign({}, s, { cacheWrite: v })))}</div>
				</div>
			</div>

			{cfg && cfg.builtin && cfg.builtin.length > 0 ? (
				<details>
					<summary className="dtok-price-hint" style={{ cursor: "pointer" }}>查看内置默认单价（{cfg.builtin.length} 条，自定义配置未命中时按此兜底）</summary>
					<div className="dtok-table-wrap" style={{ marginTop: 6 }}>
						<table className="dtok-table">
							<thead><tr><th>匹配</th><th>输入</th><th>输出</th><th>缓存命中</th><th>缓存写入</th><th>分时段</th></tr></thead>
							<tbody>
								{cfg.builtin.map((b) => (
									<tr key={b.match}>
										<td>{b.match}</td><td>{b.input}</td><td>{b.output}</td><td>{b.cacheRead}</td><td>{b.cacheWrite}</td>
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

// ---------- 主视图（嵌入 dock 面板内容区） ----------
export function TokenLogView(props) {
	// props.params.sessionId（chips 点击带入）：立即按该会话筛选并查询
	const navSession = props && props.params && props.params.sessionId ? props.params.sessionId : null;
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
	// 「单价设置」折叠面板：默认收起（费用不准确时才需要展开调整）
	// 「单价设置」子弹窗：默认收起；支持经 params.openPricing 直接打开（深链/测试用）
	const [showPricing, setShowPricing] = useState(() => !!(props && props.params && props.params.openPricing));
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

	// chips 定位：按带入的会话立即筛选查询（覆盖暂存条件里的会话项）
	useEffect(() => {
		if (!navSession) return;
		setSessionId(navSession);
		setLoading(true); setErr("");
		rpcCall("query", Object.assign({}, buildQ(true), { sessionId: navSession }))
			.then((d) => { setData(d); setPage(0); })
			.catch((e) => setErr(String((e && e.message) || e)))
			.finally(() => setLoading(false));
	}, [navSession]);

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

	// USD→CNY 汇率: host 返回(默认 7.2, 可被 settings dsh-dock.tokenlog.usdCnyRate 覆盖)。
	// 注意: 必须在本文件所有引用它的表达式(cards/summaryRows/detailRows/Detail)之前声明。
	const rateCny = (data && data.rateUsdCny) || 7.2;

	const cards = totals ? [
		{ v: fmtNum(totals.calls), l: "调用次数" },
		{ v: fmtCompact(totals.totalTokens), l: "总 Token" },
		{ v: fmtCompact(totals.inputTokens), l: "输入(未缓存)" },
		{ v: fmtCompact(totals.cacheReadTokens), l: "缓存命中" },
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
			<td>{r.key}</td><td>{fmtNum(r.calls)}</td><td>{fmtCompact(r.inputTokens)}</td>
			<td>{fmtCompact(r.cacheReadTokens)}</td><td>{r.cacheHitPct + "%"}</td><td>{fmtCompact(r.outputTokens)}</td>
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
				<td>{fmtNum(r.inputTokens)}</td>
				<td>{fmtNum(r.cacheReadTokens)}</td>
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
					<th>维度</th><th>调用</th><th>输入</th><th>缓存</th><th>命中率</th><th>输出</th><th>总Token</th><th>金额（人民币）</th><th>耗时</th>
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
						{sortTh("推理", "reasoningTokens")}{sortTh("总额", "totalTokens")}{sortTh("金额（人民币）", "cost")}{sortTh("强度", "effort")}
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
			onClick={() => openPanel("tokenlog", { sessionId: sid })}>
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
