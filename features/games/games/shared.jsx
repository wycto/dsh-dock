/* 趣味游戏 · 游戏公共工具：键盘焦点与全局按键监听 */
import { useEffect, useRef } from "react";

function isTypingTarget(event) {
	const tag = (event.target && event.target.tagName) || "";
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	if (event.target && event.target.isContentEditable) return true;
	return false;
}

/**
 * 让游戏舞台自动聚焦并在点击时重新夺回焦点；
 * 同时注册 window 级 keydown，确保方向键/WASD 等即使舞台因弹窗/按钮暂时失焦也能响应。
 * paused：来自 GameWindow 的暂停/最小化/选择层状态；暂停时不监听按键、不抢焦点。
 */
export function useGameControls(stageRef, paused, onKeyDown, onKeyUp) {
	const pausedRef = useRef(!!paused);
	pausedRef.current = !!paused;

	// 自动聚焦舞台（延时确保 DOM 已渲染且窗口已显示）
	useEffect(() => {
		if (pausedRef.current) return;
		const el = stageRef && stageRef.current;
		if (!el) return;
		const t = setTimeout(() => { try { el.focus({ preventScroll: true }); } catch { /* ignore */ } }, 60);
		return () => clearTimeout(t);
	}, [paused]);

	// 全局按键监听：只在窗口打开、未暂停、且不在输入框中时响应。
	// 事件目标落在游戏舞台（或其子元素，如棋盘格按钮）内时跳过——
	// 舞台自身的 onKeyDown 会通过冒泡处理该键，避免双重触发。
	useEffect(() => {
		const inStage = (event) => {
			const el = stageRef && stageRef.current;
			return !!el && (el === event.target || el.contains(event.target));
		};
		const handleDown = (event) => {
			if (pausedRef.current) return;
			if (isTypingTarget(event)) return;
			if (inStage(event)) return;
			if (typeof onKeyDown === "function") onKeyDown(event);
		};
		const handleUp = (event) => {
			if (pausedRef.current) return;
			if (isTypingTarget(event)) return;
			if (inStage(event)) return;
			if (typeof onKeyUp === "function") onKeyUp(event);
		};
		window.addEventListener("keydown", handleDown);
		window.addEventListener("keyup", handleUp);
		return () => {
			window.removeEventListener("keydown", handleDown);
			window.removeEventListener("keyup", handleUp);
		};
	}, [onKeyDown, onKeyUp]);
}

/** 点击舞台时重新聚焦（配合 onClick） */
export function focusStage(stageRef) {
	if (stageRef && stageRef.current) {
		try { stageRef.current.focus({ preventScroll: true }); } catch { /* ignore */ }
	}
}

/* ---------- 游戏音效：WebAudio 现场合成，零素材文件；首次交互后惰性初始化 ---------- */
let _ctx = null;
function audioCtx() {
	if (typeof window === "undefined") return null;
	const AC = window.AudioContext || window.webkitAudioContext;
	if (!AC) return null;
	try {
		if (!_ctx) _ctx = new AC();
		if (_ctx.state === "suspended") _ctx.resume().catch(() => {});
		return _ctx;
	} catch { return null; }
}
// name → 音色参数。t 波形 · g 音量 · d 单音时长 · f2 滑向频率 · seq 连奏序列 [频率, 延迟秒]
const SFX_DEFS = {
	move: { f: 240, t: "square", d: 0.035, g: 0.07 },
	rotate: { f: 340, t: "square", d: 0.05, g: 0.08 },
	lock: { f: 150, t: "triangle", d: 0.08, g: 0.15 },
	step: { f: 190, t: "triangle", d: 0.03, g: 0.06 },
	push: { f: 115, t: "triangle", d: 0.07, g: 0.14 },
	stone: { f: 520, t: "triangle", d: 0.05, g: 0.13, f2: 430 },
	capture: { f: 175, t: "square", d: 0.09, g: 0.15, f2: 105 },
	check: { t: "square", g: 0.12, d: 0.24, seq: [[660, 0], [660, 0.14]] },
	eat: { f: 620, t: "square", d: 0.06, g: 0.11, f2: 920 },
	bounce: { f: 420, t: "square", d: 0.03, g: 0.07 },
	brick: { f: 740, t: "square", d: 0.05, g: 0.1, f2: 500 },
	clear: { t: "sine", g: 0.15, d: 0.28, seq: [[523, 0], [659, 0.09], [784, 0.18], [1047, 0.27]] },
	win: { t: "sine", g: 0.14, d: 0.34, seq: [[523, 0], [659, 0.11], [784, 0.22], [1047, 0.33], [784, 0.47], [1047, 0.56]] },
	over: { t: "sawtooth", g: 0.11, d: 0.38, seq: [[392, 0], [311, 0.13], [233, 0.27], [185, 0.44]] },
};
export function playSfx(name) {
	const def = SFX_DEFS[name];
	const ac = def && audioCtx();
	if (!ac) return;
	const t0 = ac.currentTime;
	const events = def.seq || [[def.f, 0]];
	for (const [freq, dt] of events) {
		let osc, gain;
		try {
			osc = ac.createOscillator();
			gain = ac.createGain();
			osc.type = def.t || "square";
			osc.frequency.setValueAtTime(freq, t0 + dt);
			if (def.f2) osc.frequency.exponentialRampToValueAtTime(Math.max(30, def.f2), t0 + dt + def.d);
			gain.gain.setValueAtTime(0.0001, t0 + dt);
			gain.gain.exponentialRampToValueAtTime(def.g, t0 + dt + 0.008);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + def.d);
			osc.connect(gain).connect(ac.destination);
			osc.start(t0 + dt);
			osc.stop(t0 + dt + def.d + 0.03);
		} catch {
			if (osc) try { osc.stop(); } catch { /* ignore */ }
		}
	}
}
