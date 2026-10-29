# Architecture

AtomWorks owns molecular arrays, annotations, chemical data, selection syntax,
and CIF parsing. Studio owns the editing interface and transactional Undo.

| Component | Responsibility |
| --- | --- |
| `packages/editing` | Documents, mutations, selection, validation, and Undo. |
| `providers/rfd4` | Shared annotation definitions and coupled edits for RFD4 conditions. |
| `packages/api` | Bounded sessions and HTTP access to the editing library. |
| `packages/web` | Browser editor with Patinae and Mol* renderers. |
| `packages/vscode` | Embeds the browser editor and forwards the host theme. |
| `packages/pymol-plugin` | Native Qt controls and synchronization with PyMOL objects. |

All components ship together in the single `atomworks-studio` Python distribution.

Browser and VS Code use the API's document as their source of truth. PyMOL keeps
a `StudioDocument` per object in process. All hosts load the same installed
annotation provider. Files, values, levels, defaults, and coupled coordinate edits
therefore follow one contract. Tab names and order are defined once in the editing
package and used by Qt and the browser. Renderers own display state only.

Public AtomWorks supplies sequence, coordinate, index, terminal, and distance
conditions. Hotspots, groups, RASA, CATH, and other RFD4 conditions extend its
annotation registry. The RFD4 annotation wheel includes only pinned definitions,
parse presets, vocabulary, and their license. It does not import the model package
initializer or install its inference dependencies.

Edits are atomic: a failed operation restores the prior array; nested operations
form one Undo step. Coordinates and saved internal targets are changed together.
Discarding targets requires confirmation tied to the document revision. Saving
validates and serializes one frozen snapshot. Checks cover editing and structural
consistency, not whether a model will accept or successfully generate from the file.

Sessions are process-local and bounded. Set `ANNOTATION_STUDIO_SESSION_DIR` to
persist CIF snapshots across server restarts; Undo history is in memory. Run one
server process. Optional proxy identity support isolates users' session lookups.

Patinae's WebGPU support is for molecular rendering. The base editor has no
model runtime or GPU provisioning. The optional Gradio host embeds the same web
editor and queues calls to a deployment-supplied generation function. The model
repository owns checkpoint loading and inference; the host owns CIF handoff,
result selection and downloads.
