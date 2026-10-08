#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
artifact_dir="${root}/artifacts/local"
accept_port="${ANNOTATION_STUDIO_ACCEPT_PORT:-18000}"
accept_url="http://127.0.0.1:${accept_port}"
mkdir -p "${artifact_dir}"
if command -v pnpm >/dev/null 2>&1; then
  pnpm_cmd=(pnpm)
else
  pnpm_cmd=(corepack pnpm)
fi

bash "${root}/scripts/build_patinae_viewer.sh"
"${pnpm_cmd[@]}" --dir "${root}" install --frozen-lockfile
if [[ -n "${CI:-}" ]]; then
  "${pnpm_cmd[@]}" --dir "${root}/packages/web" exec playwright-core install chromium --no-shell
fi
cargo test --manifest-path "${root}/Cargo.toml" --locked
uv run --project "${root}" --all-extras python "${root}/scripts/run_pytest.py" \
  -q "${root}/tests" | tee "${artifact_dir}/pytest.log"
"${pnpm_cmd[@]}" --dir "${root}/packages/web" test:unit | tee "${artifact_dir}/web-unit.log"
"${pnpm_cmd[@]}" --dir "${root}/packages/web" build | tee "${artifact_dir}/web-build.log"
uv run --project "${root}" python "${root}/scripts/check_web_budget.py" | tee "${artifact_dir}/web-budget.log"

make -C "${root}" docs

ANNOTATION_STUDIO_PORT="${accept_port}" bash "${root}/run.sh" >"${artifact_dir}/server.log" 2>&1 &
server_pid=$!
trap 'kill "${server_pid}" >/dev/null 2>&1 || true' EXIT
for _ in {1..60}; do
  if curl --fail --silent "${accept_url}/api/ready" >"${artifact_dir}/ready.json"; then
    break
  fi
  sleep 1
done
curl --fail --silent "${accept_url}/api/ready" >/dev/null

uv run --project "${root}" python "${root}/scripts/reconstruct_examples.py" \
  "${artifact_dir}/reconstruction" | tee "${artifact_dir}/reconstruction-prepare.log"

for viewer in patinae molstar; do
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}" \
    "${pnpm_cmd[@]}" --dir "${root}/packages/web" test:e2e \
    | tee "${artifact_dir}/e2e-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/selections.mjs" | tee "${artifact_dir}/selections-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/protonation.mjs" | tee "${artifact_dir}/protonation-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/annotations.mjs" | tee "${artifact_dir}/annotations-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/editor-qol.mjs" | tee "${artifact_dir}/editor-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/loading.mjs" | tee "${artifact_dir}/loading-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    STUDIO_WORKFLOW_OUTPUT="${artifact_dir}/display" \
    node "${root}/packages/web/tests/display.mjs" | tee "${artifact_dir}/display-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    node "${root}/packages/web/tests/trajectory.mjs" | tee "${artifact_dir}/trajectory-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    STUDIO_WORKFLOW_OUTPUT="${artifact_dir}/workflows" \
    node "${root}/packages/web/tests/design-workflows.mjs" | tee "${artifact_dir}/design-workflows-${viewer}.log"
  VIEWER_MODE="${viewer}" ANNOTATION_STUDIO_URL="${accept_url}/" \
    STUDIO_RECONSTRUCTION="${artifact_dir}/reconstruction/cases.json" \
    STUDIO_WORKFLOW_OUTPUT="${artifact_dir}/reconstruction" \
    node "${root}/packages/web/tests/design-workflows.mjs" | tee "${artifact_dir}/reconstruction-${viewer}.log"
  uv run --project "${root}" python "${root}/scripts/reconstruct_examples.py" \
    "${artifact_dir}/reconstruction" --check "${viewer}" | tee "${artifact_dir}/reconstruction-check-${viewer}.log"
done
uv run --project "${root}" python "${root}/scripts/check_workflow_outputs.py" \
  "${artifact_dir}/workflows" --reference molstar --hosts patinae | tee "${artifact_dir}/workflow-parity.log"
ANNOTATION_STUDIO_URL="${accept_url}" node "${root}/packages/web/tests/renderer-failure.mjs" \
  | tee "${artifact_dir}/renderer-failure.log"

ANNOTATION_STUDIO_URL="${accept_url}/" node "${root}/packages/web/tests/renderer-recovery.mjs" \
  | tee "${artifact_dir}/renderer-recovery.log"
ANNOTATION_STUDIO_URL="${accept_url}/" "${pnpm_cmd[@]}" --dir "${root}/packages/web" test:workbench \
  | tee "${artifact_dir}/workbench.log"

ANNOTATION_STUDIO_URL="${accept_url}/" node "${root}/packages/web/tests/docs.mjs" \
  | tee "${artifact_dir}/docs.log"
