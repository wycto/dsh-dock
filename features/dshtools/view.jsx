// dsh-dock · 功能模块【DSH功能】· 客户端视图
//
// 给 DSH 自带界面补充能力的开关页：分组（例如「文件右键」）× 勾选项。
// 勾选状态存在宿主设置里（features/dshtools/host.js 的 /dsh-dock/dshtools），
// 跨浏览器/跨设备一致；面板页只负责渲染清单与提交单项切换。
//
// 新增能力不需要改这里：宿主清单里加一项，页面就多一个勾选框；
// 行为侧按分组/键名自行接线（见 installClient 里的「文件右键 → 大文件下载」示例）。
//
// 约束（与其它模块一致）：
//   1. fetch 用文档相对路径 "dsh-dock/dshtools"（子路径反代 /ui/ 下自动带前缀）；
//   2. 不引用宿主全局对象，测试可在 node:vm 里跑构建产物；
//   3. 宿主不支持该路由（旧版本）时页面给出提示，右键菜单也绝不出现新条目。
import react from "react";
import { stateOf } from "../../src/shared.js";

const ENDPOINT = "dsh-dock/dshtools";
/** 内置「下载」Remote 的整文件默认上限：超过它的文件才需要本功能的流式下载。 */
export const LARGE_FILE_BYTES = 32 * 1024 * 1024;

// ---------- 配置 Store（面板页与右键菜单共用；变更即通知） ----------
const store = {
	/** 宿主 /dsh-dock/dshtools 是否已成功读过一次：没读过就绝不接管菜单。 */
	ready: false,
	error: "",
	groups: [],
	listeners: new Set(),
	loading: null,
};

function notify() {
	for (const fn of store.listeners) {
		try { fn(); } catch (e) { console.error("[dsh-dock] DSH功能订阅者出错：", e); }
	}
}

/** 订阅配置变化；返回退订函数。 */
export function subscribe(fn) {
	store.listeners.add(fn);
	return () => { store.listeners.delete(fn); };
}

/** 用宿主返回的清单覆盖本地状态；形状不对时保持原状并记错误。 */
function applyPayload(data) {
	const groups = data && data.ok === true && Array.isArray(data.groups) ? data.groups : null;
	if (!groups) {
		store.error = (data && data.error) || "宿主返回的配置格式不正确";
		notify();
		return false;
	}
	store.groups = groups;
	store.error = "";
	store.ready = true;
	notify();
	return true;
}

/** 读一次配置（并发调用共用一个请求；失败后可重试）。 */
export function ensureLoaded() {
	if (store.ready) return Promise.resolve(true);
	if (store.loading) return store.loading;
	if (typeof fetch !== "function") {
		store.error = "当前环境不支持 fetch";
		notify();
		return Promise.resolve(false);
	}
	store.loading = fetch(ENDPOINT, { headers: { accept: "application/json" } })
		.then(async (res) => {
			if (!res.ok) throw new Error("HTTP " + res.status);
			return res.json();
		})
		.then((data) => applyPayload(data))
		.catch(() => {
			// 宿主旧版本（无此路由）/未启用：页面提示，菜单不出现；下次打开可重试。
			store.error = "宿主没有「DSH功能」接口：宿主进程可能是旧版本，或该功能在宿主侧未启用（重启 dsh web，或在功能坞里关掉再打开本功能）";
			notify();
			return false;
		})
		.finally(() => { store.loading = null; });
	return store.loading;
}

/** 某项当前勾选值；不存在返回 undefined。 */
export function valueOf(groupId, key) {
	const group = store.groups.find((g) => g.id === groupId);
	const item = group && Array.isArray(group.items) ? group.items.find((i) => i.key === key) : undefined;
	return item ? item.value === true : undefined;
}

/** 切换单项：提交宿主并同步本地（失败时抛错，由调用方展示）。 */
export async function setValue(groupId, key, value) {
	const res = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ group: groupId, key, value: value === true }),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.ok !== true) {
		throw new Error((data && data.error) || ("HTTP " + res.status));
	}
	applyPayload(data);
}

// ---------- 「文件右键」接线：大文件流式下载 ----------
/** 从 DSH 的原始文件 URL（/api/file?path=…）里取绝对路径；不是该形态返回 undefined。 */
function filePathOf(url) {
	if (typeof url !== "string" || url.length === 0) return undefined;
	let parsed;
	try {
		parsed = new URL(url, document.baseURI);
	} catch (e) {
		return undefined;
	}
	if (typeof location !== "undefined" && parsed.origin !== location.origin) return undefined;
	if (!/\/api\/file$/.test(parsed.pathname)) return undefined;
	const path = parsed.searchParams.get("path");
	return path && path.length > 0 ? path : undefined;
}

/**
 * 探测宿主下载路由是否可用（HEAD 204）。只有探测通过才接管 DSH 自带「下载」，
 * 否则保持原行为——宿主旧版本 / 功能在宿主侧未启用时绝不改变现有下载。
 */
let routeReady = false;
let routeProbe = null;
function ensureRoute() {
	if (routeReady) return Promise.resolve(true);
	if (routeProbe) return routeProbe;
	if (typeof fetch !== "function") return Promise.resolve(false);
	routeProbe = fetch("dsh-dock/download?probe=1", { method: "HEAD", cache: "no-store" })
		.then((res) => { routeReady = res.status === 204 || res.ok === true; return routeReady; })
		.catch(() => false)
		.finally(() => { routeProbe = null; });
	return routeProbe;
}

/** 当前是否接管 DSH 自带的「下载」：功能启用 + 勾选开启 + 宿主下载路由探测通过。 */
function shouldTakeover() {
	const state = stateOf("dshtools");
	if (!state || state.enabled !== true) return false;
	if (valueOf("fileContextMenu", "streamingDownload") === false) return false;
	if (!routeReady) { void ensureRoute(); return false; }
	return true;
}

/**
 * 接管 DSH 自带的「下载」：Web 端下载文件时不再走 workspaceFiles.readBytes 整文件读取
 * （默认 32 MiB 上限，超了只弹「无法保存文件」），改为跳转本模块的流式下载路由。
 * 只替换实例上的 save 方法，其余情况（Desktop、图片、非 /api/file 来源）原样回调。
 * @param {object} actions ui-file-actions 提供的 fileActions 服务实例
 */
function installDownloadTakeover(actions) {
	if (!actions || typeof actions.save !== "function" || actions.__dshDockStreamingDownload === true) return;
	const original = actions.save;
	const wrapped = async function (source, mode) {
		if (mode === "download" && actions.canSaveAs !== true && shouldTakeover()) {
			const path = filePathOf(source && source.url);
			if (path !== undefined) {
				try {
					startDownload(path);
					return { status: "requested" };
				} catch (e) {
					// 落回原下载路径（例如 document 不可用）
				}
			}
		}
		return original.call(actions, source, mode);
	};
	wrapped.__original = original;
	try {
		actions.save = wrapped;
		actions.__dshDockStreamingDownload = true;
	} catch (e) {
		// 服务对象只读：保持 DSH 原行为
	}
}

// ---------- 「文件右键」接线的第一步：大文件下载 ----------
/**
 * 触发浏览器原生下载：URL 走文档相对路径（反代前缀由 base 带入），
 * 响应带 Content-Disposition: attachment，所以只下载、不跳页。
 * @param {string} absolutePath 文件绝对路径
 */
function startDownload(absolutePath) {
	if (typeof document === "undefined" || !document.body) return;
	const base = document.baseURI || (typeof location !== "undefined" ? location.href : "http://localhost/");
	const url = new URL("dsh-dock/download?path=" + encodeURIComponent(absolutePath), base);
	const anchor = document.createElement("a");
	anchor.href = url.href;
	anchor.download = "";
	anchor.rel = "noopener";
	document.body.append(anchor);
	anchor.click();
	anchor.remove();
}

/** 右键「文件」时按文件大小决定是否追加「下载（大文件）」。 */
async function resolveFileMenu(remote, target, signal) {
	const state = stateOf("dshtools");
	if (!state || state.enabled !== true) return [];
	// 首屏配置没取到（宿主刚重启 / 请求失败）时补一次：本次不出现，下次右键就有。
	if (!store.ready) { void ensureLoaded(); return []; }
	if (valueOf("fileContextMenu", "streamingDownload") !== true) return [];
	let result;
	try {
		result = await remote.workspaceFiles.stat(target.sessionId, target.path, signal);
	} catch (e) {
		return []; // 元数据不可用：不提供本项，菜单其余条目照常
	}
	if (!result || result.ok !== true || !result.value) return [];
	const bytes = typeof result.value.bytes === "number" ? result.value.bytes : undefined;
	// 小文件 DSH 自带的「下载」就能用，不重复占位；只有超过整文件上限才出现。
	if (bytes === undefined || bytes <= LARGE_FILE_BYTES) return [];
	const absolutePath = result.value.absolutePath;
	if (typeof absolutePath !== "string" || absolutePath.length === 0) return [];
	return [{
		id: "download-large",
		label: "下载（大文件）",
		icon: { key: "dsh-dock.download" },
		run: () => startDownload(absolutePath),
	}];
}

/** 下载图标（contextMenu.icon 座位用；跟随菜单文字颜色）。 */
function DownloadIcon() {
	return react.createElement("svg", {
		width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true",
	},
	react.createElement("path", {
		d: "M8 2.5v7.2m0 0 2.8-2.8M8 9.7 5.2 6.9M3 13h10",
		stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
	}));
}

/** 取服务：优先属性访问（正常 ctx），再退回 get()（精简 ctx / 测试桩）。 */
function serviceOf(scope, name) {
	if (!scope) return undefined;
	const direct = scope[name];
	if (direct !== undefined) return direct;
	return typeof scope.get === "function" ? scope.get(name) : undefined;
}

/**
 * 在依赖服务就绪后执行；没有 ctx.inject（测试桩 / 极简 ctx）时直接尝试一次。
 * @param {object} ctx Client context
 * @param {string[]} names 依赖的服务名
 * @param {(scope: object) => void} run 装配回调
 */
function onServices(ctx, names, run) {
	if (typeof ctx.inject === "function") {
		try {
			ctx.inject(names, (scope) => run(scope));
			return;
		} catch (e) {
			// 桩 ctx 的 inject 不可用时退回直接取服务
		}
	}
	run(ctx);
}

/**
 * 客户端装配：注册右键菜单与图标。由 src/client.jsx 的 apply() 调一次。
 * 依赖用 ctx.inject 延迟获取（功能坞可能先于 ui-file-actions / ui-context-menu 加载）；
 * 服务缺失（桌面端 / 测试桩）时静默跳过，面板页本身仍可用。
 * @param {object} ctx Client context
 */
export function installClient(ctx) {
	if (!ctx || typeof ctx !== "object") return;
	ensureLoaded();
	onServices(ctx, ["slots"], (scope) => {
		const slots = serviceOf(scope, "slots");
		if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
		slots.inject("contextMenu.icon", function* () {
			yield slots.register({ name: "contextMenu.icon", key: "dsh-dock.download" }, DownloadIcon);
		});
	});
	onServices(ctx, ["contextMenus", "remote.workspaceFiles"], (scope) => {
		const menus = serviceOf(scope, "contextMenus");
		const remote = serviceOf(scope, "remote");
		if (!menus || typeof menus.register !== "function") return;
		if (!remote || !remote.workspaceFiles || typeof remote.workspaceFiles.stat !== "function") return;
		const register = () => menus.register({
			id: "dsh-dock.dshtools.file",
			target: "file",
			// 排在 DSH 自带 file-actions（order 200）之后：同菜单里我们的是补充项。
			order: 210,
			resolve: (target, signal) => resolveFileMenu(remote, target, signal),
		});
		if (typeof scope.effect === "function") scope.effect(register, "dsh-dock: DSH功能 · 文件右键");
		else register();
	});
	// 关键：把 DSH 自带的「下载」也接到流式路由上——用户最常点的是那一条，
	// 不能让他先点旧条目再看到「无法保存文件」。
	ensureRoute();
	onServices(ctx, ["fileActions"], (scope) => {
		const actions = serviceOf(scope, "fileActions");
		if (!actions) return;
		installDownloadTakeover(actions);
		if (typeof scope.effect === "function") {
			scope.effect(() => () => {
				if (actions.__dshDockStreamingDownload !== true) return;
				const restore = actions.save && actions.save.__original;
				if (typeof restore === "function") {
					try { actions.save = restore; } catch (e) { /* 忽略 */ }
				}
				delete actions.__dshDockStreamingDownload;
			}, "dsh-dock: DSH功能 · 下载接管");
		}
	});
}

// ---------- 面板页 ----------
const CSS = [
	".dkht{display:flex;flex-direction:column;gap:12px;}",
	".dkht-intro{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;border:1px dashed var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;}",
	".dkht-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-layer-1);}",
	".dkht-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}",
	".dkht-group-name{font-weight:600;font-size:13px;}",
	".dkht-group-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkht-item{display:flex;gap:10px;align-items:flex-start;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent;transition:background .12s,border-color .12s;}",
	".dkht-item:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	".dkht-item.on{border-color:color-mix(in srgb,var(--dk-accent) 35%,transparent);background:var(--dk-hover-tint);}",
	".dkht-item.busy{opacity:.6;cursor:progress;}",
	".dkht-check{width:15px;height:15px;margin:2px 0 0;accent-color:var(--dk-accent);flex:none;cursor:pointer;}",
	".dkht-text{display:flex;flex-direction:column;gap:2px;min-width:0;}",
	".dkht-name{font-size:12px;font-weight:600;}",
	".dkht-desc{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}",
	".dkht-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6;}",
	".dkht-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;}",
	".dkht-note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6;}",
].join("\n");

/**
 * 面板页：按宿主清单渲染分组与勾选框。
 * @param {{ctx?: object}} props 宿主插槽透传（本页不直接用）
 */
function DshToolsView(props) {
	const [, force] = react.useReducer((n) => n + 1, 0);
	const [busy, setBusy] = react.useState("");
	const [error, setError] = react.useState("");
	react.useEffect(() => {
		const off = subscribe(() => force());
		ensureLoaded().then(() => force());
		return off;
	}, []);
	const toggle = async (group, item) => {
		const id = group.id + "/" + item.key;
		if (busy) return;
		setBusy(id);
		setError("");
		try {
			await setValue(group.id, item.key, item.value !== true);
		} catch (e) {
			setError(e && e.message ? e.message : String(e));
		} finally {
			setBusy("");
		}
	};
	const groups = store.groups;
	return react.createElement("div", { className: "dkht" },
		react.createElement("div", { className: "dkht-intro" },
			"这里给 DSH 自带界面补充能力，按分组逐项勾选；勾选状态保存在功能坞设置里，换浏览器也一致。",
			"取消勾选即完全撤掉对应入口，不影响 DSH 原有功能。"),
		error ? react.createElement("div", { className: "dkht-error" }, error) : null,
		store.error ? react.createElement("div", { className: "dkht-error" }, store.error) : null,
		!store.ready && !store.error
			? react.createElement("div", { className: "dkht-empty" }, "正在读取配置…")
			: null,
		groups.map((group) => react.createElement("div", { className: "dkht-group", key: group.id },
			react.createElement("div", { className: "dkht-group-head" },
				react.createElement("span", { className: "dkht-group-name" }, group.name),
				group.description ? react.createElement("span", { className: "dkht-group-desc" }, group.description) : null),
			group.items.map((item) => {
				const id = group.id + "/" + item.key;
				return react.createElement("label", {
					key: item.key,
					className: "dkht-item" + (item.value === true ? " on" : "") + (busy === id ? " busy" : ""),
				},
					react.createElement("input", {
						type: "checkbox",
						className: "dkht-check",
						checked: item.value === true,
						disabled: busy !== "",
						onChange: () => { void toggle(group, item); },
					}),
					react.createElement("span", { className: "dkht-text" },
						react.createElement("span", { className: "dkht-name" }, item.name),
						item.description ? react.createElement("span", { className: "dkht-desc" }, item.description) : null));
			}))),
		react.createElement("div", { className: "dkht-note" },
			"后续新增的 DSH 增强能力会以新分组/新勾选项出现在这里，无需另外配置。"));
}

export const feature = {
	id: "dshtools",
	name: "DSH功能",
	order: 170,
	accent: "#8b5cf6",
	description: "给 DSH 自带界面补充能力（文件右键等），按分组勾选启用",
	defaultEnabled: true,
	css: CSS,
	View: DshToolsView,
};
