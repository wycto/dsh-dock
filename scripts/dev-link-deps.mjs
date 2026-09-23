/**
 * dsh-dock — 本地开发依赖链接脚本
 *
 * 用 `dsh plugin add link:<repo>` 把本仓库装进 DSH profile 后，pnpm 不会为
 * `link:` 包安装任何依赖（实测：link: 的 deps 全部不装），而 Node 对 symlink
 * 走 realpath 解析，宿主提供的 @deepseek-ai/* 也不在仓库目录的 parent-walk
 * 上——于是宿主半部一 import 就 MODULE_NOT_FOUND。本脚本生成
 * `<repo>/node_modules` 链接（不写 lock、不装网络包）：
 *
 *   @deepseek-ai/*   → DSH 安装闭包（~/.dsh/profiles/node_modules，与宿主同一
 *                      模块实例；cordis 的 Service 等类身份敏感，绝不能装副本）
 *   js-yaml / qrcode → 本仓库 .devdeps/（devdeps install 的第三类运行时依赖）
 *   esbuild          → 本仓库 .devdeps/（构建用，build-client.mjs 本地解析命中）
 *
 * 用法：
 *   node scripts/dev-link-deps.mjs            # 默认 web profile
 *   DSH_DEV_LINK_PROFILE=cli node scripts/... # 换 profile（闭包在
 *                                               $DSH_HOME/profiles/<name>/..
 *                                               即 profiles/node_modules）
 * 前置：.devdeps 已 `pnpm install`（见 .devdeps/README 或本文件头注）。
 * 幂等：已存在的正确链接跳过，链接错了重建，node_modules 不是链接目录时整体重建。
 */
import { mkdirSync, rmSync, symlinkSync, existsSync, lstatSync, readlinkSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── 解析各源目录 ─────────────────────────────────────────────
function dshHome() {
  const env = process.env.DSH_HOME;
  if (env) return resolve(env);
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  return join(home, ".dsh");
}
const profile = process.env.DSH_DEV_LINK_PROFILE || "web";
const closure = join(dshHome(), "profiles", "node_modules"); // 安装闭包（profiles/<name> 的 parent-walk 命中）
const closureDeepseek = join(closure, "@deepseek-ai");
const devdeps = join(root, ".devdeps", "node_modules");

if (!existsSync(closureDeepseek)) {
  console.error(`✗ 找不到 DSH 安装闭包 ${closureDeepseek}`);
  console.error(`  先 dsh 启动过一次（npx @deepseek-ai/dsh web）或 DSH_HOME 指向的 profiles/node_modules/@deepseek-ai。`);
  process.exit(1);
}
if (!existsSync(join(devdeps, "esbuild"))) {
  console.error(`✗ 找不到 ${join(devdeps, "esbuild")}：先 cd .devdeps && pnpm install`);
  process.exit(1);
}

// ── 链接清单：目标（相对 node_modules）→ 源绝对路径 ───────────
const links = {
  "@deepseek-ai": closureDeepseek,
  "js-yaml": join(devdeps, "js-yaml"),
  "qrcode": join(devdeps, "qrcode"),
  "esbuild": join(devdeps, "esbuild"),
};
const nm = join(root, "node_modules");

// node_modules 必须是本脚本管理的目录：已存在但不是我们生成的（比如 pnpm 直接装过），
// 先清掉避免混装。
let existing = [];
if (existsSync(nm)) {
  const st = lstatSync(nm);
  if (st.isSymbolicLink()) {
    rmSync(nm, { recursive: true });
  } else if (st.isDirectory()) {
    existing = readdirSync(nm);
    const ours = Object.keys(links).concat(".bin", ".pnpm");
    if (existing.some((n) => !ours.includes(n))) {
      console.log(`! node_modules 里发现外部项（${existing.filter((n) => !ours.includes(n)).join(", ")}），整体重建`);
      rmSync(nm, { recursive: true });
      existing = [];
    }
  }
  if (!existsSync(nm)) mkdirSync(nm, { recursive: true });
} else {
  mkdirSync(nm, { recursive: true });
}

let ok = 0;
for (const [name, source] of Object.entries(links)) {
  const link = join(nm, name);
  // 清掉错的（符号链接指错 / 普通目录混进 .devdeps 路径等）。
  // lstatSync 对「不存在」会抛 ENOENT（existsSync 对悬空链接也返回 false），必须整体捕获：
  // 全新检出时 node_modules 刚建好，四个链接都不存在，这里不能崩。
  let cur;
  try { cur = lstatSync(link); } catch { cur = undefined; }
  if (cur !== undefined) {
    if (cur.isSymbolicLink() && readlinkSync(link) === source) { console.log(`✓ ${name}（已是正确链接）`); ok++; continue; }
    rmSync(link, { recursive: true, force: true });
  }
  try { symlinkSync(source, link); ok++; console.log(`✓ ${name} → ${source}`); }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); }
}
if (ok < Object.keys(links).length) process.exit(1);
console.log(`\n完成 ${ok}/${Object.keys(links).length}：node_modules 已链接，宿主半部可跑。`);
