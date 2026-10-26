/** Derive the whole range from the gesture's initial selection, never from hover history. */
export function sequenceRangeSelection(
  residues: readonly { atoms: readonly number[] }[],
  start: number,
  end: number,
  baseline: ReadonlySet<number>,
  remove: boolean,
): Set<number> {
  const selected = new Set(baseline);
  for (let order = Math.min(start, end); order <= Math.max(start, end); order++) {
    for (const atom of residues[order].atoms) {
      if (remove) selected.delete(atom);
      else selected.add(atom);
    }
  }
  return selected;
}
