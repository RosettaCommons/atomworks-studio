import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  patinaeCommandAllowed,
  STUDIO_UNSAFE_PATINAE_COMMANDS,
} from "../src/studio/patinae-commands.ts";
import type { ViewerCommand } from "../src/viewers/contract.ts";

// Upstream command_is_web_safe() returns false only for file-system and process commands.
const DESKTOP_ONLY = new Set(["cd", "fetch", "load", "load_traj", "ls", "png", "pwd", "quit", "run", "save"]);
// Reviewed commands that only change display, camera, movie, selections or settings.
const DISPLAY_ONLY = new Set([
  "angle", "as", "backward", "bg_color", "capabilities", "center", "clear", "clip", "color",
  "count_states", "deselect", "dihedral", "disable", "distance", "dss", "enable", "ending",
  "forward", "frame", "full_screen", "get", "get_view", "group", "help", "hide", "indicate",
  "isodot", "isomesh", "isosurface", "label", "madd", "middle", "move", "mpause", "mplay",
  "mpng", "mproduce", "mset", "mstop", "mtoggle", "mview", "orient", "origin", "pick",
  "rebuild", "refresh", "reset", "rewind", "rmsd", "rock", "scene", "select", "set",
  "set_color", "set_view", "show", "state", "toggle", "turn", "ungroup", "unpick", "unset",
  "view", "viewport", "zoom",
]);

const catalogEntry = (name: string): ViewerCommand => ({ name, webSafe: !DESKTOP_ONLY.has(name) });

function shippedCatalogNames(): string[] {
  const wasm = readFileSync(new URL(
    "../node_modules/@baker-laboratory/patinae-viewer/dist/patinae_web_bg.wasm",
    import.meta.url,
  )).toString("latin1");
  return [...new Set([...wasm.matchAll(/\nUSAGE\n+ +([a-z_]+)/g)].map((match) => match[1]))].sort();
}

test("commands that create, rename or move document objects are blocked", () => {
  const catalog = ["copy", "symexp", "split_states", "align", "set_name", "materialize", "biounit",
    "delete_states", "setup_ccd", "reinitialize", "show"].map(catalogEntry);
  for (const verb of ["copy", "symexp", "split_states", "align", "set_name", "materialize", "biounit",
    "delete_states", "setup_ccd", "reinitialize"]) {
    assert.equal(patinaeCommandAllowed(catalog, verb), false, verb);
  }
  assert.equal(patinaeCommandAllowed(catalog, "show"), true);
  assert.equal(patinaeCommandAllowed(catalog, "unknown"), false);
});

test("aliases resolve to the blocked canonical command", () => {
  const catalog = [{ name: "copy", aliases: ["duplicate"], webSafe: true }];
  assert.equal(patinaeCommandAllowed(catalog, "duplicate"), false);
});

test("every command in the shipped Patinae catalog is classified", () => {
  const names = shippedCatalogNames();
  assert.ok(names.length >= 80, `parsed only ${names.length} commands from the vendored viewer`);
  const catalog = names.map(catalogEntry);
  for (const name of names) {
    if (name === "remove") continue; // Studio intercepts remove and applies it as a document edit.
    assert.ok(
      STUDIO_UNSAFE_PATINAE_COMMANDS.has(name) || DESKTOP_ONLY.has(name) || DISPLAY_ONLY.has(name),
      `review new Patinae command '${name}' and classify it`,
    );
    assert.equal(patinaeCommandAllowed(catalog, name), DISPLAY_ONLY.has(name), name);
  }
});
