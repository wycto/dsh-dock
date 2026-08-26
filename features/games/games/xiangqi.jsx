/* 趣味游戏 · 象棋（棋盘对战）——纯 Client；玩家执红先行，AI 执黑。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	initialBoard, cloneBoard, pieceChar, inCheck, hasLegalMoves,
	legalMoves, bestMove, applyMove,
} from "../xiangqi-core.js";

export function XiangqiGame(props) {
	const [board, setBoard] = useState(initialBoard);
	const [turn, setTurn] = useState("r");
	const [sel, setSel] = useState(null);         // [r,c]
	const [targets, setTargets] = useState([]);   // [r,c][]
	const [over, setOver] = useState(null);       // 'r' | 'b' | 'draw'
	const [check, setCheck] = useState(false);
	const [last, setLast] = useState(null);
	const [thinking, setThinking] = useState(false);
	const [history, setHistory] = useState([]);

	const stageRef = useRef(null);
	const boardRef = useRef(board); boardRef.current = board;
	const turnRef = useRef(turn); turnRef.current = turn;
	const overRef = useRef(over); overRef.current = over;
	const thinkingRef = useRef(thinking); thinkingRef.current = thinking;
	const historyRef = useRef(history); historyRef.current = history;

	const restart = useCallback(() => {
		const b = initialBoard();
		boardRef.current = b;
		setBoard(b); setTurn("r"); setSel(null); setTargets([]); setOver(null); setCheck(false); setLast(null); setThinking(false); setHistory([]);
	}, []);

	const undo = useCallback(() => {
		if (thinkingRef.current || overRef.current || turnRef.current !== "r") return;
		const h = historyRef.current;
		if (h.length < 2) return;
		const hist = h.slice(0, -2);
		const b = hist.length ? cloneBoard(hist[hist.length - 1]) : initialBoard();
		boardRef.current = b;
		setBoard(b); setHistory(hist); setSel(null); setTargets([]); setLast(null); setOver(null);
		setCheck(inCheck(b, "r"));
	}, []);

	const moveRed = useCallback((tr, tc) => {
		if (turnRef.current !== "r" || overRef.current || !sel) return;
		const fr = sel[0], fc = sel[1];
		const nb = applyMove(boardRef.current, fr, fc, tr, tc);
		setHistory((h) => [...h, boardRef.current]);
		boardRef.current = nb;
		setBoard(nb);
		setSel(null); setTargets([]); setLast([tr, tc]);
		setTurn("b");
		if (!hasLegalMoves(nb, "b")) { setOver("r"); setCheck(false); }
		else setCheck(inCheck(nb, "b"));
	}, [sel]);

	const select = useCallback((r, c) => {
		if (overRef.current || turnRef.current !== "r" || thinkingRef.current) return;
		const p = boardRef.current[r][c];
		if (p && p.c === "r") {
			setSel([r, c]);
			const list = legalMoves(boardRef.current, "r").filter((m) => m[0] === r && m[1] === c).map((m) => [m[2], m[3]]);
			setTargets(list);
			return;
		}
		if (sel && targets.some(([tr, tc]) => tr === r && tc === c)) { moveRed(r, c); return; }
		setSel(null); setTargets([]);
	}, [sel, targets, moveRed]);

	// AI 回合（执黑）。
	useEffect(() => {
		if (turn !== "b" || over || props.paused) return;
		const t = setTimeout(() => {
			const mv = bestMove(boardRef.current, "b", 3);
			if (mv) {
				const [fr, fc, tr, tc] = mv;
				const nb = applyMove(boardRef.current, fr, fc, tr, tc);
				setHistory((h) => [...h, boardRef.current]);
				boardRef.current = nb;
				setBoard(nb); setLast([tr, tc]); setTurn("r");
				if (!hasLegalMoves(nb, "r")) { setOver("b"); setCheck(false); }
				else setCheck(inCheck(nb, "r"));
			} else setOver("r");
			setThinking(false);
		}, 90);
		setThinking(true);
		return () => clearTimeout(t);
	}, [turn, over, props.paused]);

	useEffect(() => {
		if (props.paused) return;
		if (stageRef.current) stageRef.current.focus();
	}, [turn, over, props.paused]);

	const onKeyDown = useCallback((event) => {
		if (event.key.toLowerCase() === "r") { event.preventDefault(); restart(); }
		else if (event.key.toLowerCase() === "u") { event.preventDefault(); undo(); }
	}, [restart, undo]);

	const status = over === "r" ? "红方胜 · 恭喜" : over === "b" ? "黑方胜 · AI 赢" : (thinking ? "AI 思考中…" : (check ? "将军！" : (turn === "r" ? "轮到你（红方）" : "轮到 AI（黑方）")));

	return <section className="dgame-game" aria-label="象棋">
		<div className="dgame-game-head"><div><h3>中国象棋</h3><p>你执红先行，AI 执黑；吃掉对方将/帅即胜。点击选中红子，再点高亮落点走棋。</p></div><div className="dgame-score"><span>当前</span><strong className="dg-gomoku-status">{status}</strong><button type="button" onClick={undo}>撤销</button><button type="button" onClick={restart}>重开</button></div></div>
		<div className="dgame-xiangqi-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-label="中国象棋棋盘">
			{board.map((row, r) => row.map((p, c) => {
				const isSel = sel && sel[0] === r && sel[1] === c;
				const isTargetMark = targets.some(([tr, tc]) => tr === r && tc === c);
				const isLast = last && last[0] === r && last[1] === c;
				return <button type="button" key={r + "-" + c} role="gridcell"
					className={"dgame-xiangqi-cell" + (isSel ? " sel" : "") + (isTargetMark ? " target" : "") + (isLast ? " last" : "")}
					aria-label={"第" + (r + 1) + "行第" + (c + 1) + "列" + (p ? pieceChar(p) : " 空")}
					onClick={() => select(r, c)}>
					{p ? <span className={"dgame-xiangqi-pc " + p.c}>{pieceChar(p)}</span> : (isTargetMark ? <span className="dgame-xiangqi-dot" aria-hidden="true" /> : null)}
				</button>;
			}))}
		</div>
		<div className="dgame-controls"><button type="button" onClick={undo}>撤销</button><span>{status} · R 重开 · U 撤销</span><button type="button" onClick={restart}>重开</button></div>
	</section>;
}

export function XiangqiPreview() {
	return <span className="dgcov-prev dgcov-prev-xiangqi" aria-hidden="true">
		{["車馬象士將象馬車", "·炮·····炮·", "卒.卒.卒.卒.卒", "兵.兵.兵.兵.兵", "·炮·····炮·", "車馬相仕帥相馬車"].map((row, r) => <b key={r}>{row}</b>)}
	</span>;
}

export const xiangqiGame = { Game: XiangqiGame, Preview: XiangqiPreview, css: `
.dgame-xiangqi-board{display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(10,1fr);align-self:center;width:min(100%,320px);aspect-ratio:9/10;padding:6px;border-radius:8px;background:linear-gradient(135deg,#e8c07a,#c08a3e);border:1px solid color-mix(in srgb,#8a5a1c 55%,transparent);box-shadow:0 4px 18px rgb(0 0 0/.35),inset 0 0 0 2px rgba(0,0,0,.14);outline:none;background-image:repeating-linear-gradient(90deg,transparent 0 calc(100%/8),rgba(0,0,0,.14) calc(100%/8) calc(100%/8 + 2px)),repeating-linear-gradient(0deg,transparent 0 calc(100%/9),rgba(85,52,0,.28) calc(100%/9) calc(100%/9 + 2px))}.dgame-xiangqi-board:focus-visible{box-shadow:0 0 0 3px rgba(0,0,0,.25)}.dgame-xiangqi-cell{position:relative;background:transparent;border:none;cursor:pointer;padding:0;margin:0;outline:none;display:grid;place-items:center}.dgame-xiangqi-cell.sel{box-shadow:inset 0 0 0 3px rgba(255,200,80,.55)}.dgame-xiangqi-cell.target .dgame-xiangqi-dot{width:10px;height:10px;border-radius:50%;background:rgba(34,211,238,.55);box-shadow:0 0 8px rgba(34,211,238,.6)}.dgame-xiangqi-cell.last{box-shadow:inset 0 0 0 3px rgba(248,113,113,.5)}.dgame-xiangqi-pc{font-size:clamp(11px,2.2vw,15px);font-weight:700;display:block;z-index:1}.dgame-xiangqi-pc.r{color:#b91c1c;text-shadow:0 1px 0 rgba(255,255,255,.5)}.dgame-xiangqi-pc.b{color:#1f2937;text-shadow:0 1px 0 rgba(255,255,255,.35)}
` };
