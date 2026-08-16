const test = require("node:test");
const assert = require("node:assert/strict");
const ui = require("../modules/ui-v2.js");
const fixes = require("../modules/ui-v2-fixes.js");

function model(powerControls) {
  return {
    loadedAt: 1,
    pollSeconds: 45,
    actualModel: "MF885",
    actualFirmware: "2.5.94_release_MF855_NZ_CP_2.129.003",
    softwareVersion: "3.1.5-ui2",
    powerControls,
    errors: {},
    network: { mode: "LTE", generation: "4G", operator: "Carrier", dbm: -91, bars: 3 },
    battery: { percent: 80 }, traffic: {}, sms: { messages: [] },
    cellularDiagnostics: { values: { activeApn: { value: "internet.example" } }, stages: {} },
    cellularControl: {}, ussd: {}, deviceAccess: {}
  };
}

test("unconfirmed power and traffic-reset controls are visibly disabled", () => {
  const html = ui.buildHtml(model({ available: false, reason: "Exact profile mismatch", actions: {} }));
  assert.match(html, /id="powerBtn" disabled aria-disabled="true" title="Exact profile mismatch"/);
  assert.match(html, /id="resetTraffic" disabled aria-disabled="true"/);
  assert.match(html, /id="powerReason"[^>]*>Exact profile mismatch</);
});

test("exact profile enables only reboot and power-off UI", () => {
  const html = ui.buildHtml(model({ available: true, reason: "Exact profile matched", actions: { reboot: true, powerOff: true } }));
  assert.match(html, /id="powerBtn">⏻ Reboot \/ Power/);
  assert.doesNotMatch(html, /id="powerBtn" disabled/);
  assert.match(html, /id="resetTraffic" disabled/);
});

test("read-only preflight and actual polling/APN values reach the settings UI", () => {
  const html = fixes.enhanceHtml(ui.buildHtml(model({ available: false, reason: "Locked", actions: {} })), model({}));
  assert.match(html, /id="safePreflight">Run read-only preflight/);
  assert.match(html, /id="pollSeconds">45<\/span>s/);
  assert.match(html, /const apn=value\('#apn','—'\)/);
  assert.match(html, /const poll=value\('#pollSeconds','30'\)/);
  assert.match(html, /<span>APN<\/span><b>'\+esc\(apn\)/);
  assert.match(html, /data-settings-preflight/);
});

test("client uses configured poll interval and renders a copyable redacted preflight report", () => {
  const html = ui.buildHtml(model({ available: false, reason: "Locked", actions: {} }));
  assert.match(html, /function pollMs\(\)/);
  assert.match(html, /state\.next=Date\.now\(\)\+pollMs\(\)/);
  assert.match(html, /command\('safePreflight',\{\}\)/);
  assert.match(html, /Writes attempted: 0\. Flash allowed: false\./);
});
