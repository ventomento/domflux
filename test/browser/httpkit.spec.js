import { test, expect, open } from "./fixture.js";

const SETUP = `
let clicks = 0;
window.click = () => clicks++;
httpKit.setHeaders(async () => ({ "x-fingerprint": "fp", "x-clicks": String(clicks) }));
register("x-part", class extends Component {
  hydrate() { events.push(["hydrate", this.id]); }
});
`;

const html = (body) => ({ contentType: "text/html", body });

test("requests carry a fresh snapshot of the dynamic headers", async ({ page, origin }) => {
  const seen = [];
  await page.route(`${origin}/api`, (route) => {
    seen.push(route.request().headers());
    return route.fulfill({ body: "ok" });
  });
  await open(page, { module: SETUP });
  await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    await httpKit.get("/api");
    window.click();
    window.click();
    await httpKit.post("/api", "x");
  });
  expect(seen.map((h) => [h["x-fingerprint"], h["x-clicks"]])).toEqual([["fp", "0"], ["fp", "2"]]);
});

test("dynamic headers reach other origins too, after a CORS preflight", async ({ page, other }) => {
  await open(page, { module: SETUP });
  const status = await page.evaluate(async (url) => (await window.domflux.httpKit.get(url)).status, `${other.origin}/e`);
  expect(status).toBe(200);
  expect(other.requests.map((r) => r.method)).toEqual(["OPTIONS", "GET"]);
  expect(other.requests[1].headers["x-fingerprint"]).toBe("fp");
});

// Runs httpKit.get in the page; resolves to the response's status and type,
// and the name of the error the failure handler received, if any.
const get = (page, url, options = {}) =>
  page.evaluate(
    async ([url, options]) => {
      const { httpKit } = window.domflux;
      let failure = null;
      httpKit.setFailureHandler(({ error, response }) => (failure = error?.name ?? `HTTP ${response.status}`));
      const res = await httpKit.get(url, options);
      return { ok: res.ok, status: res.status, type: res.type, failure };
    },
    [url, options],
  );

test("control: an explicit redirect: 'follow' carries the headers to the other origin", async ({ page, other }) => {
  // Proves the next test can detect a leak.
  await open(page, { module: SETUP });
  expect((await get(page, `/redirect?to=${other.origin}/steal`, { redirect: "follow" })).ok).toBe(true);
  expect(other.requests.find((r) => r.method === "GET")?.headers["x-fingerprint"]).toBe("fp");
});

test("redirects are refused by default, before the headers leave", async ({ page, other }) => {
  await open(page, { module: SETUP });
  expect(await get(page, `/redirect?to=${other.origin}/steal`)).toEqual({
    ok: false, status: 0, type: "error", failure: "TypeError",
  });
  expect(other.requests).toEqual([]);
});

test("a manual redirect comes back as opaqueredirect, not as a failure", async ({ page, other }) => {
  await open(page, { module: SETUP });
  expect(await get(page, `/redirect?to=${other.origin}/steal`, { redirect: "manual" })).toEqual({
    ok: false, status: 0, type: "opaqueredirect", failure: null,
  });
  expect(other.requests).toEqual([]);
});

test("non-2xx responses come back and reach the failure handler", async ({ page }) => {
  await open(page, { module: SETUP });
  expect(await get(page, "/missing")).toEqual({ ok: false, status: 404, type: "basic", failure: "HTTP 404" });
});

test("a network error resolves to a failed response and reaches the failure handler", async ({ page, origin }) => {
  await page.route(`${origin}/down`, (route) => route.abort("connectionrefused"));
  await open(page, { module: SETUP });
  expect(await get(page, "/down")).toEqual({ ok: false, status: 0, type: "error", failure: "TypeError" });
});

test("an aborted request resolves to a failed response, with no failure", async ({ page }) => {
  await open(page, { module: SETUP });
  const result = await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    let failures = 0;
    httpKit.setFailureHandler(() => failures++);
    const res = await httpKit.get("/missing", { signal: AbortSignal.abort() });
    return { ok: res.ok, type: res.type, failures };
  });
  expect(result).toEqual({ ok: false, type: "error", failures: 0 });
});

test("inserted HTML hydrates components; inline scripts do not run", async ({ page, origin }) => {
  await page.route(`${origin}/partial`, (route) =>
    route.fulfill(html(`<x-part id="a"></x-part><script>window.ran = true</script><div><x-part id="b"></x-part></div>`)),
  );
  await open(page, { body: `<div id="box"></div>`, module: SETUP });
  const result = await page.evaluate(async () => {
    await window.domflux.httpKit.load(document.getElementById("box"), "/partial");
    return { events, ran: window.ran ?? false };
  });
  expect(result).toEqual({ events: [["hydrate", "a"], ["hydrate", "b"]], ran: false });
});

test("JSON rendered to HTML hydrates components", async ({ page, origin }) => {
  await page.route(`${origin}/rows`, (route) => route.fulfill({ contentType: "application/json", body: '["a","b"]' }));
  await open(page, { body: `<ul id="list"></ul>`, module: SETUP });
  const result = await page.evaluate(async () => {
    const list = document.getElementById("list");
    await window.domflux.httpKit.load(list, "/rows", {
      at: "append",
      render: (ids) => ids.map((id) => `<li><x-part id="${id}"></x-part></li>`).join(""),
    });
    return { events, html: list.innerHTML };
  });
  expect(result).toEqual({
    events: [["hydrate", "a"], ["hydrate", "b"]],
    html: '<li><x-part id="a"></x-part></li><li><x-part id="b"></x-part></li>',
  });
});

test("JSON rendered to nodes hydrates components, at a custom placement", async ({ page, origin }) => {
  await page.route(`${origin}/rows`, (route) => route.fulfill({ contentType: "application/json", body: '["a","b"]' }));
  await open(page, { body: `<div id="box"><i></i></div>`, module: SETUP });
  const result = await page.evaluate(async () => {
    const box = document.getElementById("box");
    await window.domflux.httpKit.load(box, "/rows", {
      render: (ids) => ids.map((id) => Object.assign(document.createElement("x-part"), { id })),
      at: (target, node) => target.prepend(...[...node.children].reverse()),
    });
    return { events, html: box.innerHTML };
  });
  expect(result).toEqual({
    events: [["hydrate", "b"], ["hydrate", "a"]],
    html: '<x-part id="b"></x-part><x-part id="a"></x-part><i></i>',
  });
});

test("table rows parse and insert into a tbody", async ({ page, origin }) => {
  await page.route(`${origin}/rows`, (route) => route.fulfill(html("<tr><td>a</td></tr>")));
  await open(page, { body: `<table><tbody id="rows"></tbody></table>`, module: SETUP });
  const inserted = await page.evaluate(async () => {
    const rows = document.getElementById("rows");
    await window.domflux.httpKit.load(rows, "/rows");
    return rows.innerHTML;
  });
  expect(inserted).toBe("<tr><td>a</td></tr>");
});

test("a failed load inserts nothing and reaches the failure handler once", async ({ page }) => {
  await open(page, { body: `<div id="box">keep</div>`, module: SETUP });
  const result = await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    const statuses = [];
    httpKit.setFailureHandler(({ response }) => statuses.push(response.status));
    const box = document.getElementById("box");
    const res = await httpKit.load(box, "/missing");
    return { res, statuses, html: box.innerHTML };
  });
  expect(result).toEqual({ res: null, statuses: [404], html: "keep" });
});

test("HTML from another origin can be loaded", async ({ page, other }) => {
  await open(page, { body: `<div id="box"></div>`, module: SETUP });
  const inserted = await page.evaluate(async (url) => {
    const box = document.getElementById("box");
    await window.domflux.httpKit.load(box, url);
    return box.innerHTML;
  }, `${other.origin}/partial`);
  expect(inserted).toBe("<p>from other origin</p>");
});

test("aborting a load cancels the request and the next load wins", async ({ page, origin }) => {
  let slowAborted = false;
  page.on("requestfailed", (request) => {
    if (request.url().endsWith("/slow")) slowAborted = true;
  });
  await page.route(`${origin}/slow`, async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill(html("<i>slow</i>")).catch(() => {});
  });
  await page.route(`${origin}/fast`, (route) => route.fulfill(html("<i>fast</i>")));
  await open(page, { body: `<div id="box"></div>`, module: SETUP });

  // Abort only once the request is on its way: the header provider is awaited
  // first, so an immediate abort would stop it before it was ever sent.
  const slowSent = page.waitForRequest(`${origin}/slow`);
  await page.evaluate(() => {
    window.controller = new AbortController();
    window.slow = window.domflux.httpKit.load(document.getElementById("box"), "/slow", { signal: window.controller.signal });
  });
  await slowSent;

  const result = await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    const box = document.getElementById("box");
    window.controller.abort();
    const fast = httpKit.load(box, "/fast");
    const [slowResult] = await Promise.all([window.slow, fast]);
    await new Promise((r) => setTimeout(r, 400));
    return { html: box.innerHTML, slowResult };
  });
  expect(result).toEqual({ html: "<i>fast</i>", slowResult: null });
  expect(slowAborted).toBe(true);
});
