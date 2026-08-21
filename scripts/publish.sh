#!/usr/bin/env bash
# dsh-dock 发布脚本
# 无作用域名先到先得：名字越早占住越稳。发布后即归 wycto 所有，无人可再抢。
#
# 已知坑：~/.npm 缓存目录含 root 属主文件时会报 EPERM（npm 历史 bug）。
# 修复一次：sudo chown -R 501:20 ~/.npm
# 或临时绕过：CACHE_DIR=/tmp/dsh-dock-npm-cache ./scripts/publish.sh
set -e
cd "$(dirname "$0")/.."

CACHE_DIR="${CACHE_DIR:-}"
CACHE_ARGS=()
if [ -n "$CACHE_DIR" ]; then
  mkdir -p "$CACHE_DIR"
  CACHE_ARGS=(--cache "$CACHE_DIR")
fi

echo "== 1/3 预览待发布内容（npm pack --dry-run）=="
npm pack --dry-run "${CACHE_ARGS[@]}"

echo ""
echo "== 2/3 检查 npm 登录状态 =="
if npm whoami >/dev/null 2>&1; then
  echo "已登录：$(npm whoami)"
else
  echo "未登录。请先执行：npm login"
  echo "（如果账号开了 2FA / OTP，发布时会提示输入一次性验证码）"
  exit 1
fi

echo ""
echo "== 3/3 发布 =="
npm publish "${CACHE_ARGS[@]}"

echo ""
echo "✅ 发布成功：dsh-dock@$(node -p "require('./package.json').version")"
echo "确认：https://www.npmjs.com/package/dsh-dock"