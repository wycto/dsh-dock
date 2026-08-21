// dsh-dock · Client 半部（浏览器 bundle，手写 lazy-CJS 工厂格式，无需构建器）
// 面板挂载在 settings.section：设置 → 功能中枢
// 每个功能是一个模块：FEATURES 注册表 + featureViews 视图组件 + 独立开关（内存态）。
// v0.2.0：模型余额已接入 —— balance 视图通过同源 fetch('/dsh-dock/balance') 拉取
//   Host 半部汇总好的各 Provider 余额/配额（Host 函数在 index.js，数据形状与其一致）。
// planned: true 的功能为规划占位（见 README 路线图），接入后移除 planned 并提供视图即可。
window.__ModuleLoader__.load({
	id: "dsh-dock",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		const name = "dsh-dock";
		const inject = ["timer"];

		// ---- 功能注册表：新功能在这里加一条，featureViews 里加同名视图 ----
		const FEATURES = [
			{ id: "heartbeat", name: "心跳监视", description: "示例功能：面板侧运行时长心跳（纯 Client）", defaultEnabled: true },
			{ id: "theme", name: "主题信息", description: "示例功能：读取当前主题快照（纯 Client）", defaultEnabled: true },
			{ id: "balance", name: "模型余额", description: "展示所有模型 Provider 账户余额（Host 拉取，5 分钟自动刷新）", defaultEnabled: true },
			{ id: "tokenlog", name: "Token 用量记录", description: "接入路线图 0.3.0：记录全部 LLM API 调用并统计", planned: true },
			{ id: "animation", name: "任务动画", description: "接入路线图 0.4.0：任务进度动画与通知", planned: true }
		];

		const CSS = [
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
			// 模型余额视图（dkb- 前缀，避免与面板本体 dock- 与其它插件冲突）
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
		].join("\n");

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

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;

			// 开关状态：浏览器内存态，随页面生命周期
			const state = new Map();
			for (const f of FEATURES) state.set(f.id, { enabled: !!f.defaultEnabled, error: null });

			// ---- 每个功能的客户端视图：key 与注册表 id 一致 ----
			const featureViews = {
				heartbeat: function HeartbeatView() {
					const [sec, setSec] = react.useState(0);
					react.useEffect(() => ctx.interval(() => setSec((s) => s + 1), 1000), []);
					const m = Math.floor(sec / 60);
					return react.createElement("div", null,
						"面板已运行 " + (m > 0 ? m + " 分 " : "") + (sec % 60) + " 秒");
				},
				theme: function ThemeView() {
					const theme = ctx.get("theme");
					if (theme === undefined) return react.createElement("div", null, "theme 服务不可用");
					let snap = null;
					try { snap = theme.getTheme(); }
					catch (err) { return react.createElement("div", null, "读取失败：" + String((err && err.message) || err)); }
					const label = snap && typeof snap.id === "string" ? snap.id
						: snap && typeof snap.name === "string" ? snap.name : "未知";
					return react.createElement("div", null, "当前主题：" + label);
				},
				balance: function BalanceView() {
					const [snap, setSnap] = react.useState({ data: null, loading: false, error: null });
					// load 只依赖 setSnap（函数式更新），无闭包变化，可安全被 interval 与按钮复用
					const load = react.useCallback(() => {
						setSnap((s) => (s.loading ? s : Object.assign({}, s, { loading: true })));
						fetch("/dsh-dock/balance", { signal: AbortSignal.timeout(20000) })
							.then((res) => (res.ok ? res.json() : Promise.reject(new Error("余额接口 HTTP " + res.status))))
							.then((result) => setSnap({ data: result, loading: false, error: null }))
							.catch((e) => setSnap((s) => Object.assign({}, s, { loading: false, error: (e && e.message) || String(e) })));
					}, []);
					react.useEffect(() => {
						load();
						const disposer = ctx.interval(load, 5 * 60 * 1000);
						return () => { if (disposer) disposer(); };
					}, [load]);

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
			};

			function DockPanel() {
				const [, force] = react.useReducer((n) => n + 1, 0);
				const toggle = (id) => {
					const st = state.get(id);
					if (!st) return;
					st.enabled = !st.enabled;
					force();
				};
				return react.createElement("div", { className: "dock-root" },
					react.createElement("style", null, CSS),
					react.createElement("div", { className: "dock-intro" },
						"功能中枢（dsh-dock）· 所有小功能集中在这一个面板里管理。每个功能是独立模块：开关只影响自己，单个功能出错不影响其他功能。新功能按注册表模式追加（FEATURES + featureViews 各加一条）。"),
					FEATURES.map((f) => {
						const st = state.get(f.id);
						const View = featureViews[f.id];
						return react.createElement("div", { className: "dock-card", key: f.id },
							react.createElement("div", { className: "dock-card-head" },
								react.createElement("span", { className: "dock-dot" + (st.error ? " err" : st.enabled ? " on" : "") }),
								react.createElement("span", { className: "dock-name" }, f.name),
								react.createElement("span", { className: "dock-desc" }, f.description),
								f.planned
									? react.createElement("span", { className: "dock-badge" }, "规划中")
									: react.createElement("button", {
										className: "dock-switch" + (st.enabled ? " on" : ""),
										onClick: () => toggle(f.id)
									}, st.enabled ? "已启用" : "已停用")),
							f.planned
								? react.createElement("div", { className: "dock-body" }, "待接入：见 README 路线图")
								: st.error ? react.createElement("div", { className: "dock-body dock-err" }, "功能出错：" + st.error) : null,
							!f.planned && st.enabled && View
								? react.createElement("div", { className: "dock-body" }, react.createElement(View, null))
								: null);
					}));
			}

			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "dsh-dock", order: 90, label: "功能中枢" },
				() => react.createElement(DockPanel, null)));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});