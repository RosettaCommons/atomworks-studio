# Use Studio in a workflow

Use the editing library for Python code and the HTTP API when another process
owns the document. Neither interface needs a browser, Qt, a model runtime, or a
GPU. Both currently install AtomWorks 3's ML dependencies, including Torch.

## Python primitives

`pip install atomworks-studio` provides the editing library
(`atomworks_studio_editing`) for base AtomWorks conditions and the RFD4 adapter
(`atomworks_studio_rfd4`) for the same hotspot, group, and other condition
definitions that the full Studio installation uses.

```python
from pathlib import Path
from atomworks_studio_editing.document import StudioDocument
from atomworks_studio_editing.providers import load_providers

providers = load_providers()
document = StudioDocument.from_cif(
    Path("input.cif").read_text(),
    condition_provider=providers.condition_provider,
    validation_provider=providers.validation_provider,
)
indices = document.query_indices("sel('*/*/*/CA')").tolist()
document.set_condition("sequence", indices)
Path("annotated.cif").write_text(document.to_cif())
```

`StudioDocument(array, ...)` also accepts an AtomWorks `AtomArrayPlus` directly.
Use one document per request or workflow. Mutations validate and create Undo
steps; `document.undo()` reverses the last one. `document.protonate(ph=7.4)`
updates hydrogens and formal charges. `to_cif()` serializes the current array.
Call `document.validate(full_pipeline=True)` and inspect its returned issues
when preparing model inputs; serialization alone is not a validation check.

The executable [annotation example](https://github.com/RosettaCommons/atomworks-studio/blob/main/examples/annotate.py)
uses these same calls. From the repository:

```bash
python examples/annotate.py packages/api/annotation_studio/examples/protein_binder.cif annotated.cif \
  --query "sel('*/*/*/CA')" --condition hotspot
```

## HTTP and embedded editing

Start `atomworks-studio`. Create a session by uploading an annotated CIF to
`POST /api/v1/sessions` as multipart field `file`. The response contains a
`session_id` and an `editor_path`, such as `/?session=…&embed=1`. Open that path
on the same Studio server to edit the uploaded structure.

```bash
curl --fail -F file=@input.cif http://127.0.0.1:8000/api/v1/sessions
```

For that session, use:

| Method and path after `/api/v1/sessions/{session_id}` | Use |
| --- | --- |
| `POST /selections/query` | Resolve an AtomWorks expression or selection path. |
| `POST /conditions` | Apply an annotation to explicit atom indices. |
| `POST /protonate` | Assign hydrogens and formal charges at a given pH. |
| `POST /undo` | Revert the last edit. |
| `GET /cif` | Serialize the current annotated CIF. |
| `POST /export` | Validate and serialize one snapshot; return the CIF and validation issues. |

The running server exposes request schemas at `/docs` and `/openapi.json`.
For an iframe, allow the parent's exact origin with
`ANNOTATION_STUDIO_FRAME_ANCESTORS`. Sessions are bounded, expire, and use one
server process. Export files before submitting a long-running inference job.

## Embedding Studio in a page

An iframe host drives Studio over `postMessage` and the HTTP API, as above. A host
that runs in the *same* page — a model running in the browser, a notebook, a Space
that streams results — uses `window.atomworksStudio` instead. It appears once the
editor has started, and every call goes through the same path as the UI, so an edit
is one Undo step and the document on the server stays the source of truth.

| Call | What it does |
| --- | --- |
| `renderFrame(cif, name, { keepCamera })` | Show one frame of a structure you are producing. Successive calls replace it in place, so the scene does not flash. |
| `setOverlay(key, cif, options)` | Show a display-only structure beside the document; `null` removes it. Overlays take no part in selection, annotation or analysis. `options`: `label`, `representation` (`"ball-and-stick"`, the default, or `"cartoon"`), `color`, `alpha`, `sizeAspectRatio` (ball-and-stick only); they apply when the overlay is created. |
| `setLiveMode(on)` | Trade picture quality for frame rate while streaming frames; restores the previous look exactly. |
| `showDocument()` | Go back to the open document after frames or a failed run. |
| `openSession(id, { trajectoryUrl })` | Open a session you created, optionally with a trajectory to scrub. |
| `openFile(file)` / `openExample(id)` | Open a file you already have, or a bundled example. |
| `applyEdit(path, body)` | Apply a document mutation by API path, e.g. `/conditions/batch`. |
| `getSelection()` | The selection, as document atom indices. |
| `chainColor(chainId)` | The colour Studio draws a chain in, so your own UI can match. |
| `mountRefoldPanel(container, provider, options)` | Mount Studio's Refold panel and give it a folding backend. See [Refold panel](#refold-panel). |
| `version` | The Studio release the page was built from. |

A host that serves the bundle itself usually does not want Studio's offline cache
pinning its assets. Turn it off in the composed page:

```html
<meta name="atomworks-studio-service-worker" content="off" />
```

Same-page hosts receive the `ready`, `changed` and `example` notifications an iframe
host gets over `postMessage`, as an `atomworks-studio` window event carrying the same
payload (`source`, `type`, `session_id`), plus `selection` with a `count` whenever the
selection changes.

```js
window.addEventListener("atomworks-studio", (event) => {
  if (event.detail.type === "changed") refreshMyPanel(event.detail.sessionId);
});
await window.atomworksStudio.openExample("motif_scaffolding");
await window.atomworksStudio.renderFrame(cif, "step 12", { keepCamera: true });
```

## Hugging Face Spaces

The [Docker Space example](https://github.com/RosettaCommons/atomworks-studio/tree/main/examples/space)
serves the existing editor on port 7860, including this guide. It uses built
wheels, so the deployed container needs no Node, Rust, PyMOL, or separate frontend
build. It is an editor-only CPU recipe; it does not execute inference.
[Docker Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker) can host a
custom server and use GPU hardware.

### Model-enabled Gradio host

Install `atomworks-studio[gradio]` for the optional shared generation UI. The base
editor installation does not require Gradio. Studio owns the embedded editor,
queued Generate action, current-document export, result selection and CIF/ZIP
downloads. Model-specific controls and validation live in the model's provider.
The deployment supplies one synchronous callback: `(annotated_cif, options)` to
a list of output CIF strings. It runs off the API event loop with one queued worker.

```python
from annotation_studio.gradio import create_app
from atomworks_studio_rfd4.generation import RFD4GenerationProvider

# generate(cif: str, options: dict) -> list[str] is supplied by your deployment.
app = create_app(
    provider=RFD4GenerationProvider(k_defaults=(16.0, 4.0)),
    generate_fn=generate,
)
```

Serve this app with Uvicorn using one process. `/design/` is the generation UI;
the existing editor and versioned HTTP API remain on the same origin. The callback
receives a validated snapshot of the current edits. Its output becomes separate
Studio documents; failed requests preserve the input. Download files before
sessions expire. This in-memory queue does not persist or cancel running jobs.

The same Gradio host exposes `/generate_cif` for scripts. It accepts an annotated
CIF string and the provider's options, validates the CIF through Studio, and
returns `designs` (CIF strings) and `warnings`. For a private Space:

```python
import os
from pathlib import Path

from gradio_client import Client

client = Client("https://<space>.hf.space/design/", token=os.environ["HF_TOKEN"])
result = client.predict(
    Path("input.cif").read_text(),
    {"thinking": "medium", "samples": 1, "seed": 42},
    api_name="/generate_cif",
)
Path("design.cif").write_text(result["designs"][0])
```

The editor button and this endpoint call the same validated model callback.

Task conditioning, inverse folding included, comes from the annotated CIF: which
residues are held, which are new and what is marked a hotspot already say what is
being designed, so there is no task option to keep in step with the document.
RFD4 partial diffusion is controlled by `partial_diffusion`, off by default. With
`partial_diffusion: true`, `partial_diffusion_percent` ranges from 1 to 100 and
defaults to 70; the deployment maps it to
`generation.args.partial_trajectory_fraction_steps` by dividing by 100.

A provider may implement optional members, each read with a default so
providers written against earlier releases keep working. Three are about generation: `default_example`, an
example id Studio opens on instead of an empty editor; `css`, appended to
Studio's own so provider element ids stay out of the host; and
`validate_input(snapshot, options)`, which rejects an input the chosen options
cannot run on before any GPU time is spent. The RFD4 provider uses the last of
these to refuse partial diffusion on expandable segments, reading
`has_expandable_segments` from the same exported snapshot — this includes
realized segments whose residues are still undefined. Generate a fully defined
input first, or use the partial diffusion example. The refold members
(`refold_models`, `refold_limits`, `validate_refold`) are described under
[Refold panel](#refold-panel).

Run `python scripts/preview_generation.py` to see this UI locally with a
simulated model, including the generation and failure states.

The deployment owns model weights, CUDA dependencies and execution. Pass native
`tsr_k` defaults from its inference configuration to the RFD4 provider. No Torch
model, model download, GPU provisioning or job-provider registry is added to
Studio. Other model providers implement the small `GenerationProvider` interface
in `annotation_studio.gradio`. Gradio and model generation remain optional for
PyMOL, VS Code and the standalone browser editor.

[ZeroGPU](https://huggingface.co/docs/hub/spaces-zerogpu) requires a Gradio Space;
the model deployment wraps its callback in `spaces.GPU`. The editor-only Docker
Space remains a CPU recipe. A Studio handoff check does not validate GPU inference;
run the actual model on its intended host before releasing a deployment.

### RFD4-Proteina deployment

The RFD4 deployment uses the shared host and RFD4 provider above.

Install Studio in RFD4's supported Python/CUDA environment, using the model
repository's [installation guide](https://github.com/RosettaCommons/RFD4-Proteina/blob/main/docs/installation.rst).
The adapter loads a pinned Hugging Face checkpoint bundle once and invokes
RFD4's native generation entry point for each request. The provider supplies
task, recycling preset, design count, seed and noise controls.

Keep model and Space repositories private during qualification. Store
`HF_TOKEN` as a Space secret and pin `RFD4_MODEL_REVISION` to the verified model
commit. The deployment guide in the model repository owns the exact environment
and launch instructions.

The Studio adapter hands annotated CIFs to the model deployment and imports its
result CIFs. The deployment owns eager or compiled execution, progress,
trajectories, and refolding metrics. Test generation on the intended GPU;
editor handoff tests use a test callback.

## Refold panel

Folding a design again with an independent model and scoring how it comes back
is the usual next step after generating one. Studio owns the interface for it,
once, so every host shows the same panel: the Designs table with one row of
numbers per design (RMSD, pLDDT, and for an interface ipTM and iPAE, sortable,
✓ where upstream's pass criteria hold, greyed where they fail), and under it the
Refold box with **Model**, **Seed** (0 to 4294967295, default 0), **Recycles**
(0, 1, 2, 3, 5, 10; default 3) and **Steps** (25, 50, 100, 200; default 25), a
**Refold all** button that becomes **Stop** while it runs and fills with the
run's progress, and a line for a failure. The refold of the design on show is
drawn over it as a magenta cartoon, its ligands as sticks, through `setOverlay`.

A host supplies what folds. Two are in use: the
[RFD4-Proteina page](https://github.com/sokrypton/rfd4-proteina-webgpu) folds in
the browser with LocalFold on WebGPU, and the Gradio host calls a callback on the
server. Neither keeps its own copy of the interface.

### Licence-gated models

AlphaFold 3's parameters are Google DeepMind's, not available for commercial use
and under a prohibited-use policy. Studio therefore knows `af3` as a gated model:
choosing it and pressing Refold opens the **AlphaFold 3 model parameters** dialog
with the terms, links to DeepMind's `WEIGHTS_TERMS_OF_USE.md` and
`WEIGHTS_PROHIBITED_USE_POLICY.md`, and three buttons: **Use OpenBind-0** (the same
architecture under Apache 2.0, a different model), **I agree, use AlphaFold 3**
and **Cancel**. Agreement is remembered once per browser (`localStorage`, key
`atomworks-studio.refoldTerms.af3`) and the panel never calls `prepare` for the
model, so nothing is downloaded on the person's behalf before they decide. The
wording lives in Studio (`ALPHAFOLD3_TERMS`), not in each host. A host that is
licensed to serve the weights itself lists the model with `terms: null`; whether
that is permitted is the host's decision, not a default.

OpenBind-0 is listed as `{id: "openbind0"}` and has no dialog.

### The browser contract

Same page as Studio: `window.atomworksStudio.mountRefoldPanel(container, provider,
options)`. Any other page (the Gradio host mounts it above an iframe of the
editor) imports the same code from `refold-panel.js`, served next to Studio's
bundle: `import { mountRefoldPanel } from "/refold-panel.js"`. Both run one
implementation. The panel injects its own styles; mount it in a shadow root to
keep a host's global CSS out.

```ts
const panel = window.atomworksStudio.mountRefoldPanel(container, {
  // In menu order. A known id ("af3", "openbind0") needs nothing else.
  models: [{ id: "af3" }, { id: "openbind0" }],
  // Optional. Anything left out keeps the values above.
  limits: { steps: { options: [25, 50, 100, 200], default: 25 }, recycles: { options: [0, 1, 2, 3, 5, 10], default: 3 } },
  // Fold one design. Reject on failure, and as soon as `signal` aborts (Stop).
  async refold(design, { model, seed, recycles, steps }, { signal, onStatus }) {
    onStatus({ text: "trunk", fraction: 0.4 });          // the button fills with `fraction`
    return {
      cif,                       // the refold's polymer chains, in the design's frame: drawn as a cartoon
      ligandCif,                 // optional: its ligands, drawn as sticks
      metrics: { rmsd, placedRmsd, plddt, ptm, iptm, chainPtm, minIpae },   // a number that does not apply: NaN or null
      text: "AlphaFold 3 refold: 1.2 Å RMSD · pLDDT 91",    // optional, kept with the record
      pass: true,                // optional: a verdict of your own; otherwise judged from `design.kind`
      data: { pdb },             // optional: yours, handed back by `panel.records(id)`
    };
  },
  prepare: async (model, onProgress) => {},  // optional: fetch parameters ahead of the click (never for a model whose terms are not agreed)
  available: () => true,                     // optional: false hides the Refold box and the rows' ↻
}, {
  nameHeader: { label: "Seed", title: "Each design is named by its seed" },
  describe: (design) => `seed ${design.name}`,   // how the progress line names a design
  onSelect: async (id) => {},                    // a row was chosen: show that design, resolve once it is on screen
  overlay: (key, cif, options) => {},            // default: Studio's own setOverlay
  onDownload: (design) => {},                    // default: save design.cif
});

panel.setDesigns([{ id: "s1", name: "163509", cif, kind: "binder", data: anything }]);  // refolds of a design that stays are kept
await panel.setSelected("s1");     // the host showed that design: its refold is drawn over it
panel.refold();                    // Refold all; panel.refold(["s1"]) for one
panel.prefetch();                  // optional: call `prepare` for the selected model while the machine is idle
panel.records("s1");               // every refold made of it, with the settings: for a results .zip
```

- **Designs** are folded one after another, never two at once. **Refold all** skips
  a design already refolded with the settings in the box and shows that refold
  instead, so going back to earlier settings brings their numbers back.
- `design.kind` (`"monomer"`, `"binder"`, `"antibody"`, or none) picks the pass
  criteria: monomer RMSD ≤ 1.5 Å; binder chain pTM ≥ 0.8, min iPAE ≤ 1.5 Å, placed
  RMSD ≤ 2.5 Å; antibody min iPAE ≤ 2.0 Å, placed RMSD ≤ 2.0 Å. Other jobs show
  numbers and no verdict, unless `refold` returns `pass`.
- The metrics are the names of upstream's criteria: `rmsd` (designed chains fitted
  on themselves), `placedRmsd` (fitted on everything else, so where a binder sits
  counts), `chainPtm`, `minIpae`, and the refold model's `plddt`, `ptm`, `iptm`.
- Model options are only offered; the panel does not enforce a licence on the
  server. A host that serves restricted weights checks its own terms.

### The Gradio host

A Python deployment opts in with three optional provider members and one callback,
following the optional members above. A provider without `refold_models`, or a
deployment without `refold_fn`, behaves exactly as before: no panel, no route, the
same handler outputs.

```python
class MyProvider:
    ...
    def refold_models(self) -> list[dict]:           # required to enable refolding
        return [{"id": "af3"}, {"id": "openbind0"}]  # or "terms": None, "label": "...", for models of your own
    def refold_limits(self) -> dict:                 # optional, over Studio's defaults
        return {"steps": {"options": [25, 50], "default": 25}}
    def validate_refold(self, options: dict) -> dict:  # optional, replaces the default check
        ...

def refold(design_cif: str, options: dict) -> dict:
    """options: {"model", "seed", "recycles", "steps"}, already validated."""
    ...
    return {
        "cif": refolded_polymers_cif,      # required: in the design's frame
        "ligand_cif": ligands_cif,         # optional
        "metrics": {"rmsd": 1.2, "placed_rmsd": None, "plddt": 91.0, "ptm": 0.9, "iptm": None,
                    "chain_ptm": None, "min_ipae": None},      # None or NaN where a number does not apply
        "text": "AlphaFold 3 refold: 1.2 Å RMSD",              # optional
        "passed": True,                                         # optional verdict
    }

app = create_app(provider=MyProvider(), generate_fn=generate, refold_fn=refold)
```

`refold` runs off the API loop, one at a time. On ZeroGPU, wrap it in
`spaces.GPU` as for `generate`: both go through Gradio's queue, the panel's
requests included, so quota and queueing behave as for any other click. The
model runtime stays in the deployment; Studio adds none.

The default validation accepts `model` among those offered, `seed` as a whole
number in range, and `recycles` and `steps` among the options, and fills what is
left out with the defaults. Errors reach scripts as a `ValueError` and the panel
as a message on the failed row's line.

Under the generation controls the host then shows the panel, filled with the
designs each run produces. Choosing a row opens that design in the editor, as the
View selector does, and the refold is drawn over it. The same refold is reachable
for scripts:

```python
result = client.predict(
    Path("design.cif").read_text(),
    {"model": "openbind0", "seed": 0, "recycles": 3, "steps": 25},
    api_name="/refold_cif",
)
# result["cif"], result["ligand_cif"], result["metrics"], result["text"], result["passed"]
```

Stop in the panel abandons the wait; a fold the server has already started runs to
the end, since the queue does not cancel running jobs. `python
scripts/preview_generation.py --refold` shows the panel locally with a simulated
fold.

## NIM and other inference services

Use Studio before and after inference: export an input, call the service from
your backend, then import its structure output. Keep endpoint credentials on
the server. NIM APIs are model-specific; convert the input to the documented
schema and check which annotations the model actually consumes. Arbitrary
annotated CIF fields are not universally supported.

For example, consult the [OpenFold3 request examples](https://docs.nvidia.com/nim/bionemo/openfold3/latest/example-requests.html)
or [Boltz-2 inference guide](https://docs.nvidia.com/nim/bionemo/boltz2/latest/inference.html)
for the chosen service. Studio does not need an NVIDIA or Hugging Face SDK just
to prepare structures or inspect their outputs.

## Trajectory playback

A model host can attach a multi-model CIF to an output session with
`?session=SESSION_ID&trajectory=ENCODED_URL`. URL-encode a file URL on the same
Studio origin. Studio fetches it when the user selects **Show trajectory** and
provides **Play/Pause** and a frame slider in the existing viewer. Both Patinae
and Mol* render the frames; no model code is included in Studio.

RFD4's lightweight trajectories contain only Cα atoms. Mol* automatically
estimates helix and strand assignments from each frame's Cα geometry using its
Zhang–Skolnick method. These are approximate assignments, not full-backbone
DSSP results. Patinae currently shows these trajectories as a backbone trace;
its secondary-structure assignment requires N, Cα, C, and O atoms. Neither
viewer needs extra model inference for playback.

Playback is view-only. **Back to design** restores the session's editable final
structure. Opening a different document or editing the result removes the old
trajectory association. Model hosts control whether snapshots are recorded,
their retention, and access to the trajectory file.
