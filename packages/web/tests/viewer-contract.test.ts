import assert from "node:assert/strict";
import test from "node:test";

import type { AtomIdentity } from "@baker-laboratory/patinae-viewer";

import { documentAtomIndices, nativeAtomIndices } from "../src/viewers/atom-identity.ts";
import {
  interactionToViewerOverlay,
  normalizeViewerMeasurementRequest,
  replayViewerTransientVisuals,
  validateViewerMeasurementRequest,
  viewerMeasurementCardinality,
  type ViewerInteraction,
  type ViewerMeasurementRequest,
} from "../src/viewers/contract.ts";

test("atom identity goldens preserve document and native order", () => {
  const identities: AtomIdentity[] = [
    {
      document_index: 0,
      object_name: "fixture",
      atom_index: 7,
      source_atom_id: 11,
      atom_name: "N",
      element: "N",
      chain_id: "A",
      residue_name: "GLY",
      residue_number: 4,
      insertion_code: "",
      alternate_location: "",
    },
    {
      document_index: 1,
      object_name: "fixture",
      atom_index: 3,
      source_atom_id: 12,
      atom_name: "CA",
      element: "C",
      chain_id: "A",
      residue_name: "GLY",
      residue_number: 4,
      insertion_code: "",
      alternate_location: "",
    },
  ];

  assert.deepEqual(nativeAtomIndices(identities, [0, 1]), [7, 3]);
  assert.deepEqual(documentAtomIndices(identities, {
    expression: "index 3+7",
    atom_count: 2,
    objects: [{ object_name: "fixture", atom_indices: [3, 7] }],
  }), [1, 0]);
  assert.throws(() => nativeAtomIndices(identities, [2]), /missing document indices: 2/);
});

test("measurement cardinalities and validation cover all supported kinds", () => {
  assert.equal(viewerMeasurementCardinality("distance"), 2);
  assert.equal(viewerMeasurementCardinality("angle"), 3);
  assert.equal(viewerMeasurementCardinality("dihedral"), 4);

  const valid: ViewerMeasurementRequest[] = [
    { kind: "distance", atomIndices: [1, 2] },
    { kind: "angle", atomIndices: [1, 2, 3] },
    { kind: "dihedral", atomIndices: [1, 2, 3, 4] },
  ];
  for (const request of valid) {
    assert.doesNotThrow(() => validateViewerMeasurementRequest(request));
    assert.deepEqual(normalizeViewerMeasurementRequest(request).atomIndices, request.atomIndices);
  }

  assert.throws(
    () => validateViewerMeasurementRequest({ kind: "distance", atomIndices: [1] }),
    /exactly 2 atoms/,
  );
  assert.throws(
    () => validateViewerMeasurementRequest({ kind: "angle", atomIndices: [1, 2] }),
    /exactly 3 atoms/,
  );
  assert.throws(
    () => validateViewerMeasurementRequest({ kind: "dihedral", atomIndices: [1, 2, 3] }),
    /exactly 4 atoms/,
  );
});

test("normalization deduplicates while preserving geometric atom order", () => {
  const atomIndices = [8, 3, 8, 5, 1];
  const normalized = normalizeViewerMeasurementRequest({
    kind: "dihedral",
    atomIndices,
    label: "torsion",
  });

  assert.deepEqual(normalized.atomIndices, [8, 3, 5, 1]);
  assert.deepEqual(atomIndices, [8, 3, 8, 5, 1], "does not mutate the caller's request");
  assert.throws(
    () => normalizeViewerMeasurementRequest({ kind: "distance", atomIndices: [4, 4] }),
    /exactly 2 atoms/,
  );
  assert.throws(
    () => normalizeViewerMeasurementRequest({ kind: "distance", atomIndices: [-1, 2] }),
    /non-negative integers/,
  );
});

test("interaction conversion preserves overlay identity and styling", () => {
  const interaction: ViewerInteraction = {
    id: "salt-bridge-1",
    type: "salt_bridge",
    atom1: 12,
    atom2: 4,
    label: "Salt bridge",
    color: 0x42a5f5,
  };

  assert.deepEqual(interactionToViewerOverlay(interaction), {
    id: "salt-bridge-1",
    kind: "distance",
    atomIndices: [12, 4],
    label: "Salt bridge",
    color: 0x42a5f5,
  });
});

for (const includeContacts of [true, false]) test(`transient replay replaces contacts (${includeContacts}) and preserves user measurements`, async () => {
  const events: unknown[] = [];
  const interactions: ViewerInteraction[] = [
    {
      id: "contact-1",
      type: "contact",
      atom1: 2,
      atom2: 9,
      label: "Contact",
      color: 0xffd54f,
    },
  ];
  const measurements: ViewerMeasurementRequest[] = [
    { kind: "angle", atomIndices: [3, 7, 5], label: "User angle" },
  ];

  await replayViewerTransientVisuals(
    {
      async clearMeasurements() {
        events.push("clear");
      },
      async showInteractions(value) {
        events.push(["interactions", value]);
      },
      async addMeasurement(value) {
        events.push(["measurement", value]);
        return [];
      },
    },
    { interactionOverlays: includeContacts ? interactions : [], measurementRequests: measurements },
  );

  assert.deepEqual(events, [
    "clear",
    ["interactions", includeContacts ? interactions : []],
    ["measurement", measurements[0]],
  ]);
});
