// dsh-dock · 功能模块【语音朗读】· 客户端视图
//
// 三部分组成：
//  1. TurnTail  —— 会话每条回复下方（回合结束后的动作区）的「🔊 朗读」按钮：点一下把这条
//                 回复读出来，正在读时变成「■ 停止」。同时是**自动朗读的触发点**——
//                 本条目只在 turn/end 落盘后才挂载，所以「刚挂载 + 时间够新」= 这一回合刚结束。
//  2. View      —— 功能坞面板页：音色/语速/音调/音量、自动朗读、内容清洗与长度上限、试听。
//  3. HomeStat  —— 首页总揽概要（自动朗读开/关 · 语速）。
//
// 朗读用的是浏览器自己的 Web Speech API（window.speechSynthesis），声音从**当前这台设备**
// 的扬声器出来；宿主（Node）侧没有这个能力，所以本功能的宿主半部只管配置持久化。
//
// ⚠️ 三条硬约束（都在这份文件里落实）：
//   1. 沙箱兼容：测试用例（scripts/test-client-views.mjs）在 node:vm 里跑构建产物，
//      那里没有 speechSynthesis / SpeechSynthesisUtterance 这些全局对象，**裸引用会抛
//      ReferenceError**。一律经 synth() 取（属性读 undefined 是安全的）。
//   2. 不用 useSyncExternalStore：测试用的极简 React 替身没有这个 hook。跨组件共享状态
//      一律 useState + 订阅（见 configStore / engine）。
//   3. fetch 用文档相对路径 "dsh-dock/tts/…"（反代子路径挂载契约，见用例 12）。
import react, { useState, useEffect, useRef } from "react";
import { stateOf, openPanel } from "../../src/shared.js";

// ---------- 语音合成入口（沙箱安全：绝不裸引用全局 speechSynthesis） ----------
function synth() {
	try {
		const g = typeof globalThis !== "undefined" ? globalThis : null;
		if (g && g.speechSynthesis) return g.speechSynthesis;
		if (typeof window !== "undefined" && window.speechSynthesis) return window.speechSynthesis;
	} catch { /* 取不到就当不支持 */ }
	return null;
}
function ttsSupported() {
	return synth() !== null && typeof globalThis.SpeechSynthesisUtterance === "function";
}
function makeUtterance(text) {
	try {
		const Ctor = typeof globalThis !== "undefined" && globalThis.SpeechSynthesisUtterance
			? globalThis.SpeechSynthesisUtterance
			: (typeof window !== "undefined" ? window.SpeechSynthesisUtterance : null);
		return Ctor ? new Ctor(text) : null;
	} catch { return null; }
}
/** 本机音色表（可能为空：Chrome 首次调用是异步加载，靠 voiceschanged 补）。 */
function localVoices() {
	const s = synth();
	if (!s) return [];
	try { return (typeof s.getVoices === "function" ? s.getVoices() : []) || []; } catch { return []; }
}

// ---------- 配置：宿主持久化 + 本地镜像兜底 ----------
const CONFIG_STORE_KEY = "dsh-dock/tts/v1";
const CONFIG_DEFAULTS = {
	autoPlay: false,
	autoPlayOnFinish: true,
	interruptOnNew: true,
	rate: 1,
	pitch: 1,
	volume: 1,
	voiceURI: "",
	lang: "",
	skipCode: true,
	skipTables: true,
	maxChars: 0,
	maxSentences: 0,
};
const NUMERIC_RANGE = { rate: [0.1, 10], pitch: [0, 2], volume: [0, 1], maxChars: [0, 200000], maxSentences: [0, 200] };
const BOOL_KEYS = ["autoPlay", "autoPlayOnFinish", "interruptOnNew", "skipCode", "skipTables"];
const NUM_KEYS = Object.keys(NUMERIC_RANGE);
const STR_KEYS = ["voiceURI", "lang"];

/** 把任意来源的配置对象规整成完整配置（未知键忽略、类型不符取默认、数值钳进区间）。 */
function normalizeConfig(raw) {
	const out = Object.assign({}, CONFIG_DEFAULTS);
	const src = raw && typeof raw === "object" ? raw : {};
	for (const k of BOOL_KEYS) if (typeof src[k] === "boolean") out[k] = src[k];
	for (const k of STR_KEYS) if (typeof src[k] === "string") out[k] = src[k].slice(0, 200);
	for (const k of NUM_KEYS) {
		if (typeof src[k] === "number" && Number.isFinite(src[k])) {
			const [lo, hi] = NUMERIC_RANGE[k];
			const step = k === "maxChars" || k === "maxSentences" ? Math.round(src[k]) : src[k];
			out[k] = Math.min(hi, Math.max(lo, step));
		}
	}
	return out;
}
function readLocalConfig() {
	try {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(CONFIG_STORE_KEY);
		return raw ? normalizeConfig(JSON.parse(raw)) : null;
	} catch { return null; }
}
function writeLocalConfig(cfg) {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(CONFIG_STORE_KEY, JSON.stringify(cfg));
	} catch { /* 隐私模式等写不进去，不影响本次使用 */ }
}

/**
 * 配置总线：宿主 tts 段为准，本地镜像兜底。
 * routeGone（宿主没有 /dsh-dock/tts 路由 = 宿主进程是旧版本，或本功能在宿主侧未启用）
 * 时**停止一切 POST**，改用 localStorage：手动朗读、自动朗读照常用，只是不跨设备同步。
 * 与【用量记录】chip 的 routeGone 闩锁同一个道理（405/404 是终态，重试无用）。
 */
const configStore = {
	value: readLocalConfig() || normalizeConfig({}),
	loaded: false,
	routeGone: false,
	note: "",
	listeners: new Set(),
};
function notifyConfig() {
	for (const fn of Array.from(configStore.listeners)) {
		try { fn(); } catch { /* 单个订阅者异常不影响其他 */ }
	}
}
function subscribeConfig(fn) {
	configStore.listeners.add(fn);
	return () => { configStore.listeners.delete(fn); };
}
function useConfig() {
	const [, force] = useState(0);
	useEffect(() => subscribeConfig(() => force((n) => n + 1)), []);
	return configStore.value;
}
function setConfig(patch, opts) {
	const next = normalizeConfig(Object.assign({}, configStore.value, patch && typeof patch === "object" ? patch : {}));
	configStore.value = next;
	writeLocalConfig(next);
	notifyConfig();
	if (opts && opts.skipHost) return Promise.resolve(next);
	if (configStore.routeGone) return Promise.resolve(next);
	return fetch("dsh-dock/tts/config", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(patch && typeof patch === "object" ? patch : {}),
	})
		.then(async (res) => {
			if (res.status === 404 || res.status === 405) {
				configStore.routeGone = true;
				configStore.note = "宿主侧没有语音朗读接口（重启 dsh web，或把本功能开关关掉再打开），配置暂只存在本浏览器";
				notifyConfig();
				return next;
			}
			const data = await res.json().catch(() => ({}));
			if (!res.ok || (data && data.ok === false)) {
				configStore.note = "保存配置失败：" + ((data && data.error && data.error.message) || ("HTTP " + res.status));
				notifyConfig();
				return next;
			}
			configStore.note = "";
			if (data && data.data && data.data.config) {
				const merged = normalizeConfig(data.data.config);
				configStore.value = merged;
				writeLocalConfig(merged);
			}
			notifyConfig();
			return configStore.value;
		})
		.catch(() => {
			configStore.note = "保存配置失败：网络不可达，配置暂只存在本浏览器";
			notifyConfig();
			return next;
		});
}
let hostConfigRequested = false;
/** 首次用到配置时向宿主拉一次（幂等）。宿主不可达则保持本地值。 */
function ensureConfigLoaded() {
	if (hostConfigRequested || configStore.routeGone) return;
	hostConfigRequested = true;
	fetch("dsh-dock/tts/status", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	})
		.then(async (res) => {
			if (res.status === 404 || res.status === 405) {
				configStore.routeGone = true;
				configStore.note = "宿主侧没有语音朗读接口（重启 dsh web，或把本功能开关关掉再打开），配置暂只存在本浏览器";
				notifyConfig();
				return;
			}
			const data = await res.json().catch(() => ({}));
			if (data && data.ok && data.data && data.data.config) {
				// 宿主持久化值优先；但本浏览器已经表态过的键不覆盖（多设备场景沿用 shared.js 的取舍）
				const local = readLocalConfig();
				const fromHost = normalizeConfig(data.data.config);
				configStore.value = local ? normalizeConfig(Object.assign({}, CONFIG_DEFAULTS, fromHost, local)) : fromHost;
				writeLocalConfig(configStore.value);
			}
			configStore.loaded = true;
			notifyConfig();
		})
		.catch(() => { /* 宿主不可达：本地值继续用 */ });
}

// ---------- Markdown → 可朗读的纯文本 ----------
/**
 * 会话正文是 Markdown，直接念会念出一堆符号。这里按「听起来像人话」清洗：
 * 代码块/表格按配置整段跳过，链接只留文字，标记符号一律去掉。
 * 返回的文本已经压成单段（换行→空格），分句交给 chunkForSpeech。
 */
export function plainForSpeech(md, cfg) {
	let t = String(md == null ? "" : md);
	if (!t.trim()) return "";
	t = t.replace(/\r\n?/g, "\n");
	// 围栏代码块
	t = t.replace(/```[\w+-]*(?:[^\n]*)\n([\s\S]*?)```/g, (_m, body) => {
		if (cfg && cfg.skipCode === false) return " " + String(body).replace(/[#*_`>]/g, " ") + " ";
		return " （此处有代码，略） ";
	});
	// 波浪号围栏与缩进代码（4 空格 / tab 开头且下一行也缩进）：保守处理，只去缩进
	t = t.replace(/^(?: {4}|\t)(.*)$/gm, (_m, body) => (cfg && cfg.skipCode === false ? " " + body : " "));
	// 行内代码：保留文字，去掉反引号
	t = t.replace(/`([^`\n]*)`/g, "$1");
	// 图片 → alt 文字；链接 → 锚文字
	t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, " $1 ");
	t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	t = t.replace(/<((?:https?|ftp|mailto):[^>\s]+)>/gi, " ");
	// 表格：整块跳过或把竖线换成停顿
	t = t.replace(/(^\s*\|.+\|[ \t]*(?:\n|$))+/gm, (block) => {
		if (cfg && cfg.skipTables === false) return block.replace(/\|/g, "，").replace(/[-:，]{2,}/g, "，");
		return " （此处有表格，略） ";
	});
	// 结构符号
	t = t.replace(/^\s{0,3}#{1,6}\s+/gm, " ");
	t = t.replace(/^\s{0,3}>+\s?/gm, " ");
	t = t.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, " ");
	t = t.replace(/^\s*(?:={3,}|-{3,}|\*{3,}|_{3,})\s*$/gm, " ");
	t = t.replace(/(\*\*|__|~~|\*|_)/g, " ");
	t = t.replace(/<[^>\n]{1,200}>/g, " ");
	// 压成单段
	t = t.replace(/\s*\n+\s*/g, " ").replace(/[ \t]{2,}/g, " ").trim();
	return t;
}

/** 取前 N 句（0=不限）；再按字数上限截断（0=不限），截断处补「（以下略）」。 */
export function capSpeechText(text, cfg) {
	let t = String(text || "");
	const sentences = cfg && typeof cfg.maxSentences === "number" && cfg.maxSentences > 0
		? Math.round(cfg.maxSentences) : 0;
	if (sentences > 0) {
		const parts = splitSentences(t);
		if (parts.length > sentences) t = parts.slice(0, sentences).join("") + "（后面的内容略）";
	}
	const max = cfg && typeof cfg.maxChars === "number" && cfg.maxChars > 0 ? Math.round(cfg.maxChars) : 0;
	if (max > 0 && t.length > max) t = t.slice(0, max) + "…（以下略）";
	return t.trim();
}

/** 按中英文句末标点分句，保留分隔符（不用后行断言，兼容老内核与构建目标）。 */
function splitSentences(text) {
	const out = [];
	let cur = "";
	const re = /[^。！？；.!?;\n]+|[。！？；.!?;\n]+/g;
	let m;
	while ((m = re.exec(text)) !== null) {
		if (/[。！？；.!?;\n]/.test(m[0])) {
			cur += m[0];
			if (cur.trim()) out.push(cur);
			cur = "";
		} else {
			cur += m[0];
		}
	}
	if (cur.trim()) out.push(cur);
	return out;
}

/** 切成 ≤limit 字的片段：Chrome 长句合成会静默停住，分片 + 顺序播是标准解法。 */
function chunkForSpeech(text, limit) {
	const cap = limit && limit > 0 ? limit : 180;
	const sentences = splitSentences(String(text || ""));
	const chunks = [];
	let buf = "";
	for (const s of sentences) {
		if (s.length > cap) {
			if (buf) { chunks.push(buf); buf = ""; }
			for (let i = 0; i < s.length; i += cap) chunks.push(s.slice(i, i + cap));
			continue;
		}
		if ((buf + s).length > cap && buf) { chunks.push(buf); buf = s; }
		else buf += s;
	}
	if (buf.trim()) chunks.push(buf);
	return chunks;
}

/** 按配置挑音色：显式选过的音色必须在**本机**音色表里存在，否则按语言回落。 */
function pickVoice(cfg) {
	const voices = localVoices();
	if (voices.length === 0) return null;
	const want = String((cfg && cfg.voiceURI) || "");
	if (want) {
		const hit = voices.find((v) => v && v.voiceURI === want);
		if (hit) return hit; // 音色是设备相关的：别的机器上存的 voiceURI 在这里可能没有，落下面按语言挑
	}
	const lang = String((cfg && cfg.lang) || "");
	if (lang) {
		const base = lang.split("-")[0].toLowerCase();
		return voices.find((v) => String(v.lang || "").toLowerCase() === lang.toLowerCase())
			|| voices.find((v) => String(v.lang || "").toLowerCase().startsWith(base))
			|| null;
	}
	// 未指定语言：按文本大概率是中文，优先中文音色
	const zh = voices.find((v) => /^zh/i.test(String(v.lang || "")));
	return zh || null;
}

// ---------- 朗读引擎（模块级单例：全页面同时只有一个声音） ----------
const engine = {
	state: { playing: false, key: "", label: "" },
	listeners: new Set(),
	queue: [],
	epoch: 0,
};
function notifyEngine() {
	for (const fn of Array.from(engine.listeners)) {
		try { fn(); } catch { /* 订阅者异常不外溢 */ }
	}
}
function engineSnapshot() { return engine.state; }
function subscribeEngine(fn) {
	engine.listeners.add(fn);
	return () => { engine.listeners.delete(fn); };
}
function useEngineState() {
	const [snap, setSnap] = useState(engineSnapshot());
	useEffect(() => subscribeEngine(() => setSnap(engineSnapshot())), []);
	return snap;
}
function setEngineState(next) {
	engine.state = Object.assign({}, engine.state, next);
	notifyEngine();
}

/** 停止当前朗读（清队列）。幂等：不支持 TTS / 没在读也安全。 */
export function stopSpeech() {
	engine.queue = [];
	engine.epoch += 1;
	const s = synth();
	if (s) { try { s.cancel(); } catch { /* ignore */ } }
	setEngineState({ playing: false, key: "", label: "" });
}

/**
 * 朗读一段文本。
 * @param opts.key   - 幂等键（同一 key 正在读时重复调用被忽略；自动朗读靠它防重播）。
 * @param opts.label - 显示用短标签（按钮 title）。
 * @param opts.text  - 已清洗的纯文本。
 * @param opts.cfg   - 朗读配置；interruptOnNew=false 时排队而不是打断。
 * @returns 是否真的开始了播放（浏览器不支持时 false）。
 */
export function speak(opts) {
	const o = opts && typeof opts === "object" ? opts : {};
	const text = String(o.text || "").trim();
	if (!text) return false;
	if (!ttsSupported()) return false;
	const cfg = normalizeConfig(o.cfg || configStore.value);
	const key = String(o.key || ("k" + Date.now()));
	if (engine.state.playing && engine.state.key === key) return false;
	if (!cfg.interruptOnNew && engine.state.playing) {
		// 排队：只留最新一条，旧的不读（读两条没意义）
		engine.queue = [{ key, text, label: String(o.label || ""), cfg }];
		return false;
	}
	if (engine.state.playing) stopSpeech();
	const chunks = chunkForSpeech(text, 180);
	if (chunks.length === 0) return false;
	const epoch = ++engine.epoch;
	const voice = pickVoice(cfg);
	setEngineState({ playing: true, key, label: String(o.label || "") });
	const s = synth();
	let index = 0;
	const speakNext = () => {
		if (epoch !== engine.epoch) return; // 已被新的播放/停止取代
		if (index >= chunks.length) {
			setEngineState({ playing: false, key: "", label: "" });
			drainQueue();
			return;
		}
		const text = chunks[index];
		index += 1; // 先推进：onend/onerror 只负责「继续下一片」，不再各自加一次
		const utt = makeUtterance(text);
		if (!utt) { setEngineState({ playing: false, key: "", label: "" }); return; }
		utt.rate = cfg.rate;
		utt.pitch = cfg.pitch;
		utt.volume = cfg.volume;
		if (voice) { utt.voice = voice; if (voice.lang) utt.lang = voice.lang; }
		else if (cfg.lang) utt.lang = cfg.lang;
		utt.onend = () => { if (epoch !== engine.epoch) return; speakNext(); };
		// 分片之间被浏览器吃掉 onend 是已知问题：onerror 同样推进，坏一片不致整段哑掉
		utt.onerror = () => { if (epoch !== engine.epoch) return; speakNext(); };
		try { s.speak(utt); } catch { setEngineState({ playing: false, key: "", label: "" }); }
	};
	speakNext();
	return true;
}
function drainQueue() {
	const next = engine.queue.shift();
	engine.queue = [];
	if (next) speak({ key: next.key, text: next.text, label: next.label, cfg: Object.assign({}, next.cfg, { interruptOnNew: true }) });
}

/** 清洗 + 截断 + 播放，一条搞定（按钮与试听都走它）。 */
export function speakMarkdown(md, opts) {
	const o = opts && typeof opts === "object" ? opts : {};
	const cfg = normalizeConfig(o.cfg || configStore.value);
	const plain = capSpeechText(plainForSpeech(md, cfg), cfg);
	return speak({ key: o.key, label: o.label, text: plain, cfg });
}

// ---------- 从 turnTail owner 取本回合最后一条回复正文 ----------
function closingMarkdown(owner) {
	const turn = owner && owner.turn;
	const store = turn && turn.data;
	if (!store || typeof store.get !== "function") return "";
	let tail = null;
	try { tail = store.get("turn-tail"); } catch { return ""; }
	const closing = tail && tail.closing;
	const blocks = closing && Array.isArray(closing.blocks) ? closing.blocks : null;
	if (!blocks) return "";
	const parts = [];
	for (const b of blocks) if (b && b.kind === "text" && typeof b.text === "string") parts.push(b.text);
	return parts.join("");
}

// ---------- 图标（与宿主动作行的线性图标同风格：17px 描边） ----------
const ICON_SPEAKER = react.createElement("svg", {
	viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8",
	strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
},
	react.createElement("path", { d: "M11 5 6 9H3v6h3l5 4z" }),
	react.createElement("path", { d: "M15.5 8.5a5 5 0 0 1 0 7" }),
	react.createElement("path", { d: "M18.5 5.5a9 9 0 0 1 0 13" }),
);
const ICON_STOP = react.createElement("svg", {
	viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: "1.8",
	strokeLinejoin: "round", "aria-hidden": "true",
},
	react.createElement("rect", { x: "6.5", y: "6.5", width: "11", height: "11", rx: "2" }),
);

// ---------- 回合下方的喇叭按钮（手动朗读） ----------
/**
 * 宿主把本条目渲染在「已完成回合」的动作区之前（conversation.chat.turnTail 是 list 座位）。
 * 这里只负责**手动**朗读：点一下读这条回复。自动朗读在下面的 Overlay 里——
 * 它由宿主侧任务追踪驱动（与【任务通知】同一机制），不会在冷读历史会话时误播。
 */
function TtsTurnTail(props) {
	const owner = props || {};
	const cfg = useConfig();
	const eng = useEngineState();
	const md = closingMarkdown(owner);
	const turn = owner.turn;
	const turnNo = turn && typeof turn.turn === "number" ? turn.turn : -1;
	const key = String((owner && owner.sessionId) || "") + ":" + turnNo + ":" + (owner.seq || 0);
	const hasText = Boolean(md && md.trim());
	const supported = ttsSupported();
	// 本条目对应的正文是否正在朗读（eng.key 与 key 对上）
	const speaking = hasText && eng.playing && eng.key === key;

	useEffect(() => { ensureConfigLoaded(); }, []);

	if (!hasText) return null;
	const title = !supported
		? "本浏览器不支持语音合成（Web Speech API）"
		: speaking ? "停止朗读" : "朗读这条回复";
	return react.createElement("div", { className: "dktts-tail" },
		react.createElement("button", {
			type: "button",
			className: "dktts-btn" + (speaking ? " on" : "") + (supported ? "" : " off"),
			"aria-label": title,
			"aria-pressed": speaking,
			title,
			onClick: () => {
				if (!supported) return;
				ensureConfigLoaded();
				if (speaking) { stopSpeech(); return; }
				const plain = capSpeechText(plainForSpeech(md, configStore.value), configStore.value);
				speak({ key, text: plain, cfg: configStore.value, label: "第 " + (turnNo + 1) + " 回合" });
			},
		}, speaking ? ICON_STOP : ICON_SPEAKER),
		speaking ? react.createElement("span", { className: "dktts-hint" }, "正在朗读本回合 · 再点一下停止") : null);
}

// ---------- 自动朗读浮层：任务结束时读最后一条回复 ----------
/**
 * 与【任务通知】同一机制：轮询宿主侧会话级任务追踪（src/task-track.js），
 * 看到「新出现的结束记录」就读它的 lastText。
 *
 * 为什么不在回合尾节点里判断「回合刚结束」：冷读历史会话时那个节点也会挂载，
 * 只能靠时间差猜，既会误播也读不到后台会话；而宿主追踪的 agent idle 是
 * 「这个会话的任务真的跑完了」的权威信号（一个任务多轮也只记一次结束）。
 */
const BAD_END = { error: 1, aborted: 1, blocked: 1, "max-tokens": 1, interrupted: 1 };
function TtsOverlay() {
	const cfg = useConfig();
	const seenRef = useRef(null);
	const primedRef = useRef(false);

	// 配置拉取与轮询分开：默认值是关的，若不先拉宿主配置，autoPlay 永远起不来。
	useEffect(() => { ensureConfigLoaded(); }, []);

	useEffect(() => {
		if (!cfg.autoPlay) return undefined;
		if (!ttsSupported()) return undefined;
		if (seenRef.current === null) seenRef.current = new Set();
		let cancelled = false;
		const tick = () => {
			if (cancelled || configStore.routeGone) return;
			fetch("dsh-dock/tts/status", {
				method: "POST", headers: { "content-type": "application/json" }, body: "{}",
			})
				.then(async (res) => {
					if (res.status === 404 || res.status === 405) {
						configStore.routeGone = true;
						configStore.note = "宿主侧没有语音朗读接口（重启 dsh web，或把本功能开关关掉再打开），自动朗读暂不可用";
						notifyConfig();
						return;
					}
					if (!res.ok) return;
					const data = await res.json().catch(() => ({}));
					if (cancelled || !data || !data.ok || !data.data) return;
					const recent = Array.isArray(data.data.recent) ? data.data.recent : [];
					const seen = seenRef.current;
					// 首次拿到快照只登记、不朗读：页面刚打开时「最近完成」是历史，不该补读
					if (!primedRef.current) {
						for (const r of recent) seen.add(String(r.sessionId) + "|" + String(r.endTime));
						primedRef.current = true;
						return;
					}
					// 新记录按时间正序读（一轮里可能同时结束多个任务，读最新的那条就够）
					const fresh = [];
					for (const r of recent) {
						const k = String(r.sessionId) + "|" + String(r.endTime);
						if (seen.has(k)) continue;
						seen.add(k);
						fresh.push(r);
					}
					if (fresh.length === 0) return;
					if (seen.size > 500) seenRef.current = new Set([].concat(Array.from(seen).slice(-200)));
					const r = fresh[fresh.length - 1];
					const bad = BAD_END[String(r.endReason || "")] === 1;
					if (bad && configStore.value.autoPlayOnFinish === false) return;
					const text = String(r.lastText || "");
					if (!text.trim()) return;
					const plain = capSpeechText(plainForSpeech(text, configStore.value), configStore.value);
					speak({
						key: "auto:" + String(r.sessionId) + "|" + String(r.endTime),
						text: plain,
						cfg: configStore.value,
						label: (r.title || "任务") + (bad ? "（" + String(r.endReason) + "）" : "（已完成）"),
					});
				})
				.catch(() => { /* 宿主不可达：下一轮再试 */ });
		};
		tick();
		const timer = setInterval(tick, 1000);
		return () => { cancelled = true; clearInterval(timer); };
	}, [cfg.autoPlay]);

	return null;
}

// ---------- 面板页 ----------
function TtsRow(props) {
	return react.createElement("label", { className: "dktts-row" },
		react.createElement("span", { className: "dktts-label" }, props.label),
		react.createElement("span", { className: "dktts-ctl" }, props.children),
		props.note ? react.createElement("span", { className: "dktts-note" }, props.note) : null);
}
function TtsSwitch(props) {
	const on = props.value === true;
	return react.createElement("button", {
		type: "button",
		className: "dock-sw" + (on ? " on" : ""),
		role: "switch",
		"aria-checked": on,
		"aria-label": (on ? "停用" : "启用") + props.label,
		title: on ? "已启用（点击停用）" : "已停用（点击启用）",
		onClick: () => props.onChange(!on),
	}, on ? "已启用" : "已停用");
}

function TtsView() {
	const cfg = useConfig();
	const eng = useEngineState();
	const [, force] = useState(0);
	const [saved, setSaved] = useState("");
	const voices = useRef(localVoices());

	// 音色表在 Chrome 里是异步到位的：订阅 voiceschanged 后重渲染一次
	useEffect(() => {
		ensureConfigLoaded();
		const s = synth();
		if (!s || typeof s.addEventListener !== "function") return;
		const onChange = () => { voices.current = localVoices(); force((n) => n + 1); };
		try { s.addEventListener("voiceschanged", onChange); } catch { return; }
		return () => { try { s.removeEventListener("voiceschanged", onChange); } catch { /* ignore */ } };
	}, []);
	// 首次渲染时音色表可能已经在了但没触发事件：补一次读取
	useEffect(() => {
		if (voices.current.length === 0) { voices.current = localVoices(); force((n) => n + 1); }
	}, []);

	const list = voices.current;
	const supported = ttsSupported();
	const sample = "好的，我现在把这条回复读给你听。语速和音色可以在这里调，点「试听」就能立刻听到效果。";

	const patch = (p) => {
		setConfig(p);
		setSaved("已保存");
		setTimeout(() => setSaved(""), 1500);
	};
	const preview = () => {
		stopSpeech();
		speak({
			key: "preview:" + Date.now(),
			text: sample,
			cfg: configStore.value,
			label: "试听",
		});
	};

	// 音色按语言分组：中文在前，其余按语言名排序，长列表也能找
	const grouped = [];
	{
		const zh = [], other = [];
		for (const v of list) {
			if (!v || !v.voiceURI) continue;
			if (/^zh/i.test(String(v.lang || ""))) zh.push(v); else other.push(v);
		}
		if (zh.length) grouped.push(["中文音色", zh]);
		if (other.length) grouped.push(["其他音色", other]);
	}

	return react.createElement("div", { className: "dktts-root" },
		react.createElement("div", { className: "dktts-intro" },
			"眼睛不舒服时让 dsh 把回复读出来。用的是",
			react.createElement("b", null, "浏览器自带的语音合成"),
			"（Web Speech API），声音从你当前这台设备的扬声器出来，不消耗 token、不经过服务器。",
			"每条回复下方会出现一个", react.createElement("b", null, " 🔊 喇叭"),
			"，点一下就读这条；也可以打开「自动朗读」，回合结束后直接读最后一条回复。"),

		!supported
			? react.createElement("div", { className: "dktts-warn" },
				"这个浏览器不提供语音合成能力（speechSynthesis 不可用）。换 Chrome / Edge / Safari 即可；"
				+ "Linux 上的 Chromium 需要装语音包（如 espeak-ng），或在系统设置里添加语音。")
			: null,
		supported && list.length === 0
			? react.createElement("div", { className: "dktts-warn" },
				"本机暂时读不到任何音色。通常是系统还没装/没启用语音：Windows 到「设置 → 时间和语言 → 语音」添加中文语音，"
				+ "macOS 到「系统设置 → 无障碍 → 朗读内容」添加音色，然后刷新页面。")
			: null,

		react.createElement("div", { className: "dktts-card" },
			react.createElement("div", { className: "dktts-card-h" }, "朗读时机"),
			react.createElement(TtsRow, {
				label: "自动朗读",
				note: "回合结束后自动读最后一条回复；你正在看的这条会话才读，后台会话不读。",
			}, react.createElement(TtsSwitch, {
				label: "自动朗读", value: cfg.autoPlay, onChange: (v) => patch({ autoPlay: v }),
			})),
			react.createElement(TtsRow, {
				label: "出错 / 中止也读",
				note: "关闭后只在正常完成时读。",
			}, react.createElement(TtsSwitch, {
				label: "出错也读", value: cfg.autoPlayOnFinish, onChange: (v) => patch({ autoPlayOnFinish: v }),
			})),
			react.createElement(TtsRow, {
				label: "新内容打断当前朗读",
				note: "关闭则排队：新的那条等当前读完再读（只保留最新一条）。",
			}, react.createElement(TtsSwitch, {
				label: "打断", value: cfg.interruptOnNew, onChange: (v) => patch({ interruptOnNew: v }),
			}))),

		react.createElement("div", { className: "dktts-card" },
			react.createElement("div", { className: "dktts-card-h" }, "声音"),
			react.createElement(TtsRow, { label: "音色", note: "音色是本机浏览器给的，换设备可能要重选。" },
				react.createElement("select", {
					className: "dktts-select",
					value: cfg.voiceURI,
					onChange: (e) => patch({ voiceURI: e.target.value }),
				},
					react.createElement("option", { value: "" }, "自动（按语言挑）"),
					grouped.map(([gname, vs]) => react.createElement("optgroup", { key: gname, label: gname },
						vs.map((v) => react.createElement("option", {
							key: v.voiceURI, value: v.voiceURI,
						}, (v.name || v.voiceURI) + "（" + (v.lang || "?") + "）")))))),
			react.createElement(TtsRow, { label: "强制语言", note: "留空则中文文本优先挑中文音色。" },
				react.createElement("select", {
					className: "dktts-select",
					value: cfg.lang,
					onChange: (e) => patch({ lang: e.target.value }),
				},
					react.createElement("option", { value: "" }, "自动"),
					["zh-CN", "zh-TW", "en-US", "en-GB", "ja-JP", "ko-KR"].map((l) => react.createElement("option", {
						key: l, value: l,
					}, l)))),
			react.createElement(TtsRow, { label: "语速 " + cfg.rate.toFixed(2) + "×" },
				react.createElement("input", {
					type: "range", min: "0.5", max: "2", step: "0.05", value: String(cfg.rate),
					"aria-label": "语速",
					onChange: (e) => patch({ rate: Number(e.target.value) || 1 }),
				})),
			react.createElement(TtsRow, { label: "音调 " + cfg.pitch.toFixed(2) },
				react.createElement("input", {
					type: "range", min: "0", max: "2", step: "0.1", value: String(cfg.pitch),
					"aria-label": "音调",
					onChange: (e) => patch({ pitch: Number(e.target.value) }),
				})),
			react.createElement(TtsRow, { label: "音量 " + Math.round(cfg.volume * 100) + "%" },
				react.createElement("input", {
					type: "range", min: "0", max: "1", step: "0.05", value: String(cfg.volume),
					"aria-label": "音量",
					onChange: (e) => patch({ volume: Number(e.target.value) }),
				})),
			react.createElement("div", { className: "dktts-actions" },
				react.createElement("button", {
					type: "button", className: "dktts-primary", onClick: preview, disabled: !supported,
				}, "试听"),
				react.createElement("button", {
					type: "button", className: "dktts-ghost", onClick: () => stopSpeech(),
				}, "停止"),
				eng.playing ? react.createElement("span", { className: "dktts-playing" }, "正在朗读：" + (eng.label || "内容")) : null,
				saved ? react.createElement("span", { className: "dktts-saved" }, "✓ " + saved) : null)),

		react.createElement("div", { className: "dktts-card" },
			react.createElement("div", { className: "dktts-card-h" }, "念什么（回复正文的清洗）"),
			react.createElement(TtsRow, { label: "跳过代码块", note: "关闭则连代码一起念（只去符号）。" },
				react.createElement(TtsSwitch, { label: "跳过代码块", value: cfg.skipCode, onChange: (v) => patch({ skipCode: v }) })),
			react.createElement(TtsRow, { label: "跳过表格", note: "表格逐格念出来没有意义，默认跳过。" },
				react.createElement(TtsSwitch, { label: "跳过表格", value: cfg.skipTables, onChange: (v) => patch({ skipTables: v }) })),
			react.createElement(TtsRow, { label: "只读前 N 句", note: "0 = 不限。想只听结论时设 3~5 句。" },
				react.createElement("input", {
					type: "number", className: "dktts-num", min: "0", max: "200", step: "1",
					"aria-label": "只读前几句", value: String(cfg.maxSentences),
					onChange: (e) => patch({ maxSentences: Math.max(0, Math.round(Number(e.target.value) || 0)) }),
				})),
			react.createElement(TtsRow, { label: "字数上限", note: "0 = 不限；超出部分念「以下略」。" },
				react.createElement("input", {
					type: "number", className: "dktts-num", min: "0", max: "200000", step: "100",
					"aria-label": "字数上限", value: String(cfg.maxChars),
					onChange: (e) => patch({ maxChars: Math.max(0, Math.round(Number(e.target.value) || 0)) }),
				}))),

		react.createElement("div", { className: "dktts-note-line" },
			"提示：浏览器要求「先有用户手势才允许出声」。刚打开页面就自动朗读可能被浏览器拦掉——",
			"点一下页面上任意位置，或直接用回复下方的喇叭按钮。"),
		configStore.note ? react.createElement("div", { className: "dktts-warn" }, configStore.note) : null,
		configStore.routeGone ? react.createElement("div", { className: "dktts-links" },
			react.createElement("button", {
				type: "button", className: "dktts-ghost",
				onClick: () => { configStore.routeGone = false; hostConfigRequested = false; ensureConfigLoaded(); force((n) => n + 1); },
			}, "重试连接宿主")) : null);
}

// ---------- 首页总揽 ----------
function TtsStat() {
	const cfg = useConfig();
	useEffect(() => { ensureConfigLoaded(); }, []);
	return react.createElement("span", null,
		"自动朗读：", cfg.autoPlay ? "开" : "关",
		" · 语速 ", cfg.rate.toFixed(2), "×",
		cfg.autoPlay ? "" : "（回复下方点喇叭可手动读）");
}

const CSS = [
	".dktts-root{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;}",
	".dktts-intro{color:var(--dsw-alias-label-secondary);line-height:1.7;}",
	".dktts-intro b{color:var(--dsw-alias-label-primary);}",
	".dktts-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px;}",
	".dktts-card-h{font-weight:600;color:var(--dsw-alias-label-primary);padding-bottom:2px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:2px;}",
	".dktts-row{display:grid;grid-template-columns:132px minmax(120px,220px) 1fr;align-items:center;gap:10px;padding:3px 0;}",
	".dktts-label{color:var(--dsw-alias-label-primary);}",
	".dktts-ctl{display:flex;align-items:center;gap:8px;min-width:0;}",
	".dktts-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}",
	".dktts-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 8px;font-size:12px;}",
	".dktts-num{width:110px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 8px;font-size:12px;}",
	".dktts-row input[type='range']{width:100%;accent-color:var(--dk-accent);}",
	".dktts-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px;}",
	".dktts-primary,.dktts-ghost{border-radius:999px;padding:5px 14px;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}",
	".dktts-primary{border-color:var(--dk-accent);color:var(--dk-accent);}",
	".dktts-primary:disabled{opacity:.45;cursor:default;}",
	".dktts-playing{color:var(--dk-accent);font-size:12px;}",
	".dktts-saved{color:var(--dk-ok);font-size:12px;}",
	".dktts-warn{border:1px solid var(--dk-warn);color:var(--dk-warn);border-radius:8px;padding:8px 10px;font-size:12px;line-height:1.6;}",
	".dktts-note-line{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;}",
	".dktts-links{display:flex;gap:8px;}",
	// —— 回合下方的喇叭按钮：尺寸/配色对齐宿主消息动作行（ui-chat MessageIconActions .action）——
	".dktts-tail{display:flex;align-items:center;gap:8px;margin-top:4px;}",
	".dktts-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;}",
	".dktts-btn svg{width:17px;height:17px;}",
	".dktts-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);}",
	".dktts-btn.on{color:var(--dk-accent);}",
	".dktts-btn.off{opacity:.4;cursor:default;}",
	".dktts-btn.off:hover{background:transparent;color:var(--dsw-alias-label-tertiary);}",
	".dktts-hint{color:var(--dsw-alias-label-secondary);font-size:12px;}",
].join("\n");

export const feature = {
	id: "tts",
	name: "语音朗读",
	order: 160,
	accent: "#0ea5e9",
	description: "把会话回复读出来（浏览器语音合成）：回复下方点喇叭播放，或设置回合结束自动朗读",
	defaultEnabled: false,
	css: CSS,
	View: TtsView,
	HomeStat: TtsStat,
	// 回合下方的喇叭按钮（宿主 conversation.chat.turnTail 座位，见 src/client.jsx 的装配）
	TurnTail: TtsTurnTail,
	// 自动朗读的触发器（无 UI，只在功能启用时常驻挂载）
	Overlay: TtsOverlay,
};
