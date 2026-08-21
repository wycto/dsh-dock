// dsh-dock · Client 半部（浏览器 bundle，手写 lazy-CJS 工厂格式，无需构建器）
// 面板挂载在 settings.section：设置 → 功能中枢
// 每个功能是一个模块：FEATURES 注册表 + featureViews 视图组件 + 独立开关（内存态）。
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
			{ id: "balance", name: "模型余额", description: "接入路线图 0.2.0：展示所有模型 Provider 账户余额", planned: true },
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
			".dock-body{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:4px;}"
		].join("\n");

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