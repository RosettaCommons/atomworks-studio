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
| `mountDesignCard(container, provider, options)` | Mount Studio's Design card: the start screen, the job editor, the run settings, Generate and the designs. See [Design card](#design-card). |
| `getSessionId()` / `undo()` | The session Studio shows (or `null`), and Undo of its last edit, as the button does. |
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

## Design card

The Design card is the whole interface for making designs, owned by Studio so every
host shows the same one: the RFD4-Proteina page and a Gradio Space mount it and
supply only the engine. It holds a start screen (**+ new**, **+ pdb**, **+ lig**
and ten examples), the job editor (every chain as pieces you click: structure,
sequence, position, hotspots, shape, exposure, interactions, fold, lengths, the
"+" between pieces, the chain's name and order, ligands), the **Thinking** and
**More settings** run controls (designs, seed and its dice, partial diffusion,
backbone and latent K, early stop), **Generate design** (which becomes **Stop** and
fills with the run's progress), a status line, the **Outputs** tab with the
[Refold panel](#refold-panel) and **Save all (.zip)**, the **Studio editor** switch
that swaps in Studio's own tools, and the light/dark switch. It reads and edits
the open document only through Studio's REST API and `window.atomworksStudio`, so
it needs no design engine and runs against the Python server and against a page's
in-browser implementation of the same API alike.

Mount it in Studio's page: `window.atomworksStudio.mountDesignCard(null, provider,
options)` puts the card in the right sidebar (its title row in the header) and
folds Studio's own panels away until **Studio editor** is ticked; with a
`container` it is a block there and leaves the rest of the page alone. Opening
Studio with `?card=1` mounts the card with no engine (an editor with Generate off);
a host's own `mountDesignCard(null, …)` replaces it. A page that never mounts the
card is unchanged. Without Studio's page around it, import the same code from
`design-card.js` beside the bundle: `import { mountDesignCard } from "/design-card.js"`.

```ts
const card = window.atomworksStudio.mountDesignCard(null, {
  engine: { badge: "WebGPU FP16" },        // beside the title; `disabled: "message"` turns Generate off and says why
  // Which run settings the engine takes. Omit a key for the reference page's values; `false` hides the control (and
  // leaves it out of `request.settings`), an object changes its range or default.
  settings: {
    samples: { min: 1, max: 8, default: 1 },
    thinking: { options: ["none", "low", "medium", "high"], default: "none" },
    seed: true,
    partialDiffusion: { percent: 40 },
    backboneK: { min: 1, max: 20, step: 0.1, default: 16 },
    latentK: { min: 1, max: 6, step: 0.1, default: 4 },
    earlyStop: { default: true },
  },
  // Make `request.settings.samples` designs of the input. Never called while another run is under way.
  async generate({ sessionId, cif, name, revision, spec, settings, signal }, hooks) {
    hooks.status("Loading the model…", { visible: true });  // the status box; `{ error: true }` for a failure
    hooks.progress(0.4, "design 1 of 3 · step 24/60");      // the button fills; it reads "Stop · " + the label
    hooks.loading("weights 40%");                           // optional: the model-load line; null clears it
    await hooks.frame(frameCif, { name: "step_24.cif", keepCamera: true, hotspots, overlays });  // a live frame
    const record = await hooks.design({ name: "163509", cif, trajectoryCif, pdb, kind: "binder", seed: 163509, designedChains: ["B"], data });
    return { message: "Generated from input revision 3 …" };   // optional: the status box ends on this
  },
  refold: refoldProvider,          // optional: Studio's RefoldProvider; the card hosts the Refold panel in Outputs
  refoldPanel: { nameHeader: { label: "Seed" }, describe: (d) => `seed ${d.name}` },
  renderExtras(container) {},      // optional: an engine-specific box beside Generate (the page's speed hint)
  guide() {},                      // optional: the Guide button is shown only when this exists
  zipFiles: ({ input, designs }) => [{ name: "notes.txt", text: "…" }],   // optional: more files in Save all
  zipTitle: "RFD4-Proteina (WebGPU) results",
  inputChanged(spec) {},           // optional: the job changed; get ready (load weights)
}, { theme: "dark", themeKey: "rfd4p.theme", examples: undefined, studioEditor: true });
```

`request.settings` carries the settings the engine takes, as the person left them:
`samples`, `thinking`, `seed` (the first design's; later ones take the next
integers), `partialDiffusion` (the percent, or `null` when off), `backboneK`,
`latentK`, `earlyStop`. `request.cif` is the annotated input
(`GET /sessions/{sid}/cif`); `request.spec` is what the card reads from it (task,
chains, lengths, contig). Designs of an input that has not changed since join the
earlier ones; after an edit, or from another input, the next run starts the list
again.

`hooks.design` opens the design as a session of its own (`POST /sessions`) and adds
its row. `trajectoryCif` is shown by Studio's **Show trajectory**; `hotspots`
(`{ chain, residue, insCode? }`, the viewer's numbering) are coloured amber while
the design is shown, `overlays` (`{ key: { cif, options } }`, through `setOverlay`)
drawn beside it. `data` is yours: it comes back as `RefoldDesign.data`. `hooks.frame`
draws a live frame (frames stay in order, one in flight); the card puts the viewer
in live mode for the run and restores it. A reject with a `userMessage` string says
it in the person's words; an abort ends in "Generation stopped. Your input is
unchanged."

The handle: `element`, `refold` (the Refold panel handle), `setEngine({ badge,
title, disabled })`, `setTheme` / `theme()`, `designs()`, `settings()`,
`inputSessionId()`, `spec()`, `generate()` (Stop while a run goes), `stop()`,
`zip()` (the bytes **Save all** would download), `setStatus`, `onChange(listener)`
(`input`, `designs`, `run`, `settings`, `theme` events) and `destroy()`.

**What the card needs from the server.** Reads: `GET /sessions/{sid}` (name,
revision, undo depth), `GET /sessions/{sid}/cif` (the annotated CIF, parsed in the
browser), `GET /sessions/{sid}/chains/{cid}/plan` (the chain as kept runs of the
chain as loaded and blocks of new residues), `POST /sessions/{sid}/chains/preview`
(`{ chain_id, parts }` → `{ cif }`, the session unchanged), `GET
/sessions/{sid}/chains/{cid}/source` (`{ chain, cif }`, the chain as loaded; 404
for a chain made in the session) and `GET /sessions/{sid}/segments/origins`
(`{ origins: { "<atom index>": { count, keys: ["A:41:"] } } }`, what each block of
new residues replaced). Writes: `/conditions/batch`, `/delete`, `/combine`,
`/segments` (+ `/range`, `/replace`, `/restore`, `/scaffold`, `/ligand-binder`),
`/chains` (+ `/order`, `/rebuild`), `/coordinates/clear`, `/internal-coords` (+
`/clear-targets`), `/undo`, and `POST /sessions` (multipart `file` and import
options: `parse_preset`, `assembly`, `keep_unresolved`, `fix_all`: an entry opens with every
residue held as it is, and without its unresolved residues unless `keep_unresolved`). Ligands by dictionary code
are fetched from `files.rcsb.org/ligands/view/<CODE>.cif` and built into a CIF in the
browser; the examples fetch their PDB entries from `files.rcsb.org`. An example
being built lives in a hidden session and is shown once, finished. The card's Undo
goes no further back than where an example opened (it counts the session's
`undo_depth` from there); Studio's own Undo, under **Studio editor**, is not limited.

**Differences from the RFD4-Proteina page's card.** Same markup, ids, labels,
tooltips, CSS and behaviour; where they differ it is because the page's card read a
`StudioDoc` object in the same page and this one reads the API:

- **Save all (.zip)** is a store-only zip (no compression; the page used JSZip with
  DEFLATE and a CDN script). Same files, same contents.
- **+ pdb** takes `.cif`, `.mmcif`, `.pdb` and `.ent` files (a PDB file is converted to
  mmCIF in the browser, as the server takes mmCIF only); `.cif.zst` is not read.
- A file dropped on the start screen opens through `openFile`, as Open CIF does.
- Designs open as sessions made from the design's CIF (the page registered them in its
  in-page store); a design's trajectory is a blob URL for Show trajectory.
- The Undo button stops at where an example was opened (see above).
- Live frames, motif overlays, hotspot numbering and weights loading are the provider's
  (`hooks.frame`, `DesignInfo.hotspots/overlays`, `hooks.loading`, `inputChanged`), not
  the card's; the card keeps the viewer's live mode and the order of frames.
- A DOM container `#rfd4p-extras` (no box of its own) holds what `renderExtras` adds.

### Design card in a frame

A host that keeps Studio in an iframe (the Gradio host: ZeroGPU wants the call to come
from the top-level page) opens it with `?embed=1&card=1&parent_origin=<the host's
origin>`. The card then asks the parent for an engine and sends generate and refold
requests to it with `postMessage`. Every message the frame sends is
`{ source: "atomworks-studio", channel: "design-card", type, ... }` to `parent_origin`;
every message the parent sends is `{ source: "atomworks-design-host", type, ... }`, and the
frame accepts only those from its parent's window and origin.

| Frame → parent | Meaning |
| --- | --- |
| `hello` | The card started; answer with `config`. It waits 3 s, then runs with no engine. |
| `generate` `{ id, request }` | `request` is `{ sessionId, cif, name, revision, task, settings }` (`settings` as `RunSettings`). |
| `refold` `{ id, design, settings }` | `design` is `{ id, name, cif, kind, data }`, `settings` the Refold box's. |
| `abort` `{ id }` | Stop was pressed. |
| `guide` | The Guide button was pressed. |

| Parent → frame | Meaning |
| --- | --- |
| `config` `{ engine, settings?, refold?: { models, limits? }, guide?, zipTitle? }` | What a `DesignCardProvider` has: the badge, which settings the engine takes, the refold models, whether there is a Guide. |
| `status` / `progress` / `loading` `{ id, … }` | `hooks.status(text, options)`, `hooks.progress(fraction, label)`, `hooks.loading(text)`. |
| `frame` `{ id, cif, options }` / `design` `{ id, design }` | `hooks.frame`, `hooks.design` (a `DesignInfo`). Handled in the order sent. |
| `done` `{ id, result? }` / `error` `{ id, message, userMessage? }` | The run ended; `result` is `{ message? }`. |
| `refold-status` / `refold-result` / `refold-error` `{ id, … }` | A refold's progress, its `RefoldResult`, or why it failed. |

All of it is JSON: a design's CIF travels as a string. `prepare` (fetching the refold
model ahead of the click) is not forwarded; the host prepares on its own.

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
