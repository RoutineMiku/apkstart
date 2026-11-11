#!/usr/bin/env bash
# 一键把 docs/promo/wechat-article.md 推送到微信公众号草稿箱
# 用法：
#   1) 设置环境变量 WECHAT_APP_ID / WECHAT_APP_SECRET，或
#   2) 写入 $HOME/.baoyu-skills/.env（或 WECHAT_ENV_FILE 指定的文件）
# 前置：公众号后台「基本配置 → IP 白名单」需包含本机公网 IP
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${WECHAT_ENV_FILE:-$HOME/.baoyu-skills/.env}"
EXTRA=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  EXTRA+=(--env-file "$ENV_FILE")
fi

if [ -z "$WECHAT_APP_ID" ] || [ -z "$WECHAT_APP_SECRET" ]; then
  echo "缺少凭据：请设置 WECHAT_APP_ID / WECHAT_APP_SECRET，或写入 $ENV_FILE" >&2
  exit 1
fi

wenyan publish \
  "${EXTRA[@]}" \
  -f docs/promo/wechat-article.md \
  -t lapis -h solarized-light --no-footnote

echo "已推送到草稿箱：登录 https://mp.weixin.qq.com → 内容管理 → 草稿箱 审核后群发"
