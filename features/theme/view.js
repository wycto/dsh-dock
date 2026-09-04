// dsh-dock · 功能模块【主题信息】· 客户端视图（纯 Client 功能，无宿主半部）
import react from "react";
import { useEffect, useState } from "react";

// dsh 客户端主题服务（@deepseek-ai/dsh-client-ui-theme 的 ctx.provide("theme", ...)）快照结构：
//   { preference: 'light'|'dark'|'system', active: { id, colorScheme, tokens }, themes, revision }
// preference 是用户偏好；active.id 是解析后的实际生效主题（preference 为 system 时落到 light/dark）。
// 注意：快照顶层没有 id/name 字段——直接读 snap.id 只会得到 undefined（曾导致本页显示"未知"）。
const PREFERENCE_LABELS = { light: "亮色", dark: "暗色", system: "跟随系统" };
const THEME_LABELS = { light: "亮色", dark: "暗色" };

function readThemeInfo(ctx) {
	const theme = ctx && ctx.get ? ctx.get("theme") : undefined;
	if (!theme || typeof theme.getTheme !== "function") return { err: "theme 服务不可用" };
	let snap = null;
	try { snap = theme.getTheme(); } catch (err) { return { err: "读取失败：" + String((err && err.message) || err) }; }
	const preference = snap && typeof snap.preference === "string" ? snap.preference : "";
	const activeId = snap && snap.active && typeof snap.active.id === "string" ? snap.active.id : "";
	// 偏好 → 中文；system 且实际主题与偏好不同名时补注实际生效值（跟随系统 = 亮色/暗色）
	const label = (PREFERENCE_LABELS[preference] || preference || "未知")
		+ (activeId && activeId !== preference && THEME_LABELS[activeId] ? "（实际" + THEME_LABELS[activeId] + "）" : "");
	return { label };
}

function useThemeInfo(ctx) {
	const [info, setInfo] = useState(() => readThemeInfo(ctx));
	useEffect(() => {
		// 设置页「外观」行切换主题时实时刷新（快照 revision 递增，theme/change 事件广播）
		let off = null;
		try {
			if (ctx && typeof ctx.on === "function") {
				off = ctx.on("theme/change", () => setInfo(readThemeInfo(ctx)));
			}
		} catch { /* 无订阅能力时降级为静态显示 */ }
		return () => { try { if (typeof off === "function") off(); } catch { /* 清理失败静默 */ } };
	}, [ctx]);
	return info;
}

function ThemeView(props) {
	const r = useThemeInfo(props && props.ctx);
	if (r.err) return react.createElement("div", null, r.err);
	return react.createElement("div", null, "当前主题：" + r.label);
}

function ThemeStat(props) {
	const r = useThemeInfo(props && props.ctx);
	if (r.err) return react.createElement("span", null, r.err);
	return react.createElement("span", null, "主题：" + r.label);
}

export const feature = {
	id: "theme",
	name: "主题信息",
	order: 150,
	accent: "#a78bfa",
	description: "读取当前主题快照：偏好与实际生效主题（纯 Client，主题切换实时刷新）",
	defaultEnabled: false,
	View: ThemeView,
	HomeStat: ThemeStat,
};
