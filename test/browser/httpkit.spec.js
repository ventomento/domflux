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

// Runs httpKit.get in the page; resolves to "ok" or the error name.
const get = (page, url, options = {}) =>
  page.evaluate(
    async ([url, options]) => {
      try {
        await window.domflux.httpKit.get(url, options);
        return "ok";
      } catch (e) {
        return e.name;
      }
    },
    [url, options],
  );

test("control: an explicit redirect: 'follow' carries the headers to the other origin", async ({ page, other }) => {
  // Proves the next test can detect a leak.
  await open(page, { module: SETUP });
  expect(await get(page, `/redirect?to=${other.origin}/steal`, { redirect: "follow" })).toBe("ok");
  expect(other.requests.find((r) => r.method === "GET")?.headers["x-fingerprint"]).toBe("fp");
});

test("redirects reject by default, before the headers leave", async ({ page, other }) => {
  await open(page, { module: SETUP });
  expect(await get(page, `/redirect?to=${other.origin}/steal`)).toBe("TypeError");
  expect(other.requests).toEqual([]);
});

test("non-2xx responses resolve like fetch", async ({ page }) => {
  await open(page, { module: SETUP });
  const status = await page.evaluate(async () => (await window.domflux.httpKit.get("/missing")).status);
  expect(status).toBe(404);
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
  await page.route(`${origin}/slow`, async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill(html("<i>slow</i>")).catch(() => (slowAborted = true));
  });
  await page.route(`${origin}/fast`, (route) => route.fulfill(html("<i>fast</i>")));
  await open(page, { body: `<div id="box"></div>`, module: SETUP });

  const result = await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    const box = document.getElementById("box");
    const controller = new AbortController();
    const slow = httpKit.load(box, "/slow", { signal: controller.signal });
    controller.abort();
    const fast = httpKit.load(box, "/fast");
    const [slowResult] = await Promise.all([slow, fast]);
    await new Promise((r) => setTimeout(r, 400));
    return { html: box.innerHTML, slowResult: slowResult ?? null };
  });
  expect(result).toEqual({ html: "<i>fast</i>", slowResult: null });
  expect(slowAborted).toBe(true);
});
