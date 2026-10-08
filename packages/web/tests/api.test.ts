import assert from "node:assert/strict";
import test from "node:test";

import { api, ApiError, apiText } from "../src/api.ts";

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("api returns JSON and apiText returns raw CIF content", async () => {
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    if (String(input).endsWith("/cif")) {
      return new Response("data_atom_site", { headers: { "content-type": "chemical/x-mmcif" } });
    }
    return Response.json({ ready: true });
  };

  assert.deepEqual(await api<{ ready: boolean }>("/api/schema"), { ready: true });
  assert.equal(await apiText("/api/sessions/example/cif"), "data_atom_site");
  assert.deepEqual(requested, ["/api/v1/schema", "/api/v1/sessions/example/cif"]);
});

test("HTTP failures expose status, URL, kind, and server detail", async () => {
  globalThis.fetch = async () =>
    Response.json({ detail: "session expired" }, { status: 404, statusText: "Not Found" });

  await assert.rejects(
    () => api("/api/sessions/missing"),
    (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 404);
      assert.equal(error.url, "/api/sessions/missing");
      assert.equal(error.kind, "http");
      assert.equal(error.message, "session expired");
      return true;
    },
  );
});

test("invalid JSON is reported as a typed parse error", async () => {
  globalThis.fetch = async () =>
    new Response("<html>proxy error</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

  await assert.rejects(
    () => api("/api/schema"),
    (error: unknown) =>
      error instanceof ApiError
      && error.kind === "parse"
      && error.status === 200
      && error.url === "/api/schema",
  );
});

test("caller aborts and timeouts are distinguishable ApiErrors", async () => {
  globalThis.fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });

  const controller = new AbortController();
  const aborted = api("/api/slow", { signal: controller.signal, timeoutMs: 0 });
  controller.abort();
  await assert.rejects(aborted, (error: unknown) => error instanceof ApiError && error.kind === "aborted");

  await assert.rejects(
    () => api("/api/slow", { timeoutMs: 5 }),
    (error: unknown) => error instanceof ApiError && error.kind === "timeout",
  );
});
