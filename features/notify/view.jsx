// dsh-dock · 功能模块【任务通知】· 客户端视图
//
// 三部分：
//  1. View      —— 功能坞面板页：通知事件 / 呈现方式 / 钉钉推送 / 飞书推送 四组设置；
//  2. HomeStat  —— 首页总揽概要（当前通知事件与推送通道）；
//  3. Overlay   —— 全局浮层（shell.overlay 常驻，功能启用即挂载）：轮询 Host 状态，
//                  任务结束弹通知卡片（可选提示音与浏览器系统通知），工具等批准 / 提问等回答时弹常驻提醒卡，
//                  编程阶段长时间无活动弹「卡住」提醒卡（写明主/子任务、停滞时长、最后动作）。
//                  卡住判定的口径统一在 src/shared.js 的 taskStalled：等人介入、命令还在跑、
//                  正在压缩上下文都不算卡住（那都是「在干活」），只有真的安静下来才报。
//                  所有卡片受「页内卡片」总开关与各类型开关控制（见 View 的通知事件区）。
//                  结束卡常驻到「看过」（点卡直达会话 / 点进会话 / 手动 ✕），≥3 张叠放收纳。
//
// 与【任务动画】【运行状态】完全独立：动效在 features/animation/、任务状态一览在
// features/runstate/，本模块只管通知（页内卡片 / 提示音 / 系统通知 / 钉钉飞书群机器人推送）。
// 模块启停 = 功能坞里的开关（独立菜单项），本页不再有第二个总开关。
// 语音播报是双层开关：服务端 voiceNotify（settings，跨浏览器）+ 本机开关（localStorage，
// 当前浏览器），两者都开才播报——团队共用一个 dsh 实例时可按浏览器各自静音。
//
// Host 通信：fetch('dsh-dock/notify/<method>')（见 features/notify/host.js）。
import { useState, useEffect, useRef, useCallback } from "react";
import { taskWaiting, taskApprovals, taskQuestions, taskStalled, taskActivityAt } from "../../src/shared.js";

// ---------- Host RPC 桥接 ----------
function rpcCall(method, args) {
	return fetch("dsh-dock/notify/" + method, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(args === undefined ? {} : args),
	})
		.then(async (res) => {
			const data = await res.json().catch(() => ({}));
			if (res.ok && data && data.ok === true) return data.data;
			// 宿主侧没有通知路由（405/404）：两种可能——宿主进程是旧版本，或本功能在宿主侧
			// 还没 setup（开关没同步过去）。给可操作提示，而不是裸状态码。
			if (res.status === 405 || res.status === 404) {
				throw new Error("宿主侧没有「任务通知」接口：宿主进程可能是旧版本，或该功能在宿主侧未启用（重启 dsh web，或把功能坞里的开关关掉再打开）");
			}
			if (data && data.ok === false) throw new Error((data.error && data.error.message) || ("HTTP " + res.status));
			throw new Error("HTTP " + res.status + (data && data.error && data.error.message ? ": " + data.error.message : ""));
		});
}

// ---------- 结束原因 / 阶段 ----------
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

// 工具名 → 中文场景（"需确认"通知里说清楚是什么在等确认）
function toolLabel(name) {
	const n = String(name || "").toLowerCase();
	if (/bash|shell|terminal|cmd|pwsh|powershell|exec/.test(n)) return "执行命令";
	if (/write|edit|patch|apply|create|mkdir|remove|delete/.test(n)) return "修改文件";
	if (/web|fetch|browser|navigate|search/.test(n)) return "访问网页";
	return "";
}

// ---------- 格式化 ----------
function fmtNum(n) { return (Number(n) || 0).toLocaleString("en-US"); }
// 毫秒 → "3分21秒" / "1小时2分"
function fmtDur(ms) {
	const s = Math.max(0, Math.round((ms || 0) / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	if (h > 0) return h + "小时" + m + "分" + sec + "秒";
	if (m > 0) return m + "分" + sec + "秒";
	return sec + "秒";
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

// ---------- 提示音（WebAudio 合成；macOS/Windows 通用，无音频文件） ----------
// 音效库：每种含完成音（done）、异常音（err）与确认音（ask）三套音符序列。
// 音符 [频率, 起始秒, 时长秒, 波形?]，波形缺省 sine。确认音双音上扬、偏长，
// 听感是"来人搭话"，和完成音的收束感、异常音的下坠感区分开。
const SOUND_LIBRARY = {
	chime:  { name: "清脆双音", notes: { done: [[659.25, 0, .14], [880, .13, .24]], err: [[220, 0, .16], [164.81, .15, .3]], ask: [[587.33, 0, .16], [880, .19, .34]] } },
	ding:   { name: "叮",       notes: { done: [[987.77, 0, .35]], err: [[246.94, 0, .4]], ask: [[783.99, 0, .18], [1174.66, .2, .42]] } },
	coin:   { name: "金币",     notes: { done: [[988, 0, .08], [1319, .08, .35], [988, 0, .08, "square"], [1319, .08, .3, "square"]], err: [[196, 0, .12], [147, .11, .35]], ask: [[880, 0, .09], [1108.73, .1, .12], [1318.51, .22, .3]] } },
	bell:   { name: "钟声",     notes: { done: [[523.25, 0, .5], [659.25, .02, .45], [783.99, .04, .4]], err: [[174.61, 0, .5], [130.81, .05, .5]], ask: [[659.25, 0, .4], [523.25, .05, .55]] } },
	pulse:  { name: "脉冲",     notes: { done: [[440, 0, .09], [440, .14, .09], [440, .28, .16]], err: [[174.61, 0, .1], [174.61, .14, .1], [174.61, .28, .18]], ask: [[523.25, 0, .09], [523.25, .15, .09], [659.25, .3, .22]] } },
	arp:    { name: "琶音",     notes: { done: [[523.25, 0, .12], [659.25, .09, .12], [783.99, .18, .12], [1046.5, .27, .3]], err: [[392, 0, .12], [329.63, .1, .12], [261.63, .2, .12], [196, .3, .32]], ask: [[440, 0, .11], [554.37, .12, .11], [659.25, .24, .11], [880, .36, .34]] } },
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
// 按音效播放：完成音 / 异常音 / 确认音（未知音效回退 chime）
function playDoneSound(success, effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(success ? lib.notes.done : lib.notes.err);
}
function playAskSound(effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(lib.notes.ask || lib.notes.done);
}
// 试听：完成音 + 异常音 连播（间隔 0.55s）
function previewSound(effect) {
	const lib = SOUND_LIBRARY[effect] || SOUND_LIBRARY.chime;
	playTone(lib.notes.done);
	const delayed = lib.notes.err.map(([f, at, dur, wave]) => [f, at + 0.55, dur, wave]);
	playTone(delayed);
}

// ---------- 语音播报（speechSynthesis 短句引擎；沙箱安全：绝不裸引用全局 speechSynthesis） ----------
// 与【语音朗读】是同一套浏览器能力、两套独立开关：tts 读「回复正文」，本引擎只播
// 「完成/停止/需授权/卡住」四类短句（简洁/详细两种口径）。两边共用浏览器全局队列：
// 播报先 cancel 再播——通知语义就是要打断（正在读回复时任务完成了，先打断报信）。
// 已知小边距：播报 cancel 掉【语音朗读】正在读的正文时，tts 引擎自己的进度态不会
// 同步清零（它收不到被 cancel 的 onend），表现为喇叭仍显示「正在朗读」——再点一下
// 即停；打断本身符合「先报任务信」的预期，不做跨模块耦合。
function synthOf() {
	try {
		const g = typeof globalThis !== "undefined" ? globalThis : null;
		if (g && g.speechSynthesis) return g.speechSynthesis;
		if (typeof window !== "undefined" && window.speechSynthesis) return window.speechSynthesis;
	} catch { /* 取不到当不支持 */ }
	return null;
}
function utterCtor() {
	try {
		const g = typeof globalThis !== "undefined" && globalThis.SpeechSynthesisUtterance
			? globalThis.SpeechSynthesisUtterance
			: (typeof window !== "undefined" ? window.SpeechSynthesisUtterance : null);
		return g;
	} catch { return null; }
}
export function voiceSupported() {
	return synthOf() !== null && utterCtor() !== null;
}
// ---------- 本机播报开关（每浏览器独立，存 localStorage） ----------
// 服务端 voiceNotify 是总开关（跨浏览器/跨设备，宿主 settings 持久化）；本机开关是
// 「这台浏览器要不要出声」的第二层开关——团队共用一个 dsh 实例时，有人想听、有人嫌吵。
// 两个都开才播报；默认开（保持服务端总开关打开后的既有行为），用户可在本机关闭本机开关。
const VOICE_CLIENT_KEY = "dsh-dock/notify/voice-client/v1";
export function voiceClientEnabled() {
	try {
		if (typeof localStorage === "undefined") return true;
		return localStorage.getItem(VOICE_CLIENT_KEY) !== "0";
	} catch { return true; }
}
function setVoiceClientEnabled(on) {
	try { if (typeof localStorage !== "undefined") localStorage.setItem(VOICE_CLIENT_KEY, on ? "1" : "0"); } catch { /* 持久化失败仅在本次会话生效 */ }
}
/** 真正允许自动播报：服务端总开关 && 本机开关。所有自动播报统一走这里判断。 */
export function voiceAllowed(cfg) {
	return !!cfg && cfg.voiceNotify === true && voiceClientEnabled();
}
/** 本机开关的 React 状态：读写 localStorage，并跟随其它标签页的 storage 事件。 */
function useVoiceClientEnabled() {
	const [on, setOn] = useState(() => voiceClientEnabled());
	useEffect(() => {
		const sync = () => setOn(voiceClientEnabled());
		if (typeof window === "undefined" || typeof window.addEventListener !== "function") return undefined;
		window.addEventListener("storage", sync);
		return () => { if (typeof window.removeEventListener === "function") window.removeEventListener("storage", sync); };
	}, []);
	const set = useCallback((next) => {
		const v = next !== false;
		setVoiceClientEnabled(v);
		setOn(v);
		// 关掉本机播报时立刻收声：正在念的那一句不该再继续打扰。
		if (!v) { const s = synthOf(); if (s) { try { s.cancel(); } catch { /* ignore */ } } }
	}, []);
	return [on, set];
}

// ---------- 通知配置来源：服务端配置 / 本机配置 ----------
// 服务端配置存在宿主 settings（跨浏览器共享）；本机配置只存当前浏览器 localStorage，
// 只影响本浏览器内的页面卡片/提示音/系统通知/语音播报。群机器人推送与语音服务端总开关
// 由宿主执行，始终使用服务端配置。
const CONFIG_SOURCE_KEY = "dsh-dock/notify/config-source/v1";
const CLIENT_CONFIG_KEY = "dsh-dock/notify/client-config/v1";
const CLIENT_CONFIG_FIELDS = [
	"notifyOnComplete", "notifyOnError", "notifyOnConfirm", "notifyOnStuck",
	"notifyCards", "cardMode", "notifyStayMs",
	"soundNotify", "soundEffect", "systemNotify",
	"voiceMode", "voiceOnComplete", "voiceOnError", "voiceOnConfirm", "voiceOnStuck",
	"voiceRate", "voiceVolume", "voiceLang", "voiceURI",
];
/** 当前浏览器选择的配置来源：'server'（默认）或 'client'。 */
export function notifyConfigSource() {
	try {
		if (typeof localStorage === "undefined") return "server";
		return localStorage.getItem(CONFIG_SOURCE_KEY) === "client" ? "client" : "server";
	} catch { return "server"; }
}
function setNotifyConfigSource(source) {
	try { if (typeof localStorage !== "undefined") localStorage.setItem(CONFIG_SOURCE_KEY, source === "client" ? "client" : "server"); } catch { /* 持久化失败仅本次会话生效 */ }
}
/** 本机通知配置（只在 source=client 时参与生效；未设置过返回 null）。 */
export function readClientNotifyConfig() {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(CLIENT_CONFIG_KEY);
		const obj = raw ? JSON.parse(raw) : null;
		return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
	} catch { return null; }
}
function writeClientNotifyConfig(cfg) {
	try { if (typeof localStorage !== "undefined") localStorage.setItem(CLIENT_CONFIG_KEY, JSON.stringify(cfg || {})); } catch { /* 持久化失败仅本次会话生效 */ }
}
/** 从服务端配置里摘出「本机配置」需要接管的浏览器侧字段。
 *  ⚠️ eventMatrix 只带浏览器侧渠道（card / sound / system / voice）：钉钉/飞书由宿主执行，
 *  写进本机配置既不生效也会误导——本机模式下这两个渠道在矩阵里是只读的。 */
export function pickClientConfig(serverCfg) {
	const src = serverCfg || {};
	const out = {};
	for (const key of CLIENT_CONFIG_FIELDS) {
		if (src[key] !== undefined) out[key] = src[key];
	}
	const matrix = {};
	const m = src.eventMatrix;
	if (m && typeof m === "object") {
		for (const [key, value] of Object.entries(m)) {
			if (typeof value === "boolean" && /^(card|sound|system|voice):/.test(key)) matrix[key] = value;
		}
	}
	out.eventMatrix = matrix;
	return out;
}
/** 把本机配置覆盖到服务端配置上（服务端唯一事实字段保留服务端值）。
 *  eventMatrix 逐键合并：本机只覆盖 card/sound/system/voice，dingtalk/feishu 始终用服务端的。 */
export function mergeClientNotifyConfig(serverCfg, localCfg) {
	const server = serverCfg || {};
	const cfg = Object.assign({}, server, localCfg || {});
	// 服务端唯一事实：群机器人推送与语音总开关由宿主执行/控制，不能被本机配置覆盖。
	for (const key of ["dingtalkEnabled", "dingtalkWebhook", "feishuEnabled", "feishuWebhook", "pushMode"]) {
		cfg[key] = server[key];
	}
	cfg.voiceNotify = server.voiceNotify === true;
	const matrix = Object.assign({}, server.eventMatrix || {});
	const localMatrix = (localCfg && localCfg.eventMatrix) || {};
	for (const [key, value] of Object.entries(localMatrix)) {
		if (typeof value === "boolean" && /^(card|sound|system|voice):/.test(key)) matrix[key] = value;
	}
	cfg.eventMatrix = matrix;
	return cfg;
}
export function effectiveNotifyConfig(serverCfg) {
	const server = serverCfg || {};
	if (notifyConfigSource() !== "client") return server;
	const local = readClientNotifyConfig();
	if (!local) return server;
	return mergeClientNotifyConfig(server, local);
}
/** 本机配置来源的 React 状态。 */
function useNotifyConfigSource() {
	const [source, setSource] = useState(() => notifyConfigSource());
	const set = useCallback((next) => {
		const value = next === "client" ? "client" : "server";
		setNotifyConfigSource(value);
		setSource(value);
	}, []);
	return [source, set];
}
// ---------- 通知事件矩阵：事件 × 渠道 ----------
// 键名形如 "card:complete" / "sound:error" / "voice:stuck"。未设置过的键回退到旧字段：
// 卡片/提示音/系统通知/群推送跟随 notifyOn*；语音跟随 voiceOn*——升级不改变既有行为。
const EVENT_CONFIG_KEY = {
	complete: "notifyOnComplete",
	error: "notifyOnError",
	confirm: "notifyOnConfirm",
	stuck: "notifyOnStuck",
};
const VOICE_EVENT_KEY = {
	complete: "voiceOnComplete",
	error: "voiceOnError",
	confirm: "voiceOnConfirm",
	stuck: "voiceOnStuck",
};
export function eventEnabled(cfg, channel, event) {
	const key = channel + ":" + event;
	const matrix = cfg && cfg.eventMatrix;
	if (matrix && typeof matrix === "object" && typeof matrix[key] === "boolean") return matrix[key];
	if (channel === "voice") return !cfg || cfg[VOICE_EVENT_KEY[event]] !== false;
	return !cfg || cfg[EVENT_CONFIG_KEY[event]] !== false;
}
export function withEventMatrix(cfg, channel, event, on) {
	const matrix = Object.assign({}, (cfg && cfg.eventMatrix) || {});
	matrix[channel + ":" + event] = !!on;
	return matrix;
}
/** 本机音色表（可能为空：Chrome 首次调用是异步加载，靠 voiceschanged 补）。 */
export function localVoices() {
	const s = synthOf();
	if (!s) return [];
	try { return (typeof s.getVoices === "function" ? s.getVoices() : []) || []; } catch { return []; }
}
/**
 * 按配置挑音色（与【语音朗读】pickVoice 同规则）：显式选过的 voiceURI 必须在**本机**
 * 音色表里存在，否则按语言回落——音色是设备相关的，别的机器上存的 URI 在这里可能没有。
 */
export function pickVoice(cfg, text) {
	const voices = localVoices();
	if (voices.length === 0) return null;
	const want = String((cfg && cfg.voiceURI) || "");
	if (want) {
		const hit = voices.find((v) => v && v.voiceURI === want);
		if (hit) return hit;
	}
	const lang = String((cfg && cfg.voiceLang) || "");
	if (lang) {
		const base = lang.split("-")[0].toLowerCase();
		return voices.find((v) => String(v.lang || "").toLowerCase() === lang.toLowerCase())
			|| voices.find((v) => String(v.lang || "").toLowerCase().startsWith(base))
			|| null;
	}
	// 未指定语言：播报文本大概率是中文，优先中文音色
	if (!text || /[\u4E00-\u9FFF]/.test(text)) {
		const zh = voices.find((v) => /^zh/i.test(String(v.lang || "")));
		if (zh) return zh;
	}
	return null;
}
// 本机音色表（面板下拉用）：Chrome 的 getVoices() 首次是异步的，订阅 voiceschanged
// 后再渲染一次；与【语音朗读】面板同款处理。
function useLocalVoices() {
	const [, force] = useState(0);
	const ref = useRef(null);
	if (ref.current === null) ref.current = localVoices();
	useEffect(() => {
		const s = synthOf();
		const onChange = () => { ref.current = localVoices(); force((n) => n + 1); };
		if (s && typeof s.addEventListener === "function") {
			try { s.addEventListener("voiceschanged", onChange); } catch { /* ignore */ }
		}
		// 首帧可能已就绪但没触发事件：补读一次
		if (ref.current.length === 0) onChange();
		return () => { if (s && typeof s.removeEventListener === "function") { try { s.removeEventListener("voiceschanged", onChange); } catch { /* ignore */ } } };
	}, []);
	return ref.current;
}
let voiceEpoch = 0;
/**
 * 播一句话（幂等键防重）。调用方已用 voiceAllowed 判过服务端总开关 + 本机开关；这里读
 * voiceRate/voiceVolume/voiceLang/voiceURI，voiceURI 在本机不存在时按语言回落，
 * lang 空时中文文本优先挑中文音色。
 * @returns 是否真的开始播（不支持/文本为空返回 false）
 */
export function speakVoice(text, cfg) {
	const t = String(text || "").trim();
	if (!t) return false;
	const s = synthOf();
	const Ctor = utterCtor();
	if (!s || !Ctor) return false;
	const c = cfg || {};
	let utt = null;
	try { utt = new Ctor(t); } catch { return false; }
	if (!utt) return false;
	utt.rate = typeof c.voiceRate === "number" ? Math.min(2, Math.max(0.5, c.voiceRate)) : 1;
	utt.volume = typeof c.voiceVolume === "number" ? Math.min(1, Math.max(0, c.voiceVolume)) : 1;
	let lang = String(c.voiceLang || "");
	if (!lang && /[\u4E00-\u9FFF]/.test(t)) lang = "zh-CN";
	if (lang) utt.lang = lang;
	// 指定音色（与【语音朗读】同一份本机音色表）：命中就用它，并把 lang 对齐到音色自己的
	// 语言，避免「英文音色念中文」；取不到（换设备/系统语音被删）保持按语言回落。
	const voice = pickVoice(c, t);
	if (voice) {
		utt.voice = voice;
		if (voice.lang) utt.lang = voice.lang;
	}
	const epoch = ++voiceEpoch;
	// 打断式：先清掉上一句（含【语音朗读】正文朗读——Chrome cancel 是异步冲刷，
	// 但播报都经这里串行，同一引擎连续 cancel+speak 的竞态对短句影响可忽略）。
	try { s.cancel(); } catch { /* ignore */ }
	const delay = () => {
		// epoch 落后说明期间有新的播报要抢话，本句作废
		if (epoch !== voiceEpoch) return;
		try { s.speak(utt); } catch { /* ignore */ }
	};
	// cancel 后同一 tick speak 会排进未清空的旧队列（Chrome 已知异步冲刷）：
	// 与【语音朗读】同款——等 speaking/pending 落空再播，短句轮询 20ms 足够。
	let waited = 0;
	const poll = () => {
		if (epoch !== voiceEpoch) return;
		let busy = false;
		try { busy = s.speaking === true || s.pending === true; } catch { busy = false; }
		if (!busy || waited >= 800) { delay(); return; }
		waited += 20;
		setTimeout(poll, 20);
	};
	poll();
	return true;
}

// ---------- 播报文案模板（三挡：简洁 = 一句话；适中 = 带标题与关键量；详细 = 带统计与摘要） ----------
// 口径取值 brief | medium | detailed；语音看 cfg.voiceMode（缺省 brief，与宿主 schema 同款），
// 卡片正文看 cfg.cardMode（缺省 detailed ＝历史内容，见下方卡片正文构建处）。
function voiceTone(cfg) {
	const m = cfg && cfg.voiceMode;
	return m === "detailed" || m === "medium" ? m : "brief";
}
/** 卡片正文口径（三挡）：缺省 detailed ＝历史内容——老宿主还没下发 cardMode 时卡片不缩水。 */
function cardTone(cfg) {
	const m = cfg && cfg.cardMode;
	return m === "brief" || m === "medium" ? m : "detailed";
}
function endReasonSpeech(reason) {
	if (reason === "error") return "出错了";
	if (reason === "aborted") return "已停止";
	if (reason === "blocked") return "受阻停止了";
	if (reason === "max-tokens") return "达到输出上限停止了";
	if (reason === "interrupted") return "被打断了";
	return "完成了";
}
/** 结束播报文案（success 由调用方按 isSuccessReason 给）。kind: complete|error */
export function endBroadcastText(success, record, task, cfg) {
	const mode = voiceTone(cfg);
	const reason = (record && record.endReason) || "";
	const title = (record && record.title) || (task && task.title) || "";
	if (mode === "brief") {
		// 简洁口径不分原因细念：正常完成「任务完成」，其余一律「任务停止了」
		return success ? "任务完成" : "任务停止了";
	}
	if (mode === "medium") {
		// 适中口径：点名是哪个任务 + 结果 + （停止时）原因 + 耗时；不念回合/Token 统计
		const who = title ? "任务「" + truncate(title, 30) + "」" : "任务";
		const parts = [success ? who + "完成了" : who + "停止了"];
		if (!success) parts.push("，原因：" + endReasonSpeech(reason));
		const dur = (record && record.duration) || 0;
		if (dur > 0) parts.push("，耗时" + fmtDur(dur));
		parts.push("。");
		return parts.join("");
	}
	const parts = [];
	if (title) parts.push("任务：" + truncate(title, 30) + "。");
	parts.push(success ? "已完成。" : "结束，原因：" + endReasonSpeech(reason) + "。");
	const dur = (record && record.duration) || 0;
	if (dur > 0) parts.push("耗时" + fmtDur(dur) + "。");
	const turns = (record && record.turns) || (task && task.turns) || 0;
	const steps = (record && record.steps) || (task && task.steps) || 0;
	const tools = (record && record.toolCalls) || (task && task.toolCalls) || 0;
	if (turns || steps) parts.push("共" + turns + "回合" + steps + "步" + (tools ? "、工具" + tools + "次" : "") + "。");
	if (!success && record && record.errorMessage) parts.push("错误：" + truncate(String(record.errorMessage).replace(/[`*_#>\[\]()]/g, " "), 50) + "。");
	if (success && record && record.lastText) {
		const plain = truncate(String(record.lastText).replace(/[#*_`>\[\]()!]/g, "").replace(/\s+/g, " "), 40);
		if (plain) parts.push("回复摘要：" + plain);
	}
	return parts.join("");
}
/** 需授权播报文案。 */
export function confirmBroadcastText(task, approval, cfg) {
	const mode = voiceTone(cfg);
	if (mode === "brief") return "任务需要授权";
	const tool = (approval && approval.toolName) || "工具";
	const scene = toolLabel(tool);
	if (mode === "medium") {
		// 适中口径：点名任务 + 要批准的场景；不念工具名与「回到会话」的叮嘱
		const who = task && task.title ? "任务「" + truncate(task.title, 30) + "」" : "任务";
		return who + "需要授权，正在等你批准" + (scene || "工具 " + tool) + "。";
	}
	const parts = [];
	if (task && task.title) parts.push("任务：" + truncate(task.title, 30) + "。");
	parts.push("正在等待你批准" + (scene ? "执行" + scene : "") + "，工具是" + tool + "，请回到会话处理。");
	return parts.join("");
}
/**
 * 需回答播报文案（ask_user_question 挂起，等人选答案）。
 * 与「需授权」是两件事：批准是"要不要执行"，提问是"要选哪个答案"——播报不能混说。
 * 简洁口径只说「任务需要回答」；适中点名任务与问题；详细再补"共几问"与回到会话的叮嘱。
 */
export function questionBroadcastText(task, question, cfg) {
	const mode = voiceTone(cfg);
	if (mode === "brief") return "任务需要你回答";
	const who = task && task.title ? "任务「" + truncate(task.title, 30) + "」" : "任务";
	const head = (question && question.header) || "";
	const body = (question && question.question) || "";
	const what = body ? truncate(body.replace(/[#*_`>\[\]()!]/g, ""), 40) : "";
	if (mode === "medium") {
		// 适中口径：点名任务 + 问的是什么（问题正文优先，没有正文退回标题）；句号统一补
		const tail = what ? "：" + what : (head ? "：" + head : "");
		return who + "在等你回答" + tail + "。";
	}
	const parts = [];
	if (task && task.title) parts.push("任务：" + truncate(task.title, 30) + "。");
	parts.push(what ? "正在等你回答问题：" + what + "。" : "正在等你回答问题。");
	const count = (question && question.count) || 0;
	if (count > 1) parts.push("共 " + count + " 个问题。");
	parts.push("请回到会话选择答案。");
	return parts.join("");
}
/**
 * 卡住播报文案：必须回答「哪里卡住了」——主任务还是子任务、哪个会话、停了多久、
 * 最后在干什么。子任务静默会把「主任务明明在跑却突然播报」放大成困惑（2026-10-30
 * 用户实测：主任务进行中突然播「任务卡住了」，屏幕上却看不到卡住的东西），
 * 所以简洁口径也带「主/子 + 标题」，详细口径再补停滞时长与最后动作。
 * 归属字段来自宿主追踪快照（task-track 的 isSubtask/lastToolName）。
 */
export function stuckBroadcastText(task, cfg) {
	const mode = voiceTone(cfg);
	const where = (task && task.isSubtask ? "子任务" : "主任务")
		+ (task && task.title ? "「" + truncate(task.title, 30) + "」" : "");
	if (mode === "brief") return where + "卡住了";
	if (mode === "medium") {
		return where + "卡住了，已经" + fmtDur(Math.max(0, (cfg && cfg.stuckMs) || STUCK_MS)) + "没有任何动静。";
	}
	const parts = [where + "卡住了。"];
	parts.push("编程阶段已经" + fmtDur(Math.max(0, (cfg && cfg.stuckMs) || STUCK_MS)) + "没有任何动静，");
	const tool = (task && task.lastToolName) || "";
	const scene = tool ? toolLabel(tool) : "";
	parts.push(tool ? "最后在执行" + tool + (scene ? "（" + scene + "）" : "") + "，" : "");
	parts.push("请查看。");
	return parts.join("");
}

/** 卡住判定阈值：与【任务动画】同款——phase=code 且这么久没动静才视为卡住（正常长任务不误报）。
 *  「没动静」由 src/shared.js 的 taskStalled 定义：等人介入、命令在跑、正在压缩上下文都算在干活。 */
const STUCK_MS = 18000;
/** 读取卡住阈值（宿主可下发 stuckMs 覆盖，缺字段回退 STUCK_MS；播报与判定共用同一口径）。 */
function stuckMsOf(cfg) {
	const v = cfg && Number(cfg.stuckMs);
	return Number.isFinite(v) && v > 0 ? v : STUCK_MS;
}

// ---------- 共享快照：浮层（轮询） / 面板页 / 首页概要共用一份数据 ----------
const notifyStore = {
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
	// 本机配置/配置来源变化：状态对象换一个浅拷贝，让订阅方（尤其浮层的 effect）重算。
	touch() {
		if (!this.snap.status) return;
		this.snap = Object.assign({}, this.snap, { status: Object.assign({}, this.snap.status) });
		this.emit();
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
function useNotify() {
	const [snap, setSnap] = useState(notifyStore.snap);
	useEffect(() => notifyStore.subscribe(() => setSnap(notifyStore.snap)), []);
	return snap;
}

// ---------- 通知卡片 ----------
// 需确认卡片没有任何计时器：审批没处理完它就一直在（处理完由 approvalKeys
// 对账自动收起，也可手动 ✕）。曾经的「前台看过 8 秒也收」害死人：审批还挂着
// 等人批，提醒先没了（2026-10-20 实测漏提醒）。堆叠问题交给叠放收纳解决。
function pageVisible() {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

// 当前正在看的会话（侧栏高亮行）。返回 { id, title }：
//  ① 首选权威标识：dsh 0.1.7+ 的会话行带 data-row-key="session:<id>"（Rows.tsx），
//     高亮行取 id——**不做位置过滤**（旧版按「左缘 35vw 内」筛行，窄窗口/宽侧栏时
//     行右缘超限被全部滤掉 → 跳转找不到行、巡检读不到选中 → 卡片永不收起，2026-10-23 实测）；
//  ② 无 data-row-key 的旧宿主：回退「可见 + 左缘 35vw + 行文本」的标题判定。
function currentSelectedSession() {
	if (typeof document === "undefined" || typeof window === "undefined") return { id: "", title: "" };
	if (typeof document.querySelectorAll !== "function") return { id: "", title: "" };
	let byTitle = null;
	for (const el of document.querySelectorAll('[role="treeitem"][aria-selected="true"]')) {
		const k = typeof el.getAttribute === "function" ? el.getAttribute("data-row-key") : null;
		if (typeof k === "string" && k.indexOf("session:") === 0) {
			return { id: k.slice(8), title: (el.textContent || "").trim() };
		}
		if (!byTitle) {
			const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
			if (r && r.width > 0 && r.height > 0 && r.right <= window.innerWidth * .35) {
				const text = (el.textContent || "").trim();
				if (text) byTitle = text;
			}
		}
	}
	return { id: "", title: byTitle || "" };
}
// 标题模糊对齐（与任务动画 taskOnScreen 同规则）：相等或互为子串即算同一会话
function titleMatches(a, b) {
	return !!a && !!b && (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1);
}

// 浮层挂载时记下的 ctx（跳转会话要用宿主官方导航服务；见 NotifyOverlay 里的赋值）
let overlayCtx = null;

// 按 sessionId 精确跳转：宿主 ui-workspace 的官方 API（ctx.get('uiWorkspace')
// .openSession(id)），选会话 + 显示其 Conversation 一步到位，抽屉收起也能跳。
// 服务不可用（独立打包/旧宿主/测试沙箱）返回 false，调用方回退标题点行。
function openSessionById(sessionId) {
	if (!sessionId || !overlayCtx) return false;
	let uiw = null;
	try {
		uiw = typeof overlayCtx.get === "function" ? overlayCtx.get("uiWorkspace") : overlayCtx.uiWorkspace;
	} catch { return false; }
	if (!uiw || typeof uiw.openSession !== "function") return false;
	try { uiw.openSession(sessionId); return true; } catch { return false; }
}

// 点卡片跳转会话（标题回退路径）：在侧栏会话树里找标题对上的一行，点它（优先行内的 a/button）。
// 找不到可见行（会话已删）返回 false，调用方保持卡片不收起。
function openSessionByTitle(title) {
	if (typeof document === "undefined" || typeof window === "undefined") return false;
	if (typeof document.querySelectorAll !== "function" || !title) return false;
	for (const el of document.querySelectorAll('[role="treeitem"]')) {
		const k = typeof el.getAttribute === "function" ? el.getAttribute("data-row-key") : null;
		// 有权威标识的行按标识筛会话行；没有的（旧宿主/搜索行）按位置 + 文本
		const isSessionRow = typeof k === "string" ? k.indexOf("session:") === 0 : true;
		if (!isSessionRow) continue;
		if (typeof k !== "string") {
			const r = typeof el.getBoundingClientRect === "function" ? el.getBoundingClientRect() : null;
			if (!r || r.width <= 0 || r.height <= 0 || r.right > window.innerWidth * .35) continue;
		}
		if (!titleMatches((el.textContent || "").trim(), title)) continue;
		const link = typeof el.querySelector === "function" ? el.querySelector("a,button") : null;
		const target = link || el;
		if (typeof target.click === "function") { target.click(); return true; }
		return false;
	}
	return false;
}

function Toast(props) {
	const t = props.t;
	const [closing, setClosing] = useState(!!t.closing);
	const close = useCallback(() => { setClosing(true); }, []);
	// 点卡片 = 跳转到对应会话。结束卡跳成功就地收起（这一看就把通知的活干完了）；
	// 需确认卡只跳转不收——审批没处理完它就该在。跳转优先按 sessionId 走宿主官方
	// 导航（抽屉收起也有效），回退按标题点侧栏行；都失败（会话已删）卡片原样保留。
	const jump = useCallback(() => {
		if (!t.sessionTitle && !t.sessionId) return;
		// 子任务会话未必在侧栏里：先按自身 id 走官方导航，再试父会话 id（fallbackSessionId），
		// 最后按标题点行。需确认卡只跳不收（审批没处理完它就该在）；卡住卡也不因跳转收起
		// ——它由「恢复活动 / 任务结束」的对账收（跳过去还是卡着，卡片就该继续提醒）。
		const ok = openSessionById(t.sessionId)
			|| (t.fallbackSessionId ? openSessionById(t.fallbackSessionId) : false)
			|| (t.sessionTitle ? openSessionByTitle(t.sessionTitle) : false);
		if (ok && t.kind !== "confirm" && t.kind !== "stuck") setClosing(true);
	}, [t.sessionId, t.sessionTitle, t.fallbackSessionId, t.kind]);
	// 外部要求收起（审批已处理 / 已点进会话）走同一套淡出动画
	useEffect(() => { if (t.closing && !closing) setClosing(true); }, [t.closing, closing]);
	// 所有卡片都没有计时器：结束卡常驻到「看过」（点卡跳转 / 点进会话 / 手动 ✕），
	// 需确认卡常驻到审批处理完（approvalKeys 对账收起，或手动 ✕）。
	// 曾经的 lingerMs「前台看过 8 秒也收」实测会把还挂着的审批提醒先弄丢，已移除；
	// 卡片多了靠叠放收纳（.stacked 样式），不靠丢。
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
	// 叠放收起态（collapsed）：只留标题条，正文隐藏；悬停卡片栈时整体展开
	return (
		<div className={"dknt-toast" + (t.kind === "confirm" ? " dknt-toast-confirm" : "")
				+ (t.sessionTitle || t.sessionId ? " clickable" : "")
				+ (props.collapsed ? " collapsed" : "")
				+ (closing ? " out" : "")}
			onClick={t.sessionTitle || t.sessionId ? jump : undefined}>
			<div className="dknt-toast-head">
				<span className="dknt-toast-mark" style={{ background: markColor }} />
				<span className="dknt-toast-title" title={t.sessionTitle || t.title}>
					{t.kind === "confirm" ? "✋ " : t.kind === "stuck" ? "⏳ " : ""}{props.collapsed ? (t.sessionTitle || t.title) : t.title}
					{!props.collapsed && t.sessionTitle && t.kind !== "confirm" ? " · " + t.sessionTitle : ""}
				</span>
				<button type="button" className="dknt-toast-close" aria-label="关闭"
					onClick={(e) => { if (e && e.stopPropagation) e.stopPropagation(); close(); }}>✕</button>
			</div>
			{!props.collapsed && t.body ? <div className="dknt-toast-body">{t.body}</div> : null}
		</div>
	);
}

// ---------- 全局浮层：轮询 + 通知（功能启用即常驻） ----------
export function NotifyOverlay(props) {
	// 记下外壳 ctx：点卡片跳转会话要用宿主官方导航服务（openSessionById）
	if (props && props.ctx) overlayCtx = props.ctx;
	const snap = useNotify();
	const [toasts, setToasts] = useState([]);
	const [stackHover, setStackHover] = useState(false); // 卡片栈被悬停（叠放时整体展开）
	const prevActiveRef = useRef(null);
	const remindedApprovalsRef = useRef(new Map()); // sessionId -> 提醒过的 approvalId 集合
	const remindedQuestionsRef = useRef(new Map()); // sessionId -> 提醒过的提问 callId 集合
	const toastSeqRef = useRef(0);

	const pushToast = useCallback((toast) => {
		// 「页内卡片」总开关（设置面板里关掉 → 右侧所有卡片都不再弹出）。只管卡片：
		// 语音播报 / 提示音 / 系统通知 / 群推送各有独立开关，与它正交。
		const st = notifyStore.snap.status;
		const cfg = st ? effectiveNotifyConfig(st.config) : null;
		if (cfg && cfg.notifyCards === false) return;
		// 上限 12：结束卡现在常驻到看过才收，4 张容易见底；多了靠叠放收纳而不是丢弃。
		setToasts((prev) => prev.concat([toast]).slice(-12));
	}, []);

	// 总开关中途关闭：已挂着的卡片也一并收掉（否则「设置里关了、右边还挂着」像开关失灵）。
	// 返回原数组避免空转重渲染。
	useEffect(() => {
		const cfg = snap.status ? effectiveNotifyConfig(snap.status.config) : null;
		if (cfg && cfg.notifyCards === false) setToasts((prev) => (prev.length ? [] : prev));
	}, [snap.status]);

	// 轮询：任务中 850ms，实时捕捉结束/待确认；空闲 6s / 出错 15s；页面切回立即刷新。
	useEffect(() => {
		let stopped = false;
		let timer = null;
		const loop = async () => {
			await notifyStore.refresh();
			if (stopped) return;
			const s = notifyStore.snap;
			timer = setTimeout(loop, s.error ? 15000 : (s.status && s.status.active && s.status.active.length > 0 ? 850 : 6000));
		};
		loop();
		const onVisible = () => {
			if (!stopped && typeof document !== "undefined" && document.visibilityState === "visible") notifyStore.refresh();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => { stopped = true; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
	}, []);

	// 任务结束检测：上一轮活跃、本轮消失 → 通知 + 提示音 + 系统通知（找最近完成记录补全信息）
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const prev = prevActiveRef.current;
		if (prev) {
			const currIds = new Set(st.active.map((x) => x.sessionId));
			for (const task of prev) {
				if (currIds.has(task.sessionId)) continue;
				const record = (st.recent || []).find((r) => r.sessionId === task.sessionId) || null;
				handleTaskEnd(task, record, effectiveNotifyConfig(st.config || {}));
			}
		}
		prevActiveRef.current = st.active.slice();
	}, [snap.status]);

	// ===== 需确认检测：工具等待用户批准时通知（页内卡片 + 确认音 + 后台系统通知） =====
	// host 从会话流 approval/asked 收集待确认项，approval/decided 后移除；
	// 这里对"任务首次出现待确认"触发一次提醒，已提醒过的会话不再重复打扰。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const cfg = effectiveNotifyConfig(st.config || {});
		const activeIds = new Set(st.active.map((x) => x.sessionId));
		for (const [sid, seen] of remindedApprovalsRef.current) {
			if (!activeIds.has(sid)) remindedApprovalsRef.current.delete(sid);
		}
		for (const task of st.active) {
			const approvals = taskApprovals(task);
			if (approvals.length === 0) continue;
			let seen = remindedApprovalsRef.current.get(task.sessionId);
			if (!seen) { seen = new Set(); remindedApprovalsRef.current.set(task.sessionId, seen); }
			const fresh = approvals.filter((a) => a && !seen.has(a.id));
			if (fresh.length === 0) continue;
			for (const a of fresh) seen.add(a.id);
			// 语音播报走自己的开关（在卡片开关判定**之前**：关掉卡片提醒不等于关掉耳朵）。
			// 服务端总开关 + 本机开关都开才出声（团队共用一个实例时各自可静音）。
			if (voiceAllowed(cfg) && eventEnabled(cfg, "voice", "confirm")) {
				speakVoice(confirmBroadcastText(task, fresh[0], cfg), cfg);
			}
			// 提醒开关在"收到新确认项"时检查，保证开关中途打开对下一项生效
			if (!eventEnabled(cfg, "card", "confirm")) continue;
			const toolName = fresh[0].toolName || "";
			const scene = toolLabel(toolName);
			// 卡片正文按「卡片口径」三挡裁剪（title 行永远在，卡片标题不受口径影响）
			const tone = cardTone(cfg);
			const lines = [
				"任务：" + (task.title || "(无标题)"),
				"工具：" + (toolName || "未知") + (scene ? "（" + scene + "）" : ""),
			];
			if (tone !== "brief" && fresh[0].reason) lines.push("说明：" + truncate(fresh[0].reason, 140));
			if (fresh.length > 1) {
				lines.push(tone === "brief" ? "共 " + fresh.length + " 项等待确认" : "共 " + fresh.length + " 项等待你的确认");
			} else if (tone === "detailed") {
				lines.push("请在会话里确认后继续");
			}
			pushToast({
				id: ++toastSeqRef.current,
				kind: "confirm",
				title: "任务需要确认",
				body: lines.join("\n"),
				// 点卡片直达该会话去处理审批（需确认卡跳转后不收起——审批没处理完它就该在）
				sessionId: task.sessionId || "",
				sessionTitle: task.title || "",
				// 卡片与这批审批项绑定：approval/decided 后宿主把它们移出 approvals，
				// 下面的对账 effect 据此自动收起卡片（处理完就不该再占着右上角）。
				approvalKeys: fresh.filter((a) => a && a.id).map((a) => task.sessionId + "|" + a.id),
			});
			if (cfg.soundNotify !== false && eventEnabled(cfg, "sound", "confirm")) playAskSound(cfg.soundEffect);
			if (cfg.systemNotify && eventEnabled(cfg, "system", "confirm") && typeof document !== "undefined" && document.hidden
				&& typeof Notification !== "undefined" && Notification.permission === "granted") {
				try {
					new Notification("dsh 任务需要确认", {
						body: (task.title || "(无标题)") + " · " + (toolName || "工具") + " 等待确认",
						tag: "dsh-dock-approval-" + task.sessionId,
					});
				} catch { /* 系统通知失败不影响页面内通知 */ }
			}
		}
	}, [snap.status]);

	// ===== 需回答检测：会话调 ask_user_question 后挂起等人选答案时通知 =====
	// 与「需确认」分开成一段：来源不同（tool/call → tool/result，而非 approval/asked →
	// decided），文案也不同（"要你选答案"不是"要你批准执行"）。但语义同属「任务停在原地等人」，
	// 因此卡住判定把它们一并排除（见下方 stuck 检测的 taskWaiting 判断）。
	// 真实事故（2026-11-01 用户反馈）：提问挂起期间会话零事件，18 秒后被判成「主任务卡住了」，
	// 界面一边显示提问表单、一边报卡住——错的不是检测阈值，而是"等人"没被算作一种合法停点。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const cfg = effectiveNotifyConfig(st.config || {});
		const activeIds = new Set(st.active.map((x) => x.sessionId));
		for (const [sid, seen] of remindedQuestionsRef.current) {
			if (!activeIds.has(sid)) remindedQuestionsRef.current.delete(sid);
		}
		for (const task of st.active) {
			const questions = taskQuestions(task);
			if (questions.length === 0) continue;
			let seen = remindedQuestionsRef.current.get(task.sessionId);
			if (!seen) { seen = new Set(); remindedQuestionsRef.current.set(task.sessionId, seen); }
			const fresh = questions.filter((q) => q && q.id && !seen.has(q.id));
			if (fresh.length === 0) continue;
			for (const q of fresh) seen.add(q.id);
			// 语音播报走自己的开关（与卡片开关正交：关卡片不等于关掉耳朵）。
			// 服务端总开关 + 本机开关都开才出声。
			if (voiceAllowed(cfg) && eventEnabled(cfg, "voice", "confirm")) {
				speakVoice(questionBroadcastText(task, fresh[0], cfg), cfg);
			}
			// 提醒开关在"收到新提问"时检查，保证开关中途打开对下一问生效
			if (!eventEnabled(cfg, "card", "confirm")) continue;
			const tone = cardTone(cfg);
			const head = fresh[0].header || "";
			const body = fresh[0].question || "";
			const lines = ["任务：" + (task.title || "(无标题)")];
			if (body) lines.push((head ? head + "：" : "问题：") + truncate(body, 140));
			else if (head) lines.push("问题：" + head);
			const count = (fresh[0].count || 0);
			if (count > 1) lines.push(tone === "brief" ? "共 " + count + " 个问题" : "共 " + count + " 个问题等你选择");
			if (tone === "detailed") lines.push("请在会话里选好答案后继续");
			pushToast({
				id: ++toastSeqRef.current,
				kind: "confirm",
				title: "任务需要你回答",
				body: lines.join("\n"),
				// 点卡片直达该会话去选答案（与需确认卡同哲学：问题没答完卡片就该在）
				sessionId: task.sessionId || "",
				sessionTitle: task.title || "",
				// 与这批提问绑定：回答落地后宿主把它们移出 questions，下面的对账 effect 据此收起
				questionKeys: fresh.map((q) => task.sessionId + "|" + q.id),
			});
			if (cfg.soundNotify !== false && eventEnabled(cfg, "sound", "confirm")) playAskSound(cfg.soundEffect);
			if (cfg.systemNotify && eventEnabled(cfg, "system", "confirm") && typeof document !== "undefined" && document.hidden
				&& typeof Notification !== "undefined" && Notification.permission === "granted") {
				try {
					new Notification("dsh 任务需要你回答", {
						body: (task.title || "(无标题)") + " · " + (head || "有一问在等你选择"),
						tag: "dsh-dock-question-" + task.sessionId,
					});
				} catch { /* 系统通知失败不影响页面内通知 */ }
			}
		}
	}, [snap.status]);

	// 等人介入的项消失（approval/decided 移出 approvals，或回答落地移出 questions）
	// → 对应提醒卡自动收起。只标记 closing 走淡出，不直接删：与手动点 ✕ 的退场一致。
	// 卡片绑定的 keys 全部不在仍在等待的集合里才收；空 keys（老数据）不动。
	// 两类卡共用这段对账：kind=confirm 的卡片要么绑 approvalKeys、要么绑 questionKeys。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const live = new Set();
		for (const task of st.active) {
			for (const a of taskApprovals(task)) if (a && a.id) live.add(task.sessionId + "|" + a.id);
			for (const q of taskQuestions(task)) if (q && q.id) live.add(task.sessionId + "|" + q.id);
		}
		setToasts((prev) => {
			let changed = false;
			const next = prev.map((x) => {
				if (x.kind !== "confirm" || x.closing) return x;
				const keys = []
					.concat(Array.isArray(x.approvalKeys) ? x.approvalKeys : [])
					.concat(Array.isArray(x.questionKeys) ? x.questionKeys : []);
				if (keys.length === 0 || keys.some((k) => live.has(k))) return x;
				changed = true;
				return Object.assign({}, x, { closing: true });
			});
			return changed ? next : prev;
		});
	}, [snap.status]);

	// 结束卡（完成/异常）的"看过即收"：用户点进那个会话（侧栏高亮行 = 卡片绑定的
	// sessionId，或旧宿主回退到标题对上）就视为已看到结果，卡片自动收起。结束卡没有
	// 超时自毁——没看过就一直挂着；这条巡检是它唯一的自动出口（另有手动 ✕ 与点卡跳转）。
	// 侧栏选中没有事件可订阅，用轻量轮询（500ms 一次 querySelectorAll）；页面在
	// 后台不检查（回来时若仍停在该会话，收起发生在切回后）。
	useEffect(() => {
		const timer = setInterval(() => {
			if (!pageVisible()) return;
			const cur = currentSelectedSession();
			if (!cur.id && !cur.title) return;
			setToasts((prev) => {
				let changed = false;
				const next = prev.map((x) => {
					// 需确认卡挂到审批处理完、卡住卡挂到恢复活动——都不走「看过即收」
					if (x.kind === "confirm" || x.kind === "stuck" || x.closing) return x;
					if (!x.sessionTitle && !x.sessionId) return x;
					const hit = (cur.id && x.sessionId && cur.id === x.sessionId)
						|| (!cur.id && x.sessionTitle && titleMatches(x.sessionTitle, cur.title));
					if (!hit) return x;
					changed = true;
					return Object.assign({}, x, { closing: true });
				});
				return changed ? next : prev;
			});
		}, 500);
		return () => clearInterval(timer);
	}, []);

	// ===== 卡住检测：编程阶段长时间无活动 → 播报 + 弹卡（与【任务动画】同口径 18s） =====
	// 每个会话每个停点只报一次：恢复活动（lastActivityAt 变新）即清除标记，之后再卡住可再报；
	// 会话离开活跃列表（结束/取消）同样清除。阈值到点才轮询比对，850ms 的节奏足够。
	// 语音与卡片**各自独立开关**（关卡片不关耳朵、关语音不关眼睛），所以停点标记要在
	// 两个开关之外都记——否则关掉一边会在同一停点重复打扰另一边。
	const stuckSeenRef = useRef(new Map()); // sessionId -> 已播报时的 lastActivityAt
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const cfg = effectiveNotifyConfig(st.config || {});
		const now = st.now || Date.now();
		const activeIds = new Set(st.active.map((x) => x.sessionId));
		for (const sid of Array.from(stuckSeenRef.current.keys())) {
			if (!activeIds.has(sid)) stuckSeenRef.current.delete(sid);
		}
		// 主任务正在跑子任务（有活跃子会话挂在自己名下）时，主会话天然安静——它在等子代理回话，
		// 不是卡住。这类「等待子任务」的安静不计入卡住判定，交由子任务自己命中（真卡在子任务上会
		// 说「子任务…卡住了」），避免「主任务明明在跑、却报主任务卡住」的误报（2026-11-01 用户反馈）。
		// 先扫一遍建集合、再逐条判定：同一帧里主/子顺序不影响结果。
		const parentsWaitingOnSubtask = new Set();
		for (const t of st.active) {
			if (t.isSubtask && t.parentSessionId) parentsWaitingOnSubtask.add(t.parentSessionId);
		}
		for (const task of st.active) {
			// 停在原地等人的会话不算卡住——那是「需确认 / 需回答」提醒的职责，别重复轰炸。
			// 两类都要排除：① 工具等批准（approvals）；② 提问等回答（questions）。
			// ②是 2026-11-01 用户实测的误报来源：会话调 ask_user_question 后挂起等人选答案，
			// 其间会话一条事件都没有，18 秒安静被当成停滞，播报「主任务卡住了」并弹卡——
			// 界面上明明是在等用户回答（截图为证），报「卡住」完全是错的口径。
			if (taskWaiting(task)) { stuckSeenRef.current.delete(task.sessionId); continue; }
			if (task.phase !== "code") { continue; }
			// 该会话有活跃子任务在跑 → 它在等子任务，不算卡住（否则主任务进行中会误报卡住）
			if (parentsWaitingOnSubtask.has(task.sessionId)) continue;
			// 卡住判定统一走 src/shared.js 的 taskStalled：它已经排除「有在飞的工具调用」与
			// 「正在压缩上下文」这两种**正在干活**的安静。2026-11-02 用户实测：25 分钟里 18 次
			// 误报全落在 compaction 窗口内（最长 96.7 秒），界面在刷「上下文已压缩」却报卡住。
			// 停点指纹改用同一个活动表达式（taskActivityAt），对账 effect 必须一致，否则卡片闪。
			const lastAct = taskActivityAt(task);
			const stuckMs = taskStalled(task, now, stuckMsOf(cfg));
			if (!stuckMs) continue;
			const prev = stuckSeenRef.current.get(task.sessionId);
			if (prev === lastAct) continue; // 同一停点已报过
			stuckSeenRef.current.set(task.sessionId, lastAct);
			// —— 语音：说清主/子任务、标题、停滞时长与最后动作（服务端总开关 + 本机开关）——
			if (voiceAllowed(cfg) && eventEnabled(cfg, "voice", "stuck")) {
				speakVoice(stuckBroadcastText(task, Object.assign({}, cfg, { stuckMs: stuckMs })), cfg);
			}
			// —— 卡片：只受「卡住提醒」与「页内卡片」总开关控制（总开关在 pushToast 里把关）——
			if (!eventEnabled(cfg, "card", "stuck")) continue;
			const label = task.isSubtask ? "子任务" : "主任务";
			const title = task.title || "(无标题)";
			const tool = task.lastToolName || "";
			// 卡片正文按「卡片口径」三挡裁剪：简洁只报谁卡住；适中加停滞时长；详细再加最后动作
			const tone = cardTone(cfg);
			const lines = ["任务：" + label + "·" + title];
			if (tone !== "brief") lines.push("已停滞：" + fmtDur(stuckMs) + "（编程阶段无活动）");
			if (tone === "detailed") {
				if (tool) lines.push("最后动作：" + tool + (toolLabel(tool) ? "（" + toolLabel(tool) + "）" : ""));
				lines.push("恢复活动或任务结束后自动收起；点击卡片直达会话");
			}
			pushToast({
				id: ++toastSeqRef.current,
				kind: "stuck",
				title: label + "卡住了",
				body: lines.join("\n"),
				sessionId: task.sessionId || "",
				sessionTitle: title,
				// 子任务会话通常不在侧栏里：跳不到自己时回退到父会话（看主会话里的子代理进度）
				fallbackSessionId: (task.isSubtask && task.parentSessionId) ? task.parentSessionId : "",
				// 停点指纹：恢复活动（lastActivityAt 变了）即由下面的对账 effect 收起
				stuckAt: lastAct,
			});
		}
	}, [snap.status]);

	// 卡住卡的自动收起（与需确认卡同哲学：不设倒计时，状态没变就一直挂着）：
	//  恢复活动 / 离开活跃列表（结束或取消）/ 转为等人介入（需确认卡或需回答卡接管）
	// → 标记 closing 走同一套 240ms 淡出。只标记不直删，与手动 ✕ 退场一致。
	// 「恢复活动」的判据必须与卡住判定处**完全一致**（都走 taskActivityAt），否则同一停点
	// 两处算出的指纹不同，卡片会反复收起又弹出。
	useEffect(() => {
		const st = snap.status;
		if (!st || !st.active) return;
		const byId = new Map(st.active.map((x) => [x.sessionId, x]));
		setToasts((prev) => {
			let changed = false;
			const next = prev.map((x) => {
				if (x.kind !== "stuck" || x.closing) return x;
				const task = byId.get(x.sessionId);
				const stillStalled = !!task
					&& taskActivityAt(task) === x.stuckAt
					&& !taskWaiting(task);
				if (stillStalled) return x;
				changed = true;
				return Object.assign({}, x, { closing: true });
			});
			return changed ? next : prev;
		});
	}, [snap.status]);

	const handleTaskEnd = (task, record, cfg) => {
		const reason = (record && record.endReason) || "";
		const success = isSuccessReason(reason);
		const info = endInfo(reason);
		const event = success ? "complete" : "error";
		const cardWanted = eventEnabled(cfg, "card", event);
		const soundWanted = cfg.soundNotify !== false && eventEnabled(cfg, "sound", event);
		const systemWanted = !!cfg.systemNotify && eventEnabled(cfg, "system", event);
		// 语音播报与卡片/提示音/系统通知完全正交：各自的事件矩阵与总开关独立判断。
		if (voiceAllowed(cfg) && eventEnabled(cfg, "voice", event)) {
			speakVoice(endBroadcastText(success, record, task, cfg), cfg);
		}
		const models = record && record.models && record.models.length ? record.models.join(", ")
			: (task.models && task.models.length ? task.models.join(", ") : "未知模型");
		const provider = (record && record.provider) || task.provider || "";
		const startTs = (record && record.startTime) || task.startTime;
		const endTs = (record && record.endTime) || Date.now();
		const durText = fmtDur((record && record.duration) || (endTs - startTs));
		const title = success ? "任务完成" : "任务" + info.label;
		const showTitle = (record && record.title) || task.title || "(无标题)";
		if (cardWanted) {
			// 卡片正文按「卡片口径」三挡裁剪（cfg.cardMode，缺省 detailed ＝历史内容）：
			//  简洁＝任务+耗时；适中＝加模型与起止时间；详细＝再加回合/步骤、Token、摘要或错误。
			const tone = cardTone(cfg);
			const lines = ["任务：" + showTitle];
			if (tone !== "brief") lines.push("模型：" + models + (provider ? "（" + provider + "）" : ""));
			lines.push(tone === "brief"
				? "耗时：" + durText
				: "耗时：" + durText + "（" + fmtTime(startTs) + " → " + fmtTime(endTs) + "）");
			if (tone === "detailed") {
				lines.push("回合 " + ((record && record.turns) || task.turns || 0)
					+ " · 步骤 " + ((record && record.steps) || task.steps || 0)
					+ (((record && record.toolCalls) || task.toolCalls) ? " · 工具 " + ((record && record.toolCalls) || task.toolCalls) + " 次" : ""));
				lines.push("Token：输入 " + fmtNum((record && record.inputTokens) || task.inputTokens)
					+ " / 输出 " + fmtNum((record && record.outputTokens) || task.outputTokens));
				if (record && record.lastText) lines.push("摘要：" + truncate(record.lastText, 140));
				if (!success && record && record.errorMessage) lines.push("错误：" + truncate(record.errorMessage, 120));
			}
			pushToast({
				id: ++toastSeqRef.current,
				kind: success ? "success" : (info.cls === "err" ? "error" : "warn"),
				title,
				body: lines.join("\n"),
				// 绑定会话：点卡片直达该会话；用户点进这个会话（侧栏选中）也视为
				// 看到了结果，巡检 effect 据此自动收起卡片。没看过就一直挂着。
				// sessionId 是权威标识（跳转/对账都用它），标题只作旧宿主回退。
				sessionId: task.sessionId || "",
				sessionTitle: showTitle,
			});
		}
		// 提示音：任务结束时播放（完成/异常配套音）；与系统通知独立开关
		if (soundWanted) playDoneSound(success, cfg.soundEffect);
		// 系统通知：仅页面处于后台时推送，避免前台重复打扰
		if (systemWanted && typeof document !== "undefined" && document.hidden
			&& typeof Notification !== "undefined" && Notification.permission === "granted") {
			try {
				new Notification("dsh " + title, {
					body: showTitle + " · " + durText,
					tag: "dsh-dock-notify-" + task.sessionId,
				});
			} catch { /* 系统通知失败不影响页面内通知 */ }
		}
	};

	// Host 不可用（旧宿主未重启等）：浮层整体静默，面板页会给提示
	if (!snap.status) return null;
	if (toasts.length === 0) return null;
	// 卡片多了叠放收纳：≥3 张时只完整展开最新一张，其余收成"只剩标题条"；
	// 鼠标移到卡片栈上整体展开，移开收回。跳转/收起对每张卡照常可用。
	const stack = toasts.length >= 3 && !stackHover;
	return (
		<div className={"dknt-toasts" + (stack ? " stacked" : "")}
			onMouseEnter={() => setStackHover(true)}
			onMouseLeave={() => setStackHover(false)}>
			{toasts.map((t, i) => (
				<Toast key={t.id} t={t} collapsed={stack && i < toasts.length - 1}
					onClose={(id) => setToasts((prev) => prev.filter((x) => x.id !== id))} />
			))}
		</div>
	);
}

// ---------- 面板页 ----------
// 通知事件矩阵：纵向是事件，横向是渠道。每个格子对应 eventMatrix 里的一个布尔键，
// 未设置过的键回退到旧字段（见 eventEnabled），保证老配置升级后行为不变。
const MATRIX_COLUMNS = [
	{ id: "card", label: "页内卡片" },
	{ id: "sound", label: "提示音" },
	{ id: "system", label: "系统通知" },
	{ id: "voice", label: "语音播报" },
	{ id: "dingtalk", label: "钉钉" },
	{ id: "feishu", label: "飞书" },
];
const MATRIX_EVENTS = [
	{ id: "complete", label: "完成", desc: "任务正常结束" },
	{ id: "error", label: "异常", desc: "出错 / 中止 / 受阻 / 达上限" },
	{ id: "confirm", label: "需确认 / 需回答", desc: "工具等批准、提问等回答" },
	{ id: "stuck", label: "卡住", desc: "编程阶段长时间无活动" },
];
// 渠道支持哪些事件：提示音/系统通知没有「卡住」，群机器人只在任务结束时推送。
const MATRIX_SUPPORT = {
	card: ["complete", "error", "confirm", "stuck"],
	sound: ["complete", "error", "confirm"],
	system: ["complete", "error", "confirm"],
	voice: ["complete", "error", "confirm", "stuck"],
	dingtalk: ["complete", "error"],
	feishu: ["complete", "error"],
};
const MODE_OPTIONS = [["brief", "简洁"], ["medium", "适中"], ["detailed", "详细"]];

function ModePicker(props) {
	return (
		<span className="dknt-modes">
			{MODE_OPTIONS.map(([value, label]) => (
				<button type="button" key={value}
					className={"dknt-miniswitch" + (props.value === value ? " on" : "")}
					title={props.title ? props.title + "（" + label + "）" : label}
					onClick={() => props.onChange(value)}>{label}</button>
			))}
		</span>
	);
}

/** 渠道总开关状态（矩阵表头的小圆点用）。 */
function channelMasterOn(cfg, channel, voiceClientOn) {
	if (!cfg) return false;
	if (channel === "card") return cfg.notifyCards !== false;
	if (channel === "sound") return cfg.soundNotify !== false;
	if (channel === "system") return !!cfg.systemNotify;
	if (channel === "voice") return cfg.voiceNotify === true && voiceClientOn;
	if (channel === "dingtalk") return !!cfg.dingtalkEnabled;
	if (channel === "feishu") return !!cfg.feishuEnabled;
	return false;
}

function EventMatrix(props) {
	const { cfg, source, voiceClientOn, patch } = props;
	const toggle = (channel, event, on) => patch({ eventMatrix: withEventMatrix(cfg, channel, event, on) });
	return (
		<div className="dknt-matrix-wrap">
			<div className="dknt-matrix">
				<div className="dknt-matrix-row dknt-matrix-head">
					<span className="dknt-matrix-event">通知事件</span>
					{MATRIX_COLUMNS.map((column) => (
						<span key={column.id} className={"dknt-matrix-col" + (channelMasterOn(cfg, column.id, voiceClientOn) ? " on" : "")}>
							{column.label}
							<em>{channelMasterOn(cfg, column.id, voiceClientOn) ? "开" : "关"}</em>
						</span>
					))}
				</div>
				{MATRIX_EVENTS.map((ev) => (
					<div key={ev.id} className="dknt-matrix-row">
						<span className="dknt-matrix-event">
							<b>{ev.label}</b>
							<small>{ev.desc}</small>
						</span>
						{MATRIX_COLUMNS.map((column) => {
							const supported = MATRIX_SUPPORT[column.id].indexOf(ev.id) !== -1;
							const serverOnly = source === "client" && (column.id === "dingtalk" || column.id === "feishu");
							if (!supported) return <span key={column.id} className="dknt-cell dknt-cell-na" title="该渠道不支持此事件">—</span>;
							const on = eventEnabled(cfg, column.id, ev.id);
							return (
								<button type="button" key={column.id}
									className={"dknt-cell" + (on ? " on" : "") + (serverOnly ? " disabled" : "")}
									role="checkbox" aria-checked={on}
									disabled={serverOnly}
									title={serverOnly ? "群机器人推送由服务端执行，请切换到「服务端配置」修改" : on ? "取消该事件通过此渠道提醒" : "让该事件通过此渠道提醒"}
									onClick={() => { if (!serverOnly) toggle(column.id, ev.id, !on); }}>
									{on ? "✓" : ""}
								</button>
							);
						})}
					</div>
				))}
			</div>
			<div className="dknt-matrix-legend">
				<span><i className="dknt-dot on" /> 已勾选</span>
				<span><i className="dknt-dot" /> 未勾选</span>
				<span>「—」= 该渠道不支持此事件</span>
				{source === "client" ? <span>钉钉 / 飞书为服务端推送，需切回「服务端配置」修改</span> : null}
			</div>
		</div>
	);
}

function NotifyView(props) {
	const snap = useNotify();
	const voices = useLocalVoices(); // 音色下拉用（本机 speechSynthesis 音色表）
	const [voiceClientOn, setVoiceClientOn] = useVoiceClientEnabled(); // 本机播报开关（localStorage）
	const [source, setSource] = useNotifyConfigSource(); // 服务端 / 本机
	const [tab, setTab] = useState("events"); // events | channels | robots
	const [clientCfg, setClientCfg] = useState(() => readClientNotifyConfig());
	const [serverDraft, setServerDraft] = useState(null);
	const [saveErr, setSaveErr] = useState("");
	const [testing, setTesting] = useState(false);
	const [testState, setTestState] = useState(null); // { ok, msg } 钉钉测试结果
	const [feishuTesting, setFeishuTesting] = useState(false);
	const [feishuTestState, setFeishuTestState] = useState(null); // { ok, msg } 飞书测试结果
	const cfgRef = useRef(null);
	const pendingSavesRef = useRef(0); // 进行中的保存（轮询回包不覆盖乐观值）
	const editingWebhookRef = useRef(false); // 钉钉 Webhook 输入中（轮询不覆盖草稿）
	const editingFeishuRef = useRef(false); // 飞书 Webhook 输入中（轮询不覆盖草稿）
	const serverCfg = snap.status && snap.status.config;
	// 服务端配置（含保存回包）同步到本地编辑态；保存中/输入中不覆盖
	useEffect(() => {
		if (!serverCfg) return;
		if (pendingSavesRef.current > 0 || editingWebhookRef.current || editingFeishuRef.current) return;
		if (serverCfg !== cfgRef.current) {
			cfgRef.current = serverCfg;
			setServerDraft(Object.assign({}, serverCfg));
		}
	}, [snap.status]);
	// 切到本机配置时，第一次从服务端配置复制一份作为起点
	useEffect(() => {
		if (source !== "client" || clientCfg || !serverCfg) return;
		const clone = pickClientConfig(serverCfg);
		writeClientNotifyConfig(clone);
		setClientCfg(clone);
	}, [source, clientCfg, serverCfg]);
	// 面板打开时兜底拉一次（浮层通常已在轮询）
	useEffect(() => {
		if (!notifyStore.snap.status) notifyStore.refresh();
	}, []);
	const cfg = source === "client"
		? (clientCfg ? mergeClientNotifyConfig(serverCfg, clientCfg) : null)
		: (serverDraft || serverCfg);
	// 乐观更新 + 立即持久化：服务端模式写 settings，本机模式只写 localStorage。
	const patch = (p) => {
		setSaveErr("");
		if (source === "client") {
			const base = clientCfg || (serverCfg ? pickClientConfig(serverCfg) : {});
			const next = Object.assign({}, base, p);
			writeClientNotifyConfig(next);
			setClientCfg(next);
			notifyStore.touch();
			return Promise.resolve();
		}
		setServerDraft(Object.assign({}, cfg, p));
		pendingSavesRef.current++;
		return rpcCall("config", p)
			.then((d) => {
				pendingSavesRef.current--;
				notifyStore.applyConfig(d && d.config);
			})
			.catch((e) => {
				pendingSavesRef.current--;
				setSaveErr("保存失败：" + ((e && e.message) || String(e)));
			});
	};
	const chooseSource = (next) => {
		if (next === "client" && !clientCfg && serverCfg) {
			const clone = pickClientConfig(serverCfg);
			writeClientNotifyConfig(clone);
			setClientCfg(clone);
		}
		setSource(next);
		notifyStore.touch();
	};
	const copyFromServer = () => {
		if (!serverCfg) return;
		const clone = pickClientConfig(serverCfg);
		writeClientNotifyConfig(clone);
		setClientCfg(clone);
		notifyStore.touch();
	};
	// Webhook 草稿保存：清编辑态后立即对齐一次（同步 effect 在编辑期被跳过）
	const saveWebhook = async () => {
		if (!editingWebhookRef.current) return;
		const hook = String(cfg.dingtalkWebhook || "").trim();
		await patch({ dingtalkWebhook: hook });
		editingWebhookRef.current = false;
		const c = notifyStore.snap.status && notifyStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setServerDraft(Object.assign({}, c));
		}
	};
	const saveFeishuWebhook = async () => {
		if (!editingFeishuRef.current) return;
		const hook = String(cfg.feishuWebhook || "").trim();
		await patch({ feishuWebhook: hook });
		editingFeishuRef.current = false;
		const c = notifyStore.snap.status && notifyStore.snap.status.config;
		if (c && c !== cfgRef.current) {
			cfgRef.current = c;
			setServerDraft(Object.assign({}, c));
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
				notifyStore.applyConfig(d && d.config);
				editingWebhookRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setServerDraft(Object.assign({}, cfg, { dingtalkWebhook: hook }));
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
				notifyStore.applyConfig(d && d.config);
				editingFeishuRef.current = false;
				cfgRef.current = (d && d.config) || cfgRef.current;
				setServerDraft(Object.assign({}, cfg, { feishuWebhook: hook }));
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

	const permNote = typeof Notification === "undefined"
		? "当前浏览器不支持系统通知"
		: Notification.permission === "granted" ? "已授权 · 仅页面后台时推送"
			: Notification.permission === "denied" ? "已被浏览器拒绝（需在浏览器权限设置里重新允许）" : "未授权 · 开启时会请求授权，仅页面后台时推送";

	const rows = [];
	if (!cfg) {
		rows.push(<div key="load" className="dknt-note">{snap.error ? "状态不可用：" + snap.error : (snap.loading ? "正在拉取通知状态…" : "等待通知状态")}</div>);
	} else {
		rows.push(
			<div key="source" className="dknt-source">
				<div className="dknt-source-info">
					<span className="dknt-source-title">配置来源</span>
					<span className="dknt-source-sub">{source === "server"
						? "设置保存在服务端，所有浏览器/设备共享"
						: "设置只保存在当前浏览器，不影响其他人"}</span>
				</div>
				<div className="dknt-seg" role="group" aria-label="通知配置来源">
					<button type="button" className={"dknt-seg-btn" + (source === "server" ? " on" : "")}
						aria-pressed={source === "server"} onClick={() => chooseSource("server")}>服务端配置</button>
					<button type="button" className={"dknt-seg-btn" + (source === "client" ? " on" : "")}
						aria-pressed={source === "client"} onClick={() => chooseSource("client")}>本机配置</button>
				</div>
				{source === "client" ? <button type="button" className="dknt-btn" onClick={copyFromServer}>从服务端复制</button> : null}
			</div>,
			<div key="tabs" className="dknt-tabs" role="tablist" aria-label="任务通知设置">
				{[
					["events", "按事件提醒"],
					["channels", "按渠道设置"],
					["robots", "群机器人"],
				].map(([id, label]) => (
					<button type="button" key={id} role="tab" aria-selected={tab === id}
						className={"dknt-tab" + (tab === id ? " on" : "")}
						onClick={() => setTab(id)}>{label}</button>
				))}
			</div>,
		);
		if (tab === "events") {
			rows.push(
				<div key="events" className="dknt-sec">
					<div className="dknt-sec-head">
						<span className="dknt-sec-title">通知事件</span>
						<span className="dknt-sec-sub">纵向是通知事件、横向是通知渠道；勾选表示「这个事件用这个渠道提醒」。渠道的总开关和详细设置在同页「按渠道设置」。</span>
					</div>
					<EventMatrix cfg={cfg} source={source} voiceClientOn={voiceClientOn} patch={patch} />
					<div className="dknt-note">「需确认 / 需回答」包含工具等待批准与会话提问等待回答两种「停在原地等人」；「卡住」只在编程阶段长时间没有动静时触发，等批准、等回答、命令在跑、正在压缩上下文都不算卡住。</div>
				</div>
			);
		} else if (tab === "channels") {
			rows.push(
				<div key="channels" className="dknt-channels">
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">页内卡片</span>
								<span className="dknt-channel-sub">右侧浮层通知卡；点卡片直达对应会话</span>
							</div>
							<button type="button" className={"dock-sw" + (cfg.notifyCards !== false ? " on" : "")}
								role="switch" aria-checked={cfg.notifyCards !== false} aria-label="开关页内卡片"
								onClick={() => patch({ notifyCards: cfg.notifyCards === false })} />
						</div>
						<div className="dknt-channel-body">
							<div className="dknt-row">
								<span className="dknt-row-label">正文口径</span>
								<ModePicker value={cardTone(cfg)} title="页内卡片正文" onChange={(v) => patch({ cardMode: v })} />
								<span className="dknt-row-sub">简洁＝任务与耗时 / 谁卡住；适中＝加模型、起止时间、停滞时长；详细＝全部（回合步骤、Token、摘要或错误、最后动作）</span>
							</div>
							<div className="dknt-row">
								<span className="dknt-row-label">卡片收纳</span>
								<span className="dknt-row-sub">所有卡片都不超时自动消失：结束卡没看过就一直挂着，点卡片或点进会话后收起；需确认卡挂到处理完；卡住卡挂到恢复活动。3 张及以上自动叠放成标题条，鼠标移上去整体展开。</span>
							</div>
							<div className="dknt-row">
								<span className="dknt-row-label">事件范围</span>
								<span className="dknt-row-sub">在「按事件提醒」的页内卡片列里勾选。</span>
							</div>
						</div>
					</div>
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">提示音</span>
								<span className="dknt-channel-sub">任务结束 / 需确认时播放，6 种音效可选</span>
							</div>
							<button type="button" className={"dock-sw" + (cfg.soundNotify !== false ? " on" : "")}
								role="switch" aria-checked={cfg.soundNotify !== false} aria-label="开关提示音"
								onClick={() => patch({ soundNotify: cfg.soundNotify === false })} />
						</div>
						{cfg.soundNotify !== false ? (
							<div className="dknt-channel-body">
								<div className="dknt-sounds">
									{Object.keys(SOUND_LIBRARY).map((key) => (
										<button type="button" key={key}
											className={"dknt-sound" + (cfg.soundEffect === key ? " on" : "")}
											onClick={() => patch({ soundEffect: key })}>
											<span className="dknt-sound-name">
												{SOUND_LIBRARY[key].name}
												{cfg.soundEffect === key ? <span className="dknt-sound-cur">✓</span> : null}
											</span>
											<span className="dknt-sound-play" role="button" tabIndex={0}
												title={"试听 " + SOUND_LIBRARY[key].name}
												onClick={(e) => { e.stopPropagation(); previewSound(key); }}
												onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); previewSound(key); } }}>▶</span>
										</button>
									))}
								</div>
								<div className="dknt-row">
									<span className="dknt-row-label">事件范围</span>
									<span className="dknt-row-sub">在「按事件提醒」的提示音列里勾选（支持完成 / 异常 / 需确认；卡住没有提示音）。</span>
								</div>
							</div>
						) : <div className="dknt-channel-off">未开启——任务事件不播放提示音。</div>}
					</div>
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">系统通知</span>
								<span className="dknt-channel-sub">浏览器系统通知，仅页面在后台时推送</span>
							</div>
							<button type="button" className={"dock-sw" + (cfg.systemNotify ? " on" : "")}
								role="switch" aria-checked={cfg.systemNotify} aria-label="开关系统通知"
								onClick={() => enableSystemNotify(!cfg.systemNotify)} />
						</div>
						<div className="dknt-channel-body">
							<div className="dknt-row">
								<span className="dknt-row-label">权限</span>
								<span className="dknt-row-sub">{permNote}</span>
							</div>
							<div className="dknt-row">
								<span className="dknt-row-label">事件范围</span>
								<span className="dknt-row-sub">在「按事件提醒」的系统通知列里勾选（支持完成 / 异常 / 需确认；卡住没有系统通知）。</span>
							</div>
						</div>
					</div>
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">语音播报</span>
								<span className="dknt-channel-sub">用浏览器语音（TTS）说一句话；服务端总开关 + 本机开关都开才播报</span>
							</div>
							<span className="dknt-sec-sw">
								<span className={"dknt-sec-swlabel" + (cfg.voiceNotify ? " on" : "")}>{cfg.voiceNotify ? "服务端：已开启" : "服务端：已关闭"}</span>
								<button type="button" className={"dock-sw" + (cfg.voiceNotify ? " on" : "")}
									role="switch" aria-checked={cfg.voiceNotify} aria-label="开关语音播报（服务端总开关）"
									disabled={source === "client"}
									title={source === "client" ? "服务端总开关需切换到「服务端配置」修改" : (cfg.voiceNotify ? "关闭语音播报（服务端总开关）" : "开启语音播报（服务端总开关）")}
									onClick={() => { if (source !== "client") patch({ voiceNotify: !cfg.voiceNotify }); }} />
							</span>
						</div>
						<div className="dknt-channel-body">
							<div className="dknt-row">
								<span className="dknt-row-label">本机播报</span>
								<button type="button" className={"dknt-miniswitch" + (voiceClientOn ? " on" : "")}
									role="switch" aria-checked={voiceClientOn} aria-label="开关本机语音播报"
									title={voiceClientOn ? "关闭本机语音播报" : "开启本机语音播报"}
									onClick={() => setVoiceClientOn(!voiceClientOn)}>{voiceClientOn ? "开" : "关"}</button>
								<span className="dknt-row-sub">{voiceClientOn
									? "本浏览器会播报（设置保存在当前浏览器；服务端总开关关闭时不生效）"
									: "本浏览器不播报（设置保存在当前浏览器，不影响其他浏览器）"}</span>
							</div>
							{cfg.voiceNotify ? (
								<>
									<div className="dknt-row">
										<span className="dknt-row-label">播报口径</span>
										<ModePicker value={voiceTone(cfg)} title="语音播报" onChange={(v) => patch({ voiceMode: v })} />
										<span className="dknt-row-sub">简洁：一句「任务完成 / 任务停止了 / 任务需要授权 / 主任务（或子任务）·标题 卡住了」；适中：点名任务，结束带原因与耗时、卡住带停滞时长；详细：结束带回合统计与回复摘要，需授权带工具名，卡住带最后动作。</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">播报事件</span>
										<span className="dknt-row-sub">在「按事件提醒」的语音播报列里勾选（支持完成 / 异常 / 需确认 / 卡住）。</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">语速</span>
										<input type="range" min="0.5" max="2" step="0.05" value={String(cfg.voiceRate || 1)}
											aria-label="播报语速" style={{ width: 120, accentColor: "var(--dk-accent)" }}
											onChange={(e) => patch({ voiceRate: Number(e.target.value) || 1 })} />
										<span className="dknt-row-sub">{Number(cfg.voiceRate || 1).toFixed(2)}×（播报比正文朗读略快更利落）</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">音量</span>
										<input type="range" min="0" max="1" step="0.05" value={String(cfg.voiceVolume == null ? 1 : cfg.voiceVolume)}
											aria-label="播报音量" style={{ width: 120, accentColor: "var(--dk-accent)" }}
											onChange={(e) => patch({ voiceVolume: Number(e.target.value) })} />
										<span className="dknt-row-sub">{Math.round((cfg.voiceVolume == null ? 1 : cfg.voiceVolume) * 100)}%</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">音色</span>
										<select className="dknt-input" style={{ maxWidth: 260 }} value={cfg.voiceURI || ""}
											aria-label="播报音色"
											onChange={(e) => patch({ voiceURI: e.target.value })}>
											<option value="">自动（按语言挑）</option>
											{(() => {
												// 与【语音朗读】同款分组：中文在前，其余按语言名排序，长列表也能找
												const zh = [], other = [];
												for (const v of voices) {
													if (!v || !v.voiceURI) continue;
													if (/^zh/i.test(String(v.lang || ""))) zh.push(v); else other.push(v);
												}
												const groups = [];
												if (zh.length) groups.push(["中文音色", zh]);
												if (other.length) groups.push(["其他音色", other]);
												return groups.map(([gname, vs]) => (
													<optgroup key={gname} label={gname}>
														{vs.map((v) => (
															<option key={v.voiceURI} value={v.voiceURI}>
																{(v.name || v.voiceURI) + "（" + (v.lang || "?") + "）"}
															</option>
														))}
													</optgroup>
												));
											})()}
										</select>
										<span className="dknt-row-sub">{voices.length
											? "音色是本机浏览器给的，换设备可能要重选；本机找不到所选音色时自动按语言回落"
											: "本机暂未读到音色（系统语音未装/未启用），将按语言自动挑"}</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">试听</span>
										<button type="button" className="dknt-btn" disabled={!voiceSupported()}
											onClick={() => {
												const preview = Object.assign({}, cfg, { voiceNotify: true });
												speakVoice(endBroadcastText(true, { title: "示例任务", duration: 125000, turns: 3, steps: 9, toolCalls: 4, lastText: "好的，三份文档都已更新完毕。" }, null, preview), preview);
											}}>播一句</button>
										<button type="button" className="dknt-btn" disabled={!voiceSupported()}
											onClick={() => {
												const preview = Object.assign({}, cfg, { voiceNotify: true });
												speakVoice(confirmBroadcastText({ title: "示例任务" }, { toolName: "pwsh" }, preview), preview);
											}}>需授权</button>
										<span className="dknt-row-sub">{voiceSupported()
											? "浏览器语音合成（与【语音朗读】同一套声音，独立开关；打断式——播报信时正在朗读的正文会让位）"
											: "本浏览器不支持语音合成（speechSynthesis 不可用）"}</span>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">语言</span>
										<select className="dknt-input" style={{ maxWidth: 180 }} value={cfg.voiceLang || ""}
											aria-label="播报语言"
											onChange={(e) => patch({ voiceLang: e.target.value })}>
											<option value="">自动（中文优先）</option>
											{["zh-CN", "zh-TW", "en-US", "en-GB", "ja-JP", "ko-KR"].map((l) => (
												<option key={l} value={l}>{l}</option>
											))}
										</select>
										<span className="dknt-row-sub">未指定音色时按语言自动挑；已选音色的语言会覆盖这里</span>
									</div>
								</>
							) : <div className="dknt-channel-off">服务端总开关未开启——任务事件不播报语音；上面的「本机播报」只决定本浏览器是否出声。</div>}
						</div>
					</div>
				</div>
			);
		} else {
			rows.push(
				<div key="robots" className="dknt-channels">
					{source === "client" ? <div className="dknt-note dknt-note-box">群机器人推送由服务端执行，始终使用服务端配置；请切换到「服务端配置」修改。</div> : null}
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">钉钉推送</span>
								<span className="dknt-channel-sub">任务结束推送到钉钉群机器人（宿主直发，浏览器关着也能推）</span>
							</div>
							<span className="dknt-sec-sw">
								<span className={"dknt-sec-swlabel" + (cfg.dingtalkEnabled ? " on" : "")}>{cfg.dingtalkEnabled ? "已开启" : "已关闭"}</span>
								<button type="button" className={"dock-sw" + (cfg.dingtalkEnabled ? " on" : "")}
									role="switch" aria-checked={cfg.dingtalkEnabled} aria-label="开关钉钉推送"
									disabled={source === "client"}
									onClick={() => { if (source !== "client") patch({ dingtalkEnabled: !cfg.dingtalkEnabled }); }} />
							</span>
						</div>
						{source === "client" ? <div className="dknt-channel-off">本机配置模式不修改群机器人；切回服务端配置后可编辑 Webhook。</div>
							: !cfg.dingtalkEnabled ? <div className="dknt-channel-off">未开启——任务结束不推送钉钉。</div> : (
								<div className="dknt-channel-body">
									<div className="dknt-row">
										<span className="dknt-row-label">消息口径</span>
										<ModePicker value={cfg.pushMode || "detailed"} title="钉钉消息" onChange={(v) => patch({ pushMode: v })} />
										<span className="dknt-row-sub">简洁＝任务与结果；适中＝加模型/耗时；详细＝再加回合、Token 与摘要。</span>
									</div>
									<div className="dknt-row dknt-row-webhook">
										<span className="dknt-row-label">Webhook</span>
										<input type="text" className="dknt-input" spellCheck={false}
											value={cfg.dingtalkWebhook || ""}
											placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
											onChange={(e) => {
												editingWebhookRef.current = true;
												setServerDraft(Object.assign({}, cfg, { dingtalkWebhook: e.target.value }));
											}} />
										<button type="button" className="dknt-btn" disabled={!editingWebhookRef.current}
											onClick={saveWebhook}>
											{editingWebhookRef.current ? "保存" : "已保存"}
										</button>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">连通测试</span>
										<button type="button" className="dknt-btn" disabled={testing} onClick={runDingtalkTest}>
											{testing ? "发送中…" : "发送测试消息"}
										</button>
										{testState ? <span className={"dknt-row-sub" + (testState.ok ? " dknt-ok" : " dknt-err")}>
											{testState.ok ? "✓ " : "✗ "}{testState.msg}
										</span> : <span className="dknt-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
									</div>
									<div className="dknt-note">机器人创建：钉钉群 → 设置 → 智能群助手 → 添加机器人 → 自定义（Webhook），安全设置选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
								</div>
							)}
					</div>
					<div className="dknt-channel">
						<div className="dknt-channel-head">
							<div className="dknt-channel-title-wrap">
								<span className="dknt-channel-title">飞书推送</span>
								<span className="dknt-channel-sub">任务结束以卡片形式推送到飞书群机器人（宿主直发）</span>
							</div>
							<span className="dknt-sec-sw">
								<span className={"dknt-sec-swlabel" + (cfg.feishuEnabled ? " on" : "")}>{cfg.feishuEnabled ? "已开启" : "已关闭"}</span>
								<button type="button" className={"dock-sw" + (cfg.feishuEnabled ? " on" : "")}
									role="switch" aria-checked={cfg.feishuEnabled} aria-label="开关飞书推送"
									disabled={source === "client"}
									onClick={() => { if (source !== "client") patch({ feishuEnabled: !cfg.feishuEnabled }); }} />
							</span>
						</div>
						{source === "client" ? <div className="dknt-channel-off">本机配置模式不修改群机器人；切回服务端配置后可编辑 Webhook。</div>
							: !cfg.feishuEnabled ? <div className="dknt-channel-off">未开启——任务结束不推送飞书。</div> : (
								<div className="dknt-channel-body">
									<div className="dknt-row">
										<span className="dknt-row-label">消息口径</span>
										<ModePicker value={cfg.pushMode || "detailed"} title="飞书消息" onChange={(v) => patch({ pushMode: v })} />
										<span className="dknt-row-sub">简洁＝任务与结果；适中＝加模型/耗时；详细＝再加回合、Token 与摘要。</span>
									</div>
									<div className="dknt-row dknt-row-webhook">
										<span className="dknt-row-label">Webhook</span>
										<input type="text" className="dknt-input" spellCheck={false}
											value={cfg.feishuWebhook || ""}
											placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
											onChange={(e) => {
												editingFeishuRef.current = true;
												setServerDraft(Object.assign({}, cfg, { feishuWebhook: e.target.value }));
											}} />
										<button type="button" className="dknt-btn" disabled={!editingFeishuRef.current}
											onClick={saveFeishuWebhook}>
											{editingFeishuRef.current ? "保存" : "已保存"}
										</button>
									</div>
									<div className="dknt-row">
										<span className="dknt-row-label">连通测试</span>
										<button type="button" className="dknt-btn" disabled={feishuTesting} onClick={runFeishuTest}>
											{feishuTesting ? "发送中…" : "发送测试消息"}
										</button>
										{feishuTestState ? <span className={"dknt-row-sub" + (feishuTestState.ok ? " dknt-ok" : " dknt-err")}>
											{feishuTestState.ok ? "✓ " : "✗ "}{feishuTestState.msg}
										</span> : <span className="dknt-row-sub">用当前保存的 Webhook 发一条测试消息</span>}
									</div>
									<div className="dknt-note">机器人创建：飞书群 → 设置 → 群机器人 → 添加机器人 → 自定义机器人（获取 Webhook 地址）；安全设置如选「自定义关键词」填「任务」或「dsh」（推送标题含「任务」即可命中）。</div>
								</div>
							)}
					</div>
				</div>
			);
		}
	}
	if (saveErr) rows.push(<div key="err" className="dknt-note dknt-err">{saveErr}</div>);
	// 任务运行状态（进行中 / 最近完成 / 等人介入）已独立成左侧「运行状态」菜单项，这里只留一句指路
	rows.push(
		<div key="hint" className="dknt-note">
			任务运行状态（进行中任务、等人介入（等批准 / 等回答）与最近完成）已独立成左侧「运行状态」菜单；本页只负责结束与需确认 / 需回答时的提醒。
		</div>
	);
	return <div className="dknt-root">{rows}</div>;
}

// ---------- 首页总揽概要 ----------
// 任务进行中 / 空闲这类任务信息归【运行状态】模块，这里只报通知自身的状态：
// 通知事件 + 提醒方式 + 已开启的推送通道，与面板页开关一一对应。
function NotifyStat(props) {
	const snap = useNotify(props && props.ctx);
	const cfg = snap.status ? effectiveNotifyConfig(snap.status.config) : null;
	if (snap.error) return <span className="dknt-err">通知状态不可用（宿主需重启加载通知路由）</span>;
	if (!cfg) return <span>等待通知配置…</span>;
	const anyChannel = (event) => MATRIX_COLUMNS.some((column) => eventEnabled(cfg, column.id, event));
	const events = [
		anyChannel("complete") ? "完成" : "",
		anyChannel("error") ? "异常" : "",
		anyChannel("confirm") ? "需确认/需回答" : "",
		anyChannel("stuck") ? "卡住" : "",
	].filter(Boolean);
	const voiceMode = cfg.voiceMode === "detailed" ? "·详" : cfg.voiceMode === "medium" ? "·适" : "·简";
	const voice = !cfg.voiceNotify ? "" : (voiceClientEnabled() ? "语音播报" + voiceMode : "语音播报·本机已关");
	const extras = [cfg.soundNotify !== false ? "提示音" : "", cfg.systemNotify ? "系统通知" : "", voice].filter(Boolean);
	const push = [cfg.dingtalkEnabled ? "钉钉" : "", cfg.feishuEnabled ? "飞书" : ""].filter(Boolean);
	return <span>{(events.length ? "通知：" + events.join("/") : "通知事件全关")
		+ (extras.length ? " · " + extras.join("/") : "")
		+ (push.length ? " · 推送：" + push.join("/") : "")}</span>;
}

// ---------- 样式（dknt- 前缀；全部走主题变量，暗/亮色自适应） ----------
const css = [
	// 通知卡片栈（右上角，不遮 dsh 自身 UI）
	".dknt-toasts{position:fixed;top:16px;right:16px;z-index:7;display:flex;flex-direction:column;gap:8px;width:min(380px,calc(100vw - 32px));}",
	".dknt-toast{border-radius:12px;padding:12px 14px;pointer-events:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 36px rgb(0 0 0 / .22);animation:dknt-toast-in .32s var(--ds-ease-in-out);}",
	".dknt-toast.out{animation:dknt-toast-out .24s var(--ds-ease-in-out) forwards;}",
	"@keyframes dknt-toast-in{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}",
	"@keyframes dknt-toast-out{to{opacity:0;transform:translateX(10px)}}",
	".dknt-toast-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}",
	".dknt-toast-mark{width:8px;height:8px;border-radius:50%;flex:none;}",
	".dknt-toast-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
	".dknt-toast-close{cursor:pointer;flex:none;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:6px;width:22px;height:22px;font-size:11px;line-height:1;display:inline-flex;align-items:center;justify-content:center;font-family:inherit;}",
	".dknt-toast-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}",
	".dknt-toast-body{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.7;white-space:pre-line;word-break:break-word;}",
	// 需确认卡片：琥珀描边 + 缓慢呼吸光晕，常驻提醒直到用户处理
	".dknt-toast-confirm{border-color:color-mix(in srgb,var(--dk-warn) 55%,transparent);animation:dknt-toast-in .32s var(--ds-ease-in-out),dknt-confirm-glow 2.4s ease-in-out 0.4s infinite;}",
	"@keyframes dknt-confirm-glow{0%,100%{box-shadow:0 10px 36px rgb(0 0 0 / .22),0 0 0 0 color-mix(in srgb,var(--dk-warn) 30%,transparent)}50%{box-shadow:0 10px 36px rgb(0 0 0 / .22),0 0 14px 2px color-mix(in srgb,var(--dk-warn) 32%,transparent)}}",
	"@media (prefers-reduced-motion:reduce){.dknt-toast,.dknt-toast-confirm{animation:none}}",
	// 可跳转卡片：指针 + 悬停提亮（点卡片直达对应会话）
	".dknt-toast.clickable{cursor:pointer;}",
	".dknt-toast.clickable:hover{border-color:var(--dk-accent);}",
	// 叠放收纳：≥3 张时旧卡收成"只剩标题条"，悬停卡片栈整体展开
	".dknt-toasts.stacked{gap:4px;}",
	".dknt-toast.collapsed{padding:6px 14px;opacity:.85;margin-left:14px;}",
	".dknt-toast.collapsed .dknt-toast-head{margin-bottom:0;}",
	// 面板页布局
	".dknt-root{display:flex;flex-direction:column;gap:10px;}",
	".dknt-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dknt-err{color:var(--dsw-alias-state-error-primary);}",
	".dknt-ok{color:var(--dsw-alias-state-success-primary);}",
	".dknt-sec{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;}",
	".dknt-sec-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
	".dknt-sec-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);flex:none;}",
	".dknt-sec-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);flex:1;min-width:120px;}",
	".dknt-sec-sw{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;}",
	".dknt-sec-swlabel{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;}",
	".dknt-sec-swlabel.on{color:var(--dsw-alias-state-success-primary);}",
	// 子选项行
	".dknt-rows-narrow{display:flex;flex-direction:column;gap:6px;}",
	".dknt-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);flex-wrap:wrap;}",
	".dknt-row-label{flex:none;min-width:60px;color:var(--dsw-alias-label-primary);}",
	".dknt-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-miniswitch{cursor:pointer;flex:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-tertiary);border-radius:999px;padding:1px 12px;font-family:inherit;font-size:11px;line-height:18px;}",
	".dknt-miniswitch.on{color:var(--dsw-alias-state-success-primary);border-color:currentColor;}",
	// 配置来源与页签
	".dknt-source{display:flex;align-items:center;gap:10px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;}",
	".dknt-source-info{display:flex;flex-direction:column;gap:2px;flex:1;min-width:180px;}",
	".dknt-source-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary);}",
	".dknt-source-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;flex:none;}",
	".dknt-seg-btn{cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;padding:5px 12px;}",
	".dknt-seg-btn + .dknt-seg-btn{border-left:1px solid var(--dsw-alias-border-l2);}",
	".dknt-seg-btn.on{background:var(--dk-accent-soft);color:var(--dk-accent);font-weight:600;}",
	".dknt-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding:0 2px;}",
	".dknt-tab{cursor:pointer;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;padding:7px 12px;border-bottom:2px solid transparent;margin-bottom:-1px;}",
	".dknt-tab.on{color:var(--dk-accent);border-bottom-color:var(--dk-accent);font-weight:600;}",
	// 事件 × 渠道矩阵
	".dknt-matrix-wrap{overflow-x:auto;}",
	".dknt-matrix{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden;min-width:620px;}",
	".dknt-matrix-row{display:grid;grid-template-columns:minmax(150px,1.4fr) repeat(6,minmax(56px,1fr));align-items:center;}",
	".dknt-matrix-row:nth-child(even){background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent);}",
	".dknt-matrix-head{background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1);}",
	".dknt-matrix-col{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);text-align:center;padding:7px 4px;display:flex;flex-direction:column;align-items:center;gap:1px;}",
	".dknt-matrix-col em{font-style:normal;font-size:10px;font-weight:400;color:var(--dsw-alias-label-tertiary);}",
	".dknt-matrix-col.on em{color:var(--dsw-alias-state-success-primary);}",
	".dknt-matrix-event{display:flex;flex-direction:column;gap:1px;padding:8px 10px;font-size:12px;color:var(--dsw-alias-label-primary);}",
	".dknt-matrix-event small{font-size:10px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-cell{justify-self:center;cursor:pointer;width:24px;height:24px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:transparent;font-family:inherit;font-size:12px;line-height:1;display:inline-flex;align-items:center;justify-content:center;margin:5px 0;}",
	".dknt-cell.on{border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary);}",
	".dknt-cell-na{cursor:default;border-style:dashed;color:var(--dsw-alias-label-tertiary);}",
	".dknt-cell.disabled{opacity:.4;cursor:not-allowed;}",
	".dknt-matrix-legend{display:flex;gap:12px;flex-wrap:wrap;padding-top:6px;font-size:10px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-matrix-legend span{display:inline-flex;align-items:center;gap:4px;}",
	".dknt-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary);display:inline-block;}",
	".dknt-dot.on{background:var(--dsw-alias-state-success-primary);}",
	// 渠道卡片
	".dknt-channels{display:flex;flex-direction:column;gap:10px;}",
	".dknt-channel{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}",
	".dknt-channel-head{display:flex;align-items:center;gap:10px;padding:10px 12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 45%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1);}",
	".dknt-channel-title-wrap{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}",
	".dknt-channel-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);}",
	".dknt-channel-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-channel-body{display:flex;flex-direction:column;gap:8px;padding:10px 12px;}",
	".dknt-channel-off{padding:10px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);}",
	".dknt-modes{display:inline-flex;gap:4px;flex:none;}",
	".dknt-note-box{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);}",
	// 音效选择卡（名称 + 播放键；选中态描边）
	".dknt-sounds{display:flex;gap:6px;flex-wrap:wrap;}",
	".dknt-sound{flex:1;min-width:104px;display:flex;align-items:center;justify-content:space-between;gap:6px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;font-family:inherit;transition:border-color .15s var(--ds-ease-in-out);}",
	".dknt-sound:hover{border-color:var(--dk-accent);}",
	".dknt-sound.on{border-color:var(--dk-accent);box-shadow:0 0 0 1px color-mix(in srgb,var(--dk-accent) 40%,transparent);}",
	".dknt-sound-name{font-size:12px;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:5px;}",
	".dknt-sound-cur{color:var(--dk-accent);font-size:11px;}",
	".dknt-sound-play{flex:none;cursor:pointer;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);}",
	".dknt-sound-play:hover{color:var(--dsw-alias-label-primary);border-color:currentColor;}",
	".dknt-input{flex:1;min-width:220px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 8px;font-size:12px;font-family:inherit;}",
	".dknt-input:focus{outline:none;border-color:var(--dk-accent);}",
	".dknt-row-webhook{flex-wrap:nowrap;}",
	".dknt-row-webhook .dknt-input{min-width:0;}",
	".dknt-btn{cursor:pointer;flex:none;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:4px 12px;font-family:inherit;font-size:12px;}",
	".dknt-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
	".dknt-btn[disabled]{opacity:.5;cursor:default;}",
].join("\n");

export const feature = {
	id: "notify",
	name: "任务通知",
	order: 140,
	accent: "#f59e0b",
	description: "任务完成/异常/需确认/需回答/卡住通知：服务端或本机配置、事件×渠道勾选、页内卡片/提示音/系统通知/语音播报/钉钉飞书推送（各自独立开关）",
	css,
	View: NotifyView,
	HomeStat: NotifyStat,
	Overlay: NotifyOverlay,
};
