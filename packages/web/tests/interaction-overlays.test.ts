import assert from "node:assert/strict";
import test from "node:test";
import { interactionDisplayContacts } from "../src/studio/interaction-overlays.ts";
import type { InteractionResult, SequenceChain } from "../src/types.ts";

test("stacking display groups cross-products and reversed pairs without merging chains or other contacts", () => {
  const sequence: SequenceChain[] = [[0, 1], [2, 3], [4, 5]].map((atoms, index) => ({
    chain_id: String(index),
    items: [{ kind: "residue", atom_indices: atoms, residue_id: 1, residue_name: "PHE", code: "F", conditions: [] }],
  }));
  const pairs = [[0, 2], [0, 3], [1, 2], [1, 3], [3, 0], [0, 4], [1, 5]];
  const contacts: InteractionResult[] = pairs.map(([atom1, atom2]) => ({
    type: "pi", interaction_type: "pistacking", atom1, atom2,
    atom1_role: "aromatic", atom2_role: "aromatic", distance: 4,
  }));
  const hbond = { ...contacts[0], interaction_type: "hbond" };
  const unknown = { ...contacts[0], atom1: 99 };
  contacts.push(hbond, unknown);
  const original = structuredClone(contacts);
  assert.deepEqual(interactionDisplayContacts(contacts, sequence), [contacts[0], contacts[5], hbond, unknown]);
  assert.deepEqual(contacts, original);
  assert.deepEqual(interactionDisplayContacts(contacts, []), contacts);
});
