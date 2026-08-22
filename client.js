// dsh-dock · Client 半部（浏览器 bundle，手写 lazy-CJS 工厂格式，无需构建器）
// 中文名：功能坞（dsh-dock）。完整面板挂载在 settings.section：设置 → 功能坞；
// 侧栏底部另有「功能坞」入口按钮（sidebar.footer.action），点击弹出居中功能面板（shell.overlay）：
// 左侧导航 = 首页总揽 + 各功能模块，默认打开「首页」（所有子功能的状态/概要/快捷开关一览）。
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

		const DOCK_CSS = [
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
			".dkb-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);}",
// 侧栏入口按钮（docke2- 前缀）+ 功能坞弹出面板（dockm- 前缀，仿 dsh 设置的居中模态：遮罩 + 对话框，左导航 + 右内容）
			".docke2-btn{box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:10px;height:32px;font-family:inherit;font-size:13px;line-height:32px;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
			".docke2-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".docke2-btn.docke2-on{color:var(--dsw-alias-accent,#4d9fff);background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 12%,transparent));}",
			".docke2-label{white-space:nowrap;overflow:hidden;}",
			// 弹层遮罩（点击关闭）与对话框
			".dockm-backdrop{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);backdrop-filter:blur(4px);pointer-events:auto;animation:dockm-fade .15s var(--ds-ease-in-out);}",
			"@keyframes dockm-fade{from{opacity:0}to{opacity:1}}",
			".dockm-dialog{box-sizing:border-box;width:min(820px,calc(100vw - 40px));height:min(600px,calc(100vh - 48px));display:flex;flex-direction:column;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 20px 64px rgb(0 0 0 / .32);overflow:hidden;animation:dockm-pop .18s var(--ds-ease-in-out);}",
			"@keyframes dockm-pop{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}",
			".dockm-head{flex:none;display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);}",
			".dockm-title{font-weight:600;font-size:14px;}",
			".dockm-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;}",
			".dockm-close{margin-left:auto;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;}",
			".dockm-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".dockm-body{flex:1;min-height:0;display:flex;}",
			// 左侧功能模块导航
			".dockm-nav{flex:none;width:176px;display:flex;flex-direction:column;gap:2px;padding:10px 8px;overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l1);}",
			".dockm-nav-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:none;background:transparent;border-radius:10px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;text-align:left;transition:background .15s var(--ds-ease-in-out),color .15s var(--ds-ease-in-out);}",
			".dockm-nav-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
			".dockm-nav-item.on{background:var(--dsw-alias-accent-soft,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 12%,transparent));color:var(--dsw-alias-label-primary);font-weight:600;}",
			".dockm-nav-item .dockm-badge{margin-left:auto;}",
			".dockm-dot{width:8px;height:8px;border-radius:50%;flex:none;}",
			".dockm-badge{flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
			// 右侧内容区
			".dockm-content{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px;padding:16px 18px;overflow-y:auto;}",
			".dockm-content-head{display:flex;flex-direction:column;gap:4px;}",
			".dockm-name{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;}",
			".dockm-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
			".dockm-view{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
			".dockm-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
			".dockm-err{color:var(--dsw-alias-state-error-primary);}",
			".dockm-foot{margin-top:auto;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;flex-wrap:wrap;}",
			".dockm-switch{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:4px 12px;font-family:inherit;font-size:12px;margin-left:auto;}",
			".dockm-switch:hover{color:var(--dsw-alias-label-primary);}",
			".dockm-switch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
			// 首页总揽（dockh- 前缀）：导航首项图标 + 模块卡片网格
			".dockm-navhome{display:inline-flex;align-items:center;color:var(--dsw-alias-accent,#4d9fff);flex:none;}",
			".dockh-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;}",
			".dockh-card{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s var(--ds-ease-in-out);}",
			".dockh-card:hover,.dockh-card:focus-visible{border-color:var(--dsw-alias-accent,#4d9fff);outline:none;}",
			".dockh-head{display:flex;align-items:center;gap:8px;}",
			".dockh-name{font-weight:600;flex:none;}",
			".dockh-badge{margin-left:auto;flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
			".dockh-badge.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
			".dockh-badge.off{border-style:dashed;}",
			".dockh-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}",
			".dockh-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".dockh-foot{display:flex;align-items:center;gap:8px;}",
			".dockh-go{color:var(--dsw-alias-label-tertiary);font-size:11px;}"
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

			// 样式全局注入一次（入口按钮与右下角浮层挂在设置页之外，不能依赖页内 <style>）。
			// ⚠️ 变量名不得用 CSS：浏览器存在全局 window.CSS 命名空间，bundle 任何作用域解析歧义
			// 都会把标识符解析成该全局对象（无 .join），曾导致插件应用失败、整页启动崩溃。
			// 这里用 DOCK_CSS 唯一命名，并做防御：注入永不抛错、失败只降级不打断启动。
			function ensureCss() {
				if (typeof document === "undefined") return;
				try {
					if (document.querySelector('style[data-plugin-css="dsh-dock"]')) return;
					const tag = document.createElement("style");
					tag.dataset.pluginCss = "dsh-dock";
					tag.textContent = Array.isArray(DOCK_CSS) ? DOCK_CSS.join("\n") : String(DOCK_CSS || "");
					document.head.appendChild(tag);
				} catch (e) {
					console.error("[dsh-dock] ensureCss failed:", e && e.message ? e.message : String(e));
				}
			}
			ensureCss();

			// 入口按钮与右下角浮层共享的面板开关（浏览器内存态，随页面生命周期）
			const panelState = { open: false, listeners: new Set() };
			function setPanelOpen(value) {
				panelState.open = !!value;
				for (const fn of panelState.listeners) fn();
			}
			function subscribePanel(fn) {
				panelState.listeners.add(fn);
				return () => { panelState.listeners.delete(fn); };
			}

			// ---- 侧栏入口按钮：sidebar.footer.action（设置在右下方，按钮靠右端 = 右下角）----
			function DockIcon() {
				return react.createElement("svg", { width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", strokeWidth: 1.3, "aria-hidden": true },
					react.createElement("rect", { x: 2.5, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
					react.createElement("rect", { x: 9, y: 2.5, width: 4.4, height: 4.4, rx: 1.2 }),
					react.createElement("rect", { x: 2.5, y: 9, width: 4.4, height: 4.4, rx: 1.2 }),
					react.createElement("rect", { x: 9, y: 9, width: 4.4, height: 4.4, rx: 1.2 }));
			}
			function DockEntry(props) {
				const wide = !!props.wide;
				const [open, setOpen] = react.useState(panelState.open);
				react.useEffect(() => subscribePanel(() => setOpen(panelState.open)), []);
				return react.createElement("button", {
					type: "button",
					className: "docke2-btn" + (open ? " docke2-on" : ""),
					style: wide
						// 与设置按钮精确同框：设置 trigger 宽栏 = 42px 高、margin-top 4 → 下移 46px、高度同为 42，
						// 使本按钮的四条边与设置按钮完全重合（同一水平线）；rail = 36px、margin-top 8 → 下移 44px、高 36 亦然。
						// zIndex 保证盖在满宽设置按钮之上（其右侧为空白区，不遮齿轮图标）
						? { marginLeft: "auto", transform: "translateY(46px)", zIndex: 1, height: 42, lineHeight: "42px", padding: "0 12px" }
						: { transform: "translateY(44px)", zIndex: 1, width: 36, height: 36, justifyContent: "center", padding: 0 },
					title: "功能坞",
					"aria-label": "功能坞",
					"aria-expanded": open,
					onClick: () => setPanelOpen(!open)
				}, react.createElement(DockIcon, null), wide ? react.createElement("span", { className: "docke2-label" }, "功能坞") : null);
			}

// ---- 功能坞弹出面板：shell.overlay（仿 dsh 设置：居中模态 = 遮罩 + 对话框）----
			// 左侧导航：首项「首页」总揽（默认选中），其后是各功能模块；planned 模块只占位展示
			const MODULE_ACCENTS = { heartbeat: "#34d399", theme: "#a78bfa", balance: "#4d9fff", tokenlog: "#fbbf24", animation: "#f472b6" };
			const MODULES = FEATURES.map((f) => Object.assign({}, f, { accent: MODULE_ACCENTS[f.id] || accentOf(f.id) }));
			const PLANNED_NOTES = {
				tokenlog: "待接入（路线图 0.3.0）：记录全部 LLM API 调用，统计 Token 用量与花费。",
				animation: "待接入（路线图 0.4.0）：任务进度动画与完成通知。",
			};
			function toggleFeature(id) {
				const st = state.get(id);
				if (!st) return;
				st.enabled = !st.enabled;
			}

			function DockModal() {
				// 默认关闭；SSR/无浏览器环境下默认展开内容（便于冒烟测试渲染整棵弹层树）
				const [open, setOpen] = react.useState(panelState.open || typeof document === "undefined");
				react.useEffect(() => subscribePanel(() => setOpen(panelState.open)), []);
				const [active, setActive] = react.useState("home");
				const [, force] = react.useReducer((n) => n + 1, 0);
				if (!open) return null;
				const isHome = active === "home";
				const mod = isHome ? null : (MODULES.find((m) => m.id === active) || MODULES[0]);
				const st = mod ? state.get(mod.id) : null;
				const View = mod ? featureViews[mod.id] : null;
				const enabledCount = MODULES.filter((m) => { const s = state.get(m.id); return !!(s && s.enabled); }).length;
				return react.createElement("div", { className: "dockm-backdrop", onClick: () => setPanelOpen(false) },
					react.createElement("div", { className: "dockm-dialog", onClick: (e) => e.stopPropagation() },
						react.createElement("div", { className: "dockm-head" },
							react.createElement(DockIcon, null),
							react.createElement("span", { className: "dockm-title" }, "功能坞"),
							react.createElement("span", { className: "dockm-sub" }, "dsh-dock · 也可在 设置 → 功能坞 打开管理页"),
							react.createElement("button", { type: "button", className: "dockm-close", "aria-label": "关闭", onClick: () => setPanelOpen(false) }, "✕")),
						react.createElement("div", { className: "dockm-body" },
							react.createElement("nav", { className: "dockm-nav", "aria-label": "功能模块" },
								react.createElement("button", {
									type: "button",
									key: "home",
									className: "dockm-nav-item" + (isHome ? " on" : ""),
									onClick: () => setActive("home")
								},
									react.createElement("span", { className: "dockm-navhome" }, react.createElement(DockIcon, null)),
									react.createElement("span", null, "首页")),
								MODULES.map((m) =>
									react.createElement("button", {
										type: "button",
										key: m.id,
										className: "dockm-nav-item" + (m.id === active ? " on" : ""),
										onClick: () => setActive(m.id)
									},
										react.createElement("span", { className: "dockm-dot", style: { background: m.accent } }),
										react.createElement("span", null, m.name),
										m.planned ? react.createElement("span", { className: "dockm-badge" }, "规划中") : null))),
							react.createElement("div", { className: "dockm-content" },
								react.createElement("div", { className: "dockm-content-head" },
									react.createElement("div", { className: "dockm-name" },
										isHome
											? react.createElement("span", { className: "dockm-navhome" }, react.createElement(DockIcon, null))
											: react.createElement("span", { className: "dockm-dot", style: { background: mod.accent } }),
										isHome ? "首页" : mod.name,
										!isHome && mod.planned ? react.createElement("span", { className: "dockm-badge" }, "规划中") : null),
									react.createElement("div", { className: "dockm-desc" },
										isHome
											? "所有子功能总揽：运行状态、概要与快捷开关，点击卡片进入对应功能页。"
											: mod.description)),
							isHome
								? react.createElement("div", { className: "dockm-view" }, react.createElement(HomeView, { onOpen: setActive, onToggle: force }))
									: mod.planned
										? react.createElement("div", { className: "dockm-note" }, PLANNED_NOTES[mod.id] || "待接入：见 README 路线图")
										: st && st.enabled && View
											? react.createElement("div", { className: "dockm-view" }, react.createElement(View, null))
											: st && st.error
												? react.createElement("div", { className: "dockm-note dockm-err" }, "功能出错：" + st.error)
												: react.createElement("div", { className: "dockm-note" }, "该功能当前为停用状态（记忆态随页面生命周期，0.5.0 起持久化）"),
								react.createElement("div", { className: "dockm-foot" },
									react.createElement("span", null, isHome
										? "功能坞 v0.2.0 · 共 " + MODULES.length + " 个功能模块，" + enabledCount + " 个已启用"
										: "功能坞 v0.2.0 · 新功能按路线图追加"),
									!isHome && mod && !mod.planned && st
										? react.createElement("button", {
											type: "button",
											className: "dockm-switch" + (st.enabled ? " on" : ""),
											onClick: () => { toggleFeature(mod.id); force(); }
										}, st.enabled ? "已启用（点击停用）" : "已停用（点击启用）")
										: null)))));
			}

		// 开关状态：浏览器内存态，随页面生命周期
		const state = new Map();
		for (const f of FEATURES) state.set(f.id, { enabled: !!f.defaultEnabled, error: null });

		// 面板加载时刻：心跳视图与首页总揽共用的运行时长基准（同一数字，不分谁先挂载）
		const loadedAt = Date.now();
		function uptimeText() {
			const sec = Math.max(0, Math.floor((Date.now() - loadedAt) / 1000));
			const m = Math.floor(sec / 60);
			return "面板已运行 " + (m > 0 ? m + " 分 " : "") + (sec % 60) + " 秒";
		}

		// ---- 模型余额共享快照：balance 视图（弹层/设置页）与首页总揽共用一份数据与刷新 ----
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
		function useBalance() {
			const [snap, setSnap] = react.useState(balanceStore.snap);
			react.useEffect(() => {
				const off = balanceStore.subscribe(() => setSnap(balanceStore.snap));
				if (!balanceStore.snap.data && !balanceStore.snap.loading) balanceStore.load();
				const disposer = ctx.interval(() => balanceStore.load(), 5 * 60 * 1000);
				return () => { off(); if (disposer) disposer(); };
			}, []);
			return snap;
		}

		// ---- 首页总揽：每个功能模块一张卡片（状态徽章 + 运行概要 + 快捷开关），点击进入对应功能 ----
		function HeartbeatStat() {
			const [txt, setTxt] = react.useState(uptimeText());
			react.useEffect(() => ctx.interval(() => setTxt(uptimeText()), 1000), []);
			return react.createElement("span", null, txt);
		}
		function ThemeStat() {
			const theme = ctx.get("theme");
			if (theme === undefined) return react.createElement("span", null, "theme 服务不可用");
			let label = "未知";
			try {
				const snap = theme.getTheme();
				if (snap && typeof snap.id === "string") label = snap.id;
				else if (snap && typeof snap.name === "string") label = snap.name;
			} catch (err) { return react.createElement("span", null, "读取失败：" + String((err && err.message) || err)); }
			return react.createElement("span", null, "当前主题：" + label);
		}
		function BalanceStat() {
			const snap = useBalance();
			const data = snap.data;
			const providers = data && Array.isArray(data.providers) ? data.providers : [];
			if (snap.error) return react.createElement("span", { className: "dockm-err" }, "余额查询失败（点击进入查看详情）");
			if (!data) return react.createElement("span", null, snap.loading ? "正在拉取余额…" : "等待拉取余额");
			const ok = providers.filter((p) => p.balance && p.balance.status === "ok").length;
			return react.createElement("span", null, providers.length + " 个 Provider · " + ok + " 个可查余额");
		}
		const homeStats = { heartbeat: HeartbeatStat, theme: ThemeStat, balance: BalanceStat };
		function HomeView(props) {
			const [, force] = react.useReducer((n) => n + 1, 0);
			const open = (id) => { if (props && typeof props.onOpen === "function") props.onOpen(id); };
			return react.createElement("div", { className: "dockh-grid" },
				MODULES.map((m) => {
					const st = state.get(m.id);
					const enabled = !!(st && st.enabled);
					const Stat = homeStats[m.id];
					return react.createElement("div", {
						key: m.id,
						className: "dockh-card",
						role: "button",
						tabIndex: 0,
						onClick: () => open(m.id),
						onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(m.id); } }
					},
						react.createElement("div", { className: "dockh-head" },
							react.createElement("span", { className: "dockm-dot", style: { background: m.accent } }),
							react.createElement("span", { className: "dockh-name" }, m.name),
							react.createElement("span", { className: "dockh-badge" + (m.planned ? "" : enabled ? " on" : " off") },
								m.planned ? "规划中" : enabled ? "已启用" : "已停用")),
						react.createElement("div", { className: "dockh-desc" }, m.description),
						react.createElement("div", { className: "dockh-stat" },
							m.planned
								? react.createElement("span", null, PLANNED_NOTES[m.id] || "待接入：见 README 路线图")
								: enabled && Stat
									? react.createElement(Stat, null)
									: react.createElement("span", null, "已停用，启用后在此展示运行概要")),
						react.createElement("div", { className: "dockh-foot" },
							react.createElement("span", { className: "dockh-go" }, "查看详情 →"),
							m.planned ? null : react.createElement("button", {
								type: "button",
								className: "dockm-switch" + (enabled ? " on" : ""),
								onClick: (e) => {
									e.stopPropagation();
									toggleFeature(m.id);
									// onToggle = DockModal 的 force：连带刷新弹层脚注的「N 个已启用」统计
									if (props && typeof props.onToggle === "function") props.onToggle();
									force();
								}
							}, enabled ? "停用" : "启用")));
				}));
		}

			// ---- 每个功能的客户端视图：key 与注册表 id 一致 ----
			const featureViews = {
			heartbeat: function HeartbeatView() {
				const [txt, setTxt] = react.useState(uptimeText());
				react.useEffect(() => ctx.interval(() => setTxt(uptimeText()), 1000), []);
				return react.createElement("div", null, txt);
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
				// 数据与刷新走共享 balanceStore：首页总揽、弹层与设置页共用同一份快照（挂载即拉取，5 分钟自动刷新）
				const snap = useBalance();
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
					react.createElement("div", { className: "dock-intro" },
						"功能坞（dsh-dock）· 所有小功能集中在这一个面板里管理。每个功能是独立模块：开关只影响自己，单个功能出错不影响其他功能。新功能按注册表模式追加（FEATURES + featureViews 各加一条）。"),
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

			slots.inject("sidebar.footer.action", () => slots.register(
				{ name: "sidebar.footer.action", id: "dsh-dock", order: 1, label: "功能坞" },
				(props) => react.createElement(DockEntry, props)));
			slots.inject("shell.overlay", () => slots.register(
				{ name: "shell.overlay", id: "dsh-dock-panel", order: 21, label: "功能坞面板" },
				() => react.createElement(DockModal, null)));
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "dsh-dock", order: 90, label: "功能坞" },
				() => react.createElement(DockPanel, null)));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});