import { test, expect, open } from "./fixture.js";

const SETUP = `
httpKit.setHeaderProvider(async () => ({ "X-CSRF-Token": "secret" }));
register("x-part", class extends Component {
  hydrate() { events.push(["hydrate", this.id]); }
});
`;

const html = (body) => ({ contentType: "text/html", body });

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

test("same-origin requests carry the dynamic headers", async ({ page, origin }) => {
  let headers;
  await page.route(`${origin}/api`, (route) => {
    headers = route.request().headers();
    return route.fulfill({ body: "ok" });
  });
  await open(page, { module: SETUP });
  expect(await get(page, "/api")).toBe("ok");
  expect(headers["x-csrf-token"]).toBe("secret");
  expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
});

test("cross-origin requests do not carry the dynamic headers and need no preflight", async ({ page, other }) => {
  await open(page, { module: SETUP });
  expect(await get(page, `${other.origin}/api`)).toBe("ok");
  expect(other.requests.map((r) => r.method)).toEqual(["GET"]);
  expect(other.requests[0].headers["x-csrf-token"]).toBeUndefined();
  expect(other.requests[0].headers["x-requested-with"]).toBeUndefined();
});

test("control: forcing cors mode on a redirecting same-origin request leaks the token", async ({ page, other }) => {
  // Proves the next test can detect a leak: without same-origin mode the
  // browser follows the redirect and the other origin receives the token.
  await open(page, { module: SETUP });
  expect(await get(page, `/redirect?to=${other.origin}/steal`, { mode: "cors" })).toBe("ok");
  expect(other.requests.find((r) => r.method === "GET")?.headers["x-csrf-token"]).toBe("secret");
});

test("a same-origin redirect to another origin fails before the token leaves", async ({ page, other }) => {
  await open(page, { body: `<div id="box"></div>`, module: SETUP });
  const redirect = `/redirect?to=${other.origin}/steal`;

  expect(await get(page, redirect)).toBe("TypeError");

  const inserted = await page.evaluate(async (url) => {
    const box = document.getElementById("box");
    console.warn = () => {};
    await window.domflux.httpKit.resourceIntoTarget(url, box);
    return box.innerHTML;
  }, redirect);
  expect(inserted).toBe("");
  expect(other.requests).toEqual([]);
});

test("inserted HTML hydrates components; inline scripts do not run", async ({ page, origin }) => {
  await page.route(`${origin}/partial`, (route) =>
    route.fulfill(html(`<x-part id="a"></x-part><script>window.ran = true</script><div><x-part id="b"></x-part></div>`)),
  );
  await open(page, { body: `<div id="box"></div>`, module: SETUP });
  const result = await page.evaluate(async () => {
    await window.domflux.httpKit.resourceIntoTarget("/partial", document.getElementById("box"), { replace: "inner" });
    return { events, ran: window.ran ?? false };
  });
  expect(result).toEqual({ events: [["hydrate", "a"], ["hydrate", "b"]], ran: false });
});

test("a newer load into the same target wins and the older request is aborted", async ({ page, origin }) => {
  await page.route(`${origin}/slow`, async (route) => {
    await new Promise((r) => setTimeout(r, 300));
    await route.fulfill(html("<i>slow</i>")).catch(() => {}); // aborted by the page
  });
  await page.route(`${origin}/fast`, (route) => route.fulfill(html("<i>fast</i>")));
  await open(page, { body: `<div id="box"></div>`, module: SETUP });

  const result = await page.evaluate(async () => {
    const { httpKit } = window.domflux;
    const box = document.getElementById("box");
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(" "));
    await Promise.all([
      httpKit.resourceIntoTarget("/slow", box, { replace: "inner" }),
      httpKit.resourceIntoTarget("/fast", box, { replace: "inner" }),
    ]);
    await new Promise((r) => setTimeout(r, 400));
    return { html: box.innerHTML, warnings };
  });
  expect(result).toEqual({ html: "<i>fast</i>", warnings: [] });
});
