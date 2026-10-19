import type { InteractionResult, SequenceChain } from "../types.ts";

/** Choose one atom pair per stacked residue pair without changing the analysis. */
export function interactionDisplayContacts(
  interactions: InteractionResult[],
  sequence: SequenceChain[],
): InteractionResult[] {
  const residueByAtom = new Map<number, number>();
  for (const [index, residue] of sequence.flatMap(chain => chain.items).entries()) {
    for (const atom of residue.atom_indices) residueByAtom.set(atom, index);
  }
  const stacks = new Set<string>();
  return interactions.filter(contact => {
    if (contact.interaction_type !== "pistacking") return true;
    const residue1 = residueByAtom.get(contact.atom1);
    const residue2 = residueByAtom.get(contact.atom2);
    if (residue1 === undefined || residue2 === undefined) return true;
    const key = `${Math.min(residue1, residue2)}:${Math.max(residue1, residue2)}`;
    if (stacks.has(key)) return false;
    stacks.add(key);
    return true;
  });
}
