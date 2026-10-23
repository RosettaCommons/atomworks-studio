import type { ViewerCommand } from "../viewers/contract";

export const FALLBACK_SAFE_PATINAE_COMMANDS = new Set([
  "show",
  "hide",
  "color",
  "zoom",
  "center",
  "orient",
  "enable",
  "disable",
  "toggle",
]);

// Commands that create, rename or re-bond objects, or move or drop coordinates,
// desynchronize the viewer from the annotated CIF.
export const STUDIO_UNSAFE_PATINAE_COMMANDS = new Set([
  "align", "alter", "biounit", "bond", "copy", "create", "delete", "delete_states", "extract",
  "fuse", "load", "load_traj", "materialize", "pseudoatom", "reinitialize", "rotate", "set_name",
  "setup_ccd", "split_states", "symexp", "transform_selection", "translate", "unbond",
]);

export function findPatinaeCommand(catalog: readonly ViewerCommand[], verb: string): ViewerCommand | undefined {
  return catalog.find((entry) =>
    entry.name.toLowerCase() === verb
    || entry.aliases?.some((alias) => alias.toLowerCase() === verb)
  );
}

export function patinaeCommandAllowed(
  catalog: readonly ViewerCommand[],
  verb: string,
  metadata = findPatinaeCommand(catalog, verb),
): boolean {
  return catalog.length
    ? metadata?.webSafe !== false && metadata !== undefined && !STUDIO_UNSAFE_PATINAE_COMMANDS.has(metadata.name)
    : FALLBACK_SAFE_PATINAE_COMMANDS.has(verb);
}
