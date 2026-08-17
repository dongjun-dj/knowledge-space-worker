#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."
npm test
npx wrangler deploy --dry-run
