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

test("network parser understands MF885 sys_mode and sys_submode details", () => {
  const { parseNetwork } = require("../scriptable.js");

  assert.equal(parseNetwork("<RGW><sys_mode>17</sys_mode><SignalBar>3</SignalBar></RGW>").protocol, "LTE / 4G");
  assert.equal(parseNetwork("<RGW><sys_submode>25</sys_submode></RGW>").protocol, "LTE TDD / 4G");
  assert.equal(parseNetwork("<RGW><sys_submode>26</sys_submode></RGW>").protocol, "LTE FDD / 4G");
  const noService = parseNetwork("<RGW><NW_register_status>0</NW_register_status><sys_mode>0</sys_mode><SignalBar>5</SignalBar></RGW>");
  assert.equal(noService.registered, false);
  assert.equal(noService.protocol, "No service");
  assert.equal(noService.bars, 0);
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
