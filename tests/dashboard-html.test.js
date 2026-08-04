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
