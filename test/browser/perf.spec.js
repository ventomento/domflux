import { test, expect, open, settle } from "./fixture.js";

// Performance checks. Timing budgets are deliberately loose (several times the
// measured cost) so they catch regressions in complexity, not machine noise.
// Measured numbers are attached to each test's report as annotations.

const N = 10_000;

function report(name, value) {
  test.info().annotations.push({ type: "perf", description: `${name}: ${value}` });
  console.log(`[${test.info().project.name}] ${name}: ${value}`);
}

const LIFECYCLE_BENCH = `
register("x-flux", class extends Component {});
register("x-signal", class extends Component {
  hydrate() { this.addEventListener("click", () => {}, { signal: this.signal }); }
});
customElements.define("x-bare", class extends HTMLElement {
  connectedCallback() {}
  disconnectedCallback() {}
});

window.bench = (tag, n, runs = 7) => {
  const markup = \`<\${tag}></\${tag}>\`.repeat(n);
  const box = document.createElement("div");
  document.body.append(box);
  const add = [];
  const remove = [];
  for (let i = 0; i < runs; i++) {
    let t = performance.now();
    box.innerHTML = markup;
    add.push(performance.now() - t);
    t = performance.now();
    box.innerHTML = "";
    remove.push(performance.now() - t);
  }
  box.remove();
  const median = (xs) => xs.sort((a, b) => a - b)[xs.length >> 1];
  return { add: median(add), remove: median(remove) };
};
`;

test("@perf hydrating and destroying components costs the same as bare custom elements", async ({ page }) => {
  await open(page, { module: LIFECYCLE_BENCH });
  const { bare, flux, signal } = await page.evaluate((n) => {
    bench("x-flux", n, 2); // warm up
    bench("x-bare", n, 2);
    bench("x-signal", n, 2);
    return { bare: bench("x-bare", n), flux: bench("x-flux", n), signal: bench("x-signal", n) };
  }, N);

  const perComponent = (ms) => `${((ms * 1000) / N).toFixed(2)}µs`;
  report(`bare add ${N}`, `${bare.add.toFixed(1)}ms (${perComponent(bare.add)}/el)`);
  report(`flux add ${N}`, `${flux.add.toFixed(1)}ms (${perComponent(flux.add)}/el)`);
  report(`bare remove ${N}`, `${bare.remove.toFixed(1)}ms (${perComponent(bare.remove)}/el)`);
  report(`flux remove ${N}`, `${flux.remove.toFixed(1)}ms (${perComponent(flux.remove)}/el)`);
  report(`flux + signal listener add ${N}`, `${signal.add.toFixed(1)}ms (${perComponent(signal.add)}/el)`);
  report(`flux + signal listener remove ${N}`, `${signal.remove.toFixed(1)}ms (${perComponent(signal.remove)}/el)`);

  // Components that don't use the signal cost the same as bare custom elements.
  expect(flux.add + flux.remove).toBeLessThan((bare.add + bare.remove) * 2 + 10);
  // Absolute budget for 10k components that do use it (listener + abort each).
  expect(signal.add).toBeLessThan(250);
  expect(signal.remove).toBeLessThan(250);
});

test("@perf cost scales linearly with component count", async ({ page }) => {
  await open(page, { module: LIFECYCLE_BENCH });
  const [small, large] = await page.evaluate(() => {
    bench("x-flux", 2_000, 2);
    return [bench("x-flux", 2_000), bench("x-flux", 20_000)];
  });
  const ratio = (large.add + large.remove) / (small.add + small.remove);
  report("20k / 2k time ratio (10x components)", ratio.toFixed(2));
  expect(ratio).toBeLessThan(20); // linear would be ~10; quadratic ~100
});

test("@perf one observer serves every component, and enter-only components cost nothing after entering", async ({ page }) => {
  const COUNT = 2_000;
  await page.addInitScript(() => {
    window.io = { created: 0, entries: 0 };
    const Native = window.IntersectionObserver;
    window.IntersectionObserver = class extends Native {
      constructor(callback, options) {
        super((entries, observer) => {
          window.io.entries += entries.length;
          callback(entries, observer);
        }, options);
        window.io.created++;
      }
    };
  });
  await open(page, {
    style: `x-lazy, x-watch { display: block; height: 50px; }`,
    module: `
      window.counts = { enter: 0, leave: 0 };
      register("x-lazy", class extends Component { onEnter() { counts.enter++; } });
      register("x-watch", class extends Component { onLeave() { counts.leave++; } });
    `,
  });

  const connectMs = await page.evaluate((n) => {
    const t = performance.now();
    document.body.insertAdjacentHTML("beforeend", "<x-lazy></x-lazy>".repeat(n) + "<x-watch></x-watch>".repeat(10));
    return performance.now() - t;
  }, COUNT);
  report(`connect ${COUNT} observed components`, `${connectMs.toFixed(1)}ms`);
  expect(connectMs).toBeLessThan(250);

  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= pageHeight; y += 600) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await settle(page);
  }
  const afterDown = await page.evaluate(() => ({ ...window.io, ...window.counts }));
  report("observers created", afterDown.created);
  report(`entries delivered scrolling down ${COUNT} components`, afterDown.entries);

  expect(afterDown.created).toBe(1);
  expect(afterDown.enter).toBe(COUNT);

  // Scroll back up through everything: enter-only components were unobserved,
  // so only the 10 leave-watchers can still produce entries.
  for (let y = pageHeight; y >= 0; y -= 600) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await settle(page);
  }
  const afterUp = await page.evaluate(() => ({ ...window.io, ...window.counts }));
  const extra = afterUp.entries - afterDown.entries;
  report("entries delivered scrolling back up", extra);
  expect(afterUp.enter).toBe(COUNT);
  expect(extra).toBeLessThanOrEqual(10);
  expect(afterUp.leave).toBe(10);
});
