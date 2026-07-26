#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh
nvm use 20

required=(INGEST_TOKEN NOTION_API_KEY NOTION_DATABASE_ID)
optional=(COZE_API_KEY COZE_WORKFLOW_ID COZE_BASE_URL DIFY_API_KEY DIFY_DATASET_ID DIFY_BASE_URL)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name" >&2
    exit 2
  fi
  printf '%s' "${!name}" | npx wrangler secret put "$name"
done

for name in "${optional[@]}"; do
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}" | npx wrangler secret put "$name"
  else
    echo "Skip optional env: $name"
  fi
done
