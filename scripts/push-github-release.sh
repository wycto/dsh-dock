#!/usr/bin/env bash
# 把开发库 main 的当前代码压成一条「发版」提交，同步到发版库 github 的 main。
#
# 约定（docs/workflow.md 第 3 节）：github 是发版库，不收开发提交——每次发版只多
# 一条「发版 vX.Y.Z」提交（主标题写发版，正文汇总本版功能内容），父提交是上一次
# 发版提交。本地用 release 分支跟踪 github/main；release 分支不要推到 origin。
#
# 用法: ./scripts/push-github-release.sh <message-file>
#   message-file: 发版提交信息文件（UTF-8），主标题「发版 vX.Y.Z：<要点>」+ 正文汇总。
# 前提: 在 main 上、工作区干净、origin/main 已推送、两处版本号已定稿。
# 注意: 本机 `bash` 会解析到 WSL（CRLF 报错），请用 Git Bash 跑本脚本：
#   & "D:\Program Files\Git\bin\bash.exe" ./scripts/push-github-release.sh <message-file>
set -e
cd "$(dirname "$0")/.."

MSG="${1:?用法: ./scripts/push-github-release.sh <message-file>}"
[ -f "$MSG" ] || { echo "找不到提交信息文件: $MSG"; exit 1; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || { echo "当前在 $BRANCH 分支，请切到 main 再执行"; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "工作区不干净，先提交或清理"; exit 1; }

# 1) 本地 release 分支对齐 github/main（发版库当前状态）
git fetch github main
if git show-ref --verify -q refs/heads/release; then
  git branch -f release github/main
else
  git branch release github/main
fi

# 2) 用 main 的整棵树造一条提交，父提交 = 上一次发版提交（github/main）
TREE=$(git rev-parse 'main^{tree}')
COMMIT=$(git commit-tree "$TREE" -p refs/heads/release -F "$MSG")
git branch -f release "$COMMIT"

# 3) 推送到发版库（正常发版是快进，无需 force）
git push github refs/heads/release:main

echo "✅ github/main 已更新：$(git log -1 --oneline "$COMMIT")"
echo "   本地 release 分支 = github/main（勿推 origin）"
