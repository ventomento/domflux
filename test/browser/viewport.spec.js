import { test, expect, open, settle, events, scrollTo } from "./fixture.js";

// Viewport is 1280x720 (Desktop presets). Components are 100px tall blocks
// positioned absolutely on a 4000px page.
const STYLE = `
  body { height: 4000px; position: relative; }
  x-watch, x-enter { display: block; position: absolute; left: 0; width: 100px; height: 100px; }
`;

const COMPONENTS = `
class Watch extends Component {
  onEnter() { events.push(["enter", this.id]); }
  onLeave() { events.push(["leave", this.id]); }
  destroy() { events.push(["destroy", this.id]); }
}
class EnterOnly extends Component {
  onEnter() { events.push(["enter", this.id]); }
}
register("x-watch", Watch);
register("x-enter", EnterOnly);
`;

const at = (tag, id, top) => `<${tag} id="${id}" style="top:${top}px"></${tag}>`;

test("the default bottom margin preloads onEnter up to 150px below the viewport", async ({ page }) => {
  await open(page, {
    style: STYLE,
    body: at("x-enter", "visible", 100) + at("x-enter", "near", 800) + at("x-enter", "far", 1000),
    module: COMPONENTS,
  });
  await settle(page);
  expect(await events(page)).toEqual([["enter", "visible"], ["enter", "near"]]);
});

test("onEnter fires once; onLeave fires on every exit in both directions", async ({ page }) => {
  await open(page, { style: STYLE, body: at("x-watch", "w", 1500), module: COMPONENTS });
  await settle(page);
  expect(await events(page)).toEqual([]);

  await scrollTo(page, 1200); // scrolled down to it
  await scrollTo(page, 0); // scrolled back up: leaves through the bottom
  await scrollTo(page, 1200); // visible again: no second enter
  await scrollTo(page, 2500); // scrolled past: leaves through the top

  expect(await events(page)).toEqual([["enter", "w"], ["leave", "w"], ["leave", "w"]]);
});

test("content above a restored scroll position enters when scrolled up to", async ({ page }) => {
  await open(page, { style: STYLE, body: at("x-enter", "above", 200) + at("x-enter", "here", 2200) });
  await scrollTo(page, 2000);
  await page.evaluate(COMPONENTS_REGISTER);
  await settle(page);
  expect(await events(page)).toEqual([["enter", "here"]]);

  await scrollTo(page, 0);
  expect(await events(page)).toEqual([["enter", "here"], ["enter", "above"]]);
});

// Registers COMPONENTS from page.evaluate (outside the module script).
function COMPONENTS_REGISTER() {
  const { Component, register } = window.domflux;
  register("x-enter", class extends Component {
    onEnter() {
      events.push(["enter", this.id]);
    }
  });
}

test("removing a visible component destroys it without onLeave", async ({ page }) => {
  await open(page, { style: STYLE, body: at("x-watch", "w", 100), module: COMPONENTS });
  await settle(page);
  await page.evaluate(() => document.getElementById("w").remove());
  await settle(page);
  expect(await events(page)).toEqual([["enter", "w"], ["destroy", "w"]]);
});

test("components inserted later are observed", async ({ page }) => {
  await open(page, { style: STYLE, module: COMPONENTS });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", `<x-enter id="late" style="top:50px"></x-enter>`);
  });
  await settle(page);
  expect(await events(page)).toEqual([["enter", "late"]]);
});

test("configureViewport sets the sitewide box and is locked once in use", async ({ page }) => {
  await open(page, {
    style: STYLE,
    body: at("x-enter", "near", 800) + at("x-enter", "visible", 100),
    module: `configureViewport({ rootMargin: "0px" });\n${COMPONENTS}`,
  });
  await settle(page);
  expect(await events(page)).toEqual([["enter", "visible"]]);

  const error = await page.evaluate(() => {
    try {
      window.domflux.configureViewport({ rootMargin: "500px" });
    } catch (e) {
      return e.message;
    }
  });
  expect(error).toMatch(/before any component is observed/);
});

test("a threshold requires that share of the element to be visible", async ({ page }) => {
  await open(page, {
    style: STYLE,
    body: at("x-watch", "w", 690), // 30% of its 100px inside the 720px viewport
    module: `configureViewport({ rootMargin: "0px", threshold: 0.5 });\n${COMPONENTS}`,
  });
  await settle(page);
  expect(await events(page)).toEqual([]);

  await scrollTo(page, 100); // 590–690: 100% visible
  await scrollTo(page, 10); // 680–780: 40% visible, below threshold, counts as leaving
  expect(await events(page)).toEqual([["enter", "w"], ["leave", "w"]]);
});
