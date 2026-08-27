/* 趣味游戏 · 俄罗斯方块（经典机台）——纯 Client，键盘/按钮可玩；不写会话、不改工作区。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

const COLS = 10, ROWS = 20;
const SHAPES = [
	{ color: "#22d3ee", mat: [[1, 1, 1, 1]] },
	{ color: "#facc15", mat: [[1, 1], [1, 1]] },
	{ color: "#c084fc", mat: [[0, 1, 0], [1, 1, 1]] },
	{ color: "#4ade80", mat: [[0, 1, 1], [1, 1, 0]] },
	{ color: "#f87171", mat: [[1, 1, 0], [0, 1, 1]] },
	{ color: "#60a5fa", mat: [[1, 0, 0], [1, 1, 1]] },
	{ color: "#fb923c", mat: [[0, 0, 1], [1, 1, 1]] },
];

function rotateCW(mat) {
	return mat[0].map((_, col) => mat.map((row) => row[col]).reverse());
}
function rotations(shape) {
	const list = [shape.mat];
	let cur = shape.mat;
	for (let i = 0; i < 3; i += 1) {
		cur = rotateCW(cur);
		if (!list.some((m) => JSON.stringify(m) === JSON.stringify(cur))) list.push(cur);
	}
	return list;
}
const PIECES = SHAPES.map((s) => ({ color: s.color, rots: rotations(s) }));

// 精确网格线（viewBox 1000×2000，轨道与方块单元格逐一对齐，杜绝背景纹理的亚像素漂移）。
const TETRIS_GRID = (() => {
	const lines = [];
	let k = 0;
	for (let i = 1; i < 10; i += 1) lines.push(<line key={k++} x1={i * 100} y1={0} x2={i * 100} y2={2000} />);
	for (let j = 1; j < 20; j += 1) lines.push(<line key={k++} x1={0} y1={j * 100} x2={1000} y2={j * 100} />);
	return lines;
})();

function emptyBoard() {
	return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}
function collides(board, mat, x, y) {
	for (let r = 0; r < mat.length; r += 1) {
		for (let c = 0; c < mat[r].length; c += 1) {
			if (!mat[r][c]) continue;
			const bx = x + c, by = y + r;
			if (bx < 0 || bx >= COLS || by >= ROWS || (by >= 0 && board[by][bx])) return true;
		}
	}
	return false;
}
function merge(board, mat, x, y, color) {
	const next = board.map((row) => row.slice());
	for (let r = 0; r < mat.length; r += 1) {
		for (let c = 0; c < mat[r].length; c += 1) {
			if (mat[r][c] && y + r >= 0) next[y + r][x + c] = color;
		}
	}
	return next;
}
function clearLines(board) {
	const kept = board.filter((row) => row.some((cell) => !cell));
	const cleared = ROWS - kept.length;
	while (kept.length < ROWS) kept.unshift(Array(COLS).fill(null));
	return { board: kept, cleared };
}
function seedBag() {
	const bag = SHAPES.map((_, i) => i);
	for (let i = bag.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[bag[i], bag[j]] = [bag[j], bag[i]];
	}
	return bag;
}
let PIECE_SEQ = 0;
function makePiece(type, x, y) {
	const p = PIECES[type];
	return { id: ++PIECE_SEQ, type, rot: 0, x, y: y != null ? y : -1, mat: p.rots[0], color: p.color };
}
function initial() {
	const bag = seedBag();
	const piece = makePiece(bag.pop(), 3);
	const next = bag.pop();
	return { board: emptyBoard(), piece, next, bag, score: 0, lines: 0, level: 1, over: false };
}
// 用"下一个"方块生成当前块并补足 7-bag。bag 耗尽时立即重洗新 bag，
// 保证预览 next 永远不为空（否则会与实际生成的方块不一致）。
function spawnFrom(state) {
	let bag = state.bag && state.bag.length ? state.bag.slice() : seedBag();
	const type = state.next != null ? state.next : bag.pop();
	let next = bag.length ? bag.pop() : null;
	if (next == null) {
		bag = seedBag();
		next = bag.pop();
	}
	const piece = makePiece(type, 3);
	const over = collides(state.board, piece.mat, piece.x, piece.y) || state.over;
	return Object.assign({}, state, { bag, next, piece, over });
}
// 推进一格：能下移则下移，否则落地合并、消行、生成下一个。
function advance(state) {
	if (state.over) return state;
	const p = state.piece;
	if (!collides(state.board, p.mat, p.x, p.y + 1)) {
		return Object.assign({}, state, { piece: Object.assign({}, p, { y: p.y + 1 }), score: state.score + 1 });
	}
	const merged = merge(state.board, p.mat, p.x, p.y, p.color);
	playSfx("lock");
	const cleared = clearLines(merged);
	if (cleared.cleared) playSfx(cleared.cleared >= 4 ? "win" : "clear");
	const lines = state.lines + cleared.cleared;
	const level = Math.floor(lines / 10) + 1;
	const base = [0, 100, 300, 500, 800][cleared.cleared] || 800;
	const scored = Object.assign({}, state, {
		board: cleared.board, lines, level,
		score: state.score + base * state.level,
	});
	return spawnFrom(scored);
}
function hardDrop(state) {
	if (state.over) return state;
	let y = state.piece.y, dist = 0;
	while (!collides(state.board, state.piece.mat, state.piece.x, y + 1)) { y += 1; dist += 1; }
	const p = Object.assign({}, state.piece, { y });
	const merged = merge(state.board, p.mat, p.x, p.y, p.color);
	playSfx("lock");
	const cleared = clearLines(merged);
	if (cleared.cleared) playSfx(cleared.cleared >= 4 ? "win" : "clear");
	const lines = state.lines + cleared.cleared;
	const level = Math.floor(lines / 10) + 1;
	const base = [0, 100, 300, 500, 800][cleared.cleared] || 800;
	const scored = Object.assign({}, state, {
		board: cleared.board, lines, level,
		score: state.score + base * state.level + dist * 2,
	});
	return spawnFrom(scored);
}

const KEY_ACTIONS = {
	"ArrowLeft": "left", "a": "left", "A": "left",
	"ArrowRight": "right", "d": "right", "D": "right",
	// 下键 = 快速下滑（一格一格连降，松开即停；空格/回车才是直落到底）。
	"ArrowDown": "down", "s": "down", "S": "down",
	"ArrowUp": "cw", "x": "cw", "X": "cw",
	"z": "ccw", "Z": "ccw",
	" ": "drop", "Enter": "drop",
};

export function TetrisGame(props) {
	const [state, setState] = useState(initial);
	const [manualPause, setManualPause] = useState(false);
	const pausedRef = useRef(!!(props && props.paused));
	pausedRef.current = !!(props && props.paused) || manualPause;
	const stageRef = useRef(null);

	// 事件委托统一处理（避免按钮/键盘两套逻辑）。
	const act = useCallback((action) => setState((s) => {
		if (pausedRef.current) return s;
		if (action === "left") {
			playSfx("move");
			const x2 = s.piece.x - 1;
			if (collides(s.board, s.piece.mat, x2, s.piece.y)) return s;
			return Object.assign({}, s, { piece: Object.assign({}, s.piece, { x: x2 }) });
		}
		if (action === "right") {
			playSfx("move");
			const x2 = s.piece.x + 1;
			if (collides(s.board, s.piece.mat, x2, s.piece.y)) return s;
			return Object.assign({}, s, { piece: Object.assign({}, s.piece, { x: x2 }) });
		}
		if (action === "down") return advance(s);
		if (action === "drop") return hardDrop(s);
		if (action === "cw" || action === "ccw") { playSfx("rotate"); return rotatePiece(s, action === "cw" ? 1 : -1); }
		return s;
	}), []);

	// 下键快速下滑：按住时以 45ms/格 连降（松开即停，可中途左右修正），不直接到底。
	// 只对"按住时正在下落的那个方块"生效——它一旦落定生成新方块，连降自动结束。
	const softRef = useRef(null);
	const stateRef = useRef(state); stateRef.current = state;
	const holdIdRef = useRef(null);
	const stopSoft = useCallback(() => {
		if (softRef.current) { clearInterval(softRef.current); softRef.current = null; }
	}, []);
	useEffect(() => {
		if (state.over || manualPause || props.paused) stopSoft();
		return stopSoft;
	}, [state.over, manualPause, props.paused, stopSoft]);

	const onKeyDown = useCallback((event) => {
		const action = KEY_ACTIONS[event.key];
		if (action) {
			event.preventDefault();
			if (action === "down") {
				const pieceId = stateRef.current.piece && stateRef.current.piece.id;
				act("down");
				if (!softRef.current && !pausedRef.current) {
					holdIdRef.current = pieceId;
					softRef.current = setInterval(() => {
						const cur = stateRef.current;
						if (pausedRef.current || cur.over || !cur.piece || cur.piece.id !== holdIdRef.current) { stopSoft(); return; }
						act("down");
					}, 45);
				}
				return;
			}
			act(action);
			return;
		}
		if (event.key.toLowerCase() === "p") { event.preventDefault(); setManualPause((p) => !p); }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); setState(initial()); setManualPause(false); }
	}, [act, stopSoft]);
	const onKeyUp = useCallback((event) => {
		if (KEY_ACTIONS[event.key] === "down") stopSoft();
	}, [stopSoft]);

	useEffect(() => {
		if (state.over) playSfx("over");
	}, [state.over]);

	useEffect(() => {
		if (pausedRef.current || state.over) return;
		const speed = Math.max(80, 720 - (state.level - 1) * 70);
		const timer = setInterval(() => act("down"), speed);
		return () => clearInterval(timer);
	}, [state.level, state.over, act, props.paused, manualPause]);

	useGameControls(stageRef, pausedRef.current, onKeyDown, onKeyUp);

	const display = state.board.map((row) => row.slice());
	if (!state.over) {
		const m = state.piece.mat;
		for (let r = 0; r < m.length; r += 1) {
			for (let c = 0; c < m[r].length; c += 1) {
				if (m[r][c]) {
					const by = state.piece.y + r, bx = state.piece.x + c;
					if (by >= 0 && by < ROWS && bx >= 0 && bx < COLS) display[by][bx] = state.piece.color;
				}
			}
		}
	}
	const nextType = state.next != null ? state.next : 0;
	const nextMat = PIECES[nextType].rots[0];

	return <section className="dgame-game" aria-label="俄罗斯方块">
		<div className="dgame-game-head"><div><h3>俄罗斯方块</h3><p>拼满一行即消除，速度随等级加快；方块堆到顶端就结束。</p></div><div className="dgame-score"><span>得分 <strong>{state.score}</strong></span><span>等级 {state.level} · 消行 {state.lines}</span></div></div>
		<div className="dgame-tetris">
			<div className="dgame-tetris-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onBlur={stopSoft} onClick={() => focusStage(stageRef)} aria-label="俄罗斯方块游戏区域，使用方向键与空格控制">
				{display.map((row, rr) => row.map((cell, cc) => <i key={rr + "-" + cc} className="dgame-tetris-cell" style={cell ? { background: cell, boxShadow: "0 0 8px " + cell + "aa, inset 0 0 4px rgba(255,255,255,.5)" } : undefined} />))}
				{state.over ? <div className="dgame-over"><strong>方块堆到顶了</strong><button type="button" onClick={() => setState(initial())}>再来一局</button></div> : <svg className="dgame-tetris-lines" viewBox="0 0 1000 2000" preserveAspectRatio="none" aria-hidden="true">{TETRIS_GRID}</svg>}
				{!state.over && (props.paused || manualPause) ? <div className="dgame-over"><strong>已暂停</strong><button type="button" onClick={() => setManualPause(false)}>继续（P）</button></div> : null}
			</div>
			<div className="dgame-tetris-side">
				<div className="dgame-tetris-next"><span>下一个</span><div className="dgame-tetris-nextbox">{nextMat.map((row, r) => row.map((cell, c) => <i key={r + "-" + c} className="dgame-tetris-cell" style={cell ? { background: PIECES[nextType].color } : undefined} />))}</div></div>
				<div className="dgame-tetris-keys"><b>操作</b><span>←/→ 移动 · ↓ 快速下滑 · ↑/X 旋转 · Z 反向 · 空格 直落 · P 暂停 · R 重开</span></div>
			</div>
		</div>
		<div className="dgame-controls"><button type="button" aria-label="左移" onClick={() => act("left")}>← 左移</button><span>方向键 / X、Z、空格、P</span><button type="button" aria-label="右移" onClick={() => act("right")}>右移 {'->'}</button></div>
	</section>;
}

// 旋转：带简单墙踢。
function rotatePiece(state, dir) {
	const rots = PIECES[state.piece.type].rots;
	const len = rots.length;
	const nextRot = ((state.piece.rot + dir) % len + len) % len;
	const mat = rots[nextRot];
	const kicks = [0, -1, 1, -2, 2, -1 - (state.piece.y < 0 ? 1 : 0), 1 + (state.piece.y < 0 ? 1 : 0), -1, 1];
	for (const kx of kicks) {
		if (!collides(state.board, mat, state.piece.x + kx, state.piece.y)) {
			return Object.assign({}, state, { piece: Object.assign({}, state.piece, { rot: nextRot, x: state.piece.x + kx, mat }) });
		}
	}
	return state;
}

export function TetrisPreview() {
	// 迷你棋盘：底部已堆方块 + 悬浮下落中的 T 块，与真实游戏画面一致。
	const COLORS = { I: "I", O: "O", T: "T", S: "S", Z: "Z", J: "J", L: "L" };
	const ROWS = [
		"..........",
		"....TT....",
		"..........",
		".......Z..",
		"..OO.S.Z..",
		"SS..LSOZZ.",
		"JJSLLSOZZI",
		"JJSLLOSOII",
	];
	const isFall = (r) => r === 1;
	return <span className="dgcov-prev dgcov-prev-tetris" aria-hidden="true">
		<span className="dgp-tet-grid">
			{ROWS.flatMap((row, r) => row.split("").map((ch, c) => (
				<i key={r + "-" + c} className={COLORS[ch] ? "c" + COLORS[ch] + (isFall(r) ? " fall" : "") : ""} />
			)))}
		</span>
	</span>;
}

export const tetrisGame = { Game: TetrisGame, Preview: TetrisPreview, css: `
.dgame-tetris{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;align-self:center;width:fit-content;max-width:100%;margin-inline:auto;justify-content:center}.dgame-tetris-board{position:relative;flex:none;display:grid;grid-template-columns:repeat(10,1fr);grid-template-rows:repeat(20,1fr);width:min(100%,188px);aspect-ratio:10/20;border:1px solid color-mix(in srgb,rgb(34 211 238) 35%,var(--dsw-alias-border-l1));border-radius:8px;overflow:hidden;outline:none;background:linear-gradient(180deg,#0c1024,#131a3d);padding:0;box-shadow:inset 0 0 30px rgb(0 0 0/.45)}.dgame-tetris-board:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(34 211 238) 40%,transparent)}.dgame-tetris-cell{display:block;background:transparent;border-radius:2px;margin:1px}.dgame-tetris-nextbox{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(2,1fr);width:60px;height:32px}.dgame-tetris-side{flex:1 1 96px;display:flex;flex-direction:column;gap:9px;min-width:0;max-width:220px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dgame-tetris-side b{color:var(--dsw-alias-label-secondary);font-size:12px}.dgame-tetris-side span{font-size:11px}.dgame-tetris-nextbox .dgame-tetris-cell{margin:1px}.dgame-tetris-keys span{display:block;line-height:1.6;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}.dgame-tetris-next{display:flex;flex-direction:column;gap:5px;align-items:center}.dgame-tetris-next span{color:var(--dsw-alias-label-secondary)}.dgame-tetris-lines{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.dgame-tetris-lines line{stroke:#60a5fa;stroke-opacity:.12;stroke-width:2}@media (max-width:680px){.dgame-tetris{width:100%;gap:8px}.dgame-tetris-board{width:min(100%,170px)}}
` };
