// dsh-dock · 功能模块【模型余额】· 客户端视图（v0.2.0 迁自 client.js，行为不变）
// 数据与刷新走共享 balanceStore：首页总揽、弹层与设置页共用同一份快照（挂载即拉取，5 分钟自动刷新）
import react from "react";

// ---- 模型余额视图的配色与工具（沿用 dsh-balance-panel@0.1.1，MIT 同作者）----
const ACCENT_PALETTE = ['#4d9fff', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#38bdf8', '#fb923c', '#4ade80', '#e879f9', '#22d3ee'];
const CURATED_ACCENTS = {
	'deepseek-official': '#4d9fff',
	deepseek: '#4d9fff',
	'qwen-token-plan-cn': '#fbbf24',
	fangzhou: '#a78bfa',
	openai: '#10a37f',
	anthropic: '#d97757',
	'google-gemini': '#4285f4'
};
const C_TOTAL = '#34d399';
const C_GRANTED = '#22d3ee';
const C_TOPUP = '#fbbf24';
const C_OK = '#34d399';
const C_ERR = '#f87171';

function accentOf(id) {
	if (CURATED_ACCENTS[id]) return CURATED_ACCENTS[id];
	let h = 0;
	const s = String(id);
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
	return ACCENT_PALETTE[h % ACCENT_PALETTE.length];
}
const fmt = (v) => (v == null || v === '' ? '—' : String(v));

// ---- 共享快照：弹层/设置页/首页总揽共用一份数据与刷新 ----
const balanceStore = {
	snap: { data: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	set(patch) { this.snap = Object.assign({}, this.snap, patch); for (const fn of this.listeners) fn(); },
	load() {
		if (this.snap.loading) return;
		this.set({ loading: true });
		fetch("/dsh-dock/balance", { signal: AbortSignal.timeout(20000) })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("余额接口 HTTP " + res.status))))
			.then((data) => this.set({ data: data, loading: false, error: null }))
			.catch((e) => this.set({ loading: false, error: (e && e.message) || String(e) }));
	}
};
function useBalance(ctx) {
	const [snap, setSnap] = react.useState(balanceStore.snap);
	react.useEffect(() => {
		const off = balanceStore.subscribe(() => setSnap(balanceStore.snap));
		if (!balanceStore.snap.data && !balanceStore.snap.loading) balanceStore.load();
		const disposer = ctx && typeof ctx.interval === "function" ? ctx.interval(() => balanceStore.load(), 5 * 60 * 1000) : null;
		return () => { off(); if (disposer) disposer(); };
	}, []);
	return snap;
}

function BalanceView(props) {
	// 数据与刷新走共享 balanceStore（挂载即拉取，5 分钟自动刷新）
	const snap = useBalance(props && props.ctx);
	const load = () => balanceStore.load();

	const data = snap.data;
	const providers = data && Array.isArray(data.providers) ? data.providers : [];
	const okCount = providers.filter((p) => p.balance && p.balance.status === "ok").length;
	const def = data && data.default ? data.default.provider : null;
	const body = [];

	if (snap.error) {
		body.push(react.createElement("div", { key: "err", className: "dkb-note dkb-error" }, "余额查询失败：" + snap.error));
	} else if (!data) {
		body.push(react.createElement("div", { key: "loading", className: "dkb-note" }, snap.loading ? "正在拉取余额…" : "还没有数据，点击下方刷新"));
	} else if (providers.length === 0) {
		body.push(react.createElement("div", { key: "empty", className: "dkb-note" }, "没有找到已配置的模型 Provider"));
	} else {
		body.push(react.createElement("div", { key: "rows", className: "dkb-rows" },
			providers.map((p) => {
				const accent = accentOf(p.id);
				const b = p.balance;
				let badge = ["未知", ""];
				if (b) {
					if (b.status === "ok") badge = ["可用", "ok"];
					else if (b.status === "unsupported") badge = ["不支持", ""];
					else if (b.status === "no-credential") badge = ["未配置密钥", "warn"];
					else if (b.status === "login-required") badge = ["需登录", "warn"];
					else badge = ["查询失败", "err"];
				}
				const sub = ["ID: " + p.id, p.api ? "api: " + p.api : null, p.baseURL ? p.baseURL : null].filter(Boolean).join(" · ");
				const cells = [];
				let balBody = null;
				if (b && b.status === "ok" && b.kind === "quota") {
					cells.push(react.createElement("div", { key: "q", className: "dkb-bal" },
						react.createElement("span", { className: "dkb-cur", style: { color: accent } }, "总额度"),
						react.createElement("span", { className: "dkb-total", style: { color: C_TOTAL } }, "剩余 " + fmt(b.remaining) + (b.unit ? " " + b.unit : "")),
						react.createElement("span", { className: "dkb-part" }, "已用 " + fmt(b.used) + " / 总 " + fmt(b.limit)),
						b.resetTime
							? react.createElement("span", { className: "dkb-part" }, "重置 " + String(b.resetTime).slice(0, 16))
							: null));
					(Array.isArray(b.dims) ? b.dims : []).forEach((d, i) => {
						cells.push(react.createElement("div", { key: "d" + i, className: "dkb-bal" },
							react.createElement("span", { className: "dkb-cur", style: { color: accent } }, d.window === "weekly" ? "周额度" : "小时额度"),
							react.createElement("span", { className: "dkb-total", style: { color: C_TOTAL } }, "剩余 " + fmt(d.remaining)),
							react.createElement("span", { className: "dkb-part" }, "已用 " + fmt(d.used) + " / " + fmt(d.limit)),
							d.resetTime
								? react.createElement("span", { className: "dkb-part" }, "重置 " + String(d.resetTime).slice(0, 16))
								: null));
					});
				} else if (b && b.status === "ok") {
					const infos = Array.isArray(b.infos) ? b.infos : [];
					cells.push(infos.map((i, idx) =>
						react.createElement("div", { key: idx, className: "dkb-bal" },
							react.createElement("span", { className: "dkb-cur", style: { color: accent } }, i.currency),
							react.createElement("span", { className: "dkb-total", style: { color: C_TOTAL } }, "总额 " + fmt(i.totalBalance)),
							i.grantedBalance != null
								? react.createElement("span", { className: "dkb-part", style: { color: C_GRANTED } }, "赠送 " + fmt(i.grantedBalance))
								: null,
							i.toppedUpBalance != null
								? react.createElement("span", { className: "dkb-part", style: { color: C_TOPUP } }, "充值 " + fmt(i.toppedUpBalance))
								: null)));
				} else if (b && b.status === "login-required" && b.consoleUrl) {
					balBody = react.createElement("div", { className: "dkb-bal" },
						react.createElement("a", { href: b.consoleUrl, target: "_blank", rel: "noreferrer", className: "dkb-link", style: { color: accent } }, "去控制台查看余额 →"));
				} else {
					balBody = react.createElement("div", { className: "dkb-note" }, (b && b.message) || "未知状态");
				}
				if (cells.length > 0) balBody = react.createElement("div", { className: "dkb-rows" }, cells);
				return react.createElement("div", { key: p.id, className: "dkb-row" },
					react.createElement("div", { className: "dkb-row-head" },
						react.createElement("span", { className: "dkb-dot", style: { background: accent } }),
						react.createElement("span", { className: "dkb-name", style: { color: accent } }, p.displayName),
						def === p.id ? react.createElement("span", { className: "dkb-default" }, "默认") : null,
						react.createElement("span", { className: "dkb-badge" + (badge[1] ? " " + badge[1] : ""), style: badge[1] === "err" ? { color: C_ERR, borderColor: C_ERR } : null }, badge[0])),
					sub ? react.createElement("div", { className: "dkb-sub" }, sub) : null,
					p.apiKeyEnv
						? react.createElement("div", { className: "dkb-sub" }, "密钥: " + p.apiKeyEnv + (p.credentialConfigured ? " ✓" : " ✗"))
						: null,
					p.models && p.models.length > 0
						? react.createElement("div", { className: "dkb-chips" },
							p.models.slice(0, 8).map((m) =>
								react.createElement("span", { key: m, className: "dkb-chip", style: { border: "1px solid " + accent, color: accent, background: accent + "1a" } }, m)),
							p.models.length > 8 ? react.createElement("span", { key: "more", className: "dkb-chip" }, "+" + (p.models.length - 8)) : null)
						: null,
					balBody);
			})));
	}

	const now = new Date(data && data.generatedAt ? data.generatedAt : Date.now());
	return react.createElement("div", { className: "dkb-rows" },
		react.createElement("div", { className: "dkb-note" },
			data && !snap.error && providers.length > 0
				? okCount + "/" + providers.length + " 个 Provider 可查余额"
				: "模型余额 · Host 半部实时拉取"),
		body,
		react.createElement("div", { className: "dkb-foot" },
			react.createElement("span", null, snap.loading ? "刷新中…" : "更新于 " + now.toLocaleTimeString()),
			react.createElement("button", { type: "button", className: "dkb-refresh", onClick: load }, "刷新")));
}

function BalanceStat(props) {
	const snap = useBalance(props && props.ctx);
	const data = snap.data;
	const providers = data && Array.isArray(data.providers) ? data.providers : [];
	if (snap.error) return react.createElement("span", { className: "dockm-err" }, "余额查询失败（点击进入查看详情）");
	if (!data) return react.createElement("span", null, snap.loading ? "正在拉取余额…" : "等待拉取余额");
	const ok = providers.filter((p) => p.balance && p.balance.status === "ok").length;
	return react.createElement("span", null, providers.length + " 个 Provider · " + ok + " 个可查余额");
}

export const feature = {
	id: "balance",
	name: "模型余额",
	order: 130,
	accent: "#4d9fff",
	description: "展示所有模型 Provider 账户余额（Host 拉取，5 分钟自动刷新）",
	css: [
		".dkb-note{color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkb-error{color:var(--dsw-alias-state-error-primary);}",
		".dkb-rows{display:flex;flex-direction:column;gap:8px;}",
		".dkb-row{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:5px;}",
		".dkb-row-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
		".dkb-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
		".dkb-name{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);}",
		".dkb-default{color:var(--dsw-alias-accent,#4d9fff);font-size:11px;border:1px solid currentColor;border-radius:999px;padding:0 6px;}",
		".dkb-badge{font-size:11px;border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
		".dkb-badge.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
		".dkb-badge.warn{color:var(--dsw-alias-state-warning-primary);border-color:currentColor;}",
		".dkb-badge.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
		".dkb-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
		".dkb-chips{display:flex;flex-wrap:wrap;gap:4px;}",
		".dkb-chip{font-size:10px;border-radius:6px;padding:1px 6px;}",
		".dkb-bal{display:flex;gap:10px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-primary);align-items:baseline;}",
		".dkb-cur{font-weight:600;min-width:48px;}",
		".dkb-total{font-weight:600;}",
		".dkb-part{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
		".dkb-link{font-size:12px;text-decoration:none;}",
		".dkb-link:hover{text-decoration:underline;}",
		".dkb-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;}",
		".dkb-refresh{cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px 10px;font-family:inherit;font-size:12px;}",
		".dkb-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);}"
	].join("\n"),
	View: BalanceView,
	HomeStat: BalanceStat,
};
