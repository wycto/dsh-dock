/**
 * dsh-dock · 功能模块提取脚手架：把 features/<id>/ 拎出来生成一个可独立发布的 dsh 插件包。
 *
 * 用法：node scripts/extract-feature.mjs <featureId> [--out <目录>]（默认 ../dsh-dock-<id>）
 *
 * 生成物（镜像 dock 仓库布局，保持模块内相对导入不变）：
 *   dsh-dock-<id>/
 *     index.js            宿主入口：包装 feature.setup 为独立 cordis 插件
 *     src/host-core.js    共享内核副本（sendJson/readBody 等）
 *     src/client-entry.js 独立客户端入口：dock 在场→dockBridge 注册进功能坞；
 *                         dock 缺席→自己的侧栏入口 + 全屏面板（与功能坞互不干扰）
 *     features/<id>/…     功能模块本体（host.js + view.js(x) 原样拷贝）
 *     scripts/build-client.mjs、cordis.patch.yml、package.json、README.md
 *
 * ⚠️ 脚手架性质：生成后按需裁剪依赖（package.json 的 dependencies 照搬自功能坞）、
 *   跑 node scripts/build-client.mjs 构建 client.js、实测两种形态后发布。
 *   回装验证要点：与 dsh-dock 同时安装时，独立入口应消失、功能坞菜单出现本功能（dockBridge 通道）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const featureId = args[0];
if (!featureId || featureId.startsWith("--")) {
	console.error("用法: node scripts/extract-feature.mjs <featureId> [--out <目录>]");
	process.exit(1);
}
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : join(root, "..", "dsh-dock-" + featureId);

const featDir = join(root, "features", featureId);
if (!existsSync(featDir)) {
	console.error(`未找到 features/${featureId}/（可用模块见 features/ 目录）`);
	process.exit(1);
}
if (existsSync(outDir)) {
	console.error(`目标目录已存在，换个 --out 或先删除：${outDir}`);
	process.exit(1);
}

const pkgName = "dsh-dock-" + featureId;
const dockPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

mkdirSync(outDir, { recursive: true });
cpSync(join(root, "src", "host-core.js"), join(outDir, "src", "host-core.js"));
cpSync(featDir, join(outDir, "features", featureId), { recursive: true });

// ---------- 宿主入口 ----------
writeFileSync(join(outDir, "index.js"), `// ${pkgName} · 宿主入口（由 dsh-dock scripts/extract-feature.mjs 生成的独立包）
// 本包从功能坞（dsh-dock）提取：宿主逻辑即原 features/${featureId}/host.js，行为一致。
import { feature } from './features/${featureId}/host.js'

export const name = '${pkgName}'

export function apply(ctx) {
	const dispose = feature.setup(ctx)
	// 插件卸载时停用功能（dock 内由功能坞的开关生命周期负责，独立包固定启用）
	if (typeof dispose === 'function') ctx.effect(() => dispose)
}
`);

// ---------- 独立客户端入口 ----------
writeFileSync(join(outDir, "src", "client-entry.js"), `// ${pkgName} · 独立客户端入口（浏览器）
// 双形态：装了 dsh-dock → 经 dockBridge 注册进功能坞菜单（不占独立入口）；
//         没装 dsh-dock → 自己的侧栏入口 + 全屏面板。
import react from "react";
import { feature } from "../features/${featureId}/view.js";

const name = "${pkgName}";
const inject = ["slots", "modules"];

function StandaloneView(props) {
	return react.createElement("div", { style: { padding: 16, color: "inherit" } },
		react.createElement(feature.View, props));
}

function StandalonePanel(props) {
	const [open, setOpen] = react.useState(true);
	if (!open) return null;
	return react.createElement("div", {
		style: {
			position: "fixed", inset: 0, zIndex: 9999, display: "flex", flexDirection: "column",
			background: "var(--dsw-alias-bg-layer-1, rgba(16,18,24,.97))",
			color: "var(--dsw-alias-label-primary, #e8eaf0)", fontFamily: "inherit",
		},
		onClick: (e) => e.stopPropagation(),
	},
		react.createElement("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", borderBottom: "1px solid var(--dsw-alias-border-l1, #2a2f3a)" } },
			react.createElement("span", { style: { fontWeight: 700, fontSize: 16 } }, feature.name),
			react.createElement("button", { type: "button", style: { marginLeft: "auto", cursor: "pointer" }, onClick: () => setOpen(false) }, "✕ 关闭")),
		react.createElement("div", { style: { flex: 1, overflow: "auto", padding: "12px 18px" } },
			react.createElement(StandaloneView, props)));
}

export function apply(ctx) {
	const slots = ctx.get("slots");
	if (slots === undefined) return;
	// 样式（模块自带 css + 外层容器黑底兜底）
	try {
		if (typeof document !== "undefined") {
			const tagId = "${pkgName}/panel.css";
			if (!document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
				const tag = document.createElement("style");
				tag.dataset.pluginCss = tagId;
				tag.textContent = (feature.css || "") + "\\n.standalone-host{background:var(--dsw-alias-bg-layer-1,#141720);color:var(--dsw-alias-label-primary,#e8eaf0);min-height:100%;}";
				document.head.appendChild(tag);
			}
		}
	} catch { /* 样式失败不阻断 */ }
	// dock 检测：modules.import("dsh-dock") 成功 = 功能坞在场 → 注册进面板；失败 → 独立形态。
	// （跨插件 import 是 DSH client-modules 官方通道：boot 图内任意已装插件的 client 模块可被 materialize）
	const modules = ctx.get("modules");
	const dockDef = {
		id: feature.id, name: feature.name, order: feature.order, accent: feature.accent,
		description: feature.description, css: feature.css,
		View: feature.View, HomeStat: feature.HomeStat, package: "${pkgName}",
	};
	if (modules && typeof modules.import === "function") {
		modules.import("dsh-dock").then((dockMod) => {
			if (dockMod && dockMod.dockBridge && typeof dockMod.dockBridge.register === "function") {
				dockMod.dockBridge.register(dockDef);
				return;
			}
			registerStandalone(slots);
		}, () => registerStandalone(slots));
	} else {
		registerStandalone(slots);
	}
}

function registerStandalone(slots) {
	slots.inject("sidebar.footer.action", () => slots.register(
		{ name: "sidebar.footer.action", id: "${pkgName}", order: 10, label: feature.name },
		(props) => {
			const wide = !!(props && props.wide);
			return react.createElement("button", {
				type: "button", title: feature.name, "aria-label": feature.name,
				style: { cursor: "pointer", border: "none", background: "transparent", color: "inherit", display: "inline-flex", alignItems: "center", gap: 6, height: 32, padding: "0 8px", fontFamily: "inherit", fontSize: 13 },
			}, "◆", wide ? feature.name : null);
		}));
	slots.inject("shell.overlay", () => slots.register(
		{ name: "shell.overlay", id: "${pkgName}-panel", order: 100, label: feature.name + "面板" },
		() => react.createElement(StandalonePanel, { ctx: null })));
}

export { inject };
export const dockFeature = feature;
`);

// ---------- 构建脚本（按本包改名） ----------
const dockBuild = readFileSync(join(root, "scripts", "build-client.mjs"), "utf8");
writeFileSync(
	join(outDir, "scripts", "build-client.mjs"),
	dockBuild
		.replace('const src = join(root, "src", "client.jsx");', 'const src = join(root, "src", "client-entry.js");')
		.replace(/PACKAGE_ID = "dsh-dock"/, `PACKAGE_ID = "${pkgName}"`)
		.replace(/exports\.dockBridge = dockBridge;\n\t\treturn module\.exports;/, "return module.exports;")
);

// ---------- cordis.patch.yml / package.json / README ----------
writeFileSync(join(outDir, "cordis.patch.yml"), `- insert:\n  - id: ${pkgName}\n    name: ${pkgName}\n`);

writeFileSync(join(outDir, "package.json"), JSON.stringify({
	name: pkgName,
	version: "0.1.0",
	description: `dsh-dock 功能坞「${feature.name || featureId}」模块的独立发布包（双形态：独立面板 / 回装功能坞）`,
	type: "module",
	main: "index.js",
	files: ["index.js", "client.js", "src/", "features/", "cordis.patch.yml"],
	exports: {
		".": "./index.js",
		"./client": "./client.js",
		"./package.json": "./package.json",
	},
	dsh: {
		bundle: { patch: "./cordis.patch.yml" },
		client: { platform: "web" },
	},
	keywords: ["dsh", "deepseek-harness", "cordis", "plugin", "dsh-dock", "feature", featureId],
	author: dockPkg.author,
	license: dockPkg.license,
	publishConfig: { access: "public" },
	dependencies: dockPkg.dependencies,
}, null, 2) + "\n");

writeFileSync(join(outDir, "README.md"), `# ${pkgName}

从 [dsh-dock](https://github.com/wycto/dsh-dock) 功能坞提取的独立功能包（\`${featureId}\`）。

## 双形态

- **独立使用**：\`dsh plugin --profile <p> add ${pkgName}\`，侧栏出现本功能入口 + 全屏面板。
- **装回功能坞**：与 dsh-dock 同时安装时，自动经 dockBridge 注册进功能坞菜单（独立入口隐藏）。

## 发布前

1. 裁剪 \`package.json\` 的 dependencies（只留本模块实际用到的）；
2. \`node scripts/build-client.mjs\` 构建 client.js；
3. 实测两种形态（含与 dsh-dock 共存时的菜单合并）。
`);

console.log("已生成独立包骨架:", outDir);
console.log("后续: 裁剪依赖 → node scripts/build-client.mjs → 实测双形态 → 发布");
