import { observers } from "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Component, register } from "../../index.js";

let tagCount = 0;
const uniqueTag = () => `test-el-${++tagCount}`;

function define(hooks = {}) {
  const log = [];
  class Test extends Component {
    hydrate() {
      log.push("hydrate");
      hooks.hydrate?.call(this);
    }
    destroy() {
      log.push("destroy");
    }
  }
  const tag = uniqueTag();
  register(tag, Test);
  return { tag, log, Test };
}

test("register upgrades and hydrates elements already in the document", () => {
  const tag = uniqueTag();
  document.body.innerHTML = `<${tag}></${tag}><${tag}></${tag}>`;
  const log = [];
  register(tag, class extends Component {
    hydrate() {
      log.push(this.localName);
    }
  });
  assert.deepEqual(log, [tag, tag]);
});

test("registering the same class twice is a no-op; a different class throws", () => {
  const { tag, Test } = define();
  register(tag, Test);
  assert.throws(() => register(tag, class extends Component {}));
});

test("hydrate on connect, destroy on removal", () => {
  const { tag, log } = define();
  const el = document.createElement(tag);
  assert.deepEqual(log, [], "not hydrated while detached");
  document.body.append(el);
  assert.deepEqual(log, ["hydrate"]);
  el.remove();
  assert.deepEqual(log, ["hydrate", "destroy"]);
});

test("clones get their own instance and lifecycle", () => {
  const { tag, log } = define();
  const el = document.createElement(tag);
  document.body.append(el);
  const clone = el.cloneNode(true);
  document.body.append(clone);
  assert.deepEqual(log, ["hydrate", "hydrate"]);
  clone.remove();
  assert.deepEqual(log, ["hydrate", "hydrate", "destroy"]);
  assert.ok(el.isConnected);
});

test("signal removes listeners on removal and is fresh on reconnect", () => {
  let clicks = 0;
  const { tag } = define({
    hydrate() {
      this.addEventListener("click", () => clicks++, { signal: this.signal });
    },
  });
  const el = document.createElement(tag);
  assert.equal(el.signal.aborted, true, "aborted before first connect");

  document.body.append(el);
  const first = el.signal;
  assert.equal(el.signal, first, "same signal for the whole connection");
  el.click();
  assert.equal(clicks, 1);

  el.remove();
  assert.equal(first.aborted, true);
  assert.equal(el.signal.aborted, true, "aborted while disconnected");
  el.click();
  assert.equal(clicks, 1, "listener removed by signal");

  document.body.append(el);
  assert.notEqual(el.signal, first);
  assert.equal(el.signal.aborted, false);
  el.click();
  assert.equal(clicks, 2, "listener re-added by second hydrate");
});

test("signal is already aborted when destroy runs", () => {
  let abortedInDestroy;
  const tag = uniqueTag();
  register(tag, class extends Component {
    destroy() {
      abortedInDestroy = this.signal.aborted;
    }
  });
  const el = document.createElement(tag);
  document.body.append(el);
  el.remove();
  assert.equal(abortedInDestroy, true);
});

test("async hydrate can detect removal through the signal", async () => {
  let resume;
  let abortedAfterAwait;
  const tag = uniqueTag();
  register(tag, class extends Component {
    async hydrate() {
      const { signal } = this;
      await new Promise((resolve) => (resume = resolve));
      abortedAfterAwait = signal.aborted;
    }
  });
  const el = document.createElement(tag);
  document.body.append(el);
  el.remove();
  resume();
  await Promise.resolve();
  assert.equal(abortedAfterAwait, true);
});

test("the signal is only created when a component uses it", () => {
  const Native = globalThis.AbortController;
  let created = 0;
  globalThis.AbortController = class extends Native {
    constructor() {
      super();
      created++;
    }
  };
  try {
    const { tag: unused } = define();
    const a = document.createElement(unused);
    document.body.append(a);
    a.remove();
    assert.equal(created, 0, "never accessed, never created");

    const { tag: used } = define({
      hydrate() {
        this.signal;
        this.signal;
      },
    });
    const b = document.createElement(used);
    document.body.append(b);
    assert.equal(created, 1, "one per connection, however often accessed");
  } finally {
    globalThis.AbortController = Native;
  }
});

test("components without viewport hooks never create an observer", () => {
  const { tag } = define();
  document.body.append(document.createElement(tag));
  assert.equal(observers.length, 0);
});
