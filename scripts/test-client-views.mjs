/**
 * dsh-dock — 内置功能视图「渲染不崩」回归测试（无外部依赖，node scripts/test-client-views.mjs）
 *
 * 为什么需要它：内置功能的 View 由外壳直接渲染。视图渲染一旦抛错，宿主会把整个插槽条目
 * （shell.overlay / settings.section）换成空 div——表现为「界面整个没了」，而侧栏入口按钮
 * 仍是选中态，极难定位。v0.9.3 就踩过这个坑：features/animation/view.jsx 里 waitingCount
 * 跨块引用 → ReferenceError: waitingCount is not defined → 点开「任务动画」弹层直接消失。
 *
 * 做法：在 vm 沙箱里加载构建产物 client.js（与浏览器里真正跑的是同一份代码），
 * 用极简 React 替身做渲染，逐个启用内置功能渲染设置页面板，断言：
 *   1) 渲染不抛错；2) 页面出现该功能的实际内容。
 * 每个功能都跑多趟渲染直到状态稳定（覆盖「拉取到配置 / 任务状态后」的数据分支）。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = readFileSync(join(root, "client.js"), "utf8");

// ---------- 极简 React 替身 ----------
// 单趟渲染即可发现「渲染体内引用不存在的变量」这类崩溃；多趟渲染用于覆盖拉数据后的分支。
// 组件实例按「渲染路径」缓存（不是按全局调用序），这样条件分支出现/消失时 hook 位置不串位。
function createRuntime() {
	const Fragment = Symbol.for("dsh-dock-test.Fragment");
	const instances = new Map();
	const pending = [];
	const elements = []; // 宿主元素事件句柄（render 时收集，用例触发交互用）
	const noop = () => {};
	let currentPath = "root";
	let currentInst = null;
	let cursor = 0;
	let dirty = false;

	function instanceOf(path) {
		let inst = instances.get(path);
		if (!inst) { inst = { hooks: [], effects: [] }; instances.set(path, inst); }
		return inst;
	}
	function depsChanged(prev, next) {
		if (!prev || !next) return true;
		if (prev.length !== next.length) return true;
		return prev.some((v, i) => !Object.is(v, next[i]));
	}

	const react = {
		Fragment,
		createElement(type, props, ...children) {
			const p = Object.assign({}, props);
			if (children.length) p.children = children.length === 1 ? children[0] : children;
			return { type, props: p };
		},
		useState(init) {
			const inst = currentInst, i = cursor++;
			if (!(i in inst.hooks)) inst.hooks[i] = typeof init === "function" ? init() : init;
			const set = (next) => {
				const value = typeof next === "function" ? next(inst.hooks[i]) : next;
				if (!Object.is(value, inst.hooks[i])) { inst.hooks[i] = value; dirty = true; }
			};
			return [inst.hooks[i], set];
		},
		useReducer(reducer, init) {
			const inst = currentInst, i = cursor++;
			if (!(i in inst.hooks)) inst.hooks[i] = init;
			const dispatch = (action) => {
				const value = reducer(inst.hooks[i], action);
				if (!Object.is(value, inst.hooks[i])) { inst.hooks[i] = value; dirty = true; }
			};
			return [inst.hooks[i], dispatch];
		},
		useEffect(fn, deps) { pending.push({ inst: currentInst, index: cursor++, deps, fn }); },
		useLayoutEffect(fn, deps) { react.useEffect(fn, deps); },
		useRef(init) {
			const inst = currentInst, i = cursor++;
			if (!(i in inst.hooks)) inst.hooks[i] = { current: init === undefined ? null : init };
			return inst.hooks[i];
		},
		useMemo(fn, deps) {
			const inst = currentInst, i = cursor++;
			const slot = inst.hooks[i];
			if (!slot || depsChanged(slot.deps, deps)) inst.hooks[i] = { deps, value: fn() };
			return inst.hooks[i].value;
		},
		useCallback(fn, deps) { return react.useMemo(() => fn, deps); },
		useContext() { return {}; },
		memo(comp) { return comp; },
		createRef() { return { current: null }; },
		Component: class Component {
			constructor(props) { this.props = props || {}; this.state = {}; }
			setState(next) { Object.assign(this.state, typeof next === "function" ? next(this.state) : next); }
		},
	};
	react.Component.prototype.isReactComponent = {};

	const jsxRuntime = {
		Fragment,
		jsx: (type, props, key) => ({ type, props: Object.assign({}, props, key === undefined ? null : { key }) }),
		jsxs: (type, props, key) => ({ type, props: Object.assign({}, props, key === undefined ? null : { key }) }),
	};

	function render(node, out, key) {
		if (node === null || node === undefined || typeof node === "boolean") return;
		if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return; }
		if (Array.isArray(node)) { node.forEach((child, i) => render(child, out, key + ":" + i)); return; }
		const type = node.type;
		const props = node.props || {};
		if (type === Fragment) { render(props.children, out, key); return; }
		if (typeof type === "function") {			const path = currentPath + "/" + key + "#" + (type.name || "anon");
			const prevPath = currentPath, prevInst = currentInst, prevCursor = cursor;
			currentPath = path;
			currentInst = instanceOf(path);
			cursor = 0;
			try {
				if (type.prototype && typeof type.prototype.render === "function") {
					// 类组件实例按路径缓存（错误边界的 state 要跨趟保留）
					const inst = currentInst;
					if (!inst.classInstance) inst.classInstance = new type(props);
					const ci = inst.classInstance;
					ci.props = props;
					if (typeof type.getDerivedStateFromError === "function") {
						// 错误边界语义：子树抛错 → 更新 state → 重渲染自己（再抛则交给更外层边界）
						try {
							render(ci.render(), out, "r");
						} catch (err) {
							ci.state = Object.assign({}, ci.state, type.getDerivedStateFromError(err) || null);
							if (typeof ci.componentDidCatch === "function") ci.componentDidCatch(err, {});
							render(ci.render(), out, "r");
						}
					} else {
						render(ci.render(), out, "r");
					}
				} else {
					render(type(props), out, "r");
				}
			} finally {
				currentPath = prevPath;
				currentInst = prevInst;
				cursor = prevCursor;
			}
			return;
		}
		// 宿主元素：记录带事件句柄的节点，供用例触发 onClick / onMouseEnter 等
		if (typeof type === "string") {
			const cls = String(props.className || "");
			for (const ev of ["onClick", "onMouseEnter", "onMouseLeave", "onChange"]) {
				if (typeof props[ev] === "function") elements.push({ tag: type, className: cls, event: ev, handler: props[ev] });
			}
			out.push("<" + type + (cls ? ' class="' + cls + '"' : "") + ">");
		}
		render(props.children, out, key);
	}
	// render 挂在返回对象上，避免外部重复实现
	return {
		react, jsxRuntime, elements,
		beginPass() { pending.length = 0; elements.length = 0; cursor = 0; },
		isDirty: () => dirty,
		clearDirty() { dirty = false; },
		runEffects() {
			for (const p of pending) {
				const prev = p.inst.effects[p.index];
				if (prev && !depsChanged(prev.deps, p.deps)) continue;
				if (prev && typeof prev.cleanup === "function") {
					try { prev.cleanup(); } catch { /* 清理失败不影响断言 */ }
				}
				let cleanup = null;
				try { cleanup = p.fn(); } catch { cleanup = null; }
				p.inst.effects[p.index] = { deps: p.deps, cleanup: typeof cleanup === "function" ? cleanup : null };
			}
		},
		render(node) { const out = []; render(node, out, "0"); return out.join(" "); },
	};
}

// ---------- 宿主桩：最小浏览器环境 + 按 URL 返回数据的 fetch ----------
// 状态既可以直接给对象（每轮返回同一引用），也可以给函数（每轮返回新对象——
// 覆盖「轮询到新快照 → 触发任务结束检测」这类按引用变化才生效的分支）。
// posts 记录所有 POST /dsh-dock/features（开关同步断言用）。
function resolveStatus(s) { return typeof s === "function" ? s() : s; }
function makeFetch(animationStatus, notifyStatus, posts, persisted, runstateStatus, ttsStatus) {
	return (url, init) => {
		// 只拦截功能开关的同步 POST 与【语音朗读】的配置 POST（防抖断言要数它）；
		// 其余功能自己的 RPC 也是 POST，不能一起吃掉
		if (init && init.method === "POST" && (String(url).includes("dsh-dock/features") || String(url).includes("dsh-dock/tts/config"))) {
			posts.push({ url: String(url), body: JSON.parse(init.body || "{}") });
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) });
		}
		// 模型目录：视图直接用 json() 结果作目录（不包 ok/data），须与真实宿主一致
		//（视图用相对 URL "dsh-dock/models"，此处不要求前导斜杠以兼容）
		if (String(url).includes("dsh-dock/models")) {
			return Promise.resolve({ ok: true, status: 200, json: async () => MODELCONFIG_DIR });
		}
		// 模型提供商：与模型目录同一份目录数据（真实宿主额外补 apiKeyConfigured，fixture 已含）
		if (String(url).includes("dsh-dock/providerconfig")) {
			return Promise.resolve({ ok: true, status: 200, json: async () => MODELCONFIG_DIR });
		}
		let data = {};
		// 用量记录 query 的正常响应。此前该分支缺失 → TokenLogView 渲染时读 data.counts 抛错、
		// 被错误边界降级为一行提示，而断言用的 marker「用量」恰好能在卡片描述里命中，于是
		// 「渲染正常」是假的。补上真实响应后，下面用「调用明细」「单价设置」等内容做断言。
		if (url.includes("dsh-dock/tokenlog/query")) {
			data = {
				records: [{
					id: "s1:1", time: 1_700_000_000_000, sessionId: "sess-1", provider: "deepseek", model: "deepseek-v4-flash",
					inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 0,
					billedInput: 1200, totalTokens: 1700, cacheHitPercent: 17, cost: 0.5, pricingSource: "custom",
					effort: "high", status: "completed", statusCode: 0, errorCode: "", errorMsg: "", llmMs: 1200, turn: 1, step: 1,
				}],
				counts: { total: 1, matching: 1 },
				providers: ["deepseek"], models: ["deepseek-v4-flash"], modelsByProvider: { deepseek: ["deepseek-v4-flash"] },
				statuses: ["completed"], efforts: ["high"], sessionIds: ["sess-1"],
				rateUsdCny: 7.2,
				pricingInfo: { hasCustom: true, customCount: 1, fetchOfficial: true, sources: ["自定义"] },
				totals: {
					calls: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 0, reasoningTokens: 0,
					billedInput: 1200, totalTokens: 1700, cacheHitPct: 17, cost: 0.5, llmMs: 1200, timed: 1,
				},
				summary: [],
			};
		}
		if (url.includes("dsh-dock/tokenlog/pricing")) {
			data = {
				usdCnyRate: 7.2, fetchOfficial: true, pricingFetchIntervalHours: 24,
				// 多段分时价（覆盖时段增删/跨零点/日期类型展示分支）
				pricing: [{
					match: "deepseek-v4-flash", input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0,
					peaks: [
						{ start: 0, end: 8.5, days: "all", input: 1, output: 3, cacheRead: 0.03, cacheWrite: 0 },
						{ start: 9, end: 14, days: "workday", input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0 },
					],
				}],
				holidays: ["2026-10-01~2026-10-07"],
				fallback: { input: 2.16, output: 6.48, cacheRead: 0.43, cacheWrite: 4.32 },
				builtin: [{ match: "deepseek-v4-flash", input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0, peaks: [{ start: 9, end: 12, days: "workday" }, { start: 14, end: 18, days: "workday" }] }],
				models: ["deepseek-v4-flash", "glm-4"], sourcesByModel: { "deepseek-v4-flash": "自定义", "glm-4": "兜底" },
			};
		}
		if (url.includes("dsh-dock/animation/status")) data = resolveStatus(animationStatus);
		else if (url.includes("dsh-dock/notify/status")) data = resolveStatus(notifyStatus);
		else if (url.includes("dsh-dock/runstate/status")) data = resolveStatus(runstateStatus || RUNSTATE_STATUS);
		else if (url.includes("dsh-dock/tts/status")) data = resolveStatus(ttsStatus || TTS_STATUS);
		else if (url.includes("dsh-dock/features")) data = { persisted: persisted || {} };
		return Promise.resolve({
			ok: true,
			status: 200,
			json: async () => ({ ok: true, data }),
		});
	};
}
function makeWindow() {
	const mq = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
	return {
		__ModuleLoader__: { load: (def) => { loaded = def; } },
		matchMedia: mq,
		addEventListener() {}, removeEventListener() {},
		innerWidth: 1440, innerHeight: 900,
		devicePixelRatio: 1,
		location: { href: "http://127.0.0.1:3080/" },
		localStorage: null,
	};
}
// ---------- 语音合成桩：记录 speak 出去的内容，供【语音朗读】行为断言 ----------
// speak 不自动触发 onend（引擎停在「正在读第一片」态，暂停/继续/重读才可测）；
// 用例要推进分片时手动调 flush()。
function makeSpeechStub() {
	const spoken = [];
	const utterCtor = function (text) { this.text = text; this.onend = null; this.onerror = null; };
	const voices = [
		{ name: "Microsoft Xiaoxiao", lang: "zh-CN", voiceURI: "zh-CN-Xiaoxiao" },
		{ name: "Google US English", lang: "en-US", voiceURI: "en-US-Google" },
	];
	const synth = {
		getVoices: () => voices,
		pauseCount: 0, resumeCount: 0, cancelCount: 0,
		speak(utt) { spoken.push(utt); },
		cancel() { synth.cancelCount += 1; },
		pause() { synth.pauseCount += 1; },
		resume() { synth.resumeCount += 1; },
		paused: false, speaking: false, pending: false,
		// 手动结算前 n 条（触发 onend → 引擎推进下一片）
		flush(n) {
			const list = spoken.splice(0, n === undefined ? spoken.length : n);
			for (const u of list) { try { if (typeof u.onend === "function") u.onend(); } catch { /* 用例自己负责断言 */ } }
			return list;
		},
	};
	return { spoken, utterCtor, synth, voices };
}
let loaded = null;

function loadDock(enabled, animationStatus, notifyStatus, persisted, runstateStatus, opts, ttsStatus) {
	const runtime = createRuntime();
	const posts = [];
	const store = Object.assign({}, opts && opts.store ? opts.store : null);
	if (!("dsh-dock/features/v1" in store)) store["dsh-dock/features/v1"] = JSON.stringify(enabled);
	const win = makeWindow();
	// opts.body：提供最小 document 桩（body + head + createPortal 捕获），用于覆盖
	// 「单价子弹窗 portal 到 document.body」这一真实浏览器分支。默认 document 仍为 undefined
	// （DockModal 靠它保持展开，供其他用例渲染整棵弹层树）。
	// opts.document：完整 document 桩（覆盖 ensureCss 注入与 data-plugin 归属断言）。
	const portalNodes = [];
	let doc = undefined;
	if (opts && opts.document) {
		runtime.react.createPortal = (node, target) => { portalNodes.push({ node, target }); return null; };
		doc = opts.document;
	} else if (opts && opts.body) {
		runtime.react.createPortal = (node, target) => { portalNodes.push({ node, target }); return null; };
		doc = {
			body: opts.body,
			head: { appendChild() {} },
			querySelector() { return null; },
			createElement() { return { dataset: {}, isConnected: true }; },
			addEventListener() {}, removeEventListener() {},
		};
	}
	const sandbox = {
		console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
		setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
		// opts.fetch：替换默认桩，用于「宿主某路由未注册（405/404）」这类行为用例——
		// 需要断言「收到 405 之后不再发请求」，只查字符串钉不住这个语义。
		fetch: (opts && opts.fetch) || makeFetch(animationStatus, notifyStatus, posts, persisted, runstateStatus, ttsStatus),
		// 视图的 fetch 用 AbortSignal.timeout 设超时；沙箱补一个最小替身（stub 忽略 signal）
		AbortSignal: { timeout: () => ({}) },
		localStorage: {
			getItem: (k) => (k in store ? store[k] : null),
			setItem: (k, v) => { store[k] = String(v); },
			removeItem: (k) => { delete store[k]; },
		},
		window: win,
		document: doc,
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		cancelAnimationFrame: (id) => clearTimeout(id),
	};
	sandbox.globalThis = sandbox;
	win.localStorage = sandbox.localStorage;
	// opts.speech：装一个 speechSynthesis 桩（同时挂 globalThis 与 window，
	// 视图两条路径都会读；不装时视图按「本浏览器不支持」降级，正是默认沙箱形态）。
	if (opts && opts.speech) {
		sandbox.speechSynthesis = opts.speech.synth;
		sandbox.SpeechSynthesisUtterance = opts.speech.utterCtor;
		win.speechSynthesis = opts.speech.synth;
		win.SpeechSynthesisUtterance = opts.speech.utterCtor;
	}
	vm.createContext(sandbox);
	loaded = null;
	vm.runInContext(bundle, sandbox, { filename: "client.js" });
	if (!loaded) throw new Error("client.js 没有调用 window.__ModuleLoader__.load");

	const dock = loaded.factory((id) => {
		if (id === "react") return runtime.react;
		if (id === "react/jsx-runtime") return runtime.jsxRuntime;
		throw new Error("bundle 请求了未提供的模块：" + id);
	});
	const regs = [];
	const slots = {
		inject: (_name, fn) => fn(),
		register: (def, comp) => regs.push({ def, comp }),
	};
	dock.apply({ get: (name) => (name === "slots" ? slots : undefined), interval: () => () => {} });
	return { runtime, regs, dock, posts, portalNodes };
}

/** 多趟渲染：跑到状态稳定（最多 10 趟），覆盖「拉数据后」的渲染分支。 */
async function renderSettled(runtime, node) {
	let html = "";
	for (let pass = 0; pass < 10; pass++) {
		runtime.beginPass();
		html = runtime.render(node);
		runtime.runEffects();
		await new Promise((resolve) => setImmediate(resolve));
		if (!runtime.isDirty()) break;
		runtime.clearDirty();
	}
	return html;
}

const ANIMATION_STATUS = {
	active: [{
		sessionId: "s-1", title: "回归测试任务", phase: "think", provider: "deepseek",
		models: ["deepseek-chat"], elapsed: 65_000, turns: 3, steps: 9, toolCalls: 2,
		totalTokens: 12_345, inputTokens: 10_000, outputTokens: 2_345,
		approvals: [{ toolName: "bash", reason: "需要批准执行命令" }],
	}],
	recent: [{
		sessionId: "s-0", title: "上一个任务", phase: "write", provider: "deepseek",
		models: ["deepseek-chat"], duration: 30_000, turns: 2, steps: 4, endTime: 1_700_000_000_000,
		endReason: "completed", totalTokens: 4_000, inputTokens: 3_000, outputTokens: 1_000,
	}],
	config: { animationEnabled: true, effectMode: "robot", robotScale: 1.35 },
};

const NOTIFY_STATUS = {
	active: ANIMATION_STATUS.active,
	recent: ANIMATION_STATUS.recent,
	config: {
		notifyOnComplete: true, notifyOnError: true, notifyOnConfirm: true,
		notifyStayMs: 8000, systemNotify: false, soundNotify: true, soundEffect: "chime",
		dingtalkEnabled: true, dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=x",
		feishuEnabled: true, feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
	},
};

// 运行状态模块的 /status 没有 config 段（只读共享追踪快照）
const RUNSTATE_STATUS = {
	active: ANIMATION_STATUS.active,
	recent: ANIMATION_STATUS.recent,
};

// 语音朗读的 /status：追踪快照 + tts 配置段（宿主 readTtsConfig 下发）
const TTS_STATUS = {
	active: ANIMATION_STATUS.active,
	recent: ANIMATION_STATUS.recent,
	config: {
		autoPlay: false, autoPlayOnFinish: true, interruptOnNew: true,
		rate: 1, pitch: 1, volume: 1, voiceURI: "", lang: "",
		skipCode: true, skipTables: true, maxChars: 0, maxSentences: 0,
	},
};

// 模型设置 /dsh-dock/models：视图把 json() 结果直接当目录用（不包 ok/data），
// 与真实宿主 sendJson(res, 200, payload) 一致。给一个含 pi-ai 路由的目录，
// 覆盖 Provider 管理列表 + 新增表单 + 选中 Provider 编辑器三条渲染分支。
const MODELCONFIG_DIR = {
	generatedAt: 1_700_000_000_000,
	default: { provider: "modelscope", model: "Qwen/Qwen3.8-27B", reasoningEffort: "high" },
	revisions: { "llm-pi-ai": 1, "llm-deepseek": 0, "dsh-dock": 3 },
	visionProxy: { enabled: false, provider: "", model: "" },
	providers: [
		{
			id: "deepseek-official", kind: "deepseek", displayName: "DeepSeek", api: "deepseek",
			baseURL: "https://api.deepseek.com", apiKeyEnv: "DEEPSEEK_API_KEY",
			thinking: "enabled", defaultEffort: "high", effortLevels: ["off", "low", "high", "max"],
			models: [{ id: "deepseek-flash", name: "DeepSeek Flash", contextWindow: 64000, maxTokens: 8192, input: ["text"], efforts: "inherit", effortMap: null, tags: [], raw: { id: "deepseek-flash" } }],
		},
		{
			id: "modelscope", route: "modelscope", kind: "pi-ai", displayName: "魔搭 ModelScope",
			api: "openai-completions", baseURL: "https://api-inference.modelscope.cn/v1",
			apiKeyEnv: "MODELSCOPE_API_KEY", apiKeyConfigured: true,
			apis: ["openai-completions", "openai-responses", "anthropic-messages"],
			defaultInput: ["text", "image"],
			rawProfile: {
				displayName: "魔搭 ModelScope", api: "openai-completions",
				baseURL: "https://api-inference.modelscope.cn/v1", apiKeyEnv: "MODELSCOPE_API_KEY",
				defaultInput: ["text", "image"],
				models: [{ id: "Qwen/Qwen3.8-27B", name: "Qwen3.8 27B", reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" } }],
			},
			models: [{
				id: "Qwen/Qwen3.8-27B", name: "Qwen3.8 27B", contextWindow: 262144, maxTokens: 32768,
				input: ["text", "image"], efforts: "custom",
				effortMap: { off: null, low: "low", medium: "medium", high: "high" }, tags: ["video"],
				raw: { id: "Qwen/Qwen3.8-27B", reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" }, compat: { supportsDeveloperRole: false } },
			}],
		},
	],
};

// ---------- 用例：每个内置功能单独启用后，设置页面板必须渲染出内容且不抛错 ----------
const FEATURES = [
	{ id: "animation", name: "任务动画", marker: "运行动画", deep: true },
	{ id: "notify", name: "任务通知", marker: "通知事件", deep: true },
	{ id: "runstate", name: "运行状态", marker: "运行状态", deep: true },
	{ id: "tts", name: "语音朗读", marker: "朗读时机", deep: true },
	// tokenlog 的 marker 用「调用明细」而非「用量」：后者能在卡片描述里命中，
	// 会让「视图抛错降级为一行提示」也被判为渲染正常（曾实际发生，见下方 tokenlog 断言）。
	{ id: "tokenlog", name: "用量记录", marker: "调用明细", deep: true },
	{ id: "balance", name: "模型余额", marker: "余额", deep: true },
	{ id: "modelconfig", name: "模型设置", marker: "模型", deep: true },
	{ id: "providerconfig", name: "模型提供商", marker: "模型提供商", deep: true },
	{ id: "heartbeat", name: "心跳监视", marker: "心跳", deep: true },
	{ id: "theme", name: "主题信息", marker: "主题", deep: true },
	{ id: "games", name: "趣味游戏", marker: "游戏", deep: true },
	{ id: "mobile-relay", name: "远程访问", marker: "远程", deep: true },
	{ id: "mobile", name: "手机适配", marker: "手机模式", deep: true },
];

let failed = 0;
for (const f of FEATURES) {
	const enabled = {};
	for (const other of FEATURES) enabled[other.id] = other.id === f.id;
	let html = "";
	let error = null;
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		if (!reg) throw new Error("没有注册 settings.section（设置 → 功能坞）");
		const node = runtime.react.createElement(reg.comp, f.id === "tokenlog" ? { params: { openPricing: true } } : null);
		html = f.deep ? await renderSettled(runtime, node) : runtime.render(node);
	} catch (e) {
		error = e;
	}
	if (error) {
		failed++;
		console.log(`✗ ${f.name}（${f.id}）渲染抛错：${(error && error.message) || error}`);
	} else if (!html.includes(f.marker)) {
		failed++;
		console.log(`✗ ${f.name}（${f.id}）渲染成功但没有内容（找不到「${f.marker}」）`);
	} else {
		console.log(`✓ ${f.name}（${f.id}）渲染正常`);
	}
	// 用量记录：断言真实视图内容（而非仅命中卡片描述里的「用量」二字）。
	// 该用例带 params.openPricing 直接展开「单价设置」子弹窗，因此下面同时覆盖：
	// 明细表标题、单价入口、KPI 金额，以及子弹窗的分时段多段编辑区。
	if (f.id === "tokenlog" && !error) {
		for (const needle of [
			"调用明细", "单价设置", "¥3.60", "deepseek-v4-flash",
			"分时段价", "添加时段", "基准输入", "跨零点",
			"仅工作日", "法定节假日",
		]) {
			if (!html.includes(needle)) { failed++; console.log(`✗ 用量记录视图缺少「${needle}」（视图可能未真正渲染）`); }
		}
	}
	// 模型设置：只应出现模型目录编辑相关内容；Provider 的增删改入口已拆成独立功能【模型提供商】。
	// 这里断言主页真的渲染出模型编辑器与图片代理面板，且不再有「模型提供商」入口卡（防拆分回退）。
	if (f.id === "modelconfig" && !error) {
		for (const needle of ["图片理解代理", "保存写回官方配置", "刷新模型目录"]) {
			if (!html.includes(needle)) { failed++; console.log(`✗ 模型设置主页缺少「${needle}」（模型编辑器/图片代理面板未渲染）`); }
		}
		if (html.includes("个自定义路由")) { failed++; console.log("✗ 模型设置主页仍渲染「模型提供商」入口卡（应已拆成独立功能）"); }
	}
	// 模型提供商：独立的 Provider 管理页（行卡片 + 编辑/删除 + 新增入口）
	if (f.id === "providerconfig" && !error) {
		for (const needle of ["魔搭 ModelScope", "编辑", "删除", "＋ 新增 Provider"]) {
			if (!html.includes(needle)) { failed++; console.log(`✗ 模型提供商页缺少「${needle}」（Provider 列表/新增入口未渲染）`); }
		}
	}
}

// ---------- 用例 1.4：模型提供商「新增 Provider」表单（params.openProviderForm 直接展开）----------
// Provider 管理已是独立功能模块；openProviderForm 深链要直接展开新增表单。
// 用全新 runtime 避免与主页渲染共享组件实例状态。
{
	const enabled = {};
	for (const other of FEATURES) enabled[other.id] = other.id === "providerconfig";
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		if (!reg) detail = "没有注册 settings.section";
		else {
			const formHtml = await renderSettled(runtime, runtime.react.createElement(reg.comp, { params: { openProviderForm: true } }));
			// 沙箱只序列化文本节点（不含 input 的 placeholder 属性），故用表单特有的文本断言：
			// 页面标题 + api 下拉项（仅表单有）、默认输入类型标签（仅表单有）、模型行按钮、表单标题。
			for (const needle of ["模型提供商", "新增 Provider", "OpenAI Responses", "Anthropic Messages", "默认输入类型", "添加模型"]) {
				if (!formHtml.includes(needle)) { detail = "新增 Provider 表单缺少「" + needle + "」"; break; }
			}
		}
	} catch (e) {
		detail = "Provider 表单渲染抛错：" + ((e && e.message) || e);
	}
	if (detail) { failed++; console.log("✗ " + detail); }
	else console.log("✓ 模型提供商 Provider 表单：params.openProviderForm 直接展开「新增 Provider」表单（路由/api/baseURL/key/模型行）");
}

// ---------- 用例 1.4b：模型提供商页（独立功能，行卡片列表）----------
// Provider 管理从【模型设置】拆成独立功能模块后，本页自己就要渲染出整张列表：
// 标题/说明 + 行卡片（名称/路由/模型数/密钥状态 + 编辑/删除）+ 底部虚线新增。
{
	const enabled = {};
	for (const other of FEATURES) enabled[other.id] = other.id === "providerconfig";
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		if (!reg) detail = "没有注册 settings.section";
		else {
			const pageHtml = await renderSettled(runtime, runtime.react.createElement(reg.comp, null));
			for (const needle of ["模型提供商", "魔搭 ModelScope", "modelscope", "MODELSCOPE_API_KEY 已配置", "1 模型", "编辑", "删除", "＋ 新增 Provider"]) {
				if (!pageHtml.includes(needle)) { detail = "模型提供商页缺少「" + needle + "」"; break; }
			}
			// 模型设置页的内容（图片理解代理 / 模型目录编辑器）不该串进来——两个功能各自独立
			if (!detail && pageHtml.includes("图片理解代理")) detail = "模型提供商页串进了模型设置页内容（图片理解代理）";
		}
	} catch (e) {
		detail = "模型提供商页渲染抛错：" + ((e && e.message) || e);
	}
	if (detail) { failed++; console.log("✗ " + detail); }
	else console.log("✓ 模型提供商页：独立功能渲染行卡片列表（密钥状态/模型数/编辑/删除/新增）");
}

	if (failed) {
	console.log(`\n${failed} 个内置功能视图渲染失败——内置视图抛错会连带卸载整块面板 UI。`);
	process.exit(1);
}
console.log(`\n全部 ${FEATURES.length} 个内置功能视图渲染正常。`);

// ---------- 用例 1.5：用量记录「查询」必须有可见的加载动画 ----------
// 数据量大时点「查询」要等好几秒，旧版只有一行「加载中…」，用户不知道点上没点上、数据何时换掉。
// 断言分两部分：
//   a) 动画定义（CSS）只存在于构建产物文本里——渲染替身不产出 className，页面断言抓不到；
//   b) 渲染帧：loading 帧必须出现 banner /「查询中」，收敛后必须换成「✓ 数据已更新」且不残留加载态。
{
	let ok = true;
	for (const key of ["@keyframes dtok-hop", "@keyframes dtok-sweep", "@keyframes dtok-card-in", "@keyframes dtok-btn-sheen", ".dtok-dots i"]) {
		if (!bundle.includes(key)) { ok = false; failed++; console.log(` 查询加载动画缺少 CSS 定义「${key}」`); }
	}
	const enabled = {};
	for (const other of FEATURES) enabled[other.id] = other.id === "tokenlog";
	const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
	const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
	const node = runtime.react.createElement(reg.comp);
	// 装载帧：渲染 → 跑副作用（挂载即发起查询，loading 置真）→ 再渲染，此时数据还没回来
	runtime.beginPass();
	runtime.render(node);
	runtime.runEffects();
	const loadingHtml = runtime.render(node);
	for (const needle of ["加载中", "正在翻开账本", "正在按当前条件重新统计", "查询中"]) {
		if (!loadingHtml.includes(needle)) { ok = false; failed++; console.log(`✗ 查询加载中应出现「${needle}」（等待过程没有任何反馈）`); }
	}
	// 收敛帧：数据到位后加载态必须撤掉，并给出「数据已更新」反馈
	const settledHtml = await renderSettled(runtime, node);
	for (const needle of ["✓ 数据已更新", "调用明细"]) {
		if (!settledHtml.includes(needle)) { ok = false; failed++; console.log(`✗ 查询完成后应出现「${needle}」`); }
	}
	for (const needle of ["正在翻开账本", "查询中"]) {
		if (settledHtml.includes(needle)) { ok = false; failed++; console.log(` 查询完成后不该残留「${needle}」`); }
	}
	if (ok) console.log("✓ 查询加载动画：loading 帧有 banner /「查询中」，收敛后换成「✓ 数据已更新」");
}

// ---------- 用例 1.6：用量记录「图表统计」页签渲染不崩 ----------
// 图表区默认不渲染（默认页签是明细），一旦 ChartsPanel 抛错同样会被错误边界静默降级，
// 而 marker「调用明细」仍能命中 → 假绿。这里直接以 ChartsPanel 组件渲染（props.params.charts
// 让视图初始落在图表页签），断言四张图的标题都在。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tokenlog";
	const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
	const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
	const node = runtime.react.createElement(reg.comp, { params: { charts: true } });
	let html = "";
	let error = null;
	try { html = await renderSettled(runtime, node); } catch (e) { error = e; }
	if (error) {
		failed++; console.log(`✗ 图表统计页签渲染抛错：${(error && error.message) || error}`);
	} else {
		for (const needle of ["今日模型用量占比", "24 小时调用分布", "模型耗时排行", "分布统计", "deepseek-v4-flash"]) {
			if (!html.includes(needle)) { failed++; console.log(`✗ 图表统计页签缺少「${needle}」`); }
		}
		if (failed === 0 || !html.includes("渲染出错")) {
			if (!html.includes("渲染出错")) console.log("✓ 图表统计页签：四张图渲染正常（今日占比/24小时分布/耗时排行/分布统计）");
			else { failed++; console.log("✗ 图表统计页签被错误边界降级（视图里有「渲染出错」）"); }
		}
	}
}

// ---------- 用例 2：视图渲染抛错必须被错误边界隔离，不能打没整块面板 ----------
// 宿主把每个插槽条目换成空 div 是「界面整个没了」的直接机制，所以这条断言与上面同等重要。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = false;
	let detail = "";
	try {
		const { runtime, regs, dock } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
		dock.dockBridge.register({
			id: "boom", name: "会崩的功能",
			View: () => { throw new Error("boom-test"); },
		});
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		const html = runtime.render(runtime.react.createElement(reg.comp, null));
		if (!html.includes("渲染出错")) detail = "崩溃视图没有被隔离（页面里没有错误提示）";
		else if (!html.includes("会崩的功能")) detail = "崩溃视图把同一面板的其他内容也带没了";
	} catch (e) {
		detail = "崩溃视图把整块面板渲染带崩了：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 错误隔离：${detail}`);
		process.exit(1);
	}
	console.log("✓ 错误隔离：崩溃视图只降级为一行提示，面板其余内容照常渲染");
}

// ---------- 用例 3：内置视图抛错同样要被隔离（v0.9.3~0.9.8 正是内置视图抛错打没了面板） ----------
{
	// 拿【运行状态】当靶子：它渲染期会 active.reduce 统计等待确认项（与当年 animation 的
	// waitingCount 同一类写法），给 active 一个 reduce 就抛错的 Proxy 即可稳定复现。
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "runstate";
	const boomActive = new Proxy([], {
		get(target, key) {
			if (key === "reduce") throw new Error("boom-builtin");
			return Reflect.get(target, key);
		},
	});
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined,
			Object.assign({}, RUNSTATE_STATUS, { active: boomActive }));
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		const html = await renderSettled(runtime, runtime.react.createElement(reg.comp, null));
		if (!html.includes("渲染出错")) detail = "内置视图抛错没有被隔离（页面里没有错误提示）";
		else if (!html.includes("用量记录")) detail = "内置视图抛错把同一面板的其他内容也带没了";
	} catch (e) {
		detail = "内置视图抛错把整块面板渲染带崩了：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 内置视图错误隔离：${detail}`);
		process.exit(1);
	}
	console.log("✓ 内置视图错误隔离：内置视图抛错也只降级为一行提示");
}

// ---------- 用例 4：功能坞弹层左侧菜单必须列出「任务动画」「任务通知」「运行状态」三个独立菜单项 ----------
// 通知、运行状态先后从任务动画里拆成独立菜单项，这条断言防的就是「拆完菜单里看不到」。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS);
		const panel = regs.find((r) => r.def && r.def.name === "shell.overlay" && r.def.id === "dsh-dock-panel");
		if (!panel) throw new Error("没有注册功能坞弹层（shell.overlay / dsh-dock-panel）");
		const html = await renderSettled(runtime, runtime.react.createElement(panel.comp, null));
		for (const name of ["任务动画", "任务通知", "运行状态"]) {
			if (!html.includes(name)) { detail = "左侧菜单缺少「" + name + "」"; break; }
		}
		if (!detail) {
			// 各功能的全局浮层（任务动效 / 通知卡片栈）也必须能挂载渲染
			const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
			if (!overlays) detail = "没有注册功能全局浮层（shell.overlay / dsh-dock-feature-overlays）";
			else runtime.render(runtime.react.createElement(overlays.comp, null));
		}
	} catch (e) {
		detail = "弹层 / 浮层渲染抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 左侧菜单 / 全局浮层：${detail}`);
		process.exit(1);
	}
	console.log("✓ 左侧菜单：功能坞弹层含「任务动画」「任务通知」「运行状态」三个独立菜单项，全局浮层渲染正常");
}

// ---------- 用例 5：任务结束时【任务通知】浮层真的弹出通知卡片 ----------
// 通知逻辑全靠「轮询到新快照 → 上一轮活跃、本轮消失 → 弹卡片」，所以这里用函数式状态桩
// 让每次轮询返回新对象，并在两轮之间把任务从「活跃」挪到「最近完成」。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const live = {
		active: [Object.assign({}, NOTIFY_STATUS.active[0])],
		recent: [],
		config: NOTIFY_STATUS.config,
	};
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus);
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		await renderSettled(runtime, runtime.react.createElement(overlays.comp, null));
		// 任务结束：活跃清空、最近完成出现（同一 sessionId，通知侧才能取到完成记录补全信息）
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const html = await renderSettled(runtime, runtime.react.createElement(overlays.comp, null));
		if (!html.includes("任务完成")) detail = "任务结束没有弹出通知卡片（渲染结果里没有「任务完成」）";
		else if (!html.includes("任务：上一个任务")) detail = "通知卡片缺少任务详情（正文里没有任务标题）";
	} catch (e) {
		detail = "通知浮层渲染抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 任务通知浮层：${detail}`);
		process.exit(1);
	}
	console.log("✓ 任务通知浮层：任务结束时弹出通知卡片（轮询 → 检测 → 卡片）");
}

// ---------- 用例 5b：需确认卡挂到审批处理完才收，前台多久都不自毁 ----------
// 两代真实问题：①（用户截图）一个任务连弹 4 张需确认卡，只能挨个点 ✕——修法是
// 卡片与审批项绑定（approvalKeys = sessionId|approvalId），approval/decided 后
// 浮层对账到「绑定的审批项都不在了」就把卡片标记 closing 淡出；②（用户实测漏
// 提醒）曾经的「前台看过 8 秒也收」（lingerMs）会在审批还挂着等人批的时候先把
// 提醒弄丢——已彻底移除计时器。本用例先在前台放 9 秒（>旧 8 秒 linger）断言卡片
// 仍在，再把 approvals 换空断言对账收起。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const live = {
		active: [Object.assign({}, NOTIFY_STATUS.active[0], {
			approvals: [{ id: "ap-1", toolName: "pwsh", reason: "需要提权执行命令" }],
		})],
		recent: [],
		config: NOTIFY_STATUS.config,
	};
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus);
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		const before = await renderSettled(runtime, node);
		if (!before.includes("任务需要确认")) throw new Error("审批等待时没有弹出需确认卡（前置条件不成立）");
		// 前台放 9 秒（旧 linger 是 8 秒自毁）：审批没处理完，卡片必须还挂着
		await new Promise((resolve) => setTimeout(resolve, 9200));
		const still = await renderSettled(runtime, node);
		if (!still.includes("任务需要确认")) detail = "审批还挂着时前台放满 9 秒，需确认卡自己消失了（计时器没删干净）";
		if (!detail && /lingerMs/.test(bundle)) detail = "产物里仍有 lingerMs（前台看过计时未移除，会提前弄丢待审批提醒）";
		// 用户确认/拒绝 → 宿主把审批项移出 approvals（任务本身还在跑）
		live.active = [Object.assign({}, live.active[0], { approvals: [] })];
		await new Promise((resolve) => setTimeout(resolve, 1000)); // 等下一轮轮询（任务中 850ms）
		let html = await renderSettled(runtime, node);
		// 收起是 240ms 的淡出：多等几拍，断言最终真的从 DOM 里消失
		for (let i = 0; i < 4 && html.includes("任务需要确认"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			html = await renderSettled(runtime, node);
		}
		if (!detail && html.includes("任务需要确认")) detail = "审批已处理，需确认卡没有自动收起（仍渲染在页面上）";
	} catch (e) {
		detail = "需确认卡自动收起用例抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 需确认卡挂到处理完：${detail}`);
		process.exit(1);
	}
	console.log("✓ 需确认卡挂到处理完：前台 9 秒不自毁（无计时器），审批处理完对账自动淡出");
}

// ---------- 用例 5c：完成卡没人看过就不会消失（后台弹的、前台弹的都常驻）----------
// 真实问题（用户实测）：任务在后台跑完，切回页面时右上角什么都没有。根因（历史）：
// 完成卡带 stayMs 倒计时，从弹卡那一刻就开始走，后台标签页里浏览器把轮询节流，
// 卡片在没人看的地方默默走完时间消失——通知等于丢了。修法（最终形态）：结束卡
// **没有任何自动消失**——没点开看过就一直挂着，多了靠叠放收纳。本用例 hidden
// 弹卡等 3 秒断言仍在；切回 visible 再等 3 秒仍断言在（旧实现这里早已超时消失）。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const live = {
		active: [Object.assign({}, NOTIFY_STATUS.active[0])],
		recent: [],
		config: NOTIFY_STATUS.config,
	};
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	const listeners = {};
	const doc = {
		visibilityState: "hidden",
		body: { tag: "body-stub" },
		head: { appendChild() {} },
		querySelector() { return null; },
		createElement() { return { dataset: {}, isConnected: true }; },
		addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
		removeEventListener(type, fn) {
			const arr = listeners[type] || [];
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
	};
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus, undefined, undefined, { document: doc });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		await renderSettled(runtime, node);
		// 任务在后台结束：活跃清空、最近完成出现
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await new Promise((resolve) => setTimeout(resolve, 1000)); // 等一轮轮询（任务中 850ms）
		let html = await renderSettled(runtime, node);
		if (!html.includes("任务完成")) throw new Error("后台任务结束没有弹出完成卡（前置条件不成立）");
		// 后台等超过旧 stayMs（8s 的节流轮询场景按 3s 计），卡片必须还在
		await new Promise((resolve) => setTimeout(resolve, 3000));
		html = await renderSettled(runtime, node);
		if (!html.includes("任务完成")) detail = "页面在后台时完成卡自己消失了（用户切回来什么都看不到）";
		else {
			// 切回前台：没看过，仍然挂着（旧实现在这里重新计满 stayMs 后收起——已废弃）
			doc.visibilityState = "visible";
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setTimeout(resolve, 3000));
			html = await renderSettled(runtime, node);
			if (!html.includes("任务完成")) detail = "切回前台后完成卡超时消失（应常驻到看过）";
		}
	} catch (e) {
		detail = "完成卡常驻用例抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 完成卡常驻不白丢：${detail}`);
		process.exit(1);
	}
	console.log("✓ 完成卡常驻不白丢：后台、前台都没看过就一直挂着，不超时自毁");
}

// ---------- 用例 5d：点进完成的会话，完成卡跟着自动收起 ----------
// 用户诉求：完成卡该弹还得弹（前台完成也要有通知），但点进那个会话看过结果后，
// 卡片就该自己消失，不用手动点 ✕。判定与【任务动画】同款：侧栏高亮行
// （role=treeitem + aria-selected）标题与卡片 sessionTitle 对上即收起。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const live = {
		active: [Object.assign({}, NOTIFY_STATUS.active[0])],
		recent: [],
		config: NOTIFY_STATUS.config,
	};
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	// 侧栏选中态可变桩：selectedTitle 非空即模拟"用户点进了该会话"
	let selectedTitle = "";
	const doc = {
		visibilityState: "visible",
		body: { tag: "body-stub" },
		head: { appendChild() {} },
		querySelector() { return null; },
		querySelectorAll(sel) {
			if (sel === '[role="treeitem"][aria-selected="true"]' && selectedTitle) {
				return [{ textContent: selectedTitle, getBoundingClientRect: () => ({ width: 200, height: 32, top: 100, bottom: 132, right: 200, left: 8 }) }];
			}
			return [];
		},
		createElement() { return { dataset: {}, isConnected: true }; },
		addEventListener() {}, removeEventListener() {},
	};
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus, undefined, undefined, { document: doc });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		await renderSettled(runtime, node);
		// 前台任务结束 → 弹完成卡
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await new Promise((resolve) => setTimeout(resolve, 1000)); // 等一轮轮询
		let html = await renderSettled(runtime, node);
		if (!html.includes("任务完成")) throw new Error("前台任务结束没有弹出完成卡（前置条件不成立）");
		// 用户点进那个会话（recent[0].title =「上一个任务」）→ 巡检（500ms）应收起卡片
		selectedTitle = NOTIFY_STATUS.recent[0].title;
		await new Promise((resolve) => setTimeout(resolve, 700));
		html = await renderSettled(runtime, node);
		await new Promise((resolve) => setTimeout(resolve, 300)); // 240ms 淡出
		html = await renderSettled(runtime, node);
		if (html.includes("任务完成")) detail = "点进完成的会话后完成卡仍在（未随会话选中自动收起）";
	} catch (e) {
		detail = "点进会话收起完成卡用例抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 点进会话收起完成卡：${detail}`);
		process.exit(1);
	}
	console.log("✓ 点进会话收起完成卡：侧栏选中该会话即视为看到结果，完成卡自动淡出");
}

// ---------- 用例 5e：点通知卡片跳转到对应会话并收起 ----------
// 用户诉求：点卡片直达对应会话。结束卡跳转成功就地淡出；找不到可见会话行
// （抽屉收起/手机端）不跳转也不收起。侧栏行桩：role=treeitem、标题对上、内含可点 button。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const live = {
		// approvals 置空：本用例只测结束卡，别把共享 fixture 里的需确认项也弹出来抢句柄
		active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })],
		recent: [],
		config: NOTIFY_STATUS.config,
	};
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	let clicked = 0;
	let rowsVisible = true;
	const doc = {
		visibilityState: "visible",
		body: { tag: "body-stub" },
		head: { appendChild() {} },
		querySelector() { return null; },
		querySelectorAll(sel) {
			if (sel === '[role="treeitem"]' && rowsVisible) {
				return [{
					textContent: NOTIFY_STATUS.recent[0].title,
					getBoundingClientRect: () => ({ width: 200, height: 32, top: 100, bottom: 132, right: 200, left: 8 }),
					querySelector: () => ({ click: () => { clicked += 1; } }),
				}];
			}
			return [];
		},
		createElement() { return { dataset: {}, isConnected: true }; },
		addEventListener() {}, removeEventListener() {},
	};
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus, undefined, undefined, { document: doc });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		await renderSettled(runtime, node);
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await new Promise((resolve) => setTimeout(resolve, 1000)); // 等一轮轮询弹卡
		let html = await renderSettled(runtime, node);
		if (!html.includes("任务完成")) throw new Error("任务结束没有弹出完成卡（前置条件不成立）");
		// 行不可见时点卡片：不跳转也不收起（选择器精确到卡片本体，别吃进 ✕ 按钮）
		rowsVisible = false;
		const isCard = (el) => el.event === "onClick" && /(^|\s)dknt-toast(\s|$)/.test(el.className) && !el.className.includes("close");
		const card = runtime.elements.find(isCard);
		if (!card) throw new Error("完成卡没有挂 onClick 跳转句柄（不是可点击卡片）");
		card.handler({});
		await new Promise((resolve) => setTimeout(resolve, 400));
		html = await renderSettled(runtime, node);
		if (clicked !== 0) detail = "会话行不可见时仍触发了点击";
		else if (!html.includes("任务完成")) detail = "跳转失败时完成卡被误收起（没看到结果不该消失）";
		else {
			// 行可见时点卡片：跳转一次 + 卡片淡出收起
			rowsVisible = true;
			const card2 = runtime.elements.find(isCard);
			card2.handler({});
			if (clicked !== 1) detail = "点卡片没有调用会话行的 click（未跳转，clicked=" + clicked + "）";
			await new Promise((resolve) => setTimeout(resolve, 600)); // 240ms 淡出 + 余量
			html = await renderSettled(runtime, node);
			await new Promise((resolve) => setTimeout(resolve, 300)); // 淡出定时器在渲染趟内才排上，再等一拍
			html = await renderSettled(runtime, node);
			if (!detail && html.includes("任务完成")) detail = "跳转成功后完成卡没有收起";
		}
	} catch (e) {
		detail = "点卡片跳转会话用例抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 点卡片跳转会话：${detail}`);
		process.exit(1);
	}
	console.log("✓ 点卡片跳转会话：结束卡可点击直达会话，跳转成功即收起；行不可见时不跳不收");
}

// ---------- 用例 5f：卡片多了叠放收纳（≥3 张收成标题条，悬停展开）----------
// 用户诉求：通知卡片过多时叠放、只露标题，鼠标放上去展开。实现：NotifyOverlay 在
// toasts.length ≥ 3 且未悬停卡片栈时给栈加 .stacked、给除最新外的卡片加
// .collapsed（只渲染标题条、不渲染正文）；悬停 onMouseEnter 整体展开。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	// 三个不同会话先后结束 → 三张完成卡
	const sessions = [
		{ sessionId: "s-a", title: "会话甲的任务" },
		{ sessionId: "s-b", title: "会话乙的任务" },
		{ sessionId: "s-c", title: "会话丙的任务" },
	];
	const live = { active: [], recent: [], config: NOTIFY_STATUS.config };
	for (const s of sessions) {
		// approvals 置空：本用例只看结束卡的叠放，别让共享 fixture 的需确认项混进来
		live.active.push(Object.assign({}, NOTIFY_STATUS.active[0], { sessionId: s.sessionId, title: s.title, approvals: [] }));
	}
	const notifyStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	const doc = {
		visibilityState: "visible",
		body: { tag: "body-stub" },
		head: { appendChild() {} },
		querySelector() { return null; },
		querySelectorAll() { return []; },
		createElement() { return { dataset: {}, isConnected: true }; },
		addEventListener() {}, removeEventListener() {},
	};
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, notifyStatus, undefined, undefined, { document: doc });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		await renderSettled(runtime, node);
		// 三个会话依次结束（active 清空、recent 补三条同 id 记录）
		live.recent = sessions.map((s) => Object.assign({}, NOTIFY_STATUS.recent[0], s));
		live.active = [];
		await new Promise((resolve) => setTimeout(resolve, 1000)); // 一轮轮询全部判结束
		let html = await renderSettled(runtime, node);
		if (!html.includes("class=\"dknt-toasts stacked\"")) detail = "三张卡片没有进入叠放态（栈缺 .stacked 类）";
		else {
			const collapsedCount = (html.match(/dknt-toast[^"]*\scollapsed/g) || []).length;
			const bodyCount = (html.match(/dknt-toast-body/g) || []).length;
			// 叠放态：3 张里最新一张完整展开（1 个正文），其余 2 张只剩标题条
			if (collapsedCount !== 2) detail = "叠放时应只展开最新一张（期望 2 张 .collapsed，实际 " + collapsedCount + "）";
			else if (bodyCount !== 1) detail = "叠放态正文数不对（期望 1，实际 " + bodyCount + "；收起态不应渲染正文）";
			else {
				// 悬停卡片栈 → 整体展开
				const stackEl = runtime.elements.find((el) => el.className.includes("dknt-toasts") && el.event === "onMouseEnter");
				if (!stackEl) throw new Error("卡片栈没有 onMouseEnter 展开句柄");
				stackEl.handler({});
				html = await renderSettled(runtime, node);
				if (html.includes("class=\"dknt-toasts stacked\"")) detail = "悬停卡片栈后没有展开（仍带 .stacked）";
				else if ((html.match(/dknt-toast-body/g) || []).length !== 3) detail = "展开后没有恢复全部正文（期望 3）";
			}
		}
	} catch (e) {
		detail = "卡片叠放用例抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 卡片叠放收纳：${detail}`);
		process.exit(1);
	}
	console.log("✓ 卡片叠放收纳：≥3 张只展开最新、其余收成标题条，悬停卡片栈整体展开");
}

// ---------- 用例 6：开关补推（浏览器已表态、宿主从未收到过该功能） ----------
// 真实事故：点【任务通知】开关时宿主还是旧进程 → POST 404 → 开关只留在浏览器
// 本地；宿主重启后 persisted 里没有 notify → 宿主从不 setup → 路由整片 404，面板还误报
// 「宿主进程是旧版本」。修法：启动时若宿主没记录过该功能，就补推一次本浏览器的选择。
{
	const cases = [
		{ name: "宿主没记录过 notify → 补推 true", local: { notify: true }, persisted: { animation: true }, expect: { id: "notify", enabled: true } },
		{ name: "宿主显式记过 notify=false → 不覆盖", local: { notify: true }, persisted: { notify: false }, expect: null },
		{ name: "本地关着、宿主也没记录 → 补推 false", local: { notify: false }, persisted: {}, expect: { id: "notify", enabled: false } },
	];
	let detail = "";
	for (const c of cases) {
		try {
			const { posts } = loadDock(c.local, ANIMATION_STATUS, NOTIFY_STATUS, c.persisted);
			await new Promise((resolve) => setTimeout(resolve, 30)); // 等 syncFeatureStateFromHost 的 fetch 回来
			const pushes = posts.filter((p) => p.url.includes("dsh-dock/features")).map((p) => p.body);
			const got = pushes.find((b) => b.id === "notify") || null;
			if (c.expect === null && got) { detail = `${c.name}：不该补推，却推了 ${JSON.stringify(got)}`; break; }
			if (c.expect && (!got || got.enabled !== c.expect.enabled)) {
				detail = `${c.name}：期望 ${JSON.stringify(c.expect)}，实际 ${JSON.stringify(got)}`;
				break;
			}
		} catch (e) {
			detail = `${c.name} 抛错：${(e && e.message) || e}`;
			break;
		}
	}
	if (detail) {
		console.log(`✗ 开关补推：${detail}`);
		process.exit(1);
	}
	console.log("✓ 开关补推：宿主没记录过的功能按本浏览器选择补推一次，宿主已显式关掉的不覆盖");
}

// ---------- 用例 7：双半部功能 id 一致（视图描述符 id === 宿主 feature id） ----------
// 真实事故：模型设置的宿主 id 叫 "models"、客户端视图 id 叫 "modelconfig"——面板开关
// 按 id POST /dsh-dock/features 被宿主当「未知功能」404（客户端静默吞掉），宿主半部
// 永远不 setup，目录接口整片 404；v0.9.5 默认全关后暴露成「模型设置不行了」。
// 其余模块三方一致（目录名 = 视图 id = 宿主 id），这里把该约定锁死，防再次劈叉。
{
	const { readdirSync } = await import("node:fs");
	let detail = "";
	let checked = 0;
	for (const dir of readdirSync(join(root, "features"), { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const hostPath = join(root, "features", dir.name, "host.js");
		const viewPath = ["view.js", "view.jsx"].map((f) => join(root, "features", dir.name, f)).find((p) => existsSync(p));
		if (!existsSync(hostPath) || !viewPath) continue; // 单半部模块（纯客户端/纯宿主）不约束
		checked++;
		try {
			const { feature } = await import(`file://${hostPath.replace(/\\/g, "/")}`);
			const m = readFileSync(viewPath, "utf8").match(/export\s+const\s+feature\s*=\s*\{\s*id:\s*["']([^"']+)["']/);
			if (!m) { detail = `${dir.name}/view 视图描述符里找不到 id 声明（正则失配，请同步更新本用例）`; break; }
			if (feature.id !== m[1]) { detail = `${dir.name}：宿主 id="${feature.id}" ≠ 视图 id="${m[1]}"（面板开关会推不到宿主）`; break; }
		} catch (e) {
			detail = `${dir.name} 双半部 id 校验抛错：${(e && e.message) || e}`;
			break;
		}
	}
	if (detail) {
		console.log(`✗ 双半部功能 id 一致：${detail}`);
		process.exit(1);
	}
	console.log(`✓ 双半部功能 id 一致：${checked} 个双半部模块的视图 id 与宿主 id 全部相同`);
}

// ---------- 用例 8：单价子弹窗必须 portal 到 document.body ----------
// 为什么必须 portal：功能坞弹层的祖先带 backdrop-filter，会改变 position:fixed 的包含块，
// 子弹窗会从「覆盖整屏」退化成「贴着弹层内定位」；设置页的祖先更不可控。所以子弹窗一律
// 挂到 body。这里用带 document 桩的沙箱验证「确实调用了 createPortal 且目标是不在面板树内的节点」。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const bodyStub = { tag: "body-stub" };
	let detail = "";
	try {
		const { runtime, regs, portalNodes } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { body: bodyStub });
		const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		if (!reg) throw new Error("没有注册 settings.section");
		// 带 openPricing 直接展开子弹窗（省去模拟点击）
		await renderSettled(runtime, runtime.react.createElement(reg.comp, { params: { openPricing: true } }));
		if (portalNodes.length === 0) detail = "没有调用 createPortal（子弹窗未 portal 到 body）";
		else if (portalNodes[0].target !== bodyStub) detail = "createPortal 的目标不是 document.body";
		else {
			// portal 出去的节点应含子弹窗结构（用替身渲染它校验内容）
			const html = runtime.render(portalNodes[0].node);
			if (!html.includes("单价设置")) detail = "portal 的节点里没有单价设置内容";
		}
	} catch (e) {
		detail = "子弹窗 portal 渲染抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 单价子弹窗 portal：${detail}`);
		process.exit(1);
	}
	console.log("✓ 单价子弹窗 portal：createPortal 到 document.body（不受面板 transform/backdrop-filter 影响）");
}

// ---------- 用例 9：样式标签必须带 data-plugin 归属 ----------
// 官方 claimStyles 只认 style[data-plugin]；无主标签会被任意后 materialize 的插件
// claim 走，对方卸载 removeOwnedStyles 时连带删掉——表现为「开合别的插件后功能坞样式坏了」。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = true;
	const styles = [];
	let detail = "";
	try {
		const bodyStub = { tag: "body-stub" };
		const head = {
			appendChild(el) { styles.push(el); },
		};
		const doc = {
			body: bodyStub,
			head,
			querySelector(sel) {
				// 仅支持 ensureCss 用的 data-plugin-css 选择器
				const m = /data-plugin-css="([^"]+)"/.exec(String(sel));
				if (!m) return null;
				return styles.find((el) => el.dataset && el.dataset.pluginCss === m[1]) || null;
			},
			createElement() {
				return {
					dataset: {},
					isConnected: true,
					textContent: "",
					setAttribute(k, v) {
						if (k === "data-plugin") this.dataset.plugin = v;
						if (k === "data-plugin-css") this.dataset.pluginCss = v;
					},
					getAttribute(k) {
						if (k === "data-plugin") return this.dataset.plugin || null;
						if (k === "data-plugin-css") return this.dataset.pluginCss || null;
						return null;
					},
				};
			},
			addEventListener() {},
			removeEventListener() {},
		};
		const { dock } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { body: bodyStub, document: doc });
		if (!dock || typeof dock.apply !== "function") detail = "apply 不可用";
		else if (styles.length === 0) detail = "apply 后 head 上没有注入任何 <style>";
		else {
			const tag = styles[styles.length - 1];
			if (!tag.dataset || tag.dataset.plugin !== "dsh-dock") {
				detail = `style 缺 data-plugin=dsh-dock（实际=${tag.dataset && tag.dataset.plugin}）`;
			} else if (tag.dataset.pluginCss !== "dsh-dock") {
				detail = `style 缺 data-plugin-css=dsh-dock（实际=${tag.dataset.pluginCss}）`;
			} else if (!String(tag.textContent || "").includes("dockm-backdrop")) {
				detail = "样式内容缺少外壳 CSS（dockm-backdrop）";
			}
		}
	} catch (e) {
		detail = "样式归属断言抛错：" + ((e && e.message) || e);
	}
	if (detail) {
		console.log(`✗ 样式 data-plugin 归属：${detail}`);
		process.exit(1);
	}
	console.log("✓ 样式 data-plugin 归属：style 带 data-plugin=dsh-dock，不被其它插件 claim 后误删");
}

// ---------- 用例 10：手机端滚动体/贴底/无浮动把手的样式契约 ----------
// 真实事故（用户实测）：远程访问手机端「会话记录不能上下滑动看」。根因是为让欢迎页
// 输入卡贴底，给会话滚动体加了 justify-content:flex-end——内容于是从滚动体起点溢出，
// 而 Chrome 不把起点方向的溢出算进 scrollHeight（无头 Chrome 390×844 实测
// scrollHeight==clientHeight、maxScroll==0），整段会话定格在视口外，首条消息永远看不到。
// 贴底只能用输入区自己的 margin-top:auto（有剩余空间才生效，不制造起点溢出）。
// 同时锁死：窄屏收起输入区 chip（否则被 28cqw 上限挤成「余..」）；左缘浮动「抽屉把手」
// 必须保持移除（用户实测：与抽屉入口功能重复，还悬浮在内容上）；底部 Tab 栏必须移除
// （用户要求：三个常驻入口太占页面空间，会话入口改为左上角汉堡菜单）。
// 宿主半部同款契约在 scripts/test-mobile-host.mjs 里，两半部必须一起改。
{
	const issues = [];
	if (/\[class\*="scrollBody"\][^{}]*\{[^}]*justify-content:\s*(?:flex-end|center)/.test(bundle)) issues.push("滚动体被设置成 flex-end/center（会让会话记录滚不动）");
	if (!/\[class\*="scrollBody"\]\[data-conversation-scroll\]\{justify-content:flex-start !important/.test(bundle)) issues.push("会话滚动体没有显式复位成 flex-start（压不过宿主旧注入，手机刷新后仍滚不动）");
	if (!/\[class\*="scrollBody"\]>\[class\*="composerSeat"\]\{margin-top:auto/.test(bundle)) issues.push("输入区贴底没有走 margin-top:auto");
	if (!/\.dockchip-row\{display:none\}/.test(bundle)) issues.push("窄屏没有收起输入区 chip");
	if (/dsh-mobile-drawer-btn/.test(bundle)) issues.push("客户端不应再有左缘浮动抽屉把手（会话入口在左上角汉堡菜单）");
	if (/dsh-dock-drawer-top|dsh-dock-drawer-off/.test(bundle)) issues.push("残留了把手定位的 CSS 变量/隐藏开关");
	if (!/\[class\*="sidebarCol"\]:has\(\[class\*="collapsed"\]\):not\(:has\(\[role="dialog"\]\)\) \[class\*="root"\]\[class\*="collapsed"\]\{display:none !important\}/.test(bundle)) issues.push("收起轨道没有 display:none 主隐藏（dsh 0.2.0 的 WorkspaceBrowser 自带 visibility:visible，会从列级 hidden 里透出游离按钮）");
	if (issues.length) {
		console.log(`✗ 手机端样式契约：${issues.join("；")}`);
		process.exit(1);
	}
	console.log("✓ 手机端样式契约：滚动体不设 justify-content、贴底走 margin-top:auto、chip 窄屏收起、无浮动抽屉把手");
}

// ---------- 用例 11：手机端左上角汉堡菜单与软键盘适配（替代原底部 Tab 栏契约） ----------
// 用户要求：底部三个常驻入口（会话/插件/设置）太占页面空间，全部去掉，改为左上角
// 「三条横线」折叠菜单，点击展开左侧会话抽屉。插件/设置/运行状态等入口本来就在抽屉里
// （原生侧栏 rail），展开抽屉即可达，不在 chrome 里重复提供。
// 本用例钉住：汉堡存在且语义正确、底部 Tab 栏与角标彻底移除、残留 Tab 兜底摘除、
// 软键盘让位、以及「点会话才收抽屉」的点击路由。
{
	const issues = [];
	// 底部 Tab 栏/角标彻底移除（唯一允许出现的 .dsh-mobile-tabbar 是「兜底摘除残留」那一句）。
	const withoutCleanup = bundle.replace(/querySelectorAll\("\.dsh-mobile-tabbar"\)/g, "");
	if (/dsh-mobile-tabbar/.test(withoutCleanup)) issues.push("仍残留底部 Tab 栏代码/样式（用户要求移除）");
	if (/dsh-mobile-tab-badge/.test(withoutCleanup)) issues.push("残留页签角标元素/样式（随 Tab 栏一并移除）");
	if (/id: "dock",\s*label: "(插件|\\u63D2\\u4EF6)"/.test(bundle)) issues.push("残留「插件」页签定义");
	if (/id: "settings",\s*label: "(设置|\\u8BBE\\u7F6E)"/.test(bundle)) issues.push("残留「设置」页签定义");
	if (!/querySelectorAll\("\.dsh-mobile-tabbar"\)/.test(bundle)) issues.push("Overlay 没有兜底摘除残留旧 Tab 栏（宿主旧注入会在页面里留一份）");
	// 左上角汉堡菜单：存在、够大、贴左上安全区、三条横线、能展开抽屉。
	if (!/\.dsh-mobile-burger\{/.test(bundle)) issues.push("缺少左上角汉堡菜单样式");
	// ⚠️ 产物里中文会被转义成 \\uXXXX，且 className 是赋值而非 createElement 属性。
	if (!/className = "dsh-mobile-burger"/.test(bundle)) issues.push("缺少汉堡按钮元素创建");
	if (!/M4 7h16"\/><path d="M4 12h16"\/><path d="M4 17h16"/.test(bundle)) issues.push("汉堡图标不是三条横线");
	if (!/\.dsh-mobile-burger\{[^}]*width:44px;height:44px/.test(bundle)) issues.push("汉堡按钮触控面积不足 44×44");
	if (!/\.dsh-mobile-burger\{[^}]*left:env\(safe-area-inset-left,0px\)/.test(bundle)) issues.push("汉堡没有避让左侧安全区");
	if (!/\.dsh-mobile-burger\{[^}]*top:env\(safe-area-inset-top,0px\)/.test(bundle)) issues.push("汉堡没有避让顶部安全区（刘海）");
	// ⚠️ 视觉契约：页面左上角本来是空的，原生同类控件（右上侧栏开关）是**裸图标**
	// （transparent 底 / border:0 / 无阴影）。汉堡不得做成白底圆角卡片 + 阴影 + 模糊，
	// 否则在白底页面上像一块贴上去的异物（用户实测反馈「没有贴合边缘，很突兀」）。
	if (!/\.dsh-mobile-burger\{[^}]*background:transparent/.test(bundle)) issues.push("汉堡有底色卡片（应贴合原生裸图标，不悬浮）");
	if (!/\.dsh-mobile-burger\{[^}]*border:0/.test(bundle)) issues.push("汉堡有边框");
	if (/\.dsh-mobile-burger\{[^}]*box-shadow/.test(bundle)) issues.push("汉堡有投影（会显得像悬浮异物）");
	if (/\.dsh-mobile-burger\{[^}]*backdrop-filter/.test(bundle)) issues.push("汉堡有毛玻璃底");
	if (!/aria-label", "\\u6253\\u5F00\\u4F1A\\u8BDD\\u5217\\u8868"/.test(bundle) && !/aria-label", "打开会话列表"/.test(bundle)) issues.push("汉堡没有无障碍标签");
	if (!/aria-expanded/.test(bundle)) issues.push("汉堡没有维护展开态语义");
	// 给标题让出汉堡宽度（用户实测：标题首字叠在三条横线上）。
	// 汉堡 fixed 定位、不占布局，原生标题从头部 padding-left:20px 起排 → 真实实例 390×844
	// 逐字实测重叠 16px（会话标题首字 x=28 vs 汉堡右缘 44）；插件页/自动化任务页页头
	// （padding-left:0、靠外层容器给 24px）首字 x=24 → 重叠 20px。
	// 契约：会话页头补到 44px（= 汉堡宽度）；两条原生页头各补 28px（首字落 x=52、留 8px），
	// 并把 gap 从 16px 收到 4px 补回被内边距吃掉的内容宽度（否则「添加插件」按钮会换行）。
	if (!/body\[data-dk-mobile="1"\] header:has\(\[class\*="titleRow"\]\)\{padding-left:calc\(44px \+ env\(safe-area-inset-left,0px\)\)\}/.test(bundle)) issues.push("会话页头没有给汉堡让出宽度（标题会被压住）");
	if (!/body\[data-dk-mobile="1"\] \[class\$="_pageHead"\],body\[data-dk-mobile="1"\] \[class\$="_pageHeading"\]\{padding-left:calc\(28px \+ env\(safe-area-inset-left,0px\)\);gap:4px\}/.test(bundle)) issues.push("插件页/任务页页头没有给汉堡让出宽度（标题会被压住）");
	if (!/\\u6253\\u5F00\\u4FA7\\u8FB9\\u680F/.test(bundle) && !/打开侧边栏/.test(bundle)) issues.push("汉堡没有转发原生「打开侧边栏」（点它展不开抽屉）");
	// 待确认任务角标：底部 Tab 栏移除前挂在「插件」页签上，现在必须挂在汉堡右上角，
	// 保留「手机上一眼看到有任务卡住等人确认」的能力。钉住：元素 + 轮询 runstate +
	// 等待确认=红点脉冲 / 进行中=蓝色数字 + 路由不存在时静默停。
	if (!/dsh-mobile-burger-badge/.test(bundle)) issues.push("汉堡没有待确认任务角标（底部 Tab 栏移除后该提醒丢失了）");
	if (!/dsh-dock\/runstate\/status/.test(bundle)) issues.push("汉堡角标没有轮询 runstate 路由");
	if (!/dsh-mobile-burger-badge\.wait/.test(bundle)) issues.push("角标缺少「等待确认」红色脉冲态");
	if (!/badge\.hidden\s*=\s*true/.test(bundle)) issues.push("角标没有在无任务时隐藏");
	if (!/runstateGone/.test(bundle)) issues.push("runstate 路由不存在时没有静默停轮询（会一直 405）");
	// 轮询前必须先看功能开关：【运行状态】停用时宿主不注册路由，无条件轮询会先打一次 405。
	if (!/stateOf\("runstate"\)\.enabled/.test(bundle)) issues.push("角标轮询没有先看【运行状态】功能开关（停用时会打一次无谓的 405）");
	if (!/__dshDockRunstate/.test(bundle)) issues.push("角标轮询没有看宿主侧 __dshDockRunstate 旗标（客户端开着、宿主没注册的情况仍会 405）");
	// 底部留白只留安全区（用户要求：少留一点，多给会话区显示内容）。
	// Tab 栏移除后，滚动体 24px + 输入区 6px 都是纯浪费（真实实例 390×844 像素扫描：
	// 卡片下方空白带 51px → 收掉这 30px 后 21px，剩下的是 dsh 自带的卡片下边距）。
	if (/padding-bottom:calc\(\d+px \+ env\(safe-area-inset-bottom/.test(bundle)) issues.push("滚动体底部仍有 Tab 栏时代的硬留白（白占会话区）");
	if (!/\[class\*="scrollBody"\]\[data-conversation-scroll\]\{justify-content:flex-start !important;padding-bottom:env\(safe-area-inset-bottom,0px\) !important\}/.test(bundle)) issues.push("会话滚动体底部留白应只剩安全区");
	if (!/\[class\*="scrollBody"\]>\[class\*="composerSeat"\]\{margin-top:auto;padding-bottom:0\}/.test(bundle)) issues.push("输入区不应再自带底部内边距");
	// 其余既有契约保持。
	if (!/\[class\*="dockm-backdrop"\]\{z-index:2000 !important\}/.test(bundle)) issues.push("手机端没有把功能坞面板抬到原生弹层之上（z 2000）");
	if (!/dsh-dock-kbd/.test(bundle)) issues.push("缺少软键盘让位（dsh-dock-kbd）");
	if (!/visualViewport/.test(bundle)) issues.push("软键盘判定没有用 visualViewport");
	if (!/querySelector\('\[role="dialog"\]'\)\)\s*collapse\(\)/.test(bundle)) issues.push("侧栏入口点击后没有「面板弹出即收起抽屉」的探测（面板被抽屉盖住等于点了没反应）");
	if (!/startsWith\(["']session:["']\)/.test(bundle)) issues.push("会话行识别没有按 data-row-key 的 session: 前缀（点工作区文件夹会被误收抽屉）");
	if (issues.length) {
		console.log(`✗ 手机端汉堡菜单契约：${issues.join("；")}`);
		process.exit(1);
	}
	console.log("✓ 手机端汉堡菜单契约：底部 Tab 栏与角标已移除、左上角三条横线汉堡展开抽屉、软键盘让位、点击路由不变");
}

// ---------- 用例 12：客户端 fetch 一律用文档相对路径（反代子路径挂载契约） ----------
// 真实事故（用户实测）：【模型设置】切页报「模型目录拉取失败：Unexpected token '<', "<!doctype "…」。
// 反代/网关把 dsh 挂在子路径（如 /ui/）时，绝对路径 fetch("/dsh-dock/models") 会跳出应用前缀，
// 命中站点 HTML，res.json() 便炸在 doctype 上。约定：客户端只写 "dsh-dock/xxx"（相对当前文档，
// 浏览器自动补全前缀）；宿主 webServer.register 仍是绝对路径 —— 两半部不要混写。
// 注：/__dsh_auth/health 是网关自己的根路径端点，属有意为之，不在本契约内。
{
	if (/fetch\(\s*["'`]\/dsh-dock/.test(bundle)) {
		console.log('✗ 客户端 fetch 路径契约：仍有绝对路径 fetch("/dsh-dock…")（子路径反代挂载下会返回 HTML，JSON 解析崩溃）');
		process.exit(1);
	}
	console.log("✓ 客户端 fetch 路径契约：全部为文档相对路径（兼容反代子路径挂载）");
}

// ---------- 用例 13：用量记录路由不可用时停止轮询（405 契约） ----------
// 真实问题（隔离实例实测）：【用量记录】的会话区 chip 每 10s 轮询 dsh-dock/tokenlog/query，
// 但当该功能在**宿主侧没启用**时（多设备开关不一致 / localStorage 与宿主 settings 不同步，
// 实测 `initial toggles applied:` 里没有 tokenlog），宿主根本没注册该路由 → 连续 405，
// 一直重试到页面关闭。405/404 是**终态**（路由就是不存在，重试无用），必须置闩锁停轮询。
{
	const issues = [];
	if (!/isTokenlogRouteGone/.test(bundle)) issues.push("缺少「路由不可用」闩锁（405/404 后会无限重试）");
	if (!/routeGone\s*=\s*true/.test(bundle)) issues.push("收到 405/404 后没有置位闩锁");
	// chip 的轮询必须先查闩锁再发请求（早退），而不是在 catch 里硬改定时器。
	if (!/cancel \|\| isTokenlogRouteGone\(\)\)\s*return null/.test(bundle)) issues.push("chip 轮询没有在发请求前检查闩锁");
	// ⚠️ 产物里中文被转义，且中间的「·」esbuild 用 \xB7（不是 \u00B7）——两种都认。
	if (!/\\u7528\\u91CF(?:\\xB7|\\u00B7|\\uFF65)?\\u672A\\u542F\\u7528/.test(bundle) && !/用量·未启用/.test(bundle)) issues.push("路由不可用时 chip 没有显示「未启用」态（会误导成报错）");
	if (/(tokenlog|TokenLog)[\s\S]{0,80}宿主进程是旧版本（没有用量记录路由）/.test(bundle)) issues.push("仍只提示「宿主旧版本」，漏了更常见的「功能未启用」成因");
	if (issues.length) {
		console.log(`✗ 用量记录路由闩锁契约：${issues.join("；")}`);
		process.exit(1);
	}
	console.log("✓ 用量记录路由闩锁契约：405/404 置闩锁并停止轮询、chip 显示「未启用」而非报错、提示覆盖「功能未启用」成因");
}

// ---------- 用例 14：用量记录路由闩锁（行为级断言，不只查字符串） ----------
// 真实问题（隔离实例实测）：宿主没注册 tokenlog 路由时（功能在宿主侧被停用），
// 会话区 chip 每 10s 轮询一次、首页概要每 60s 一次，持续 405 并刷控制台，直到页面关闭。
// 405/404 是**终态**（路由就是不存在，重试无用），必须置闩锁停掉后续调用。
// 这里断言的是行为：第一次 405 之后，再次挂载视图**不得**再发出任何网络请求。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tokenlog";
	const base = makeFetch(ANIMATION_STATUS, NOTIFY_STATUS, [], {}, undefined);
	let calls = 0;
	const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, {
		fetch: (url, init) => {
			if (String(url).includes("dsh-dock/tokenlog/")) {
				calls++;
				// 宿主未注册该路由：405（与真实场景一致，见 host register 的 405 分支）
				return Promise.resolve({ ok: false, status: 405, json: async () => ({ ok: false }) });
			}
			return base(url, init);
		},
	});
	const reg = regs.find((r) => r.def && r.def.name === "conversation.input.left" && r.def.id === "dsh-dock-chips");
	if (!reg) { console.log("✗ 路由闩锁：没有注册 conversation.input.left（会话区 chips）"); process.exit(1); }

	// 第一次挂载（会话 s1）：发出请求并拿到 405
	await renderSettled(runtime, runtime.react.createElement(reg.comp, { sessionId: "s1" }));
	const first = calls;
	if (first < 1) { console.log(`✗ 路由闩锁：chip 首次挂载没有发出 tokenlog 请求（calls=${first}）`); process.exit(1); }

	// 换到另一个会话（s2）→ chip 的 useEffect 依赖 [sid] 变化，**一定会重跑**并再次发请求；
	// 闩锁生效时这次请求应被拦在 fetch 之前，一次都不该发出去。
	await renderSettled(runtime, runtime.react.createElement(reg.comp, { sessionId: "s2" }));
	const again = calls - first;
	if (again !== 0) {
		console.log(`✗ 路由闩锁：收到 405 后切会话仍又发出 ${again} 次请求（应立即停止轮询）`);
		process.exit(1);
	}
	console.log(`✓ 用量记录路由闩锁（行为）：首次 405 后停止轮询（首挂载 ${first} 次、切会话新增 ${again} 次）`);
}

// ---------- 用例 15：【语音朗读】回合尾喇叭按钮渲染 + 点击朗读（含 Markdown 清洗） ----------
// 用户诉求：会话结束后在回复下方点喇叭听，不想看了。这里锁三件事：
//   ① 功能启用后确实注册了 conversation.chat.turnTail 座位，且对「有正文的已完成回合」渲染出按钮；
//   ② 点按钮 → speechSynthesis.speak 收到朗读文本；
//   ③ 朗读的是清洗过的纯文本（Markdown 符号、代码块、表格不能念出来）。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { speech });
		const reg = regs.find((r) => r.def && r.def.name === "conversation.chat.turnTail" && r.def.id === "dsh-dock-turn-tail");
		if (!reg) throw new Error("没有注册 conversation.chat.turnTail（回复下方不会出现喇叭按钮）");
		const blocks = [
			{ kind: "reasoning", text: "这段是思考过程，不该念" },
			{ kind: "text", text: "结论如下：**共 3 处**修改。\n\n```js\nconst a = 1;\n```\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |\n\n详见 [工作流](docs/workflow.md)。" },
		];
		const owner = {
			sessionId: "s-1",
			seq: 42,
			openFile() {},
			turn: {
				turn: 2,
				status: "closed",
				end: { time: Date.now(), data: { reason: { kind: "completed" } } },
				data: { get: (k) => (k === "turn-tail" ? { closing: { blocks } } : undefined) },
			},
		};
		const html = await renderSettled(runtime, runtime.react.createElement(reg.comp, owner));
		if (!/dktts-btn/.test(html)) detail = "回合下方没有渲染朗读按钮（dktts-btn）";
		else if (html.includes("思考过程")) detail = "思考过程被念出来了（只应读 text 块）";
		else {
			const btn = runtime.elements.find((el) => el.event === "onClick" && /dktts-btn/.test(el.className));
			if (!btn) throw new Error("朗读按钮没有挂 onClick 句柄");
			btn.handler({});
			if (speech.spoken.length === 0) throw new Error("点喇叭没有任何 speak 调用");
			const text = speech.spoken.map((u) => u.text).join("");
			if (!text.includes("结论如下")) detail = "朗读文本缺少正文（实际：" + text.slice(0, 60) + "）";
			else if (text.includes("const a")) detail = "代码块内容被念出来了（skipCode 默认应跳过）";
			else if (text.includes("| a |")) detail = "表格原样被念出来了（skipTables 默认应跳过）";
			else if (text.includes("**")) detail = "Markdown 加粗符号没清掉";
			else if (text.includes("docs/workflow.md")) detail = "链接地址没清掉（只应留锚文字）";
			else if (!text.includes("工作流")) detail = "链接锚文字丢了";
			else if (speech.spoken.some((u) => typeof u.rate !== "number")) detail = "utterance 没带语速等参数";
		}
	} catch (e) {
		detail = "回合尾朗读用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 回合尾朗读按钮：${detail}`); process.exit(1); }
	console.log("✓ 回合尾朗读按钮：回复下方渲染喇叭，点击朗读清洗后的正文（代码块/表格/思考过程不念）");
}

// ---------- 用例 16：【语音朗读】自动朗读由宿主任务追踪驱动，且首屏历史不补读 ----------
// 自动朗读的触发源是宿主侧会话级追踪（与【任务通知】同一机制），不是「回合节点刚挂载」——
// 后者在冷读历史会话时也会命中，会莫名其妙把老回复念出来。这里锁两条：
//   ① 首份快照里的「最近完成」只登记不朗读（页面刚打开保持安静）；
//   ② 之后新出现的结束记录才朗读，且读的是那条记录的 lastText。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	const live = {
		active: [],
		recent: [Object.assign({}, NOTIFY_STATUS.recent[0], { lastText: "这是打开页面之前就完成的老回复" })],
		config: Object.assign({}, TTS_STATUS.config, { autoPlay: true }),
	};
	const ttsStatus = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { speech }, ttsStatus);
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		if (!overlays) throw new Error("没有注册功能全局浮层");
		const node = runtime.react.createElement(overlays.comp, null);
		await renderSettled(runtime, node);
		await new Promise((resolve) => setTimeout(resolve, 1600)); // 宿主配置回来 + 轮询起 + 首帧登记
		await renderSettled(runtime, node);
		if (speech.spoken.length > 0) detail = "页面刚打开就把历史「最近完成」补读了（应保持安静）";
		else {
			// 新任务结束：出现一条新的结束记录（endTime 不同）
			live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], {
				lastText: "新回复：三个仓库都已更新完毕。", endTime: Date.now() + 5000,
			})].concat(live.recent);
			await new Promise((resolve) => setTimeout(resolve, 1600)); // 等一轮轮询
			await renderSettled(runtime, node);
			if (speech.spoken.length === 0) detail = "新任务结束没有自动朗读（浮层没读到宿主追踪快照？）";
			else {
				const text = speech.spoken.map((u) => u.text).join("");
				if (!text.includes("三个仓库都已更新完毕")) detail = "自动朗读的内容不是本回合回复（实际：" + text.slice(0, 40) + "）";
			}
		}
	} catch (e) {
		detail = "自动朗读用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 自动朗读：${detail}`); process.exit(1); }
	console.log("✓ 自动朗读：首屏历史不补读，新任务结束时朗读其回复正文");
}

// ---------- 用例 17：【语音朗读】配置页与契约（音色设备相关 / 长度上限 / 不支持时的提示） ----------
{
	const issues = [];
	// 音色是浏览器/设备本地的：使用前必须拿本机 getVoices 校验，取不到按语言回落
	if (!/voiceURI/.test(bundle)) issues.push("产物里没有 voiceURI（音色选择未持久化）");
	if (!/getVoices/.test(bundle)) issues.push("没有读本机音色表（换设备会挑到不存在的音色）");
	// 沙箱兼容：不得裸引用全局 speechSynthesis（node:vm 里会 ReferenceError）
	if (!/speechSynthesis/.test(bundle)) issues.push("产物里没有 speechSynthesis 引用");
	if (/[^.\w"']speechSynthesis\s*\./.test(bundle)) issues.push("裸引用 speechSynthesis.xxx（沙箱/旧内核会抛）");
	// 不支持时要给出可读原因，而不是静默失效
	if (!/本浏览器不支持语音合成|不提供语音合成能力/.test(bundle) && !/\\u672C\\u6D4F\\u89C8\\u5668\\u4E0D\\u652F\\u6301/.test(bundle)) {
		issues.push("浏览器不支持时没有可读提示（静默失效）");
	}
	// 长文本分片：Chrome 长句合成会静默停住
	if (!/chunkForSpeech/.test(bundle)) issues.push("没有分片逻辑（长回复在 Chrome 上会中途哑掉）");
	// 长度上限（只读前 N 句 / 字数上限）
	if (!/maxSentences/.test(bundle) || !/maxChars/.test(bundle)) issues.push("缺少朗读长度上限设置");
	// 功能默认关闭（新功能的仓库约定）
	if (!/id: "tts"[\s\S]{0,400}defaultEnabled: false/.test(bundle)) issues.push("【语音朗读】未遵循「新功能默认停用」约定");
	if (issues.length) { console.log(`✗ 语音朗读契约：${issues.join("；")}`); process.exit(1); }
	console.log("✓ 语音朗读契约：音色按本机校验、无裸引用、不支持有提示、长文本分片、长度上限、默认停用");
}

// ---------- 用例 18：【语音朗读】暂停 / 继续 / 重新朗读（不重头） ----------
// 用户实测反馈（截图）：读完一条后再点喇叭会从头开始——要求播放中再点=暂停、
// 再点=从暂停处继续；「重新朗读」才是显式回第一句。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { speech });
		const reg = regs.find((r) => r.def && r.def.name === "conversation.chat.turnTail" && r.def.id === "dsh-dock-turn-tail");
		if (!reg) throw new Error("没有注册 conversation.chat.turnTail");
		const owner = {
			sessionId: "s-9", seq: 7, openFile() {},
			turn: {
				turn: 1, status: "closed",
				end: { time: Date.now(), data: { reason: { kind: "completed" } } },
				data: { get: (k) => (k === "turn-tail" ? { closing: { blocks: [{ kind: "text", text: "第一句。第二句。第三句。" }] } } : undefined) },
			},
		};
		const node = runtime.react.createElement(reg.comp, owner);
		const mainBtn = () => {
			const els = runtime.elements.filter((el) => el.event === "onClick" && /(^|\s)dktts-btn/.test(el.className));
			if (els.length === 0) throw new Error("回合尾没有可点按钮");
			return els[0];
		};
		// ① 第一下：开始朗读（speak 一次，未自动播完）
		await renderSettled(runtime, node);
		mainBtn().handler({});
		await renderSettled(runtime, node);
		if (speech.spoken.length !== 1) throw new Error("第一下没有开始朗读（spoken=" + speech.spoken.length + "）");
		// ② 第二下：暂停（synth.pause 被调、没有 cancel——cancel 会丢进度）
		mainBtn().handler({});
		await renderSettled(runtime, node);
		if (speech.synth.pauseCount !== 1) detail = "播放中再点没有暂停（pause 调用数=" + speech.synth.pauseCount + "）";
		else if (speech.synth.cancelCount !== 0) detail = "暂停走了 cancel（会丢进度、继续就重头）";
		else {
			// ③ 第三下：就地继续（synth.resume，不再 speak 新 utterance）
			mainBtn().handler({});
			await renderSettled(runtime, node);
			if (speech.synth.resumeCount !== 1) detail = "暂停后再点没有继续（resume 调用数=" + speech.synth.resumeCount + "）";
			else if (speech.spoken.length !== 1) detail = "继续时重新 speak 了（应就地续读，spoken=" + speech.spoken.length + "）";
			else {
				// ④ 「重新朗读」：cancel 旧篇 + 从第一片重 speak
				const restart = runtime.elements.filter((el) => el.event === "onClick" && /(^|\s)dktts-btn/.test(el.className))[1];
				if (!restart) throw new Error("播放中没有出现「重新朗读」按钮");
				restart.handler({});
				await renderSettled(runtime, node);
				if (speech.synth.cancelCount < 1) detail = "重新朗读没有 cancel 旧篇";
				else if (speech.spoken.length !== 2) detail = "重新朗读没有重新 speak（spoken=" + speech.spoken.length + "）";
			}
		}
	} catch (e) {
		detail = "暂停/继续用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 朗读暂停/继续：${detail}`); process.exit(1); }
	console.log("✓ 朗读暂停/继续：播放中再点=暂停（不 cancel）、再点=就地继续、「重新朗读」才回第一句");
}

// ---------- 用例 19：切换朗读内容时等 Chrome 异步清队，不排旧队列后面 ----------
// 用户实测：会话 A 正在朗读时点会话 B 的喇叭，前几秒读的还是 A 的剩余内容。
// 根因：Chrome 的 speechSynthesis.cancel() 是异步冲刷的——cancel 后同一 tick speak()，
// 新语音排进还没清空的旧队列。修法：轮询 speaking/pending 直到队列真空再开播。
// 桩模拟这个异步：cancel() 后 speaking 仍挂 30ms 才落。断言：
//   ① 点 B 的瞬间**不得**立即 speak（否则就是排进了 A 的旧队列）；
//   ② 队列真空后 B 的文本才 speak 出去，且内容确实是 B 的。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	// 覆盖桩：speak 置忙；cancel 后延迟 30ms 才真空（真实 Chrome 语义）
	speech.synth.speak = (utt) => { speech.spoken.push(utt); speech.synth.speaking = true; };
	speech.synth.cancel = () => {
		speech.synth.cancelCount += 1;
		setTimeout(() => { speech.synth.speaking = false; }, 30);
	};
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { speech });
		const reg = regs.find((r) => r.def && r.def.name === "conversation.chat.turnTail" && r.def.id === "dsh-dock-turn-tail");
		if (!reg) throw new Error("没有注册 conversation.chat.turnTail");
		const ownerFor = (turnNo, text) => ({
			sessionId: "s-19", seq: 100 + turnNo, openFile() {},
			turn: {
				turn: turnNo, status: "closed",
				end: { time: Date.now(), data: { reason: { kind: "completed" } } },
				data: { get: (k) => (k === "turn-tail" ? { closing: { blocks: [{ kind: "text", text }] } } : undefined) },
			},
		});
		const nodeA = runtime.react.createElement(reg.comp, ownerFor(1, "会话甲的内容，正在被朗读。"));
		await renderSettled(runtime, nodeA);
		const btn = () => runtime.elements.filter((el) => el.event === "onClick" && /(^|\s)dktts-btn/.test(el.className))[0];
		btn().handler({}); // A 开读
		await renderSettled(runtime, nodeA);
		if (speech.spoken.length !== 1) throw new Error("A 没有开始朗读（前置条件不成立）");
		// 切到 B（模拟点另一会话的喇叭）
		const nodeB = runtime.react.createElement(reg.comp, ownerFor(2, "会话乙的内容，应当立刻顶替甲。"));
		await renderSettled(runtime, nodeB);
		btn().handler({});
		// 此刻 cancel 还没冲刷完（speaking 仍 true）：B 不得已经 speak
		if (speech.spoken.length !== 1) detail = "cancel 尚未冲刷就 speak 了新内容（会排进旧队列，先听完上一条）";
		else {
			await new Promise((resolve) => setTimeout(resolve, 150)); // 等队列真空 + 轮询追上
			await renderSettled(runtime, nodeB);
			if (speech.spoken.length < 2) detail = "队列真空后 B 的内容始终没有开播";
			else if (!String(speech.spoken[1].text).includes("会话乙")) detail = "真空后读的不是 B 的内容：" + String(speech.spoken[1].text).slice(0, 20);
		}
	} catch (e) {
		detail = "切换清队用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 切换朗读清队：${detail}`); process.exit(1); }
	console.log("✓ 切换朗读清队：cancel 未冲刷完不 speak，队列真空后立即播新内容（不排旧队列后面）");
}

// ---------- 用例 20：回合尾 ⚙ 就地快设（语速/音量滑杆即时生效 + 宿主落盘防抖） ----------
// 用户诉求：听的时候想直接调语速音量，不用跑去功能坞。锁四点：
//   ① 喇叭行里任何状态都有 ⚙ 设置按钮；② 点击弹出语速/音量浮层（portal 到 body）；
//   ③ 拖动滑杆 → configStore 立即更新（引擎逐片现取 → 下一句生效）；
//   ④ 连拖多格只 POST 一次宿主（防抖），且 payload 带上最新值。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	const bodyStub = { tag: "body-stub" };
	let detail = "";
	try {
		const { runtime, regs, posts, portalNodes } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, { speech, body: bodyStub });
		const reg = regs.find((r) => r.def && r.def.name === "conversation.chat.turnTail" && r.def.id === "dsh-dock-turn-tail");
		if (!reg) throw new Error("没有注册 conversation.chat.turnTail");
		const owner = {
			sessionId: "s-20", seq: 5, openFile() {},
			turn: {
				turn: 0, status: "closed",
				end: { time: Date.now(), data: { reason: { kind: "completed" } } },
				data: { get: (k) => (k === "turn-tail" ? { closing: { blocks: [{ kind: "text", text: "测试内容一句。" }] } } : undefined) },
			},
		};
		const node = runtime.react.createElement(reg.comp, owner);
		await renderSettled(runtime, node);
		// ⚙ = 最后一个 dktts-btn（喇叭/重读/停止之后；未播放时是 喇叭+⚙ 两个）
		const btns = runtime.elements.filter((el) => el.event === "onClick" && /(^|\s)dktts-btn/.test(el.className));
		if (btns.length < 2) throw new Error("回合尾没有 ⚙ 设置按钮（只有 " + btns.length + " 枚按钮）");
		btns[btns.length - 1].handler({ currentTarget: { getBoundingClientRect: () => ({ left: 200, bottom: 400 }) } });
		await renderSettled(runtime, node);
		const pops = portalNodes.filter((p) => p.target === bodyStub);
		if (pops.length === 0) throw new Error("⚙ 点击后没有 portal 出浮层到 body");
		const popHtml = runtime.render(pops[pops.length - 1].node);
		if (!popHtml.includes("dktts-pop")) detail = "浮层缺少 dktts-pop 结构";
		else {
			// 拖语速滑杆（连拖 3 格）→ 本地值即时更新、宿主写盘只 1 次（防抖）
			// 浮层里带 onChange 的就是语速/音量两枚滑杆（替身不记录 type 属性，按事件筛）
			const sliders = runtime.elements.filter((el) => el.event === "onChange" && el.tag === "input");
			if (sliders.length < 2) throw new Error("浮层里语速/音量滑杆不足两枚（找到 " + sliders.length + "）");
			const before = posts.filter((p) => p.url.includes("dsh-dock/tts/config")).length;
			sliders[0].handler({ target: { value: "1.4" } });
			sliders[0].handler({ target: { value: "1.7" } });
			sliders[0].handler({ target: { value: "1.6" } });
			await renderSettled(runtime, node);
			const after = posts.filter((p) => p.url.includes("dsh-dock/tts/config"));
			// 防抖 400ms：此刻必须还没发（发早了=每格一个 POST）
			if (after.length !== before) detail = "滑杆连拖 3 格立刻发了宿主 POST（应防抖到停手后合一次）";
			await new Promise((resolve) => setTimeout(resolve, 650));
			const after2 = posts.filter((p) => p.url.includes("dsh-dock/tts/config"));
			if (after2.length - before !== 1) detail = "停手后应恰好补发 1 次宿主 POST（实际 " + (after2.length - before) + "）";
			else {
				const body = after2[after2.length - 1].body;
				if (body.rate !== 1.6) detail = "防抖 POST 应带最新语速 1.6（实际 " + body.rate + "）";
			}
		}
	} catch (e) {
		detail = "⚙ 快设用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 回合尾快设：${detail}`); process.exit(1); }
	console.log("✓ 回合尾快设：⚙ 弹语速/音量浮层（portal body），拖动即时生效、宿主落盘防抖合一次");
}

// 视图里挂的轮询定时器（ctx.interval / setInterval 兜底）会让事件循环不退出，显式收尾。
process.exit(0);
