// dsh-dock · 功能模块【模型设置】· 客户端视图（v0.3.0 迁自 client.js，行为不变）
// modelconfig 视图经 /dsh-dock/models（GET 目录 / POST 写回）编辑各 Provider 模型的
// 输入类型与思考强度档位，写回官方 settings 热生效。图片理解代理（visionproxy 宿主功能）
// 的全局配置面板也渲染在本页顶部。
import react from "react";

// ---- 模型设置共享快照：视图与首页总揽共用一份目录数据（手动刷新，不轮询） ----
const modelsStore = {
	snap: { data: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	set(patch) { this.snap = Object.assign({}, this.snap, patch); for (const fn of this.listeners) fn(); },
	load() {
		if (this.snap.loading) return;
		this.set({ loading: true, error: null });
		// Provider 可在 DSH 原生模型设置中随时增删；不要复用浏览器缓存，
		// 否则返回本页时仍可能看到旧的共享快照。
		fetch("dsh-dock/models", { cache: "no-store", signal: AbortSignal.timeout(20000) })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("模型目录接口 HTTP " + res.status))))
			.then((data) => this.set({ data: data, loading: false, error: null }))
			.catch((e) => this.set({ loading: false, error: (e && e.message) || String(e) }));
	}
};
function useModels() {
	const [snap, setSnap] = react.useState(modelsStore.snap);
	react.useEffect(() => {
		const off = modelsStore.subscribe(() => setSnap(modelsStore.snap));
		if (!modelsStore.snap.data && !modelsStore.snap.loading) modelsStore.load();
		return off;
	}, []);
	return snap;
}

// ---- 编辑常量与草稿工具 ----
// 官方 schema 接受的真实输入模态；其余（视频等）仅作为 dockTags 标注随配置持久化
const DKM_MODALITIES = [["text", "文本"], ["image", "图片"]];
const DKM_TAGS = [["video", "视频"], ["audio", "音频"], ["document", "文档"]];
const DKM_PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DKM_DS_LEVELS = ["off", "low", "high", "max"];
const DKM_EFFORT_NAMES = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
// Provider 级增删改：api 协议选项（与宿主 PI_AI_APIS 一致）与路由 key 约束（与宿主同规则）
const DKM_APIS = [
	["openai-completions", "OpenAI 兼容（chat/completions）"],
	["openai-responses", "OpenAI Responses"],
	["anthropic-messages", "Anthropic Messages"]
];
const DKM_ROUTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 由路由 key 推导凭据库条目名：jiyuanlvdong -> JIYUANLVDONG_API_KEY。让 apiKeyEnv 可以真的留空。 */
function dkmEnvFromRoute(route) {
	const s = String(route || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	if (!s) return "";
	return (/^[0-9]/.test(s) ? "KEY_" + s : s) + "_API_KEY";
}
const DKM_ALL_INPUT = DKM_MODALITIES.map((x) => x[0]);
const DKM_ALL_TAGS = DKM_TAGS.map((x) => x[0]);

function dkmToggleIn(list, v) {
	return list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : list.concat([v]);
}
function dkmAllInputs(on) {
	return { input: on ? DKM_ALL_INPUT.slice() : [], tags: on ? DKM_ALL_TAGS.slice() : [] };
}
function dkmAllLevels(on) {
	const lv = {};
	for (const k of DKM_PI_LEVELS) lv[k] = !!on;
	return { effortsMode: "custom", effortLevels: lv };
}

/** 单个目录模型条目 → 可编辑草稿（目录编辑器与 Provider 表单共用）。 */
function draftFromModel(m) {
	// effortMap: {档位: wire}，声明过（wire 字符串或 null）即视为勾选，undefined = 未提供
	const levels = {};
	if (m.efforts === "custom" && m.effortMap && typeof m.effortMap === "object") {
		for (const lv of DKM_PI_LEVELS) levels[lv] = m.effortMap[lv] !== undefined;
	}
	return {
		id: m.id || "",
		name: m.name || "",
		contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
		maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
		input: m.input && m.input.length ? m.input.slice() : ["text"],
		tags: (m.tags || []).slice(),
		effortsMode: m.efforts === "custom" ? "custom" : m.efforts === "off" ? "off" : "inherit",
		effortLevels: levels,
		raw: m.raw && typeof m.raw === "object" ? m.raw : null
	};
}

/** 空白模型行（新增 Provider / 添加模型用）。 */
function emptyModelDraft() {
	return { id: "", name: "", contextWindow: "", maxTokens: "", input: ["text"], tags: [], effortsMode: "inherit", effortLevels: {}, raw: null };
}

/** 新增 Provider 的空表单。 */
function emptyProviderForm() {
	return {
		route: "",
		displayName: "",
		api: "openai-completions",
		baseURL: "",
		apiKeyEnv: "",
		apiKey: "",
		defaultInput: ["text"],
		models: [],
		extra: {}
	};
}

/**
 * 由目录 Provider 视图构建「编辑 Provider」表单。
 * 以用户层原始配置（rawProfile）为准回填；面板不负责的未知字段（自配 compat/description 等）
 * 收进 extra，保存时原样并回，避免把用户手写配置抹掉。API Key 明文永不回显。
 */
function providerFormFromProvider(p) {
	const raw = p.rawProfile && typeof p.rawProfile === "object" && !Array.isArray(p.rawProfile) ? p.rawProfile : {};
	const extra = Object.assign({}, raw);
	delete extra.displayName; delete extra.api; delete extra.baseURL;
	delete extra.apiKeyEnv; delete extra.defaultInput; delete extra.models;
	const models = draftFromProvider(p).models;
	return {
		route: p.route || p.id || "",
		displayName: typeof raw.displayName === "string" ? raw.displayName : (p.displayName || ""),
		api: typeof raw.api === "string" && raw.api ? raw.api : (p.api || "openai-completions"),
		baseURL: typeof raw.baseURL === "string" ? raw.baseURL : (p.baseURL || ""),
		apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : (p.apiKeyEnv || ""),
		apiKey: "",
		defaultInput: Array.isArray(raw.defaultInput) && raw.defaultInput.length
			? raw.defaultInput.slice()
			: (Array.isArray(p.defaultInput) && p.defaultInput.length ? p.defaultInput.slice() : ["text"]),
		models: models.length ? models : [emptyModelDraft()],
		extra
	};
}

/** 从目录 Provider 视图构建可编辑草稿。 */
function draftFromProvider(p) {
	return {
		id: p.id,
		kind: p.kind,
		thinking: p.thinking === "disabled" ? "disabled" : "enabled",
		defaultEffort: DKM_DS_LEVELS.indexOf(p.defaultEffort) >= 0 ? p.defaultEffort : "high",
		models: (p.models || []).map(draftFromModel)
	};
}

/**
 * 单个模型编辑行（Provider 表单与目录模型编辑器共用；无 hook，可直接当纯函数调用）。
 * props: { m, i, kind, onPatch(i, patch), onDel(i) }
 */
function ModelRow(props) {
	const m = props.m, i = props.i, kind = props.kind, onPatch = props.onPatch, onDel = props.onDel;
	return react.createElement("div", { key: i, className: "dkm-model" },
		react.createElement("div", { className: "dkm-model-head" },
			react.createElement("span", { className: "dkm-model-idx" }, "#" + (i + 1)),
			react.createElement("button", { type: "button", className: "dkm-del", onClick: () => onDel(i) }, "删除")),
		react.createElement("div", { className: "dkm-grid" },
			react.createElement("input", { className: "dkm-input", placeholder: "模型 id（必填，如 deepseek-v4-pro）", value: m.id, onChange: (e) => onPatch(i, { id: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "显示名称（可选）", value: m.name, onChange: (e) => onPatch(i, { name: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "上下文窗口", inputMode: "numeric", value: m.contextWindow, onChange: (e) => onPatch(i, { contextWindow: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "最大输出", inputMode: "numeric", value: m.maxTokens, onChange: (e) => onPatch(i, { maxTokens: e.target.value }) })),
		react.createElement("div", { className: "dkm-checks" },
			react.createElement("span", { className: "dkm-label" }, "输入类型："),
			DKM_MODALITIES.map(([v, label]) => react.createElement("label", {
				key: v,
				className: "dkm-check",
				title: v === "image" ? "由你声明该端点支持图片：保存后原图直发，并可作为视觉模型候选。系统不会替你猜测；端点实际不支持时取消勾选即可恢复走图片理解代理" : null
			},
				react.createElement("input", {
					type: "checkbox",
					checked: m.input.indexOf(v) >= 0,
					onChange: () => {
						const next = dkmToggleIn(m.input, v);
						onPatch(i, { input: next.length > 0 ? next : ["text"] });
					}
				}),
				label)),
			react.createElement("span", { className: "dkm-label dkm-tag", title: "标注仅在本面板展示与持久化，不参与请求路由（官方 schema 只接受文本/图片）" }, "标注："),
			DKM_TAGS.map(([v, label]) => react.createElement("label", { key: v, className: "dkm-check dkm-tag" },
				react.createElement("input", { type: "checkbox", checked: m.tags.indexOf(v) >= 0, onChange: () => onPatch(i, { tags: dkmToggleIn(m.tags, v) }) }),
				label)),
			react.createElement("button", { type: "button", className: "dkm-mini", title: "一键勾选全部输入类型与标注", onClick: () => onPatch(i, dkmAllInputs(true)) }, "全选"),
			react.createElement("button", { type: "button", className: "dkm-mini", title: "一键取消全部勾选（输入留空 = 继承目录默认）", onClick: () => onPatch(i, dkmAllInputs(false)) }, "取消全选")),
		react.createElement("div", { className: "dkm-efforts" },
			react.createElement("span", { className: "dkm-label" }, "思考强度："),
			kind === "deepseek"
				? react.createElement("span", { className: "dkm-sub" }, "随 Provider 设置（Off/Low/High/Max，全模型共享）")
				: react.createElement("span", null,
					react.createElement("select", {
						className: "dkm-select",
						value: m.effortsMode,
						onChange: (e) => onPatch(i, {
							effortsMode: e.target.value,
							effortLevels: e.target.value === "custom" && m.effortsMode !== "custom"
								? { off: true, low: true, high: true }
								: m.effortLevels
						})
					},
						react.createElement("option", { value: "inherit" }, "跟随目录默认"),
						react.createElement("option", { value: "off" }, "不支持思考"),
						react.createElement("option", { value: "custom" }, "自定义档位")),
					m.effortsMode === "custom"
						? DKM_PI_LEVELS.map((lv) => react.createElement("label", { key: lv, className: "dkm-check" },
							react.createElement("input", {
								type: "checkbox",
								checked: !!m.effortLevels[lv],
								onChange: () => {
									const nl = Object.assign({}, m.effortLevels);
									nl[lv] = !nl[lv];
									onPatch(i, { effortLevels: nl });
								}
							}),
							DKM_EFFORT_NAMES[lv] || lv))
						: null,
					react.createElement("button", { type: "button", className: "dkm-mini", title: "一键勾选全部强度档（切为自定义）", onClick: () => onPatch(i, dkmAllLevels(true)) }, "全选"),
					react.createElement("button", { type: "button", className: "dkm-mini", title: "一键取消全部强度档", onClick: () => onPatch(i, dkmAllLevels(false)) }, "取消全选"))));
}

function ModelsView(props) {
	const snap = useModels();
	const data = snap.data;
	const providers = data && Array.isArray(data.providers) ? data.providers : [];
	const params = props && props.params;
	const [selId, setSelId] = react.useState(null);
	const [draft, setDraft] = react.useState(null);
	const [builtKey, setBuiltKey] = react.useState(null);
	const [dirty, setDirty] = react.useState(false);
	const [saving, setSaving] = react.useState(false);
	const [msg, setMsg] = react.useState(null);
	// 图片理解代理（全局配置，独立于 Provider 草稿）
	const [vpDraft, setVpDraft] = react.useState(null);
	const [vpBuilt, setVpBuilt] = react.useState(null);
	const [vpDirty, setVpDirty] = react.useState(false);
	const [vpSaving, setVpSaving] = react.useState(false);
	const [vpMsg, setVpMsg] = react.useState(null);
	const [vpDirectExpanded, setVpDirectExpanded] = react.useState(false);
	// 子页面路由：page = "settings"（模型设置主页）| "providers"（模型提供商子页面）
	const [page, setPage] = react.useState("settings");
	// 进入「模型提供商」子页面时是否直接展开新增表单（deep-link：params.openProviderForm）
	const [pageOpenCreate, setPageOpenCreate] = react.useState(false);

	// 每次进入模型设置都重新读取官方目录。modelsStore 是跨页面共享快照，
	// 原生设置刚新增 Provider 时不能要求用户再滚到页面底部手动刷新。
	react.useEffect(() => { modelsStore.load(); }, []);
	const refreshModels = () => {
		setBuiltKey(null);
		modelsStore.load();
	};

	const cur = providers.length > 0 ? (providers.find((p) => p.id === selId) || providers[0]) : null;
	// 选中 Provider 或目录刷新时重建草稿（render 期受控重置；msg 只在切 Provider/编辑时清）
	const wantKey = cur ? cur.id + ":" + String(data && data.generatedAt || 0) : null;
	if (cur && builtKey !== wantKey) {
		setBuiltKey(wantKey);
		setDraft(draftFromProvider(cur));
		setDirty(false);
	}
	// 图片代理草稿随目录刷新重建（保存成功 → load() → 新 generatedAt → 重建为已保存态，msg 保留）
	const vpWantKey = data ? String(data.generatedAt) : null;
	if (data && vpBuilt !== vpWantKey) {
		setVpBuilt(vpWantKey);
		const vp = data.visionProxy || {};
		setVpDraft({ enabled: !!vp.enabled, provider: String(vp.provider || ""), model: String(vp.model || "") });
		setVpDirty(false);
	}
	const saveVp = () => {
		if (!vpDraft || vpSaving) return;
		setVpSaving(true);
		fetch("dsh-dock/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ visionProxy: vpDraft, revisions: (data && data.revisions) || {} }),
			signal: AbortSignal.timeout(20000)
		})
			.then((res) => res.json()
				.then((b2) => ({ status: res.status, body: b2 }))
				.catch(() => ({ status: res.status, body: {} })))
			.then((r2) => {
				if (r2.status === 200 && r2.body && r2.body.ok) {
					setVpMsg({ ok: true, text: "图片代理配置已保存，即时生效" });
					modelsStore.load();
				} else {
					setVpMsg({ ok: false, text: (r2.body && r2.body.error) || ("HTTP " + r2.status) });
				}
			})
			.catch((e) => setVpMsg({ ok: false, text: (e && e.message) || String(e) }))
			.then(() => setVpSaving(false));
	};

	const patchDraft = (patch) => { setDraft(Object.assign({}, draft, patch)); setDirty(true); setMsg(null); };
	const patchModel = (i, patch) => {
		const models = draft.models.slice();
		models[i] = Object.assign({}, models[i], patch);
		patchDraft({ models: models });
	};
	const toggleIn = (list, v) => list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : list.concat([v]);
	// 一键批量：输入支持（官方模态 + 标注）与强度档。输入留空 = 继承目录默认（Host 写回时删除 input 字段，安全）
	const ALL_INPUT = DKM_MODALITIES.map((x) => x[0]);
	const ALL_TAGS = DKM_TAGS.map((x) => x[0]);
	const allInputs = (on) => ({ input: on ? ALL_INPUT.slice() : [], tags: on ? ALL_TAGS.slice() : [] });
	const allLevels = (on) => {
		const lv = {};
		for (const k of DKM_PI_LEVELS) lv[k] = !!on;
		return { effortsMode: "custom", effortLevels: lv };
	};
	const bulkModels = (fn) => patchDraft({ models: draft.models.map((m) => Object.assign({}, m, fn(m))) });
	const selectProvider = (id) => { setSelId(id); setMsg(null); };

	// deep-link：params.page === "providers" 直达「模型提供商」子页面；
	// params.openProviderForm 再直接展开新增表单（设置页深链与渲染回归测试共用）。
	react.useEffect(() => {
		if (params && params.page === "providers") setPage("providers");
		if (params && params.openProviderForm) { setPage("providers"); setPageOpenCreate(true); }
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const save = () => {
		if (!draft || !cur || !dirty || saving) return;
		const models = draft.models.map((m) => ({
			id: String(m.id || "").trim(),
			name: String(m.name || "").trim(),
			contextWindow: m.contextWindow === "" ? undefined : Number(m.contextWindow),
			maxTokens: m.maxTokens === "" ? undefined : Number(m.maxTokens),
			input: m.input,
			tags: m.tags,
			effortsMode: m.effortsMode,
			effortLevels: m.effortLevels,
			raw: m.raw
		}));
		const payload = { provider: cur.id, revisions: (data && data.revisions) || {}, models: models };
		if (cur.kind === "deepseek") {
			payload.thinking = draft.thinking;
			payload.defaultEffort = draft.defaultEffort;
		}
		setSaving(true);
		fetch("dsh-dock/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(20000)
		})
			.then((res) => res.json()
				.then((body2) => ({ status: res.status, body: body2 }))
				.catch(() => ({ status: res.status, body: {} })))
			.then((r2) => {
				if (r2.status === 200 && r2.body && r2.body.ok) {
					setMsg({ ok: true, text: "已写回官方配置；重新打开会话模型选择器即可选择新模型/强度档" });
					modelsStore.load();
				} else {
					setMsg({ ok: false, text: (r2.body && r2.body.error) || ("HTTP " + r2.status) });
				}
			})
			.catch((e) => setMsg({ ok: false, text: (e && e.message) || String(e) }))
			.then(() => setSaving(false));
	};

	// 目录模型编辑行：委托给共用的 ModelRow（kind 用当前 Provider 的类型）
	const modelRow = (m, i) => ModelRow({
		m, i, kind: cur.kind,
		onPatch: (j, patch) => patchModel(j, patch),
		onDel: (j) => patchDraft({ models: draft.models.filter((_, k) => k !== j) })
	});

	// ---- 子页面：模型提供商 ----
	// 整块替换模型设置主页内容（官方「模型」设置页同款布局）。这里是独立组件，
	// 因此返回主页时自动卸载——未保存的 Provider 草稿不会悄悄留在后台。
	if (page === "providers") {
		return react.createElement(ProvidersPage, {
			data: data,
			providers: providers,
			loading: snap.loading,
			error: snap.error,
			openCreate: pageOpenCreate,
			onCreateHandled: () => setPageOpenCreate(false),
			// 返回主页时顺手重读目录：子页面里增删改过的 Provider 立即反映到模型编辑器
			onBack: () => { setPage("settings"); refreshModels(); }
		});
	}

	const body = [];
	if (data) {
		body.push(react.createElement("div", { key: "refresh", className: "dkm-topbar" },
			react.createElement("span", { className: "dkm-sub" }, "已载入 " + providers.length + " 个 Provider；在 DSH 原生模型设置中新增后，返回本页会自动更新"),
			react.createElement("button", { type: "button", className: "dkb-refresh", disabled: snap.loading || saving, onClick: refreshModels }, snap.loading ? "刷新中…" : "刷新模型目录")));
	}
	if (snap.error) {
		body.push(react.createElement("div", { key: "err", className: "dkm-error" },
			"模型目录拉取失败：" + snap.error + " ",
			react.createElement("button", { type: "button", className: "dkb-refresh", onClick: () => modelsStore.load() }, "重试")));
	} else if (!data) {
		body.push(react.createElement("div", { key: "loading", className: "dkm-note" }, snap.loading ? "正在拉取模型目录…" : "等待拉取模型目录"));
	}

	// ---- 图片理解代理（全局配置）：纯文本模型收图自动走视觉模型识别 ----
	// 宿主较旧（GET 无 visionProxy 字段）时降级为提示，避免保存撞到旧写回分支
	if (data && data.visionProxy === undefined) {
		body.push(react.createElement("div", { key: "visionproxy-old", className: "dkm-note" },
			"图片理解代理需要新版宿主进程：当前 dsh web 较旧，重启后此面板可用。"));
	}
	if (data && data.visionProxy !== undefined && vpDraft) {
		// 用户在模型设置里勾选「图片」即可决定原图直发和视觉候选；
		// 运行时目录仅作自动提示，不能排除用户明确声明的模型。
		// 无论哪种来源都不等同于联网实测，凭据、额度和上游状态仍以真实调用为准。
		const runtimeImage = (m) => Array.isArray(m.runtimeInput) && m.runtimeInput.indexOf("image") >= 0;
		const declaredImage = (m) => Array.isArray(m.input) && m.input.indexOf("image") >= 0;
		const vpDirect = [];
		const vpProxied = [];
		for (const p of providers) {
			for (const m of (p.models || [])) {
				const declared = declaredImage(m);
				const runtime = runtimeImage(m);
				const source = declared ? "你已标记图片" : (runtime ? "运行时识别" : "未标记图片");
				const item = {
					key: p.id + "/" + m.id,
					label: (p.displayName || p.id) + " / " + (m.name || m.id) + "（" + source + "）",
					model: m.name || m.id,
					source: source,
					declared: declared,
				};
				((declared || runtime) ? vpDirect : vpProxied).push(item);
			}
		}
		const vpCandidates = vpDirect.slice();
		const vpKey = vpDraft.provider + "/" + vpDraft.model;
		const vpKnown = vpCandidates.some((c) => c.key === vpKey);
		body.push(react.createElement("div", { key: "visionproxy", className: "dkm-prov" },
				react.createElement("div", { className: "dkm-prov-head" },
					react.createElement("span", { className: "dkm-name" }, "图片理解代理"),
					react.createElement("span", { className: "dkm-badge" }, vpDraft.enabled ? "已启用" : "已停用"),
					react.createElement("span", { className: "dkm-sub" }, "纯文本模型收到图片时自动调用所选视觉模型识别，识别文本替换图片；多模态模型原样自识别")),
				react.createElement("div", { className: "dkm-note dkm-warn" },
					"⚠ 本功能会调用视觉模型识别图片，消耗 token（每次识图按视觉模型计费）。默认关闭；不开启则插件其余功能均不消耗任何 token。"),
			react.createElement("div", { className: "dkm-checks" },
				react.createElement("label", { className: "dkm-check" },
					react.createElement("input", {
						type: "checkbox",
						checked: vpDraft.enabled,
						onChange: () => { setVpDraft(Object.assign({}, vpDraft, { enabled: !vpDraft.enabled })); setVpDirty(true); setVpMsg(null); }
					}),
					"启用"),
				react.createElement("span", { className: "dkm-label" }, "视觉模型："),
				react.createElement("select", {
					className: "dkm-select",
					value: vpKey,
					onChange: (e) => {
						const idx = e.target.value.indexOf("/");
						setVpDraft(Object.assign({}, vpDraft, { provider: e.target.value.slice(0, idx), model: e.target.value.slice(idx + 1) }));
						setVpDirty(true);
						setVpMsg(null);
					}
				},
					react.createElement("option", { value: "/" }, "（未选择）"),
					!vpKnown && vpDraft.provider ? react.createElement("option", { value: vpKey }, vpDraft.provider + " / " + vpDraft.model + "（当前）") : null,
					vpCandidates.map((c) => react.createElement("option", { key: c.key, value: c.key }, c.label))),
				vpCandidates.length === 0
					? react.createElement("span", { className: "dkm-sub" }, "还没有标记图片能力的模型——在下方给你确认支持图片的模型勾选「图片」并保存")
					: null),
			react.createElement("div", { className: "dkm-sub" },
				"以你在下方勾选的「图片」为准；运行时识别只是辅助提示。它不代表已联网实测可调用，实际可用性仍取决于 Provider 凭据、额度与上游服务。若端点实际不认图，取消该模型的「图片」勾选即可恢复走图片理解代理。"),
			vpDirect.length > 0
				? react.createElement("div", { className: "dkm-capabilities" },
					react.createElement("div", { className: "dkm-checks" },
						react.createElement("span", { className: "dkm-label" }, "原图直发候选（你的标记优先，" + vpDirect.length + "）："),
						react.createElement("button", {
							type: "button",
							className: "dkm-mini",
							"aria-expanded": vpDirectExpanded,
							onClick: () => setVpDirectExpanded(!vpDirectExpanded)
						}, vpDirectExpanded ? "收起列表" : "展开列表")),
					vpDirectExpanded
						? react.createElement("div", { className: "dkm-checks dkm-capability-list" },
							vpDirect.map((c) => react.createElement("span", { key: c.key, className: "dkm-chip", title: c.key + " · " + c.source }, c.model)))
						: null)
				: null,
			vpProxied.length > 0
				? react.createElement("div", { className: "dkm-checks" },
						react.createElement("span", { className: "dkm-label" }, "走视觉代理（未标记图片，" + vpProxied.length + "）："),
					react.createElement("span", { className: "dkm-sub" }, vpProxied.map((c) => c.model).join("、")))
				: null,
			react.createElement("div", { className: "dkm-savebar" },
				react.createElement("button", { type: "button", className: "dkm-save", disabled: !vpDirty || vpSaving, onClick: saveVp }, vpSaving ? "保存中…" : "保存图片代理配置"),
				vpMsg ? react.createElement("span", { className: "dkm-msg " + (vpMsg.ok ? "ok" : "err") }, vpMsg.text)
					: react.createElement("span", { className: "dkm-msg" }, vpDirty ? "有未保存的修改" : ""))));
	}

	// ---- 模型提供商入口卡（子页面入口；卡片外观与官方模型管理页的行卡片一致）----
	if (data) {
		const custom = providers.filter((p) => p.kind === "pi-ai");
		const missingKey = custom.filter((p) => p.apiKeyEnv && !p.apiKeyConfigured).length;
		body.push(react.createElement("div", { key: "pf-entry", className: "dkp-card" },
			react.createElement("div", { className: "dkp-rowhead" },
				react.createElement("span", { className: "dkp-identity" },
					react.createElement("span", { className: "dkp-name" }, "模型提供商"),
					react.createElement("span", { className: "dkp-tag" }, custom.length + " 个自定义路由"),
					custom.length > 0
						? react.createElement("span", {
							className: "dkp-dot " + (missingKey > 0 ? "warn" : "ok"),
							role: "img",
							title: missingKey > 0 ? "有 " + missingKey + " 个 Provider 未配置密钥" : "密钥均已配置",
							"aria-label": missingKey > 0 ? "有 Provider 未配置密钥" : "密钥均已配置"
						})
						: null),
				react.createElement("span", { className: "dkp-actions" },
					react.createElement("button", {
						type: "button",
						className: "dkp-btn ghost sm",
						onClick: () => setPage("providers")
					}, "管理"))),
			react.createElement("p", { className: "dkp-hint" },
				"新增 / 编辑 / 删除自定义模型 Provider（OpenAI 兼容、Anthropic 等），写入官方配置并热生效；API Key 存本机凭据库（文件仅 root 可读）。")));
	}

	if (data && providers.length === 0) {
		body.push(react.createElement("div", { key: "empty", className: "dkm-note" }, "没有可编辑的模型 Provider（Host 侧尚未配置）"));
	}
	if (providers.length > 0) {
		body.push(react.createElement("div", { key: "chips", className: "dkm-chips" },
			providers.map((p) => react.createElement("button", {
				type: "button",
				key: p.id,
				className: "dkm-chip" + (cur && p.id === cur.id ? " on" : ""),
				onClick: () => selectProvider(p.id)
			}, p.displayName + "（" + (p.models ? p.models.length : 0) + "）"))));
	}
	if (cur && draft) {
		body.push(react.createElement("div", { key: "prov", className: "dkm-prov" },
			react.createElement("div", { className: "dkm-prov-head" },
				react.createElement("span", { className: "dkm-name" }, cur.displayName),
				react.createElement("span", { className: "dkm-badge" }, cur.kind === "deepseek" ? "官方 DeepSeek" : "自定义路由"),
				react.createElement("span", { className: "dkm-sub" }, [cur.api, cur.baseURL].filter(Boolean).join(" · "))),
			cur.kind === "deepseek"
				? react.createElement("div", { className: "dkm-controls" },
					react.createElement("span", { className: "dkm-label" }, "思考模式："),
					react.createElement("select", { className: "dkm-select", value: draft.thinking, onChange: (e) => patchDraft({ thinking: e.target.value }) },
						react.createElement("option", { value: "enabled" }, "开启"),
						react.createElement("option", { value: "disabled" }, "关闭")),
					react.createElement("span", { className: "dkm-label" }, "默认强度："),
					react.createElement("select", { className: "dkm-select", value: draft.defaultEffort, onChange: (e) => patchDraft({ defaultEffort: e.target.value }) },
						DKM_DS_LEVELS.map((lv) => react.createElement("option", { key: lv, value: lv }, DKM_EFFORT_NAMES[lv] || lv))))
				: null,
			react.createElement("div", { className: "dkm-toolbar" },
				react.createElement("span", { className: "dkm-toolbar-label" }, "批量（全部模型）："),
				react.createElement("button", { type: "button", className: "dkm-mini", title: "全部模型：勾选全部输入类型与标注", onClick: () => bulkModels(() => allInputs(true)) }, "输入全选"),
				react.createElement("button", { type: "button", className: "dkm-mini", title: "全部模型：取消全部输入勾选（留空 = 继承目录默认）", onClick: () => bulkModels(() => allInputs(false)) }, "输入取消全选"),
				cur.kind !== "deepseek"
					? react.createElement("button", { type: "button", className: "dkm-mini", title: "全部模型：勾选全部强度档（切为自定义）", onClick: () => bulkModels(() => allLevels(true)) }, "强度全选")
					: null,
				cur.kind !== "deepseek"
					? react.createElement("button", { type: "button", className: "dkm-mini", title: "全部模型：取消全部强度档", onClick: () => bulkModels(() => allLevels(false)) }, "强度取消全选")
					: null),
			react.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } },
				draft.models.map(modelRow),
				react.createElement("button", {
					type: "button",
					className: "dkm-add",
					onClick: () => patchDraft({
						models: draft.models.concat([{ id: "", name: "", contextWindow: "", maxTokens: "", input: ["text"], tags: [], effortsMode: "inherit", effortLevels: {} }])
					})
				}, "+ 添加模型")),
			react.createElement("div", { className: "dkm-savebar" },
				react.createElement("span", { className: "dkm-msg" }, dirty ? "有未保存的修改" : "无未保存修改"),
				react.createElement("button", { type: "button", className: "dkm-save", disabled: !dirty || saving, onClick: save }, saving ? "保存中…" : "保存写回官方配置"),
				react.createElement("button", { type: "button", className: "dkb-refresh", disabled: saving || snap.loading, onClick: refreshModels }, snap.loading ? "刷新中…" : "重新拉取"),
				msg ? react.createElement("span", { className: "dkm-msg " + (msg.ok ? "ok" : "err") }, msg.text) : null)));
	}
	return react.createElement("div", { className: "dkm-list" }, body);
}

/**
 * Provider 表单里的单个模型行（官方模型行同款：id / 名称 / 容量 一行网格，下方输入类型与思考强度）。
 * props: { m, i, onPatch(i, patch), onDel(i) }
 */
function ProviderModelRow(props) {
	const m = props.m;
	const i = props.i;
	const check = (v, list, kind) => react.createElement("label", { key: v[0], className: "dkp-check" },
		react.createElement("input", {
			type: "checkbox",
			checked: list.indexOf(v[0]) >= 0,
			onChange: () => {
				const next = dkmToggleIn(list, v[0]);
				props.onPatch(i, kind === "input" ? { input: next.length > 0 ? next : ["text"] } : { tags: next });
			}
		}),
		v[1]);
	return react.createElement("div", { className: "dkp-model-entry" },
		react.createElement("div", { className: "dkp-model-row" },
			react.createElement("input", { className: "dkp-input", placeholder: "模型 id（必填）", value: m.id, onChange: (e) => props.onPatch(i, { id: e.target.value }) }),
			react.createElement("input", { className: "dkp-input", placeholder: "显示名称（可选）", value: m.name, onChange: (e) => props.onPatch(i, { name: e.target.value }) }),
			react.createElement("input", { className: "dkp-input", placeholder: "上下文窗口", inputMode: "numeric", value: m.contextWindow, onChange: (e) => props.onPatch(i, { contextWindow: e.target.value }) }),
			react.createElement("input", { className: "dkp-input", placeholder: "最大输出", inputMode: "numeric", value: m.maxTokens, onChange: (e) => props.onPatch(i, { maxTokens: e.target.value }) }),
			react.createElement("button", { type: "button", className: "dkp-iconbtn danger", title: "删除该模型", "aria-label": "删除模型", onClick: () => props.onDel(i) }, "✕")),
		react.createElement("div", { className: "dkp-model-opts" },
			react.createElement("div", { className: "dkp-checks" },
				react.createElement("span", { className: "dkp-flabel" }, "输入类型："),
				DKM_MODALITIES.map((v) => check(v, m.input, "input")),
				react.createElement("span", { className: "dkp-flabel dkp-dim", title: "标注仅在本面板展示与持久化，不参与请求路由（官方 schema 只接受文本/图片）" }, "标注："),
				DKM_TAGS.map((v) => check(v, m.tags, "tags")),
				react.createElement("button", { type: "button", className: "dkp-mini", title: "一键勾选全部输入类型与标注", onClick: () => props.onPatch(i, dkmAllInputs(true)) }, "全选"),
				react.createElement("button", { type: "button", className: "dkp-mini", title: "一键取消全部勾选", onClick: () => props.onPatch(i, dkmAllInputs(false)) }, "取消全选")),
			react.createElement("div", { className: "dkp-checks" },
				react.createElement("span", { className: "dkp-flabel" }, "思考强度："),
				react.createElement("select", {
					className: "dkp-input dkp-select dkp-select-sm",
					value: m.effortsMode,
					onChange: (e) => props.onPatch(i, {
						effortsMode: e.target.value,
						effortLevels: e.target.value === "custom" && m.effortsMode !== "custom"
							? { off: true, low: true, high: true }
							: m.effortLevels
					})
				},
					react.createElement("option", { value: "inherit" }, "跟随目录默认"),
					react.createElement("option", { value: "off" }, "不支持思考"),
					react.createElement("option", { value: "custom" }, "自定义档位")),
				m.effortsMode === "custom"
					? DKM_PI_LEVELS.map((lv) => react.createElement("label", { key: lv, className: "dkp-check" },
						react.createElement("input", {
							type: "checkbox",
							checked: !!m.effortLevels[lv],
							onChange: () => {
								const nl = Object.assign({}, m.effortLevels);
								nl[lv] = !nl[lv];
								props.onPatch(i, { effortLevels: nl });
							}
						}),
						DKM_EFFORT_NAMES[lv] || lv))
					: null,
				react.createElement("button", { type: "button", className: "dkp-mini", title: "一键勾选全部强度档（切为自定义）", onClick: () => props.onPatch(i, dkmAllLevels(true)) }, "全选"),
				react.createElement("button", { type: "button", className: "dkp-mini", title: "一键取消全部强度档", onClick: () => props.onPatch(i, dkmAllLevels(false)) }, "取消全选"))));
}

/**
 * 模型提供商子页面：官方「模型」设置页同款布局——
 * 返回入口 + 标题 + 说明 + 行卡片列表（每行可展开同一个编辑卡片）+ 底部虚线「新增 Provider」。
 * 只管自定义 pi-ai 路由的增删改（内置 DeepSeek 官方 Provider 在主页编辑其模型目录）。
 * 由 ModelsView 在 page === "providers" 时整页替换渲染；返回主页即卸载，草稿不会留在后台。
 */
function ProvidersPage(props) {
	const data = props.data;
	const providers = props.providers || [];
	const piProviders = providers.filter((p) => p.kind === "pi-ai");
	// pfMode = "create" | "edit" | null；pfDraft 为对应草稿（同一时刻只开一个编辑卡片）
	const [pfMode, setPfMode] = react.useState(null);
	const [pfDraft, setPfDraft] = react.useState(null);
	const [pfDirty, setPfDirty] = react.useState(false);
	const [pfSaving, setPfSaving] = react.useState(false);
	const [pfMsg, setPfMsg] = react.useState(null);
	const [pfDelArm, setPfDelArm] = react.useState(null);
	const [pfFetching, setPfFetching] = react.useState(false);
	const [pfFetchedList, setPfFetchedList] = react.useState(null);

	const openPfCreate = () => {
		setPfMode("create"); setPfDraft(emptyProviderForm()); setPfDirty(false);
		setPfMsg(null); setPfDelArm(null); setPfFetchedList(null);
	};
	const openPfEdit = (p) => {
		setPfMode("edit"); setPfDraft(providerFormFromProvider(p)); setPfDirty(false);
		setPfMsg(null); setPfDelArm(null); setPfFetchedList(null);
	};
	const closePf = () => {
		setPfMode(null); setPfDraft(null); setPfDirty(false);
		setPfMsg(null); setPfDelArm(null); setPfFetchedList(null);
	};
	const patchPf = (patch) => { setPfDraft(Object.assign({}, pfDraft, patch)); setPfDirty(true); setPfMsg(null); };
	const patchPfModel = (i, patch) => {
		const models = pfDraft.models.slice();
		models[i] = Object.assign({}, models[i], patch);
		patchPf({ models: models });
	};
	const delPfModel = (i) => patchPf({ models: pfDraft.models.filter((_, j) => j !== i) });
	const addPfModel = () => patchPf({ models: pfDraft.models.concat([emptyModelDraft()]) });
	// 勾选式选模型：checked 状态直接映射「该 id 是否在草稿模型列表里」
	const togglePfModel = (id, name, on) => {
		const base = pfDraft.models.filter((m) => String(m.id || "").trim());
		if (on) {
			if (base.some((m) => String(m.id).trim() === id)) return;
			base.push(Object.assign(emptyModelDraft(), { id: id, name: name || "", input: pfDraft.defaultInput.slice() }));
		} else {
			const i = base.findIndex((m) => String(m.id).trim() === id);
			if (i >= 0) base.splice(i, 1);
		}
		patchPf({ models: base });
	};
	const setAllPfModels = (on) => {
		const base = [];
		if (on && pfFetchedList) {
			for (const mm of pfFetchedList) {
				const id = String((mm && mm.id) || "").trim();
				if (!id) continue;
				base.push(Object.assign(emptyModelDraft(), { id: id, name: (mm && mm.name) || "", input: pfDraft.defaultInput.slice() }));
			}
		}
		patchPf({ models: base });
	};
	const pfSelectedCount = () => pfDraft ? pfDraft.models.filter((m) => String(m.id || "").trim()).length : 0;
	const pfModelsPayload = () => pfDraft.models.map((m) => ({
		id: String(m.id || "").trim(),
		name: String(m.name || "").trim(),
		contextWindow: m.contextWindow === "" || m.contextWindow == null ? undefined : Number(m.contextWindow),
		maxTokens: m.maxTokens === "" || m.maxTokens == null ? undefined : Number(m.maxTokens),
		input: m.input,
		tags: m.tags,
		effortsMode: m.effortsMode,
		effortLevels: m.effortLevels,
		raw: m.raw
	}));
	// 自动获取模型列表：宿主代打 GET {baseURL}/models（Key 还没保存也能先拉）
	const fetchPfModels = () => {
		if (!pfDraft || pfFetching) return;
		setPfFetching(true); setPfMsg(null);
		fetch("dsh-dock/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "listModels",
				baseURL: pfDraft.baseURL,
				api: pfDraft.api,
				apiKeyEnv: pfDraft.apiKeyEnv,
				apiKey: pfDraft.apiKey
			}),
			signal: AbortSignal.timeout(30000)
		})
			.then((res) => res.json()
				.then((b) => ({ status: res.status, body: b }))
				.catch(() => ({ status: res.status, body: {} })))
			.then((r) => {
				if (r.status === 200 && r.body && r.body.ok) {
					setPfFetchedList(Array.isArray(r.body.models) ? r.body.models : []);
				} else {
					setPfMsg({ ok: false, text: (r.body && r.body.error) || ("HTTP " + r.status) });
				}
			})
			.catch((e) => setPfMsg({ ok: false, text: (e && e.message) || String(e) }))
			.then(() => setPfFetching(false));
	};
	const savePf = () => {
		if (!pfDraft || pfSaving) return;
		const route = pfDraft.route.trim();
		const baseURL = pfDraft.baseURL.trim();
		const apiKey = pfDraft.apiKey.trim();
		// Key 填了但 apiKeyEnv 留空：按路由 key 自动生成凭据库条目名，不再逼用户现编一个
		let apiKeyEnv = pfDraft.apiKeyEnv.trim();
		if (apiKey && !apiKeyEnv) {
			apiKeyEnv = dkmEnvFromRoute(route);
			setPfDraft(Object.assign({}, pfDraft, { apiKeyEnv: apiKeyEnv }));
		}
		const models = pfModelsPayload();
		if (!route) { setPfMsg({ ok: false, text: "路由 key 不能为空（如 modelscope）" }); return; }
		if (!DKM_ROUTE_KEY_RE.test(route)) { setPfMsg({ ok: false, text: "路由 key 非法：只能含字母、数字与 . _ -，且以字母/数字开头" }); return; }
		if (!/^https?:\/\//i.test(baseURL)) { setPfMsg({ ok: false, text: "baseURL 须以 http:// 或 https:// 开头" }); return; }
		const ids = models.map((m) => m.id);
		if (ids.length === 0 || ids.some((x) => !x)) { setPfMsg({ ok: false, text: "每个模型都要有 id（可点「获取模型列表」自动拉取）" }); return; }
		if (new Set(ids).size !== ids.length) { setPfMsg({ ok: false, text: "模型 id 有重复" }); return; }
		const profile = Object.assign({}, pfDraft.extra || {});
		const dn = pfDraft.displayName.trim();
		if (dn) profile.displayName = dn; else delete profile.displayName;
		profile.api = pfDraft.api;
		profile.baseURL = baseURL;
		if (apiKeyEnv) profile.apiKeyEnv = apiKeyEnv; else delete profile.apiKeyEnv;
		profile.defaultInput = pfDraft.defaultInput;
		profile.models = models;
		const payload = {
			action: pfMode === "create" ? "create" : "update",
			route: route,
			profile: profile,
			revisions: (data && data.revisions) || {}
		};
		if (apiKey) payload.apiKey = apiKey;
		setPfSaving(true); setPfMsg(null);
		fetch("dsh-dock/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(30000)
		})
			.then((res) => res.json()
				.then((b) => ({ status: res.status, body: b }))
				.catch(() => ({ status: res.status, body: {} })))
			.then((r) => {
				if (r.status === 200 && r.body && r.body.ok) {
					setPfMsg({ ok: true, text: "Provider「" + route + "」已" + (pfMode === "create" ? "新增" : "更新") + "；会话模型选择器即时可选" });
					setPfMode(null); setPfDraft(null); setPfDirty(false);
					modelsStore.load();
				} else {
					setPfMsg({ ok: false, text: (r.body && r.body.error) || ("HTTP " + r.status) });
				}
			})
			.catch((e) => setPfMsg({ ok: false, text: (e && e.message) || String(e) }))
			.then(() => setPfSaving(false));
	};
	// 删除：两步确认（先点一次进入待确认态，再点一次真删；不用 window.confirm）
	const deletePf = (p) => {
		const route = p.route || p.id;
		if (pfDelArm !== route) { setPfDelArm(route); setPfMsg(null); return; }
		setPfDelArm(null); setPfSaving(true); setPfMsg(null);
		fetch("dsh-dock/models", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "delete", route: route, revisions: (data && data.revisions) || {} }),
			signal: AbortSignal.timeout(20000)
		})
			.then((res) => res.json()
				.then((b) => ({ status: res.status, body: b }))
				.catch(() => ({ status: res.status, body: {} })))
			.then((r) => {
				if (r.status === 200 && r.body && r.body.ok) {
					setPfMsg({ ok: true, text: "Provider「" + route + "」已删除" });
					if (pfMode === "edit" && pfDraft && pfDraft.route === route) { setPfMode(null); setPfDraft(null); }
					modelsStore.load();
				} else {
					setPfMsg({ ok: false, text: (r.body && r.body.error) || ("HTTP " + r.status) });
				}
			})
			.catch((e) => setPfMsg({ ok: false, text: (e && e.message) || String(e) }))
			.then(() => setPfSaving(false));
	};
	// deep-link：带 openProviderForm 进入本页时直接展开新增表单（只认第一次，之后由用户自己开关）
	const openedRef = react.useRef(false);
	react.useEffect(() => {
		if (props.openCreate && !openedRef.current) {
			openedRef.current = true;
			openPfCreate();
			if (typeof props.onCreateHandled === "function") props.onCreateHandled();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 官方 ProviderEditor 同款字段：一行一个字段（标签在上、输入铺满），非必填项收进「自定义设置」
	const input = (p) => react.createElement("input", Object.assign({ className: "dkp-input" }, p));
	const field = (label, node, hint) => react.createElement("div", { className: "dkp-field", key: label },
		react.createElement("label", { className: "dkp-flabel" }, label),
		node,
		hint ? react.createElement("p", { className: "dkp-hint" }, hint) : null);

	const editor = !pfDraft ? null : react.createElement("div", { className: "dkp-editor" },
		react.createElement("div", { className: "dkp-editor-head" },
			react.createElement("span", { className: "dkp-editor-title" }, pfMode === "create" ? "新增 Provider" : "编辑 Provider"),
			pfMode === "edit" ? react.createElement("span", { className: "dkp-editor-route" }, pfDraft.route) : null),
		field("路由 key", input({
			value: pfDraft.route,
			disabled: pfMode === "edit",
			placeholder: "acme-gateway",
			onChange: (e) => patchPf({ route: e.target.value })
		}), pfMode === "edit" ? "路由 key 是配置键，保存后不建议修改。" : "唯一标识：只能含字母、数字与 . _ -，且以字母/数字开头。"),
		field("显示名称", input({
			value: pfDraft.displayName,
			placeholder: pfDraft.route || "如 魔搭 ModelScope",
			onChange: (e) => patchPf({ displayName: e.target.value })
		})),
		field("baseURL", input({
			value: pfDraft.baseURL,
			placeholder: pfDraft.api === "anthropic-messages" ? "https://gateway.example" : "https://gateway.example/v1",
			onChange: (e) => patchPf({ baseURL: e.target.value })
		}), "OpenAI 兼容端点通常以 /v1 结尾；Anthropic Messages 由 SDK 自行追加 /v1/messages。"),
		field("API 协议", react.createElement("select", {
			className: "dkp-input dkp-select",
			value: pfDraft.api,
			onChange: (e) => patchPf({ api: e.target.value })
		},
			DKM_APIS.map(([v, label]) => react.createElement("option", { key: v, value: v }, label)))),
		field("API Key", react.createElement("input", {
			className: "dkp-input",
			type: "password",
			autoComplete: "new-password",
			placeholder: pfMode === "edit" ? "留空 = 不改动已存密钥" : "sk-…（仅本次写入本机凭据库，不回显）",
			value: pfDraft.apiKey,
			onChange: (e) => patchPf({ apiKey: e.target.value })
		})),
		react.createElement("details", { className: "dkp-customized" },
			react.createElement("summary", { className: "dkp-summary" }, "自定义设置"),
			react.createElement("div", { className: "dkp-custombody" },
				field("apiKeyEnv", input({
					value: pfDraft.apiKeyEnv,
					placeholder: "留空 = 按路由 key 自动生成（" + (dkmEnvFromRoute(pfDraft.route) || "ROUTE_API_KEY") + "）",
					onChange: (e) => patchPf({ apiKeyEnv: e.target.value })
				}), "凭据库条目名；留空时按路由 key 推导，一般无需填写。"),
				react.createElement("div", { className: "dkp-field" },
					react.createElement("span", { className: "dkp-flabel" }, "默认输入类型"),
					react.createElement("div", { className: "dkp-checks" },
						DKM_MODALITIES.map(([v, label]) => react.createElement("label", { key: v, className: "dkp-check" },
							react.createElement("input", {
								type: "checkbox",
								checked: pfDraft.defaultInput.indexOf(v) >= 0,
								onChange: () => {
									const next = dkmToggleIn(pfDraft.defaultInput, v);
									patchPf({ defaultInput: next.length > 0 ? next : ["text"] });
								}
							}),
							label)),
						react.createElement("span", { className: "dkp-hint" }, "模型未单独声明输入类型时继承这里。"))))),
		react.createElement("section", { className: "dkp-catalog", "aria-label": "模型" },
			react.createElement("div", { className: "dkp-catalog-head" },
				react.createElement("div", { className: "dkp-catalog-titlewrap" },
					react.createElement("span", { className: "dkp-catalog-title" }, "模型"),
					react.createElement("span", { className: "dkp-catalog-meta" },
						"已选 " + pfSelectedCount() + " 个" + (pfFetchedList ? " / 上游共 " + pfFetchedList.length + " 个" : ""))),
				react.createElement("div", { className: "dkp-actions" },
					react.createElement("button", {
						type: "button",
						className: "dkp-btn ghost sm",
						disabled: pfFetching || !pfDraft.baseURL,
						title: "调用 baseURL/models 拉取该端点可用模型，勾选后加入下方列表",
						onClick: fetchPfModels
					}, pfFetching ? "拉取中…" : "获取模型列表"),
					pfFetchedList && pfFetchedList.length > 0
						? react.createElement("button", { type: "button", className: "dkp-btn ghost sm", title: "勾选上游返回的全部模型", onClick: () => setAllPfModels(true) }, "全选")
						: null,
					pfFetchedList && pfFetchedList.length > 0
						? react.createElement("button", { type: "button", className: "dkp-btn ghost sm", title: "清空已勾选的模型", onClick: () => setAllPfModels(false) }, "清空")
						: null)),
			pfFetchedList
				? react.createElement("div", { className: "dkp-picker" },
					pfFetchedList.length === 0
						? react.createElement("div", { className: "dkp-hint" }, "上游没有返回任何模型")
						: pfFetchedList.map((mm) => {
							const id = String((mm && mm.id) || "").trim();
							if (!id) return null;
							const checked = pfDraft.models.some((m) => String(m.id || "").trim() === id);
							return react.createElement("label", { key: id },
								react.createElement("input", {
									type: "checkbox",
									checked: checked,
									onChange: () => togglePfModel(id, (mm && mm.name) || "", !checked)
								}),
								react.createElement("span", { className: "dkp-picker-id" }, id),
								(mm && mm.name) ? react.createElement("span", { className: "dkp-picker-name" }, mm.name) : null);
						}))
				: null,
			pfDraft.models.length === 0
				? react.createElement("div", { className: "dkp-empty" }, "还没有模型——点「获取模型列表」勾选上游模型，或「添加模型」手动填写。")
				: react.createElement("div", { className: "dkp-model-list" },
					pfDraft.models.map((m, i) => react.createElement(ProviderModelRow, { key: i, m: m, i: i, onPatch: patchPfModel, onDel: delPfModel }))),
			react.createElement("button", { type: "button", className: "dkp-addmodel", onClick: addPfModel }, "＋ 添加模型")),
		pfMsg && !pfMsg.ok ? react.createElement("p", { className: "dkp-error" }, pfMsg.text) : null,
		react.createElement("div", { className: "dkp-editor-actions" },
			react.createElement("span", { className: "dkp-hint" }, pfDirty ? "有未保存的修改" : ""),
			react.createElement("button", { type: "button", className: "dkp-btn ghost", onClick: closePf }, "取消"),
			react.createElement("button", { type: "button", className: "dkp-btn primary", disabled: pfSaving, onClick: savePf },
				pfSaving ? "保存中…" : (pfMode === "create" ? "新增 Provider" : "保存修改"))));

	const body = [
		react.createElement("button", { key: "back", type: "button", className: "dkp-back", onClick: props.onBack }, "← 模型设置"),
		react.createElement("h2", { key: "title", className: "dkp-title" }, "模型提供商"),
		react.createElement("p", { key: "intro", className: "dkp-intro" },
			"新增 / 编辑 / 删除自定义模型 Provider（OpenAI 兼容、Anthropic 等），写入官方配置并热生效；API Key 存本机凭据库（文件仅 root 可读）。内置 DeepSeek 官方 Provider 在本页只读，其模型目录请回「模型设置」编辑。")
	];
	if (props.error) {
		body.push(react.createElement("p", { key: "err", className: "dkp-error" }, "模型目录拉取失败：" + props.error));
	}
	if (pfMsg && !pfDraft) {
		body.push(react.createElement("p", { key: "msg", className: "dkp-msg " + (pfMsg.ok ? "ok" : "err"), role: "status" }, pfMsg.text));
	}
	if (!data) {
		body.push(react.createElement("p", { key: "loading", className: "dkp-hint" }, props.loading ? "正在拉取模型目录…" : "等待拉取模型目录"));
	} else if (piProviders.length === 0) {
		body.push(react.createElement("div", { key: "empty", className: "dkp-empty" }, "还没有自定义 Provider——点下方「新增 Provider」添加。"));
	} else {
		body.push(react.createElement("ul", { key: "rows", className: "dkp-rows" },
			piProviders.map((p) => {
				const route = p.route || p.id;
				const editing = pfMode === "edit" && !!pfDraft && pfDraft.route === route;
				const keyMissing = !!(p.apiKeyEnv && !p.apiKeyConfigured);
				return react.createElement("li", { key: p.id, className: "dkp-card" },
					react.createElement("div", { className: "dkp-rowhead" },
						react.createElement("span", { className: "dkp-identity" },
							react.createElement("span", { className: "dkp-name" }, p.displayName || route),
							react.createElement("span", { className: "dkp-tag" }, route),
							react.createElement("span", { className: "dkp-tag" }, (p.models ? p.models.length : 0) + " 模型"),
							react.createElement("span", {
								className: "dkp-dot " + (keyMissing ? "missing" : "ok"),
								role: "img",
								title: p.apiKeyEnv ? (p.apiKeyConfigured ? p.apiKeyEnv + " 已配置" : p.apiKeyEnv + " 未配置") : "未设 apiKeyEnv",
								"aria-label": p.apiKeyEnv ? (p.apiKeyConfigured ? "密钥已配置" : "密钥未配置") : "未设 apiKeyEnv"
							}),
							p.apiKeyEnv
								? react.createElement("span", { className: "dkp-tag" + (keyMissing ? " warn" : " ok") },
									p.apiKeyConfigured ? p.apiKeyEnv + " 已配置" : p.apiKeyEnv + " 未配置")
								: null),
						react.createElement("span", { className: "dkp-actions" },
							react.createElement("button", {
								type: "button",
								className: "dkp-btn ghost sm",
								"aria-expanded": editing,
								onClick: () => (editing ? closePf() : openPfEdit(p))
							}, editing ? "收起" : "编辑"),
							react.createElement("button", {
								type: "button",
								className: "dkp-btn danger sm" + (pfDelArm === route ? " arm" : ""),
								title: pfDelArm === route ? "再点一次确认删除" : "删除该 Provider",
								onClick: () => deletePf(p)
							}, pfDelArm === route ? "确认删除？" : "删除"))),
					react.createElement("div", { className: "dkp-sub" }, [p.api, p.baseURL].filter(Boolean).join(" · ")),
					editing ? editor : null);
			})));
	}
	body.push(react.createElement("div", { key: "add", className: "dkp-addblock" },
		pfMode === "create" && pfDraft
			? react.createElement("div", { className: "dkp-card dkp-addcard" }, editor)
			: react.createElement("button", { type: "button", className: "dkp-addbtn", onClick: openPfCreate }, "＋ 新增 Provider")));
	return react.createElement("div", { className: "dkp-page" }, body);
}

function ModelsStat() {
	const snap = useModels();
	const data = snap.data;
	if (snap.error) return react.createElement("span", { className: "dockm-err" }, "模型目录拉取失败（点击进入查看）");
	if (!data) return react.createElement("span", null, snap.loading ? "正在拉取模型目录…" : "等待拉取模型目录");
	const providers = Array.isArray(data.providers) ? data.providers : [];
	const total = providers.reduce((n, p) => n + (p.models ? p.models.length : 0), 0);
	return react.createElement("span", null, providers.length + " 个 Provider · " + total + " 个模型");
}

export const feature = {
	id: "modelconfig",
	name: "模型设置",
	order: 100,
	accent: "#22d3ee",
	description: "编辑各 Provider 模型目录（输入类型/思考强度档位）；自定义 Provider 的增删改在「模型提供商」子页面，写回官方配置热生效，会话模型选择器即时可选",
	css: [
		".dkm-note{color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkm-warn{color:var(--dk-warn);}",
		".dkm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;}",
		".dkm-chips{display:flex;flex-wrap:wrap;gap:6px;}",
		".dkm-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-family:inherit;font-size:12px;}",
		".dkm-chip.on{color:var(--dk-accent);border-color:currentColor;}",
		".dkm-prov{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
		".dkm-prov-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
		".dkm-name{font-weight:600;}",
		".dkm-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}",
		".dkm-badge{flex:none;font-size:11px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
		".dkm-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px;}",
		".dkm-label{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;}",
		".dkm-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 8px;font-family:inherit;font-size:12px;}",
		".dkm-model{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;}",
		".dkm-model-head{display:flex;align-items:center;gap:6px;}",
		".dkm-model-idx{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;}",
		".dkm-grid{display:grid;grid-template-columns:1.3fr 1.3fr .8fr .8fr;gap:6px;align-items:center;}",
		".dkm-input{box-sizing:border-box;width:100%;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:4px 8px;font-family:inherit;font-size:12px;}",
		".dkm-checks{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}",
		".dkm-check{display:inline-flex;align-items:center;gap:5px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkm-check input{accent-color:var(--dk-accent);margin:0;}",
		".dkm-tag{color:var(--dsw-alias-label-tertiary);}",
		".dkm-efforts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
		".dkm-del{margin-left:auto;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;padding:2px 10px;font-family:inherit;font-size:12px;flex:none;}",
		".dkm-del:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
		".dkm-add{cursor:pointer;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:10px;padding:6px 14px;font-family:inherit;font-size:12px;align-self:flex-start;}",
		".dkm-add:hover{color:var(--dsw-alias-label-primary);}",
		".dkm-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
		".dkm-save{cursor:pointer;border:1px solid var(--dk-accent);color:var(--dk-accent);background:transparent;border-radius:8px;padding:4px 14px;font-family:inherit;font-size:12px;flex:none;}",
		".dkm-save:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkm-save[disabled]{opacity:.5;cursor:default;}",
		".dkm-msg{font-size:12px;color:var(--dsw-alias-label-secondary);}",
		".dkm-msg.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkm-msg.err{color:var(--dsw-alias-state-error-primary);}",
		".dkm-list{display:flex;flex-direction:column;gap:8px;}",
		".dkm-topbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}",
		".dkm-capabilities{display:flex;flex-direction:column;gap:6px;}",
		".dkm-capability-list{max-height:168px;overflow:auto;padding:2px 0 2px 2px;}",
		".dkm-ro{color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkm-mini{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-family:inherit;font-size:11px;flex:none;}",
		".dkm-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);}",
		".dkm-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;}",
		".dkm-toolbar-label{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;}",
		// ---- 模型提供商子页面（dkp- 前缀）：对齐官方「模型」设置页的排版与尺寸 ----
		// 官方用量参考：section 限宽 720、行卡片 .5px 描边 + radius-xl + 12/14 内距、
		// 输入高 32、按钮高 36（行内小按钮 28）、新增按钮 44 虚线、编辑器 bg-module-platform。
		".dkp-page{width:100%;max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}",
		".dkp-back{box-sizing:border-box;align-self:flex-start;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:var(--dsw-radius-sm,6px);padding:4px 8px;margin-left:-8px;font-family:inherit;font-size:12px;line-height:18px;}",
		".dkp-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
		".dkp-title{margin:0;font-size:16px;font-weight:500;line-height:24px;}",
		".dkp-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:14px;line-height:22px;}",
		".dkp-rows{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:8px;}",
		".dkp-card{box-sizing:border-box;margin:0;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border-radius:var(--dsw-radius-xl,12px);padding:12px 14px;display:flex;flex-direction:column;gap:10px;}",
		".dkp-rowhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
		".dkp-identity{display:inline-flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;}",
		".dkp-name{font-size:14px;font-weight:500;line-height:22px;}",
		".dkp-tag{flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px;}",
		".dkp-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
		".dkp-tag.warn{color:var(--dk-warn);border-color:currentColor;}",
		".dkp-dot{box-sizing:border-box;flex:none;width:8px;height:8px;border-radius:50%;display:inline-block;}",
		".dkp-dot.ok{background:var(--dsw-alias-state-success-primary);}",
		".dkp-dot.missing{background:var(--dsw-alias-state-error-primary);}",
		".dkp-dot.warn{background:var(--dk-warn);}",
		".dkp-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
		".dkp-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
		".dkp-dim{color:var(--dsw-alias-label-tertiary);}",
		".dkp-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;}",
		".dkp-msg{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}",
		".dkp-msg.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkp-msg.err{color:var(--dsw-alias-state-error-primary);}",
		".dkp-actions{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:4px;}",
		".dkp-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}",
		".dkp-btn.ghost{border:.5px solid var(--dsw-alias-border-l3);}",
		".dkp-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dk-accent));color:var(--dsw-alias-label-primary-foreground,#fff);}",
		".dkp-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dk-accent));}",
		".dkp-btn.danger{color:var(--dsw-alias-state-error-primary);}",
		".dkp-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.1));}",
		".dkp-btn.arm{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
		".dkp-btn.sm{height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm,6px);font-size:12px;line-height:18px;}",
		".dkp-btn[disabled]{opacity:.4;cursor:default;}",
		".dkp-editor{border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));padding:14px 16px;display:flex;flex-direction:column;gap:14px;}",
		".dkp-editor-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}",
		".dkp-editor-title{font-size:14px;font-weight:500;line-height:22px;}",
		".dkp-editor-route{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;}",
		".dkp-field{display:flex;flex-direction:column;gap:6px;min-width:0;}",
		".dkp-flabel{display:inline-flex;align-items:center;gap:10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;}",
		".dkp-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;}",
		".dkp-input:focus{border-color:var(--dsw-alias-state-business-primary,var(--dk-accent));outline:none;}",
		".dkp-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));}",
		".dkp-input:disabled{opacity:.6;cursor:default;}",
		"select.dkp-input{appearance:auto;cursor:pointer;max-width:240px;}",
		".dkp-select-sm{height:28px;max-width:160px;font-size:12px;line-height:18px;}",
		".dkp-checks{display:flex;align-items:center;gap:16px;flex-wrap:wrap;min-height:32px;}",
		".dkp-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}",
		".dkp-check input{accent-color:var(--dk-accent);margin:0;}",
		".dkp-mini{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);padding:1px 8px;font-family:inherit;font-size:11px;line-height:16px;flex:none;}",
		".dkp-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);}",
		".dkp-customized{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px;}",
		".dkp-summary{display:flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;border-radius:var(--dsw-radius-sm,6px);list-style:none;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;}",
		".dkp-summary::-webkit-details-marker{display:none;}",
		".dkp-summary::before{content:\"\";width:5px;height:5px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(-45deg);transition:transform .12s;}",
		".dkp-customized[open]>.dkp-summary::before{transform:rotate(45deg);}",
		".dkp-summary:hover{color:var(--dsw-alias-label-primary);}",
		".dkp-custombody{display:flex;flex-direction:column;gap:12px;padding-top:12px;}",
		".dkp-catalog{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;display:flex;flex-direction:column;gap:10px;}",
		".dkp-catalog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;}",
		".dkp-catalog-titlewrap{display:flex;flex-direction:column;gap:2px;}",
		".dkp-catalog-title{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;}",
		".dkp-catalog-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
		".dkp-model-list{display:flex;flex-direction:column;gap:8px;}",
		".dkp-model-entry{border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-lg,10px);padding:6px;display:flex;flex-direction:column;gap:6px;}",
		".dkp-model-row{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr) minmax(0,.7fr) minmax(0,.7fr) auto;gap:6px;align-items:center;}",
		".dkp-model-row .dkp-input{height:30px;padding:0 8px;font-size:13px;}",
		".dkp-model-opts{display:flex;flex-direction:column;gap:4px;padding:2px 2px 0;}",
		".dkp-iconbtn{box-sizing:border-box;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;line-height:1;}",
		".dkp-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
		".dkp-iconbtn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.1));color:var(--dsw-alias-state-error-primary);}",
		".dkp-addmodel{box-sizing:border-box;align-self:flex-start;display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;}",
		".dkp-addmodel:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkp-picker{max-height:320px;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,8px);padding:4px 6px;display:flex;flex-direction:column;gap:2px;}",
		".dkp-picker label{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);}",
		".dkp-picker label:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkp-picker input{accent-color:var(--dk-accent);margin:0;flex:none;}",
		".dkp-picker-id{flex:none;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px;line-height:20px;}",
		".dkp-picker-name{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
		".dkp-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);padding:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
		".dkp-addblock{display:flex;align-items:stretch;}",
		".dkp-addbtn{box-sizing:border-box;flex:1 1 auto;min-width:180px;height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}",
		".dkp-addbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkp-addcard{flex:1 1 auto;padding:14px 16px;}",
		".dkp-addcard .dkp-editor{background:transparent;padding:0;}",
		".dkp-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:12px;}",
		".dkp-editor-actions .dkp-hint{margin-right:auto;}",
		"@media (max-width:680px){.dkp-page{max-width:none;gap:14px}.dkp-intro{font-size:13px;line-height:20px}.dkp-model-row{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.dkp-model-row .dkp-iconbtn{justify-self:end}.dkp-editor{padding:12px}.dkp-addcard{padding:12px 14px}.dkp-btn{height:40px}.dkp-btn.sm{height:34px}.dkp-addbtn{height:48px}}"
	].join("\n"),
	View: ModelsView,
	HomeStat: ModelsStat,
};
