#!/usr/bin/env node
/**
 * dsh-dock — esbuild 调用桥（WSL 场景）
 *
 * build-client.mjs 支持用 DSH_DOCK_ESBUILD 指定 esbuild 入口（离线/沙箱环境指着现成二进制跑）。
 * WSL 里有时只有 Windows 侧装过 esbuild（…/@esbuild/win32-x64/esbuild.exe），Linux 侧没有任何
 * esbuild（npx 又拉不到包）。此时可以：
 *
 *   DSH_DOCK_ESBUILD=scripts/esbuild-wsl-bridge.mjs \
 *     node scripts/esbuild-wsl-bridge.mjs /mnt/c/.../@esbuild/win32-x64/esbuild.exe   # ← 见下方说明
 *
 * 实际用法是两段式：本桥自己需要知道 esbuild.exe 在哪，而 DSH_DOCK_ESBUILD 只能是一个入口路径，
 * 所以把 exe 路径写进环境变量 ESBUILD_EXE 传给本桥：
 *
 *   ESBUILD_EXE=/mnt/c/.../@esbuild/win32-x64/esbuild.exe \
 *     DSH_DOCK_ESBUILD=scripts/esbuild-wsl-bridge.mjs node scripts/build-client.mjs
 *
 * 桥的作用：WSL 的 node 把 /mnt/f/... 这种路径原样交给 .exe，Windows 版 esbuild 认不出来，
 * 会报 "The entry point ... cannot be marked as external" 之类的路径错误。这里把参数里以 /
 * 开头的 Linux 路径逐个用 wslpath -w 翻成 F:\... 再转发，其余参数（--bundle/--external=…
 * 等）原样透传；exe 自身用 Linux 路径 spawn（WSL 的 binfmt 互操作会把它当 Windows 程序执行）。
 *
 * 仅用于本机 WSL 手工构建；正常 CI/开发机有 Linux esbuild，走 build-client.mjs 的默认解析。
 */
import { spawnSync } from 'node:child_process'

const exeArg = process.env.ESBUILD_EXE || process.argv[2]
const args = process.env.ESBUILD_EXE ? process.argv.slice(2) : process.argv.slice(3)
if (!exeArg) {
  console.error('用法: ESBUILD_EXE=<esbuild.exe> DSH_DOCK_ESBUILD=scripts/esbuild-wsl-bridge.mjs node scripts/build-client.mjs')
  process.exit(2)
}

/** Linux 绝对路径 → Windows 路径（wslpath 不可用时原样返回）。 */
function toWinPath(p) {
  if (!p.startsWith('/')) return p
  const r = spawnSync('wslpath', ['-w', p], { encoding: 'utf8' })
  const out = (r.stdout || '').trim()
  return r.status === 0 && out ? out : p
}

const translated = args.map((a) => {
  // 分开 --outfile=/path 这类 “--flag=/path” 形态，只翻译等号右侧
  const eq = a.indexOf('=')
  if (a.startsWith('--') && eq !== -1) {
    const flag = a.slice(0, eq + 1)
    const value = a.slice(eq + 1)
    return flag + toWinPath(value)
  }
  return toWinPath(a)
})

const r = spawnSync(exeArg, translated, { stdio: 'inherit' })
if (r.error) {
  console.error('esbuild-wsl-bridge: 无法执行 ' + exeArg + '：' + (r.error.message || r.error))
  process.exit(1)
}
process.exit(r.status === null ? 1 : r.status)
