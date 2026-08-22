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
		this.set({ loading: true });
		fetch("/dsh-dock/models", { signal: AbortSignal.timeout(20000) })
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

/** 从目录 Provider 视图构建可编辑草稿。 */
function draftFromProvider(p) {
	return {
		id: p.id,
		kind: p.kind,
		thinking: p.thinking === "disabled" ? "disabled" : "enabled",
		defaultEffort: DKM_DS_LEVELS.indexOf(p.defaultEffort) >= 0 ? p.defaultEffort : "high",
		models: (p.models || []).map((m) => {
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
		})
	};
}

function ModelsView() {
	const snap = useModels();
	const data = snap.data;
	const providers = data && Array.isArray(data.providers) ? data.providers : [];
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
		fetch("/dsh-dock/models", {
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
		fetch("/dsh-dock/models", {
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

	const modelRow = (m, i) => react.createElement("div", { key: i, className: "dkm-model" },
		react.createElement("div", { className: "dkm-model-head" },
			react.createElement("span", { className: "dkm-model-idx" }, "#" + (i + 1)),
			react.createElement("button", {
				type: "button",
				className: "dkm-del",
				onClick: () => patchDraft({ models: draft.models.filter((_, j) => j !== i) })
			}, "删除")),
		react.createElement("div", { className: "dkm-grid" },
			react.createElement("input", { className: "dkm-input", placeholder: "模型 id（必填，如 deepseek-v4-pro）", value: m.id, onChange: (e) => patchModel(i, { id: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "显示名称（可选）", value: m.name, onChange: (e) => patchModel(i, { name: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "上下文窗口", inputMode: "numeric", value: m.contextWindow, onChange: (e) => patchModel(i, { contextWindow: e.target.value }) }),
			react.createElement("input", { className: "dkm-input", placeholder: "最大输出", inputMode: "numeric", value: m.maxTokens, onChange: (e) => patchModel(i, { maxTokens: e.target.value }) })),
		react.createElement("div", { className: "dkm-checks" },
			react.createElement("span", { className: "dkm-label" }, "输入类型："),
			DKM_MODALITIES.map(([v, label]) => react.createElement("label", {
				key: v,
				className: "dkm-check",
				title: v === "image" ? "勾选=端点原生支持图片（原图直发，图片理解代理跳过）；纯文本模型勿勾——收图会自动交给图片理解代理识别" : null
			},
				react.createElement("input", {
					type: "checkbox",
					checked: m.input.indexOf(v) >= 0,
					onChange: () => {
						const next = toggleIn(m.input, v);
						patchModel(i, { input: next.length > 0 ? next : ["text"] });
					}
				}),
				label)),
			react.createElement("span", { className: "dkm-label dkm-tag", title: "标注仅在本面板展示与持久化，不参与请求路由（官方 schema 只接受文本/图片）" }, "标注："),
			DKM_TAGS.map(([v, label]) => react.createElement("label", { key: v, className: "dkm-check dkm-tag" },
				react.createElement("input", { type: "checkbox", checked: m.tags.indexOf(v) >= 0, onChange: () => patchModel(i, { tags: toggleIn(m.tags, v) }) }),
				label)),
			react.createElement("button", { type: "button", className: "dkm-mini", title: "一键勾选全部输入类型与标注", onClick: () => patchModel(i, allInputs(true)) }, "全选"),
			react.createElement("button", { type: "button", className: "dkm-mini", title: "一键取消全部勾选（输入留空 = 继承目录默认）", onClick: () => patchModel(i, allInputs(false)) }, "取消全选")),
		react.createElement("div", { className: "dkm-efforts" },
			react.createElement("span", { className: "dkm-label" }, "思考强度："),
			cur.kind === "deepseek"
				? react.createElement("span", { className: "dkm-sub" }, "随 Provider 设置（Off/Low/High/Max，全模型共享）")
				: react.createElement("span", null,
					react.createElement("select", {
						className: "dkm-select",
						value: m.effortsMode,
						onChange: (e) => patchModel(i, {
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
									patchModel(i, { effortLevels: nl });
								}
							}),
							DKM_EFFORT_NAMES[lv] || lv))
						: null,
					react.createElement("button", { type: "button", className: "dkm-mini", title: "一键勾选全部强度档（切为自定义）", onClick: () => patchModel(i, allLevels(true)) }, "全选"),
					react.createElement("button", { type: "button", className: "dkm-mini", title: "一键取消全部强度档", onClick: () => patchModel(i, allLevels(false)) }, "取消全选"))));

	const body = [];
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
		// 图片能力以运行时视角（runtimeInput，与官方投影同源）为准，无则回退条目 input
		const effInput = (m) => (m.runtimeInput && m.runtimeInput.length > 0 ? m.runtimeInput : m.input) || [];
		const vpDirect = [];
		const vpProxied = [];
		for (const p of providers) {
			for (const m of (p.models || [])) {
				const item = { key: p.id + "/" + m.id, label: (p.displayName || p.id) + " / " + (m.name || m.id), model: m.name || m.id };
				(effInput(m).indexOf("image") >= 0 ? vpDirect : vpProxied).push(item);
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
					? react.createElement("span", { className: "dkm-sub" }, "目录里暂无多模态模型——先在下方给真·多模态模型勾选「图片」输入类型")
					: null),
			react.createElement("div", { className: "dkm-sub" },
				"判定与官方运行时同源：「图片」勾选（或目录默认）= 端点原生支持、原图直发；其余模型收图自动走视觉模型。注意：若端点实际不认图却勾了「图片」，模型会看不见图片、转而用工具瞎折腾——不确定就不要勾，交给代理。"),
			vpDirect.length > 0
				? react.createElement("div", { className: "dkm-checks" },
					react.createElement("span", { className: "dkm-label" }, "原图直发（多模态，" + vpDirect.length + "）："),
					vpDirect.map((c) => react.createElement("span", { key: c.key, className: "dkm-chip", title: c.key }, c.model)))
				: null,
			vpProxied.length > 0
				? react.createElement("div", { className: "dkm-checks" },
					react.createElement("span", { className: "dkm-label" }, "走视觉代理（纯文本，" + vpProxied.length + "）："),
					react.createElement("span", { className: "dkm-sub" }, vpProxied.map((c) => c.model).join("、")))
				: null,
			react.createElement("div", { className: "dkm-savebar" },
				react.createElement("button", { type: "button", className: "dkm-save", disabled: !vpDirty || vpSaving, onClick: saveVp }, vpSaving ? "保存中…" : "保存图片代理配置"),
				vpMsg ? react.createElement("span", { className: "dkm-msg " + (vpMsg.ok ? "ok" : "err") }, vpMsg.text)
					: react.createElement("span", { className: "dkm-msg" }, vpDirty ? "有未保存的修改" : ""))));
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
				react.createElement("button", { type: "button", className: "dkb-refresh", disabled: saving, onClick: () => { setBuiltKey(null); modelsStore.load(); } }, "重新拉取"),
				msg ? react.createElement("span", { className: "dkm-msg " + (msg.ok ? "ok" : "err") }, msg.text) : null)));
	}
	return react.createElement("div", { className: "dkm-list" }, body);
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
	description: "编辑各 Provider 模型目录：输入类型（文本/图片 + 标注）与思考强度档位；写回官方配置热生效，会话模型选择器即时可选",
	css: [
		".dkm-note{color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;}",
		".dkm-chips{display:flex;flex-wrap:wrap;gap:6px;}",
		".dkm-chip{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 12px;font-family:inherit;font-size:12px;}",
		".dkm-chip.on{color:var(--dsw-alias-accent,#4d9fff);border-color:currentColor;}",
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
		".dkm-check input{accent-color:var(--dsw-alias-accent,#4d9fff);margin:0;}",
		".dkm-tag{color:var(--dsw-alias-label-tertiary);}",
		".dkm-efforts{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}",
		".dkm-del{margin-left:auto;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:8px;padding:2px 10px;font-family:inherit;font-size:12px;flex:none;}",
		".dkm-del:hover{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
		".dkm-add{cursor:pointer;border:1px dashed var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:10px;padding:6px 14px;font-family:inherit;font-size:12px;align-self:flex-start;}",
		".dkm-add:hover{color:var(--dsw-alias-label-primary);}",
		".dkm-savebar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
		".dkm-save{cursor:pointer;border:1px solid var(--dsw-alias-accent,#4d9fff);color:var(--dsw-alias-accent,#4d9fff);background:transparent;border-radius:8px;padding:4px 14px;font-family:inherit;font-size:12px;flex:none;}",
		".dkm-save:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkm-save[disabled]{opacity:.5;cursor:default;}",
		".dkm-msg{font-size:12px;color:var(--dsw-alias-label-secondary);}",
		".dkm-msg.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkm-msg.err{color:var(--dsw-alias-state-error-primary);}",
		".dkm-list{display:flex;flex-direction:column;gap:8px;}",
		".dkm-ro{color:var(--dsw-alias-label-secondary);font-size:12px;}",
		".dkm-mini{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 8px;font-family:inherit;font-size:11px;flex:none;}",
		".dkm-mini:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary);}",
		".dkm-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l1);padding-top:8px;}",
		".dkm-toolbar-label{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none;}"
	].join("\n"),
	View: ModelsView,
	HomeStat: ModelsStat,
};
