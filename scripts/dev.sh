#!/usr/bin/env bash
# 本地开发启动：先建本地 D1 表（幂等），再启动 wrangler dev
set -uo pipefail
cd "$(dirname "$0")/.."

echo "🗄️  初始化本地 D1 表…"
npx wrangler d1 execute kb-logs --local --file=schema.sql        >/dev/null 2>&1 && echo "  ✅ 日志表"
npx wrangler d1 execute kb-logs --local --file=schema-async.sql  >/dev/null 2>&1 && echo "  ✅ 异步任务表"
npx wrangler d1 execute kb-logs --local --file=schema-config.sql >/dev/null 2>&1 && echo "  ✅ 配置表"

echo "🚀 启动 wrangler dev…"
npx wrangler dev --ip 127.0.0.1 --port "${PORT:-8787}"
