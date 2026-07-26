#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh
nvm use 20
npx wrangler dev --ip 127.0.0.1 --port "${PORT:-8787}"
