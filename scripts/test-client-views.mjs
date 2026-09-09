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
import { readFileSync } from "node:fs";
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
		if (typeof type === "function") {
			const path = currentPath + "/" + key + "#" + (type.name || "anon");
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
		render(props.children, out, key);
	}
	// render 挂在返回对象上，避免外部重复实现
	return {
		react, jsxRuntime,
		beginPass() { pending.length = 0; cursor = 0; },
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
function makeFetch(animationStatus, notifyStatus, posts, persisted, runstateStatus) {
	return (url, init) => {
		// 只拦截功能开关的同步 POST；功能自己的 RPC 也是 POST，不能一起吃掉
		if (init && init.method === "POST" && String(url).includes("/dsh-dock/features")) {
			posts.push({ url: String(url), body: JSON.parse(init.body || "{}") });
			return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, data: {} }) });
		}
		let data = {};
		if (url.includes("/dsh-dock/animation/status")) data = resolveStatus(animationStatus);
		else if (url.includes("/dsh-dock/notify/status")) data = resolveStatus(notifyStatus);
		else if (url.includes("/dsh-dock/runstate/status")) data = resolveStatus(runstateStatus || RUNSTATE_STATUS);
		else if (url.includes("/dsh-dock/features")) data = { persisted: persisted || {} };
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
let loaded = null;

function loadDock(enabled, animationStatus, notifyStatus, persisted, runstateStatus) {
	const runtime = createRuntime();
	const posts = [];
	const store = { "dsh-dock/features/v1": JSON.stringify(enabled) };
	const win = makeWindow();
	const sandbox = {
		console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
		setTimeout, clearTimeout, setInterval, clearInterval, setImmediate,
		fetch: makeFetch(animationStatus, notifyStatus, posts, persisted, runstateStatus),
		localStorage: {
			getItem: (k) => (k in store ? store[k] : null),
			setItem: (k, v) => { store[k] = String(v); },
			removeItem: (k) => { delete store[k]; },
		},
		window: win,
		document: undefined,
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		cancelAnimationFrame: (id) => clearTimeout(id),
	};
	sandbox.globalThis = sandbox;
	win.localStorage = sandbox.localStorage;
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
	return { runtime, regs, dock, posts };
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

// ---------- 用例：每个内置功能单独启用后，设置页面板必须渲染出内容且不抛错 ----------
const FEATURES = [
	{ id: "animation", name: "任务动画", marker: "运行动画", deep: true },
	{ id: "notify", name: "任务通知", marker: "通知事件", deep: true },
	{ id: "runstate", name: "运行状态", marker: "运行状态", deep: true },
	{ id: "tokenlog", name: "用量记录", marker: "用量", deep: true },
	{ id: "balance", name: "模型余额", marker: "余额", deep: true },
	{ id: "modelconfig", name: "模型设置", marker: "模型", deep: true },
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
		const node = runtime.react.createElement(reg.comp, null);
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
}

if (failed) {
	console.log(`\n${failed} 个内置功能视图渲染失败——内置视图抛错会连带卸载整块面板 UI。`);
	process.exit(1);
}
console.log(`\n全部 ${FEATURES.length} 个内置功能视图渲染正常。`);

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
			const pushes = posts.filter((p) => p.url.includes("/dsh-dock/features")).map((p) => p.body);
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

// 视图里挂的轮询定时器（ctx.interval / setInterval 兜底）会让事件循环不退出，显式收尾。
process.exit(0);
