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
    softwareRevision: "a".repeat(40),
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
  assert.match(html, /const softwareRevision=value\('#deviceSoftwareRevision','—'\)/);
  assert.match(html, /<span>APN<\/span><b>'\+esc\(apn\)/);
  assert.match(html, /data-settings-preflight/);
  assert.match(html, /data-settings-app-auth/);
  assert.match(html, /data-settings-firmware-canary/);
  assert.match(html, /data-settings-last-power/);
});

test("client uses configured poll interval and renders a copyable redacted preflight report", () => {
  const html = ui.buildHtml(model({ available: false, reason: "Locked", actions: {} }));
  assert.match(html, /function pollMs\(\)/);
  assert.match(html, /state\.next=Date\.now\(\)\+pollMs\(\)/);
  assert.match(html, /command\('safePreflight',\{\}\)/);
  assert.match(html, /Writes attempted: 0\. Flash allowed: false\./);
});

test("power result keeps redacted diagnostics visible and copyable", () => {
  const html = ui.buildHtml(model({ available: true, reason: "Exact profile matched", actions: { reboot:true, powerOff:true } }));
  assert.match(html, /error\.diagnostics=String\(r\.diagnostics\|\|""\)/);
  assert.match(html, /function powerReport\(/);
  assert.match(html, /textareaId=isPower\?'powerReport':'diagnosticReport'/);
  assert.match(html, /copyId=isPower\?'copyPowerReport':'copyDiagnosticReport'/);
  assert.match(html, /result&&result\.diagnostics/);
  assert.match(html, /e&&e\.diagnostics/);
  assert.match(html, /id="lastPowerReportBtn"/);
  assert.match(html, /command\('lastPowerReport',\{\}\)/);
  assert.match(html, /Copy THIS power report/);
  assert.match(html, /let powerPending=false/);
  assert.match(html, /if\(powerPending\)return toast\('A power request is already in progress'\)/);
  assert.match(html, /\$\$\('\[data-reboot\],\[data-off\]'\)/);
});

test("software build and GET-only APP auth probe are visible and copyable", () => {
  const html = ui.buildHtml(model({ available:true, reason:"Exact profile matched", actions:{reboot:true,powerOff:true} }));
  assert.match(html, /id="deviceFirmware">2\.5\.94_release/);
  assert.match(html, /id="deviceSoftware">3\.1\.5-ui2/);
  assert.match(html, /id="deviceSoftwareRevision" title="a{40}">a{12}<\/b>/);
  assert.match(html, /id="appAuthProbe">Run APP auth probe \(GET only\)/);
  assert.match(html, /command\('appAuthProbe',\{\}\)/);
  assert.match(html, /Writes attempted: 0\. Destructive attempts: 0\./);
  assert.match(html, /Copy diagnostic report/);
});

test("WEBUI Canary Logs remains audit-only while Stage 0 restore is visibly locked", () => {
  const html = ui.buildHtml(model({ available:false, reason:"Locked", actions:{} }));
  assert.match(html, /id="firmwareTransportProbe">Capture firmware status contract \(GET only\)/);
  assert.match(html, /command\('firmwareTransportProbe',\{\}\)/);
  assert.match(html, /Restore upload remains locked/);
  assert.match(html, /id="firmwareCanaryValidate">Audit WEBUI Canary Logs r1 \(no flash\)/);
  assert.match(html, /command\('firmwareCanaryValidate',\{\}\)/);
  assert.match(html, /Flash remains locked/);
  assert.match(html, /id="firmwareFlash" disabled aria-disabled="true"[^>]*>Firmware restore locked · recovery \+ contract/);
  assert.match(html, /command\('firmwareFlash',\{confirmed:true\}\)/);
  assert.match(html,/id="firmwareJournalBtn">Stage 0 journal/);
  assert.match(html,/command\('firmwareJournalStatus',\{\}\)/);
  assert.match(html,/command\('firmwareJournalAcknowledge',\{confirmed:true\}\)/);
  assert.match(html, /ONE POST/);
  assert.match(html, /NO automatic retry/);
  assert.match(html, /@media\(max-width:560px\)\{[\s\S]*?\.dashboard-grid\{grid-template-columns:minmax\(0,1fr\)/);
  assert.match(html, /\.sheet button\{[^}]*white-space:normal;overflow-wrap:anywhere/);
  assert.match(html, /\.device-row b\{[^}]*overflow-wrap:anywhere/);
});

test("missing dashboard revision is displayed explicitly as unknown", () => {
  const value=model({available:false,reason:"Unavailable",actions:{}});
  delete value.softwareRevision;
  const html=ui.buildHtml(value);
  assert.match(html,/id="deviceSoftwareRevision" title="unknown">unknown<\/b>/);
});

test("router availability starts and refreshes as one consistent state", () => {
  const offline=model({available:false,reason:"Offline",actions:{}});
  offline.errors={status:"network connection lost",statusRequest:true};
  const html=ui.buildHtml(offline);
  assert.match(html,/id="onlineState"[^>]*>Offline<\/div>/);
  assert.match(html,/id="connectionStatus"[^>]*>Unavailable<\/div>/);
  assert.match(html,/id="routerReachability"[^>]*>Unreachable<\/b>/);

  const script=ui.buildHtml(model({available:true,reason:"Exact profile matched",actions:{reboot:true,powerOff:true}}));
  assert.match(script,/const statusFailed=!!\(p\.errors&&p\.errors\.statusRequest\)/);
  assert.match(script,/setRouterAvailability\(!statusFailed\)/);
  assert.match(script,/function setRouterAvailability\(available\)[\s\S]*?Online[\s\S]*?Connected[\s\S]*?Reachable/);
  const guarded=script.match(/if\(!statusFailed\)\{[\s\S]*?\n    \}/);
  assert.ok(guarded,"live measurements must be guarded by successful status polling");
  for(const field of ["state.data.network.dbm=p.dbm","state.data.battery.percent=p.batteryPercent","#trafficDown","updatePanel(p)"]){
    assert.match(guarded[0],new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
});

test("every v2 control is either actionable or rendered as non-interactive status", () => {
  const html=fixes.enhanceHtml(ui.buildHtml(model({available:true,reason:"Exact profile matched",actions:{reboot:true,powerOff:true}})),model({}));
  assert.doesNotMatch(html,/<button class="filter-pill"/);
  assert.match(html,/<span class="filter-pill">Inbox/);
  assert.match(html,/data-cap-row="cellularControl" role="button" tabindex="0"/);
  assert.match(html,/\$\$\('\[data-cap-row\]'\)\.forEach\(row=>\{row\.onclick=/);
  assert.match(html,/event\.key==='Enter'\|\|event\.key===' '/);
  assert.match(html,/\$\('#detectAll'\)[\s\S]*?command\('detectExperimental'/);
  assert.match(html,/data-settings-capabilities[\s\S]*?d\.click\(\)/);
  assert.match(html,/\$\('#safePreflight'\)\.onclick/);
  assert.match(html,/\$\('#appAuthProbe'\)\.onclick/);
  assert.match(html,/\$\('#firmwareTransportProbe'\)\.onclick/);
  assert.match(html,/\$\('#firmwareCanaryValidate'\)\.onclick/);
  assert.match(html,/\$\('#firmwareFlash'\)\.onclick/);
  assert.match(html,/\$\('#firmwareJournalBtn'\)\.onclick/);
  assert.match(html,/\$\('#lastPowerReportBtn'\)\.onclick/);
  assert.match(html,/\$\('#newSms'\)\.onclick/);
  assert.match(html,/\$\('#refreshNow'\)\.onclick=refresh/);
  assert.match(html,/\$\('#diagRefresh'\)\.onclick=refresh/);
  assert.match(html,/\$\('#pauseBtn'\)\.onclick/);
  assert.match(html,/data-reboot[\s\S]*?power\('reboot'\)/);
  assert.match(html,/data-off[\s\S]*?power\('powerOff'\)/);
});

test("SMS send and verified delete avoid redundant full-history reloads", () => {
  const html=ui.buildHtml(model({available:false,reason:"Locked",actions:{}}));
  assert.doesNotMatch(html,/command\('refreshSms'/);
  assert.match(html,/const result=await command\('deleteSms',\{id,confirmed:true\}\);if\(result&&result\.history\)applySms\(result\.history\)/);
  assert.doesNotMatch(html,/command\('deleteSms'[\s\S]{0,220}await refresh\(\)/);
  assert.match(html,/const result=await command\('sendSms',\{to,text\}\);if\(result&&result\.ok===false\)throw new Error/);
  assert.match(html,/result&&result\.historyWarning\?'SMS sent; history refresh failed':'SMS sent'/);
});

test("state-changing commands stay single-flight while the native result is pending", () => {
  const html=ui.buildHtml(model({available:false,reason:"Locked",actions:{}}));
  assert.match(html,/const nonRepeatableActions=new Set\(\['sendSms','deleteSms','ussd','firmwareTransportProbe','firmwareCanaryValidate','firmwareFlash','firmwareJournalAcknowledge','deviceAccess','cellularReconnect','cellularMode','resetTraffic','reboot','powerOff'\]\)/);
  assert.match(html,/state\.mutationPending\.has\(key\)[\s\S]*?it was not sent again/);
  assert.match(html,/if\(key\)\{toast\('Still waiting for the router; do not repeat the action'\);return;\}/);
  assert.match(html,/if\(p\.mutationKey\)state\.mutationPending\.delete\(p\.mutationKey\)/);
});

test("cellular writes are fail-closed until explicitly confirmed writable", () => {
  const html=ui.buildHtml(model({available:false,reason:"Locked",actions:{}}));
  assert.match(html,/kind==='cellularControl'&&value\.state==='available'&&value\.supported===true&&value\.readOnly===false/);
});

test("the page queues commands before Scriptable finishes native channel registration", () => {
  const html=ui.buildHtml(model({available:false,reason:"Locked",actions:{}}));
  assert.match(html,/if\(!Array\.isArray\(window\.__zmiCommandQueue\)\)window\.__zmiCommandQueue=\[\]/);
  assert.match(html,/window\.__zmiCommandListenerInstalled=true/);
  const source=require("node:fs").readFileSync(require.resolve("../scriptable.js"),"utf8");
  assert.match(source,/if\(!Array\.isArray\(window\.__zmiCommandQueue\)\)window\.__zmiCommandQueue=\[\]/);
  assert.match(source,/if\(window\.__zmiCommandListenerInstalled!==true\)/);
});

test("diagnostic refresh updates current overview values and the Logs tab", () => {
  const html=fixes.enhanceHtml(ui.buildHtml(model({available:false,reason:"Locked",actions:{}})),model({}));
  assert.match(html,/id="diagnosticLog"/);
  assert.match(html,/const log=\$\('#diagnosticLog'\)/);
  for(const target of ["#band","#rsrp","#rsrq","#sinr","#headerSignal"]){
    assert.match(html,new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  }
  assert.match(html,/Object\.entries\(state\.data\.errors\|\|\{\}\)/);
  assert.match(html,/Router status request failed/);
});

test("Logs tab exposes full technical router events and opt-in live Scriptable streaming", () => {
  const html=fixes.enhanceHtml(ui.buildHtml(model({available:false,reason:"Locked",actions:{}})),model({}));
  for(const id of ["routerEventLog","liveDiagnosticLog","liveLogStatus","liveLogPause","liveLogRefresh","liveLogClear","liveLogCopy"]){
    assert.match(html,new RegExp(`id="${id}"`));
  }
  assert.match(html,/window\.zmiSetLogsVisible\(name==='logs'\)/);
  assert.match(html,/if\(state\.logPending\|\|state\.logPaused\|\|!state\.logsVisible\)return/);
  assert.match(html,/command\('diagnosticLogSnapshot',\{after:state\.logCursor,limit:200\}\)/);
  assert.match(html,/setInterval\(\(\)=>\{if\(state\.logsVisible&&!state\.logPaused\)refreshLiveLog\(\)\},1500\)/);
  assert.match(html,/command\('copyDiagnosticLog',\{\}\)/);
  assert.match(html,/state\.liveEvents=\[\]/);
  assert.match(html,/renderRouterLog\(d\.routerLog\|\|\{\}\)/);
  assert.match(html,/Full PDP and Wi-Fi session details/);
  assert.match(html,/SMS hidden/);
});
