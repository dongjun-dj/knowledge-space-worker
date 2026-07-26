#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source ~/.nvm/nvm.sh
nvm use 20
npx wrangler login
npx wrangler deploy
