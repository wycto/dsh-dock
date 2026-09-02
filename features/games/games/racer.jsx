/* 趣味游戏 · 极速赛车（经典机台）——纯 Client；canvas 渲染，躲避来车、收集金币，越开越快。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { focusStage, useGameControls } from "./shared.jsx";

const W = 300, H = 420;
const ROAD_W = 232, ROAD_X = (W - ROAD_W) / 2;
const CAR_W = 34, CAR_H = 52;
const CAR_COLORS = ["#f87171", "#fb923c", "#c084fc", "#38bdf8", "#4ade80", "#fde047"];
function laneX(lane) { return ROAD_X + ROAD_W * (lane + 0.5) / 3 - CAR_W / 2; }
function overlap(a, b) {
	return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function rect(ctx, x, y, w, h, r, fill) {
	ctx.fillStyle = fill;
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
	ctx.fill();
}

export function RacerGame(props) {
	const canvasRef = useRef(null);
	const [status, setStatus] = useState("play"); // play | over
	const game = useRef(null);
	const keys = useRef({});
	const statusRef = useRef("play"); statusRef.current = status;
	const pausedRef = useRef(!!(props && props.paused)); pausedRef.current = !!(props && props.paused);

	const reset = useCallback(() => {
		game.current = {
			stars: Array.from({ length: 50 }, () => ({ x: Math.random() * W, y: Math.random() * H, a: .2 + Math.random() * .5 })),
			player: { x: laneX(1), y: H - CAR_H - 16, w: CAR_W, h: CAR_H },
			enemies: [], coins: [],
			dist: 0, coinsGot: 0, spawn: 0, coinSpawn: 0,
			speed: 3.4, over: false,
		};
	}, []);

	useEffect(() => { reset(); setStatus("play"); }, [reset]);

	const launch = useCallback(() => {
		reset(); setStatus("play");
	}, [reset]);

	useEffect(() => {
		const draw = () => {
			const g = game.current, ctx = canvasRef.current && canvasRef.current.getContext("2d");
			if (!g || !ctx) return;
			// 背景
			ctx.fillStyle = "#0b1024"; ctx.fillRect(0, 0, W, H);
			ctx.fillStyle = "#1b2bb0";
			for (const s of g.stars) { ctx.globalAlpha = s.a; ctx.fillRect(s.x, s.y, 1.5, 1.5); }
			ctx.globalAlpha = 1;
			// 路面
			ctx.fillStyle = "#20243a"; ctx.fillRect(ROAD_X, 0, ROAD_W, H);
			ctx.fillStyle = "rgba(255,255,255,.09)"; ctx.fillRect(ROAD_X + 6, 0, 4, H); ctx.fillRect(ROAD_X + ROAD_W - 10, 0, 4, H);
			// 车道虚线
			ctx.fillStyle = "rgba(255,255,255,.16)";
			for (let i = 1; i < 3; i += 1) {
				const lx = ROAD_X + ROAD_W * i / 3 - 1;
				for (let yy = (g.dist % 60); yy < H; yy += 60) ctx.fillRect(lx, yy, 2, 26);
			}
			if (pausedRef.current || g.over) { drawHUD(ctx, g); return; }
			// 挡板移动（玩家车）
			if (keys.current.left) g.player.x -= 5;
			if (keys.current.right) g.player.x += 5;
			g.player.x = Math.max(ROAD_X + 2, Math.min(ROAD_X + ROAD_W - CAR_W - 2, g.player.x));
			g.dist += g.speed * .16;
			// 生成来车
			g.spawn += 1;
			if (g.spawn > Math.max(20, 56 - g.dist / 600)) {
				g.spawn = 0;
				const lane = Math.floor(Math.random() * 3);
				const v = g.speed * (1.1 + Math.random() * .6);
				g.enemies.push({ x: laneX(lane), y: -CAR_H - Math.random() * 60, w: CAR_W, h: CAR_H, v, c: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)] });
			}
			// 生成金币
			g.coinSpawn += 1;
			if (g.coinSpawn > Math.max(30, 70 - g.dist / 500)) {
				g.coinSpawn = 0;
				g.coins.push({ x: laneX(Math.floor(Math.random() * 3)), y: -30, r: 11, got: false });
			}
			// 更新来车/金币
			for (const e of g.enemies) e.y += e.v;
			for (const c of g.coins) c.y += g.speed;
			g.enemies = g.enemies.filter((e) => e.y < H + 20);
			g.coins = g.coins.filter((c) => c.y < H + 20);
			// 碰撞检测
			for (const e of g.enemies) {
				if (overlap(g.player, e)) { g.over = true; setStatus("over"); statusRef.current = "over"; }
			}
			for (const c of g.coins) {
				if (!c.got && Math.abs(c.x + c.r - (g.player.x + CAR_W / 2)) < CAR_W / 2 + 8 && Math.abs(c.y - (g.player.y + CAR_H / 2)) < CAR_H / 2 + 10) {
					c.got = true; g.coinsGot += 1;
				}
			}
			// 画来车
			for (const e of g.enemies) { rect(ctx, e.x, e.y, e.w, e.h, 7, e.c); ctx.fillStyle = "rgba(255,255,255,.25)"; ctx.fillRect(e.x + 6, e.y + 7, e.w - 12, 12); }
			// 画金币
			ctx.fillStyle = "#fde047";
			for (const c of g.coins) { ctx.beginPath(); ctx.arc(c.x + c.r, c.y, c.r, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "rgba(120,53,15,.4)"; ctx.beginPath(); ctx.arc(c.x + c.r, c.y, c.r * .5, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = "#fde047"; }
			// 画玩家车
			drawCar(ctx, g.player.x, g.player.y, "#22d3ee");
			drawHUD(ctx, g);
		};
		const drawHUD = (ctx, g) => {
			ctx.fillStyle = "#e7ecff";
			ctx.font = "bold 13px system-ui, sans-serif";
			ctx.textBaseline = "top";
			ctx.fillText("距离 " + Math.floor(g.dist / 60) + " m", 10, 10);
			ctx.fillStyle = "#fde047";
			ctx.fillText("金币 × " + g.coinsGot, W - 70, 10);
		};
		function drawCar(ctx, x, y, c) {
			rect(ctx, x, y, CAR_W, CAR_H, 9, c);
			ctx.fillStyle = "rgba(255,255,255,.3)"; rect(ctx, x + 5, y + 6, CAR_W - 10, 13, 4, "rgba(255,255,255,.3)");
			ctx.fillStyle = "rgba(15,23,42,.5)"; rect(ctx, x + 5, y + CAR_H - 16, CAR_W - 10, 9, 3, "rgba(15,23,42,.5)");
			ctx.fillStyle = "rgba(255,255,255,.45)";
			rect(ctx, x + 3, y + CAR_H - 4, 6, 5, 2, "#fde047");
			rect(ctx, x + CAR_W - 9, y + CAR_H - 4, 6, 5, 2, "#fde047");
		}
		let raf = requestAnimationFrame(function loop() { draw(); raf = requestAnimationFrame(loop); });
		return () => cancelAnimationFrame(raf);
	}, []);

	const onKeyDown = useCallback((event) => {
		if (pausedRef.current) return;
		if (event.key === "ArrowLeft") { event.preventDefault(); keys.current.left = true; }
		else if (event.key === "ArrowRight") { event.preventDefault(); keys.current.right = true; }
		else if (event.key.toLowerCase() === "r") { event.preventDefault(); launch(); }
	}, [launch]);
	const onKeyUp = useCallback((event) => {
		if (event.key === "ArrowLeft") keys.current.left = false;
		else if (event.key === "ArrowRight") keys.current.right = false;
	}, []);

	const onPointerMove = useCallback((e) => {
		const g = game.current, cv = canvasRef.current;
		if (!g || !cv) return;
		const rect0 = cv.getBoundingClientRect();
		const scale = rect0.width / W;
		g.player.x = Math.max(ROAD_X + 2, Math.min(ROAD_X + ROAD_W - CAR_W - 2, (e.clientX - rect0.left) / scale - CAR_W / 2));
	}, []);
	useGameControls(canvasRef, pausedRef.current, onKeyDown, onKeyUp);

	return <section className="dgame-game" aria-label="极速赛车">
		<div className="dgame-game-head"><div><h3>极速赛车</h3><p>左右移动避开迎面来车、收集金币，越开越快；撞车即结束。距离与金币实时显示在游戏画面左上/右上。</p></div><div className="dgame-score"><span>操作</span><span>←/→ 或鼠标</span></div></div>
		<div className="dgame-racer">
			<canvas ref={canvasRef} width={W} height={H} tabIndex={0} onKeyDown={onKeyDown} onKeyUp={onKeyUp} onPointerMove={onPointerMove} onClick={() => focusStage(canvasRef)} className="dgame-racer-canvas" aria-label="极速赛车游戏区域，左右方向键或鼠标控制方向" />
			{status === "over" ? <div className="dgame-over"><strong>撞车了 · 行驶 {(game.current && Math.floor(game.current.dist / 60)) || 0} 米</strong><button type="button" onClick={launch}>重新出发</button></div> : null}
		</div>
		<div className="dgame-controls"><button type="button" aria-label="向左" onClick={() => { keys.current.left = false; if (game.current) game.current.player.x = Math.max(ROAD_X + 2, game.current.player.x - 14); }}>← 左移</button><span>←/→ 或鼠标移动 · R 重开</span><button type="button" aria-label="向右" onClick={() => { keys.current.right = false; if (game.current) game.current.player.x = Math.min(ROAD_X + ROAD_W - CAR_W - 2, game.current.player.x + 14); }}>右移 {'->'}</button></div>
	</section>;
}

export function RacerPreview() {
	return <span className="dgcov-prev dgcov-prev-racer" aria-hidden="true">
		<i style={{ left: "20%", top: "8%" }} /><i style={{ left: "55%", top: "22%" }} /><i style={{ left: "20%", top: "42%" }} /><i style={{ left: "64%", top: "58%" }} /><i style={{ left: "38%", top: "74%" }} />
		<b />
	</span>;
}

export const racerGame = { Game: RacerGame, Preview: RacerPreview, css: `
.dgame-racer{position:relative;align-self:center;width:min(100%,300px);margin:0 auto}.dgame-racer-canvas{display:block;width:100%;aspect-ratio:300/420;border:1px solid color-mix(in srgb,rgb(34 211 238) 32%,var(--dsw-alias-border-l1));border-radius:10px;outline:none;background:#0b1024;box-shadow:0 4px 18px rgb(0 0 0/.4)}.dgame-racer-canvas:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,rgb(34 211 238) 35%,transparent)}.dgame-racer .dgame-over{position:absolute;inset:0;border-radius:10px}.dgame-racer-stat{color:var(--dsw-alias-label-tertiary)}
` };
