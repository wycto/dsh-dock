// dsh-dock · 功能模块【模型提供商】· 客户端视图
//
// 管理自定义模型 Provider（OpenAI 兼容 / Anthropic 等）：新增、编辑、删除、拉取上游
// 模型列表、写入 API Key。写回官方 settings 与本地凭据库，热生效。
// 与【模型设置】的分工：那边只管已配置模型的输入模态与思考强度；本页管 Provider 本身。
// 数据来自 /dsh-dock/providerconfig（GET 列表 / POST action=listModels|create|update|delete）。
import react from "react";
import {
	DKM_APIS,
	DKM_EFFORT_NAMES,
	DKM_MODALITIES,
	DKM_PI_LEVELS,
	DKM_ROUTE_KEY_RE,
	DKM_TAGS,
	dkmAllInputs,
	dkmAllLevels,
	dkmEnvFromRoute,
	dkmToggleIn,
	emptyModelDraft,
	emptyProviderForm,
	providerFormFromProvider,
} from "../../src/model-draft.js";

// ---- Provider 列表快照：本模块独占（不与模型目录共享，两个功能可各自启停） ----
const providersStore = {
	snap: { data: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	set(patch) { this.snap = Object.assign({}, this.snap, patch); for (const fn of this.listeners) fn(); },
	load() {
		if (this.snap.loading) return;
		this.set({ loading: true, error: null });
		// Provider 可以在 DSH 原生模型设置里随时增删；不要复用浏览器缓存。
		fetch("dsh-dock/providerconfig", { cache: "no-store", signal: AbortSignal.timeout(20000) })
			.then((res) => (res.ok ? res.json() : Promise.reject(new Error("模型提供商接口 HTTP " + res.status))))
			.then((data) => this.set({ data: data, loading: false, error: null }))
			.catch((e) => this.set({ loading: false, error: (e && e.message) || String(e) }));
	}
};
function useProviders() {
	const [snap, setSnap] = react.useState(providersStore.snap);
	react.useEffect(() => {
		const off = providersStore.subscribe(() => setSnap(providersStore.snap));
		if (!providersStore.snap.data && !providersStore.snap.loading) providersStore.load();
		return off;
	}, []);
	return snap;
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
 * 模型提供商页：官方「模型」设置页同款布局——
 * 标题 + 说明 + 行卡片列表（每行可展开同一个编辑卡片）+ 底部虚线「新增 Provider」。
 * 只管自定义 pi-ai 路由的增删改（内置 DeepSeek 官方 Provider 在【模型设置】里编辑其模型目录）。
 */
function ProvidersView(props) {
	const snap = useProviders();
	const data = snap.data;
	const providers = data && Array.isArray(data.providers) ? data.providers : [];
	const params = props && props.params;
	const [openCreate, setOpenCreate] = react.useState(false);
	const [pfMode, setPfMode] = react.useState(null);
	const [pfDraft, setPfDraft] = react.useState(null);
	const [pfDirty, setPfDirty] = react.useState(false);
	const [pfSaving, setPfSaving] = react.useState(false);
	const [pfMsg, setPfMsg] = react.useState(null);
	const [pfDelArm, setPfDelArm] = react.useState(null);
	const [pfFetching, setPfFetching] = react.useState(false);
	const [pfFetchedList, setPfFetchedList] = react.useState(null);

	// 每次进入本页都重新读取（原生设置里刚改过 Provider 也要看到最新的）
	react.useEffect(() => { providersStore.load(); }, []);
	// deep-link：params.openProviderForm 直接展开「新增 Provider」表单（渲染回归测试与设置页深链共用）
	react.useEffect(() => {
		if (params && params.openProviderForm) setOpenCreate(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const reload = () => providersStore.load();
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
		fetch("dsh-dock/providerconfig", {
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
		fetch("dsh-dock/providerconfig", {
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
					reload();
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
		fetch("dsh-dock/providerconfig", {
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
					reload();
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
		if (openCreate && !openedRef.current) {
			openedRef.current = true;
			openPfCreate();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [openCreate]);

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

	const piProviders = providers.filter((p) => p.kind === "pi-ai");
	const body = [
		react.createElement("h2", { key: "title", className: "dkp-title" }, "模型提供商"),
		react.createElement("p", { key: "intro", className: "dkp-intro" },
			"新增 / 编辑 / 删除自定义模型 Provider（OpenAI 兼容、Anthropic 等），写入官方配置并热生效；API Key 存本机凭据库（文件仅 root 可读）。内置 DeepSeek 官方 Provider 在本页只读，其模型目录在「模型设置」里编辑。本功能可单独停用：停用后这些写配置与出站请求的路由一并关闭。")
	];
	if (snap.error) {
		body.push(react.createElement("p", { key: "err", className: "dkp-error" }, "模型目录拉取失败：" + snap.error));
	}
	if (pfMsg && !pfDraft) {
		body.push(react.createElement("p", { key: "msg", className: "dkp-msg " + (pfMsg.ok ? "ok" : "err"), role: "status" }, pfMsg.text));
	}
	if (!data) {
		body.push(react.createElement("p", { key: "loading", className: "dkp-hint" }, snap.loading ? "正在拉取模型目录…" : "等待拉取模型目录"));
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

function ProvidersStat() {
	const snap = useProviders();
	const data = snap.data;
	if (snap.error) return react.createElement("span", { className: "dockm-err" }, "模型提供商拉取失败（点击进入查看）");
	if (!data) return react.createElement("span", null, snap.loading ? "正在拉取模型提供商…" : "等待拉取模型提供商");
	const providers = Array.isArray(data.providers) ? data.providers : [];
	const custom = providers.filter((p) => p.kind === "pi-ai");
	const missing = custom.filter((p) => p.apiKeyEnv && !p.apiKeyConfigured).length;
	return react.createElement("span", null, custom.length + " 个自定义 Provider" + (missing > 0 ? " · " + missing + " 个缺密钥" : ""));
}

export const feature = {
	id: "providerconfig",
	name: "模型提供商",
	order: 101,
	accent: "#8b5cf6",
	description: "管理自定义模型 Provider：新增/编辑/删除、拉取上游模型列表、写入 API Key（可单独停用）",
	css: [
		// ---- 模型提供商页（dkp- 前缀）：对齐官方「模型」设置页的排版与尺寸 ----
		// 官方用量参考：section 限宽 720、行卡片 .5px 描边 + radius-xl + 12/14 内距、
		// 输入高 32、按钮高 36（行内小按钮 28）、新增按钮 44 虚线、编辑器 bg-module-platform。
		".dkp-page{width:100%;max-width:720px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}",
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
	View: ProvidersView,
	HomeStat: ProvidersStat,
};
