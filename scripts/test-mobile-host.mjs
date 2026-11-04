// dsh-dock · 【手机适配】宿主半部契约测试
//
// 本模块的实现全部在客户端（features/mobile/view.js）：样式与行为在 Overlay 挂载时注入、
// 卸载时移除。宿主半部只保留一个 feature 描述符让开关能持久化，**不得**再做任何
// webServer.tapIndex 内联注入（否则关闭时需重启 dsh web 才能彻底摘除，违背「关闭彻底」）。
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { feature } from "../features/mobile/host.js";

// 1) 描述符：id/name/defaultEnabled 与客户端一致
assert.equal(feature.id, "mobile", "宿主 feature.id 必须是 mobile");
assert.equal(feature.name, "手机适配");
assert.equal(feature.defaultEnabled, false, "手机适配默认关闭（用户按需在功能坞开启）");
assert.equal(typeof feature.setup, "function", "setup 必须是函数");

// 2) setup 无宿主副作用：返回可调用的清理函数，且不 throw（空 ctx 也不崩）
let dispose = null;
try {
	dispose = feature.setup({ inject() { throw new Error("不应调用 ctx.inject"); }, effect() {}, get() { return undefined; }, on() {} });
} catch (e) {
	assert.fail("setup 不应依赖宿主能力而抛错：" + ((e && e.message) || e));
}
assert.equal(typeof dispose, "function", "setup 必须返回 disposer");
dispose();

// 3) 源码层面：宿主半部不得出现 tapIndex（禁止内联注入 index.html）
const hostSrc = readFileSync(new URL("../features/mobile/host.js", import.meta.url), "utf8");
assert.ok(!/\.tapIndex\s*\(/.test(hostSrc), "host.js 不应再使用 webServer.tapIndex() 注入");

// 4) 客户端运行时注入契约要点都在
const viewSrc = readFileSync(new URL("../features/mobile/view.js", import.meta.url), "utf8");
for (const marker of [
	"data-dsh-mobile-runtime",
	"data-dsh-mobile-stack",
	"data-dsh-mobile-legacy",
	"data-dk-mobile",
	"(max-width: 767px)",
	"export function mobileActive",
	"export function MobileOverlay",
	"applyRuntime",
]) {
	assert.ok(viewSrc.includes(marker), "view.js 缺少契约要素：" + marker);
}
// 5) 关闭彻底：运行时样式必须可移除（dispose 里 removeChild styleEl），且不写 <meta viewport>
assert.ok(/removeChild\(styleEl\)/.test(viewSrc), "view.js 卸载时必须移除运行时 <style>");
assert.ok(!/viewport-fit|meta\[name="viewport"\]/.test(viewSrc), "view.js 不得改 <meta viewport>");

console.log("mobile host: ok（最小宿主 / 开关占位 / 无 tapIndex 注入；客户端运行时注入 + 卸载移除契约齐备）");
