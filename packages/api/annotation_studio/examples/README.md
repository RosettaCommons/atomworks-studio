# Design examples

Eight inputs from the private RFD4 NIM, revision
`3a8a1f6f2ed6bab37757d2471b5007971175225d`, under `nim/examples/*/request.json`.
Motif, partial-diffusion and inverse-folding CIF contents are unchanged.
Enzyme and VHH inputs include missing heavy atoms with free coordinates.
Antibody and unconditional condition specs use the standard-annotation serializer;
the antibody uses separate internal heavy/light framework groups and a fixed target.
SAM uses the positioned conformer from RFD4’s interaction examples while leaving
coordinate conditioning off. See `docs/PROVENANCE.md` for sources and preparation.

`examples.json` pairs each CIF with its sampling task. Partial diffusion uses
40% of the trajectory; inverse folding uses the native inverse-folding sampler.
The model deployment chooses the native recycling preset and design count.
Example selection does not enable refolding or establish biological design quality.

`protein_binder.cif` comes from RFD4 `all_ppi.yaml:rfd3_pdl1`: a fixed PD-L1
target, six hotspot atoms on residues 56, 115 and 123, and a separate 50–120
residue binder segment. It uses the standard protein sampler with these conditions.

Keep this directory nonpublic until release review.
