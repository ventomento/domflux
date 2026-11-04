// In its own file (each runs in its own process): setFailureHandler has no way
// back to the default, so these must run where no handler was ever set.
import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { httpKit } from "../../index.js";

let respond;
globalThis.fetch = async () => respond();

test("without a handler, a non-2xx response is logged and still comes back", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  respond = () => new Response("nope", { status: 404 });
  const res = await httpKit.get("/missing");
  assert.equal(res.status, 404);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [["/missing: HTTP 404"]]);
});

test("without a handler, a network error is logged and resolves to a failed response", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const error = new TypeError("Failed to fetch");
  respond = () => Promise.reject(error);
  const res = await httpKit.get("/down");
  assert.equal(res.ok, false);
  assert.deepEqual(log.mock.calls.map((call) => call.arguments), [[error]]);
});

test("without a handler, a failed load is logged and resolves null", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  respond = () => new Response("nope", { status: 500 });
  assert.equal(await httpKit.load(document.createElement("div"), "/p"), null);
  assert.equal(log.mock.callCount(), 1);
});
