// Installs a happy-dom window as globals. Import this before domflux: flux.js
// picks its HTMLElement base class when it is first evaluated.
import { Window } from "happy-dom";

export const window = new Window({ url: "https://app.test/page" });

for (const key of ["HTMLElement", "customElements", "document", "location", "Node"]) {
  globalThis[key] = window[key];
}

// Node has no reportError; record instead so tests can assert on it.
export const reportedErrors = [];
globalThis.reportError = (error) => reportedErrors.push(error);

// happy-dom has no layout, so IntersectionObserver is driven by hand.
export const observers = [];

export class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    observers.push(this);
  }

  observe(target) {
    this.targets.add(target);
  }

  unobserve(target) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  // Delivers one entry per [target, ratio] pair in a single callback, like the browser.
  report(...pairs) {
    this.callback(pairs.map(([target, ratio]) => ({ target, intersectionRatio: ratio, isIntersecting: ratio > 0 })));
  }
}

globalThis.IntersectionObserver = FakeIntersectionObserver;
