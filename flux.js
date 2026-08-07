/**
 * Flux – Lightweight DOM mutation & visibility-driven component hydration
 *
 * Automatically detects elements matching registered selectors, instantiates
 * associated Component classes, calls hydrate() when elements are added to
 * the DOM, and cleans up via destroy() when removed.
 *
 * Features:
 * - MutationObserver-based DOM watching
 * - One-time & recurring visibility observation (IntersectionObserver)
 * - Automatic cleanup on element removal
 * - Progressive enhancement friendly
 *
 * @version 1.0.0
 * @author vento-mento
 */


export class Component {
  constructor(el) {
    this.el = el;
  }

  hydrate() {}
  destroy() {}
}

export const flux = {
  registry: new Map(),
  mutationObserver: null,
  intersectionObserver: null,
  unIntersectionObserver: null,

  register(selector, Klass) {
    this.registry.set(selector, Klass);
  },

  activate(el) {
    if (el.dataset.hydrated !== undefined) return;
    try {
      for (let [selector, Klass] of this.registry.entries()) {
        if (el.matches(selector)) {
          const instance = new Klass(el);
          instance.hydrate();
          el.__componentInstance = instance;
          el.dataset.hydrated = "";
        }
      }
    } catch (error) {
      console.error(error);
    }
  },

  deactivate(el) {
    if (el.__componentInstance) {
      el.__componentInstance.destroy();
      delete el.__componentInstance;
    }

    delete el.dataset.hydrated;
  },

  scan(root = document) {
    for (let [selector] of this.registry.entries()) {
      root.querySelectorAll(selector).forEach((el) => this.activate(el));
    }
  },

  observeVisibility(el, callback) {
    if (!this.intersectionObserver) {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const cb = entry.target.__onVisible;
            if (cb) {
              cb(entry.target);
              delete entry.target.__onVisible;
              this.intersectionObserver.unobserve(entry.target);
            }
          }
        });
      }, {
        root: null,
        threshold: 0.0,
        rootMargin: "0px 0px 150px 0px" // pre-loads a bit earlier
      });
    }

    el.__onVisible = callback;
    this.intersectionObserver.observe(el);
  },

  observeUnVisibility(element, callback) {
    // Fires **every time** element goes out of view (multiple times possible)
    if (!element) return;

    if (!this.unIntersectionObserver) {
      this.unIntersectionObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) {
              const cb = entry.target.__onUnVisible;
              if (typeof cb === 'function') {
                cb(entry);
              }
            }
          });
        },
        {
          threshold: 0.3
        }
      );
    }

    element.__onUnVisible = callback;
    this.unIntersectionObserver.observe(element);
  },

  start() {
    if (!this.mutationObserver) {
      this.mutationObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
          // Handle added nodes
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              this.activate(node);
              this.scan(node);
            }
          });

          // Handle removed nodes
          mutation.removedNodes.forEach((node) => {
            if (node.nodeType === 1) {
              this.deactivate(node);
              // Also clean up all descendants
              node.querySelectorAll?.("*").forEach((child) => this.deactivate(child));
            }
          });
        });
      });

      this.mutationObserver.observe(document.body, {
        childList: true,
        subtree: true
      });
    }

    // Initial hydration pass
    this.scan(document);
  }
};

/**
* Example usage
* html:

<div class="carousel">...<div>

* js:
* 1. Define a component

class Carousel extends Component {
  hydrate() {
    console.log("Carousel → hydrated", this.el);
    // Initialize slider, attach listeners, lazy-load images, etc.
    
    Flux.observeVisibility(this.el, (el) => {
      console.log("Carousel now visible → load high-res images / start autoplay");
    });
  }

  destroy() {
    // Remove listeners, clear timers, etc.
    console.log("Carousel → destroyed");
  }
}

// 2. Register selector → component class mapping
Flux.register('.carousel', Carousel);

// 3. Start watching the DOM
Flux.start();
 */