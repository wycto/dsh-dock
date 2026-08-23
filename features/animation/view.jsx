// dsh-dock · 功能模块【任务动画】· 客户端视图（v0.5.0，参照 @wycto/dsh-task-pulse client 会话追踪消费，同作者 MIT）
//
// 三部分：
//  1. View      —— 功能坞面板页：动画/通知两组独立开关 + 动画模式选择（带缩微预览）+ 运行状态列表；
//  2. HomeStat  —— 首页总揽概要（N 个任务进行中 / 空闲）；
//  3. Overlay   —— 全局浮层（shell.overlay 常驻，功能启用即挂载）：轮询 Host 状态，
//                  任务进行中渲染克制的动效（顶部流光细线 / 呼吸光点 / 轨道光环）+ 右下角状态徽标，
//                  任务结束时弹通知卡片（可选浏览器系统通知），完成瞬间一缕流光掠过。
//
// 设计取向：不做满屏粒子彩带，动效全部走主题变量（暗/亮色自适应）、低透明度、慢节奏。
// 动画与通知是两个独立开关（可只开其一）；配置全部经 Host settings 持久化，重启后恢复。
//
// Host 通信：fetch('/dsh-dock/animation/<method>')（见 features/animation/host.js）。
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { openPanel, panelNav, subscribePanel } from "../../src/shared.js";

// ---------- Host RPC 桥接 ----------
function rpcCall(method, args) {
	return fetch("/dsh-dock/animation/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args === undefined ? {} : args),
	})
		.then(async (res) => {
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.ok === true) return data.data;
			// 旧宿主进程没有动画路由（405/404）：给出可操作提示而非裸状态码
			if (res.status === 405 || res.status === 404) {
				throw new Error("宿主进程是旧版本（没有任务动画路由），重启 dsh web 后重试");
			}
			if (data && data.ok === false) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
			throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""));
		});
}

// ---------- 动画模式 ----------
const EFFECT_MODES = [
	{ id: "flow", name: "流光细线", desc: "顶部细线流光往返，速度随任务吞吐加快" },
	{ id: "breathe", name: "呼吸光点", desc: "状态徽标圆点呼吸，越忙呼吸越快" },
	{ id: "ring", name: "轨道光环", desc: "细环绕圆点旋转，转速随任务速度" },
	{ id: "orbit", name: "环屏巡航", desc: "一颗光点沿屏幕边缘巡航整圈，醒目不遮挡" },
	{ id: "robot", name: "桌面伙伴", desc: "更具象的人物坐镇四屏工位：思考、输出、查资料随任务阶段切换" },
	{ id: "matrix", name: "代码雨", desc: "字符沿屏幕缓落如数据流，速度随任务吞吐，克制的低透明度" },
	{ id: "stars", name: "星野", desc: "细碎星点缓慢飘移闪烁，安静耐看的背景氛围" },
	{ id: "aurora", name: "极光", desc: "屏幕顶部柔光带缓慢呼吸流动，像极光拂过" },
];

// 任务阶段 → 机器人行为/文案（host 按 chunk/事件实时推导：
// reasoning-delta=think、text-delta=write、tool 名分类=search/code）
const PHASE_LABELS = { think: "思考中", write: "输出中", code: "编写代码", search: "查资料" };
function phaseLabel(p) { return PHASE_LABELS[p] || "工作中"; }

// ---------- 结束原因 ----------
const END_LABELS = {
	completed: { label: "完成", cls: "ok" },
	error: { label: "出错", cls: "err" },
	aborted: { label: "已中止", cls: "warn" },
	blocked: { label: "受阻", cls: "warn" },
	"max-tokens": { label: "达输出上限", cls: "warn" },
	interrupted: { label: "中断", cls: "warn" },
};
function endInfo(reason) {
	return END_LABELS[reason] || END_LABELS.completed;
}
function isSuccessReason(reason) {
	return !reason || reason === "completed";
}

// ---------- 格式化 ----------
function fmtNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }
function fmtCompact(n) {
	n = Number(n) || 0;
	if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
	return String(Math.round(n));
}
// 毫秒 → "3分21秒" / "1小时2分"
function fmtDur(ms) {
	const s = Math.max(0, Math.round((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	if (h > 0) return h + "小时" + m + "分" + sec + "秒";
	if (m > 0) return m + "分" + sec + "秒";
	return sec + "秒";
}
// 毫秒 → "12:34" / "1:02:11"（徽标计时）
function fmtClock(ms) {
	const s = Math.max(0, Math.floor((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	const p = (x) => String(x).padStart(2, "0");
	return h > 0 ? h + ":" + p(m) + ":" + p(sec) : p(m) + ":" + p(sec);
}
function fmtTime(ts) {
	if (!ts) return "";
	const d = new Date(ts);
	const p = (x) => String(x).padStart(2, "0");
	return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}
function truncate(str, max) {
	if (!str) return "";
	return String(str).length > max ? String(str).slice(0, max) + "…" : str;
}

// ---------- 共享快照：浮层（轮询） / 面板页 / 首页概要共用一份数据 ----------
const animationStore = {
	snap: { status: null, loading: false, error: null },
	listeners: new Set(),
	subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; },
	emit() { for (const fn of this.listeners) fn(); },
	applyConfig(cfg) {
		if (this.snap.status) {
			this.snap = Object.assign({}, this.snap, { status: Object.assign({}, this.snap.status, { config: cfg }) });
			this.emit();
		}
	},
	refresh() {
		if (this.snap.loading) return Promise.resolve();
		this.snap = Object.assign({}, this.snap, { loading: true });
		this.emit();
		return rpcCall("status")
			.then((data) => {
				this.snap = { status: data, loading: false, error: null };
				this.emit();
			})
			.catch((e) => {
				this.snap = Object.assign({}, this.snap, { loading: false, error: (e && e.message) || String(e) });
				this.emit();
			});
	},
};
function useAnimation() {
	const [snap, setSnap] = useState(animationStore.snap);
	useEffect(() => animationStore.subscribe(() => setSnap(animationStore.snap)), []);
	return snap;
}

// 秒级滴答（徽标计时用；ctx.interval 优先，退回 setInterval）
function useTicker(ctx, active) {
	const [, bump] = useState(0);
	useEffect(() => {
		if (!active) return;
		if (ctx && typeof ctx.interval === "function") return ctx.interval(bump, 1000);
		const t = setInterval(bump, 1000);
		return () => clearInterval(t);
	}, [active]);
}

// ---------- 桌面场景（CSS 3D：长方体拼装的 3D 动漫人物，侧身面向镜头、面朝三屏） ----------
// data-phase 驱动四态（think/write/code/search，host 由 assistant/chunk 流级事件实时同步）；
// --dkan-speed 随任务吞吐加速；卡片可整卡自由拖拽（位置 localStorage 持久化）。
// Box3 = 六面长方体（w×h×d），faces: 前(+Z)/后/右(+X)/左/顶/底；世界层统一转角取 3/4 视角。
function Box3(props) {
	const w = props.w, h = props.h, d = props.d;
	const faces = [
		[w, h, "translate(-50%,-50%) translateZ(" + (d / 2) + "px)"],
		[w, h, "translate(-50%,-50%) rotateY(180deg) translateZ(" + (d / 2) + "px)"],
		[d, h, "translate(-50%,-50%) rotateY(90deg) translateZ(" + (w / 2) + "px)"],
		[d, h, "translate(-50%,-50%) rotateY(-90deg) translateZ(" + (w / 2) + "px)"],
		[w, d, "translate(-50%,-50%) rotateX(90deg) translateZ(" + (h / 2) + "px)"],
		[w, d, "translate(-50%,-50%) rotateX(-90deg) translateZ(" + (h / 2) + "px)"],
	];
	return (
		<span className={"dk3-box " + (props.cls || "")}
			style={Object.assign({ width: w, height: h, left: props.x - w / 2, top: props.y - h / 2 },
				props.z ? { transform: "translateZ(" + props.z + "px)" } : null, props.style)}>
			{faces.map((f, i) => (
				<span key={i} className="dk3-face" style={{ width: f[0], height: f[1], transform: f[2] }} />
			))}
			{props.children}
		</span>
	);
}

function Monitor3(props) {
	const w = props.w, h = props.h;
	// 屏幕内容：10 行代码（5 行×2 循环）+ 光标，整体向上滚动（速度随 --dkan-speed）
	const lines = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
	return (
		<span className={"dk3-mon3 " + (props.cls || "")}
			style={{ left: props.x - w / 2, top: props.y - h / 2, width: w, height: h, transform: "translateZ(" + (props.z || -3) + "px) rotateY(" + (props.ry || 0) + "deg)" }}>
			<Box3 w={w} h={h} d={5} cls="dk3-frame" x={w / 2} y={h / 2} />
			<span className="dk3-screen" style={{ width: w - 4, height: h - 4, transform: "translate(-50%,-50%) translateZ(3.1px)" }}>
				<span className="dk3-code">
					{lines.map((n, i) => <i key={i} />)}
					<span className="dk3-cur" />
				</span>
			</span>
		</span>
	);
}

// 3D 动漫人物：更拟人的比例与细节（圆角头/ volumetric 头发/五官/脖颈/弯肘/腿脚鞋），侧身面向三屏
function RobotScene(props) {
	const phase = props && props.phase ? props.phase : "code";
	return (
		<div className="dkan-bot-scene" data-phase={phase} aria-hidden="true">
			<div className="dk3-world">
				{/* 书桌（缩短：150 宽，人物居中） */}
				<Box3 w={150} h={7} d={40} cls="dk3-desk" x={115} y={78} />
				<Box3 w={5} h={26} d={32} cls="dk3-metal dk3-leg" x={48} y={94} />
				<Box3 w={5} h={26} d={32} cls="dk3-metal dk3-leg" x={182} y={94} />
				{/* 四屏：三台扇形 + 中屏上叠一台竖屏 */}
				<Monitor3 w={34} h={24} x={140} y={60} ry={24} cls="left" />
				<Monitor3 w={40} h={30} x={168} y={58} ry={0} cls="center" />
				<Monitor3 w={28} h={21} x={188} y={62} ry={-24} cls="right" />
				<Monitor3 w={30} h={20} x={168} y={28} ry={0} cls="top" />
				{/* 键盘 + 咖啡杯（人物手边） */}
				<Box3 w={16} h={2.5} d={9} cls="dk3-metal dk3-kb3" x={126} y={73} z={14} />
				<Box3 w={4} h={5} d={4} cls="dk3-mug" x={140} y={71} z={14} />
				{/* 人物组：坐在桌子中间近镜头侧（z=30） */}
				<div className="dk3-person">
					{/* 椅子：靠背/坐垫/支柱/底盘 */}
					<Box3 w={4} h={30} d={22} cls="dk3-chairback" x={2} y={42} />
					<Box3 w={20} h={4} d={22} cls="dk3-chairseat" x={12} y={58} />
					<Box3 w={3} h={12} d={3} cls="dk3-metal" x={12} y={68} />
					<Box3 w={14} h={2} d={14} cls="dk3-metal" x={12} y={74} />
					{/* 腿：大腿/小腿/鞋 */}
					<Box3 w={13} h={5} d={9} cls="dk3-pants" x={20} y={54} />
					<Box3 w={4} h={12} d={4} cls="dk3-pants" x={26} y={62} />
					<Box3 w={6} h={3} d={5} cls="dk3-shoe" x={28} y={73} />
					{/* 躯干（卫衣）+ 后帽兜 */}
					<Box3 w={15} h={20} d={11} cls="dk3-hood dk3-torso" x={12} y={36} />
					<Box3 w={5} h={8} d={9} cls="dk3-hood dk3-hoodbump" x={5} y={30} />
					{/* 脖颈 */}
					<Box3 w={4} h={3} d={4} cls="dk3-skin" x={14} y={25} />
					{/* 头组：圆角头 + volumetric 头发 + 眼睛 + 嘴（俯仰=rotateZ，左右看=rotateY） */}
					<div className="dk3-head3">
						<Box3 w={13} h={12} d={12} cls="dk3-skin dk3-headbox" x={8} y={10}>
							<span className="dk3-brows" style={{ width: 10, height: 4, transform: "translate(-50%,-50%) rotateY(90deg) translateZ(6.3px)" }}><i /><i /></span>
							<span className="dk3-eyes" style={{ width: 10, height: 7, transform: "translate(-50%,-50%) rotateY(90deg) translateZ(6.2px)" }}>
								<i /><i />
							</span>
							<span className="dk3-nose" style={{ transform: "translate(-50%,-50%) rotateY(90deg) translateZ(6.8px)" }} />
							<span className="dk3-mouth" style={{ transform: "translate(-50%,-50%) rotateY(90deg) translateZ(6.2px)" }} />
						</Box3>
						<Box3 w={14} h={6} d={13} cls="dk3-hair" x={8} y={4} />
						<Box3 w={4} h={11} d={13} cls="dk3-hair" x={2} y={9} />
						<span className="dk3-ear" />
					</div>
					{/* 近侧手臂：上臂微前倾 + 肘 + 前臂 + 手 */}
					<div className="dk3-arm3">
						<Box3 w={4} h={11} d={4} cls="dk3-hood dk3-uarm" x={2} y={6} />
						<div className="dk3-elbow">
							<Box3 w={11} h={3.5} d={3.5} cls="dk3-hood dk3-farm" x={6} y={2} />
							<Box3 w={3.5} h={3} d={3} cls="dk3-skin dk3-hand" x={12.5} y={2} />
						</div>
					</div>
					{/* 远侧手臂 */}
					<div className="dk3-arm3 dk3-far">
						<Box3 w={4} h={11} d={4} cls="dk3-hood dk3-uarm" x={2} y={6} />
						<div className="dk3-elbow">
							<Box3 w={11} h={3.5} d={3.5} cls="dk3-hood dk3-farm" x={6} y={2} />
							<Box3 w={3.5} h={3} d={3} cls="dk3-skin dk3-hand" x={12.5} y={2} />
						</div>
					</div>
				</div>
			</div>
			{/* 思考泡泡（贴镜头的 2D 层，think 阶段显示） */}
			<span className="dkan-bubble"><i /><i /><i /></span>
		</div>
	);
}

// ---------- 提示音（WebAudio 合成；macOS/Windows 通用，无音频文件） ----------
// 音效库：每种含完成音（done）与异常音（err）两套音符序列。
// 音符 [频率, 起始秒, 时长秒, 波形?]，波形缺省 sine。
const SOUND_LIBRARY = {
	chime:  { name: "清脆双音", notes: { done: [[659.25, 0, .14], [880, .13, .24]], err: [[220, 0, .16], [164.81, .15, .3]] } },
	ding:   { name: "叮",       notes: { done: [[987.77, 0, .35]], err: [[246.94, 0, .4]] } },
	coin:   { name: "金币",     notes: { done: [[988, 0, .08], [1319, .08, .35], [988, 0, .08, "square"], [1319, .08, .3, "square"]], err: [[196, 0, .12], [147, .11, .35]] } },
	bell:   { name: "钟声",     notes: { done: [[523.25, 0, .5], [659.25, .02, .45], [783.99, .04, .4]], err: [[174.61, 0, .5], [130.81, .05, .5]] } },
	pulse:  { name: "脉冲",     notes: { done: [[440, 0, .09], [440, .14, .09], [440, .28, .16]], err: [[174.61, 0, .1], [174.61, .14, .1], [174.61, .28, .18]] } },
	arp:    { name: "琶音",     notes: { done: [[523.25, 0, .12], [659.25, .09, .12], [783.99, .18, .12], [1046.5, .27, .3]], err: [[392, 0, .12], [329.63, .1, .12], [261.63, .2, .12], [196, .3, .32]] } },
};
// AudioContext 按需创建（浏览器自动播放策略：首次用户交互后才能出声，静默失败不报错）
let soundCtx = null;
function playTone(seq) {
	try {
		if (typeof window === "undefined" || !window.AudioContext && !window.webkitAudioContext) return;
		const AC = window.AudioContext || window.webkitAudioContext;
		if (!soundCtx) soundCtx = new AC();
		if (soundCtx.state === "suspended") { soundCtx.resume().catch(() => {}); }
		const t0 = soundCtx.currentTime;
		for (const [f, at, dur, wave] of seq) {
			const osc = soundCtx.createOscillator();
			const gain = soundCtx.createGain();
			osc.type = wave || "sine";
			osc.frequency.value = f;
			gain.gain.setValueAtTime(0, t0 + at);
			gain.gain.linearRampToValueAtTime(0.18, t0 + at + 0.015);
			gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
			osc.connect(gain).connect(soundCtx.destination);
			osc.start(t0 + at);
			osc.stop(t0 + at + dur + 0.05);
		}
	} catch { /* 音频不可用静默 */ }
}
// 按音效播放：完成音 / 异常音（未知音效回退 chime）
function playDoneSound(success, effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(success ? lib.notes.done : lib.notes.err);
}
// 试听：完成音 + 异常音 连播（间隔 0.55s）
function previewSound(effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(lib.notes.done);
	const delayed = lib.notes.err.map(([f, at, dur, wave]) => [f, at + 0.55, dur, wave]);
	playTone(delayed);
}


function Toast(props) {
	const t = props.t;
	const [closing, setClosing] = useState(false);
	const close = useCallback(() => { if (!closing) setClosing(true); }, [closing]);
	// 停留时长（stayMs=0 常驻，仅手动关闭）
	useEffect(() => {
		if (!t.stayMs) return;
		const timer = setTimeout(close, t.stayMs);
		return () => clearTimeout(timer);
	}, []);
	useEffect(() => {
		if (!closing) return;
		const timer = setTimeout(() => props.onClose(t.id), 240);
		return () => clearTimeout(timer);
	}, [closing]);
	const markColor = t.kind === "success"
		? "var(--dsw-alias-state-success-primary,#34d399)"
		: t.kind === "error"
			? "var(--dsw-alias-state-error-primary,#f87171)"
			: "var(--dsw-alias-state-warning-primary,#fbbf24)";
	return (
		<div className={"dkan-toast" + (closing ? " out" : "")}>
			<div className="dkan-toast-head">
				<span className="dkan-toast-mark" style={{ background: markColor }} />
				<span className="dkan-toast-title" title={t.title}>{t.title}</span>
				<button type="button" className="dkan-toast-close" aria-label="关闭" onClick={close}>✕</button>
			</div>
			{t.body ? <div className="dkan-toast-body">{t.body}</div> : null}
		</div>
	);
}

// ---------- 交互反馈层：对用户操作即时回应（纸飞机/火花/流光/微光/光涌/彩带） ----------
// 事件来源：document 点击监听（发送/新会话/切会话/切工作目录）+ 任务状态变化（开始/完成）。
// 每个 burst = { id, type, x, y, bits }，bits 为预生成的随机粒子参数（内联样式驱动 CSS 动画）。
function makeBits(n, fn) {
	const arr = [];
	for (let i = 0; i < n; i++) arr.push(fn(i));
	return arr;
}
function BurstLayer(props) {
	const bursts = props.bursts || [];
	return (
		<div className="dkan-fxwrap" aria-hidden="true">
			{bursts.map((b) => {
				if (b.type === "plane") {
					return <span key={b.id} className="dkan-fx dkan-fx-plane" style={{ left: b.x, top: b.y }}>➤</span>;
				}
				if (b.type === "spark") {
					return (
						<span key={b.id} className="dkan-fx dkan-fx-spark" style={{ left: b.x, top: b.y }}>
							{b.bits.map((p, i) => <i key={i} style={{ "--dx": p.dx + "px", "--dy": p.dy + "px", background: p.c, boxShadow: "0 0 6px " + p.c }} />)}
						</span>
					);
				}
				if (b.type === "streak") return <span key={b.id} className="dkan-fx dkan-fx-streak" />;
				if (b.type === "flash") return <span key={b.id} className="dkan-fx dkan-fx-flash" />;
				if (b.type === "surge") return <span key={b.id} className="dkan-fx dkan-fx-surge" />;
				if (b.type === "confetti") {
					return (
						<span key={b.id} className="dkan-fx dkan-fx-confetti">
							{b.bits.map((p, i) => <i key={i} style={{ left: p.l + "%", "--dx": p.dx + "px", "--r": p.r + "deg", background: p.c, boxShadow: "0 0 4px " + p.c, animationDelay: p.d + "s" }} />)}
						</span>
					);
				}
				return null;
			})}
		</div>
	);
}

// ---------- 氛围动效：代码雨 / 星野 / 极光（粒子配置 useMemo 稳定，避免重渲染抖动） ----------
const MATRIX_CHARS = "01</>;{}=+*#";
function AmbientLayer(props) {
	const mode = props.mode;
	const speed = props.speed;
	const matrix = useMemo(() => makeBits(34, () => ({
		l: Math.random() * 100, d: 4 + Math.random() * 6, delay: -Math.random() * 8, o: 0.28 + Math.random() * 0.34, s: 11 + Math.round(Math.random() * 4),
		c: MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] + MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] + MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)],
	})), []);
	const stars = useMemo(() => makeBits(80, () => ({
		l: Math.random() * 100, t: Math.random() * 100, sz: 1.5 + Math.random() * 2, d: 2 + Math.random() * 4, delay: -Math.random() * 6, dx: (Math.random() - 0.5) * 40, dy: (Math.random() - 0.5) * 24,
	})), []);
	if (mode === "matrix") {
		return (
			<div className="dkan-amb dkan-matrix" style={{ "--dkan-speed": speed }} aria-hidden="true">
				{matrix.map((p, i) => (
					<span key={i} style={{ left: p.l + "%", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s", opacity: p.o, fontSize: p.s }}>{p.c}</span>
				))}
			</div>
		);
	}
	if (mode === "stars") {
		return (
			<div className="dkan-amb dkan-stars" style={{ "--dkan-speed": speed }} aria-hidden="true">
				{stars.map((p, i) => (
					<i key={i} className="dkan-star" style={{ left: p.l + "%", top: p.t + "%", width: p.sz, height: p.sz, animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s", "--dx": p.dx + "px", "--dy": p.dy + "px" }} />
				))}
				<span className="dkan-moon" />
				<i className="dkan-meteor" style={{ top: "12%", left: "72%", animationDelay: "0s" }} />
				<i className="dkan-meteor" style={{ top: "28%", left: "88%", animationDelay: "2.8s" }} />
				<i className="dkan-meteor" style={{ top: "6%", left: "42%", animationDelay: "5.6s" }} />
			</div>
		);
	}
	if (mode === "aurora") {
		return (
			<div className="dkan-amb dkan-aurora" style={{ "--dkan-speed": speed }} aria-hidden="true">
				<i /><i /><i />
			</div>
		);
	}
	return null;
}

// ---------- 全局浮层：轮询 + 动效 + 通知（功能启用即常驻） ----------
export function AnimationOverlay(props) {
	const ctx = props && props.ctx;
	const snap = useAnimation();
	const [toasts, setToasts] = useState([]);
	const [flourish, setFlourish] = useState(null); // { key, err } 完成瞬间的一次性流光
	const [bursts, setBursts] = useState([]); // 交互反馈动画队列
	const prevActiveRef = useRef(null);
	const burstIdRef = useRef(0);

	// 触发一个交互反馈动画（自动清理）
	const pushBurst = useCallback((type, x, y, bits) => {
		const id = ++burstIdRef.current;
		setBursts((prev) => prev.concat([{ id, type, x, y, bits }]).slice(-6));
		setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 2600);
	}, []);

	// 点击监听：识别用户操作 → 即时反馈（发送/新会话/切会话/切工作目录）
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onClick = (e) => {
			const t = e.target;
			if (!t || !t.closest) return;
			const sendBtn = t.closest('button[aria-label="Send message"], button[aria-label*="发送"]');
			const newSession = t.closest('button[aria-label*="New session"], button[aria-label*="新会话"], button[aria-label*="New Session"]');
			const workspace = t.closest('button[aria-label*="Choose workspace"], button[aria-label*="工作目录"], button[aria-label*="workspace"]');
			const sessionItem = t.closest('[role="treeitem"]');
			if (sendBtn) {
				pushBurst("plane", e.clientX, e.clientY);
			} else if (newSession) {
				pushBurst("spark", e.clientX, e.clientY, makeBits(10, () => ({
					dx: (Math.random() - 0.5) * 70, dy: (Math.random() - 0.5) * 70,
					c: ["#4d9fff", "#34d399", "#fbbf24", "#f472b6"][Math.floor(Math.random() * 4)],
				})));
			} else if (workspace) {
				pushBurst("flash");
			} else if (sessionItem) {
				pushBurst("streak");
			}
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, [pushBurst]);

	// 任务状态变化 → 开始光涌 / 完成彩带
	const taskCountRef = useRef(0);
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const n = st.active.length;
		if (n > taskCountRef.current) pushBurst("surge");
		taskCountRef.current = n;
	}, [snap.status, pushBurst]);

	// 轮询：有任务 2s / 空闲 6s / 出错 15s；页面从后台切回立即刷新
	useEffect(() => {
		let stopped = false;
		let timer = null;
		const loop = async () => {
			await animationStore.refresh();
			if (stopped) return;
			const s = animationStore.snap;
			timer = setTimeout(loop, s.error ? 15000 : (s.status && s.status.active && s.status.active.length > 0 ? 2000 : 6000));
		};
		loop();
		const onVisible = () => {
			if (!stopped && typeof document !== "undefined" && document.visibilityState === "visible") animationStore.refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, []);

	// 任务结束检测：上一轮活跃、本轮消失 → 通知 + 流光（找最近完成记录补全信息）
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const prev = prevActiveRef.current;
		if (prev) {
			const currIds = new Set(st.active.map((x) => x.sessionId));
			for (const task of prev) {
				if (currIds.has(task.sessionId)) continue;
				const record = (st.recent || []).find((r) => r.sessionId === task.sessionId) || null;
				handleTaskEnd(task, record, st.config || {});
			}
		}
		prevActiveRef.current = st.active.slice();
	}, [snap.status]);

	const handleTaskEnd = (task, record, cfg) => {
		const reason = (record && record.endReason) || "";
		const success = isSuccessReason(reason);
		const info = endInfo(reason);
		// 动画侧：完成瞬间一缕流光掠过 + 成功时顶部彩带庆祝（动画关时不渲染）
		if (cfg.animationEnabled) {
			setFlourish({ key: Date.now(), err: !success });
			if (success) {
				pushBurst("confetti", 0, 0, makeBits(18, (i) => ({
					l: 4 + (i / 18) * 92 + Math.random() * 3,
					dx: (Math.random() - 0.5) * 60,
					r: Math.random() * 720 - 360,
					d: Math.random() * 0.35,
					c: ["#4d9fff", "#34d399", "#fbbf24", "#f472b6", "#a78bfa"][i % 5],
				})));
			}
		}
		// 通知侧：与动画开关完全独立
		if (!cfg.notifyEnabled) return;
		const wanted = success ? cfg.notifyOnComplete : cfg.notifyOnError;
		if (!wanted) return;
		const models = record && record.models && record.models.length ? record.models.join(", ")
			: (task.models && task.models.length ? task.models.join(", ") : "未知模型");
		const provider = (record && record.provider) || task.provider || "";
		const startTs = (record && record.startTime) || task.startTime;
		const endTs = (record && record.endTime) || Date.now();
		const lines = [
			"任务：" + ((record && record.title) || task.title || "(无标题)"),
			"模型：" + models + (provider ? "（" + provider + "）" : ""),
			"耗时：" + fmtDur((record && record.duration) || (endTs - startTs))
				+ "（" + fmtTime(startTs) + " → " + fmtTime(endTs) + "）",
			"回合 " + ((record && record.turns) || task.turns || 0)
				+ " · 步骤 " + ((record && record.steps) || task.steps || 0)
				+ (((record && record.toolCalls) || task.toolCalls) ? " · 工具 " + ((record && record.toolCalls) || task.toolCalls) + " 次" : ""),
			"Token：输入 " + fmtNum((record && record.inputTokens) || task.inputTokens)
				+ " / 输出 " + fmtNum((record && record.outputTokens) || task.outputTokens),
		];
		if (record && record.lastText) lines.push("摘要：" + truncate(record.lastText, 140));
		if (!success && record && record.errorMessage) lines.push("错误：" + truncate(record.errorMessage, 120));
		const title = success ? "任务完成" : "任务" + info.label;
		const toast = {
			id: Date.now() + Math.random(),
			kind: success ? "success" : (info.cls === "err" ? "error" : "warn"),
			title,
			body: lines.join("\n"),
			stayMs: typeof cfg.notifyStayMs === "number" ? cfg.notifyStayMs : 8000,
		};
		setToasts((prev) => prev.concat([toast]).slice(-4));
		// 提示音：任务结束时播放（完成/异常配套音）；与系统通知独立开关
		if (cfg.soundNotify !== false) playDoneSound(success, cfg.soundEffect);
		// 系统通知：仅页面处于后台时推送，避免前台重复打扰
		if (cfg.systemNotify && typeof document !== "undefined" && document.hidden
			&& typeof Notification !== "undefined" && Notification.permission === "granted") {
			try {
				new Notification("dsh " + title, {
					body: ((record && record.title) || task.title || "(无标题)") + " · " + fmtDur((record && record.duration) || (endTs - startTs)),
					tag: "dsh-dock-animation-" + task.sessionId,
				});
			} catch { /* 系统通知失败不影响页面内通知 */ }
		}
	};

	const st = snap.status;
	const cfg = st && st.config;
	const active = st && st.active ? st.active : [];
	const animOn = !!(cfg && cfg.animationEnabled && active.length > 0);
	const mode = cfg && cfg.effectMode ? cfg.effectMode : "flow";
	useTicker(ctx, animOn);
	// 徽标计时：以最早开始的任务为基准
	const now = Date.now();
	const elapsed = active.length > 0 ? fmtClock(now - Math.min(...active.map((x) => x.startTime || now))) : "";
	// 面板打开时隐藏环境动效（徽标/细线/巡航/机器人），避免与弹窗重叠错位
	const [panelOpen, setPanelOpen] = useState(false);
	useEffect(() => {
		setPanelOpen(panelNav.open);
		return subscribePanel(() => setPanelOpen(panelNav.open));
	}, []);
	// 任务速度：两次轮询间 Token 吞吐 → CSS --dkan-speed（0.7~3，越忙越快）
	const [speed, setSpeed] = useState(1);
	const speedRef = useRef({ tokens: -1, at: 0 });
	useEffect(() => {
		if (!st || active.length === 0) { speedRef.current = { tokens: -1, at: 0 }; return; }
		const total = active.reduce((a, x) => a + (x.totalTokens || 0), 0);
		const t = Date.now();
		const prev = speedRef.current;
		if (prev.tokens < 0 || t - prev.at < 500) { speedRef.current = { tokens: total, at: t }; return; }
		const rate = Math.max(0, (total - prev.tokens) / ((t - prev.at) / 1000));
		setSpeed(Math.max(0.7, Math.min(3, 0.7 + rate / 45)));
		speedRef.current = { tokens: total, at: t };
	}, [snap.status]);
	// 机器人阶段：取最近发生阶段变化的活跃任务
	const phase = active.length > 0
		? active.reduce((best, x) => (!best || (x.phaseAt || 0) > (best.phaseAt || 0) ? x : best), null).phase
		: "think";
	const ambientOn = animOn && !panelOpen;
	const robotScaleFromConfig = Math.max(.85, Math.min(2.2, Number(cfg && cfg.robotScale) || 1.35));
	const speedStyle = { "--dkan-speed": Number(speed).toFixed(2) };
	const saveRobotScale = useCallback((robotScale) => {
		rpcCall("config", { robotScale })
			.then((d) => animationStore.applyConfig(d && d.config))
			.catch(() => { /* 浮层保存失败不打断任务动画；面板页会显示可操作的错误 */ });
	}, []);

	// ===== 机器人卡片自由拖拽：整卡可拖到屏幕任意位置（localStorage 持久化），防止固定遮挡 =====
	const [botPos, setBotPos] = useState(null); // null = 停泊默认位（右下、输入卡上方）
	const botPosRef = useRef(null);
	const botDragRef = useRef(null); // { sx, sy, ox, oy, moved }
	const botResizeRef = useRef(null); // { sx, sy, scale }
	const [botScaleDraft, setBotScaleDraft] = useState(null);
	const botClickBlockRef = useRef(false);
	useEffect(() => {
		try {
			if (typeof localStorage === "undefined") return;
			const raw = localStorage.getItem("dsh-dock/anim/robot-pos/v1");
			const p = raw ? JSON.parse(raw) : null;
			if (p && typeof p.x === "number" && typeof p.y === "number" && typeof window !== "undefined") {
				// 恢复时钳制回视口内（窗口可能变小了）
				const card = document.querySelector(".dkan-botcard");
				const w = card ? card.offsetWidth : 200, h = card ? card.offsetHeight : 160;
				const x = Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8));
				const y = Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - h - 8));
				botPosRef.current = { x, y };
				setBotPos({ x, y });
			}
		} catch { /* localStorage 不可用时停默认位 */ }
	}, []);
	const onBotPointerDown = (e) => {
		if (e.button !== 0) return;
		const r = e.currentTarget.getBoundingClientRect();
		botDragRef.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 无指针捕获也能拖 */ }
	};
	const onBotPointerMove = (e) => {
		const d = botDragRef.current;
		if (!d || typeof window === "undefined") return;
		const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
		if (!d.moved && Math.hypot(dx, dy) < 4) return;
		d.moved = true;
		const el = e.currentTarget;
		const w = el.offsetWidth || 200, h = el.offsetHeight || 160;
		const x = Math.min(Math.max(8, d.ox + dx), window.innerWidth - w - 8);
		const y = Math.min(Math.max(8, d.oy + dy), window.innerHeight - h - 8);
		botPosRef.current = { x, y };
		setBotPos({ x, y });
	};
	const onBotPointerUp = () => {
		const d = botDragRef.current;
		botDragRef.current = null;
		if (d && d.moved) {
			try { if (typeof localStorage !== "undefined") localStorage.setItem("dsh-dock/anim/robot-pos/v1", JSON.stringify(botPosRef.current)); } catch { /* 持久化失败静默 */ }
			botClickBlockRef.current = true; // 拖动结束的 pointerup 不触发面板跳转
			setTimeout(() => { botClickBlockRef.current = false; }, 0);
		}
	};
	const onBotResizePointerDown = (e) => {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		botResizeRef.current = { sx: e.clientX, sy: e.clientY, scale: botScaleDraft == null ? robotScaleFromConfig : botScaleDraft };
		try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 无指针捕获也能缩放 */ }
	};
	const onBotResizePointerMove = (e) => {
		const d = botResizeRef.current;
		if (!d) return;
		e.preventDefault();
		e.stopPropagation();
		// 保持场景比例；以右下角手柄向外拖动放大，向内拖动缩小。
		const delta = ((e.clientX - d.sx) + (e.clientY - d.sy)) / 2;
		const next = Math.max(.85, Math.min(2.2, Math.round((d.scale + delta / 220) * 100) / 100));
		setBotScaleDraft(next);
		// 已拖到自定义位置时，放大也始终留在可视区域内。
		if (botPosRef.current && typeof window !== "undefined") {
			const w = 220 * next + 24, h = 132 * next + 46;
			const x = Math.min(Math.max(8, botPosRef.current.x), Math.max(8, window.innerWidth - w - 8));
			const y = Math.min(Math.max(8, botPosRef.current.y), Math.max(8, window.innerHeight - h - 8));
			botPosRef.current = { x, y };
			setBotPos({ x, y });
		}
	};
	const onBotResizePointerUp = (e) => {
		if (!botResizeRef.current) return;
		e.preventDefault();
		e.stopPropagation();
		const next = botScaleDraft == null ? robotScaleFromConfig : botScaleDraft;
		botResizeRef.current = null;
		saveRobotScale(next);
		try { if (botPosRef.current && typeof localStorage !== "undefined") localStorage.setItem("dsh-dock/anim/robot-pos/v1", JSON.stringify(botPosRef.current)); } catch { /* 位置保存失败不影响缩放 */ }
		setBotScaleDraft(null);
	};
	const onBotClick = () => {
		if (botClickBlockRef.current) return;
		openPanel("animation");
	};
	const displayRobotScale = botScaleDraft == null ? robotScaleFromConfig : botScaleDraft;
	const botCardStyle = botPos
		? Object.assign({}, speedStyle, { "--dkan-bot-scale": displayRobotScale, left: botPos.x, top: botPos.y, right: "auto", bottom: "auto" })
		: Object.assign({}, speedStyle, { "--dkan-bot-scale": displayRobotScale });

	// Host 不可用（旧宿主未重启等）：浮层整体静默，面板页会给提示
	if (!st) return null;
	return (<>
		{/* 顶部流光细线（flow 模式 / 任务进行中） */}
		{ambientOn && mode === "flow" ? <div className="dkan-line" style={speedStyle} aria-hidden="true" /> : null}
		{/* 氛围动效（代码雨/星野/极光，任务进行中渲染，速度随吞吐） */}
		{ambientOn && (mode === "matrix" || mode === "stars" || mode === "aurora")
			? <AmbientLayer mode={mode} speed={Number(speed).toFixed(2)} /> : null}
		{/* 环屏巡航：一颗光点沿屏幕边缘转圈（orbit 模式） */}
		{ambientOn && mode === "orbit" ? <div className="dkan-orbit" style={speedStyle} aria-hidden="true" /> : null}
		{/* 交互反馈层：纸飞机/火花/流光/微光/光涌/彩带（与动画开关独立，只要功能启用即回应操作） */}
		<BurstLayer bursts={bursts} />
		{/* 桌面伙伴：背侧视角三屏工位机器人，阶段与任务同步；整卡可拖到任意位置（robot 模式） */}
		{ambientOn && mode === "robot" ? (
			<div className="dkan-botcard" role="button" tabIndex={0} style={botCardStyle}
				title={active.length + " 个任务 · " + phaseLabel(phase) + " · 点击查看任务动画页 · 可拖动到任意位置"}
				onPointerDown={onBotPointerDown}
				onPointerMove={onBotPointerMove}
				onPointerUp={onBotPointerUp}
				onPointerCancel={onBotPointerUp}
				onClick={onBotClick}
				onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onBotClick(); } }}>
				<RobotScene phase={phase} />
				<span className="dkan-bot-cap">
					<span className="n">{active.length}</span> 个任务{elapsed ? " · " + elapsed : ""} · {phaseLabel(phase)}
				</span>
				<button type="button" className="dkan-bot-resize" aria-label="调整桌面伙伴大小"
					title="拖动调整桌面伙伴大小"
					onPointerDown={onBotResizePointerDown}
					onPointerMove={onBotResizePointerMove}
					onPointerUp={onBotResizePointerUp}
					onPointerCancel={onBotResizePointerUp}
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => {
						if (e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowDown" && e.key !== "ArrowLeft") return;
						e.preventDefault(); e.stopPropagation();
						const d = e.key === "ArrowUp" || e.key === "ArrowRight" ? .05 : -.05;
						saveRobotScale(Math.max(.85, Math.min(2.2, Math.round((displayRobotScale + d) * 100) / 100)));
					}} />
			</div>
		) : null}
		{/* 右下角状态徽标：dot 随模式变化（breathe/ring 装饰），点击进功能坞动画页 */}
		{ambientOn && mode !== "robot" ? (
			<button type="button" className="dkan-badge" style={speedStyle}
				title={active.length + " 个任务进行中 · 点击查看任务动画页"}
				onClick={() => openPanel("animation")}>
				<span className="dkan-dotwrap">
					<span className="dkan-dot" />
					{mode === "ring" ? <span className="dkan-ring" /> : null}
				</span>
				<span className="dkan-badge-txt"><span className="n">{active.length}</span> 个任务{elapsed ? " · " + elapsed : ""}</span>
			</button>
		) : null}
		{/* 完成瞬间的一次性流光（成功绿 / 异常红），动画结束自动清场 */}
		{flourish ? (
			<div key={flourish.key} className={"dkan-done" + (flourish.err ? " err" : "")}
				onAnimationEnd={() => setFlourish(null)} aria-hidden="true" />
		) : null}
		{/* 通知卡片栈（右下→右上不遮 dsh 自身 UI；右上角更常规） */}
		{toasts.length > 0 ? (
			<div className="dkan-toasts">
				{toasts.map((t) => <Toast key={t.id} t={t} onClose={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))} />)}
			</div>
		) : null}
	</>);
}

// ---------- 面板页 ----------
function ModePreview({ id }) {
	if (id === "flow") return <span className="dkan-prev"><span className="dkan-prev-flow" /></span>;
	if (id === "ring") {
		return (
			<span className="dkan-prev">
				<span className="dkan-dotwrap"><span className="dkan-dot" /><span className="dkan-ring" /></span>
			</span>
		);
	}
	if (id === "orbit") {
		return (
			<span className="dkan-prev dkan-prev-box">
				<span className="dkan-prev-orbit" />
			</span>
		);
	}
	if (id === "matrix") {
		return (
			<span className="dkan-prev dkan-prev-matrix">
				<i /><i /><i /><i /><i />
			</span>
		);
	}
	if (id === "stars") {
		return (
			<span className="dkan-prev dkan-prev-stars">
				<i /><i /><i /><i /><i /><i />
			</span>
		);
	}
	if (id === "aurora") {
		return (
			<span className="dkan-prev dkan-prev-aurora">
				<i /><i />
			</span>
		);
	}
	if (id === "robot") {
		return (
			<span className="dkan-prev dkan-prev-bot">
				<RobotScene phase="code" />
			</span>
		);
	}
	return (
		<span className="dkan-prev">
			<span className="dkan-dotwrap dkan-breathe"><span className="dkan-dot" /></span>
		</span>
	);
}

function TaskRow(props) {
	const t = props.t;
	const info = endInfo(t.endReason);
	return (
		<div className="dkan-task">
		<div className="dkan-task-head">
			<span className="dkan-task-title" title={t.title}>{t.title || "(无标题)"}</span>
			{props.done ? <span className={"dkan-tag " + info.cls}>{info.label}</span>
				: <span className="dkan-tag on">{phaseLabel(t.phase)}</span>}
		</div>
			<div className="dkan-task-meta">
				<span>{(t.models && t.models.length ? t.models.join(", ") : "未知") + (t.provider ? "（" + t.provider + "）" : "")}</span>
				<span>{props.done ? fmtDur(t.duration) : fmtClock(t.elapsed)}</span>
				{"turns" in t ? <span>{"回合 " + (t.turns || 0) + " · 步骤 " + (t.steps || 0) + (t.toolCalls ? " · 工具 " + t.toolCalls : "")}</span> : null}
				{t.totalTokens ? <span>{"↧" + fmtCompact(t.inputTokens) + " ↥" + fmtCompact(t.outputTokens)}</span> : null}
				{props.done && t.endTime ? <span>{fmtTime(t.endTime)}</span> : null}
			</div>
			{props.done && t.errorMessage ? <div className="dkan-task-err">{truncate(t.errorMessage, 120)}</div> : null}
		</div>
	);
}

function AnimationView(props) {
	const ctx = props && props.ctx;
	const snap = useAnimation(ctx);
	const [cfg, setCfg] = useState(null); // null = 尚未加载
	const [saveErr, setSaveErr] = useState("");
	const [testing, setTesting] = useState(false);
	const [testState, setTestState] = useState(null); // { ok, msg } 机器人测试结果
	const [feishuTestState, setFeishuTestState] = useState(null); // { ok, msg } 飞书测试结果
	const [feishuTesting, setFeishuTesting] = useState(false);
	const cfgRef = useRef(null);
	const pendingSavesRef = useRef(0); // 进行中的保存（轮询回包不覆盖乐观值）
	const editingWebhookRef = useRef(false); // 钉钉 Webhook 输入中（轮询不覆盖草稿）
	const editingFeishuRef = useRef(false); // 飞书 Webhook 输入中（轮询不覆盖草稿）
	// 拉到新配置（含保存回包）后同步本地编辑态；保存中/输入中不覆盖
	useEffect(() => {
		const c = snap.status && snap.status.config;
		if (!c) return;
		if (pendingSavesRef.current > 0 || editingWebhookRef.current || editingFeishuRef.current) return;
		if (c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	}, [snap.status]);
	// 面板打开时兜底拉一次（浮层通常已在轮询）
	useEffect(() => {
		if (!animationStore.snap.status) animationStore.refresh();
	}, []);
	// 乐观更新 + 立即持久化（每个开关独立保存）；返回 Promise 供需要串联的操作使用
	const patch = (p) => {
		setSaveErr("");
		setCfg(Object.assign({}, cfg, p));
		pendingSavesRef.current++;
		return rpcCall("config", p)
			.then((d) => {
				pendingSavesRef.current--;
				animationStore.applyConfig(d && d.config);
			})
			.catch((e) => {
				pendingSavesRef.current--;
				setSaveErr("保存失败：" + ((e && e.message) || String(e)));
			});
	};
	// Webhook 草稿保存：清编辑态后立即对齐一次（同步 effect 在编辑期被跳过）
	const saveWebhook = async () => {
		if (!editingWebhookRef.current) return;
		const hook = String(cfg.dingtalkWebhook || "").trim();
		await patch({ dingtalkWebhook: hook });
		editingWebhookRef.current = false;
		const c = animationStore.snap.status && animationStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	};
	// 飞书 Webhook 草稿保存
	const saveFeishuWebhook = async () => {
		if (!editingFeishuRef.current) return;
		const hook = String(cfg.feishuWebhook || "").trim();
		await patch({ feishuWebhook: hook });
		editingFeishuRef.current = false;
		const c = animationStore.snap.status && animationStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setCfg(Object.assign({}, c));
		}
	};
	// 钉钉测试：草稿未保存先保存，再发测试消息
	const runDingtalkTest = async () => {
		setTesting(true);
		setTestState(null);
		try {
			if (editingWebhookRef.current) {
				const hook = String(cfg.dingtalkWebhook || "").trim();
				if (!hook) throw new Error("请先填写 Webhook 地址");
				const d = await rpcCall("config", { dingtalkWebhook: hook });
				animationStore.applyConfig(d && d.config);
				editingWebhookRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setCfg(Object.assign({}, cfg, { dingtalkWebhook: hook }));
			}
			const r = await rpcCall("test");
			setTestState(r && r.sent
				? { ok: true, msg: "测试消息已发送，去群里看看" }
				: { ok: false, msg: (r && r.error) || "发送失败" });
		} catch (e) {
			setTestState({ ok: false, msg: (e && e.message) || String(e) });
		} finally {
			setTesting(false);
		}
	};
	// 飞书测试：草稿未保存先保存，再发测试消息
	const runFeishuTest = async () => {
		setFeishuTesting(true);
		setFeishuTestState(null);
		try {
			if (editingFeishuRef.current) {
				const hook = String(cfg.feishuWebhook || "").trim();
				if (!hook) throw new Error("请先填写 Webhook 地址");
				const d = await rpcCall("config", { feishuWebhook: hook });
				animationStore.applyConfig(d && d.config);
				editingFeishuRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setCfg(Object.assign({}, cfg, { feishuWebhook: hook }));
			}
			const r = await rpcCall("test", { target: "feishu" });
			setFeishuTestState(r && r.sent
				? { ok: true, msg: "测试消息已发送，去群里看看" }
				: { ok: false, msg: (r && r.error) || "发送失败" });
		} catch (e) {
			setFeishuTestState({ ok: false, msg: (e && e.message) || String(e) });
		} finally {
			setFeishuTesting(false);
		}
	};
	const enableSystemNotify = async (next) => {
		if (next && typeof Notification !== "undefined" && Notification.permission !== "granted") {
			try {
				const perm = await Notification.requestPermission(); // 开关点击即用户手势
				if (perm !== "granted") {
					setSaveErr("浏览器未授权系统通知（可在地址栏权限设置里重新允许）");
					return;
				}
			} catch {
				setSaveErr("浏览器不支持系统通知");
				return;
			}
		}
		patch({ systemNotify: next });
	};

	const st = snap.status;
	const active = st && st.active ? st.active : [];
	const recent = st && st.recent ? st.recent.slice(0, 6) : [];
	const permNote = typeof Notification === "undefined"
		? "当前浏览器不支持系统通知"
		: Notification.permission === "granted" ? "已授权 · 仅页面后台时推送"
			: Notification.permission === "denied" ? "已被浏览器拒绝（需在浏览器权限设置里重新允许）" : "未授权 · 开启时会请求授权，仅页面后台时推送";

	const rows = [];
	if (!cfg) {
		rows.push(<div key="load" className="dkan-note">{snap.error ? "状态不可用：" + snap.error : (snap.loading ? "正在拉取任务状态…" : "等待任务状态")}</div>);
	} else {
		rows.push(
			<div key="anim" className="dkan-sec">
				<div className="dkan-sec-head">
					<span className="dkan-sec-title">运行动画</span>
					<span className="dkan-sec-sub">任务进行中才出现；克制的动效，暗/亮色自适应</span>
					<span className="dkan-sec-sw">
						<span className={"dkan-sec-swlabel" + (cfg.animationEnabled ? " on" : "")}>{cfg.animationEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.animationEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.animationEnabled} aria-label="开关运行动画"
							title={cfg.animationEnabled ? "关闭运行动画" : "开启运行动画"}
							onClick={() => patch({ animationEnabled: !cfg.animationEnabled })} />
					</span>
				</div>
				{cfg.animationEnabled ? (
					<>
					<div className="dkan-modes">
						{EFFECT_MODES.map((m) => (
							<button type="button" key={m.id}
								className={"dkan-mode" + (cfg.effectMode === m.id ? " on" : "")}
								onClick={() => patch({ effectMode: m.id })}>
								<span className="dkan-mode-name">{m.name}</span>
								<ModePreview id={m.id} />
								<span className="dkan-mode-desc">{m.desc}</span>
							</button>
						))}
					</div>
					{cfg.effectMode === "robot" ? <div className="dkan-robot-controls">
						<div className="dkan-robot-controls-head">
							<span>桌面伙伴大小</span>
							<strong>{Math.round((Number(cfg.robotScale) || 1.35) * 100)}%</strong>
						</div>
						<div className="dkan-robot-size-options" role="group" aria-label="桌面伙伴大小预设">
							{[[1, "紧凑"], [1.35, "默认"], [1.7, "加大"], [2.1, "特大"]].map(([scale, label]) => (
								<button type="button" key={scale} className={Math.abs((Number(cfg.robotScale) || 1.35) - scale) < .03 ? "on" : ""}
									onClick={() => patch({ robotScale: scale })}>{label}</button>
							))}
						</div>
						<div className="dkan-robot-slider-row">
							<input type="range" min="0.85" max="2.2" step="0.05" value={Number(cfg.robotScale) || 1.35}
								aria-label="桌面伙伴大小百分比"
								onChange={(e) => patch({ robotScale: Number(e.target.value) })} />
							<span>浮层右下角也可直接拖动缩放，大小会自动保存。</span>
						</div>
					</div> : null}
					</>
				) : <div className="dkan-note">动画已关闭——只保留通知（或全部关闭）时，页面不会有任何动效。</div>}
			</div>,
			<div key="notify" className="dkan-sec">
				<div className="dkan-sec-head">
					<span className="dkan-sec-title">完成通知</span>
					<span className="dkan-sec-sub">与动画互不依赖，可单独开启</span>
					<span className="dkan-sec-sw">
						<span className={"dkan-sec-swlabel" + (cfg.notifyEnabled ? " on" : "")}>{cfg.notifyEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.notifyEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.notifyEnabled} aria-label="开关完成通知"
							title={cfg.notifyEnabled ? "关闭完成通知" : "开启完成通知"}
							onClick={() => patch({ notifyEnabled: !cfg.notifyEnabled })} />
					</span>
				</div>
				{cfg.notifyEnabled ? <div className="dkan-rows-narrow">
					<div className="dkan-row">
						<span className="dkan-row-label">完成通知</span>
						<button type="button" className={"dkm-miniswitch" + (cfg.notifyOnComplete ? " on" : "")}
							onClick={() => patch({ notifyOnComplete: !cfg.notifyOnComplete })}>
							{cfg.notifyOnComplete ? "开" : "关"}
						</button>
						<span className="dkan-row-sub">任务正常完成时通知</span>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">异常通知</span>
						<button type="button" className={"dkm-miniswitch" + (cfg.notifyOnError ? " on" : "")}
							onClick={() => patch({ notifyOnError: !cfg.notifyOnError })}>
							{cfg.notifyOnError ? "开" : "关"}
						</button>
						<span className="dkan-row-sub">出错 / 中止 / 达输出上限时通知</span>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">停留时长</span>
						<select className="dkan-select" value={String(cfg.notifyStayMs)}
							onChange={(e) => patch({ notifyStayMs: Number(e.target.value) })}>
							<option value="4000">4 秒</option>
							<option value="8000">8 秒</option>
							<option value="15000">15 秒</option>
							<option value="30000">30 秒</option>
							<option value="0">常驻（手动关闭）</option>
						</select>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">系统通知</span>
						<button type="button" className={"dkm-miniswitch" + (cfg.systemNotify ? " on" : "")}
							onClick={() => enableSystemNotify(!cfg.systemNotify)}>
							{cfg.systemNotify ? "开" : "关"}
						</button>
						<span className="dkan-row-sub">{permNote}</span>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">提示音</span>
						<button type="button" className={"dkm-miniswitch" + (cfg.soundNotify !== false ? " on" : "")}
							onClick={() => patch({ soundNotify: cfg.soundNotify === false })}>
							{cfg.soundNotify !== false ? "开" : "关"}
						</button>
						<span className="dkan-row-sub">任务结束时播放（试听为先播完成音、后播异常音）</span>
					</div>
					{cfg.soundNotify !== false ? (
						<div className="dkan-sounds">
							{Object.keys(SOUND_LIBRARY).map((key) => (
								<button type="button" key={key}
									className={"dkan-sound" + (cfg.soundEffect === key ? " on" : "")}
									onClick={() => patch({ soundEffect: key })}>
									<span className="dkan-sound-name">
										{SOUND_LIBRARY[key].name}
										{cfg.soundEffect === key ? <span className="dkan-sound-cur">✓</span> : null}
									</span>
									<span className="dkan-sound-play" role="button" tabIndex={0}
										title={"试听 " + SOUND_LIBRARY[key].name}
										onClick={(e) => { e.stopPropagation(); previewSound(key); }}
										onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); previewSound(key); } }}>▶</span>
								</button>
							))}
						</div>
					) : null}
				</div> : <div className="dkan-note">通知已关闭——任务结束时既不弹卡片也不推系统通知。</div>}
			</div>,
			<div key="dingtalk" className="dkan-sec">
				<div className="dkan-sec-head">
					<span className="dkan-sec-title">钉钉推送</span>
					<span className="dkan-sec-sub">任务结束推送到钉钉群机器人（宿主直发，浏览器关着也能推；事件跟随上方完成/异常开关）</span>
					<span className="dkan-sec-sw">
						<span className={"dkan-sec-swlabel" + (cfg.dingtalkEnabled ? " on" : "")}>{cfg.dingtalkEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.dingtalkEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.dingtalkEnabled} aria-label="开关钉钉推送"
							title={cfg.dingtalkEnabled ? "关闭钉钉推送" : "开启钉钉推送"}
							onClick={() => patch({ dingtalkEnabled: !cfg.dingtalkEnabled })} />
					</span>
				</div>
				{cfg.dingtalkEnabled ? <div className="dkan-rows-narrow">
					<div className="dkan-row dkan-row-webhook">
						<span className="dkan-row-label">Webhook</span>
						<input type="text" className="dkan-input" spellCheck={false}
							value={cfg.dingtalkWebhook || ""}
							placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
							onChange={(e) => {
								editingWebhookRef.current = true;
								setCfg(Object.assign({}, cfg, { dingtalkWebhook: e.target.value }));
							}} />
						<button type="button" className="dkan-btn" disabled={!editingWebhookRef.current}
							onClick={saveWebhook}>
							{editingWebhookRef.current ? "保存" : "已保存"}
						</button>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">连通测试</span>
						<button type="button" className="dkan-btn" disabled={testing} onClick={runDingtalkTest}>
							{testing ? "发送中…" : "发送测试消息"}
						</button>
						{testState ? <span className={"dkan-row-sub" + (testState.ok ? " dkan-ok" : " dkan-err")}>
							{testState.ok ? "✓ " : "✗ "}{testState.msg}
						</span> : <span className="dkan-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
					</div>
					<div className="dkan-note">机器人创建：钉钉群 → 设置 → 智能群助手 → 添加机器人 → 自定义（Webhook），
						安全设置选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
				</div> : <div className="dkan-note">未开启——任务结束不推送钉钉。</div>}
			</div>,
			<div key="feishu" className="dkan-sec">
				<div className="dkan-sec-head">
					<span className="dkan-sec-title">飞书推送</span>
					<span className="dkan-sec-sub">任务结束推送到飞书群机器人（宿主直发，浏览器关着也能推；事件跟随上方完成/异常开关）</span>
					<span className="dkan-sec-sw">
						<span className={"dkan-sec-swlabel" + (cfg.feishuEnabled ? " on" : "")}>{cfg.feishuEnabled ? "已开启" : "已关闭"}</span>
						<button type="button" className={"dock-sw" + (cfg.feishuEnabled ? " on" : "")}
							role="switch" aria-checked={cfg.feishuEnabled} aria-label="开关飞书推送"
							title={cfg.feishuEnabled ? "关闭飞书推送" : "开启飞书推送"}
							onClick={() => patch({ feishuEnabled: !cfg.feishuEnabled })} />
					</span>
				</div>
				{cfg.feishuEnabled ? <div className="dkan-rows-narrow">
					<div className="dkan-row dkan-row-webhook">
						<span className="dkan-row-label">Webhook</span>
						<input type="text" className="dkan-input" spellCheck={false}
							value={cfg.feishuWebhook || ""}
							placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
							onChange={(e) => {
								editingFeishuRef.current = true;
								setCfg(Object.assign({}, cfg, { feishuWebhook: e.target.value }));
							}} />
						<button type="button" className="dkan-btn" disabled={!editingFeishuRef.current}
							onClick={saveFeishuWebhook}>
							{editingFeishuRef.current ? "保存" : "已保存"}
						</button>
					</div>
					<div className="dkan-row">
						<span className="dkan-row-label">连通测试</span>
						<button type="button" className="dkan-btn" disabled={feishuTesting} onClick={runFeishuTest}>
							{feishuTesting ? "发送中…" : "发送测试消息"}
						</button>
						{feishuTestState ? <span className={"dkan-row-sub" + (feishuTestState.ok ? " dkan-ok" : " dkan-err")}>
							{feishuTestState.ok ? "✓ " : "✗ "}{feishuTestState.msg}
						</span> : <span className="dkan-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
					</div>
					<div className="dkan-note">机器人创建：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人（获取 Webhook 地址）；
						安全设置如选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
				</div> : <div className="dkan-note">未开启——任务结束不推送飞书。</div>}
			</div>
		);
	}
	if (saveErr) rows.push(<div key="err" className="dkan-note dkan-err">{saveErr}</div>);
	rows.push(
		<div key="state" className="dkan-sec">
			<div className="dkan-sec-head">
				<span className="dkan-sec-title">运行状态</span>
				<span className="dkan-sec-sub">
					{snap.error ? "状态拉取失败：" + snap.error
						: active.length > 0 ? active.length + " 个任务进行中"
							: recent.length > 0 ? "空闲 · 显示最近完成" : "空闲 · 暂无任务记录"}
				</span>
				<button type="button" className="dkan-refresh" onClick={() => animationStore.refresh()}>
					{snap.loading ? "刷新中…" : "刷新"}
				</button>
			</div>
			{active.length > 0 ? <div className="dkan-tasks">{active.map((t) => <TaskRow key={t.sessionId} t={t} />)}</div> : null}
			{active.length === 0 && recent.length === 0
				? <div className="dkan-note">发起新会话任务后，这里会显示进行中与最近完成的任务；动画与通知同时在页面生效。</div> : null}
			{recent.length > 0 ? <div className="dkan-tasks dkan-tasks-done">{recent.map((t) => <TaskRow key={t.sessionId + ":" + t.endTime} t={t} done />)}</div> : null}
		</div>
	);
	return <div className="dkan-root">{rows}</div>;
}

// ---------- 首页总揽概要 ----------
function AnimationStat(props) {
	const snap = useAnimation(props && props.ctx);
	const st = snap.status;
	if (snap.error) return <span className="dkan-err">任务状态不可用（宿主需重启加载动画路由）</span>;
	if (!st) return <span>等待任务状态…</span>;
	if (st.active && st.active.length > 0) {
		return <span>{st.active.length + " 个任务进行中 · " + fmtDur(Math.max(...st.active.map((x) => x.elapsed || 0)))}</span>;
	}
	const last = st.recent && st.recent[0];
	return <span>{last ? "空闲 · 最近完成 " + truncate(last.title, 24) : "空闲 · 暂无任务记录"}</span>;
}

// ---------- 样式（dkan- 前缀；全部走主题变量，暗/亮色自适应；动效时长 = 基准 / --dkan-speed） ----------
const css = [
	// 顶部流光细线（3px，比首版更醒目）
	".dkan-line{position:fixed;top:0;left:0;right:0;height:3px;z-index:9990;pointer-events:none;background:color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 30%,transparent);}",
	".dkan-line::after{content:\"\";position:absolute;top:0;bottom:0;left:-42%;width:42%;background:linear-gradient(90deg,transparent,var(--dsw-alias-accent,#4d9fff) 60%,#fff);box-shadow:0 0 10px 1px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 70%,transparent);animation:dkan-flow calc(1.9s / var(--dkan-speed,1)) linear infinite;}",
	"@keyframes dkan-flow{to{left:100%}}",
	// 完成瞬间的一次性流光（成功绿 / 异常红），动画结束自动清场
	".dkan-done{position:fixed;top:0;left:0;right:0;height:3px;z-index:9991;pointer-events:none;background:linear-gradient(90deg,transparent,var(--dsw-alias-state-success-primary,#34d399) 50%,#fff);background-size:50% 100%;background-repeat:no-repeat;animation:dkan-done 1.1s var(--ds-ease-in-out) forwards;}",
	".dkan-done.err{background-image:linear-gradient(90deg,transparent,var(--dsw-alias-state-error-primary,#f87171) 50%,#fff);}",
	"@keyframes dkan-done{0%{background-position:-60% 0;opacity:0}25%{opacity:1}100%{background-position:160% 0;opacity:0}}",
	// 环屏巡航：光点沿屏幕边缘转一整圈
	".dkan-orbit{position:fixed;top:0;left:0;width:12px;height:12px;z-index:9990;pointer-events:none;border-radius:50%;background:var(--dsw-alias-accent,#4d9fff);box-shadow:0 0 14px 4px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 60%,transparent),0 0 30px 8px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 25%,transparent);animation:dkan-orbit calc(14s / var(--dkan-speed,1)) linear infinite;}",
	"@keyframes dkan-orbit{0%{top:0;left:0}25%{top:0;left:calc(100vw - 12px)}50%{top:calc(100vh - 12px);left:calc(100vw - 12px)}75%{top:calc(100vh - 12px);left:0}100%{top:0;left:0}}",
	// ===== 氛围动效 =====
	".dkan-amb{position:fixed;inset:0;z-index:9989;pointer-events:none;overflow:hidden;}",
	// 代码雨：字符列缓落（提亮加大，速度随吞吐）
	".dkan-matrix span{position:absolute;top:-12%;writing-mode:vertical-rl;font-family:var(--ds-font-family-code,monospace);color:var(--dsw-alias-accent,#4d9fff);text-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 60%,transparent);animation:dkan-fall linear infinite;will-change:transform;}",
	"@keyframes dkan-fall{to{transform:translateY(125vh)}}",
	// 星野：星点缓慢飘移 + 闪烁（加亮加发光）+ 月亮 + 流星
	".dkan-stars .dkan-star{position:absolute;border-radius:50%;background:#cfe3ff;box-shadow:0 0 4px 1px color-mix(in srgb,#8ab6ff 55%,transparent);animation:dkan-star ease-in-out infinite alternate;}",
	"@keyframes dkan-star{0%{opacity:.3;transform:translate(0,0)}50%{opacity:1}100%{opacity:.45;transform:translate(var(--dx),var(--dy))}}",
	// 月亮：右上弯月（radial-gradient 咬出月牙，透明区不遮挡背景；外圈柔光晕）
	".dkan-moon{position:absolute;top:9%;right:10%;width:36px;height:36px;border-radius:50%;background:radial-gradient(circle at 66% 34%,transparent 0 44%,#fdf6d8 46%,#e8d9a0 78%,#d8c78a);box-shadow:0 0 18px 4px color-mix(in srgb,#fdf6d8 35%,transparent),0 0 44px 12px color-mix(in srgb,#fdf6d8 15%,transparent);}",
	// 流星：斜向划过的光带（亮头 + 渐隐尾），周期出现
	".dkan-meteor{position:absolute;width:110px;height:2px;border-radius:2px;background:linear-gradient(90deg,#fff,color-mix(in srgb,#8ab6ff 60%,transparent) 40%,transparent);transform:rotate(35deg);transform-origin:left center;opacity:0;animation:dkan-meteor 8.4s linear infinite;}",
	".dkan-meteor::before{content:\"\";position:absolute;left:-2px;top:-2px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 8px 2px color-mix(in srgb,#cfe3ff 70%,transparent);}",
	"@keyframes dkan-meteor{0%{opacity:0;transform:rotate(35deg) translateX(0)}3%{opacity:1}10%{opacity:0;transform:rotate(35deg) translateX(46vh)}100%{opacity:0;transform:rotate(35deg) translateX(46vh)}}",
	// 极光：顶部柔光带呼吸流动（加浓）
	".dkan-aurora i{position:absolute;top:-40%;left:-20%;width:70%;height:80%;border-radius:50%;filter:blur(50px);opacity:.32;animation:dkan-aurora ease-in-out infinite alternate;}",
	".dkan-aurora i:nth-child(1){background:#4d9fff;}",
	".dkan-aurora i:nth-child(2){background:#34d399;left:20%;animation-delay:-2s;}",
	".dkan-aurora i:nth-child(3){background:#a78bfa;left:55%;animation-delay:-4s;}",
	"@keyframes dkan-aurora{0%{transform:translateX(-8%) scaleY(1)}100%{transform:translateX(10%) scaleY(1.3)}}",
	// ===== 交互反馈层 =====
	".dkan-fxwrap{position:fixed;inset:0;z-index:9992;pointer-events:none;overflow:hidden;}",
	".dkan-fx{position:absolute;}",
	// 纸飞机：从点击处向右上飞出淡出（加大加亮）
	".dkan-fx-plane{color:var(--dsw-alias-accent,#4d9fff);font-size:24px;text-shadow:0 0 8px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 70%,transparent);animation:dkan-plane 1.2s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-plane{0%{opacity:0;transform:translate(0,0) rotate(-20deg) scale(.6)}15%{opacity:1;transform:translate(20px,-14px) rotate(-20deg) scale(1.1)}100%{opacity:0;transform:translate(240px,-160px) rotate(-20deg) scale(1)}}",
	// 火花：粒子四散（加大加多散得更开）
	".dkan-fx-spark i{position:absolute;width:7px;height:7px;border-radius:50%;box-shadow:0 0 6px currentColor;animation:dkan-spark .9s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.4)}}",
	// 流光：横向扫过（切会话，加高加亮）
	".dkan-fx-streak{top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,var(--dsw-alias-accent,#4d9fff) 50%,#fff);background-size:45% 100%;background-repeat:no-repeat;box-shadow:0 0 12px 2px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 50%,transparent);animation:dkan-streak 1s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-streak{0%{background-position:-50% 0;opacity:0}20%{opacity:1}100%{background-position:150% 0;opacity:0}}",
	// 微光：全屏柔光一闪（切工作目录，加浓）
	".dkan-fx-flash{inset:0;background:radial-gradient(ellipse at center,color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 26%,transparent),transparent 75%);animation:dkan-flash .8s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-flash{0%{opacity:0}30%{opacity:1}100%{opacity:0}}",
	// 光涌：底部向上涌起（任务开始，加高加浓）
	".dkan-fx-surge{left:0;right:0;bottom:0;height:42%;background:linear-gradient(0deg,color-mix(in srgb,var(--dsw-alias-state-success-primary,#34d399) 38%,transparent),transparent);animation:dkan-surge 1.2s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-surge{0%{opacity:0;transform:translateY(45%)}30%{opacity:1}100%{opacity:0;transform:translateY(-35%)}}",
	// 彩带：顶部飘落（任务完成庆祝，加大加多）
	".dkan-fx-confetti{inset:0;}",
	".dkan-fx-confetti i{position:absolute;top:-14px;width:8px;height:13px;border-radius:2px;box-shadow:0 0 4px currentColor;animation:dkan-confetti 2s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-confetti{0%{opacity:1;transform:translateY(0) rotate(0)}100%{opacity:0;transform:translateY(75vh) translateX(var(--dx)) rotate(var(--r))}}",
	// 右下角状态徽标（玻璃拟态，可点击）；抬到 dsh 输入卡上方避免重叠错位
	".dkan-badge{position:fixed;right:20px;bottom:calc(var(--dsh-composer-height,152px) + 20px);z-index:9990;display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 6px 24px rgb(0 0 0 / .16);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;pointer-events:auto;animation:dkan-rise .3s var(--ds-ease-in-out);transition:color .15s var(--ds-ease-in-out);}",
	".dkan-badge:hover{color:var(--dsw-alias-label-primary);}",
	".dkan-badge .n{color:var(--dsw-alias-label-primary);font-weight:600;}",
	"@keyframes dkan-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}",
	// 徽标圆点与两种动效（呼吸 / 轨道环）
	".dkan-dotwrap{position:relative;width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;}",
	".dkan-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-accent,#4d9fff);box-shadow:0 0 8px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 55%,transparent);}",
	".dkan-breathe .dkan-dot{animation:dkan-breathe calc(2.6s / var(--dkan-speed,1)) ease-in-out infinite;}",
	"@keyframes dkan-breathe{0%,100%{transform:scale(1);opacity:.55}50%{transform:scale(1.6);opacity:1}}",
	".dkan-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 68%,var(--dsw-alias-accent,#4d9fff) 92%,#fff);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));animation:dkan-spin calc(2.2s / var(--dkan-speed,1)) linear infinite;opacity:.9;}",
	"@keyframes dkan-spin{to{transform:rotate(360deg)}}",
	// 通知卡片栈（右上角）
	".dkan-toasts{position:fixed;top:16px;right:16px;z-index:9995;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 32px));}",
	".dkan-toast{border-radius:12px;padding:12px 14px;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 36px rgb(0 0 0 / .22);animation:dkan-toast-in .32s var(--ds-ease-in-out);}",
	".dkan-toast.out{animation:dkan-toast-out .24s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-toast-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}",
	"@keyframes dkan-toast-out{to{opacity:0;transform:translateX(10px)}}",
	".dkan-toast-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
	".dkan-toast-mark{width:8px;height:8px;border-radius:50%;flex:none;}",
	".dkan-toast-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkan-toast-close{cursor:pointer;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;width:22px;height:22px;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;}",
	".dkan-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dkan-toast-body{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;white-space:pre-line;word-break:break-word;}",
	// 面板页布局
	".dkan-root{display:flex;flex-direction:column;gap:10px;}",
	".dkan-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dkan-err{color:var(--dsw-alias-state-error-primary);}",
	".dkan-sec{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
	".dkan-sec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dkan-sec-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:none;}",
	".dkan-sec-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:120px;}",
	".dkan-sec-sw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;}",
	".dkan-sec-swlabel{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
	".dkan-sec-swlabel.on{color:var(--dsw-alias-state-success-primary);}",
	".dkan-refresh{cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:2px 10px;font-family:inherit;font-size:12px;}",
	".dkan-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	// 模式选择卡（带缩微预览）
	".dkan-modes{display:flex;gap:8px;flex-wrap:wrap;}",
	".dkan-mode{flex:1;min-width:150px;display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-family:inherit;text-align:left;transition:border-color .15s var(--ds-ease-in-out);}",
	".dkan-mode:hover{border-color:var(--dsw-alias-accent,#4d9fff);}",
	".dkan-mode.on{border-color:var(--dsw-alias-accent,#4d9fff);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 40%,transparent);}",
	".dkan-mode-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px;}",
	".dkan-mode.on .dkan-mode-name::after{content:\"✓\";color:var(--dsw-alias-accent,#4d9fff);}",
	".dkan-mode-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;}",
	".dkan-robot-controls{display:flex;flex-direction:column;gap:8px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 28%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 5%,var(--dsw-alias-bg-layer-2));}",
	".dkan-robot-controls-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-primary);}",
	".dkan-robot-controls-head strong{font-variant-numeric:tabular-nums;color:var(--dsw-alias-accent,#4d9fff);}",
	".dkan-robot-size-options{display:flex;gap:6px;flex-wrap:wrap;}",
	".dkan-robot-size-options button{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;}",
	".dkan-robot-size-options button:hover,.dkan-robot-size-options button.on{border-color:var(--dsw-alias-accent,#4d9fff);color:var(--dsw-alias-label-primary);}",
	".dkan-robot-slider-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkan-robot-slider-row input{accent-color:var(--dsw-alias-accent,#4d9fff);width:min(240px,100%);}",
	".dkan-prev{height:30px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}",
	".dkan-prev-flow{position:absolute;top:0;left:0;right:0;height:3px;background:color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 30%,transparent);}",
	".dkan-prev-flow::after{content:\"\";position:absolute;top:0;bottom:0;left:-40%;width:40%;background:linear-gradient(90deg,transparent,var(--dsw-alias-accent,#4d9fff));animation:dkan-flow 1.9s linear infinite;}",
	".dkan-prev-box{--dkan-speed:1;}",
	".dkan-prev-orbit{position:absolute;top:3px;left:3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-accent,#4d9fff);box-shadow:0 0 7px 2px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 55%,transparent);animation:dkan-prev-orbit 3s linear infinite;}",
	"@keyframes dkan-prev-orbit{0%{top:3px;left:3px}25%{top:3px;left:calc(100% - 10px)}50%{top:calc(100% - 10px);left:calc(100% - 10px)}75%{top:calc(100% - 10px);left:3px}100%{top:3px;left:3px}}",
	// 预览：代码雨（字符列下落）
	".dkan-prev-matrix i{position:absolute;top:-100%;writing-mode:vertical-rl;font-size:8px;font-family:var(--ds-font-family-code,monospace);color:var(--dsw-alias-accent,#4d9fff);opacity:.5;animation:dkan-prev-fall 2.2s linear infinite;}",
	".dkan-prev-matrix i:nth-child(1){left:12%;}",
	".dkan-prev-matrix i:nth-child(2){left:32%;animation-delay:-.6s;}",
	".dkan-prev-matrix i:nth-child(3){left:52%;animation-delay:-1.2s;}",
	".dkan-prev-matrix i:nth-child(4){left:72%;animation-delay:-.3s;}",
	".dkan-prev-matrix i:nth-child(5){left:88%;animation-delay:-1.6s;}",
	".dkan-prev-matrix i::after{content:\"01</>\";}",
	"@keyframes dkan-prev-fall{to{transform:translateY(300%)}}",
	// 预览：星野（星点闪烁）
	".dkan-prev-stars i{position:absolute;width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-secondary);animation:dkan-prev-star 1.6s ease-in-out infinite alternate;}",
	".dkan-prev-stars i:nth-child(1){left:15%;top:25%;}",
	".dkan-prev-stars i:nth-child(2){left:40%;top:60%;animation-delay:-.4s;}",
	".dkan-prev-stars i:nth-child(3){left:60%;top:30%;animation-delay:-.8s;}",
	".dkan-prev-stars i:nth-child(4){left:80%;top:55%;animation-delay:-1.2s;}",
	".dkan-prev-stars i:nth-child(5){left:28%;top:70%;animation-delay:-.6s;}",
	".dkan-prev-stars i:nth-child(6){left:70%;top:75%;animation-delay:-1s;}",
	"@keyframes dkan-prev-star{0%{opacity:.2}100%{opacity:.9}}",
	// 预览：极光（柔光带呼吸）
	".dkan-prev-aurora i{position:absolute;top:-30%;width:60%;height:120%;border-radius:50%;filter:blur(8px);opacity:.35;animation:dkan-prev-aurora 2.4s ease-in-out infinite alternate;}",
	".dkan-prev-aurora i:nth-child(1){left:5%;background:#4d9fff;}",
	".dkan-prev-aurora i:nth-child(2){left:45%;background:#34d399;animation-delay:-1.2s;}",
	"@keyframes dkan-prev-aurora{0%{transform:translateX(-10%)}100%{transform:translateX(15%)}}",
	".dkan-prev-bot{height:92px;justify-content:center;}",
	".dkan-prev-bot .dkan-bot-scene{--dkan-bot-scale:1;transform:scale(.56);transform-origin:center;}",
	// ===== 桌面伙伴：具象人物 + 四屏工位（尺寸可调，整卡可拖拽） =====
	// 卡片：玻璃拟态；默认停泊右下（dsh 输入卡上方），拖动后位置持久化、可放屏幕任意处
	".dkan-botcard{--dkan-bot-scale:1.35;position:fixed;right:20px;bottom:calc(var(--dsh-composer-height,152px) + 20px);z-index:9990;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:16px;cursor:grab;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 86%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 12px 36px rgb(0 0 0 / .22);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;pointer-events:auto;touch-action:none;user-select:none;animation:dkan-rise .3s var(--ds-ease-in-out);}",
	".dkan-botcard:hover,.dkan-botcard:focus-visible{border-color:var(--dsw-alias-accent,#4d9fff);outline:none;}",
	".dkan-botcard.dkan-dragging{cursor:grabbing;animation:none;}",
	".dkan-botcard .n{color:var(--dsw-alias-label-primary);font-weight:600;}",
	".dkan-bot-cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:18px;}",
	".dkan-bot-resize{position:absolute;right:7px;bottom:7px;width:15px;height:15px;padding:0;border:0;border-radius:4px;background:linear-gradient(135deg,transparent 0 42%,var(--dsw-alias-label-tertiary) 44% 51%,transparent 53% 62%,var(--dsw-alias-label-tertiary) 64% 71%,transparent 73%);cursor:nwse-resize;touch-action:none;opacity:.72;}",
	".dkan-bot-resize:hover,.dkan-bot-resize:focus-visible{opacity:1;outline:1px solid var(--dsw-alias-accent,#4d9fff);outline-offset:1px;}",
	// ===== 3D 场景（CSS 长方体拼装：世界层统一 3/4 视角——俯视 + 侧身面向镜头） =====
	".dkan-bot-scene{position:relative;width:calc(220px * var(--dkan-bot-scale,1));height:calc(132px * var(--dkan-bot-scale,1));perspective:calc(620px * var(--dkan-bot-scale,1));perspective-origin:55% 18%;--dk3-side:#7c8ba0;--dk3-side-hi:#a9b8ca;--dk3-side-dk:#4c5870;--dk3-screen:#0d1526;--dkan-code-a:#4ade80;--dkan-code-b:#60a5fa;--dkan-code-c:#fbbf24;}",
	".dk3-world{position:absolute;left:0;top:0;width:220px;height:132px;transform-style:preserve-3d;transform-origin:top left;transform:scale(var(--dkan-bot-scale,1)) rotateX(-15deg) rotateY(-30deg);}",
	".dk3-box{position:absolute;transform-style:preserve-3d;}",
	".dk3-face{position:absolute;left:50%;top:50%;display:block;background:var(--dk3-side);backface-visibility:hidden;border-radius:1px;}",
	// 金属件着色：顶面亮、底面暗，正/侧面中调（3D 光感）
	".dk3-metal .dk3-face{background:linear-gradient(180deg,#93a5ba,#71809a);}",
	".dk3-metal .dk3-face:nth-child(5){background:linear-gradient(180deg,var(--dk3-side-hi),#9dadc2);}",
	".dk3-metal .dk3-face:nth-child(6){background:var(--dk3-side-dk);}",
	// 书桌与桌腿
	".dk3-desk .dk3-face{background:linear-gradient(180deg,#9db0c6,#7f92aa);}",
	".dk3-desk .dk3-face:nth-child(5){background:#c3d2e2;}",
	// 显示器（薄盒 + 贴在前面的屏幕；组内扇形微转，整组后撤出桌沿）
	".dk3-mon3{position:absolute;transform-style:preserve-3d;}",
	".dk3-frame .dk3-face{background:#3a465b;}",
	".dk3-frame .dk3-face:nth-child(5){background:#55647d;}",
	".dk3-screen{position:absolute;left:50%;top:50%;background:var(--dk3-screen);border-radius:2px;overflow:hidden;transition:opacity .4s var(--ds-ease-in-out),box-shadow .4s var(--ds-ease-in-out);}",
	// 屏幕内容：代码块整体向上滚动（10 行=5 行×2 循环，滚半程无缝接回）+ 闪烁光标，速度随 --dkan-speed
	".dk3-code{position:absolute;left:0;top:0;right:0;display:block;animation:dk3-scroll calc(5s / var(--dkan-speed,1)) linear infinite;}",
	".dk3-code i{display:block;height:2px;border-radius:1px;margin:2px 3px 0;background:var(--dkan-code-b);opacity:.55;}",
	".dk3-code i:nth-child(5n+1){width:58%;background:var(--dkan-code-a);}",
	".dk3-code i:nth-child(5n+2){width:82%;}",
	".dk3-code i:nth-child(5n+3){width:46%;background:var(--dkan-code-c);}",
	".dk3-code i:nth-child(5n+4){width:72%;}",
	".dk3-code i:nth-child(5n){width:54%;background:var(--dkan-code-a);}",
	".dk3-cur{position:absolute;left:3px;bottom:2px;width:4px;height:2px;background:var(--dkan-code-b);animation:dkan-blink3 1s steps(1) infinite;}",
	"@keyframes dk3-scroll{to{transform:translateY(-50%)}}",
	// 人物组（坐在桌子中间近镜头侧 z=30，侧身面朝 +X 三屏；不会被桌体遮挡）
	".dk3-person{position:absolute;left:96px;top:14px;width:44px;height:64px;transform-style:preserve-3d;transform:translateZ(30px);}",
	// 动漫人物配色：皮肤/头发/卫衣/裤子
	".dk3-skin .dk3-face{background:linear-gradient(180deg,#ffd9b8,#f3b98d);}",
	".dk3-skin .dk3-face:nth-child(5){background:#ffe3c9;}",
	".dk3-hair .dk3-face{background:linear-gradient(180deg,#5b4632,#3f3021);}",
	".dk3-hair .dk3-face:nth-child(5){background:#6b543c;}",
	".dk3-hood .dk3-face{background:linear-gradient(180deg,#7c8ba0,#5b6a80);}",
	".dk3-hood .dk3-face:nth-child(5){background:#93a5ba;}",
	".dk3-pants .dk3-face{background:linear-gradient(180deg,#3d4a5c,#2c3646);}",
	".dk3-pants .dk3-face:nth-child(5){background:#4a5a70;}",
	// 人物细节：圆角 + 鞋 + 咖啡杯 + 嘴
	".dk3-headbox .dk3-face{border-radius:3px;}",
	".dk3-torso .dk3-face{border-radius:3px;}",
	".dk3-hair .dk3-face{border-radius:2px;}",
	".dk3-shoe .dk3-face{background:#20262f;border-radius:2px;}",
	".dk3-mug .dk3-face{background:#c2703d;border-radius:1px;}",
	".dk3-mug .dk3-face:nth-child(5){background:#e08a52;}",
	".dk3-mouth{position:absolute;left:50%;top:78%;width:5px;height:1.5px;border-radius:1px;background:#b5766a;}",
	// 椅子
	".dk3-chairback .dk3-face{background:linear-gradient(180deg,#3f4c60,#2c3648);}",
	".dk3-chairseat .dk3-face{background:#33415a;}",
	// 头组（俯仰=rotateZ，左右看=rotateY）；眼睛贴在 +X 面板上
	".dk3-head3{position:absolute;left:14px;top:2px;width:17px;height:20px;transform-style:preserve-3d;transform-origin:50% 85%;transition:transform .25s var(--ds-ease-in-out);}",
	".dk3-brows{position:absolute;left:50%;top:30%;display:flex;gap:3px;align-items:center;justify-content:center;}",
	".dk3-brows i{width:3px;height:1px;border-radius:2px;background:#4a3428;}",
	".dk3-eyes{position:absolute;left:50%;top:52%;display:flex;gap:3px;align-items:center;justify-content:center;}",
	".dk3-eyes i{width:3px;height:4px;border-radius:50%;background:radial-gradient(circle at 60% 35%,#fff 0 .5px,#2b3442 .8px);animation:dkan-blink3 4.6s infinite;}",
	".dk3-nose{position:absolute;left:50%;top:64%;width:2px;height:2px;border-radius:50%;background:#d99277;}",
	".dk3-ear{position:absolute;left:-1px;top:11px;width:3px;height:5px;border-radius:50%;background:#f3b98d;transform:translateZ(2px);}",
	"@keyframes dkan-blink3{0%,91%,100%{transform:scaleY(1)}94%{transform:scaleY(.15)}}",
	// 手臂：肩组挂躯干前上，肘组在其下端（前臂+手伸向键盘）；write/code 时肘部高频敲击
	".dk3-arm3{position:absolute;left:20px;top:30px;width:16px;height:16px;transform-style:preserve-3d;}",
	".dk3-elbow{position:absolute;left:0;top:10px;width:15px;height:5px;transform-style:preserve-3d;transform-origin:2px 2px;}",
	".dk3-far{transform:translateZ(-8px);filter:brightness(.62);}",
	// 思考泡泡（贴镜头 2D 层，think 阶段显示）
	".dkan-bubble{position:absolute;left:80px;top:4px;display:none;gap:3px;padding:4px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 6px rgb(0 0 0 / .15);z-index:3;}",
	".dkan-bubble i{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:dkan-bubdot 1.2s ease-in-out infinite;}",
	".dkan-bubble i:nth-child(2){animation-delay:.2s;}",
	".dkan-bubble i:nth-child(3){animation-delay:.4s;}",
	"@keyframes dkan-bubdot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}",
	// ===== 阶段驱动（data-phase 四态，host 由 chunk 流实时同步） =====
	// think：屏幕调暗 + 仰头苦想 + 泡泡浮现
	".dkan-bot-scene[data-phase=think] .dk3-screen{opacity:.32;}",
	".dkan-bot-scene[data-phase=think] .dkan-bubble{display:inline-flex;}",
	".dkan-bot-scene[data-phase=think] .dk3-head3{animation:dkan-think-head 1.8s ease-in-out infinite alternate;}",
	".dkan-bot-scene[data-phase=think] .dk3-arm3:not(.dk3-far){animation:dkan-think-arm 1.8s ease-in-out infinite alternate;}",
	".dkan-bot-scene[data-phase=think] .dk3-arm3.dk3-far{animation:dkan-think-arm-far 1.8s ease-in-out infinite alternate;}",
	"@keyframes dkan-think-head{from{transform:rotateZ(-12deg) translateY(-1px)}to{transform:rotateZ(-22deg) translate(3px,-4px)}}",
	"@keyframes dkan-think-arm{from{transform:rotateZ(-4deg)}to{transform:rotateZ(-34deg) translate(1px,-8px)}}",
	"@keyframes dkan-think-arm-far{from{transform:translateZ(-8px) rotateZ(-2deg)}to{transform:translateZ(-8px) rotateZ(-24deg) translate(1px,-7px)}}",
	// write/code：中屏高亮代码滚动 + 肘部高频敲击 + 低头专注
	".dkan-bot-scene[data-phase=write] .dk3-mon3.center .dk3-screen,.dkan-bot-scene[data-phase=code] .dk3-mon3.center .dk3-screen{opacity:1;box-shadow:0 0 10px color-mix(in srgb,var(--dkan-code-b,#60a5fa) 45%,transparent);}",
	".dkan-bot-scene[data-phase=write] .dk3-mon3.center .dk3-code,.dkan-bot-scene[data-phase=code] .dk3-mon3.center .dk3-code{animation-duration:calc(2.2s / var(--dkan-speed,1));}",
	".dkan-bot-scene[data-phase=write] .dk3-arm3:not(.dk3-far),.dkan-bot-scene[data-phase=code] .dk3-arm3:not(.dk3-far){animation:dkan-output-arm calc(.46s / var(--dkan-speed,1)) ease-in-out infinite alternate;}",
	".dkan-bot-scene[data-phase=write] .dk3-arm3.dk3-far,.dkan-bot-scene[data-phase=code] .dk3-arm3.dk3-far{animation:dkan-output-arm-far calc(.46s / var(--dkan-speed,1)) ease-in-out infinite alternate;}",
	".dkan-bot-scene[data-phase=write] .dk3-elbow,.dkan-bot-scene[data-phase=code] .dk3-elbow{animation:dkan-type3 calc(.22s / var(--dkan-speed,1)) ease-in-out infinite alternate;}",
	".dkan-bot-scene[data-phase=write] .dk3-arm3.dk3-far .dk3-elbow,.dkan-bot-scene[data-phase=code] .dk3-arm3.dk3-far .dk3-elbow{animation-delay:.11s;}",
	"@keyframes dkan-type3{from{transform:rotate(12deg) translateY(-1px)}to{transform:rotate(-14deg) translateY(2px)}}",
	"@keyframes dkan-output-arm{from{transform:rotateZ(7deg) translateY(0)}to{transform:rotateZ(-13deg) translateY(4px)}}",
	"@keyframes dkan-output-arm-far{from{transform:translateZ(-8px) rotateZ(5deg)}to{transform:translateZ(-8px) rotateZ(-11deg) translateY(4px)}}",
	".dkan-bot-scene[data-phase=write] .dk3-head3,.dkan-bot-scene[data-phase=code] .dk3-head3{animation:dkan-output-head calc(.8s / var(--dkan-speed,1)) ease-in-out infinite alternate;}",
	"@keyframes dkan-output-head{from{transform:rotateZ(4deg) translateY(0)}to{transform:rotateZ(10deg) translate(2px,2px)}}",
	// search：侧屏高亮 + 滚动加速 + 头部左右扫视（一会忙这个一会看那个）
	".dkan-bot-scene[data-phase=search] .dk3-mon3.left .dk3-screen,.dkan-bot-scene[data-phase=search] .dk3-mon3.right .dk3-screen{opacity:1;box-shadow:0 0 8px color-mix(in srgb,var(--dkan-code-a,#4ade80) 40%,transparent);}",
	".dkan-bot-scene[data-phase=search] .dk3-mon3.left .dk3-code,.dkan-bot-scene[data-phase=search] .dk3-mon3.right .dk3-code{animation-duration:calc(1.6s / var(--dkan-speed,1));}",
	".dkan-bot-scene[data-phase=search] .dk3-head3{animation:dkan-scan3 3.4s ease-in-out infinite;}",
	"@keyframes dkan-scan3{0%,16%{transform:rotateZ(3deg) rotateY(-38deg)}30%,48%{transform:rotateZ(3deg) rotateY(6deg)}62%,80%{transform:rotateZ(3deg) rotateY(38deg)}100%{transform:rotateZ(3deg) rotateY(-38deg)}}",
	"@media (prefers-reduced-motion:reduce){.dkan-botcard *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;}}",
	// 通知子选项行
	".dkan-rows-narrow{display:flex;flex-direction:column;gap:6px;}",
	".dkan-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}",
	".dkan-row-label{flex:none;min-width:60px;color:var(--dsw-alias-label-primary);}",
	".dkan-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkm-miniswitch{cursor:pointer;flex:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 12px;font-family:inherit;font-size:11px;line-height:18px;}",
	".dkm-miniswitch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
		".dkan-select{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 8px;font-size:12px;font-family:inherit;}",
	// 音效选择卡（名称 + 播放键；选中态描边）
	".dkan-sounds{display:flex;gap:6px;flex-wrap:wrap;}",
	".dkan-sound{flex:1;min-width:104px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-family:inherit;transition:border-color .15s var(--ds-ease-in-out);}",
	".dkan-sound:hover{border-color:var(--dsw-alias-accent,#4d9fff);}",
	".dkan-sound.on{border-color:var(--dsw-alias-accent,#4d9fff);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-accent,#4d9fff) 40%,transparent);}",
	".dkan-sound-name{font-size:12px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:5px;}",
	".dkan-sound-cur{color:var(--dsw-alias-accent,#4d9fff);font-size:11px;}",
	".dkan-sound-play{flex:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);}",
	".dkan-sound-play:hover{color:var(--dsw-alias-label-primary);border-color:currentColor;}",
	".dkan-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;}",
	".dkan-input:focus{outline:none;border-color:var(--dsw-alias-accent,#4d9fff);}",
	".dkan-row-webhook{flex-wrap:nowrap;}",
	".dkan-row-webhook .dkan-input{min-width:0;}",
	".dkan-btn{cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 12px;font-family:inherit;font-size:12px;}",
	".dkan-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	".dkan-btn[disabled]{opacity:.5;cursor:default;}",
	".dkan-ok{color:var(--dsw-alias-state-success-primary);}",
	// 任务列表
	".dkan-tasks{display:flex;flex-direction:column;gap:6px;}",
	".dkan-tasks-done{border-top:1px dashed var(--dsw-alias-border-l2);padding-top:6px;}",
	".dkan-task{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;display:flex;flex-direction:column;gap:3px;}",
	".dkan-task-head{display:flex;align-items:center;gap:8px;min-width:0;}",
	".dkan-task-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkan-task-meta{display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkan-task-err{font-size:11px;color:var(--dsw-alias-state-error-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dkan-tag{flex:none;font-size:10px;border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--dsw-alias-border-l2);}",
	".dkan-tag.on{color:var(--dsw-alias-accent,#4d9fff);border-color:currentColor;}",
	".dkan-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	".dkan-tag.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
	".dkan-tag.warn{color:var(--dsw-alias-state-warning-primary);border-color:currentColor;}",
].join("\n");

export const feature = {
	id: "animation",
	name: "任务动画",
	order: 130,
	accent: "#f472b6",
	description: "任务运行动画（流光细线/呼吸光点/轨道光环）与完成通知，两组开关独立、配置持久化",
	css,
	View: AnimationView,
	HomeStat: AnimationStat,
	Overlay: AnimationOverlay,
};
