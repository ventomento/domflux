import "./setup.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Component, register, httpKit } from "../../index.js";

const html = (body, type = "text/html; charset=utf-8") => new Response(body, { headers: { "Content-Type": type } });

let calls;
let respond;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  return respond(String(url), init);
};
const lastCall = () => calls.at(-1);

beforeEach(() => {
  calls = [];
  respond = () => html("<p>hi</p>");
  httpKit.setHeaderProvider(async () => ({ "X-CSRF-Token": "secret" }));
  document.body.innerHTML = "";
});

function box(inner = "") {
  const el = document.createElement("div");
  el.innerHTML = inner;
  document.body.append(el);
  return el;
}

// --- request ---

test("same-origin requests get default + dynamic headers and same-origin mode", async () => {
  await httpKit.get("/api");
  const { init } = lastCall();
  assert.equal(init.headers.get("X-Requested-With"), "XMLHttpRequest");
  assert.equal(init.headers.get("X-CSRF-Token"), "secret");
  assert.equal(init.mode, "same-origin");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.method, "GET");
});

test("cross-origin requests get only per-call headers and no forced mode", async () => {
  let providerCalled = false;
  httpKit.setHeaderProvider(async () => {
    providerCalled = true;
    return { "X-CSRF-Token": "secret" };
  });
  await httpKit.get("https://other.test/x", { headers: { A: "b" } });
  const { init } = lastCall();
  assert.equal(init.headers.get("X-CSRF-Token"), null);
  assert.equal(init.headers.get("X-Requested-With"), null);
  assert.equal(init.headers.get("A"), "b");
  assert.equal(init.mode, undefined);
  assert.equal(providerCalled, false, "provider not called for cross-origin");
});

test("absolute URLs on the page's own origin count as same-origin", async () => {
  await httpKit.get("https://app.test/api");
  assert.equal(lastCall().init.headers.get("X-CSRF-Token"), "secret");
});

test("header precedence: defaults < dynamic < per-call, any HeadersInit form", async () => {
  httpKit.setHeaderProvider(async () => new Headers({ "X-Requested-With": "dyn", "X-A": "dyn", "X-B": "dyn" }));
  await httpKit.get("/api", { headers: new Headers({ "X-B": "call" }) });
  let { headers } = lastCall().init;
  assert.equal(headers.get("X-Requested-With"), "dyn");
  assert.equal(headers.get("X-A"), "dyn");
  assert.equal(headers.get("X-B"), "call");

  await httpKit.get("/api", { headers: [["X-A", "pairs"]] });
  ({ headers } = lastCall().init);
  assert.equal(headers.get("X-A"), "pairs");
});

test("per-call options override defaults, including mode", async () => {
  await httpKit.get("/api", { mode: "cors", credentials: "include", cache: "no-store" });
  const { init } = lastCall();
  assert.equal(init.mode, "cors");
  assert.equal(init.credentials, "include");
  assert.equal(init.cache, "no-store");
});

test("verb shorthands set method and body", async () => {
  for (const [verb, method] of [["post", "POST"], ["put", "PUT"], ["delete", "DELETE"]]) {
    await httpKit[verb]("/api", "payload", { method: "IGNORED" });
    assert.equal(lastCall().init.method, method);
    assert.equal(lastCall().init.body, "payload");
  }
  await httpKit.get("/api", { method: "POST" });
  assert.equal(lastCall().init.method, "GET");
});

test("non-2xx responses throw with status and response attached", async () => {
  respond = () => new Response("nope", { status: 404, statusText: "Not Found" });
  await assert.rejects(httpKit.get("/missing"), (err) => {
    assert.equal(err.message, "HTTP 404");
    assert.equal(err.status, 404);
    assert.equal(err.statusText, "Not Found");
    assert.ok(err.response instanceof Response);
    return true;
  });
});

test("setHeaderProvider rejects non-functions", () => {
  assert.throws(() => httpKit.setHeaderProvider({}), TypeError);
});

// --- resourceIntoTarget ---

test("default inserts at position without removing anything", async () => {
  const el = box("<span>old</span>");
  await httpKit.resourceIntoTarget("/p", el);
  assert.equal(el.innerHTML, "<span>old</span><p>hi</p>");
  await httpKit.resourceIntoTarget("/p", el, { position: "afterbegin" });
  assert.equal(el.innerHTML, "<p>hi</p><span>old</span><p>hi</p>");
});

test("replace inner swaps contents and ignores position", async () => {
  const el = box("<span>old</span>");
  await httpKit.resourceIntoTarget("/p", el, { replace: "inner", position: "afterend" });
  assert.equal(el.innerHTML, "<p>hi</p>");
  assert.equal(el.nextSibling, null);
});

test("replace outer swaps the target in place, keeping text siblings", async () => {
  const wrap = box("a<b id=t></b>c");
  await httpKit.resourceIntoTarget("/p", wrap.querySelector("#t"), { replace: "outer" });
  assert.equal(wrap.innerHTML, "a<p>hi</p>c");
});

test("replace outer on a detached target fails", async () => {
  const detached = document.createElement("div");
  await assert.rejects(
    httpKit.resourceIntoTarget("/p", detached, { replace: "outer", throwOnError: true }),
    /no parent/,
  );
});

test("argument validation throws synchronously-rejected errors", async () => {
  await assert.rejects(httpKit.resourceIntoTarget("/p", null), TypeError);
  await assert.rejects(httpKit.resourceIntoTarget("/p", document.createTextNode("x")), TypeError);
  await assert.rejects(httpKit.resourceIntoTarget("/p", box(), { position: "inside" }), RangeError);
  assert.equal(calls.length, 0, "nothing fetched");
});

test("cross-origin HTML is refused unless allowed", async () => {
  const el = box();
  await assert.rejects(httpKit.resourceIntoTarget("https://other.test/p", el), /another origin/);
  assert.equal(calls.length, 0);

  await httpKit.resourceIntoTarget("https://other.test/p", el, { allowCrossOrigin: true });
  assert.equal(el.innerHTML, "<p>hi</p>");
});

test("non-HTML responses are not inserted", async () => {
  const el = box("keep");
  respond = () => html('{"x":1}', "application/json");
  await assert.rejects(httpKit.resourceIntoTarget("/p", el, { throwOnError: true }), /Expected text\/html/);
  respond = () => new Response("<p>no type</p>");
  await assert.rejects(httpKit.resourceIntoTarget("/p", el, { throwOnError: true }), /Expected text\/html/);
  assert.equal(el.innerHTML, "keep");
});

test("failures warn instead of throwing by default", async () => {
  const warn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    respond = () => new Response("", { status: 500 });
    await httpKit.resourceIntoTarget("/p", box());
    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /Failed to load \/p/);
  } finally {
    console.warn = warn;
  }
});

function delayedResponder(delays) {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(html(`<i>${url}</i>`)), delays[url] ?? 0);
      init.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

test("a newer load into the same target cancels the older one silently", async () => {
  respond = delayedResponder({ "/slow": 30 });
  const el = box();
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    await Promise.all([
      httpKit.resourceIntoTarget("/slow", el, { replace: "inner" }),
      httpKit.resourceIntoTarget("/fast", el, { replace: "inner" }),
    ]);
  } finally {
    console.warn = warn;
  }
  assert.equal(el.innerHTML, "<i>/fast</i>");
  assert.equal(warned, 0);
});

test("loads into different targets do not cancel each other", async () => {
  respond = delayedResponder({ "/one": 10 });
  const a = box();
  const b = box();
  await Promise.all([
    httpKit.resourceIntoTarget("/one", a, { replace: "inner" }),
    httpKit.resourceIntoTarget("/two", b, { replace: "inner" }),
  ]);
  assert.equal(a.innerHTML, "<i>/one</i>");
  assert.equal(b.innerHTML, "<i>/two</i>");
});

test("the caller's signal cancels silently, even with throwOnError", async () => {
  respond = delayedResponder({ "/p": 30 });
  const el = box("keep");
  const controller = new AbortController();
  const load = httpKit.resourceIntoTarget("/p", el, { signal: controller.signal, throwOnError: true });
  controller.abort();
  await load;
  assert.equal(el.innerHTML, "keep");
});

test("components in inserted HTML hydrate", async () => {
  const hydrated = [];
  register("http-comp", class extends Component {
    hydrate() {
      hydrated.push(this.id);
    }
  });
  respond = () => html('<http-comp id="x"></http-comp><div><http-comp id="y"></http-comp></div>');
  await httpKit.resourceIntoTarget("/p", box(), { replace: "inner" });
  assert.deepEqual(hydrated, ["x", "y"]);
});

test("replace outer destroys a component target", async () => {
  const log = [];
  register("http-outer", class extends Component {
    destroy() {
      log.push("destroy");
    }
  });
  const wrap = box("<http-outer></http-outer>");
  await httpKit.resourceIntoTarget("/p", wrap.firstChild, { replace: "outer" });
  assert.deepEqual(log, ["destroy"]);
  assert.equal(wrap.innerHTML, "<p>hi</p>");
});
