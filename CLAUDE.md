# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

domflux is an ultra-lightweight, dependency-free frontend library for controlling component lifecycles in the DOM. It is plain browser JavaScript (ES modules), with no build step, bundler config or linter. The library has no runtime dependencies; `happy-dom` and `@playwright/test` are dev-only.

It is published as an ESM-only npm package (`"type": "module"`, MIT). It must work without a bundler, in both Node and native browser ESM. That means relative imports always need the `.js` extension, and no module may touch the DOM at import time: `package.json` declares `"sideEffects": false`, and the package must import cleanly in Node with no DOM. `test/unit/package.test.js` enforces all of this, including the exact list of published files.

## Commands

```sh
npm test                # unit + browser (excludes @perf)
npm run test:unit       # node --test test/unit/
npm run test:browser    # Playwright: chromium, firefox
npm run test:perf       # @perf-tagged budgets, serial, prints measurements
node --test test/unit/viewport.test.js                 # one unit file
npx playwright test viewport --project chromium         # one browser file / engine
npx playwright test -g "onEnter fires once"             # one test by title
```

The package is only tested against Chromium and Firefox. WebKit/Safari is deliberately not part of the test matrix; don't add it back without being asked.

## Tests

- **Unit tests** (`test/unit/`, node:test plus happy-dom) cover logic.
  - `setup.js` must be the first import, because `flux.js` picks its `HTMLElement` base when it is first evaluated.
  - `IntersectionObserver` is a hand-driven fake (`report([el, ratio], ...)`), and `fetch` is stubbed per test.
  - Each file runs in its own process, so viewport tests share one module-level observer and run in order.
- **Browser tests** (`test/browser/`) cover what happy-dom can't: real layout and scrolling, `moveBefore`, the top layer, real `fetch` rules, and timing.
  - `fixture.js` starts two real loopback servers per worker. The page origin serves the library and per-test pages; the "other" origin records every request it receives.
  - Pages must be served by the real server, not `page.route`: Chromium treats intercepted documents as public and then blocks requests to loopback. CORS preflights and redirects also bypass `page.route`. Cross-origin assertions therefore need the recording server.
- **Perf tests** (`perf.spec.js`, tagged `@perf`) compare against bare custom elements and assert loose budgets, so they catch complexity regressions rather than noise.

## Architecture

`index.js` re-exports `Component`, `register` and `configureViewport` from `flux.js`, and `httpKit` from `httpkit.js`. The `exports` map in `package.json` also exposes the `domflux/flux` and `domflux/httpkit` subpaths. Any new public module needs entries in both `exports` and `files`.

### flux.js: components are native Custom Elements

There is deliberately no `MutationObserver`, selector registry, or DOM scanning. The browser handles detection.

- `Component` extends `HTMLElement`. It falls back to an empty class when there is no DOM, so the module stays importable in Node.
  - `connectedCallback` calls `hydrate()`; `disconnectedCallback` aborts the signal and calls `destroy()`.
- `this.signal` is the main cleanup mechanism. Components pass it to `addEventListener` and `fetch` rather than undoing those in `destroy()`.
  - The `AbortController` is created lazily, on the first read of `this.signal` during a connection. This is a measured optimization: an eager controller made removal about 6x slower than bare custom elements in Chromium. Don't make it eager.
  - Each connection gets a new signal. While disconnected, including before the first connect, `signal` returns a shared already-aborted signal. Async `hydrate()` code can therefore always check `signal.aborted` after an `await`.
- The empty `connectedMoveCallback` is intentional. It makes `Element.moveBefore()` keep a component alive instead of destroying and re-hydrating it.
- A plain DOM move (`appendChild`, `insertBefore`) still destroys and re-hydrates, so components should not be moved into "portal" containers. Use the top layer instead (`dialog.showModal()`, `popover`).
- `register(tag, Klass)` wraps `customElements.define`. Tags need a hyphen, elements already on the page are upgraded, and registering the same class twice is a no-op.
- **Viewport observation is deliberately sitewide and uniform.** There is exactly one `IntersectionObserver` per page, created lazily, with the viewport as root. There are no per-component options, child-element targets or custom scroll roots; this is a design decision, not a gap to fill.
  - A component opts in by defining `onEnter(entry)` and/or `onLeave(entry)`. The component element itself is observed, so it needs a box (`display: block`).
  - `onEnter` fires once per connection, the first time the element is in view, from any direction. Requiring entry from the bottom was rejected because content above a restored scroll position or an `#anchor` would never fire.
  - `onLeave` fires on every transition from visible to not visible, never for an element that was never visible.
  - Enter-only components are unobserved after entering. Disconnecting always unobserves, and reconnecting starts a new lifecycle.
  - The observer callback dispatches through a module-private symbol method on the target, so there is no callback registry.
  - `configureViewport({ rootMargin, threshold })` sets the one box both hooks are measured against. It throws once the observer exists, so it must be called before `register()`. The default `rootMargin` of `0px 0px 150px 0px` preloads `onEnter`, and as a consequence makes `onLeave` fire late at the bottom edge.

### httpkit.js: fetch wrapper and HTML insertion

- `request(url, options)` has fetch's signature but never rejects for a failed request, so `res.ok` is the one check: any HTTP status resolves with its `Response`, and a network error or abort resolves to `Response.error()`. Only a throwing header provider or failure handler rejects, because those are bugs. The verb shorthands (`get`, `delete`, `post`, `put`, `patch`; `post`/`put`/`patch` take `body` second) are one-liners over it, and nothing uses `this`.
- `setHeaders(fn)` sets the function called before every request with `(url, options)`; its plain-object result is a fresh snapshot per request (e.g. a live fingerprint). There is no origin logic: the headers go to every origin.
- `setFailureHandler(fn)` sets the one function called on a failure: a non-2xx response (`{ url, options, response }`) or a network error (`{ url, options, error }`). The default logs. It only reacts and never changes what `request` returns, so a call's contract doesn't depend on global setup, which is the reason there is no status-range handler or `null` return. Aborts and `redirect: 'manual'` responses are not failures.
- The header provider runs outside `request`'s `try`, so a bug in it can't be reported as a network error. `fetch`'s own `TypeError` for an invalid URL or header can't be told apart from a network error, so that does reach the handler.
- `request` defaults to `redirect: 'error'` so the headers can't follow a redirect to another site; per-call `redirect` overrides it. The browser test for this has a control that proves a leak is detectable. Keep it, or the redirect test can pass for the wrong reason.
- Headers are plain objects merged with spread: dynamic, then per-call `options.headers`. `Headers` instances and arrays aren't supported.
- `load(target, url, { at, render, signal })` is always a GET, on top of `request`. It inserts as-is, from any origin: inline handlers run, `<script>` tags in strings don't.
  - The parser is picked by exact MIME: `text/html` → text, `application/json` → parsed. `render(body, response)` returns an HTML string, a Node or an array of those, so JSON needs it.
  - It resolves to the `Response`, or `null` when nothing was inserted: a failed request (already reported by `request`) or an abort, including one during the body read.
  - Other content types, an unreadable body, invalid JSON and a bad or throwing render reject without inserting.
  - Everything is normalised to one node (`toNode`: strings through a `<template>`) before one insert table. `at` is `inner | outer | before | prepend | append | after`, mapped to `replaceChildren`, `replaceWith`, `before`, `prepend`, `append` and `after`, or a function `(target, node)`. `outer`, `before` and `after` silently do nothing on a detached element, so they go through the `attached` check. A `<template>` parses without the target's context, so an SVG target needs `render` to return nodes.
  - Concurrent loads are deliberately not coordinated; callers abort the previous one via `signal`.

### How the two modules interact

Inserting HTML with `httpKit` triggers the Custom Element lifecycle on its own, so components in fetched markup hydrate without either module importing the other.
