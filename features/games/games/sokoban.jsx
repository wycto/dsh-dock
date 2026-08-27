/* 趣味游戏 · 推箱子（经典机台）——纯 Client；把箱子推到目标点上即可过关。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

// 关卡：'#' 墙 · ' ' 地板 · '.' 目标 · '$' 箱子 · '@' 人 · '*' 箱子在目标 · '+' 人在目标
const LEVELS = [
	["######", "#    #", "#@$ .#", "#    #", "######"],
	["######", "# @  #", "# $  #", "# .  #", "######"],
	["#######", "# @   #", "# $$  #", "# ..  #", "#######"],
	["######", "#@   #", "# $  #", "#  . #", "#    #", "######"],
	["#######", "# @   #", "# $   #", "#  $ .#", "#   . #", "#######"],
	["########", "#      #", "# $ $  #", "# . .  #", "#   @  #", "########"],
	// —— 扩充关：由易到难（已用求解器验证全部可解）——
	["########", "#  ##  #", "#@ $ . #", "#  ##  #", "########"],
	["########", "#  @   #", "# $$$  #", "# ...  #", "#      #", "########"],
	["########", "#@     #", "# $ $  #", "#  #   #", "# . #. #", "########"],
	["########", "#    @ #", "# $$   #", "#  ..# #", "#      #", "########"],
	["########", "#@     #", "# $ $  #", "#      #", "# .# . #", "########"],
	["#########", "#       #", "# $ $ $ #", "#  ...  #", "#   @   #", "#       #", "#########"],
	["#########", "#   @   #", "# $#$$  #", "#  ...  #", "#  ##   #", "#########"],
	["#########", "#@  #   #", "# $   $ #", "# ###   #", "#  . .  #", "#########"],
	["#########", "#     ###", "# $$ #  #", "# .. #@ #", "# $$ #  #", "# ..    #", "#########"],
];

function cloneGrid(grid) {
	return grid.map((row) => row.slice());
}
function parse(rows) {
	return rows.map((row) => row.split(""));
}
function findPlayer(grid) {
	for (let r = 0; r < grid.length; r += 1) {
		for (let c = 0; c < grid[r].length; c += 1) {
			if (grid[r][c] === "@" || grid[r][c] === "+") return { r, c };
		}
	}
	return { r: 0, c: 0 };
}
function isTarget(ch) {
	return ch === "." || ch === "*" || ch === "+";
}
function isBox(ch) {
	return ch === "$" || ch === "*";
}
// 获胜：没有箱子错位（不存在 '$'）。
function won(grid) {
	for (const row of grid) for (const ch of row) if (ch === "$") return false;
	return true;
}
function makeInitial(levelIndex) {
	const grid = parse(LEVELS[levelIndex]);
	return { grid, moves: 0, pushes: 0, level: levelIndex, wonNew: false, history: [] };
}

function step(state, dr, dc) {
	if (state.wonNew) return state;
	const grid = cloneGrid(state.grid);
	const p = findPlayer(grid);
	const nr = p.r + dr, nc = p.c + dc;
	if (nr < 0 || nr >= grid.length || nc < 0 || nc >= grid[0].length) return state;
	const target = grid[nr][nc];
	if (target === "#") return state;
	grid[p.r][p.c] = isTarget(grid[p.r][p.c]) ? "." : " ";
	if (isBox(target)) {
		const br = nr + dr, bc = nc + dc;
		if (br < 0 || br >= grid.length || bc < 0 || bc >= grid[0].length) return state;
		const beyond = grid[br][bc];
		if (beyond === "#" || isBox(beyond)) return state;
		playSfx("push");
		grid[br][bc] = isTarget(beyond) ? "*" : "$";
		grid[nr][nc] = isTarget(target) ? "+" : "@";
		return Object.assign({}, state, {
			grid,
			moves: state.moves + 1,
			pushes: state.pushes + 1,
			wonNew: won(grid),
			history: state.history.concat([{ grid: state.grid, moves: state.moves, pushes: state.pushes }]),
		});
	}
	grid[nr][nc] = isTarget(target) ? "+" : "@";
	playSfx("step");
	return Object.assign({}, state, {
		grid,
		moves: state.moves + 1,
		wonNew: won(grid),
		history: state.history.concat([{ grid: state.grid, moves: state.moves, pushes: state.pushes }]),
	});
}
function undo(state) {
	if (!state.history.length) return state;
	const prev = state.history[state.history.length - 1];
	return Object.assign({}, state, {
		grid: cloneGrid(prev.grid),
		moves: prev.moves,
		pushes: prev.pushes,
		history: state.history.slice(0, -1),
		wonNew: false,
	});
}

const DIRS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], w: [-1, 0], s: [1, 0], a: [0, -1], d: [0, 1], W: [-1, 0], S: [1, 0], A: [0, -1], D: [0, 1] };

export function SokobanGame(props) {
	const [level, setLevel] = useState(0);
	const [state, setState] = useState(() => makeInitial(0));
	const stageRef = useRef(null);
	const levelRef = useRef(level);
	levelRef.current = level;

	const move = useCallback((dr, dc) => setState((s) => step(s, dr, dc)), []);
	const prevWon = useRef(false);
	useEffect(() => {
		if (state.wonNew && !prevWon.current) playSfx("win");
		prevWon.current = state.wonNew;
	}, [state.wonNew]);
	const nextLevel = useCallback(() => {
		const n = (levelRef.current + 1) % LEVELS.length;
		setLevel(n);
		setState(makeInitial(n));
	}, []);
	const pickLevel = useCallback((i) => { setLevel(i); setState(makeInitial(i)); }, []);
	const reset = useCallback(() => setState(makeInitial(levelRef.current)), []);

	const onKeyDown = useCallback((event) => {
		const d = DIRS[event.key];
		if (d) { event.preventDefault(); move(d[0], d[1]); return; }
		if (event.key.toLowerCase() === "u") { event.preventDefault(); setState((s) => undo(s)); }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); reset(); }
		else if (event.key === "Enter" && state.wonNew) { event.preventDefault(); nextLevel(); }
	}, [move, state.wonNew, reset, nextLevel]);

	useGameControls(stageRef, props.paused, onKeyDown);

	const grid = state.grid;
	const rows = grid.length, cols = grid[0].length;
	// 宽度同时钳制：单元格理想宽、容器可用宽、按关卡长宽比折算的视口可用高——保证等比完整显示不裁切。
	const width = "min(" + (cols * 26) + "px, 100%, calc((100vh - 250px) * " + cols + " / " + rows + "))";

	return <section className="dgame-game" aria-label="推箱子">
		<div className="dgame-game-head"><div><h3>推箱子</h3><p>用方向键把箱子推到目标格子上；全部到位即过关（U 撤销、R 重置）。</p></div><div className="dgame-score"><span>步数 <strong>{state.moves}</strong></span><span>推箱 {state.pushes}</span></div></div>
		<div className="dgame-sokoban-levels" role="tablist" aria-label="选择关卡">
			{LEVELS.map((_, i) => <span key={i}><button type="button" role="tab" aria-selected={i === level} className={i === level ? "on" : ""} onClick={() => pickLevel(i)}>{i + 1}</button></span>)}
			<button type="button" onClick={() => setState((s) => undo(s))}>撤销</button>
			<button type="button" onClick={reset}>重置</button>
		</div>
		<div className="dgame-sokoban-stage" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} style={{ width, gridTemplateColumns: "repeat(" + cols + ",1fr)", gridTemplateRows: "repeat(" + rows + ",1fr)", aspectRatio: cols + " / " + rows }} aria-label="推箱子游戏区域，使用方向键移动，U 撤销，R 重置">
			{grid.map((row, r) => row.map((ch, c) => {
				let cls = "dgame-soko-cell";
				if (ch === "#") cls += " wall";
				else if (ch === "." || ch === "*" || ch === "+") cls += " target";
				if (ch === "$" || ch === "*") cls += " box";
				if (ch === "@" || ch === "+") cls += " player";
				return <i key={r + "-" + c} className={cls} aria-hidden="true" />;
			}))}
			{state.wonNew ? <div className="dgame-over"><strong>全搞定！第 {level + 1} 关通过</strong><button type="button" onClick={nextLevel}>{level + 1 < LEVELS.length ? "下一关" : "重新开始"}</button></div> : null}
		</div>
		<div className="dgame-controls"><button type="button" aria-label="向上" onClick={() => move(-1, 0)}>↑</button><span>方向键 / WASD · U 撤销 · R 重置</span><button type="button" aria-label="向下" onClick={() => move(1, 0)}>↓</button></div>
	</section>;
}

export function SokobanPreview() {
	// 迷你关卡画面：墙/地/箱/目标/小人色块，与真实游戏元素一致。
	const ROWS = [
		"#######",
		"#     #",
		"# .$@ #",
		"# .*  #",
		"#######",
	];
	const cls = { "#": "wall", " ": "floor", ".": "target", "$": "box", "*": "boxT", "@": "player", "+": "player" };
	return <span className="dgcov-prev dgcov-prev-soko" aria-hidden="true">
		<span className="dgp-soko-grid">
			{ROWS.flatMap((row, r) => row.split("").map((ch, c) => <i key={r + "-" + c} className={"dgp-soko-" + cls[ch]} />))}
		</span>
	</span>;
}

export const sokobanGame = { Game: SokobanGame, Preview: SokobanPreview, css: `
.dgame-sokoban-stage{position:relative;display:grid;align-self:center;gap:0;padding:6px;border:1px solid color-mix(in srgb,rgb(250 204 21) 32%,var(--dsw-alias-border-l1));border-radius:8px;background:linear-gradient(180deg,#181420,#14101f);outline:none;box-shadow:inset 0 0 26px rgb(0 0 0/.4)}.dgame-sokoban-stage:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(250 204 21) 30%,transparent)}.dgame-soko-cell{position:relative;display:block;min-width:0;min-height:0}.dgame-soko-cell.wall{background:linear-gradient(180deg,#3a3350,#241f3a);box-shadow:inset 0 1px 0 rgba(255,255,255,.12),inset 0 -1px 0 rgba(0,0,0,.4)}.dgame-soko-cell.target::before{content:'';position:absolute;inset:30%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fde68a,#f59e0b 70%);box-shadow:0 0 8px color-mix(in srgb,#f59e0b 55%,transparent);opacity:.9}.dgame-soko-cell.box::after{content:'';position:absolute;inset:12%;border-radius:5px;background:linear-gradient(135deg,#d4a24a,#8a5a1c);box-shadow:0 2px 5px rgb(0 0 0/.45),inset 0 1px 0 rgba(255,255,255,.4);border:1px solid color-mix(in srgb,#fde68a 45%,transparent)}.dgame-soko-cell.box.target::after{background:linear-gradient(135deg,#34d399,#0f766e);border-color:#a7f3d0}.dgame-soko-cell.player::before{content:'';position:absolute;inset:18%;border-radius:50%;background:radial-gradient(circle at 35% 30%,#e0f2fe,#38bdf8 70%);box-shadow:0 0 9px color-mix(in srgb,#38bdf8 70%,transparent)}.dgame-sokoban-levels{display:flex;gap:6px;align-items:center;align-self:center;flex-wrap:wrap;width:min(100%,340px);justify-content:center}.dgame-sokoban-levels button{min-width:30px;height:28px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;transition:all .15s ease}.dgame-sokoban-levels button.on{color:#fde68a;border-color:color-mix(in srgb,#f59e0b 60%,transparent);background:color-mix(in srgb,#f59e0b 18%,transparent)}.dgame-sokoban-levels button:hover{border-color:var(--dgame-accent);color:var(--dsw-alias-label-primary)}
` };
