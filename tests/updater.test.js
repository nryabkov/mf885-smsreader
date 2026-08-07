const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const updater = require("../loader.js");

const A = "a".repeat(40);
const B = "b".repeat(40);
const config = { repositoryOwner: "example", repositoryName: "fork", branch: "docs/next" };
const manifest = {
  loaderProtocol: 2,
  minimumLoaderProtocol: 2,
  loader: "loader.js",
  entry: "scriptable.js",
  files: ["scriptable.js", "modules/ussd.js"]
};
const active = { activeSha: A, pendingSha: null, loaderProtocol: 2, status: "active" };

test("constructs encoded branch HEAD API URL", () => {
  assert.equal(updater.commitApiUrl(config), "https://api.github.com/repos/example/fork/commits/docs%2Fnext");
});

test("pins manifest, loader, and every application URL to one full SHA", () => {
  const urls = updater.artifactUrls(config, B, manifest);
  for (const url of [urls.manifest, urls.loader, ...urls.files]) {
    assert.match(url, new RegExp(`/${B}/`));
    assert.doesNotMatch(url, /\/main\//);
  }
});

test("accepts a full hexadecimal SHA and rejects malformed identities", () => {
  assert.equal(updater.assertSha(A.toUpperCase()), A);
  for (const value of ["", "abc", "g".repeat(40), A + "0", null]) {
    assert.throws(() => updater.assertSha(value), /malformed commit SHA/);
  }
});

test("equal complete SHA needs no synchronization", () => {
  assert.equal(updater.synchronizationNeeded(A, active, true), false);
});

test("every changed HEAD is a revision, including documentation-only commits", () => {
  assert.equal(updater.synchronizationNeeded(B, active, true), true);
});

test("missing/invalid state, migration, and incomplete artifacts force repair", () => {
  assert.equal(updater.synchronizationNeeded(A, null, true), true, "legacy version cannot identify a commit");
  assert.equal(updater.synchronizationNeeded(A, { activeSha: "2.0.0" }, true), true);
  assert.equal(updater.synchronizationNeeded(A, active, false), true);
});

test("pending restart state is validated independently of semantic version", () => {
  assert.equal(updater.validState({ activeSha: A, pendingSha: B, loaderProtocol: 3, status: "pending-restart" }), true);
  assert.equal(updater.validState({ ...active, version: "2.0.0" }), true);
  assert.equal(updater.synchronizationNeeded(A, { ...active, version: "999.0.0" }, true), false);
});

test("manifest validates loader/application separation and compatibility", () => {
  assert.deepEqual(updater.validateManifest({ ...manifest }), manifest);
  assert.throws(() => updater.validateManifest({ ...manifest, files: [] }), /non-empty/);
  assert.throws(() => updater.validateManifest({ ...manifest, files: ["scriptable.js", "../secret"] }), /unsafe/);
  assert.throws(() => updater.validateManifest({ ...manifest, loader: "scriptable.js" }), /separate/);
  assert.throws(() => updater.validateManifest({ ...manifest, minimumLoaderProtocol: 3 }), /protocol range/);
});

test("repository manifest includes the entry point and every locally imported module", () => {
  const repositoryRoot = path.join(__dirname, "..");
  const repositoryManifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"));
  const scriptable = fs.readFileSync(path.join(repositoryRoot, "scriptable.js"), "utf8");
  const importedModules = Array.from(
    scriptable.matchAll(/importModule\(\s*[`'"][^`'"]*?(modules\/[^`'"]+\.js)[`'"]\s*\)/g),
    match => match[1]
  );

  assert.ok(importedModules.length > 0, "scriptable.js should import at least one local module");
  for (const requiredFile of [repositoryManifest.entry, ...importedModules]) {
    assert.ok(repositoryManifest.files.includes(requiredFile), `${requiredFile} is missing from manifest.files`);
  }
});

test("GitHub headers include API negotiation, user agent, no-cache, and optional token", () => {
  const headers = updater.requestHeaders("secret", true);
  assert.equal(headers.Authorization, "Bearer secret");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.match(headers["Cache-Control"], /no-cache/);
  assert.match(headers["User-Agent"], /MF885/);
  assert.equal(updater.requestHeaders("", true).Authorization, undefined);
});

test("safe paths reject traversal, absolute paths, and empty segments", () => {
  for (const path of ["loader.js", "modules/ussd.js"]) assert.equal(updater.safeRelativePath(path), true);
  for (const path of ["../loader.js", "/loader.js", "a//b", "", "a?b"]) assert.equal(updater.safeRelativePath(path), false);
});

test("experimental controls are enabled by default but can be explicitly hidden", () => {
  assert.equal(updater.DEFAULT_CONFIG.showExperimentalControls, true);
  assert.equal(updater.normalizeConfig({}).showExperimentalControls, true);
  assert.equal(updater.normalizeConfig({ showExperimentalControls: false }).showExperimentalControls, false);
});

test("XML request path supports the shorter compatibility endpoint", () => {
  assert.equal(updater.normalizeConfig({ xmlRequestPath: "/xml_action.cgi" }).xmlRequestPath, "/xml_action.cgi");
  assert.equal(updater.normalizeConfig({ xmlRequestPath: "/unexpected.cgi" }).xmlRequestPath, "/xml_action.cgi");
});
