const test = require("node:test");
const assert = require("node:assert/strict");

global.Script = { name: () => "MF885 Test" };

const { buildHtml, clientScript } = require("../scriptable.js");

function model(tab) {
  return {
    tab,
    loadedAt: Date.UTC(2026, 7, 4, 12, 0, 0),
    sms: { messages: [{ id: "42", row: 42, phone: "+123", date: "today", content: "hello" }] },
    errors: {},
    network: {},
    battery: {},
    traffic: {},
    ussd: {},
    deviceAccess: { capabilities: [] }
  };
}

test("client WebView script keeps newline escapes inside string literals", () => {
  const script = clientScript(model("sms"), "scriptable:///run?scriptName=MF885%20Test");

  assert.match(script, /parts\.join\('\\n'\)/);
  assert.match(script, /filter\(Boolean\)\.join\('\\n'\)/);
  assert.match(script, /statusText\+'\\n'\+raw/);
  assert.match(script, /'\\nResponse: '\+raw/);

  assert.doesNotMatch(script, /join\('\n/);
  assert.doesNotMatch(script, /statusText\+'\n'\+raw/);
  assert.doesNotMatch(script, /'\nResponse: '\+raw/);
  assert.doesNotThrow(() => new Function(script));
});

test("dashboard HTML marks SMS tab active without client JavaScript", () => {
  const html = buildHtml(model("sms"));

  assert.match(html, /<button data-tab-button="sms" class="active"/);
  assert.match(html, /<button data-tab-button="router" class=""/);
  assert.match(html, /<section id="sms" class="tab active">/);
  assert.match(html, /<section id="router" class="tab">/);
});

test("dashboard HTML marks router tab active without client JavaScript", () => {
  const html = buildHtml(model("router"));

  assert.match(html, /<button data-tab-button="sms" class=""/);
  assert.match(html, /<button data-tab-button="router" class="active"/);
  assert.match(html, /<section id="sms" class="tab">/);
  assert.match(html, /<section id="router" class="tab active">/);
});

test("dashboard labels are English and error notices are not green success notices", () => {
  const data = model("sms");
  data.notice = { text: "Deletion failed", type: "error" };
  data.battery = { percent: 72, charging: false, status: "Discharging", rawStatus: "1" };
  data.network = { mode: "LTE / 4G", bars: 4, dbm: -84, quality: "Strong" };
  const html = buildHtml(data);

  assert.match(html, /Router/);
  assert.match(html, /Next refresh:/);
  assert.match(html, /Compose SMS/);
  assert.match(html, /class="notice error"/);
  assert.doesNotMatch(html, /class="notice">Deletion failed/);
  assert.doesNotMatch(html, /[А-Яа-я]/);
});

test("battery inline labels show charging direction in English", () => {
  const { batteryInlineLabel } = require("../scriptable.js");

  assert.equal(batteryInlineLabel({ percent: 72, charging: true, rawStatus: "2" }), "🔋 72% ↑ Charging");
  assert.equal(batteryInlineLabel({ percent: 72, charging: false, rawStatus: "1" }), "🔋 72% ↓ Discharging");
  assert.equal(batteryInlineLabel({ percent: 100, charging: false, rawStatus: "3" }), "🔋 100% Full");
  assert.equal(batteryInlineLabel({ percent: null, charging: false, rawStatus: "" }), "🔋 — Unknown");
});

test("network mode and alternate signal fields render readable protocol and bars", () => {
  const { parseNetwork, networkModeLabel, signalBarsHtml } = require("../scriptable.js");

  assert.equal(networkModeLabel("19"), "LTE / 4G");
  assert.equal(networkModeLabel("2"), "3G");
  assert.equal(networkModeLabel("1"), "2G");
  assert.equal(networkModeLabel("20"), "5G");
  const parsed = parseNetwork("<RGW><NetworkType>19</NetworkType><network_signal>80</network_signal><RSRP>-88</RSRP></RGW>");
  assert.equal(parsed.mode, "LTE / 4G");
  assert.equal(parsed.bars, 4);
  assert.match(signalBarsHtml(parsed), /aria-label="Signal 4 of 5"/);
});
