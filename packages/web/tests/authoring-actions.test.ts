import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api.ts";
import { mutateWithConfirmation, prepareCifDownload } from "../src/studio/authoring-actions.ts";

const originalFetch = globalThis.fetch;
let confirm: (message: string) => Promise<boolean>;
test.afterEach(() => {
  globalThis.fetch = originalFetch;

});

test("save checks the frozen export and cancellation creates no download payload", async () => {
  const requested: string[] = [];
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    assert.equal(init?.method, "POST");
    return Response.json({
      cif: "data_snapshot", name: "input", revision: 2,
      issues: [{ severity: "error", check: "res_id_gap", message: "gap in group" }],
    });
  };
  confirm = async (message: string) => {
    assert.match(message, /\[res_id_gap\] gap in group/);
    assert.match(message, /Save anyway/);
    return false;
  };
  assert.equal(await prepareCifDownload("one", () => true, confirm), null);
  assert.deepEqual(requested, ["/api/v1/sessions/one/export"]);
});

test("save approval returns the validated snapshot without refetching a newer CIF", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      cif: "data_checked", name: "checked", revision: 3,
      issues: [{ severity: "error", check: "pipeline_error", message: "invalid" }],
    });
  };
  confirm = async () => true;
  assert.equal((await prepareCifDownload("one", () => true, confirm))?.cif, "data_checked");
  assert.equal(calls, 1);
});

test("valid saves require no override; a switched session discards a pending export", async () => {
  globalThis.fetch = async () => Response.json({ cif: "data_ok", name: "valid", revision: 0, issues: [] });
  confirm = async () => { throw new Error("unexpected prompt"); };
  assert.equal((await prepareCifDownload("one", () => true, confirm))?.cif, "data_ok");
  assert.equal(await prepareCifDownload("one", () => false, confirm), null);
});

test("coordinate confirmation binds the retry to the preview revision", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1
      ? Response.json({ detail: {
        code: "target_discard_confirmation_required", lost_target_count: 4, revision: 7,
      } }, { status: 409 })
      : Response.json({ structure: { revision: 8 } });
  };
  confirm = async (message: string) => {
    assert.match(message, /4 atoms/);
    assert.match(message, /outside the selection/);
    return true;
  };
  const body = { condition: "coordinate", atom_indices: [0], enabled: true };
  const result = await mutateWithConfirmation("/api/sessions/one/conditions", body, () => true, confirm);
  assert.deepEqual(result, { structure: { revision: 8 } });
  assert.deepEqual(bodies, [body, { ...body, allow_target_discard: true, expected_revision: 7 }]);
});

test("cancel and session changes never retry a destructive edit", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ detail: {
      code: "target_discard_confirmation_required", lost_target_count: 2, revision: 0,
    } }, { status: 409 });
  };
  confirm = async () => false;
  assert.equal(await mutateWithConfirmation("/api/edit", {}, () => true, confirm), null);
  assert.equal(calls, 1);
  confirm = async () => { throw new Error("unexpected prompt"); };
  assert.equal(await mutateWithConfirmation("/api/edit", {}, () => false, confirm), null);
  assert.equal(calls, 2);
});

test("stale confirmation fails instead of silently retrying against newer data", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ detail: calls === 1
      ? { code: "target_discard_confirmation_required", lost_target_count: 2, revision: 0 }
      : { code: "revision_conflict", revision: 1 } }, { status: 409 });
  };
  confirm = async () => true;
  await assert.rejects(() => mutateWithConfirmation("/api/edit", {}, () => true, confirm), ApiError);
  assert.equal(calls, 2);
});
