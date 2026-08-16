const test = require("node:test");
const assert = require("node:assert/strict");
const preflight = require("../modules/read-only-preflight.js");
const app = require("../scriptable.js");

const fixtures = {
  status1: "<RGW><model>LV01</model><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num><batteryinfo><Battery_percent>81</Battery_percent><Battery_status>1</Battery_status><Battery_level>4</Battery_level><Charger_status>0</Charger_status><Output_current>0</Output_current></batteryinfo><IMEI>123456789012345</IMEI></RGW>",
  wan: "<RGW><wan><lte_apn>private.enterprise.apn</lte_apn><username>secret-user</username><password>secret-password</password><operator>Carrier</operator></wan></RGW>",
  Engineer_parameter: "<RGW><RSRP>-91</RSRP><RSRQ>-9</RSRQ><SINR>12</SINR></RGW>",
  miautosleep: "<RGW><autosleep_mi><autosleep_status>1</autosleep_status><wpsbtneffect>2</wpsbtneffect></autosleep_mi></RGW>",
  smart_set: "<RGW><wlan_settings><wifi_sleep_time>600</wifi_sleep_time><wifi_sleep_action>1</wifi_sleep_action></wlan_settings></RGW>",
  uapxb_wlan_basic_settings: "<RGW><wlan_settings><wifi_sleep_time>600</wifi_sleep_time></wlan_settings></RGW>",
  autoreboot: "<RGW><auto_reboot><autoreboot_enabled>1</autoreboot_enabled><autoreboot_time>03:00</autoreboot_time></auto_reboot></RGW>"
};

test("collector calls only the fixed GET allowlist and never touches destructive models", async () => {
  const calls = [];
  const report = await preflight.collect({
    get: async endpoint => { calls.push(endpoint); return fixtures[endpoint]; }
  }, { now: 12345 });
  assert.deepEqual(calls, preflight.READ_ONLY_ENDPOINTS);
  assert.equal(report.mode, "read-only");
  assert.equal(report.safety.writesAttempted, 0);
  assert.equal(report.safety.forbiddenEndpointsTouched, false);
  assert.equal(report.safety.restoreTransportVerified, false);
  assert.equal(report.safety.flashAllowed, false);
  assert.deepEqual(report.safety.methodsUsed, ["GET"]);
});

test("report extracts sleep/reboot evidence but never returns raw secrets", async () => {
  const report = await preflight.collect({ get: async endpoint => fixtures[endpoint] }, { now: 12345 });
  assert.equal(report.identity.model, "MF885");
  assert.equal(report.identity.rawModel, "LV01");
  assert.equal(report.identity.exactFirmware, true);
  assert.equal(report.sleep.autosleepStatus, "1");
  assert.equal(report.sleep.wifiSleepTime, "600");
  assert.equal(report.sleep.wifiSleepAction, "1");
  assert.equal(report.autoReboot.time, "03:00");
  assert.equal(report.network.apnPresent, true);
  assert.equal(report.power.inputConnected, true);
  assert.equal(report.power.state, "charging");
  assert.equal(report.power.powerStatus, "charging");
  assert.equal(report.power.chargeHealth, "normal");
  assert.equal(report.power.interpretation, "zmi-apk-1.2.42");
  assert.equal(report.power.fieldsPresent.chargerStatus, true);
  assert.equal(report.power.fieldsPresent.chargerCurrent, false);
  assert.equal(report.power.outputCurrent, "0");
  const text = preflight.format(report);
  for (const secret of ["123456789012345", "private.enterprise.apn", "secret-user", "secret-password"]) {
    assert.doesNotMatch(text, new RegExp(secret));
  }
});

test("power report distinguishes a missing field from zero and never aliases CDetectStatus to Charger_status", async () => {
  const status1 = "<RGW><model>LV01</model><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num><batteryinfo><Battery_status>3</Battery_status><CDetectStatus>0</CDetectStatus><Output_current>0</Output_current></batteryinfo></RGW>";
  const report = await preflight.collect({ get: async endpoint => endpoint === "status1" ? status1 : fixtures[endpoint] });
  assert.equal(report.power.chargerStatus, "");
  assert.equal(report.power.cDetectStatus, "0");
  assert.equal(report.power.fieldsPresent.chargerStatus, false);
  assert.equal(report.power.fieldsPresent.cDetectStatus, true);
  assert.equal(report.power.fieldsPresent.outputCurrent, true);
  assert.equal(report.power.inputConnected, false);
  assert.equal(report.power.usbOutputActive, false);
  assert.equal(report.power.state, "normal");
  assert.equal(report.power.powerStatus, "not-charging");
});

test("power interpretation fails closed when the exact firmware identity is absent", async () => {
  const status1 = "<RGW><model>LV01</model><batteryinfo><Battery_status>1</Battery_status><Charger_status>0</Charger_status></batteryinfo></RGW>";
  const report = await preflight.collect({ get: async endpoint => endpoint === "status1" ? status1 : fixtures[endpoint] });
  assert.equal(report.identity.exactFirmware, false);
  assert.equal(report.power.interpretation, "unconfirmed");
  assert.equal(report.power.inputConnected, null);
});

test("endpoint summaries never copy response field values", async () => {
  const marker = "secret-result-value";
  const report = await preflight.collect({
    get: async endpoint => endpoint === "Engineer_parameter"
      ? `<RGW><result>${marker}</result></RGW>`
      : fixtures[endpoint]
  }, { now: 12345 });
  assert.equal(report.endpoints.Engineer_parameter.ok, true);
  assert.equal(report.endpoints.Engineer_parameter.responseRoot, undefined);
  assert.doesNotMatch(preflight.format(report), new RegExp(marker));
});

test("unavailable optional endpoints are recorded without converting the probe into a write", async () => {
  const report = await preflight.collect({
    get: async endpoint => {
      if (endpoint === "miautosleep") throw new Error("miautosleep request failed: HTTP 404 from /xml_action.cgi");
      return fixtures[endpoint] || "<RGW/>";
    }
  });
  assert.equal(report.endpoints.miautosleep.ok, false);
  assert.equal(report.endpoints.miautosleep.error, "HTTP 404");
  assert.equal(report.safety.writesAttempted, 0);
});

test("arbitrary endpoint errors cannot leak response or credential text", async () => {
  const marker = "private-response-body";
  const report = await preflight.collect({
    get: async endpoint => {
      if (endpoint === "wan") throw new Error(`unexpected parser failure password=hunter2 ${marker}`);
      return fixtures[endpoint] || "<RGW/>";
    }
  });
  assert.equal(report.endpoints.wan.error, "Endpoint unavailable");
  assert.doesNotMatch(preflight.format(report), new RegExp(marker));
  assert.doesNotMatch(preflight.format(report), /hunter2/);
});

test("dashboard bridge returns the same redacted read-only report", async () => {
  const calls = [];
  const result = await app.runReadOnlyPreflight({}, {
    get: async endpoint => { calls.push(endpoint); return fixtures[endpoint]; },
    now: 12345
  });
  assert.deepEqual(calls, preflight.READ_ONLY_ENDPOINTS);
  assert.equal(result.report.safety.flashAllowed, false);
  assert.match(result.text, /"writesAttempted": 0/);
});
