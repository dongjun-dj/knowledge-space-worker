#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
npx wrangler login
npx wrangler deploy
