// dsh-dock · 模型目录客户端共享层（草稿工具）
//
// 【模型设置】（编辑已有 Provider 的模型条目）与【模型提供商】（新建/更新 Provider 时
// 随带模型）在浏览器里编辑的是同一种「模型草稿」：id / 名称 / 容量 / 输入模态 / 标注 /
// 思考强度档位。这里放两边共用的常量与纯函数，避免各自复刻一份口径（曾经两份实现漂移过：
// 思考档位与输入模态的默认值不一致）。

// 官方 schema 接受的真实输入模态；其余（视频等）仅作为 dockTags 标注随配置持久化
export const DKM_MODALITIES = [["text", "文本"], ["image", "图片"]];
export const DKM_TAGS = [["video", "视频"], ["audio", "音频"], ["document", "文档"]];
export const DKM_PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const DKM_DS_LEVELS = ["off", "low", "high", "max"];
export const DKM_EFFORT_NAMES = { off: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高" };
// Provider 级增删改：api 协议选项（与宿主 PI_AI_APIS 一致）与路由 key 约束（与宿主同规则）
export const DKM_APIS = [
	["openai-completions", "OpenAI 兼容（chat/completions）"],
	["openai-responses", "OpenAI Responses"],
	["anthropic-messages", "Anthropic Messages"]
];
export const DKM_ROUTE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 由路由 key 推导凭据库条目名：jiyuanlvdong -> JIYUANLVDONG_API_KEY。让 apiKeyEnv 可以真的留空。 */
export function dkmEnvFromRoute(route) {
	const s = String(route || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	if (!s) return "";
	return (/^[0-9]/.test(s) ? "KEY_" + s : s) + "_API_KEY";
}

export const DKM_ALL_INPUT = DKM_MODALITIES.map((x) => x[0]);
export const DKM_ALL_TAGS = DKM_TAGS.map((x) => x[0]);

export function dkmToggleIn(list, v) {
	return list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : list.concat([v]);
}
export function dkmAllInputs(on) {
	return { input: on ? DKM_ALL_INPUT.slice() : [], tags: on ? DKM_ALL_TAGS.slice() : [] };
}
export function dkmAllLevels(on) {
	const lv = {};
	for (const k of DKM_PI_LEVELS) lv[k] = !!on;
	return { effortsMode: "custom", effortLevels: lv };
}

/** 单个目录模型条目 → 可编辑草稿（目录编辑器与 Provider 表单共用）。 */
export function draftFromModel(m) {
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
export function emptyModelDraft() {
	return { id: "", name: "", contextWindow: "", maxTokens: "", input: ["text"], tags: [], effortsMode: "inherit", effortLevels: {}, raw: null };
}

/** 新增 Provider 的空表单。 */
export function emptyProviderForm() {
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

/** 从目录 Provider 视图构建可编辑草稿（模型设置页只取 models 字段）。 */
export function draftFromProvider(p) {
	return {
		id: p.id,
		kind: p.kind,
		thinking: p.thinking === "disabled" ? "disabled" : "enabled",
		defaultEffort: DKM_DS_LEVELS.indexOf(p.defaultEffort) >= 0 ? p.defaultEffort : "high",
		models: (p.models || []).map(draftFromModel)
	};
}

/**
 * 由目录 Provider 视图构建「编辑 Provider」表单。
 * 以用户层原始配置（rawProfile）为准回填；面板不负责的未知字段（自配 compat/description 等）
 * 收进 extra，保存时原样并回，避免把用户手写配置抹掉。API Key 明文永不回显。
 */
export function providerFormFromProvider(p) {
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
