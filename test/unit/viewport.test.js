import { observers, reportedErrors } from "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Component, register, configureViewport } from "../../index.js";

// Module state is per process and node:test runs each file in its own
// process, so these tests run in order against one sitewide observer.

const events = [];
let tagCount = 0;

// Hooks are added to the prototype only when requested: their presence is the opt-in.
function defineWith({ enter = false, leave = false } = {}) {
  const tag = `vp-el-${++tagCount}`;
  class Test extends Component {
    hydrate() {
      events.push(["hydrate", this.id]);
    }
    destroy() {
      events.push(["destroy", this.id]);
    }
  }
  if (enter) Test.prototype.onEnter = function (entry) {
    events.push(["enter", this.id, entry.intersectionRatio]);
  };
  if (leave) Test.prototype.onLeave = function (entry) {
    events.push(["leave", this.id, entry.intersectionRatio]);
  };
  register(tag, Test);
  return tag;
}

function mount(tag, id) {
  const el = document.createElement(tag);
  el.id = id;
  document.body.append(el);
  return el;
}

const viewport = () => observers[0];
const take = () => events.splice(0);

test("configureViewport merges options and the observer is created lazily", () => {
  configureViewport({ rootMargin: "0px 0px 300px 0px" });
  configureViewport({ threshold: 0.25 });
  assert.equal(observers.length, 0);

  mount(defineWith({ enter: true }), "lazy");
  assert.equal(observers.length, 1);
  assert.deepEqual(viewport().options, { rootMargin: "0px 0px 300px 0px", threshold: 0.25 });
  take();
});

test("configureViewport throws once components are observed", () => {
  assert.throws(() => configureViewport({ threshold: 0 }), /before any component is observed/);
});

test("all observed components share one observer", () => {
  mount(defineWith({ enter: true }), "a");
  mount(defineWith({ leave: true }), "b");
  mount(defineWith({ enter: true, leave: true }), "c");
  assert.equal(observers.length, 1);
  assert.equal(viewport().targets.size, 4);
  take();
});

test("the initial off-screen report fires nothing", () => {
  const el = mount(defineWith({ enter: true, leave: true }), "init");
  take();
  viewport().report([el, 0]);
  assert.deepEqual(take(), []);
});

test("onEnter fires once, after hydrate, and enter-only components are then unobserved", () => {
  const el = mount(defineWith({ enter: true }), "once");
  assert.deepEqual(take(), [["hydrate", "once"]]);
  viewport().report([el, 0.5]);
  assert.deepEqual(take(), [["enter", "once", 0.5]]);
  assert.equal(viewport().targets.has(el), false);
});

test("onLeave fires on every exit; re-entry is silent", () => {
  const el = mount(defineWith({ enter: true, leave: true }), "both");
  take();
  const vp = viewport();
  vp.report([el, 0.5]);
  vp.report([el, 0]);
  vp.report([el, 0.8]);
  vp.report([el, 1]);
  vp.report([el, 0]);
  assert.deepEqual(take(), [["enter", "both", 0.5], ["leave", "both", 0], ["leave", "both", 0]]);
  assert.equal(vp.targets.has(el), true, "still observed for onLeave");
});

test("leave-only components fire only after having been visible", () => {
  const el = mount(defineWith({ leave: true }), "leave");
  take();
  viewport().report([el, 0]);
  viewport().report([el, 0.6]);
  viewport().report([el, 0]);
  assert.deepEqual(take(), [["leave", "leave", 0]]);
});

test("ratios below the configured threshold count as not visible", () => {
  const el = mount(defineWith({ enter: true, leave: true }), "thr");
  take();
  viewport().report([el, 0.1]);
  assert.deepEqual(take(), [], "0.1 < threshold 0.25 is not an enter");
  viewport().report([el, 0.3]);
  viewport().report([el, 0.1]);
  assert.deepEqual(take(), [["enter", "thr", 0.3], ["leave", "thr", 0.1]]);
});

test("removal unobserves before destroy; reconnecting starts a new lifecycle", () => {
  const el = mount(defineWith({ enter: true, leave: true }), "re");
  viewport().report([el, 1]);
  take();

  el.remove();
  assert.equal(viewport().targets.has(el), false);
  assert.deepEqual(take(), [["destroy", "re"]], "no onLeave on removal");

  document.body.append(el);
  assert.equal(viewport().targets.has(el), true);
  viewport().report([el, 1]);
  assert.deepEqual(take(), [["hydrate", "re"], ["enter", "re", 1]], "onEnter fires again after reconnect");
});

test("a throwing hook is reported and does not block other components in the batch", () => {
  const boomTag = `vp-boom-${++tagCount}`;
  register(boomTag, class extends Component {
    onEnter() {
      throw new Error("boom");
    }
  });
  const boom = mount(boomTag, "boom");
  const ok = mount(defineWith({ enter: true }), "ok");
  take();

  viewport().report([boom, 1], [ok, 1]);
  assert.deepEqual(reportedErrors.map((e) => e.message), ["boom"]);
  assert.deepEqual(take(), [["enter", "ok", 1]]);
});
