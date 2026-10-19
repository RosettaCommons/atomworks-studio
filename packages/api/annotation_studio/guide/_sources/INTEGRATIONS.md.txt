# Use Studio in a workflow

Use the editing library for Python code and the HTTP API when another process
owns the document. Neither interface needs a browser, Qt, a model runtime, or a
GPU. Both currently install AtomWorks 3's ML dependencies, including Torch.

## Python primitives

Install `atomworks-studio-editing` for base AtomWorks conditions. Add
`atomworks-annotation-studio-rfd4` for the same hotspot, group, and other condition
definitions that the full Studio installation uses. Until these packages are
published, install the wheels from a verified build with `pip --find-links`.

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
    provider=RFD4GenerationProvider(noise_defaults=(0.3, 0.1)),
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
    {"task": "antibody_design", "thinking": "medium", "samples": 1, "seed": 42},
    api_name="/generate_cif",
)
Path("design.cif").write_text(result["designs"][0])
```

The editor button and this endpoint call the same validated model callback.

The deployment owns model weights, CUDA dependencies and execution. Pass native
noise defaults from its inference configuration to the RFD4 provider. No Torch
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
