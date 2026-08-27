/* 趣味游戏 · 贪吃蛇（经典机台）——纯 Client；吃到食物变长，撞墙或咬到自身结束。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

const SIZE = 16;
const DIRS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1], W: [-1, 0], S: [1, 0], A: [0, -1], D: [0, 1] };
const OPPOSITE = { "-1,0": [1, 0], "1,0": [-1, 0], "0,1": [0, -1], "0,-1": [0, 1] };
// 三档速度：随得分缓慢提速，下限保证可玩性。
const SPEED_MODES = {
	slow: { label: "慢速", stepMs: 4, base: 320, min: 180 },
	normal: { label: "中速", stepMs: 3, base: 220, min: 120 },
	fast: { label: "快速", stepMs: 2, base: 140, min: 80 },
};
function loadSpeedMode() {
	try { return SPEED_MODES[localStorage.getItem("dsh-dock.snake.speed")] ? localStorage.getItem("dsh-dock.snake.speed") : "slow"; } catch { return "slow"; }
}

function randFood(snake) {
	while (true) {
		const r = Math.floor(Math.random() * SIZE), c = Math.floor(Math.random() * SIZE);
		if (!snake.some((s) => s.r === r && s.c === c)) return { r, c };
	}
}
function initial() {
	const snake = [{ r: 7, c: 5 }, { r: 7, c: 4 }, { r: 7, c: 3 }];
	return { snake, dir: [0, 1], food: randFood(snake), score: 0, over: false, started: false };
}
function step(state, dir) {
	const head = state.snake[0];
	const nr = head.r + dir[0], nc = head.c + dir[1];
	const body = state.snake.slice(0, -1);
	if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || body.some((s) => s.r === nr && s.c === nc)) {
		return Object.assign({}, state, { over: true });
	}
	const ate = state.food.r === nr && state.food.c === nc;
	let snake = [{ r: nr, c: nc }, ...state.snake];
	if (ate) {
		playSfx("eat");
		const food = randFood(snake);
		return Object.assign({}, state, { snake, food, score: state.score + 1 });
	}
	snake.pop();
	return Object.assign({}, state, { snake });
}

export function SnakeGame(props) {
	const [state, setState] = useState(initial);
	const [paused, setPaused] = useState(false);
	// 速度档位：默认慢速，可随时切换（重开不重置）。
	const [speedMode, setSpeedMode] = useState(loadSpeedMode);
	const stageRef = useRef(null);
	const dirRef = useRef(state.dir);
	const overRef = useRef(state.over); overRef.current = state.over;
	const pausedRef = useRef(!!(props && props.paused) || paused); pausedRef.current = !!(props && props.paused) || paused;

	const start = useCallback(() => { const init = initial(); init.started = true; dirRef.current = init.dir; setState(init); setPaused(false); }, []);
	// 待机 → 开始：按回车/空格，或直接按方向键起步。
	const begin = useCallback(() => { setState((s) => (s.started || s.over ? s : Object.assign({}, s, { started: true }))); }, []);
	const changeDir = useCallback((nv) => {
		if (overRef.current || pausedRef.current) return;
		const cur = dirRef.current;
		const opp = OPPOSITE[cur[0] + "," + cur[1]];
		if (opp && opp[0] === nv[0] && opp[1] === nv[1]) return;
		dirRef.current = nv;
		begin();
	}, [begin]);

	useEffect(() => {
		if (state.over) playSfx("over");
	}, [state.over]);

	useEffect(() => {
		if (!state.started || state.over || pausedRef.current) return;
		const mode = SPEED_MODES[speedMode] || SPEED_MODES.slow;
		const speed = Math.max(mode.min, mode.base - state.score * mode.stepMs);
		const timer = setInterval(() => setState((s) => (s.over || !s.started || pausedRef.current ? s : step(s, dirRef.current))), speed);
		return () => clearInterval(timer);
	}, [state.started, state.over, state.score, props.paused, paused, speedMode]);

	const pickSpeed = useCallback((m) => {
		setSpeedMode(m);
		try { localStorage.setItem("dsh-dock.snake.speed", m); } catch { /* ignore */ }
	}, []);

	const onKeyDown = useCallback((event) => {
		const d = DIRS[event.key];
		if (d) { event.preventDefault(); changeDir(d); return; }
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			if (overRef.current || !state.started || pausedRef.current) start();
			else setPaused((p) => !p);
			return;
		}
		if (event.key.toLowerCase() === "p") { event.preventDefault(); setPaused((p) => !p); }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); start(); }
	}, [changeDir, start, state.started]);

	useGameControls(stageRef, pausedRef.current, onKeyDown);

	const cells = [];
	for (let r = 0; r < SIZE; r += 1) {
		for (let c = 0; c < SIZE; c += 1) {
			const idx = state.snake.findIndex((s) => s.r === r && s.c === c);
			const isFood = state.food.r === r && state.food.c === c;
			let cls = "dgame-snake-cell";
			if (idx >= 0) cls += " bob" + (idx === 0 ? " head" : idx < 4 ? " body2" : "");
			if (isFood) cls += " food";
			cells.push(<i key={r + "-" + c} className={cls} aria-hidden="true" />);
		}
	}

	return <section className="dgame-game" aria-label="贪吃蛇">
		<div className="dgame-game-head"><div><h3>贪吃蛇</h3><p>回车开始/暂停，方向键控制移动；吃到食物变长并缓慢提速，撞墙或咬到自己就结束。</p></div><div className="dgame-score"><span>长度 <strong>{state.score + 3}</strong></span><span>得分 {state.score}</span></div></div>
		<div className="dgame-snake-speeds" role="radiogroup" aria-label="游戏速度">
			<span>速度</span>
			{Object.entries(SPEED_MODES).map(([m, cfg]) => (
				<button key={m} type="button" role="radio" aria-checked={speedMode === m} className={speedMode === m ? "on" : ""} onClick={() => pickSpeed(m)}>{cfg.label}</button>
			))}
		</div>
		<div className="dgame-snake-stage" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} aria-label="贪吃蛇游戏区域，使用方向键控制移动，回车开始">
			<div className="dgame-snake-grid">{cells}</div>
			{state.over ? <div className="dgame-over"><strong>撞上了 · 得 {state.score} 分</strong><button type="button" onClick={start}>重新开始</button></div> : null}
			{!state.started && !state.over ? <div className="dgame-over"><strong>按 Enter 或方向键开始</strong><button type="button" onClick={start}>开始游戏</button></div> : null}
			{state.started && !state.over && pausedRef.current ? <div className="dgame-over"><strong>已暂停</strong><button type="button" onClick={() => setPaused(false)}>继续（P）</button></div> : null}
		</div>
		<div className="dgame-controls"><button type="button" aria-label="向上" onClick={() => changeDir([-1, 0])}>↑</button><span>方向键 / WASD · 回车 开始/暂停 · R 重开</span><button type="button" aria-label="向下" onClick={() => changeDir([1, 0])}>↓</button></div>
	</section>;
}

export function SnakePreview() {
	return <span className="dgcov-prev dgcov-prev-snake" aria-hidden="true">
		<i style={{ left: "12%", top: "62%" }} /><i style={{ left: "24%", top: "62%" }} /><i style={{ left: "36%", top: "62%" }} /><i style={{ left: "48%", top: "62%" }} /><i style={{ left: "60%", top: "62%" }} />
		<b />
	</span>;
}

export const snakeGame = { Game: SnakeGame, Preview: SnakePreview, css: `
.dgame-snake-speeds{display:flex;gap:6px;align-items:center;align-self:center;justify-content:center}
.dgame-snake-speeds span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dgame-snake-speeds button{min-width:44px;height:26px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;transition:all .15s ease}
.dgame-snake-speeds button.on{color:#bbf7d0;border-color:color-mix(in srgb,#4ade80 55%,transparent);background:color-mix(in srgb,#4ade80 16%,transparent)}
.dgame-snake-speeds button:hover{border-color:#4ade80;color:var(--dsw-alias-label-primary)}
.dgame-snake-stage{position:relative;align-self:center;width:min(100%,300px);aspect-ratio:1/1;border:1px solid color-mix(in srgb,rgb(74 222 128) 32%,var(--dsw-alias-border-l1));border-radius:10px;overflow:hidden;outline:none;background:radial-gradient(circle at 50% -10%,color-mix(in srgb,#166534 30%,transparent),transparent 55%),#0a1420}.dgame-snake-stage:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(74 222 128) 35%,transparent)}.dgame-snake-grid{display:grid;grid-template-columns:repeat(16,1fr);grid-template-rows:repeat(16,1fr);width:100%;height:100%}.dgame-snake-cell{position:relative}.dgame-snake-cell.food::after{content:'';position:absolute;inset:22%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fecaca,#ef4444 70%);box-shadow:0 0 9px color-mix(in srgb,#ef4444 70%,transparent)}.dgame-snake-cell.bob::after{content:'';position:absolute;inset:20%;border-radius:26%;background:linear-gradient(135deg,#4ade80,#16a34a)}.dgame-snake-cell.head::after{background:linear-gradient(135deg,#bbf7d0,#22c55e);border-radius:30% 30% 28% 28%;box-shadow:0 1px 6px color-mix(in srgb,#22c55e 60%,transparent)}.dgame-snake-cell.head::before{content:'';position:absolute;left:30%;top:30%;width:9%;height:9%;border-radius:50%;background:#0b1b12}.dgame-snake-cell.body2::after{background:linear-gradient(135deg,#34d399,#0d9f6e)}
` };
