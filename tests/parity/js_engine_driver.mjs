// Runs a list of design-card operations through the RFD4-Proteina page's in-browser Studio engine
// (`web/studio-api.js`, class `StudioDoc`) and prints the resulting state after every step as JSON.
//
// The Python parity tests (`tests/test_design_card_parity.py`) run the same job through `StudioDocument` and compare.
//
//   RFD4P_PAGE_DIR=/path/to/rfd4-proteina-webgpu node tests/parity/js_engine_driver.mjs job.json > out.json
//
// Job: { documents: {main: {path, name?, open?}, other: {...}}, ops: [...] }
//   open: {} (a file as it is) or {preset: 'rcsb', assembly, keep_unresolved} (an entry as `createStudioDocWithCcd` opens it).
//   ops: each {op, ...}; atom arguments are selectors resolved against the document's own atoms at that step:
//     {chain?, res?: "38,40-42", names?: ["CA"], kind?: "polymer"|"ligand"|"segment"|"residue", k?: n}  (a list = union)
//   Result: {steps: [{op, state, extra?}]}, `state` = atoms, bonds, annotation details and summary pieces.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pageDir = process.env.RFD4P_PAGE_DIR;
if (!pageDir) throw new Error('set RFD4P_PAGE_DIR to the rfd4-proteina-webgpu checkout');
const engine = await import(pathToFileURL(path.join(pageDir, 'web/studio-api.js')).href);
const { StudioDoc, createStudioDocWithCcd } = engine;

const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));

const isSegment = (a, i) => /^\d+-\d+$/.test(String(a.res_name[i]));
const isPolymer = (a, i) => (a.is_polymer?.length === a.nAtoms ? Boolean(a.is_polymer[i]) : !a.hetero[i]) && !isSegment(a, i);
const insOf = (a, i) => { const c = String(a.ins_code?.[i] ?? ''); return c === '.' || c === '?' ? '' : c; };

function resRanges(text) {
  return String(text).split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(part);
    if (!m) throw new Error(`bad residue range ${part}`);
    return [Number(m[1]), Number(m[2] ?? m[1])];
  });
}

/** Atom indices a selector names, in document order. */
function resolve(doc, sel) {
  const a = doc.atoms;
  const out = new Set();
  for (const s of Array.isArray(sel) ? sel : [sel]) {
    if (s.atoms) { for (const i of s.atoms) out.add(i); continue; }
    const chains = s.chain === undefined ? null : new Set([].concat(s.chain).map(String));
    const ranges = s.res === undefined ? null : resRanges(s.res);
    const names = s.names ? new Set(s.names) : null;
    const hits = [];
    for (let i = 0; i < a.nAtoms; i += 1) {
      if (chains && !chains.has(String(a.chain_id[i]))) continue;
      if (ranges && !ranges.some(([lo, hi]) => a.res_id[i] >= lo && a.res_id[i] <= hi)) continue;
      if (names && !names.has(String(a.atom_name[i]))) continue;
      if (s.kind === 'polymer' && !isPolymer(a, i)) continue;
      if (s.kind === 'residue' && (!isPolymer(a, i))) continue;
      if (s.kind === 'ligand' && (isPolymer(a, i) || isSegment(a, i))) continue;
      if (s.kind === 'segment' && !isSegment(a, i)) continue;
      hits.push(i);
    }
    if (s.k !== undefined) {
      // The k-th residue among the hits (consecutive atoms of one residue count once).
      const groups = [];
      let last = null;
      for (const i of hits) {
        const key = `${a.chain_id[i]}:${a.res_id[i]}:${insOf(a, i)}:${a.res_name[i]}`;
        if (key !== last) { groups.push([]); last = key; }
        groups.at(-1).push(i);
      }
      const group = groups[s.k < 0 ? groups.length + s.k : s.k];
      if (!group) throw new Error(`selector has no residue ${s.k}`);
      for (const i of group) out.add(i);
    } else {
      for (const i of hits) out.add(i);
    }
  }
  return [...out].sort((x, y) => x - y);
}

const num = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null);

/** Everything the parity test compares, as plain JSON. */
function stateOf(doc) {
  const a = doc.atoms;
  const n = a.nAtoms;
  const atoms = {
    chain: Array.from({ length: n }, (_, i) => String(a.chain_id[i])),
    res_id: Array.from({ length: n }, (_, i) => Number(a.res_id[i])),
    ins: Array.from({ length: n }, (_, i) => insOf(a, i)),
    res_name: Array.from({ length: n }, (_, i) => String(a.res_name[i])),
    atom_name: Array.from({ length: n }, (_, i) => String(a.atom_name[i])),
    element: Array.from({ length: n }, (_, i) => String(a.element[i])),
    coord: Array.from({ length: n }, (_, i) => Array.from(a.coord[i]).slice(0, 3).map(num)),
    segment: Array.from({ length: n }, (_, i) => isSegment(a, i)),
    polymer: Array.from({ length: n }, (_, i) => isPolymer(a, i)),
    src: Array.from({ length: n }, (_, i) => String(a.annotations?.['annotation_src-component_1_atom']?.[i] ?? '')),
    seg_min: Array.from({ length: n }, (_, i) => Number(a.annotations?.annotation_expsegmin_1_residue?.[i] ?? -1)),
    seg_max: Array.from({ length: n }, (_, i) => Number(a.annotations?.annotation_expsegmax_1_residue?.[i] ?? -1)),
  };
  const bonds = (a.bonds || []).map(([u, v]) => (u < v ? [u, v] : [v, u])).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const annotations = {};
  for (const entry of doc.annotationDetails()) {
    annotations[entry.name] = {
      count: entry.count,
      values: entry.values.map((v) => ({ label: v.label, value: v.value ?? null, atom_indices: v.atom_indices })),
    };
  }
  const summary = doc.summary();
  return {
    atoms,
    bonds,
    annotations,
    summary: {
      atom_count: summary.atom_count,
      chain_ids: summary.chain_ids,
      next_chain_id: summary.next_chain_id,
      condition_counts: summary.condition_counts,
      undo_depth: summary.undo_depth,
      sequence: summary.sequence,
    },
  };
}

async function open(spec) {
  const text = readFileSync(spec.path, 'utf8');
  const name = spec.name ?? 'structure';
  const o = spec.open ?? {};
  const opts = o.preset === 'rcsb'
    ? { preset: 'rcsb', assembly: String(o.assembly ?? '1'), keepUnresolved: Boolean(o.keep_unresolved) }
    : {};
  // Offline by default: CCD lookups only change bond tables and ion charges, which the comparison does not use.
  const doc = o.ccd ? await createStudioDocWithCcd(text, name, opts) : new StudioDoc(text, name, opts);
  if (o.drop_names) {
    const names = new Set(o.drop_names);
    const drop = [];
    for (let i = 0; i < doc.atoms.nAtoms; i += 1) if (names.has(String(doc.atoms.atom_name[i]))) drop.push(i);
    doc.deleteAtoms(drop);
  }
  doc.undoStack = [];
  return doc;
}

const docs = {};
for (const [key, spec] of Object.entries(job.documents)) docs[key] = await open(spec);
const doc = docs.main;

function apply(op) {
  const sel = (s) => resolve(doc, s);
  switch (op.op) {
    case 'rebuild': return doc.rebuildChain(op.chain, resolveParts(op.parts));
    case 'order': return doc.reorderChains(op.chain_ids);
    case 'clear_coordinates': return doc.clearCoordinates(sel(op.select), op.lead ? sel(op.lead) : []);
    case 'segment_range': return doc.setSegmentRange(sel(op.select)[0], op.minimum, op.maximum);
    case 'replace': return doc.replaceWithSegments(sel(op.select), op.minimum, op.maximum);
    case 'restore': return doc.restoreSegment(sel(op.select)[0]);
    case 'scaffold':
      return doc.scaffoldMotif(sel(op.select), {
        spread: op.spread ?? 0.25, sidechainsOnly: Boolean(op.sidechains_only), unindexed: Boolean(op.unindexed),
        ordered: Boolean(op.ordered), totalMin: op.total_min ?? null, totalMax: op.total_max ?? null,
      });
    case 'ligand_binder':
      return doc.designAroundLigand({
        removeProtein: op.remove_protein ?? true, poseFixed: op.pose_fixed ?? true, minimum: op.minimum ?? 100, maximum: op.maximum ?? 150,
      });
    case 'delete': return op.close_residue_gaps ? doc.deleteAtoms(sel(op.select), true) : doc.removeAtoms(sel(op.select));
    case 'insert_segment':
      return doc.insertSegment({
        minimum: op.minimum, maximum: op.maximum, atomIndex: op.select ? sel(op.select)[0] : null, before: op.before ?? true,
        newChain: op.new_chain ?? false, chainId: op.chain_id ?? null, chainType: op.chain_type ?? 'polypeptide(L)',
      });
    case 'combine': return doc.combine([docs[op.with]]);
    case 'assign_chain': return doc.assignChain(sel(op.select), op.chain_id);
    case 'conditions':
      return doc.setConditions(op.edits.map((e) => ({
        condition: e.condition, atom_indices: sel(e.select), enabled: e.enabled ?? true, value: e.value ?? null, scope: e.scope ?? 'atom',
      })));
    case 'internal_coords': return doc.setInternalCoordinateConditioning(sel(op.select), op.enabled ?? true, 'atom', op.group_id ?? null);
    case 'clear_targets': return doc.clearInternalCoordinateTargets(sel(op.select), 'atom');
    case 'undo': if (!doc.undo()) throw new Error('undo history is empty'); return { changed: true };
    default: throw new Error(`unknown op ${op.op}`);
  }
}

/** Parts name atoms by selector ({kind: 'own', select}) or by source number; the engine takes indices. */
function resolveParts(parts) {
  return parts.map((p) => (p.kind === 'own' ? { kind: 'own', atoms: resolve(doc, p.select) } : p.kind === 'new' && p.select ? { ...p, atom: resolve(doc, p.select)[0] } : p));
}

const steps = [];
steps.push({ op: 'open', state: stateOf(doc) });
for (const op of job.ops) {
  const step = { op: op.op };
  try {
    if (op.op === 'preview') {
      const before = doc.toCif();
      const copy = doc.previewRebuild(op.chain, resolveParts(op.parts));
      step.extra = { cif: copy.toCif(), state: stateOf(copy), unchanged: doc.toCif() === before };
    } else if (op.op === 'plan') {
      step.extra = { plan: JSON.parse(JSON.stringify(doc.chainPlan(op.chain))) };
    } else if (op.op === 'origins') {
      const origins = {};
      for (let i = 0; i < doc.atoms.nAtoms; i += 1) {
        const found = doc.segmentOrigin(i);
        if (found) origins[String(i)] = found;
      }
      step.extra = { origins };
    } else if (op.op === 'source') {
      const src = doc.chainSources?.get(op.chain);
      step.extra = { source: src ? { chain: src.chain, residues: doc.sourceResidues?.(op.chain) ?? null } : null };
    } else {
      step.result = JSON.parse(JSON.stringify(apply(op) ?? null));
    }
  } catch (error) {
    step.error = String(error?.message ?? error);
  }
  step.state = stateOf(doc);
  steps.push(step);
}
process.stdout.write(JSON.stringify({ steps }));
