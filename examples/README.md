# Example structures

The **Edit → Examples** menu uses the packaged catalog in
`packages/api/annotation_studio/examples/`. The PD-L1 protein binder and eight
NIM inputs also power the Gradio demo; model execution is optional.

The files below remain regression fixtures and can be opened with **Open CIF**:

- `mcsa_ph2.cif`: catalytic residues and PH2 ligand with a 180 residue expandable
  segment. Source: RFD4 `mcsa_40_fixed_ligand.json:M0664_2dhn`.
- `disco_iai.cif`: IAI ligand with a 150 residue expandable segment.
  Source: RFD4 `sm_binder.json:IAI`.

The files illustrate stored annotations, ligand editing, and expandable segments.
They open in browser, VS Code, and PyMOL without a model runtime.
