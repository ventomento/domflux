/**
 * Flux – Lightweight component lifecycle on top of native Custom Elements
 *
 * The browser detects components, so there is no MutationObserver, registry
 * or DOM scanning: connectedCallback → hydrate(), disconnectedCallback → destroy().
 *
 * Features:
 * - Native lifecycle (works with clones, late registration and shadow DOM)
 * - Per-connection AbortSignal for automatic cleanup of listeners, fetches & timers
 * - Opt-in viewport hooks: onEnter() once, onLeave() every time
 * - One sitewide IntersectionObserver for all components
 * - Survives Element.moveBefore() without re-hydrating
 * - Progressive enhancement friendly
 *
 * @version 1.0.0
 * @author ventomento
 */

// Lets the module be imported where there is no DOM (SSR, Node tooling).
const Base = globalThis.HTMLElement ?? class {};

const abortedSignal = AbortSignal.abort();
const visibilityChanged = Symbol("visibilityChanged");
let viewportOptions = { rootMargin: "0px 0px 150px 0px", threshold: 0 };
let io = null;

/**
 * Configure the sitewide viewport box that onEnter() and onLeave() are
 * measured against. All observed components share it, so it can only be set
 * before the first component is observed (i.e. before register()).
 *
 * - rootMargin grows/shrinks the viewport, e.g. a bottom margin makes
 *   onEnter() fire early (preloading) and onLeave() fire late at the bottom.
 * - threshold is the visible ratio that counts as "in view". Elements taller
 *   than the viewport may never reach a high threshold; keep it low.
 *
 * @param {{ rootMargin?: string, threshold?: number }} options
 */
export function configureViewport(options) {
  if (io) throw new Error("configureViewport() must be called before any component is observed");
  viewportOptions = { ...viewportOptions, ...options };
}

function viewport() {
  return (io ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      try {
        entry.target[visibilityChanged](entry);
      } catch (error) {
        reportError(error);
      }
    }
  }, viewportOptions));
}

/**
 * Base class for components. Optional viewport hooks, defined by subclasses:
 *
 * - onEnter(entry): once per connection, the first time the element is in view
 *   (from any direction). Always runs after hydrate().
 * - onLeave(entry): every time the element leaves view, from any direction,
 *   if it was in view before.
 *
 * Defining either hook opts the element itself into observation; it then
 * needs a box (e.g. `display: block`, never `display: contents`).
 */
export class Component extends Base {
  #connected = false;
  #controller = null;
  #entered = false;
  #visible = false;

  /**
   * Aborted when the element leaves the document; a fresh one is used for
   * every connection. Pass it to addEventListener and fetch so they clean
   * themselves up. Async hydrate() code should check `signal.aborted` after
   * each await. While disconnected it is always aborted.
   *
   * Created on first access, so components that never use it pay nothing.
   * @returns {AbortSignal}
   */
  get signal() {
    if (!this.#connected) return abortedSignal;
    return (this.#controller ??= new AbortController()).signal;
  }

  connectedCallback() {
    this.#connected = true;
    this.#controller = null;
    this.#entered = this.#visible = false;
    this.hydrate();
    if (this.onEnter || this.onLeave) viewport().observe(this);
  }

  disconnectedCallback() {
    this.#connected = false;
    if (this.onEnter || this.onLeave) io?.unobserve(this);
    this.#controller?.abort();
    this.#controller = null;
    this.destroy();
  }

  // Its presence makes Element.moveBefore() keep the component alive instead of
  // running disconnectedCallback + connectedCallback.
  connectedMoveCallback() {}

  hydrate() {}
  destroy() {}

  [visibilityChanged](entry) {
    const visible = entry.isIntersecting && entry.intersectionRatio >= viewportOptions.threshold;
    if (visible === this.#visible) return;
    this.#visible = visible;

    if (visible && !this.#entered) {
      this.#entered = true;
      this.onEnter?.(entry);
      // Nothing left to report for enter-only components.
      if (!this.onLeave) io.unobserve(this);
    } else if (!visible) {
      this.onLeave?.(entry);
    }
  }
}

/**
 * Define a component for a custom element tag (must contain a hyphen).
 * Existing elements with that tag are upgraded and hydrated immediately.
 * Registering the same class twice is a no-op.
 *
 * @param {string} tag
 * @param {typeof Component} Klass
 */
export function register(tag, Klass) {
  if (customElements.get(tag) === Klass) return;
  customElements.define(tag, Klass);
}

/**
* Example usage
* html:

<lazy-chart data-src="/chart.json"></lazy-chart>
<flux-video><video src="clip.mp4" controls playsinline></video></flux-video>

* css (observed components need a box):

lazy-chart, flux-video { display: block; }

* js:
* 1. Optionally configure the sitewide viewport (before register)

configureViewport({ rootMargin: "0px 0px 300px 0px" });

* 2. Define components

class LazyChart extends Component {
  // Once, ~300px before it scrolls into view; then no longer observed.
  async onEnter() {
    const res = await fetch(this.dataset.src, { signal: this.signal });
    // render...
  }
}

class FluxVideo extends Component {
  hydrate() {
    // Removed automatically when the element leaves the document.
    this.querySelector("video").addEventListener("ended", () => console.log("done"), { signal: this.signal });
  }

  // Every time it scrolls out of view.
  onLeave() {
    this.querySelector("video").pause();
  }
}

* 3. Register tag → component class (upgrades elements already on the page)

register("lazy-chart", LazyChart);
register("flux-video", FluxVideo);
 */
