// dsh-dock · 功能模块【主题信息】· 客户端视图（纯 Client 功能，无宿主半部）
import react from "react";

function readThemeLabel(ctx) {
	const theme = ctx && ctx.get ? ctx.get("theme") : undefined;
	if (theme === undefined) return { err: "theme 服务不可用" };
	let snap = null;
	try { snap = theme.getTheme(); }
	catch (err) { return { err: "读取失败：" + String((err && err.message) || err) }; }
	const label = snap && typeof snap.id === "string" ? snap.id
		: snap && typeof snap.name === "string" ? snap.name : "未知";
	return { label };
}

function ThemeView(props) {
	const r = readThemeLabel(props && props.ctx);
	if (r.err) return react.createElement("div", null, r.err);
	return react.createElement("div", null, "当前主题：" + r.label);
}

function ThemeStat(props) {
	const r = readThemeLabel(props && props.ctx);
	if (r.err) return react.createElement("span", null, r.err);
	return react.createElement("span", null, "当前主题：" + r.label);
}

export const feature = {
	id: "theme",
	name: "主题信息",
	order: 150,
	accent: "#a78bfa",
	description: "示例功能：读取当前主题快照（纯 Client）",
	View: ThemeView,
	HomeStat: ThemeStat,
};
