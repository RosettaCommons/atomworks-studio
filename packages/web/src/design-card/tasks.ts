/**
 * What the card offers to start from, and the option lists its popups share. Ported from the page's design panel
 * (web/design-panel.js, `TASKS` and the constants above `DesignPanel`): same entries, same wording.
 */

/** A choice: its value, and the words for it. */
export type Option = readonly [string, string];

/** One step of an example's recipe; see `TASKS` for what each key does. */
export type RecipeStep = {
  fetch?: string;
  start?: string;
  add?: string;
  piece?: string;
  removePiece?: string;
  at?: number;
  set?: {
    from?: number; to?: number; structure?: string; atoms?: string; sequence?: string; position?: string;
    length?: [number, number]; hotspots?: string; keepOnly?: string;
  };
  pick?: string;
  removeNew?: string;
  addSeq?: boolean;
  newLength?: [number, number];
  k?: number;
  ligand?: string;
  pose?: string;
  atoms?: string;
  chain?: string;
  name?: string;
  order?: number;
  fold?: string;
  blocks?: [number, string][];
  partial?: boolean;
};

export type Task = {
  /** The bundled example it matches, and its id on the start screen. */
  example: string;
  title: string;
  desc: string;
  /** A set-up to apply to the opened example (`inverse_folding`'s "sequence"). */
  then?: string;
  recipe?: RecipeStep[];
};

/**
 * Start-screen tasks. Each with a `recipe` is built from its PDB entry with the card's own controls, out of sight
 * (`_buildRecipe`), and shown finished: the set-up a user would make, captioned with its entry. Each matches the bundled
 * Studio example of the same name (`example`, web/studio/examples) model input for model input: the same entries,
 * residues, held atoms, chain names and order. The two 2KL8 examples are the exception: the bundled file lacks residues
 * 8–27 (a bug in it), so they keep the whole protein and drop only the His tag. If an entry cannot be fetched the
 * example does not open (the page says why); there is no stand-in.
 * Steps: `fetch` (ID and chains), `start` (a bundled Studio example instead, no download), `add` (another entry's chains,
 * as + pdb), `piece` (open the piece holding `at`, fill `set`, `from`/`to` its Residues, Apply), `pick` (residues picked
 * as in the viewer, "H99-109", and that popup's `set`: structure, sequence, length), `removePiece` (× the piece holding
 * `at`), `removeNew` (× the new residues left in a chain), `addSeq`,
 * `newLength` (the chain's `k`-th new piece), `ligand` (pose, held atoms), `chain` (its popup: `name`, `order` from 1),
 * `blocks` (a new chain laid out as blocks, [length, shape] each: "+" after the last, then each block's popup),
 * `partial`.
 */
export const TASKS: Task[] = [
  { example: 'unconditional', title: 'Protein from scratch', desc: 'A new fold of the length you choose' },
  {
    // The blocks idea: a ferredoxin-like fold drawn as strands, helices and loops, each its own block of new residues.
    example: 'blueprint', title: 'Blueprint', desc: 'A fold drawn as blocks: E-H-E-E-H-E',
    recipe: [
      { start: 'unconditional' },
      { blocks: [[6, 'E'], [3, 'C'], [14, 'H'], [3, 'C'], [6, 'E'], [3, 'C'],
        [6, 'E'], [3, 'C'], [14, 'H'], [3, 'C'], [6, 'E']] },
    ],
  },
  {
    example: 'protein_binder', title: 'Protein binder', desc: 'Bind PD-L1 (PDB 5O45)',
    recipe: [
      { fetch: '5O45 A' },
      { piece: 'A', at: 10, set: { hotspots: 'A40(CG,OH), A99(CG,SD), A107(CD2,OH)', keepOnly: 'A1-115' } },
      { removeNew: 'A' },
      { addSeq: true },
      { newLength: [50, 120] },
    ],
  },
  {
    example: 'small_molecule_binder', title: 'Small-molecule binder', desc: 'A pocket around SAM (PDB 1XVA)',
    recipe: [
      { fetch: '1XVA D_1' },
      { addSeq: true },
      { newLength: [150, 150] },
      { ligand: 'SAM', pose: 'free' },
      { chain: 'D_1', name: 'B' },
      { chain: 'A', order: 1 },
    ],
  },
  {
    example: 'motif_scaffolding', title: 'Motif scaffolding', desc: 'Keep three residues, build the rest (PDB 1QJG)',
    recipe: [
      { fetch: '1QJG A' },
      { piece: 'A', at: 10, set: { keepOnly: 'A38, A14, A99' } },
      { newLength: [10, 20], chain: 'A', k: 0 },
      { newLength: [15, 30], chain: 'A', k: 1 },
      { newLength: [15, 30], chain: 'A', k: 2 },
      { newLength: [10, 20], chain: 'A', k: 3 },
    ],
  },
  {
    example: 'enzyme_design', title: 'Enzyme', desc: 'A catalytic Asp around Zn and orotate (PDB 1J79)',
    recipe: [
      { fetch: '1J79 A C E' },
      { piece: 'A', at: 10, set: { atoms: 'CG, OD1', position: 'anywhere', keepOnly: 'A250' } },
      { newLength: [180, 180], chain: 'A' },
      { ligand: 'ORO', pose: 'fixed', atoms: 'N1, C2, N3, C4' },
      { chain: 'C', name: 'B' },
      { chain: 'E', name: 'C' },
      { chain: 'C', order: 2 },
    ],
  },
  {
    example: 'antibody_design', title: 'Antibody loop', desc: 'Redesign CDR H3 against HER2 (PDB 1N8Z)',
    recipe: [
      { fetch: '1N8Z A B C' },
      { chain: 'A', name: 'L' },
      { chain: 'B', name: 'H' },
      { chain: 'C', name: 'T' },
      { piece: 'H', at: 10, set: { structure: 'rigid', keepOnly: 'H1-120' } },
      { removeNew: 'H' },
      { piece: 'L', at: 10, set: { structure: 'rigid', keepOnly: 'L1-107' } },
      { removeNew: 'L' },
      { pick: 'H99-109', set: { structure: 'designed', sequence: 'designed' } },
      { piece: 'T', at: 550, set: { keepOnly: 'T545-580, T591-607', hotspots: 'T557-573, T591-605' } },
      { removeNew: 'T' },
      // The frameworks' fold, as upstream's antibody examples give it (Ig-like, CATH 2.60.40).
      { chain: 'H', fold: '2.60.40' },
      { chain: 'L', fold: '2.60.40' },
    ],
  },
  {
    example: 'nanobody', title: 'Nanobody (VHH)', desc: 'Design CDRs against PD-L1 (PDB 4Z18, 3EAK)',
    recipe: [
      { fetch: '4Z18 A' },
      { piece: 'A', at: 10, set: { structure: 'rigid', atoms: 'backbone', keepOnly: 'A2-114', hotspots: 'A39(CZ), A98(CE), A106(CZ)' } },
      { removeNew: 'A' },
      { add: '3EAK B' },
      { chain: 'B', name: 'H' },
      { piece: 'H', at: 10, set: { structure: 'rigid', atoms: 'backbone', keepOnly: 'H1-127' } },
      { removeNew: 'H' },
      { pick: 'H23-38', set: { structure: 'designed', sequence: 'designed', length: [11, 16] } },
      { pick: 'H53-62', set: { structure: 'designed', sequence: 'designed', length: [8, 12] } },
      { pick: 'H100-117', set: { structure: 'designed', sequence: 'designed', length: [8, 22] } },
    ],
  },
  {
    example: 'inverse_folding', title: 'Redesign a sequence', desc: 'New sequence for a fixed backbone (PDB 2KL8)', then: 'sequence',
    recipe: [
      { fetch: '2KL8' },
      { piece: 'A', at: 10, set: { from: 1, to: 79 } },
      { piece: 'A', at: 10, set: { sequence: 'designed' } },
    ],
  },
  {
    example: 'partial_diffusion', title: 'Diversify a structure', desc: 'Variants close to a starting fold (PDB 2KL8)',
    recipe: [
      { fetch: '2KL8' },
      { piece: 'A', at: 10, set: { from: 1, to: 79 } },
      { partial: true },
    ],
  },
];

/** Hotspots' one colour, wherever they are shown: sequence bar, viewer, chain bar, chip (styles.css `--rfd4p-hotspot`). */
export const HOTSPOT_COLOR = 0xf59e0b;
/** How faded residues the model rebuilds are in the input structure (0 solid, 1 gone). */
export const FREE_TRANSPARENCY = 0.65;

// The three properties of residues, the same in a sub-card's popup and the selection's: each fixed or free (the model
// decides), and a structure may also be rigid (kept, moving as one body).
export const STRUCTURE_OPTIONS: Option[] = [['fixed', 'fixed'], ['rigid', 'rigid'], ['designed', 'free']];
// Which atoms a fixed structure holds; "named" takes atom names typed beside it (CG, OD1).
export const ATOM_OPTIONS: Option[] = [['all', 'all'], ['backbone', 'backbone'], ['sidechain', 'side chains'], ['named', 'named']];
export const SEQUENCE_OPTIONS: Option[] = [['fixed', 'fixed'], ['designed', 'free']];
export const POSITION_OPTIONS: Option[] = [['fixed', 'fixed'], ['anywhere', 'free']];
// What else can be asked of residues: their secondary structure, how exposed they are, an interaction to make. Every
// list ends with "free", the model decides, as the three properties do.
// Secondary structure as DSSP's letters, H helix, E strand, C coil (loop): a card reads "6 · E · new", the popup says both.
export const SHAPE_OPTIONS: Option[] = [['1', 'H helix'], ['2', 'E strand'], ['3', 'C loop'], ['0', 'free']];
export const SHAPE_LETTER: Record<number, string> = { 1: 'H', 2: 'E', 3: 'C' };

export const EXPOSURE_OPTIONS: Option[] = [['1', 'buried'], ['2', 'intermediate'], ['3', 'exposed'], ['0', 'free']];
export const INTERACTION_OPTIONS: Option[] = [
  ['hbond:1', 'H-bond donor'], ['hbond:2', 'H-bond acceptor'], ['hbond:3', 'H-bond donor or acceptor'],
  ['saltbridge:1', 'salt bridge, positive'], ['saltbridge:2', 'salt bridge, negative'], ['pistack:1', 'π-stacking'],
  ['pication:1', 'π-cation, aromatic'], ['pication:2', 'π-cation, cation'], ['hydrophobic:1', 'hydrophobic'],
  ['metal_coord:2', 'metal-coordinating'], ['', 'free'],
];

// Folds a chain can be asked for, by name (CATH class, architecture, topology); "other" takes any code.
/** What + pdb takes, the same on the start screen and under a job. */
export const STRUCTURE_NOTE = 'Its ID in the PDB, then any chains to keep (5O45 A, 1J79 A C) with the ligands filed under them, or a ligand by its code (9FJX B LVY), or a file. It comes in fixed; free what you want designed.';

export const FOLD_OPTIONS: Option[] = [
  ['1', 'mainly α'], ['2', 'mainly β'], ['3', 'α/β'],
  ['1.10', 'helix bundle (orthogonal)'], ['1.20', 'up-down helix bundle'], ['2.40', 'β-barrel'], ['2.60', 'β-sandwich'], ['2.60.40', 'immunoglobulin-like'],
  ['3.30.70', 'ferredoxin-like'], ['3.40.50', 'Rossmann-like'], ['3.20.20', 'TIM barrel'], ['other', 'other code'], ['', 'free'],
];
export const CONDITION_KEY: Record<string, string> = { hbond: 'hbond', saltbridge: 'saltbridge', pistack: 'pistack', pication: 'pication', hydrophobic: 'hydrophobic', metal_coord: 'metal_coord' };
