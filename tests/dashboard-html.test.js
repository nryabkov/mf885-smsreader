const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

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

test("translateSms continues when localStorage throws SecurityError", async () => {
  const script = clientScript(model("sms"), "scriptable:///run?scriptName=MF885%20Test")
    .replace("translateEndpoint:\"\"", "translateEndpoint:\"https://translate.example.test\"");
  const box = { textContent: "" };
  const card = {
    querySelector: selector => selector === "[data-translation] span" ? box : null,
    getAttribute: name => ({ "data-msg-id": "42", "data-msg-text": "hello" })[name] || ""
  };
  const button = {
    disabled: false,
    textContent: "Translate",
    closest: selector => selector === ".sms" ? card : null
  };
  const localStorage = {
    getItem() { throw new DOMException("Blocked", "SecurityError"); },
    setItem() { throw new DOMException("Blocked", "SecurityError"); }
  };
  const context = {
    localStorage,
    DOMException,
    URLSearchParams,
    navigator: {},
    document: {
      addEventListener() {},
      getElementById() { return null; }
    },
    window: {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { fn(); },
    fetch: async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ translatedText: "привет" })
    })
  };

  vm.createContext(context);
  vm.runInContext(script, context);

  await assert.doesNotReject(() => context.translateSms(button));
  assert.equal(box.textContent, "привет");
  assert.equal(button.textContent, "Translate");
  assert.equal(button.disabled, false);
});


test("client auto refresh uses WebView bridge instead of Scriptable relaunch", () => {
  const script = clientScript(model("sms"), "scriptable:///run?scriptName=MF885%20Test");

  assert.match(script, /window\.zmiTick=function/);
  assert.match(script, /window\.zmiApply=function/);
  assert.match(script, /window\.zmiTick=function\(\)\{startProgress\(\)\}/);
  assert.match(script, /showActionError\('Refresh failed',payload\.error,''\)/);
  assert.doesNotMatch(script, /Router status refreshed without reopening Scriptable\./);
  assert.doesNotMatch(script, /navigateTo\(runUrl\('dashboard',selectedTab\(\)\),'Automatic refresh\.'\)/);
});


test("dashboard hides Translate button when endpoint is not configured", () => {
  const html = buildHtml(model("sms"));

  assert.match(html, />Copy</);
  assert.match(html, />Delete</);
  assert.doesNotMatch(html, />Translate</);
});

test("copy fallback selects manual textarea when clipboard is unavailable", async () => {
  const script = clientScript(model("sms"), "scriptable:///run?scriptName=MF885%20Test");
  const selection = { focused: false, selected: false, range: null };
  const textarea = {
    value: "",
    hidden: true,
    focus() { selection.focused = true; },
    select() { selection.selected = true; },
    setSelectionRange(start, end) { selection.range = [start, end]; }
  };
  const status = {
    hidden: true,
    classList: { toggle() {} },
    querySelector(selector) {
      if (selector === "[data-status-title]" || selector === "[data-status-detail]") return { textContent: "" };
      if (selector === "[data-status-copy]") return textarea;
      if (selector === "[data-status-pre]") return { textContent: "", hidden: false };
      return null;
    }
  };
  const card = {
    querySelector: selector => selector === ".body" ? { innerText: "hello" } : null
  };
  const button = {
    disabled: false,
    textContent: "Copy",
    closest: selector => selector === ".sms" ? card : null
  };
  const context = {
    localStorage: {},
    URLSearchParams,
    navigator: {},
    document: {
      addEventListener() {},
      querySelectorAll() { return []; },
      getElementById(id) { return id === "actionStatus" ? status : null; }
    },
    window: {},
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(fn) { fn(); }
  };

  vm.createContext(context);
  vm.runInContext(script, context);

  await context.copySms(button);

  assert.equal(textarea.value, "hello");
  assert.equal(textarea.hidden, false);
  assert.equal(selection.focused, true);
  assert.equal(selection.selected, true);
  assert.deepEqual(selection.range, [0, 5]);
});

test("dashboard shows Translate button when endpoint is configured", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "scriptable.js"), "utf8")
    .replace('const TRANSLATE_ENDPOINT = "";', 'const TRANSLATE_ENDPOINT = "https://translate.example.test";');
  const sandbox = { module: { exports: {} }, exports: {}, Script: global.Script, args: { queryParameters: {} } };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const html = sandbox.module.exports.buildHtml(model("sms"));

  assert.match(html, />Copy</);
  assert.match(html, />Translate</);
  assert.match(html, />Delete</);
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

test("dashboard battery UI renders inline charging direction", () => {
  const dashboard = model("router");
  dashboard.battery = { percent: 72, charging: true, rawStatus: "2", status: "Charging" };
  const html = buildHtml(dashboard);

  assert.match(html, /<span>🔋 72% ↑ Charging<\/span>/);
  assert.match(html, /<small>🔋 72% ↑ Charging<\/small>/);
  assert.match(html, /<h2>🔋 72% ↑ Charging<\/h2>/);
});

test("network mode and alternate signal fields render readable protocol and bars", () => {
  const { parseNetwork, networkModeLabel, signalBarsHtml } = require("../scriptable.js");

  assert.equal(networkModeLabel("19"), "4G · LTE");
  assert.equal(networkModeLabel("2"), "3G");
  assert.equal(networkModeLabel("1"), "2G");
  assert.equal(networkModeLabel("20"), "5G");
  const parsed = parseNetwork("<RGW><NetworkType>19</NetworkType><network_signal>80</network_signal><RSRP>-88</RSRP></RGW>");
  assert.equal(parsed.mode, "4G · LTE");
  assert.equal(parsed.bars, 4);
  assert.match(signalBarsHtml(parsed), /aria-label="Signal 4 of 5"/);
});

test("network parser understands MF885 sys_mode and sys_submode details", () => {
  const { parseNetwork } = require("../scriptable.js");

  assert.equal(parseNetwork("<RGW><sys_mode>17</sys_mode><SignalBar>3</SignalBar></RGW>").protocol, "4G · LTE");
  assert.equal(parseNetwork("<RGW><sys_submode>25</sys_submode></RGW>").protocol, "4G · LTE TDD");
  assert.equal(parseNetwork("<RGW><sys_submode>26</sys_submode></RGW>").protocol, "4G · LTE FDD");
  const noService = parseNetwork("<RGW><NW_register_status>0</NW_register_status><sys_mode>0</sys_mode><SignalBar>5</SignalBar></RGW>");
  assert.equal(noService.registered, false);
  assert.equal(noService.protocol, "No service");
  assert.equal(noService.bars, 0);
});


test("network parser normalizes common 4G and 3G firmware mode fields", () => {
  const { parseNetwork } = require("../scriptable.js");

  assert.equal(parseNetwork("<RGW><CurrentNetworkType>LTE FDD</CurrentNetworkType></RGW>").mode, "4G · LTE FDD");
  assert.equal(parseNetwork("<RGW><current_network>LTE TDD</current_network></RGW>").mode, "4G · LTE TDD");
  assert.equal(parseNetwork("<RGW><networkMode>LTE-A</networkMode></RGW>").mode, "4G · LTE-A");
  assert.equal(parseNetwork("<RGW><NetworkMode>19</NetworkMode></RGW>").mode, "4G · LTE");
  assert.equal(parseNetwork("<RGW><ps_service_type>HSPA+</ps_service_type></RGW>").mode, "3G · HSPA+");
  assert.equal(parseNetwork("<RGW><accessTechnology>WCDMA</accessTechnology></RGW>").mode, "3G · WCDMA");
  assert.equal(parseNetwork("<RGW><cellular_network_type>EDGE</cellular_network_type></RGW>").mode, "2G · EDGE");
});

test("network parser detects roaming and signal scales", () => {
  const { parseNetwork } = require("../scriptable.js");

  const rsrp = parseNetwork("<RGW><roaming>1</roaming><rsrp>-88</rsrp><rat_name>LTE</rat_name></RGW>");
  assert.equal(rsrp.roaming, true);
  assert.equal(rsrp.bars, 4);
  assert.equal(rsrp.signalText, "Good");
  assert.equal(parseNetwork("<RGW><RSSI>-82</RSSI></RGW>").bars, 3);
  assert.equal(parseNetwork("<RGW><signal_strength>20</signal_strength></RGW>").dbm, -73);
  assert.equal(parseNetwork("<RGW><network_signal>80</network_signal></RGW>").percent, 80);
  assert.equal(parseNetwork("<RGW><signal>99</signal></RGW>").bars, null);
});


test("battery parser understands numeric status values independently", () => {
  const { parseBattery, batteryInlineLabel } = require("../scriptable.js");

  const discharging = parseBattery("<RGW><Battery_percent>70</Battery_percent><Battery_status>1</Battery_status></RGW>");
  assert.equal(discharging.state, "discharging");
  assert.equal(discharging.status, "Discharging");
  assert.equal(discharging.charging, false);
  assert.equal(batteryInlineLabel(discharging), "🔋 70% ↓ Discharging");

  const charging = parseBattery("<RGW><Battery_percent>71</Battery_percent><Battery_status>2</Battery_status></RGW>");
  assert.equal(charging.state, "charging");
  assert.equal(charging.status, "Charging");
  assert.equal(charging.charging, true);

  const full = parseBattery("<RGW><Battery_percent>100</Battery_percent><Battery_status>3</Battery_status></RGW>");
  assert.equal(full.state, "full");
  assert.equal(full.status, "Full");
  assert.equal(full.charging, false);

  const chargerDisconnected = parseBattery("<RGW><Battery_percent>55</Battery_percent><Charger_status>0</Charger_status></RGW>");
  assert.equal(chargerDisconnected.state, "discharging");
  assert.equal(chargerDisconnected.status, "Discharging");

  const unpluggedStatus3 = parseBattery("<RGW><Battery_percent>92</Battery_percent><Battery_status>3</Battery_status><Charger_status>0</Charger_status></RGW>");
  assert.equal(unpluggedStatus3.state, "discharging");
  assert.equal(unpluggedStatus3.status, "Discharging");

  const outputStatus3 = parseBattery("<RGW><Battery_percent>92</Battery_percent><Battery_status>3</Battery_status><Output_current>80</Output_current></RGW>");
  assert.equal(outputStatus3.state, "discharging");
  assert.equal(outputStatus3.status, "Discharging");
});


test("battery status 3 at 92 percent is charging, not full", () => {
  const { parseBattery } = require("../scriptable.js");

  const parsed = parseBattery("<RGW><Battery_percent>92</Battery_percent><Battery_status>3</Battery_status></RGW>");

  assert.notEqual(parsed.status, "Full");
  assert.equal(parsed.state, "charging");
  assert.equal(parsed.status, "Charging");
});

test("battery parser uses charger and output current details", () => {
  const { parseBattery } = require("../scriptable.js");

  const charging = parseBattery("<RGW><batteryPercent>55</batteryPercent><Charger_current>120</Charger_current></RGW>");
  assert.equal(charging.charging, true);
  assert.equal(charging.state, "charging");
  assert.equal(charging.chargerCurrent, 120);
  const discharging = parseBattery("<RGW><BatteryValue>44</BatteryValue><Output_current>80</Output_current></RGW>");
  assert.equal(discharging.state, "discharging");
  assert.equal(discharging.outputCurrent, 80);
});

test("traffic parser understands units and WAN session duration", () => {
  const { parseTraffic } = require("../scriptable.js");
  const traffic = parseTraffic("<RGW><WanStatistics><tx_byte_all>4 MB</tx_byte_all><rx_byte_all>1.2 GB</rx_byte_all><tx_byte>12.5 KiB</tx_byte><rx_byte>1.2 GiB</rx_byte><conn_days>1</conn_days><conn_hours>2</conn_hours><conn_minutes>3</conn_minutes><conn_seconds>4</conn_seconds></WanStatistics></RGW>");

  assert.equal(traffic.upload, 4 * 1024 * 1024);
  assert.equal(traffic.download, Math.round(1.2 * 1024 * 1024 * 1024));
  assert.equal(traffic.sessionUpload, Math.round(12.5 * 1024));
  assert.equal(traffic.sessionDownload, Math.round(1.2 * 1024 * 1024 * 1024));
  assert.equal(traffic.sessionSeconds, 93784);
});

test("SMS parser treats total_number as messages and fingerprints repeated pages", () => {
  const { parseSmsPage, pageMessageFingerprint, smsEdgeFingerprint, unchangedSms } = require("../scriptable.js");
  const xml = "<RGW><total_number>42</total_number><Item index=\"1\"><index>a</index><from>+1</from><content>hello</content><date>now</date></Item></RGW>";
  const page = parseSmsPage(xml, 1);

  assert.equal(page.totalMessages, 42);
  assert.equal(page.totalPages, null);
  assert.equal(pageMessageFingerprint(page.messages), pageMessageFingerprint(parseSmsPage(xml, 2).messages));
  const fingerprint = smsEdgeFingerprint(page, null, page.totalPages, page.totalMessages);
  assert.equal(unchangedSms({ fingerprint, totalPages: null, totalMessages: 42 }, { fingerprint, totalPages: null, totalMessages: 42 }), true);
});


test("USSD composer lives only in unified router experimental section", () => {
  const data = model("router");
  data.ussd = { supported: true, detail: "USSD probes passed" };
  data.deviceAccess = { supported: true, detail: "Device probes passed", capabilities: [{ id: "adb", title: "Enable ADB" }] };
  const html = buildHtml(data);
  const smsSection = html.match(new RegExp('<section id="sms"[\\s\\S]*?</section>\\n    <section id="router"'))[0];
  const routerExperimental = html.match(/<article class="card experimental" id="routerExperimental"[\s\S]*?<article class="card"><small>Power/)[0];

  assert.doesNotMatch(smsSection, /ussdComposer|Dial USSD/);
  assert.match(routerExperimental, /ussdComposer/);
  assert.match(routerExperimental, /data-ussd-section/);
  assert.match(routerExperimental, /data-device-access-section/);
  assert.match(routerExperimental, /Enable ADB/);
  assert.match(clientScript(data, "scriptable:///run?scriptName=MF885%20Test"), /runUrl\('ussd','router',\{code:code\}\)/);
});

test("dangerous primary actions use local WebView confirmation", () => {
  const html = buildHtml(model("router"));

  assert.match(html, /data-power-action="reboot"/);
  assert.match(html, /data-power-action="powerOff"/);
  assert.match(html, /data-power-action="resetTraffic"/);
  assert.doesNotMatch(html, /<a[^>]+href="scriptable:\/\/\/run\?[^\"]*action=(?:reboot|powerOff|resetTraffic)[^\"]*confirm=1/);
  assert.doesNotMatch(html, /<a[^>]+href="scriptable:\/\/\/run\?[^\"]*confirm=1[^\"]*action=(?:reboot|powerOff|resetTraffic)/);
});

test("client script contains inline confirm flow for power and traffic actions", () => {
  const script = clientScript(model("router"), "scriptable:///run?scriptName=MF885%20Test");

  assert.match(script, /function showInlineConfirm/);
  assert.match(script, /data-power-action/);
  assert.match(script, /data-final-confirm/);
  assert.match(script, /runUrl\(action,'router',\{confirm:'1'\}\)/);
  assert.match(script, /\\u0422\\u043e\\u0447\\u043d\\u043e \\u043f/);
  assert.match(script, /\\u0422\\u043e\\u0447\\u043d\\u043e \\u0432/);
  assert.match(script, /\\u0441\\u0447\\u0451\\u0442\\u0447\\u0438\\u043a/);
});

test("powerAccepted requires explicit firmware acceptance", () => {
  const { powerAccepted } = require("../scriptable.js");

  assert.equal(powerAccepted("<RGW></RGW>"), false);
  assert.equal(powerAccepted(""), false);
  assert.equal(powerAccepted("<RGW><status>0</status></RGW>"), true);
  assert.equal(powerAccepted("<RGW><result>0</result></RGW>"), true);
});

test("router UI shows experimental cellular reconnect and whitelist modes", () => {
  const data = model("router");
  data.network = { mode: "4G · LTE", bars: 4 };
  data.cellularControl = { modes: [
    { id: "auto", title: "Automatic" },
    { id: "lteOnly", title: "4G/LTE only" },
    { id: "ltePreferred", title: "LTE preferred" },
    { id: "wcdmaOnly", title: "3G only" },
    { id: "gsmOnly", title: "2G only" }
  ] };
  const html = buildHtml(data);

  assert.match(html, /Reconnect cellular network/);
  assert.match(html, /Current mode: <strong>4G · LTE<\/strong>/);
  assert.match(html, /Experimental cellular controls/);
  for (const mode of ["auto", "lteOnly", "ltePreferred", "wcdmaOnly", "gsmOnly"]) {
    assert.match(html, new RegExp(`action=cellularMode[^\"]*mode=${mode}`));
    assert.match(html, new RegExp(`data-cellular-mode="${mode}"`));
  }
});

test("client cellular confirmation adds final confirm URL only after inline prompt", () => {
  const script = clientScript(model("router"), "scriptable:///run?scriptName=MF885%20Test");

  assert.match(script, /showCellularConfirm/);
  assert.match(script, /runUrl\('cellularMode','router',\{mode:mode,confirm:'1'\}\)/);
  assert.match(script, /runUrl\('cellularReconnect','router',\{confirm:'1'\}\)/);
  assert.match(script, /\[data-cellular-action\],\[data-cellular-mode\]/);
  assert.doesNotThrow(() => new Function(script));
});

test("cellular diagnostics sanitizer redacts digest and secrets", () => {
  const { sanitizeDiagnostics } = require("../scriptable.js");
  const raw = 'Authorization: Digest username="admin", nonce="abcdef123456", response="1234567890abcdef"\npassword=secret\nCookie: sid=secret';
  const clean = sanitizeDiagnostics(raw);

  assert.doesNotMatch(clean, /abcdef123456|1234567890abcdef|password=secret|sid=secret/);
  assert.match(clean, /Authorization: <redacted>/);
  assert.match(clean, /password=<redacted>/);
});
