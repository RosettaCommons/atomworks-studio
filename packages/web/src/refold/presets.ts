/**
 * The models Studio knows by name, so a host lists `{ id: "af3" }` and the panel supplies the label and the terms.
 * Both host kinds (a Python provider returning JSON, the page's LocalFold) then show the same dialog and the same
 * wording: the text lives here once.
 */
import type { RefoldModel, RefoldModelInput, RefoldTerms } from "./types.ts";

/** Google DeepMind's AlphaFold 3 parameters: not for commercial use, under a prohibited-use policy. */
export const ALPHAFOLD3_TERMS: RefoldTerms = {
  title: "AlphaFold 3 model parameters",
  paragraphs: [
    "These are Google DeepMind's parameters. They are not available for commercial use and carry a prohibited-use policy.",
    "**OpenBind-0** runs the same architecture under Apache 2.0. It is a different model.",
  ],
  links: [
    { label: "AlphaFold 3 weights terms", href: "https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_TERMS_OF_USE.md" },
    { label: "prohibited use policy", href: "https://github.com/google-deepmind/alphafold3/blob/main/WEIGHTS_PROHIBITED_USE_POLICY.md" },
  ],
  storageKey: "atomworks-studio.refoldTerms.af3",
  switchTo: { model: "openbind0", label: "Use OpenBind-0" },
  agreeLabel: "I agree, use AlphaFold 3",
};

/** Terms a provider can name instead of spelling out. */
export const TERMS_PRESETS: Record<string, RefoldTerms> = {
  alphafold3: ALPHAFOLD3_TERMS,
  af3: ALPHAFOLD3_TERMS,
};

export const MODEL_PRESETS: Record<string, RefoldModel> = {
  af3: { id: "af3", label: "AlphaFold 3", terms: ALPHAFOLD3_TERMS },
  openbind0: { id: "openbind0", label: "OpenBind-0" },
};

/** A provider's model entry, completed from the presets: a known id needs nothing else. `terms: null` drops a preset's. */
export function resolveModel(input: RefoldModelInput): RefoldModel {
  const preset = MODEL_PRESETS[input.id];
  const terms = input.terms === undefined ? preset?.terms
    : input.terms === null ? undefined
    : typeof input.terms === "string" ? TERMS_PRESETS[input.terms]
    : input.terms;
  if (typeof input.terms === "string" && !terms) throw new Error(`Unknown refold terms preset "${input.terms}"`);
  const model: RefoldModel = { id: input.id, label: input.label ?? preset?.label ?? input.id };
  if (terms) model.terms = terms;
  return model;
}
