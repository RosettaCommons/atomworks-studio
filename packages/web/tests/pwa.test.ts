import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serviceWorker = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

test("service worker caches shell assets but never API responses", () => {
  assert.match(serviceWorker, /atomworks_logo_dark\.svg/);
  assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(serviceWorker, /return;/);
});
