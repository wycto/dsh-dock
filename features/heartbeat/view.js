// dsh-dock · 功能模块【心跳监视】· 客户端视图（纯 Client 功能，无宿主半部）
import react from "react";

// 面板加载时刻：心跳视图与首页总揽共用的运行时长基准（同一数字，不分谁先挂载）
const loadedAt = Date.now();
function uptimeText() {
	const sec = Math.max(0, Math.floor((Date.now() - loadedAt) / 1000));
	const m = Math.floor(sec / 60);
	return "面板已运行 " + (m > 0 ? m + " 分 " : "") + (sec % 60) + " 秒";
}

function HeartbeatView(props) {
	const ctx = props && props.ctx;
	const [txt, setTxt] = react.useState(uptimeText());
	react.useEffect(() => (ctx && typeof ctx.interval === "function" ? ctx.interval(() => setTxt(uptimeText()), 1000) : undefined), []);
	return react.createElement("div", null, txt);
}

function HeartbeatStat(props) {
	const ctx = props && props.ctx;
	const [txt, setTxt] = react.useState(uptimeText());
	react.useEffect(() => (ctx && typeof ctx.interval === "function" ? ctx.interval(() => setTxt(uptimeText()), 1000) : undefined), []);
	return react.createElement("span", null, txt);
}

export const feature = {
	id: "heartbeat",
	name: "心跳监视",
	order: 140,
	accent: "#34d399",
	description: "示例功能：面板侧运行时长心跳（纯 Client）",
	View: HeartbeatView,
	HomeStat: HeartbeatStat,
};
