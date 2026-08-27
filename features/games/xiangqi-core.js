/* 趣味游戏 · 象棋核心规则（纯函数，无 React）——供组件复用，也便于单测。 */
export const ROWS = 10, COLS = 9;
// 类型：g 将/帅 · a 仕/士 · e 相/象 · h 马 · k 车 · c 炮 · p 兵/卒
// 颜色：r 红（下）· b 黑（上）

export function pieceChar(p) {
	const map = {
		g: { r: "帥", b: "將" }, a: { r: "仕", b: "士" }, e: { r: "相", b: "象" },
		h: { r: "馬", b: "馬" }, k: { r: "車", b: "車" }, c: { r: "炮", b: "炮" },
		p: { r: "兵", b: "卒" },
	};
	return map[p.t] && map[p.t][p.c];
}
export const VALUE = { g: 100000, k: 900, c: 450, h: 400, e: 200, a: 200, p: 100 };

export function initialBoard() {
	const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
	const back = ["k", "h", "e", "a", "g", "a", "e", "h", "k"];
	back.forEach((t, c) => { b[0][c] = { t, c: "b" }; });
	b[2][1] = { t: "c", c: "b" }; b[2][7] = { t: "c", c: "b" };
	// 黑卒在己方第三横线（row 3，紧邻楚河汉界一侧留一行间隔）。
	[0, 2, 4, 6, 8].forEach((c) => { b[3][c] = { t: "p", c: "b" }; });
	back.forEach((t, c) => { b[9][c] = { t, c: "r" }; });
	b[7][1] = { t: "c", c: "r" }; b[7][7] = { t: "c", c: "r" };
	// 红兵与红炮和黑方对称（row 6 / row 7）。
	[0, 2, 4, 6, 8].forEach((c) => { b[6][c] = { t: "p", c: "r" }; });
	return b;
}
export function cloneBoard(b) {
	return b.map((row) => row.slice());
}
// 局面指纹：用于识别重复局面（防止 AI 无限循环将军）。
export function posKey(board) {
	let s = "";
	for (const row of board) for (const p of row) s += p ? p.t + p.c : ".";
	return s;
}
function inBounds(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }
function inPalace(r, c, color) {
	if (c < 3 || c > 5) return false;
	return color === "r" ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
}
function ownSide(r, color) { return color === "r" ? r >= 5 : r <= 4; }
function crossedRiver(r, color) { return color === "r" ? r <= 4 : r >= 5; }
function countBetween(board, r, c, tr, tc, dr, dc) {
	let n = 0, rr = r + dr, cc = c + dc;
	while (!(rr === tr && cc === tc)) {
		if (rr < 0 || rr >= ROWS || cc < 0 || cc >= COLS) return -1;
		if (board[rr][cc]) n += 1;
		rr += dr; cc += dc;
	}
	return n;
}

export function attacks(board, r, c, tr, tc) {
	const p = board[r][c];
	if (!p) return false;
	const dr = Math.sign(tr - r), dc = Math.sign(tc - c);
	const t = board[tr][tc];
	if (p.t === "k") {
		if (r !== tr && c !== tc) return false;
		return countBetween(board, r, c, tr, tc, dr, dc) === 0;
	}
	if (p.t === "c") {
		if (r !== tr && c !== tc) return false;
		if (dr === 0 && dc === 0) return false;
		return countBetween(board, r, c, tr, tc, dr, dc) === 1 && !!t;
	}
	if (p.t === "h") {
		const adr = Math.abs(tr - r), adc = Math.abs(tc - c);
		if (!((adr === 2 && adc === 1) || (adr === 1 && adc === 2))) return false;
		const legR = adr === 2 ? r + dr : r;
		const legC = adc === 2 ? c + dc : c;
		return !board[legR][legC];
	}
	if (p.t === "g") {
		return Math.abs(tr - r) + Math.abs(tc - c) === 1 && inPalace(tr, tc, p.c);
	}
	if (p.t === "a") {
		return Math.abs(tr - r) === 1 && Math.abs(tc - c) === 1 && inPalace(tr, tc, p.c);
	}
	if (p.t === "e") {
		const adr = Math.abs(tr - r), adc = Math.abs(tc - c);
		if (!(adr === 2 && adc === 2)) return false;
		if (!ownSide(tr, p.c)) return false;
		const eyeR = r + dr, eyeC = c + dc;
		return !board[eyeR][eyeC];
	}
	if (p.t === "p") {
		const forward = p.c === "r" ? r - 1 : r + 1;
		if (tr === forward && tc === c) return true;
		if (crossedRiver(r, p.c) && tr === r && Math.abs(tc - c) === 1) return true;
		return false;
	}
	return false;
}

export function findGeneral(board, color) {
	for (let r = 0; r < ROWS; r += 1) {
		for (let c = 0; c < COLS; c += 1) {
			const p = board[r][c];
			if (p && p.t === "g" && p.c === color) return { r, c };
		}
	}
	return null;
}
export function pseudoMoves(board, r, c) {
	const p = board[r][c];
	if (!p) return [];
	const out = [];
	const push = (nr, nc) => { if (inBounds(nr, nc)) out.push([nr, nc]); };
	const clear = (nr, nc) => !board[nr][nc];
	const enemy = (nr, nc) => { const q = board[nr][nc]; return q && q.c !== p.c; };
	if (p.t === "g") {
		[[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
			const nr = r + dr, nc = c + dc;
			if (inPalace(nr, nc, p.c) && (clear(nr, nc) || enemy(nr, nc))) push(nr, nc);
		});
	}
	if (p.t === "a") {
		[[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([dr, dc]) => {
			const nr = r + dr, nc = c + dc;
			if (inPalace(nr, nc, p.c) && (clear(nr, nc) || enemy(nr, nc))) push(nr, nc);
		});
	}
	if (p.t === "e") {
		[[-2, -2], [-2, 2], [2, -2], [2, 2]].forEach(([dr, dc]) => {
			const nr = r + dr, nc = c + dc, er = r + dr / 2, ec = c + dc / 2;
			if (inBounds(nr, nc) && ownSide(nr, p.c) && !board[er][ec] && (clear(nr, nc) || enemy(nr, nc))) push(nr, nc);
		});
	}
	if (p.t === "h") {
		[[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2]].forEach(([dr, dc]) => {
			const nr = r + dr, nc = c + dc;
			const legR = Math.abs(dr) === 2 ? r + dr / 2 : r;
			const legC = Math.abs(dc) === 2 ? c + dc / 2 : c;
			if (inBounds(nr, nc) && !board[legR][legC] && (clear(nr, nc) || enemy(nr, nc))) push(nr, nc);
		});
	}
	if (p.t === "k" || p.t === "c") {
		[[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
			let rr = r + dr, cc = c + dc, jumped = false;
			while (inBounds(rr, cc)) {
				const q = board[rr][cc];
				if (p.t === "k") {
					if (!q) push(rr, cc);
					else { if (q.c !== p.c) push(rr, cc); break; }
				} else {
					if (!q && !jumped) push(rr, cc);
					else if (q && !jumped) jumped = true;
					else if (q && jumped) { if (q.c !== p.c) push(rr, cc); break; }
				}
				rr += dr; cc += dc;
			}
		});
	}
	if (p.t === "p") {
		const forward = p.c === "r" ? -1 : 1;
		[[forward, 0], [0, -1], [0, 1]].forEach(([dr, dc]) => {
			const nr = r + dr, nc = c + dc;
			if (!inBounds(nr, nc) || (dc !== 0 && !crossedRiver(r, p.c))) return;
			if (clear(nr, nc) || enemy(nr, nc)) push(nr, nc);
		});
	}
	return out;
}
export function applyMove(board, fr, fc, tr, tc) {
	const nb = cloneBoard(board);
	nb[tr][tc] = nb[fr][fc];
	nb[fr][fc] = null;
	return nb;
}
export function inCheck(board, color) {
	const g = findGeneral(board, color);
	if (!g) return true;
	const enemy = color === "r" ? "b" : "r";
	for (let r = 0; r < ROWS; r += 1) {
		const p = board[r][g.c];
		if (p && p.t === "g" && p.c === enemy) {
			let clear = true;
			const lo = Math.min(r, g.r), hi = Math.max(r, g.r);
			for (let i = lo + 1; i < hi; i += 1) if (board[i][g.c]) { clear = false; break; }
			if (clear) return true;
		}
	}
	for (let r = 0; r < ROWS; r += 1) {
		for (let c = 0; c < COLS; c += 1) {
			const p = board[r][c];
			if (p && p.c === enemy && attacks(board, r, c, g.r, g.c)) return true;
		}
	}
	return false;
}
export function legalMoves(board, color) {
	const out = [];
	for (let r = 0; r < ROWS; r += 1) {
		for (let c = 0; c < COLS; c += 1) {
			const p = board[r][c];
			if (!p || p.c !== color) continue;
			for (const [nr, nc] of pseudoMoves(board, r, c)) {
				const nb = applyMove(board, r, c, nr, nc);
				if (!inCheck(nb, color)) out.push([r, c, nr, nc]);
			}
		}
	}
	return out;
}
export function hasLegalMoves(board, color) {
	return legalMoves(board, color).length > 0;
}
function evaluatePosition(board) {
	let score = 0;
	for (let r = 0; r < ROWS; r += 1) {
		for (let c = 0; c < COLS; c += 1) {
			const p = board[r][c];
			if (!p) continue;
			let v = VALUE[p.t];
			if (p.t === "p") v += crossedRiver(r, p.c) ? 50 : 0;
			score += p.c === "b" ? v : -v;
		}
	}
	return score;
}
function evalFrom(board, color) {
	const e = evaluatePosition(board);
	return color === "b" ? e : -e;
}
function negamax(board, color, depth, alpha, beta) {
	const moves = legalMoves(board, color);
	if (moves.length === 0) {
		return color === "b" ? -1000000 + (10 - depth) : 1000000 - (10 - depth);
	}
	if (depth === 0) return evalFrom(board, color);
	const enemy = color === "r" ? "b" : "r";
	const ordered = orderMoves(board, moves);
	let best = -Infinity;
	for (const m of ordered) {
		const nb = applyMove(board, m[0], m[1], m[2], m[3]);
		const score = -negamax(nb, enemy, depth - 1, -beta, -alpha);
		if (score > best) best = score;
		if (best > alpha) alpha = best;
		if (alpha >= beta) break;
	}
	return best;
}
function orderMoves(board, moves) {
	const scored = moves.map((m) => {
		let s = 0;
		const target = board[m[2]][m[3]];
		if (target) s += VALUE[target.t] * 10;
		return { m, s };
	});
	scored.sort((a, b) => b.s - a.s);
	return scored.map((o) => o.m);
}
// avoid：局面指纹 → 出现次数 的计数表。
// 优先只在"从未出现过的局面"里选优；若全部重复，给出现次数越多的走法越大的罚分，
// 避免来回倒子的死循环。根节点对评分相近（±TIE_EPSILON）的走法随机挑一个，
// 防止每局都走出完全相同的呆板着法。
export function bestMove(board, color, depth, avoid) {
	const moves = legalMoves(board, color);
	if (!moves.length) return null;
	const enemy = color === "r" ? "b" : "r";
	const ordered = orderMoves(board, moves);
	let pool;
	if (avoid && avoid.size) {
		const seenCount = (m) => avoid.get(posKey(applyMove(board, m[0], m[1], m[2], m[3]))) || 0;
		const minSeen = Math.min(...ordered.map(seenCount));
		pool = minSeen === 0
			? ordered.filter((m) => seenCount(m) === 0).map((m) => ({ m, pen: 0 }))
			: ordered.map((m) => ({ m, pen: seenCount(m) * 60 })).sort((a, b) => a.pen - b.pen);
	} else {
		pool = ordered.map((m) => ({ m, pen: 0 }));
	}
	if (depth <= 1) {
		return pickAmongBest(pool.map(({ m, pen }) => ({ m, s: evalFrom(applyMove(board, m[0], m[1], m[2], m[3]), color) - pen })));
	}
	let bestScore = -Infinity;
	let alpha = -Infinity;
	const scored = [];
	for (const { m, pen } of pool) {
		const nb = applyMove(board, m[0], m[1], m[2], m[3]);
		// 窗口下界放宽 TIE_EPSILON：近似并列的走法仍能拿到精确评分，供随机挑选。
		const s = -negamax(nb, enemy, depth - 1, -Infinity, -alpha) - pen;
		scored.push({ m, s });
		if (s > bestScore) {
			bestScore = s;
			alpha = Math.max(alpha, bestScore - TIE_EPSILON);
		}
	}
	return pickAmongBest(scored);
}
const TIE_EPSILON = 12;
function pickAmongBest(scored) {
	let bestScore = -Infinity;
	for (const o of scored) if (o.s > bestScore) bestScore = o.s;
	const ties = scored.filter((o) => o.s >= bestScore - TIE_EPSILON);
	return ties[Math.floor(Math.random() * ties.length)].m;
}
