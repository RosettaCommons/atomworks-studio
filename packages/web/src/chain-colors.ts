// One chain palette for the whole app: the Mol* "studio-chain" colour theme and the sequence bar read from here, so
// a chain is the same colour wherever it appears. Embedders can read it through `chainColorCss`.
//
// Keyed by chain id, not by chain order, so a chain keeps its colour when other chains are added or removed.
//
// Cool colours only (greens, blues, violets): warm ones are left for marks drawn over the chains, such as hotspots
// (amber) and a refolded overlay (magenta), which must not be mistaken for a chain. Thirteen, so the letters of an
// antibody job (H, L and a target T) fall on three different colours.
const PALETTE = [
  0x3fbf8f, 0x6d9eff, 0xa78bfa, 0x4fc3e8, 0x9bc53d, 0x8fa1b3, 0xc3e88d,
  0x7c8cf8, 0x80cbc4, 0x5fd3a5, 0x93b5e1, 0x2bb5c9, 0xb4a7f5,
];

// A chain letter with an optional assembly-copy number: "A", "a", "A_1", "A-1", "A1", "A_2". Documents written by
// the API label chains this way, so this case follows the alphabet rather than falling through to the hash.
const LETTERED = /^([A-Za-z])(?:[_-]?(\d+))?$/;

/**
 * Palette slot of a chain id. A, B, C… take the palette in order, and a later assembly copy takes the next slot
 * along, so "A_1" and "A_2" never share a colour. Anything else hashes.
 *
 * With thirteen colours and arbitrary ids, two chains can still collide; the guarantee is only that one id always
 * maps to one colour, so a chain keeps its colour as other chains come and go.
 */
export function chainColorIndex(chainId: string): number {
  const id = String(chainId);
  const lettered = LETTERED.exec(id);
  if (lettered) {
    const letter = lettered[1].toUpperCase().charCodeAt(0) - 65;
    const copy = lettered[2] === undefined ? 1 : Number(lettered[2]);
    return (letter + Math.max(0, copy - 1)) % PALETTE.length;
  }
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return hash % PALETTE.length;
}

export function chainColor(chainId: string): number {
  return PALETTE[chainColorIndex(chainId)];
}

export function chainColorCss(chainId: string): string {
  return `#${chainColor(chainId).toString(16).padStart(6, "0")}`;
}
