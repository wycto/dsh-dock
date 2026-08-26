/* 趣味游戏 · 俄罗斯方块（经典机台）——纯 Client，键盘/按钮可玩；不写会话、不改工作区。 */
import { useCallback, useEffect, useRef, useState } from "react";

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
function makePiece(type, x, y) {
	const p = PIECES[type];
	return { type, rot: 0, x, y: y != null ? y : -1, mat: p.rots[0], color: p.color };
}
function initial() {
	const bag = seedBag();
	const piece = makePiece(bag.pop(), 3);
	const next = bag.pop();
	return { board: emptyBoard(), piece, next, bag, score: 0, lines: 0, level: 1, over: false };
}
// 用"下一个"方块生成当前块并补足 7-bag。
function spawnFrom(state) {
	const bag = state.bag && state.bag.length ? state.bag.slice() : seedBag();
	const type = state.next != null ? state.next : bag.pop();
	const next = bag.length ? bag.pop() : null;
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
	const cleared = clearLines(merged);
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
	const cleared = clearLines(merged);
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
			const x2 = s.piece.x - 1;
			if (collides(s.board, s.piece.mat, x2, s.piece.y)) return s;
			return Object.assign({}, s, { piece: Object.assign({}, s.piece, { x: x2 }) });
		}
		if (action === "right") {
			const x2 = s.piece.x + 1;
			if (collides(s.board, s.piece.mat, x2, s.piece.y)) return s;
			return Object.assign({}, s, { piece: Object.assign({}, s.piece, { x: x2 }) });
		}
		if (action === "down") return advance(s);
		if (action === "drop") return hardDrop(s);
		if (action === "cw" || action === "ccw") return rotatePiece(s, action === "cw" ? 1 : -1);
		return s;
	}), []);

	const onKeyDown = useCallback((event) => {
		const action = KEY_ACTIONS[event.key];
		if (action) { event.preventDefault(); act(action); return; }
		if (event.key.toLowerCase() === "p") { event.preventDefault(); setManualPause((p) => !p); }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); setState(initial()); setManualPause(false); }
	}, [act]);

	useEffect(() => {
		if (pausedRef.current || state.over) return;
		const speed = Math.max(80, 720 - (state.level - 1) * 70);
		const timer = setInterval(() => act("down"), speed);
		return () => clearInterval(timer);
	}, [state.level, state.over, act, props.paused, manualPause]);

	useEffect(() => {
		if (pausedRef.current || state.over) return;
		if (stageRef.current) stageRef.current.focus();
	}, [state.over, props.paused, manualPause]);

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
			<div className="dgame-tetris-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} aria-label="俄罗斯方块游戏区域，使用方向键与空格控制">
				{display.map((row, rr) => row.map((cell, cc) => <i key={rr + "-" + cc} className="dgame-tetris-cell" style={cell ? { background: cell, boxShadow: "0 0 8px " + cell + "aa, inset 0 0 4px rgba(255,255,255,.5)" } : undefined} />))}
				{state.over ? <div className="dgame-over"><strong>方块堆到顶了</strong><button type="button" onClick={() => setState(initial())}>再来一局</button></div> : <span className="dgame-tetris-bg" aria-hidden="true" />}
				{!state.over && (props.paused || manualPause) ? <div className="dgame-over"><strong>已暂停</strong><button type="button" onClick={() => setManualPause(false)}>继续（P）</button></div> : null}
			</div>
			<div className="dgame-tetris-side">
				<div className="dgame-tetris-next"><span>下一个</span><div className="dgame-tetris-nextbox">{nextMat.map((row, r) => row.map((cell, c) => <i key={r + "-" + c} className="dgame-tetris-cell" style={cell ? { background: PIECES[nextType].color } : undefined} />))}</div></div>
				<div className="dgame-tetris-keys"><b>操作</b><span>←/→ 移动 · ↓ 下落 · ↑/X 旋转 · Z 反向 · 空格 直落 · P 暂停 · R 重开</span></div>
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
	return <span className="dgcov-prev dgcov-prev-tetris" aria-hidden="true">
		<i style={{ left: "34%", top: "10%", background: "#22d3ee" }} />
		<i style={{ left: "24%", top: "40%", background: "#facc15" }} />
		<i style={{ left: "46%", top: "48%", background: "#c084fc" }} />
		<i style={{ left: "68%", top: "26%", background: "#4ade80" }} />
		<i style={{ left: "54%", top: "68%", background: "#f87171" }} />
		<i style={{ left: "26%", top: "74%", background: "#60a5fa" }} />
		<i style={{ left: "72%", top: "60%", background: "#fb923c" }} />
		<b />
	</span>;
}

export const tetrisGame = { Game: TetrisGame, Preview: TetrisPreview, css: `
.dgame-tetris{display:flex;gap:12px;align-items:flex-start;align-self:center;width:min(100%,360px);justify-content:center}.dgame-tetris-board{position:relative;flex:none;display:grid;grid-template-columns:repeat(10,1fr);grid-template-rows:repeat(20,1fr);width:min(100%,188px);aspect-ratio:10/20;border:1px solid color-mix(in srgb,rgb(34 211 238) 35%,var(--dsw-alias-border-l1));border-radius:8px;overflow:hidden;outline:none;background:linear-gradient(180deg,#0c1024,#131a3d);padding:0;box-shadow:inset 0 0 30px rgb(0 0 0/.45)}.dgame-tetris-board:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(34 211 238) 40%,transparent)}.dgame-tetris-cell{display:block;background:transparent;border-radius:2px;margin:1px}.dgame-tetris-nextbox{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(2,1fr);width:60px;height:32px}.dgame-tetris-side{flex:none;display:flex;flex-direction:column;gap:9px;min-width:112px;color:var(--dsw-alias-label-tertiary);font-size:11px}.dgame-tetris-side b{color:var(--dsw-alias-label-secondary);font-size:12px}.dgame-tetris-side span{font-size:11px}.dgame-tetris-nextbox .dgame-tetris-cell{margin:1px}.dgame-tetris-keys span{display:block;line-height:1.6;color:var(--dsw-alias-label-tertiary)}.dgame-tetris-next{display:flex;flex-direction:column;gap:5px;align-items:center}.dgame-tetris-next span{color:var(--dsw-alias-label-secondary)}.dgame-tetris-bg{position:absolute;inset:0;pointer-events:none;background-image:repeating-linear-gradient(0deg,color-mix(in srgb,#60a5fa 7%,transparent) 0 1px,transparent 1px calc(100% / 20)),repeating-linear-gradient(90deg,color-mix(in srgb,#60a5fa 7%,transparent) 0 1px,transparent 1px calc(100% / 10));opacity:.5}@media (max-width:680px){.dgame-tetris{width:100%;gap:8px}.dgame-tetris-board{width:min(100%,170px)}}
` };
