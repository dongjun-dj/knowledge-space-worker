#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh
nvm use 20

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  read -s -p "请输入 CLOUDFLARE_API_TOKEN（输入时不显示）: " CLOUDFLARE_API_TOKEN
  echo
  export CLOUDFLARE_API_TOKEN
fi

COZE_WORKFLOW_ID="${COZE_WORKFLOW_ID:-7654435313217650740}"
COZE_BASE_URL="${COZE_BASE_URL:-https://api.coze.cn}"

read -s -p "请输入 COZE_API_KEY / 个人访问令牌（输入时不显示）: " COZE_API_KEY
echo
read -p "请输入 COZE_WORKFLOW_ID [${COZE_WORKFLOW_ID}]: " input_workflow_id
if [[ -n "${input_workflow_id:-}" ]]; then
  COZE_WORKFLOW_ID="$input_workflow_id"
fi
read -p "请输入 COZE_BASE_URL [${COZE_BASE_URL}]: " input_base_url
if [[ -n "${input_base_url:-}" ]]; then
  COZE_BASE_URL="$input_base_url"
fi

echo "正在写入 Cloudflare Worker Secrets..."
printf '%s' "$COZE_API_KEY" | npx wrangler secret put COZE_API_KEY
printf '%s' "$COZE_WORKFLOW_ID" | npx wrangler secret put COZE_WORKFLOW_ID
printf '%s' "$COZE_BASE_URL" | npx wrangler secret put COZE_BASE_URL

echo "正在重新部署 Worker..."
npx wrangler deploy

echo
echo "完成。线上地址："
echo "https://<你的worker域名>.workers.dev"
echo
echo "下一步：用 Chrome Bookmarklet 或 iPhone 分享一条新内容，返回中应看到 coze_status: ok。"
