import type { AtomIdentity, SelectionEvaluation } from "@baker-laboratory/patinae-viewer";

export function nativeAtomIndices(
  identities: readonly AtomIdentity[],
  documentIndices: readonly number[],
): number[] {
  if (!identities.length) return [...documentIndices];
  const byDocument = new Map(identities.map((atom) => [atom.document_index, atom]));
  const mapped = documentIndices.map((index) => byDocument.get(index));
  const missing = documentIndices.filter((_, index) => mapped[index] === undefined);
  if (missing.length) {
    throw new Error(`Patinae atom identity map is missing document indices: ${missing.join(", ")}`);
  }
  const atoms = mapped as AtomIdentity[];
  if (new Set(atoms.map((atom) => atom.object_name)).size > 1) {
    throw new Error("A single Patinae command cannot target document atoms across multiple objects.");
  }
  return atoms.map((atom) => atom.atom_index);
}

export function documentAtomIndices(
  identities: readonly AtomIdentity[],
  selection: SelectionEvaluation,
): number[] {
  if (!identities.length) {
    return selection.objects.flatMap((object) => object.atom_indices);
  }
  const byNative = new Map(
    identities.map((atom) => [`${atom.object_name}\0${atom.atom_index}`, atom.document_index]),
  );
  return selection.objects.flatMap((object) => object.atom_indices.map((index) => {
    const documentIndex = byNative.get(`${object.object_name}\0${index}`);
    if (documentIndex === undefined) {
      throw new Error(`Patinae atom identity map is missing ${object.object_name}:${index}`);
    }
    return documentIndex;
  }));
}
