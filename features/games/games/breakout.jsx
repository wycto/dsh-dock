/* 趣味游戏 · 打砖块（经典机台）——纯 Client；canvas 渲染，方向键/鼠标/触摸控制挡板。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls, playSfx } from "./shared.jsx";

const W = 320, H = 360;
const BRICK_COLS = 8, BRICK_ROWS = 5, BRICK_GAP = 4, BRICK_TOP = 22, BRICK_H = 18;
const PADDLE_W = 60, PADDLE_H = 11, PADDLE_BOTTOM = 20;
const BALL_R = 5.5;
const SPEED = 3.4;
const COLORS = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8"];

function makeBricks(level) {
	const bricks = [];
	const bw = (W - BRICK_GAP * (BRICK_COLS + 1)) / BRICK_COLS;
	for (let r = 0; r < BRICK_ROWS; r += 1) {
		for (let c = 0; c < BRICK_COLS; c += 1) {
			bricks.push({
				x: BRICK_GAP + c * (bw + BRICK_GAP),
				y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
				w: bw, h: BRICK_H,
				color: COLORS[(r + level) % COLORS.length],
				alive: true,
			});
		}
	}
	return bricks;
}
function draw(ctx, g) {
	ctx.clearRect(0, 0, W, H);
	// 星空背景
	ctx.fillStyle = "#0b1024";
	ctx.fillRect(0, 0, W, H);
	ctx.fillStyle = "#1b2bb0";
	for (const s of g.stars) { ctx.globalAlpha = s.a; ctx.fillRect(s.x, s.y, 1.5, 1.5); }
	ctx.globalAlpha = 1;
	// 砖块
	for (const b of g.bricks) {
		if (!b.alive) continue;
		ctx.fillStyle = b.color;
		ctx.beginPath();
		roundRect(ctx, b.x, b.y, b.w, b.h, 4);
		ctx.fill();
		ctx.fillStyle = "rgba(255,255,255,.25)";
		roundRect(ctx, b.x, b.y, b.w, b.h / 2.4, 4);
		ctx.fill();
	}
	// 挡板
	ctx.fillStyle = "#a5f3fc";
	roundRect(ctx, g.paddle.x, g.paddle.y, PADDLE_W, PADDLE_H, 5);
	ctx.fill();
	// 球
	ctx.fillStyle = "#fef3c7";
	ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, BALL_R, 0, Math.PI * 2); ctx.fill();
	ctx.fillStyle = "rgba(254,243,199,.5)";
	ctx.beginPath(); ctx.arc(g.ball.x, g.ball.y, BALL_R + 2.5, 0, Math.PI * 2); ctx.fill();
}
function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}
function collideRect(x, y, r, bx, by, bw, bh) {
	const cx = Math.max(bx, Math.min(x, bx + bw));
	const cy = Math.max(by, Math.min(y, by + bh));
	const dx = x - cx, dy = y - cy;
	return dx * dx + dy * dy < r * r;
}

export function BreakoutGame(props) {
	const canvasRef = useRef(null);
	const [score, setScore] = useState(0);
	const [lives, setLives] = useState(3);
	const [level, setLevel] = useState(1);
	const [status, setStatus] = useState("play"); // play | win | over
	const keys = useRef({});
	const pausedRef = useRef(!!(props && props.paused)); pausedRef.current = !!(props && props.paused);
	const game = useRef(null);
	const scoreRef = useRef(0); scoreRef.current = score;
	const statusRef = useRef("play"); statusRef.current = status;
	const livesRef = useRef(3); livesRef.current = lives;

	const start = useCallback((lvl) => {
		const bricks = makeBricks(lvl);
		game.current = {
			stars: Array.from({ length: 46 }, () => ({ x: Math.random() * W, y: Math.random() * H, a: .25 + Math.random() * .5 })),
			bricks,
			paddle: { x: (W - PADDLE_W) / 2, y: H - PADDLE_BOTTOM - PADDLE_H },
			ball: { x: W / 2, y: H - PADDLE_BOTTOM - PADDLE_H - BALL_R - 1, vx: (Math.random() > .5 ? 1 : -1) * SPEED, vy: -SPEED },
			speed: SPEED * (1 + (lvl - 1) * .09),
		};
	}, []);

	useEffect(() => {
		start(1); setScore(0); setLives(3); setStatus("play");
	}, [start]);

	const launchBall = useCallback(() => {
		const g = game.current;
		if (!g) return;
		g.ball.vx = (Math.random() > .5 ? 1 : -1) * SPEED;
		g.ball.vy = -SPEED;
		g.launched = true;
	}, []);
	const resetBall = useCallback(() => {
		const g = game.current;
		if (g) { g.ball.x = W / 2; g.ball.y = H - PADDLE_BOTTOM - PADDLE_H - BALL_R - 1; g.ball.vx = 0; g.ball.vy = 0; g.launched = false; }
	}, []);

	// rAF 主循环。注意：本地函数不能叫 draw，否则会遮蔽模块级渲染函数导致递归自调用。
	useEffect(() => {
		const frame = () => {
			const g = game.current;
			const ctx = canvasRef.current && canvasRef.current.getContext("2d");
			if (!g || !ctx) return;
			if (pausedRef.current || statusRef.current !== "play") { draw(ctx, g); return; }
			// 挡板移动
			if (keys.current.left) g.paddle.x -= 5.5;
			if (keys.current.right) g.paddle.x += 5.5;
			g.paddle.x = Math.max(0, Math.min(W - PADDLE_W, g.paddle.x));
			// 球
			const b = g.ball;
			if (!g.launched) {
				b.x = g.paddle.x + PADDLE_W / 2;
				b.y = g.paddle.y - BALL_R - 1;
			} else {
				b.x += b.vx; b.y += b.vy;
				// 墙
				if (b.x - BALL_R < 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
				if (b.x + BALL_R > W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); }
				if (b.y - BALL_R < 0) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
				// 挡板
				if (b.vy > 0 && b.y + BALL_R >= g.paddle.y && b.y - BALL_R <= g.paddle.y + PADDLE_H && b.x >= g.paddle.x - BALL_R && b.x <= g.paddle.x + PADDLE_W + BALL_R) {
					playSfx("bounce");
					const rel = (b.x - (g.paddle.x + PADDLE_W / 2)) / (PADDLE_W / 2);
					const ang = rel * .6;
					const sp = Math.hypot(b.vx, b.vy);
					b.vx = sp * Math.sin(ang);
					b.vy = -Math.abs(sp * Math.cos(ang));
					b.y = g.paddle.y - BALL_R - 1;
				}
				// 砖块
				const maxSpeed = g.speed * 1.6;
				for (const br of g.bricks) {
					if (!br.alive) continue;
					if (collideRect(b.x, b.y, BALL_R, br.x, br.y, br.w, br.h)) {
						br.alive = false;
						playSfx("brick");
						const cx = br.x + br.w / 2, cy = br.y + br.h / 2;
						const dx = b.x - cx, dy = b.y - cy;
						if (Math.abs(dx / br.w) > Math.abs(dy / br.h)) { b.vx = -b.vx; b.x += b.vx * 2; }
						else { b.vy = -b.vy; b.y += b.vy * 2; }
						setScore((s) => s + 10);
						scoreRef.current += 10;
						const remain = g.bricks.some((x) => x.alive);
						if (!remain) {
							playSfx("win");
							setStatus("win"); setLevel((l) => l + 1);
							if (statusRef.current !== "over") statusRef.current = "win";
						}
						break;
					}
				}
				// 掉出
				if (b.y - BALL_R > H) {
					const nl = livesRef.current - 1;
					livesRef.current = nl; setLives(nl);
					playSfx(nl <= 0 ? "over" : "step");
					if (nl <= 0) { setStatus("over"); statusRef.current = "over"; }
					else resetBall();
				}
			}
			draw(ctx, g);
		};
		let raf = requestAnimationFrame(function loop() { frame(); raf = requestAnimationFrame(loop); });
		return () => cancelAnimationFrame(raf);
	}, [resetBall]);

	const onKeyDown = useCallback((event) => {
		if (pausedRef.current) return;
		if (event.key === "ArrowLeft") { event.preventDefault(); keys.current.left = true; }
		else if (event.key === "ArrowRight") { event.preventDefault(); keys.current.right = true; }
		else if (event.key === " ") { event.preventDefault(); launchBall(); }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); start(1); setScore(0); setLives(3); setStatus("play"); statusRef.current = "play"; livesRef.current = 3; }
	}, [launchBall, start]);
	const onKeyUp = useCallback((event) => {
		if (event.key === "ArrowLeft") keys.current.left = false;
		else if (event.key === "ArrowRight") keys.current.right = false;
	}, []);

	const onPointerMove = useCallback((e) => {
		const g = game.current, cv = canvasRef.current;
		if (!g || !cv) return;
		const rect = cv.getBoundingClientRect();
		const scale = rect.width / W;
		g.paddle.x = Math.max(0, Math.min(W - PADDLE_W, (e.clientX - rect.left) / scale - PADDLE_W / 2));
	}, []);
	useGameControls(canvasRef, pausedRef.current, onKeyDown, onKeyUp);

	return <section className="dgame-game" aria-label="打砖块">
		<div className="dgame-game-head"><div><h3>打砖块</h3><p>移动挡板反弹小球，击碎所有砖块；球落到底部扣一条命。</p></div><div className="dgame-score"><span>得分 <strong>{score}</strong></span><span>命 {lives} · 第 {level} 关</span></div></div>
		<div className="dgame-breakout">
			<canvas ref={canvasRef} width={W} height={H} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPointerMove={onPointerMove} onClick={(e) => { focusStage(canvasRef); launchBall(); }} className="dgame-breakout-canvas" aria-label="打砖块游戏区域，左右方向键或鼠标移动挡板，空格或点击发球" />
			{status === "win" ? <div className="dgame-over"><strong>全消！进入第 {level} 关</strong><button type="button" onClick={() => { start(level); setStatus("play"); statusRef.current = "play"; }}>下一关</button></div> : null}
			{status === "over" ? <div className="dgame-over"><strong>球掉光了 · 得 {score} 分</strong><button type="button" onClick={() => { start(1); setScore(0); setLives(3); setStatus("play"); statusRef.current = "play"; livesRef.current = 3; }}>重新开始</button></div> : null}
		</div>
		<div className="dgame-controls"><button type="button" aria-label="向左移动" onClick={() => { keys.current.left = false; game.current && (game.current.paddle.x = Math.max(0, game.current.paddle.x - 12)); }}>← 左移</button><span>←/→ 或鼠标移动 · 空格/点击发球</span><button type="button" aria-label="向右移动" onClick={() => { keys.current.right = false; game.current && (game.current.paddle.x = Math.min(W - PADDLE_W, game.current.paddle.x + 12)); }}>右移 {'->'}</button></div>
	</section>;
}

export function BreakoutPreview() {
	const cols = ["#f87171", "#fb923c", "#facc15", "#4ade80", "#38bdf8", "#c084fc"];
	return <span className="dgcov-prev dgcov-prev-breakout" aria-hidden="true">
		{Array.from({ length: 12 }, (_, i) => {
			const row = Math.floor(i / 6), c = i % 6;
			return <i key={i} style={{ left: (5 + c * 15) + "%", top: (10 + row * 12) + "%", background: cols[i % cols.length] }} />;
		})}
		<b />
	</span>;
}

export const breakoutGame = { Game: BreakoutGame, Preview: BreakoutPreview, css: `
.dgame-breakout{position:relative;align-self:center;width:min(100%,320px);margin:0 auto}.dgame-breakout-canvas{display:block;width:100%;aspect-ratio:320/360;border:1px solid color-mix(in srgb,rgb(56 189 248) 32%,var(--dsw-alias-border-l1));border-radius:10px;outline:none;background:#0b1024;box-shadow:0 4px 18px rgb(0 0 0/.4)}.dgame-breakout-canvas:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(56 189 248) 35%,transparent)}.dgame-breakout .dgame-over{position:absolute;inset:0;border-radius:10px}
` };
