// dsh-dock · 功能模块【趣味游戏】· 客户端视图（纯 Client）
// 任务等待期间的十款小游戏（五子棋/中国象棋/俄罗斯方块/推箱子/贪吃蛇/打砖块/极速赛车/坦克大战/星际躲避/反应堆点亮）：功能坞里按类型分组、多封面预览选择，点击封面在局部浮动窗口开玩；
// 屏幕侧边常驻磁吸快捷入口（贴边停靠、上下可拖、左右可换边，位置记忆）；
// 浮动窗口可拖动、可自定义大小、可最大化/最小化，不铺满全屏、不遮会话内容；
// 不写入会话、不改动工作区。
import { useCallback, useEffect, useRef, useState } from "react";
import { panelNav, setPanelOpen, subscribePanel } from "../../src/shared.js";
import { focusStage, useGameControls } from "./games/shared.jsx";
import { tetrisGame } from "./games/tetris.jsx";
import { sokobanGame } from "./games/sokoban.jsx";
import { gomokuGame } from "./games/gomoku.jsx";
import { xiangqiGame } from "./games/xiangqi.jsx";
import { snakeGame } from "./games/snake.jsx";
import { breakoutGame } from "./games/breakout.jsx";
import { racerGame } from "./games/racer.jsx";
import { tankGame } from "./games/tank.jsx";

const LANES = 3;
const REACTOR_NEIGHBORS = [[0, 1, 3], [1, 0, 2, 4], [2, 1, 5], [3, 0, 4, 6], [4, 1, 3, 5, 7], [5, 2, 4, 8], [6, 3, 7], [7, 4, 6, 8], [8, 5, 7]];

// 磁吸入口 / 浮动窗口的几何记忆（localStorage 持久化；值均为视口像素）
const FAB_POS_KEY = "dsh-dock/games/fab/v1"; // { side: "left"|"right", y }
const WIN_GEOM_KEY = "dsh-dock/games/win/v1"; // { x, y, w, h }
const FAB_W = 36, FAB_H = 120; // 与 .dgfab CSS 尺寸对应：未挂载时的钳制估算
const WIN_MIN_W = 360, WIN_MIN_H = 340;

function phaseLabel(phase) {
	return ({ think: "思考中", write: "输出中", code: "编写代码", search: "查资料" })[phase] || "处理中";
}
function elapsedText(ms) {
	const sec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
	const min = Math.floor(sec / 60);
	return min > 0 ? min + " 分 " + String(sec % 60).padStart(2, "0") + " 秒" : sec + " 秒";
}
function makeReactor() {
	let cells = Array(9).fill(true);
	// 固定的可解起手式；每次重置按不同顺序翻转，保留一点随机感但不制造死局。
	const seed = [4, 0, 8, 1, 7, 3];
	for (const index of seed) {
		for (const target of REACTOR_NEIGHBORS[index]) cells[target] = !cells[target];
	}
	return cells;
}
function initialDash() {
	return { lane: 1, rocks: [], score: 0, shield: 3, running: true, nextId: 1 };
}

function useTaskPulse() {
	const [status, setStatus] = useState({ loading: true, active: [], error: false });
	const refresh = useCallback(() => fetch("/dsh-dock/animation/status", {
		method: "POST", headers: { "content-type": "application/json" }, body: "{}",
	}).then((res) => res.json()).then((payload) => {
		if (!payload || !payload.ok) throw new Error("status unavailable");
		setStatus({ loading: false, active: Array.isArray(payload.data && payload.data.active) ? payload.data.active : [], error: false });
	}).catch(() => setStatus((current) => ({ loading: false, active: current.active || [], error: true }))), []);
	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, 2600);
		return () => clearInterval(timer);
	}, [refresh]);
	return status;
}

// ---------- 小游戏本体（面板内嵌与浮动窗口共用一套默认尺寸） ----------
function DashGame(props) {
	const [dash, setDash] = useState(initialDash);
	// 窗口最小化或展开选择层时暂停陨石；页面切到后台也不扣护盾。
	const pausedRef = useRef(!!(props && props.paused));
	pausedRef.current = !!(props && props.paused);
	const move = useCallback((delta) => setDash((current) => Object.assign({}, current, {
		lane: Math.max(0, Math.min(LANES - 1, current.lane + delta)),
	})), []);
	const stageRef = useRef(null);
	const onKeyDown = useCallback((event) => {
		if (event.key === "ArrowLeft" || event.key.toLowerCase() === "a") { event.preventDefault(); move(-1); }
		else if (event.key === "ArrowRight" || event.key.toLowerCase() === "d") { event.preventDefault(); move(1); }
		else if (!dash.running && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); setDash(initialDash()); }
	}, [move, dash.running]);
	useGameControls(stageRef, props.paused, onKeyDown);
	useEffect(() => {
		const timer = setInterval(() => {
			if (pausedRef.current || (typeof document !== "undefined" && document.hidden)) return;
			setDash((current) => {
				if (!current.running) return current;
				let gained = 0;
				let hit = false;
				const rocks = [];
				for (const rock of current.rocks) {
					const next = Object.assign({}, rock, { row: rock.row + 1 });
					if (next.row >= 4) {
						if (next.lane === current.lane) hit = true;
						else gained += 1;
					} else rocks.push(next);
				}
				const shield = hit ? current.shield - 1 : current.shield;
				if (Math.random() > .32) rocks.push({ id: current.nextId, lane: Math.floor(Math.random() * LANES), row: 0 });
				return {
					lane: current.lane, rocks, score: current.score + gained, shield,
					running: shield > 0, nextId: current.nextId + 1,
				};
			});
		}, 620);
		return () => clearInterval(timer);
	}, []);
	const cells = [];
	for (let row = 0; row < 5; row += 1) {
		for (let lane = 0; lane < LANES; lane += 1) {
			const rock = dash.rocks.find((item) => item.row === row && item.lane === lane);
			const pilot = row === 4 && lane === dash.lane;
			cells.push(<span className="dgame-dash-cell" key={row + "-" + lane}>{rock ? <i className="dgame-rock">◆</i> : null}{pilot ? <b className="dgame-pilot">▲</b> : null}</span>);
		}
	}
	return <section className="dgame-game" aria-label="星际躲避小游戏">
		<div className="dgame-game-head"><div><h3>星际躲避</h3><p>左右移动补给艇，避开正在坠落的陨石。</p></div><div className="dgame-score"><span>得分 <strong>{dash.score}</strong></span><span aria-label={"护盾 " + dash.shield + " 格"}>护盾 {"✦".repeat(Math.max(0, dash.shield))}{"·".repeat(Math.max(0, 3 - dash.shield))}</span></div></div>
		<div className="dgame-dash-stage" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} aria-label="星际躲避游戏区域，使用左右方向键或下方按钮移动">
			<div className="dgame-dash-grid">{cells}</div>
			{!dash.running ? <div className="dgame-over"><strong>护盾耗尽</strong><button type="button" onClick={() => setDash(initialDash())}>重新出发</button></div> : null}
		</div>
		<div className="dgame-controls"><button type="button" aria-label="向左移动" onClick={() => move(-1)}>← 左移</button><span>方向键 / A、D · 空格重开</span><button type="button" aria-label="向右移动" onClick={() => move(1)}>右移 {'->'}</button></div>	</section>;
}

function ReactorGame(props) {
	const [cells, setCells] = useState(makeReactor);
	const [moves, setMoves] = useState(0);
	const [cursor, setCursor] = useState(4); // 键盘光标：默认停在中格
	const gridRef = useRef(null);
	const solved = cells.every(Boolean);
	const toggle = (index) => {
		if (solved) return;
		setCells((current) => current.map((on, target) => REACTOR_NEIGHBORS[index].includes(target) ? !on : on));
		setMoves((current) => current + 1);
	};
	const reset = () => { setCells(makeReactor()); setMoves(0); };
	// 方向键在 3×3 内移动光标；Enter/空格 点亮；R 重置。
	const moveCursor = (dRow, dCol) => setCursor((c) => {
		const row = Math.min(2, Math.max(0, Math.floor(c / 3) + dRow));
		const col = Math.min(2, Math.max(0, (c % 3) + dCol));
		return row * 3 + col;
	});
	const onKeyDown = (event) => {
		const key = event.key;
		if (key === "ArrowLeft") { event.preventDefault(); moveCursor(0, -1); }
		else if (key === "ArrowRight") { event.preventDefault(); moveCursor(0, 1); }
		else if (key === "ArrowUp") { event.preventDefault(); moveCursor(-1, 0); }
		else if (key === "ArrowDown") { event.preventDefault(); moveCursor(1, 0); }
		else if (key === "Enter" || key === " ") { event.preventDefault(); toggle(cursor); }
		else if (key.toLowerCase() === "r") { event.preventDefault(); reset(); }
	};
	useGameControls(gridRef, props.paused, onKeyDown);
	return <section className="dgame-game" aria-label="反应堆点亮小游戏">
		<div className="dgame-game-head"><div><h3>反应堆点亮</h3><p>点一下会切换相邻模块，把九个模块全部点亮；键盘：方向键选格、Enter/空格 点亮、R 重置。</p></div><div className="dgame-score"><span>操作 <strong>{moves}</strong></span><button type="button" onClick={reset}>重置</button></div></div>
		<div className="dgame-reactor" ref={gridRef} tabIndex={0} role="group" aria-label="九宫格反应堆" onKeyDown={onKeyDown} onClick={() => focusStage(gridRef)}>
			{cells.map((on, index) => <button type="button" key={index} tabIndex={-1} className={"dgame-reactor-cell" + (on ? " on" : "") + (cursor === index ? " focus" : "")} aria-current={cursor === index ? "true" : undefined} aria-label={(on ? "已点亮" : "未点亮") + "模块 " + (index + 1)} onClick={() => { toggle(index); setCursor(index); focusStage(gridRef); }}><i /></button>)}
		</div>
		<div className={"dgame-reactor-status" + (solved ? " solved" : "")}>{solved ? "反应堆稳定运行 · 做得漂亮（R 重新开始）" : "让所有模块发光，给任务一点能量"}</div>
	</section>;
}

// ---------- 游戏目录：封面预览 + 描述（与任务动画的模式卡同一套交互语言） ----------
function DashCover() {
	return <span className="dgcov-prev dgcov-prev-dash" aria-hidden="true"><i /><i /><i /><b /></span>;
}
function ReactorCover() {
	return <span className="dgcov-prev dgcov-prev-reactor" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} />)}</span>;
}

const GAMES = [
	{
		id: "dash", name: "星际躲避", cat: "casual", accent: "#38bdf8",
		desc: "左右移动补给艇，避开坠落的陨石；护盾耗尽前能拿多少分？",
		tip: "←/→ 或 A、D 移动 · 空格重开",
		Game: DashGame, Preview: DashCover,
	},
	{
		id: "reactor", name: "反应堆点亮", cat: "casual", accent: "#a78bfa",
		desc: "点一下会翻转相邻模块，把九个模块全部点亮，让反应堆稳定运行；键盘全程可玩。",
		tip: "方向键选格 · Enter/空格 点亮 · R 重置",
		Game: ReactorGame, Preview: ReactorCover,
	},
	{
		id: "gomoku", name: "五子棋", cat: "board", accent: "#38bdf8",
		desc: "你执黑先手、AI 执白；先在横竖斜任一方向连成五子者胜。",
		tip: "点击空位落子 · 撤销 / 重开",
		Game: gomokuGame.Game, Preview: gomokuGame.Preview,
	},
	{
		id: "xiangqi", name: "中国象棋", cat: "board", accent: "#f87171",
		desc: "你执红先行、AI 执黑；吃光对方将/帅即胜，别送王被将。",
		tip: "选中红子再点落点 · R 重开 · U 撤销",
		Game: xiangqiGame.Game, Preview: xiangqiGame.Preview,
	},
	{
		id: "tetris", name: "俄罗斯方块", cat: "classic", accent: "#22d3ee",
		desc: "经典机台第一款：拼满一行消除得分，速度随等级加快。",
		tip: "←/→ 移动 · ↓ 下落 · ↑/X 旋转 · 空格 直落 · P 暂停",
		Game: tetrisGame.Game, Preview: tetrisGame.Preview,
	},
	{
		id: "sokoban", name: "推箱子", cat: "classic", accent: "#facc15",
		desc: "把箱子全部推到目标点上通关；六关难度递增。",
		tip: "方向键移动 · U 撤销 · R 重置 · 数字切关",
		Game: sokobanGame.Game, Preview: sokobanGame.Preview,
	},
	{
		id: "snake", name: "贪吃蛇", cat: "classic", accent: "#4ade80",
		desc: "吃到食物变长并加速；撞墙或咬到自己就结束。",
		tip: "方向键 / WASD 移动 · P 暂停 · R 重开",
		Game: snakeGame.Game, Preview: snakeGame.Preview,
	},
	{
		id: "breakout", name: "打砖块", cat: "classic", accent: "#38bdf8",
		desc: "移动挡板反弹小球，击碎全部砖块；球掉到底部丢一条命。",
		tip: "←/→ 或鼠标移动 · 空格发球",
		Game: breakoutGame.Game, Preview: breakoutGame.Preview,
	},
	{
		id: "racer", name: "极速赛车", cat: "classic", accent: "#fb923c",
		desc: "避开迎面来车、收集金币，越开越快；撞车即结束。",
		tip: "←/→ 或鼠标移动 · R 重开",
		Game: racerGame.Game, Preview: racerGame.Preview,
	},
	{
		id: "tank", name: "坦克大战", cat: "classic", accent: "#fde047",
		desc: "击毁敌方坦克、守住中央基地；清空一波进入下一波。",
		tip: "方向键移动 · 空格开炮 · R 重开",
		Game: tankGame.Game, Preview: tankGame.Preview,
	},
];

// ---- 浮动窗口启动总线：面板封面 / 磁吸快捷入口 / 窗口内换游戏共用一份状态 ----
// state: { open, game, picker } -- open=窗口是否显示；game=当前游戏 id（关窗后仍记忆）；picker=窗口内选择层
const gamesBus = {
	state: { open: false, game: null, picker: false },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	emit() { for (const fn of this.listeners) fn(); },
	launch(id) {
		if (!GAMES.some((g) => g.id === id)) return;
		this.state = { open: true, game: id, picker: false };
		this.emit();
	},
	// 快捷入口点击：上次玩过的直接续玩，否则先展开选择层。
	entry() {
		this.state = { open: true, game: this.state.game, picker: this.state.game ? false : true };
		this.emit();
	},
	togglePicker() {
		this.state = Object.assign({}, this.state, { picker: !this.state.picker });
		this.emit();
	},
	closePicker() {
		this.state = Object.assign({}, this.state, { picker: false });
		this.emit();
	},
	close() {
		this.state = { open: false, game: this.state.game, picker: false };
		this.emit();
	},
};
function useGameWin() {
	const [state, setState] = useState(gamesBus.state);
	useEffect(() => gamesBus.subscribe(() => setState(gamesBus.state)), []);
	return state;
}

// ---------- 封面网格：功能坞面板页与窗口选择层共用（按类型分组） ----------
const CATS = [
	{ id: "board", label: "棋盘对战", desc: "你与 AI 对弈" },
	{ id: "classic", label: "经典机台", desc: "俄罗斯方块游戏机里的怀旧游戏" },
	{ id: "casual", label: "休闲益智", desc: "等任务时顺手来一把" },
];
function GameCoverGrid(props) {
	const currentId = props && props.currentId;
	return <div className="dgcov-groups">
		{CATS.map((cat) => {
			const list = GAMES.filter((g) => (g.cat || "casual") === cat.id);
			if (!list.length) return null;
			return <div key={cat.id} className="dgcov-section">
				<div className="dgcov-sechead"><b>{cat.label}</b><span>{cat.desc}</span><em>{list.length} 款</em></div>
				<div className="dgcov-grid" role="list">
					{list.map((g) => (
						<button type="button" key={g.id} role="listitem" className={"dgcov" + (currentId === g.id ? " on" : "")}
							onClick={() => props.onLaunch(g.id)}>
							<g.Preview />
							<span className="dgcov-name"><i style={{ background: g.accent }} />{g.name}<em>{currentId === g.id ? "正在玩" : "开玩"}</em></span>
							<span className="dgcov-desc">{g.desc}</span>
						</button>
					))}
				</div>
			</div>;
		})}
	</div>;
}

// ---------- 窗口任务状态胶囊（标题栏随身提示） ----------
function TaskPill({ status }) {
	if (status.loading) return <span className="dgwin-task">正在读取任务状态…</span>;
	const task = status.active[0];
	if (!task) return <span className="dgwin-task idle"><i />任务空闲 · 慢慢玩</span>;
	return <span className="dgwin-task live"><i /><b>{status.active.length} 个任务</b>{phaseLabel(task.phase)} · {elapsedText(task.elapsed)}</span>;
}

// ---------- 浮动窗口几何：持久化 + 视口内钳制 ----------
function readFabSide() {
	try {
		const p = JSON.parse(localStorage.getItem(FAB_POS_KEY) || "null");
		return p && (p.side === "left" || p.side === "right") ? p.side : "left";
	} catch { return "left"; }
}
function defaultWinGeom() {
	const w = Math.min(470, window.innerWidth - 16);
	const h = Math.min(600, window.innerHeight - 16);
	// 默认停靠在快捷入口所在的一侧，形成「从入口展开」的空间延续感。
	// 「左」档现在钉在宿主侧栏右缘（不压工作区目录），窗口也随之靠侧栏右侧展开。
	const x = readFabSide() === "right"
		? Math.max(10, window.innerWidth - w - 14)
		: Math.min(Math.max(10, sidebarRightEdge() + 10), Math.max(10, window.innerWidth - w - 14));
	return { mode: "normal", x, y: Math.max(10, Math.round((window.innerHeight - h) / 2) - 10), w, h };
}
function restoreWinGeom() {
	try {
		const g = JSON.parse(localStorage.getItem(WIN_GEOM_KEY) || "null");
		if (g && [g.x, g.y, g.w, g.h].every((v) => typeof v === "number")) {
			const w = Math.max(WIN_MIN_W, Math.min(g.w, window.innerWidth - 16));
			const h = Math.max(WIN_MIN_H, Math.min(g.h, window.innerHeight - 16));
			return {
				mode: "normal",
				x: Math.min(Math.max(8, g.x), Math.max(8, window.innerWidth - w - 8)),
				y: Math.min(Math.max(8, g.y), Math.max(8, window.innerHeight - h - 8)),
				w, h,
			};
		}
	} catch { /* 记录损坏时走默认几何 */ }
	return defaultWinGeom();
}

// 找到宿主侧栏列元素：磁吸入口挂在 shell.overlay（宿主 AppFrame 网格的浮层 [data-shell-overlay]），
// 其父级即宿主三栏 AppFrame，网格第一个格子便是左侧栏列（sidebar / center / details）。
function findSidebarCol() {
	if (typeof document === "undefined") return null;
	const overlay = document.querySelector("[data-shell-overlay]");
	const frame = overlay && overlay.parentElement;
	if (!frame) return null;
	return frame.children[0] || null;
}
// 宿主侧栏右缘（视口像素）：「左」档磁吸钉在侧栏右缘而非屏幕左缘，避免挡住工作区目录。
function sidebarRightEdge() {
	const col = findSidebarCol();
	if (col) {
		const rect = col.getBoundingClientRect();
		if (rect && typeof rect.right === "number") return rect.right;
	}
	// 兜底：宿主侧栏默认宽度（264–420 可拖，取 280），侧栏元素通常总能找到。
	return 280;
}
// 磁吸档位 → 停靠 X：left = 侧栏右缘；right = 屏幕右缘。
function snapFabX(side) {
	if (typeof window === "undefined") return 0;
	return side === "right" ? Math.max(0, window.innerWidth - FAB_W) : sidebarRightEdge();
}

// ---------- 浮动游戏窗口：标题栏拖动、右下角缩放、最大化/最小化，Esc 关窗 ----------
function GameWindow(props) {
	const game = props.game;
	const status = useTaskPulse();
	const [win, setWin] = useState(() => (typeof window === "undefined" ? { mode: "normal", x: 14, y: 14, w: 470, h: 600 } : restoreWinGeom()));
	const winRef = useRef(win);
	winRef.current = win;
	// Esc：先收窗口内选择层，再关窗口。
	const pickerRef = useRef(props.picker);
	pickerRef.current = props.picker;
	useEffect(() => {
		const onKey = (e) => {
			if (e.key !== "Escape") return;
			if (pickerRef.current) gamesBus.closePicker();
			else gamesBus.close();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	function persistGeom(s) {
		try { localStorage.setItem(WIN_GEOM_KEY, JSON.stringify({ x: s.x, y: s.y, w: s.w, h: s.h })); } catch { /* 持久化失败静默 */ }
	}
	// 标题栏拖动（最大化时固定）/ 右下角缩放；边界钳制在视口内。
	function beginDrag(e, kind) {
		if (e.button !== 0 || typeof window === "undefined") return;
		if (kind === "move" && (winRef.current.mode === "max" || (e.target && e.target.closest && e.target.closest("button")))) return;
		const startX = e.clientX, startY = e.clientY;
		const origin = Object.assign({}, winRef.current);
		const onMove = (ev) => {
			const dx = ev.clientX - startX, dy = ev.clientY - startY;
			if (kind === "move") setWin((s) => Object.assign({}, s, {
				x: Math.min(Math.max(8, origin.x + dx), Math.max(8, window.innerWidth - origin.w - 8)),
				y: Math.min(Math.max(8, origin.y + dy), Math.max(8, window.innerHeight - origin.h - 8)),
			}));
			else setWin((s) => Object.assign({}, s, {
				// 窗口高度随内容自适应，缩放只调宽度；游戏板按比例跟随缩放。
				w: Math.max(WIN_MIN_W, Math.min(origin.w + dx, window.innerWidth - 16)),
			}));
		};
		const onUp = () => {
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			setWin((s) => { persistGeom(s); return s; });
		};
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}
	const Game = game && game.Game;
	// 最大化：铺满视口（四周留 10px）；最小化：折叠成标题栏；普通：固定坐标，高度随内容自适应（不裁切）；
	// 选择层打开时给固定舒适高度，列表内部滚动（避免内容稀疏导致窗口过矮）。
	const style = win.mode === "max"
		? { left: 10, top: 10, right: 10, bottom: 10, width: "auto", height: "auto" }
		: { left: win.x, top: win.y, width: win.w, height: props.picker ? "min(76vh, 640px)" : "auto" };
	return <div className={"dgwin dgwin-" + win.mode} role="dialog" aria-label={"游戏窗口：" + (game ? game.name : "趣味游戏")} style={style}>
		<header className="dgwin-bar"
			onPointerDown={(e) => beginDrag(e, "move")}
			onDoubleClick={() => setWin((s) => Object.assign({}, s, { mode: s.mode === "max" ? "normal" : "max" }))}>
			<span className="dgwin-ico"><GamepadIcon size={15} /></span>
			<div className="dgwin-title"><b>{game ? game.name : "趣味游戏"}</b><span>{game ? game.desc : "选一款小游戏，边等边玩"}</span></div>
			<TaskPill status={status} />
			<div className="dgwin-ctrls">
				<button type="button" className="dgwin-btn" title={props.picker ? "收起选择层，回到游戏" : "展开选择层，换一款游戏"} onClick={() => gamesBus.togglePicker()}>{props.picker ? "返回" : "换游戏"}</button>
				<button type="button" className="dgwin-sq" title={win.mode === "min" ? "还原" : "最小化"} aria-label={win.mode === "min" ? "还原窗口" : "最小化窗口"} onClick={() => setWin((s) => Object.assign({}, s, { mode: s.mode === "min" ? "normal" : "min" }))}>▁</button>
				<button type="button" className="dgwin-sq" title={win.mode === "max" ? "还原" : "最大化"} aria-label={win.mode === "max" ? "还原窗口" : "最大化窗口"} onClick={() => setWin((s) => Object.assign({}, s, { mode: s.mode === "max" ? "normal" : "max" }))}>{win.mode === "max" ? "❐" : "▢"}</button>
				<button type="button" className="dgwin-sq" title="关闭（Esc）" aria-label="关闭游戏窗口" onClick={() => gamesBus.close()}>✕</button>
			</div>
		</header>
		<div className="dgwin-body">
			{Game ? <Game paused={props.picker || win.mode === "min"} /> : <div className="dgwin-empty">从「换游戏」里挑一款开始玩。</div>}
			{game ? <footer className="dgwin-tip">{game.tip} · Esc 关闭窗口</footer> : null}
			{props.picker ? <div className="dgwin-picker" role="dialog" aria-label="选择小游戏">
				<div className="dgwin-picker-head">
					<div><b>选择小游戏</b><span>点击封面开玩；窗口位置和大小随你调</span></div>
					<button type="button" className="dgwin-picker-close" aria-label="关闭选择层" title="关闭" onClick={() => gamesBus.closePicker()}>✕</button>
				</div>
				<GameCoverGrid currentId={game && game.id} onLaunch={(id) => gamesBus.launch(id)} />
			</div> : null}
		</div>
		{win.mode === "normal" ? <div className="dgwin-resize" title="拖动调整窗口大小" aria-hidden="true" onPointerDown={(e) => beginDrag(e, "size")} /> : null}
	</div>;
}

// ---------- 磁吸悬浮入口：左档贴侧栏右缘、右档贴屏幕右缘，上下可拖，松手磁吸到最近一侧并记忆 ----------
function GameFab(props) {
	const [pos, setPos] = useState(null); // null=未初始化（SSR/首帧不渲染）
	const [dragging, setDragging] = useState(false);
	const dragRef = useRef(null); // { sx, sy, ox, oy, w, h, moved }
	const clickBlockRef = useRef(false);
	const sideRef = useRef("left"); // 当前磁吸档位（左=侧栏右缘 / 右=屏幕右缘），供尺寸变化时重算停靠点
	useEffect(() => {
		if (typeof window === "undefined") return;
		let next = { side: "left", y: Math.round(window.innerHeight * .34) };
		try {
			const p = JSON.parse(localStorage.getItem(FAB_POS_KEY) || "null");
			if (p && (p.side === "left" || p.side === "right") && typeof p.y === "number") next = { side: p.side, y: p.y };
		} catch { /* storage 不可用走默认位 */ }
		sideRef.current = next.side;
		setPos({
			side: next.side,
			x: snapFabX(next.side),
			y: Math.min(Math.max(8, next.y), Math.max(8, window.innerHeight - FAB_H - 8)),
		});
	}, []);
	// 磁吸跟随：窗口缩放/侧栏拖宽或折叠时，重算停靠 X（左档钉侧栏右缘、右档钉屏幕右缘）。
	useEffect(() => {
		if (typeof window === "undefined") return;
		const update = () => {
			if (dragRef.current) return; // 拖动中不打断自由跟随
			setPos((cur) => cur ? Object.assign({}, cur, { x: snapFabX(cur.side) }) : cur);
		};
		const resizeTarget = findSidebarCol();
		let ro = null;
		if (typeof ResizeObserver !== "undefined" && resizeTarget) {
			ro = new ResizeObserver(update);
			ro.observe(resizeTarget);
		}
		window.addEventListener("resize", update);
		return () => {
			window.removeEventListener("resize", update);
			if (ro) ro.disconnect();
		};
	}, []);
	const onPointerDown = (e) => {
		if (e.button !== 0) return;
		const r = e.currentTarget.getBoundingClientRect();
		dragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, w: r.width || FAB_W, h: r.height || FAB_H, moved: false };
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 无指针捕获也能拖 */ }
	};
	const onPointerMove = (e) => {
		const d = dragRef.current;
		if (!d || typeof window === "undefined") return;
		const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
		if (!d.moved && Math.hypot(dx, dy) < 4) return;
		d.moved = true;
		setDragging(true);
		// 拖动中自由跟随（越界钳制）；圆角随所在半边实时翻转，松手再磁吸贴边。
		const side = (d.ox + dx + d.w / 2) < window.innerWidth / 2 ? "left" : "right";
		sideRef.current = side;
		setPos({
			side,
			x: Math.min(Math.max(0, d.ox + dx), Math.max(0, window.innerWidth - d.w)),
			y: Math.min(Math.max(8, d.oy + dy), Math.max(8, window.innerHeight - d.h - 8)),
		});
	};
	const onPointerUp = (e) => {
		const d = dragRef.current;
		dragRef.current = null;
		setDragging(false);
		if (!d || !d.moved) return; // 纯点击交给 onClick
		clickBlockRef.current = true; // 拖动结束的 pointerup 不再触发点击
		setTimeout(() => { clickBlockRef.current = false; }, 0);
		const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
		const side = (d.ox + dx + d.w / 2) < window.innerWidth / 2 ? "left" : "right";
		sideRef.current = side;
		const x = snapFabX(side);
		const y = Math.min(Math.max(8, d.oy + dy), Math.max(8, window.innerHeight - d.h - 8));
		setPos({ side, x, y });
		try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ side, y })); } catch { /* 持久化失败静默 */ }
	};
	if (!pos) return null;
	return <button type="button"
		className={"dgfab dgfab-side-" + pos.side + (dragging ? " dgfab-drag" : "") + (props.hidden ? " dgfab-hide" : "")}
		style={{ left: pos.x + "px", top: pos.y + "px" }}
		title="趣味游戏 · 点击开玩；按住可拖到侧栏右缘或屏幕右侧、上下挪位"
		aria-label="趣味游戏快捷入口，可拖动换边与上下挪位"
		onPointerDown={onPointerDown}
		onPointerMove={onPointerMove}
		onPointerUp={onPointerUp}
		onClick={() => { if (!clickBlockRef.current) gamesBus.entry(); }}>
		<span className="dgfab-ico"><GamepadIcon size={16} /></span>
		<span className="dgfab-label">趣味游戏</span>
	</button>;
}

function GamepadIcon(props) {
	const size = (props && props.size) || 16;
	return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
		<rect x="1.6" y="4.6" width="12.8" height="6.8" rx="3.2" />
		<path d="M4.7 6.8v2.6M3.4 8.1h2.6" />
		<circle cx="10.4" cy="6.9" r=".95" fill="currentColor" stroke="none" />
		<circle cx="12.2" cy="8.7" r=".95" fill="currentColor" stroke="none" />
	</svg>;
}

// ---------- 全局浮层：磁吸快捷入口 + 浮动游戏窗口（功能启用即常驻） ----------
function GamesOverlay() {
	const winState = useGameWin();
	const [panelOpen, setPanelOpen] = useState(panelNav.open);
	useEffect(() => {
		setPanelOpen(panelNav.open);
		return subscribePanel(() => setPanelOpen(panelNav.open));
	}, []);
	const game = winState.game ? GAMES.find((g) => g.id === winState.game) : null;
	return (<>
		<GameFab hidden={winState.open || panelOpen} />
		{winState.open ? <GameWindow game={game} picker={winState.picker} /> : null}
	</>);
}

function TaskStatus({ status }) {
	const task = status.active[0];
	if (status.loading) return <div className="dgame-task-status loading">正在读取任务状态…</div>;
	if (!task) return <div className="dgame-task-status"><i /> 任务暂时空闲 · 游戏随时可玩</div>;
	return <div className="dgame-task-status live"><i /><div><strong>{status.active.length} 个任务进行中 · {phaseLabel(task.phase)}</strong><span title={task.title}>{task.title || "当前任务"} · 已运行 {elapsedText(task.elapsed)}</span></div></div>;
}

// ---------- 功能坞面板页：多封面预览选择，点击封面在浮动窗口开玩（顺手收起功能坞） ----------
function GamesView() {
	const status = useTaskPulse();
	const winState = useGameWin();
	return <section className="dgame">
		<header className="dgame-hero"><div><span className="dgame-eyebrow"><i /> 等待也可以很好玩</span><h2>趣味游戏</h2><p>任务在后台继续执行；游戏在局部浮动窗口里运行，不铺满全屏、不遮挡会话内容，也不影响文件或正在运行的智能体。</p></div><span className="dgame-planet" aria-hidden="true"><i /><b /></span></header>
		<TaskStatus status={status} />
		<div className="dgame-launch-note">点击封面在浮动窗口开玩：窗口可拖动、可调大小、可最大化最小化；屏幕侧边的「趣味游戏」磁吸入口贴在左侧边栏右缘（不挡工作区目录），可上下挪位、左右换边，位置都会记住；十款小游戏都支持键盘（能配按钮的也配了按钮）操作。</div>
		<GameCoverGrid currentId={winState.open ? winState.game : null} onLaunch={(id) => { gamesBus.launch(id); setPanelOpen(false); }} />
		<footer className="dgame-foot">游戏中按 Esc 关闭窗口；游戏不发送任何消息，也不改动工作区。方向键 / WASD、Enter、空格、R、U、P 等键随游戏可用；五子棋、象棋支持撤销/重开。</footer>
	</section>;
}

function GamesHomeStat() {
	return <span>十款浮动窗口小游戏 · 五子棋/象棋/俄罗斯方块/推箱子…任务等待不无聊</span>;
}

const baseCss = `
.dgame{--dgame-accent:#a78bfa;--dgame-accent-soft:color-mix(in srgb,var(--dgame-accent) 16%,transparent);display:flex;flex-direction:column;gap:14px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}.dgame h2,.dgame h3,.dgame p{margin:0}.dgame-hero{position:relative;display:flex;justify-content:space-between;gap:18px;overflow:hidden;padding:17px 18px;border:1px solid color-mix(in srgb,var(--dgame-accent) 35%,var(--dsw-alias-border-l1));border-radius:16px;background:radial-gradient(circle at 88% 30%,color-mix(in srgb,#38bdf8 25%,transparent),transparent 28%),radial-gradient(circle at 8% 100%,color-mix(in srgb,#a855f7 24%,transparent),transparent 34%),var(--dsw-alias-bg-layer-1)}.dgame-hero>div{position:relative;z-index:1;display:flex;flex-direction:column;gap:5px;max-width:540px}.dgame-hero h2{font-size:21px;letter-spacing:-.02em}.dgame-hero p,.dgame-foot{color:var(--dsw-alias-label-secondary);font-size:12px}.dgame-eyebrow{display:inline-flex;align-items:center;gap:7px;color:var(--dgame-accent);font-size:11px;font-weight:700}.dgame-eyebrow i,.dgame-task-status>i{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px currentColor;opacity:.9}.dgame-planet{position:relative;z-index:1;align-self:center;display:block;width:76px;height:76px;flex:none;border-radius:50%;background:radial-gradient(circle at 35% 30%,#e0f2fe 0 4%,#60a5fa 18%,#3730a3 59%,#1e1b4b);box-shadow:0 0 30px color-mix(in srgb,#818cf8 45%,transparent)}.dgame-planet::after{content:'';position:absolute;left:-16px;top:33px;width:106px;height:27px;border:3px solid color-mix(in srgb,#c4b5fd 72%,transparent);border-radius:50%;transform:rotate(-17deg)}.dgame-planet i{position:absolute;right:15px;top:14px;width:9px;height:9px;border-radius:50%;background:#818cf8;box-shadow:-23px 24px 0 5px color-mix(in srgb,#312e81 52%,transparent)}.dgame-planet b{position:absolute;left:-9px;top:9px;width:5px;height:5px;border-radius:50%;background:#fef3c7;box-shadow:58px -20px 0 #fef3c7,76px 43px 0 #bae6fd}.dgame-task-status{display:flex;align-items:center;gap:9px;min-height:40px;padding:9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}.dgame-task-status>i{color:var(--dsw-alias-label-tertiary);box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-label-tertiary) 13%,transparent)}.dgame-task-status.live{color:var(--dgame-accent);border-color:color-mix(in srgb,var(--dgame-accent) 36%,var(--dsw-alias-border-l1));background:var(--dgame-accent-soft)}.dgame-task-status.live>i{box-shadow:0 0 0 4px color-mix(in srgb,var(--dgame-accent) 17%,transparent);animation:dgame-pulse 1.8s ease-in-out infinite}.dgame-task-status div{display:flex;flex:1;min-width:0;flex-direction:column}.dgame-task-status strong{font-size:12px}.dgame-task-status span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-secondary)}.dgame-task-status.loading{color:var(--dsw-alias-label-tertiary)}@keyframes dgame-pulse{50%{transform:scale(.72);opacity:.5}}.dgame-launch-note{color:var(--dsw-alias-label-secondary);font-size:12px}.dgame-game{display:flex;flex-direction:column;gap:11px;padding:15px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1)}.dgame-game-head{display:flex;justify-content:space-between;gap:12px}.dgame-game-head>div:first-child{display:flex;flex-direction:column;gap:3px}.dgame-game h3{font-size:16px}.dgame-game p{font-size:12px;color:var(--dsw-alias-label-secondary)}.dgame-score{display:flex;align-items:flex-end;gap:9px;flex-direction:column;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}.dgame-score strong{color:var(--dgame-accent);font-size:17px;line-height:1}.dgame-score button{min-height:28px;padding:3px 8px;font-size:11px}.dgame-dash-stage{position:relative;align-self:center;width:min(100%,360px);border:1px solid color-mix(in srgb,var(--dgame-accent) 30%,var(--dsw-alias-border-l1));border-radius:13px;overflow:hidden;outline:none;background:radial-gradient(circle at 50% -16%,color-mix(in srgb,#38bdf8 25%,transparent),transparent 42%),linear-gradient(180deg,#10162d,#17142d)}.dgame-dash-stage:focus-visible{box-shadow:0 0 0 3px var(--dgame-accent-soft)}.dgame-dash-grid{display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(5,52px);padding:7px;background:repeating-linear-gradient(90deg,transparent 0 calc(33.333% - 1px),color-mix(in srgb,#c4b5fd 15%,transparent) calc(33.333% - 1px) 33.333%)}.dgame-dash-cell{position:relative;display:grid;place-items:center;border-bottom:1px dashed color-mix(in srgb,#c4b5fd 13%,transparent)}.dgame-rock{font-style:normal;color:#fb7185;text-shadow:0 0 12px #f43f5e;font-size:22px;animation:dgame-rock .55s cubic-bezier(.2,.8,.25,1)}.dgame-pilot{position:relative;color:#a5f3fc;font-size:25px;text-shadow:0 0 14px #38bdf8;animation:dgame-pilot .9s ease-in-out infinite alternate}.dgame-pilot::after{content:'';position:absolute;left:46%;top:19px;width:4px;height:18px;background:linear-gradient(#fef3c7,transparent);transform:translateX(-50%)}@keyframes dgame-rock{from{opacity:0;transform:translateY(-13px) scale(.65)}to{opacity:1;transform:none}}@keyframes dgame-pilot{to{transform:translateY(-2px)}}.dgame-over{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:9px;background:color-mix(in srgb,#111827 74%,transparent);backdrop-filter:blur(2px);color:#fef3c7}.dgame-over strong{font-size:17px}.dgame-over button{padding:7px 12px;color:#fef3c7;background:color-mix(in srgb,#f59e0b 25%,transparent);border-color:#f59e0b}.dgame-controls{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;align-self:center;width:min(100%,360px)}.dgame-controls button{min-height:42px;padding:8px 10px;font-weight:600}.dgame-controls span{text-align:center;color:var(--dsw-alias-label-tertiary);font-size:11px}.dgame-reactor{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;align-self:center;width:min(100%,360px);padding:10px;border-radius:13px;background:linear-gradient(135deg,color-mix(in srgb,#312e81 34%,transparent),color-mix(in srgb,#0f172a 45%,transparent));border:1px solid color-mix(in srgb,var(--dgame-accent) 22%,var(--dsw-alias-border-l1))}.dgame-reactor-cell{position:relative;aspect-ratio:1;border:1px solid color-mix(in srgb,#94a3b8 30%,transparent);border-radius:12px;background:#171a33;cursor:pointer;transition:transform .16s ease,background .22s ease,border-color .22s ease,box-shadow .22s ease}.dgame-reactor-cell:hover{transform:translateY(-2px);border-color:var(--dgame-accent)}.dgame-reactor-cell:focus-visible{outline:2px solid var(--dgame-accent);outline-offset:2px}.dgame-reactor-cell i{position:absolute;inset:23%;border-radius:9px;background:#303252;transition:inherit}.dgame-reactor-cell.on{border-color:#67e8f9;background:color-mix(in srgb,#164e63 70%,#0f172a)}.dgame-reactor-cell.on i{background:radial-gradient(circle at 35% 30%,#ecfeff,#67e8f9 36%,#2563eb 78%);box-shadow:0 0 15px color-mix(in srgb,#22d3ee 65%,transparent)}.dgame-reactor-cell.focus{border-color:#a5f3fc;box-shadow:0 0 0 2px var(--dgame-accent) inset,0 0 14px color-mix(in srgb,#22d3ee 48%,transparent)}.dgame-reactor-cell.focus i{box-shadow:0 0 0 2px color-mix(in srgb,#ecfeff 55%,transparent) inset}.dgame-reactor:focus-visible{outline:2px solid var(--dgame-accent);outline-offset:3px}.dgame-reactor-status{align-self:center;min-height:36px;padding:8px 12px;border-radius:9px;color:var(--dsw-alias-label-secondary);font-size:12px}.dgame-reactor-status.solved{color:#a7f3d0;background:color-mix(in srgb,#34d399 13%,transparent)}.dgame-foot{padding:0 2px}.dgame-foot::before{content:'✦';margin-right:6px;color:var(--dgame-accent)}
.dgame .dgame-score button,.dgame .dgame-controls button,.dgame .dgame-over button,.dgwin .dgame-score button,.dgwin .dgame-controls button,.dgwin .dgame-over button{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;transition:transform .16s ease,border-color .18s ease,background .18s ease,color .18s ease}.dgame .dgame-score button:hover,.dgame .dgame-controls button:hover,.dgame .dgame-over button:hover,.dgwin .dgame-score button:hover,.dgwin .dgame-controls button:hover,.dgwin .dgame-over button:hover{border-color:var(--dgame-accent);color:var(--dsw-alias-label-primary)}.dgame .dgame-score button:active,.dgame .dgame-controls button:active,.dgame .dgame-over button:active,.dgwin .dgame-score button:active,.dgwin .dgame-controls button:active,.dgwin .dgame-over button:active{transform:scale(.97)}
.dgcov-grid{--dgame-accent:#a78bfa;display:flex;gap:10px;flex-wrap:wrap}.dgcov{flex:1;min-width:230px;display:flex;flex-direction:column;gap:8px;padding:11px;border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-family:inherit;text-align:left;transition:border-color .16s ease,transform .16s ease}.dgcov:hover{border-color:var(--dgame-accent);transform:translateY(-2px)}.dgcov:focus-visible{outline:2px solid var(--dgame-accent);outline-offset:2px}.dgcov.on{border-color:var(--dgame-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dgame-accent) 40%,transparent)}.dgcov-name{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}.dgcov-name i{width:8px;height:8px;border-radius:50%;flex:none}.dgcov-name em{margin-left:auto;font-style:normal;font-size:10px;color:var(--dgame-accent);border:1px solid color-mix(in srgb,var(--dgame-accent) 45%,transparent);border-radius:999px;padding:1px 8px;white-space:nowrap}.dgcov-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.55}.dgcov-prev{position:relative;display:block;height:96px;border-radius:9px;overflow:hidden;border:1px solid color-mix(in srgb,var(--dgame-accent) 25%,var(--dsw-alias-border-l1))}
.dgcov-prev-dash{background:radial-gradient(circle at 70% 20%,color-mix(in srgb,#1d4ed8 30%,transparent),transparent 55%),linear-gradient(180deg,#0d1330,#171233)}.dgcov-prev-dash i{position:absolute;top:-22%;font-style:normal;color:#fb7185;text-shadow:0 0 10px #f43f5e;font-size:15px;animation:dgcov-fall 1.5s linear infinite}.dgcov-prev-dash i::after{content:'◆'}.dgcov-prev-dash i:nth-child(1){left:16%}.dgcov-prev-dash i:nth-child(2){left:50%;animation-delay:-.5s}.dgcov-prev-dash i:nth-child(3){left:82%;animation-delay:-1s}.dgcov-prev-dash b{position:absolute;left:50%;bottom:8px;margin-left:-9px;font-size:17px;color:#a5f3fc;text-shadow:0 0 12px #38bdf8;animation:dgcov-dodge 2.4s ease-in-out infinite}.dgcov-prev-dash b::after{content:'▲'}@keyframes dgcov-fall{to{transform:translateY(140px)}}@keyframes dgcov-dodge{0%,100%{transform:translateX(-46px)}25%,75%{transform:translateX(0)}50%{transform:translateX(46px)}}
.dgcov-prev-reactor{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;padding:14px;background:linear-gradient(135deg,#272463,#12102c)}.dgcov-prev-reactor i{display:block;border-radius:9px;background:#191c38;border:1px solid color-mix(in srgb,#ffffff 11%,transparent);animation:dgcov-reactor 3s ease-in-out infinite}.dgcov-prev-reactor i:nth-child(1){animation-delay:0s}.dgcov-prev-reactor i:nth-child(2){animation-delay:-.33s}.dgcov-prev-reactor i:nth-child(3){animation-delay:-.66s}.dgcov-prev-reactor i:nth-child(4){animation-delay:-1s}.dgcov-prev-reactor i:nth-child(5){animation-delay:-1.33s}.dgcov-prev-reactor i:nth-child(6){animation-delay:-1.66s}.dgcov-prev-reactor i:nth-child(7){animation-delay:-2s}.dgcov-prev-reactor i:nth-child(8){animation-delay:-2.33s}.dgcov-prev-reactor i:nth-child(9){animation-delay:-2.66s}@keyframes dgcov-reactor{0%,20%,100%{background:#191c38;box-shadow:none;border-color:color-mix(in srgb,#ffffff 11%,transparent)}40%,64%{background:radial-gradient(circle at 35% 30%,#ecfeff,#67e8f9 40%,#2563eb 85%);box-shadow:0 0 14px color-mix(in srgb,#22d3ee 55%,transparent);border-color:#67e8f9}}
.dgfab{--dgame-accent:#a78bfa;position:fixed;z-index:9985;display:flex;flex-direction:column;align-items:center;gap:6px;box-sizing:border-box;width:36px;padding:11px 0;border:1px solid color-mix(in srgb,var(--dgame-accent) 42%,var(--dsw-alias-border-l1));background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);color:var(--dsw-alias-label-primary);font-family:inherit;cursor:grab;user-select:none;touch-action:none;box-shadow:0 6px 24px rgb(0 0 0 / .18);transition:left .22s ease,top .22s ease,border-color .15s ease,opacity .15s ease}.dgfab:hover{border-color:var(--dgame-accent)}.dgfab-side-left{border-radius:0 12px 12px 0;border-left:none}.dgfab-side-right{border-radius:12px 0 0 12px;border-right:none}.dgfab-drag{transition:none;cursor:grabbing;box-shadow:0 10px 34px rgb(0 0 0 / .3);z-index:9986}.dgfab-hide{display:none}.dgfab-ico{display:inline-flex;color:var(--dgame-accent)}.dgfab-label{writing-mode:vertical-rl;letter-spacing:.22em;font-size:11px;line-height:1;color:var(--dsw-alias-label-secondary)}
.dgwin{--dgame-accent:#a78bfa;--dgame-accent-soft:color-mix(in srgb,#a78bfa 16%,transparent);--dsw-alias-label-primary:#e7ecff;--dsw-alias-label-secondary:#aab3e8;--dsw-alias-label-tertiary:#7d86c0;--dsw-alias-border-l1:rgb(255 255 255 / .12);--dsw-alias-border-l2:rgb(255 255 255 / .17);--dsw-alias-bg-layer-1:#0d1230;--dsw-alias-bg-layer-2:#131a3d;--dsw-alias-interactive-bg-hover:rgb(255 255 255 / .08);position:fixed;z-index:9993;display:flex;flex-direction:column;border:1px solid rgb(255 255 255 / .14);border-radius:14px;background:radial-gradient(600px 300px at 80% -10%,color-mix(in srgb,#312e81 30%,transparent),transparent 60%),radial-gradient(500px 340px at -10% 110%,color-mix(in srgb,#0ea5e9 14%,transparent),transparent 55%),linear-gradient(180deg,#0b1024,#12102a 60%,#0a0f22);color:var(--dsw-alias-label-primary);box-shadow:0 24px 72px rgb(0 0 0 / .5);animation:dgwin-in .18s ease-out}.dgwin::before{content:'';position:absolute;inset:0;pointer-events:none;background-image:radial-gradient(1px 1px at 12% 22%,rgb(255 255 255 / .35),transparent),radial-gradient(1px 1px at 34% 68%,rgb(255 255 255 / .26),transparent),radial-gradient(1.5px 1.5px at 58% 14%,rgb(199 210 254 / .35),transparent),radial-gradient(1px 1px at 76% 44%,rgb(255 255 255 / .22),transparent),radial-gradient(1.5px 1.5px at 88% 78%,rgb(165 243 252 / .3),transparent),radial-gradient(1px 1px at 22% 88%,rgb(255 255 255 / .18),transparent),radial-gradient(1px 1px at 45% 38%,rgb(255 255 255 / .15),transparent),radial-gradient(1px 1px at 67% 86%,rgb(255 255 255 / .19),transparent)}@keyframes dgwin-in{from{opacity:0;transform:translateY(8px) scale(.985)}}
.dgwin-min{height:auto!important;border-radius:12px}.dgwin-min .dgwin-body{display:none}.dgwin-min .dgwin-resize{display:none}
.dgwin-max{border-radius:12px}.dgwin-max .dgwin-body .dgame-game{align-items:stretch}.dgwin-max .dgwin-body .dgame-dash-stage,.dgwin-max .dgwin-body .dgame-tetris,.dgwin-max .dgwin-body .dgame-tetris-board,.dgwin-max .dgwin-body .dgame-snake-stage,.dgwin-max .dgwin-body .dgame-sokoban-stage,.dgwin-max .dgwin-body .dgame-gomoku-board,.dgwin-max .dgwin-body .dgame-xiangqi-board,.dgwin-max .dgwin-body .dgame-tank-stage,.dgwin-max .dgwin-body .dgame-breakout,.dgwin-max .dgwin-body .dgame-racer,.dgwin-max .dgwin-body .dgame-reactor{width:100%;max-width:none}.dgwin-max .dgwin-body .dgame-controls{width:100%;max-width:none}
.dgwin-bar{flex:none;display:flex;align-items:center;gap:9px;padding:10px 12px;border-bottom:1px solid rgb(255 255 255 / .09);background:rgb(7 11 28 / .72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#cdd6ff;cursor:move;user-select:none;touch-action:none;position:relative;z-index:2}.dgwin-ico{display:inline-flex;color:#a78bfa}.dgwin-title{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}.dgwin-title b{font-size:13px}.dgwin-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:#8f98ce}.dgwin-task{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;border:1px solid rgb(255 255 255 / .13);background:rgb(255 255 255 / .05);font-size:11px;color:#aab3e8;white-space:nowrap}.dgwin-task i{width:7px;height:7px;border-radius:50%;background:#6b7499;flex:none}.dgwin-task.live{color:#c4f5e4;border-color:color-mix(in srgb,#34d399 33%,transparent);background:color-mix(in srgb,#34d399 8%,transparent)}.dgwin-task.live i{background:#34d399;box-shadow:0 0 0 3px color-mix(in srgb,#34d399 14%,transparent);animation:dgame-pulse 1.8s ease-in-out infinite}.dgwin-ctrls{display:flex;align-items:center;gap:6px;flex:none}.dgwin-btn{cursor:pointer;border:1px solid rgb(255 255 255 / .17);background:rgb(255 255 255 / .07);color:#e6ebff;border-radius:8px;padding:5px 10px;font:inherit;font-size:11px;transition:background .15s ease,border-color .15s ease}.dgwin-btn:hover{background:rgb(255 255 255 / .13);border-color:rgb(255 255 255 / .28)}.dgwin-sq{cursor:pointer;border:1px solid transparent;background:transparent;color:#a9b2e2;border-radius:8px;width:28px;height:26px;display:inline-flex;align-items:center;justify-content:center;font-size:12px;transition:background .15s ease,color .15s ease}.dgwin-sq:hover{background:rgb(255 255 255 / .12);color:#fff}
/* 小窗内容自适应：高度随内容（不裁切、不滚动），游戏板按屏幕可用高度等比缩放 */
.dgwin-normal{max-height:calc(100vh - 12px)}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-snake-stage,.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-tank-stage{width:min(100%,430px,calc(100vh - 240px))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-gomoku-board{width:min(100%,390px,calc(100vh - 245px))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-xiangqi-board{width:min(100%,370px,calc((100vh - 240px) * .9))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-breakout{width:min(100%,410px,calc((100vh - 235px) * .89))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-tetris-board{width:min(100%,215px,calc((100vh - 270px) / 2))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-dash-stage{width:min(100%,430px,calc((100vh - 215px) * 1.24))}
.dgwin:not(.dgwin-max):not(.dgwin-min) .dgame-racer{width:min(100%,400px,calc((100vh - 235px) * .71))}
.dgwin-body{flex:1;min-height:0;position:relative;z-index:1;overflow:hidden;display:flex;flex-direction:column;gap:10px;padding:13px}.dgwin-body .dgame-game{border-color:transparent;background:transparent;padding:0}.dgwin-empty{display:grid;place-items:center;min-height:220px;color:#8f98ce;font-size:12px}.dgwin-tip{flex:none;text-align:center;color:#8b93c9;font-size:11px;padding:0 4px 2px}
.dgwin-picker{position:absolute;inset:0;z-index:4;display:flex;flex-direction:column;gap:10px;padding:13px;background:rgb(10 14 32 / .86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);overflow-y:auto;animation:dgentry-in .15s ease-out}.dgwin-picker-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.dgwin-picker-head>div{display:flex;flex-direction:column;gap:3px}.dgwin-picker-head b{font-size:14px}.dgwin-picker-head span{font-size:11px;color:#aab3e8}.dgwin-picker-close{cursor:pointer;border:none;background:transparent;color:#7d86c0;border-radius:8px;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-size:14px;flex:none}.dgwin-picker-close:hover{background:rgb(255 255 255 / .08);color:#e7ecff}.dgwin-picker .dgcov-grid{flex-direction:column;--dsw-alias-label-primary:#e7ecff;--dsw-alias-label-secondary:#aab3e8;--dsw-alias-border-l1:rgb(255 255 255 / .12)}.dgwin-picker .dgcov{min-width:0;background:rgb(255 255 255 / .04)}
.dgwin-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:3;touch-action:none}.dgwin-resize::after{content:'';position:absolute;right:4px;bottom:4px;width:8px;height:8px;border-right:2px solid rgb(255 255 255 / .3);border-bottom:2px solid rgb(255 255 255 / .3);border-radius:0 0 3px 0}
@keyframes dgentry-in{from{opacity:0}}
@media (max-width:680px){.dgame{gap:12px;font-size:14px}.dgame-hero{padding:15px}.dgame-hero h2{font-size:20px}.dgame-planet{width:58px;height:58px}.dgame-planet::after{left:-12px;top:25px;width:80px;height:20px}.dgame-game{padding:12px}.dgame-dash-grid{grid-template-rows:repeat(5,48px)}.dgame-controls{grid-template-columns:1fr 1fr}.dgame-controls span{grid-column:1 / -1;grid-row:2}.dgame-reactor{gap:8px}.dgcov-grid{flex-direction:column}.dgcov{min-width:0}.dgfab{width:32px}.dgwin-title span,.dgwin-task{display:none}.dgwin-bar{gap:7px;padding:8px 10px}.dgwin-btn{padding:6px 8px}.dgwin-body{padding:10px}}
@media (prefers-reduced-motion:reduce){.dgame *,.dgcov *,.dgfab,.dgwin,.dgwin-picker *{animation:none!important;transition:none!important}}
`;

const dgcovGroupCss = `
.dgcov-groups{display:flex;flex-direction:column;gap:16px}.dgcov-section{display:flex;flex-direction:column;gap:8px}.dgcov-sechead{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dgcov-sechead b{font-size:13px;color:var(--dsw-alias-label-primary);font-weight:600}.dgcov-sechead span{font-size:11px;color:var(--dsw-alias-label-tertiary)}.dgcov-sechead em{margin-left:auto;font-style:normal;font-size:10px;color:var(--dgame-accent);border:1px solid color-mix(in srgb,var(--dgame-accent) 40%,transparent);border-radius:999px;padding:1px 8px;white-space:nowrap}
.dgcov-prev-gomoku{background:repeating-linear-gradient(94deg,rgba(124,79,22,.06) 0 2px,transparent 2px 11px),radial-gradient(120% 120% at 30% 10%,#edc97f,#dcae62 55%,#c89a52)}.dgcov-prev-gomoku svg{position:absolute;inset:0;width:100%;height:100%}.dgcov-prev-gomoku line,.dgcov-prev-gomoku rect{stroke:#66431a;stroke-width:3;fill:none}.dgcov-prev-gomoku .dgp-star{fill:#66431a}.dgcov-prev-gomoku .dgp-stone-b{fill:radial-gradient(circle at 34% 30%,#4b5563,#111827 70%);fill:#1f2937;stroke:#0b1220;stroke-width:3}.dgcov-prev-gomoku .dgp-stone-w{fill:#fff;stroke:#94a3b8;stroke-width:3}
.dgcov-prev-xiangqi{background:repeating-linear-gradient(94deg,rgba(124,79,22,.06) 0 2px,transparent 2px 11px),radial-gradient(120% 120% at 30% 10%,#f0cd86,#ddb067 55%,#c89a52)}.dgcov-prev-xiangqi svg{position:absolute;inset:0;width:100%;height:100%}.dgcov-prev-xiangqi line,.dgcov-prev-xiangqi rect,.dgcov-prev-xiangqi path{stroke:#66431a;stroke-width:3;fill:none}.dgcov-prev-xiangqi .dgp-xq-river{fill:rgba(102,67,26,.65);font-family:KaiTi,"Kaiti SC","STKaiti",serif;font-size:62px;text-anchor:middle;letter-spacing:8px}.dgcov-prev-xiangqi .dgp-xq-pc-b{fill:#f3e0ae;stroke:#8a5a1c;stroke-width:4}.dgcov-prev-xiangqi .dgp-xq-pc-r{fill:#f3e0ae;stroke:#b91c1c;stroke-width:4}.dgcov-prev-xiangqi .dgp-xq-tx-b{fill:#1f2937;font-size:52px;font-weight:700;text-anchor:middle;dominant-baseline:central;font-family:KaiTi,"Kaiti SC","STKaiti",serif}.dgcov-prev-xiangqi .dgp-xq-tx-r{fill:#b91c1c;font-size:52px;font-weight:700;text-anchor:middle;dominant-baseline:central;font-family:KaiTi,"Kaiti SC","STKaiti",serif}
.dgcov-prev-tetris{display:grid;place-items:center;background:linear-gradient(180deg,#0c1024,#131a3d)}.dgp-tet-grid{display:grid;grid-template-columns:repeat(10,10px);grid-auto-rows:10px;gap:1px;padding:7px;border:1px solid rgba(34,211,238,.3);border-radius:7px;background:rgba(12,16,36,.6)}.dgp-tet-grid i{border-radius:2px;background:rgba(255,255,255,.045);box-shadow:inset 0 0 2px rgba(255,255,255,.07)}.dgp-tet-grid i.cI{background:#22d3ee;box-shadow:0 0 6px rgba(34,211,238,.6)}.dgp-tet-grid i.cO{background:#facc15;box-shadow:0 0 6px rgba(250,204,21,.55)}.dgp-tet-grid i.cT{background:#c084fc;box-shadow:0 0 6px rgba(192,132,252,.55)}.dgp-tet-grid i.cS{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,.55)}.dgp-tet-grid i.cZ{background:#f87171;box-shadow:0 0 6px rgba(248,113,113,.55)}.dgp-tet-grid i.cJ{background:#60a5fa;box-shadow:0 0 6px rgba(96,165,250,.55)}.dgp-tet-grid i.cL{background:#fb923c;box-shadow:0 0 6px rgba(251,146,60,.55)}.dgp-tet-grid i.fall{animation:dgp-tetbob 1.1s ease-in-out infinite}@keyframes dgp-tetbob{0%,100%{transform:translateY(0)}50%{transform:translateY(4px)}}
.dgcov-prev-soko{display:grid;place-items:center;background:linear-gradient(180deg,#181420,#14101f)}.dgp-soko-grid{display:grid;grid-template-columns:repeat(7,17px);grid-auto-rows:17px;gap:2px}.dgp-soko-grid i{display:block;border-radius:3px;position:relative}.dgp-soko-floor{background:rgba(255,255,255,.04)}.dgp-soko-wall{background:linear-gradient(180deg,#3a3350,#241f3a);box-shadow:inset 0 1px 0 rgba(255,255,255,.12)}.dgp-soko-box{background:linear-gradient(135deg,#d4a24a,#8a5a1c);box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}.dgp-soko-boxT{background:linear-gradient(135deg,#34d399,#0f766e)}.dgp-soko-target{background:rgba(255,255,255,.04)}.dgp-soko-target::after{content:'';position:absolute;inset:32%;border-radius:50%;background:#f59e0b}.dgp-soko-player{background:radial-gradient(circle at 35% 30%,#e0f2fe,#38bdf8 70%);border-radius:50%!important}
.dgcov-prev-snake{background:linear-gradient(180deg,#0a1420,#123320)}.dgcov-prev-snake i{position:absolute;width:12px;height:12px;border-radius:26%;background:linear-gradient(135deg,#4ade80,#16a34a);transform:translate(-50%,-50%)}.dgcov-prev-snake i:first-child{background:linear-gradient(135deg,#bbf7d0,#22c55e)}.dgcov-prev-snake i:nth-child(2){background:linear-gradient(135deg,#34d399,#0d9f6e)}.dgcov-prev-snake b{position:absolute;width:13px;height:13px;border-radius:50%;background:#ef4444;box-shadow:0 0 8px #ef4444;transform:translate(-50%,-50%);animation:dgcov-snakefood 1s ease-in-out infinite}@keyframes dgcov-snakefood{50%{transform:translate(-50%,-50%) scale(1.3)}}
.dgcov-prev-breakout{background:linear-gradient(180deg,#0b1024,#14203a)}.dgcov-prev-breakout i{position:absolute;width:12px;height:5px;border-radius:3px}.dgcov-prev-breakout b{position:absolute;left:50%;bottom:10px;width:34px;height:8px;border-radius:4px;background:#a5f3fc;transform:translateX(-50%)}
.dgcov-prev-racer{background:linear-gradient(180deg,#0b1024,#1a0f2a)}.dgcov-prev-racer i{position:absolute;width:14px;height:22px;border-radius:5px;transform:translate(-50%,-50%);background:#f87171}.dgcov-prev-racer i:nth-child(even){background:#fb923c}.dgcov-prev-racer b{position:absolute;left:50%;bottom:8px;width:18px;height:30px;border-radius:6px;background:#22d3ee;transform:translateX(-50%)}
.dgcov-prev-tank{display:grid;place-items:center;background:linear-gradient(180deg,#1a1425,#100d1c)}.dgp-tank-grid{display:grid;grid-template-columns:repeat(8,18px);grid-auto-rows:18px;gap:2px}.dgp-tank-grid i{display:block;border-radius:3px}.dgp-tank-void{background:rgba(255,255,255,.035)}.dgp-tank-brick{background:repeating-linear-gradient(45deg,#a3672a 0 55%,#8a5a1c 55% 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}.dgp-tank-steel{background:linear-gradient(180deg,#94a3b8,#64748b)}.dgp-tank-pw{background:linear-gradient(135deg,#fde047,#eab308);box-shadow:0 0 7px rgba(234,179,8,.55);border-radius:5px}.dgp-tank-en{background:#f87171;box-shadow:0 0 5px rgba(248,113,113,.4);border-radius:5px}.dgp-tank-base{background:#fbbf24;border-radius:50%}

`;

const css = [baseCss, tetrisGame.css, sokobanGame.css, gomokuGame.css, xiangqiGame.css, snakeGame.css, breakoutGame.css, racerGame.css, tankGame.css, dgcovGroupCss].filter(Boolean).join("\n");

export const feature = {
	id: "games",
	name: "趣味游戏",
	order: 135,
	accent: "#a78bfa",
	description: "任务等待时可玩的十款小游戏：五子棋、中国象棋（你 vs AI）、俄罗斯方块、推箱子、贪吃蛇、打砖块、极速赛车、坦克大战、星际躲避、反应堆点亮。浮动窗口运行（可拖动、可调大小、可最大化最小化，不遮挡会话），屏幕侧边磁吸快捷入口贴在左侧边栏右缘（不挡工作区目录），可上下挪位、左右换边；均支持键盘",
	defaultEnabled: true,
	css,
	View: GamesView,
	HomeStat: GamesHomeStat,
	Overlay: GamesOverlay,
};
