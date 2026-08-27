/* 趣味游戏 · 五子棋（棋盘对战）——纯 Client；玩家执黑先手，AI 执白。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

// 正规棋盘：SVG 精确绘制（viewBox 1500×1500，交点对齐各格中心）。外框加粗，五个星位点。
const GOMOKU_LINES = (() => {
	const P = (n) => n * 100 + 50;
	const parts = [<rect key="frame" x={P(0)} y={P(0)} width={1400} height={1400} strokeWidth={6.5} fill="none" />];
	let k = 0;
	for (let i = 1; i <= 13; i += 1) {
		parts.push(<line key={k++} x1={P(i)} y1={P(0)} x2={P(i)} y2={P(14)} />);
		parts.push(<line key={k++} x1={P(0)} y1={P(i)} x2={P(14)} y2={P(i)} />);
	}
	for (const [r, c] of [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]]) {
		parts.push(<circle key={k++} className="dgame-gomoku-star" cx={P(c)} cy={P(r)} r={15} />);
	}
	return parts;
})();

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
// 返回连成五子（含以上）的坐标数组；未连成返回 null。
function winLine(board, r, c, color) {
	for (const [dr, dc] of DIRS) {
		const cells = [[r, c]];
		let rr = r + dr, cc = c + dc;
		while (inBoard(rr, cc) && board[rr][cc] === color) { cells.push([rr, cc]); rr += dr; cc += dc; }
		rr = r - dr; cc = c - dc;
		while (inBoard(rr, cc) && board[rr][cc] === color) { cells.push([rr, cc]); rr -= dr; cc -= dc; }
		if (cells.length >= 5) return cells;
	}
	return null;
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
	const [winCells, setWinCells] = useState(null);
	const [showResult, setShowResult] = useState(false);
	const [last, setLast] = useState(null);
	const [history, setHistory] = useState([]);
	const [thinking, setThinking] = useState(false);
	const boardRef = useRef(board);
	const stageRef = useRef(null);
	boardRef.current = board;
	const turnRef = useRef(turn);
	turnRef.current = turn;
	const winRef = useRef(winner);
	winRef.current = winner;

	const finish = useCallback((b, r, c, color) => {
		const line = winLine(b, r, c, color);
		if (line) { setWinner(color); setWinCells(line); setShowResult(true); playSfx(color === "b" ? "win" : "over"); }
		else if (boardFull(b)) { setWinner("draw"); setWinCells(null); setShowResult(true); playSfx("clear"); }
		else playSfx("stone");
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
		setBoard(emptyBoard()); setTurn("b"); setWinner(null); setWinCells(null); setShowResult(false); setLast(null); setHistory([]); setThinking(false);
	}, []);
	const undo = useCallback(() => {
		if (thinking || history.length < 2) return;
		// 回退两步：撤掉 AI 与玩家（对局结束后也允许撤回继续）。
		const h = history.slice(0, -2);
		const next = emptyBoard();
		for (const m of h) next[m.r][m.c] = m.color;
		setBoard(next); boardRef.current = next;
		setHistory(h); setTurn("b"); setWinner(null); setWinCells(null); setShowResult(false);
		setLast(h.length ? h[h.length - 1] : null);
	}, [history, thinking]);

	const onKeyDown = useCallback((event) => {
		if (event.key.toLowerCase() === "r") { event.preventDefault(); reset(); }
		else if (event.key.toLowerCase() === "u") { event.preventDefault(); undo(); }
	}, [reset, undo]);
	useGameControls(stageRef, props.paused, onKeyDown);

	const statusText = winner === "b" ? "你赢了 · 五子连珠" : winner === "w" ? "AI 赢了 · 再试一次" : winner === "draw" ? "和棋 · 棋盘已满" : (turn === "b" ? "轮到你落子（黑）" : "AI 思考中…（白）");

	return <section className="dgame-game" aria-label="五子棋">
		<div className="dgame-game-head"><div><h3>五子棋</h3><p>你执黑先手，AI 执白；先在横竖斜任一线连成五子者胜。</p></div><div className="dgame-score"><span>回合</span><strong className="dg-gomoku-status">{statusText}</strong><button type="button" onClick={undo}>撤销</button><button type="button" onClick={reset}>重开</button></div></div>
		<div className="dgame-gomoku-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} role="grid" aria-label="十五路五子棋棋盘">
			<svg className="dgame-gomoku-lines" viewBox="0 0 1500 1500" preserveAspectRatio="none" aria-hidden="true">{GOMOKU_LINES}</svg>
			{board.map((row, r) => row.map((cell, c) => {
				const isWin = winCells && winCells.some(([wr, wc]) => wr === r && wc === c);
				return <button type="button" key={r + "-" + c} role="gridcell" className={"dgame-gomoku-cell" + (cell ? " filled " + cell : "") + (last && last.r === r && last.c === c ? " last" : "") + (isWin ? " wincell" : "")}
					aria-label={"第" + (r + 1) + "行第" + (c + 1) + "列" + (cell === "b" ? " 黑子" : cell === "w" ? " 白子" : " 空格")}
					onClick={() => { focusStage(stageRef); onCell(r, c); }}>{cell ? <i className={"dgame-gomoku-stone " + (cell === "b" ? "black" : "white")} /> : null}</button>;
			}))}
			{winner && showResult ? (
				<div className="dgame-gomoku-result" role="status">
					<div className={"dgame-gomoku-result-card " + winner}>
						<span className="dgame-gomoku-result-icon" aria-hidden="true">{winner === "b" ? "🎉" : winner === "w" ? "🤖" : "🤝"}</span>
						<strong>{winner === "b" ? "你赢了！" : winner === "w" ? "AI 赢了" : "和棋"}</strong>
						<p>{winner === "b" ? "五子连珠，漂亮！" : winner === "w" ? "再接再厉，卷土重来。" : "棋盘已满，平分秋色。"}</p>
						<div className="dgame-gomoku-result-actions">
							<button type="button" onClick={(e) => { e.stopPropagation(); setShowResult(false); }}>查看棋盘</button>
							<button type="button" onClick={(e) => { e.stopPropagation(); reset(); }}>再来一局</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
		<div className="dgame-controls"><button type="button" onClick={undo}>撤销</button><span>{statusText}</span><button type="button" onClick={reset}>重开</button></div>
	</section>;
}

export function GomokuPreview() {
	// 迷你 9 路棋盘：木纹 + 加粗外框 + 星位 + 黑白对弈石子，与真实棋盘同款画法。
	const P = (n) => n * 100 + 50;
	const stones = [[3, 3, "b"], [6, 3, "w"], [4, 4, "w"], [5, 5, "b"], [2, 6, "w"], [6, 6, "b"]];
	return <span className="dgcov-prev dgcov-prev-gomoku" aria-hidden="true">
		<svg viewBox="0 0 900 900" preserveAspectRatio="xMidYMid slice">
			<rect x={P(0)} y={P(0)} width={800} height={800} fill="none" strokeWidth={11} />
			{[1, 2, 3, 4, 5, 6, 7].map((i) => [
				<line key={"v" + i} x1={P(i)} y1={P(0)} x2={P(i)} y2={P(8)} />,
				<line key={"h" + i} x1={P(0)} y1={P(i)} x2={P(8)} y2={P(i)} />,
			])}
			<circle className="dgp-star" cx={P(4)} cy={P(4)} r={16} />
			{stones.map(([r, c, col], i) => <circle key={i} className={"dgp-stone-" + col} cx={P(c)} cy={P(r)} r={40} />)}
		</svg>
	</span>;
}

export const gomokuGame = { Game: GomokuGame, Preview: GomokuPreview, css: `
.dgame-gomoku-board{position:relative;display:grid;grid-template-columns:repeat(15,1fr);grid-template-rows:repeat(15,1fr);align-self:center;width:min(100%,min(90vw,330px));aspect-ratio:1/1;padding:12px;border-radius:12px;border:1px solid color-mix(in srgb,#7c4f16 65%,transparent);box-shadow:0 12px 32px rgb(0 0 0/.5),inset 0 1px 0 rgba(255,236,200,.55),inset 0 -3px 9px rgba(90,50,10,.35),inset 3px 0 8px rgba(255,224,170,.28),inset -3px 0 8px rgba(120,70,20,.25);outline:none;background:repeating-linear-gradient(94deg,rgba(124,79,22,.05) 0 2px,transparent 2px 11px),repeating-linear-gradient(87deg,rgba(255,238,196,.05) 0 2px,transparent 2px 14px),radial-gradient(120% 110% at 30% 10%,#edc97f,#dcae62 52%,#cc9a52 80%,#bb8844)}.dgame-gomoku-lines{position:absolute;inset:12px;pointer-events:none}.dgame-gomoku-lines line{stroke:#66431a;stroke-width:3;fill:none}.dgame-gomoku-star{fill:#66431a}.dgame-gomoku-cell{position:relative;z-index:1;background:transparent;border:none;cursor:pointer;padding:0;margin:0;outline:none;min-width:0;min-height:0}.dgame-gomoku-cell:focus-visible::after{content:'';position:absolute;inset:8%;border:2px solid rgba(255,255,255,.7);border-radius:50%}.dgame-gomoku-stone{position:absolute;inset:10%;border-radius:50%;display:block}.dgame-gomoku-stone.black{background:radial-gradient(circle at 34% 30%,#4b5563,#111827 68%);box-shadow:0 2px 5px rgb(0 0 0/.5),inset 0 1px 1px rgba(255,255,255,.25)}.dgame-gomoku-stone.white{background:radial-gradient(circle at 34% 30%,#ffffff,#cbd5e1 70%);box-shadow:0 2px 5px rgb(0 0 0/.4),inset 0 1px 1px rgba(255,255,255,.9)}.dgame-gomoku-cell.last .dgame-gomoku-stone::after{content:'';position:absolute;inset:32%;border-radius:50%;background:rgba(255,80,80,.9)}.dg-gomoku-status{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dgame-gomoku-cell.wincell .dgame-gomoku-stone{animation:dg-gomoku-win 1s ease-in-out infinite;z-index:1}
@keyframes dg-gomoku-win{0%,100%{box-shadow:0 2px 5px rgb(0 0 0/.5),0 0 0 0 rgba(255,214,102,.85)}50%{box-shadow:0 2px 5px rgb(0 0 0/.5),0 0 0 6px rgba(255,214,102,0)}}
.dgame-gomoku-result{position:absolute;inset:-1px;z-index:5;display:grid;place-items:center;background:rgba(10,10,20,.55);backdrop-filter:blur(2px);border-radius:8px;animation:dg-gomoku-fade .25s ease-out}
.dgame-gomoku-result-card{display:flex;flex-direction:column;align-items:center;gap:6px;padding:18px 26px;border-radius:14px;background:linear-gradient(160deg,#241f38,#171427);border:1px solid color-mix(in srgb,var(--dgame-accent,#a78bfa) 45%,transparent);box-shadow:0 12px 40px rgb(0 0 0/.55),0 0 0 4px rgba(167,139,250,.08);animation:dg-gomoku-pop .35s cubic-bezier(.22,1.6,.36,1);text-align:center}
.dgame-gomoku-result-card strong{font-size:18px;color:#fff}
.dgame-gomoku-result-card.b strong{color:#fbbf24}.dgame-gomoku-result-card.w strong{color:#e5e7eb}.dgame-gomoku-result-card.draw strong{color:#cbd5e1}
.dgame-gomoku-result-icon{font-size:28px;line-height:1;animation:dg-gomoku-bounce 1.2s ease-in-out infinite}
.dgame-gomoku-result-card p{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,#9ca3af)}
.dgame-gomoku-result-actions{display:flex;gap:10px;margin-top:6px}
.dgame-gomoku-result-actions button{padding:6px 14px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dgame-accent,#a78bfa) 40%,transparent);background:rgba(167,139,250,.14);color:#ede9fe;font-size:13px;cursor:pointer}
.dgame-gomoku-result-actions button:hover{background:rgba(167,139,250,.28)}
@keyframes dg-gomoku-fade{from{opacity:0}to{opacity:1}}
@keyframes dg-gomoku-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}
@keyframes dg-gomoku-bounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
` };
