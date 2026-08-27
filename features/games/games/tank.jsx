/* 趣味游戏 · 坦克大战（经典机台）——纯 Client；击毁敌方坦克、守住基地过关。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GRID, EMPTY, STEEL, BRICK, BASE, initialState, step, nextWave, findBase } from "../tank-core.js";
import { focusStage, useGameControls } from "./shared.jsx";

const DIR_ANGLE = { up: 0, right: 90, down: 180, left: 270 };
const ENEMY_COLORS = ["#f87171", "#fb923c", "#c084fc", "#4ade80", "#38bdf8"];

export function TankGame(props) {
	const [snap, setSnap] = useState(initialState);
	const [status, setStatus] = useState("play"); // play | wave | over | win
	const snapRef = useRef(snap); snapRef.current = snap;
	const keys = useRef({ dir: null, shoot: false });
	const pausedRef = useRef(!!(props && props.paused)); pausedRef.current = !!(props && props.paused);
	const statusRef = useRef("play"); statusRef.current = status;
	const boardRef = useRef(null);

	const start = useCallback(() => {
		setSnap(initialState()); setStatus("play"); statusRef.current = "play";
	}, []);
	const nextLvl = useCallback(() => {
		setSnap((s) => nextWave(s)); setStatus("play"); statusRef.current = "play";
	}, []);

	// 主循环
	useEffect(() => {
		const timer = setInterval(() => {
			if (pausedRef.current) return;
			setSnap((s) => {
				if (s.over || s.win) return s;
				const input = { dir: keys.current.dir, shoot: keys.current.shoot };
				const ns = step(s, input);
				if (ns.over && statusRef.current === "play") { statusRef.current = "over"; setStatus("over"); }
				else if (ns.win && statusRef.current === "play") { statusRef.current = "wave"; setStatus("wave"); }
				return ns;
			});
		}, 120);
		return () => clearInterval(timer);
	}, []);

	const stageRef = useRef(null);
	const onKeyDown = useCallback((event) => {
		if (pausedRef.current) return;
		const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right" };
		const dir = map[event.key];
		if (dir) { event.preventDefault(); keys.current.dir = dir; return; }
		if (event.key === " ") { event.preventDefault(); keys.current.shoot = true; }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); start(); }
	}, [start]);
	const onKeyUp = useCallback((event) => {
		const map = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right" };
		const dir = map[event.key];
		if (dir && keys.current.dir === dir) keys.current.dir = null;
		if (event.key === " ") keys.current.shoot = false;
	}, []);
	useGameControls(stageRef, pausedRef.current, onKeyDown, onKeyUp);

	const grid = snap.grid;
	const player = snap.player;
	const enemies = snap.enemies;
	const bullets = snap.bullets;
	let playerPos = null;
	if (player && player.alive) playerPos = { r: player.r, c: player.c };
	const enemyMap = {};
	for (const e of enemies) enemyMap[e.r + "-" + e.c] = e;
	const bulletMap = {};
	for (const b of bullets) bulletMap[b.r + "-" + b.c] = b;
	const basePos = findBase(grid);

	const cells = [];
	for (let r = 0; r < GRID; r += 1) {
		for (let c = 0; c < GRID; c += 1) {
			const key = r + "-" + c;
			let cls = "dgame-tank-cell";
			let inner = null;
			if (grid[r][c] === STEEL) cls += " steel";
			else if (grid[r][c] === BRICK) cls += " brick";
			else if (grid[r][c] === BASE) cls += " base";
			if (playerPos && playerPos.r === r && playerPos.c === c) {
				cls += " pw";
				inner = <i className="dgame-tank-body pw" style={{ transform: "rotate(" + DIR_ANGLE[player.dir] + "deg)" }} />;
			} else if (enemyMap[key]) {
				const e = enemyMap[key];
				cls += " en";
				inner = <i className="dgame-tank-body en" style={{ background: ENEMY_COLORS[(e.r + e.c) % ENEMY_COLORS.length], transform: "rotate(" + DIR_ANGLE[e.dir] + "deg)" }} />;
			}
			if (bullets && bulletMap[key]) cls += " bullet";
			cells.push(<span key={key} className={cls}>{inner}{bulletMap[key] ? <i className="dgame-tank-bullet" aria-hidden="true" /> : null}{grid[r][c] === BASE ? <b className="dgame-tank-flag" aria-hidden="true">⚑</b> : null}</span>);
		}
	}

	const statusText = status === "over" ? "基地失守 · 游戏结束" : status === "wave" ? "第 " + snap.wave + " 波清空！进入下一波" : ("第 " + snap.wave + " 波 · 待歼灭 " + (snap.remaining + snap.enemies.length) + " 辆 · 生命 × " + (player && player.lives));

	return <section className="dgame-game" aria-label="坦克大战">
		<div className="dgame-game-head"><div><h3>坦克大战</h3><p>方向键移动，空格开炮；击毁敌方坦克，别让敌军摧毁中央基地。</p></div><div className="dgame-score"><span>得分 <strong>{snap.score}</strong></span><span>生命 × {player && player.lives}</span></div></div>
		<div className="dgame-tank-stage" ref={stageRef} tabIndex={0} role="grid" onKeyDown={onKeyDown} onKeyUp={onKeyUp} onClick={() => focusStage(stageRef)} aria-label="坦克大战游戏区域，方向键移动，空格开炮">
			<div className="dgame-tank-grid">{cells}</div>
			{status === "over" ? <div className="dgame-over"><strong>胜败已分 · 得 {snap.score} 分</strong><button type="button" onClick={start}>重新开始</button></div> : null}
			{status === "wave" ? <div className="dgame-over"><strong>第 {snap.wave} 波清空！</strong><button type="button" onClick={nextLvl}>下一波</button></div> : null}
		</div>
		<div className="dgame-controls dgame-tank-controls">
			<button type="button" aria-label="向上" onClick={() => { keys.current.dir = "up"; setTimeout(() => { if (keys.current.dir === "up") keys.current.dir = null; }, 90); }}>↑</button>
			<span>方向键 / WASD · 空格开炮 · R 重开</span>
			<button type="button" className="dgame-tank-fire" aria-label="开炮" onClick={() => { keys.current.shoot = true; setTimeout(() => { keys.current.shoot = false; }, 90); }}>开炮</button>
		</div>
	</section>;
}

export function TankPreview() {
	// 迷你战场：砖墙/钢墙色块 + 我方坦克 + 敌方坦克 + 基地，与真实游戏元素一致。
	const ROWS = [
		"..B..B..",
		"S.....E.",
		"..B.B...",
		"B..S...B",
		"...P..F.",
	];
	const cls = { ".": "void", B: "brick", S: "steel", P: "pw", E: "en", F: "base" };
	return <span className="dgcov-prev dgcov-prev-tank" aria-hidden="true">
		<span className="dgp-tank-grid">
			{ROWS.flatMap((row, r) => row.split("").map((ch, c) => <i key={r + "-" + c} className={"dgp-tank-" + cls[ch]} />))}
		</span>
	</span>;
}

export const tankGame = { Game: TankGame, Preview: TankPreview, css: `
.dgame-tank-stage{position:relative;align-self:center;width:min(100%,320px);aspect-ratio:1/1;border:1px solid color-mix(in srgb,rgb(250 204 21) 32%,var(--dsw-alias-border-l1));border-radius:8px;overflow:hidden;outline:none;background:linear-gradient(180deg,#1a1425,#100d1c);box-shadow:inset 0 0 26px rgb(0 0 0/.5)}.dgame-tank-stage:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(250 204 21) 30%,transparent)}.dgame-tank-grid{display:grid;grid-template-columns:repeat(15,1fr);grid-template-rows:repeat(15,1fr);width:100%;height:100%;gap:0}.dgame-tank-cell{position:relative;background:rgba(255,255,255,.03);min-width:0;min-height:0}.dgame-tank-cell.steel{background:linear-gradient(180deg,#94a3b8,#64748b)}.dgame-tank-cell.brick{background:repeating-linear-gradient(45deg,#a3672a 0 55%,#8a5a1c 55% 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.25)}.dgame-tank-cell.base{background:#fbbf24}.dgame-tank-cell.bullet::before{content:'';position:absolute;inset:38%;background:#fef3c7;box-shadow:0 0 5px #fef3c7;z-index:4}.dgame-tank-flag{position:absolute;inset:0;display:grid;place-items:center;color:#7c2d12;font-size:18px;z-index:2}.dgame-tank-body{position:absolute;inset:16%;display:block;border-radius:16%;z-index:3;transition:transform .1s ease}.dgame-tank-body.pw{background:linear-gradient(135deg,#fde047,#eab308);box-shadow:0 0 7px color-mix(in srgb,#eab308 55%,transparent)}.dgame-tank-body.en{background:#f87171;box-shadow:0 0 5px color-mix(in srgb,#f87171 40%,transparent)}.dgame-tank-body::before{content:'';position:absolute;left:38%;top:-30%;width:24%;height:64%;background:rgba(255,255,255,.5);border-radius:3px}.dgame-tank-controls{grid-template-columns:1fr auto 1fr}
` };
