// Runs without the DOM setup: checks the package as Node and bundlers see it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

function importInFreshNode(specifier) {
  const script = `import(${JSON.stringify(specifier)}).then((m) => console.log(JSON.stringify(Object.keys(m).sort())))`;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" }));
}

test("main entry imports in Node without a DOM", () => {
  assert.deepEqual(importInFreshNode("domflux"), ["Component", "configureViewport", "httpKit", "register"]);
});

test("subpath exports resolve", () => {
  assert.deepEqual(importInFreshNode("domflux/flux"), ["Component", "configureViewport", "register"]);
  assert.deepEqual(importInFreshNode("domflux/httpkit"), ["httpKit"]);
});

test("internal files are not importable through the package", () => {
  assert.throws(() => importInFreshNode("domflux/package.json"), /ERR_PACKAGE_PATH_NOT_EXPORTED/);
});

test("published files are only the library, license and readme", () => {
  const [{ files }] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" }));
  assert.deepEqual(files.map((f) => f.path).sort(), ["LICENSE", "README.md", "flux.js", "httpkit.js", "index.js", "package.json"]);
});
