#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
exec uv run --locked atomworks-studio \
  --host "${ANNOTATION_STUDIO_HOST:-127.0.0.1}" \
  --port "${ANNOTATION_STUDIO_PORT:-8000}" "$@"
