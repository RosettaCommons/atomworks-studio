#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"
uv run python scripts/export_openapi.py
mkdir -p packages/web/src/generated
pnpm --dir packages/web exec openapi-typescript \
  "${root}/.cache/openapi.json" \
  --output "${root}/packages/web/src/generated/api.d.ts"
