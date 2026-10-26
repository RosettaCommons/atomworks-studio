# Example structures

The **Main → Examples** menu uses the packaged catalog in
`packages/api/annotation_studio/examples/`. The same ten inputs power the Gradio
demo; model execution is optional. Open them with the **Annotated CIF** preset
when using the file picker; the example buttons choose this preset automatically.

| Example file | Design intent |
| --- | --- |
| `protein_binder.cif` | BHRF1 target chain B: full sequence, backbone-only internal coordinates; new chain A: 50–120 residues. |
| `ptm_binder.cif` | H3pS10 hit04 target chain B, including phosphoserine: sequence only, no coordinate/hotspot conditions; new chain A: exactly 150 residues. |
| `enzyme_design.cif` | PTE p2H11's eight complete motif residues and all original ligand/metal components. Seven canonical residues are unindexed in separate groups. KCX stays indexed, flanked by independent 75–100 residue segments on chain A. Original tip/ligand coordinates and motif/ligand sequence conditions are retained. |
| `inverse_folding.cif` | Complete PTE p2H11 hit: original motif/ligand sequence conditions, original tip/ligand coordinate targets, plus absolute N/CA/C/O coordinates across chain A. Other protein residues have free sequence. |
| `partial_diffusion.cif` | BHRF1 generated complex (111-residue binder A and 157-residue target B), copied byte-for-byte with its existing conditions for partial diffusion. |
| `antibody_design.cif` | MZB1 / adalimumab Fv with six expandable CDRs. |
| `nanobody.cif` | PD-L1 / VHH with expandable CDRs. |
| `motif_scaffolding.cif` | 1QJG motif-scaffolding input. |
| `small_molecule_binder.cif` | SAM ligand with a 150-residue design segment. |
| `unconditional.cif` | Unconditional protein design. |

All segments remain collapsed. The two PTE scaffold ranges sample independently:
150–200 generated residues in total, with KCX between them and seven unindexed
motif residues placed by the model. The PTE full-hit example uses the
`inverse_folding` task. The BHRF1 complex uses `partial_diffusion`; enable partial-diffusion
sampling for the BHRF1 complex in the runner.
The PTM binder uses the general protein-design task with its CIF conditions.

### Hit provenance and validation

PTE p2H11 and H3pS10 hit04 come from the
`RFD4-Proteina-paper/structures/figures_4_6_non_idr_hits` collection. BHRF1 comes
from the supplied `29_BHRF1_rep6_job18_generated.cif`. Source hashes and saved-file
hashes are recorded in `hit-example-provenance.json` beside the CIFs.
`scripts/build_hit_examples.py` rebuilds the five inputs from explicit source
paths and checks save/reload preservation of atom identities, coordinates, bonds,
charges, and stored annotations. No ligand chemistry or metal coordination was
invented, and no missing atoms were added. The BHRF1 partial-diffusion input is an exact source copy, retaining both chains
and every saved condition.

Source terminal OXT atoms remain absent: one in the PTE inverse-folding input,
one each in the H3pS10 and BHRF1 targets, and two in the BHRF1 partial-diffusion complex. Studio may request a save override for these missing atoms. These are source-preserving example inputs;
structural/annotation checks do not establish generation quality.

The current RFD4 validation pipeline was also run on the five updated inputs.
PTE scaffolding, H3pS10, and both BHRF1 inputs pass pipeline and index-group checks. PTE
inverse folding passes the pipeline but retains the source numbering gap near
KCX (105 is atomized; 106 is absent). The separate index-group gap check reports
104 to 107. Existing saved motif coordinate targets are retained, including their
small differences from the generated hit's displayed coordinates.

The BHRF1 partial-diffusion complex retains its source conditioning: target
sequence and absolute backbone coordinates, plus the existing binder coordinates
as the starting structure. This differs from the separate BHRF1 protein-binder
example, which uses internal target coordinates and an expandable design chain.
PTE custom-ligand sanitization also emits diagnostic
warnings; the authored bond graph and formal charges are preserved. The detailed
results are in `hit-example-validation.json` alongside the packaged CIFs.
Generation outputs have not been tested.

The files below remain regression fixtures and can be opened with **Open CIF**:

- `mcsa_ph2.cif`: catalytic residues and PH2 ligand with a 180 residue expandable
  segment. Source: RFD4 `mcsa_40_fixed_ligand.json:M0664_2dhn`.
- `disco_iai.cif`: IAI ligand with a 150 residue expandable segment.
  Source: RFD4 `sm_binder.json:IAI`.

The files illustrate stored annotations, ligand editing, and expandable segments.
They open in browser, VS Code, and PyMOL without a model runtime.
