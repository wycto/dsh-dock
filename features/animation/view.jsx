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
	{ id: "breathe", name: "呼吸光点", desc: "醒目呼吸光点带扩散光晕：颜色随任务阶段（思考蓝/输出绿/代码橙/查资料青），呼吸随吞吐加快" },
	{ id: "ring", name: "轨道光环", desc: "细环绕圆点旋转，转速随任务速度" },
	{ id: "orbit", name: "环屏巡航", desc: "一颗光点沿屏幕边缘巡航整圈，醒目不遮挡" },
	{ id: "robot", name: "桌面伙伴", desc: "真人化双工位：查资料看左屏、写入/改代码移到右屏；座椅和转头随实时任务节奏加速" },
	{ id: "matrix", name: "代码雨", desc: "字符沿屏幕缓落如数据流，速度随任务吞吐，克制的低透明度" },
	{ id: "stars", name: "星野", desc: "细碎星点缓慢飘移闪烁，安静耐看的背景氛围" },
	{ id: "aurora", name: "极光", desc: "屏幕顶部柔光带缓慢呼吸流动，像极光拂过" },
	{ id: "space", name: "星际远征", desc: "任务中星球与飞船巡航；完成后货运旗舰携实际输出量停靠输入框" },
	{ id: "nebula", name: "星云潮汐", desc: "四团彩色星云在屏幕边缘缓慢潮汐，阶段色随任务改变" },
	{ id: "warp", name: "曲速航道", desc: "光束从屏幕中心向外拉伸，吞吐越高曲速越快" },
	{ id: "radar", name: "量子雷达", desc: "三座边缘雷达持续扫描，任务活动化作跳动信标" },
	{ id: "constellation", name: "星座网络", desc: "节点与连线逐段点亮，像任务知识图谱在生长" },
	{ id: "fireflies", name: "数据萤火", desc: "轻盈光点在空白区游弋，活跃阶段会更明亮" },
	{ id: "ocean", name: "深海脉动", desc: "低透明度波层与气泡缓慢上浮，安静但富有生命感" },
	{ id: "prism", name: "棱镜光谱", desc: "彩色光束从屏幕边缘折射穿行，形成克制的玻璃光感" },
	{ id: "circuit", name: "神经电路", desc: "电路路径依次通电，脉冲速度跟随代码与工具活动" },
	{ id: "gravity", name: "引力涟漪", desc: "多个引力源向外扩散波纹，任务越快涟漪越紧密" },
	{ id: "lantern", name: "灵感天灯", desc: "微型灵感灯从屏幕底部缓慢升起，留下温暖光迹" },
];

const AMBIENT_EFFECT_MODES = new Set(["matrix", "stars", "aurora", "space", "nebula", "warp", "radar", "constellation", "fireflies", "ocean", "prism", "circuit", "gravity", "lantern"]);

// 任务阶段 → 机器人行为/文案（host 按 chunk/事件实时推导：
// reasoning-delta=think、text-delta=write、tool 名分类=search/code）
const PHASE_LABELS = { think: "思考中", write: "输出中", code: "编写代码", search: "查资料" };
function phaseLabel(p) { return PHASE_LABELS[p] || "工作中"; }
// 阶段配色（徽标呼吸点/光环随任务阶段变色，--dkan-phase 下发到 CSS）
const PHASE_COLORS = { think: "#2f6fed", write: "#0d9488", code: "#b45309", search: "#0e7490" };
function phaseColor(p) { return PHASE_COLORS[p] || "#2f6fed"; }

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
	const searchScreen = props.mode === "search";
	// 屏幕内容：10 行代码（5 行×2 循环）+ 光标，整体向上滚动（速度随 --dkan-speed）
	const lines = [1, 2, 3, 4, 5, 1, 2, 3, 4, 5];
	return (
		<span className={"dk3-mon3 " + (props.cls || "")}
			style={{ left: props.x - w / 2, top: props.y - h / 2, width: w, height: h, transform: "translateZ(" + (props.z || -3) + "px) rotateY(" + (props.ry || 0) + "deg)" }}>
			<Box3 w={w} h={h} d={5} cls="dk3-frame" x={w / 2} y={h / 2} />
			<span className="dk3-screen" style={{ width: w - 4, height: h - 4, transform: "translate(-50%,-50%) translateZ(3.1px)" }}>
				{searchScreen ? <span className="dk3-search-ui">
					<span className="dk3-search-box"><b /></span>
					<span className="dk3-search-results">{lines.slice(0, 6).map((n, i) => <i key={i} />)}</span>
				</span> : <span className="dk3-code">
					{lines.map((n, i) => <i key={i} />)}
					<span className="dk3-cur" />
				</span>}
			</span>
		</span>
	);
}

// 3D 动漫人物：更拟人的比例与细节（圆角头/ volumetric 头发/五官/脖颈/弯肘/腿脚鞋）。
// 紧凑双工位：左侧专做资料检索，右侧专做写作/改文件；顶部小屏放任务状态。
// 人物坐滚轮椅在两侧工位间滑动，思考时停在两屏之间。
function RobotScene(props) {
	const phase = props && props.phase ? props.phase : "code";
	const tasks = Array.isArray(props && props.tasks) ? props.tasks : null;
	const n = tasks ? Math.max(1, Math.min(3, tasks.length)) : 1;
	// 左工位只做资料检索；正文输出和工具写入都在右工位，思考回到中位。
	const station = phase === "search" ? "left" : (phase === "write" || phase === "code" ? "right" : "center");
	return (
		<div className="dkan-bot-scene" data-phase={phase} data-station={station} data-tasks={tasks ? String(n) : undefined} aria-hidden="true">
			<div className="dk3-world">
				{/* 紧凑单人书桌：只留左右两个真实工作位，消除左侧空桌面。 */}
				<Box3 w={134} h={7} d={38} cls="dk3-desk" x={145} y={76} />
				<Box3 w={5} h={24} d={30} cls="dk3-metal dk3-leg" x={84} y={89} />
				<Box3 w={5} h={24} d={30} cls="dk3-metal dk3-leg" x={206} y={89} />
				{/* 左检索、右编码，顶部小屏显示任务进度。 */}
				<Monitor3 w={34} h={24} x={140} y={59} ry={20} cls="left" mode="search" />
				<Monitor3 w={42} h={30} x={180} y={57} ry={-16} cls="right" />
				<Monitor3 w={28} h={18} x={160} y={31} ry={0} cls="top" />
				{/* 两套键鼠紧贴相应屏幕，中央仅保留咖啡杯。 */}
				<Box3 w={16} h={2.5} d={9} cls="dk3-metal dk3-kb3" x={130} y={71} z={14} />
				<Box3 w={4} h={2.5} d={6} cls="dk3-metal dk3-mouse3" x={141} y={71} z={14} />
				<Box3 w={4} h={5} d={4} cls="dk3-mug" x={154} y={69} z={14} />
				<Box3 w={16} h={2.5} d={9} cls="dk3-metal dk3-kb3" x={170} y={71} z={14} />
				<Box3 w={4} h={2.5} d={6} cls="dk3-metal dk3-mouse3" x={181} y={71} z={14} />
				{/* 人物组：按当前任务在左检索/中思考/右编码两个工位间平滑移动。 */}
				<div className="dk3-person">
					{/* 椅子：靠背只到肩胛、降低支柱和底盘，贴近真实坐姿。 */}
					<Box3 w={4} h={20} d={20} cls="dk3-chairback" x={2} y={47} />
					<Box3 w={18} h={4} d={20} cls="dk3-chairseat" x={12} y={59} />
					<Box3 w={3} h={9} d={3} cls="dk3-metal" x={12} y={66} />
					<Box3 w={13} h={2} d={13} cls="dk3-metal" x={12} y={71} />
					{/* 椅子滚轮（左右各一，滑动时可见） */}
					<Box3 w={3} h={3} d={3} cls="dk3-wheel" x={6} y={74} />
					<Box3 w={3} h={3} d={3} cls="dk3-wheel" x={18} y={74} />
					{/* 腿：大腿/小腿/鞋 */}
					<Box3 w={12} h={5} d={9} cls="dk3-pants" x={20} y={54} />
					<Box3 w={4} h={10} d={4} cls="dk3-pants" x={26} y={62} />
					<Box3 w={6} h={3} d={5} cls="dk3-shoe" x={28} y={70} />
					{/* 上身整体始终面向桌面；阶段动作只改变前倾、肩肘腕和视线。 */}
					<div className="dk3-upper3">
						{/* 肩线、胸腔和腰部做成上宽下窄，摆脱直筒积木感。 */}
						<Box3 w={18} h={5} d={12} cls="dk3-hood dk3-shoulders3" x={13} y={30} />
						<Box3 w={15} h={14} d={11} cls="dk3-hood dk3-torso dk3-chest3" x={12} y={38} />
						<Box3 w={12} h={7} d={10} cls="dk3-hood dk3-torso dk3-waist3" x={12} y={47} />
						<Box3 w={5} h={8} d={9} cls="dk3-hood dk3-hoodbump" x={5} y={32} />
						{/* 颈部加长并与下颌、衣领重叠，避免悬空。 */}
						<Box3 w={5} h={7} d={5} cls="dk3-skin dk3-neck3" x={14} y={24} />
						<Box3 w={8} h={3} d={8} cls="dk3-collar3" x={14} y={28} />
						{/* 头组与颈部同轴：颅骨 + 收窄下颌 + 短侧渐层发型。 */}
						<div className="dk3-head3">
							<Box3 w={12} h={11} d={11} cls="dk3-skin dk3-cranium" x={8} y={8}>
								<span className="dk3-brows" style={{ width: 9, height: 4, transform: "translate(-50%,-50%) rotateY(90deg) translateZ(5.8px)" }}><i /><i /></span>
								<span className="dk3-eyes" style={{ width: 9, height: 6, transform: "translate(-50%,-50%) rotateY(90deg) translateZ(5.7px)" }}><i /><i /></span>
								<span className="dk3-nose" style={{ transform: "translate(-50%,-50%) rotateY(90deg) translateZ(6.1px)" }} />
							</Box3>
							<Box3 w={9} h={7} d={9} cls="dk3-skin dk3-jaw3" x={8.5} y={14}>
								<span className="dk3-mouth" style={{ transform: "translate(-50%,-50%) rotateY(90deg) translateZ(4.7px)" }} />
							</Box3>
							<Box3 w={12} h={5} d={12} cls="dk3-hair dk3-hair-crown" x={8} y={3.5} />
							<Box3 w={4} h={8} d={11} cls="dk3-hair dk3-hair-back" x={3} y={7.5} />
							<span className="dk3-fringe3"><i /><i /><i /></span>
							<span className="dk3-ear" />
						</div>
						{/* 近侧手臂：肩、肘、腕、手指分段动作。 */}
						<div className="dk3-arm3 dk3-near">
							<Box3 w={4} h={11} d={4} cls="dk3-hood dk3-uarm" x={2} y={6} />
							<div className="dk3-elbow">
								<Box3 w={10} h={3.5} d={3.5} cls="dk3-hood dk3-farm" x={5.5} y={2} />
								<div className="dk3-wrist3">
									<Box3 w={3.5} h={3} d={3} cls="dk3-skin dk3-hand" x={2} y={2} />
									<span className="dk3-fingers3"><i /><i /></span>
								</div>
							</div>
						</div>
						{/* 远侧手臂：在桌面深处，和近侧手错开节奏。 */}
						<div className="dk3-arm3 dk3-far">
							<Box3 w={4} h={11} d={4} cls="dk3-hood dk3-uarm" x={2} y={6} />
							<div className="dk3-elbow">
								<Box3 w={10} h={3.5} d={3.5} cls="dk3-hood dk3-farm" x={5.5} y={2} />
								<div className="dk3-wrist3">
									<Box3 w={3.5} h={3} d={3} cls="dk3-skin dk3-hand" x={2} y={2} />
									<span className="dk3-fingers3"><i /><i /></span>
								</div>
							</div>
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
		? "var(--dk-ok)"
		: t.kind === "error"
			? "var(--dk-err)"
			: "var(--dk-warn)";
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
	// 一个模式只创建自己需要的粒子；星际模式不再额外生成代码雨和星野的 114 个无用节点。
	const particles = useMemo(() => {
		if (mode === "matrix") return { matrix: makeBits(34, () => ({
			l: Math.random() * 100, d: 4 + Math.random() * 6, delay: -Math.random() * 8, o: 0.28 + Math.random() * 0.34, s: 11 + Math.round(Math.random() * 4),
			c: MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] + MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)] + MATRIX_CHARS[Math.floor(Math.random() * MATRIX_CHARS.length)],
		})) };
		if (mode === "stars") return { stars: makeBits(80, () => ({
			l: Math.random() * 100, t: Math.random() * 100, sz: 1.5 + Math.random() * 2, d: 2 + Math.random() * 4, delay: -Math.random() * 6, dx: (Math.random() - 0.5) * 40, dy: (Math.random() - 0.5) * 24,
		})) };
		if (mode === "space") return { dust: makeBits(22, () => ({
			l: Math.random() * 100, t: Math.random() * 82, sz: 1 + Math.random() * 2.2, d: 2.4 + Math.random() * 3.8, delay: -Math.random() * 6,
		})) };
		if (mode === "warp") return { warp: makeBits(28, () => ({
			a: Math.random() * 360, len: 54 + Math.random() * 130, d: 1.8 + Math.random() * 2.4, delay: -Math.random() * 4,
		})) };
		if (mode === "fireflies") return { fireflies: makeBits(28, () => ({
			l: 4 + Math.random() * 92, t: 8 + Math.random() * 78, sz: 3 + Math.random() * 5, dx: -42 + Math.random() * 84, dy: -32 + Math.random() * 64, d: 4.8 + Math.random() * 5.4, delay: -Math.random() * 8,
		})) };
		if (mode === "ocean") return { bubbles: makeBits(18, () => ({
			l: 3 + Math.random() * 94, sz: 4 + Math.random() * 12, d: 5 + Math.random() * 6, delay: -Math.random() * 9, drift: -34 + Math.random() * 68,
		})) };
		if (mode === "lantern") return { lanterns: makeBits(18, () => ({
			l: 4 + Math.random() * 92, sz: 8 + Math.random() * 9, d: 7 + Math.random() * 7, delay: -Math.random() * 12, drift: -48 + Math.random() * 96,
		})) };
		return {};
	}, [mode]);
	const ambientStyle = { "--dkan-speed": speed, "--dkan-phase": phaseColor(props.phase) };
	if (mode === "matrix") {
		return (
			<div className="dkan-amb dkan-matrix" style={{ "--dkan-speed": speed }} aria-hidden="true">
				{particles.matrix.map((p, i) => (
					<span key={i} style={{ left: p.l + "%", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s", opacity: p.o, fontSize: p.s }}>{p.c}</span>
				))}
			</div>
		);
	}
	if (mode === "stars") {
		return (
			<div className="dkan-amb dkan-stars" style={{ "--dkan-speed": speed }} aria-hidden="true">
				{particles.stars.map((p, i) => (
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
	if (mode === "nebula") {
		return <div className="dkan-amb dkan-nebula" style={ambientStyle} aria-hidden="true"><i /><i /><i /><i /></div>;
	}
	if (mode === "warp") {
		return <div className="dkan-amb dkan-warp" style={ambientStyle} aria-hidden="true">
			{particles.warp.map((p, i) => <i key={i} style={{ "--a": p.a + "deg", "--len": p.len + "px", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s" }} />)}
		</div>;
	}
	if (mode === "radar") {
		return <div className="dkan-amb dkan-radar" style={ambientStyle} aria-hidden="true">
			{["a", "b", "c"].map((id) => <span className={"dkan-radar-station " + id} key={id}><i /><b /></span>)}
		</div>;
	}
	if (mode === "constellation") {
		return <div className="dkan-amb dkan-constellation" style={ambientStyle} aria-hidden="true">
			<svg viewBox="0 0 100 100" preserveAspectRatio="none">
				<path pathLength="1" d="M6 68 L18 30 L31 48 L45 18 L58 42 L73 25 L91 58 L78 78 L58 42 L31 48 L18 76 L6 68" />
				{[[6,68],[18,30],[31,48],[45,18],[58,42],[73,25],[91,58],[78,78],[18,76]].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 1.1 : .7} style={{ animationDelay: (-i * .24) + "s" }} />)}
			</svg>
		</div>;
	}
	if (mode === "fireflies") {
		return <div className="dkan-amb dkan-fireflies" style={ambientStyle} aria-hidden="true">
			{particles.fireflies.map((p, i) => <i key={i} style={{ left: p.l + "%", top: p.t + "%", width: p.sz, height: p.sz, "--dx": p.dx + "px", "--dy": p.dy + "px", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s" }} />)}
		</div>;
	}
	if (mode === "ocean") {
		return <div className="dkan-amb dkan-ocean" style={ambientStyle} aria-hidden="true">
			<span className="dkan-ocean-waves">{Array.from({ length: 5 }, (_, i) => <i key={i} />)}</span>
			{particles.bubbles.map((p, i) => <b key={i} style={{ left: p.l + "%", width: p.sz, height: p.sz, "--drift": p.drift + "px", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s" }} />)}
		</div>;
	}
	if (mode === "prism") {
		return <div className="dkan-amb dkan-prism" style={ambientStyle} aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</div>;
	}
	if (mode === "circuit") {
		return <div className="dkan-amb dkan-circuit" style={ambientStyle} aria-hidden="true">
			<svg viewBox="0 0 1000 600" preserveAspectRatio="none">
				{["M0 92 H180 V210 H390 V128 H610 V260 H820 V104 H1000", "M0 486 H144 V358 H334 V470 H520 V338 H748 V448 H1000", "M82 0 V126 H264 V286 H472 V196 H694 V320 H914 V600", "M936 0 V148 H776 V278 H566 V410 H350 V548 H112 V600"].map((d, i) => <path key={i} pathLength="1" d={d} style={{ animationDelay: (-i * .7) + "s" }} />)}
				{[[180,210],[390,128],[610,260],[144,358],[520,338],[264,286],[694,320],[566,410]].map(([cx, cy], i) => <circle key={i} cx={cx} cy={cy} r="5" />)}
			</svg>
		</div>;
	}
	if (mode === "gravity") {
		return <div className="dkan-amb dkan-gravity" style={ambientStyle} aria-hidden="true">
			{["a", "b", "c"].map((id) => <span className={"dkan-gravity-source " + id} key={id}><b />{Array.from({ length: 4 }, (_, i) => <i key={i} style={{ animationDelay: "calc(" + (-i * .9) + "s / var(--dkan-speed,1))" }} />)}</span>)}
		</div>;
	}
	if (mode === "lantern") {
		return <div className="dkan-amb dkan-lantern" style={ambientStyle} aria-hidden="true">
			{particles.lanterns.map((p, i) => <i key={i} style={{ left: p.l + "%", width: p.sz, height: p.sz * 1.28, "--drift": p.drift + "px", animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s" }} />)}
		</div>;
	}
	if (mode === "space") {
		const taskCount = Math.max(1, Math.min(3, Array.isArray(props.tasks) ? props.tasks.length : 1));
		// 任务期间每条航线至少有两艘巡航船，三座星系之间始终有可见往返；并发任务越多，舰队越密。
		// 所有飞船仍只使用 transform/opacity 合成动画，速度跟随任务活动速率。
		const runnerCount = Math.max(6, Math.min(9, taskCount * 3));
		const galaxies = props.galaxies;
		if (!galaxies) return null;
		return (
			<div className="dkan-amb dkan-space" style={{
				"--dkan-speed": speed, "--dkan-space-ships": taskCount,
				"--dkan-alpha-x": galaxies.alpha.cx + "px", "--dkan-alpha-y": galaxies.alpha.cy + "px",
				"--dkan-beta-x": galaxies.beta.cx + "px", "--dkan-beta-y": galaxies.beta.cy + "px",
				"--dkan-gamma-x": galaxies.gamma.cx + "px", "--dkan-gamma-y": galaxies.gamma.cy + "px",
			}} aria-hidden="true">
				{particles.dust.map((p, i) => <i key={i} className="dkan-space-dust" style={{ left: p.l + "%", top: p.t + "%", width: p.sz, height: p.sz, animationDuration: "calc(" + p.d + "s / var(--dkan-speed,1))", animationDelay: p.delay + "s" }} />)}
				{["alpha", "beta", "gamma"].map((galaxy) => <span className={"dkan-space-system " + galaxy} key={galaxy} style={{ left: galaxies[galaxy].x, top: galaxies[galaxy].y, "--dkan-system-scale": galaxies[galaxy].scale }}>
					<i className="dkan-space-sun" />
					<span className="dkan-space-orbit a"><i /></span>
					<span className="dkan-space-orbit b"><i /></span>
					<span className="dkan-space-orbit c"><i /></span>
				</span>)}
				{Array.from({ length: runnerCount }, (_, i) => <span className={"dkan-space-runner route-" + (i % 3)} key={i} style={{ "--dkan-run-delay": (-i * 1.8) + "s" }}><FreighterHull units={1} empty /></span>)}
			</div>
		);
	}
	return null;
}

// ---------- 完成货运舰：从任务航线归航到会话输入框上方，货舱量使用真实输出 Token ----------
function outputCargo(outputTokens) {
	const tokens = Math.max(0, Number(outputTokens) || 0);
	// 每个可见货舱约代表 900 输出 Token；保留 1 个基础舱，防止无 usage 时舰体塌陷。
	return { tokens, units: Math.max(1, Math.min(8, Math.ceil(tokens / 900))) };
}
function fallbackComposerDockPoint(side = "right") {
	const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
	const vh = typeof window === "undefined" ? 900 : window.innerHeight;
	return {
		// 待命位贴近输入框右上；右侧远端只保留给旧的通用停靠计算。
		x: side === "left" ? Math.max(304, Math.min(520, Math.round(vw * .18)))
			: side === "ready" ? Math.max(316, vw - 640)
				: Math.max(16, vw - 232),
		y: Math.max(32, vh - 218),
	};
}
function visibleRect(el) {
	if (!el || typeof window === "undefined") return null;
	const r = el.getBoundingClientRect();
	return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight ? r : null;
}
const COMPOSER_SEND_SELECTOR = 'button[aria-label="Send message"],button[aria-label*="发送"],button[data-testid*="send"],button[data-testid*="submit"],button[type="submit"]';
function conversationComposer() {
	if (typeof document === "undefined" || typeof window === "undefined") return null;
	// 发送键只会位于真实会话输入卡内。由它逐层向上找卡片，比遍历历史消息的编辑节点可靠。
	const sendButtons = document.querySelectorAll(COMPOSER_SEND_SELECTOR);
	for (const button of sendButtons) {
		let el = button.parentElement;
		for (let depth = 0; el && depth < 9; depth += 1, el = el.parentElement) {
			const r = visibleRect(el);
			if (r && r.width >= 360 && r.height >= 72 && r.height <= 360 && r.top > window.innerHeight * .42) return { element: el, rect: r };
		}
	}
	return null;
}
function conversationComposerRect() {
	const composer = conversationComposer();
	return composer ? composer.rect : null;
}
function composerPointFromRect(composer, side) {
	return {
		x: side === "ready" ? Math.max(composer.left + 16, composer.right - 210) : fallbackComposerDockPoint(side).x,
		y: Math.max(22, composer.top - 92),
	};
}
function composerDockPoint(side = "right") {
	if (typeof document === "undefined" || typeof window === "undefined") return fallbackComposerDockPoint(side);
	const composer = conversationComposerRect();
	if (composer) return composerPointFromRect(composer, side);
	const selectors = [
		'[data-testid*="composer"]', '[data-testid*="conversation-input"]', '[data-slot*="conversation.input"]',
		'textarea[placeholder*="Message"]', 'textarea[placeholder*="消息"]', 'textarea',
		'[contenteditable="true"][data-testid*="composer"]', '[contenteditable="true"][aria-label*="消息"]', '[contenteditable="true"][data-slot*="conversation.input"]',
	];
	const seen = new Set();
	const candidates = [];
	for (const selector of selectors) {
		for (const el of document.querySelectorAll(selector)) {
			if (seen.has(el)) continue;
			seen.add(el);
			const r = el.getBoundingClientRect();
			if (r.width > 80 && r.height > 16 && r.bottom > window.innerHeight * .48) candidates.push({ el, r });
		}
	}
	const best = candidates.sort((a, b) => b.r.bottom - a.r.bottom)[0];
	if (!best) return fallbackComposerDockPoint(side);
	const r = best.r;
	// 候补输入节点没有卡片边界时，仅待命位贴近其右侧；其他位置仍由视口锚点决定。
	const x = side === "ready" ? Math.max(r.left + 16, r.right - 210) : fallbackComposerDockPoint(side).x;
	return {
		// 纵向以真实输入控件上沿停靠，飞船底部和输入框保留间隙。
		x,
		y: Math.max(22, r.top - 92),
	};
}
// 刷新时先让会话本身完成首帧绘制，再在空闲期读取输入框布局。
// 避免星际模式恢复时 querySelectorAll + getBoundingClientRect 抢占主线程。
function useSpaceDocks(enabled) {
	const [docks, setDocks] = useState(null);
	useEffect(() => {
		if (!enabled || typeof window === "undefined") { setDocks(null); return undefined; }
		let disposed = false;
		let frame = 0;
		let idle = 0;
		let timer = 0;
		let pollTimer = 0;
		let retries = 0;
		let pending = false;
		let observedComposer = null;
		let resizeObserver = null;
		const samePoint = (a, b) => !!a && !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
		const bindComposerResize = (element) => {
			if (!resizeObserver || observedComposer === element) return;
			if (observedComposer) resizeObserver.unobserve(observedComposer);
			observedComposer = element;
			if (observedComposer) resizeObserver.observe(observedComposer);
		};
		const measure = () => {
			if (disposed) return;
			const found = conversationComposer();
			// 历史会话切换时输入卡可能比浮层更晚挂载；没有真实卡片就不显示，绝不猜到正文中。
			if (!found) {
				bindComposerResize(null);
				setDocks(null);
				if (retries++ < 20) schedule(140);
				return;
			}
			retries = 0;
			bindComposerResize(found.element);
			const composer = found.rect;
			const right = composerPointFromRect(composer, "right");
			// 三个停泊位共用同一输入框上沿，避免重复扫描整个页面读取布局。
			const next = {
				right,
				left: composerPointFromRect(composer, "left"),
				ready: composerPointFromRect(composer, "ready"),
			};
			setDocks((current) => current && samePoint(current.right, next.right) && samePoint(current.left, next.left) && samePoint(current.ready, next.ready) ? current : next);
		};
		function schedule(delay = 0, deferUntilIdle = false) {
			if (disposed || pending) return;
			pending = true;
			const queueFrame = () => {
				frame = window.requestAnimationFrame(() => {
					pending = false;
					measure();
				});
			};
			if (delay > 0) timer = window.setTimeout(queueFrame, delay);
			else if (deferUntilIdle && typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(queueFrame, { timeout: 350 });
			else queueFrame();
		};
		if (typeof window.ResizeObserver === "function") resizeObserver = new window.ResizeObserver(() => schedule());
		// 会话是 SPA 切换：输入框节点会被整体替换，但 effect 本身不会重新挂载。仅在包含发送键的子树增删时重测。
		const mutationObserver = typeof window.MutationObserver === "function" ? new window.MutationObserver((mutations) => {
			const hasComposerChange = mutations.some((mutation) => Array.from(mutation.addedNodes).concat(Array.from(mutation.removedNodes)).some((node) => {
				if (!node || node.nodeType !== 1) return false;
				return (node.matches && node.matches(COMPOSER_SEND_SELECTOR)) || (node.querySelector && node.querySelector(COMPOSER_SEND_SELECTOR));
			}));
			if (hasComposerChange) schedule(40);
		}) : null;
		if (mutationObserver && document.body) mutationObserver.observe(document.body, { childList: true, subtree: true });
		schedule(0, true);
		// 部分会话会复用同一输入框节点、只改变祖先布局；低频校准覆盖这种无 DOM 替换的位移。
		pollTimer = window.setInterval(() => schedule(), 700);
		const onResize = () => {
			if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
			if (timer) window.clearTimeout(timer);
			pending = false;
			schedule();
		};
		window.addEventListener("resize", onResize, { passive: true });
		return () => {
			disposed = true;
			window.cancelAnimationFrame(frame);
			if (idle && typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(idle);
			if (timer) window.clearTimeout(timer);
			if (pollTimer) window.clearInterval(pollTimer);
			if (mutationObserver) mutationObserver.disconnect();
			if (resizeObserver) resizeObserver.disconnect();
			window.removeEventListener("resize", onResize);
		};
	}, [enabled]);
	return docks;
}
// 三个星系分处内容区右上、左上、左下，路线有足够的飞行距离且避开侧栏和输入框。
// 返回中心点还会被巡航线路和归航飞船共用，避免“从空气里飞回来”。
function spaceGalaxyLayout() {
	const vw = typeof window === "undefined" ? 1280 : window.innerWidth;
	const vh = typeof window === "undefined" ? 900 : window.innerHeight;
	const contentLeft = 316;
	const make = (x, y, scale) => ({ x, y, scale, cx: x + 123, cy: y + 123 });
	return {
		alpha: make(Math.max(contentLeft + 420, vw - 360), 72, .50),
		beta: make(contentLeft, Math.max(142, Math.min(232, vh * .18)), .48),
		gamma: make(contentLeft + 18, Math.max(420, vh - 382), .48),
	};
}
function freighterAnchorAt(point) {
	// 飞船外框为 210×88，飞船主体中心约在 (88, 32)，对齐到星系中心而不是左上角。
	return { x: Math.round(point.x - 88), y: Math.round(point.y - 32) };
}
function flightAngle(from, to) {
	return Math.round(Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI);
}
function FreighterHull(props) {
	const units = Math.max(1, Number(props.units) || 1);
	return <span className="dkan-freighter">
		<i className="dkan-freighter-engine"><i /><i /></i>
		<i className="dkan-freighter-wing left" /><i className="dkan-freighter-wing right" /><i className="dkan-freighter-fin" />
		<i className="dkan-freighter-hull" /><i className="dkan-freighter-canopy" /><i className="dkan-freighter-nose" />
		<span className={"dkan-freighter-cargo" + (props.empty ? " empty" : "")}>{Array.from({ length: units }, (_, i) => <i key={i} />)}</span>
	</span>;
}
function DeliveryFreighter(props) {
	const d = props.delivery;
	return (
		<div className="dkan-delivery" style={{
			"--dkan-from-x": d.from.x + "px", "--dkan-from-y": d.from.y + "px",
			"--dkan-to-x": d.to.x + "px", "--dkan-to-y": d.to.y + "px",
			"--dkan-delivery-duration": d.duration + "ms",
		}} aria-hidden="true">
			<span className="dkan-delivery-trail" />
			<FreighterHull units={d.units} />
			<span className="dkan-delivery-label"><b>归航货运舰</b><span>输出 {fmtCompact(d.tokens)} Tokens · {d.units} 舱</span></span>
		</div>
	);
}
function ReadyFreighter(props) {
	const dock = props.dock || fallbackComposerDockPoint("ready");
	return <div className="dkan-ready-freighter" style={{ left: dock.x, top: dock.y }} aria-hidden="true"><FreighterHull units={3} empty /><span>待命 · 等待下一条任务</span></div>;
}
function MissionDeparture(props) {
	const d = props.departure;
	return <div className="dkan-departure" style={{
		"--dkan-from-x": d.from.x + "px", "--dkan-from-y": d.from.y + "px",
		"--dkan-to-x": d.to.x + "px", "--dkan-to-y": d.to.y + "px",
		"--dkan-flight-angle": d.angle + "deg", "--dkan-departure-duration": d.duration + "ms",
	}} aria-hidden="true"><FreighterHull units={3} empty /></div>;
}
function ProgrammingStuck(props) {
	return <div className="dkan-space-stuck" aria-hidden="true"><FreighterHull units={3} empty /><span className="dkan-stuck-code"><i />{`{ }`}</span><strong>编程等待中</strong><small>{truncate((props.task && props.task.title) || "工具暂无新响应", 28)}</small></div>;
}

// ---------- 全局浮层：轮询 + 动效 + 通知（功能启用即常驻） ----------
export function AnimationOverlay(props) {
	const ctx = props && props.ctx;
	const snap = useAnimation();
	const [toasts, setToasts] = useState([]);
	const [flourish, setFlourish] = useState(null); // { key, err } 完成瞬间的一次性流光
	const [bursts, setBursts] = useState([]); // 交互反馈动画队列
	const [deliveries, setDeliveries] = useState([]); // 星际模式完成时停泊在输入框上方的归航货运舰
	const [departures, setDepartures] = useState([]); // 从输入框起飞的出航舰
	const prevActiveRef = useRef(null);
	const burstIdRef = useRef(0);
	const deliveryIdRef = useRef(0);
	const departureTimersRef = useRef(new Map());
	const lastImmediateDepartureRef = useRef(0);

	useEffect(() => () => {
		for (const timer of departureTimersRef.current.values()) clearTimeout(timer);
		departureTimersRef.current.clear();
	}, []);

	// 触发一个交互反馈动画（自动清理）
	const pushBurst = useCallback((type, x, y, bits) => {
		const id = ++burstIdRef.current;
		setBursts((prev) => prev.concat([{ id, type, x, y, bits }]).slice(-6));
		setTimeout(() => setBursts((prev) => prev.filter((b) => b.id !== id)), 2600);
	}, []);
	// 发送即出发：从左侧归航位先缓慢滑行，再逐段加速，最终并入右上角星系。
	const launchMission = useCallback(() => {
		const cfg = animationStore.snap.status && animationStore.snap.status.config;
		if (!cfg || !cfg.animationEnabled || cfg.effectMode !== "space") return false;
		const id = ++deliveryIdRef.current;
		const from = composerDockPoint("left");
		const targetGalaxy = spaceGalaxyLayout().alpha;
		const to = freighterAnchorAt({ x: targetGalaxy.cx, y: targetGalaxy.cy });
		const departure = {
			id, from, to,
			angle: flightAngle(from, to),
			duration: 8600,
		};
		lastImmediateDepartureRef.current = Date.now();
		setDeliveries([]); // 满载归港舰重新出航前离开停泊位
		setDepartures((prev) => prev.concat([departure]).slice(-3));
		departureTimersRef.current.set(id, setTimeout(() => {
			departureTimersRef.current.delete(id);
			setDepartures((prev) => prev.filter((item) => item.id !== id));
		}, departure.duration));
		return true;
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
				launchMission();
			} else if (newSession) {
				pushBurst("spark", e.clientX, e.clientY, makeBits(10, () => ({
					dx: (Math.random() - 0.5) * 70, dy: (Math.random() - 0.5) * 70,
					c: ["#2563eb", "#0d9488", "#b45309", "#be185d"][Math.floor(Math.random() * 4)],
				})));
			} else if (workspace) {
				pushBurst("flash");
			} else if (sessionItem) {
				pushBurst("streak");
			}
		};
		document.addEventListener("click", onClick, true);
		return () => document.removeEventListener("click", onClick, true);
	}, [pushBurst, launchMission]);

	// 任务状态变化：没有直接发送事件时，仍由状态变化兜底从左侧起飞。
	const taskCountRef = useRef(0);
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const n = st.active.length;
		if (n > taskCountRef.current) {
			pushBurst("surge");
			const cfg = st.config || {};
			if (cfg.animationEnabled && cfg.effectMode === "space" && Date.now() - lastImmediateDepartureRef.current > 10000) launchMission();
		}
		taskCountRef.current = n;
	}, [snap.status, pushBurst, launchMission]);

	// 轮询：任务中 850ms，实时捕捉 chunk/工具活动；空闲 6s / 出错 15s；页面切回立即刷新。
	useEffect(() => {
		let stopped = false;
		let timer = null;
		const loop = async () => {
			await animationStore.refresh();
			if (stopped) return;
			const s = animationStore.snap;
			timer = setTimeout(loop, s.error ? 15000 : (s.status && s.status.active && s.status.active.length > 0 ? 850 : 6000));
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
			// 星际远征把完成结果送回用户正在输入的位置。速度继承最后一帧任务节奏；
			// 货舱数量及标签只取 Host 已记录的真实 outputTokens。
			if (cfg.effectMode === "space") {
				const cargo = outputCargo((record && record.outputTokens) || task.outputTokens);
				const id = ++deliveryIdRef.current;
				const taskSpeed = Math.max(.9, Number(speed) || 1);
				const duration = Math.round(Math.max(8000, Math.min(9400, 10000 / Math.sqrt(taskSpeed))));
				// 从三个星系中随机挑选归航起点，任务完成时才能知道本次货舰从哪里回来。
				const galaxies = spaceGalaxyLayout();
				const returnGalaxy = galaxies[["alpha", "beta", "gamma"][Math.floor(Math.random() * 3)]];
				const from = freighterAnchorAt({ x: returnGalaxy.cx, y: returnGalaxy.cy });
				const to = composerDockPoint("left");
				// 满载舰最终停入左侧归航位，和右上出发星系形成清晰的往返方向。
				const delivery = Object.assign({ id, from, to, duration }, cargo);
				setDeliveries([delivery]);
			}
			if (success) {
				pushBurst("confetti", 0, 0, makeBits(18, (i) => ({
					l: 4 + (i / 18) * 92 + Math.random() * 3,
					dx: (Math.random() - 0.5) * 60,
					r: Math.random() * 720 - 360,
					d: Math.random() * 0.35,
					c: ["#2563eb", "#0d9488", "#b45309", "#be185d", "#7c3aed"][i % 5],
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
	// 机器人阶段：取最近发生阶段变化的活跃任务。
	const phase = active.length > 0
		? active.reduce((best, x) => (!best || (x.phaseAt || 0) > (best.phaseAt || 0) ? x : best), null).phase
		: "think";
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
	// 任务速度：优先使用 host 从 chunk/tool 实时累积的活动脉冲；
	// token usage 只在完整消息后才到达，不能再作为唯一速度来源。
	const [speed, setSpeed] = useState(1);
	const speedRef = useRef({ ticks: -1, at: 0 });
	useEffect(() => {
		if (!st || active.length === 0) { speedRef.current = { ticks: -1, at: 0 }; setSpeed(1); return; }
		const ticks = active.reduce((a, x) => a + (x.motionTicks || 0), 0);
		const t = Date.now();
		const prev = speedRef.current;
		if (prev.ticks < 0 || t - prev.at < 300) { speedRef.current = { ticks, at: t }; return; }
		const rate = Math.max(0, (ticks - prev.ticks) / ((t - prev.at) / 1000));
		const phaseBoost = phase === "write" || phase === "code" ? .28 : (phase === "search" ? .18 : 0);
		const next = Math.max(.9, Math.min(4, Number((.9 + rate / 14 + phaseBoost).toFixed(2))));
		setSpeed((current) => Math.abs(current - next) < .03 ? current : next);
		speedRef.current = { ticks, at: t };
	}, [snap.status]);
	const ambientOn = animOn && !panelOpen;
	const spaceModeOn = !!(cfg && cfg.animationEnabled && mode === "space" && !panelOpen);
	const spaceDocks = useSpaceDocks(spaceModeOn);
	const spaceGalaxies = spaceModeOn && spaceDocks ? spaceGalaxyLayout() : null;
	// Host 在编程阶段持续 18 秒没有 chunk/tool 活动，才把它视为卡住；正常长任务不会误触发。
	const stuckTask = active.find((task) => task.phase === "code" && now - (task.lastActivityAt || task.phaseAt || now) >= 18000) || null;
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
		{/* 氛围动效（代码雨/星野/极光/星际远征，任务进行中渲染，速度随吞吐） */}
		{ambientOn && AMBIENT_EFFECT_MODES.has(mode) && (mode !== "space" || spaceGalaxies)
			? <AmbientLayer mode={mode} phase={phase} speed={Number(speed).toFixed(2)} tasks={active} galaxies={spaceGalaxies} /> : null}
		{/* 星际模式：空闲时在输入框上方待命；任务卡住时在中央呈现编程等待状态。 */}
		{spaceModeOn && spaceDocks && active.length === 0 && deliveries.length === 0 ? <ReadyFreighter dock={spaceDocks.ready} /> : null}
		{spaceModeOn && stuckTask ? <ProgrammingStuck task={stuckTask} /> : null}
		{!panelOpen ? departures.map((departure) => <MissionDeparture key={departure.id} departure={departure} />) : null}
		{/* 环屏巡航：一颗光点沿屏幕边缘转圈（orbit 模式） */}
		{ambientOn && mode === "orbit" ? <div className="dkan-orbit" style={speedStyle} aria-hidden="true" /> : null}
		{/* 交互反馈层：纸飞机/火花/流光/微光/光涌/彩带（与动画开关独立，只要功能启用即回应操作） */}
		<BurstLayer bursts={bursts} />
		{/* 桌面伙伴：背侧视角紧凑双工位人物，阶段与任务同步；整卡可拖到任意位置（robot 模式） */}
		{ambientOn && mode === "robot" ? (
			<div className="dkan-botcard" role="button" tabIndex={0} style={botCardStyle}
				title={active.length + " 个任务 · " + phaseLabel(phase) + " · 点击查看任务动画页 · 可拖动到任意位置"}
				onPointerDown={onBotPointerDown}
				onPointerMove={onBotPointerMove}
				onPointerUp={onBotPointerUp}
				onPointerCancel={onBotPointerUp}
				onClick={onBotClick}
				onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onBotClick(); } }}>
				<RobotScene phase={phase} tasks={active} />
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
		{/* 右下角状态徽标：dot 随模式变化（breathe/ring 装饰），颜色随任务阶段、呼吸随吞吐；点击进功能坞动画页 */}
		{ambientOn && mode !== "robot" ? (
			<button type="button" className={"dkan-badge" + (mode === "breathe" ? " dkan-badge-breathe" : "")}
				style={Object.assign({}, speedStyle, { "--dkan-phase": phaseColor(phase) })}
				title={active.length + " 个任务进行中 · " + phaseLabel(phase) + " · 点击查看任务动画页"}
				onClick={() => openPanel("animation")}>
				<span className="dkan-dotwrap">
					<span className="dkan-dot" />
					{mode === "breathe" ? <span className="dkan-halo" /> : null}
					{mode === "ring" ? <span className="dkan-ring" /> : null}
				</span>
				<span className="dkan-badge-txt"><span className="n">{active.length}</span> 个任务{elapsed ? " · " + elapsed : ""} · {phaseLabel(phase)}</span>
			</button>
		) : null}
		{/* 完成瞬间的一次性流光（成功绿 / 异常红），动画结束自动清场 */}
		{flourish ? (
			<div key={flourish.key} className={"dkan-done" + (flourish.err ? " err" : "")}
				onAnimationEnd={() => setFlourish(null)} aria-hidden="true" />
		) : null}
		{/* 星际任务完成：货运舰沿航线飞到输入框上方并保持停泊，直到下一次任务出航。 */}
		{!panelOpen ? deliveries.map((delivery) => <DeliveryFreighter key={delivery.id} delivery={delivery} />) : null}
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
	if (id === "space") {
		return <span className="dkan-prev dkan-prev-space"><i /><b /><em /></span>;
	}
	if (id === "aurora") {
		return (
			<span className="dkan-prev dkan-prev-aurora">
				<i /><i />
			</span>
		);
	}
	if (["nebula", "warp", "radar", "constellation", "fireflies", "ocean", "prism", "circuit", "gravity", "lantern"].includes(id)) {
		return <span className={"dkan-prev dkan-prev-new dkan-prev-" + id}>{Array.from({ length: id === "warp" ? 8 : 6 }, (_, i) => <i key={i} />)}</span>;
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
			<span className="dkan-dotwrap dkan-breathe"><span className="dkan-dot" /><span className="dkan-halo" /></span>
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
	".dkan-line{position:fixed;top:0;left:0;right:0;height:3px;z-index:9990;pointer-events:none;background:color-mix(in srgb,var(--dk-accent) 30%,transparent);}",
	".dkan-line::after{content:\"\";position:absolute;top:0;bottom:0;left:-42%;width:42%;background:linear-gradient(90deg,transparent,var(--dk-accent) 60%,#fff);box-shadow:0 0 10px 1px color-mix(in srgb,var(--dk-accent) 70%,transparent);animation:dkan-flow calc(1.9s / var(--dkan-speed,1)) linear infinite;}",
	"@keyframes dkan-flow{to{left:100%}}",
	// 完成瞬间的一次性流光（成功绿 / 异常红），动画结束自动清场
	".dkan-done{position:fixed;top:0;left:0;right:0;height:3px;z-index:9991;pointer-events:none;background:linear-gradient(90deg,transparent,var(--dsw-alias-state-success-primary,#34d399) 50%,#fff);background-size:50% 100%;background-repeat:no-repeat;animation:dkan-done 1.1s var(--ds-ease-in-out) forwards;}",
	".dkan-done.err{background-image:linear-gradient(90deg,transparent,var(--dsw-alias-state-error-primary,#f87171) 50%,#fff);}",
	"@keyframes dkan-done{0%{background-position:-60% 0;opacity:0}25%{opacity:1}100%{background-position:160% 0;opacity:0}}",
	// 环屏巡航：光点沿屏幕边缘转一整圈
	".dkan-orbit{position:fixed;top:0;left:0;width:12px;height:12px;z-index:9990;pointer-events:none;border-radius:50%;background:var(--dk-accent);box-shadow:0 0 14px 4px color-mix(in srgb,var(--dk-accent) 60%,transparent),0 0 30px 8px color-mix(in srgb,var(--dk-accent) 25%,transparent);animation:dkan-orbit calc(14s / var(--dkan-speed,1)) linear infinite;}",
	"@keyframes dkan-orbit{0%{top:0;left:0}25%{top:0;left:calc(100vw - 12px)}50%{top:calc(100vh - 12px);left:calc(100vw - 12px)}75%{top:calc(100vh - 12px);left:0}100%{top:0;left:0}}",
	// ===== 氛围动效 =====
	".dkan-amb{position:fixed;inset:0;z-index:9989;pointer-events:none;overflow:hidden;}",
	// pointer-events 不继承：全屏装饰层的子粒子（星点/流星/极光/火花/彩带）必须各自透明于点击
	".dkan-amb *,.dkan-fxwrap *{pointer-events:none;}",
	// 代码雨：字符列缓落（提亮加大，速度随吞吐）
	".dkan-matrix span{position:absolute;top:-12%;writing-mode:vertical-rl;font-family:var(--ds-font-family-code,monospace);color:var(--dk-accent);text-shadow:0 0 6px color-mix(in srgb,var(--dk-accent) 60%,transparent);animation:dkan-fall linear infinite;will-change:transform;}",
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
	// 星际远征：星尘、行星轨道和任务飞船都只在任务运行时出现，统一由 --dkan-speed 加速。
	".dkan-space{background:radial-gradient(ellipse 34% 28% at 84% 11%,color-mix(in srgb,#426aaf 15%,transparent),transparent 72%),radial-gradient(ellipse 26% 22% at 14% 58%,color-mix(in srgb,#7c4dff 10%,transparent),transparent 74%);}",
	".dkan-space-dust{position:absolute;border-radius:50%;background:#dbeafe;box-shadow:0 0 5px color-mix(in srgb,#93c5fd 62%,transparent);opacity:.2;animation:dkan-space-dust ease-in-out infinite alternate;will-change:transform,opacity;}",
	"@keyframes dkan-space-dust{0%{opacity:.14;transform:translate3d(0,0,0) scale(.7)}55%{opacity:.78}100%{opacity:.26;transform:translate3d(22px,-8px,0) scale(1.15)}}",
	".dkan-space-system{position:fixed;width:246px;height:246px;border-radius:50%;opacity:.78;transform:translateZ(0) scale(var(--dkan-system-scale,1));transform-origin:center;contain:layout paint style;}.dkan-space-system.alpha{opacity:.76}.dkan-space-system.beta{opacity:.68}.dkan-space-system.gamma{opacity:.64}",
	".dkan-space-sun{position:absolute;left:50%;top:50%;width:34px;height:34px;border-radius:50%;transform:translate(-50%,-50%);background:radial-gradient(circle at 32% 28%,#fff7c2 0 9%,#ffc85a 30%,#e76f2e 74%);box-shadow:0 0 12px 4px color-mix(in srgb,#ffc85a 58%,transparent),0 0 36px 12px color-mix(in srgb,#f97316 20%,transparent);}",
	".dkan-space-orbit{position:absolute;left:50%;top:50%;border:1px solid color-mix(in srgb,#93c5fd 28%,transparent);border-radius:50%;animation:dkan-space-orbit linear infinite;transform-origin:center;}",
	".dkan-space-orbit i{position:absolute;top:50%;left:-5px;width:10px;height:10px;border-radius:50%;transform:translateY(-50%);box-shadow:0 0 9px 2px currentColor;}",
	".dkan-space-orbit.a{width:82px;height:50px;margin:-25px 0 0 -41px;animation-duration:calc(5.4s / var(--dkan-speed,1));}.dkan-space-orbit.a i{color:#67e8f9;background:#22d3ee;}",
	".dkan-space-orbit.b{width:142px;height:86px;margin:-43px 0 0 -71px;animation-duration:calc(9.2s / var(--dkan-speed,1));animation-direction:reverse;}.dkan-space-orbit.b i{width:15px;height:15px;color:#c4b5fd;background:radial-gradient(circle at 30% 28%,#ede9fe,#8b5cf6 72%);}",
	".dkan-space-orbit.c{width:212px;height:130px;margin:-65px 0 0 -106px;animation-duration:calc(15.6s / var(--dkan-speed,1));}.dkan-space-orbit.c i{width:18px;height:18px;color:#fda4af;background:radial-gradient(circle at 32% 28%,#ffe4e6,#e11d48 74%);}",
	"@keyframes dkan-space-orbit{to{transform:rotate(360deg)}}",
	".dkan-space-runner{position:fixed;left:0;top:0;width:108px;height:56px;opacity:0;animation-duration:calc(10.8s / var(--dkan-speed,1));animation-timing-function:linear;animation-iteration-count:infinite;animation-delay:var(--dkan-run-delay,0s);will-change:transform,opacity;contain:layout paint style;backface-visibility:hidden;}.dkan-space-runner .dkan-freighter{left:0;top:0;transform:translateZ(0) scale(.52);transform-origin:top left;filter:none}.dkan-space-runner .dkan-freighter-engine i{animation:none;opacity:.76;box-shadow:-6px 0 8px #22d3ee}.dkan-space-runner .dkan-freighter-nose{filter:none}.dkan-space-runner.route-0{animation-name:dkan-space-route-a}.dkan-space-runner.route-1{animation-name:dkan-space-route-b}.dkan-space-runner.route-2{animation-name:dkan-space-route-c}",
	"@keyframes dkan-space-route-a{0%{opacity:0;transform:translate3d(var(--dkan-alpha-x),var(--dkan-alpha-y),0) rotate(151deg)}7%,86%{opacity:.9}100%{opacity:0;transform:translate3d(var(--dkan-beta-x),var(--dkan-beta-y),0) rotate(151deg)}}@keyframes dkan-space-route-b{0%{opacity:0;transform:translate3d(var(--dkan-beta-x),var(--dkan-beta-y),0) rotate(-90deg)}7%,86%{opacity:.9}100%{opacity:0;transform:translate3d(var(--dkan-gamma-x),var(--dkan-gamma-y),0) rotate(-90deg)}}@keyframes dkan-space-route-c{0%{opacity:0;transform:translate3d(var(--dkan-gamma-x),var(--dkan-gamma-y),0) rotate(-18deg)}7%,86%{opacity:.9}100%{opacity:0;transform:translate3d(var(--dkan-alpha-x),var(--dkan-alpha-y),0) rotate(-18deg)}}",
	// 完成归航：一艘货运旗舰从航线飞到真实会话输入框上方，货舱逐格表达实际输出量。
	".dkan-delivery{position:fixed;left:0;top:0;width:210px;height:88px;z-index:9994;pointer-events:none;will-change:transform,opacity;contain:layout paint style;isolation:isolate;animation:dkan-delivery-flight var(--dkan-delivery-duration,8600ms) cubic-bezier(.22,.61,.36,1) forwards;}",
	"@keyframes dkan-delivery-flight{0%{opacity:0;transform:translate3d(var(--dkan-from-x),var(--dkan-from-y),0) scale(.5) rotate(-12deg)}6%{opacity:1;transform:translate3d(var(--dkan-from-x),var(--dkan-from-y),0) scale(.56) rotate(-10deg)}100%{opacity:1;transform:translate3d(var(--dkan-to-x),var(--dkan-to-y),0) scale(1) rotate(0)}}",
	".dkan-delivery-trail{position:absolute;left:-132px;top:26px;width:154px;height:4px;border-radius:999px;background:linear-gradient(90deg,transparent,#34d399 48%,#d9f99d 78%,transparent);opacity:.9;animation:dkan-delivery-trail var(--dkan-delivery-duration,8600ms) linear forwards;}@keyframes dkan-delivery-trail{0%,82%{opacity:.9}100%{opacity:0}}.dkan-freighter{position:absolute;left:10px;top:10px;width:176px;height:45px;display:block;filter:drop-shadow(0 0 9px color-mix(in srgb,#7dd3fc 62%,transparent));}.dkan-delivery .dkan-freighter,.dkan-departure .dkan-freighter{filter:none}.dkan-delivery .dkan-freighter-engine i,.dkan-departure .dkan-freighter-engine i{animation:none;opacity:.76;box-shadow:-6px 0 8px #22d3ee}.dkan-delivery .dkan-freighter-nose,.dkan-departure .dkan-freighter-nose{filter:none}.dkan-freighter-hull{position:absolute;z-index:3;left:21px;top:7px;width:126px;height:31px;background:linear-gradient(150deg,#f8fbff 0%,#9cc8ff 30%,#385d91 72%,#1d3150);clip-path:polygon(0 30%,43% 0,83% 17%,100% 50%,83% 83%,43% 100%,0 70%,12% 50%);box-shadow:inset 0 1px 0 rgb(255 255 255 / .7),inset -7px -5px 9px rgb(8 24 49 / .38);}.dkan-freighter-nose{position:absolute;z-index:4;right:10px;top:16px;width:28px;height:14px;background:linear-gradient(90deg,#a9d1ff,#e8f5ff);clip-path:polygon(0 0,100% 50%,0 100%,22% 50%);filter:drop-shadow(5px 0 5px color-mix(in srgb,#93c5fd 62%,transparent));}.dkan-freighter-canopy{position:absolute;z-index:5;left:77px;top:10px;width:39px;height:11px;border-radius:70% 48% 42% 32%;background:linear-gradient(135deg,#ecfeff 0%,#67e8f9 32%,#2563eb 75%);transform:skewX(-18deg);box-shadow:inset 0 2px 2px rgb(255 255 255 / .7),0 0 8px color-mix(in srgb,#67e8f9 42%,transparent);}.dkan-freighter-fin{position:absolute;z-index:2;left:48px;top:3px;width:24px;height:17px;background:linear-gradient(135deg,#31557f,#a7caf7);clip-path:polygon(0 100%,58% 0,100% 100%);}.dkan-freighter-wing{position:absolute;z-index:1;left:48px;width:60px;height:18px;background:linear-gradient(135deg,#24436d,#8ebaf4);}.dkan-freighter-wing.left{top:2px;clip-path:polygon(0 100%,100% 0,68% 100%)}.dkan-freighter-wing.right{top:26px;clip-path:polygon(0 0,68% 0,100% 100%)}",
	".dkan-freighter-cargo{position:absolute;z-index:6;left:37px;top:31px;width:74px;height:7px;display:flex;align-items:center;gap:2px;padding:1px 3px;border-radius:4px;background:#172842;border:1px solid color-mix(in srgb,#b8d8ff 48%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / .2);}.dkan-freighter-cargo i{display:block;flex:1;min-width:4px;height:5px;border-radius:1px;background:linear-gradient(135deg,#fef3c7,#f59e0b 58%,#b45309);box-shadow:0 0 4px color-mix(in srgb,#fbbf24 58%,transparent);}.dkan-freighter-cargo.empty i{background:linear-gradient(135deg,#dbeafe,#38bdf8 58%,#1d4ed8);box-shadow:0 0 4px color-mix(in srgb,#38bdf8 55%,transparent);}.dkan-freighter-engine{position:absolute;z-index:0;left:5px;top:19px;display:flex;gap:3px;align-items:center;height:11px;}.dkan-freighter-engine i{width:18px;height:5px;border-radius:60% 0 0 60%;background:linear-gradient(90deg,transparent,#67e8f9);box-shadow:-9px 0 12px #22d3ee;animation:dkan-engine .34s ease-in-out infinite alternate;}.dkan-freighter-engine i:nth-child(2){animation-delay:-.14s}",
	"@keyframes dkan-engine{to{transform:scaleX(.55);opacity:.5}}",
	".dkan-delivery-label{position:absolute;left:21px;top:58px;display:flex;align-items:baseline;gap:6px;padding:4px 8px;border:1px solid color-mix(in srgb,#93c5fd 30%,var(--dsw-alias-border-l1));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);backdrop-filter:blur(10px);color:var(--dsw-alias-label-secondary);font:10px/1.2 var(--ds-font-family,system-ui,sans-serif);white-space:nowrap;}.dkan-delivery-label b{color:var(--dsw-alias-label-primary);font-weight:650}.dkan-delivery-label span{color:var(--dk-accent);}",
	"@media (max-width:1100px){.dkan-space-system,.dkan-space-runner{display:none}}",
	".dkan-ready-freighter{position:fixed;width:210px;height:88px;z-index:9994;pointer-events:none;filter:drop-shadow(0 10px 14px rgb(0 0 0 / .18));}.dkan-ready-freighter>span:last-child{position:absolute;left:21px;top:58px;padding:4px 8px;border:1px solid color-mix(in srgb,#93c5fd 28%,var(--dsw-alias-border-l1));border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent);backdrop-filter:blur(10px);color:var(--dsw-alias-label-secondary);font:10px/1.2 var(--ds-font-family,system-ui,sans-serif);white-space:nowrap;}.dkan-departure{position:fixed;left:0;top:0;width:210px;height:88px;z-index:9994;pointer-events:none;will-change:transform,opacity;contain:layout paint style;isolation:isolate;animation:dkan-departure-flight var(--dkan-departure-duration,8600ms) cubic-bezier(.42,0,.85,.45) forwards;}@keyframes dkan-departure-flight{0%{opacity:0;transform:translate3d(var(--dkan-from-x),var(--dkan-from-y),0) scale(1) rotate(var(--dkan-flight-angle,0deg))}6%{opacity:1;transform:translate3d(var(--dkan-from-x),var(--dkan-from-y),0) scale(1) rotate(var(--dkan-flight-angle,0deg))}100%{opacity:0;transform:translate3d(var(--dkan-to-x),var(--dkan-to-y),0) scale(.24) rotate(var(--dkan-flight-angle,0deg))}}",
	".dkan-space-stuck{position:fixed;left:50%;top:50%;width:244px;height:160px;z-index:9993;pointer-events:none;transform:translate(-50%,-50%);border:1px solid color-mix(in srgb,#f59e0b 48%,var(--dsw-alias-border-l1));border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);backdrop-filter:blur(16px);box-shadow:0 18px 54px rgb(0 0 0 / .28),0 0 30px color-mix(in srgb,#f59e0b 15%,transparent);}.dkan-space-stuck .dkan-freighter{left:37px;top:11px;transform:scale(.9);transform-origin:top left;}.dkan-stuck-code{position:absolute;left:17px;right:17px;top:60px;height:36px;border-radius:7px;background:linear-gradient(90deg,color-mix(in srgb,#f59e0b 18%,transparent),transparent);color:var(--dk-warn);font:700 14px/36px var(--ds-font-family-code,monospace);letter-spacing:.12em;text-align:center;overflow:hidden;}.dkan-stuck-code::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,#fef3c7 70%,transparent),transparent);transform:translateX(-110%);animation:dkan-stuck-scan 1.25s linear infinite;}.dkan-stuck-code i{display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:#f59e0b;box-shadow:0 0 9px #f59e0b;animation:dkan-stuck-pulse .8s ease-in-out infinite alternate;}.dkan-space-stuck strong{position:absolute;left:0;right:0;top:108px;color:var(--dsw-alias-label-primary);font:650 13px/1.2 var(--ds-font-family,system-ui,sans-serif);text-align:center;}.dkan-space-stuck small{position:absolute;left:18px;right:18px;top:128px;color:var(--dsw-alias-label-secondary);font:11px/1.25 var(--ds-font-family,system-ui,sans-serif);text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}@keyframes dkan-stuck-scan{to{transform:translateX(110%)}}@keyframes dkan-stuck-pulse{to{transform:scale(.55);opacity:.45}}",
	// 极光：顶部柔光带呼吸流动（加浓）
	".dkan-aurora i{position:absolute;top:-40%;left:-20%;width:70%;height:80%;border-radius:50%;filter:blur(50px);opacity:.32;animation:dkan-aurora ease-in-out infinite alternate;}",
	".dkan-aurora i:nth-child(1){background:#4d9fff;}",
	".dkan-aurora i:nth-child(2){background:#34d399;left:20%;animation-delay:-2s;}",
	".dkan-aurora i:nth-child(3){background:#a78bfa;left:55%;animation-delay:-4s;}",
	"@keyframes dkan-aurora{0%{transform:translateX(-8%) scaleY(1)}100%{transform:translateX(10%) scaleY(1.3)}}",
	// 星云潮汐：无动态模糊，柔边由径向渐变生成，移动只发生在合成层。
	".dkan-nebula{contain:strict}.dkan-nebula i{position:absolute;width:48vw;aspect-ratio:1;border-radius:50%;opacity:.22;background:radial-gradient(circle,color-mix(in srgb,var(--dkan-phase,#60a5fa) 48%,transparent),color-mix(in srgb,#8b5cf6 18%,transparent) 42%,transparent 70%);animation:dkan-nebula-drift calc(18s / var(--dkan-speed,1)) cubic-bezier(.45,0,.55,1) infinite alternate;will-change:transform,opacity}.dkan-nebula i:nth-child(1){left:-18%;top:-24%}.dkan-nebula i:nth-child(2){right:-18%;top:4%;background:radial-gradient(circle,color-mix(in srgb,#22d3ee 34%,transparent),color-mix(in srgb,#3b82f6 15%,transparent) 45%,transparent 72%);animation-delay:-5s}.dkan-nebula i:nth-child(3){left:4%;bottom:-34%;background:radial-gradient(circle,color-mix(in srgb,#f472b6 28%,transparent),color-mix(in srgb,#8b5cf6 14%,transparent) 48%,transparent 72%);animation-delay:-10s}.dkan-nebula i:nth-child(4){right:8%;bottom:-26%;width:36vw;animation-delay:-14s}",
	"@keyframes dkan-nebula-drift{0%{opacity:.14;transform:translate3d(-3vw,-2vh,0) scale(.92)}100%{opacity:.3;transform:translate3d(5vw,4vh,0) scale(1.12)}}",
	// 曲速航道：从视口中心放射的独立光束。
	".dkan-warp{background:radial-gradient(circle at center,color-mix(in srgb,var(--dkan-phase,#60a5fa) 10%,transparent),transparent 34%);contain:strict}.dkan-warp i{position:absolute;left:50%;top:50%;width:var(--len);height:1px;border-radius:999px;transform-origin:left center;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dkan-phase,#60a5fa) 48%,transparent),#e0f2fe);opacity:0;animation-name:dkan-warp-ray;animation-timing-function:cubic-bezier(.3,.1,.8,1);animation-iteration-count:infinite;will-change:transform,opacity}",
	"@keyframes dkan-warp-ray{0%{opacity:0;transform:rotate(var(--a)) translate3d(18px,0,0) scaleX(.05)}18%{opacity:.6}100%{opacity:0;transform:rotate(var(--a)) translate3d(58vw,0,0) scaleX(1.55)}}",
	// 量子雷达：三个边缘站点各自扫描，避免占据会话正文中心。
	".dkan-radar{contain:strict}.dkan-radar-station{position:absolute;width:176px;height:176px;border-radius:50%;opacity:.44;background:repeating-radial-gradient(circle,color-mix(in srgb,var(--dkan-phase,#60a5fa) 28%,transparent) 0 1px,transparent 1px 29px);border:1px solid color-mix(in srgb,var(--dkan-phase,#60a5fa) 22%,transparent)}.dkan-radar-station.a{right:4%;top:8%}.dkan-radar-station.b{left:1%;top:38%;transform:scale(.72)}.dkan-radar-station.c{right:7%;bottom:9%;transform:scale(.58)}.dkan-radar-station i{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 76%,color-mix(in srgb,var(--dkan-phase,#60a5fa) 44%,transparent) 92%,transparent);animation:dkan-radar-sweep calc(4.8s / var(--dkan-speed,1)) linear infinite;will-change:transform}.dkan-radar-station b{position:absolute;left:67%;top:31%;width:7px;height:7px;border-radius:50%;background:var(--dkan-phase,#60a5fa);box-shadow:0 0 12px 4px color-mix(in srgb,var(--dkan-phase,#60a5fa) 58%,transparent);animation:dkan-radar-blip calc(2.4s / var(--dkan-speed,1)) ease-in-out infinite}",
	"@keyframes dkan-radar-sweep{to{transform:rotate(360deg)}}@keyframes dkan-radar-blip{0%,70%,100%{opacity:.15;transform:scale(.65)}78%{opacity:1;transform:scale(1.25)}}",
	// 星座网络：轻量 SVG 线网分段点亮。
	".dkan-constellation svg{position:absolute;left:8%;top:7%;width:86%;height:78%;overflow:visible}.dkan-constellation path{fill:none;stroke:color-mix(in srgb,var(--dkan-phase,#60a5fa) 42%,transparent);stroke-width:.16;vector-effect:non-scaling-stroke;stroke-dasharray:.08 .025;animation:dkan-constellation-line calc(7s / var(--dkan-speed,1)) linear infinite}.dkan-constellation circle{fill:var(--dkan-phase,#60a5fa);filter:drop-shadow(0 0 2px var(--dkan-phase,#60a5fa));animation:dkan-constellation-star calc(2.8s / var(--dkan-speed,1)) ease-in-out infinite alternate;transform-box:fill-box;transform-origin:center}",
	"@keyframes dkan-constellation-line{to{stroke-dashoffset:-1}}@keyframes dkan-constellation-star{0%{opacity:.28;transform:scale(.68)}100%{opacity:.92;transform:scale(1.22)}}",
	// 数据萤火：二维漂移和明暗呼吸组合在同一个 transform 动画中。
	".dkan-fireflies{contain:strict}.dkan-fireflies i{position:absolute;border-radius:50%;background:color-mix(in srgb,var(--dkan-phase,#60a5fa) 78%,#fff);box-shadow:0 0 8px 2px color-mix(in srgb,var(--dkan-phase,#60a5fa) 46%,transparent);opacity:.2;animation-name:dkan-firefly;animation-timing-function:cubic-bezier(.45,0,.55,1);animation-iteration-count:infinite;animation-direction:alternate;will-change:transform,opacity}",
	"@keyframes dkan-firefly{0%{opacity:.12;transform:translate3d(0,0,0) scale(.65)}48%{opacity:.86}100%{opacity:.26;transform:translate3d(var(--dx),var(--dy),0) scale(1.18)}}",
	// 深海脉动：波层在底部横向漂移，气泡只做向上合成位移。
	".dkan-ocean{background:linear-gradient(0deg,color-mix(in srgb,#0284c7 12%,transparent),transparent 46%);contain:strict}.dkan-ocean-waves{position:absolute;left:-12%;right:-12%;bottom:0;height:42%}.dkan-ocean-waves i{position:absolute;left:0;width:112%;height:52%;border-top:1px solid color-mix(in srgb,#67e8f9 28%,transparent);border-radius:50%;animation:dkan-ocean-wave calc(9s / var(--dkan-speed,1)) ease-in-out infinite alternate;will-change:transform}.dkan-ocean-waves i:nth-child(1){top:2%}.dkan-ocean-waves i:nth-child(2){top:18%;animation-delay:-2s}.dkan-ocean-waves i:nth-child(3){top:34%;animation-delay:-4s}.dkan-ocean-waves i:nth-child(4){top:50%;animation-delay:-6s}.dkan-ocean-waves i:nth-child(5){top:66%;animation-delay:-8s}.dkan-ocean>b{position:absolute;bottom:-20px;border:1px solid color-mix(in srgb,#a5f3fc 54%,transparent);border-radius:50%;opacity:0;animation-name:dkan-ocean-bubble;animation-timing-function:linear;animation-iteration-count:infinite;will-change:transform,opacity}",
	"@keyframes dkan-ocean-wave{to{transform:translate3d(7%,5px,0) scaleY(1.08)}}@keyframes dkan-ocean-bubble{0%{opacity:0;transform:translate3d(0,0,0) scale(.7)}14%{opacity:.58}100%{opacity:0;transform:translate3d(var(--drift),-82vh,0) scale(1.18)}}",
	// 棱镜光谱：七条低透明度光带错峰穿过视口。
	".dkan-prism{contain:strict}.dkan-prism i{position:absolute;left:-32vw;width:160vw;height:2px;border-radius:999px;opacity:0;background:linear-gradient(90deg,transparent,#ef4444,#f59e0b,#facc15,#22c55e,#22d3ee,#6366f1,#a855f7,transparent);animation:dkan-prism-ray calc(8s / var(--dkan-speed,1)) cubic-bezier(.45,0,.55,1) infinite;will-change:transform,opacity}.dkan-prism i:nth-child(1){top:12%;animation-delay:0s}.dkan-prism i:nth-child(2){top:25%;animation-delay:-1.1s}.dkan-prism i:nth-child(3){top:38%;animation-delay:-2.2s}.dkan-prism i:nth-child(4){top:51%;animation-delay:-3.3s}.dkan-prism i:nth-child(5){top:64%;animation-delay:-4.4s}.dkan-prism i:nth-child(6){top:77%;animation-delay:-5.5s}.dkan-prism i:nth-child(7){top:90%;animation-delay:-6.6s}",
	"@keyframes dkan-prism-ray{0%{opacity:0;transform:translate3d(-12vw,0,0) rotate(-7deg) scaleX(.7)}34%{opacity:.2}66%{opacity:.36}100%{opacity:0;transform:translate3d(20vw,0,0) rotate(-7deg) scaleX(1.05)}}",
	// 神经电路：少量 SVG 路径的虚线脉冲，节点保持低透明度。
	".dkan-circuit svg{position:absolute;inset:5% 3% 9% 8%;width:89%;height:86%;overflow:visible}.dkan-circuit path{fill:none;stroke:color-mix(in srgb,var(--dkan-phase,#60a5fa) 40%,transparent);stroke-width:1.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:.045 .12;animation:dkan-circuit-pulse calc(5.6s / var(--dkan-speed,1)) linear infinite}.dkan-circuit circle{fill:var(--dkan-phase,#60a5fa);opacity:.58;filter:drop-shadow(0 0 4px var(--dkan-phase,#60a5fa));animation:dkan-circuit-node calc(2.2s / var(--dkan-speed,1)) ease-in-out infinite alternate}",
	"@keyframes dkan-circuit-pulse{to{stroke-dashoffset:-1}}@keyframes dkan-circuit-node{to{opacity:.16}}",
	// 引力涟漪：三个边缘引力源按错峰节奏扩散。
	".dkan-gravity{contain:strict}.dkan-gravity-source{position:absolute;width:260px;height:260px}.dkan-gravity-source.a{right:2%;top:5%}.dkan-gravity-source.b{left:-4%;top:39%;transform:scale(.76)}.dkan-gravity-source.c{right:17%;bottom:-10%;transform:scale(.62)}.dkan-gravity-source b{position:absolute;left:50%;top:50%;width:12px;height:12px;margin:-6px;border-radius:50%;background:var(--dkan-phase,#60a5fa);box-shadow:0 0 16px 5px color-mix(in srgb,var(--dkan-phase,#60a5fa) 42%,transparent)}.dkan-gravity-source i{position:absolute;left:50%;top:50%;width:26px;height:26px;margin:-13px;border:1px solid color-mix(in srgb,var(--dkan-phase,#60a5fa) 42%,transparent);border-radius:50%;opacity:0;animation:dkan-gravity-wave calc(4.6s / var(--dkan-speed,1)) cubic-bezier(.2,.55,.35,1) infinite;will-change:transform,opacity}",
	"@keyframes dkan-gravity-wave{0%{opacity:.64;transform:scale(.3)}100%{opacity:0;transform:scale(9)}}",
	// 灵感天灯：暖色灯体从屏幕底部缓慢升起，尾迹由伪元素提供。
	".dkan-lantern{contain:strict}.dkan-lantern i{position:absolute;bottom:-30px;border-radius:45% 45% 34% 34%;background:linear-gradient(150deg,#fff7c2 0%,#fbbf24 46%,#f97316 100%);box-shadow:0 0 10px 3px color-mix(in srgb,#fbbf24 36%,transparent);opacity:0;animation-name:dkan-lantern-rise;animation-timing-function:cubic-bezier(.34,.02,.6,1);animation-iteration-count:infinite;will-change:transform,opacity}.dkan-lantern i::after{content:'';position:absolute;left:42%;top:100%;width:16%;height:13px;background:linear-gradient(#f59e0b,transparent)}",
	"@keyframes dkan-lantern-rise{0%{opacity:0;transform:translate3d(0,0,0) rotate(-3deg) scale(.72)}12%{opacity:.72}78%{opacity:.48}100%{opacity:0;transform:translate3d(var(--drift),-104vh,0) rotate(4deg) scale(1.04)}}",
	// ===== 交互反馈层 =====
	".dkan-fxwrap{position:fixed;inset:0;z-index:9992;pointer-events:none;overflow:hidden;}",
	".dkan-fx{position:absolute;}",
	// 纸飞机：从点击处向右上飞出淡出（加大加亮）
	".dkan-fx-plane{color:var(--dk-accent);font-size:24px;text-shadow:0 0 8px color-mix(in srgb,var(--dk-accent) 70%,transparent);animation:dkan-plane 1.2s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-plane{0%{opacity:0;transform:translate(0,0) rotate(-20deg) scale(.6)}15%{opacity:1;transform:translate(20px,-14px) rotate(-20deg) scale(1.1)}100%{opacity:0;transform:translate(240px,-160px) rotate(-20deg) scale(1)}}",
	// 火花：粒子四散（加大加多散得更开）
	".dkan-fx-spark i{position:absolute;width:7px;height:7px;border-radius:50%;box-shadow:0 0 6px currentColor;animation:dkan-spark .9s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-spark{0%{opacity:1;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.4)}}",
	// 流光：横向扫过（切会话，加高加亮）
	".dkan-fx-streak{top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,transparent,var(--dk-accent) 50%,#fff);background-size:45% 100%;background-repeat:no-repeat;box-shadow:0 0 12px 2px color-mix(in srgb,var(--dk-accent) 50%,transparent);animation:dkan-streak 1s var(--ds-ease-in-out) forwards;}",
	"@keyframes dkan-streak{0%{background-position:-50% 0;opacity:0}20%{opacity:1}100%{background-position:150% 0;opacity:0}}",
	// 微光：全屏柔光一闪（切工作目录，加浓）
	".dkan-fx-flash{inset:0;background:radial-gradient(ellipse at center,color-mix(in srgb,var(--dk-accent) 26%,transparent),transparent 75%);animation:dkan-flash .8s var(--ds-ease-in-out) forwards;}",
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
	".dkan-dotwrap{position:relative;width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;}",
	".dkan-dot{width:12px;height:12px;border-radius:50%;background:var(--dkan-phase,var(--dk-accent));box-shadow:0 0 10px color-mix(in srgb,var(--dkan-phase,var(--dk-accent)) 70%,transparent);transition:background .4s var(--ds-ease-in-out),box-shadow .4s var(--ds-ease-in-out);}",
	".dkan-breathe .dkan-dot{animation:dkan-breathe calc(2.2s / var(--dkan-speed,1)) ease-in-out infinite;}",
	"@keyframes dkan-breathe{0%,100%{transform:scale(1);opacity:.5}50%{transform:scale(1.7);opacity:1}}",
	// 呼吸光晕：向外扩散的波纹环，与圆点同频（颜色随阶段）
	".dkan-halo{position:absolute;inset:0;border-radius:50%;border:2px solid var(--dkan-phase,var(--dk-accent));animation:dkan-halo calc(2.2s / var(--dkan-speed,1)) ease-out infinite;}",
	"@keyframes dkan-halo{0%{transform:scale(.5);opacity:.9}70%{transform:scale(1.5);opacity:.25}100%{transform:scale(1.7);opacity:0}}",
	// breathe 模式徽标更醒目：阶段色描边 + 呼吸辉光
	".dkan-badge-breathe{border-color:color-mix(in srgb,var(--dkan-phase,#4d9fff) 55%,transparent);animation:dkan-rise .3s var(--ds-ease-in-out),dkan-badge-breathe calc(2.2s / var(--dkan-speed,1)) ease-in-out infinite;}",
	"@keyframes dkan-badge-breathe{0%,100%{box-shadow:0 0 6px color-mix(in srgb,var(--dkan-phase,#4d9fff) 22%,transparent),0 6px 24px rgb(0 0 0 / .16)}50%{box-shadow:0 0 18px color-mix(in srgb,var(--dkan-phase,#4d9fff) 55%,transparent),0 6px 24px rgb(0 0 0 / .16)}}",
	".dkan-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0deg,transparent 0 68%,var(--dk-accent) 92%,#fff);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));mask:radial-gradient(farthest-side,transparent calc(100% - 2px),#000 calc(100% - 2px));animation:dkan-spin calc(2.2s / var(--dkan-speed,1)) linear infinite;opacity:.9;}",
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
	".dkan-mode:hover{border-color:var(--dk-accent);}",
	".dkan-mode.on{border-color:var(--dk-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dk-accent) 40%,transparent);}",
	".dkan-mode-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px;}",
	".dkan-mode.on .dkan-mode-name::after{content:\"✓\";color:var(--dk-accent);}",
	".dkan-mode-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5;}",
	".dkan-robot-controls{display:flex;flex-direction:column;gap:8px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--dk-accent) 28%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dk-accent) 5%,var(--dsw-alias-bg-layer-2));}",
	".dkan-robot-controls-head{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--dsw-alias-label-primary);}",
	".dkan-robot-controls-head strong{font-variant-numeric:tabular-nums;color:var(--dk-accent);}",
	".dkan-robot-size-options{display:flex;gap:6px;flex-wrap:wrap;}",
	".dkan-robot-size-options button{cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:3px 10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;}",
	".dkan-robot-size-options button:hover,.dkan-robot-size-options button.on{border-color:var(--dk-accent);color:var(--dsw-alias-label-primary);}",
	".dkan-robot-slider-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dkan-robot-slider-row input{accent-color:var(--dk-accent);width:min(240px,100%);}",
	".dkan-prev{height:30px;border-radius:6px;background:var(--dsw-alias-bg-layer-1);position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;}",
	".dkan-prev-flow{position:absolute;top:0;left:0;right:0;height:3px;background:color-mix(in srgb,var(--dk-accent) 30%,transparent);}",
	".dkan-prev-flow::after{content:\"\";position:absolute;top:0;bottom:0;left:-40%;width:40%;background:linear-gradient(90deg,transparent,var(--dk-accent));animation:dkan-flow 1.9s linear infinite;}",
	".dkan-prev-box{--dkan-speed:1;}",
	".dkan-prev-orbit{position:absolute;top:3px;left:3px;width:7px;height:7px;border-radius:50%;background:var(--dk-accent);box-shadow:0 0 7px 2px color-mix(in srgb,var(--dk-accent) 55%,transparent);animation:dkan-prev-orbit 3s linear infinite;}",
	"@keyframes dkan-prev-orbit{0%{top:3px;left:3px}25%{top:3px;left:calc(100% - 10px)}50%{top:calc(100% - 10px);left:calc(100% - 10px)}75%{top:calc(100% - 10px);left:3px}100%{top:3px;left:3px}}",
	// 预览：代码雨（字符列下落）
	".dkan-prev-matrix i{position:absolute;top:-100%;writing-mode:vertical-rl;font-size:8px;font-family:var(--ds-font-family-code,monospace);color:var(--dk-accent);opacity:.5;animation:dkan-prev-fall 2.2s linear infinite;}",
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
	// 预览：星际远征（行星、轨道与飞船）
	".dkan-prev-space i{position:absolute;left:49%;top:50%;width:9px;height:9px;border-radius:50%;background:#fbbf24;box-shadow:0 0 6px #fbbf24;}.dkan-prev-space b{position:absolute;left:21%;top:23%;width:15px;height:8px;border:1px solid #93c5fd;border-radius:50%;animation:dkan-prev-space-orbit 2.4s linear infinite;}.dkan-prev-space b::after{content:'';position:absolute;left:-3px;top:0;width:5px;height:5px;border-radius:50%;background:#a78bfa;box-shadow:0 0 4px #a78bfa;}.dkan-prev-space em{position:absolute;left:5%;top:65%;width:19px;height:4px;border-radius:50% 0 0 50%;background:linear-gradient(90deg,#22d3ee,#dbeafe);animation:dkan-prev-space-ship 1.8s linear infinite;}.dkan-prev-space em::after{content:'';position:absolute;right:-7px;top:-3px;border-left:9px solid #93c5fd;border-top:5px solid transparent;border-bottom:5px solid transparent;}.dkan-prev-space{background:radial-gradient(ellipse at 78% 20%,color-mix(in srgb,#6366f1 18%,transparent),transparent 58%);}.dkan-prev-space i,.dkan-prev-space b,.dkan-prev-space em{font-style:normal;}.dkan-prev-space b{transform-origin:34px 11px;}@keyframes dkan-prev-space-orbit{to{transform:rotate(360deg)}}@keyframes dkan-prev-space-ship{to{transform:translateX(105px)}}",
	// 预览：极光（柔光带呼吸）
	".dkan-prev-aurora i{position:absolute;top:-30%;width:60%;height:120%;border-radius:50%;filter:blur(8px);opacity:.35;animation:dkan-prev-aurora 2.4s ease-in-out infinite alternate;}",
	".dkan-prev-aurora i:nth-child(1){left:5%;background:#4d9fff;}",
	".dkan-prev-aurora i:nth-child(2){left:45%;background:#34d399;animation-delay:-1.2s;}",
	"@keyframes dkan-prev-aurora{0%{transform:translateX(-10%)}100%{transform:translateX(15%)}}",
	// 十种新增模式的缩微预览：复用主体运动语言，但把节点数和振幅压到卡片内。
	".dkan-prev-new{--dkan-phase:var(--dk-accent)}.dkan-prev-new i{position:absolute;display:block}",
	".dkan-prev-nebula i{width:48px;height:48px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--dkan-phase) 48%,transparent),transparent 70%);animation:dkan-prev-nebula 3s ease-in-out infinite alternate}.dkan-prev-nebula i:nth-child(1){left:2%;top:-60%}.dkan-prev-nebula i:nth-child(2){right:4%;bottom:-65%;background:radial-gradient(circle,color-mix(in srgb,#a855f7 42%,transparent),transparent 70%);animation-delay:-1.4s}.dkan-prev-nebula i:nth-child(n+3){display:none}@keyframes dkan-prev-nebula{to{transform:translateX(24px) scale(1.18)}}",
	".dkan-prev-warp i{left:50%;top:50%;width:36px;height:1px;transform-origin:left;background:linear-gradient(90deg,transparent,var(--dkan-phase),#fff);animation:dkan-prev-warp 1.8s linear infinite;opacity:0}.dkan-prev-warp i:nth-child(1){--a:0deg}.dkan-prev-warp i:nth-child(2){--a:45deg;animation-delay:-.2s}.dkan-prev-warp i:nth-child(3){--a:90deg;animation-delay:-.4s}.dkan-prev-warp i:nth-child(4){--a:135deg;animation-delay:-.6s}.dkan-prev-warp i:nth-child(5){--a:180deg;animation-delay:-.8s}.dkan-prev-warp i:nth-child(6){--a:225deg;animation-delay:-1s}.dkan-prev-warp i:nth-child(7){--a:270deg;animation-delay:-1.2s}.dkan-prev-warp i:nth-child(8){--a:315deg;animation-delay:-1.4s}@keyframes dkan-prev-warp{0%{opacity:0;transform:rotate(var(--a)) translateX(2px) scaleX(.1)}35%{opacity:.8}100%{opacity:0;transform:rotate(var(--a)) translateX(40px) scaleX(1.3)}}",
	".dkan-prev-radar i{left:50%;top:50%;width:24px;height:24px;margin:-12px;border:1px solid color-mix(in srgb,var(--dkan-phase) 48%,transparent);border-radius:50%;animation:dkan-prev-radar 2.6s ease-out infinite;opacity:0}.dkan-prev-radar i:nth-child(2){animation-delay:-.85s}.dkan-prev-radar i:nth-child(3){animation-delay:-1.7s}.dkan-prev-radar i:nth-child(n+4){display:none}@keyframes dkan-prev-radar{0%{opacity:.8;transform:scale(.2)}100%{opacity:0;transform:scale(1.25)}}",
	".dkan-prev-constellation::after{content:'';position:absolute;left:12%;right:12%;top:50%;height:1px;background:linear-gradient(90deg,transparent,var(--dkan-phase),transparent);transform:rotate(-9deg)}.dkan-prev-constellation i,.dkan-prev-fireflies i{width:4px;height:4px;border-radius:50%;background:var(--dkan-phase);box-shadow:0 0 5px var(--dkan-phase);animation:dkan-prev-twinkle 1.8s ease-in-out infinite alternate}.dkan-prev-constellation i:nth-child(1),.dkan-prev-fireflies i:nth-child(1){left:12%;top:62%}.dkan-prev-constellation i:nth-child(2),.dkan-prev-fireflies i:nth-child(2){left:28%;top:26%;animation-delay:-.3s}.dkan-prev-constellation i:nth-child(3),.dkan-prev-fireflies i:nth-child(3){left:45%;top:52%;animation-delay:-.6s}.dkan-prev-constellation i:nth-child(4),.dkan-prev-fireflies i:nth-child(4){left:61%;top:18%;animation-delay:-.9s}.dkan-prev-constellation i:nth-child(5),.dkan-prev-fireflies i:nth-child(5){left:76%;top:58%;animation-delay:-1.2s}.dkan-prev-constellation i:nth-child(6),.dkan-prev-fireflies i:nth-child(6){left:88%;top:34%;animation-delay:-1.5s}@keyframes dkan-prev-twinkle{to{opacity:.2;transform:translateY(4px) scale(.65)}}",
	".dkan-prev-ocean i{left:-10%;width:120%;height:18px;border-top:1px solid color-mix(in srgb,#22d3ee 52%,transparent);border-radius:50%;animation:dkan-prev-wave 2.8s ease-in-out infinite alternate}.dkan-prev-ocean i:nth-child(1){top:15%}.dkan-prev-ocean i:nth-child(2){top:35%;animation-delay:-.5s}.dkan-prev-ocean i:nth-child(3){top:55%;animation-delay:-1s}.dkan-prev-ocean i:nth-child(4){top:75%;animation-delay:-1.5s}.dkan-prev-ocean i:nth-child(n+5){display:none}@keyframes dkan-prev-wave{to{transform:translateX(12px) scaleY(1.2)}}",
	".dkan-prev-prism i{left:-10%;width:120%;height:1px;background:linear-gradient(90deg,transparent,#ef4444,#fbbf24,#22c55e,#22d3ee,#8b5cf6,transparent);transform:rotate(-6deg);animation:dkan-prev-prism 2.8s ease-in-out infinite}.dkan-prev-prism i:nth-child(1){top:18%}.dkan-prev-prism i:nth-child(2){top:34%;animation-delay:-.4s}.dkan-prev-prism i:nth-child(3){top:50%;animation-delay:-.8s}.dkan-prev-prism i:nth-child(4){top:66%;animation-delay:-1.2s}.dkan-prev-prism i:nth-child(5){top:82%;animation-delay:-1.6s}.dkan-prev-prism i:nth-child(n+6){display:none}@keyframes dkan-prev-prism{0%,100%{opacity:.12;transform:translateX(-8px) rotate(-6deg)}50%{opacity:.72;transform:translateX(10px) rotate(-6deg)}}",
	".dkan-prev-circuit i{height:1px;background:var(--dkan-phase);box-shadow:0 0 4px var(--dkan-phase);animation:dkan-prev-circuit 2.4s linear infinite}.dkan-prev-circuit i:nth-child(1){left:5%;top:30%;width:42%}.dkan-prev-circuit i:nth-child(2){left:47%;top:30%;width:1px;height:45%}.dkan-prev-circuit i:nth-child(3){left:47%;top:74%;width:38%}.dkan-prev-circuit i:nth-child(4){left:68%;top:15%;width:1px;height:60%}.dkan-prev-circuit i:nth-child(5){left:68%;top:15%;width:26%}.dkan-prev-circuit i:nth-child(6){left:12%;top:62%;width:35%}@keyframes dkan-prev-circuit{0%,100%{opacity:.18}50%{opacity:.9}}",
	".dkan-prev-gravity i{left:50%;top:50%;width:18px;height:18px;margin:-9px;border:1px solid var(--dkan-phase);border-radius:50%;opacity:0;animation:dkan-prev-gravity 2.6s ease-out infinite}.dkan-prev-gravity i:nth-child(2){animation-delay:-.65s}.dkan-prev-gravity i:nth-child(3){animation-delay:-1.3s}.dkan-prev-gravity i:nth-child(4){animation-delay:-1.95s}.dkan-prev-gravity i:nth-child(n+5){display:none}@keyframes dkan-prev-gravity{0%{opacity:.8;transform:scale(.15)}100%{opacity:0;transform:scale(2.4)}}",
	".dkan-prev-lantern i{bottom:-8px;width:6px;height:8px;border-radius:3px;background:#fbbf24;box-shadow:0 0 5px #f59e0b;animation:dkan-prev-lantern 3.2s linear infinite}.dkan-prev-lantern i:nth-child(1){left:12%}.dkan-prev-lantern i:nth-child(2){left:27%;animation-delay:-.6s}.dkan-prev-lantern i:nth-child(3){left:43%;animation-delay:-1.2s}.dkan-prev-lantern i:nth-child(4){left:61%;animation-delay:-1.8s}.dkan-prev-lantern i:nth-child(5){left:76%;animation-delay:-2.4s}.dkan-prev-lantern i:nth-child(6){left:90%;animation-delay:-2.8s}@keyframes dkan-prev-lantern{0%{opacity:0;transform:translateY(0)}20%{opacity:.9}100%{opacity:0;transform:translateY(-38px)}}",
	".dkan-prev-bot{height:92px;justify-content:center;}",
	".dkan-prev-bot .dkan-bot-scene{--dkan-bot-scale:1;transform:scale(.56);transform-origin:center;}",
	// ===== 桌面伙伴：具象人物 + 紧凑双工位（尺寸可调，整卡可拖拽） =====
	// 卡片：玻璃拟态；默认停泊右下（dsh 输入卡上方），拖动后位置持久化、可放屏幕任意处
	".dkan-botcard{--dkan-bot-scale:1.35;position:fixed;right:20px;bottom:calc(var(--dsh-composer-height,152px) + 20px);z-index:9990;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:16px;cursor:grab;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 86%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 12px 36px rgb(0 0 0 / .22);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;pointer-events:auto;touch-action:none;user-select:none;animation:dkan-rise .3s var(--ds-ease-in-out);}",
	".dkan-botcard:hover,.dkan-botcard:focus-visible{border-color:var(--dk-accent);outline:none;}",
	".dkan-botcard.dkan-dragging{cursor:grabbing;animation:none;}",
	".dkan-botcard .n{color:var(--dsw-alias-label-primary);font-weight:600;}",
	".dkan-bot-cap{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:18px;}",
	".dkan-bot-resize{position:absolute;right:7px;bottom:7px;width:15px;height:15px;padding:0;border:0;border-radius:4px;background:linear-gradient(135deg,transparent 0 42%,var(--dsw-alias-label-tertiary) 44% 51%,transparent 53% 62%,var(--dsw-alias-label-tertiary) 64% 71%,transparent 73%);cursor:nwse-resize;touch-action:none;opacity:.72;}",
	".dkan-bot-resize:hover,.dkan-bot-resize:focus-visible{opacity:1;outline:1px solid var(--dk-accent);outline-offset:1px;}",
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
	// 左屏检索视图：搜索框、放大镜与结果条，和右侧代码编辑器明确区分
	".dk3-search-ui{position:absolute;inset:3px;display:block;overflow:hidden;}",
	".dk3-search-box{display:block;height:5px;margin:0 1px 3px;border:1px solid color-mix(in srgb,var(--dkan-code-a) 72%,#d7fff4);border-radius:2px;box-sizing:border-box;}",
	".dk3-search-box b{display:block;width:2px;height:2px;margin:1px 0 0 2px;border:1px solid var(--dkan-code-a);border-radius:50%;position:relative;}",
	".dk3-search-box b:after{content:'';position:absolute;width:2px;height:1px;background:var(--dkan-code-a);right:-2px;bottom:-1px;transform:rotate(45deg);transform-origin:left center;}",
	".dk3-search-results{display:block;animation:dk3-search-scroll calc(2.1s / var(--dkan-speed,1)) linear infinite;}",
	".dk3-search-results i{display:block;height:2px;margin:2px 1px 0;border-radius:1px;background:var(--dkan-code-a);opacity:.72;}",
	".dk3-search-results i:nth-child(2n){width:74%;background:var(--dkan-code-b);}",
	".dk3-search-results i:nth-child(3n){width:48%;background:var(--dkan-code-c);}",
	"@keyframes dk3-search-scroll{to{transform:translateY(-5px)}}",
	"@keyframes dk3-scroll{to{transform:translateY(-50%)}}",
	// 人物与椅子始终正对桌面：工位切换只横移，不再旋转整个人和座椅。
	".dk3-person{--dk3-seat-x:22px;position:absolute;left:98px;top:14px;width:44px;height:61px;transform-style:preserve-3d;transform:translateZ(30px) translateX(var(--dk3-seat-x));transition:transform max(.18s,calc(.38s / var(--dkan-speed,1))) cubic-bezier(.23,1,.32,1);will-change:transform;}",
	".dkan-bot-scene[data-station=left] .dk3-person{--dk3-seat-x:0px;}",
	".dkan-bot-scene[data-station=center] .dk3-person{--dk3-seat-x:22px;}",
	".dkan-bot-scene[data-station=right] .dk3-person{--dk3-seat-x:44px;}",
	// 上身以髋部为旋转原点；只做前后倾，始终朝向桌面。
	".dk3-upper3{position:absolute;inset:0;transform-style:preserve-3d;transform-origin:12px 52px;transform:translateZ(0);transition:transform .24s cubic-bezier(.77,0,.175,1);will-change:transform;}",
	// 动漫人物配色：皮肤/头发/卫衣/裤子
	".dk3-skin .dk3-face{background:linear-gradient(180deg,#ffd9b8,#f3b98d);}",
	".dk3-skin .dk3-face:nth-child(5){background:#ffe3c9;}",
	".dk3-hair .dk3-face{background:linear-gradient(180deg,#5b4632,#3f3021);}",
	".dk3-hair .dk3-face:nth-child(5){background:#6b543c;}",
	".dk3-hood .dk3-face{background:linear-gradient(180deg,#7c8ba0,#5b6a80);}",
	".dk3-hood .dk3-face:nth-child(5){background:#93a5ba;}",
	".dk3-pants .dk3-face{background:linear-gradient(180deg,#3d4a5c,#2c3646);}",
	".dk3-pants .dk3-face:nth-child(5){background:#4a5a70;}",
	// 人物细节：收窄下颌、连续肩颈、短侧渐层发型
	".dk3-cranium .dk3-face{border-radius:42% 46% 38% 36%;}",
	".dk3-jaw3 .dk3-face{border-radius:30% 30% 48% 48%;}",
	".dk3-neck3 .dk3-face{border-radius:2px;}",
	".dk3-collar3 .dk3-face{background:linear-gradient(180deg,#516176,#374459);border-radius:3px;}",
	".dk3-shoulders3 .dk3-face{border-radius:4px;}",
	".dk3-chest3 .dk3-face{border-radius:4px;}",
	".dk3-waist3 .dk3-face{border-radius:3px;}",
	".dk3-hair .dk3-face{border-radius:2px;}",
	".dk3-hair-crown .dk3-face{border-radius:48% 42% 28% 30%;}",
	".dk3-hair-back .dk3-face{background:linear-gradient(180deg,#493727,#2f241b);border-radius:46% 24% 38% 44%;}",
	".dk3-shoe .dk3-face{background:#20262f;border-radius:2px;}",
	".dk3-mug .dk3-face{background:#c2703d;border-radius:1px;}",
	".dk3-mug .dk3-face:nth-child(5){background:#e08a52;}",
	".dk3-mouth{position:absolute;left:50%;top:64%;width:3.5px;height:1px;border-radius:2px;background:#a9635c;}",
	// 椅子
	".dk3-chairback .dk3-face{background:linear-gradient(180deg,#3f4c60,#2c3648);}",
	".dk3-chairseat .dk3-face{background:#33415a;}",
	// 头组与颈部中心均为 x=14；只让头部观察左右屏，身体和椅子不转向。
	".dk3-head3{--dk3-head-turn:rotateY(0deg);position:absolute;left:6px;top:3px;width:17px;height:21px;transform-style:preserve-3d;transform-origin:8px 18px;transform:var(--dk3-head-turn);transition:transform max(.18s,calc(.22s / var(--dkan-speed,1))) cubic-bezier(.23,1,.32,1);will-change:transform;}",
	".dkan-bot-scene[data-station=left] .dk3-head3{--dk3-head-turn:rotateY(-18deg);}",
	".dkan-bot-scene[data-station=center] .dk3-head3{--dk3-head-turn:rotateY(0deg);}",
	".dkan-bot-scene[data-station=right] .dk3-head3{--dk3-head-turn:rotateY(14deg);}",
	".dk3-brows{position:absolute;left:50%;top:29%;display:flex;gap:2.5px;align-items:center;justify-content:center;}",
	".dk3-brows i{width:3.5px;height:1px;border-radius:2px;background:#3a2a21;transform:rotate(-7deg);}",
	".dk3-brows i+ i{transform:rotate(7deg);}",
	".dk3-eyes{position:absolute;left:50%;top:51%;display:flex;gap:2.5px;align-items:center;justify-content:center;}",
	".dk3-eyes i{width:3.5px;height:2.5px;border-radius:50%;background:radial-gradient(circle at 62% 30%,#fff 0 .5px,#263141 .8px 1.7px,#111827 1.9px);animation:dkan-blink3 4.8s infinite;}",
	".dk3-nose{position:absolute;left:50%;top:66%;width:2px;height:3px;border-radius:60% 40% 55% 45%;background:linear-gradient(90deg,#e7a67e,#c77f67);}",
	".dk3-ear{position:absolute;left:1px;top:10px;width:3px;height:5px;border-radius:52% 44% 48% 52%;background:linear-gradient(90deg,#edaa82,#ffd2ad);transform:translateZ(2px);}",
	".dk3-fringe3{position:absolute;left:13px;top:4px;width:5px;height:7px;transform-style:preserve-3d;transform:rotateY(90deg) translateZ(5.8px);}",
	".dk3-fringe3 i{position:absolute;top:0;width:2px;height:6px;border-radius:70% 25% 60% 30%;background:linear-gradient(180deg,#6b5239,#392b20);transform-origin:top center;}",
	".dk3-fringe3 i:nth-child(1){left:0;transform:rotate(-18deg);height:5px;}",
	".dk3-fringe3 i:nth-child(2){left:1.8px;transform:rotate(-6deg);height:6px;}",
	".dk3-fringe3 i:nth-child(3){left:3.5px;transform:rotate(12deg);height:4px;}",
	"@keyframes dkan-blink3{0%,91%,100%{transform:scaleY(1)}94%{transform:scaleY(.15)}}",
	// 手臂按肩→肘→腕分段，旋转原点位于真实关节连接处。
	".dk3-arm3{position:absolute;left:20px;top:30px;width:16px;height:16px;transform-style:preserve-3d;transform-origin:2px 2px;will-change:transform;}",
	".dk3-elbow{position:absolute;left:0;top:10px;width:15px;height:5px;transform-style:preserve-3d;transform-origin:1px 2px;will-change:transform;}",
	".dk3-wrist3{position:absolute;left:9.5px;top:0;width:6px;height:5px;transform-style:preserve-3d;transform-origin:1px 2px;will-change:transform;}",
	".dk3-fingers3{position:absolute;left:3px;top:1px;width:4px;height:3px;transform:translateZ(2px);}",
	".dk3-fingers3 i{position:absolute;left:0;width:4px;height:.8px;border-radius:2px;background:#f2b58d;}",
	".dk3-fingers3 i+ i{top:1.4px;width:3.5px;}",
	".dk3-far{transform:translateZ(-7px);filter:brightness(.72);}",
	// 思考泡泡（贴镜头 2D 层，think 阶段显示）
	".dkan-bubble{position:absolute;left:80px;top:4px;display:none;gap:3px;padding:4px 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 6px rgb(0 0 0 / .15);z-index:3;}",
	".dkan-bubble i{width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-tertiary);animation:dkan-bubdot 1.2s ease-in-out infinite;}",
	".dkan-bubble i:nth-child(2){animation-delay:.2s;}",
	".dkan-bubble i:nth-child(3){animation-delay:.4s;}",
	"@keyframes dkan-bubdot{0%,100%{opacity:.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-2px)}}",
	// ===== 多任务工位（data-tasks=活跃任务数，上限 3） =====
	// 椅子滚轮
	".dk3-wheel .dk3-face{background:#1c232e;border-radius:50%;}",
	// 有活跃任务时，未轮到的侧工位稍暗；多任务则两个工位均保持可见。
	".dkan-bot-scene[data-tasks] .dk3-mon3.left .dk3-screen,.dkan-bot-scene[data-tasks] .dk3-mon3.right .dk3-screen{opacity:.3;}",
	// 2 个及以上任务：左右工位同时点亮（各自带辉光、代码滚动加速）。
	".dkan-bot-scene[data-tasks=\"2\"] .dk3-mon3.left .dk3-screen,.dkan-bot-scene[data-tasks=\"2\"] .dk3-mon3.right .dk3-screen,.dkan-bot-scene[data-tasks=\"3\"] .dk3-mon3.left .dk3-screen,.dkan-bot-scene[data-tasks=\"3\"] .dk3-mon3.right .dk3-screen{opacity:1;box-shadow:0 0 8px color-mix(in srgb,var(--dkan-code-b,#60a5fa) 42%,transparent);}",
	".dkan-bot-scene[data-tasks=\"2\"] .dk3-mon3.left .dk3-code,.dkan-bot-scene[data-tasks=\"2\"] .dk3-mon3.right .dk3-code,.dkan-bot-scene[data-tasks=\"3\"] .dk3-mon3.left .dk3-code,.dkan-bot-scene[data-tasks=\"3\"] .dk3-mon3.right .dk3-code{animation-duration:calc(2.6s / var(--dkan-speed,1));}",
	// 座椅移动期间滚轮跟随任务节奏转动；思考中停下，避免无意义的常驻运动。
	".dkan-bot-scene[data-station=left] .dk3-wheel,.dkan-bot-scene[data-station=right] .dk3-wheel{animation:dkan-wheel calc(.46s / var(--dkan-speed,1)) linear infinite;transform-origin:center;}",
	"@keyframes dkan-wheel{to{transform:rotateZ(360deg)}}",
	// ===== 阶段驱动（data-phase 四态，host 由 chunk 流实时同步） =====
	// think：上身轻靠、近侧手托下巴、远侧手留在桌面；动作有停顿而不是机械往返。
	".dkan-bot-scene[data-phase=think] .dk3-screen{opacity:.32;}",
	".dkan-bot-scene[data-phase=think] .dkan-bubble{display:inline-flex;}",
	".dkan-bot-scene[data-phase=think] .dk3-upper3{animation:dkan-think-upper max(1.8s,calc(2.4s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=think] .dk3-head3{animation:dkan-think-head max(1.8s,calc(2.4s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=think] .dk3-arm3.dk3-near{animation:dkan-think-near max(1.8s,calc(2.4s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=think] .dk3-arm3.dk3-far{transform:translateZ(-7px) rotateZ(3deg);}",
	".dkan-bot-scene[data-phase=think] .dk3-near .dk3-elbow{transform:rotateZ(-28deg) translateY(-1px);}",
	".dkan-bot-scene[data-phase=think] .dk3-near .dk3-wrist3{transform:rotateZ(-18deg) translateY(-1px);}",
	"@keyframes dkan-think-upper{0%,44%{transform:rotateZ(-1deg) translateY(0)}62%,100%{transform:rotateZ(-1.8deg) translateY(-.5px)}}",
	"@keyframes dkan-think-head{0%,44%{transform:var(--dk3-head-turn) rotateZ(-3deg)}62%,100%{transform:var(--dk3-head-turn) rotateZ(-6deg) translateY(-.5px)}}",
	"@keyframes dkan-think-near{0%,44%{transform:rotateZ(-31deg) translate(-8px,-14.5px)}62%,100%{transform:rotateZ(-34deg) translate(-8.5px,-15px)}}",
	// write/code：身体仍面向桌面，仅轻微前倾；主要由手腕和手指敲击。
	".dkan-bot-scene[data-phase=write] .dk3-mon3.right .dk3-screen,.dkan-bot-scene[data-phase=code] .dk3-mon3.right .dk3-screen{opacity:1;box-shadow:0 0 11px color-mix(in srgb,var(--dkan-code-b,#60a5fa) 52%,transparent);}",
	".dkan-bot-scene[data-phase=write] .dk3-mon3.right .dk3-code,.dkan-bot-scene[data-phase=code] .dk3-mon3.right .dk3-code{animation-duration:calc(1.35s / var(--dkan-speed,1));}",
	".dkan-bot-scene[data-phase=write] .dk3-upper3,.dkan-bot-scene[data-phase=code] .dk3-upper3{animation:dkan-code-upper max(1.2s,calc(2.4s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=write] .dk3-arm3.dk3-near,.dkan-bot-scene[data-phase=code] .dk3-arm3.dk3-near{transform:rotateZ(3deg);}",
	".dkan-bot-scene[data-phase=write] .dk3-arm3.dk3-far,.dkan-bot-scene[data-phase=code] .dk3-arm3.dk3-far{transform:translateZ(-7px) rotateZ(1deg);}",
	".dkan-bot-scene[data-phase=write] .dk3-elbow,.dkan-bot-scene[data-phase=code] .dk3-elbow{animation:dkan-type-elbow max(.28s,calc(.58s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=write] .dk3-wrist3,.dkan-bot-scene[data-phase=code] .dk3-wrist3{animation:dkan-type-wrist max(.18s,calc(.29s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=write] .dk3-far .dk3-elbow,.dkan-bot-scene[data-phase=code] .dk3-far .dk3-elbow{animation-delay:-.09s;animation-duration:max(.3s,calc(.63s / var(--dkan-speed,1)));}",
	".dkan-bot-scene[data-phase=write] .dk3-far .dk3-wrist3,.dkan-bot-scene[data-phase=code] .dk3-far .dk3-wrist3{animation-delay:-.09s;animation-duration:max(.2s,calc(.33s / var(--dkan-speed,1)));}",
	".dkan-bot-scene[data-phase=write] .dk3-head3,.dkan-bot-scene[data-phase=code] .dk3-head3{animation:dkan-output-head max(1.2s,calc(2.4s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	"@keyframes dkan-code-upper{0%,38%{transform:rotateZ(2deg) translate(1px,0)}62%,100%{transform:rotateZ(3deg) translate(1px,1px)}}",
	"@keyframes dkan-type-elbow{0%,38%{transform:rotateZ(-4deg)}62%,100%{transform:rotateZ(5deg) translateY(1px)}}",
	"@keyframes dkan-type-wrist{0%,34%{transform:rotateZ(-2deg) translateY(0)}62%,100%{transform:rotateZ(3deg) translateY(1.5px)}}",
	"@keyframes dkan-output-head{0%,46%,100%{transform:var(--dk3-head-turn) rotateZ(3deg)}58%{transform:var(--dk3-head-turn) rotateZ(5deg) translateY(1px)}}",
	// search：身体正对桌面，头看左屏，近侧手腕小幅操作鼠标。
	".dkan-bot-scene[data-phase=search] .dk3-mon3.left .dk3-screen{opacity:1;box-shadow:0 0 10px color-mix(in srgb,var(--dkan-code-a,#4ade80) 52%,transparent);}",
	".dkan-bot-scene[data-phase=search] .dk3-mon3.left .dk3-search-results{animation-duration:calc(1.05s / var(--dkan-speed,1));}",
	".dkan-bot-scene[data-phase=search] .dk3-upper3{transform:rotateZ(2deg) translateY(1px);}",
	".dkan-bot-scene[data-phase=search] .dk3-head3{animation:dkan-search-head max(.72s,calc(1.15s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=search] .dk3-near .dk3-wrist3{animation:dkan-search-wrist max(.45s,calc(.72s / var(--dkan-speed,1))) cubic-bezier(.77,0,.175,1) infinite;}",
	".dkan-bot-scene[data-phase=search] .dk3-far{transform:translateZ(-7px) rotateZ(2deg);}",
	"@keyframes dkan-search-head{0%,28%{transform:var(--dk3-head-turn) rotateZ(1deg)}48%,68%{transform:var(--dk3-head-turn) rotateZ(6deg) translate(1px,1px)}88%,100%{transform:var(--dk3-head-turn) rotateZ(2deg)}}",
	"@keyframes dkan-search-wrist{0%,34%{transform:translateX(-1px)}62%,100%{transform:translateX(1.5px)}}",
	// 减少动态时停止空间位移，保留屏幕亮暗与思考状态的淡入反馈。
	"@media (prefers-reduced-motion:reduce){.dkan-amb *,.dkan-prev *,.dkan-space-system,.dkan-space-dust,.dkan-space-runner,.dkan-delivery,.dkan-departure,.dkan-freighter-engine i,.dkan-stuck-code::after,.dkan-stuck-code i{animation:none!important}.dkan-space-runner,.dkan-departure{display:none}.dkan-delivery{opacity:1;transform:translate3d(var(--dkan-to-x),var(--dkan-to-y),0)}.dkan-delivery-trail{display:none}.dk3-person,.dk3-upper3,.dk3-head3,.dk3-arm3,.dk3-elbow,.dk3-wrist3,.dk3-wheel,.dk3-code,.dk3-search-results{animation:none!important;transition:none!important}.dk3-screen,.dkan-bubble{transition:opacity .2s cubic-bezier(.23,1,.32,1)!important}}",
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
	".dkan-sound:hover{border-color:var(--dk-accent);}",
	".dkan-sound.on{border-color:var(--dk-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dk-accent) 40%,transparent);}",
	".dkan-sound-name{font-size:12px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:5px;}",
	".dkan-sound-cur{color:var(--dk-accent);font-size:11px;}",
	".dkan-sound-play{flex:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);}",
	".dkan-sound-play:hover{color:var(--dsw-alias-label-primary);border-color:currentColor;}",
	".dkan-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;}",
	".dkan-input:focus{outline:none;border-color:var(--dk-accent);}",
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
	".dkan-tag.on{color:var(--dk-accent);border-color:currentColor;}",
	".dkan-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	".dkan-tag.err{color:var(--dsw-alias-state-error-primary);border-color:currentColor;}",
	".dkan-tag.warn{color:var(--dk-warn);border-color:currentColor;}",
].join("\n");

export const feature = {
	id: "animation",
	name: "任务动画",
	order: 130,
	accent: "#f472b6",
	description: "19 种任务运行动画与完成通知：速度随任务活动联动，两组开关独立、配置持久化",
	css,
	View: AnimationView,
	HomeStat: AnimationStat,
	Overlay: AnimationOverlay,
};
