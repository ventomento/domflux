import { test, expect, open, events } from "./fixture.js";

const LOGGER = `
class Logged extends Component {
  hydrate() { events.push(["hydrate", this.id, this.children.length]); }
  destroy() { events.push(["destroy", this.id]); }
}
register("x-logged", Logged);
`;

test("components parsed in the page hydrate with their children available", async ({ page }) => {
  await open(page, {
    body: `<x-logged id="a"><p>1</p><p>2</p></x-logged><x-logged id="b"></x-logged>`,
    module: LOGGER,
  });
  expect(await events(page)).toEqual([["hydrate", "a", 2], ["hydrate", "b", 0]]);
});

test("moveBefore keeps the component alive; appendChild re-hydrates", async ({ page }) => {
  await open(page, {
    body: `<div id="from"><x-logged id="a"></x-logged></div><div id="to"></div>`,
    module: LOGGER,
  });
  const supported = await page.evaluate(() => typeof Element.prototype.moveBefore === "function");
  test.skip(!supported, "Element.moveBefore not supported in this browser");

  const result = await page.evaluate(() => {
    events.length = 0;
    const el = document.getElementById("a");
    const signal = el.signal;
    document.getElementById("to").moveBefore(el, null);
    const afterMoveBefore = { events: [...events], sameSignal: el.signal === signal, aborted: signal.aborted };

    document.getElementById("from").appendChild(el);
    return { afterMoveBefore, afterAppend: [...events] };
  });

  expect(result.afterMoveBefore).toEqual({ events: [], sameSignal: true, aborted: false });
  expect(result.afterAppend).toEqual([["destroy", "a"], ["hydrate", "a", 0]]);
});

test("a modal dialog inside a component opens in the top layer without disconnecting it", async ({ page }) => {
  await open(page, {
    style: `.clip { overflow: hidden; height: 10px; position: relative; z-index: 1; transform: translateZ(0); }`,
    body: `<div class="clip"><x-logged id="a"><dialog><button>x</button></dialog></x-logged></div>`,
    module: LOGGER,
  });
  const result = await page.evaluate(() => {
    events.length = 0;
    const dialog = document.querySelector("dialog");
    dialog.showModal();
    const rect = dialog.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return { events: [...events], open: dialog.open, topmost: dialog.contains(hit) };
  });
  expect(result).toEqual({ events: [], open: true, topmost: true });
});

test("components inside shadow roots hydrate and destroy", async ({ page }) => {
  await open(page, { module: LOGGER });
  const result = await page.evaluate(() => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<x-logged id="s"></x-logged>`;
    host.remove();
    return events;
  });
  expect(result).toEqual([["hydrate", "s", 0], ["destroy", "s"]]);
});

test("listeners added with the signal are removed on disconnect", async ({ page }) => {
  await open(page, {
    body: `<x-counter></x-counter>`,
    module: `
      register("x-counter", class extends Component {
        hydrate() { window.addEventListener("ping", () => events.push("ping"), { signal: this.signal }); }
      });
    `,
  });
  const result = await page.evaluate(() => {
    dispatchEvent(new Event("ping"));
    document.querySelector("x-counter").remove();
    dispatchEvent(new Event("ping"));
    return events;
  });
  expect(result).toEqual(["ping"]);
});
