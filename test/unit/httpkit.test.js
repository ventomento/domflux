import "./setup.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Component, register, httpKit } from "../../index.js";

const html = (body, type = "text/html; charset=utf-8") => new Response(body, { headers: { "Content-Type": type } });
const json = (data) => new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });

let calls;
let failures;
let respond;
globalThis.fetch = async (url, init) => {
  calls.push({ url, init });
  return respond(String(url), init);
};
const lastCall = () => calls.at(-1);

beforeEach(() => {
  calls = [];
  failures = [];
  respond = () => html("<p>hi</p>");
  httpKit.setHeaders(async () => ({ "x-fingerprint": "fp" }));
  httpKit.setFailureHandler((failure) => failures.push(failure));
  document.body.innerHTML = "";
});

function box(inner = "") {
  const el = document.createElement("div");
  el.innerHTML = inner;
  document.body.append(el);
  return el;
}

// Resolves after `delay` ms unless the request's signal aborts first.
function delayedResponder(delays) {
  return (url, init) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(html(`<i>${url}</i>`)), delays[url] ?? 0);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

// --- request ---

test("passes url and options through to fetch, adding the dynamic headers", async () => {
  const url = new URL("https://app.test/api");
  await httpKit.request(url, { method: "POST", body: "x", credentials: "include", cache: "no-store" });
  const { url: sentUrl, init } = lastCall();
  assert.equal(sentUrl, url);
  assert.equal(init.method, "POST");
  assert.equal(init.body, "x");
  assert.equal(init.credentials, "include");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(init.headers, { "x-fingerprint": "fp" });
});

test("redirects reject by default; per-call options can allow them", async () => {
  await httpKit.get("/api");
  assert.equal(lastCall().init.redirect, "error");
  await httpKit.get("/api", { redirect: "follow" });
  assert.equal(lastCall().init.redirect, "follow");
});

test("the provider runs on every request and receives url and options", async () => {
  const seen = [];
  let clicks = 0;
  httpKit.setHeaders(async (url, options) => {
    seen.push([url, options.method]);
    return { "x-clicks": String(clicks) };
  });
  await httpKit.get("/a");
  clicks = 3;
  await httpKit.post("/b", "x");
  assert.deepEqual(seen, [["/a", "GET"], ["/b", "POST"]]);
  assert.deepEqual(calls.map((c) => c.init.headers["x-clicks"]), ["0", "3"]);
});

test("a synchronous provider works too", async () => {
  httpKit.setHeaders(() => ({ "x-a": "sync" }));
  await httpKit.get("/api");
  assert.deepEqual(lastCall().init.headers, { "x-a": "sync" });
});

test("per-call headers override the dynamic ones", async () => {
  httpKit.setHeaders(async () => ({ "x-a": "dyn", "x-b": "dyn" }));
  await httpKit.get("/api", { headers: { "x-b": "call" } });
  assert.deepEqual(lastCall().init.headers, { "x-a": "dyn", "x-b": "call" });
});

test("dynamic headers go to every origin", async () => {
  await httpKit.get("https://analytics.other.test/e");
  assert.deepEqual(lastCall().init.headers, { "x-fingerprint": "fp" });
  assert.equal(lastCall().init.mode, undefined);
});

test("2xx responses come back without calling the failure handler", async () => {
  const res = await httpKit.get("/ok");
  assert.equal(res.ok, true);
  assert.deepEqual(failures, []);
});

test("non-2xx responses call the handler and still come back, body unread", async () => {
  respond = () => new Response("nope", { status: 404 });
  const options = { method: "DELETE" };
  const res = await httpKit.request("/missing", options);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "nope");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, "/missing");
  assert.equal(failures[0].options, options);
  assert.equal(failures[0].response, res);
  assert.equal(failures[0].error, undefined);
});

test("network errors call the handler and resolve to Response.error()", async () => {
  const error = new TypeError("Failed to fetch");
  respond = () => Promise.reject(error);
  const res = await httpKit.get("/down");
  assert.equal(res.ok, false);
  assert.equal(res.status, 0);
  assert.equal(res.type, "error");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].url, "/down");
  assert.equal(failures[0].error, error);
  assert.equal(failures[0].response, undefined);
});

test("aborts resolve to Response.error() without calling the handler", async () => {
  respond = delayedResponder({ "/p": 30 });
  const controller = new AbortController();
  const pending = httpKit.get("/p", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve));
  controller.abort();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.type, "error");
  assert.deepEqual(failures, []);
});

test("a timeout is a failure, not an abort", async () => {
  const error = new DOMException("timed out", "TimeoutError");
  respond = () => Promise.reject(error);
  const res = await httpKit.get("/slow");
  assert.equal(res.ok, false);
  assert.equal(failures[0].error, error);
});

test("a manual redirect is what the caller asked for, not a failure", async () => {
  const redirect = { ok: false, type: "opaqueredirect", status: 0 };
  respond = () => redirect;
  assert.equal(await httpKit.get("/login", { redirect: "manual" }), redirect);
  assert.deepEqual(failures, []);
});

test("a throwing header provider rejects, sends nothing and is not a failure", async () => {
  httpKit.setHeaders(() => {
    throw new RangeError("provider bug");
  });
  await assert.rejects(httpKit.get("/api"), RangeError);
  await assert.rejects(httpKit.load(box(), "/api"), RangeError);
  assert.equal(calls.length, 0);
  assert.deepEqual(failures, []);
});

test("a throwing failure handler rejects", async () => {
  httpKit.setFailureHandler(() => {
    throw new RangeError("handler bug");
  });
  respond = () => new Response("nope", { status: 500 });
  await assert.rejects(httpKit.get("/a"), RangeError);
  respond = () => Promise.reject(new TypeError("Failed to fetch"));
  await assert.rejects(httpKit.get("/b"), RangeError);
});

test("verb shorthands set method and body", async () => {
  for (const [verb, method] of [["post", "POST"], ["put", "PUT"], ["patch", "PATCH"]]) {
    await httpKit[verb]("/api", "payload", { method: "IGNORED" });
    assert.equal(lastCall().init.method, method);
    assert.equal(lastCall().init.body, "payload");
  }
  for (const [verb, method] of [["get", "GET"], ["delete", "DELETE"]]) {
    await httpKit[verb]("/api", { method: "IGNORED" });
    assert.equal(lastCall().init.method, method);
    assert.equal(lastCall().init.body, undefined);
  }
});

// --- load ---

test("load GETs the url with the dynamic headers and resolves with the response", async () => {
  const res = await httpKit.load(box(), "/p");
  assert.ok(res instanceof Response);
  assert.equal(lastCall().url, "/p");
  assert.equal(lastCall().init.method, undefined, "fetch's default GET");
  assert.deepEqual(lastCall().init.headers, { "x-fingerprint": "fp" });
});

test("default position replaces the target's contents", async () => {
  const el = box("<span>old</span>");
  await httpKit.load(el, "/p");
  assert.equal(el.innerHTML, "<p>hi</p>");
});

test("prepend and append insert inside the target", async () => {
  const el = box("<span>old</span>");
  await httpKit.load(el, "/p", { at: "append" });
  await httpKit.load(el, "/p", { at: "prepend" });
  assert.equal(el.innerHTML, "<p>hi</p><span>old</span><p>hi</p>");
});

test("before and after insert next to the target", async () => {
  const wrap = box("<b id=t></b>");
  const target = wrap.querySelector("#t");
  await httpKit.load(target, "/p", { at: "before" });
  await httpKit.load(target, "/p", { at: "after" });
  assert.equal(wrap.innerHTML, '<p>hi</p><b id="t"></b><p>hi</p>');
});

test("outer replaces the target in place, keeping text siblings", async () => {
  const wrap = box("a<b id=t></b>c");
  await httpKit.load(wrap.querySelector("#t"), "/p", { at: "outer" });
  assert.equal(wrap.innerHTML, "a<p>hi</p>c");
});

test("inserting next to a detached target rejects", async () => {
  for (const at of ["outer", "before", "after"]) {
    await assert.rejects(httpKit.load(document.createElement("div"), "/p", { at }), /detached/);
  }
});

test("inserting inside a detached target works", async () => {
  const el = document.createElement("div");
  await httpKit.load(el, "/p", { at: "append" });
  assert.equal(el.innerHTML, "<p>hi</p>");
});

test("invalid arguments reject before anything is fetched", async () => {
  await assert.rejects(httpKit.load(null, "/p"), TypeError);
  await assert.rejects(httpKit.load(document.createTextNode("x"), "/p"), TypeError);
  await assert.rejects(httpKit.load(box(), "/p", { at: "beforeend" }), RangeError);
  await assert.rejects(httpKit.load(box(), "/p", { at: "toString" }), RangeError);
  assert.equal(calls.length, 0);
});

test("JSON is passed to render with the response, and its result is inserted", async () => {
  respond = () => json([{ name: "a" }, { name: "b" }]);
  const el = box();
  let seenResponse;
  const res = await httpKit.load(el, "/rows", {
    render: (rows, response) => {
      seenResponse = response;
      return rows.map((r) => `<li>${r.name}</li>`).join("");
    },
  });
  assert.equal(el.innerHTML, "<li>a</li><li>b</li>");
  assert.equal(seenResponse, res);
});

test("render can transform HTML too", async () => {
  const el = box();
  await httpKit.load(el, "/p", { render: (text) => `<section>${text}</section>` });
  assert.equal(el.innerHTML, "<section><p>hi</p></section>");
});

test("render can return an element", async () => {
  respond = () => json({ name: "a" });
  const el = box("<span>old</span>");
  await httpKit.load(el, "/p", {
    render: ({ name }) => {
      const li = document.createElement("li");
      li.textContent = name;
      return li;
    },
  });
  assert.equal(el.innerHTML, "<li>a</li>");
});

test("render can return a fragment, at every position", async () => {
  const fragment = () => {
    const nodes = document.createDocumentFragment();
    nodes.append(document.createElement("i"), document.createElement("u"));
    return nodes;
  };
  const wrap = box("<b id=t><span></span></b>");
  const target = wrap.querySelector("#t");
  await httpKit.load(target, "/p", { at: "prepend", render: fragment });
  await httpKit.load(target, "/p", { at: "append", render: fragment });
  await httpKit.load(target, "/p", { at: "before", render: fragment });
  await httpKit.load(target, "/p", { at: "after", render: fragment });
  assert.equal(wrap.innerHTML, '<i></i><u></u><b id="t"><i></i><u></u><span></span><i></i><u></u></b><i></i><u></u>');
  await httpKit.load(target, "/p", { at: "inner", render: fragment });
  assert.equal(target.innerHTML, "<i></i><u></u>");
  await httpKit.load(target, "/p", { at: "outer", render: fragment });
  assert.equal(wrap.innerHTML, "<i></i><u></u><i></i><u></u><i></i><u></u>");
});

test("render can return an array, of nodes and HTML strings", async () => {
  const el = box();
  await httpKit.load(el, "/p", { render: () => [document.createElement("i"), "<u>x</u>"] });
  assert.equal(el.innerHTML, "<i></i><u>x</u>");
});

test("an empty render result empties an inner target", async () => {
  const el = box("<span>old</span>");
  await httpKit.load(el, "/p", { render: () => "" });
  assert.equal(el.innerHTML, "");
  el.innerHTML = "<span>old</span>";
  await httpKit.load(el, "/p", { render: () => [] });
  assert.equal(el.innerHTML, "");
});

test("JSON without render, or a render that returns nothing insertable, rejects", async () => {
  const el = box("keep");
  respond = () => json({ x: 1 });
  await assert.rejects(httpKit.load(el, "/p"), /JSON needs a render function/);
  await assert.rejects(httpKit.load(el, "/p", { render: () => null }), TypeError);
  await assert.rejects(httpKit.load(el, "/p", { render: () => [null] }), TypeError);
  await assert.rejects(httpKit.load(el, "/p", { render: () => ({ nodeName: "P" }) }), TypeError);
  assert.equal(el.innerHTML, "keep");
});

test("a render bug rejects and is not a failure", async () => {
  await assert.rejects(httpKit.load(box(), "/p", {
    render: () => {
      throw new RangeError("render bug");
    },
  }), RangeError);
  assert.deepEqual(failures, []);
});

test("at can be a function that places the rendered node itself", async () => {
  const el = box("<span>old</span>");
  let placed;
  const res = await httpKit.load(el, "/p", {
    at: (target, node) => {
      placed = [target, node.nodeType];
      target.prepend(...[...node.childNodes].reverse());
    },
    render: () => "<i></i><u></u>",
  });
  assert.ok(res instanceof Response);
  assert.deepEqual(placed, [el, 11]);
  assert.equal(el.innerHTML, "<u></u><i></i><span>old</span>");
});

test("a function at runs on neither a failure nor an abort", async () => {
  let placed = false;
  const at = () => (placed = true);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await httpKit.load(box(), "/p", { at, signal: controller.signal }), null);
  respond = () => new Response("nope", { status: 500 });
  assert.equal(await httpKit.load(box(), "/p", { at }), null);
  assert.equal(placed, false);
});

test("other or missing content types are not inserted", async () => {
  const el = box("keep");
  respond = () => html("<p>x</p>", "text/plain");
  await assert.rejects(httpKit.load(el, "/p"), /Expected HTML or JSON, got "text\/plain"/);
  respond = () => new Response(new Blob(["<p>x</p>"]));
  await assert.rejects(httpKit.load(el, "/p"), /Expected HTML or JSON/);
  assert.equal(el.innerHTML, "keep");
});

test("non-2xx responses call the handler, resolve null and insert nothing", async () => {
  const el = box("keep");
  respond = () => new Response("<p>error page</p>", { status: 500, headers: { "Content-Type": "text/html" } });
  assert.equal(await httpKit.load(el, "/p"), null);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].response.status, 500);
  assert.equal(el.innerHTML, "keep");
});

test("network errors call the handler, resolve null and insert nothing", async () => {
  const el = box("keep");
  respond = () => Promise.reject(new TypeError("Failed to fetch"));
  assert.equal(await httpKit.load(el, "/p"), null);
  assert.equal(failures.length, 1);
  assert.equal(el.innerHTML, "keep");
});

test("aborting the signal resolves null, calls no handler and inserts nothing", async () => {
  respond = delayedResponder({ "/p": 30 });
  const el = box("keep");
  const controller = new AbortController();
  const pending = httpKit.load(el, "/p", { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve));
  controller.abort();
  assert.equal(await pending, null);
  assert.deepEqual(failures, []);
  assert.equal(el.innerHTML, "keep");
});

test("an abort while the body is read resolves null", async () => {
  const body = { headers: new Headers({ "Content-Type": "text/html" }), ok: true, text: () => Promise.reject(new DOMException("aborted", "AbortError")) };
  respond = () => body;
  const el = box("keep");
  assert.equal(await httpKit.load(el, "/p"), null);
  assert.deepEqual(failures, []);
  assert.equal(el.innerHTML, "keep");
});

test("aborting after the response arrives still inserts nothing", async () => {
  const controller = new AbortController();
  respond = () => {
    controller.abort(); // fetch already resolved; the body read is what's left
    return html("<p>late</p>");
  };
  const el = box("keep");
  assert.equal(await httpKit.load(el, "/p", { signal: controller.signal }), null);
  assert.equal(el.innerHTML, "keep");
});

test("concurrent loads are the caller's to coordinate: abort the previous one", async () => {
  respond = delayedResponder({ "/slow": 30 });
  const el = box();
  const slow = new AbortController();
  const first = httpKit.load(el, "/slow", { signal: slow.signal });
  slow.abort();
  const second = httpKit.load(el, "/fast");
  assert.deepEqual(await Promise.all([first, second]).then((r) => r.map(Boolean)), [false, true]);
  assert.equal(el.innerHTML, "<i>/fast</i>");
});

test("uncoordinated concurrent loads are not cancelled: the last to arrive wins", async () => {
  respond = delayedResponder({ "/slow": 30 });
  const el = box();
  await Promise.all([httpKit.load(el, "/slow"), httpKit.load(el, "/fast")]);
  assert.equal(el.innerHTML, "<i>/slow</i>");
});

test("components in inserted HTML hydrate", async () => {
  const hydrated = [];
  register("http-comp", class extends Component {
    hydrate() {
      hydrated.push(this.id);
    }
  });
  respond = () => html('<http-comp id="x"></http-comp><div><http-comp id="y"></http-comp></div>');
  await httpKit.load(box(), "/p");
  assert.deepEqual(hydrated, ["x", "y"]);
});

test("components rendered from JSON hydrate", async () => {
  const hydrated = [];
  register("http-json-comp", class extends Component {
    hydrate() {
      hydrated.push(this.id);
    }
  });
  respond = () => json(["a", "b"]);
  await httpKit.load(box(), "/p", { render: (ids) => ids.map((id) => `<http-json-comp id="${id}"></http-json-comp>`).join("") });
  assert.deepEqual(hydrated, ["a", "b"]);
});

test("components rendered as nodes hydrate once inserted", async () => {
  const hydrated = [];
  register("http-node-comp", class extends Component {
    hydrate() {
      hydrated.push(this.id);
    }
  });
  respond = () => json(["a", "b"]);
  await httpKit.load(box(), "/p", {
    render: (ids) => ids.map((id) => {
      const el = document.createElement("http-node-comp");
      el.id = id;
      return el;
    }),
  });
  assert.deepEqual(hydrated, ["a", "b"]);
});

test("outer destroys a component target", async () => {
  const log = [];
  register("http-outer", class extends Component {
    destroy() {
      log.push("destroy");
    }
  });
  const wrap = box("<http-outer></http-outer>");
  await httpKit.load(wrap.firstChild, "/p", { at: "outer" });
  assert.deepEqual(log, ["destroy"]);
  assert.equal(wrap.innerHTML, "<p>hi</p>");
});
