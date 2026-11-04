# domflux

Ultra lightweight frontend framework to control component flux in the DOM model.

domflux gives server-rendered pages a component lifecycle with almost no code of its own. The browser does the work: components are native [Custom Elements](https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_custom_elements), so there is no virtual DOM, no DOM scanning and no build step.

- **Lifecycle:** `hydrate()` when an element enters the document, `destroy()` when it leaves. This works for parsed HTML, `innerHTML`, clones, late registration and shadow DOM.
- **Automatic cleanup:** `this.signal` removes listeners and cancels requests when the component is removed.
- **Viewport hooks:** `onEnter()` once when a component first scrolls into view, `onLeave()` every time it scrolls out. One shared observer serves the whole site.
- **httpKit:** a small `fetch` wrapper that adds your dynamic headers to every request and reports every failure in one place, plus a helper that loads HTML (or JSON rendered to HTML or nodes) into the page. Components in loaded content hydrate automatically.
- **No dependencies, ESM only.** About 3 KB minified, 1.5 KB minified and gzipped.

## Install

```sh
npm install domflux
```

```js
import { Component, register, configureViewport, httpKit } from "domflux";
```

Subpath imports are available if you only need one part: `domflux/flux` and `domflux/httpkit`.

## Components

```html
<image-gallery>
  <button class="next">Next</button>
  <img src="1.jpg" alt="">
</image-gallery>
```

```js
import { Component, register } from "domflux";

class ImageGallery extends Component {
  hydrate() {
    // `this` is the element itself.
    this.querySelector(".next").addEventListener("click", () => this.next(), { signal: this.signal });
    window.addEventListener("resize", () => this.layout(), { signal: this.signal });
  }

  destroy() {
    // Only needed for cleanup a signal can't do, e.g. a third-party instance.
  }

  next() { /* ... */ }
  layout() { /* ... */ }
}

register("image-gallery", ImageGallery);
```

- **Tag names must contain a hyphen.** `register()` also hydrates matching elements already on the page, so it can be called at any time. Registering the same class twice does nothing.
- **Load your script as a module** (`<script type="module">`) or with `defer`. Modules run after the page is parsed, so `hydrate()` always sees the element's children.
- **Use `this.signal` for cleanup.** It is aborted when the element is removed, which removes every listener and cancels every `fetch` that was given it. Each time the element is added to the page it gets a fresh signal.
- **Async `hydrate()`:** if it awaits something, check `this.signal.aborted` afterwards; the component may have been removed in the meantime.

### Moving components

Moving an element with `appendChild` or `insertBefore` removes it and adds it again, so it is destroyed and re-hydrated. To move a component without losing its state, use [`moveBefore()`](https://developer.mozilla.org/en-US/docs/Web/API/Element/moveBefore) where the browser supports it:

```js
newParent.moveBefore(component, null); // no destroy / hydrate
```

### Dialogs and popovers

Don't move dialogs into a "portal" container. `dialog.showModal()` and the [Popover API](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API) render in the browser's *top layer*, above everything, regardless of `z-index`, `overflow: hidden` or `transform` on ancestors. The dialog can stay inside its component:

```html
<confirm-delete>
  <button>Delete</button>
  <dialog>
    <form method="dialog">
      <p>Are you sure?</p>
      <button value="no">No</button>
      <button value="yes">Yes</button>
    </form>
  </dialog>
</confirm-delete>
```

```js
class ConfirmDelete extends Component {
  hydrate() {
    const dialog = this.querySelector("dialog");
    this.querySelector("button").addEventListener("click", () => dialog.showModal(), { signal: this.signal });
    dialog.addEventListener("close", () => {
      if (dialog.returnValue === "yes") this.delete();
    }, { signal: this.signal });
  }
}
```

## Viewport hooks

A component opts in to viewport observation by defining one or both hooks:

| Hook | When it fires |
|---|---|
| `onEnter(entry)` | **Once**, the first time the component is in view, from any direction. Always after `hydrate()`. |
| `onLeave(entry)` | **Every time** the component leaves view, from any direction, if it was in view before. |

```js
class LazyChart extends Component {
  async onEnter() {
    const res = await fetch(this.dataset.src, { signal: this.signal });
    this.render(await res.json());
  }
}

class AutoPauseVideo extends Component {
  onLeave() {
    this.querySelector("video").pause();
  }
}

register("lazy-chart", LazyChart);
register("auto-pause-video", AutoPauseVideo);
```

```css
/* Observed components need a box: custom elements are inline by default. */
lazy-chart, auto-pause-video { display: block; }
```

`entry` is the browser's [`IntersectionObserverEntry`](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserverEntry).

Things to know:

- **The component element itself is observed**, so it must have a box. Use `display: block` or similar, never `display: contents`.
- **Scrolling back to an element doesn't fire `onEnter` again.** Only removing the element and adding it back does. A video paused in `onLeave` therefore stays paused until the user plays it.
- **Enter-only components stop being observed after entering**, so they cost nothing afterwards.
- **No hooks after removal:** removing a component stops observation before `destroy()` runs.

### Configuring the viewport

All observed components share one viewport box. The default is the visible viewport extended **150px downward**, so `onEnter` fires shortly before content scrolls into view, for preloading. Change it once, before registering components:

```js
import { configureViewport, register } from "domflux";

configureViewport({
  rootMargin: "0px 0px 300px 0px", // preload further ahead
  threshold: 0,                    // share of the element that must be visible
});

register("lazy-chart", LazyChart);
```

- **One box for both hooks.** A bottom margin makes `onEnter` fire early, and it also makes `onLeave` fire late when an element leaves through the bottom.
- **`configureViewport()` throws once any component is being observed.** That's because the box is shared sitewide.
- **Keep `threshold` low.** An element taller than the viewport can never be, say, 50% visible, so with a high threshold its `onEnter` never fires.

## httpKit

```js
import { httpKit } from "domflux";

// Optional: called before every request; returns a plain object of headers.
httpKit.setHeaders(async () => ({
  "x-fingerprint": await fingerprint(),
}));

// Optional: called on every failed request. The default logs it.
httpKit.setFailureHandler(({ response, error }) => {
  showError(error ? "Could not reach the server." : `Failed: ${response.status}`);
});

const res = await httpKit.get("/api/items");
if (res.ok) items = await res.json();

await httpKit.post("/api/items", JSON.stringify(item), {
  headers: { "content-type": "application/json" },
});
```

- **Same signature as `fetch`:** `request(url, options)`, `get(url, options)`, `delete(url, options)`, `post(url, body, options)`, `put(url, body, options)` and `patch(url, body, options)`.
- **`res.ok` covers every failure.** Unlike `fetch`, a failed request never rejects, so there is one check and no `try/catch`:

  | Outcome | Resolves to | Failure handler |
  |---|---|---|
  | 2xx | The `Response` | Not called |
  | Non-2xx | The `Response`, body unread | Called with `{ url, options, response }` |
  | Network error, refused redirect | `Response.error()`: `ok: false`, `status: 0`, `type: "error"` | Called with `{ url, options, error }` |
  | Abort | `Response.error()` | Not called |
  | `redirect: "manual"` | An `opaqueredirect` response (`ok: false`, check `res.type`) | Not called |

- **The failure handler only reacts.** It can't change what the caller gets, so a call behaves the same whether a handler is set or not. To read the body in it, use `response.clone()`, or the caller can't read it afterwards.
- **Bugs still reject:** a header function or failure handler that throws rejects the call. A header function that throws sends nothing. `fetch` itself also fails on an invalid URL or header value, and browsers report that like a network error, so it reaches the failure handler.
- **Dynamic headers:** the `setHeaders` function receives `(url, options)` and runs fresh for every request, so each request sends a snapshot. Per-call `headers` override it.
- **Plain objects only:** headers are merged with object spread, so pass `options.headers` as an object (not `Headers` or an array) and keep names in one casing, e.g. lowercase.
- **Redirects are refused by default** (`redirect: "error"`), so your headers never follow a redirect to another site. Pass `redirect: "follow"` on calls that need redirects.
- **Every origin gets the headers.** If some must stay on your own origin, check `url` in the function. Custom headers on cross-origin requests trigger a CORS preflight, so the other server must allow them.

### Loading content into the page

```js
await httpKit.load(document.querySelector("#cart"), "/partials/cart");

await httpKit.load(list, "/api/rows?page=2", {
  at: "append",
  render: (rows) => rows.map(rowHTML).join(""),
});

await httpKit.load(list, "/api/rows?page=2", {
  render: (rows) => rows.map(rowElement),
  at: (list, nodes) => animateIn(list, nodes),
});
```

`load(target, url, options)` GETs `url` and inserts the result relative to `target`.

| Option | Default | |
|---|---|---|
| `at` | `"inner"` | `inner` replaces the target's contents, `outer` replaces the target, `before`/`after` insert next to it, `prepend`/`append` inside it. A function `(target, node) => {}` places the node itself |
| `render` | | `(body, response) => content`, where content is an HTML string, a Node (a fragment too) or an array of those. `body` is the text for `text/html`, the parsed value for `application/json`. Required for JSON |
| `signal` | | An `AbortSignal` to cancel the load |

- **Components in the loaded content hydrate automatically.**
- **Resolves with the `Response`,** or `null` if nothing was inserted: the request failed (which reached the failure handler) or `signal` cancelled it.
- **Bugs reject, with nothing inserted:** another content type, an unreadable body, invalid JSON, a throwing `render`, or one that returns nothing insertable. So does inserting next to a target that has no parent.
- **Strings are parsed as HTML, not in the target's context,** so SVG content needs `render` to return nodes.
- **Concurrent loads are yours to coordinate.** Nothing cancels an earlier load into the same target, so a slow response can overwrite a newer one. Abort the previous load:

  ```js
  let controller;
  input.addEventListener("input", () => {
    controller?.abort();
    controller = new AbortController();
    httpKit.load(results, `/search?q=${encodeURIComponent(input.value)}`, { signal: controller.signal });
  });
  ```

  Inside a component, pass `this.signal` to tie the load to the component's lifetime.
- **Security:** content is inserted as-is, from any origin. `<script>` tags in strings don't run, but inline event handlers such as `onerror="..."` do. Only load from endpoints that return trusted markup, and escape data in `render`.

## Browser support

domflux is tested against **Chromium and Firefox only**. Safari is not tested.

The oldest supported versions are Chrome 116 and Firefox 124. Moving components with `moveBefore()` is used where the browser supports it.

The package can be imported in Node, for example during server rendering or in tests, without a DOM. Components only work in a browser.

## Performance

Measured in the test suite (`npm run test:perf`), headless Chromium on a Linux desktop:

| | 10,000 components |
|---|---|
| Hydrate (insert) | ~25 ms, the same as bare custom elements |
| Destroy (remove) | ~8 ms, the same as bare custom elements |
| Hydrate + destroy, each using `this.signal` for a listener | ~45 ms + ~50 ms |

- **Signals are created lazily**, only when a component reads `this.signal`. Components that don't use it pay nothing.
- **One observer serves the whole page**, and enter-only components stop being observed once they've entered. Scrolling back through 2,000 lazy components that have already entered delivers no events.

## Development

```sh
npm install
npx playwright install chromium firefox   # browsers for the browser tests

npm test               # unit + browser tests
npm run test:unit      # Node + happy-dom: lifecycle, viewport logic, httpKit, packaging
npm run test:browser   # Playwright: Chromium, Firefox
npm run test:perf      # performance budgets, with measurements in the output
```

- **Single test file:** `node --test test/unit/httpkit.test.js`, or `npx playwright test viewport --project chromium`.
- **Unit tests** fake `IntersectionObserver` and `fetch`.
- **Browser tests** run against two real local servers, so cross-origin rules, redirects and CORS preflights behave exactly as in production.

## License

[MIT](LICENSE)
