// dsh-dock · 功能模块【MCP 管理】· 客户端视图
//
// 管理 DSH 使用的 MCP 服务器（增删改 / 启停 / 工具状态）。数据来自宿主半部：
//   GET  /dsh-dock/mcpconfig
//        → { ok, patchPath, hmrAvailable, warning?/warnings?, servers: [{
//             serverName, transport, command?, args?, env?, cwd?, url?, headers?,
//             enabled, failOnStartupError, toolCallTimeoutMs,
//             state: 'active'|'inactive'|'failed'|'disabled'|'unknown', error, tools, toolCount }] }
//   POST /dsh-dock/mcpconfig  { action:'save', servers:[…] }（全量列表；增删改启停都由前端算好整表提交）
//        → { ok:true, changed, applied, restartRequired?, warnings? }
//        → 400/409 { ok:false, error, rolledBack?, needsRestart? }
//
// 写法照抄 features/providerconfig/view.js：纯 react.createElement、模块自带 css（dkmc- 前缀）、
// fetch 用相对路径 "dsh-dock/mcpconfig"（子路径反代可解析）、cache:'no-store'、AbortSignal 超时。
import react from "react";

const ENDPOINT = "dsh-dock/mcpconfig";
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_TOOL_TIMEOUT_MS = 60000;
const TRANSPORTS = [
	{ value: "stdio", label: "stdio（本机子进程）" },
	{ value: "streamable-http", label: "streamable-http（远端 HTTP）" },
];
const STATE_TEXT = { active: "运行中", inactive: "未连接", failed: "失败", disabled: "已停用", unknown: "未知" };

/** 与 providerconfig 同款超时信号；AbortSignal 不可用时退化为无信号。 */
function timeoutSignal(ms) {
	try {
		if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
	} catch (e) { /* 老内核：不加超时 */ }
	return undefined;
}

/** 兼容宿主两种错误形态：{ error:"…" } 与 { error:{ message:"…" } }。 */
function errorText(body, fallback) {
	if (body && typeof body.error === "string" && body.error) return body.error;
	if (body && body.error && typeof body.error.message === "string" && body.error.message) return body.error.message;
	return fallback;
}
function messageOf(e) {
	return (e && e.message) || String(e);
}

/** 多行 "K=V" → 对象；空行忽略。 */
function linesToEnv(text) {
	const out = {};
	for (const line of String(text || "").split(/\r?\n/)) {
		const raw = line.trim();
		if (!raw) continue;
		const at = raw.indexOf("=");
		if (at < 0) { out[raw] = ""; continue; }
		const key = raw.slice(0, at).trim();
		if (key) out[key] = raw.slice(at + 1).trim();
	}
	return out;
}
/** 多行 "KEY: VALUE" → 对象（首个冒号切分；VALUE 可含冒号）。 */
function linesToHeaders(text) {
	const out = {};
	for (const line of String(text || "").split(/\r?\n/)) {
		const raw = line.trim();
		if (!raw) continue;
		const at = raw.indexOf(":");
		if (at < 0) { out[raw] = ""; continue; }
		const key = raw.slice(0, at).trim();
		if (key) out[key] = raw.slice(at + 1).trim();
	}
	return out;
}
/** 对象 → 多行文本；对象值（如 !!js 表达式节点）退化为 JSON 展示。 */
function mapToEnvText(map) {
	return Object.keys(map || {}).map((k) => {
		const v = map[k];
		return k + "=" + (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
	}).join("\n");
}
function mapToHeadersText(map) {
	return Object.keys(map || {}).map((k) => {
		const v = map[k];
		return k + ": " + (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
	}).join("\n");
}
function argsToText(args) {
	return (Array.isArray(args) ? args : []).map((x) => (typeof x === "string" ? x : String(x))).join("\n");
}
function textToArgs(text) {
	return String(text || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

/** GET 的服务器条目 → 编辑草稿（保留展示用字段，保存时再剥离）。 */
function toDraft(server) {
	const s = server && typeof server === "object" ? server : {};
	return {
		serverName: typeof s.serverName === "string" ? s.serverName : "",
		transport: s.transport === "streamable-http" ? "streamable-http" : "stdio",
		command: typeof s.command === "string" ? s.command : "",
		args: Array.isArray(s.args) ? s.args.filter((x) => typeof x === "string") : [],
		env: s.env && typeof s.env === "object" && !Array.isArray(s.env) ? s.env : {},
		cwd: typeof s.cwd === "string" ? s.cwd : "",
		url: typeof s.url === "string" ? s.url : "",
		headers: s.headers && typeof s.headers === "object" && !Array.isArray(s.headers) ? s.headers : {},
		enabled: s.enabled !== false,
		failOnStartupError: s.failOnStartupError === true,
		toolCallTimeoutMs: Number.isFinite(s.toolCallTimeoutMs) && s.toolCallTimeoutMs > 0 ? s.toolCallTimeoutMs : DEFAULT_TOOL_TIMEOUT_MS,
		// 只读展示字段（POST 不含这些）
		state: typeof s.state === "string" ? s.state : "unknown",
		error: typeof s.error === "string" && s.error ? s.error : null,
		tools: Array.isArray(s.tools) ? s.tools.filter((x) => typeof x === "string") : [],
		toolCount: Number.isFinite(s.toolCount) ? s.toolCount : (Array.isArray(s.tools) ? s.tools.length : 0),
	};
}

/** 草稿 → POST 用的服务器定义（剥掉 state/tools/toolCount/error 等只读字段）。 */
function toSaveShape(draft) {
	const base = {
		serverName: draft.serverName,
		transport: draft.transport === "streamable-http" ? "streamable-http" : "stdio",
		enabled: draft.enabled !== false,
		failOnStartupError: draft.failOnStartupError === true,
		toolCallTimeoutMs: draft.toolCallTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS,
	};
	if (base.transport === "streamable-http") {
		return Object.assign(base, { url: draft.url || "", headers: draft.headers || {} });
	}
	return Object.assign(base, {
		command: draft.command || "",
		args: Array.isArray(draft.args) ? draft.args : [],
		env: draft.env || {},
		cwd: draft.cwd || "",
	});
}

/** 新建表单初始值。 */
function emptyForm() {
	return {
		mode: "create",
		index: -1,
		serverName: "",
		transport: "stdio",
		command: "",
		argsText: "",
		envText: "",
		cwd: "",
		url: "",
		headersText: "",
		toolCallTimeoutMs: String(DEFAULT_TOOL_TIMEOUT_MS),
		failOnStartupError: false,
		enabled: true,
	};
}
/** 编辑表单：由草稿展开（args/env/headers 转成多行文本）。 */
function formFrom(draft, index) {
	return {
		mode: "edit",
		index: index,
		serverName: draft.serverName,
		transport: draft.transport,
		command: draft.command || "",
		argsText: argsToText(draft.args),
		envText: mapToEnvText(draft.env),
		cwd: draft.cwd || "",
		url: draft.url || "",
		headersText: mapToHeadersText(draft.headers),
		toolCallTimeoutMs: String(draft.toolCallTimeoutMs || DEFAULT_TOOL_TIMEOUT_MS),
		failOnStartupError: !!draft.failOnStartupError,
		enabled: draft.enabled !== false,
	};
}

/** 表单 → 草稿 + 校验（校验失败返回 { error }）。 */
function formToDraft(form, drafts) {
	const serverName = String(form.serverName || "").trim();
	if (!SERVER_NAME_RE.test(serverName)) {
		return { error: "serverName 非法：须匹配 " + SERVER_NAME_RE + "（1~32 位字母、数字、_ 或 -）" };
	}
	const duplicate = drafts.some((d, i) => i !== form.index && d.serverName === serverName);
	if (duplicate) return { error: "serverName「" + serverName + "」已存在，请换一个名字" };
	const transport = form.transport === "streamable-http" ? "streamable-http" : "stdio";
	const timeoutRaw = String(form.toolCallTimeoutMs === undefined ? "" : form.toolCallTimeoutMs).trim();
	const timeout = timeoutRaw === "" ? DEFAULT_TOOL_TIMEOUT_MS : Number(timeoutRaw);
	if (!Number.isFinite(timeout) || timeout <= 0) return { error: "toolCallTimeoutMs 须为正整数（毫秒），默认 " + DEFAULT_TOOL_TIMEOUT_MS };
	const base = {
		serverName: serverName,
		transport: transport,
		enabled: form.mode === "create" ? form.enabled !== false : drafts[form.index] ? drafts[form.index].enabled !== false : true,
		failOnStartupError: !!form.failOnStartupError,
		toolCallTimeoutMs: Math.floor(timeout),
	};
	if (transport === "streamable-http") {
		const url = String(form.url || "").trim();
		if (!/^https?:\/\//i.test(url)) return { error: "url 非法：须以 http:// 或 https:// 开头" };
		const headers = linesToHeaders(form.headersText);
		for (const key of Object.keys(headers)) {
			if (!/^[A-Za-z0-9-]+$/.test(key)) return { error: "header 名非法：" + key };
		}
		return { draft: Object.assign(base, { url: url, headers: headers, command: "", args: [], env: {}, cwd: "" }) };
	}
	const command = String(form.command || "").trim();
	if (!command) return { error: "stdio 传输必须填写 command（可执行文件路径）" };
	const env = linesToEnv(form.envText);
	for (const key of Object.keys(env)) {
		if (!ENV_KEY_RE.test(key)) return { error: "环境变量名非法：" + key + "（须匹配 " + ENV_KEY_RE + "）" };
	}
	return { draft: Object.assign(base, { command: command, args: textToArgs(form.argsText), env: env, cwd: String(form.cwd || "").trim(), url: "", headers: {} }) };
}

/** 状态点：active 绿 / inactive 灰 / failed 红 / disabled 灰 / unknown 灰。 */
function stateDotClass(state) {
	if (state === "active") return "dkmc-dot ok";
	if (state === "failed") return "dkmc-dot err";
	if (state === "inactive") return "dkmc-dot idle";
	return "dkmc-dot off";
}
function stateClass(state) {
	if (state === "active") return "dkmc-state ok";
	if (state === "failed") return "dkmc-state err";
	return "dkmc-state";
}

function Field(props) {
	return react.createElement("div", { className: "dkmc-field" },
		react.createElement("label", { className: "dkmc-flabel" }, props.label),
		props.children,
		props.hint ? react.createElement("p", { className: "dkmc-hint" }, props.hint) : null);
}

/** 新增 / 编辑表单（create 在底部「新增」块内渲染，edit 就地展开在卡片内）。 */
function ServerForm(props) {
	const form = props.form;
	const patch = props.patch;
	const onSave = props.onSave;
	const onCancel = props.onCancel;
	const saving = props.saving;
	const onExample = props.onExample;
	const input = (p) => react.createElement("input", Object.assign({ className: "dkmc-input" }, p));
	const isEdit = form.mode === "edit";

	return react.createElement("div", { className: "dkmc-editor" },
		react.createElement("div", { className: "dkmc-editor-head" },
			react.createElement("span", { className: "dkmc-editor-title" }, isEdit ? "编辑 MCP 服务器" : "新增 MCP 服务器"),
			react.createElement("span", { className: "dkmc-editor-sub" }, isEdit ? form.serverName : "写回 cordis.patch.yml 的托管块并热应用"),
			!isEdit && typeof onExample === "function"
				? react.createElement("button", {
					type: "button",
					className: "dkmc-btn ghost sm dkmc-example",
					title: "一键填入本机 Xiaomi-OCR MCP 服务器配置",
					disabled: saving,
					onClick: onExample,
				}, "填入本机 Xiaomi-OCR 示例")
				: null),
		props.error ? react.createElement("p", { className: "dkmc-error" }, props.error) : null,
		Field({
			label: "serverName",
			hint: "工具名前缀：模型看到的是 mcp__<serverName>__<tool>；须匹配 " + SERVER_NAME_RE,
		}, input({
			value: form.serverName,
			placeholder: "xiaomi_ocr",
			disabled: isEdit,
			onChange: (e) => patch({ serverName: e.target.value }),
		})),
		Field({ label: "传输方式" }, react.createElement("select", {
			className: "dkmc-input dkmc-select",
			value: form.transport,
			onChange: (e) => patch({ transport: e.target.value }),
		},
			TRANSPORTS.map((t) => react.createElement("option", { key: t.value, value: t.value }, t.label)))),
		form.transport === "streamable-http"
			? Field({ label: "url", hint: "MCP 端点（Streamable HTTP），须以 http:// 或 https:// 开头" },
				input({ value: form.url, placeholder: "http://127.0.0.1:3000/mcp", onChange: (e) => patch({ url: e.target.value }) }))
			: Field({ label: "command", hint: "可执行文件绝对路径或 PATH 中的命令" },
				input({ value: form.command, placeholder: "/usr/bin/python3", onChange: (e) => patch({ command: e.target.value }) })),
		form.transport === "streamable-http"
			? Field({ label: "headers（每行一个 KEY: VALUE）", hint: "如 Authorization: Bearer xxx；值为空的行忽略" },
				react.createElement("textarea", {
					className: "dkmc-input dkmc-textarea",
					rows: 4,
					spellCheck: false,
					value: form.headersText,
					placeholder: "Authorization: Bearer xxxxx",
					onChange: (e) => patch({ headersText: e.target.value }),
				}))
			: react.createElement(react.Fragment, null,
				Field({ label: "args（每行一个参数）" },
					react.createElement("textarea", {
						className: "dkmc-input dkmc-textarea",
						rows: 4,
						spellCheck: false,
						value: form.argsText,
						placeholder: "/www/wwwroot/xiaomi-ocr/mcp_ocr.py",
						onChange: (e) => patch({ argsText: e.target.value }),
					})),
				Field({ label: "env（每行一个 KEY=VALUE）", hint: "环境变量会明文写进 profile 补丁层（文件 0600，仅本机可读）；没有可留空" },
					react.createElement("textarea", {
						className: "dkmc-input dkmc-textarea",
						rows: 3,
						spellCheck: false,
						value: form.envText,
						placeholder: "PYTHONUNBUFFERED=1",
						onChange: (e) => patch({ envText: e.target.value }),
					})),
				Field({ label: "cwd（可选）" },
					input({ value: form.cwd, placeholder: "/www/wwwroot/xiaomi-ocr", onChange: (e) => patch({ cwd: e.target.value }) }))),
		react.createElement("details", { className: "dkmc-advanced" },
			react.createElement("summary", { className: "dkmc-summary" }, "高级"),
			react.createElement("div", { className: "dkmc-advanced-body" },
				Field({ label: "toolCallTimeoutMs", hint: "单次 MCP 工具调用超时（毫秒），默认 " + DEFAULT_TOOL_TIMEOUT_MS },
					input({ value: form.toolCallTimeoutMs, inputMode: "numeric", placeholder: String(DEFAULT_TOOL_TIMEOUT_MS), onChange: (e) => patch({ toolCallTimeoutMs: e.target.value }) })),
				react.createElement("label", { className: "dkmc-check" },
					react.createElement("input", {
						type: "checkbox",
						checked: !!form.failOnStartupError,
						onChange: () => patch({ failOnStartupError: !form.failOnStartupError }),
					}), "首次连接失败时拒绝启用该行（failOnStartupError）"))),
		react.createElement("div", { className: "dkmc-editor-actions" },
			react.createElement("button", { type: "button", className: "dkmc-btn ghost", disabled: saving, onClick: onCancel }, "取消"),
			react.createElement("button", { type: "button", className: "dkmc-btn primary", disabled: saving, onClick: onSave },
				saving ? "保存中…" : (isEdit ? "保存修改" : "新增并保存"))));
}

/** MCP 管理页：顶部说明 + 补丁路径/HMR 状态 + 服务器卡片列表 + 新增/编辑表单。 */
function McpConfigView() {
	const [snap, setSnap] = react.useState({ loading: true, error: null, data: null });
	const [drafts, setDrafts] = react.useState([]);
	const [form, setForm] = react.useState(null);
	const [formError, setFormError] = react.useState(null);
	const [saving, setSaving] = react.useState(false);
	const [msg, setMsg] = react.useState(null);   // { tone:'ok'|'err'|'warn', text }
	const [delArm, setDelArm] = react.useState(null); // 待二次确认删除的 serverName

	/** GET 刷新：全量重建草稿列表。 */
	const refresh = async () => {
		setSnap((s) => Object.assign({}, s, { loading: true, error: null }));
		try {
			if (typeof fetch !== "function") throw new Error("当前环境没有 fetch，无法读取 MCP 配置");
			const res = await fetch(ENDPOINT, { cache: "no-store", signal: timeoutSignal(60000) });
			const body = await res.json().catch(() => null);
			if (!res.ok) throw new Error(errorText(body, "MCP 配置接口 HTTP " + res.status));
			if (!body || body.ok === false) throw new Error(errorText(body, "MCP 配置接口返回异常"));
			// 兼容两种载荷：扁平 {servers}（本功能契约）与 {data:{servers}}（dsh-dock 通用约定）
			const list = Array.isArray(body.servers) ? body.servers
				: body.data && Array.isArray(body.data.servers) ? body.data.servers
					: [];
			setSnap({ loading: false, error: null, data: body });
			setDrafts(list.map(toDraft));
		} catch (e) {
			setSnap({ loading: false, error: messageOf(e), data: null });
		}
	};
	react.useEffect(() => { refresh(); }, []);

	/** 提交整表：成功刷新（重新 GET）；失败回滚本地草稿并在表单上方显示 error。 */
	const commit = async (nextDrafts, successText) => {
		if (saving) return false;
		const previous = drafts;
		setSaving(true);
		setFormError(null);
		setMsg(null);
		setDrafts(nextDrafts);
		try {
			if (typeof fetch !== "function") throw new Error("当前环境没有 fetch，无法保存 MCP 配置");
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "save", servers: nextDrafts.map(toSaveShape) }),
				cache: "no-store",
				signal: timeoutSignal(60000),
			});
			const body = await res.json().catch(() => null);
			if (!res.ok || !body || body.ok === false) {
				const extra = body && body.rolledBack ? "（已回滚到保存前的配置）" : body && body.needsRestart ? "（配置可能已写入，需重启 DSH 检查）" : "";
				throw new Error(errorText(body, "保存失败：HTTP " + res.status) + extra);
			}
			const notes = [];
			if (body.restartRequired) notes.push("已保存，重启 DSH 后生效");
			else if (body.applied === false) notes.push("已保存，等待 DSH 应用");
			else notes.push(body.changed === false ? "配置没有变化" : "已应用");
			for (const w of (Array.isArray(body.warnings) ? body.warnings : [])) notes.push(String(w));
			setMsg({ tone: "ok", text: successText + "；" + notes.join("；") });
			setForm(null);
			setFormError(null);
			setDelArm(null);
			await refresh();
			return true;
		} catch (e) {
			setDrafts(previous);
			setFormError(messageOf(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	const openCreate = () => { setForm(emptyForm()); setFormError(null); setMsg(null); setDelArm(null); };
	const openEdit = (draft, index) => { setForm(formFrom(draft, index)); setFormError(null); setMsg(null); setDelArm(null); };
	const closeForm = () => { setForm(null); setFormError(null); };
	const patchForm = (patch) => { setForm((f) => Object.assign({}, f, patch)); setFormError(null); };

	const saveForm = () => {
		if (!form || saving) return;
		const result = formToDraft(form, drafts);
		if (result.error) { setFormError(result.error); return; }
		const draft = result.draft;
		const next = form.mode === "edit"
			? drafts.map((d, i) => (i === form.index ? Object.assign({}, d, draft) : d))
			: drafts.concat([draft]);
		const text = (form.mode === "edit" ? "已更新「" : "已新增「") + draft.serverName + "」";
		commit(next, text);
	};

	const toggle = (draft) => {
		const next = drafts.map((d) => (d.serverName === draft.serverName ? Object.assign({}, d, { enabled: !d.enabled }) : d));
		commit(next, "已" + (draft.enabled ? "停用「" : "启用「") + draft.serverName + "」");
	};
	// 删除：两步确认（照抄 providerconfig 的「再点一次确认」，不用 window.confirm）
	const remove = (draft) => {
		if (delArm !== draft.serverName) { setDelArm(draft.serverName); setMsg(null); setFormError(null); return; }
		setDelArm(null);
		const next = drafts.filter((d) => d.serverName !== draft.serverName);
		if (form && form.mode === "edit" && form.serverName === draft.serverName) closeForm();
		commit(next, "已删除「" + draft.serverName + "」");
	};

	// 一键填入本机 Xiaomi-OCR 示例（已存在则只提示，不覆盖）
	const fillXiaomiExample = () => {
		if (drafts.some((d) => d.serverName === "xiaomi_ocr")) {
			setMsg({ tone: "warn", text: "列表里已经有 xiaomi_ocr（可直接点该卡片的「编辑」查看/修改）" });
			return;
		}
		setForm(Object.assign(emptyForm(), {
			serverName: "xiaomi_ocr",
			transport: "stdio",
			command: "/usr/bin/python3",
			argsText: "/www/wwwroot/xiaomi-ocr/mcp_ocr.py",
			cwd: "/www/wwwroot/xiaomi-ocr",
			envText: "",
			toolCallTimeoutMs: "300000",
			failOnStartupError: false,
		}));
		setFormError(null);
		setMsg(null);
	};

	const data = snap.data;
	const patchPath = data && typeof data.patchPath === "string" ? data.patchPath : "";
	const hmrAvailable = !!(data && data.hmrAvailable);
	const warnings = data
		? (Array.isArray(data.warnings) ? data.warnings.filter((w) => typeof w === "string" && w)
			: (typeof data.warning === "string" && data.warning ? [data.warning] : []))
		: [];
	const serverCount = drafts.length;
	const enabledCount = drafts.filter((d) => d.enabled).length;
	const toolsTotal = drafts.reduce((n, d) => n + (Number.isFinite(d.toolCount) ? d.toolCount : 0), 0);

	const body = [
		react.createElement("div", { key: "head", className: "dkmc-head" },
			react.createElement("div", { className: "dkmc-head-title" },
				react.createElement("h2", { className: "dkmc-title" }, "MCP管理"),
				react.createElement("span", { className: "dkmc-badge " + (hmrAvailable ? "ok" : "warn"), title: hmrAvailable ? "保存后由 dsh-hmr 原地重载，无需重启" : "当前 profile 未启用 HMR：保存后需重启 DSH 生效" },
					hmrAvailable ? "即时生效" : "需重启 DSH 生效")),
			react.createElement("p", { className: "dkmc-intro" },
				"管理 DSH 使用的 MCP 服务器（新增 / 编辑 / 删除 / 启停），保存后写回当前 profile 的 cordis 补丁层托管块；连接成功后模型工具列表出现 mcp__<serverName>__<tool>。")),
		react.createElement("div", { key: "meta", className: "dkmc-meta" },
			react.createElement("span", { className: "dkmc-meta-label" }, "补丁文件"),
			react.createElement("code", { className: "dkmc-path", title: patchPath || undefined }, patchPath || "（尚未读取）"),
			react.createElement("button", { type: "button", className: "dkmc-btn ghost sm", disabled: snap.loading || saving, onClick: () => { setMsg(null); refresh(); } },
				snap.loading ? "刷新中…" : "刷新")),
	];
	if (warnings.length > 0) {
		body.push(react.createElement("ul", { key: "warnings", className: "dkmc-warnings" },
			warnings.map((w, i) => react.createElement("li", { key: i, className: "dkmc-warning" }, w))));
	}
	if (snap.error) {
		body.push(react.createElement("p", { key: "loaderr", className: "dkmc-error" }, "MCP 配置读取失败：" + snap.error));
	}
	if (msg) {
		body.push(react.createElement("p", {
			key: "msg",
			className: "dkmc-msg " + (msg.tone === "ok" ? "ok" : msg.tone === "warn" ? "warn" : "err"),
			role: "status",
		}, msg.text));
	}

	if (!data) {
		body.push(react.createElement("div", { key: "empty-loading", className: "dkmc-empty" },
			snap.loading ? "正在读取 MCP 服务器…" : "暂时读不到 MCP 配置，点上方「刷新」重试"));
	} else {
		body.push(react.createElement("div", { key: "summary", className: "dkmc-summary-line" },
			"共 " + serverCount + " 台服务器 · " + enabledCount + " 台启用 · 已注册工具 " + toolsTotal + " 个"));
		if (drafts.length === 0) {
			body.push(react.createElement("div", { key: "empty", className: "dkmc-empty" }, "还没有 MCP 服务器——点下方「新增 MCP 服务器」添加，或先填入本机 Xiaomi-OCR 示例。"));
		} else {
			body.push(react.createElement("ul", { key: "cards", className: "dkmc-cards" },
				drafts.map((draft, index) => {
					const editing = !!form && form.mode === "edit" && form.index === index;
					const state = draft.state || "unknown";
					const stateText = STATE_TEXT[state] || STATE_TEXT.unknown;
					const toolTitle = draft.tools && draft.tools.length > 0 ? draft.tools.join("\n") : "尚未注册工具";
					return react.createElement("li", { key: draft.serverName + ":" + index, className: "dkmc-card" + (editing ? " editing" : "") },
						react.createElement("div", { className: "dkmc-rowhead" },
							react.createElement("span", { className: "dkmc-name" }, draft.serverName || "（未命名）"),
							react.createElement("span", { className: "dkmc-tag" }, draft.transport === "streamable-http" ? "HTTP" : "stdio"),
							react.createElement("span", { className: stateClass(state), title: stateText },
								react.createElement("span", { className: stateDotClass(state), "aria-hidden": true }),
								stateText),
							react.createElement("span", { className: "dkmc-tools", title: toolTitle }, (Number.isFinite(draft.toolCount) ? draft.toolCount : 0) + " 个工具"),
							react.createElement("span", { className: "dkmc-actions" },
								react.createElement("button", {
									type: "button",
									className: "dkmc-switch" + (draft.enabled ? " on" : ""),
									role: "switch",
									"aria-checked": draft.enabled,
									"aria-label": (draft.enabled ? "停用" : "启用") + draft.serverName,
									title: draft.enabled ? "停用（保存后立即生效）" : "启用（保存后立即生效）",
									disabled: saving,
									onClick: () => toggle(draft),
								}, draft.enabled ? "已启用" : "已停用"),
								react.createElement("button", {
									type: "button",
									className: "dkmc-btn ghost sm",
									"aria-expanded": editing,
									disabled: saving,
									onClick: () => (editing ? closeForm() : openEdit(draft, index)),
								}, editing ? "收起" : "编辑"),
								react.createElement("button", {
									type: "button",
									className: "dkmc-btn danger sm" + (delArm === draft.serverName ? " arm" : ""),
									title: delArm === draft.serverName ? "再点一次确认删除" : "删除该 MCP 服务器",
									disabled: saving,
									onClick: () => remove(draft),
								}, delArm === draft.serverName ? "确认删除？" : "删除"))),
						draft.error ? react.createElement("p", { className: "dkmc-error dkmc-error-line", title: draft.error }, draft.error) : null,
						editing
							? react.createElement(ServerForm, {
								form: form,
								patch: patchForm,
								error: formError,
								saving: saving,
								onSave: saveForm,
								onCancel: closeForm,
							})
							: null);
				})));
		}
	}

	// 底部新增块：默认是一个虚线按钮；点开后在原位置展开新增表单
	body.push(react.createElement("div", { key: "add", className: "dkmc-addblock" },
		form && form.mode === "create"
			? react.createElement("div", { className: "dkmc-card dkmc-addcard" },
				react.createElement(ServerForm, {
					form: form,
					patch: patchForm,
					error: formError,
					saving: saving,
					onExample: fillXiaomiExample,
					onSave: saveForm,
					onCancel: closeForm,
				}))
			: react.createElement("div", { className: "dkmc-addrow" },
				react.createElement("button", { type: "button", className: "dkmc-addbtn", disabled: saving, onClick: openCreate }, "＋ 新增 MCP 服务器"),
				react.createElement("button", { type: "button", className: "dkmc-btn ghost", disabled: saving, onClick: fillXiaomiExample }, "填入本机 Xiaomi-OCR 示例"))));

	return react.createElement("div", { className: "dkmc-page" }, body);
}

export const feature = {
	id: "mcpconfig",
	name: "MCP管理",
	order: 101,
	accent: "#a855f7",
	description: "管理 DSH 使用的 MCP 服务器（增删改/启停/工具状态）",
	defaultEnabled: false,
	View: McpConfigView,
	css: [
		// ---- MCP 管理页（dkmc- 前缀；排版/尺寸对齐 providerconfig 的 dkp- 页） ----
		".dkmc-page{width:100%;max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;}",
		".dkmc-head{display:flex;flex-direction:column;gap:6px;}",
		".dkmc-head-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
		".dkmc-title{margin:0;font-size:16px;font-weight:500;line-height:24px;}",
		".dkmc-intro{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;}",
		".dkmc-badge{flex:none;border-radius:999px;padding:2px 9px;font-size:11px;line-height:16px;border:1px solid currentColor;}",
		".dkmc-badge.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkmc-badge.warn{color:var(--dk-warn);}",
		".dkmc-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);}",
		".dkmc-meta-label{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;}",
		".dkmc-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;}",
		".dkmc-warnings{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;}",
		".dkmc-warning{color:var(--dk-warn);font-size:12px;line-height:18px;}",
		".dkmc-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;word-break:break-word;}",
		".dkmc-error-line{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
		".dkmc-msg{margin:0;font-size:12px;line-height:18px;word-break:break-word;}",
		".dkmc-msg.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkmc-msg.warn{color:var(--dk-warn);}",
		".dkmc-msg.err{color:var(--dsw-alias-state-error-primary);}",
		".dkmc-summary-line{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
		".dkmc-empty{border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);padding:16px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}",
		".dkmc-cards{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}",
		".dkmc-card{box-sizing:border-box;margin:0;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border-radius:var(--dsw-radius-lg,10px);padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
		".dkmc-card.editing{border-color:color-mix(in srgb,var(--dk-accent) 45%,var(--dsw-alias-border-l2));}",
		".dkmc-rowhead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
		".dkmc-name{font-size:14px;font-weight:600;line-height:22px;overflow:hidden;text-overflow:ellipsis;max-width:100%;}",
		".dkmc-tag{flex:none;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs,4px);color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px;}",
		".dkmc-state{flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;}",
		".dkmc-state.ok{color:var(--dsw-alias-state-success-primary);}",
		".dkmc-state.err{color:var(--dsw-alias-state-error-primary);}",
		".dkmc-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary);}",
		".dkmc-dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 4px color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);}",
		".dkmc-dot.err{background:var(--dsw-alias-state-error-primary);}",
		".dkmc-dot.idle{background:transparent;border:1.5px solid var(--dsw-alias-label-secondary);}",
		".dkmc-dot.off{background:transparent;border:1.5px solid var(--dsw-alias-label-tertiary);opacity:.75;}",
		".dkmc-tools{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;white-space:nowrap;cursor:default;}",
		".dkmc-actions{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;}",
		".dkmc-switch{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:3px 10px;font-family:inherit;font-size:11px;line-height:16px;}",
		".dkmc-switch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
		".dkmc-switch[disabled]{opacity:.45;cursor:default;}",
		".dkmc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:32px;padding:0 12px;border:none;border-radius:var(--dsw-radius-md,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;}",
		".dkmc-btn.ghost{border:.5px solid var(--dsw-alias-border-l3);}",
		".dkmc-btn.ghost:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkmc-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dk-accent));color:var(--dsw-alias-label-primary-foreground,#fff);}",
		".dkmc-btn.danger{color:var(--dsw-alias-state-error-primary);}",
		".dkmc-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,38,38,.1));}",
		".dkmc-btn.arm{color:var(--dsw-alias-state-error-primary);border:.5px solid currentColor;}",
		".dkmc-btn.sm{height:26px;padding:0 9px;border-radius:var(--dsw-radius-sm,6px);font-size:11px;line-height:16px;}",
		".dkmc-btn[disabled]{opacity:.4;cursor:default;}",
		".dkmc-editor{border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-module-platform,var(--dsw-alias-bg-layer-1));padding:12px 14px;display:flex;flex-direction:column;gap:12px;}",
		".dkmc-editor-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}",
		".dkmc-editor-title{font-size:13px;font-weight:600;line-height:20px;}",
		".dkmc-editor-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;}",
		".dkmc-example{margin-left:auto;flex:none;}",
		".dkmc-field{display:flex;flex-direction:column;gap:5px;min-width:0;}",
		".dkmc-flabel{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;}",
		".dkmc-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;word-break:break-word;}",
		".dkmc-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;}",
		".dkmc-input:focus{border-color:var(--dsw-alias-state-business-primary,var(--dk-accent));outline:none;}",
		".dkmc-input::placeholder{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));}",
		".dkmc-input:disabled{opacity:.6;cursor:default;}",
		".dkmc-textarea{height:auto;min-height:64px;padding:8px 10px;resize:vertical;line-height:1.5;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;}",
		"select.dkmc-input{appearance:auto;cursor:pointer;max-width:280px;}",
		".dkmc-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}",
		".dkmc-check input{accent-color:var(--dk-accent);margin:0;}",
		".dkmc-advanced{border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px;}",
		".dkmc-summary{display:flex;align-items:center;gap:6px;width:fit-content;margin-left:-4px;padding:2px 4px;border-radius:var(--dsw-radius-sm,6px);list-style:none;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500;line-height:18px;}",
		".dkmc-summary::-webkit-details-marker{display:none;}",
		".dkmc-summary::before{content:\"\";width:5px;height:5px;border-right:1.5px solid;border-bottom:1.5px solid;transform:rotate(-45deg);transition:transform .12s;}",
		".dkmc-advanced[open]>.dkmc-summary::before{transform:rotate(45deg);}",
		".dkmc-advanced-body{display:flex;flex-direction:column;gap:12px;padding-top:12px;}",
		".dkmc-editor-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:10px;}",
		".dkmc-addblock{display:flex;align-items:stretch;}",
		".dkmc-addrow{display:flex;align-items:stretch;gap:8px;flex-wrap:wrap;}",
		".dkmc-addbtn{box-sizing:border-box;flex:1 1 220px;min-width:180px;height:44px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer;}",
		".dkmc-addbtn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
		".dkmc-addbtn[disabled]{opacity:.4;cursor:default;}",
		".dkmc-addcard{flex:1 1 auto;padding:12px 14px;}",
		".dkmc-addcard .dkmc-editor{background:transparent;padding:0;}",
		"@media (max-width:680px){.dkmc-page{max-width:none;gap:14px}.dkmc-intro{font-size:13px;line-height:20px}.dkmc-editor{padding:12px}.dkmc-addcard{padding:12px 14px}.dkmc-btn{height:40px}.dkmc-btn.sm{height:34px}.dkmc-addbtn{height:48px;flex:1 1 100%}.dkmc-actions{width:100%;margin-left:0;justify-content:flex-end}.dkmc-name{font-size:15px}}",
	].join("\n"),
};
