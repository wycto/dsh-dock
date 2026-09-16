/**
 * dsh-dock — Client(web) 增量构建监视脚本（本地开发用）
 *
 * 监视 src/ 与 features/（各模块 view.js(x) / view.css）下的客户端源码，
 * 有改动就自动调 build-client.mjs 的 buildClient() 重建 client.js。
 * DSH web 的 client-hmr 节点半部每 500ms stat-poll 一次各插件 client 半部的
 * 文件 mtime/size，client.js 一变就广播 /plugins/events SSE，浏览器换新版。
 * 所以这条链路的「自动刷新」= 本脚本负责重建 + dsh 内置 HMR 负责推浏览器。
 *
 * 用法：node scripts/watch-client.mjs
 *   （先跑 node scripts/dev-link-deps.mjs 生成 node_modules，或直接 pnpm install .devdeps）
 */
import { watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./build-client.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// 客户端源码目录（view 系 + 外壳/共享）：
const WATCH_DIRS = [join(root, "src"), join(root, "features")];

let dirty = new Set();
let timer = null;
let building = false;
let pending = false;

function schedule() {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 150);
}

async function flush() {
  if (dirty.size === 0) return;
  const files = [...dirty];
  dirty.clear();
  if (building) { pending = true; return; }
  building = true;
  console.log(`\n[dsh-dock watch] rebuild for ${files.length} file(s):`, files.map((f) => f.replace(root, ".")).join(", "));
  const t0 = Date.now();
  try {
    buildClient();
    console.log(`[dsh-dock watch] done in ${Date.now() - t0}ms — 浏览器 /plugins/events 会在 ≤500ms 内换新版`);
  } catch (e) {
    console.error(`[dsh-dock watch] build failed: ${e.message || e}`);
  } finally {
    building = false;
    if (pending) { pending = false; flush(); }
  }
}

function watchDir(dir) {
  try {
    // Node 20+ 支持 recursive（Linux 走非 inotify 的轮询/内核事件，够用）。
    const w = watch(dir, { recursive: true });
    w.on("change", (ev, name) => {
      if (!name) return;
      // 只关心 .js/.jsx/.css/.html/.md/.json（view 系）。
      if (!/\.(js|jsx|css|html|json)$/.test(name)) return;
      // 跳过 node_modules、build 产物本身。
      const p = join(dir, name);
      if (p.includes("node_modules") || p.endsWith("client.js") || p.endsWith("client.tmp.cjs")) return;
      dirty.add(p);
      schedule();
    });
    w.on("error", (e) => console.error(`[dsh-dock watch] ${dir} watcher error: ${e.message}`));
  } catch (e) {
    // 某些平台/文件系统不支持 recursive，退化为逐层手动 watch。
    watchDirFallback(dir);
  }
}

function watchDirFallback(dir) {
  const { readdirSync, statSync } = require("node:fs");
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
      watchDirFallback(p);
    } else if (entry.name.match(/\.(js|jsx|css|html|json)$/)) {
      watch(p).on("change", () => { dirty.add(p); schedule(); });
    }
  }
}

// 初次构建一次，然后开始监视。
buildClient();
for (const d of WATCH_DIRS) watchDir(d);
console.log(`[dsh-dock watch] 监视中：${WATCH_DIRS.map((d) => d.replace(root, ".")).join(", ")}（Ctrl+C 退出）`);
