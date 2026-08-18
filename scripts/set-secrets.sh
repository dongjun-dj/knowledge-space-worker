#!/usr/bin/env bash
# 手动设置 Cloudflare Worker Secrets（一般用配置页即可，此脚本备选）
set -uo pipefail
cd "$(dirname "$0")/.."

required=(INGEST_TOKEN)
optional=(TIKHUB_API_KEY FIRECRAWL_API_KEY VOLC_ACCESS_KEY VOLC_SECRET_KEY ARK_API_KEY LLM_BASE_URL LLM_MODEL NOTION_API_KEY NOTION_DATABASE_ID BARK_KEYJINA_API_KEY)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
  echo "$name" | npx wrangler secret put "$name" || exit 1
done

for name in "${optional[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    echo "$name" | npx wrangler secret put "$name" || exit 1
  else
    echo "Skip optional env: $name"
  fi
done
