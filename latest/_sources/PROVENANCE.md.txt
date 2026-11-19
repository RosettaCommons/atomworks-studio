# Source provenance

AtomWorks Studio originated in RFD4-Proteina editor work. Its editor code is
maintained in this repository; scientific condition definitions remain upstream.

The Patinae browser bundle and optional desktop launcher are pinned to upstream
[`ba03133`](https://github.com/zmactep/patinae/commit/ba03133e59243394a9c425d0538ca5d2f33d528d)
(v0.5.1). `vendor/patinae/UPSTREAM.toml` records the full revision and bundle checksum.
Two patches remain in `vendor/patinae/patches`: a WebAssembly-compatible renderer
clock, and a structured browser bridge for atom identities, selections, command
metadata, and measurements. Measurements and labels use upstream's scene and
rendering code. The earlier trajectory and custom rendering patches are removed;
upstream now handles multi-model CIF trajectories directly.

`bash scripts/build_patinae_viewer.sh` verifies the checked-in bundle. Set
`ATOMWORKS_STUDIO_REBUILD_PATINAE=1` to rebuild it using the pinned Rust toolchain,
upstream's npm lockfile, and the patch series.

## Dependencies

AtomWorks is the public release pinned in `dependencies.toml`, from PyPI; `uv.lock` records its artifacts
and hashes. Studio no longer vendors a separate private AtomWorks checkout.
RFD4 definitions come from `RosettaCommons/RFD4-Proteina` at
`e519afe329a0963172747e9f71e843a21b6995e8`. The five unchanged definition, vocabulary, and license files
are committed under `providers/rfd4/atomworks_studio_rfd4/_upstream`.
`providers/rfd4/UPSTREAM.toml` records their SHA-256 hashes, verified by CI and
package builds. No private checkout or model runtime is required.

## Migrated editor code

Some editor code was copied out of the dependencies so Studio can track their
default branches; it is maintained here. Upstream removal is a separate, gated change; see
[release acceptance](ACCEPTANCE.md). Re-verify parity when updating upstream definitions.

- `packages/editing/atomworks_studio_editing/{structure_mutations,mutations,validation}.py`
  — from atomworks commit `8e4b2c39` (before upstream removal).
- `providers/rfd4/atomworks_studio_rfd4/interactive_validation.py` and the
  model-specific PyMOL widgets originated in RFD4 commit `0e9050ca`. Semantic
  editor metadata belongs to Studio and is derived from the scientific annotation
  contract from AtomWorks 3's value-derived annotations.
- `providers/rfd4/atomworks_studio_rfd4/internal_coordinate.py` adapts Studio
  atom indices to RFD4's shared mask/group authoring function. Centering and
  random rotation live exclusively in RFD4 featurization;
  `tests/test_rfd4_internal_coords.py` guards that boundary.


The base PyMOL plugin (`packages/pymol-plugin`) is published as
`atomworks_studio_pymol`; upstream removal of its former
`atomworks.pymol_plugin` copy remains subject to the acceptance gates above.

Additional Studio-owned components extracted during the unified-editor refactor:

- `packages/pymol-plugin/atomworks_studio_pymol/display.py`: display preparation and style generation from
  AtomWorks `82fd08ae51688f48ff2949ae16ee320d87d434a1`, `ml/utils/visualize.py`.
- `providers/rfd4/atomworks_studio_rfd4/reporting.py`: summaries and index-group
  synchronization from RFD4 `26094e08e6f979ee6da53d51bc34357ffc062025`,
  `conditions_reporting.py`. Studio performs annotation checks only; full model pipeline validation is outside
  the editor.
- CATH input vocabulary validation follows the current RFD4 editor's C.A.T.x
  convention. The vocabulary data and condition definition remain upstream.
- `providers/rfd4/atomworks_studio_rfd4/sequence_probability.py`: input
  canonicalization and validation extracted from RFD4
  `a12ccf17f746590b05ebe032ce744af2c7caa485`,
  `datapipes/pipeline.py` and `transforms/invariants.py`. Scientific condition
  definitions and token vocabulary remain imported from upstream.
- Current-format coordinate authoring follows that same RFD4 revision's
  `transforms/utils/conditioning_utils.py`; group validation and preservation of
  saved targets remain upstream scientific responsibilities.
- The native `group_editor.py` was refreshed against `a12ccf17` for reserved
  group IDs, stale selection handling and per-atom defaults on removal/deletion.
  Confirmation and undo use Studio's shared document transaction.
- The shared missing-heavy-atom save check follows AtomWorks `38f44845`'s
  `pymol_plugin/panel.py`, including its configuration and log-and-skip behavior
  when preparation fails. Regression tests cover structures with and without explicit hydrogens.
- `packages/editing/atomworks_studio_editing/query.py` adapts query evaluation
  from that revision's `utils/mask_spec.py`. Studio derives selection fields on
  temporary copies so queries do not persist stale annotations in a document.

ConditionSpec, contig parsing, and their compiler tests remain owned by RFD4.
Studio does not vendor those modules. Coordinate-group separation used by
interactive document combination lives in `internal_coordinate.py`; it preserves
saved targets while giving independent inputs disjoint group IDs.

## Example CIFs

Bundled annotated examples contain their complete heavy-atom inventories. Added
atoms have NaN coordinates and no atom-level conditions; existing residue-level
conditions extend to the complete residue. The enzyme example adds seven ASP
atoms; protein binder, VHH, and `examples/mcsa_ph2.cif` each add one terminal OXT.
VHH entity metadata distinguishes its target and antibody chains.

`scripts/complete_example_atoms.py` uses AtomWorks templates and `to_cif_file`,
then verifies the original coordinates, charges, bonds, and StandardAnnotations
after reloading. Expandable segments remain collapsed and connected.

The antibody example is the cropped MZB1 (7AAH) target paired with the
adalimumab Fv framework (3WD5), recovered from RFD4-Proteina-dev commit
`64e59d8566cbc6ebd27bb6c76a62a4caec2fe6e2` on the historical
`feat/antibody-campaign-examples` branch:
`examples/antibody_design/structures/fv/mzb1_7AAH__Fv_3wd5_adalimumab.cif.zst`.
It was decompressed with Zstandard, then passed through
`scripts/complete_example_atoms.py`, adding only three unresolved terminal OXT
atoms. Existing coordinates, bonds, charges and StandardAnnotations were checked
for preservation after reloading with the minimal annotated-CIF preset.

The shared internal group contains the H/L framework backbones and their saved
internal-coordinate targets, preserving the VH–VL arrangement. The MZB1 backbone
retains absolute conditioning; framework sequences and CATH `2.60.40.x` remain
fixed. Six expandable CDRs retain the source ranges: H1 13–15, H2 9–10, H3 11–22,
L1 11–14, L2 8 and L3 8–12. This is an illustrative design input, not a validated
adalimumab–MZB1 binder. The obsolete HER2 preparation script has been removed.

For the VHH example, resolved chain H display coordinates were translated by
`(-97.658, -35.314, -13.544)` Å toward the PD-L1 target, reducing the closest
interchain atom distance from about 112 Å to 8 Å. No rotation, target-coordinate,
chemistry, or condition edits were made. In particular, saved internal-coordinate
targets are unchanged; this is a display placement, not a predicted binding pose.

The PD-L1 protein-binder example now uses one internal-coordinate group for all
460 resolved target backbone atoms (`N`, `CA`, `C`, `O`). Absolute-coordinate
targets were cleared, including sidechains. Internal targets remain unset for
RFD4 featurization to derive. Coordinates, target sequence/index conditions,
the six hotspot atoms and the 50–120 residue binder segment are unchanged.

The SAM binder retains a 150-residue protein segment and unconditioned ligand
geometry. Its 27 heavy-atom coordinates match RFD4
`data/benchmarks/adherence/interchain_interaction_conditioning/sam_pistack_aromatic_ring.cif`
at `42d82947c2590c7e2dc73e93a073a3fdd03590f7`, mapped from custom atom names
to SAM CCD names with matching elements and bond connectivity. Only coordinates
are transferred; Studio's ligand chemistry and conditions remain unchanged.

## PTE, PTM, and BHRF1 examples

The hit-based catalog supersedes the earlier PD-L1 protein-binder and 2KL8
inverse-folding entries described above. The PTE p2H11 and H3pS10 hit04 sources are the paper's curated hit files. BHRF1
is the supplied generated design: the binder example keeps its target, while
the partial-diffusion example is a byte-for-byte copy of the full complex. See `examples/README.md` for exact task definitions and retained source
limitations. `hit-example-provenance.json` records input/output hashes, and
`hit-example-validation.json` records model validation findings. The old 2KL8
and minimal catalytic-motif structures remain regression fixtures under
`tests/fixtures/`.
