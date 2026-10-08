# Design examples

Eight inputs from the private RFD4 NIM, revision
`3a8a1f6f2ed6bab37757d2471b5007971175225d`, under `nim/examples/*/request.json`.
The enzyme, motif, ligand binder, VHH, partial-diffusion and inverse-folding
CIF contents are unchanged. Antibody and unconditional condition specs were
converted with the native RFD4 condition-spec builder and standard-annotation
serializer. Antibody framework/target conditions and excluded CDR H3 are retained.

`examples.json` pairs each CIF with its sampling task. Partial diffusion uses
40% of the trajectory; inverse folding uses the native inverse-folding sampler.
The model deployment chooses the native recycling preset and design count.
Example selection does not enable refolding or establish biological design quality.

`protein_binder.cif` comes from RFD4 `all_ppi.yaml:rfd3_pdl1`: a fixed PD-L1
target, six hotspot atoms on residues 56, 115 and 123, and a separate 50–120
residue binder segment. It uses the standard protein sampler with these conditions.

Keep this directory nonpublic until release review.
