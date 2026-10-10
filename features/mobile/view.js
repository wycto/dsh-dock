// dsh-dock · 功能模块【手机适配】· 客户端视图
//
// 职责：手机/窄屏下的排版与触控兜底。dsh 布局自身在 <1024px（SIDEBAR_AUTO_COLLAPSE）
// 已有窄屏抽屉，本模块补它没管的几件事：
//   1. 输入类控件字号拉到 16px —— iOS Safari 聚焦任何 <16px 的输入框都会强制放大页面，
//      聊天输入框 14px 字号让手机端每点一次输入框整页就缩放一次，是最影响体验的一件事；
//   2. 触控基础：去点按高亮、touch-action: manipulation（消双击缩放判定延迟），
//      纯图标按钮(唯一子元素为 svg)面积兜底到 ≥36px（实测一批 28×28 的工具钮手机上很难点中）；
//   3. 代码块横向滚动 + 行内代码换行（窄屏不撑破版面）；
//   4. 手机端 chrome：底部 Tab 栏（会话/插件/设置）+ 侧栏抽屉遮罩 + 软键盘让位 +
//      窄屏排版（设置弹层纵排、侧栏浮层化）。这套 chrome 从【远程访问】整体迁到本模块
//      整体迁到本模块——远程访问只负责远程入口本身，本机窄屏同样享有手机适配。
//      顺带给 viewport meta 补 viewport-fit=cover，standalone 模式下 env(safe-area-*) 才有值。
//   5. 滚动兜底：所有纵向滚动体声明 touch-action:pan-y + iOS 惯性滚动；设置弹层内容列
//      补 min-height:0（见 host.js 文件头对「哪都滑不动」两条根因的说明）。
//
// 宿主半部（features/mobile/host.js）经 tapIndex 内联注入同一套样式与行为（重启 dsh web
// 后生效）；本客户端半部在宿主脚本缺位时自建，刷新页面即生效，两者用
// window.__dshDockMobileDrawer 旗标（'host' | 'client'，先到先得）互斥，绝不各建一套。
//
// 开关协议（关键）：dsh-dock 的 css 字段会「无条件」并入全局 <style>（外壳 fullDockCss
// 不区分功能启停），所以本模块的**全局**样式（输入字号/触控面积/代码块/滚动兜底）都挂在
// body[data-dk-mobile="1"] 属性下——该属性由 Overlay 在「功能启用 && 视口命中」时打上、
// 其余情况摘除。停用功能 = 属性消失 = 这些样式一秒还原，不需要 !important 互相拆台。
//
// 例外（有意的）：窄屏 chrome 与滚动体贴底规则包在 @media (max-width:700px) 里，不挂
// body 属性——它们要么只命中本模块自建的 .dsh-mobile-* 元素（停用时元素已移除，规则空转），
// 要么是「窄屏才有意义」的排版修正（滚动体留白/贴底/chip 收起）。这层在 700px 以上完全
// 不生效，桌面与平板不受影响；与迁移前【远程访问】的同款规则行为一致。
//
// 命中条件：窗口宽 ≤820px，或 主指针为粗触且无悬停（真手机/平板）。桌面触屏（主指针 fine）
// 不会误命中；桌面把窗口拖窄到 820px 以下也会命中——这是有意的，方便桌面调试手机效果。
// chrome 自身的工作带宽更窄（≤700px，与宿主半部一致）：820px 平板宽度下不塞底部 Tab 栏。
//
// ⚠️ 命名空间用 dkmob- 前缀：dkm- 已被【模型设置】模块占用，撞了会互相覆盖样式。
import react from "react";
import { useEffect, useState } from "react";
import { openPanel, subscribePanel, panelNav } from "../../src/shared.js";

/** 视口命中条件（任一即视为手机形态）。 */
const MOBILE_QUERY_NARROW = "(max-width: 820px)";
const MOBILE_QUERY_COARSE = "(pointer: coarse) and (hover: none)";
/** 手机端 chrome（底部 Tab 栏/遮罩/窄屏排版）的工作带宽，与宿主编排一致。 */
const MOBILE_QUERY_CHROME = "(max-width: 700px)";

/** 当前视口是否命中手机形态（SSR/无 window 时恒 false）。 */
export function mobileActive() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
	try {
		return window.matchMedia(MOBILE_QUERY_NARROW).matches || window.matchMedia(MOBILE_QUERY_COARSE).matches;
	} catch { return false; }
}

/** 订阅一个 media query，回调即时触发一次，返回取消订阅函数。 */
function watchQuery(query, onChange) {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
	let mq = null;
	try { mq = window.matchMedia(query); } catch { return () => {}; }
	const update = () => onChange(mq.matches);
	update();
	if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
	else if (typeof mq.addListener === "function") mq.addListener(update);
	return () => {
		if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
		else if (typeof mq.removeListener === "function") mq.removeListener(update);
	};
}

// —— Overlay：功能启用期间常驻挂载，负责属性开关、viewport meta 与手机端 chrome ——
// 属性管理放 effect 里（含卸载清理）：功能停用 → Overlay 卸载 → 属性摘除 → 全局样式失效。
export function MobileOverlay() {
	const [active, setActive] = useState(() => mobileActive());

	// 视口命中监听（matchMedia change；老内核降级 addListener）。两条查询任一命中即 active。
	useEffect(() => {
		if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
		let mqs = [];
		try {
			mqs = [window.matchMedia(MOBILE_QUERY_NARROW), window.matchMedia(MOBILE_QUERY_COARSE)];
		} catch { return undefined; }
		const update = () => setActive(mqs.some((mq) => mq.matches));
		update();
		for (const mq of mqs) {
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", update);
			else if (typeof mq.addListener === "function") mq.addListener(update);
		}
		return () => {
			for (const mq of mqs) {
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", update);
				else if (typeof mq.removeListener === "function") mq.removeListener(update);
			}
		};
	}, []);

	// body 属性 = 本模块全部全局样式的总开关；顺带补 viewport-fit=cover（幂等）。
	// 只补不删：cover 在非 standalone 环境无副作用，删了反而让用户自己在 PWA 里的布局抖一次。
	useEffect(() => {
		if (typeof document === "undefined") return undefined;
		if (active) {
			document.body.setAttribute("data-dk-mobile", "1");
			try {
				const meta = document.querySelector('meta[name="viewport"]');
				if (meta && !/(^|,)\s*viewport-fit\s*=/.test(meta.content || "")) {
					meta.setAttribute("content", (meta.content || "width=device-width, initial-scale=1") + ", viewport-fit=cover");
				}
			} catch { /* meta 缺失不致命 */ }
		} else {
			document.body.removeAttribute("data-dk-mobile");
		}
		return () => { document.body.removeAttribute("data-dk-mobile"); };
	}, [active]);

	useEffect(() => mobileChrome(), []);
	return null;
}

// —— 手机端 chrome（客户端自建版）：窄屏 ≤700px 的底部 Tab 栏 + 抽屉遮罩 + 行为 ——
// 直接操作 document.body 下的 DOM——若作为 overlayLayer 的子元素，会落入 overlayLayer
// （z 90）的堆叠上下文，遮罩压不住侧栏抽屉（z 80）、Tab 栏也盖不住内容；挂到 body 下
// z 序才是设计值（遮罩 75 < 侧栏 80 < overlayLayer 90）。
//
// 与宿主 tapIndex 注入版（features/mobile/host.js，重启 dsh web 后才生效）互斥：
// window.__dshDockMobileDrawer 先到先得——宿主脚本在 <head> 先跑并置 'host'，本组件
// 见旗标即整体让位（遮罩/底部 Tab/收起逻辑全归宿主）；宿主未就位（旧版无注入、
// 或刷新早于重启）时本组件自建全套。本组件的价值是 client bundle 按内容 hash 服务、
// 刷新页面即生效，无需重启。
// ⚠️ 两个版本绝不能各建一套：曾出现双底部 Tab 栏（两套按钮叠在一起）与 CSS 互相覆盖。
function mobileChrome() {
	if (typeof window === "undefined" || typeof document === "undefined") return undefined;
	const mq = window.matchMedia ? window.matchMedia(MOBILE_QUERY_CHROME) : null;
	if (!mq) return undefined;
	// 宿主版接管中：整套 chrome 由宿主负责，本组件零副作用退出。
	if (window.__dshDockMobileDrawer === "host") return undefined;
	window.__dshDockMobileDrawer = "client";

	const narrow = () => mq.matches;
	const frameEl = () => document.querySelector('[class$="frame"]');
	const sidebarCollapsed = () => { const f = frameEl(); return !!f && f.hasAttribute("data-sidebar-collapsed") };
	const dialogOpen = () => !!document.querySelector('[role="dialog"][class*="panel"]');
	// 右侧详情面板：dsh 0.1.7 起 detailsCol 改名 rightbarCol，窄屏原生全屏展开
	// （data-sidebar-right-panel / data-sidebar-right-open，折叠钮 data-sidebar-right-toggle）。
	const rightOpen = () => !!document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]');
	const collapse = () => { const b = document.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]'); if (b) b.click() };
	const expand = () => { const b = document.querySelector('button[aria-label="打开侧边栏"],button[aria-label="Open sidebar"]'); if (b) b.click() };
	const closeDetails = () => {
		const panel = document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]');
		if (!panel) return;
		const toggle = panel.querySelector('[data-sidebar-right-toggle]');
		if (toggle) toggle.click();
	};

	// 抽屉遮罩：侧栏展开（浮层态）时盖住页面，点击经全局捕获 handler 收起。
	// 它是全屏 touch-action:none 浮层，收起态必须 display:none——残留一份会让整页滑不动。
	const scrim = document.createElement("div");
	scrim.className = "dsh-mobile-scrim";
	document.body.appendChild(scrim);

	// ---- 仿 ZCode 手机端底部 Tab 栏：会话 / 插件 / 设置 ----
	// 「任务」「功能坞」合并为一个「插件」页签（用户反馈两个入口冗余）：插件面板里
	// 本来就有运行状态页，任务状态以角标显示在「插件」上——进行中蓝色数量、等待确认
	// 红色脉冲；有任务在跑时点「插件」直接落到运行状态页，否则进面板首页。
	// 挂 body（避开 overlayLayer 堆叠上下文），z 序 65：
	// 低于遮罩 75 / 侧栏抽屉 80 / 功能坞面板 200，这些打开时自然盖住 Tab 栏。
	// 走到这里说明宿主未注入——兜底摘一次历史上可能残留的旧 Tab 栏，保证全程只有一份。
	document.querySelectorAll(".dsh-mobile-tabbar").forEach((el) => el.remove());
	const tabbar = document.createElement("nav");
	tabbar.className = "dsh-mobile-tabbar";
	tabbar.setAttribute("aria-label", "底部导航");
	// 最近一次角标轮询看到的任务数（驱动「插件」页签的直达目标与角标显隐）。
	let tasksActive = 0;
	let tasksWaiting = 0;
	const tabDefs = [
		{
			id: "sessions", label: "会话",
			icon: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
			act: () => expand(),
		},
		{
			id: "dock", label: "插件",
			icon: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>',
			act: () => {
				// 始终打开、不再当开关用：若功能坞处于打开态但被原生全屏页/弹层（如从侧栏
				// 进的官方插件管理页）盖住，再点一下会把功能坞关掉、露出的反而是原生页——
				// 看起来就是「点插件出官方插件页」（用户实测截图）。关闭走面板自己的 ✕。
				// 配合手机端把功能坞面板 z 序抬到原生弹层之上（媒体查询内 2000）。
				openPanel((tasksActive > 0 || tasksWaiting > 0) ? "runstate" : "home");
			},
		},
		{
			id: "settings", label: "设置",
			icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.51 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.23.6.86 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></svg>',
			act: () => {
				// 中英文双匹配：aria-label 随 dsh 客户端语言本地化（英文环境是 "Settings"），
				// 只认「设置」会让英文环境的页签点不动（测试实例 en 环境实测）。
				const b = [...document.querySelectorAll("button")].find((x) => {
					const a = x.getAttribute("aria-label") || "";
					return a === "设置" || a === "Settings" || (x.textContent || "").trim() === "设置";
				});
				if (b) b.click()
			},
		},
	];
	let tasksBadge = null;
	const tabButtons = tabDefs.map((def) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = "dsh-mobile-tab";
		b.dataset.tab = def.id;
		b.innerHTML = def.icon + "<span>" + def.label + "</span>";
		b.addEventListener("click", () => def.act());
		if (def.id === "dock") {
			tasksBadge = document.createElement("span");
			tasksBadge.className = "dsh-mobile-tab-badge";
			tasksBadge.style.display = "none";
			b.appendChild(tasksBadge);
		}
		tabbar.appendChild(b);
		return b;
	});
	document.body.appendChild(tabbar);
	const syncTabs = () => {
		const expanded = !sidebarCollapsed();
		const settingsOpen = dialogOpen();
		for (const b of tabButtons) {
			const id = b.dataset.tab;
			const on = (id === "sessions" && expanded)
				|| (id === "dock" && panelNav.open)
				|| (id === "settings" && settingsOpen);
			b.classList.toggle("on", on);
		}
	};
	const unsubPanel = subscribePanel(syncTabs);

	// 「插件」角标：低频轮询 runstate 宿主路由（3s，仅窄屏 + 页面可见时发）；
	// 进行中 = 蓝色数量，等待确认 = 红色数量 + 脉冲。路由不存在（runstate 未启用
	// 或宿主旧版）时静默停轮询并摘掉角标，不报错不打扰。
	let runstateGone = false;
	const pollTasks = () => {
		if (runstateGone || !tasksBadge || !narrow() || document.visibilityState === "hidden" || !tabbar.isConnected) return;
		fetch("dsh-dock/runstate/status", {
			method: "POST", headers: { "content-type": "application/json" }, body: "{}",
		}).then(async (res) => {
			if (res.status === 404 || res.status === 405) { runstateGone = true; tasksActive = 0; tasksWaiting = 0; tasksBadge.style.display = "none"; return null }
			const body = await res.json().catch(() => null);
			if (!body) return null;
			const active = (body.data && body.data.active) || [];
			const waiting = active.filter((t) => t.approvals && t.approvals.length).length;
			tasksActive = active.length;
			tasksWaiting = waiting;
			if (waiting > 0) {
				tasksBadge.textContent = String(waiting);
				tasksBadge.className = "dsh-mobile-tab-badge wait";
				tasksBadge.style.display = "";
			} else if (active.length > 0) {
				tasksBadge.textContent = String(active.length);
				tasksBadge.className = "dsh-mobile-tab-badge";
				tasksBadge.style.display = "";
			} else {
				tasksBadge.style.display = "none";
			}
		}).catch(() => {});
	};
	const tasksTimer = setInterval(pollTasks, 3000);

	// 软键盘判定：visualViewport 与布局视口高度差超阈值视为键盘弹出（挂
	// html.dsh-dock-kbd，样式表随之隐藏 Tab 栏并收窄滚动体留白——打字时
	// 这两样只会挤占键盘上方的一线空间）。老内核没有 visualViewport 就跳过。
	const vv = window.visualViewport || null;
	const kbdSync = () => {
		if (!vv) return;
		const kbd = vv.height > 0 && (window.innerHeight - vv.height) > 120;
		document.documentElement.classList.toggle("dsh-dock-kbd", kbd);
	};

	const sync = () => {
		kbdSync();
		// 兜底摘除历史上可能残留的旧 Tab 栏（正常路径下走到这里说明宿主版未注入，
		// 不会有第二份；保险起见 sync 周期里也保持全局只有一份）。
		document.querySelectorAll(".dsh-mobile-tabbar").forEach((el) => { if (el !== tabbar) el.remove() });
		const on = narrow() && !!frameEl() && !dialogOpen();
		const collapsed = sidebarCollapsed();
		// 右侧详情面板（窄屏原生全屏，z 40）打开时：Tab 栏 65 比它高会压边，整体让位，
		// 面板收起（它自带折叠钮）后再回来。
		const right = rightOpen();
		// 遮罩只在抽屉真的展开时显示——它是全屏 touch-action:none 浮层，
		// 收起态残留会让整页滑不动。
		if (scrim) scrim.style.display = on && !collapsed ? "" : "none";
		tabbar.style.display = narrow() && !!frameEl() && !panelNav.open && !right ? "" : "none";
		syncTabs();
	};
	sync();
	pollTasks();
	// MutationObserver 跟属性翻转即时同步；1.5s 轮询覆盖路由重渲等一切边角
	const observer = typeof MutationObserver !== "undefined" ? new MutationObserver(sync) : null;
	if (observer) observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-sidebar-collapsed"], subtree: true });
	const timer = setInterval(sync, 1500);
	const onMq = () => sync();
	if (mq.addEventListener) mq.addEventListener("change", onMq);
	else if (mq.addListener) mq.addListener(onMq);
	window.addEventListener("resize", kbdSync);
	if (vv && vv.addEventListener) vv.addEventListener("resize", kbdSync);
	const onVisible = () => { if (document.visibilityState === "visible") pollTasks() };
	document.addEventListener("visibilitychange", onVisible);

	// 捕获阶段统一处理：
	// Tab 栏自身排除（否则页签动作会被「点外部收起」当场撤销）；
	// 遮罩不挂自己的 click——它的点击也走这里 collapse()，单一路径防止同一事件两次 toggle。
	const onClick = (e) => {
		if (!narrow()) return;
		const t = e.target;
		if (!t || !t.closest) return;
		if (t.closest(".dsh-mobile-tabbar")) return;
		const expanded = !!document.querySelector('button[aria-label="收起侧边栏"],button[aria-label="Collapse sidebar"]');
		const col = document.querySelector('[class*="sidebarCol"]');
		const inSidebar = col && col.contains(t);
		if (!expanded && !inSidebar) return;
		if (inSidebar) {
			// 只有点「会话」才收抽屉：会话行 data-row-key 以 session: 开头（dsh 0.1.7+ 结构，
			// ui-workspace Rows.tsx）；工作区文件夹行是 workspace: 开头——点它只是展开/收拢
			// 分组，绝不能收抽屉（用户实测「点文件夹抽屉被收起」）。搜索结果行无 data-row-key，
			// 回退按无子叶判定。
			const row = t.closest('[role="treeitem"]');
			const rowKey = (row && row.getAttribute("data-row-key")) || "";
			const sessionRow = (rowKey && rowKey.startsWith("session:"))
				|| (row && !rowKey && !row.querySelector('[role="treeitem"]') && row.closest('[role="tree"]'));
			const fresh = t.closest('[class*="newSession"]');
			if (sessionRow || fresh) { setTimeout(() => { collapse(); closeDetails(); }, 300); return; }
			// 工作区文件夹：只展开/收拢分组，既不收抽屉也不做「面板弹出即收起」探测。
			if (rowKey.startsWith("workspace:")) return;
			// 侧栏入口（插件/自动化任务/设置/记忆/自动进化…）点击后会弹出面板，而面板
			// z 序常低于展开的抽屉——被盖住等于「点了没反应」（用户实测截图）。稍候
			// 探测：有面板弹出就收起抽屉让它露出来；目录折叠/搜索等不弹面板的点击不受影响。
			setTimeout(() => { if (document.querySelector('[role="dialog"]')) collapse(); }, 260);
			return;
		}
		if (t.closest('[role="dialog"],[class*="dockm"],[class*="dgfab"],[class*="dgwin"],[class*="dgame"],[data-sidebar-right-panel]')) return;
		collapse();
	};
	document.addEventListener("click", onClick, true);

	return () => {
		document.removeEventListener("click", onClick, true);
		if (observer) observer.disconnect();
		clearInterval(timer);
		clearInterval(tasksTimer);
		unsubPanel();
		if (mq.removeEventListener) mq.removeEventListener("change", onMq);
		else if (mq.removeListener) mq.removeListener(onMq);
		window.removeEventListener("resize", kbdSync);
		if (vv && vv.removeEventListener) vv.removeEventListener("resize", kbdSync);
		document.removeEventListener("visibilitychange", onVisible);
		document.documentElement.classList.remove("dsh-dock-kbd");
		if (scrim) scrim.remove();
		tabbar.remove();
		if (window.__dshDockMobileDrawer === "client") delete window.__dshDockMobileDrawer;
	};
}

// —— 功能页：状态一览 + 说明 ——
function useViewportSize() {
	const [size, setSize] = useState(() => (typeof window === "undefined" ? null : { w: window.innerWidth, h: window.innerHeight }));
	useEffect(() => {
		if (typeof window === "undefined") return undefined;
		const update = () => setSize({ w: window.innerWidth, h: window.innerHeight });
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return size;
}

function useMobileState() {
	const [active, setActive] = useState(() => mobileActive());
	const [chrome, setChrome] = useState(() => (typeof window === "undefined" || typeof window.matchMedia !== "function"
		? false
		: window.matchMedia(MOBILE_QUERY_CHROME).matches));
	const [owner, setOwner] = useState(() => (typeof window === "undefined" ? null : window.__dshDockMobileDrawer || null));
	useEffect(() => {
		const offChrome = watchQuery(MOBILE_QUERY_CHROME, setChrome);
		let mqs = [];
		try {
			mqs = [window.matchMedia(MOBILE_QUERY_NARROW), window.matchMedia(MOBILE_QUERY_COARSE)];
		} catch { mqs = []; }
		const compute = () => setActive(mqs.some((mq) => mq.matches));
		for (const mq of mqs) {
			if (typeof mq.addEventListener === "function") mq.addEventListener("change", compute);
			else if (typeof mq.addListener === "function") mq.addListener(compute);
		}
		const timer = setInterval(() => setOwner(typeof window === "undefined" ? null : window.__dshDockMobileDrawer || null), 1000);
		return () => {
			offChrome();
			for (const mq of mqs) {
				if (typeof mq.removeEventListener === "function") mq.removeEventListener("change", compute);
				else if (typeof mq.removeListener === "function") mq.removeListener(compute);
			}
			clearInterval(timer);
		};
	}, []);
	return { active, chrome, owner };
}

function MobileView() {
	const { active, chrome, owner } = useMobileState();
	const size = useViewportSize();
	return react.createElement("div", { className: "dkmob-root" },
		react.createElement("div", { className: "dkmob-row" },
			react.createElement("span", { className: "dkmob-label" }, "手机模式"),
			react.createElement("span", { className: "dkmob-state" + (active ? " on" : "") }, active ? "已命中" : "未命中"),
			react.createElement("span", { className: "dkmob-dim" },
				size ? size.w + "×" + size.h + "px" : "",
				"（≤820px 宽，或主指针为触屏无悬停时命中；桌面把窗口拖窄也会命中，方便调试）")),
		react.createElement("div", { className: "dkmob-row" },
			react.createElement("span", { className: "dkmob-label" }, "手机端 chrome"),
			react.createElement("span", { className: "dkmob-state" + (chrome ? " on" : "") }, chrome ? "≤700px，生效中" : "未命中"),
			react.createElement("span", { className: "dkmob-dim" },
				"底部 Tab 栏（会话 / 插件 / 设置）+ 侧栏抽屉遮罩 + 软键盘让位；会话入口在底部「会话」页签，不设左缘浮动按钮。",
				owner === "host" ? "当前由宿主注入版驱动（重启 dsh web 后生效的那套）。" : owner === "client" ? "当前由客户端自建版驱动（刷新即生效）。" : "")),
		react.createElement("div", { className: "dkmob-note" },
			"生效中的优化：输入类控件字号拉到 16px（避免 iOS 聚焦缩放整页）· 纯图标按钮面积兜底 ≥36px · ",
			"去掉点按高亮与双击缩放判定 · 代码块横向滚动、行内代码自动换行 · 滚动体 touch-action:pan-y + iOS 惯性滚动 · ",
			"设置弹层内容列 min-height:0（否则窄屏弹层被内容撑高后整片滑不动）· viewport meta 补 viewport-fit=cover",
			"（standalone 全屏时给圆角/刘海留安全区）。停用本功能即全部还原。"));
}

// —— 首页概要：一行说清当前命中状态 ——
function MobileStat() {
	const { active, chrome } = useMobileState();
	if (!active) return react.createElement("span", null, "当前视口未命中手机形态，样式未注入");
	return react.createElement("span", null, "手机模式生效中 · " + (chrome ? "底部 Tab 栏已接管会话入口" : "chrome 带宽未命中（≤700px 才启用）"));
}

// —— 样式：本模块全部样式（随功能启停；全局部分依赖 body[data-dk-mobile="1"]）。
//     !important 只用在输入字号与 chrome 覆盖上：dsh 组件层对输入框有自己的
//     字号声明，具体度相同的层叠顺序对插件的 <style> 插入时机敏感，这里以内容正确性优先。
//
//     ⚠️ chrome 样式（.dsh-mobile-*）与宿主半部（features/mobile/host.js 的
//     MOBILE_LAYOUT_CSS）保持同款，两半部改一处必须同步另一处；测试
//     scripts/test-mobile-host.mjs 与 scripts/test-client-views.mjs 各自钉契约。 ——
const css = [
	// 输入类控件 16px：防 iOS 聚焦自动放大（<16px 的输入框聚焦时 Safari 强制缩放页面）
	'body[data-dk-mobile="1"] :is(textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="password"], input[type="number"], input[type="email"], [contenteditable="true"]){font-size:16px !important;}',
	// 触控基础：去点按高亮、消双击缩放判定
	'body[data-dk-mobile="1"] :is(button, [role="button"]){-webkit-tap-highlight-color:transparent;touch-action:manipulation;}',
	// 纯图标按钮面积兜底：实测窄屏下一批 28×28 的工具钮很难点中；36px 是不引起行高剧变的上限。
	// 只收「唯一子元素是 svg」的按钮，避免撑坏带文字的行内控件；排除本模块 chrome 按钮。
	'body[data-dk-mobile="1"] button:has(> svg:only-child):not(.dsh-mobile-tab){min-width:36px;min-height:36px;}',
	// 代码块横向滚动、行内代码换行：窄屏不撑破版面
	'body[data-dk-mobile="1"] pre{max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
	'body[data-dk-mobile="1"] code{overflow-wrap:anywhere;}',
	'body[data-dk-mobile="1"] pre code{overflow-wrap:normal;}',
	// 滚动兜底：所有纵向滚动体可纵向平移 + iOS 惯性滚动（祖先合成层/触控声明不再吃掉触摸滚动）。
	'body[data-dk-mobile="1"] :is([class*="scrollBody"], [class*="sidebarCol"] [class*="list"], [role="dialog"] [class*="options"], [class*="dockm-content"]){-webkit-overflow-scrolling:touch;overscroll-behavior-y:contain;touch-action:pan-y;}',
	// iOS 横竖屏切换时的字号自动膨胀关掉（:has 挂到 html 上；dsh 自身样式已依赖 :has，基线足够）
	'html:has(body[data-dk-mobile="1"]){-webkit-text-size-adjust:100%;text-size-adjust:100%;}',
	// 功能页自身
	".dkmob-root{display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;}",
	".dkmob-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dkmob-label{font-weight:600;flex:none;}",
	".dkmob-state{flex:none;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 10px;font-size:11px;}",
	".dkmob-state.on{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}",
	".dkmob-dim{color:var(--dsw-alias-label-secondary);font-size:12px;}",
	".dkmob-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px;}",
	// 手机端 chrome：底部 Tab 栏 + 抽屉遮罩（窄屏 ≤700px；与宿主半部同款）
	"@media (max-width:700px){",
	".dsh-mobile-scrim{position:fixed;inset:0;z-index:75;background:rgba(8,10,14,.45);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);touch-action:none}",
	".dsh-mobile-tabbar{position:fixed;left:0;right:0;bottom:0;z-index:65;display:flex;align-items:stretch;justify-content:space-around;padding:6px 8px calc(8px + env(safe-area-inset-bottom,0px));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#1c2230) 92%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,139,161,.25));touch-action:manipulation}",
	".dsh-mobile-tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;min-height:48px;padding:4px 0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8b95ab);font:600 11px/1.2 inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;border-radius:10px;position:relative}",
	".dsh-mobile-tab svg{width:21px;height:21px;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}",
	".dsh-mobile-tab.on{color:var(--dsw-alias-label-primary,#e6eaf2)}",
	".dsh-mobile-tab.on svg{color:var(--dk-accent,#4d9fff)}",
	".dsh-mobile-tab:active{transform:scale(.94)}",
	".dsh-mobile-tab-badge{position:absolute;top:0;right:calc(50% - 26px);box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:#4d9fff;color:#fff;font-size:10px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;box-shadow:0 2px 8px rgba(0,0,0,.35);pointer-events:none}",
	".dsh-mobile-tab-badge.wait{background:#ef4444;animation:dsh-badge-pulse 1.2s ease-in-out infinite}",
	"@keyframes dsh-badge-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}",
	"@media (prefers-reduced-motion:reduce){.dsh-mobile-tab-badge.wait{animation:none}}",
	// ⚠️ 「设置页滑不动」的关键兜底（客户端无条件携带 = 刷新即生效，不必等宿主重启）：
	// 窄屏把设置弹层改成纵向堆叠后，内容列若是默认 min-height:auto 就会被内容撑高
	// （无头 390×844 实测列高 1216px 塞在 844px 视口里）、再被 .panel 的 overflow:hidden
	// 裁掉——列内滚动容器（[class*=options]）因此 scrollHeight==clientHeight，手指怎么滑
	// 都不动。补 min-height:0 后 scrollTop 0 → 425。宿主半部 MOBILE_LAYOUT_CSS 同款；
	// 两处都写是因为宿主注入要重启 dsh web 才更新，而客户端样式刷新即生效，覆盖窗口期。
	'[role="dialog"][class*="panel"]>[class*="content"]{min-height:0!important}',
	// 输入区吸附到 Tab 栏上方 + 滚动体留白（与宿主半部同款）。
	// ⚠️ 绝不能给滚动体加 justify-content:flex-end/center 贴底：内容会被挤到滚动体
	// 起点之外，Chrome 不把起点方向溢出算进 scrollHeight（手机视口实测
	// scrollHeight==clientHeight、maxScroll==0），会话记录彻底滚不动、首条消息永远看不到。
	// 宿主半部旧版注入里还留着那条 flex-end（要重启 dsh web 才消失），这里用更高优先级
	// 的选择器显式复位：刷新页面即修好，不必等重启。
	'[class*="scrollBody"][data-conversation-scroll]{justify-content:flex-start !important;padding-bottom:calc(72px + env(safe-area-inset-bottom,0px)) !important}',
	'html:not(.dsh-dock-kbd) [class*="scrollBody"]{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px)) !important}',
	'html.dsh-dock-kbd [class*="scrollBody"]{padding-bottom:12px !important}',
	'[class*="scrollBody"]>[class*="composerSeat"]{margin-top:auto;padding-bottom:6px}',
	// 输入区工具行上的 dsh-dock chip（用量/余额）：窄屏下 28cqw 的宽度上限把它们挤成
	// 「…」「余..」（手机实测），既读不出数值又白占输入行空间。手机端整组收起，数值在
	// 底部「插件」里看（用量/余额页信息更全）；桌面端不动。
	'.dockchip-row{display:none}',
	'[class*="sidebarCol"]:has([class*="collapsed"]){visibility:hidden}',
	// ⚠️ 列级 visibility:hidden 在 dsh 0.2.0 上挡不住：工作区浏览器给自己的
	// headerActions/sectionLabel 显式声明 visibility:visible（展开/收拢动画用），visibility
	// 可被后代覆盖，轨道按钮会从隐藏列里「透」出来（实测手机截图左缘游离按钮）。
	// display:none 不可被后代翻转——但只能打在**轨道根节点**上（类名同时含 root 与
	// collapsed 两个语义后缀），绝不能打在列上：frame 是「侧栏 0px + 中列 1fr + 右轨 0px」
	// 的网格，列 display:none 会从网格流里摘掉，中列被自动放置顶进 0px 轨（实测整页空屏）。
	// 弹层打开时豁免（设置弹层挂在列内部，display:none 会连坐成空气弹层），此时列退回
	// visibility 机制（由下一条 [role=dialog] 强制可见），窄屏弹层全屏铺满盖住透出的轨道。
	'[class*="sidebarCol"]:has([class*="collapsed"]):not(:has([role="dialog"])) [class*="root"][class*="collapsed"]{display:none !important}',
	// 设置/插件管理弹层挂在侧栏列内部：上面隐藏整列会把它连坐隐藏（空气弹层）。
	// visibility 可被后代覆盖，弹层关闭态整体卸载，所以只在真正打开时命中。
	'[class*="sidebarCol"]:has([class*="collapsed"]) [role="dialog"]{visibility:visible}',
	'html.dsh-dock-kbd .dsh-mobile-tabbar{display:none !important}',
	// 功能坞面板在手机端抬到原生弹层之上：从侧栏进的官方插件管理页等原生弹层 z 序高于
	// 面板默认的 200，功能坞开在下面会被盖住——「插件」页签点了像没反应/露出原页面。
	'[class*="dockm-backdrop"]{z-index:2000 !important}',
	"}",
].join("\n");

export const feature = {
	id: "mobile",
	name: "手机适配",
	order: 170,
	accent: "#34d399",
	description: "手机/窄屏排版与触控兜底：底部 Tab 栏 + 侧栏抽屉、16px 输入防 iOS 缩放、图标按钮触控面积、代码块滚动、滚动兜底",
	defaultEnabled: true,
	css,
	Overlay: MobileOverlay,
	View: MobileView,
	HomeStat: MobileStat,
};
