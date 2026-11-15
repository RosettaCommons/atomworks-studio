/**
 * What "Save all (.zip)" holds: the annotated input a run designed from, each design (final structure and its
 * diffusion trajectory), every refold made of it, and a summary of all of them, as mmCIF only (a PDB would repeat the
 * same coordinates and lose the input's conditions). Pure, so it is unit-tested without a browser; the card gathers the
 * data and zips the files (`zipStore`).
 */

const THREE_TO_ONE: Record<string, string> = {
  ALA: "A", ARG: "R", ASN: "N", ASP: "D", CYS: "C", GLN: "Q", GLU: "E", GLY: "G", HIS: "H", ILE: "I", LEU: "L",
  LYS: "K", MET: "M", PHE: "F", PRO: "P", SER: "S", THR: "T", TRP: "W", TYR: "Y", VAL: "V",
  DA: "A", DC: "C", DG: "G", DT: "T", A: "A", C: "C", G: "G", U: "U",
};

/** Polymer sequence per chain of a PDB, in file order: `{A: 'MKV...'}`; unknown residues read as X. */
export function pdbSequences(pdb: string | null | undefined): Record<string, string> {
  const chains: Record<string, string> = {};
  const seen = new Set<string>();
  for (const line of (pdb ?? "").split("\n")) {
    if (!line.startsWith("ATOM")) continue;
    const key = `${line[21]}:${line.slice(22, 27)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chains[line[21]] = (chains[line[21]] ?? "") + (THREE_TO_ONE[line.slice(17, 20).trim()] ?? "X");
  }
  return chains;
}

const round = (v: unknown, digits: number): number | null => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(digits)) : null);

/** The refold models' names, and for a licence-gated one the lines the README quotes (its terms). */
export type ResultsModels = Record<string, { name: string; termsLines?: string[] }>;

export const DEFAULT_RESULTS_MODELS: ResultsModels = {
  af3: {
    name: "AlphaFold 3",
    termsLines: [
      "https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_TERMS_OF_USE.md",
      "https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_PROHIBITED_USE_POLICY.md",
    ],
  },
  openbind0: { name: "OpenBind-0" },
};

/** A refold of a design, with what the summary records of it. */
export type ResultsRefold = {
  model: string;
  /** The refold's structure (mmCIF), in the design's frame; saved as its own file. */
  cif?: string | null;
  seed?: number | null;
  recycles?: number | null;
  steps?: number | null;
  /** The RMSD of the designed chain's shape, fitted on itself (Å). */
  rmsd?: number | null;
  confidence?: { meanPlddt?: number | null; ptm?: number | null; iptm?: number | null };
  metrics?: { placedRmsd?: number | null; chainPtm?: number | null; minIpae?: number | null; motifRmsd?: number | null; motifBackboneRmsd?: number | null };
  pass?: boolean | null;
  templated?: string[];
  partial?: { chain: string; residues: number | string }[];
  text?: string | null;
};

export type ResultsDesign = {
  index: number;
  label: string;
  seed?: number | null;
  stepsRun?: number | null;
  nsteps?: number | null;
  cif: string;
  /** Read for the summary's sequences only; never written. */
  pdb?: string | null;
  trajectoryCif?: string | null;
  designedChains?: string[];
  refolds?: ResultsRefold[];
};

export type ResultsFile = { name: string; text: string };

function refoldSummary(r: ResultsRefold, models: ResultsModels) {
  const c = r.confidence ?? {};
  return {
    model: r.model,
    model_name: models[r.model]?.name ?? r.model,
    seed: r.seed ?? 0,
    recycles: r.recycles ?? null,
    steps: r.steps ?? null,
    rmsd_designed_chain: round(r.rmsd, 3),
    rmsd_on_target: round(r.metrics?.placedRmsd, 3),
    plddt: round(c.meanPlddt, 2),
    ptm: round(c.ptm, 3),
    iptm: round(c.iptm, 3),
    designed_chain_ptm: round(r.metrics?.chainPtm, 3),
    min_ipae: round(r.metrics?.minIpae, 3),
    motif_rmsd: round(r.metrics?.motifRmsd, 3),
    motif_backbone_aligned_rmsd: round(r.metrics?.motifBackboneRmsd, 3),
    passes: r.pass ?? null,
    templated_chains: r.templated ?? [],
    partial_templates: (r.partial ?? []).map((p) => ({ chain: p.chain, residues: p.residues })),
    description: r.text ?? null,
  };
}

type Cell = string | number | boolean | null | undefined | (string | number)[];

const csvCell = (v: Cell): string => {
  const s = v == null ? "" : Array.isArray(v) ? v.join(" ") : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export type ResultsOptions = {
  input?: { cif: string | null; name?: string | null; revision?: number | null } | null;
  designs: ResultsDesign[];
  /** ISO time. */
  generatedAt?: string;
  /** The page's URL. */
  page?: string;
  /** The README's first line; "Design results" by default. */
  title?: string;
  models?: ResultsModels;
  /** Files the host adds (an engine's log, say), appended as they are. */
  extraFiles?: ResultsFile[];
};

/** The package's files, in order: input, designs with their trajectories and refolds, summary.json, summary.csv, README.txt. */
export function resultsFiles({
  input, designs, generatedAt = new Date().toISOString(), page = "", title = "Design results",
  models = DEFAULT_RESULTS_MODELS, extraFiles = [],
}: ResultsOptions): ResultsFile[] {
  const files: ResultsFile[] = [];
  if (input?.cif) files.push({ name: "input.cif", text: input.cif });
  const rows: Record<string, Cell>[] = [];
  const summary = {
    generated_at: generatedAt,
    page,
    input: input?.cif ? { file: "input.cif", name: input.name ?? null, revision: input.revision ?? null } : null,
    designs: [] as unknown[],
  };
  let usesTerms = false;
  const termsLines: string[] = [];
  for (const d of designs) {
    const stem = `design-${d.index}`;
    files.push({ name: `${stem}.cif`, text: d.cif });
    if (d.trajectoryCif) files.push({ name: `${stem}-trajectory.cif`, text: d.trajectoryCif });
    const refolds = [];
    const all = d.refolds ?? [];
    for (const [k, r] of all.entries()) {
      // a second refold with the same model gets its own name rather than replacing the first
      const sameModelBefore = all.slice(0, k).filter((x) => x.model === r.model).length;
      const rstem = `${stem}-refold-${r.model}${sameModelBefore ? `-${sameModelBefore + 1}` : ""}`;
      if (r.cif) files.push({ name: `${rstem}.cif`, text: r.cif });
      const lines = models[r.model]?.termsLines;
      if (lines?.length) {
        usesTerms = true;
        for (const line of lines) if (!termsLines.includes(line)) termsLines.push(line);
      }
      refolds.push({ files: r.cif ? [`${rstem}.cif`] : [], ...refoldSummary(r, models) });
    }
    const sequences = pdbSequences(d.pdb);
    summary.designs.push({
      index: d.index, label: d.label, seed: d.seed ?? null, steps_run: d.stepsRun ?? null, steps: d.nsteps ?? null,
      designed_chains: d.designedChains ?? [], sequences,
      files: [`${stem}.cif`, d.trajectoryCif ? `${stem}-trajectory.cif` : null].filter(Boolean),
      refolds,
    });
    const base: Record<string, Cell> = {
      design: d.index, seed: d.seed ?? null, steps_run: d.stepsRun ?? null, designed_chains: d.designedChains ?? [],
      sequences: Object.entries(sequences).map(([c, s]) => `${c}:${s}`),
    };
    if (refolds.length === 0) rows.push(base);
    for (const r of refolds) {
      rows.push({
        ...base, refold_model: r.model, refold_seed: r.seed, refold_recycles: r.recycles, refold_steps: r.steps,
        rmsd_designed_chain: r.rmsd_designed_chain, rmsd_on_target: r.rmsd_on_target,
        plddt: r.plddt, ptm: r.ptm, iptm: r.iptm, designed_chain_ptm: r.designed_chain_ptm, min_ipae: r.min_ipae,
        motif_rmsd: r.motif_rmsd, motif_backbone_aligned_rmsd: r.motif_backbone_aligned_rmsd,
        passes: r.passes, templated_chains: r.templated_chains,
        partial_templates: r.partial_templates.map((p) => `${p.chain}:${p.residues}`),
      });
    }
  }
  files.push({ name: "summary.json", text: `${JSON.stringify(summary, null, 2)}\n` });
  const columns = ["design", "seed", "steps_run", "designed_chains", "sequences", "refold_model", "refold_seed", "refold_recycles",
    "refold_steps", "rmsd_designed_chain", "rmsd_on_target", "plddt", "ptm", "iptm", "designed_chain_ptm", "min_ipae", "motif_rmsd",
    "motif_backbone_aligned_rmsd", "passes", "templated_chains", "partial_templates"];
  files.push({
    name: "summary.csv",
    text: `${[columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\n")}\n`,
  });
  files.push({ name: "README.txt", text: readme({ hasInput: Boolean(input?.cif), usesTerms, termsLines, page, generatedAt, title }) });
  return [...files, ...extraFiles];
}

function readme({ hasInput, usesTerms, termsLines, page, generatedAt, title }: {
  hasInput: boolean; usesTerms: boolean; termsLines: string[]; page: string; generatedAt: string; title: string;
}): string {
  const lines = [
    title,
    `Saved ${generatedAt}${page ? ` from ${page}` : ""}`,
    "",
    ...(hasInput ? ["input.cif                     the annotated input the run designed from (conditions included);",
      "                              open it in the page to design again"] : []),
    "design-N.cif                  design N, the final structure",
    "design-N-trajectory.cif       design N, every diffusion step (multi-model)",
    "design-N-refold-<model>.cif   a refold of design N's sequence, in the design's frame;",
    "                              the B-factor column is the model's pLDDT",
    "summary.json / summary.csv    per design: seed, steps, designed chains, sequences; per refold: model,",
    "                              RMSDs, pLDDT, pTM, ipTM, min iPAE, whether it passes, templated chains",
    "",
    "rmsd_designed_chain compares the designed chain's shape, fitted on itself. rmsd_on_target fits the refold on",
    "every other chain first, so where a binder sits on its target counts. min_ipae is the lowest predicted aligned",
    "error between a designed residue and another chain's. passes applies the model's own pass criteria",
    "(RFD4-Proteina configs/metrics/pass_criteria): monomers RMSD <= 1.5 A; binders designed-chain pTM >= 0.80,",
    "min iPAE <= 1.5, RMSD on target <= 2.5 A; antibodies min iPAE <= 2.0, RMSD on target <= 2.0 A. Empty where",
    "no criteria apply (motifs, enzymes and small-molecule binders also need ligand RMSDs and thresholds not applied here).",
    "motif_rmsd is RFD4-Proteina's refolded_motif_allatom_rmsd: the refold fitted on the motif atoms the run held (each rigid",
    "group on its own), RMSD of those atoms. motif_backbone_aligned_rmsd is the same atoms after fitting the refold on the",
    "designed chains' backbone, so where the motif sits in the scaffold counts. Empty where a design has no motif.",
  ];
  if (usesTerms) {
    lines.push("", "AlphaFold 3 refolds were made with Google DeepMind's AlphaFold 3 parameters, which are for",
      "non-commercial use and carry a prohibited-use policy:", ...termsLines.map((l) => `  ${l}`));
  }
  return `${lines.join("\n")}\n`;
}
