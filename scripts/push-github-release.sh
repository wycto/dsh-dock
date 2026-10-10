#!/usr/bin/env bash
# 把开发库 main 的当前代码压成一条「发版」提交，同步到 GitHub 本地发版库并推上去。
#
# 约定（docs/workflow.md 第 3 节）：GitHub 是发版库，不收开发提交——每次发版只多
# 一条「发版 vX.Y.Z」提交（主标题写发版，正文汇总本版功能内容），父提交是上一次
# 发版提交。本地 release 分支就是这条发版线；release 分支不要推到 origin。
#
# ⚠️ 开发库（本仓库）**不配置 github 远端**：GitHub 有自己的本地仓库
# （默认 /Users/weiyi/develop/github/wycto/dsh-dock，可用 DSH_DOCK_GITHUB_REPO 覆盖），
# 由它持有 origin=git@github.com:wycto/dsh-dock.git 并负责推送。本脚本在开发库造好
# 发版提交后，直接快进同步到那个本地仓库、再由它推送——开发库的远端只有 origin。
#
# 用法: ./scripts/push-github-release.sh <message-file> [--no-push]
#   message-file: 发版提交信息文件（UTF-8），主标题「发版 vX.Y.Z：<要点>」+ 正文汇总。
#   --no-push:    只同步到 GitHub 本地仓库，不推送（供人工检查后再推）。
# 前提: 在 main 上、工作区干净、origin/main 已推送、两处版本号已定稿。
# 注意: 本机 `bash` 会解析到 WSL（CRLF 报错），请用 Git Bash 跑本脚本：
#   & "D:\Program Files\Git\bin\bash.exe" ./scripts/push-github-release.sh <message-file>
set -e
cd "$(dirname "$0")/.."

MSG="${1:?用法: ./scripts/push-github-release.sh <message-file> [--no-push]}"
PUSH=1
[ "${2:-}" = "--no-push" ] && PUSH=0
[ -f "$MSG" ] || { echo "找不到提交信息文件: $MSG"; exit 1; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "当前在 $BRANCH 分支，请切到 main 再执行"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交或清理"; exit 1; }

DEV_REPO="$(git rev-parse --show-toplevel)"
GH_REPO="${DSH_DOCK_GITHUB_REPO:-/Users/weiyi/develop/github/wycto/dsh-dock}"
[ -d "$GH_REPO/.git" ] || { echo "找不到 GitHub 本地发版库: $GH_REPO"; echo "  可用 DSH_DOCK_GITHUB_REPO=<路径> 指定"; exit 1; }

# 1) 发版提交的父提交 = 上一次发版提交。
#    以本地 release 分支为准；它若落后于发版库 main（例如在别的机器发过版），
#    改用发版库的 main，避免造出一条分叉的发版线。
GH_MAIN="$(git -C "$GH_REPO" rev-parse main 2>/dev/null || true)"
if git show-ref --verify -q refs/heads/release; then
  RELEASE_BASE="$(git rev-parse refs/heads/release)"
else
  RELEASE_BASE="$GH_MAIN"
fi
if [ -n "$GH_MAIN" ] && ! git merge-base --is-ancestor "$GH_MAIN" "$RELEASE_BASE" 2>/dev/null; then
  echo "⚠️ 发版库 main 不在本地 release 线上，以发版库为准：$(git -C "$GH_REPO" log -1 --oneline main)"
  RELEASE_BASE="$GH_MAIN"
fi

# 2) 用 main 的整棵树造一条提交，父提交 = 上一次发版提交
TREE="$(git rev-parse 'main^{tree}')"
COMMIT="$(git commit-tree "$TREE" -p "$RELEASE_BASE" -F "$MSG")"
git branch -f release "$COMMIT"

# 3) 快进同步到 GitHub 本地发版库（历史同源，正常是快进，无需 force）
git -C "$GH_REPO" fetch "$DEV_REPO" release
git -C "$GH_REPO" merge --ff-only FETCH_HEAD
echo "✅ 发版库已同步: $(git -C "$GH_REPO" log -1 --oneline main)"
echo "   本地 release 分支 = 该发版提交（勿推 origin）"

# 4) 由发版库推送（开发库不再持有 github 远端）
if [ "$PUSH" = "1" ]; then
  git -C "$GH_REPO" push origin main
  echo "✅ 已推送到 GitHub: origin/main"
else
  echo "（--no-push：未推送。人工检查后执行 git -C $GH_REPO push origin main）"
fi
