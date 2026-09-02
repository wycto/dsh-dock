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

// 传统棋谱着法（如"炮二平五"/"馬8进7"）：红方用中文数字、黑方用阿拉伯数字，各自从己方右侧数起。
const CN_NUMS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
function moveNotation(board, fr, fc, tr, tc) {
	const p = board[fr][fc];
	if (!p) return "";
	const red = p.c === "r";
	const num = (n) => (red ? CN_NUMS[n - 1] : String(n));
	const file = (c) => (red ? 9 - c : c + 1);
	const forward = red ? tr < fr : tr > fr;
	const verb = fr === tr ? "平" : (forward ? "进" : "退");
	// 直行棋子进/退记步数；斜行棋子（马/象/士）进/退记目标线位。
	const to = fr === tr || p.t === "h" || p.t === "e" || p.t === "a" ? file(tc) : Math.abs(tr - fr);
	return pieceChar(p) + num(file(fc)) + verb + num(to);
}

export function XiangqiGame(props) {
	const [board, setBoard] = useState(initialBoard);
	const [turn, setTurn] = useState("r");
	const [sel, setSel] = useState(null);         // [r,c]
	const [targets, setTargets] = useState([]);   // [r,c][]
	const [over, setOver] = useState(null);       // 'r' | 'b' | 'draw'
	const [check, setCheck] = useState(false);
	const [last, setLast] = useState(null);
	// 上一手的起点/终点/棋谱文本：起点画虚线圈、终点画红点，棋谱行让玩家看清对方走了什么。
	const [lastMove, setLastMove] = useState(null);   // { fr, fc, tr, tc, text }
	const [moveLog, setMoveLog] = useState([]);       // [{ side, text }] 双方着法流水
	// 跳跃动画：moving = { fr, fc, tr, tc, piece, capture }，动画结束后落定为普通棋子。
	const [moving, setMoving] = useState(null);
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
	// 动画期间锁输入与 AI 回合，结束后调用 settle 落定真正的棋盘状态。
	const movingRef = useRef(false);
	const pendingRef = useRef(null);

	// 起跳动画：先在起点渲染飞行棋子，260ms 后落地并把棋盘推进到新局面。
	const animTimerRef = useRef(null);
	const animateMove = useCallback((b, fr, fc, tr, tc, after) => {
		// 被移动/被吃的棋子须从旧盘（boardRef）读取：b 已是落子后的新盘。
		const piece = boardRef.current[fr][fc];
		const capture = !!boardRef.current[tr][tc];
		pendingRef.current = { board: b, after };
		movingRef.current = true;
		setSel(null); setTargets([]);
		setMoving({ fr, fc, tr, tc, piece, capture });
		playSfx(capture ? "capture" : "step");
		if (animTimerRef.current) clearTimeout(animTimerRef.current);
		animTimerRef.current = setTimeout(() => {
			animTimerRef.current = null;
			const pend = pendingRef.current;
			pendingRef.current = null;
			movingRef.current = false;
			setMoving(null);
			if (pend) {
				const text = moveNotation(boardRef.current, fr, fc, tr, tc);
				boardRef.current = pend.board;
				setBoard(pend.board);
				setLastMove({ fr, fc, tr, tc, text });
				setMoveLog((log) => log.concat({ side: piece.c, text }));
				setLast([tr, tc]);
				if (pend.after) pend.after();
			}
		}, 260);
	}, []);

	const restart = useCallback(() => {
		if (animTimerRef.current) { clearTimeout(animTimerRef.current); animTimerRef.current = null; }
		pendingRef.current = null; movingRef.current = false;
		const b = initialBoard();
		boardRef.current = b;
		setBoard(b); setTurn("r"); setSel(null); setTargets([]); setOver(null); setCheck(false); setLast(null); setThinking(false); setHistory([]);
		setLastMove(null); setMoveLog([]); setMoving(null); setRepKeys([posKey(b)]);
	}, []);

	const undo = useCallback(() => {
		if (thinkingRef.current || overRef.current || turnRef.current !== "r" || movingRef.current) return;
		const h = historyRef.current;
		if (h.length < 2) return;
		const hist = h.slice(0, -2);
		const b = hist.length ? cloneBoard(hist[hist.length - 1]) : initialBoard();
		boardRef.current = b;
		setBoard(b); setHistory(hist); setSel(null); setTargets([]); setLast(null); setLastMove(null); setMoveLog((prevLog) => prevLog.slice(0, -2)); setOver(null);
		setCheck(inCheck(b, "r"));
		// 重建局面指纹（历史各局面 + 当前）。
		setRepKeys(hist.map(posKey).concat(posKey(b)));
	}, []);

	const moveRed = useCallback((tr, tc) => {
		if (turnRef.current !== "r" || overRef.current || !sel || movingRef.current) return;
		const fr = sel[0], fc = sel[1];
		const nb = applyMove(boardRef.current, fr, fc, tr, tc);
		setHistory((h) => [...h, boardRef.current]);
		pushKey(nb);
		animateMove(nb, fr, fc, tr, tc, () => {
			// 动画落地后再移交回合：让 AI 的 useEffect 依赖到最新 turn 才启动搜索。
			setTurn("b");
			if (!hasLegalMoves(nb, "b")) { setOver("r"); setCheck(false); }
			else setCheck(inCheck(nb, "b"));
		});
	}, [sel, pushKey, animateMove]);

	const select = useCallback((r, c) => {
		if (overRef.current || turnRef.current !== "r" || thinkingRef.current || movingRef.current) return;
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

	// AI 回合（执黑）：先想棋（thinking 期间玩家能看到"AI 思考中"），落子走同款跳跃动画。
	useEffect(() => {
		if (turn !== "b" || over || props.paused || movingRef.current) return;
		const t = setTimeout(() => {
			// 局面出现次数表：AI 优先走新局面；全部重复时也倾向去往出现最少的局面。
			const seenCounts = new Map();
			for (const k of repKeys) seenCounts.set(k, (seenCounts.get(k) || 0) + 1);
			const mv = bestMove(boardRef.current, "b", 3, seenCounts);
			if (mv) {
				const [fr, fc, tr, tc] = mv;
				const nb = applyMove(boardRef.current, fr, fc, tr, tc);
				setHistory((h) => [...h, boardRef.current]);
				pushKey(nb);
				animateMove(nb, fr, fc, tr, tc, () => {
					setTurn("r");
					if (!hasLegalMoves(nb, "r")) { setOver("b"); setCheck(false); }
					else setCheck(inCheck(nb, "r"));
				});
			} else setOver("r");
			setThinking(false);
		}, 420);
		setThinking(true);
		return () => clearTimeout(t);
	}, [turn, over, props.paused, repKeys, pushKey, animateMove]);

	const onKeyDown = useCallback((event) => {
		if (event.key.toLowerCase() === "r") { event.preventDefault(); restart(); }
		else if (event.key.toLowerCase() === "u") { event.preventDefault(); undo(); }
	}, [restart, undo]);
	useGameControls(stageRef, props.paused, onKeyDown);

	const status = over === "r" ? "红方胜 · 恭喜" : over === "b" ? "黑方胜 · AI 赢" : (moving ? (moving.piece.c === "r" ? "红方走子…" : "AI 走子…") : (thinking ? "AI 思考中…" : (check ? "将军！" : (turn === "r" ? "轮到你（红方）" : "轮到 AI（黑方）"))));
	const prevCheck = useRef(false);
	useEffect(() => {
		if (over === "r") playSfx("win");
		else if (over === "b") playSfx("over");
		else if (!thinking && check && !prevCheck.current) playSfx("check");
		prevCheck.current = !thinking && check;
	}, [check, thinking, over]);
	// 组件卸载时清掉未落地的动画定时器，避免对已卸载组件 setState。
	useEffect(() => () => { if (animTimerRef.current) clearTimeout(animTimerRef.current); }, []);

	return <section className="dgame-game" aria-label="象棋">
		<div className="dgame-game-head"><div><h3>中国象棋</h3><p>你执红先行，AI 执黑；吃掉对方将/帅即胜。点击选中红子，再点高亮落点走棋。</p></div><div className="dgame-score"><span>当前</span><strong className="dg-gomoku-status">{status}</strong><button type="button" onClick={undo}>撤销</button><button type="button" onClick={restart}>重开</button></div></div>
		<div className="dgame-xiangqi-board" ref={stageRef} tabIndex={0} onKeyDown={onKeyDown} onClick={() => focusStage(stageRef)} role="grid" aria-label="中国象棋棋盘">
			<svg className="dgame-xiangqi-lines" viewBox="0 0 900 1000" preserveAspectRatio="none" aria-hidden="true">
				{XIANGQI_LINES}
				<text className="dgame-xiangqi-rivertext" x={230} y={505}>楚 河</text>
				<text className="dgame-xiangqi-rivertext" x={670} y={505}>漢 界</text>
			</svg>
			{board.map((row, r) => row.map((p, c) => {
				const mv = moving;
				// 动画期间：飞行棋子由独立层渲染（起点格不再画它）；被吃棋子原地淡出。
				const isFlyFrom = mv && mv.fr === r && mv.fc === c;
				const isDying = mv && mv.capture && mv.tr === r && mv.tc === c;
				const isSel = sel && sel[0] === r && sel[1] === c;
				const isTargetMark = targets.some(([tr, tc]) => tr === r && tc === c);
				const isLastMoveFrom = lastMove && lastMove.fr === r && lastMove.fc === c;
				const isLand = !mv && lastMove && lastMove.tr === r && lastMove.tc === c;
				const isLast = last && last[0] === r && last[1] === c;
				return <button type="button" key={r + "-" + c} role="gridcell"
					className={"dgame-xiangqi-cell" + (isSel ? " sel" : "") + (isTargetMark ? " target" : "") + (isLastMoveFrom ? " from" : "") + (isLand ? " land" : "") + (isLast ? " last" : "")}
					aria-label={"第" + (r + 1) + "行第" + (c + 1) + "列" + (p ? pieceChar(p) : " 空")}
					onClick={() => { focusStage(stageRef); select(r, c); }}>
					{p && !isFlyFrom ? <span className={"dgame-xiangqi-pc " + p.c + (isDying ? " dying" : "")}>{pieceChar(p)}</span> : (!p && isTargetMark ? <span className="dgame-xiangqi-dot" aria-hidden="true" /> : null)}
				</button>;
			}))}
			{moving ? <span key={moving.fr + "-" + moving.fc + "-" + moving.tr + "-" + moving.tc + "-" + moving.piece.c}
				className={"dgame-xiangqi-pc dgame-xiangqi-fly " + moving.piece.c}
				style={{
					"--fx0": (moving.fc + 0.5) / 9, "--fy0": (moving.fr + 0.5) / 10,
					"--fx1": (moving.tc + 0.5) / 9, "--fy1": (moving.tr + 0.5) / 10,
				}}
				aria-hidden="true">{pieceChar(moving.piece)}</span> : null}
		</div>
		{moveLog.length ? <div className="dgame-xiangqi-log" role="status" aria-live="polite">
			{moveLog.slice(-4).map((m, i) => <span key={moveLog.length - 4 + i} className={m.side}>{m.text}</span>)}
		</div> : null}
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
.dgame-xiangqi-board{position:relative;display:grid;grid-template-columns:repeat(9,1fr);grid-template-rows:repeat(10,1fr);align-self:center;width:min(100%,min(90vw,340px));aspect-ratio:9/10;padding:13px;border-radius:12px;border:1px solid color-mix(in srgb,#7c4f16 65%,transparent);box-shadow:0 12px 32px rgb(0 0 0/.5),inset 0 1px 0 rgba(255,236,200,.55),inset 0 -3px 9px rgba(90,50,10,.35),inset 3px 0 8px rgba(255,224,170,.28),inset -3px 0 8px rgba(120,70,20,.25);outline:none;background:repeating-linear-gradient(94deg,rgba(124,79,22,.05) 0 2px,transparent 2px 11px),repeating-linear-gradient(87deg,rgba(255,238,196,.05) 0 2px,transparent 2px 14px),radial-gradient(130% 105% at 26% 8%,#f0cd86,#ddb067 48%,#cb9a51 78%,#bb8844)}.dgame-xiangqi-lines{position:absolute;inset:13px;pointer-events:none}.dgame-xiangqi-lines line,.dgame-xiangqi-lines path,.dgame-xiangqi-lines rect{stroke:#66431a;stroke-width:3.4;fill:none;stroke-linecap:square}.dgame-xiangqi-lines rect{stroke-width:7}.dgame-xiangqi-lines .dgame-xiangqi-mark{stroke-width:2.6}.dgame-xiangqi-rivertext{fill:rgba(102,67,26,.7);font-family:KaiTi,"Kaiti SC","STKaiti","FangSong",serif;font-size:46px;letter-spacing:7px;text-anchor:middle;dominant-baseline:central}.dgame-xiangqi-board:focus-visible{box-shadow:0 0 0 3px rgba(0,0,0,.25)}.dgame-xiangqi-cell{position:relative;z-index:1;background:transparent;border:none;cursor:pointer;padding:0;margin:0;outline:none;display:grid;place-items:center;min-width:0;min-height:0}.dgame-xiangqi-cell.target .dgame-xiangqi-dot{width:12px;height:12px;border-radius:50%;background:rgba(34,211,238,.6);box-shadow:0 0 10px rgba(34,211,238,.65),0 0 0 2px rgba(255,255,255,.28)}.dgame-xiangqi-cell.target .dgame-xiangqi-pc{box-shadow:0 0 0 2px rgba(248,113,113,.85),0 0 10px rgba(248,113,113,.5),0 2px 4px rgb(0 0 0/.4),inset 0 0 0 1.5px rgba(96,62,18,.5),inset 0 1px 2px rgba(255,255,255,.95),inset 0 -2px 3px rgba(120,80,20,.4)}.dgame-xiangqi-cell.sel .dgame-xiangqi-pc::before{content:'';position:absolute;inset:-3px;border-radius:50%;border:2.5px solid rgba(251,191,36,.95);box-shadow:0 0 12px rgba(251,191,36,.6)}.dgame-xiangqi-cell.from::before{content:'';position:absolute;inset:50% auto auto 50%;width:34%;height:34%;transform:translate(-50%,-50%);border-radius:50%;border:2.5px dashed rgba(102,67,26,.75);pointer-events:none}.dgame-xiangqi-cell.land .dgame-xiangqi-pc{animation:dgame-xq-land .28s cubic-bezier(.2,.85,.3,1.25)}.dgame-xiangqi-cell.last .dgame-xiangqi-pc::after{content:'';position:absolute;right:5%;bottom:5%;width:5px;height:5px;border-radius:50%;background:#ef4444;box-shadow:0 0 4px rgba(239,68,68,.8)}.dgame-xiangqi-pc{position:relative;display:grid;place-items:center;z-index:1;width:min(80%,30px);aspect-ratio:1/1;border-radius:50%;box-sizing:border-box;font-family:KaiTi,"Kaiti SC","STKaiti","FangSong","SimSun",serif;font-size:clamp(12px,1.4vw,15px);font-weight:700;line-height:1;background:radial-gradient(circle at 34% 28%,#fff3d4,#eedaa6 46%,#d8b675 72%,#bd9650);box-shadow:0 2px 4px rgb(0 0 0/.45),inset 0 0 0 1.5px rgba(96,62,18,.5),inset 0 1px 2px rgba(255,255,255,.95),inset 0 -2px 3px rgba(120,80,20,.4)}.dgame-xiangqi-pc.dying{animation:dgame-xq-die .26s ease forwards}.dgame-xiangqi-fly{position:absolute;z-index:5;width:calc((100% - 26px)*.0889);aspect-ratio:1/1;border-radius:50%;display:grid;place-items:center;box-sizing:border-box;font-family:KaiTi,"Kaiti SC","STKaiti","FangSong","SimSun",serif;font-size:clamp(12px,1.4vw,15px);font-weight:700;line-height:1;pointer-events:none;background:radial-gradient(circle at 34% 28%,#fff3d4,#eedaa6 46%,#d8b675 72%,#bd9650);box-shadow:0 6px 14px rgb(0 0 0/.5),0 0 0 1.5px rgba(96,62,18,.35),inset 0 0 0 1.5px rgba(96,62,18,.5),inset 0 1px 2px rgba(255,255,255,.95),inset 0 -2px 3px rgba(120,80,20,.4);animation:dgame-xq-hop .26s cubic-bezier(.3,.7,.4,1) forwards}.dgame-xiangqi-fly.r{color:#b91c1c;text-shadow:0 1px 0 rgba(255,255,255,.5)}.dgame-xiangqi-fly.b{color:#1f2937;text-shadow:0 1px 0 rgba(255,255,255,.35)}@keyframes dgame-xq-hop{0%{left:calc(13px + var(--fx0)*(100% - 26px));top:calc(13px + var(--fy0)*(100% - 26px));transform:translate(-50%,-50%) scale(.9);opacity:.85}55%{transform:translate(-50%,-64%) scale(1.16);opacity:1}100%{left:calc(13px + var(--fx1)*(100% - 26px));top:calc(13px + var(--fy1)*(100% - 26px));transform:translate(-50%,-50%) scale(1)}}@keyframes dgame-xq-land{0%{transform:scale(1.18)}100%{transform:scale(1)}}@keyframes dgame-xq-die{to{opacity:0;transform:scale(.55)}}.dgame-xiangqi-log{display:flex;flex-wrap:wrap;justify-content:center;gap:5px 12px;align-self:center;min-height:22px;color:var(--dsw-alias-label-secondary);font-family:KaiTi,"Kaiti SC","STKaiti","FangSong",serif;font-size:13px}.dgame-xiangqi-log span{opacity:.65}.dgame-xiangqi-log span:last-child{opacity:1;font-weight:700}.dgame-xiangqi-log .r{color:#c03434}.dgame-xiangqi-log .b{color:var(--dsw-alias-label-primary)}
` };
