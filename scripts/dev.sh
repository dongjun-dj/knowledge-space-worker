#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
npx wrangler dev --ip 127.0.0.1 --port "${PORT:-8787}"
