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

AtomWorks is the public 3.0.1 release from PyPI; `uv.lock` records its artifacts
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

- `packages/pymol-plugin/display.py`: display preparation and style generation from
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

The HER2 CDR-H3 antibody example follows the separate-Ig-groups, absolute-target
variant of RFD4’s `IgFrameworkConditioningTask` at `e519afe329a0963172747e9f71e843a21b6995e8`
(`src/rfproteina/transforms/design_task.py`, steps 3–7). Resolved sequence-fixed
heavy/light atoms belong to internal groups 1/2; HER2 retains absolute group 0.
H99–H109 remains free for sequence and coordinate design. Framework Lys30 is
included in the heavy-chain group. `scripts/prepare_antibody_example.py` reproduces
this policy while preserving topology, charges, sequence/index conditions and
other annotations. Internal targets are materialized during RFD4 featurization.

The SAM binder retains a 150-residue protein segment and unconditioned ligand
geometry. Its 27 heavy-atom coordinates match RFD4
`data/benchmarks/adherence/interchain_interaction_conditioning/sam_pistack_aromatic_ring.cif`
at `42d82947c2590c7e2dc73e93a073a3fdd03590f7`, mapped from custom atom names
to SAM CCD names with matching elements and bond connectivity. Only coordinates
are transferred; Studio's ligand chemistry and conditions remain unchanged.
