# Acceptance

Run `make bootstrap`, `make test`, `make accept-local`, and `make docs` from a
clean checkout. No model runtime, weights, database, or GPU worker is required.

A release must pass:

- Python editing, API, selection, validation, and native PyMOL tests.
- Browser workflows in Patinae and Mol*: annotations, protonation, Undo,
  selection syntax, save/reopen, renderer switching, and embedded views.
- Responsive and accessibility checks, plus the 80 KB gzip browser-shell budget.
- TypeScript, Rust, Python lint, package metadata, and strict documentation builds.
- Installation of built wheels outside the checkout, including bundled annotation
  definitions, browser assets, and WASM.

Check the installed VSIX in VS Code as well as a normal browser. Save confirmations
must work inside its sandbox. Inspect a representative structure in native PyMOL
before release. Automation does not replace that final visual check.

Artifacts are written under `artifacts/`; generated output is not committed.

## Compare the three backends

With Studio running and the browser bundle built, use a Python environment
containing PyMOL, Qt, pytest, Studio and its PyMOL plugin:

```bash
python scripts/test_backend_parity.py --url http://127.0.0.1:8000/
```

This runs the same PPI, enzyme and ligand cases from
`tests/fixtures/workflow_cases.json` through native PyMOL controls and the actual
Patinae and Mol* browser controls. It compares selected atom indices and every
deterministic edit, then saves and reopens each CIF. Comparisons cover atom
identity, coordinates, stored bonds, charges, segment bounds, and all condition
values and masks, including pair restraints. Random segment realization is
checked in each host; parity is checked after Undo restores the original state.

Each run writes a fresh directory under `artifacts/parity/`. Missing PyMOL,
missing exports, or a renderer fallback fail the run. The separate renderer
recovery tests still exercise fallback deliberately. GitHub's `backend-parity`
job runs the strict comparison with an actual PyMOL installation; it does not
count optional native-test skips as success.

To include the installed VS Code extension, start the test server with
`atomworks-studio --vscode --port 8000` to allow its webview and parent origins.
Start an isolated VS Code profile
with `--remote-debugging-port=9222`. Install the built VSIX into that profile;
set `annotationStudio.serverUrl` to the same test server and
`annotationStudio.viewerBackend` to the renderer being tested. Then run:

```bash
CDP_PORT=9222 VIEWER_MODE=molstar \
  ANNOTATION_STUDIO_URL=http://127.0.0.1:8000/ \
  STUDIO_WORKFLOW_OUTPUT=artifacts/parity/run-EXACT_DIRECTORY \
  node packages/web/tests/vscode-workflows.mjs
```

Repeat with a fresh profile using `patinae`, then compare all five hosts:

```bash
python scripts/check_workflow_outputs.py artifacts/parity/run-EXACT_DIRECTORY \
  --strict-renderers
```

This drives the actual VS Code webview and its download handling through the
same shared workflow driver. The hosted `backend-parity` job covers the three
rendering backends; these installed-extension runs are an additional local check.
Use a test profile, since the driver opens Studio and loads the bundled examples.
