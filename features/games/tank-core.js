/* 趣味游戏 · 坦克大战核心逻辑（纯函数，无 React）——供组件复用，便于单测。 */
export const GRID = 15;
export const EMPTY = 0, STEEL = 1, BRICK = 2, BASE = 3;
const DIRS = { up: [-1, 0], down: [1, 0], left: [0, -1], right: [0, 1] };
export const DIR_KEYS = Object.keys(DIRS);
const SPAWNS = [{ r: 0, c: 0 }, { r: 0, c: 7 }, { r: 0, c: 14 }];

function cloneGrid(g) { return g.map((row) => row.slice()); }
function inBounds(r, c) { return r >= 0 && r < GRID && c >= 0 && c < GRID; }
function cellBlockedForTank(grid, r, c) { return !inBounds(r, c) || grid[r][c] !== EMPTY; }

export function makeGrid() {
	const g = Array.from({ length: GRID }, () => Array(GRID).fill(EMPTY));
	const set = (r, c, v) => { if (r >= 0 && r < GRID && c >= 0 && c < GRID) g[r][c] = v; };
	for (let r = 2; r <= 5; r += 1) { set(r, 3, STEEL); set(r, 11, STEEL); set(r, 7, STEEL); }
	for (let c = 4; c <= 10; c += 1) set(8, c, BRICK);
	set(9, 5, BRICK); set(9, 6, BRICK); set(9, 8, BRICK); set(9, 9, BRICK); set(9, 10, BRICK);
	set(13, 7, BASE);
	set(12, 6, BRICK); set(12, 7, BRICK); set(12, 8, BRICK);
	set(13, 6, BRICK); set(13, 8, BRICK);
	return g;
}
export function findBase(grid) {
	for (let r = 0; r < GRID; r += 1) for (let c = 0; c < GRID; c += 1) if (grid[r][c] === BASE) return { r, c };
	return { r: 13, c: 7 };
}
function playerSpawn() { return { r: 11, c: 7, dir: "up", alive: true, lives: 3, cooldown: 0 }; }

export function initialState() {
	return {
		grid: makeGrid(),
		player: playerSpawn(),
		enemies: [],
		bullets: [],
		score: 0,
		wave: 1,
		remaining: 4,
		active: 2,
		spawnTick: 0,
		over: false, win: false,
		respawnTicks: 0,
	};
}
function spawnBullet(r, c, dir, from) {
	const [dr, dc] = DIRS[dir];
	return { r: r + dr, c: c + dc, dr, dc, from };
}
function spawnOne(grid, enemies) {
	for (const s of SPAWNS) {
		if (grid[s.r][s.c] === EMPTY && !enemies.some((e) => e.r === s.r && e.c === s.c)) {
			return { r: s.r, c: s.c, dir: "down", hp: 1, cooldown: 3, moveTick: 0 };
		}
	}
	return null;
}

export function step(state, input) {
	if (state.over || state.win) return state;
	const grid = cloneGrid(state.grid);
	let player = Object.assign({}, state.player);
	let enemies = state.enemies.map((e) => Object.assign({}, e));
	let bullets = state.bullets.map((b) => Object.assign({}, b));
	let remaining = state.remaining, score = state.score, over = state.over;
	let respawnTicks = state.respawnTicks;
	let spawnTick = state.spawnTick + 1;

	// 玩家移动
	if (player.alive && input.dir && DIRS[input.dir]) {
		const [dr, dc] = DIRS[input.dir];
		player.dir = input.dir;
		const nr = player.r + dr, nc = player.c + dc;
		if (!cellBlockedForTank(grid, nr, nc)) { player.r = nr; player.c = nc; }
	}
	// 玩家射击
	if (player.alive && input.shoot && player.cooldown <= 0) {
		bullets.push(spawnBullet(player.r, player.c, player.dir, "p"));
		player.cooldown = 9;
	}
	player.cooldown = Math.max(0, player.cooldown - 1);

	// 敌人移动/射击
	for (let i = 0; i < enemies.length; i += 1) {
		const e = enemies[i];
		e.cooldown -= 1; e.moveTick += 1;
		if (e.moveTick % 12 === 0) {
			const [dr, dc] = DIRS[e.dir];
			const nr = e.r + dr, nc = e.c + dc;
			if (cellBlockedForTank(grid, nr, nc) || enemies.some((o, oi) => oi !== i && o.r === nr && o.c === nc)) {
				const opts = DIR_KEYS.filter((d) => {
					const [ddr, ddc] = DIRS[d];
					const tr = e.r + ddr, tc = e.c + ddc;
					return !cellBlockedForTank(grid, tr, tc) && !enemies.some((o, oi) => oi !== i && o.r === tr && o.c === tc);
				});
				if (opts.length) e.dir = opts[Math.floor(Math.random() * opts.length)];
			} else { e.r = nr; e.c = nc; }
		}
		if (e.cooldown <= 0) {
			bullets.push(spawnBullet(e.r, e.c, e.dir, "e"));
			e.cooldown = 9 + Math.floor(Math.random() * 9);
		}
	}

	// 子弹移动/碰撞
	let baseHit = false, playerHit = false;
	const nextBullets = [];
	const base = findBase(grid);
	for (const b of bullets) {
		const nr = b.r + b.dr, nc = b.c + b.dc;
		if (!inBounds(nr, nc)) continue;
		const cell = grid[nr][nc];
		if (cell === STEEL) continue;
		if (cell === BRICK) { grid[nr][nc] = EMPTY; continue; }
		if (cell === BASE) { if (b.from === "e") baseHit = true; continue; }
		if (b.from === "p") {
			const idx = enemies.findIndex((e) => e.r === nr && e.c === nc);
			if (idx >= 0) { enemies.splice(idx, 1); score += 100; continue; }
		} else if (player.alive && player.r === nr && player.c === nc) {
			player.lives -= 1;
			if (player.lives <= 0) over = true;
			else { player.alive = false; respawnTicks = 24; }
			continue;
		}
		b.r = nr; b.c = nc;
		nextBullets.push(b);
	}

	// 生成敌人
	if (remaining > 0 && enemies.length < state.active && spawnTick % 9 === 0) {
		const fresh = spawnOne(grid, enemies);
		if (fresh) { enemies.push(fresh); remaining -= 1; }
	}
	// 玩家重生
	if (!player.alive && !over) {
		if (respawnTicks <= 0) { player.alive = true; player.r = 11; player.c = 7; player.dir = "up"; player.cooldown = 0; }
		else respawnTicks -= 1;
	}

	const win = remaining <= 0 && enemies.length === 0;
	return Object.assign({}, state, {
		grid, player, enemies, bullets: nextBullets, score, remaining,
		over: over || baseHit, win, spawnTick, respawnTicks,
	});
}

export function nextWave(state) {
	return Object.assign({}, state, {
		wave: state.wave + 1,
		remaining: Math.min(3 + state.wave, 8),
		active: Math.min(2 + Math.floor(state.wave / 2), 4),
		enemies: [], win: false, spawnTick: 0,
	});
}
