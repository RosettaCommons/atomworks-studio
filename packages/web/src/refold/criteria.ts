/**
 * How a refold's numbers are judged. Upstream's pass criteria for the jobs whose every number a refold measures
 * (`configs/metrics/pass_criteria`): the panel applies them to a design's `kind`, so a host reports numbers and says
 * what kind of job made the design, and every host shows the same verdict.
 *
 * Motif, enzyme and small-molecule jobs also need ligand RMSDs and thresholds this panel does not apply, so they show
 * their numbers and no verdict (`kind: null`); a provider that judges them itself returns `pass` with its result.
 */
import type { RefoldKind, RefoldMetrics } from "./types.ts";

type Rule = { key: keyof RefoldMetrics & string; min?: number; max?: number };

export const PASS_CRITERIA: Record<Exclude<RefoldKind, null>, Rule[]> = {
  // unconditional: refolded backbone RMSD ≤ 1.5 Å
  monomer: [{ key: "rmsd", max: 1.5 }],
  // ppi: pTM of the binder ≥ 80, min iPAE ≤ 1.5, binder RMSD with the target aligned ≤ 2.5 Å
  binder: [{ key: "chainPtm", min: 0.8 }, { key: "minIpae", max: 1.5 }, { key: "placedRmsd", max: 2.5 }],
  // antibody: min iPAE ≤ 2.0, binder RMSD with the target aligned ≤ 2.0 Å
  antibody: [{ key: "minIpae", max: 2.0 }, { key: "placedRmsd", max: 2.0 }],
};

/** The RMSD, Å, at or below which a de novo design is usually called self-consistent. */
export const SELF_CONSISTENT_RMSD_A = 2;

/** Whether `metrics` meet the criteria of `kind`: true, false, or null (no criteria, or a number missing). */
export function passes(metrics: RefoldMetrics | null | undefined, kind: RefoldKind | undefined): boolean | null {
  const rules = kind ? PASS_CRITERIA[kind] : undefined;
  if (!rules || !metrics) return null;
  for (const { key, min, max } of rules) {
    const value = metrics[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    if ((min != null && value < min) || (max != null && value > max)) return false;
  }
  return true;
}

/** The number a job's designs are best ranked by, and which way (1 ascending, -1 descending): upstream's first criterion. */
export function rankKey(kind: RefoldKind | undefined): { key: string; dir: 1 | -1 } {
  if (kind === "binder" || kind === "antibody") return { key: "minIpae", dir: 1 };
  if (kind === "monomer") return { key: "rmsd", dir: 1 };
  return { key: "plddt", dir: -1 };
}

/** A finite number from a metric, or null: JSON carries a missing number as null, a fold as NaN. */
export function finiteMetric(metrics: RefoldMetrics | null | undefined, key: string): number | null {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
