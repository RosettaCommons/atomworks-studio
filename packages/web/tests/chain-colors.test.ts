import assert from "node:assert/strict";
import test from "node:test";
import { chainColor, chainColorCss, chainColorIndex } from "../src/chain-colors.ts";

test("plain chain letters follow the alphabet, with or without a first-copy suffix", () => {
  assert.equal(chainColorIndex("A"), 0);
  assert.equal(chainColorIndex("B"), 1);
  assert.equal(chainColorIndex("C"), 2);
  // Documents written by the API label chains "A_1", "B_1", … — they must land on the same slots.
  for (const [plain, suffixed] of [["A", "A_1"], ["B", "B-1"], ["C", "C1"]]) {
    assert.equal(chainColorIndex(suffixed), chainColorIndex(plain), `${suffixed} matches ${plain}`);
  }
  assert.equal(chainColorIndex("a"), chainColorIndex("A"));
});

test("assembly copies of one chain never share a colour", () => {
  const copies = ["A_1", "A_2", "A_3", "A_4"].map(chainColorIndex);
  assert.equal(new Set(copies).size, copies.length, "each copy of A has its own slot");
  assert.equal(chainColorIndex("A_2"), chainColorIndex("B_1"), "a copy takes the next slot along");
});

test("a chain id always maps to the same colour, independent of the other chains present", () => {
  const first = chainColorIndex("D_1");
  assert.equal(chainColorIndex("D_1"), first);
  assert.equal(chainColor("D_1"), chainColor("D"));
});

test("the palette wraps and every id yields a usable six-digit css colour", () => {
  for (const id of ["A", "Z", "A_2", "zz", "1", "", "A_1"]) {
    const index = chainColorIndex(id);
    assert.ok(Number.isInteger(index) && index >= 0, `${id} has an integer slot`);
    assert.match(chainColorCss(id), /^#[0-9a-f]{6}$/, `${id} renders as css`);
  }
  // Wrapping. The palette size is not exported, so find the cycle from the letters themselves rather than pin a
  // number that goes stale the next time a colour is added or removed (it said "12 slots" until the palette became
  // thirteen cool colours): the first letter to repeat A's slot is where the palette wraps.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const period = letters.split("").findIndex((letter, i) => i > 0 && chainColorIndex(letter) === chainColorIndex("A"));
  assert.ok(period > 1, "the palette holds more than one colour");
  assert.ok(period < letters.length, "the palette wraps within the alphabet");
  for (let i = 0; i + period < letters.length; i += 1) {
    assert.equal(chainColorIndex(letters[i + period]), chainColorIndex(letters[i]), `${letters[i + period]} wraps onto ${letters[i]}`);
  }
});

test("the letters of an antibody job fall on three different colours", () => {
  // The palette is sized for this: heavy (H), light (L) and a target (T) are the chains a Studio antibody job
  // carries, and two of them sharing a colour would make the sequence bar and the viewer ambiguous.
  const slots = new Set(["H", "L", "T"].map(chainColorIndex));
  assert.equal(slots.size, 3);
});
