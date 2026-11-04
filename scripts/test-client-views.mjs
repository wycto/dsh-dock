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
		// 模型余额：宿主直接返回快照（不包 ok/data）
		if (String(url).includes("dsh-dock/balance")) {
			return Promise.resolve({ ok: true, status: 200, json: async () => BALANCE_SNAPSHOT });
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
// 音频桩：记录 playTone 起播的每个音符（频率 + 起始时间），用于通知提示音的事件矩阵断言
function makeAudioStub() {
	const notes = [];
	const Param = function () {};
	Param.prototype.setValueAtTime = function () {};
	Param.prototype.linearRampToValueAtTime = function () {};
	Param.prototype.exponentialRampToValueAtTime = function () {};
	function Node() { this.connect = () => this; }
	function AudioContextStub() {
		this.state = "running";
		this.currentTime = 0;
		this.destination = new Node();
	}
	AudioContextStub.prototype.resume = () => Promise.resolve();
	AudioContextStub.prototype.createOscillator = function () {
		const node = new Node();
		node.frequency = { value: 0 };
		node.type = "sine";
		node.start = (at) => notes.push({ freq: node.frequency.value, at });
		node.stop = () => {};
		return node;
	};
	AudioContextStub.prototype.createGain = function () {
		const node = new Node();
		node.gain = new Param();
		return node;
	};
	return { AudioContext: AudioContextStub, notes };
}
// 系统通知桩：记录 new Notification(...) 的标题与正文
function makeNotificationStub() {
	const sent = [];
	function NotificationStub(title, options) {
		sent.push({ title, options: options || {} });
	}
	NotificationStub.permission = "granted";
	NotificationStub.requestPermission = async () => "granted";
	return { Notification: NotificationStub, sent };
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
	// opts.globals：注入测试用全局桩（如 AudioContext / Notification），同时挂到 globalThis 与 window
	if (opts && opts.globals) {
		for (const [key, value] of Object.entries(opts.globals)) {
			sandbox[key] = value;
			win[key] = value;
		}
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
		// 页内卡片总开关（关 → 右侧所有卡不弹）+ 卡住提醒卡（类型开关之一）+ 卡片口径三挡
		notifyCards: true, notifyOnStuck: true, cardMode: "detailed",
		notifyStayMs: 8000, systemNotify: false, soundNotify: true, soundEffect: "chime",
		dingtalkEnabled: true, dingtalkWebhook: "https://oapi.dingtalk.com/robot/send?access_token=x",
		feishuEnabled: true, feishuWebhook: "https://open.feishu.cn/open-apis/bot/v2/hook/x",
		// 语音播报（默认总开关关；播报用例里显式打开）
		voiceNotify: false, voiceMode: "brief",
		voiceOnComplete: true, voiceOnError: true, voiceOnConfirm: true, voiceOnStuck: true,
		voiceRate: 1, voiceVolume: 1, voiceLang: "", voiceURI: "",
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

// 模型余额 /dsh-dock/balance：同样不包 ok/data（宿主直接 sendJson 快照）。
// 覆盖「DeepSeek 账号（官网账号，ok + 充值/赠送分列）」与「需登录 → 控制台链接」两条分支。
const BALANCE_SNAPSHOT = {
	generatedAt: 1_700_000_000_000,
	default: { provider: "deepseek-account", model: "deepseek-flash" },
	providers: [
		{
			id: "deepseek-account", displayName: "DeepSeek 账号", apiKeyEnv: null,
			baseURL: null, api: null, models: ["deepseek-flash"], credentialConfigured: false,
			balance: {
				status: "ok", kind: "currency", available: true,
				// 故意给不可整除到分的金额：官网把真实余额 77.6772 显示成 ¥77.67，四舍五入会多一分钱。
				infos: [{ currency: "CNY", totalBalance: "77.6772", grantedBalance: "0.004", toppedUpBalance: "77.6732" }],
			},
		},
		{
			id: "kimi-coding", displayName: "Kimi Coding", apiKeyEnv: "KIMI_API_KEY",
			baseURL: "https://api.kimi.com/coding", api: null, models: [], credentialConfigured: false,
			balance: { status: "login-required", consoleUrl: "https://platform.moonshot.cn/console" },
		},
	],
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
	// 模型余额：官网账号（DeepSeek 账号）走宿主 deepseekAccount 服务，必须渲染成
	// 「可用 + 充值/赠送分列」；需登录的 Provider 给出控制台链接（不再一律「不支持」）。
	if (f.id === "balance" && !error) {
		for (const needle of ["DeepSeek 账号", "77.67", "充值 77.67", "赠送 0.00", "需登录", "去控制台查看余额"]) {
			if (!html.includes(needle)) { failed++; console.log(`✗ 模型余额视图缺少「${needle}」（官网账号余额分支未渲染）`); }
		}
		// 精度回归：金额按分截断（77.6772 → 77.67），不能四舍五入成 77.68 比官网多一分钱。
		if (html.includes("77.68")) { failed++; console.log("✗ 模型余额视图出现「77.68」：金额仍四舍五入到分（应截断）"); }
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

// ---------- 用例 10：手机自适应内建在 dsh-dock 样式里（不再有独立【手机适配】模块） ----------
// 用户 2026-11-04 决定：官方 DSH 已自带抽屉/单列设置/16px 输入，独立模块冗余，整块删掉；
// 真正还需要的那点手机优化（输入卡贴底、状态条上移、chip 紧凑、触控热区、安全区、代码滚动）
// 直接写进 dsh-dock 的 SHELL_CSS，随插件生效、按窄屏媒体查询命中，不再有开关与注入。
{
	const issues = [];
	if (/id:\s*["']mobile["']/.test(bundle)) issues.push("bundle 里仍注册了 mobile 功能描述符");
	if (/data-dsh-mobile-runtime|data-dsh-mobile-stack|data-dsh-mobile-legacy|data-dk-mobile/.test(bundle)) {
		issues.push("仍残留【手机适配】模块的运行时标记/属性");
	}
	if (/dsh-mobile-burger|dsh-mobile-scrim|dsh-dock-kbd/.test(bundle)) issues.push("仍残留手机端 chrome/软键盘逻辑");
	if (existsSync(join(root, "features", "mobile"))) issues.push("features/mobile 目录仍存在");
	for (const marker of ["composerSeat", "dockchip-row", "safe-area-inset-bottom", "data-sidebar-opener"]) {
		if (!bundle.includes(marker)) issues.push("SHELL_CSS 缺少内建手机自适应规则：" + marker);
	}
	if (issues.length) {
		console.log(`✗ 手机自适应内建契约：${issues.join("；")}`);
		process.exit(1);
	}
	console.log("✓ 手机自适应内建契约：独立模块已删除；贴底/状态条/chip/热区/安全区/代码滚动等窄屏规则留在 dsh-dock 自身样式");
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

// ---------- 用例 21：宿主路由不可用时，自动朗读走回合尾本地兜底 ----------
// 用户实测（2026-10-23）：开了自动朗读但会话结束没读——根因是宿主进程旧版本没注册
// /dsh-dock/tts（405 → routeGone），浮层主路径哑火，而手动喇叭不依赖宿主照常能用，
// 形成「手动能读、自动不读」的残缺态。修法：回合尾节点自带兜底——routeGone 时
// 「刚挂载 + turn/end < 8 秒」即读本回合；冷读历史（时间差大）不播。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "tts";
	const speech = makeSpeechStub();
	// 本地表态：自动朗读开（configStore 初值从 localStorage 读，宿主 405 后保持本地值）
	const store = { "dsh-dock/tts/v1": JSON.stringify({ autoPlay: true }) };
	let detail = "";
	try {
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, NOTIFY_STATUS, undefined, undefined, {
			speech,
			store,
			// tts 路由一律 405（模拟旧宿主进程未注册）
			fetch: (url, init) => {
				if (String(url).includes("dsh-dock/tts/")) {
					return Promise.resolve({ ok: false, status: 405, json: async () => ({ ok: false }) });
				}
				return makeFetch(ANIMATION_STATUS, NOTIFY_STATUS, [], {}, undefined)(url, init);
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 50)); // 等 ensureConfigLoaded 的 405 回来置闩锁
		const reg = regs.find((r) => r.def && r.def.name === "conversation.chat.turnTail" && r.def.id === "dsh-dock-turn-tail");
		if (!reg) throw new Error("没有注册 conversation.chat.turnTail");
		const mkOwner = (turnNo, text, endAgeMs) => ({
			sessionId: "s-21", seq: 900 + turnNo, openFile() {},
			turn: {
				turn: turnNo, status: "closed",
				end: { time: Date.now() - endAgeMs, data: { reason: { kind: "completed" } } },
				data: { get: (k) => (k === "turn-tail" ? { closing: { blocks: [{ kind: "text", text }] } } : undefined) },
			},
		});
		// ① 刚结束的回合（turn/end 1 秒前）→ 兜底自动读
		const freshNode = runtime.react.createElement(reg.comp, mkOwner(3, "刚跑完的回复，应当被自动朗读。", 1000));
		await renderSettled(runtime, freshNode);
		if (speech.spoken.length === 0) detail = "routeGone 时刚结束的回合没有被兜底自动朗读";
		else if (!String(speech.spoken[0].text).includes("自动朗读")) detail = "兜底读的内容不对：" + String(speech.spoken[0].text).slice(0, 20);
		else {
			// ② 冷读历史回合（turn/end 1 小时前）→ 不播
			const n0 = speech.spoken.length;
			const oldNode = runtime.react.createElement(reg.comp, mkOwner(4, "一小时前的老回复。", 3600_000));
			await renderSettled(runtime, oldNode);
			if (speech.spoken.length !== n0) detail = "冷读历史会话被兜底误播（老回复不该补读）";
			else {
				// ③ 同一新回合重挂载（切走再切回）→ 去重不重播
				const againNode = runtime.react.createElement(reg.comp, mkOwner(3, "刚跑完的回复，应当被自动朗读。", 1000));
				await renderSettled(runtime, againNode);
				if (speech.spoken.length !== n0) detail = "同一回合重挂载被重复朗读（去重失效）";
			}
		}
	} catch (e) {
		detail = "自动朗读兜底用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 自动朗读兜底：${detail}`); process.exit(1); }
	console.log("✓ 自动朗读兜底：宿主路由不可用时刚结束回合仍自动读、冷读历史不播、重挂载不重播");
}

// ---------- 用例 5g：点卡片/巡检按 sessionId 走（旧版位置过滤在窄窗口下全失效） ----------
// 用户实测（2026-10-23）：完成卡点了不跳转、点进会话也不收，一直挂着。根因不是设计，
// 是判定口径：旧版跳转与巡检都要求会话行「可见 + 右缘 ≤ 35vw」，侧栏较宽或窗口较窄时
// 行右缘超限 → 一行都匹配不上 → 跳转失败（卡片不收）、巡检读不到选中（永不自动收）。
// 修法：会话行有权威标识 data-row-key="session:<id>"（dsh 0.1.7+ Rows.tsx），
// 跳转优先走宿主官方 ctx.uiWorkspace.openSession(id)（不做任何几何过滤），
// 巡检按高亮行的 id 比对；只有拿不到 id 的旧宿主才回退标题 + 几何判定。
// ⚠️ 两个场景各用一套 runtime：替身按渲染路径缓存组件实例，同一位置先后两张卡
//    会复用旧实例的 closing 态（真实 React 按 key={t.id} 区分，无此问题）。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "notify";
	const TARGET_ID = "sess-target-5g";
	const taskOf = () => Object.assign({}, NOTIFY_STATUS.active[0], { sessionId: TARGET_ID, approvals: [] });
	const recOf = (endTime) => Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: TARGET_ID, endTime });
	// 会话行桩：右缘 900px（窄窗口/宽侧栏的真实形态，旧几何口径 ≤35vw 会把行全滤掉）
	const makeDoc = (listeners) => ({
		visibilityState: "visible",
		body: { tag: "body-stub" },
		head: { appendChild() {} },
		querySelector() { return null; },
		querySelectorAll(sel) {
			const row = {
				getAttribute: (k) => (k === "data-row-key" ? "session:" + TARGET_ID : null),
				textContent: NOTIFY_STATUS.recent[0].title,
				getBoundingClientRect: () => ({ width: 900, height: 32, top: 100, bottom: 132, right: 900, left: 8 }),
				querySelector: () => ({ click() {} }),
			};
			if (sel === '[role="treeitem"][aria-selected="true"]') return [row];
			if (sel === '[role="treeitem"]') return [row];
			return [];
		},
		createElement() { return { dataset: {}, isConnected: true }; },
		addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
		removeEventListener(type, fn) {
			const arr = listeners[type] || [];
			const i = arr.indexOf(fn);
			if (i >= 0) arr.splice(i, 1);
		},
	});
	const isCard = (el) => el.event === "onClick" && /(^|\s)dknt-toast(\s|$)/.test(el.className) && !el.className.includes("close");
	// 起一套 runtime：注册带 uiWorkspace.openSession 桩的 ctx，返回驱动工具
	function setupScenario(live, openSessionCalls) {
		const listeners = {};
		const { runtime, regs, dock } = loadDock(enabled, ANIMATION_STATUS, () => JSON.parse(JSON.stringify(live)), undefined, undefined, { document: makeDoc(listeners) });
		dock.apply({
			get: (name) => (name === "slots"
				? { inject: () => {}, register: () => () => {} }
				: name === "uiWorkspace" ? { openSession: (id) => { openSessionCalls.push(String(id)); } } : undefined),
			interval: () => () => {},
		});
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		// 空闲轮询 6 秒，用例等不起：派发 visibilitychange 强制刷新一次
		const poke = async () => {
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setImmediate(resolve));
			await renderSettled(runtime, node);
		};
		return { runtime, node, poke };
	}
	let detail = "";
	// —— 场景① 点卡片：官方 openSession(sessionId) 精确跳转（不做几何过滤），成功即收起 ——
	try {
		const live = { active: [taskOf()], recent: [], config: NOTIFY_STATUS.config };
		const openSessionCalls = [];
		const { runtime, node, poke } = setupScenario(live, openSessionCalls);
		await renderSettled(runtime, node);
		await poke(); // 首轮：prevActive 登记 TARGET_ID
		live.active = [];
		live.recent = [recOf(Date.now() + 5000)];
		await poke();
		let html = runtime.render(node);
		if (!html.includes("任务完成")) throw new Error("①任务结束没有弹出完成卡（前置条件不成立）");
		const card = runtime.elements.find(isCard);
		if (!card) throw new Error("①完成卡没有挂 onClick 跳转句柄");
		card.handler({});
		if (openSessionCalls.length !== 1 || openSessionCalls[0] !== TARGET_ID) {
			detail = "①点卡片没有走 ctx.uiWorkspace.openSession(sessionId)（calls=" + JSON.stringify(openSessionCalls) + "）";
		} else {
			await renderSettled(runtime, node); // 淡出定时器在 effect 里排
			await new Promise((resolve) => setTimeout(resolve, 600));
			html = await renderSettled(runtime, node);
			if (html.includes("任务完成")) detail = "①官方跳转成功后完成卡没有收起";
		}
	} catch (e) {
		detail = "①用例抛错：" + ((e && e.message) || e);
	}
	// —— 场景② 巡检按 id 收起：高亮行 data-row-key 与卡片 sessionId 对上 → 自动收 ——
	if (!detail) try {
		const live = { active: [taskOf()], recent: [], config: NOTIFY_STATUS.config };
		const { runtime, node, poke } = setupScenario(live, []);
		await renderSettled(runtime, node);
		await poke();
		live.active = [];
		live.recent = [recOf(Date.now() + 5000)];
		await poke();
		let html = runtime.render(node);
		if (!html.includes("任务完成")) throw new Error("②没有弹出完成卡（前置条件不成立）");
		// 巡检 500ms 一轮标 closing；淡出 240ms 定时器在 effect 里排——多跑几轮收敛
		for (let i = 0; i < 6 && html.includes("任务完成"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 350));
			html = await renderSettled(runtime, node);
		}
		if (html.includes("任务完成")) detail = "②高亮行 id 与卡片 sessionId 对上后仍没自动收起（id 比对未生效）";
	} catch (e) {
		detail = "②用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 通知卡按会话 id 跳转收起：${detail}`); process.exit(1); }
	console.log("✓ 通知卡按会话 id 跳转收起：窄窗口/宽侧栏（行右缘超 35vw）下点卡片走官方 openSession 并收起、点进会话按 id 自动收");
}

// ---------- 用例 21：【任务通知】语音播报（完成/需授权/卡住三类事件 × 简洁/详细两档 × 总开关） ----------
// 用户诉求：任务完成/需授权/卡住/停止时用语音播报，可设简洁与详细。播报走浏览器
// speechSynthesis（与【语音朗读】同一能力、独立开关），只测「该说话时 speak 出去
// 的文本对不对」——音色/分片细节由语音朗读自己的用例覆盖。
{
	const cfgOf = (over) => Object.assign({}, NOTIFY_STATUS.config, { voiceNotify: true }, over || {});
	// 一套 runtime：live 状态 + speech 桩；poke 借 visibilitychange 强制立即刷新
	function setup(live, speech, opts) {
		const enabled = {};
		for (const f of FEATURES) enabled[f.id] = f.id === "notify";
		const listeners = {};
		const doc = {
			visibilityState: "visible",
			body: { tag: "body-stub" },
			head: { appendChild() {} },
			querySelector() { return null; },
			querySelectorAll() { return []; },
			createElement() { return { dataset: {}, isConnected: true }; },
			addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
			removeEventListener() {},
		};
		const status = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, status, undefined, undefined, Object.assign({ document: doc, speech }, opts || {}));
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		let lastHtml = "";
		const poke = async () => {
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setImmediate(resolve));
			lastHtml = await renderSettled(runtime, node);
		};
		return { poke, node, runtime, getHtml: () => lastHtml };
	}
	const lastSpeech = (speech) => (speech.spoken.length ? String(speech.spoken[speech.spoken.length - 1].text) : "");
	let detail = "";
	// —— ① 任务完成（简洁）→ 「任务完成」；总开关关 → 不说话 ——
	try {
		const live = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf() };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke(); // 首轮登记活跃任务
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await poke();
		if (speech.spoken.length !== 1) throw new Error("①任务完成没有播报（spoken=" + speech.spoken.length + "）");
		if (lastSpeech(speech) !== "任务完成") detail = "①简洁口径播报文本不对：" + lastSpeech(speech);
		// 换详细口径的完成：应带标题与耗时
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf({ voiceMode: "detailed" }) };
		const speech2 = makeSpeechStub();
		const s2 = setup(live2, speech2);
		await renderSettled(s2.runtime, s2.node);
		await s2.poke();
		live2.active = [];
		live2.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId, duration: 125000 })];
		await s2.poke();
		const t2 = lastSpeech(speech2);
		if (!t2.includes("上一个任务") || !t2.includes("已完成")) detail = "①详细口径缺少标题或结果（实际：" + t2.slice(0, 50) + "）";
		// 总开关关：同样的结束不说话
		const live3 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: Object.assign({}, NOTIFY_STATUS.config, { voiceNotify: false }) };
		const speech3 = makeSpeechStub();
		const s3 = setup(live3, speech3);
		await renderSettled(s3.runtime, s3.node);
		await s3.poke();
		live3.active = [];
		live3.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await s3.poke();
		if (!detail && speech3.spoken.length !== 0) detail = "①总开关关闭仍播报了：" + lastSpeech(speech3);
		// 本机开关（当前浏览器）关：服务端总开关开着也不出声
		const live4 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf() };
		const speech4 = makeSpeechStub();
		const s4 = setup(live4, speech4, { store: { "dsh-dock/notify/voice-client/v1": "0" } });
		await renderSettled(s4.runtime, s4.node);
		await s4.poke();
		live4.active = [];
		live4.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await s4.poke();
		if (!detail && speech4.spoken.length !== 0) detail = "①本机播报开关关闭仍播报了：" + lastSpeech(speech4);
		// 本机开关开 + 服务端总开关关：仍然不出声（本机不能绕过服务端总开关）
		const live5 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: Object.assign({}, NOTIFY_STATUS.config, { voiceNotify: false }) };
		const speech5 = makeSpeechStub();
		const s5 = setup(live5, speech5, { store: { "dsh-dock/notify/voice-client/v1": "1" } });
		await renderSettled(s5.runtime, s5.node);
		await s5.poke();
		live5.active = [];
		live5.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await s5.poke();
		if (!detail && speech5.spoken.length !== 0) detail = "①本机开、服务端关时仍播报了：" + lastSpeech(speech5);
		// 事件矩阵：只关掉「完成」的页内卡片，语音播报仍应出声（渠道相互独立）
		const liveM = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf({ eventMatrix: { "card:complete": false } }) };
		const speechM = makeSpeechStub();
		const sM = setup(liveM, speechM);
		await renderSettled(sM.runtime, sM.node);
		await sM.poke();
		liveM.active = [];
		liveM.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await sM.poke();
		if (!detail && speechM.spoken.length !== 1) detail = "①事件矩阵关卡片后语音也被静音了（渠道未解耦）";
		if (!detail && sM.getHtml().includes("任务完成")) detail = "①事件矩阵 card:complete=false 仍弹了完成卡片";
		// 配置来源=本机：本机 notifyCards=true 覆盖服务端 notifyCards=false
		const clientCfg = Object.assign({}, NOTIFY_STATUS.config, { notifyCards: true, voiceNotify: false });
		const liveSrc = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: Object.assign({}, NOTIFY_STATUS.config, { notifyCards: false, voiceNotify: false }) };
		const speechSrc = makeSpeechStub();
		const sSrc = setup(liveSrc, speechSrc, { store: {
			"dsh-dock/notify/config-source/v1": "client",
			"dsh-dock/notify/client-config/v1": JSON.stringify(clientCfg),
		} });
		await renderSettled(sSrc.runtime, sSrc.node);
		await sSrc.poke();
		liveSrc.active = [];
		liveSrc.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await sSrc.poke();
		if (!detail && !sSrc.getHtml().includes("任务完成")) detail = "①本机配置未覆盖服务端配置（客户端 notifyCards=true 时不弹卡）";
		// 本机配置的 eventMatrix 不能覆盖服务端钉钉/飞书（群机器人由宿主执行）：
		// 本机写 dingtalk:complete=false，但服务端没设过该键（回退 notifyOnComplete=true）
		// → 面板矩阵「完成 × 钉钉」仍应为勾选；「完成 × 页内卡片」按本机的 true 也应勾选。
		// ⚠️ 矩阵在设置面板 View 里，不在浮层：这里渲染 settings.section 的组件。
		const liveMatrixSrc = { active: [], recent: [], config: Object.assign({}, NOTIFY_STATUS.config, { notifyCards: true, notifyOnComplete: true }) };
		const enabledSrc = {};
		for (const f of FEATURES) enabledSrc[f.id] = f.id === "notify";
		const statusSrc = () => JSON.parse(JSON.stringify({ active: liveMatrixSrc.active, recent: liveMatrixSrc.recent, config: liveMatrixSrc.config }));
		const loadedSrc = loadDock(enabledSrc, ANIMATION_STATUS, statusSrc, undefined, undefined, { store: {
			"dsh-dock/notify/config-source/v1": "client",
			"dsh-dock/notify/client-config/v1": JSON.stringify({ eventMatrix: { "dingtalk:complete": false, "card:complete": true } }),
		} });
		const viewReg = loadedSrc.regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
		const viewHtml = await renderSettled(loadedSrc.runtime, loadedSrc.runtime.react.createElement(viewReg.comp, null));
		const rowMatch = viewHtml.split(/dknt-matrix-row/).find((chunk) => chunk.includes("完成") && chunk.includes("任务正常结束"));
		if (!detail && !rowMatch) detail = "①本机模式矩阵渲染异常（找不到完成行）";
		else if (!detail) {
			// 完成行的 6 个格子：card / sound / system / voice / dingtalk / feishu
			const cells = (rowMatch.match(/class="dknt-cell[^"]*"/g) || []).map((c) => c.includes(" on"));
			if (cells.length !== 6) detail = "①完成行格子数量异常：" + cells.length;
			else if (!cells[0]) detail = "①本机配置 card:complete=true 未生效（页内卡片格未勾选）";
			else if (!cells[4]) detail = "①本机配置覆盖了服务端钉钉开关（钉钉格被本机 eventMatrix 关掉了）";
		}
	} catch (e) {
		detail = "①完成播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ② 需授权 → 「任务需要授权」，且与卡片开关正交（notifyOnConfirm=false 仍播报） ——
	if (!detail) try {
		const live = {
			active: [Object.assign({}, NOTIFY_STATUS.active[0], {
				approvals: [{ id: "ap-9", toolName: "pwsh", reason: "需要提权" }],
			})],
			recent: [],
			config: cfgOf({ notifyOnConfirm: false }),
		};
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("②出现待确认项没有播报");
		if (lastSpeech(speech) !== "任务需要授权") detail = "②需授权简洁播报不对：" + lastSpeech(speech);
	} catch (e) {
		detail = "②需授权播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ③ 卡住（phase=code 且 18 秒无活动）→ 必须说清「主/子任务 + 标题」，同一停点只报一次 ——
	// 2026-10-30 用户实测：主任务进行中突然播「任务卡住了」却看不到卡住的东西——卡的是子任务，
	// 而旧口径一句话不带身份。这里锁死：简洁口径 = 主任务/子任务 + 「标题」+ 卡住了。
	if (!detail) try {
		const stalled = Object.assign({}, NOTIFY_STATUS.active[0], {
			phase: "code", approvals: [],
			lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
		});
		const live = { active: [stalled], recent: [], config: cfgOf() };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("③卡住没有播报");
		if (lastSpeech(speech) !== "主任务「回归测试任务」卡住了") detail = "③卡住简洁播报没带主任务与标题：" + lastSpeech(speech);
		const before = speech.spoken.length;
		await poke();
		await poke(); // 同一 lastActivityAt：不得重复轰炸
		if (!detail && speech.spoken.length !== before) detail = "③同一停点重复播报了 " + (speech.spoken.length - before) + " 次";
		// 恢复活动后再卡 → 可再报
		live.active = [Object.assign({}, stalled, { lastActivityAt: Date.now() - 20000 + 1 })];
		await poke();
		if (!detail && speech.spoken.length !== before + 1) detail = "④活动变化后重新卡住没有再播报";
	} catch (e) {
		detail = "③卡住播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ④b 子任务会话卡住 → 播「子任务…卡住了」（主任务在跑时的突然播报必须能定位） ——
	if (!detail) try {
		const stalled = Object.assign({}, NOTIFY_STATUS.active[0], {
			phase: "code", approvals: [], isSubtask: true,
			lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
		});
		const live = { active: [stalled], recent: [], config: cfgOf() };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("④b子任务卡住没有播报");
		if (lastSpeech(speech) !== "子任务「回归测试任务」卡住了") detail = "④b子任务卡住播报没带子任务标识：" + lastSpeech(speech);
	} catch (e) {
		detail = "④b子任务卡住播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ④c 详细口径 → 补停滞时长与最后动作（lastToolName 来自宿主 tool/call 记录） ——
	if (!detail) try {
		const stalled = Object.assign({}, NOTIFY_STATUS.active[0], {
			phase: "code", approvals: [], lastToolName: "bash",
			lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
		});
		const live = { active: [stalled], recent: [], config: cfgOf({ voiceMode: "detailed" }) };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("④c详细口径卡住没有播报");
		const t = lastSpeech(speech);
		if (!/^主任务「回归测试任务」卡住了/.test(t)) detail = "④c详细口径缺主任务与标题：" + t;
		else if (!t.includes("20秒")) detail = "④c详细口径缺停滞时长：" + t;
		else if (!t.includes("最后在执行bash（执行命令）")) detail = "④c详细口径缺最后动作：" + t;
	} catch (e) {
		detail = "④c详细卡住播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑤ 任务停止（endReason=aborted）→ 简洁口径「任务停止了」 ——
	if (!detail) try {
		const live = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf() };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], {
			sessionId: NOTIFY_STATUS.active[0].sessionId, endReason: "aborted",
		})];
		await poke();
		if (speech.spoken.length < 1) throw new Error("⑤任务停止没有播报");
		if (lastSpeech(speech) !== "任务停止了") detail = "⑤停止播报文本不对：" + lastSpeech(speech);
	} catch (e) {
		detail = "⑤停止播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑥ 指定音色：命中本机音色表则用它并把 lang 对齐；本机没有则按语言回落中文音色 ——
	if (!detail) try {
		const live = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf({ voiceURI: "en-US-Google" }) };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await poke();
		if (speech.spoken.length < 1) throw new Error("⑥指定音色后没有播报");
		const utt = speech.spoken[speech.spoken.length - 1];
		if (!utt.voice || utt.voice.voiceURI !== "en-US-Google") detail = "⑥没有用选中的音色（实际：" + (utt.voice && utt.voice.voiceURI) + "）";
		if (!detail && utt.lang !== "en-US") detail = "⑥音色的语言没有对齐到 utt.lang（实际：" + utt.lang + "）";
		// 换设备后本机没有那个音色：不得哑掉，按语言回落到中文音色
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf({ voiceURI: "zh-CN-NotOnThisMachine" }) };
		const speech2 = makeSpeechStub();
		const s2 = setup(live2, speech2);
		await renderSettled(s2.runtime, s2.node);
		await s2.poke();
		live2.active = [];
		live2.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await s2.poke();
		if (!detail) {
			if (speech2.spoken.length < 1) throw new Error("⑥音色在本机不存在时没有播报（回落失效）");
			const u2 = speech2.spoken[speech2.spoken.length - 1];
			if (!u2.voice || !/^zh/i.test(String(u2.voice.lang || ""))) detail = "⑥音色缺失时没有回落到中文音色（实际：" + (u2.voice && u2.voice.lang) + "）";
		}
	} catch (e) {
		detail = "⑥音色播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑦ 适中口径：完成 → 点名任务 + 结果 + 耗时（不念回合/Token 统计） ——
	if (!detail) try {
		const live = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf({ voiceMode: "medium" }) };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await poke();
		if (speech.spoken.length < 1) throw new Error("⑦适中口径完成没有播报");
		const t = lastSpeech(speech);
		if (t !== "任务「上一个任务」完成了，耗时30秒。") detail = "⑦适中完成播报文本不对：" + t;
	} catch (e) {
		detail = "⑦适中完成播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑧ 适中口径：卡住 → 主/子 + 标题 + 停滞时长（不念最后动作） ——
	if (!detail) try {
		const stalled = Object.assign({}, NOTIFY_STATUS.active[0], {
			phase: "code", approvals: [], lastToolName: "bash",
			lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
		});
		const live = { active: [stalled], recent: [], config: cfgOf({ voiceMode: "medium" }) };
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("⑧适中口径卡住没有播报");
		const t = lastSpeech(speech);
		if (!/^主任务「回归测试任务」卡住了，已经2\d秒没有任何动静。$/.test(t)) detail = "⑧适中卡住播报文本不对：" + t;
		if (!detail && t.indexOf("最后在执行") !== -1) detail = "⑧适中口径不该念最后动作：" + t;
	} catch (e) {
		detail = "⑧适中卡住播报用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑨ 适中口径：需授权 → 点名任务 + 要批准的场景（不念工具名与叮嘱） ——
	if (!detail) try {
		const live = {
			active: [Object.assign({}, NOTIFY_STATUS.active[0], {
				approvals: [{ id: "ap-9", toolName: "pwsh", reason: "需要提权" }],
			})],
			recent: [],
			config: cfgOf({ voiceMode: "medium" }),
		};
		const speech = makeSpeechStub();
		const { runtime, node, poke } = setup(live, speech);
		await renderSettled(runtime, node);
		await poke();
		if (speech.spoken.length < 1) throw new Error("⑨适中口径需授权没有播报");
		const t = lastSpeech(speech);
		if (t !== "任务「回归测试任务」需要授权，正在等你批准执行命令。") detail = "⑨适中需授权播报文本不对：" + t;
	} catch (e) {
		detail = "⑨适中需授权播报用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 任务通知语音播报：${detail}`); process.exit(1); }
	console.log("✓ 任务通知语音播报：完成/需授权/卡住/停止 × 简洁/适中/详细三挡逐句对账，同一停点不重复，指定音色生效且换设备按语言回落");
}

// ---------- 用例 21b：【任务通知】语音播报「服务端总开关 + 本机开关」双层开关 UI ----------
// 团队共用一个 dsh 实例：服务端 voiceNotify 是总开关（跨浏览器），客户端另有按浏览器
// 保存的「本机播报」开关。面板必须同时展示两层开关，且本机开关状态来自 localStorage。
{
	const enabled = {};
	for (const f of FEATURES) enabled[f.id] = f.id === "notify";
	const status = JSON.parse(JSON.stringify(NOTIFY_STATUS));
	status.config.voiceNotify = true;
	const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, status, undefined, undefined, {
		store: { "dsh-dock/notify/voice-client/v1": "1" },
	});
	const reg = regs.find((r) => r.def && r.def.name === "settings.section" && r.def.id === "dsh-dock");
	if (!reg) { console.log("✗ 语音播报双层开关 UI：没有注册 settings.section"); process.exit(1); }
	const firstHtml = await renderSettled(runtime, runtime.react.createElement(reg.comp, null));
	const tabs = runtime.elements.filter((el) => el.event === "onClick" && /(^|\s)dknt-tab(\s|$)/.test(el.className));
	if (tabs.length < 3) { console.log("✗ 语音播报双层开关 UI：找不到「按事件提醒 / 按渠道设置 / 群机器人」页签"); process.exit(1); }
	const issues = [];
	if (!firstHtml.includes("按事件提醒") || !firstHtml.includes("按渠道设置") || !firstHtml.includes("群机器人")) issues.push("缺少事件/渠道/群机器人页签");
	if (!firstHtml.includes("页内卡片") || !firstHtml.includes("语音播报") || !firstHtml.includes("钉钉")) issues.push("按事件矩阵缺少渠道列");
	tabs[1].handler({});
	const html = await renderSettled(runtime, runtime.react.createElement(reg.comp, null));
	if (!html.includes("本机播报")) issues.push("设置面板没有「本机播报」开关");
	if (!html.includes("服务端：已开启")) issues.push("服务端总开关状态没有单独标注");
	if (!html.includes("本浏览器会播报")) issues.push("本机开关开启态说明缺失");
	if (!html.includes("服务端总开关 + 本机开关都开才播报")) issues.push("双层开关的生效条件没有写明");
	if (!html.includes("配置来源")) issues.push("面板顶部没有「配置来源」总开关");
	if (!html.includes("服务端配置") || !html.includes("本机配置")) issues.push("配置来源缺少服务端/本机两个选项");
	if (issues.length) { console.log(`✗ 语音播报双层开关 UI：${issues.join("；")}`); process.exit(1); }
	console.log("✓ 语音播报双层开关 UI：按事件/按渠道/群机器人页签 + 事件矩阵齐全；服务端总开关 + 本机开关（localStorage）均可见，且写明两者都开才播报；配置来源可选服务端/本机");
}

// ---------- 用例 21c：通知事件矩阵 × 各渠道的真实生效 ----------
// 这里不只看字符串：给提示音装 AudioContext 桩、给系统通知装 Notification 桩，
// 逐项验证「事件 → 渠道」勾选真的决定该渠道是否动作（卡片、提示音、系统通知、语音）。
{
	const baseCfg = (over) => Object.assign({}, NOTIFY_STATUS.config, {
		notifyCards: true, notifyOnComplete: true, notifyOnError: true, notifyOnConfirm: true,
		soundNotify: true, systemNotify: true, voiceNotify: false,
	}, over || {});
	function setup(live, opts) {
		const enabled = {};
		for (const f of FEATURES) enabled[f.id] = f.id === "notify";
		const listeners = {};
		const doc = {
			visibilityState: "visible", hidden: true,
			body: { tag: "body-stub" },
			head: { appendChild() {} },
			querySelector() { return null; },
			querySelectorAll() { return []; },
			createElement() { return { dataset: {}, isConnected: true }; },
			addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
			removeEventListener() {},
		};
		const status = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, status, undefined, undefined, Object.assign({ document: doc }, opts || {}));
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		let lastHtml = "";
		const poke = async () => {
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setImmediate(resolve));
			lastHtml = await renderSettled(runtime, node);
		};
		return { runtime, node, poke, getHtml: () => lastHtml };
	}
	const finish = async (s, live) => {
		await renderSettled(s.runtime, s.node);
		await s.poke();
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await s.poke();
	};
	let detail = "";
	// 提示音：sound:complete=false 不响；改为 true 后响（playDoneSound 的完成音为 2 个音符）
	try {
		const audio1 = makeAudioStub();
		const live1 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ eventMatrix: { "sound:complete": false } }) };
		const s1 = setup(live1, { globals: { AudioContext: audio1.AudioContext, webkitAudioContext: audio1.AudioContext } });
		await finish(s1, live1);
		if (audio1.notes.length !== 0) detail = "提示音 sound:complete=false 仍响了 " + audio1.notes.length + " 个音符";
		const audio2 = makeAudioStub();
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ eventMatrix: { "sound:complete": true } }) };
		const s2 = setup(live2, { globals: { AudioContext: audio2.AudioContext, webkitAudioContext: audio2.AudioContext } });
		await finish(s2, live2);
		if (!detail && audio2.notes.length < 2) detail = "提示音 sound:complete=true 没有播放完成音（notes=" + audio2.notes.length + "）";
	} catch (e) { detail = "提示音矩阵用例抛错：" + ((e && e.message) || e); }
	// 系统通知：system:complete=false 不弹；改为 true 后弹（页面后台态）
	if (!detail) try {
		const n1 = makeNotificationStub();
		const live1 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ eventMatrix: { "system:complete": false } }) };
		const s1 = setup(live1, { globals: { Notification: n1.Notification } });
		await finish(s1, live1);
		if (n1.sent.length !== 0) detail = "系统通知 system:complete=false 仍发了 " + n1.sent.length + " 条";
		const n2 = makeNotificationStub();
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ eventMatrix: { "system:complete": true } }) };
		const s2 = setup(live2, { globals: { Notification: n2.Notification } });
		await finish(s2, live2);
		if (!detail && n2.sent.length !== 1) detail = "系统通知 system:complete=true 没有发通知（sent=" + n2.sent.length + "）";
	} catch (e) { detail = "系统通知矩阵用例抛错：" + ((e && e.message) || e); }
	// 卡片：card:confirm=false 不弹需确认卡；true 后弹
	if (!detail) try {
		const live1 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [{ id: "mx-1", toolName: "bash", reason: "test" }] })], recent: [], config: baseCfg({ eventMatrix: { "card:confirm": false } }) };
		const s1 = setup(live1);
		await renderSettled(s1.runtime, s1.node);
		await s1.poke();
		if (s1.getHtml().includes("任务需要确认")) detail = "card:confirm=false 仍弹了需确认卡";
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [{ id: "mx-2", toolName: "bash", reason: "test" }] })], recent: [], config: baseCfg({ eventMatrix: { "card:confirm": true } }) };
		const s2 = setup(live2);
		await renderSettled(s2.runtime, s2.node);
		await s2.poke();
		if (!detail && !s2.getHtml().includes("任务需要确认")) detail = "card:confirm=true 没有弹需确认卡";
	} catch (e) { detail = "卡片矩阵用例抛错：" + ((e && e.message) || e); }
	// 语音：eventMatrix 覆盖旧 voiceOn*（true 覆盖 false、false 覆盖 true）
	if (!detail) try {
		const speech1 = makeSpeechStub();
		const live1 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ voiceNotify: true, voiceOnComplete: false, eventMatrix: { "voice:complete": true } }) };
		const s1 = setup(live1, { speech: speech1 });
		await finish(s1, live1);
		if (speech1.spoken.length !== 1) detail = "voice:complete=true 没有覆盖 voiceOnComplete=false";
		const speech2 = makeSpeechStub();
		const live2 = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: baseCfg({ voiceNotify: true, voiceOnComplete: true, eventMatrix: { "voice:complete": false } }) };
		const s2 = setup(live2, { speech: speech2 });
		await finish(s2, live2);
		if (!detail && speech2.spoken.length !== 0) detail = "voice:complete=false 没有覆盖 voiceOnComplete=true";
	} catch (e) { detail = "语音矩阵用例抛错：" + ((e && e.message) || e); }
	if (detail) { console.log(`✗ 通知事件矩阵生效：${detail}`); process.exit(1); }
	console.log("✓ 通知事件矩阵生效：提示音/系统通知/卡片/语音分别按 eventMatrix 独立开关，矩阵值覆盖旧字段");
}

// ---------- 用例 22：【任务通知】页内卡片总开关 + 卡住卡（类型开关 / 主子标注 / 恢复自动收 / 关总开关清卡） ----------
// 用户诉求（2026-10-30）：① 设置面板里能整体关闭右侧通知卡片（关掉后一律不弹，已挂的一并收掉）；
// ② 每类卡片可单独开关（完成 / 异常 / 需确认 / 卡住）；③ 卡住也弹卡——此前只有语音，主任务
//    进行中突然听到「任务卡住了」却看不到任何东西，卡的往往是子任务会话。
{
	const cfgOf = (over) => Object.assign({}, NOTIFY_STATUS.config, over || {});
	function setup(live) {
		const enabled = {};
		for (const f of FEATURES) enabled[f.id] = f.id === "notify";
		const listeners = {};
		const doc = {
			visibilityState: "visible",
			body: { tag: "body-stub" },
			head: { appendChild() {} },
			querySelector() { return null; },
			querySelectorAll() { return []; },
			createElement() { return { dataset: {}, isConnected: true }; },
			addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
			removeEventListener() {},
		};
		const speech = makeSpeechStub();
		const status = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, status, undefined, undefined, { document: doc, speech });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		const poke = async () => {
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setImmediate(resolve));
			await renderSettled(runtime, node);
		};
		return { poke, node, runtime, speech };
	}
	// 卡住任务桩：编程阶段 + 20 秒无活动 + 最后动作 bash（默认按主任务）
	const stalledTask = (over) => Object.assign({}, NOTIFY_STATUS.active[0], {
		phase: "code", approvals: [], lastToolName: "bash",
		lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
	}, over || {});
	// 等收卡淡出（240ms）走完，最多 6 拍 × 300ms；返回仍含关键字的最终 html
	const waitGone = async (render, stillThere) => {
		let html = await render();
		for (let i = 0; i < 6 && stillThere(html); i++) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			html = await render();
		}
		return html;
	};
	let detail = "";
	// —— ① 默认开：卡住 → 弹卡，正文写明主任务、停滞时长、最后动作 ——
	try {
		const live = { active: [stalledTask()], recent: [], config: cfgOf() };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (!html.includes("主任务卡住了")) throw new Error("①卡住没有弹卡（渲染里没有「主任务卡住了」）");
		if (!html.includes("任务：主任务·回归测试任务")) detail = "①卡住卡正文缺主任务与标题";
		else if (!/已停滞：2\d秒/.test(html)) detail = "①卡住卡正文缺停滞时长（没有「已停滞：2x 秒」）";
		else if (!html.includes("最后动作：bash（执行命令）")) detail = "①卡住卡正文缺最后动作（没有「最后动作：bash（执行命令）」）";
	} catch (e) {
		detail = "①卡住弹卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ② 「页内卡片」总开关关 → 所有类型一律不弹（含卡住卡） ——
	if (!detail) try {
		const live = { active: [stalledTask()], recent: [], config: cfgOf({ notifyCards: false }) };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (html.includes("卡住了")) detail = "②页内卡片总开关关闭仍弹了卡住卡";
	} catch (e) {
		detail = "②总开关用例抛错：" + ((e && e.message) || e);
	}
	// —— ③ 类型开关：「卡住提醒」关 → 不弹卡，但语音照播（卡片与耳朵正交） ——
	if (!detail) try {
		const live = { active: [stalledTask()], recent: [], config: cfgOf({ notifyOnStuck: false, voiceNotify: true }) };
		const { runtime, node, poke, speech } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (html.includes("卡住了")) detail = "③卡住提醒关闭仍弹了卡住卡";
		else if (speech.spoken.length < 1) detail = "③关掉卡住卡后语音也哑了（卡片开关不得连坐语音）";
		else if (!/主任务「回归测试任务」卡住了/.test(speech.spoken[speech.spoken.length - 1].text)) {
			detail = "③卡住语音文本不对：" + speech.spoken[speech.spoken.length - 1].text;
		}
	} catch (e) {
		detail = "③类型开关用例抛错：" + ((e && e.message) || e);
	}
	// —— ④ 子任务卡住 → 标题与正文都标「子任务」（主任务在跑时的突然播报要能定位） ——
	if (!detail) try {
		const live = { active: [stalledTask({ isSubtask: true })], recent: [], config: cfgOf() };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (!html.includes("子任务卡住了")) detail = "④子任务卡住卡没有标「子任务」";
		else if (!html.includes("任务：子任务·回归测试任务")) detail = "④子任务卡住卡正文缺子任务与标题";
	} catch (e) {
		detail = "④子任务卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑤ 恢复活动 → 卡住卡自动收起（不靠人点 ✕） ——
	if (!detail) try {
		const live = { active: [stalledTask()], recent: [], config: cfgOf() };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		let html = await renderSettled(runtime, node);
		if (!html.includes("卡住了")) throw new Error("⑤前置条件不成立：没有先弹出卡住卡");
		live.active = [Object.assign({}, live.active[0], { lastActivityAt: Date.now() })]; // 活动恢复
		await poke();
		html = await waitGone(() => renderSettled(runtime, node), (h) => h.includes("卡住了"));
		if (html.includes("卡住了")) detail = "⑤恢复活动后卡住卡没有自动收起";
	} catch (e) {
		detail = "⑤恢复收卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑥ 中途关总开关 → 已挂着的卡也一并收掉 ——
	if (!detail) try {
		const live = { active: [stalledTask()], recent: [], config: cfgOf() };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		let html = await renderSettled(runtime, node);
		if (!html.includes("卡住了")) throw new Error("⑥前置条件不成立：没有先弹出卡住卡");
		live.config = cfgOf({ notifyCards: false }); // 设置面板里关掉「页内卡片」
		await poke();
		html = await waitGone(() => renderSettled(runtime, node), (h) => h.includes("卡住了"));
		if (html.includes("卡住了")) detail = "⑥关掉页内卡片总开关后，已挂出的卡没有收起";
	} catch (e) {
		detail = "⑥关总开关收卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑦ 主任务在等子任务（子任务会话活跃）→ 不算卡住；子任务未关联到主会话时仍正常报 ——
	// 2026-11-01 用户反馈：主任务派发子任务后自己安静，被误报「主任务卡住了」；此刻主会话只是
	// 在等子代理回话，应交给子任务自己判定（真卡在子任务上会说「子任务…卡住了」）。
	if (!detail) try {
		const voiceCfg = cfgOf({ voiceNotify: true, voiceMode: "brief" });
		// ⑦a：子任务活跃且 parentSessionId 指向主会话 → 主任务不报卡住（语音与卡片都不弹）
		let s = setup({
			active: [
				stalledTask({ sessionId: "root-1" }),
				stalledTask({ isSubtask: true, parentSessionId: "root-1", sessionId: "sub-1", lastActivityAt: Date.now(), phaseAt: Date.now() }),
			],
			recent: [], config: voiceCfg,
		});
		await renderSettled(s.runtime, s.node);
		await s.poke();
		let html = await renderSettled(s.runtime, s.node);
		if (html.includes("主任务卡住了")) detail = "⑦a主任务在等子任务时仍报了「主任务卡住了」";
		else if (html.includes("子任务卡住了")) detail = "⑦a子任务活跃时被误报「子任务卡住了」";
		else if ((s.speech.spoken || []).some((x) => /卡住了/.test(x.text || ""))) detail = "⑦a主任务在等子任务时仍语音播报「卡住了」";
		// ⑦b：同样的安静主任务，但子任务没把它记成父亲（parentSessionId 不指向它）→ 仍应正常报卡住
		if (!detail) {
			s = setup({
				active: [
					stalledTask({ sessionId: "root-1" }),
					stalledTask({ isSubtask: true, parentSessionId: "someone-else", sessionId: "sub-2", lastActivityAt: Date.now(), phaseAt: Date.now() }),
				],
				recent: [], config: voiceCfg,
			});
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (!html.includes("主任务卡住了")) detail = "⑦b子任务未关联到主会话时，主任务卡住被错误吞掉";
		}
	} catch (e) {
		detail = "⑦主任务等子任务用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑧ 停在原地等人（等批准 / 等回答）不算卡住 ——
	// 真实事故（2026-11-01 用户反馈，截图为证）：会话调 ask_user_question 挂起等人选答案，
	// 界面显示提问表单，任务通知却播「主任务卡住了」并弹卡。根因是卡住判定只把 approvals
	// 当「等人」，提问（questions）没算——提问期间会话零事件（实测 66 秒零事件），18 秒安静
	// 就被当成停滞。这里锁死两类等待都不报卡住，且回复后该恢复的照常恢复。
	if (!detail) try {
		const voiceCfg = cfgOf({ voiceNotify: true, voiceMode: "brief" });
		// ⑧a：提问挂起（phase=code + 20 秒无活动 + questions 非空）→ 不报卡住
		let s = setup({
			active: [stalledTask({ questions: [{ id: "call_q1", header: "是否自动信任证书", question: "到什么程度？", count: 1 }] })],
			recent: [], config: voiceCfg,
		});
		await renderSettled(s.runtime, s.node);
		await s.poke();
		let html = await renderSettled(s.runtime, s.node);
		if (html.includes("卡住了")) detail = "⑧a提问挂起等人回答时仍弹了「卡住了」卡（把等人的安静当成停滞）";
		else if ((s.speech.spoken || []).some((x) => /卡住了/.test(x.text || ""))) detail = "⑧a提问挂起时仍语音播报「卡住了」";
		// ⑧b：提问挂起 → 弹「任务需要你回答」卡（等人这件事本身要有提醒，不是干脆不管）
		if (!detail) {
			if (!html.includes("任务需要你回答")) detail = "⑧b提问挂起没有弹「需要你回答」卡（等人却毫无提醒）";
			else if (!html.includes("是否自动信任证书")) detail = "⑧b需要你回答卡没有点名问的是什么";
			else if ((s.speech.spoken || []).length < 1) detail = "⑧b提问挂起没有语音播报";
			else if (!/任务需要你回答|等你回答/.test(s.speech.spoken[s.speech.spoken.length - 1].text)) {
				detail = "⑧b提问播报文案不对：" + s.speech.spoken[s.speech.spoken.length - 1].text;
			}
		}
		// ⑧c：提问答完（questions 清空）但仍是同一停点 → 此时该按卡住判定走（沉默不再合法）
		if (!detail) {
			s = setup({
				active: [stalledTask({ questions: [] })],
				recent: [], config: voiceCfg,
			});
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (!html.includes("卡住了")) detail = "⑧c提问答完后（无人在等）的停滞没有被判成卡住（判定被 ⑧a 误伤）";
		}
		// ⑧d：等批准与等回答同时挂 → 两者都不报卡住，且「需确认」卡优先展示批准
		if (!detail) {
			s = setup({
				active: [stalledTask({
					approvals: [{ id: "ap-77", toolName: "bash", reason: "需要批准执行命令" }],
					questions: [{ id: "call_q2", header: "选择方案", question: "用哪种？", count: 1 }],
				})],
				recent: [], config: voiceCfg,
			});
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (html.includes("卡住了")) detail = "⑧d同时等批准与等回答时仍报了卡住";
			else if (!html.includes("任务需要确认")) detail = "⑧d等批准时没有弹「任务需要确认」卡";
		}
	} catch (e) {
		detail = "⑧等人不算卡住用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑨ 正在干活（压缩上下文 / 在飞工具 / 仍在出字）不算卡住 ——
	// 2026-11-02 用户反馈：界面在刷「思考中 / 运行命令 / 上下文已压缩」，通知却反复弹
	// 「主任务卡住了」。实测回放（25 分钟 316 事件）：25 次 ≥18 秒停顿中 18 次落在
	// compaction/start→end 之间（最长 96.7 秒），工具调用最长只有 7.5 秒。判据收敛在
	// src/shared.js 的 taskStalled（taskBusy + taskActivityAt），这里锁死客户端真的用上了它。
	if (!detail) try {
		// ⑨a 压缩窗口内（compacting + 起始时间在有效期内）→ 不报卡住
		let live = { active: [stalledTask({ compacting: true, compactStartedAt: Date.now() - 60000 })], recent: [], config: cfgOf() };
		let s = setup(live);
		await renderSettled(s.runtime, s.node);
		await s.poke();
		let html = await renderSettled(s.runtime, s.node);
		if (html.includes("卡住了")) detail = "⑨a压缩上下文期间仍弹了「卡住了」卡（把正在压缩当成停滞）";
		// ⑨b 在飞工具调用（长命令）→ 不报卡住
		if (!detail) {
			live = { active: [stalledTask({ pendingTool: "bash", toolStartedAt: Date.now() - 30000 })], recent: [], config: cfgOf() };
			s = setup(live);
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (html.includes("卡住了")) detail = "⑨b命令还在跑（在飞调用）时仍弹了「卡住了」卡";
		}
		// ⑨c 仍在出字（lastMotionAt 新、lastActivityAt 旧）→ 不报卡住
		// 老口径只看 lastActivityAt，流式输出的会话会被误判；新口径把「出字/工具动作」也算活动。
		if (!detail) {
			live = { active: [stalledTask({ lastMotionAt: Date.now() - 2000 })], recent: [], config: cfgOf() };
			s = setup(live);
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (html.includes("卡住了")) detail = "⑨c仍在流式出字（lastMotionAt 新）时仍弹了「卡住了」卡";
		}
		// ⑨d 豁免有上限：压缩卡死 3 分钟以上（超过 taskBusy 上限）→ 仍要报卡住
		// 否则「压缩」会变成永远不报警的挡箭牌，真挂死也看不见。
		if (!detail) {
			live = { active: [stalledTask({ compacting: true, compactStartedAt: Date.now() - 200000 })], recent: [], config: cfgOf() };
			s = setup(live);
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (!html.includes("卡住了")) detail = "⑨d压缩卡死超过上限（3 分钟）时没有报卡住（豁免不能无上限）";
		}
		// ⑨e 同理：在飞工具调用超过上限（3 分钟）→ 仍要报卡住
		if (!detail) {
			live = { active: [stalledTask({ pendingTool: "bash", toolStartedAt: Date.now() - 200000 })], recent: [], config: cfgOf() };
			s = setup(live);
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (!html.includes("卡住了")) detail = "⑨e命令卡死超过上限（3 分钟）时没有报卡住（豁免不能无上限）";
		}
		// ⑨f 压缩结束后真安静下来 → 该恢复报卡住（豁免只管压缩窗口，不能把之后的停滞一起吞掉）
		if (!detail) {
			live = { active: [stalledTask({ compacting: true, compactStartedAt: Date.now() - 60000 })], recent: [], config: cfgOf() };
			s = setup(live);
			await renderSettled(s.runtime, s.node);
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (html.includes("卡住了")) throw new Error("⑨f前置条件不成立：压缩期间不应有卡住卡");
			live.active = [stalledTask()]; // 压缩结束、仍无新活动
			await s.poke();
			html = await renderSettled(s.runtime, s.node);
			if (!html.includes("卡住了")) detail = "⑨f压缩结束后真停滞时没有恢复报卡住";
		}
	} catch (e) {
		detail = "⑨正在干活不算卡住用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 任务通知卡片开关与卡住卡：${detail}`); process.exit(1); }
	console.log("✓ 任务通知卡片开关与卡住卡：总开关关则不弹且清已挂卡，类型开关与语音正交，卡住卡带主/子与停滞时长，恢复活动自动收，主任务在等子任务不算卡住，等批准/等回答不算卡住，正在压缩/命令在跑/仍在出字不算卡住但超上限仍报");
}

// ---------- 用例 23：【任务通知】卡片口径三挡（简洁 / 适中 / 详细 × 结束卡 / 需确认卡 / 卡住卡） ----------
// 用户诉求（2026-10-30 续）：右侧通知卡片正文要能选「简洁 / 适中 / 详细」三挡；
// 语音播报同步升三挡（由用例 21 的 ⑦⑧⑨ 覆盖）。卡片缺省 detailed ＝历史内容，
// 老宿主还没下发 cardMode 时卡片不缩水。
{
	const cfgOf = (over) => Object.assign({}, NOTIFY_STATUS.config, over || {});
	function setup(live) {
		const enabled = {};
		for (const f of FEATURES) enabled[f.id] = f.id === "notify";
		const listeners = {};
		const doc = {
			visibilityState: "visible",
			body: { tag: "body-stub" },
			head: { appendChild() {} },
			querySelector() { return null; },
			querySelectorAll() { return []; },
			createElement() { return { dataset: {}, isConnected: true }; },
			addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
			removeEventListener() {},
		};
		const speech = makeSpeechStub();
		const status = () => JSON.parse(JSON.stringify({ active: live.active, recent: live.recent, config: live.config }));
		const { runtime, regs } = loadDock(enabled, ANIMATION_STATUS, status, undefined, undefined, { document: doc, speech });
		const overlays = regs.find((r) => r.def && r.def.id === "dsh-dock-feature-overlays");
		const node = runtime.react.createElement(overlays.comp, null);
		const poke = async () => {
			for (const fn of (listeners.visibilitychange || []).slice()) fn();
			await new Promise((resolve) => setImmediate(resolve));
			await renderSettled(runtime, node);
		};
		return { poke, node, runtime, speech };
	}
	// 跑一轮「任务结束」：活跃登记 → 挪进最近完成 → 弹结束卡
	const endCardHtml = async (over) => {
		const live = { active: [Object.assign({}, NOTIFY_STATUS.active[0], { approvals: [] })], recent: [], config: cfgOf(over) };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		live.active = [];
		live.recent = [Object.assign({}, NOTIFY_STATUS.recent[0], { sessionId: NOTIFY_STATUS.active[0].sessionId })];
		await poke();
		return renderSettled(runtime, node);
	};
	let detail = "";
	// —— ① 结束卡 · 简洁：只有任务与耗时（模型/回合/Token 全部不出现） ——
	try {
		const html = await endCardHtml({ cardMode: "brief" });
		if (!html.includes("任务：上一个任务")) throw new Error("①简洁结束卡缺任务标题行");
		if (!html.includes("耗时：30秒")) detail = "①简洁结束卡缺耗时行（没有「耗时：30秒」）";
		else if (html.includes("模型：")) detail = "①简洁结束卡不该有模型行";
		else if (html.includes("Token：") || html.includes("回合 2")) detail = "①简洁结束卡不该有 Token/回合行";
	} catch (e) {
		detail = "①简洁结束卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ② 结束卡 · 适中：加模型与起止时间，仍无回合/Token/摘要 ——
	if (!detail) try {
		const html = await endCardHtml({ cardMode: "medium" });
		if (!html.includes("模型：deepseek-chat（deepseek）")) detail = "②适中结束卡缺模型行";
		else if (!html.includes("耗时：30秒（")) detail = "②适中结束卡耗时行缺起止时间（应带括号时间）";
		else if (html.includes("Token：") || html.includes("回合 2")) detail = "②适中结束卡不该有 Token/回合行";
	} catch (e) {
		detail = "②适中结束卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ③ 结束卡 · 详细（默认挡）：模型、回合步骤、Token 全量 ——
	if (!detail) try {
		const html = await endCardHtml({});
		if (!html.includes("模型：deepseek-chat（deepseek）")) detail = "③详细结束卡缺模型行（默认挡不该缩水）";
		else if (!html.includes("回合 2 · 步骤 4")) detail = "③详细结束卡缺回合/步骤行";
		else if (!html.includes("Token：输入 3,000 / 输出 1,000")) detail = "③详细结束卡缺 Token 行";
	} catch (e) {
		detail = "③详细结束卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ④ 需确认卡 · 简洁：任务 + 工具，说明与「请确认」提示都不出现 ——
	if (!detail) try {
		const live = {
			active: [Object.assign({}, NOTIFY_STATUS.active[0], {
				approvals: [{ id: "ap-23", toolName: "bash", reason: "需要批准执行命令" }],
			})],
			recent: [],
			config: cfgOf({ cardMode: "brief" }),
		};
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (!html.includes("任务：回归测试任务")) throw new Error("④简洁需确认卡缺任务行");
		if (!html.includes("工具：bash（执行命令）")) detail = "④简洁需确认卡缺工具行";
		else if (html.includes("说明：")) detail = "④简洁需确认卡不该有说明行";
		else if (html.includes("请在会话里确认后继续")) detail = "④简洁需确认卡不该有确认提示行";
	} catch (e) {
		detail = "④简洁需确认卡用例抛错：" + ((e && e.message) || e);
	}
	// —— ⑤ 卡住卡 · 简洁：只有归属·标题行（停滞时长与最后动作不出现），卡片标题照旧 ——
	if (!detail) try {
		const stalled = Object.assign({}, NOTIFY_STATUS.active[0], {
			phase: "code", approvals: [], lastToolName: "bash",
			lastActivityAt: Date.now() - 20000, phaseAt: Date.now() - 20000,
		});
		const live = { active: [stalled], recent: [], config: cfgOf({ cardMode: "brief" }) };
		const { runtime, node, poke } = setup(live);
		await renderSettled(runtime, node);
		await poke();
		const html = await renderSettled(runtime, node);
		if (!html.includes("主任务卡住了")) throw new Error("⑤简洁卡住卡没有弹（标题缺失）");
		if (!html.includes("任务：主任务·回归测试任务")) detail = "⑤简洁卡住卡缺归属·标题行";
		else if (html.includes("已停滞：")) detail = "⑤简洁卡住卡不该有停滞时长行";
		else if (html.includes("最后动作：")) detail = "⑤简洁卡住卡不该有最后动作行";
	} catch (e) {
		detail = "⑤简洁卡住卡用例抛错：" + ((e && e.message) || e);
	}
	if (detail) { console.log(`✗ 任务通知卡片口径三挡：${detail}`); process.exit(1); }
	console.log("✓ 任务通知卡片口径三挡：结束卡/需确认卡/卡住卡按简洁·适中·详细裁剪正文，默认详细不缩水；语音三挡由用例 21 覆盖");
}

// 全部用例都是顶层 await，跑完即终局。显式退出：浮层用例留下的轮询 setTimeout 挂在
// 真实计时器上（沙箱透传 setTimeout），不退出进程就一直吊着（2026-10-27 实测）。
process.exit(0);
