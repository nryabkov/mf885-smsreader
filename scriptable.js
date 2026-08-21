// ZMI MF855/MF885 dashboard: all SMS, new-message polling, network, battery,
// traffic, power controls, and experimental USSD support.
// Scriptable for iPhone

let ROUTER_HOST = "192.168.21.1";
const USERNAME = "admin";
let PASSWORD = "zimifi";
let ussdModule = null;
let deviceAccessModule = null;
let telnetControlModule = null;
let cellularControlModule = null;
let apiContractModule = null;
let powerCompatibilityModule = null;
let powerStatusModule = null;
let readOnlyPreflightModule = null;
let engineerParameterModule = null;
let cellularDiagnosticsModule = null;
let firmwareStage0Module = null;
let firmwareRestoreDryRunModule = null;
let ACTIVE_POWER_PROFILE = { id: "unavailable", supported: false, commands: {}, reason: "Live device identity has not been read." };
if (typeof require === "function") {
  cellularDiagnosticsModule = require("./modules/cellular-diagnostics.js");
  powerCompatibilityModule = require("./modules/power-compatibility.js");
  powerStatusModule = require("./modules/power-status.js");
  readOnlyPreflightModule = require("./modules/read-only-preflight.js");
  firmwareStage0Module = require("./modules/firmware-stage0.js");
  firmwareRestoreDryRunModule = require("./modules/firmware-restore-dry-run.js");
}

const XML_REQUEST_PATH = "/xml_action.cgi";
const XML_DIGEST_URI = "/cgi/xml_action.cgi";
const APP_CLIENT = "APP";
let APP_NONCE_COUNT = 2;
let ACTIVE_XML_REQUEST_PATH = XML_REQUEST_PATH;

let POLL_SECONDS = 30;
const SMS_PAGE_SIZE = 10;
const SMS_MAX_PAGES = 500;
const USSD_RESPONSE_POLLS = 8;
let DEBUG = true;
let DEBUG_SENSITIVE_PAYLOADS = false;
const LOGGED_FIRMWARE_MISMATCHES = new Set();
let DEBUG_REQUEST_SEQUENCE = 0;
const DEBUG_CHUNK_SIZE = 900;
const DEBUG_MAX_CHUNKS = 4;
const DEBUG_EVENT_LIMIT = 400;
let DEBUG_EVENT_SEQUENCE = 0;
const DEBUG_EVENTS = [];
const TRANSLATE_ENDPOINT = ""; // LibreTranslate-compatible endpoint, e.g. https://libretranslate.example/translate
const CAPABILITY_NAMES = { cellularControl: "Cellular controls", ussd: "USSD", deviceAccess: "Device access" };
const CAPABILITY_STATE_LABELS = { unchecked: "Not checked", detecting: "Detecting…", available: "Available", unavailable: "Unavailable", error: "Status unavailable" };

const QUERY = typeof args !== "undefined" && args.queryParameters
  ? args.queryParameters
  : {};
const ACTION = String(QUERY.action || "dashboard");
const INITIAL_TAB = String(QUERY.tab || "sms") === "router" ? "router" : "sms";
let SOFTWARE_VERSION = "";
let SOFTWARE_REVISION = "";
let LAST_POWER_REPORT_MEMORY = "";
const LAST_POWER_REPORT_SCHEMA = 1;
let FIRMWARE_EXCLUSIVE = false;

/**
 * Run the dashboard with settings supplied by loader.js.
 * Keeping configuration at this boundary lets the loader store credentials in
 * Keychain instead of writing them into the downloaded application module.
 */
async function run(options = {}) {
  configureDebug(options);
  SOFTWARE_VERSION = String(options.softwareVersion || "").trim();
  SOFTWARE_REVISION = String(options.softwareRevision || "").trim();
  if (options.ip) ROUTER_HOST = String(options.ip);
  if (options.password) PASSWORD = String(options.password);
  POLL_SECONDS = Math.max(15, Math.min(300, Number(options.pollSeconds) || 30));
  if (!options.moduleDirectory) {
    throw new Error("The application module directory was not provided by the loader.");
  }
  ussdModule = importModule(`${options.moduleDirectory}/modules/ussd.js`);
  deviceAccessModule = importModule(`${options.moduleDirectory}/modules/device-access.js`);
  telnetControlModule = importModule(`${options.moduleDirectory}/modules/telnet-control.js`);
  cellularControlModule = importModule(`${options.moduleDirectory}/modules/cellular-control.js`);
  apiContractModule = importModule(`${options.moduleDirectory}/modules/api-contract.js`);
  powerCompatibilityModule = importModule(`${options.moduleDirectory}/modules/power-compatibility.js`);
  powerStatusModule = importModule(`${options.moduleDirectory}/modules/power-status.js`);
  readOnlyPreflightModule = importModule(`${options.moduleDirectory}/modules/read-only-preflight.js`);
  engineerParameterModule = importModule(`${options.moduleDirectory}/modules/engineer-parameter.js`);
  cellularDiagnosticsModule = importModule(`${options.moduleDirectory}/modules/cellular-diagnostics.js`);
  firmwareStage0Module = importModule(`${options.moduleDirectory}/modules/firmware-stage0.js`);
  firmwareRestoreDryRunModule = importModule(`${options.moduleDirectory}/modules/firmware-restore-dry-run.js`);
  ACTIVE_POWER_PROFILE = powerProfileForIdentity({});
  ACTIVE_XML_REQUEST_PATH = options.xmlRequestPath || XML_REQUEST_PATH;
  await main();
}

module.exports = { run, dashboardFlow, executePowerCommand, runReadOnlyPreflight, runAppAuthProbe, runFirmwareTransportProbe, firmwareStatusRouteDefinitions, validateFirmwareCanary, runFirmwareRestoreDryRun, runFirmwareRestore, firmwareRestoreAvailability, confirmFirmwareRestore, readFirmwareJournalStatus, acknowledgeFirmwareJournal, readLastPowerReport, rememberLastPowerReport, softwareIdentity, powerProfileForIdentity, XML_REQUEST_PATH, XML_DIGEST_URI, APP_CLIENT, xmlRequestUrl, parseDigestChallenge, authorization, authenticatedRequest, digestProof, buildAppLogin, appAuthorization, appRequestHeaders, responseCookieHeader, classifyControlResponse, assertAppLoginResponse, createAppSession, appXmlGet, submitAppPowerCommand, buildHtml, clientScript, parseCounter, formatBytes, formatDuration, parseBattery, parseNetwork, parseTraffic, parseSmsPage, parseSendResult, smsCommandState, waitForSmsCommand, sendSms, deleteSms, loadAllSms, loadRemainingSms, mergeSmsPage, inspectSmsEdges, smsEdgeFingerprint, pageMessageFingerprint, unchangedSms, batteryInlineLabel, networkProtocol, signalBarsHtml, sanitizeDiagnostics, smsSegments, webPollPayload, loadPollingSnapshot, createInFlightGuard, capabilityCacheValid, requireSuccessfulActionResult, createWebViewDispatcher, createDashboardDispatcher, validateWebViewCommand, loadModel, configureDebug, debugLog, debugXml, debugLogSnapshot, parseDetailedLogSummary, redactDebugValue, redactDebugPayload, logXmlSummary, routerAccepted, firmwareUserVersion, hardwareRevision };

function powerProfileForIdentity(identity) {
  return powerCompatibilityModule && typeof powerCompatibilityModule.resolve === "function"
    ? powerCompatibilityModule.resolve(identity || {})
    : { id: "unavailable", supported: false, commands: {}, reason: "Power compatibility module is unavailable." };
}

function configureDebug(options = {}) {
  DEBUG = options.debug !== false;
  DEBUG_SENSITIVE_PAYLOADS = options.debugSensitivePayloads === true;
  DEBUG_EVENT_SEQUENCE = 0;
  DEBUG_EVENTS.length = 0;
}

function redactDebugValue(value) {
  let text = String(value === undefined || value === null ? "" : value);
  // Preserve technical radio/network identity for diagnostics. Only message
  // material and active credentials are removed from the local log stream.
  text = text.replace(/<(content|message_content|subject|contacts|from|phone_number|sender|recipient|password|passwd|pwd|pin|puk|psk|wifi(?:_key|_password)?)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1><redacted></$1>");
  text = text.replace(/\b(Authorization|Cookie|Set-Cookie|password|passwd|pwd|token|nonce|cnonce|response)\b\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;&]+)/gi, "$1=<redacted>");
  text = text.replace(/([?&](?:token|password|passwd|pwd|nonce|cnonce|response)=)[^&#]*/gi, "$1<redacted>");
  text = text.replace(/(?:\+\d[\d ()-]{6,}\d)/g, "<redacted-phone>");
  return text.replace(/[\r\n]+/g, " ");
}
function redactDebugPayload(payload) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== "object") return redactDebugValue(payload);
  const blocked = /^(?:authorization|cookie|set[_-]?cookie|password|passwd|pwd|token|nonce|cnonce|response|pin|puk|psk|wifi[_-]?(?:key|password)|content|message[_-]?content|subject|contacts|from|phone(?:_number)?|sender|recipient)$/i;
  const copy = Array.isArray(payload) ? [] : {};
  Object.keys(payload).forEach(key => { copy[key] = blocked.test(key) ? "<redacted>" : redactDebugPayload(payload[key]); });
  return copy;
}
function debugLog(event, data) {
  if (!DEBUG) return;
  const safe = redactDebugPayload(data || {});
  const safeEvent = redactDebugValue(event).slice(0, 180);
  const fields = Object.keys(safe).map(key => `${key}=${typeof safe[key] === "object" ? JSON.stringify(safe[key]) : safe[key]}`).join(" ");
  DEBUG_EVENTS.push({ seq:++DEBUG_EVENT_SEQUENCE, at:Date.now(), event:safeEvent, data:safe });
  if (DEBUG_EVENTS.length > DEBUG_EVENT_LIMIT) DEBUG_EVENTS.splice(0, DEBUG_EVENTS.length - DEBUG_EVENT_LIMIT);
  console.log(`[ZMI DEBUG]${safeEvent ? `[${safeEvent}]` : ""}${fields ? ` ${fields}` : ""}`);
}
function debugLogSnapshot(after = 0, limit = 200) {
  const cursor = Number.isFinite(Number(after)) ? Math.max(0, Math.floor(Number(after))) : 0;
  const count = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(400, Math.floor(Number(limit)))) : 200;
  const available = DEBUG_EVENTS.filter(entry => entry.seq > cursor);
  const events = available.slice(-count).map(entry => ({
    seq:entry.seq,
    at:entry.at,
    event:redactDebugValue(entry.event),
    data:redactDebugPayload(entry.data)
  }));
  return {
    schema:1,
    generatedAt:Date.now(),
    enabled:DEBUG,
    firstAvailable:DEBUG_EVENTS.length ? DEBUG_EVENTS[0].seq : DEBUG_EVENT_SEQUENCE,
    nextCursor:events.length ? events[events.length - 1].seq : cursor,
    dropped:(DEBUG_EVENTS.length>0&&cursor<DEBUG_EVENTS[0].seq-1)||available.length > events.length,
    events
  };
}
function debugXml(event, xml) {
  if (!DEBUG) return;
  if (/message|sms/i.test(String(event)) || /<(?:content|message_content|subject|contacts|from|phone_number|sender|recipient)\b/i.test(String(xml||""))) {
    debugLog(event, { omitted:"SMS payload permanently hidden", bytes:String(xml||"").length, structure:xmlStructure(xml) });
    return;
  }
  const safe = redactDebugValue(xml);
  const total = Math.min(DEBUG_MAX_CHUNKS, Math.max(1, Math.ceil(safe.length / DEBUG_CHUNK_SIZE)));
  for (let index=0; index<total; index++) debugLog(event, { part:`${index+1}/${total}`, truncated:safe.length > DEBUG_CHUNK_SIZE * DEBUG_MAX_CHUNKS, xml:safe.slice(index*DEBUG_CHUNK_SIZE,(index+1)*DEBUG_CHUNK_SIZE) });
}
function xmlStructure(xml) {
  const source=String(xml||"");
  const cellular=["network_type","network_mode","network_name","signalbar","signal_strength","rssi","rsrp","operator","plmn"].filter(name=>new RegExp(`<${name}\\b`,"i").test(source));
  return { sections:Array.from(new Set(Array.from(source.matchAll(/<RGW[^>]*>\s*(?:<[^>]+>\s*)?<([A-Za-z_][\w.-]*)\b/gi),m=>m[1]))), WanStatistics:/<WanStatistics\b/i.test(source), batteryinfo:/<batteryinfo\b/i.test(source), cellularFields:cellular };
}
function logXmlSummary(operation, xml) { const summary=xmlStructure(xml); debugLog(`${operation}:xml-summary`,summary); return summary; }
function firmwareVersion(xml) { return firstText(xml, ["version_num"]) || ""; }
function firmwareUserVersion(value) {
  const firmware=String(value||"").trim();
  const release=firmware.match(/^(.+?)_release(?:_|$)/i);
  return release ? release[1] : firmware;
}
function hardwareRevision(xml) { return firstText(xml, ["revision","hardware_version","hardware_ver","hw_version"]) || ""; }

async function main() {
  try {
    const auth = await getAuthChallenge();
    await login(auth);
    return await dashboardFlow(auth, null, INITIAL_TAB);
  } catch (error) {
    console.error(String(error));
    await showMessage("ZMI error", cleanError(error), "⚠️");
  }
}

// Application flows
function normalizeNotice(notice) {
  if (!notice) return null;
  if (typeof notice === "object") return { text: String(notice.text || ""), type: ["success", "warning", "error"].includes(notice.type) ? notice.type : "success", diagnostics: sanitizeDiagnosticOutput(notice.diagnostics || "") };
  return { text: String(notice), type: "success", diagnostics: "" };
}
function successNotice(text, diagnostics = "") { return { text, type: "success", diagnostics }; }
function warningNotice(text, diagnostics = "") { return { text, type: "warning", diagnostics }; }
function errorNotice(text, diagnostics = "") { return { text, type: "error", diagnostics }; }

function scriptableSleep(milliseconds) {
  return new Promise(resolve => Timer.schedule(milliseconds, false, resolve));
}

async function dashboardFlow(auth, notice = "", tab = "sms", overrides = {}) {
  const dependencies = {
    loadModel, buildHtml, WebView: () => new WebView(), showMessage,
    createDispatcher: createDashboardDispatcher, loadRemainingSms,
    sleep: scriptableSleep,
    ...overrides
  };
  const model = await dependencies.loadModel(auth);
  model.notice = normalizeNotice(notice);
  model.tab = tab;
  let html;
  try {
    html = dependencies.buildHtml(model);
    validateDashboardHtml(html);
  } catch (error) {
    console.error(`ZMI dashboard HTML build stage failed: ${cleanError(error)}`);
    await dependencies.showMessage("ZMI dashboard", "The dashboard could not be built.", "⚠️");
    return;
  }
  const web = dependencies.WebView();
  try {
    await web.loadHTML(html);
  } catch (error) {
    console.error(`ZMI dashboard WebView loadHTML stage failed: ${cleanError(error)}`);
    await dependencies.showMessage("ZMI dashboard", "The dashboard could not be opened.", "⚠️");
    return;
  }
  let presented;
  try {
    presented = web.present();
  } catch (error) {
    console.error(`ZMI dashboard WebView present stage failed: ${cleanError(error)}`);
    await dependencies.showMessage("ZMI dashboard", "The dashboard could not be displayed.", "⚠️");
    return;
  }
  let presentationClosed = false;
  const presentationResult = Promise.resolve(presented).then(() => { presentationClosed = true; return { closed: true }; }, error => { presentationClosed = true; return { closed: true, error }; });
  // Let Scriptable enter its native presentation before installing a
  // completion callback while present() itself is being started.
  await dependencies.sleep(0);
  try {
    await registerWebViewCommandChannel(web);
  } catch (error) {
    console.warn(`ZMI dashboard WebView command channel registration failed: ${cleanError(error)}`);
    return;
  }
  const smsGuard = createInFlightGuard();
  const refreshGuard = createInFlightGuard();
  const powerGuard = createInFlightGuard();
  // History is deliberately sequential: several MF885 firmwares lose requests
  // when two message pages are fetched concurrently.
  if (model.sms.loading) smsGuard.run(async () => {
    try {
      model.sms = await dependencies.loadRemainingSms(auth, model.sms, async partial => {
        await applyWebView(web, "zmiApplySmsHistory", partial);
      });
      await applyWebView(web, "zmiApplySmsHistory", model.sms);
    } catch (error) {
      model.sms.warning = cleanError(error);
      await applyWebView(web, "zmiApplySmsHistory", model.sms);
    }
  });
  const dispatcher = dependencies.createDispatcher(auth, model, web, { smsGuard, refreshGuard, powerGuard });
  while (true) {
    try {
      const event = await Promise.race([nextWebViewCommand(web, dependencies.sleep, () => presentationClosed).then(message => ({ message })), presentationResult]);
      if (event.closed) {
        // A rejected presentation may occur after the WebView became visible;
        // do not cover it with a native Alert.
        if (event.error) console.error(`ZMI dashboard WebView present stage failed: ${cleanError(event.error)}`);
        break;
      }
      if (event.message) await dispatcher(event.message);
    } catch (error) {
      console.warn(`WebView channel: ${cleanError(error)}`);
    }
  }
}

function validateDashboardHtml(html) {
  if (typeof html !== "string" || !html.trim()) throw new Error("buildHtml returned empty HTML");
  if (!/<main(?:\s|>)/i.test(html)) throw new Error("dashboard HTML has no <main> element");
  if (!/<section[^>]*class=["'][^"']*\btab\b[^"']*\bactive\b[^"']*["']/i.test(html)) throw new Error("dashboard HTML has no active tab section");
}

async function loadPollingSnapshot(auth, currentSms) {
  const model={sms:currentSms||emptySms(),traffic:{},battery:{},network:{},cellularDiagnostics:{},errors:{},loadedAt:Date.now(),pollSeconds:POLL_SECONDS,powerControls:powerCompatibilityModule&&powerCompatibilityModule.publicState?powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE):{available:false,reason:"Power compatibility module is unavailable.",actions:{}},firmwareRestore:firmwareRestoreAvailability()};
  let status = null;
  try {
    status=await getStatus(auth);
    const identity={model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status)};
    model.actualModel=identity.model; model.actualRevision=identity.hardware; model.actualFirmware=identity.firmware;
    model.traffic=parseTraffic(status); model.battery=parseBattery(status,identity); model.network=parseNetwork(status);
    ACTIVE_POWER_PROFILE=powerProfileForIdentity(identity);
    model.powerControls=powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE);
  }
  catch(error){
    ACTIVE_POWER_PROFILE=powerProfileForIdentity({});
    model.powerControls=powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE);
    model.errors.status=cleanError(error);
    model.errors.statusRequest=true;
  }
  model.cellularDiagnostics = await loadCellularDiagnostics(auth, status);
  if (status && model.cellularDiagnostics.values) model.network=parseNetwork(model.cellularDiagnostics);
  try { const edges=await inspectSmsEdges(auth); if(!unchangedSms(currentSms,edges)) model.sms=await loadAllSms(auth); }
  catch(error){ model.errors.sms=cleanError(error); }
  return model;
}

function webPollPayload(model) {
  return {
    loadedAt: model.loadedAt,
    smsCount: model.sms && model.sms.messages ? model.sms.messages.length : 0,
    smsFingerprint: model.sms && model.sms.fingerprint || "",
    smsMessages: model.sms && model.sms.messages || [],
    smsTotalMessages: model.sms && model.sms.totalMessages,
    networkMode: model.network && (model.network.mode || model.network.networkError) || "Unknown",
    networkGeneration: model.network && model.network.generation || "Unknown",
    preferredMode: model.network && model.network.preferredMode || "Unknown",
    networkSource: model.network && model.network.networkSource || null,
    networkRawCode: model.network && model.network.rawMode || null,
    networkConflict: !!(model.network && model.network.networkConflict),
    dbm: model.network && model.network.dbm,
    lac: model.network && model.network.lac || null,
    cellId: model.network && model.network.cellId || null,
    pci: model.network && model.network.pci || null,
    batteryInline: batteryInlineLabel(model.battery || {}),
    batteryStatus: model.battery && model.battery.status || "Unknown",
    batteryPowerStatus: model.battery && (model.battery.powerStatus || model.battery.state) || "unknown",
    chargerConnected: !!(model.battery && (model.battery.inputConnected || model.battery.chargerConnected)),
    usbHostActive: !!(model.battery && (model.battery.usbOutputActive || model.battery.usbHostActive)),
    batteryChargerCurrent: model.battery && model.battery.chargerCurrent,
    batteryOutputCurrent: model.battery && model.battery.outputCurrent,
    batteryPercent: model.battery && model.battery.percent,
    operator: model.network && model.network.operator || "",
    roaming: model.network && model.network.fields && model.network.fields.roaming || null,
    signalRaw: model.network && model.network.signalRaw || null,
    trafficTotal: formatBytes(model.traffic && model.traffic.total),
    trafficDown: formatBytes(model.traffic && model.traffic.download),
    trafficUp: formatBytes(model.traffic && model.traffic.upload),
    connectionTime: formatDuration(model.traffic && model.traffic.sessionSeconds),
    pollSeconds: Number(model.pollSeconds) || POLL_SECONDS,
    powerControls: model.powerControls || (powerCompatibilityModule && powerCompatibilityModule.publicState ? powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE) : { available:false, reason:"Power compatibility module is unavailable.", actions:{} }),
    cellularDiagnostics: model.cellularDiagnostics || {},
    errors: model.errors || {}
  };
}

async function loadModel(auth) {
  ACTIVE_POWER_PROFILE = powerProfileForIdentity({});
  const model = {
    sms: emptySms(), traffic: {}, battery: {}, network: {}, cellularDiagnostics: {}, ussd: {}, deviceAccess: {}, cellularControl: {},
    errors: {}, notice: "", tab: "sms", loadedAt: Date.now(), softwareVersion: SOFTWARE_VERSION, softwareRevision: SOFTWARE_REVISION, pollSeconds: POLL_SECONDS,
    powerControls: powerCompatibilityModule && powerCompatibilityModule.publicState ? powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE) : { available:false, reason:ACTIVE_POWER_PROFILE.reason, actions:{} },
    firmwareRestore: firmwareRestoreAvailability()
  };
  let status = null;
  const initial = await Promise.allSettled([getStatus(auth), getSmsPage(auth, 1)]);
  debugLog("loadModel:allSettled", { status1:initial[0].status, message:initial[1].status });
  try {
    if (initial[0].status === "rejected") throw initial[0].reason;
    status = initial[0].value;
    const actualFirmware=firmwareVersion(status);
    const actualModel=firstText(status,["model","model_name","product_name"]);
    model.actualFirmware=actualFirmware;
    model.actualFirmwareVersion=firmwareUserVersion(actualFirmware);
    model.actualModel=actualModel;
    model.actualRevision=hardwareRevision(status);
    ACTIVE_POWER_PROFILE=powerProfileForIdentity({model:actualModel,hardware:model.actualRevision,firmware:actualFirmware});
    model.powerControls=powerCompatibilityModule.publicState(ACTIVE_POWER_PROFILE);
    model.traffic = sectionWithError(parseTraffic(status), "trafficError", "status1 has no WanStatistics data");
    model.battery = sectionWithError(parseBattery(status, { model:actualModel, hardware:model.actualRevision, firmware:actualFirmware }), "batteryError", "status1 has no batteryinfo data");
    model.network = sectionWithError(parseNetwork(status), "networkError", "status1 has no cellular network data");
    debugLog("network:normalized",{firmware:actualFirmware,sys_mode:model.network.raw&&model.network.raw.sys_mode,sys_submode:model.network.raw&&model.network.raw.sys_submode,ConnType:model.network.raw&&model.network.raw.ConnType,proto:model.network.raw&&model.network.raw.proto,source:model.network.networkSource,currentRat:model.network.mode,reason:model.network.networkConflict?"conflict":model.network.generation==="Unknown"?"unknown":null});
  } catch (error) {
    model.errors.status = cleanError(error);
    model.errors.statusRequest = true;
  }
  // Expensive diagnostics and capability probes are not part of first paint.
  try {
    if (initial[1].status === "rejected") throw initial[1].reason;
    model.sms = mergeSmsPage(emptySms(), parseSmsPage(initial[1].value, 1));
    model.sms.loading = true;
  } catch (error) { model.sms.loading = false; model.errors.smsError = cleanError(error); model.errors.sms = model.errors.smsError; }
  model.ussd = readCapabilityCache("ussd") || { state: "unchecked", detail: "Not checked" };
  model.deviceAccess = readCapabilityCache("deviceAccess") || { state: "unchecked", detail: "Run Detect first", capabilities: deviceAccessModule && deviceAccessModule.capabilities ? deviceAccessModule.capabilities() : [] };
  model.cellularControl = readCapabilityCache("cellularControl") || { state: "unchecked", detail: "Not checked" };
  debugLog("loadModel:complete", { smsCount:model.sms.messages.length, traffic:!!model.traffic.hasData, battery:!!model.battery.hasData, network:!!model.network.hasData, errorKeys:Object.keys(model.errors) });
  model.diagnosticLog = debugLogSnapshot(0, 120);
  return model;
}

async function sendFlow(auth) {
  const inlineTo = String(QUERY.to || "").trim();
  const inlineText = String(QUERY.text || "").trim();
  const inlineTab = INITIAL_TAB || "sms";
  if (inlineTo || inlineText) {
    if (!inlineTo) return dashboardFlow(auth, errorNotice("Enter a recipient number."), inlineTab);
    if (!inlineText) return dashboardFlow(auth, errorNotice("Enter SMS text."), inlineTab);
    if (inlineText.length > 1000) return dashboardFlow(auth, errorNotice("SMS text is too long."), inlineTab);
    const result = parseSendResult(await sendSms(auth, inlineTo, inlineText));
    if (!result.ok) return dashboardFlow(auth, errorNotice(`SMS send failed: ${result.message}`), inlineTab);
    return dashboardFlow(auth, successNotice(`SMS sent to ${inlineTo}`), inlineTab);
  }
  return dashboardFlow(auth, warningNotice("Open the Compose SMS form."), "sms");
}

async function deleteFlow(auth) {
  const id = String(QUERY.id || "").trim();
  if (!id) return dashboardFlow(auth, errorNotice("SMS identifier was not found."), "sms");
  if (String(QUERY.confirm || "") !== "1") return dashboardFlow(auth, warningNotice("Confirm SMS deletion in the message card."), "sms");

  const result = await deleteSms(auth, id);
  if (!result.ok) return dashboardFlow(auth, errorNotice(`SMS deletion failed: ${result.message}`), "sms");
  return dashboardFlow(auth, successNotice("SMS deleted."), "sms");
}

async function ussdFlow(auth) {
  const capability = await detectUssdCapability(auth);
  const inlineCode = String(QUERY.code || "").trim();
  const inlineTab = INITIAL_TAB || "sms";
  if (inlineCode) {
    if (inlineCode.length > 128) return dashboardFlow(auth, errorNotice("USSD code is too long."), inlineTab);
    const result = await executeUssd(auth, capability, inlineCode);
    const detail = DEBUG && result.diagnostics ? `${result.message} (${result.diagnostics})` : result.message;
    return dashboardFlow(auth, { text: `${result.title || "USSD"}: ${detail}`, type: result.ok ? "success" : "error" }, inlineTab);
  }
  return dashboardFlow(auth, warningNotice("Open the Dial USSD form."), "sms");
}

async function deviceAccessFlow(auth) {
  const capability = await detectDeviceAccess(auth);
  const actions = capability.capabilities || [];
  const actionId = String(QUERY.deviceAction || "").trim();
  const confirm = String(QUERY.confirm || "") === "1";
  const action = actions.find(item => item.id === actionId);
  if (!actionId || !action) return dashboardFlow(auth, warningNotice("Choose an experimental action in the router card."), "router");
  if (!confirm) return dashboardFlow(auth, warningNotice(`Confirm the experimental action: ${action.title}.`), "router");

  const result = await executeDeviceAccess(auth, action.id, action.id);
  const detail = DEBUG && result.diagnostics
    ? `${result.message} (${result.diagnostics})`
    : result.message;
  return dashboardFlow(auth, { text: `${result.title}: ${detail}`, type: result.ok ? "success" : "error" }, "router");
}

async function cellularReconnectFlow(auth) {
  const capability = await detectCellularControl(auth);
  if (String(QUERY.confirm || "") !== "1") {
    return dashboardFlow(auth, warningNotice("Confirm experimental cellular reconnect. Mobile internet will be temporarily unavailable."), "router");
  }
  const result = await cellularControlModule.executeReconnect(cellularControlApi(auth), capability);
  return dashboardFlow(auth, { text: `${result.title}: ${result.message}`, type: result.ok ? "success" : "error", diagnostics: result.diagnostics }, "router");
}

async function cellularModeFlow(auth) {
  const capability = await detectCellularControl(auth);
  const modeId = String(QUERY.mode || "").trim();
  const mode = cellularControlModule.modeById(modeId);
  if (!mode) return dashboardFlow(auth, errorNotice("Unknown cellular network mode."), "router");
  if (String(QUERY.confirm || "") !== "1") {
    return dashboardFlow(auth, warningNotice(`Confirm experimental cellular mode change: ${mode.title}. Mobile internet may be temporarily unavailable.`), "router");
  }
  const result = await cellularControlModule.executeSetMode(cellularControlApi(auth), capability, mode.id);
  return dashboardFlow(auth, { text: `${result.title}: ${result.message}`, type: result.ok ? "success" : "error", diagnostics: result.diagnostics }, "router");
}

async function resetTrafficFlow(auth) {
  if (String(QUERY.confirm || "") !== "1") return dashboardFlow(auth, warningNotice("Confirm WAN traffic reset."), "router");
  return dashboardFlow(auth, warningNotice("WAN statistics reset is unavailable because no universal write contract is confirmed."), "router");
  /* istanbul ignore next */
  const spec = null;
  const beforeXml = await xmlRequest(auth, "GET", "statistics");
  const before = wanCounterSnapshot(beforeXml);
  const body = `<RGW><statistics><WanStatistics><set_action>${escapeXml(spec.set_action)}</set_action><clear_cur_stat_flag>${escapeXml(spec.clear_cur_stat_flag)}</clear_cur_stat_flag></WanStatistics></statistics></RGW>`;
  const result = await writeThenVerify(auth, { model:"statistics", xml:body, verificationModel:"statistics", verify: xml => statisticsResetMatches(before, wanCounterSnapshot(xml)) });
  return dashboardFlow(auth, result.outcome === "confirmed" ? successNotice("WAN statistics reset was confirmed.") : warningNotice(`WAN statistics reset: ${result.outcome}.`), "router");
}

async function powerFlow(auth, kind) {
  if (String(QUERY.confirm || "") !== "1") return dashboardFlow(auth, warningNotice(kind === "reboot" ? "Confirm router reboot." : "Confirm router shutdown."), "router");
  try {
    if (kind !== "reboot" && kind !== "powerOff") throw new Error("Unsupported power action.");
    const result = await executePowerCommand(auth, kind);
    const text=result.outcome==="request-accepted"?"The APP-compatible request was accepted; the reboot or shutdown effect is not yet confirmed.":"The command was attempted once; delivery is unknown after connection loss.";
    return dashboardFlow(auth, warningNotice(text, result.diagnostics), "router");
  } catch(error) {
    return dashboardFlow(auth, errorNotice("Router command failed.", error.diagnostics || cleanError(error)), "router");
  }
}

function wanCounterSnapshot(xml) { return { rx: firstText(xml,["rx_byte_all"]), tx:firstText(xml,["tx_byte_all"]), used:firstText(xml,["total_used_data","total_used_all"]) }; }
function statisticsResetMatches(before, after) { return !!before && !!after && before.rx !== after.rx && before.tx !== after.tx && before.used !== after.used; }
async function writeThenVerify(auth, operation) {
  const helper = apiContractModule && apiContractModule.writeThenVerify;
  if (!helper) throw new Error("Write verification helper is unavailable");
  return helper({ ...operation, post:(model,xml,opts)=>xmlRequest(auth,"POST",model,xml,opts.retry401 !== false), get:model=>xmlRequest(auth,"GET",model,null,operation.destructive !== true), pollAvailability:async()=>{ for(let i=0;i<3;i++){ await sleep(1000); try { await getStatus(auth); return true; } catch (_) {} } return false; } });
}

function sanitizeDiagnostics(value) {
  return String(value || "")
    .replace(/(password|passwd|pwd|pin|puk|psk)([=:\s]+)[^\s&|<]+/ig, "$1$2<redacted>")
    .replace(/(response=)[0-9a-f]{16,}/ig, "$1<redacted>")
    .replace(/(authorization:\s*Digest[^\n]*)/ig, "Authorization: <redacted>")
    .replace(/(nonce|cnonce)([=:\s"]+)[^\s,&|"]+/ig, "$1$2<redacted>")
    .replace(/(cookie:|set-cookie:|x-[^:\n]*token:)[^\n]*/ig, "$1 <redacted>");
}

function sanitizeDiagnosticReport(value) {
  if (typeof value === "string") return sanitizeDiagnostics(value);
  if (Array.isArray(value)) return value.map(sanitizeDiagnosticReport);
  if (value && typeof value === "object") {
    const safe = Object.create(null);
    Object.keys(value).forEach(key => { safe[key] = sanitizeDiagnosticReport(value[key]); });
    return safe;
  }
  return value;
}

function formatDiagnosticReport(value) {
  return JSON.stringify(sanitizeDiagnosticReport(value), null, 2);
}

function sanitizeDiagnosticOutput(value) {
  const text = String(value || "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return formatDiagnosticReport(parsed);
  } catch (_) {}
  return sanitizeDiagnostics(text);
}

function softwareIdentity(overrides = {}) {
  const version = String(overrides.version || SOFTWARE_VERSION || "").trim();
  const revision = String(overrides.revision || SOFTWARE_REVISION || "").trim();
  return { version: version || "unknown", revision: revision || "unknown" };
}

function lastPowerReportKey() {
  return `zmi-last-power-report-${LAST_POWER_REPORT_SCHEMA}-${ROUTER_HOST}`;
}

function validPowerReport(value) {
  const text = String(value || "");
  if (!text || text.length > 20000) return "";
  try {
    const report = JSON.parse(text);
    if (!report || report.schema !== 1 || report.mode !== "power-command") return "";
    const safe = formatDiagnosticReport(report);
    return safe.length <= 10000 ? safe : "";
  } catch (_) { return ""; }
}

function rememberLastPowerReport(value) {
  const text = validPowerReport(value);
  if (!text) return "";
  LAST_POWER_REPORT_MEMORY = text;
  try { if (typeof Keychain !== "undefined") Keychain.set(lastPowerReportKey(), text); } catch (_) {}
  return text;
}

function readLastPowerReport() {
  try {
    if (typeof Keychain !== "undefined" && Keychain.contains(lastPowerReportKey())) {
      const stored = validPowerReport(Keychain.get(lastPowerReportKey()));
      if (stored) { LAST_POWER_REPORT_MEMORY = stored; return stored; }
    }
  } catch (_) {}
  return validPowerReport(LAST_POWER_REPORT_MEMORY);
}

// Digest authentication and router API
function rejectRedirects(req) {
  const state={count:0};
  req.onRedirect=redirected=>{state.count++;return null;};
  req._zmiRedirectState=state;
  return state;
}

async function getAuthChallenge(options = {}) {
  const req = new Request(`http://${ROUTER_HOST}/login.cgi`);
  req.method = "GET";
  req.headers = baseHeaders();
  if (Number(options.timeoutInterval) > 0) req.timeoutInterval = Number(options.timeoutInterval);
  const redirectState=options.rejectRedirects===true?rejectRedirects(req):null;
  debugLog("auth:challenge", { stage:"request", url:`http://${ROUTER_HOST}/login.cgi` });
  try { await req.loadString(); } catch (error) { debugLog("auth:challenge", { stage:"exception", error:cleanError(error) }); }
  const headers = req.response ? req.response.headers : {};
  if (redirectState&&redirectState.count) throw new Error("Authentication challenge was redirected");
  const challengeKey = Object.keys(headers).find(key => key.toLowerCase() === "www-authenticate");
  const challenge = challengeKey ? headers[challengeKey] : undefined;
  debugLog("auth:challenge", { stage:"response", status:req.response&&req.response.statusCode, wwwAuthenticate:!!challenge });
  if (!challenge) throw new Error("No authentication challenge. Check the ZMI Wi-Fi connection and router address.");
  const auth = parseDigestChallenge(challenge);
  debugLog("auth:challenge", { stage:"parsed", qop:auth.qop });
  return Object.assign(auth, { nc: 1, ha1: md5(`${USERNAME}:${auth.realm}:${PASSWORD}`) });
}

async function login(auth) {
  const cnonce = randomCnonce();
  const nc = "00000001", path = "/cgi/protected.cgi";
  const response = md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`GET:${path}`)}`);
  const query = formEncode({ realm: auth.realm, nonce: auth.nonce, response,
    qop: auth.qop, cnonce, Action: "Digest", username: USERNAME, temp: "marvell" });
  const req = new Request(`http://${ROUTER_HOST}/login.cgi?${query}`);
  req.method = "GET";
  req.headers = Object.assign({}, baseHeaders(), { Authorization: digestAuthorization(auth, "GET", path, nc, cnonce, response) });
  debugLog("auth:login", { stage:"request", url:`http://${ROUTER_HOST}/login.cgi`, qop:auth.qop });
  await req.loadString();
  debugLog("auth:login", { stage:"result", status:req.response&&req.response.statusCode, success:!(req.response&&Number(req.response.statusCode)>=400) });
  auth.nc++;
}

function authorization(auth, method) {
  const nc = Number(auth.nc).toString(16).padStart(8, "0");
  const cnonce = randomCnonce();
  const response = md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`${method}:${XML_DIGEST_URI}`)}`);
  return digestAuthorization(auth, method, XML_DIGEST_URI, nc, cnonce, response);
}
function digestAuthorization(auth, method, path, nc, cnonce, response) { const opaque=auth.opaque?`, opaque="${auth.opaque}"`:""; return `Digest username="${USERNAME}", realm="${auth.realm}", nonce="${auth.nonce}", uri="${path}", response="${response}", qop=${auth.qop}, nc=${nc}, cnonce="${cnonce}"${opaque}`; }

function digestProof(auth, method, uri, ncNumber, cnonce) {
  const nc = Number(ncNumber).toString(16).padStart(8, "0");
  const response = md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`${method}:${uri}`)}`);
  return { method, uri, nc, cnonce, response };
}

function appDigestHeader(auth, proof) {
  // The recovered APP does not copy an optional challenge `opaque` value into
  // this vendor-specific header. Keep the wire shape byte-for-byte compatible.
  return `Digest username="${USERNAME}", realm="${auth.realm}", nonce="${auth.nonce}", uri="${proof.uri}", response="${proof.response}", qop=${auth.qop}, nc=${proof.nc}, cnonce="${proof.cnonce}", client=${APP_CLIENT}`;
}

function buildAppLogin(auth, options = {}) {
  const start = Number(auth && auth.nc);
  if (!Number.isSafeInteger(start) || start < 1) throw new Error("APP Digest nonce count is invalid");
  const queryCnonce = options.queryCnonce || randomCnonce();
  const headerCnonce = options.headerCnonce || randomCnonce();
  const queryProof = digestProof(auth, "GET", "/cgi/protected.cgi", start, queryCnonce);
  const headerProof = digestProof(auth, "GET", XML_DIGEST_URI, start + 1, headerCnonce);
  const query = formEncode({
    Action: "Digest",
    username: USERNAME,
    realm: auth.realm,
    nonce: auth.nonce,
    response: queryProof.response,
    qop: auth.qop,
    cnonce: queryProof.cnonce,
    temp: "marvell",
    client: APP_CLIENT
  });
  return {
    query,
    authorization: appDigestHeader(auth, headerProof),
    queryProof,
    headerProof,
    nextNc: start + 2
  };
}

function appAuthorization(auth, method) {
  if (String(method || "").toUpperCase() !== "GET") throw new Error("The recovered APP session header is GET-only");
  const value = String(auth && auth.appAuthorization || "");
  if (!value || !/, client=APP$/.test(value) || /[\r\n]/.test(value)) throw new Error("The persisted APP Authorization header is unavailable");
  return value;
}

function appRequestHeaders(auth, method) {
  const headers = Object.assign({}, baseHeaders(), { Authorization:appAuthorization(auth, method) });
  if (auth && auth.appCookie) headers.Cookie = auth.appCookie;
  return headers;
}

function responseCookieHeader(response, options = {}) {
  const pairs = [];
  const seen = new Set();
  const host=String(options.host||ROUTER_HOST).toLowerCase(),targetPath=String(options.path||XML_REQUEST_PATH),secure=options.secure===true;
  const inScope = cookie => {
    const domain=String(cookie&&cookie.domain||host).toLowerCase().replace(/^\./,""),path=String(cookie&&cookie.path||"/");
    const domainMatch=host===domain||host.endsWith(`.${domain}`),pathMatch=targetPath===path||targetPath.startsWith(path.endsWith("/")?path:`${path}/`);
    return domainMatch&&pathMatch&&(secure||cookie&&cookie.secure!==true);
  };
  const add = (name, value) => {
    const key=String(name||"").trim(), item=String(value===undefined||value===null?"":value).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[;\r\n]/.test(item) || seen.has(key)) return;
    seen.add(key); pairs.push(`${key}=${item}`);
  };
  const hasCookieApi=!!(response&&Array.isArray(response.cookies)),cookies=hasCookieApi?response.cookies:[];
  cookies.filter(inScope).forEach(cookie=>add(cookie&&cookie.name,cookie&&cookie.value));
  if (!hasCookieApi) {
    const headers=response&&response.headers||{};
    const key=Object.keys(headers).find(name=>name.toLowerCase()==="set-cookie");
    const raw=key?headers[key]:"";
    const values=Array.isArray(raw)?raw:String(raw||"").split(/\r?\n|,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
    values.forEach(value=>{const parts=String(value||"").split(";"),pair=parts.shift()||"",separator=pair.indexOf("=");if(separator<=0)return;const cookie={name:pair.slice(0,separator).trim(),value:pair.slice(separator+1).trim(),domain:host,path:"/",secure:false};parts.forEach(part=>{const index=part.indexOf("="),name=(index<0?part:part.slice(0,index)).trim().toLowerCase(),item=index<0?"":part.slice(index+1).trim();if(name==="domain")cookie.domain=item;if(name==="path")cookie.path=item||"/";if(name==="secure")cookie.secure=true;});if(inScope(cookie))add(cookie.name,cookie.value);});
  }
  return pairs.join("; ");
}

function classifyControlResponse(value) {
  const text = String(value || "");
  const loginStatus = firstText(text, ["login_status"]).toUpperCase();
  if (["UNAUTHORIZED", "TIMEOUT", "KICKOFF"].includes(loginStatus)) return `auth-${loginStatus.toLowerCase()}`;
  if (!text.trim()) return "empty";
  if (/^\s*<!doctype\s+html\b|^\s*<html\b/i.test(text)) return "html-response";
  if (/<(?:reboot|shutdown)\b/i.test(text)) return "model-schema";
  if (/^\s*<\?xml\b|^\s*<[A-Za-z_][^>]*>/i.test(text)) return "xml-response";
  return "text-response";
}

function assertAppResponse(result, operation) {
  if (Number(result&&result.redirectCount)>0) throw new Error(`${operation} request was redirected`);
  const status = result.response && Number(result.response.statusCode);
  if (!Number.isFinite(status)) {
    if (result.exception) throw result.exception;
    throw new Error(`${operation} request failed without an HTTP status`);
  }
  if (Number.isFinite(status) && (status < 200 || status > 299)) throw new Error(`${operation} request failed: HTTP ${status} from /xml_action.cgi`);
  const responseClass = classifyControlResponse(result.text);
  if (responseClass.startsWith("auth-")) throw new Error(`Authorization failed for ${operation}: ${responseClass.slice(5)}`);
  if (responseClass==="html-response"||responseClass==="text-response") throw new Error(`${operation} returned an unexpected ${responseClass}`);
  if (result.exception) throw result.exception;
  return { responseClass, statusCode:Number.isFinite(status)?status:null };
}

function assertAppLoginResponse(result){
  try{return assertAppResponse(result,"APP login");}
  catch(error){
    const status=result&&result.response&&Number(result.response.statusCode),text=String(result&&result.text||"");
    const capturedMongooseEnvelope=/^HTTP\/1\.1 200 OK\r?\nContent-Type: text\/html\r?\nServer: Mongoose\/3\.0\r?\n\r?\n?$/.test(text);
    if(status===200&&Number(result&&result.redirectCount)===0&&!result.exception&&capturedMongooseEnvelope)return {responseClass:"captured-mongoose-login-envelope",statusCode:200};
    throw error;
  }
}

async function appLogin(auth) {
  const built = buildAppLogin(auth);
  const req = new Request(`http://${ROUTER_HOST}/login.cgi?${built.query}`);
  req.method = "GET";
  req.headers = Object.assign({}, baseHeaders(), { Authorization:built.authorization });
  req.timeoutInterval = 10;
  rejectRedirects(req);
  const startedAt = Date.now();
  const result = await loadResponse(req, { requestId:++DEBUG_REQUEST_SEQUENCE, operation:"APP login", attempt:1, startedAt });
  let checked;
  try { checked=assertAppLoginResponse(result); }
  catch(error){error.appStage={...powerDiagnosticStage(result),responseClass:classifyControlResponse(result.text),redirectCount:Number(result.redirectCount)||0};throw error;}
  auth.appAuthorization = built.authorization;
  auth.appCookie = responseCookieHeader(result.response);
  auth.nc = built.nextNc;
  return { ...checked, bytes:String(result.text||"").length, durationMs:Date.now()-startedAt, queryClientApp:true, authClientApp:true, queryNonceCount:Number(built.queryProof.nc), loginHeaderNonceCount:Number(built.headerProof.nc), authHeaderPersisted:true, sessionCookieReceived:!!auth.appCookie };
}

async function createAppSession() {
  // Keep the destructive-control authentication path bounded below the WebView
  // command timeout. The normal dashboard challenge retains its prior timeout.
  const auth = await getAuthChallenge({rejectRedirects:true,timeoutInterval:10});
  // ZMI MiFi 1.2.42 initializes its process counter at 2. The login query uses
  // nc=2, its Authorization header uses nc=3, and that exact header is then
  // retained by the shared HTTP client for every command-on-read GET.
  const start=APP_NONCE_COUNT;
  auth.nc = start;
  APP_NONCE_COUNT = start + 2;
  auth.appLogin = await appLogin(auth);
  return auth;
}

async function appXmlGet(auth, file, timeout = 5) {
  const req = new Request(xmlRequestUrl(ROUTER_HOST, "GET", file, null, XML_REQUEST_PATH));
  req.method = "GET";
  req.headers = appRequestHeaders(auth, "GET");
  req.timeoutInterval = timeout;
  req._zmi = { method:"GET", operation:file, timeout, body:null, appClient:true };
  rejectRedirects(req);
  const startedAt = Date.now();
  const result = await loadResponse(req, { requestId:++DEBUG_REQUEST_SEQUENCE, operation:`APP ${file}`, attempt:1, startedAt });
  let checked;
  try { checked=assertAppResponse(result, file); }
  catch(error){error.appStage={...powerDiagnosticStage(result),responseClass:classifyControlResponse(result.text),redirectCount:Number(result.redirectCount)||0,authHeaderReused:true,sessionCookieSent:!!auth.appCookie,responseFingerprint:/^(?:reset|poweroff)$/.test(String(file))?md5(String(result.text||"")):null};throw error;}
  return { text:result.text, ...checked, bytes:String(result.text||"").length, durationMs:Date.now()-startedAt, redirectCount:Number(result.redirectCount)||0, method:"GET", model:file, authHeaderReused:true, sessionCookieSent:!!auth.appCookie };
}

function expectedPowerDisconnect(error) {
  const message = String(error && error.message || error || "");
  return /timed?\s*out|timeout|connection\s+(?:lost|closed|reset|aborted)|network\s+connection\s+was\s+lost|socket\s+hang\s+up/i.test(message)
    && !/authorization|unauthorized|HTTP\s+[45]\d\d/i.test(message);
}

async function submitAppPowerCommand(auth, descriptor, options = {}) {
  const normalized = apiContractModule && apiContractModule.normalizeModelDescriptor
    ? apiContractModule.normalizeModelDescriptor(descriptor)
    : typeof descriptor === "string" ? { name:descriptor, method:"GET" } : descriptor || {};
  if (!normalized.name || normalized.method !== "GET") throw new Error("Invalid APP power command descriptor");
  const get = options.get || ((file)=>appXmlGet(auth,file,5));
  try {
    const response = await get(normalized.name);
    return { outcome:"request-accepted", effectConfirmed:false, responseClass:response.responseClass, responseFingerprint:md5(String(response.text||"")), statusCode:response.statusCode, bytes:response.bytes, durationMs:response.durationMs, redirectCount:Number(response.redirectCount)||0, method:"GET", model:normalized.name, authHeaderReused:response.authHeaderReused===true, sessionCookieSent:response.sessionCookieSent===true };
  } catch (error) {
    if (!expectedPowerDisconnect(error)) throw error;
    return { outcome:"delivery-unknown", effectConfirmed:false, connectionLost:true, error, method:"GET", model:normalized.name, authHeaderReused:!!(auth&&auth.appAuthorization), sessionCookieSent:!!(auth&&auth.appCookie) };
  }
}

function xmlRequestUrl(host, method, file, command, requestPath = XML_REQUEST_PATH) {
  const query = [`method=${method === "GET" ? "get" : "set"}`, "module=duster", `file=${encodeURIComponent(file)}`];
  if (command !== undefined && command !== null) query.push(`command=${encodeURIComponent(command)}`);
  return `http://${host}${requestPath}?${query.join("&")}`;
}

async function xmlRequest(auth, method, file, body = null, retry = true, timeout = 15) {
  const operation = method === "GET" ? "get" : "set";
  const text = await authenticatedRequest(auth, () => {
    const req = new Request(xmlRequestUrl(ROUTER_HOST, method, file, null, ACTIVE_XML_REQUEST_PATH));
    req.method = method;
    req.headers = requestHeaders(auth, method);
    req.timeoutInterval = timeout;
    if (body !== null) req.body = body;
    req._zmi = { method, operation:file, timeout, body };
    return req;
  }, file, retry);
  logXmlSummary(file, text);
  return text;
}

async function routerCall(auth, path, method) {
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><param><method>call</method><session>000</session><obj_path>${escapeXml(path)}</obj_path><obj_method>${escapeXml(method)}</obj_method></param></RGW>`;
  return authenticatedRequest(auth, () => {
    const req = new Request(xmlRequestUrl(ROUTER_HOST, "POST", path, method, ACTIVE_XML_REQUEST_PATH));
    req.method = "POST"; req.headers = requestHeaders(auth, "POST"); req.body = xml;
    return req;
  }, method);
}

async function loadResponse(req, context = {}) {
  let text = "";
  let exception = null;
  const started=Date.now();
  try { text = await req.loadString(); }
  catch (error) { exception = error; }
  const response=req.response;
  const allowed={};
  const responseHeaders=response&&response.headers||{};
  Object.keys(responseHeaders).forEach(key=>{if(/^(content-type|content-length|date|server)$/i.test(key))allowed[key]=responseHeaders[key];});
  debugLog(`request:${context.requestId}:response`, { operation:context.operation, method:req.method, url:String(req.url||"").replace(/([?&](?:command|token|password|nonce|cnonce|response)=)[^&#]*/gi,"$1<redacted>"), attempt:context.attempt, retry:context.attempt>1, timeout:req.timeoutInterval, startedAt:context.startedAt, durationMs:Date.now()-started, status:response&&response.statusCode, headers:allowed, bytes:String(text||"").length });
  if (req.body) debugXml(`request:${context.requestId}:${context.operation}:request-xml`, req.body);
  if (text) debugXml(`request:${context.requestId}:${context.operation}:response-xml`, text);
  if (exception) debugLog(`request:${context.requestId}:exception`, { operation:context.operation, stage:"loadResponse", error:cleanError(exception) });
  return { text, exception, response, redirectCount:req&&req._zmiRedirectState?req._zmiRedirectState.count:0, durationMs:Date.now()-started };
}

async function authenticatedRequest(auth, makeRequest, operation, retry = true) {
  const previous = auth._requestLock || Promise.resolve();
  let release;
  auth._requestLock = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    return await authenticatedRequestLocked(auth, makeRequest, operation, retry);
  } finally { release(); }
}

async function authenticatedRequestLocked(auth, makeRequest, operation, retry = true) {
  const attempts = retry ? 2 : 1;
  const requestId=++DEBUG_REQUEST_SEQUENCE;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const req=makeRequest();
    debugLog(`request:${requestId}:start`, { operation, method:req.method, attempt:attempt+1, retry:attempt>0, timeout:req.timeoutInterval, startedAt:Date.now() });
    const result = await loadResponse(req,{requestId,operation,attempt:attempt+1,startedAt:Date.now()});
    auth.nc++;
    const statusCode = result.response && Number(result.response.statusCode);
    const authenticationFailed = statusCode === 401 || unauthorized(result.text);
    if (authenticationFailed) {
      debugLog(`request:${requestId}:reauth`, { operation, reason:statusCode===401?"HTTP 401":"XML unauthorized", attempt:attempt+1 });
      if (attempt + 1 < attempts) {
        const fresh = await getAuthChallenge();
        await login(fresh);
        Object.assign(auth, fresh);
        continue;
      }
      throw new Error(`Authorization failed for ${operation}`);
    }
    if (Number.isFinite(statusCode) && (statusCode < 200 || statusCode > 299)) {
      const endpoint = String(req.url || "").replace(/^[a-z][a-z\d+.-]*:\/\/[^/]+/i, "").split(/[?#]/, 1)[0] || "/";
      throw new Error(`${operation} request failed: HTTP ${statusCode} from ${endpoint}`);
    }
    if (result.exception) throw result.exception;
    return result.text;
  }
}

function requestHeaders(auth, method) {
  return Object.assign({}, baseHeaders(), {
    Authorization: authorization(auth, method), "X-Requested-With": "XMLHttpRequest",
    Cookie: "locale=en; hard_ver=Ver.A; platform=mifi", "Content-Type": "text/xml;charset=UTF-8"
  });
}
function baseHeaders() { return { Expires: "-1", "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache" }; }
function unauthorized(xml) { return String(xml || "").toLowerCase().includes("unauthorized"); }
function parseDigestChallenge(header) {
  const parameters = digestParameters(header);
  const realm = parameters.realm || "";
  const nonce = parameters.nonce || "";
  if (!realm || !nonce) throw new Error("Could not parse the Digest authentication challenge");
  if (!Object.prototype.hasOwnProperty.call(parameters, "qop") || !parameters.qop.trim()) {
    throw new Error("Unsupported Digest challenge: qop is required (RFC 2069 no-qop authentication is not implemented)");
  }

  const offeredQop = parameters.qop.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!offeredQop.includes("auth")) {
    if (offeredQop.includes("auth-int")) {
      throw new Error("Unsupported Digest challenge: auth-int requires entity-body hashing; qop=auth was not offered");
    }
    throw new Error(`Unsupported Digest challenge qop: ${parameters.qop}`);
  }
  const result = { realm, nonce, qop: "auth" };
  Object.defineProperty(result, "opaque", { value: parameters.opaque || "", enumerable: false, writable: true });
  return result;
}

// Parse authentication parameters without treating commas inside quoted values
// (notably qop="auth-int,auth") as parameter separators.
function digestParameters(header) {
  const source = String(header || "").replace(/^\s*Digest\s+/i, "");
  const result = {};
  let offset = 0;
  while (offset < source.length) {
    while (offset < source.length && /[\s,]/.test(source[offset])) offset++;
    const keyStart = offset;
    while (offset < source.length && /[!#$%&'*+.^_`|~0-9A-Za-z-]/.test(source[offset])) offset++;
    const key = source.slice(keyStart, offset).toLowerCase();
    while (offset < source.length && /\s/.test(source[offset])) offset++;
    if (!key || source[offset] !== "=") break;
    offset++;
    while (offset < source.length && /\s/.test(source[offset])) offset++;
    let value = "";
    if (source[offset] === '"') {
      offset++;
      while (offset < source.length) {
        if (source[offset] === '"') { offset++; break; }
        if (source[offset] === "\\" && offset + 1 < source.length) offset++;
        value += source[offset++];
      }
    } else {
      const valueStart = offset;
      while (offset < source.length && source[offset] !== ",") offset++;
      value = source.slice(valueStart, offset).trim();
    }
    result[key] = value;
  }
  return result;
}
function randomCnonce() { return md5(String(Math.random()) + Date.now()).slice(0, 16); }
function formEncode(value) { return Object.keys(value).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(value[key])}`).join("&"); }

async function getStatus(auth) { return xmlRequest(auth, "GET", "status1"); }
async function getSmsPage(auth, page) {
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><message><flag><message_flag>GET_RCV_SMS_LOCAL</message_flag></flag><get_message><page_number>${page}</page_number></get_message></message></RGW>`;
  return xmlRequest(auth, "POST", "message", xml);
}
async function sendSms(auth, to, text, dependencies = {}) {
  const request = dependencies.request || xmlRequest;
  const poll = dependencies.poll || waitForSmsCommand;
  const wait = dependencies.wait || sleep;
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><message><flag><message_flag>SEND_SMS</message_flag><sms_cmd>4</sms_cmd></flag><send_save_message><contacts>${escapeXml(to)}</contacts><content>${utf16Hex(text)}</content><encode_type>UNICODE</encode_type><sms_time>${smsTime()}</sms_time></send_save_message></message></RGW>`;
  await request(auth, "POST", "message", xml);
  const completion = await poll(auth, "4", { request, wait });
  if (!completion.ok && completion.status !== "") {
    const error = new Error(completion.message || "The router rejected the send command");
    error.diagnostics = completion.diagnostics || "";
    throw error;
  }
  if (!completion.ok) throw new Error(completion.message || "SMS command status timed out");
  return completion.xml;
}

async function deleteSms(auth, id, dependencies = {}) {
  const request = dependencies.request || xmlRequest;
  const verify = dependencies.verify || loadAllSms;
  const wait = dependencies.wait || sleep;
  const poll = dependencies.poll || waitForSmsCommand;
  const rawId=String(id||"").trim(),deleteId=/,$/.test(rawId)?rawId:`${rawId},`;
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><message><flag><message_flag>DELETE_SMS</message_flag><sms_cmd>6</sms_cmd></flag><get_message><tags>12</tags><mem_store>1</mem_store></get_message><set_message><delete_message_id>${escapeXml(deleteId)}</delete_message_id></set_message></message></RGW>`;
  try { await request(auth, "POST", "message", xml); }
  catch (error) { return { ok:false, message:"Deletion could not be verified because the router connection was lost.", diagnostics:cleanError(error) }; }
  const completion = await poll(auth, "6", { request, wait });
  if (!completion.ok) return { ok:false, message:completion.message || "The router rejected the SMS deletion command.", diagnostics:completion.diagnostics || "" };
  await wait(500);
  let current;
  try { current = await verify(auth); }
  catch (error) { return { ok:false, message:"Deletion could not be verified because the router connection was lost.", diagnostics:cleanError(error) }; }
  if (current.messages.some(message => String(message.id) === String(id))) return { ok:false, message:"The router accepted a deletion command, but the SMS is still present.", diagnostics:"The message was still present after the command." };
  return { ok:true, message:"The SMS was removed from the router.", history:current };
}

function compactDebug(value, limit = 240) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }

function smsCommandState(xml) {
  return { command:firstText(xml,["sms_cmd"]), status:firstText(xml,["sms_cmd_status_result"]) };
}

async function waitForSmsCommand(auth, expectedCommand, dependencies = {}) {
  const request = dependencies.request || xmlRequest;
  const wait = dependencies.wait || sleep;
  const attempts = Math.max(1, Number(dependencies.attempts) || 11);
  const intervalMs = Math.max(0, Number(dependencies.intervalMs) || 1500);
  let last = { command:"", status:"" };
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await wait(intervalMs);
    let xml;
    try { xml = await request(auth, "GET", "message", null, true, 10); }
    catch (error) { return { ok:false, command:last.command, status:last.status, message:"SMS command status could not be read because the router connection was lost.", diagnostics:cleanError(error) }; }
    last = smsCommandState(xml);
    if (last.command === String(expectedCommand) && last.status === "3") return { ok:true, ...last, xml };
    if (last.command === String(expectedCommand) && last.status && last.status !== "1") return { ok:false, ...last, xml, message:`The router rejected SMS command ${expectedCommand} (status ${last.status}).`, diagnostics:`sms_cmd=${last.command}; sms_cmd_status_result=${last.status}` };
  }
  return { ok:false, ...last, message:`SMS command ${expectedCommand} did not complete before the status timeout.`, diagnostics:`sms_cmd=${last.command||"unknown"}; sms_cmd_status_result=${last.status||"unknown"}` };
}

function routerAccepted(xml) {
  const sms = smsCommandState(xml);
  if (sms.command && sms.status) return sms.status === "3";
  const fields = ["sms_cmd_status_result", "delete_status", "status", "result"];
  const values = fields.map(name => tag(xml, name).trim().toLowerCase()).filter(Boolean);
  if (!values.length) return false;
  const failure = /^(?:-1|1|2|3|false|error|failed?|failure|rejected?|denied|invalid|unsupported|not[ _-]?(?:supported|completed))$/;
  const success = /^(?:0|true|ok|success|successful|accepted|complete|completed|deleted)$/;
  if (values.some(value => failure.test(value))) return false;
  return values.some(value => success.test(value));
}

// SMS pagination and parsing
function emptySms() { return { messages: [], loadedPages: 0, totalPages: null, totalMessages: null, hasMore: false, fingerprint: "", warning: "" }; }
function mergeSmsPage(result, parsed) {
  result = result || emptySms();
  if (!parsed) return result;
  if (result.totalPages === null && parsed.totalPages !== null && parsed.totalPages !== undefined) result.totalPages = parsed.totalPages;
  if (result.totalMessages === null && parsed.totalMessages !== null && parsed.totalMessages !== undefined) result.totalMessages = parsed.totalMessages;
  if (!parsed.messages || !parsed.messages.length) return result;
  const seen = new Set(result.messages.map(smsKey));
  for (const message of parsed.messages) if (!seen.has(smsKey(message))) {
    seen.add(smsKey(message)); result.messages.push(message);
  }
  result.loadedPages = Math.max(result.loadedPages || 0, parsed.page || 0);
  return result;
}
async function loadRemainingSms(auth, initial, onProgress) {
  const result = initial || emptySms();
  const first = result._first || { page:1, messages:result.messages.slice(), totalPages:result.totalPages, totalMessages:result.totalMessages };
  let cachedLast = null;
  if (result.totalMessages === null && result.totalPages !== null && result.totalPages > 1 && result.totalPages <= SMS_MAX_PAGES) {
    try {
      cachedLast = parseSmsPage(await getSmsPage(auth, result.totalPages), result.totalPages);
      result.totalMessages = (result.totalPages - 1) * SMS_PAGE_SIZE + Math.min(cachedLast.messages.length, SMS_PAGE_SIZE);
    } catch (error) {
      result.warning = `Message history is incomplete: ${cleanError(error)}`;
    }
  }
  const seenPages = new Set();
  if (first.messages.length) seenPages.add(pageMessageFingerprint(first.messages));
  let last = first;
  for (let page = Math.max(2, (result.loadedPages || 1) + 1); page <= SMS_MAX_PAGES; page++) {
    if (result.totalPages !== null && page > result.totalPages) break;
    let parsed;
    try { parsed = cachedLast && page === cachedLast.page ? cachedLast : parseSmsPage(await getSmsPage(auth, page), page); }
    catch (error) { result.warning = `Message history is incomplete: ${cleanError(error)}`; break; }
    if (!parsed.messages.length) break;
    const fp = pageMessageFingerprint(parsed.messages);
    if (seenPages.has(fp)) { result.warning = "The router repeated a page; loading stopped."; break; }
    seenPages.add(fp); mergeSmsPage(result, parsed); last = parsed;
    if (onProgress) await onProgress(Object.assign({}, result, { messages:result.messages.slice(), loading:true }));
    if (result.totalPages === null && parsed.messages.length < SMS_PAGE_SIZE) break;
    if (page === SMS_MAX_PAGES) { result.warning = `The ${SMS_MAX_PAGES}-page safety limit was reached.`; result.hasMore = true; }
  }
  result.loading = false;
  if (result.totalMessages === null || result.totalMessages < result.messages.length) result.totalMessages = result.messages.length;
  result.fingerprint = smsEdgeFingerprint(first, last, result.totalPages, result.totalMessages);
  return result;
}
async function loadAllSms(auth) {
  const result = emptySms();
  const first = parseSmsPage(await getSmsPage(auth, 1), 1);
  result.totalPages = first.totalPages;
  result.totalMessages = first.totalMessages;
  let expectedPages = first.totalPages;
  let last = null;
  if (expectedPages !== null && expectedPages > 1 && expectedPages <= SMS_MAX_PAGES) {
    last = parseSmsPage(await getSmsPage(auth, expectedPages), expectedPages);
    if (!last.messages.length) {
      result.warning = "The router reported an invalid page count; page count was inferred.";
      expectedPages = null;
      result.totalPages = null;
    }
  }
  const seenPages = new Set();
  for (let page = 1; page <= SMS_MAX_PAGES; page++) {
    const parsed = page === 1 ? first : (last && page === last.page ? last : parseSmsPage(await getSmsPage(auth, page), page));
    if (!parsed.messages.length) break;
    const pageFp = pageMessageFingerprint(parsed.messages);
    if (seenPages.has(pageFp)) { result.warning = result.warning || "The router repeated a page; loading stopped."; break; }
    seenPages.add(pageFp);
    result.messages.push(...parsed.messages);
    result.loadedPages++;
    if (result.totalMessages === null) result.totalMessages = parsed.totalMessages;
    if (expectedPages !== null && page >= expectedPages) break;
    if (expectedPages === null && parsed.messages.length < SMS_PAGE_SIZE) break;
    if (page === SMS_MAX_PAGES) { result.warning = `The ${SMS_MAX_PAGES}-page safety limit was reached.`; result.hasMore = true; }
  }
  const seen = new Set();
  result.messages = result.messages.filter(message => { const key = smsKey(message); if (seen.has(key)) return false; seen.add(key); return true; });
  if (result.totalMessages === null || result.totalMessages < result.messages.length) result.totalMessages = result.messages.length;
  result.fingerprint = smsEdgeFingerprint(first, last || (result.loadedPages === 1 ? first : null), result.totalPages, result.totalMessages);
  return result;
}
async function inspectSmsEdges(auth) {
  const first = parseSmsPage(await getSmsPage(auth, 1), 1);
  let last = null;
  const totalPages = first.totalPages;
  const totalMessages = first.totalMessages;
  if (totalPages !== null && totalPages > 1 && totalPages <= SMS_MAX_PAGES) last = parseSmsPage(await getSmsPage(auth, totalPages), totalPages);
  const fingerprint = smsEdgeFingerprint(first, last, totalPages, totalMessages);
  return { first, last, totalPages, totalMessages, fingerprint };
}
function smsEdgeFingerprint(first, last, totalPages, totalMessages) {
  return [totalPages == null ? "?" : totalPages, totalMessages == null ? "?" : totalMessages, pageMessageFingerprint(first && first.messages), pageMessageFingerprint(last && last.messages)].join("#");
}
function pageMessageFingerprint(messages) { return (messages || []).map(smsKey).join("|"); }
function unchangedSms(current, edges) {
  return !!(current && edges && current.fingerprint && current.fingerprint === edges.fingerprint && current.totalPages === edges.totalPages && current.totalMessages === edges.totalMessages);
}
function parseSmsPage(xml, page) {
  const totalMessages = firstNumber(xml, ["total_sms_count", "total_message_count", "message_count", "sms_count", "record_count", "total_records"]);
  const legacy = firstNumber(xml, ["total_number"]);
  const explicitTotalPages = firstNumber(xml, ["total_pages", "total_page", "page_count", "total_page_number"]);
  const totalPages = explicitTotalPages !== null ? explicitTotalPages : legacy;
  return { page, totalMessages, totalPages, legacyTotalNumber: legacy, messages: parseSmsItems(xml) };
}
function parseSmsItems(xml) {
  const messages = []; const regex = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi; let hit;
  while ((hit = regex.exec(String(xml || ""))) !== null) {
    const body = hit[2]; const row = attr(hit[1], "index") || String(messages.length + 1);
    const id = decodeSms(tag(body, "index") || row);
    const phone = decodeSms(firstText(body, ["from", "contacts", "phone_number", "number"])).replace(/^;\s*/, "");
    const content = decodeSms(firstText(body, ["subject", "content", "message_content"]));
    const date = formatSmsDate(firstText(body, ["received", "sms_time", "time", "date"]));
    if (id || phone || content) messages.push({ row, id, phone, content, date });
  }
  return messages;
}
function smsKey(item) { return [item.id, item.phone, item.date, item.content].join("|"); }
function decodeSms(value) {
  const text = String(value || "").trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 4 === 0) {
    let output = ""; for (let i = 0; i < text.length; i += 4) { const code = parseInt(text.slice(i, i + 4), 16); if (code) output += String.fromCharCode(code); }
    return htmlDecode(output);
  }
  return htmlDecode(text);
}
function formatSmsDate(value) { const p = String(value || "").split(","); return p.length < 6 ? String(value || "") : `20${pad2(p[0])}-${pad2(p[1])}-${pad2(p[2])} ${pad2(p[3])}:${pad2(p[4])}:${pad2(p[5])}`; }
function utf16Hex(text) { let value = ""; for (let i = 0; i < text.length; i++) value += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase(); return value; }
const GSM7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENSION = "^{}\\[~]|€";
function smsSegments(message) {
  const text = String(message || ""); let units=0, encoding="GSM-7";
  for (const character of text) { if(GSM7_BASIC.includes(character)) units++; else if(GSM7_EXTENSION.includes(character)) units+=2; else { encoding="UCS-2"; break; } }
  if(encoding==="UCS-2") units=text.length;
  const single=encoding==="GSM-7"?160:70, multipart=encoding==="GSM-7"?153:67;
  return { encoding, units, segments:units<=single?1:Math.ceil(units/multipart), singleLimit:single, multipartLimit:multipart, multipart:units>single };
}
function smsTime() { const d = new Date(); const offset = -d.getTimezoneOffset(); const sign = offset >= 0 ? "%2B" : "-"; return [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), `${sign}${Math.floor(Math.abs(offset) / 60)}`].join(","); }
function parseSendResult(xml) { const lower = String(xml || "").toLowerCase(),state=smsCommandState(xml),status=state.status||firstText(xml,["send_status"]); const ok=!unauthorized(xml)&&!/error|fail/.test(lower)&&state.command==="4"&&status==="3"; return { ok, message: ok ? "The router confirmed the send command" : "The router rejected the send command" }; }

// Router status
function sectionWithError(data, errorKey, message) { return data && data.hasData ? data : Object.assign({}, data || {}, { [errorKey]: message }); }
function parseTraffic(xml) {
  const source = tag(xml, "WanStatistics") || xml;
  const uploadCounter = parseCounter(tag(source, "tx_byte_all"));
  const downloadCounter = parseCounter(tag(source, "rx_byte_all"));
  const sessionUploadCounter = parseCounter(tag(source, "tx_byte"));
  const sessionDownloadCounter = parseCounter(tag(source, "rx_byte"));
  const upload = uploadCounter.value, download = downloadCounter.value;
  const sessionUpload = sessionUploadCounter.value, sessionDownload = sessionDownloadCounter.value;
  const sessionSeconds = connectionSeconds(source);
  const hasData = [upload, download, sessionUpload, sessionDownload, sessionSeconds].some(v => v !== null && v !== undefined);
  return { hasData, upload, download, total: upload !== null && download !== null ? upload + download : null, sessionUpload, sessionDownload, sessionSeconds,
    raw: { tx_byte_all:uploadCounter.raw, rx_byte_all:downloadCounter.raw, tx_byte:sessionUploadCounter.raw, rx_byte:sessionDownloadCounter.raw },
    parsed: { tx_byte_all:uploadCounter, rx_byte_all:downloadCounter, tx_byte:sessionUploadCounter, rx_byte:sessionDownloadCounter } };
}
function parseCounter(value) { if(value===undefined||value===null||String(value).trim()==="")return{state:"missing",raw:value==null?"":String(value),value:null};const raw=String(value).trim();if(!/^[0-9]+$/.test(raw))return{state:"invalid",raw,value:null};return{state:"valid",raw,value:BigInt(raw)}; }
function connectionSeconds(source) { const d=firstNumber(source,["conn_days"]), h=firstNumber(source,["conn_hours"]), m=firstNumber(source,["conn_minutes"]), sec=firstNumber(source,["conn_seconds"]); return [d,h,m,sec].some(v=>v!==null) ? (d||0)*86400+(h||0)*3600+(m||0)*60+(sec||0) : null; }
function parseBattery(xml, identity = {}) {
  const source = tag(xml, "batteryinfo") || xml;
  const percentRaw = firstText(source, ["Battery_percent"]);
  const percentNumber = percentRaw !== "" && /^\d+$/.test(percentRaw) ? Number(percentRaw) : null;
  const percent = percentNumber !== null && percentNumber >= 0 && percentNumber <= 100 ? percentNumber : null;
  const batteryStatus = firstText(source, ["Battery_status", "battery_status", "battery_charging"]);
  const batteryLevel = firstText(source, ["Battery_level", "battery_level"]);
  const chargerStatus = firstText(source, ["Charger_status", "charger_status"]);
  const cDetectStatus = firstText(source, ["CDetectStatus", "c_detect_status"]);
  const chargerCurrentRaw = firstText(source, ["Charger_current", "charger_current"]), outputCurrentRaw = firstText(source, ["Output_current", "output_current"]);
  const chargerCurrent = chargerCurrentRaw !== "" && Number.isFinite(Number(chargerCurrentRaw)) ? Number(chargerCurrentRaw) : null;
  const outputCurrent = outputCurrentRaw !== "" && Number.isFinite(Number(outputCurrentRaw)) ? Number(outputCurrentRaw) : null;
  const profile = powerStatusModule && typeof powerStatusModule.decode === "function"
    ? powerStatusModule.decode({ batteryStatus, chargerStatus, batteryLevel, chargerCurrent, outputCurrent, cDetectStatus }, identity)
    : { confirmed:false };
  const lv01Family = powerStatusModule && typeof powerStatusModule.isLv01Family === "function" && powerStatusModule.isLv01Family(identity);
  const state = profile.confirmed ? profile.state : lv01Family ? "unknown" : batteryState(batteryStatus, chargerStatus, percent, chargerCurrent, outputCurrent);
  const inputConnected = profile.confirmed ? profile.inputConnected : lv01Family ? false : batteryInputConnected(batteryStatus, chargerStatus, chargerCurrent);
  const usbOutputActive = profile.confirmed ? profile.usbOutputActive : lv01Family ? false : outputCurrent !== null && outputCurrent > 0;
  const labels={charging:"Charging","charging-error":"Charging error","not-charging":"Not charging",discharging:"Discharging","powering-usb":"Powering USB device","charging-and-powering-usb":"Charging · Powering USB device",full:"Full","full-and-powering-usb":"Full · Powering USB device",unknown:"Unknown"}, status=labels[state]||labels.unknown;
  return { hasData: percentRaw !== "" || !!batteryStatus || !!chargerStatus || !!batteryLevel || chargerCurrent !== null || outputCurrent !== null, percent, percentRaw, percentValid: percent !== null, charging:inputConnected, inputConnected, chargerConnected:inputConnected, usbOutputActive, usbHostActive:usbOutputActive, powerStatus:state, state, status, detailText:status, chargeHealth:profile.chargeHealth||"unknown", firmwarePowerState:profile.firmwareState||"unknown", profileConfirmed:profile.confirmed===true, batteryLevel:batteryLevel||"", chargerCurrent, outputCurrent, rawStatus:batteryStatus || "", chargerStatus:chargerStatus || "", rawChargerStatus:chargerStatus || "", cDetectStatus:cDetectStatus||"", rawChargerCurrent:chargerCurrentRaw, rawOutputCurrent:outputCurrentRaw };
}
function batteryInputConnected(batteryStatus, chargerStatus, chargerCurrent) {
  const battery=String(batteryStatus||"").trim(), charger=String(chargerStatus||"").trim();
  const batteryPositive = !/discharg|not\s*charg|unplug|offline/i.test(battery) && /charg|adapter|\bac\b|plug|online|connected/i.test(battery);
  const chargerPositive = !/discharg|not\s*charg|unplug|offline/i.test(charger) && /charg|adapter|\bac\b|plug|online|connected/i.test(charger);
  return (chargerCurrent !== null && chargerCurrent > 0) ||
    batteryPositive ||
    chargerPositive ||
    /^(1|true|yes|on)$/i.test(charger) || battery === "2" || battery === "3";
}
function batteryState(batteryStatus, chargerStatus, percent, chargerCurrent, outputCurrent) {
  const raw = String(batteryStatus || "").trim();
  const charger = String(chargerStatus || "").trim();
  const hasCharger = batteryInputConnected(raw, charger, chargerCurrent);
  const hasOutput = outputCurrent !== null && outputCurrent > 0;
  const full =
    /full|charged|complete|finish/i.test(raw) ||
    (percent !== null && percent >= 98 && (raw === "3" || hasCharger));
  if (full) return hasOutput ? "full-and-powering-usb" : "full";
  if (hasCharger && hasOutput) return "charging-and-powering-usb";
  if (raw === "3" && percent !== null && percent < 98) return hasOutput ? "charging-and-powering-usb" : "charging";
  if (raw === "2" || hasCharger) return "charging";
  if (hasOutput) return "powering-usb";
  if (/discharg|unplug|not\s*charg|offline/i.test(raw) || raw === "1" || charger === "0") return "discharging";
  return "unknown";
}
function enumRaw(value, mapping) { const raw=value===undefined||value===null?null:String(value); const label=raw!==null&&mapping&&Object.prototype.hasOwnProperty.call(mapping,raw)?mapping[raw]:null; return {raw,label,confirmed:label!==null}; }
function ratGeneration(label) { const text=String(label||"").toLowerCase(); return /5g|\bnr\b/.test(text)?"5G":/4g|lte/.test(text)?"4G":/3g|wcdma|umts|hspa|hsdpa|hsupa/.test(text)?"3G":/2g|gsm|gprs|edge/.test(text)?"2G":/no service/.test(text)?"No service":"Unknown"; }
function networkProtocol(value, mapping) {
  const raw=value===undefined||value===null?null:String(value).trim();
  if(!raw)return {protocol:"Unknown",generation:"Unknown",confirmed:false};
  if(mapping&&Object.prototype.hasOwnProperty.call(mapping,raw)){const protocol=mapping[raw];return {protocol,generation:ratGeneration(protocol),confirmed:true};}
  // Human-readable RAT names are self-describing; opaque numeric enums are not.
  if(!/^[-+]?\d+$/.test(raw)&&ratGeneration(raw)!=="Unknown"){const generation=ratGeneration(raw);return {protocol:generation==="4G"&&!/4g/i.test(raw)?`4G · ${raw}`:raw,generation,confirmed:true};}
  return {protocol:`Unknown (raw: ${raw})`,generation:"Unknown",confirmed:false};
}
function parseNetwork(xml) {
  const normalized=xml && typeof xml === "object" && xml.values ? xml : cellularDiagnosticsModule ? cellularDiagnosticsModule.normalize({status1:xml}) : null;
  if(!normalized) return {hasData:false,mode:"Unknown",generation:"Unknown",bars:null,dbm:null};
  const v=normalized.values,rat=normalized.rat,signal=normalized.signal;
  const preferred=v.preferred_mode.raw!==null?v.preferred_mode:v.connect_mode;
  const additional=rat.additional||[];
  const raw={}; for(const name of ["sys_mode","sys_submode","ConnType","proto","network_mode","network_type","preferred_mode","connect_mode"])raw[name]=v[name].raw;
  return {hasData:Object.values(v).some(x=>x&&x.raw!==null),normalized,raw,fields:v,operator:v.operator.value||"",mode:rat.value,protocol:rat.value,generation:rat.generation,networkConflict:rat.conflict,
    rawMode:rat.raw,networkSource:rat.source,networkDiagnostic:[rat.source?`${rat.source}=${rat.raw}`:"",...additional.map(x=>`${x.key}=${x.raw}`)].filter(Boolean).join(", ")||"No RAT field returned",
    preferredMode:preferred.raw!==null?preferred.value:"Unknown",preferredSource:preferred.source,registered:v.registration.value,roaming:v.roaming.value,
    rssi:v.rssi,signalRaw:(v.rsrp.raw||v.signalbar.raw||v.rssi.raw||v.signalStrength.raw),bars:signal.bars,dbm:signal.dbm,percent:signal.bars===null?null:signal.bars*20,signalText:signalText(signal.bars),rsrq:v.rsrq,sinr:v.sinr,
    lac:v.lac.raw,cellId:v.cellId.raw,pci:v.pci.raw,band:v.band.raw,earfcn:v.earfcn.raw,simStatus:v.sim,pdp:{state:v.pdpState,type:v.pdpType,configuredApn:v.configuredApn,activeApn:v.activeApn,ipv4:v.ipv4,ipv6:v.ipv6,dns1:v.dns1,dns2:v.dns2}};
}
function batteryStatusLabel(value, charging, percent, chargerStatus) {
  const state = batteryState(value, chargerStatus, percent, charging ? 1 : null, null);
  return state === "full" ? "Full" : state === "full-and-powering-usb" ? "Full · Powering USB device" : state === "charging-error" ? "Charging error" : state === "charging" ? "Charging" : state === "not-charging" ? "Not charging" : state === "discharging" ? "Discharging" : state === "powering-usb" ? "Powering USB device" : state === "charging-and-powering-usb" ? "Charging · Powering USB device" : "Unknown";
}
function batteryInlineLabel(battery) {
  const percent = battery && battery.percent !== null && battery.percent !== undefined ? `${battery.percent}%` : "—";
  const status = battery && battery.status ? battery.status : batteryStatusLabel(battery && battery.rawStatus, battery && battery.charging, battery && battery.percent);
  if (status === "Charging") return `🔋 ${percent} ↑ Charging`;
  if (status === "Charging error") return `🔋 ${percent} ⚠ Charging error`;
  if (status === "Not charging") return `🔋 ${percent} · Not charging`;
  if (status === "Discharging") return `🔋 ${percent} ↓ Discharging`;
  if (status === "Powering USB device") return `🔋 ${percent} → Powering USB device`;
  if (status === "Charging · Powering USB device") return `🔋 ${percent} ↑ Charging · → Powering USB device`;
  if (status === "Full") return `🔋 ${percent} Full`;
  if (status === "Full · Powering USB device") return `🔋 ${percent} Full · → Powering USB device`;
  return `🔋 ${percent} Unknown`;
}
function preferredModeId(label) { const text = String(label || "").toLowerCase(); if (/auto|automatic/.test(text)) return "auto"; if (/lte|4g/.test(text)) return "lteOnly"; if (/wcdma|umts|hspa|hsdpa|hsupa|3g/.test(text)) return "wcdmaOnly"; if (/gsm|gprs|edge|2g/.test(text)) return "gsmOnly"; return "auto"; }
function signalInfo(value, rsrp, rssi) {
  if (rsrp !== null && rsrp !== undefined) { const b = barsFromThresholds(rsrp, [-125,-115,-105,-95,-85]); return { dbm: rsrp, bars: b, percent: b * 20 }; }
  if (value !== null && value !== undefined) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 99) return { dbm: null, bars: null, percent: null };
    if (n < 0) { const b=barsFromThresholds(n, [-105,-95,-85,-75,-65]); return { dbm: n, bars: b, percent: b * 20 }; }
    if (n <= 5) return { dbm: null, bars: Math.round(n), percent: Math.round(n) * 20 };
    if (n <= 31) { const dbm = -113 + 2 * n, b=barsFromThresholds(dbm, [-105,-95,-85,-75,-65]); return { dbm, bars: b, percent: b * 20 }; }
    if (n <= 100) return { dbm: null, bars: Math.max(0, Math.min(5, Math.round(n / 20))), percent: n };
  }
  if (rssi !== null && rssi !== undefined) return signalInfo(rssi, null, null);
  return { dbm: null, bars: null, percent: null };
}
function barsFromThresholds(dbm, thresholds) { let bars = 0; for (const t of thresholds) if (dbm >= t) bars++; return Math.max(0, Math.min(5, bars)); }
function normalizeSignalBars(value, dbm) { return signalInfo(value, null, dbm).bars; }
function signalText(bars) { return ["No signal", "Very weak", "Weak", "Medium", "Good", "Excellent"][bars == null ? -1 : bars] || "No data"; }
function signalQuality(bars, dbm) { const b = bars !== null && bars !== undefined ? bars : normalizeSignalBars(null, dbm); return signalText(b); }
function signalBarsHtml(network) {
  const bars = network && network.bars !== undefined ? network.bars : normalizeSignalBars(null, network && network.dbm);
  const safe = bars === null || bars === undefined ? 0 : bars;
  const label = bars === null || bars === undefined ? "Signal unknown" : `Signal ${safe} of 5`;
  return `<span class="signal-bars" role="img" aria-label="${escapeHtml(label)}">${[1,2,3,4,5].map(i => `<i class="${i <= safe ? "on" : ""}"></i>`).join("")}</span>`;
}
function formatBytes(bytes) { if(typeof bytes!=="bigint"||bytes<0n)return "—";if(bytes===0n)return "0 B";const units=["B","KiB","MiB","GiB","TiB","PiB","EiB","ZiB","YiB"];let i=0,d=1n;while(i+1<units.length&&bytes>=d*1024n){d*=1024n;i++;}if(!i)return `${bytes} B`;const t=(bytes*10n+d/2n)/d;return `${t/10n}.${t%10n} ${units[i]}`; }
function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
  const s=Math.max(0,Math.floor(Number(seconds))),days=Math.floor(s/86400),hours=Math.floor((s%86400)/3600),minutes=Math.floor((s%3600)/60),secs=s%60;
  if(days)return `${days}d ${String(hours).padStart(2,"0")}h ${String(minutes).padStart(2,"0")}m`;
  if(hours)return `${hours}h ${String(minutes).padStart(2,"0")}m`;
  return `${minutes}m ${String(secs).padStart(2,"0")}s`;
}

// Experimental USSD support is isolated in modules/ussd.js. The API adapter
// keeps authentication and XML transport in this application module.
async function detectUssdCapability(auth) {
  return ussdModule.detect(ussdApi(auth));
}
async function executeUssd(auth, capability, code) {
  return ussdModule.execute(ussdApi(auth), capability, code);
}
function ussdApi(auth) {
  return {
    xmlRequest: (method, file, body, retry, timeout) =>
      xmlRequest(auth, method, file, body, retry, timeout),
    cleanError,
    decodeSms,
    firstText,
    escapeXml,
    sleep,
    responsePolls: USSD_RESPONSE_POLLS
  };
}
// Experimental device-access support is isolated in modules/device-access.js.
// Detection uses only GET probes; execution goes through a separate confirmed flow.
async function detectDeviceAccess(auth) {
  return deviceAccessModule.detect(deviceAccessApi(auth));
}
async function executeDeviceAccess(auth, capability, action) {
  if (capability === "tryEnableTelnet" || action === "tryEnableTelnet") return executeTelnet(auth, true, true);
  return deviceAccessModule.execute(deviceAccessApi(auth), capability, action);
}
async function executeTelnet(auth, enable, confirmed) {
  const result=await telnetControlModule.control(telnetApi(auth),enable,confirmed);
  if(result.outcome==="unsupported") return {ok:false,title:"Telnet",message:"Unavailable: no universal command contract is confirmed",outcome:result.outcome};
  return {ok:result.outcome==="confirmed",title:"Telnet",message:`Telnet result: ${result.outcome}`,outcome:result.outcome};
}
function telnetApi(auth) { return { host:ROUTER_HOST, escapeXml, xmlRequest:(method,file,body)=>xmlRequest(auth,method,file,body), writeThenVerify:spec=>writeThenVerify(auth,spec), portCheck:async(host,port,timeout)=>{ if(typeof Socket==="undefined") return false; const socket=new Socket(); try { await socket.connect(host,port,timeout); return true; } catch (_) { return false; } finally { try { socket.close(); } catch (_) {} } } }; }
function deviceAccessApi(auth) {
  return {
    xmlRequest: (method, file, body, retry, timeout) =>
      xmlRequest(auth, method, file, body, retry, timeout),
    routerCall: (path, method) => routerCall(auth, path, method),
    cleanError,
    escapeXml
  };
}

async function loadCellularDiagnostics(auth, statusXml) {
  const responses = {}; const errors = {};
  if (statusXml) responses.status1 = statusXml;
  const endpoints = ["wan", "Engineer_parameter", "detailed_log"];
  for (const endpoint of endpoints) {
    try {
      const xml = await xmlRequest(auth, "GET", endpoint);
      responses[endpoint] = xml;
      if (endpoint === "Engineer_parameter" && engineerParameterModule) engineerParameterModule.parseEngineerParameter(xml);
    } catch (error) { errors[endpoint] = cleanError(error); }
  }
  responses.__errors = errors;
  const normalized=cellularDiagnosticsModule ? cellularDiagnosticsModule.normalize(responses) : { values: {}, stages: {}, endpointErrors: errors };
  normalized.routerLog=responses.detailed_log ? parseDetailedLogSummary(responses.detailed_log) : { available:false,events:[],error:errors.detailed_log||"Router detailed_log was not returned." };
  debugLog("router-log:summary",{available:normalized.routerLog.available,pdpSessions:normalized.routerLog.pdpSessions,clientSessions:normalized.routerLog.clientSessions,eventCount:normalized.routerLog.events.length,truncated:normalized.routerLog.truncated,error:normalized.routerLog.error||null});
  normalized.loadedAt=Date.now(); normalized.loading=false; return normalized;
}

function detailedLogItems(xml, sectionName) {
  const section=tag(xml,sectionName);
  if(!section)return [];
  return Array.from(String(section).matchAll(/<Item(?:\s[^>]*)?>([\s\S]*?)<\/Item>/gi),match=>match[1]);
}
function safeRouterLogField(value, pattern, fallback = "") {
  const text=String(value||"").trim().slice(0,80);
  return text&&pattern.test(text)?text:fallback;
}
function parseDetailedLogSummary(xml, limit = 120) {
  const source=String(xml||"");
  if(!/<detailed_log\b/i.test(source))return {available:false,events:[],pdpSessions:0,clientSessions:0,truncated:false,error:"The response has no detailed_log section."};
  const pdp=detailedLogItems(source,"pdp_detailed_log_list").map(item=>({
    type:"pdp",
    start:safeRouterLogField(firstText(item,["start_time"]),/^[0-9 T/:+_.-]+$/),
    end:safeRouterLogField(firstText(item,["end_time"]),/^[0-9 T/:+_.-]+$/),
    context:safeRouterLogField(firstText(item,["cid"]),/^[0-9]+$/),
    ipType:safeRouterLogField(firstText(item,["ip_type"]),/^[A-Za-z0-9+_.-]+$/,"unknown"),
    apn:safeRouterLogField(firstText(item,["pdp_name"]),/^[\x20-\x7e]+$/),
    ipv4:safeRouterLogField(firstText(item,["ip_addr"]),/^[A-Fa-f0-9:./]+$/),
    ipv6:safeRouterLogField(firstText(item,["ipv6_addr"]),/^[A-Fa-f0-9:./]+$/)
  }));
  const clients=detailedLogItems(source,"con_time_list").map(item=>({
    type:"wifi-client",
    start:safeRouterLogField(firstText(item,["con_time"]),/^[0-9 T/:+_.-]+$/),
    end:safeRouterLogField(firstText(item,["discon_time"]),/^[0-9 T/:+_.-]+$/),
    client:safeRouterLogField(firstText(item,["wifimac"]),/^[A-Fa-f0-9:.-]+$/,"unknown")
  }));
  const all=pdp.concat(clients),count=Math.max(1,Math.min(200,Number(limit)||120)),events=all.slice(-count);
  return {
    available:true,
    loadedAt:Date.now(),
    loginTime:safeRouterLogField(firstText(source,["login_time"]),/^[0-9 T/:+_.-]+$/),
    pdpSessions:pdp.length,
    clientSessions:clients.length,
    truncated:all.length>events.length,
    events
  };
}

async function detectCellularControl(auth) {
  return cellularControlModule.detect(cellularControlApi(auth));
}
function cellularControlApi(auth) {
  return {
    xmlRequest: (method, file, body, retry, timeout) => xmlRequest(auth, method, file, body, retry, timeout),
    routerCall: (path, method) => routerCall(auth, path, method),
    cleanError,
    escapeXml,
    firstText,
    sleep,
    parseNetwork: async () => parseNetwork(await getStatus(auth))
  };
}

function sleep(ms) { return new Promise(resolve => { const timer = Timer.schedule(ms, false, () => { timer.invalidate(); resolve(); }); }); }

const CAPABILITY_CACHE_SCHEMA = 1;
const CAPABILITY_NEGATIVE_TTL = 24 * 60 * 60 * 1000;
function capabilityCacheValid(entry, host = ROUTER_HOST, now = Date.now()) {
  if (!entry || entry.schema !== CAPABILITY_CACHE_SCHEMA || entry.host !== host || !entry.checkedAt) return false;
  return entry.positive === true || now - entry.checkedAt < CAPABILITY_NEGATIVE_TTL;
}
function capabilityCacheKey(kind) { return `zmi-capability-${CAPABILITY_CACHE_SCHEMA}-${ROUTER_HOST}-${kind}`; }
function readCapabilityCache(kind) {
  try { const key=capabilityCacheKey(kind); if(typeof Keychain!=="undefined"&&Keychain.contains(key)){const entry=JSON.parse(Keychain.get(key));return capabilityCacheValid(entry)?entry.value:null;} } catch (_) {}
  return null;
}
function writeCapabilityCache(kind, value) {
  try { if(typeof Keychain!=="undefined") Keychain.set(capabilityCacheKey(kind),JSON.stringify({schema:CAPABILITY_CACHE_SCHEMA,host:ROUTER_HOST,checkedAt:Date.now(),positive:value&&value.supported===true,value})); } catch (_) {}
}
function createInFlightGuard() {
  let active = null;
  return { get active(){return !!active;}, run(task){ if(active)return active; active=Promise.resolve().then(task).finally(()=>{active=null;}); return active; } };
}
function requireSuccessfulActionResult(result, fallbackMessage = "Router action failed") {
  if (!result || result.ok !== false) return result;
  const error = new Error(result.message || fallbackMessage);
  error.diagnostics = sanitizeDiagnostics(result.diagnostics || "");
  throw error;
}
const WEB_ACTIONS = new Set(["refresh","refreshSms","sendSms","deleteSms","copySms","copyDiagnosticLog","shareSms","ussd","detectCapability","detectExperimental","diagnosticLogSnapshot","safePreflight","appAuthProbe","firmwareTransportProbe","firmwareRestoreDryRun","firmwareCanaryValidate","firmwareFlash","firmwareJournalStatus","firmwareJournalAcknowledge","lastPowerReport","deviceAccess","cellularReconnect","cellularMode","resetTraffic","reboot","powerOff","resumePolling"]);
const DANGEROUS_ACTIONS = new Set(["firmwareFlash","firmwareJournalAcknowledge","cellularReconnect","cellularMode","deviceAccess","resetTraffic","reboot","powerOff"]);
function validateWebViewCommand(input) {
  if (!input || typeof input!=="object" || typeof input.id!=="string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.id)) throw new Error("Invalid command id");
  if (typeof input.action!=="string" || !WEB_ACTIONS.has(input.action)) throw new Error("Action is not allowed");
  const p=input.params===undefined?{}:input.params;
  if (!p || typeof p!=="object" || Array.isArray(p)) throw new Error("Invalid command parameters");
  const text=(name,max,required=false)=>{if(p[name]===undefined&&!required)return;if(typeof p[name]!=="string"||p[name].length>(max||128)||(required&&!p[name].trim()))throw new Error(`Invalid ${name}`);};
  if(input.action==="sendSms"){text("to",64,true);text("text",1000,true);}
  if(input.action==="deleteSms")text("id",128,true);
  if(input.action==="copySms")text("text",10000,true);
  if(input.action==="shareSms")text("text",12000,true);
  if(input.action==="ussd")text("code",128,true);
  if(input.action==="detectCapability"&&!['ussd','deviceAccess','cellularControl'].includes(p.kind))throw new Error("Invalid capability kind");
  if(input.action==="deviceAccess")text("deviceAction",64,true);
  if(input.action==="cellularMode"&&!['auto','lteOnly','ltePreferred','wcdmaOnly','gsmOnly'].includes(p.mode))throw new Error("Invalid cellular mode");
  if(input.action==="diagnosticLogSnapshot"){
    if(p.after!==undefined&&(!Number.isInteger(p.after)||p.after<0))throw new Error("Invalid diagnostic log cursor");
    if(p.limit!==undefined&&(!Number.isInteger(p.limit)||p.limit<1||p.limit>400))throw new Error("Invalid diagnostic log limit");
  }
  if(DANGEROUS_ACTIONS.has(input.action)&&p.confirmed!==true)throw new Error("Explicit confirmation is required");
  return {id:input.id,action:input.action,params:p};
}
function createWebViewDispatcher(handlers, reply) {
  return async input => {
    let command; const startedAt=Date.now();
    try {
      command=validateWebViewCommand(input);
      const shouldTrace=command.action!=="diagnosticLogSnapshot";
      if(shouldTrace)debugLog("web-action:start",{id:command.id,action:command.action,paramKeys:Object.keys(command.params||{}),confirmed:command.params&&command.params.confirmed===true});
      const handler=handlers[command.action];
      if(typeof handler!=="function")throw new Error("Action is unavailable");
      const result=await handler(command.params);
      if(shouldTrace)debugLog("web-action:complete",{id:command.id,action:command.action,durationMs:Date.now()-startedAt,ok:true});
      const response={id:command.id,ok:true,result:result===undefined?null:result}; if(reply)await reply(response); return response;
    }
    catch(error){
      const action=command&&command.action||input&&input.action||"invalid";
      if(action!=="diagnosticLogSnapshot")debugLog("web-action:failed",{id:command&&command.id||input&&input.id||"",action,durationMs:Date.now()-startedAt,error:cleanError(error)});
      const response={id:command&&command.id||input&&typeof input.id==="string"?input.id:"",ok:false,error:cleanError(error)};const diagnostics=sanitizeDiagnosticOutput(error&&error.diagnostics||"");if(diagnostics)response.diagnostics=diagnostics;if(reply)await reply(response);return response;
    }
  };
}
async function applyWebView(web, method, payload) { await web.evaluateJavaScript(`window.${method} && window.${method}(${JSON.stringify(payload)})`,false); }
async function registerWebViewCommandChannel(web) {
  await web.evaluateJavaScript(`(function(){if(!Array.isArray(window.__zmiCommandQueue))window.__zmiCommandQueue=[];if(window.__zmiCommandListenerInstalled!==true){window.addEventListener('ZMICommand',function(e){window.__zmiCommandQueue.push(e.detail)});window.__zmiCommandListenerInstalled=true;}return true})()`, false);
}
async function nextWebViewCommand(web, sleep = scriptableSleep, stopped = () => false) {
  // Scriptable completion callbacks can contend with present(). Polling keeps
  // every evaluation finite and only starts after command channel registration.
  while (true) {
    if (stopped()) return null;
    const message = await web.evaluateJavaScript("window.__zmiCommandQueue && window.__zmiCommandQueue.length ? window.__zmiCommandQueue.shift() : null", false);
    if (message) return message;
    await sleep(150);
  }
}
function createDashboardDispatcher(auth, model, web, guards, native = {}) {
  const pasteboard=native.Pasteboard||(typeof Pasteboard!=="undefined"?Pasteboard:null);
  const shareSheet=native.ShareSheet||(typeof ShareSheet!=="undefined"?ShareSheet:null);
  const powerGuard=guards.powerGuard||createInFlightGuard();
  const firmwareGuard=guards.firmwareGuard||createInFlightGuard();
  const executePower=native.executePowerCommand||executePowerCommand;
  const validateCanary=native.validateFirmwareCanary||validateFirmwareCanary;
  const probeFirmwareTransport=native.runFirmwareTransportProbe||runFirmwareTransportProbe;
  const dryRunFirmwareRestore=native.runFirmwareRestoreDryRun||runFirmwareRestoreDryRun;
  const restoreFirmware=native.runFirmwareRestore||runFirmwareRestore;
  const firmwareJournal=native.readFirmwareJournalStatus||readFirmwareJournalStatus;
  const acknowledgeJournal=native.acknowledgeFirmwareJournal||acknowledgeFirmwareJournal;
  const runPower=kind=>{if(powerGuard.active)throw new Error("A power request is already in progress; no second command was sent");return powerGuard.run(()=>executePower(auth,kind));};
  const runCanaryValidation=()=>{if(firmwareGuard.active)throw new Error("Firmware validation is already in progress");return firmwareGuard.run(()=>validateCanary(auth));};
  const runFirmwareProbe=()=>{if(firmwareGuard.active)throw new Error("Firmware diagnostics are already in progress");return firmwareGuard.run(()=>probeFirmwareTransport());};
  const runFirmwareDryRun=async()=>{if(firmwareGuard.active||guards.smsGuard.active||guards.refreshGuard.active||powerGuard.active)throw new Error("Another router operation is still active; firmware dry-run was not started");FIRMWARE_EXCLUSIVE=true;try{return await firmwareGuard.run(()=>dryRunFirmwareRestore());}finally{FIRMWARE_EXCLUSIVE=false;}};
  const runFirmwareFlash=async()=>{if(firmwareGuard.active||guards.smsGuard.active||guards.refreshGuard.active||powerGuard.active)throw new Error("Another router operation is still active; firmware mode was not entered");FIRMWARE_EXCLUSIVE=true;try{const result=await firmwareGuard.run(()=>restoreFirmware(auth));if(result&&result.cancelled)FIRMWARE_EXCLUSIVE=false;return result;}catch(error){if(!error.stage0Transaction&&Number(error.destructivePostsAttempted)!==1)FIRMWARE_EXCLUSIVE=false;throw error;}};
  const runFirmwareJournalAcknowledge=async()=>{if(firmwareGuard.active)throw new Error("A firmware operation is already in progress");const result=await firmwareGuard.run(()=>acknowledgeJournal());if(result&&result.cleared)FIRMWARE_EXCLUSIVE=false;return result;};
  const refresh=()=>guards.refreshGuard.run(async()=>{const fresh=await loadPollingSnapshot(auth,model.sms);model.sms=fresh.sms;await applyWebView(web,"zmiApplyStatus",webPollPayload(fresh));return webPollPayload(fresh);});
  const refreshSms=()=>guards.smsGuard.run(async()=>{model.sms=await loadAllSms(auth);await applyWebView(web,"zmiApplySmsHistory",model.sms);return model.sms;});
  const detect=async p=>{const value=p.kind==="ussd"?await detectUssdCapability(auth):p.kind==="deviceAccess"?await detectDeviceAccess(auth):await detectCellularControl(auth);writeCapabilityCache(p.kind,value);model[p.kind]=value;await applyWebView(web,"zmiApplyCapability",{kind:p.kind,value});return value;};
  const detectExperimental=async()=>{
    const kinds=["ussd","deviceAccess","cellularControl"];
    await Promise.all(kinds.map(kind=>applyWebView(web,"zmiApplyCapability",{kind,value:{...(model[kind]||{}),state:"detecting",detail:"Detection in progress"}})));
    const probes=[()=>detectUssdCapability(auth),()=>detectDeviceAccess(auth),()=>detectCellularControl(auth)];
    const results={}; let completed=0;
    await Promise.all(probes.map(async(probe,i)=>{const kind=kinds[i];let value;try{const found=await probe();value={...found,state:found&&found.supported===true?"available":"unavailable"};}catch(error){value={state:"error",supported:false,detail:cleanError(error)};}results[kind]=value;model[kind]=value;writeCapabilityCache(kind,value);completed++;await applyWebView(web,"zmiApplyCapability",{kind,value,progress:{completed,total:kinds.length}});}));
    return {results,completed,total:kinds.length,failed:kinds.filter(kind=>results[kind].state==="error")};
  };
  const handlers={refresh,refreshSms,resumePolling:async()=>({resumed:true}),detectCapability:detect,detectExperimental,diagnosticLogSnapshot:p=>debugLogSnapshot(p&&p.after,p&&p.limit),safePreflight:()=>runReadOnlyPreflight(auth),appAuthProbe:()=>runAppAuthProbe(),firmwareTransportProbe:runFirmwareProbe,firmwareRestoreDryRun:runFirmwareDryRun,firmwareCanaryValidate:runCanaryValidation,firmwareFlash:runFirmwareFlash,firmwareJournalStatus:()=>firmwareJournal(),firmwareJournalAcknowledge:runFirmwareJournalAcknowledge,
    lastPowerReport:async()=>{const diagnostics=readLastPowerReport();if(!diagnostics)throw new Error("No power request report has been recorded yet");return {diagnostics};},
    copySms:async p=>{pasteboard.copyString(p.text);return {copied:true};},
    copyDiagnosticLog:async()=>{if(!pasteboard||typeof pasteboard.copyString!=="function")throw new Error("Clipboard is unavailable");const snapshot=debugLogSnapshot(0,400),text=formatDiagnosticReport(snapshot);pasteboard.copyString(text);return {copied:true,events:snapshot.events.length,bytes:text.length};},
    shareSms:async p=>{
      if(shareSheet&&typeof shareSheet.present==="function"){
        try { const presented=await shareSheet.present([p.text]); return presented===false?{shared:false,cancelled:true}:{shared:true}; }
        catch(error){if(error&&(error.cancelled===true||error.canceled===true||error.name==="CancellationError"||/cancel(?:led|ed)/i.test(String(error.message||""))))return {shared:false,cancelled:true};throw new Error("System share failed");}
      }
      if(pasteboard&&typeof pasteboard.copyString==="function"){pasteboard.copyString(p.text);return {shared:false,copied:true,fallback:true};}
      throw new Error("System sharing and clipboard fallback are unavailable");
    },
    sendSms:async p=>{const r=requireSuccessfulActionResult(parseSendResult(await sendSms(auth,p.to.trim(),p.text)),"The router rejected the send command");try{await refreshSms();}catch(error){r.historyWarning=`SMS was accepted, but history refresh failed: ${cleanError(error)}`;}return r;},
    deleteSms:async p=>{const r=await deleteSms(auth,p.id);if(!r.ok){const error=new Error(r.message||"SMS deletion was not confirmed");error.diagnostics=sanitizeDiagnostics(r.diagnostics||"");throw error;}model.sms=await loadAllSms(auth);if(model.sms.messages.some(message=>String(message.id)===String(p.id))){const error=new Error("The SMS is still present in the updated history.");error.diagnostics=sanitizeDiagnostics(r.diagnostics||"");throw error;}return {...r,id:String(p.id),history:model.sms};},
    ussd:async p=>requireSuccessfulActionResult(await executeUssd(auth,readCapabilityCache("ussd")||await detectUssdCapability(auth),p.code),"USSD request failed"),
    deviceAccess:async p=>{const detected=readCapabilityCache("deviceAccess");if(!detected)throw new Error("Run Detect first");return requireSuccessfulActionResult(await executeDeviceAccess(auth,p.deviceAction,p.deviceAction),"Device-access action failed");},
    cellularReconnect:async()=>{const c=readCapabilityCache("cellularControl")||await detectCellularControl(auth);const r=requireSuccessfulActionResult(await cellularControlModule.executeReconnect(cellularControlApi(auth),c),"Cellular reconnect failed");await refresh();return r;},
    cellularMode:async p=>{const c=readCapabilityCache("cellularControl")||await detectCellularControl(auth),m=cellularControlModule.modeById(p.mode);if(!m)throw new Error("Unknown cellular network mode");const r=requireSuccessfulActionResult(await cellularControlModule.executeSetMode(cellularControlApi(auth),c,m.id),"Cellular mode change failed");await refresh();return r;},
    resetTraffic:async()=>{throw new Error("Traffic reset is unavailable because no universal write contract is confirmed");},
    reboot:()=>runPower("reboot"),powerOff:()=>runPower("powerOff")};
  const safeDuringFirmware=new Set(["copySms","copyDiagnosticLog","shareSms","diagnosticLogSnapshot","firmwareJournalStatus","firmwareJournalAcknowledge","lastPowerReport"]);
  Object.keys(handlers).forEach(action=>{const handler=handlers[action];handlers[action]=params=>{if(FIRMWARE_EXCLUSIVE&&!safeDuringFirmware.has(action))throw new Error("Firmware-exclusive mode is active; this router action was not sent");return handler(params);};});
  return createWebViewDispatcher(handlers,response=>applyWebView(web,"zmiApplyActionResult",response));
}
function diagnosticNumber(value){if(value===null||value===undefined||value==="")return null;const parsed=Number(value);return Number.isFinite(parsed)?parsed:null;}
function powerDiagnosticStage(value){if(!value||typeof value!=="object"||!["statusCode","response","bytes","text","durationMs","responseClass","redirectCount","error","connectionLost"].some(key=>Object.prototype.hasOwnProperty.call(value,key)))return null;const status=value.statusCode!==undefined?value.statusCode:value.response&&value.response.statusCode,bytes=value.bytes!==undefined?value.bytes:Object.prototype.hasOwnProperty.call(value,"text")?String(value.text||"").length:null;return {statusCode:diagnosticNumber(status),bytes:diagnosticNumber(bytes),durationMs:diagnosticNumber(value.durationMs),responseClass:String(value.responseClass||"none"),redirectCount:diagnosticNumber(value.redirectCount)};}
function powerDiagnostics(method,operation,file,error,outcome,responseClass,context={}){const descriptor=apiContractModule&&apiContractModule.normalizeModelDescriptor?apiContractModule.normalizeModelDescriptor(file):(typeof file==="string"?{name:file,method:"POST"}:file||{}),result=context.result||error&&error.appStage||{},login=context.login||{},probe=context.probe||{};const report={schema:1,mode:"power-command",generatedAt:Date.now(),software:softwareIdentity(context.software||{}),checkpoint:String(context.checkpoint||"complete"),client:"APP",authFlow:"zmi-apk-1.2.42-persisted-login-header",command:{method:method||descriptor.method||"unknown",operation:String(operation||""),endpoint:XML_REQUEST_PATH,file:String(descriptor.name||""),outcome:outcome||"unknown",effectConfirmed:false,responseClass:responseClass||result.responseClass||"none",response:powerDiagnosticStage(result),responseFingerprint:result.responseFingerprint||null},session:{initialNonceCount:diagnosticNumber(login.queryNonceCount),loginHeaderNonceCount:diagnosticNumber(login.loginHeaderNonceCount),login:powerDiagnosticStage(login),identityProbe:powerDiagnosticStage(probe),authorizationPersisted:login.authHeaderPersisted===true,authorizationReusedForProbeAndCommand:probe.authHeaderReused===true&&result.authHeaderReused===true,sessionCookieReceived:login.sessionCookieReceived===true,sessionCookieSent:result.sessionCookieSent===true},safety:{destructiveAttempts:context.destructiveAttempted===true?1:0,automaticRetries:0,replayed:false,requestBodyPresent:false,redirectsAllowed:false},error:error?cleanError(error):null};return formatDiagnosticReport(report);}
async function executePowerCommand(auth,kind,options={}) {
  const compatibility=options.compatibility||powerCompatibilityModule;
  let profile=options.profile;
  let powerAuth=options.appAuth||null;
  let appProbe=null;
  let spec=null;
  let destructiveAttempted=false;
  let phase="compatibility";
  const saveCheckpoint=(checkpoint,operation=phase,file={name:phase,method:"GET"})=>rememberLastPowerReport(powerDiagnostics(null,operation,file,null,"in-progress",null,{login:powerAuth&&powerAuth.appLogin,probe:appProbe,destructiveAttempted,software:options.software,checkpoint}));
  saveCheckpoint("entered",kind,{name:kind,method:"GET"});
  try {
    if(!compatibility||typeof compatibility.command!=="function")throw new Error("Power compatibility module is unavailable");
    if(!profile){
      let status;
      if(options.getStatus){phase="identity-probe";saveCheckpoint("identity-probe","identity-probe",{name:"status1",method:"GET"});status=await options.getStatus(auth);}
      else {
        const makeSession=options.createAppSession||createAppSession;
        phase="app-login";
        saveCheckpoint("app-login","app-login",{name:"login",method:"GET"});
        powerAuth=await makeSession();
        const readAppStatus=options.getAppStatus||((session)=>appXmlGet(session,"status1",5));
        phase="identity-probe";
        saveCheckpoint("identity-probe","identity-probe",{name:"status1",method:"GET"});
        appProbe=await readAppStatus(powerAuth);
        status=appProbe&&typeof appProbe==="object"&&Object.prototype.hasOwnProperty.call(appProbe,"text")?appProbe.text:appProbe;
      }
      profile=powerProfileForIdentity({model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status)});
      ACTIVE_POWER_PROFILE=profile;
    }
    spec=compatibility.command(profile,kind);
    if(!options.writeThenVerify&&!powerAuth)throw new Error("APP power session is unavailable");
    const submit=options.writeThenVerify||((operation)=>submitAppPowerCommand(powerAuth,operation.model));
    phase="power-command";
    destructiveAttempted=true;
    saveCheckpoint("destructive-request-started",spec.operation,spec.file);
    const result=await submit({model:spec.file,xml:`<RGW><${spec.tree}></${spec.tree}></RGW>`,destructive:true});
    if(result.error&&!result.connectionLost)throw result.error;
    if(!["request-accepted","delivery-unknown","submitted","unknown"].includes(result.outcome))throw new Error(`Unexpected destructive command outcome: ${result.outcome}`);
    const accepted=result.outcome==="request-accepted"||result.outcome==="submitted";
    const diagnostics=powerDiagnostics(result.method,spec.operation,spec.file,result.error,result.outcome,result.responseClass,{login:powerAuth&&powerAuth.appLogin,probe:appProbe,result,destructiveAttempted:true,software:options.software,checkpoint:"completed"});
    rememberLastPowerReport(diagnostics);
    const effect=kind==="powerOff"?"shutdown":"reboot";
    return {...result,effectConfirmed:false,message:accepted?`The APP-compatible request was accepted; the ${effect} effect is not yet confirmed.`:"The command was attempted once; delivery is unknown after connection loss.",diagnostics};
  } catch(error) {
    const operation=spec&&spec.operation||phase,file=spec&&spec.file||{name:phase==="identity-probe"?"status1":"login",method:"GET"};
    error.diagnostics=powerDiagnostics(null,operation,file,error,"failed",null,{login:powerAuth&&powerAuth.appLogin,probe:appProbe,result:error&&error.appStage,destructiveAttempted,software:options.software,checkpoint:"failed"});
    rememberLastPowerReport(error.diagnostics);
    throw error;
  }
}

function appAuthProbeDiagnostics(error,context={}) {
  const login=context.login||{},probe=context.probe||{},identity=context.identity||{};
  const loginStage=context.loginStage||login,probeStage=context.probeStage||probe;
  const report={
    schema:1,
    mode:"app-auth-probe",
    generatedAt:Date.now(),
    software:softwareIdentity(context.software||{}),
    client:"APP",
    authFlow:"zmi-apk-1.2.42-persisted-login-header",
    outcome:error?"failed":"authenticated",
    phase:String(context.phase||"complete"),
    identity:{
      model:String(identity.model||""),
      hardware:String(identity.hardware||""),
      firmware:String(identity.firmware||""),
      exactFirmware:identity.exactFirmware===true
    },
    session:{
      initialNonceCount:diagnosticNumber(login.queryNonceCount),
      loginHeaderNonceCount:diagnosticNumber(login.loginHeaderNonceCount),
      login:powerDiagnosticStage(loginStage),
      identityProbe:powerDiagnosticStage(probeStage),
      authorizationPersisted:login.authHeaderPersisted===true,
      authorizationReusedForProbe:probe.authHeaderReused===true,
      sessionCookieReceived:login.sessionCookieReceived===true,
      sessionCookieSent:probe.sessionCookieSent===true
    },
    safety:{
      methodsUsed:["GET"],
      writesAttempted:0,
      destructiveAttempts:0,
      destructiveEndpointsTouched:false,
      requestBodyPresent:false,
      automaticRetries:0,
      redirectsAllowed:false
    },
    error:error?cleanError(error):null
  };
  return formatDiagnosticReport(report);
}

async function runAppAuthProbe(options={}) {
  let session=null,probe=null,phase="app-login",identity={};
  try {
    session=await (options.createAppSession||createAppSession)();
    phase="identity-probe";
    probe=await (options.getAppStatus||((value)=>appXmlGet(value,"status1",5)))(session);
    const status=probe&&typeof probe==="object"&&Object.prototype.hasOwnProperty.call(probe,"text")?probe.text:probe;
    const rawModel=firstText(status,["model","model_name","product_name"]),hardware=hardwareRevision(status),firmware=firmwareVersion(status);
    identity={model:/^LV01$/i.test(rawModel)?"MF885":rawModel,hardware,firmware,exactFirmware:firmware==="2.5.94_release_MF855_NZ_CP_2.129.003"};
    phase="complete";
    const diagnostics=appAuthProbeDiagnostics(null,{login:session&&session.appLogin,probe,identity,phase,software:options.software});
    return {ok:true,report:JSON.parse(diagnostics),text:diagnostics,diagnostics};
  } catch(error) {
    error.diagnostics=appAuthProbeDiagnostics(error,{login:session&&session.appLogin,probe,loginStage:phase==="app-login"&&error&&error.appStage,probeStage:phase==="identity-probe"&&error&&error.appStage,identity,phase,software:options.software});
    throw error;
  }
}

function firmwareStatusRouteDefinitions(){
  return Object.freeze([
    Object.freeze({id:"restore-status-duster",model:"GetRestoreStatus",method:"GET",query:"method=get&module=duster&file=GetRestoreStatus",schema:"restore"}),
    Object.freeze({id:"restore-status-direct",model:"GetRestoreStatus",method:"GET",query:"method=get&file=GetRestoreStatus",schema:"restore"}),
    Object.freeze({id:"upgrade-status-direct",model:"upgrade_firmware",method:"GET",query:"method=get&file=upgrade_firmware",schema:"upgrade"}),
    Object.freeze({id:"upgrade-status-duster",model:"upgrade_firmware",method:"GET",query:"method=get&module=duster&file=upgrade_firmware",schema:"upgrade"})
  ]);
}

function firmwareStatusValues(schema,xml){
  if(schema==="restore")return {status:firstText(xml,["status"]),progress:firstText(xml,["progress"]),cause:firstText(xml,["cause"])};
  return {
    support32mFlash:firstText(xml,["support_32m_flash"]),
    upgradeStatus:firstText(xml,["upgrade_status"]),
    progress:firstText(xml,["progress"]),
    upgradeFailCause:firstText(xml,["upgrade_fail_cause"]),
    backupStatus:firstText(xml,["backup_status"]),
    backupProgress:firstText(xml,["backup_progress"]),
    backupFailCause:firstText(xml,["backup_fail_cause"]),
    restoreStatus:firstText(xml,["restore_status"]),
    restoreProgress:firstText(xml,["restore_progress"]),
    restoreFailCause:firstText(xml,["restore_fail_cause"])
  };
}

async function readFirmwareStatusRoute(auth,route,options={}){
  const RequestType=options.Request||(typeof Request!=="undefined"?Request:null);
  if(!RequestType)throw new Error("Native GET transport is unavailable");
  if(!route||route.method!=="GET"||!/^(?:method=get&)/.test(String(route.query||"")))throw new Error("Firmware status probe refused a non-GET route");
  const req=new RequestType(`http://${ROUTER_HOST}${XML_REQUEST_PATH}?${route.query}`);
  req.method="GET";
  req.headers=appRequestHeaders(auth,"GET");
  req.timeoutInterval=Math.max(1,Math.min(10,Number(options.timeout)||5));
  req._zmi={method:"GET",operation:`firmware-status:${route.id}`,timeout:req.timeoutInterval,body:null,appClient:true};
  rejectRedirects(req);
  const startedAt=Date.now();
  const result=await loadResponse(req,{requestId:++DEBUG_REQUEST_SEQUENCE,operation:`Firmware status ${route.id}`,attempt:1,startedAt});
  const checked=assertAppResponse(result,`Firmware status ${route.id}`);
  return {...checked,text:result.text,bytes:String(result.text||"").length,durationMs:Date.now()-startedAt,redirectCount:Number(result.redirectCount)||0,method:"GET"};
}

async function runFirmwareTransportProbe(options={}){
  const clock=typeof options.now==="function"?options.now:Date.now;
  const routes=firmwareStatusRouteDefinitions();
  const makeSession=options.createAppSession||createAppSession;
  const getIdentity=options.getAppStatus||((session)=>appXmlGet(session,"status1",5));
  const readRoute=options.readRoute||((session,route)=>readFirmwareStatusRoute(session,route,options));
  let session=null,identityResponse=null,phase="app-login";
  try{
    session=await makeSession();
    phase="identity";
    identityResponse=await getIdentity(session);
    const status=identityResponse&&typeof identityResponse==="object"&&Object.prototype.hasOwnProperty.call(identityResponse,"text")?identityResponse.text:identityResponse;
    const rawModel=firstText(status,["model","model_name","product_name","device_name"]),hardware=hardwareRevision(status),firmware=firmwareVersion(status);
    const identity={model:/^LV01$/i.test(rawModel)?"MF885":rawModel,rawModel,hardware,firmware,exactFirmware:firmware==="2.5.94_release_MF855_NZ_CP_2.129.003"};
    const battery=parseBattery(status,identity);
    const observations=[];
    for(const route of routes){
      phase=route.id;
      try{
        const response=await readRoute(session,route);
        const text=response&&typeof response==="object"&&Object.prototype.hasOwnProperty.call(response,"text")?response.text:String(response||"");
        const statusCode=response&&response.statusCode!==undefined?Number(response.statusCode):response&&response.response&&Number(response.response.statusCode);
        const redirectCount=Number(response&&response.redirectCount)||0;
        observations.push({id:route.id,model:route.model,method:"GET",requestPath:XML_REQUEST_PATH,query:route.query,ok:Number.isFinite(statusCode)?statusCode>=200&&statusCode<=299&&!unauthorized(text)&&redirectCount===0:!unauthorized(text)&&redirectCount===0,statusCode:Number.isFinite(statusCode)?statusCode:null,responseClass:String(response&&response.responseClass||classifyControlResponse(text)),bytes:String(text).length,redirectCount,values:firmwareStatusValues(route.schema,text)});
      }catch(error){
        observations.push({id:route.id,model:route.model,method:"GET",requestPath:XML_REQUEST_PATH,query:route.query,ok:false,statusCode:null,responseClass:"error",bytes:0,redirectCount:0,values:{},error:cleanError(error)});
      }
    }
    const exactDevice=identity.model==="MF885"&&identity.hardware==="MF96 Ver.D"&&identity.exactFirmware;
    const readSideComplete=exactDevice&&observations.every(item=>item.ok);
    const fingerprintSource=JSON.stringify({identity,observations:observations.map(item=>({id:item.id,query:item.query,statusCode:item.statusCode,responseClass:item.responseClass,values:item.values}))});
    const stage0=options.stage0||firmwareStage0Module;
    const observationFingerprint=stage0&&typeof stage0.sha256Hex==="function"?stage0.sha256Hex(utf8Bytes(fingerprintSource)):md5(fingerprintSource);
    const report={schema:1,mode:"firmware-transport-read-probe",generatedAt:clock(),software:softwareIdentity(options.software||{}),identity,power:{batteryPercent:battery.percent,batteryStatus:battery.rawStatus,chargerStatus:battery.chargerStatus,chargerConnected:battery.chargerConnected===true},session:{authFlow:"zmi-apk-1.2.42-persisted-login-header",authorizationPersisted:session&&session.appLogin&&session.appLogin.authHeaderPersisted===true,sessionCookieReceived:session&&session.appLogin&&session.appLogin.sessionCookieReceived===true},observations,readSideComplete,observationFingerprint,limitations:["RestoreFw upload POST was not sent.","Multipart fields, filename, MIME type, acceptance response, and redirect behavior remain unverified on this router.","This report cannot populate the destructive transport allowlist."],safety:{methodsUsed:["GET"],routerGetsAttempted:3+routes.length,writesAttempted:0,firmwarePostsAttempted:0,requestBodiesPresent:false,automaticRetries:0,redirectsAllowed:false,flashAllowed:false}};
    const text=formatDiagnosticReport(report);
    return {ok:readSideComplete,readSideComplete,flashAllowed:false,report,text,diagnostics:text};
  }catch(error){
    const report={schema:1,mode:"firmware-transport-read-probe",generatedAt:clock(),phase,readSideComplete:false,limitations:["RestoreFw upload POST was not sent.","This report cannot populate the destructive transport allowlist."],safety:{methodsUsed:["GET"],writesAttempted:0,firmwarePostsAttempted:0,requestBodiesPresent:false,automaticRetries:0,redirectsAllowed:false,flashAllowed:false},error:cleanError(error)};
    error.diagnostics=formatDiagnosticReport(report);
    throw error;
  }
}

async function runReadOnlyPreflight(auth,options={}) {
  const module=options.module||readOnlyPreflightModule;
  if(!module||typeof module.collect!=="function")throw new Error("Read-only preflight module is unavailable");
  const get=options.get||((endpoint)=>xmlRequest(auth,"GET",endpoint,null,true,10));
  const report=await module.collect({get},{now:options.now||Date.now(),powerDecoder:options.powerDecoder||powerStatusModule,software:softwareIdentity(options.software||{})});
  return {report,text:module.format(report)};
}

function selectedFileName(path) {
  const raw=String(path||"").replace(/\\/g,"/").split("/").pop()||"selected firmware file";
  try { return decodeURIComponent(raw).slice(0,180); } catch (_) { return raw.slice(0,180); }
}

function utf8Bytes(value){
  const bytes=[];
  for(const symbol of String(value||"")){
    const code=symbol.codePointAt(0);
    if(code<=0x7f)bytes.push(code);
    else if(code<=0x7ff)bytes.push(0xc0|(code>>6),0x80|(code&0x3f));
    else if(code<=0xffff)bytes.push(0xe0|(code>>12),0x80|((code>>6)&0x3f),0x80|(code&0x3f));
    else bytes.push(0xf0|(code>>18),0x80|((code>>12)&0x3f),0x80|((code>>6)&0x3f),0x80|(code&0x3f));
  }
  return bytes;
}

function firmwareUnitFingerprint(status,stage0){
  const candidates=[
    ["imei",firstText(status,["imei","IMEI","device_imei","modem_imei"])],
    ["serial",firstText(status,["serial_number","serial","device_sn","sn"])],
    ["lan-mac",firstText(status,["lan_mac","mac_address","device_mac","mac"])]
  ];
  const selected=candidates.find(item=>String(item[1]||"").trim());
  if(!selected||!stage0||typeof stage0.sha256Hex!=="function")return "";
  return stage0.sha256Hex(utf8Bytes(`mf885-unit-v1|${selected[0]}|${String(selected[1]).trim().toLowerCase()}`));
}

function firmwareRestoreAvailability(stage0 = firmwareStage0Module, adapter) {
  if (!stage0) return { available:false, allowlistedContracts:0, reason:"SafeFlash Stage 0 module is unavailable." };
  const base = typeof stage0.restoreAvailability === "function"
    ? stage0.restoreAvailability()
    : { available:false, atomicCrossProcessLeaseProven:false, allowlistedContracts:Array.isArray(stage0.VERIFIED_RESTORE_TRANSPORTS)?stage0.VERIFIED_RESTORE_TRANSPORTS.length:0, reason:"SafeFlash Stage 0 does not expose the complete atomic-lease availability gate." };
  if (!base.available) return { ...base, installerCompiled:true };
  if(stage0.ATOMIC_RESTORE_LEASE_PROVEN!==true||base.atomicCrossProcessLeaseProven!==true)return {available:false,installerCompiled:true,allowlistedContracts:base.allowlistedContracts,atomicCrossProcessLeaseProven:false,reason:"RestoreFw is locked because an atomic, non-stealable cross-process lease is not proven in both Stage 0 and its availability report."};
  const transport = adapter || null;
  const required = ["prepare", "sendOnce", "readStatus", "classifyStatus", "verifyBoot"];
  if (!transport || required.some(name => typeof transport[name] !== "function")) {
    return { available:false, installerCompiled:true, allowlistedContracts:base.allowlistedContracts, reason:"A transport contract exists, but its reviewed one-shot Scriptable adapter is missing." };
  }
  const safety = transport.safety || {};
  const evidence=transport.transportEvidence||{};
  const physicalEvidence=transport.recoveryEvidence||null,softwareRiskEvidence=transport.softwareRiskEvidence||null;
  if((physicalEvidence&&softwareRiskEvidence)||(!physicalEvidence&&!softwareRiskEvidence))return {available:false,installerCompiled:true,allowlistedContracts:base.allowlistedContracts,reason:"The firmware adapter must bind exactly one physical recovery or software-only risk record."};
  if(!Object.isFrozen(evidence)||!Object.isFrozen(physicalEvidence||softwareRiskEvidence))return {available:false,installerCompiled:true,allowlistedContracts:base.allowlistedContracts,reason:"Compiled firmware evidence records are not immutable."};
  if(!/^[0-9a-f]{64}$/.test(String(transport.artifactSha256||""))||transport.artifactSha256!==evidence.adapterArtifactSha256)return {available:false,installerCompiled:true,allowlistedContracts:base.allowlistedContracts,reason:"The reviewed firmware adapter artifact hash does not match the compiled contract."};
  if (safety.destructivePostLimit !== 1 || safety.automaticRetries !== 0 || safety.redirectsAllowed !== false || safety.statusHttpMethod !== "GET" || safety.platformExclusiveLease!==true || safety.exclusiveLeaseProfile!==evidence.exclusiveLeaseProfile) {
    return { available:false, installerCompiled:true, allowlistedContracts:base.allowlistedContracts, reason:"The compiled firmware adapter does not satisfy ONE POST / NO RETRY / NO REDIRECT / GET-only status rules." };
  }
  return { available:true, installerCompiled:true, allowlistedContracts:base.allowlistedContracts, reason:"Reviewed Stage 0 transport adapter is compiled; every live gate and native confirmation still must pass." };
}

function createFirmwareQualificationStore(stage0, keychain) {
  const storage = keychain || (typeof Keychain !== "undefined" ? Keychain : null);
  const key = stage0 && stage0.GOLDEN_QUALIFICATION_KEY;
  const secretKey=`${key}-integrity-secret`;
  if (!storage || !key || typeof storage.get !== "function" || typeof storage.set !== "function") throw new Error("Persistent golden qualification storage is unavailable.");
  const canonical=value=>JSON.stringify([value.schema,value.completedAt,value.transactionId,value.state,value.imageId,value.imageSha256,value.unitFingerprintSha256,value.transportContractId,value.transportCaptureSha256,value.riskProfile,value.riskEvidenceId,value.riskCaptureSha256,value.recoveryEvidenceId,value.recoveryCaptureSha256]);
  const signature=(value,secret)=>stage0.sha256Hex(utf8Bytes(`mf885-golden-qualification-v2|${secret}|${canonical(value)}`));
  const secret=()=>{
    if(typeof storage.contains==="function"&&storage.contains(secretKey))return storage.get(secretKey);
    const UUIDType=typeof UUID!=="undefined"?UUID:null;
    if(!UUIDType||typeof UUIDType.string!=="function")throw new Error("Secure local qualification integrity key generation is unavailable.");
    const created=UUIDType.string();storage.set(secretKey,created);return created;
  };
  return {
    async load() {
      if (typeof storage.contains === "function" && !storage.contains(key)) return null;
      let raw;
      try { raw=storage.get(key); } catch (_) { return null; }
      if (!raw) return null;
      try { const parsed=JSON.parse(raw),expected=signature(parsed,secret());if(!parsed.integrity||parsed.integrity.scheme!=="sha256-secret-prefix-v2"||parsed.integrity.signature!==expected)throw new Error("mismatch");return Object.freeze({...parsed,integrityVerified:true}); } catch (_) { throw new Error("Stored golden qualification is corrupt or failed integrity verification; canary flashing is locked."); }
    },
    async save(value) {
      const signed={...value,integrity:{scheme:"sha256-secret-prefix-v2",signature:signature(value,secret())}};
      storage.set(key,JSON.stringify(signed));
      const saved=await this.load();
      const expectedRiskCapture=value.riskCaptureSha256||value.recoveryCaptureSha256,savedRiskCapture=saved&&saved.riskCaptureSha256||saved&&saved.recoveryCaptureSha256;
      if(!saved||saved.transactionId!==value.transactionId||saved.transportCaptureSha256!==value.transportCaptureSha256||savedRiskCapture!==expectedRiskCapture||saved.unitFingerprintSha256!==value.unitFingerprintSha256)throw new Error("Golden qualification could not be read back; canary flashing remains locked.");
      return saved;
    }
  };
}

async function readFirmwareJournalStatus(options={}){
  const stage0=options.stage0||firmwareStage0Module;
  if(!stage0||typeof stage0.loadJournal!=="function")throw new Error("SafeFlash Stage 0 journal is unavailable.");
  const journal=options.journal||stage0.createKeychainJournal(stage0.JOURNAL_KEY,options.keychain);
  let transaction=await stage0.loadJournal(journal);
  if(transaction&&!stage0.TERMINAL_STATES.includes(transaction.state))transaction=await stage0.recoverPersistentTransaction(journal,typeof options.now==="function"?options.now():Date.now());
  const summary=transaction?{id:transaction.transactionId,state:transaction.state,imageId:transaction.imageId,imageSha256:transaction.imageSha256,updatedAt:transaction.updatedAt,destructivePostCount:transaction.destructivePostCount}:null;
  const clearable=!!(transaction&&[stage0.TRANSACTION_STATES.BOOT_VERIFIED,stage0.TRANSACTION_STATES.FAILED].includes(transaction.state));
  return {present:!!transaction,transaction:summary,clearable,unknownLocked:!!(transaction&&transaction.state===stage0.TRANSACTION_STATES.UNKNOWN),text:formatDiagnosticReport({schema:1,mode:"firmware-stage0-journal",generatedAt:Date.now(),transaction:summary,clearable,safety:{routerRequestsAttempted:0,firmwarePostsAttempted:0}})};
}

async function acknowledgeFirmwareJournal(options={}){
  const stage0=options.stage0||firmwareStage0Module;
  if(!stage0||typeof stage0.clearCompletedJournal!=="function")throw new Error("SafeFlash Stage 0 journal is unavailable.");
  const journal=options.journal||stage0.createKeychainJournal(stage0.JOURNAL_KEY,options.keychain);
  const transaction=await stage0.loadJournal(journal);
  if(!transaction) return {cleared:false,reason:"No Stage 0 journal is stored."};
  if(transaction.state===stage0.TRANSACTION_STATES.BOOT_VERIFIED&&transaction.imageId===stage0.GOLDEN_IMAGE.id){
    const store=options.qualificationStore||createFirmwareQualificationStore(stage0,options.keychain),qualification=await store.load();
    if(!qualification||qualification.transactionId!==transaction.transactionId||qualification.unitFingerprintSha256!==transaction.unitFingerprintSha256)throw new Error("Golden qualification is missing or does not match this completed transaction; the journal was not cleared.");
  }
  await stage0.clearCompletedJournal(journal,transaction.transactionId);
  return {cleared:true,transactionId:transaction.transactionId,previousState:transaction.state};
}

async function confirmFirmwareRestore(image, device, power, transport, risk, options = {}) {
  const prefix=String(image.sha256||"").slice(0,12),softwareOnly=risk&&risk.profile==="software-only-risk-v1",phrase=softwareOnly?`NO RECOVERY FLASH ${prefix}`:`FLASH ${prefix}`;
  if (typeof options.confirm === "function") return options.confirm({ phrase, image, device, power, transport, risk });
  const AlertType=options.Alert||(typeof Alert!=="undefined"?Alert:null);
  if(!AlertType)throw new Error("Native firmware confirmation is unavailable.");
  const alert=new AlertType();
  alert.title="Stage 0 firmware restore";
  const riskLine=softwareOnly?"Risk: SOFTWARE-ONLY · NO HARDWARE RECOVERY · worst case is a bricked router":`Recovery: ${String(risk&&risk.evidenceId||"reviewed physical record")}`;
  alert.message=`Image: ${image.file}\nSHA-256: ${image.sha256}\nDevice: ${device.model} ${device.hardware} · unit ${String(device.unitFingerprintSha256||"").slice(0,12)}\nBattery: ${power.batteryPercent}% · external power connected\nContract: ${transport.contractId} · capture ${String(transport.captureSha256||"").slice(0,12)}\n${riskLine}\n\nONE POST. NO AUTOMATIC RETRY. A timeout becomes UNKNOWN. Type ${phrase} to continue.`;
  alert.addTextField(phrase,"");
  alert.addDestructiveAction("Arm one firmware POST");
  alert.addCancelAction("Cancel");
  const choice=await alert.presentAlert();
  return choice===0&&String(alert.textFieldValue(0)||"").trim()===phrase;
}

async function runFirmwareRestoreDryRun(options = {}) {
  const stage0=options.stage0||firmwareStage0Module;
  const dryRun=options.dryRunModule||firmwareRestoreDryRunModule;
  if(!stage0||typeof stage0.createImageEvidence!=="function"||typeof stage0.validateImageEvidence!=="function"||typeof stage0.validateDevice!=="function"||typeof stage0.validatePower!=="function")throw new Error("SafeFlash Stage 0 dry-run prerequisites are unavailable.");
  if(!dryRun||typeof dryRun.verifiedMultipartManifest!=="function"||typeof dryRun.validateGetOnlyTrace!=="function")throw new Error("RestoreFw dry-run core is unavailable.");
  const clock=typeof options.now==="function"?options.now:Date.now;
  const picker=options.documentPicker||(typeof DocumentPicker!=="undefined"?DocumentPicker:null);
  const fileManager=options.fileManager||(typeof FileManager!=="undefined"?FileManager.local():null);
  if(!picker||typeof picker.openFile!=="function"||!fileManager||typeof fileManager.read!=="function")throw new Error("Scriptable file selection is unavailable.");
  const trace=[];
  let phase="file-selection",selectedName="",image=null,manifest=null,identity=null,power=null,session=null,sessionComplete=false,observations=[];
  const safety=()=>{
    const checked=dryRun.validateGetOnlyTrace(trace);
    const routerGetCountSemantics=phase==="app-session"&&!sessionComplete?"conservative-upper-bound":"attempted";
    return {methodsUsed:trace.length?["GET"]:[],routerGetsAttempted:checked.routerGetsAttempted,routerGetCountSemantics,routerWritesAttempted:0,writesAttempted:0,firmwarePostsAttempted:0,multipartNetworkRequestsConstructed:0,automaticRetries:0,redirectsAllowed:false,liveJournalTouched:false,flashAllowed:false,traceValid:checked.ok,traceErrors:checked.errors};
  };
  const diagnostics=(error=null)=>formatDiagnosticReport({schema:dryRun.DRY_RUN_SCHEMA||1,mode:"firmware-restore-dry-run",generatedAt:clock(),phase,selectedFile:selectedName&&image?{name:selectedName,size:image.size,sha256:image.sha256}:selectedName?{name:selectedName}:null,image:image?{id:image.id,doubleHashVerified:!!manifest}:null,device:identity?{model:identity.model,hardware:identity.hardware,firmware:identity.firmware,unitFingerprintPrefix:String(identity.unitFingerprintSha256||"").slice(0,12)}:null,power:power?{batteryPercent:power.batteryPercent,chargerConnected:power.chargerConnected,minimumBatteryPercent:stage0.SOFTWARE_ONLY_MIN_BATTERY_PERCENT}:null,wireManifest:manifest,statusObservations:observations,productionAvailability:typeof stage0.restoreAvailability==="function"?stage0.restoreAvailability():{available:false},liveBlockers:Array.isArray(dryRun.LIVE_BLOCKERS)?dryRun.LIVE_BLOCKERS.slice():[],safety:safety(),error:error?cleanError(error):null});
  try{
    let selected;
    try{selected=await picker.openFile();}
    catch(error){if(error&&(error.cancelled===true||error.canceled===true||/cancel(?:led|ed)/i.test(String(error.message||""))))return {cancelled:true,ok:false,flashAllowed:false};throw new Error("Firmware file selection failed before any router request.");}
    const path=Array.isArray(selected)?selected[0]:selected;
    if(!path)return {cancelled:true,ok:false,flashAllowed:false};
    selectedName=selectedFileName(path);
    let data;
    try{
      if(typeof fileManager.downloadFileFromiCloud==="function")await fileManager.downloadFileFromiCloud(path);
      data=fileManager.read(path);
    }catch(_){throw new Error("The selected firmware file could not be downloaded or read. No router request was made.");}
    if(!data||typeof data.getBytes!=="function")throw new Error("RestoreFw dry-run requires immutable Scriptable Data from the native file reader.");
    let payloadBytes;
    try{payloadBytes=new Uint8Array(data.getBytes());}
    catch(_){throw new Error("The selected firmware bytes could not be sealed in memory. No router request was made.");}
    phase="image-validation";
    const firstEvidence=stage0.createImageEvidence(payloadBytes,clock());
    const firstValidation=stage0.validateImageEvidence(firstEvidence,clock());
    if(!firstValidation.ok)throw new Error(firstValidation.errors.join(" "));
    image=firstValidation.image;
    const secondEvidence=stage0.createImageEvidence(payloadBytes,clock());
    if(secondEvidence.sha256!==firstEvidence.sha256||secondEvidence.size!==firstEvidence.size)throw new Error("Firmware bytes changed between the two dry-run hashes. No router request was made.");
    manifest=dryRun.verifiedMultipartManifest({data:payloadBytes,image,sha256Hex:stage0.sha256Hex});
    if(!manifest||manifest.networkRequestConstructed!==false||manifest.payloadRoundTripVerified!==true)throw new Error("The local RestoreFw wire manifest did not verify.");

    phase="app-session";
    trace.push({method:"GET",query:"login-challenge",bodyPresent:false},{method:"GET",query:"Action=Digest&client=APP",bodyPresent:false});
    session=await (options.createAppSession||createAppSession)();
    sessionComplete=true;
    phase="identity";
    trace.push({method:"GET",query:"method=get&module=duster&file=status1",bodyPresent:false});
    const identityResponse=await (options.getAppStatus||((value)=>appXmlGet(value,"status1",5)))(session);
    const status=identityResponse&&typeof identityResponse==="object"&&Object.prototype.hasOwnProperty.call(identityResponse,"text")?identityResponse.text:identityResponse;
    const observedAt=clock();
    identity={model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status),unitFingerprintSha256:firmwareUnitFingerprint(status,stage0),source:"status1-live",observedAt};
    const deviceCheck=stage0.validateDevice(identity,clock());
    const battery=parseBattery(status,identity);
    power={batteryPercent:battery.percent,chargerConnected:battery.chargerConnected===true,source:"status1-live",observedAt};
    const powerCheck=stage0.validatePower(power,clock(),stage0.SOFTWARE_ONLY_MIN_BATTERY_PERCENT);
    if(!deviceCheck.ok||!powerCheck.ok)throw new Error([...deviceCheck.errors,...powerCheck.errors].join(" "));

    phase="get-only-status";
    const routes=options.routes||firmwareStatusRouteDefinitions();
    if(!Array.isArray(routes)||!routes.length||routes.some(route=>!route||route.method!=="GET"))throw new Error("RestoreFw dry-run refused a non-GET status route.");
    const readRoute=options.readRoute||((value,route)=>readFirmwareStatusRoute(value,route,options));
    for(const route of routes){
      trace.push({method:"GET",query:route.query,bodyPresent:false});
      try{
        const response=await readRoute(session,route);
        const text=response&&typeof response==="object"&&Object.prototype.hasOwnProperty.call(response,"text")?response.text:String(response||"");
        const statusCode=response&&response.statusCode!==undefined?Number(response.statusCode):response&&response.response&&Number(response.response.statusCode);
        const redirectCount=Number(response&&response.redirectCount)||0;
        const values=firmwareStatusValues(route.schema,text);
        const process=route.schema==="restore"?dryRun.processStatus(text,firstText):null;
        observations.push({id:route.id,method:"GET",query:route.query,ok:Number.isFinite(statusCode)?statusCode>=200&&statusCode<=299&&!unauthorized(text)&&redirectCount===0:!unauthorized(text)&&redirectCount===0,statusCode:Number.isFinite(statusCode)?statusCode:null,redirectCount,values,processState:process?dryRun.classifyProcessStatus(process):null});
      }catch(error){observations.push({id:route.id,method:"GET",query:route.query,ok:false,statusCode:null,redirectCount:0,values:{},processState:null,error:cleanError(error)});}
    }
    const traceCheck=dryRun.validateGetOnlyTrace(trace);
    const restoreReads=observations.filter(item=>/^restore-status-/.test(item.id));
    if(!traceCheck.ok||!observations.length||observations.some(item=>!item.ok)||!restoreReads.length||restoreReads.some(item=>item.processState!=="IDLE"))throw new Error("The GET-only restore status baseline is incomplete or not idle; live flashing remains locked.");
    phase="complete";
    const report={schema:dryRun.DRY_RUN_SCHEMA||1,mode:"firmware-restore-dry-run",generatedAt:clock(),software:softwareIdentity(options.software||{}),selectedFile:{name:selectedName,size:image.size,sha256:image.sha256},image:{id:image.id,doubleHashVerified:true},device:{model:identity.model,hardware:identity.hardware,firmware:identity.firmware,unitFingerprintPrefix:identity.unitFingerprintSha256.slice(0,12)},power:{batteryPercent:power.batteryPercent,chargerConnected:power.chargerConnected,minimumBatteryPercent:stage0.SOFTWARE_ONLY_MIN_BATTERY_PERCENT},session:{authFlow:"zmi-apk-1.2.42-persisted-login-header",authorizationPersisted:session&&session.appLogin&&session.appLogin.authHeaderPersisted===true,sessionCookieReceived:session&&session.appLogin&&session.appLogin.sessionCookieReceived===true},wireManifest:manifest,statusObservations:observations,productionAvailability:stage0.restoreAvailability(),liveBlockers:dryRun.LIVE_BLOCKERS.slice(),dryRunReady:true,safety:safety()};
    const text=formatDiagnosticReport(report);
    return {ok:true,dryRunReady:true,flashAllowed:false,report,text,diagnostics:text};
  }catch(error){error.diagnostics=diagnostics(error);throw error;}
}

async function runFirmwareRestore(auth, options = {}) {
  const stage0=options.stage0||firmwareStage0Module;
  // Production deliberately has no dynamic adapter fallback. The exact
  // core-owned Request builder must be added here after capture/review; the
  // injected adapter is only a local test seam and is never supplied by the
  // WebView dispatcher.
  const adapter=options.transportAdapter||null;
  const availability=firmwareRestoreAvailability(stage0,adapter);
  if(!availability.available){const error=new Error(availability.reason);error.diagnostics=formatDiagnosticReport({schema:1,mode:"firmware-restore-stage0",generatedAt:Date.now(),availability,safety:{routerReadsAttempted:0,firmwarePostsAttempted:0,automaticRetries:0,flashAllowed:false}});throw error;}
  if(!stage0||typeof stage0.createImageEvidence!=="function"||typeof stage0.executePersistentRestoreOnce!=="function"||typeof stage0.monitorPersistentRestore!=="function")throw new Error("SafeFlash Stage 0 installer is incomplete.");
  const clock=typeof options.now==="function"?options.now:Date.now;
  const picker=options.documentPicker||(typeof DocumentPicker!=="undefined"?DocumentPicker:null);
  const fileManager=options.fileManager||(typeof FileManager!=="undefined"?FileManager.local():null);
  if(!picker||typeof picker.openFile!=="function"||!fileManager||typeof fileManager.read!=="function")throw new Error("Scriptable file selection is unavailable.");
  const journal=options.journal||stage0.createKeychainJournal(stage0.JOURNAL_KEY,options.keychain);
  const qualificationStore=options.qualificationStore||createFirmwareQualificationStore(stage0,options.keychain);
  let existing=await stage0.loadJournal(journal);
  if(existing&&!stage0.TERMINAL_STATES.includes(existing.state))existing=await stage0.recoverPersistentTransaction(journal,clock());
  if(existing)throw new Error(`Stage 0 journal contains ${existing.transactionId} in state ${existing.state}; resolve it before selecting another image.`);

  let selected;
  try{selected=await picker.openFile();}
  catch(error){if(error&&(error.cancelled===true||error.canceled===true||/cancel(?:led|ed)/i.test(String(error.message||""))))return {cancelled:true,ok:false,flashAllowed:false};throw error;}
  const path=Array.isArray(selected)?selected[0]:selected;
  if(!path)return {cancelled:true,ok:false,flashAllowed:false};
  let data;
  try{
    if(typeof fileManager.downloadFileFromiCloud==="function")await fileManager.downloadFileFromiCloud(path);
    data=fileManager.read(path);
  }catch(_){throw new Error("The selected firmware file could not be downloaded or read. No upload was attempted.");}
  if(!data)throw new Error("The selected firmware file could not be read.");
  if(typeof data.getBytes!=="function")throw new Error("Firmware restore requires immutable Scriptable Data from the native file reader.");
  const firstImageEvidence=stage0.createImageEvidence(data,clock());
  const firstImageValidation=stage0.validateImageEvidence(firstImageEvidence,clock());
  if(!firstImageValidation.ok)throw new Error(firstImageValidation.errors.join(" "));
  const image=firstImageValidation.image;
  const suppliedTransportEvidence=adapter.transportEvidence;
  const suppliedRecoveryEvidence=adapter.recoveryEvidence||null;
  const suppliedSoftwareRiskEvidence=adapter.softwareRiskEvidence||null;
  const suppliedRiskEvidence=suppliedRecoveryEvidence||suppliedSoftwareRiskEvidence;
  if(!suppliedTransportEvidence||!suppliedRiskEvidence||(suppliedRecoveryEvidence&&suppliedSoftwareRiskEvidence)||!Object.isFrozen(suppliedTransportEvidence)||!Object.isFrozen(suppliedRiskEvidence))throw new Error("Compiled transport and exactly one recovery/risk evidence record must be immutable plain records.");
  const goldenQualification=await qualificationStore.load();

  let status=await (options.getStatus||getStatus)(auth);
  let observedAt=clock();
  let device={model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status),unitFingerprintSha256:firmwareUnitFingerprint(status,stage0),source:"status1-live",observedAt};
  let battery=parseBattery(status,device);
  let power={batteryPercent:battery.percent,chargerConnected:battery.chargerConnected===true,source:"status1-live",observedAt};
  const preview=stage0.preflight({image:firstImageEvidence,device,power,restoreTransportEvidence:suppliedTransportEvidence,recoveryEvidence:suppliedRecoveryEvidence,softwareRiskEvidence:suppliedSoftwareRiskEvidence,goldenQualification},clock());
  if(!preview.destructiveAllowed)throw new Error(preview.errors.join(" "));
  const transportEvidence=Object.freeze({...preview.restoreTransportEvidence});
  const riskProfile=String(preview.riskProfile||"physical-nor-v1");
  const riskEvidence=Object.freeze({...(preview.riskEvidence||preview.recoveryEvidence||{})});
  const recoveryEvidence=riskProfile==="physical-nor-v1"?riskEvidence:null;
  const softwareRiskEvidence=riskProfile==="software-only-risk-v1"?riskEvidence:null;
  const confirmed=await confirmFirmwareRestore(image,device,power,transportEvidence,{...riskEvidence,profile:riskProfile},options);
  if(!confirmed)return {cancelled:true,ok:false,flashAllowed:false};

  // Finish all fallible local byte work before authentication and arming.
  // The future reviewed core adapter must return its own final live status
  // observation from the same prepared session; no generic request may disturb
  // that session between preparation and the one-shot POST.
  const finalImageEvidence=stage0.createImageEvidence(data,clock());
  if(finalImageEvidence.sha256!==firstImageEvidence.sha256||finalImageEvidence.size!==firstImageEvidence.size)throw new Error("Firmware bytes changed after confirmation; no upload was attempted.");
  const prepared=await adapter.prepare({auth,image,transportEvidence,riskProfile,riskEvidence,recoveryEvidence,softwareRiskEvidence});
  if(!prepared||!prepared.status||!Number.isFinite(Number(prepared.statusObservedAt))||!prepared.exclusiveLease||typeof prepared.exclusiveLease.assertOwner!=="function")throw new Error("The reviewed prepared session did not return final live status and an exclusive firmware lease.");
  status=prepared.status;
  observedAt=Number(prepared.statusObservedAt);
  device={model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status),unitFingerprintSha256:firmwareUnitFingerprint(status,stage0),source:"status1-live",observedAt};
  battery=parseBattery(status,device);
  power={batteryPercent:battery.percent,chargerConnected:battery.chargerConnected===true,source:"status1-live",observedAt};
  const preflight=stage0.preflight({image:finalImageEvidence,device,power,restoreTransportEvidence:transportEvidence,recoveryEvidence,softwareRiskEvidence,goldenQualification},clock());
  if(!preflight.destructiveAllowed)throw new Error(preflight.errors.join(" "));

  let finalTransaction;
  try{
    const oneShot=await stage0.executePersistentRestoreOnce(journal,preflight,async transaction=>{
      return adapter.sendOnce({prepared,transaction,data,image,transportEvidence,riskProfile,riskEvidence,recoveryEvidence,softwareRiskEvidence});
    },{now:clock,exclusiveLease:prepared.exclusiveLease});
    finalTransaction=await stage0.monitorPersistentRestore(journal,oneShot.transaction,{
      readStatus:context=>adapter.readStatus({prepared,transportEvidence,...context}),
      classifyStatus:(observation,context)=>adapter.classifyStatus(observation,{transportEvidence,...context}),
      verifyBoot:context=>adapter.verifyBoot({auth,prepared,image,transportEvidence,...context})
    },{now:clock,sleep:options.sleep||scriptableSleep,maxPolls:transportEvidence.maxStatusPolls,intervalMs:transportEvidence.statusPollIntervalMs,maxBootPolls:transportEvidence.maxBootPolls,bootIntervalMs:transportEvidence.bootPollIntervalMs});
    if(finalTransaction.state===stage0.TRANSACTION_STATES.BOOT_VERIFIED&&image.id===stage0.GOLDEN_IMAGE.id){
      await qualificationStore.save(stage0.createGoldenQualification(finalTransaction,clock()));
    }
  }catch(error){
    let stored=error&&error.stage0Transaction||null;
    if(!stored){try{stored=await stage0.loadJournal(journal);}catch(_){stored=null;}}
    const attempted=Number(error&&error.destructivePostsAttempted)||(stored&&stored.destructivePostCount===1?1:0);
    error.diagnostics=formatDiagnosticReport({schema:1,mode:"firmware-restore-stage0",generatedAt:clock(),selectedFile:{name:selectedFileName(path),size:image.size,sha256:image.sha256},transport:{contractId:transportEvidence.contractId,captureSha256:transportEvidence.captureSha256},risk:{profile:riskProfile,evidenceId:riskEvidence.evidenceId,captureSha256:riskEvidence.captureSha256},transaction:stored?{id:stored.transactionId,state:stored.state,destructivePostCount:stored.destructivePostCount}:null,safety:{firmwarePostsAttempted:attempted,automaticRetries:0,redirectsAllowed:false,statusMethod:"GET"},error:cleanError(error)});
    throw error;
  }
  const report={schema:1,mode:"firmware-restore-stage0",generatedAt:clock(),software:softwareIdentity(options.software||{}),selectedFile:{name:selectedFileName(path),size:image.size,sha256:image.sha256},device:{model:device.model,hardware:device.hardware,firmware:device.firmware},power:{batteryPercent:power.batteryPercent,chargerConnected:power.chargerConnected},transport:{contractId:transportEvidence.contractId,captureSha256:transportEvidence.captureSha256},risk:{profile:riskProfile,evidenceId:riskEvidence.evidenceId,captureSha256:riskEvidence.captureSha256},transaction:{id:finalTransaction.transactionId,state:finalTransaction.state,destructivePostCount:finalTransaction.destructivePostCount},safety:{firmwarePostsAttempted:1,automaticRetries:0,redirectsAllowed:false,statusMethod:"GET"}};
  return {ok:finalTransaction.state===stage0.TRANSACTION_STATES.BOOT_VERIFIED,flashAllowed:false,destructiveAttempted:true,state:finalTransaction.state,report,text:formatDiagnosticReport(report)};
}

async function validateFirmwareCanary(auth,options={}) {
  const stage0=options.stage0||firmwareStage0Module;
  if(!stage0||typeof stage0.createImageEvidence!=="function")throw new Error("SafeFlash Stage 0 module is unavailable");
  const picker=options.documentPicker||(typeof DocumentPicker!=="undefined"?DocumentPicker:null);
  const fileManager=options.fileManager||(typeof FileManager!=="undefined"?FileManager.local():null);
  if(!picker||typeof picker.openFile!=="function"||!fileManager||typeof fileManager.read!=="function")throw new Error("Scriptable file selection is unavailable");
  const clock=typeof options.now==="function"?options.now:Date.now;
  let selected;
  try { selected=await picker.openFile(); }
  catch(error){if(error&&(error.cancelled===true||error.canceled===true||/cancel(?:led|ed)/i.test(String(error.message||""))))return {cancelled:true,ok:false,flashAllowed:false};throw error;}
  const path=Array.isArray(selected)?selected[0]:selected;
  if(!path)return {cancelled:true,ok:false,flashAllowed:false};
  try { if(typeof fileManager.downloadFileFromiCloud==="function")await fileManager.downloadFileFromiCloud(path); }
  catch(_){throw new Error("The selected firmware file could not be downloaded from Files.");}
  let data;
  try { data=fileManager.read(path); }
  catch(_){throw new Error("The selected firmware file could not be read.");}
  if(!data)throw new Error("The selected firmware file could not be read");

  const imageEvidence=stage0.createImageEvidence(data,clock());
  const imageValidation=typeof stage0.validateAuditImageEvidence==="function"?stage0.validateAuditImageEvidence(imageEvidence,clock()):stage0.validateImageEvidence(imageEvidence,clock());
  const image=imageValidation.image;
  const expectedCanary=stage0.WEBUI_CANARY_LOGS_R1||stage0.WEBUI_CANARY_R3;
  const canaryMatch=!!(image&&expectedCanary&&image.id===expectedCanary.id);
  const imageErrors=imageValidation.errors.slice();
  if(imageValidation.ok&&!canaryMatch)imageErrors.push("The selected audited image is not WEBUI Canary Logs r1.");
  const base={
    schema:1,
    mode:"firmware-canary-validation",
    generatedAt:clock(),
    software:softwareIdentity(options.software||{}),
    selectedFile:{name:selectedFileName(path),size:imageEvidence.size,sha256:imageEvidence.sha256,persistedByDashboard:false},
    expectedCanary:{id:expectedCanary.id,file:expectedCanary.file,size:expectedCanary.size,sha256:expectedCanary.sha256,nativeOsloPatch:false,logicalChanges:expectedCanary.logicalChanges,restorable:expectedCanary.restorable===true,structuralStatus:expectedCanary.structuralStatus||"unknown",quarantineReason:expectedCanary.quarantineReason||null},
    image:{ok:imageErrors.length===0,match:canaryMatch,id:image&&image.id||null,errors:imageErrors},
    device:{checked:false,ok:false,errors:["Live status1 was not read because the image gate did not pass."]},
    power:{checked:false,ok:false,errors:["Live status1 was not read because the image gate did not pass."]},
    restoreTransport:{verified:false,allowlistedContracts:Array.isArray(stage0.VERIFIED_RESTORE_TRANSPORTS)?stage0.VERIFIED_RESTORE_TRANSPORTS.length:0,errors:["RestoreFw transport remains locked in this build."]},
    safety:{routerReadsAttempted:0,routerWritesAttempted:0,firmwarePostsAttempted:0,automaticRetries:0,flashAllowed:false}
  };
  if(imageErrors.length){const text=formatDiagnosticReport(base);return {cancelled:false,ok:false,readyForTransportCapture:false,flashAllowed:false,report:base,text};}

  let status;
  try {
    base.safety.routerReadsAttempted=1;
    status=await (options.getStatus||getStatus)(auth);
  } catch(error) {
    base.device={checked:true,ok:false,errors:[`Fresh status1 read failed: ${cleanError(error)}`]};
    base.power={checked:true,ok:false,errors:["Power gate could not be evaluated without status1."]};
    const text=formatDiagnosticReport(base);
    return {cancelled:false,ok:false,readyForTransportCapture:false,flashAllowed:false,report:base,text};
  }

  const observedAt=clock();
  const identity={model:firstText(status,["model","model_name","product_name"]),hardware:hardwareRevision(status),firmware:firmwareVersion(status),unitFingerprintSha256:firmwareUnitFingerprint(status,stage0),source:"status1-live",observedAt};
  const battery=parseBattery(status,identity);
  const power={batteryPercent:battery.percent,chargerConnected:battery.chargerConnected===true,source:"status1-live",observedAt};
  const deviceValidation=stage0.validateDevice(identity,observedAt);
  const powerValidation=stage0.validatePower(power,observedAt);
  base.device={checked:true,ok:deviceValidation.ok,model:identity.model,hardware:identity.hardware,firmware:identity.firmware,source:identity.source,errors:deviceValidation.errors};
  base.power={checked:true,ok:powerValidation.ok,batteryPercent:powerValidation.batteryPercent,chargerConnected:powerValidation.chargerConnected,source:powerValidation.source,errors:powerValidation.errors};
  const readyForTransportCapture=canaryMatch&&deviceValidation.ok&&powerValidation.ok;
  base.readyForTransportCapture=readyForTransportCapture;
  const text=formatDiagnosticReport(base);
  return {cancelled:false,ok:readyForTransportCapture,readyForTransportCapture,flashAllowed:false,report:base,text};
}

// WebView rendering
function buildHtml(model) {
  const battery = model.battery || {}; const network = model.network || {}; const traffic = model.traffic || {};
  const updated = new Date(model.loadedAt || Date.now()).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const allMessages = model.sms && model.sms.messages ? model.sms.messages : [];
  const smsCount = allMessages.length;
  const smsTotal = Number(model.sms.totalMessages);
  const hasSmsTotal = Number.isFinite(smsTotal) && smsTotal >= smsCount && smsTotal > 0;
  const smsCounter = hasSmsTotal ? `${smsCount}/${smsTotal}` : String(smsCount);
  const smsLoadingPercent = hasSmsTotal ? ` (${Math.min(100, Math.round(smsCount / smsTotal * 100))}%)` : "";
  const maxVisibleSms = 200;
  const visibleMessages = allMessages.slice(0, maxVisibleSms);
  const hiddenSmsCount = Math.max(0, smsCount - visibleMessages.length);
  const nextUpdate = new Date((model.loadedAt || Date.now()) + POLL_SECONDS * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  const networkLabel = network.quality || "No data";
  const batteryLabel = battery.percent === null || battery.percent === undefined ? "—" : `${battery.percent}%`;
  const batteryInline = batteryInlineLabel(battery);
  const totalTraffic = formatBytes(traffic.total);
  const notice = normalizeNotice(model.notice);
  const noticeHtml = notice && notice.text ? `<div class="notice ${notice.type}">${escapeHtml(notice.text)}${notice.diagnostics ? `<details><summary>Diagnostics</summary><textarea rows="7" readonly>${escapeHtml(notice.diagnostics)}</textarea><pre>${escapeHtml(notice.diagnostics)}</pre></details>` : ""}</div>` : "";
  const signalHtml = signalBarsHtml(network);
  const warnings=[model.errors&&model.errors.status].filter(Boolean);
  const statusWarning = warnings.length ? `<div class="warning status-warning" data-status-warning><strong>${model.errors.statusRequest ? "Status request error" : "Status data warning"}</strong><p>${warnings.map(escapeHtml).join("<br>")}</p></div>` : "";
  const topCards = `<section class="topgrid router-only">
    <article class="mini mini-signal" data-overview-card="signal"><span>Signal</span><strong data-network-signal>${signalHtml}</strong><small><span data-network-current>${escapeHtml(network.networkError || network.mode || "Unknown")}</span><span data-network-dbm>${network.dbm === null || network.dbm === undefined ? "" : ` · ${escapeHtml(network.dbm)} dBm`}</span></small></article>
    <article class="mini mini-battery" data-overview-card="battery"><span>Battery</span><strong data-battery-percent>${batteryLabel}</strong><small data-battery-inline>${escapeHtml(batteryInline)}</small></article>
    <article class="mini mini-traffic" data-overview-card="traffic"><span>Traffic</span><strong data-traffic-total>${totalTraffic}</strong><small>Downloaded: <span data-traffic-down>${formatBytes(traffic.download)}</span> · Uploaded: <span data-traffic-up>${formatBytes(traffic.upload)}</span></small></article>
  </section>`;
  const smsCards = smsCount ? visibleMessages.map((item, index) => {
    const key = escapeHtml(String(item.id || smsKey(item) || index));
    const translateButton = TRANSLATE_ENDPOINT ? `<button onclick="translateSms(this)">Translate</button>` : "";
    return `<article class="card sms" data-msg-id="${key}" data-msg-text="${escapeHtml(item.content)}" data-msg-sender="${escapeHtml(item.phone)}" data-msg-date="${escapeHtml(item.date)}"><header><div><h3 class="app-value">${escapeHtml(item.phone || "Unknown sender")}</h3><small>SMS #${escapeHtml(item.row || index + 1)}</small></div><time class="app-value">${escapeHtml(item.date || "Unknown time")}</time></header><p class="body app-value">${escapeHtml(item.content || "")}</p><div class="translation" data-translation><span></span></div><footer><button data-copy type="button">Copy</button><button data-share type="button">Share</button>${translateButton}<button class="danger" data-delete-action type="button">Delete</button></footer><div class="warning" data-delete-confirm role="status" aria-live="polite" hidden></div></article>`;
  }).join("") : `<article class="card empty"><h2>No SMS found</h2><p>${escapeHtml(model.errors.sms || "There are no inbox messages.")}</p></article>`;
  const smsLimitWarning = hiddenSmsCount ? `<div class="warning">⚠️ Showing the latest ${visibleMessages.length} SMS out of ${smsCount} to keep the WebView responsive.</div>` : "";
  const codes = [network.lac ? `LAC/TAC ${escapeHtml(network.lac)}` : "", network.cellId ? `Cell ${escapeHtml(network.cellId)}` : "", network.pci ? `PCI ${escapeHtml(network.pci)}` : ""].filter(Boolean).join(" · ");
  const diagnostics = model.cellularDiagnostics || {}; const diagnosticValues = diagnostics.values || {}; const diagnosticStages = diagnostics.stages || {}; const diagnosticsLoading=!diagnostics.loadedAt&&!Object.keys(diagnosticValues).length;
  const diagnosticGroups = [
    ["Connection and APN", [["configuredApn","Configured APN"],["activeApn","Active APN"],["pdpType","PDP type"]]],
    ["IP, gateways and DNS", [["ipv4","IPv4 address"],["ipv6","IPv6 address"],["gateway4","IPv4 gateway"],["gateway6","IPv6 gateway"],["dns1","Primary DNS server"],["dns2","Secondary DNS server"]]],
    ["Radio network and signal quality", [["operator","Operator"],["band","Radio band"],["pci","Physical cell ID (PCI)"],["earfcn","Radio channel (EARFCN)"],["rsrp","Signal power (RSRP)"],["rsrq","Signal quality (RSRQ)"],["sinr","Signal-to-noise ratio (SINR)"]]]
  ];
  const stageRows = [["sim","SIM"],["registration","Registration and roaming"],["pdp","PDP session"]].map(([key,label]) => { const item=diagnosticStages[key]||{}; const detail=key==="registration"&&item.roaming&&item.roaming.value?`${item.detail||""} · ${item.roaming.value}`:item.detail||""; const raw=item.raw!==null&&item.raw!==undefined?` (raw: ${item.raw})`:""; return `<li class="diag-stage ${escapeHtml(item.state||"unknown")}" data-diag-stage="${key}" data-diag-source=""><strong>${label}</strong>: <span class="app-value">${escapeHtml(detail+raw)}</span></li>`; }).join("");
  const diagnosticFields=diagnosticGroups.map(([title,fields])=>`<section class="diag-group"><h3>${title}</h3>${fields.map(([name,label])=>{const item=diagnosticValues[name]||{},missing=item.value===null||item.value===undefined;return `<p${missing?' hidden':''}><span>${label}</span><strong class="app-value" data-diag="${name}" data-raw="${escapeHtml(item.raw||"")}" data-source="${escapeHtml(item.source||"")}">${missing?'':escapeHtml(String(item.value))}</strong></p>`}).join("")}</section>`).join("");
  const missingCount=diagnosticGroups.flatMap(group=>group[1]).filter(([name])=>(diagnosticValues[name]||{}).value==null).length;
  const endpointErrors=Object.entries(diagnostics.endpointErrors||{}).map(([endpoint,error])=>`<p class="diag-endpoint-error app-value" data-diag-endpoint="${escapeHtml(endpoint)}"><strong>${escapeHtml(endpoint)}</strong>: ${escapeHtml(error)}</p>`).join("");
  const diagnosticBlock = `<article class="card cellular-diagnostics"><small>Connection diagnostics</small><h2>Connection state <span class="diag-spinner" role="status"><span class="sr-only">Loading diagnostics</span></span></h2><ol>${stageRows}</ol><div class="diag-grid">${diagnosticFields}</div><p class="diag-partial" data-diag-partial${diagnosticsLoading||!missingCount?' hidden':''}>Some details were not returned by the firmware.</p><div data-diag-endpoint-errors>${endpointErrors}</div><small class="app-value" data-diag-updated>${diagnostics.loadedAt?`Last successful update ${escapeHtml(new Date(diagnostics.loadedAt).toLocaleTimeString("en-US"))}`:"Waiting for first diagnostic poll"}</small></article>`;
  const capabilityState=value=>value&&value.state?value.state:value&&value.supported===true?"available":value&&value.supported===false?"unavailable":"unchecked";
  const stateLabel=value=>CAPABILITY_STATE_LABELS[capabilityState(value)]||CAPABILITY_STATE_LABELS.error;
  const deviceActions = capabilityState(model.deviceAccess)==="available" ? (model.deviceAccess.capabilities || []).filter(action => action.supported===true).map(action => `<button class="danger buttonlike" type="button" data-device-action="${escapeHtml(action.id)}">${escapeHtml(action.title)}</button>`).join(" ") : "";
  const deviceConfirm = "";
  const cellular = model.cellularControl || {};
  const defaultCellularModes = [{ id: "auto", title: "Automatic" }, { id: "lteOnly", title: "4G/LTE only" }, { id: "ltePreferred", title: "LTE preferred" }, { id: "wcdmaOnly", title: "3G only" }, { id: "gsmOnly", title: "2G only" }];
  const activePreferredMode = preferredModeId(network.preferredMode || network.mode || "");
  const cellularModeOptions = (cellular.modes || (cellularControlModule && cellularControlModule.modes ? cellularControlModule.modes() : defaultCellularModes)).map(mode => `<option value="${escapeHtml(mode.id)}"${mode.id === activePreferredMode ? " selected" : ""}>${escapeHtml(mode.title)}</option>`).join("");
  const controlsDisabled = capabilityState(cellular)!=="available" || cellular.readOnly === true;
  const cellularModeSelect = controlsDisabled || !cellularModeOptions ? "" : `<label class="selectline">Current preferred protocol <select data-cellular-mode-select>${cellularModeOptions}</select></label>`;
  const cellularReconnect = controlsDisabled ? "" : `<button class="danger buttonlike" type="button" data-cellular-action="reconnect">Reconnect cellular network</button>`;
  const resetTrafficConfirm = "";
  const powerConfirmCard = `<div class="warning" data-power-confirm hidden></div>`;
  const powerControls = model.powerControls || { available:false, reason:"Power commands are disabled until the exact live device profile is confirmed.", actions:{} };
  const powerAvailable = powerControls.available === true && powerControls.actions && powerControls.actions.reboot && powerControls.actions.powerOff;
  const powerDisabled = powerAvailable ? "" : ` disabled aria-disabled="true" title="${escapeHtml(powerControls.reason)}"`;
  const powerUnavailable = powerAvailable ? "" : `<p class="warning" data-power-unavailable>${escapeHtml(powerControls.reason)}</p>`;
  const resetTrafficDisabled = ` disabled aria-disabled="true" title="WAN traffic reset has no confirmed write contract"`;
  const connectionTime = formatDuration(traffic.sessionSeconds);
  const activeTab = model.tab === "router" ? "router" : "sms";
  const deviceModel = String(model.actualModel || "").trim() || "unknown";
  const deviceRevision = String(model.actualRevision || "").trim();
  const firmwareBuild = String(model.actualFirmware || "").trim() || "unknown";
  const firmwareVersion = String(model.actualFirmwareVersion || firmwareUserVersion(firmwareBuild)).trim() || "unknown";
  const softwareVersion = String(model.softwareVersion || "").trim() || "unknown";
  const pageTitle = `${deviceModel}${deviceRevision ? ` · ${deviceRevision}` : ""} · firmware ${firmwareVersion} · software ${softwareVersion}`;
  const smsActive = activeTab === "sms" ? " active" : "";
  const routerActive = activeTab === "router" ? " active" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${escapeHtml(pageTitle)}</title><style>${css()}</style></head>
  <body><div id="progressbar" class="progressbar" aria-hidden="true"><i></i></div><main><header class="hero compact"><div class="device-heading"><h1>${escapeHtml(deviceModel)}</h1>${deviceRevision ? `<span class="device-revision">Revision ${escapeHtml(deviceRevision)}</span>` : ""}</div><div class="device-metadata"><span><small>Firmware version</small><b>${escapeHtml(firmwareVersion)}</b></span><span><small>Application version</small><b>${escapeHtml(softwareVersion)}</b></span></div><div class="firmware-build"><small>Firmware build</small><code>${escapeHtml(firmwareBuild)}</code></div><strong class="sms-counter">SMS: ${smsCounter}</strong><p class="statusline"><span>📶 ${escapeHtml(network.mode || "Unknown")}</span><span>${escapeHtml(batteryInline)}</span><span>⇅ ${totalTraffic}</span><span data-status-updated>⟳ ${escapeHtml(updated.slice(0,5))}</span></p></header>
  <section class="power-toolbar" data-power-control><span>Connection time: <strong data-connection-time>${escapeHtml(connectionTime)}</strong></span><button class="danger" type="button" data-power-action="powerOff"${powerDisabled}>Power off</button><div class="warning" data-power-confirm hidden></div></section>${powerUnavailable}
  <nav class="seg dashboard-tabs" role="tablist" aria-label="Dashboard sections"><button role="tab" aria-controls="sms" aria-selected="${activeTab==='sms'}" tabindex="${activeTab==='sms'?'0':'-1'}" data-tab-button="sms" class="${smsActive.trim()}" onclick="tab('sms')">SMS</button><button role="tab" aria-controls="router" aria-selected="${activeTab==='router'}" tabindex="${activeTab==='router'?'0':'-1'}" data-tab-button="router" class="${routerActive.trim()}" onclick="tab('router')">Router</button></nav>
  <section class="refresh"><span id="countdown">Next refresh: ${escapeHtml(nextUpdate)}</span><div class="actions"><button id="refreshLink" class="buttonlike" type="button" onclick="refreshNow(event)">Refresh</button><button id="pauseBtn" aria-pressed="false" onclick="togglePause()">Pause</button></div></section>
  <section id="actionStatus" class="action-status warning" hidden><header><strong data-status-title></strong><button type="button" onclick="hideActionStatus()">Close</button></header><p data-status-detail></p><textarea data-status-copy rows="5" readonly></textarea><pre data-status-pre></pre></section>
  <section id="webviewDiagnostics" class="action-status warning" hidden><header><strong>WebView interface error</strong><button type="button" onclick="hideWebviewDiagnostics()">Close</button></header><p>The WebView interface encountered an error. Open the details below or refresh the script.</p><pre data-webview-diagnostics></pre></section>
  ${noticeHtml}
    <section id="sms" class="tab${smsActive}" role="tabpanel"><div class="inline-toolbar"><button aria-expanded="false" aria-controls="smsComposer" onclick="toggleSmsComposer(undefined,this)">📝 Compose SMS</button></div>
    <form id="smsComposer" class="composer card" onsubmit="submitSmsInline(event)" hidden><input name="to" placeholder="Recipient" autocomplete="tel"><textarea name="text" placeholder="SMS text" rows="3" maxlength="1000"></textarea><div><button class="primary" type="submit">Send SMS</button><button type="button" onclick="toggleSmsComposer(false)">Cancel</button></div><p class="formStatus" data-status></p></form>
    ${model.sms.loading ? `<div class="notice" data-history-warning>Loading messages: ${smsCounter}${smsLoadingPercent}</div>` : model.sms.warning ? `<div class="warning" data-history-warning>⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}<div class="history-toast" data-history-toast role="status" aria-live="polite" hidden></div>${smsCards}${smsLimitWarning}</section>
    <section id="router" class="tab${routerActive}" role="tabpanel">${statusWarning}<h2 class="section-title">Overview</h2>${topCards}
    <article class="card network"><small>Mobile network</small><h2 data-network-signal>${signalHtml}</h2><div class="quality" data-network-current>${escapeHtml(network.mode || "Unknown")}</div><p>Operator: <strong data-network-operator>${escapeHtml(network.networkError || network.operator || "Unknown operator")}</strong></p><p>Signal: <strong data-network-dbm>${network.dbm === null || network.dbm === undefined ? "Not returned by firmware" : `${escapeHtml(network.dbm)} dBm`}</strong></p><p>Preferred protocol: <strong data-network-preferred>${escapeHtml(network.preferredMode || "Unknown")}</strong></p><p class="codes">LAC/TAC <strong data-network-lac>${escapeHtml(network.lac||"Not returned")}</strong> · Cell <strong data-network-cell>${escapeHtml(network.cellId||"Not returned")}</strong> · PCI <strong data-network-pci>${escapeHtml(network.pci||"Not returned")}</strong></p><p class="codes" data-network-raw>Source: ${escapeHtml(network.networkSource||"none")} · raw: ${escapeHtml(network.rawMode||"none")}</p></article>
    ${diagnosticBlock}
    <article class="card experimental experimental-features" id="routerExperimental"><small>Unconfirmed firmware features</small><h2>Experimental features</h2><p>Availability depends on the router firmware. Check all features together before using them.</p><div class="inline-toolbar"><button type="button" data-detect-experimental>Detect experimental features</button><span role="status" aria-live="polite" data-detection-status>Detection has not started</span></div>
      <ul class="experimental-list">
        <li data-cellular-control-section><h3><span data-capability-name>${CAPABILITY_NAMES.cellularControl}</span>: <span data-capability-status>${stateLabel(cellular)}</span></h3><p>${escapeHtml(cellular.detail||'Detection determines whether reconnect and mode selection are safe.')}</p><div class="inline-toolbar" data-capability-actions>${cellularReconnect}</div><ul><li><h4>Preferred protocol control</h4><div data-cellular-mode-control>${cellularModeSelect}</div></li></ul><div data-cellular-confirm hidden></div></li>
        <li data-ussd-section><h3><span data-capability-name>${CAPABILITY_NAMES.ussd}</span>: <span data-capability-status>${stateLabel(model.ussd)}</span></h3><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><div class="inline-toolbar" data-capability-actions>${capabilityState(model.ussd)==='available'?'<button type="button" onclick="toggleUssdComposer(true)">Dial USSD</button>':''}</div><form id="ussdComposer" class="composer" onsubmit="submitUssdInline(event)" hidden><input name="code" placeholder="Code, for example *100#"><button class="primary" type="submit">Send USSD</button></form></li>
        <li data-device-access-section><h3><span data-capability-name>${CAPABILITY_NAMES.deviceAccess}</span>: <span data-capability-status>${stateLabel(model.deviceAccess)}</span></h3><p>${escapeHtml(model.errors.deviceAccess || model.deviceAccess.detail || "")}</p><div class="inline-toolbar" data-capability-actions>${deviceActions}</div>${deviceConfirm}</li>
      </ul>
    </article>
    <article class="card" data-power-control><small>System</small><h2>System commands</h2><button class="danger buttonlike" type="button" data-power-action="resetTraffic"${resetTrafficDisabled}>Reset traffic</button> <button class="buttonlike" type="button" data-power-action="reboot"${powerDisabled}>Restart</button> <button class="danger buttonlike" type="button" data-power-action="powerOff"${powerDisabled}>Power off</button>${powerUnavailable}${powerConfirmCard}</article></section></main>
  <script>${clientScript(model)}</script></body></html>`;
}

function clientScript(model) {
  return `var model={tab:${JSON.stringify(model.tab)},poll:${POLL_SECONDS},translateEndpoint:${JSON.stringify(TRANSLATE_ENDPOINT)},sms:{fingerprint:${JSON.stringify(model.sms&&model.sms.fingerprint||"")},totalPages:${JSON.stringify(model.sms&&model.sms.totalPages)},totalMessages:${JSON.stringify(model.sms&&model.sms.totalMessages)}}};
var remaining=model.poll,paused=false,timer=null,pending={},pendingKeys={},sequence=0,detectionAttempt=0,detectionStarted=0,detectionCompleted=0,detectionTotal=3,detectionTimer=null,historyToastTimer=null,lastDiagnostics={values:{},stages:{},loadedAt:null};
function safeStorageGet(k){try{return localStorage.getItem?localStorage.getItem(k):localStorage[k]}catch(e){return null}}
function safeStorageSet(k,v){try{if(localStorage.setItem)localStorage.setItem(k,v);else localStorage[k]=v}catch(e){}}
function selectedTab(){return safeStorageGet('zmiTab')||model.tab}
function tab(name){name=name==='router'?'router':'sms';var current=document.querySelector('.tab.active');if(current)safeStorageSet('zmiScrollY:'+current.id,String(window.scrollY||0));document.querySelectorAll('.tab').forEach(function(x){var on=x.id===name;x.classList.toggle('active',on);x.hidden=!on});document.querySelectorAll('[data-tab-button]').forEach(function(x){var on=x.getAttribute('data-tab-button')===name;x.classList.toggle('active',on);x.setAttribute('aria-selected',on?'true':'false');x.setAttribute('tabindex',on?'0':'-1')});safeStorageSet('zmiTab',name);var saved=safeStorageGet('zmiScrollY:'+name);setTimeout(function(){window.scrollTo(0,saved===null?0:Number(saved)||0)},0)}
function handleTabKeydown(e){var target=e.target,tabName=target&&target.getAttribute&&target.getAttribute('data-tab-button');if(!tabName)return;var buttons=Array.prototype.slice.call(document.querySelectorAll('[data-tab-button]')),index=buttons.indexOf(target),next;if(e.key==='ArrowLeft')next=buttons[(index-1+buttons.length)%buttons.length];else if(e.key==='ArrowRight')next=buttons[(index+1)%buttons.length];else if(e.key==='Home')next=buttons[0];else if(e.key==='End')next=buttons[buttons.length-1];else return;e.preventDefault();tab(next.getAttribute('data-tab-button'));next.focus()}
function describeError(e){return String(e&&e.message||e||'Unknown error')}
function setActionStatus(text){fillActionStatus('Dashboard',text||'','',false)}
function showHistoryToast(text){var toast=document.querySelector('[data-history-toast]');if(!toast)return;if(historyToastTimer!==null)clearTimeout(historyToastTimer);toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');toast.textContent=text||'';toast.hidden=false;historyToastTimer=setTimeout(function(){toast.hidden=true;historyToastTimer=null},4000)}
function fillActionStatus(title,detail,raw,isError){var box=document.getElementById('actionStatus');if(!box)return;box.hidden=false;box.classList.toggle('error',!!isError);var t=box.querySelector('[data-status-title]'),d=box.querySelector('[data-status-detail]'),pre=box.querySelector('[data-status-pre]');if(t)t.textContent=title||'';if(d)d.textContent=detail||'';if(pre){pre.textContent=raw||'';pre.hidden=!raw}}
function showActionError(title,detail,raw){fillActionStatus(title,detail,raw,true)}
function hideActionStatus(){var x=document.getElementById('actionStatus');if(x)x.hidden=true}
function hideWebviewDiagnostics(){var x=document.getElementById('webviewDiagnostics');if(x)x.hidden=true}
function actionPendingLabel(action){return action==='refresh'||action==='refreshSms'?'Refreshing…':action==='sendSms'||action==='ussd'?'Sending…':action==='deleteSms'?'Deleting…':action==='detectCapability'||action==='detectExperimental'?'Detecting…':action==='cellularReconnect'?'Reconnecting…':action==='reboot'||action==='powerOff'?'Restarting…':'Applying…'}
function setButtonState(button,state,label){if(!button)return;if(!button.dataset.originalLabel)button.dataset.originalLabel=button.textContent;button.dataset.state=state;button.setAttribute('aria-busy',state==='pending'?'true':'false');button.disabled=state==='pending'||state==='disabled';var text=label||(state==='idle'?button.dataset.originalLabel:'');button.textContent=(state==='pending'?'◌ ':'')+text;if(state==='selected'||state==='toggled')button.setAttribute('aria-pressed','true');else if(state==='idle'&&button.hasAttribute('aria-pressed'))button.setAttribute('aria-pressed','false')}
function finishButton(button,state,label){setButtonState(button,state,label);setTimeout(function(){setButtonState(button,'idle')},state==='error'?1800:1200)}
function bridge(action,params,button){var semantic=action+':'+JSON.stringify(params||{});if(pendingKeys[semantic])return Promise.reject(new Error('This action is already pending'));var id=Date.now().toString(36)+'-'+(++sequence);pendingKeys[semantic]=id;setButtonState(button,'pending',actionPendingLabel(action));return new Promise(function(resolve,reject){pending[id]={resolve:resolve,reject:reject,button:button,key:semantic,action:action,params:params||{}};try{window.dispatchEvent(new CustomEvent('ZMICommand',{detail:{id:id,action:action,params:params||{}}}))}catch(error){delete pending[id];delete pendingKeys[semantic];finishButton(button,'error','Failed');reject(error)}})}
function smsHistoryContains(history,id){return !!(history&&Array.isArray(history.messages)&&history.messages.some(function(message){return String(message.id)===String(id)}))}
function deleteStatusBox(p){var card=p&&p.button&&p.button.closest&&p.button.closest('.sms');return card&&card.querySelector('[data-delete-confirm]')}
function setDeleteStatus(p,message,isError){var box=deleteStatusBox(p);if(!box)return;box.hidden=false;box.classList.toggle('error',!!isError);box.setAttribute('role',isError?'alert':'status');box.setAttribute('aria-live',isError?'assertive':'polite');box.textContent=message}
window.zmiApplyActionResult=function(payload){var p=payload&&pending[payload.id];if(p){delete pending[payload.id];delete pendingKeys[p.key];var deletion=p.action==='deleteSms',verified=deletion&&payload.ok&&payload.result&&payload.result.id===String(p.params.id)&&payload.result.history&&!smsHistoryContains(payload.result.history,p.params.id);if(payload.ok&&(!deletion||verified)){var destructive=p.action==='reboot'||p.action==='powerOff'||p.action==='cellularReconnect',powerAction=p.action==='reboot'||p.action==='powerOff',uncertain=powerAction&&payload.result&&['delivery-unknown','unknown'].includes(payload.result.outcome),accepted=powerAction&&payload.result&&['request-accepted','submitted'].includes(payload.result.outcome);if(deletion)setDeleteStatus(p,'SMS deleted and verified in the updated history.',false);finishButton(p.button,powerAction?'warning':'success',uncertain?'Delivery unknown':accepted?'Accepted · effect unconfirmed':destructive?'Submitted':p.action==='sendSms'||p.action==='ussd'?'Sent':deletion?'Deleted':p.action==='cellularMode'?'Applied':'Done');p.resolve(payload.result);if(deletion)setTimeout(function(){window.zmiApplySmsHistory(payload.result.history)},0)}else{var message=payload.error||(deletion?'SMS deletion was not confirmed by the updated history.':'Command failed'),error=new Error(message);error.diagnostics=payload.diagnostics||'';finishButton(p.button,'error',deletion?'Retry':'Failed');if(deletion)setDeleteStatus(p,message+(error.diagnostics?'\\n'+error.diagnostics:''),true);p.reject(error)}}if(!payload.ok&&(!p||p.action!=='deleteSms')){stopProgress();showActionError('Command failed',payload.error||'Unknown error',payload.diagnostics||'')}};
function renderPolledSms(payload){var messages=payload.messages||payload.smsMessages;if(!Array.isArray(messages))return false;var section=document.getElementById('sms');if(!section)return false;section.querySelectorAll('.sms,.empty,[data-history-warning]').forEach(function(x){x.remove()});if(messages.length===0){var empty=document.createElement('article');empty.className='card empty';var title=document.createElement('h2');title.textContent='No SMS found';var description=document.createElement('p');description.textContent='No inbox messages are available. They may not have arrived yet, or message history could not be loaded.';empty.appendChild(title);empty.appendChild(description);section.appendChild(empty)}messages.slice(0,200).forEach(function(item,index){var card=document.createElement('article');card.className='card sms';card.setAttribute('data-msg-id',item.id||'');card.setAttribute('data-msg-text',item.content||'');card.setAttribute('data-msg-sender',item.phone||'');card.setAttribute('data-msg-date',item.date||'');card.innerHTML='<header><div><h3></h3><small></small></div><time></time></header><p class="body"></p><div class="translation" data-translation><span></span></div><footer><button data-copy>Copy</button><button data-share>Share</button><button class="danger" data-delete-action>Delete</button></footer><div class="warning" data-delete-confirm role="status" aria-live="polite" hidden></div>';card.querySelectorAll('h3,time,.body,.translation span').forEach(function(el){el.classList.add('app-value')});card.querySelector('h3').textContent=item.phone||'Unknown sender';card.querySelector('small').textContent='SMS #'+(item.row||index+1);card.querySelector('time').textContent=item.date||'Unknown time';card.querySelector('.body').textContent=item.content||'';section.appendChild(card)});return true}
window.zmiApplySmsHistory=function(payload){payload=payload||{};renderPolledSms(payload);model.sms.fingerprint=payload.fingerprint||model.sms.fingerprint;var loaded=Array.isArray(payload.messages)?payload.messages.length:0,total=Number(payload.totalMessages),hasTotal=Number.isFinite(total)&&total>=loaded&&total>0,percent=hasTotal?Math.min(100,Math.round(loaded/total*100)):null,counter=hasTotal?loaded+'/'+total:String(loaded),hero=document.querySelector('.hero strong'),section=document.getElementById('sms'),note=section&&section.querySelector('[data-history-warning]'),toast=section&&section.querySelector('[data-history-toast]');if(hero)hero.textContent='SMS: '+counter;if(payload.loading){if(historyToastTimer!==null){clearTimeout(historyToastTimer);historyToastTimer=null}if(toast)toast.hidden=true;if(!note&&section){note=document.createElement('div');note.setAttribute('data-history-warning','');section.insertBefore(note,section.firstChild)}if(note){note.className='notice';note.textContent='Loading messages: '+counter+(hasTotal?' ('+percent+'%)':'')}}else if(payload.warning){if(!note&&section){note=document.createElement('div');note.setAttribute('data-history-warning','');section.insertBefore(note,section.firstChild)}if(note){note.className='warning';note.textContent='⚠️ '+payload.warning}}else{if(note)note.remove();showHistoryToast('Message history loaded')}};
function setAll(selector,value){document.querySelectorAll(selector).forEach(function(el){el.textContent=value})}
function diagnosticFailure(error){var x=String(error||'').toLowerCase();return /timeout|timed out/.test(x)?'Timeout':/401|403|auth/.test(x)?'HTTP/authentication error':/http/.test(x)?'HTTP error':/parse|xml/.test(x)?'Parse error':/unsupported|404/.test(x)?'Endpoint not supported':'Endpoint error'}
window.zmiApplyCellularDiagnostics=function(payload){payload=payload||{};var spinner=document.querySelector('.diag-spinner');if(spinner)spinner.hidden=true;var hasSuccess=payload.values&&Object.keys(payload.values).some(function(k){return payload.values[k]&&payload.values[k].value!=null});if(hasSuccess){lastDiagnostics={values:payload.values||{},stages:payload.stages||{},loadedAt:payload.loadedAt||Date.now()}}var values=hasSuccess?payload.values:lastDiagnostics.values||{},missing=0;document.querySelectorAll('[data-diag]').forEach(function(el){var key=el.getAttribute('data-diag'),item=values[key]||{},row=el.closest('p');if(item.value!=null){el.textContent=item.value;el.dataset.raw=item.raw==null?'':item.raw;el.dataset.source=item.source||'';el.classList.toggle('stale',!hasSuccess);if(row)row.hidden=false}else{missing++;if(row)row.hidden=true}});var partial=document.querySelector('[data-diag-partial]');if(partial)partial.hidden=!missing;var stages=hasSuccess?payload.stages||{}:lastDiagnostics.stages||{};document.querySelectorAll('[data-diag-stage]').forEach(function(el){var item=stages[el.getAttribute('data-diag-stage')];if(!item)return;el.className='diag-stage '+(item.state||'unknown')+(!hasSuccess&&lastDiagnostics.loadedAt?' stale':'');var span=el.querySelector('span');if(span)span.textContent=(item.detail||'Status unavailable')+(item.raw==null?'':' (raw: '+item.raw+')')});var box=document.querySelector('[data-diag-endpoint-errors]');if(box){box.innerHTML='';var errors=payload.endpointErrors||{};if(!hasSuccess&&!lastDiagnostics.loadedAt&&Object.keys(errors).length){var first=Object.keys(errors)[0],p=document.createElement('p');p.className='diag-endpoint-error app-value';p.textContent='Diagnostics unavailable: '+diagnosticFailure(errors[first]);box.appendChild(p)}else Object.keys(errors).forEach(function(endpoint){var p=document.createElement('p');p.className='diag-endpoint-error app-value';p.setAttribute('data-diag-endpoint',endpoint);p.textContent=endpoint+': '+diagnosticFailure(errors[endpoint])+' — '+errors[endpoint];box.appendChild(p)})}var updated=document.querySelector('[data-diag-updated]');if(updated&&lastDiagnostics.loadedAt)updated.textContent=(hasSuccess?'Last successful update ':'Stale · last successful update ')+new Date(lastDiagnostics.loadedAt).toLocaleTimeString()}
window.zmiApplyStatus=function(payload){payload=payload||{};remaining=model.poll;drawTimer();var spans=document.querySelectorAll('.statusline span');if(spans[0]&&payload.networkMode)spans[0].textContent='📶 '+payload.networkMode;if(spans[1]&&payload.batteryInline)spans[1].textContent=payload.batteryInline;if(spans[2]&&payload.trafficTotal)spans[2].textContent='⇅ '+payload.trafficTotal;var statusUpdated=document.querySelector('[data-status-updated]');if(statusUpdated&&!payload.errors.status)statusUpdated.textContent='⟳ '+new Date(payload.loadedAt||Date.now()).toLocaleTimeString();setAll('[data-network-current]',payload.networkMode||'Unknown');setAll('[data-network-operator]',payload.operator||'Unknown operator');setAll('[data-network-preferred]',payload.preferredMode||'Unknown');setAll('[data-network-dbm]',payload.dbm==null?'Not returned by firmware':payload.dbm+' dBm');setAll('[data-network-lac]',payload.lac||'Not returned');setAll('[data-network-cell]',payload.cellId||'Not returned');setAll('[data-network-pci]',payload.pci||'Not returned');setAll('[data-network-raw]','Source: '+(payload.networkSource||'none')+' · raw: '+(payload.networkRawCode||'none'));setAll('[data-battery-percent]',payload.batteryPercent==null?'—':payload.batteryPercent+'%');setAll('[data-battery-inline]',payload.batteryInline||'Unknown');setAll('[data-traffic-total]',payload.trafficTotal||'—');setAll('[data-traffic-down]',payload.trafficDown||'—');setAll('[data-traffic-up]',payload.trafficUp||'—');setAll('[data-connection-time]',payload.connectionTime||'—');if(payload.cellularDiagnostics)window.zmiApplyCellularDiagnostics(payload.cellularDiagnostics);if(payload.smsMessages)window.zmiApplySmsHistory({messages:payload.smsMessages,fingerprint:payload.smsFingerprint,totalMessages:payload.smsTotalMessages});stopProgress()};
window.zmiApplyCapability=function(payload){if(payload.progress){detectionCompleted=payload.progress.completed;detectionTotal=payload.progress.total;drawDetectionProgress()}var value=payload.value||{},state=value.state||(value.supported===true?'available':value.supported===false?'unavailable':'unchecked'),labels=${JSON.stringify(CAPABILITY_STATE_LABELS)},section=document.querySelector('[data-'+(payload.kind==='deviceAccess'?'device-access':payload.kind==='cellularControl'?'cellular-control':'ussd')+'-section]');if(!section)return;var status=section.querySelector('[data-capability-status]'),detail=section.querySelector('p'),actions=section.querySelector('[data-capability-actions]');if(status)status.textContent=labels[state]||labels.error;if(detail)detail.textContent=value.detail||'';if(actions){actions.innerHTML='';if(state==='available'){if(payload.kind==='ussd'){var dial=document.createElement('button');dial.type='button';dial.textContent='Dial USSD';dial.onclick=function(){toggleUssdComposer(true)};actions.appendChild(dial)}else if(payload.kind==='cellularControl'&&value.readOnly!==true){var reconnect=document.createElement('button');reconnect.type='button';reconnect.className='danger buttonlike';reconnect.setAttribute('data-cellular-action','reconnect');reconnect.textContent='Reconnect cellular network';actions.appendChild(reconnect)}else if(payload.kind==='deviceAccess'){(value.capabilities||[]).filter(function(item){return item.supported===true}).forEach(function(item){var button=document.createElement('button');button.type='button';button.className='danger buttonlike';button.setAttribute('data-device-action',item.id);button.textContent=item.title;actions.appendChild(button)})}}}if(payload.kind==='cellularControl'){var control=section.querySelector('[data-cellular-mode-control]');if(control){control.innerHTML='';if(state==='available'&&value.readOnly!==true&&(value.modes||[]).length){var label=document.createElement('label'),select=document.createElement('select');label.className='selectline';label.appendChild(document.createTextNode('Current preferred protocol '));select.setAttribute('data-cellular-mode-select','');(value.modes||[]).forEach(function(mode){var option=document.createElement('option');option.value=mode.id;option.textContent=mode.title;select.appendChild(option)});label.appendChild(select);control.appendChild(label)}}}};
window.zmiApply=window.zmiApplyStatus;
window.zmiTick=function(){if(!paused)refreshNow()};
function drawTimer(){var el=document.getElementById('countdown'),btn=document.getElementById('pauseBtn');if(el)el.textContent=paused?'Polling paused':'Next refresh in '+Math.max(0,remaining)+'s';if(btn){btn.textContent=paused?'Paused · Resume':'Pause';btn.setAttribute('aria-pressed',paused?'true':'false');btn.classList.toggle('active',paused);btn.dataset.state=paused?'toggled':'idle'}}
function tick(){if(!paused&&--remaining<=0){remaining=model.poll;window.zmiTick()}drawTimer()}
function startProgress(label){var bar=document.getElementById('progressbar');if(bar)bar.classList.add('active');if(label)label.disabled=true}
function stopProgress(){var bar=document.getElementById('progressbar');if(bar)bar.classList.remove('active')}
function refreshNow(e){if(e)e.preventDefault();var b=document.getElementById('refreshLink');startProgress(b);bridge('refresh',{},b).catch(function(e){showActionError('Refresh failed',describeError(e),'')}).finally(stopProgress)}
function togglePause(){paused=!paused;safeStorageSet('zmiPaused',paused?'1':'0');remaining=model.poll;drawTimer();if(!paused)bridge('resumePolling',{}).catch(function(){})}
function toggleSmsComposer(force,button){var el=document.getElementById('smsComposer');if(el){el.hidden=force===undefined?!el.hidden:!force;button=button||document.querySelector('[aria-controls="smsComposer"]');if(button)button.setAttribute('aria-expanded',el.hidden?'false':'true')}}
function toggleUssdComposer(force,button){var el=document.getElementById('ussdComposer');if(el){el.hidden=force===undefined?!el.hidden:!force;if(button)button.setAttribute('aria-expanded',el.hidden?'false':'true')}}
function submitSmsInline(e){e.preventDefault();var f=e.target,to=f.elements.to.value.trim(),text=f.elements.text.value.trim(),b=f.querySelector('[type=submit]');if(!to||!text||text.length>1000)return;bridge('sendSms',{to:to,text:text},b).then(function(){f.elements.text.value='';safeStorageSet('zmiSmsDraft','');setActionStatus('SMS sent')}).catch(function(x){showActionError('SMS send failed',describeError(x),'')})}
function submitUssdInline(e){e.preventDefault();var f=e.target,code=f.elements.code.value.trim(),b=f.querySelector('[type=submit]');if(code&&code.length<=128)bridge('ussd',{code:code},b).then(function(r){setActionStatus((r&&r.message)||'USSD complete')}).catch(function(x){showActionError('USSD failed',describeError(x),'')})}
function cellularActionCopy(kind,label){return kind==='reconnect'?{title:'Reconnect cellular network?',detail:'Mobile internet will be temporarily unavailable.'}:{title:'Set cellular mode?',detail:'Change mode to '+label+'?'}}
function powerActionCopy(action){return action==='reboot'?{title:'Restart router?',detail:'Wi-Fi will be temporarily unavailable.'}:action==='powerOff'?{title:'Power off router?',detail:'The physical power button is required to turn it on.'}:{title:'Reset total traffic?',detail:'Reset WAN traffic counters?'}}
function makeConfirm(card,copy,action,params,attribute,trigger){var box=card.querySelector('['+attribute+']');if(!box){box=document.createElement('div');box.className='warning';box.setAttribute(attribute,'');card.appendChild(box)}box.hidden=false;if(trigger)trigger.setAttribute('aria-expanded','true');box.innerHTML='';var p=document.createElement('p');p.textContent=copy.title+' '+copy.detail;var yes=document.createElement('button');yes.className='danger';yes.textContent='Confirm';yes.onclick=function(){params.confirmed=true;bridge(action,params,yes).then(function(r){setActionStatus((r&&r.message)||'Command submitted');if(action==='reboot'||action==='powerOff'){paused=true;safeStorageSet('zmiPaused','1');drawTimer()}}).catch(function(e){showActionError('Command failed',describeError(e),'')})};var no=document.createElement('button');no.textContent='Cancel';no.onclick=function(){box.hidden=true;if(trigger)trigger.setAttribute('aria-expanded','false')};box.appendChild(p);box.appendChild(yes);box.appendChild(no)}
function showInlineConfirm(button){var action=button.getAttribute('data-power-action');makeConfirm(button.closest('[data-power-control]'),powerActionCopy(action),action,{},'data-power-confirm',button)}
function showCellularConfirm(el){var mode=el.getAttribute('data-cellular-mode-select')!==null?el.value:'',action=mode?'cellularMode':'cellularReconnect',copy=cellularActionCopy(mode?'mode':'reconnect',mode);makeConfirm(el.closest('.card'),copy,action,mode?{mode:mode}:{},'data-cellular-confirm')}
function showDeviceConfirm(button){makeConfirm(button.closest('.card'),{title:'Run this device-access action?',detail:'The action can change router services.'},'deviceAccess',{deviceAction:button.getAttribute('data-device-action')},'data-device-confirm')}
function confirmSmsDelete(card,item){var box=card.querySelector('[data-delete-confirm]');box.hidden=false;box.classList.remove('error');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.innerHTML='';var prompt=document.createElement('p');prompt.textContent='Delete this SMS? '+String(item.content||'').slice(0,80);var yes=document.createElement('button');yes.className='danger';yes.textContent='Confirm';yes.onclick=function(){box.setAttribute('aria-busy','true');bridge('deleteSms',{id:String(item.id||'')},yes).catch(function(){}).finally(function(){box.setAttribute('aria-busy','false')})};var no=document.createElement('button');no.textContent='Cancel';no.onclick=function(){box.hidden=true};box.appendChild(prompt);box.appendChild(yes);box.appendChild(no)}
function detectionElapsed(){return Math.max(0,Math.floor((Date.now()-detectionStarted)/1000))}
function formatDetectionElapsed(seconds){var m=Math.floor(seconds/60),s=seconds%60;return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
function drawDetectionProgress(){var status=document.querySelector('[data-detection-status]');if(status)status.textContent='Attempt '+detectionAttempt+' · '+formatDetectionElapsed(detectionElapsed())+' · '+detectionCompleted+'/'+detectionTotal+' checks'}
function detectExperimental(button){button=button||document.querySelector('[data-detect-experimental]');if(!button)return Promise.resolve();detectionAttempt++;detectionStarted=Date.now();detectionCompleted=0;detectionTotal=3;drawDetectionProgress();if(detectionTimer)clearInterval(detectionTimer);detectionTimer=setInterval(drawDetectionProgress,1000);return bridge('detectExperimental',{},button).then(function(r){var failed=r&&r.failed||[],elapsed=detectionElapsed(),status=document.querySelector('[data-detection-status]');detectionCompleted=r&&r.completed==null?detectionTotal:r.completed;if(status)status.textContent='Attempt '+detectionAttempt+(failed.length?(detectionCompleted?' partially completed in ':' failed after '):' completed in ')+formatDetectionElapsed(elapsed)+' · '+detectionCompleted+'/'+detectionTotal+' checks'}).catch(function(e){var status=document.querySelector('[data-detection-status]');if(status)status.textContent='Attempt '+detectionAttempt+' failed after '+formatDetectionElapsed(detectionElapsed())+' · '+detectionCompleted+'/'+detectionTotal+' checks';button.dataset.originalLabel='Retry experimental detection';showActionError('Detection failed',describeError(e),'')}).finally(function(){if(detectionTimer){clearInterval(detectionTimer);detectionTimer=null}})}
function initDashboard(){paused=safeStorageGet('zmiPaused')==='1';tab(selectedTab());var draft=safeStorageGet('zmiSmsDraft'),form=document.getElementById('smsComposer');if(form&&draft)form.elements.text.value=draft;if(form)form.elements.text.addEventListener('input',function(){safeStorageSet('zmiSmsDraft',this.value)});window.addEventListener('scroll',function(){var active=document.querySelector('.tab.active');if(active)safeStorageSet('zmiScrollY:'+active.id,String(window.scrollY||0))});timer=setInterval(tick,1000);drawTimer();setTimeout(function(){detectExperimental()},0);document.addEventListener('keydown',handleTabKeydown);document.addEventListener('change',function(e){if(e.target.matches&&e.target.matches('[data-cellular-mode-select]'))showCellularConfirm(e.target)});document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-copy],[data-share],[data-delete-action],[data-power-action],[data-cellular-action],[data-device-action],[data-detect-experimental]');if(!b)return;if(b.hasAttribute('data-copy')){e.preventDefault();e.stopPropagation();copySms(b);return}if(b.hasAttribute('data-share')){e.preventDefault();e.stopPropagation();shareSms(b);return}if(b.hasAttribute('data-delete-action')){var c=b.closest('.sms');confirmSmsDelete(c,{id:c.getAttribute('data-msg-id'),content:c.getAttribute('data-msg-text')})}else if(b.hasAttribute('data-power-action'))showInlineConfirm(b);else if(b.hasAttribute('data-cellular-action'))showCellularConfirm(b);else if(b.hasAttribute('data-device-action'))showDeviceConfirm(b);else detectExperimental(b)})}
var dashboardReady=false;
function markDashboardReady(){if(dashboardReady)return;dashboardReady=true;document.documentElement.dataset.zmiReady='true';initDashboard()}
if(document.readyState==='interactive'||document.readyState==='complete')markDashboardReady();else document.addEventListener('DOMContentLoaded',markDashboardReady,{once:true});
async function copySms(button){var card=button&&button.closest('.sms'),body=card&&card.querySelector('.body'),value=body?(body.innerText||body.textContent||''):'',original=button&&button.textContent||'Copy',copied=false;if(!button||!body)return;button.disabled=true;if(typeof navigator!=='undefined'&&navigator.clipboard&&typeof navigator.clipboard.writeText==='function'){try{await navigator.clipboard.writeText(value);copied=true}catch(webError){}}if(!copied){try{await bridge('copySms',{text:value});copied=true}catch(nativeError){showActionError('Copy SMS manually','Clipboard access failed. Select and copy the SMS text below.',value);button.disabled=false;return}}button.textContent='Copied';button.setAttribute('aria-label','SMS copied');button.setAttribute('role','status');showHistoryToast('SMS copied to clipboard');setTimeout(function(){button.textContent=original;button.removeAttribute('aria-label');button.removeAttribute('role');button.disabled=false},1500)}
async function shareSms(button){var card=button&&button.closest('.sms'),body=card&&card.querySelector('.body');if(!button||!card||!body)return;var sender=card.getAttribute('data-msg-sender')||'Unknown sender',date=card.getAttribute('data-msg-date')||'Unknown time',message=body.innerText||body.textContent||'',value='From: '+sender+'\\nDate: '+date+'\\n\\n'+message;try{var result=await bridge('shareSms',{text:value},button);if(result&&result.cancelled){showHistoryToast('Sharing cancelled');return}if(result&&result.fallback){showHistoryToast('Sharing unavailable — SMS details copied to clipboard');return}showHistoryToast('SMS shared')}catch(error){showActionError('Share failed','The system share sheet could not be opened.','')}}
async function translateSms(button){var card=button&&button.closest('.sms'),box=card&&card.querySelector('[data-translation] span'),text=card?card.getAttribute('data-msg-text')||'':'';if(!box||!model.translateEndpoint)return;var key='zmiTr:'+card.getAttribute('data-msg-id')+':'+text,cached=safeStorageGet(key);if(cached){box.textContent=cached;return}button.disabled=true;try{var res=await fetch(model.translateEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'en',format:'text'})}),raw=await res.text(),data=JSON.parse(raw),tr=data.translatedText||data.translation||'';if(!res.ok||!tr)throw new Error('HTTP '+res.status+'\\nResponse: '+raw);safeStorageSet(key,tr);box.textContent=tr}catch(e){showActionError('Could not prepare translation',describeError(e),text)}finally{button.disabled=false}}
`;
}
function css() { return `:root{color-scheme:dark;--bg:#0b1020;--panel:#111827;--panel2:#172033;--text:#f8fafc;--muted:#a8b3c7;--line:#253044;--cyan:#67e8f9;--blue:#60a5fa;--purple:#a78bfa;--bad:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#101827 0%,var(--bg) 45%,#070b13 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:env(safe-area-inset-top) 10px 30px}main{max-width:720px;margin:auto}.hero{padding:12px 4px 6px}.hero.compact{display:block}.hero h1{font-size:26px;line-height:1;margin:0}.hero strong{color:var(--cyan)}.device-heading{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.device-revision{color:var(--muted);font-size:13px}.device-metadata{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:10px}.device-metadata span{min-width:0}.device-metadata small,.firmware-build small{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}.device-metadata b{display:block;margin-top:2px;overflow-wrap:anywhere}.firmware-build{margin-top:8px;color:var(--muted);font-size:11px}.firmware-build code{display:block;margin-top:2px;font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere}.sms-counter{display:block;margin-top:10px}.statusline{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0;color:var(--muted);font-size:14px}.statusline span{border:1px solid var(--line);border-radius:999px;padding:5px 8px;background:#0d1424}.hero>small,.card small,.mini > span{color:var(--cyan);font-weight:800;letter-spacing:.1em;font-size:10px;text-transform:uppercase}.card p,.mini small{color:var(--muted)}.topgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.mini,.card,.notice,.warning{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,var(--panel2),var(--panel));box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.mini{min-height:86px;position:relative}.mini:after{display:none}.mini strong{display:block;font-size:21px;margin:8px 0 3px}.seg{display:flex;background:#080d18;border:1px solid var(--line);border-radius:14px;padding:4px;margin:8px 0}.seg button{flex:1}.seg button.active,.primary{background:#dff8ff;color:#03111d;border-color:transparent;font-weight:800}.power-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:8px 0;color:var(--muted);font-size:13px}.power-toolbar>span{white-space:nowrap}.power-toolbar>button{padding:6px 10px}.power-toolbar>[data-power-confirm]{flex-basis:100%;margin:0}.dashboard-tabs{align-items:flex-end;gap:4px;background:transparent;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:0}.dashboard-tabs button{margin-bottom:-1px;border-color:transparent;border-bottom:3px solid transparent;border-radius:8px 8px 0 0;background:transparent;color:var(--muted)}.dashboard-tabs button.active{background:var(--panel);color:var(--text);border-color:var(--line) var(--line) var(--cyan);outline:none;font-weight:800}button,a,.buttonlike{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:8px 11px;background:#182235;color:var(--text);text-decoration:none;font:inherit}button{transition:transform .12s ease,background-color .16s ease,border-color .16s ease}button:active,a:active{transform:scale(.94);filter:brightness(1.25)}button[data-state="pending"]{border-color:var(--cyan);background:#123044;cursor:progress}button[data-state="pending"]:before{content:'◌';display:inline-block;margin-right:5px;animation:spin .7s linear infinite}button[data-state="success"]{border-color:var(--good);background:#12352d}button[data-state="error"]{border-color:var(--bad);background:#401824}button:disabled,button[data-state="disabled"]{opacity:.48;cursor:not-allowed;filter:saturate(.4)}button[aria-pressed="true"],button.active{outline:2px solid var(--cyan);outline-offset:1px}.danger{color:var(--bad)}.refresh{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0 10px;color:var(--muted);font-size:14px}.actions,.inline-toolbar{display:flex;gap:8px;flex-wrap:wrap}.inline-toolbar{margin:8px 0}.tab{display:none}.tab.active{display:block}.card{margin:8px 0}.card h2{font-size:24px;margin:6px 0}.experimental-list{list-style:none;margin:14px 0 0;padding:0}.experimental-list>li{position:relative;margin:12px 0;padding-left:18px}.experimental-list>li:before{content:'›';position:absolute;left:0;color:var(--cyan);font-weight:800}.experimental-list h3{font-size:18px;margin:0 0 4px}.experimental-list ul{list-style:circle;margin:6px 0 0;padding-left:24px}.experimental-list h4{font-size:14px;margin:8px 0 6px;color:var(--muted)}.composer input,.composer textarea,.selectline select{width:100%;margin:0 0 8px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.formStatus{margin:8px 0 0;color:#fbbf24}.selectline{display:block;color:var(--muted);margin:8px 0}.selectline select{display:block;margin-top:6px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.sms{padding:11px;margin:8px 0}.sms header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;border-bottom:1px solid #253044aa;padding-bottom:7px}.sms h3{margin:0 0 2px;font-size:15px}.sms time,.sms footer{color:var(--muted);font-size:12px}.sms footer{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #253044aa;padding-top:8px}.sms footer button,.sms footer a{padding:6px 9px;border-radius:10px}.sms .body{white-space:pre-wrap;word-break:break-word;font-size:17px;line-height:1.45;color:#f8fafc;margin:10px 0}.translation{color:var(--muted);font-size:14px}.translation span:empty{display:none}.app-value{user-select:text;-webkit-user-select:text;-webkit-touch-callout:default}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.diag-spinner{display:inline-block;width:14px;height:14px;margin-left:5px;border:2px solid #ffffff35;border-top-color:var(--cyan);border-radius:50%;animation:diagSpin .7s linear infinite;vertical-align:middle}.diag-spinner[hidden]{display:none}@keyframes diagSpin{to{transform:rotate(360deg)}}.cellular-diagnostics ol{padding-left:22px}.diag-stage{margin:7px 0}.diag-stage.ok{color:var(--good)}.diag-stage.pending{color:#fbbf24}.diag-stage.failed{color:var(--bad)}.diag-stage.unknown{color:var(--muted)}.diag-group h3{grid-column:1/-1;margin:10px 0 2px;color:var(--cyan);font-size:13px}.diag-partial{font-size:12px}.diag-grid{border-top:1px solid var(--line);margin-top:10px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.diag-grid p{min-width:0;overflow-wrap:anywhere;margin:7px 0}.diag-grid p span{display:block;color:var(--muted);font-size:11px}.stale{opacity:.7}.diag-endpoint-error{color:var(--bad);overflow-wrap:anywhere}.section-title{font-size:14px;color:var(--cyan);margin:16px 4px 4px}.active-apn{color:var(--cyan)}.quality{display:inline-block;padding:6px 10px;border-radius:999px;background:#34d39922;color:var(--good)}.codes{font-family:ui-monospace,Menlo,monospace}.bar{height:10px;background:#ffffff14;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue),var(--cyan));border-radius:inherit}.progressbar{position:fixed;left:0;right:0;top:0;height:3px;z-index:1000;background:transparent;overflow:hidden}.progressbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--blue));box-shadow:0 0 16px var(--cyan)}.progressbar.active i{animation:progressStart 1.2s ease-in-out infinite}@keyframes spin{to{transform:rotate(360deg)}}@keyframes progressStart{0%{width:0;transform:translateX(0)}55%{width:72%;transform:translateX(12%)}100%{width:40%;transform:translateX(160%)}}.notice{color:var(--good);margin:8px 0}.history-toast{position:fixed;z-index:1100;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 24px);padding:10px 16px;border:1px solid #34d39966;border-radius:14px;background:#12352d;color:var(--text);box-shadow:0 8px 22px #0008}.history-toast[hidden]{display:none}.notice.warning{color:#fbbf24;border-color:#fbbf2466;background:linear-gradient(180deg,#3b2f14,#1f1a0f)}.notice.error{color:var(--bad);border-color:#fb718566;background:linear-gradient(180deg,#3b1720,#1f0f14)}.warning{color:#fbbf24}.signal-bars{display:inline-flex;gap:3px;align-items:flex-end;height:22px;vertical-align:middle}.signal-bars i{display:block;width:5px;border-radius:3px;background:#ffffff30}.signal-bars i:nth-child(1){height:6px}.signal-bars i:nth-child(2){height:9px}.signal-bars i:nth-child(3){height:12px}.signal-bars i:nth-child(4){height:16px}.signal-bars i:nth-child(5){height:20px}.signal-bars i.on{background:var(--cyan)}.action-status{margin:8px 0;border:1px solid #fbbf2466;border-radius:18px;background:linear-gradient(180deg,#3b2f14,#1f1a0f);box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.action-status header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.action-status p{white-space:pre-wrap;color:#fde68a;margin:8px 0}.action-status textarea,.action-status pre{width:100%;max-width:100%;min-height:96px;margin:8px 0 0;padding:10px;border-radius:12px;border:1px solid #fbbf2466;background:#0b1220;color:#f8fafc;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto;user-select:text;-webkit-user-select:text}.action-status textarea[hidden],.action-status pre[hidden]{display:none}.empty{text-align:center}@media(prefers-reduced-motion:reduce){button{transition:none}.progressbar.active i,button[data-state="pending"]:before,.diag-spinner{animation:none}}@media(max-width:520px){.topgrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.topgrid .mini-traffic{grid-column:1 / -1}.diag-grid{grid-template-columns:1fr}.card,.mini{max-width:100%}.codes{overflow-wrap:anywhere}.refresh{align-items:flex-start}.actions{justify-content:flex-end}}@media(max-width:340px){.power-toolbar{align-items:stretch}.power-toolbar>span,.power-toolbar>button{width:100%}.power-toolbar>button{text-align:center}.topgrid{grid-template-columns:1fr}.topgrid .mini-traffic{grid-column:auto}}`; }
async function showMessage(title, message, icon) {
  const alert = new Alert();
  alert.title = `${icon || ""} ${title || "ZMI"}`.trim();
  alert.message = String(message || "");
  alert.addAction("OK");
  await alert.presentAlert();
}

// Generic XML and text helpers
function tag(xml, name) { const hit = String(xml || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return hit ? htmlDecode(hit[1].trim()) : ""; }
function firstText(xml, names) { for (const name of names) { const value = tag(xml, name).trim(); if (value) return value; } return ""; }
function firstNumber(xml, names) { for (const name of names) { const value = number(tag(xml, name)); if (value !== null) return value; } return null; }
function firstSigned(xml, names) { for (const name of names) { const hit = tag(xml, name).replace(",", ".").match(/-?[0-9]+(?:\.[0-9]+)?/); if (hit) return Number(hit[0]); } return null; }
function number(value) { const clean = String(value || "").replace(/[^0-9.-]/g, ""); const result = Number(clean); return clean && Number.isFinite(result) && result >= 0 ? result : null; }
function attr(value, name) { const hit = String(value).match(new RegExp(`${name}=["']([^"']+)["']`, "i")); return hit ? hit[1] : ""; }
function sum(...values) { const known = values.filter(value => value !== null && Number.isFinite(value)); return known.length ? known.reduce((a, b) => a + b, 0) : null; }
function escapeXml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function htmlDecode(value) { return String(value || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }
function escapeHtml(value) { return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
function cleanError(error) { return String(error && error.message ? error.message : error).replace(/^Error:\s*/i, "").trim(); }
function pad2(value) { return String(value).padStart(2, "0"); }

// Compact MD5 implementation used by the router's Digest authentication.
function md5(input) {
  function add(a,b){return(a+b)&0xffffffff} function cmn(q,a,b,x,s,t){a=add(add(a,q),add(x,t));return add((a<<s)|(a>>>(32-s)),b)}
  function ff(a,b,c,d,x,s,t){return cmn((b&c)|(~b&d),a,b,x,s,t)} function gg(a,b,c,d,x,s,t){return cmn((b&d)|(c&~d),a,b,x,s,t)}
  function hh(a,b,c,d,x,s,t){return cmn(b^c^d,a,b,x,s,t)} function ii(a,b,c,d,x,s,t){return cmn(c^(b|~d),a,b,x,s,t)}
  function cycle(x,k){let a=x[0],b=x[1],c=x[2],d=x[3];
    a=ff(a,b,c,d,k[0],7,-680876936);d=ff(d,a,b,c,k[1],12,-389564586);c=ff(c,d,a,b,k[2],17,606105819);b=ff(b,c,d,a,k[3],22,-1044525330);a=ff(a,b,c,d,k[4],7,-176418897);d=ff(d,a,b,c,k[5],12,1200080426);c=ff(c,d,a,b,k[6],17,-1473231341);b=ff(b,c,d,a,k[7],22,-45705983);a=ff(a,b,c,d,k[8],7,1770035416);d=ff(d,a,b,c,k[9],12,-1958414417);c=ff(c,d,a,b,k[10],17,-42063);b=ff(b,c,d,a,k[11],22,-1990404162);a=ff(a,b,c,d,k[12],7,1804603682);d=ff(d,a,b,c,k[13],12,-40341101);c=ff(c,d,a,b,k[14],17,-1502002290);b=ff(b,c,d,a,k[15],22,1236535329);
    a=gg(a,b,c,d,k[1],5,-165796510);d=gg(d,a,b,c,k[6],9,-1069501632);c=gg(c,d,a,b,k[11],14,643717713);b=gg(b,c,d,a,k[0],20,-373897302);a=gg(a,b,c,d,k[5],5,-701558691);d=gg(d,a,b,c,k[10],9,38016083);c=gg(c,d,a,b,k[15],14,-660478335);b=gg(b,c,d,a,k[4],20,-405537848);a=gg(a,b,c,d,k[9],5,568446438);d=gg(d,a,b,c,k[14],9,-1019803690);c=gg(c,d,a,b,k[3],14,-187363961);b=gg(b,c,d,a,k[8],20,1163531501);a=gg(a,b,c,d,k[13],5,-1444681467);d=gg(d,a,b,c,k[2],9,-51403784);c=gg(c,d,a,b,k[7],14,1735328473);b=gg(b,c,d,a,k[12],20,-1926607734);
    a=hh(a,b,c,d,k[5],4,-378558);d=hh(d,a,b,c,k[8],11,-2022574463);c=hh(c,d,a,b,k[11],16,1839030562);b=hh(b,c,d,a,k[14],23,-35309556);a=hh(a,b,c,d,k[1],4,-1530992060);d=hh(d,a,b,c,k[4],11,1272893353);c=hh(c,d,a,b,k[7],16,-155497632);b=hh(b,c,d,a,k[10],23,-1094730640);a=hh(a,b,c,d,k[13],4,681279174);d=hh(d,a,b,c,k[0],11,-358537222);c=hh(c,d,a,b,k[3],16,-722521979);b=hh(b,c,d,a,k[6],23,76029189);a=hh(a,b,c,d,k[9],4,-640364487);d=hh(d,a,b,c,k[12],11,-421815835);c=hh(c,d,a,b,k[15],16,530742520);b=hh(b,c,d,a,k[2],23,-995338651);
    a=ii(a,b,c,d,k[0],6,-198630844);d=ii(d,a,b,c,k[7],10,1126891415);c=ii(c,d,a,b,k[14],15,-1416354905);b=ii(b,c,d,a,k[5],21,-57434055);a=ii(a,b,c,d,k[12],6,1700485571);d=ii(d,a,b,c,k[3],10,-1894986606);c=ii(c,d,a,b,k[10],15,-1051523);b=ii(b,c,d,a,k[1],21,-2054922799);a=ii(a,b,c,d,k[8],6,1873313359);d=ii(d,a,b,c,k[15],10,-30611744);c=ii(c,d,a,b,k[6],15,-1560198380);b=ii(b,c,d,a,k[13],21,1309151649);a=ii(a,b,c,d,k[4],6,-145523070);d=ii(d,a,b,c,k[11],10,-1120210379);c=ii(c,d,a,b,k[2],15,718787259);b=ii(b,c,d,a,k[9],21,-343485551);x[0]=add(a,x[0]);x[1]=add(b,x[1]);x[2]=add(c,x[2]);x[3]=add(d,x[3]);}
  function block(s){const out=[];for(let i=0;i<64;i+=4)out[i>>2]=s.charCodeAt(i)+(s.charCodeAt(i+1)<<8)+(s.charCodeAt(i+2)<<16)+(s.charCodeAt(i+3)<<24);return out}
  input=unescape(encodeURIComponent(input));const length=input.length,state=[1732584193,-271733879,-1732584194,271733878];let i;for(i=64;i<=length;i+=64)cycle(state,block(input.substring(i-64,i)));input=input.substring(i-64);const tail=new Array(16).fill(0);for(i=0;i<input.length;i++)tail[i>>2]|=input.charCodeAt(i)<<((i%4)<<3);tail[i>>2]|=0x80<<((i%4)<<3);if(i>55){cycle(state,tail);tail.fill(0)}tail[14]=length*8;cycle(state,tail);return state.map(n=>{let s="";for(let j=0;j<4;j++)s+=((n>>(j*8+4))&15).toString(16)+((n>>(j*8))&15).toString(16);return s}).join("");
}
