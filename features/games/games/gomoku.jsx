/* 趣味游戏 · 五子棋（棋盘对战）——纯 Client；玩家执黑先手，AI 执白。 */
import { useCallback, useEffect, useRef, useState } from "react";

const SIZE = 15;
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

function emptyBoard() {
	return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
}
function inBoard(r, c) {
	return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
}
// 在 (r,c) 落 color 后，沿四个方向统计连子数、开放端，计分。
function lineScore(board, r, c, color) {
	let total = 0;
	for (const [dr, dc] of DIRS) {
		let count = 1;
		let rr = r + dr, cc = c + dc;
		let openEnds = 0;
		while (inBoard(rr, cc) && board[rr][cc] === color) { count += 1; rr += dr; cc += dc; }
		if (inBoard(rr, cc) && board[rr][cc] === null) openEnds += 1;
		rr = r - dr; cc = c - dc;
		while (inBoard(rr, cc) && board[rr][cc] === color) { count += 1; rr -= dr; cc -= dc; }
		if (inBoard(rr, cc) && board[rr][cc] === null) openEnds += 1;
		total += patternScore(count, openEnds);
	}
	return total;
}
function patternScore(count, openEnds) {
	if (count >= 5) return 10000000;
	if (openEnds === 0) return 0;
	if (count === 4) return openEnds === 2 ? 1000000 : 100000;
	if (count === 3) return openEnds === 2 ? 10000 : 1000;
	if (count === 2) return openEnds === 2 ? 200 : 20;
	if (count === 1) return openEnds === 2 ? 10 : 1;
	return 0;
}
function checkWin(board, r, c, color) {
	for (const [dr, dc] of DIRS) {
		let count = 1;
		let rr = r + dr, cc = c + dc;
		while (inBoard(rr, cc) && board[rr][cc] === color) { count += 1; rr += dr; cc += dc; }
		rr = r - dr; cc = c - dc;
		while (inBoard(rr, cc) && board[rr][cc] === color) { count += 1; rr -= dr; cc -= dc; }
		if (count >= 5) return true;
	}
	return false;
}
function boardFull(board) {
	for (const row of board) for (const cell of row) if (!cell) return false;
	return true;
}
// 取有落子的附近空位（距离 ≤2），否则空盘取中心。
function candidates(board) {
	const set = [];
	const seen = new Set();
	let hasStone = false;
	for (let r = 0; r < SIZE; r += 1) {
		for (let c = 0; c < SIZE; c += 1) {
			if (!board[r][c]) continue;
			hasStone = true;
			for (let dr = -2; dr <= 2; dr += 1) {
				for (let dc = -2; dc <= 2; dc += 1) {
					const rr = r + dr, cc = c + dc;
					if (inBoard(rr, cc) && !board[rr][cc] && !seen.has(rr * SIZE + cc)) {
						seen.add(rr * SIZE + cc);
						set.push([rr, cc]);
					}
				}
			}
		}
	}
	if (!hasStone) return [[7, 7], [7, 8], [8, 7]];
	return set;
}
// AI 选点：进攻价值 + 防守价值（防对方五连/活四）。
function aiMove(board) {
	const cands = candidates(board);
	let best = null, bestScore = -1;
	for (const [r, c] of cands) {
		const attack = lineScore(board, r, c, "w");
		const defend = lineScore(board, r, c, "b");
		const score = attack + defend * 0.92;
		if (score > bestScore) { bestScore = score; best = [r, c]; }
	}
	return best || [7, 7];
}

export function GomokuGame(props) {
	const [board, setBoard] = useState(emptyBoard);
	const [turn, setTurn] = useState("b");
	const [winner, setWinner] = useState(null);
	const [last, setLast] = useState(null);
	const [history, setHistory] = useState([]);
	const [thinking, setThinking] = useState(false);
	const boardRef = useRef(board);
	boardRef.current = board;
	const turnRef = useRef(turn);
	turnRef.current = turn;
	const winRef = useRef(winner);
	winRef.current = winner;

	const finish = useCallback((b, r, c, color) => {
		if (checkWin(b, r, c, color)) setWinner(color);
		else if (boardFull(b)) setWinner("draw");
	}, []);

	const place = useCallback((r, c, color) => {
		if (boardRef.current[r][c]) return false;
		const next = boardRef.current.map((row) => row.slice());
		next[r][c] = color;
		setBoard(next);
		boardRef.current = next;
		setLast({ r, c });
		setHistory((h) => h.concat([{ r, c, color }]));
		finish(next, r, c, color);
		return true;
	}, [finish]);

	// AI 回合：思考片刻后落子（执白）。
	useEffect(() => {
		if (turn !== "w" || winner || props.paused) return;
		setThinking(true);
		const t = setTimeout(() => {
			const [r, c] = aiMove(boardRef.current);
			place(r, c, "w");
			setTurn("b");
			setThinking(false);
		}, 260);
		return () => clearTimeout(t);
	}, [turn, winner, props.paused, place]);

	const onCell = useCallback((r, c) => {
		if (winRef.current || turnRef.current !== "b" || thinking || boardRef.current[r][c]) return;
		place(r, c, "b");
		setTurn("w");
	}, [thinking, place]);

	const reset = useCallback(() => {
		setBoard(emptyBoard()); setTurn("b"); setWinner(null); setLast(null); setHistory([]); setThinking(false);
	}, []);
	const undo = useCallback(() => {
		if (winner || thinking || history.length < 2) return;
		// 回退两步：撤掉 AI 与玩家。
		const h = history.slice(0, -2);
		const next = emptyBoard();
		for (const m of h) next[m.r][m.c] = m.color;
		setBoard(next); boardRef.current = next;
		setHistory(h); setTurn("b"); setWinner(null); setLast(h.length ? h[h.length - 1] : null);
	}, [history, winner, thinking]);

	const statusText = winner === "b" ? "你赢了 · 五子连珠" : winner === "w" ? "AI 赢了 · 再试一次" : winner === "draw" ? "和棋 · 棋盘已满" : (turn === "b" ? "轮到你落子（黑）" : "AI 思考中…（白）");

	return <section className="dgame-game" aria-label="五子棋">
		<div className="dgame-game-head"><div><h3>五子棋</h3><p>你执黑先手，AI 执白；先在横竖斜任一线连成五子者胜。</p></div><div className="dgame-score"><span>回合</span><strong className="dg-gomoku-status">{statusText}</strong><button type="button" onClick={undo}>撤销</button><button type="button" onClick={reset}>重开</button></div></div>
		<div className="dgame-gomoku-board" role="grid" aria-label="十五路五子棋棋盘">
			{board.map((row, r) => row.map((cell, c) => (
				<button type="button" key={r + "-" + c} role="gridcell" className={"dgame-gomoku-cell" + (cell ? " filled " + cell : "") + (last && last.r === r && last.c === c ? " last" : "")}
					aria-label={"第" + (r + 1) + "行第" + (c + 1) + "列" + (cell === "b" ? " 黑子" : cell === "w" ? " 白子" : " 空格")}
					onClick={() => onCell(r, c)}>{cell ? <i className={"dgame-gomoku-stone " + cell} /> : null}</button>
			)))}
		</div>
		<div className="dgame-controls"><button type="button" onClick={undo}>撤销</button><span>{statusText}</span><button type="button" onClick={reset}>重开</button></div>
	</section>;
}

export function GomokuPreview() {
	return <span className="dgcov-prev dgcov-prev-gomoku" aria-hidden="true">
		{[[6, 6], [7, 7], [8, 8], [9, 9], [7, 8], [8, 7]].map(([r, c], i) => <i key={i} style={{ left: (c + 1) * 10 + "%", top: (r + 1) * 9.5 + "%" }} className={i % 3 === 0 || i === 5 ? "black" : "white"} />)}
	</span>;
}

export const gomokuGame = { Game: GomokuGame, Preview: GomokuPreview, css: `
.dgame-gomoku-board{display:grid;grid-template-columns:repeat(15,1fr);grid-template-rows:repeat(15,1fr);align-self:center;width:min(100%,320px);aspect-ratio:1/1;padding:6px;border-radius:8px;background:linear-gradient(135deg,#d9a441,#c08a2c);border:1px solid color-mix(in srgb,#8a5a1c 60%,transparent);box-shadow:0 4px 18px rgb(0 0 0/.35),inset 0 0 0 2px rgba(0,0,0,.18);background-image:repeating-linear-gradient(90deg,transparent 0 calc(100%/14),rgba(0,0,0,.16) calc(100%/14) calc(100%/14 + 1px)),repeating-linear-gradient(0deg,transparent 0 calc(100%/14),rgba(0,0,0,.16) calc(100%/14) calc(100%/14 + 1px))}.dgame-gomoku-cell{position:relative;background:transparent;border:none;cursor:pointer;padding:0;margin:0;outline:none}.dgame-gomoku-cell:focus-visible::after{content:'';position:absolute;inset:8%;border:2px solid rgba(255,255,255,.7);border-radius:50%}.dgame-gomoku-stone{position:absolute;inset:12%;border-radius:50%;display:block}.dgame-gomoku-stone.black{background:radial-gradient(circle at 34% 30%,#4b5563,#111827 68%);box-shadow:0 2px 5px rgb(0 0 0/.5),inset 0 1px 1px rgba(255,255,255,.25)}.dgame-gomoku-stone.white{background:radial-gradient(circle at 34% 30%,#ffffff,#cbd5e1 70%);box-shadow:0 2px 5px rgb(0 0 0/.4),inset 0 1px 1px rgba(255,255,255,.9)}.dgame-gomoku-cell.last .dgame-gomoku-stone::after{content:'';position:absolute;inset:32%;border-radius:50%;background:rgba(255,80,80,.9)}.dg-gomoku-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
` };
