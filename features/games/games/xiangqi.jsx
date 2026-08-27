/* 趣味游戏 · 象棋（棋盘对战）——纯 Client；玩家执红先行，AI 执黑。 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	initialBoard, cloneBoard, pieceChar, inCheck, hasLegalMoves,
	legalMoves, bestMove, applyMove, posKey,
} from "../xiangqi-core.js";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

// 正规棋盘：SVG 精确绘制（viewBox 900×1000，交点对齐各格中心）。
// 外框加粗；中间竖线在楚河汉界断开；两侧九宫斜线；炮位/兵位直角标。
const XIANGQI_LINES = (() => {
	const P = (n) => n * 100 + 50;
	const parts = [];
	let k = 0;
	parts.push(<rect key="frame" x={P(0)} y={P(0)} width={800} height={900} strokeWidth={7} fill="none" />);
	for (let r = 1; r <= 8; r += 1) parts.push(<line key={k++} x1={P(0)} y1={P(r)} x2={P(8)} y2={P(r)} />);
	for (let c = 1; c <= 7; c += 1) {
		parts.push(<line key={k++} x1={P(c)} y1={P(0)} x2={P(c)} y2={P(4)} />);
		parts.push(<line key={k++} x1={P(c)} y1={P(5)} x2={P(c)} y2={P(9)} />);
	}
	parts.push(<path key={k++} d={`M${P(3)} ${P(0)}L${P(5)} ${P(2)}M${P(5)} ${P(0)}L${P(3)} ${P(2)}M${P(3)} ${P(7)}L${P(5)} ${P(9)}M${P(5)} ${P(7)}L${P(3)} ${P(9)}`} />);
	// 炮位/兵位的四角直角小标（贴边的点只画内侧两角）。
	const t = 14, o = 16;
	const marks = [[1, 2], [7, 2], [1, 7], [7, 7], [0, 3], [2, 3], [4, 3], [6, 3], [8, 3], [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]];
	for (const [c, r] of marks) {
		const seg = [];
		if (c > 0) seg.push(
			`M${P(c) - o - t} ${P(r) - o}H${P(c) - o}V${P(r) - o - t}`,
			`M${P(c) - o - t} ${P(r) + o}H${P(c) - o}V${P(r) + o + t}`,
		);
		if (c < 8) seg.push(
			`M${P(c) + o} ${P(r) - o}H${P(c) + o + t}V${P(r) - o - t}`,
			`M${P(c) + o} ${P(r) + o}H${P(c) + o + t}V${P(r) + o + t}`,
		);
		parts.push(<path key={k++} className="dgame-xiangqi-mark" strokeWidth={2.6} d={seg.join("")} />);
	}
	return parts;
})();

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
	// 已出现过的局面指纹：AI 搜索时排除重复局面，杜绝"反复将军无限循环"。
	const [repKeys, setRepKeys] = useState(() => [posKey(initialBoard())]);
	const pushKey = useCallback((b) => setRepKeys((ks) => (ks[ks.length - 1] === posKey(b) ? ks : ks.concat(posKey(b)))), []);

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
		setRepKeys([posKey(b)]);
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
		// 重建局面指纹（历史各局面 + 当前）。
		setRepKeys(hist.map(posKey).concat(posKey(b)));
	}, []);

	const moveRed = useCallback((tr, tc) => {
		if (turnRef.current !== "r" || overRef.current || !sel) return;
		const fr = sel[0], fc = sel[1];
		if (boardRef.current[tr][tc]) playSfx("capture"); else playSfx("step");
		const nb = applyMove(boardRef.current, fr, fc, tr, tc);
		setHistory((h) => [...h, boardRef.current]);
		boardRef.current = nb;
		pushKey(nb);
		setBoard(nb);
		setSel(null); setTargets([]); setLast([tr, tc]);
		setTurn("b");
		if (!hasLegalMoves(nb, "b")) { setOver("r"); setCheck(false); }
		else setCheck(inCheck(nb, "b"));
	}, [sel, pushKey]);

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

	// AI 回合（执黑）：搜索时排除已出现过的局面，禁止长将循环。
	useEffect(() => {
		if (turn !== "b" || over || props.paused) return;
		const t = setTimeout(() => {
			// 局面出现次数表：AI 优先走新局面；全部重复时也倾向去往出现最少的局面。
			const seenCounts = new Map();
			for (const k of repKeys) seenCounts.set(k, (seenCounts.get(k) || 0) + 1);
			const mv = bestMove(boardRef.current, "b", 3, seenCounts);
			if (mv) {
				const [fr, fc, tr, tc] = mv;
				if (boardRef.current[tr][tc]) playSfx("capture"); else playSfx("step");
				const nb = applyMove(boardRef.current, fr, fc, tr, tc);
				setHistory((h) => [...h, boardRef.current]);
				boardRef.current = nb;
				pushKey(nb);
				setBoard(nb); setLast([tr, tc]); setTurn("r");
				if (!hasLegalMoves(nb, "r")) { setOver("b"); setCheck(false); }
				else setCheck(inCheck(nb, "r"));
			} else setOver("r");
			setThinking(false);
		}, 90);
		setThinking(true);
		return () => clearTimeout(t);
	}, [turn, over, props.paused, repKeys, pushKey]);

	const onKeyDown = useCallback((event) => {
		if (event.key.toLowerCase() === "r") { event.preventDefault(); restart(); }
		else if (event.key.toLowerCase() === "u") { event.preventDefault(); undo(); }
	}, [restart, undo]);
	useGameControls(stageRef, props.paused, onKeyDown);

	const status = over === "r" ? "红方胜 · 恭喜" : over === "b" ? "黑方胜 · AI 赢" : (thinking ? "AI 思考中…" : (check ? "将军！" : (turn === "r" ? "轮到你（红方）" : "轮到 AI（黑方）")));
	const prevCheck = useRef(false);
	useEffect(() => {
		if (over === "r") playSfx("win");
		else if (over === "b") playSfx("over");
		else if (!thinking && check && !prevCheck.current) playSfx("check");
		prevCheck.current = !thinking && check;
	}, [check, thinking, over]);

	return <section className="dgame-game" aria-label="象棋">
		<div className="dgame-game-head"><div><h3>中国象棋</h3><p>你执红先行，AI 执黑；吃掉对方将/帅即胜。点击选中红子，再点高亮落点走棋。</p></div><div className="dgame-score"><span>当前</span><strong className="dg-gomoku-status">{status}</strong><button type="button" onClick={undo}>撤销</button><button type="button" onClick={restart}>重开</button></div></div>
		<div className="dgame-xiangqi-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} role="grid" aria-label="中国象棋棋盘">
			<svg className="dgame-xiangqi-lines" viewBox="0 0 900 1000" preserveAspectRatio="none" aria-hidden="true">
				{XIANGQI_LINES}
				<text className="dgame-xiangqi-rivertext" x={230} y={505}>楚 河</text>
				<text className="dgame-xiangqi-rivertext" x={670} y={505}>漢 界</text>
			</svg>
			{board.map((row, r) => row.map((p, c) => {
				const isSel = sel && sel[0] === r && sel[1] === c;
				const isTargetMark = targets.some(([tr, tc]) => tr === r && tc === c);
				const isLast = last && last[0] === r && last[1] === c;
				return <button type="button" key={r + "-" + c} role="gridcell"
					className={"dgame-xiangqi-cell" + (isSel ? " sel" : "") + (isTargetMark ? " target" : "") + (isLast ? " last" : "")}
					aria-label={"第" + (r + 1) + "行第" + (c + 1) + "列" + (p ? pieceChar(p) : " 空")}
					onClick={() => { focusStage(stageRef); select(r, c); }}>
					{p ? <span className={"dgame-xiangqi-pc " + p.c}>{pieceChar(p)}</span> : (isTargetMark ? <span className="dgame-xiangqi-dot" aria-hidden="true" /> : null)}
				</button>;
			}))}
		</div>
		<div className="dgame-controls"><button type="button" onClick={undo}>撤销</button><span>{status} · R 重开 · U 撤销</span><button type="button" onClick={restart}>重开</button></div>
	</section>;
}

export function XiangqiPreview() {
	// 迷你象棋盘：河界断线 + 九宫斜线 + 楚河汉界 + 对峙棋子，与真实棋盘同款画法。
	const P = (n) => n * 100 + 50;
	const pc = (c, r, ch, col) => [
		<circle key={"pc" + c + r} cx={P(c)} cy={P(r)} r={44} className={"dgp-xq-pc-" + col} />,
		<text key={"tx" + c + r} x={P(c)} y={P(r) + 2} className={"dgp-xq-tx-" + col}>{ch}</text>,
	];
	return <span className="dgcov-prev dgcov-prev-xiangqi" aria-hidden="true">
		<svg viewBox="0 0 900 1000" preserveAspectRatio="xMidYMid slice">
			<rect x={P(0)} y={P(0)} width={800} height={900} fill="none" strokeWidth={11} />
			{[1, 2, 3, 4, 5, 6, 7, 8].map((r) => <line key={"h" + r} x1={P(0)} y1={P(r)} x2={P(8)} y2={P(r)} />)}
			<line x1={P(0)} y1={P(0)} x2={P(0)} y2={P(9)} />
			<line x1={P(8)} y1={P(0)} x2={P(8)} y2={P(9)} />
			{[1, 2, 3, 4, 5, 6, 7].map((c) => [
				<line key={"vt" + c} x1={P(c)} y1={P(0)} x2={P(c)} y2={P(4)} />,
				<line key={"vb" + c} x1={P(c)} y1={P(5)} x2={P(c)} y2={P(9)} />,
			])}
			<path d={`M${P(3)} ${P(0)}L${P(5)} ${P(2)}M${P(5)} ${P(0)}L${P(3)} ${P(2)}M${P(3)} ${P(7)}L${P(5)} ${P(9)}M${P(5)} ${P(7)}L${P(3)} ${P(9)}`} />
			<text className="dgp-xq-river" x={235} y={500}>楚河</text>
			<text className="dgp-xq-river" x={665} y={500}>漢界</text>
			{pc(4, 0, "將", "b")}
			{pc(1, 2, "炮", "b")}
			{pc(5, 3, "卒", "b")}
			{pc(3, 6, "兵", "r")}
			{pc(7, 7, "炮", "r")}
			{pc(4, 9, "帥", "r")}
		</svg>
	</span>;
}

export const xiangqiGame = { Game: XiangqiGame, Preview: XiangqiPreview, css: `
.dgame-xiangqi-board{position:relative;display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(10,1fr);align-self:center;width:min(100%,min(90vw,340px));aspect-ratio:9/10;padding:13px;border-radius:12px;border:1px solid color-mix(in srgb,#7c4f16 65%,transparent);box-shadow:0 12px 32px rgb(0 0 0/.5),inset 0 1px 0 rgba(255,236,200,.55),inset 0 -3px 9px rgba(90,50,10,.35),inset 3px 0 8px rgba(255,224,170,.28),inset -3px 0 8px rgba(120,70,20,.25);outline:none;background:repeating-linear-gradient(94deg,rgba(124,79,22,.05) 0 2px,transparent 2px 11px),repeating-linear-gradient(87deg,rgba(255,238,196,.05) 0 2px,transparent 2px 14px),radial-gradient(130% 105% at 26% 8%,#f0cd86,#ddb067 48%,#cb9a51 78%,#bb8844)}.dgame-xiangqi-lines{position:absolute;inset:13px;pointer-events:none}.dgame-xiangqi-lines line,.dgame-xiangqi-lines path{stroke:#66431a;stroke-width:3.4;fill:none;stroke-linecap:square}.dgame-xiangqi-lines .dgame-xiangqi-mark{stroke-width:2.6}.dgame-xiangqi-rivertext{fill:rgba(102,67,26,.7);font-family:KaiTi,"Kaiti SC","STKaiti","FangSong",serif;font-size:46px;letter-spacing:7px;text-anchor:middle;dominant-baseline:central}.dgame-xiangqi-board:focus-visible{box-shadow:0 0 0 3px rgba(0,0,0,.25)}.dgame-xiangqi-cell{position:relative;z-index:1;background:transparent;border:none;cursor:pointer;padding:0;margin:0;outline:none;display:grid;place-items:center;min-width:0;min-height:0}.dgame-xiangqi-cell.target .dgame-xiangqi-dot{width:12px;height:12px;border-radius:50%;background:rgba(34,211,238,.6);box-shadow:0 0 10px rgba(34,211,238,.65),0 0 0 2px rgba(255,255,255,.28)}.dgame-xiangqi-cell.target .dgame-xiangqi-pc{box-shadow:0 0 0 2px rgba(248,113,113,.85),0 0 10px rgba(248,113,113,.5),0 2px 4px rgb(0 0 0/.4),inset 0 0 0 1.5px rgba(96,62,18,.5),inset 0 1px 2px rgba(255,255,255,.95),inset 0 -2px 3px rgba(120,80,20,.4)}.dgame-xiangqi-cell.sel .dgame-xiangqi-pc::before{content:'';position:absolute;inset:-3px;border-radius:50%;border:2.5px solid rgba(251,191,36,.95);box-shadow:0 0 12px rgba(251,191,36,.6)}.dgame-xiangqi-cell.last .dgame-xiangqi-pc::after{content:'';position:absolute;right:5%;bottom:5%;width:5px;height:5px;border-radius:50%;background:#ef4444;box-shadow:0 0 4px rgba(239,68,68,.8)}.dgame-xiangqi-pc{position:relative;display:grid;place-items:center;z-index:1;width:min(80%,30px);aspect-ratio:1/1;border-radius:50%;box-sizing:border-box;font-family:KaiTi,"Kaiti SC","STKaiti","FangSong","SimSun",serif;font-size:clamp(12px,1.4vw,15px);font-weight:700;line-height:1;background:radial-gradient(circle at 34% 28%,#fff3d4,#eedaa6 46%,#d8b675 72%,#bd9650);box-shadow:0 2px 4px rgb(0 0 0/.45),inset 0 0 0 1.5px rgba(96,62,18,.5),inset 0 1px 2px rgba(255,255,255,.95),inset 0 -2px 3px rgba(120,80,20,.4)}.dgame-xiangqi-pc.r{color:#b91c1c;text-shadow:0 1px 0 rgba(255,255,255,.5)}.dgame-xiangqi-pc.b{color:#1f2937;text-shadow:0 1px 0 rgba(255,255,255,.35)}
` };
