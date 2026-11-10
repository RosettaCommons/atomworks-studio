# Development

Use Python 3.12, the Node version in `.node-version`, pnpm from `package.json`,
and Rust from `rust-toolchain.toml`. Install `wasm-pack` 0.13.1.

```bash
make bootstrap
make test
make build
make run
```

The pinned RFD4 source is used only for scientific annotation definitions.
No checkpoints or model environment are needed. Both browser renderers are built
into the release wheel. `make bootstrap` verifies and reuses the bundled Patinae
viewer; rebuilding it is only needed when its upstream source or patches change.

`make run` uses the installed Studio command and existing web assets. After editing
the frontend, run `make build` again. For a frontend development server with live
updates, use `pnpm --dir packages/web dev`.

## Checks

```bash
make lint
make typecheck
make test
make accept-local
make docs
```

`make typecheck` regenerates API types before checking TypeScript.
`make accept-local` tests the API and browser workflows in both renderers,
including selections, annotations, protonation, Undo, save/reopen, embedding,
responsive layouts, and accessibility. It writes logs to `artifacts/local/`.
Browser automation uses `CHROME_PATH` when supplied; see `scripts/browser.mjs`.
CI installs the Chromium revision matched to the locked Playwright version.
Linux runs it under Xvfb with SwiftShader so WebGPU screenshots contain the
rendered frame. Reproduce that setup with `CI=1 xvfb-run -a make accept-local`.

Native PyMOL tests need PyMOL and Qt. Create the environment described in the
[PyMOL guide](PYMOL.md), install the source packages there, then run:

```bash
QT_QPA_PLATFORM=offscreen python scripts/run_pytest.py -q packages/pymol-plugin/tests tests/test_pymol_conformance.py
```

Use the wrapper so PyMOL shutdown cannot hide a failing test exit code.

## VS Code extension

Run `pnpm --dir packages/vscode package` after bootstrap to build the VSIX in
`packages/vscode/`. Install it using **Extensions → Install from VSIX…**, then run **AtomWorks: Open Studio**.
The extension starts the installed Python backend. `pnpm --dir packages/vscode test`
checks startup, reuse, failure recovery, and process cleanup.

## Annotation changes

Keep scientific definitions upstream. Studio adapts their editing metadata into
controls and delegates mutation to the shared document. A new or changed editor
needs coverage for stored values, scope, invalid input, Undo, and CIF round-trips
across native PyMOL and HTTP. UI controls must report errors without losing selection.

The same annotation loader is used by PyMOL and the API. Public AtomWorks conditions
remain usable when developing the editing library without the RFD4 adapter.
A broken installed adapter fails visibly instead of silently omitting annotations.

See [architecture](ARCHITECTURE.md) for package boundaries and
[releases](RELEASE.md) for distribution builds.

Condition edits always broadcast to the declared AtomWorks level (atom, token,
residue, or chain) in `StudioDocument.set_condition`, including removal and group
actions. Explicit selection scope can expand an edit further. Token broadcasting
uses AtomWorks token boundaries, including atomization.

Sequence probability channels share one editor group, with residue choices and
numeric limits supplied by the condition schema. Web and PyMOL use the same
metadata: two decimal places, a 0.1 step, and values from zero to one. Stored
probabilities retain their precision; rounding applies only to GUI input.

New-chain segments use `StudioDocument.next_chain_id()` when no ID is supplied;
both interfaces show that suggestion. IDs progress A–Z, AA–AZ, and so on.
Salt-bridge and metal-coordination roles use the bundled RFD4 enum definitions.

## Workflow checks

The browser acceptance suite runs the PPI, enzyme-motif and ligand cases in
`tests/fixtures/workflow_cases.json` and the eight NIM cases in
`tests/fixtures/nim_workflow_cases.json` through both viewers. It compares exported
atom identities, coordinates, bonds, charges, segment bounds, and all annotation
values and masks. Segment expansion uses random lengths; the comparison checks
the state restored by Undo, while each workflow checks expansion separately.

With PyMOL available in the test Python environment, run the same cases through
the native controls and compare their exports:

```bash
STUDIO_WORKFLOW_OUTPUT=artifacts/local/workflows QT_QPA_PLATFORM=offscreen \
  python scripts/run_pytest.py -q tests/test_design_workflows.py
python scripts/check_workflow_outputs.py artifacts/local/workflows --hosts molstar patinae
```

These tests prepare design inputs; they do not validate model inference.

To test authoring the shipped examples from CIFs with their annotations removed,
prepare temporary inputs, run the shared GUI driver, then compare saved and
reopened CIFs with the originals. `make accept-local` runs this for both viewers.
Against an already running standalone Studio server:

```bash
python scripts/reconstruct_examples.py artifacts/reconstruction
STUDIO_RECONSTRUCTION=$PWD/artifacts/reconstruction/cases.json \
  STUDIO_WORKFLOW_OUTPUT=$PWD/artifacts/reconstruction \
  ANNOTATION_STUDIO_URL=http://127.0.0.1:8000/ VIEWER_MODE=molstar \
  node packages/web/tests/design-workflows.mjs
python scripts/reconstruct_examples.py artifacts/reconstruction --check molstar
```

Repeat with `VIEWER_MODE=patinae` and `--check patinae`. The unconditional
case has no target structure, so the test uses a temporary atom to create its
segment through the GUI, then deletes that atom.

The optional Gradio host uses the same workflow driver. Against a running host:

```bash
ANNOTATION_STUDIO_URL=http://127.0.0.1:8791/ VIEWER_MODE=patinae \
  STUDIO_STRICT_RENDERER=1 node packages/web/tests/gradio-workflows.mjs
ANNOTATION_STUDIO_URL=http://127.0.0.1:8791/ GRADIO_URL=http://127.0.0.1:8791/design/ \
  VIEWER_MODE=molstar node packages/web/tests/editor-qol.mjs
```

Repeat with the other viewer. `STUDIO_TEST_GENERATE=1` also submits one antibody
input, reopens the result, and checks that switching examples clears old results;
use an echo runner locally or explicitly enable it against a model deployment.
For private Spaces, supply `HF_TOKEN` through the environment and set
`STUDIO_PARENT_ORIGIN=https://huggingface.co` to reproduce the Hub's nested iframe.
The test sends authentication only to the configured Studio origin.

## Selection invariants

`SelectionController` owns the selected atom set. A toggle changes only its target:
remove the target when every target atom is selected; otherwise add the target.
Selection behavior depends on the current set and explicit operation, never on
which residue was clicked previously. Renderer focus, camera movement, and local
sticks are display state. In Atoms mode, cartoon hits only change that display.

Canvas picks and query results use `applyResolved` to commit in request order.
Clear, replacement selections, mode changes, and document changes invalidate
pending work. Keep those rules in the controller rather than adding per-renderer
selection exceptions. The unit suite checks set invariants and delayed requests;
`tests/picking.mjs` checks actual Mol* hits and `tests/selections.mjs` checks both
renderers and query cancellation.

Mol* renders a root structure containing only positioned atoms, preserving their original
source indices. Missing coordinates and design placeholders stay in the editable document;
they must never enter geometry, focus surroundings, camera bounds, or picking. The shared
coordinate filter also constrains Patinae representation changes. The close/reopen regression
in `packages/web/tests/unresolved-rendering.mjs` checks scene isolation and sequence coverage.
