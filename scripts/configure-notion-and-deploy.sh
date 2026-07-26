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

if [[ -z "${INGEST_TOKEN:-}" ]]; then
  INGEST_TOKEN="kb_$(openssl rand -hex 24)"
fi

echo "本次生成/使用的 INGEST_TOKEN，请保存，后续手机/Chrome/Hermes 调用都要用："
echo "$INGEST_TOKEN"

read -s -p "请输入 NOTION_API_KEY（输入时不显示）: " NOTION_API_KEY
echo
read -p "请输入 NOTION_DATABASE_ID: " NOTION_DATABASE_ID

echo "正在写入 Cloudflare Worker Secrets..."
printf '%s' "$INGEST_TOKEN" | npx wrangler secret put INGEST_TOKEN
printf '%s' "$NOTION_API_KEY" | npx wrangler secret put NOTION_API_KEY
printf '%s' "$NOTION_DATABASE_ID" | npx wrangler secret put NOTION_DATABASE_ID

echo "正在重新部署 Worker..."
npx wrangler deploy

echo
echo "完成。线上地址："
echo "https://knowledge-space-worker.dj-knowledge.workers.dev"
echo
echo "请用下面命令测试（把 <INGEST_TOKEN> 替换为上面打印的值）："
cat <<'CMD'
curl -sS -X POST "https://knowledge-space-worker.dj-knowledge.workers.dev/ingest" \
  -H "Authorization: Bearer <INGEST_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "source_url": "https://example.com/article/1",
    "title": "AI Agent 个人知识库测试",
    "text": "这是一条测试内容，讲如何用 RAG 和 Agent 构建个人知识库。",
    "source_platform": "网页",
    "capture_device": "curl",
    "privacy": "personal"
  }'
CMD
