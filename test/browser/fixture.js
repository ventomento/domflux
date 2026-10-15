// Two real loopback servers on different ports, i.e. two origins:
// - the page origin serves the library (tests add responses with page.route)
// - the other origin records every request it receives, so tests can assert
//   on what actually left the browser, including CORS preflights.
// Cross-origin behaviour has to hit real servers: browsers send CORS
// preflights and redirects past Playwright's request interception.
import { test as base, expect } from "@playwright/test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

export { expect };

const root = new URL("../../", import.meta.url);
const libraryFiles = new Set(["/index.js", "/flux.js", "/httpkit.js"]);
const pageServers = new WeakMap(); // page → servers, for open()
let pageCount = 0;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

export const test = base.extend({
  servers: [
    async ({}, use) => {
      const otherRequests = [];
      const pages = new Map(); // path → html registered by open()

      const main = createServer(async (req, res) => {
        const url = new URL(req.url, "http://x");
        if (libraryFiles.has(url.pathname)) {
          res.writeHead(200, { "Content-Type": "text/javascript" });
          return res.end(await readFile(new URL(`.${url.pathname}`, root)));
        }
        if (pages.has(url.pathname)) {
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end(pages.get(url.pathname));
        }
        if (url.pathname === "/redirect") {
          res.writeHead(302, { Location: url.searchParams.get("to") });
          return res.end();
        }
        res.writeHead(404);
        res.end();
      });

      const other = createServer((req, res) => {
        otherRequests.push({ method: req.method, path: req.url, headers: req.headers });
        res.writeHead(200, {
          "Content-Type": "text/html",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        });
        res.end("<p>from other origin</p>");
      });

      const servers = { origin: await listen(main), otherOrigin: await listen(other), otherRequests, pages };
      await use(servers);
      main.close();
      other.close();
    },
    { scope: "worker" },
  ],

  origin: async ({ servers }, use) => use(servers.origin),

  other: async ({ servers }, use) => {
    servers.otherRequests.length = 0;
    await use({ origin: servers.otherOrigin, requests: servers.otherRequests });
  },

  page: async ({ page, servers }, use) => {
    pageServers.set(page, servers);
    await use(page);
  },
});

/**
 * Open a page with the given markup. `module` is code run inside a module
 * script after parsing, with the library's exports in scope. The library is
 * also exposed as `window.domflux` and an event log as `window.events`.
 */
export async function open(page, { body = "", style = "", module = "" } = {}) {
  const servers = pageServers.get(page);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<style>html, body { margin: 0; } ${style}</style>
</head>
<body>
${body}
<script type="module">
import * as domflux from "/index.js";
const { Component, register, configureViewport, httpKit } = domflux;
window.domflux = domflux;
window.events = [];
${module}
window.ready = true;
</script>
</body>
</html>`;
  // Served by the real server: Chromium treats intercepted documents as public
  // and would then block requests to the loopback "other" origin.
  const path = `/page-${++pageCount}`;
  servers.pages.set(path, html);
  await page.goto(`${servers.origin}${path}`);
  await page.waitForFunction(() => window.ready);
}

/** Wait until the browser has had time to deliver IntersectionObserver entries. */
export async function settle(page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))),
  );
}

export const events = (page) => page.evaluate(() => window.events);

export async function scrollTo(page, y) {
  await page.evaluate((top) => window.scrollTo(0, top), y);
  await settle(page);
}
