const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");
const stage0 = require("../modules/firmware-stage0.js");

const STATUS = `<?xml version="1.0"?><RGW>
  <model>LV01</model><hardware_version>MF96 Ver.D</hardware_version>
  <version_num>${stage0.REQUIRED_FIRMWARE}</version_num>
  <batteryinfo><Battery_percent>100</Battery_percent><Battery_status>1</Battery_status><Charger_status>4</Charger_status></batteryinfo>
</RGW>`;
const RESTORE = `<?xml version="1.0"?><RGW><process><status>0</status><progress>0</progress><cause>No Error!</cause></process></RGW>`;
const UPGRADE = `<RGW><upgrade><support_32m_flash>1</support_32m_flash></upgrade><webui_upgrade><upgrade_status>0</upgrade_status><progress>0</progress><upgrade_fail_cause>No Error!</upgrade_fail_cause><backup_status>3</backup_status><backup_progress>0</backup_progress><backup_fail_cause>Backup not start!</backup_fail_cause><restore_status/><restore_progress/><restore_fail_cause/></webui_upgrade></RGW>`;

test("firmware status route definitions are immutable fixed GET queries", () => {
  const routes = app.firmwareStatusRouteDefinitions();
  assert.equal(Object.isFrozen(routes), true);
  assert.equal(routes.length, 4);
  assert.deepEqual(routes.map(route => route.query), [
    "method=get&module=duster&file=GetRestoreStatus",
    "method=get&file=GetRestoreStatus",
    "method=get&file=upgrade_firmware",
    "method=get&module=duster&file=upgrade_firmware"
  ]);
  assert.ok(routes.every(route => Object.isFrozen(route)));
  assert.ok(routes.every(route => route.query.startsWith("method=get&")));
});

test("firmware transport probe captures only read-side status models and redacts session secrets", async () => {
  const calls = [];
  const session = {
    appAuthorization: "Digest secret-header",
    appCookie: "secret-cookie",
    appLogin: { authHeaderPersisted:true, sessionCookieReceived:false }
  };
  const result = await app.runFirmwareTransportProbe({
    stage0,
    now: () => 123456,
    createAppSession: async () => { calls.push("login"); return session; },
    getAppStatus: async value => { assert.equal(value, session); calls.push("status1"); return { text:STATUS, statusCode:200, responseClass:"xml-response", redirectCount:0 }; },
    readRoute: async (value, route) => {
      assert.equal(value, session);
      calls.push(route.id);
      const text = route.schema === "restore" ? RESTORE : UPGRADE;
      return { text, statusCode:200, responseClass:"xml-response", redirectCount:0 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.readSideComplete, true);
  assert.equal(result.flashAllowed, false);
  assert.equal(result.report.identity.model, "MF885");
  assert.equal(result.report.identity.rawModel, "LV01");
  assert.equal(result.report.identity.hardware, "MF96 Ver.D");
  assert.equal(result.report.identity.exactFirmware, true);
  assert.equal(result.report.power.batteryPercent, 100);
  assert.equal(result.report.power.batteryStatus, "1");
  assert.equal(result.report.power.chargerStatus, "4");
  assert.equal(result.report.observations.length, 4);
  assert.deepEqual(result.report.observations[0].values, { status:"0", progress:"0", cause:"No Error!" });
  assert.equal(result.report.observations[2].values.support32mFlash, "1");
  assert.equal(result.report.observations[2].values.backupStatus, "3");
  assert.deepEqual(result.report.safety, {
    methodsUsed:["GET"],
    routerGetsAttempted:7,
    writesAttempted:0,
    firmwarePostsAttempted:0,
    requestBodiesPresent:false,
    automaticRetries:0,
    redirectsAllowed:false,
    flashAllowed:false
  });
  assert.deepEqual(calls, ["login","status1",...app.firmwareStatusRouteDefinitions().map(route => route.id)]);
  assert.doesNotMatch(result.text, /secret-header|secret-cookie/);
  assert.match(result.text, /RestoreFw upload POST was not sent/);
  assert.match(result.text, /cannot populate the destructive transport allowlist/);
});

test("firmware transport probe keeps flash locked when a GET model is unavailable", async () => {
  const result = await app.runFirmwareTransportProbe({
    stage0,
    createAppSession: async () => ({ appLogin:{} }),
    getAppStatus: async () => ({ text:STATUS, statusCode:200, responseClass:"xml-response" }),
    readRoute: async (_session, route) => {
      if (route.id === "restore-status-direct") throw new Error("network connection lost");
      const text = route.schema === "restore" ? RESTORE : UPGRADE;
      return { text, statusCode:200, responseClass:"xml-response", redirectCount:0 };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.readSideComplete, false);
  assert.equal(result.flashAllowed, false);
  assert.equal(result.report.safety.firmwarePostsAttempted, 0);
  assert.equal(result.report.observations.find(item => item.id === "restore-status-direct").ok, false);
});

test("dashboard dispatches the GET-only firmware probe without dangerous confirmation", async () => {
  const guard = () => app.createInFlightGuard();
  const web = { async evaluateJavaScript(){ return null; } };
  let probes = 0;
  const dispatcher = app.createDashboardDispatcher({}, {sms:{messages:[]}}, web, {
    smsGuard:guard(), refreshGuard:guard(), powerGuard:guard(), firmwareGuard:guard()
  }, {
    runFirmwareTransportProbe:async()=>{probes++;return {ok:true,readSideComplete:true,flashAllowed:false};}
  });
  const response = await dispatcher({id:"fw-read-1",action:"firmwareTransportProbe",params:{}});
  assert.equal(response.ok, true);
  assert.equal(response.result.flashAllowed, false);
  assert.equal(probes, 1);
});
