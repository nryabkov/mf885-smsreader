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
let compatibilityModule = null;
let engineerParameterModule = null;
let cellularDiagnosticsModule = null;
let ACTIVE_PROFILE = { id: "unknown", confirmed: false };
let CONFIGURED_PROFILE = "";
let PROFILE_OVERRIDE = "";
const LEGACY_DEFAULT_PROFILE = "2.5.96";
if (typeof require === "function") {
  compatibilityModule = require("./modules/compatibility-profiles.js");
  cellularDiagnosticsModule = require("./modules/cellular-diagnostics.js");
}

const XML_REQUEST_PATH = "/xml_action.cgi";
const XML_DIGEST_URI = "/cgi/xml_action.cgi";
let ACTIVE_XML_REQUEST_PATH = XML_REQUEST_PATH;

let POLL_SECONDS = 30;
const SMS_PAGE_SIZE = 10;
const SMS_MAX_PAGES = 500;
const USSD_RESPONSE_POLLS = 8;
let DEBUG = true;
let DEBUG_SENSITIVE_PAYLOADS = false;
let SKIP_SMS_CONTENT_LOG = true;
const LOGGED_FIRMWARE_MISMATCHES = new Set();
let DEBUG_REQUEST_SEQUENCE = 0;
const DEBUG_CHUNK_SIZE = 900;
const DEBUG_MAX_CHUNKS = 4;
const TRANSLATE_ENDPOINT = ""; // LibreTranslate-compatible endpoint, e.g. https://libretranslate.example/translate

const QUERY = typeof args !== "undefined" && args.queryParameters
  ? args.queryParameters
  : {};
const ACTION = String(QUERY.action || "dashboard");
const INITIAL_TAB = String(QUERY.tab || "sms") === "router" ? "router" : "sms";

/**
 * Run the dashboard with settings supplied by loader.js.
 * Keeping configuration at this boundary lets the loader store credentials in
 * Keychain instead of writing them into the downloaded application module.
 */
async function run(options = {}) {
  configureDebug(options);
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
  compatibilityModule = importModule(`${options.moduleDirectory}/modules/compatibility-profiles.js`);
  engineerParameterModule = importModule(`${options.moduleDirectory}/modules/engineer-parameter.js`);
  cellularDiagnosticsModule = importModule(`${options.moduleDirectory}/modules/cellular-diagnostics.js`);
  CONFIGURED_PROFILE = String(options.compatibilityProfile || "");
  PROFILE_OVERRIDE = String(options.compatibilityProfileOverride || "").trim();
  ACTIVE_PROFILE = resolveCompatibilityProfile("", "");
  ACTIVE_XML_REQUEST_PATH = options.xmlRequestPath || ACTIVE_PROFILE.xmlRequestPath || XML_REQUEST_PATH;
  await main();
}

module.exports = { run, dashboardFlow, resolveCompatibilityProfile, chooseCompatibilityProfile, XML_REQUEST_PATH, XML_DIGEST_URI, xmlRequestUrl, parseDigestChallenge, authorization, authenticatedRequest, buildHtml, clientScript, parseCounter, formatBytes, parseBattery, parseNetwork, parseTraffic, parseSmsPage, loadAllSms, loadRemainingSms, mergeSmsPage, inspectSmsEdges, smsEdgeFingerprint, pageMessageFingerprint, unchangedSms, batteryInlineLabel, networkProtocol, signalBarsHtml, sanitizeDiagnostics, smsSegments, webPollPayload, createInFlightGuard, capabilityCacheValid, createWebViewDispatcher, validateWebViewCommand, loadModel, configureDebug, debugLog, debugXml, redactDebugValue, redactDebugPayload, logXmlSummary, statusCompatibilityError, routerAccepted };

function chooseCompatibilityProfile(options, detectedFirmware, detectedModel, profiles = compatibilityModule) {
  const override=String(options&&options.compatibilityProfileOverride||"").trim(), configured=String(options&&options.compatibilityProfile||"").trim();
  const detected=String(detectedFirmware||"").trim(), model=String(detectedModel||"").trim();
  const key=override || detected || (model && profiles.PROFILES[model] ? model : "") || configured || LEGACY_DEFAULT_PROFILE;
  return profiles.selectProfile(key);
}
function resolveCompatibilityProfile(detectedFirmware, detectedModel) {
  return chooseCompatibilityProfile({compatibilityProfile:CONFIGURED_PROFILE,compatibilityProfileOverride:PROFILE_OVERRIDE},detectedFirmware,detectedModel);
}

function configureDebug(options = {}) {
  DEBUG = options.debug !== false;
  DEBUG_SENSITIVE_PAYLOADS = options.debugSensitivePayloads === true;
  SKIP_SMS_CONTENT_LOG = options.skipSmsContentLog !== false;
}

function redactDebugValue(value) {
  let text = String(value === undefined || value === null ? "" : value);
  text = text.replace(/<(content|message_content|subject|contacts|from|phone_number|sender|recipient|password|passwd|pwd|pin|puk|psk|ussd(?:_code|code)?|current_device_mac|mac(?:_address)?|imei|iccid|imsi|ssid|wifi(?:_key|_password)?|apn|ip(?:v[46])?|ip_address)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1><redacted></$1>");
  text = text.replace(/\b(Authorization|Cookie|Set-Cookie|password|passwd|pwd|token|nonce|cnonce|response)\b\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|[^\s,;&]+)/gi, "$1=<redacted>");
  text = text.replace(/([?&](?:token|password|passwd|pwd|nonce|cnonce|response|code)=)[^&#]*/gi, "$1<redacted>");
  text = text.replace(/(?:\+\d[\d ()-]{6,}\d)/g, "<redacted-phone>");
  return text.replace(/[\r\n]+/g, " ");
}
function redactDebugPayload(payload) {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload !== "object") return redactDebugValue(payload);
  const blocked = /authorization|cookie|password|passwd|pwd|token|nonce|cnonce|response|content|contacts|phone|sender|recipient|ussd|mac|imei|iccid|imsi|ssid|wifi|apn|(?:^|_)ip(?:v[46])?(?:_|$)/i;
  const copy = Array.isArray(payload) ? [] : {};
  Object.keys(payload).forEach(key => { copy[key] = blocked.test(key) ? "<redacted>" : redactDebugPayload(payload[key]); });
  return copy;
}
function debugLog(event, data) {
  if (!DEBUG) return;
  const safe = redactDebugPayload(data || {});
  const fields = Object.keys(safe).map(key => `${key}=${typeof safe[key] === "object" ? JSON.stringify(safe[key]) : safe[key]}`).join(" ");
  console.log(`[ZMI DEBUG]${event ? `[${redactDebugValue(event)}]` : ""}${fields ? ` ${fields}` : ""}`);
}
function debugXml(event, xml) {
  if (!DEBUG) return;
  if (SKIP_SMS_CONTENT_LOG && (/message|sms/i.test(String(event)) || /<(?:content|message_content|subject|contacts|from|phone_number|sender|recipient)\b/i.test(String(xml||"")))) {
    debugLog(event, { omitted:"SMS content logging disabled", bytes:String(xml||"").length, structure:xmlStructure(xml) });
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
function statusCompatibilityError(xml, profile = ACTIVE_PROFILE) {
  const structure=xmlStructure(xml);
  if (structure.WanStatistics || structure.batteryinfo || structure.cellularFields.length) return "";
  return `Router responded successfully, but status1 format does not match compatibility profile ${profile.id}. Missing expected XML sections: WanStatistics, batteryinfo, cellular/network fields.`;
}
function firmwareVersion(xml) { return firstText(xml, ["version_num"]) || ""; }
function profileVersionWarning(actual, configured, profile) {
  if (!actual || !configured || actual === configured || actual === (profile && profile.firmware)) return "";
  return `Firmware profile mismatch: configured ${configured}, but status1 reports ${actual}. Manual compatibilityProfile override remains active.`;
}
function firmwareWarningId(actual, configured) {
  const value=`${String(configured||"unknown")}\u0000${String(actual||"unknown")}`;
  let hash=2166136261; for(let i=0;i<value.length;i++){hash^=value.charCodeAt(i);hash=Math.imul(hash,16777619);}
  return `firmware-${(hash>>>0).toString(16)}`;
}

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
  if (typeof notice === "object") return { text: String(notice.text || ""), type: ["success", "warning", "error"].includes(notice.type) ? notice.type : "success", diagnostics: sanitizeDiagnostics(notice.diagnostics || "") };
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
  const dispatcher = dependencies.createDispatcher(auth, model, web, { smsGuard, refreshGuard });
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
  const model={sms:currentSms||emptySms(),traffic:{},battery:{},network:{},cellularDiagnostics:{},errors:{},loadedAt:Date.now()};
  let status = null;
  try { status=await getStatus(auth); model.traffic=parseTraffic(status); model.battery=parseBattery(status); model.network=parseNetwork(status); }
  catch(error){ model.errors.status=cleanError(error); }
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
    batteryPercent: model.battery && model.battery.percent,
    operator: model.network && model.network.operator || "",
    roaming: model.network && model.network.fields && model.network.fields.roaming || null,
    signalRaw: model.network && model.network.signalRaw || null,
    trafficTotal: formatBytes(model.traffic && model.traffic.total),
    trafficDown: formatBytes(model.traffic && model.traffic.download),
    trafficUp: formatBytes(model.traffic && model.traffic.upload),
    cellularDiagnostics: model.cellularDiagnostics || {},
    errors: model.errors || {}
  };
}

async function loadModel(auth) {
  const model = {
    sms: emptySms(), traffic: {}, battery: {}, network: {}, cellularDiagnostics: {}, ussd: {}, deviceAccess: {}, cellularControl: {},
    errors: {}, notice: "", tab: "sms", loadedAt: Date.now()
  };
  let status = null;
  const initial = await Promise.allSettled([getStatus(auth), getSmsPage(auth, 1)]);
  debugLog("loadModel:allSettled", { status1:initial[0].status, message:initial[1].status });
  try {
    if (initial[0].status === "rejected") throw initial[0].reason;
    status = initial[0].value;
    const actualFirmware=firmwareVersion(status);
    ACTIVE_PROFILE=resolveCompatibilityProfile(actualFirmware, firstText(status,["model","model_name","product_name"]));
    model.actualFirmware=actualFirmware;
    const versionWarning=profileVersionWarning(actualFirmware,PROFILE_OVERRIDE,ACTIVE_PROFILE);
    if(versionWarning) {
      model.errors.profile=versionWarning;
      model.firmwareWarning={id:firmwareWarningId(actualFirmware,PROFILE_OVERRIDE),configured:PROFILE_OVERRIDE,detected:actualFirmware,text:versionWarning};
      if(!LOGGED_FIRMWARE_MISMATCHES.has(model.firmwareWarning.id)){LOGGED_FIRMWARE_MISMATCHES.add(model.firmwareWarning.id);debugLog("firmware:mismatch",{id:model.firmwareWarning.id,configured:CONFIGURED_PROFILE,detected:actualFirmware});}
    }
    model.traffic = sectionWithError(parseTraffic(status), "trafficError", "status1 has no WanStatistics data");
    model.battery = sectionWithError(parseBattery(status), "batteryError", "status1 has no batteryinfo data");
    model.network = sectionWithError(parseNetwork(status), "networkError", "status1 has no cellular network data");
    debugLog("network:normalized",{firmware:actualFirmware,profile:ACTIVE_PROFILE.id,sys_mode:model.network.raw&&model.network.raw.sys_mode,sys_submode:model.network.raw&&model.network.raw.sys_submode,ConnType:model.network.raw&&model.network.raw.ConnType,proto:model.network.raw&&model.network.raw.proto,source:model.network.networkSource,currentRat:model.network.mode,reason:model.network.networkConflict?"conflict":model.network.generation==="Unknown"?"unknown":null});
    const compatibilityError=statusCompatibilityError(status);
    if (compatibilityError) model.errors.status=compatibilityError;
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
  const result = await cellularControlModule.executeReconnect(cellularControlApi(auth), capability, ACTIVE_PROFILE);
  return dashboardFlow(auth, { text: `${result.title}: ${result.message}`, type: result.ok ? "success" : "error", diagnostics: result.diagnostics }, "router");
}

async function cellularModeFlow(auth) {
  const capability = await detectCellularControl(auth);
  const modeId = String(QUERY.mode || "").trim();
  const mode = cellularControlModule.modeById(modeId, ACTIVE_PROFILE);
  if (!mode) return dashboardFlow(auth, errorNotice("Unknown cellular network mode."), "router");
  if (String(QUERY.confirm || "") !== "1") {
    return dashboardFlow(auth, warningNotice(`Confirm experimental cellular mode change: ${mode.title}. Mobile internet may be temporarily unavailable.`), "router");
  }
  const result = await cellularControlModule.executeSetMode(cellularControlApi(auth), capability, mode.id, ACTIVE_PROFILE);
  return dashboardFlow(auth, { text: `${result.title}: ${result.message}`, type: result.ok ? "success" : "error", diagnostics: result.diagnostics }, "router");
}

async function resetTrafficFlow(auth) {
  if (String(QUERY.confirm || "") !== "1") return dashboardFlow(auth, warningNotice("Confirm WAN traffic reset."), "router");
  const spec = ACTIVE_PROFILE.statisticsReset;
  if (!spec || !spec.confirmed) return dashboardFlow(auth, warningNotice("WAN statistics reset is read-only: this firmware has no confirmed reset mapping."), "router");
  const beforeXml = await xmlRequest(auth, "GET", "statistics");
  const before = wanCounterSnapshot(beforeXml);
  const body = `<RGW><statistics><WanStatistics><set_action>${escapeXml(spec.set_action)}</set_action><clear_cur_stat_flag>${escapeXml(spec.clear_cur_stat_flag)}</clear_cur_stat_flag></WanStatistics></statistics></RGW>`;
  const result = await writeThenVerify(auth, { model:"statistics", xml:body, verificationModel:"statistics", verify: xml => statisticsResetMatches(before, wanCounterSnapshot(xml)) });
  return dashboardFlow(auth, result.outcome === "confirmed" ? successNotice("WAN statistics reset was confirmed.") : warningNotice(`WAN statistics reset: ${result.outcome}.`), "router");
}

async function powerFlow(auth, kind) {
  if (String(QUERY.confirm || "") !== "1") return dashboardFlow(auth, warningNotice(kind === "reboot" ? "Confirm router reboot." : "Confirm router shutdown."), "router");
  const operation = kind === "reboot" ? "reset" : kind === "trueShutdown" ? "trueshutdown" : "poweroff";
  const spec = ACTIVE_PROFILE.destructive && ACTIVE_PROFILE.destructive[operation];
  if (!spec) return dashboardFlow(auth, warningNotice("This destructive operation is unavailable because its trigger is not confirmed for this firmware."), "router");
  const xml = `<RGW><${spec.tree}></${spec.tree}></RGW>`;
  const result = await writeThenVerify(auth, { model:spec.file, xml, destructive:true });
  return dashboardFlow(auth, warningNotice(`Router operation submitted; result is ${result.outcome}. Safe status polling will detect when the router returns.`), "router");
}

function wanCounterSnapshot(xml) { return { rx: firstText(xml,["rx_byte_all"]), tx:firstText(xml,["tx_byte_all"]), used:firstText(xml,["total_used_data","total_used_all"]) }; }
function statisticsResetMatches(before, after) { return !!before && !!after && before.rx !== after.rx && before.tx !== after.tx && before.used !== after.used; }
async function writeThenVerify(auth, operation) {
  const helper = apiContractModule && apiContractModule.writeThenVerify;
  if (!helper) throw new Error("Write verification helper is unavailable");
  return helper({ ...operation, post:(model,xml,opts)=>xmlRequest(auth,"POST",model,xml,opts.retry401 !== false), get:model=>xmlRequest(auth,"GET",model), pollAvailability:async()=>{ for(let i=0;i<3;i++){ await sleep(1000); try { await getStatus(auth); return true; } catch (_) {} } return false; } });
}

function sanitizeDiagnostics(value) {
  return String(value || "")
    .replace(/(password|passwd|pwd|pin|puk|psk)([=:\s]+)[^\s&|<]+/ig, "$1$2<redacted>")
    .replace(/(response=)[0-9a-f]{16,}/ig, "$1<redacted>")
    .replace(/(authorization:\s*Digest[^\n]*)/ig, "Authorization: <redacted>")
    .replace(/(nonce|cnonce)([=:\s"]+)[^\s,&|"]+/ig, "$1$2<redacted>")
    .replace(/(cookie:|set-cookie:|x-[^:\n]*token:)[^\n]*/ig, "$1 <redacted>");
}

// Digest authentication and router API
async function getAuthChallenge() {
  const req = new Request(`http://${ROUTER_HOST}/login.cgi`);
  req.method = "GET";
  req.headers = baseHeaders();
  debugLog("auth:challenge", { stage:"request", url:`http://${ROUTER_HOST}/login.cgi` });
  try { await req.loadString(); } catch (error) { debugLog("auth:challenge", { stage:"exception", error:cleanError(error) }); }
  const headers = req.response ? req.response.headers : {};
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
  return { text, exception, response };
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
async function sendSms(auth, to, text) {
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><message><flag><message_flag>SEND_SMS</message_flag><sms_cmd>4</sms_cmd></flag><send_save_message><contacts>${escapeXml(to)}</contacts><content>${utf16Hex(text)}</content><encode_type>UNICODE</encode_type><sms_time>${smsTime()}</sms_time></send_save_message></message></RGW>`;
  return xmlRequest(auth, "POST", "message", xml);
}

async function deleteSms(auth, id) {
  const safeId = escapeXml(id);
  const attempts = [
    `<RGW><message><flag><message_flag>DELETE_SMS</message_flag></flag><delete_message><message_id>${safeId}</message_id></delete_message></message></RGW>`,
    `<RGW><message><flag><message_flag>DELETE_SMS_LOCAL</message_flag></flag><delete_message><message_id>${safeId}</message_id></delete_message></message></RGW>`,
    `<RGW><message><flag><message_flag>DELETE_SMS</message_flag></flag><delete_message><index>${safeId}</index></delete_message></message></RGW>`
  ];
  const diagnostics = [];
  let lostConnection = false;
  let stillPresent = false;
  let rejected = false;

  for (const payload of attempts) {
    const xml = `<?xml version="1.0" encoding="US-ASCII"?>${payload}`;
    try {
      const response = await xmlRequest(auth, "POST", "message", xml);
      diagnostics.push(compactDebug(response));
      if (!routerAccepted(response)) { rejected = true; continue; }
      await sleep(500);
      let current;
      try { current = await loadAllSms(auth); }
      catch (verifyError) { lostConnection = true; diagnostics.push(cleanError(verifyError)); continue; }
      if (!current.messages.some(message => String(message.id) === String(id))) return { ok: true, message: "The SMS was removed from the router." };
      stillPresent = true;
      diagnostics.push("The message was still present after the command.");
    } catch (error) {
      const detail = cleanError(error);
      diagnostics.push(detail);
      if (/network|timed? ?out|could not connect|not connected|host|dns|offline|connection/i.test(detail)) lostConnection = true;
    }
  }
  let message = "The router rejected the SMS deletion command.";
  if (lostConnection) message = "Deletion could not be verified because the router connection was lost.";
  else if (stillPresent) message = "The router accepted a deletion command, but the SMS is still present.";
  else if (rejected) message = "The router firmware rejected or did not complete the deletion command.";
  return { ok: false, message, diagnostics: diagnostics.join("\n") };
}

function compactDebug(value, limit = 240) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit); }

function routerAccepted(xml) {
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
  if (!parsed || !parsed.messages || !parsed.messages.length) return result;
  if (result.totalPages === null) result.totalPages = parsed.totalPages;
  if (result.totalMessages === null) result.totalMessages = parsed.totalMessages;
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
  const seenPages = new Set();
  if (first.messages.length) seenPages.add(pageMessageFingerprint(first.messages));
  let last = first;
  for (let page = Math.max(2, (result.loadedPages || 1) + 1); page <= SMS_MAX_PAGES; page++) {
    if (result.totalPages !== null && page > result.totalPages) break;
    let parsed;
    try { parsed = parseSmsPage(await getSmsPage(auth, page), page); }
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
      result.warning = "The router reported message count as total_number; page count was inferred.";
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
  const totalPages = firstNumber(xml, ["total_pages", "total_page", "page_count", "total_page_number"]);
  const legacy = firstNumber(xml, ["total_number"]);
  return { page, totalMessages: totalMessages !== null ? totalMessages : legacy, totalPages, legacyTotalNumber: legacy, messages: parseSmsItems(xml) };
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
function parseSendResult(xml) { const lower = String(xml || "").toLowerCase(); const status = firstText(xml, ["sms_cmd_status_result", "send_status"]); const ok = !unauthorized(xml) && !/error|fail/.test(lower) && status !== "0" && status !== "2"; return { ok, message: ok ? "The router accepted the send command" : "The router rejected the send command" }; }

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
function parseBattery(xml) {
  const source = tag(xml, "batteryinfo") || xml;
  const percentRaw = firstText(source, ["Battery_percent"]);
  const percentNumber = percentRaw !== "" && /^\d+$/.test(percentRaw) ? Number(percentRaw) : null;
  const percent = percentNumber !== null && percentNumber >= 0 && percentNumber <= 100 ? percentNumber : null;
  const batteryStatus = firstText(source, ["Battery_status", "battery_status", "battery_charging"]);
  const chargerStatus = firstText(source, ["Charger_status", "charger_status", "CDetectStatus"]);
  const chargerCurrentRaw = firstText(source, ["Charger_current", "charger_current"]), outputCurrentRaw = firstText(source, ["Output_current", "output_current"]);
  const chargerCurrent = chargerCurrentRaw !== "" && Number.isFinite(Number(chargerCurrentRaw)) ? Number(chargerCurrentRaw) : null;
  const outputCurrent = outputCurrentRaw !== "" && Number.isFinite(Number(outputCurrentRaw)) ? Number(outputCurrentRaw) : null;
  const state = batteryState(batteryStatus, chargerStatus, percent, chargerCurrent, outputCurrent);
  const labels={charging:"Charging",discharging:"Discharging",full:"Full",unknown:"Unknown"}, status=labels[state];
  const contradictory=chargerCurrent!==null&&chargerCurrent>0&&outputCurrent!==null&&outputCurrent>0;
  const detailText=contradictory?`${status} · conflicting charge/output currents`:status;
  return { hasData: percentRaw !== "" || !!batteryStatus || !!chargerStatus || chargerCurrent !== null || outputCurrent !== null, percent, percentRaw, percentValid: percent !== null, charging:state==="charging"||state==="full", state, status, detailText, chargerCurrent, outputCurrent, rawStatus:batteryStatus || "", chargerStatus:chargerStatus || "", rawChargerStatus:chargerStatus || "", rawChargerCurrent:chargerCurrentRaw, rawOutputCurrent:outputCurrentRaw };
}
function batteryState(batteryStatus, chargerStatus, percent, chargerCurrent, outputCurrent) {
  const raw = String(batteryStatus || "").trim();
  const charger = String(chargerStatus || "").trim();
  const lower = raw.toLowerCase();
  const chargerLower = charger.toLowerCase();
  const hasCharger =
    /charg|adapter|usb|ac|plug|online/.test(lower) ||
    /charg|adapter|usb|ac|plug|online/.test(chargerLower) ||
    (charger && charger !== "0" && /^(1|true|yes|on)$/i.test(charger)) ||
    (chargerCurrent !== null && chargerCurrent > 0);
  const discharging =
    /discharg|unplug|not\s*charg|offline/.test(lower) ||
    raw === "1" ||
    charger === "0" ||
    (outputCurrent !== null && outputCurrent > 0);
  const full =
    /full|charged|complete|finish/.test(lower) ||
    (percent !== null && percent >= 98 && (raw === "3" || hasCharger));
  if (discharging) return "discharging";
  if (full) return "full";
  if (raw === "3" && percent !== null && percent < 98) return "charging";
  if (raw === "2" || hasCharger) return "charging";
  return "unknown";
}
function enumRaw(value, mapping) { const raw=value===undefined||value===null?null:String(value); const label=raw!==null&&mapping&&Object.prototype.hasOwnProperty.call(mapping,raw)?mapping[raw]:null; return {raw,label,confirmed:label!==null}; }
function ratGeneration(label) { const text=String(label||"").toLowerCase(); return /5g|\bnr\b/.test(text)?"5G":/4g|lte/.test(text)?"4G":/3g|wcdma|umts|hspa|hsdpa|hsupa/.test(text)?"3G":/2g|gsm|gprs|edge/.test(text)?"2G":/no service/.test(text)?"No service":"Unknown"; }
function networkProtocol(value, profile, field) {
  const raw=value===undefined||value===null?null:String(value).trim();
  if(!raw)return {protocol:"Unknown",generation:"Unknown",confirmed:false};
  const mapping=profile&&profile.wan&&profile.wan.mappings&&profile.wan.mappings[field];
  if(mapping&&Object.prototype.hasOwnProperty.call(mapping,raw)){const protocol=mapping[raw];return {protocol,generation:ratGeneration(protocol),confirmed:true};}
  // Human-readable RAT names are self-describing; opaque numeric enums are not.
  if(!/^[-+]?\d+$/.test(raw)&&ratGeneration(raw)!=="Unknown"){const generation=ratGeneration(raw);return {protocol:generation==="4G"&&!/4g/i.test(raw)?`4G · ${raw}`:raw,generation,confirmed:true};}
  return {protocol:`Unknown (raw: ${raw})`,generation:"Unknown",confirmed:false};
}
function parseNetwork(xml, profile = ACTIVE_PROFILE) {
  const normalized=xml && typeof xml === "object" && xml.values ? xml : cellularDiagnosticsModule ? cellularDiagnosticsModule.normalize({status1:xml},profile) : null;
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
  return state === "full" ? "Full" : state === "charging" ? "Charging" : state === "discharging" ? "Discharging" : "Unknown";
}
function batteryInlineLabel(battery) {
  const percent = battery && battery.percent !== null && battery.percent !== undefined ? `${battery.percent}%` : "—";
  const status = battery && battery.status ? battery.status : batteryStatusLabel(battery && battery.rawStatus, battery && battery.charging, battery && battery.percent);
  if (status === "Charging") return `🔋 ${percent} ↑ Charging`;
  if (status === "Discharging") return `🔋 ${percent} ↓ Discharging`;
  if (status === "Full") return `🔋 ${percent} Full`;
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
function formatDuration(seconds) { if (seconds === null || seconds === undefined) return ""; const s=Math.max(0, seconds|0), h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h ? `${h}h ${m}m` : `${m}m ${s%60}s`; }

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
  const result=await telnetControlModule.control(telnetApi(auth),ACTIVE_PROFILE,enable,confirmed);
  const firmware=ACTIVE_PROFILE.firmware||ACTIVE_PROFILE.id||"unknown";
  if(result.outcome==="unsupported") return {ok:false,title:"Telnet",message:`Unavailable: no confirmed mapping for firmware ${firmware}`,outcome:result.outcome};
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
  const endpoints = Array.from(new Set(["wan", "Engineer_parameter"].concat((ACTIVE_PROFILE.diagnosticEndpoints || []).filter(name => name !== "status1"))));
  for (const endpoint of endpoints) {
    try {
      const xml = await xmlRequest(auth, "GET", endpoint);
      responses[endpoint] = xml;
      if (endpoint === "Engineer_parameter" && engineerParameterModule) engineerParameterModule.parseEngineerParameter(xml);
    } catch (error) { errors[endpoint] = cleanError(error); }
  }
  responses.__errors = errors;
  const normalized=cellularDiagnosticsModule ? cellularDiagnosticsModule.normalize(responses, ACTIVE_PROFILE) : { values: {}, stages: {}, endpointErrors: errors };
  normalized.loadedAt=Date.now(); normalized.loading=false; return normalized;
}

async function detectCellularControl(auth) {
  return cellularControlModule.detect(cellularControlApi(auth), ACTIVE_PROFILE);
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
const WEB_ACTIONS = new Set(["refresh","refreshSms","sendSms","deleteSms","ussd","detectCapability","detectExperimental","deviceAccess","cellularReconnect","cellularMode","resetTraffic","reboot","powerOff","resumePolling"]);
const DANGEROUS_ACTIONS = new Set(["cellularReconnect","cellularMode","deviceAccess","resetTraffic","reboot","powerOff"]);
function validateWebViewCommand(input) {
  if (!input || typeof input!=="object" || typeof input.id!=="string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(input.id)) throw new Error("Invalid command id");
  if (typeof input.action!=="string" || !WEB_ACTIONS.has(input.action)) throw new Error("Action is not allowed");
  const p=input.params===undefined?{}:input.params;
  if (!p || typeof p!=="object" || Array.isArray(p)) throw new Error("Invalid command parameters");
  const text=(name,max,required=false)=>{if(p[name]===undefined&&!required)return;if(typeof p[name]!=="string"||p[name].length>(max||128)||(required&&!p[name].trim()))throw new Error(`Invalid ${name}`);};
  if(input.action==="sendSms"){text("to",64,true);text("text",1000,true);}
  if(input.action==="deleteSms")text("id",128,true);
  if(input.action==="ussd")text("code",128,true);
  if(input.action==="detectCapability"&&!['ussd','deviceAccess','cellularControl'].includes(p.kind))throw new Error("Invalid capability kind");
  if(input.action==="deviceAccess")text("deviceAction",64,true);
  if(input.action==="cellularMode"&&!['auto','lteOnly','ltePreferred','wcdmaOnly','gsmOnly'].includes(p.mode))throw new Error("Invalid cellular mode");
  if(DANGEROUS_ACTIONS.has(input.action)&&p.confirmed!==true)throw new Error("Explicit confirmation is required");
  return {id:input.id,action:input.action,params:p};
}
function createWebViewDispatcher(handlers, reply) {
  return async input => {
    let command;
    try { command=validateWebViewCommand(input); const handler=handlers[command.action]; if(typeof handler!=="function")throw new Error("Action is unavailable"); const result=await handler(command.params); const response={id:command.id,ok:true,result:result===undefined?null:result}; if(reply)await reply(response); return response; }
    catch(error){const response={id:command&&command.id||input&&typeof input.id==="string"?input.id:"",ok:false,error:cleanError(error)};const diagnostics=sanitizeDiagnostics(error&&error.diagnostics||"");if(diagnostics)response.diagnostics=diagnostics;if(reply)await reply(response);return response;}
  };
}
async function applyWebView(web, method, payload) { await web.evaluateJavaScript(`window.${method} && window.${method}(${JSON.stringify(payload)})`,false); }
async function registerWebViewCommandChannel(web) {
  await web.evaluateJavaScript(`(function(){if(window.__zmiCommandQueue)return true;window.__zmiCommandQueue=[];window.addEventListener('ZMICommand',function(e){window.__zmiCommandQueue.push(e.detail)});return true})()`, false);
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
function createDashboardDispatcher(auth, model, web, guards) {
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
  const handlers={refresh,refreshSms,resumePolling:async()=>({resumed:true}),detectCapability:detect,detectExperimental,
    sendSms:async p=>{const r=parseSendResult(await sendSms(auth,p.to.trim(),p.text));await refreshSms();return r;},
    deleteSms:async p=>{const r=await deleteSms(auth,p.id);if(!r.ok){const error=new Error(r.message||"SMS deletion was not confirmed");error.diagnostics=sanitizeDiagnostics(r.diagnostics||"");throw error;}model.sms=await loadAllSms(auth);if(model.sms.messages.some(message=>String(message.id)===String(p.id))){const error=new Error("The SMS is still present in the updated history.");error.diagnostics=sanitizeDiagnostics(r.diagnostics||"");throw error;}return {...r,id:String(p.id),history:model.sms};},
    ussd:async p=>executeUssd(auth,readCapabilityCache("ussd")||await detectUssdCapability(auth),p.code),
    deviceAccess:async p=>{const detected=readCapabilityCache("deviceAccess");if(!detected)throw new Error("Run Detect first");return executeDeviceAccess(auth,p.deviceAction,p.deviceAction);},
    cellularReconnect:async()=>{const c=readCapabilityCache("cellularControl")||await detectCellularControl(auth);const r=await cellularControlModule.executeReconnect(cellularControlApi(auth),c,ACTIVE_PROFILE);await refresh();return r;},
    cellularMode:async p=>{const c=readCapabilityCache("cellularControl")||await detectCellularControl(auth),m=cellularControlModule.modeById(p.mode,ACTIVE_PROFILE);if(!m)throw new Error("Unknown cellular network mode");const r=await cellularControlModule.executeSetMode(cellularControlApi(auth),c,m.id,ACTIVE_PROFILE);await refresh();return r;},
    resetTraffic:async()=>{const spec=ACTIVE_PROFILE.statisticsReset;if(!spec||!spec.confirmed)throw new Error("Traffic reset is unavailable");const before=wanCounterSnapshot(await xmlRequest(auth,"GET","statistics"));const body=`<RGW><statistics><WanStatistics><set_action>${escapeXml(spec.set_action)}</set_action><clear_cur_stat_flag>${escapeXml(spec.clear_cur_stat_flag)}</clear_cur_stat_flag></WanStatistics></statistics></RGW>`;const r=await writeThenVerify(auth,{model:"statistics",xml:body,verificationModel:"statistics",verify:x=>statisticsResetMatches(before,wanCounterSnapshot(x))});await refresh();return r;},
    reboot:()=>executePowerCommand(auth,"reboot"),powerOff:()=>executePowerCommand(auth,"powerOff")};
  return createWebViewDispatcher(handlers,response=>applyWebView(web,"zmiApplyActionResult",response));
}
async function executePowerCommand(auth,kind){const operation=kind==="reboot"?"reset":"poweroff",spec=ACTIVE_PROFILE.destructive&&ACTIVE_PROFILE.destructive[operation];if(!spec)throw new Error("Power command is unavailable");try{return await writeThenVerify(auth,{model:spec.file,xml:`<RGW><${spec.tree}></${spec.tree}></RGW>`,destructive:true});}catch(error){return{outcome:"submitted",warning:`Connection lost as expected: ${cleanError(error)}`};}}

// WebView rendering
function buildHtml(model) {
  const battery = model.battery || {}; const network = model.network || {}; const traffic = model.traffic || {};
  const updated = new Date(model.loadedAt || Date.now()).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const allMessages = model.sms && model.sms.messages ? model.sms.messages : [];
  const smsCount = allMessages.length;
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
  const statusWarning = warnings.length ? `<div class="warning status-compatibility" data-status-warning><strong>${model.errors.statusRequest ? "Status request error" : "Status compatibility warning"}</strong><p>${warnings.map(escapeHtml).join("<br>")}</p></div>` : "";
  const topCards = `<section class="topgrid router-only">
    <article class="mini mini-signal" data-overview-card="signal"><span>Signal</span><strong data-network-signal>${signalHtml}</strong><small><span data-network-current>${escapeHtml(network.networkError || network.mode || "Unknown")}</span><span data-network-dbm>${network.dbm === null || network.dbm === undefined ? "" : ` · ${escapeHtml(network.dbm)} dBm`}</span></small></article>
    <article class="mini mini-battery" data-overview-card="battery"><span>Battery</span><strong data-battery-percent>${batteryLabel}</strong><small data-battery-inline>${escapeHtml(batteryInline)}</small></article>
    <article class="mini mini-traffic" data-overview-card="traffic"><span>Traffic</span><strong data-traffic-total>${totalTraffic}</strong><small>Downloaded: <span data-traffic-down>${formatBytes(traffic.download)}</span> · Uploaded: <span data-traffic-up>${formatBytes(traffic.upload)}</span></small></article>
  </section>`;
  const smsCards = smsCount ? visibleMessages.map((item, index) => {
    const key = escapeHtml(String(item.id || smsKey(item) || index));
    const translateButton = TRANSLATE_ENDPOINT ? `<button onclick="translateSms(this)">Translate</button>` : "";
    return `<article class="card sms" data-msg-id="${key}" data-msg-text="${escapeHtml(item.content)}" data-msg-sender="${escapeHtml(item.phone)}" data-msg-date="${escapeHtml(item.date)}"><header><div><h3>${escapeHtml(item.phone || "Unknown sender")}</h3><small>SMS #${escapeHtml(item.row || index + 1)}</small></div><time>${escapeHtml(item.date || "Unknown time")}</time></header><p class="body">${escapeHtml(item.content || "")}</p><div class="translation" data-translation><span></span></div><footer><button onclick="copySms(this)">Copy</button>${translateButton}<button class="danger" data-delete-action type="button">Delete</button></footer><div class="warning" data-delete-confirm role="status" aria-live="polite" hidden></div></article>`;
  }).join("") : `<article class="card empty"><h2>No SMS found</h2><p>${escapeHtml(model.errors.sms || "There are no inbox messages.")}</p></article>`;
  const smsLimitWarning = hiddenSmsCount ? `<div class="warning">⚠️ Showing the latest ${visibleMessages.length} SMS out of ${smsCount} to keep the WebView responsive.</div>` : "";
  const codes = [network.lac ? `LAC/TAC ${escapeHtml(network.lac)}` : "", network.cellId ? `Cell ${escapeHtml(network.cellId)}` : "", network.pci ? `PCI ${escapeHtml(network.pci)}` : ""].filter(Boolean).join(" · ");
  const diagnostics = model.cellularDiagnostics || {}; const diagnosticValues = diagnostics.values || {}; const diagnosticStages = diagnostics.stages || {}; const diagnosticsLoading=!diagnostics.loadedAt&&!Object.keys(diagnosticValues).length;
  const diagText = name => { const item=diagnosticValues[name]||{}; return diagnosticsLoading?"Loading diagnostics…":item.value === null || item.value === undefined ? "Not returned by firmware" : String(item.value); };
  const stageRows = [["sim","SIM"],["registration","Registration and roaming"],["pdp","PDP activation"],["ip","IP assignment"],["dns","DNS availability"]].map(([key,label]) => { const item=diagnosticStages[key]||{}; const detail=diagnosticsLoading?"Loading diagnostics…":key==="registration"&&item.roaming&&item.roaming.value?`${item.detail||""} · ${item.roaming.value}`:item.detail||"Not returned by firmware"; const raw=item.raw!==null&&item.raw!==undefined?` (raw: ${item.raw})`:""; return `<li class="diag-stage ${escapeHtml(diagnosticsLoading?"loading":item.state||"unknown")}" data-diag-stage="${key}" data-diag-source=""><strong>${label}</strong>: <span>${escapeHtml(detail+raw)}</span></li>`; }).join("");
  const diagFields=["configuredApn","activeApn","pdpType","ipv4","ipv6","gateway4","gateway6","dns1","dns2","band","pci","earfcn","rsrp","rsrq","sinr"];
  const diagnosticFields=diagFields.map(name=>`<p><span>${escapeHtml(name)}</span><strong data-diag="${name}" data-raw="${escapeHtml((diagnosticValues[name]||{}).raw||"")}" data-source="${escapeHtml((diagnosticValues[name]||{}).source||"")}">${escapeHtml(diagText(name))}</strong></p>`).join("");
  const endpointErrors=Object.entries(diagnostics.endpointErrors||{}).map(([endpoint,error])=>`<p class="diag-endpoint-error" data-diag-endpoint="${escapeHtml(endpoint)}"><strong>${escapeHtml(endpoint)}</strong>: ${escapeHtml(error)}</p>`).join("");
  const diagnosticBlock = `<article class="card cellular-diagnostics"><small>Connection diagnostics</small><h2>${diagnosticsLoading?"Loading diagnostics…":"Connection state"}</h2><ol>${stageRows}</ol><div class="diag-grid">${diagnosticFields}</div><div data-diag-endpoint-errors>${endpointErrors}</div><small data-diag-updated>${diagnostics.loadedAt?`Last successful update ${escapeHtml(new Date(diagnostics.loadedAt).toLocaleTimeString("en-US"))}`:"Waiting for first diagnostic poll"}</small></article>`;
  const capabilityState=value=>value&&value.state?value.state:value&&value.supported===true?"available":value&&value.supported===false?"unavailable":"unchecked";
  const stateLabel=value=>({unchecked:"Not checked",detecting:"Detecting…",available:"Available",unavailable:"Unavailable",error:"Status unavailable"}[capabilityState(value)]||"Status unavailable");
  const deviceActions = (model.deviceAccess.capabilities || []).map(action => {const enabled=capabilityState(model.deviceAccess)==="available"&&action.supported===true;return `<button class="danger buttonlike" type="button" data-device-action="${escapeHtml(action.id)}"${enabled?'':` disabled title="${escapeHtml(model.deviceAccess.detail||'Status unavailable')}"`}>${escapeHtml(action.title)}${enabled?'':' — Status unavailable'}</button>`;}).join(" ");
  const deviceConfirm = "";
  const cellular = model.cellularControl || {};
  const defaultCellularModes = [{ id: "auto", title: "Automatic" }, { id: "lteOnly", title: "4G/LTE only" }, { id: "ltePreferred", title: "LTE preferred" }, { id: "wcdmaOnly", title: "3G only" }, { id: "gsmOnly", title: "2G only" }];
  const activePreferredMode = preferredModeId(network.preferredMode || network.mode || "");
  const cellularModeOptions = (cellular.modes || (cellularControlModule && cellularControlModule.modes ? cellularControlModule.modes(ACTIVE_PROFILE) : defaultCellularModes)).map(mode => `<option value="${escapeHtml(mode.id)}"${mode.id === activePreferredMode ? " selected" : ""}>${escapeHtml(mode.title)}</option>`).join("");
  const controlsDisabled = capabilityState(cellular)!=="available" || cellular.readOnly === true;
  const cellularModeSelect = controlsDisabled || !cellularModeOptions ? `<p>Cellular mode control unavailable: no confirmed firmware mapping.</p>` : `<label class="selectline">Current preferred protocol <select data-cellular-mode-select>${cellularModeOptions}</select></label>`;
  const cellularReconnect = controlsDisabled ? `<button class="danger buttonlike" type="button" disabled>Reconnect unavailable</button>` : `<button class="danger buttonlike" type="button" data-cellular-action="reconnect" >Reconnect cellular network</button>`;
  const resetTrafficConfirm = "";
  const powerConfirmCard = `<div class="warning" data-power-confirm hidden></div>`;
  const activeTab = model.tab === "router" ? "router" : "sms";
  const smsActive = activeTab === "sms" ? " active" : "";
  const routerActive = activeTab === "router" ? " active" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZMI Router</title><style>${css()}</style></head>
  <body><div id="progressbar" class="progressbar" aria-hidden="true"><i></i></div><main><header class="hero compact"><div><h1>MF855 / MF885</h1><strong>SMS: ${smsCount}</strong></div><p class="statusline"><span>📶 ${escapeHtml(network.mode || "Unknown")}</span><span>${escapeHtml(batteryInline)}</span><span>⇅ ${totalTraffic}</span><span data-status-updated>⟳ ${escapeHtml(updated.slice(0,5))}</span></p></header>
  <nav class="seg" role="tablist" aria-label="Dashboard sections"><button role="tab" aria-controls="sms" aria-selected="${activeTab==='sms'}" data-tab-button="sms" class="${smsActive.trim()}" onclick="tab('sms')">SMS</button><button role="tab" aria-controls="router" aria-selected="${activeTab==='router'}" data-tab-button="router" class="${routerActive.trim()}" onclick="tab('router')">Router</button></nav>
  <section class="refresh"><span id="countdown">Next refresh: ${escapeHtml(nextUpdate)}</span><div class="actions"><button id="refreshLink" class="buttonlike" type="button" onclick="refreshNow(event)">Refresh</button><button id="pauseBtn" aria-pressed="false" onclick="togglePause()">Pause</button></div></section>
  <section id="actionStatus" class="action-status warning" hidden><header><strong data-status-title></strong><button type="button" onclick="hideActionStatus()">Close</button></header><p data-status-detail></p><textarea data-status-copy rows="5" readonly></textarea><pre data-status-pre></pre></section>
  <section id="webviewDiagnostics" class="action-status warning" hidden><header><strong>WebView interface error</strong><button type="button" onclick="hideWebviewDiagnostics()">Close</button></header><p>The WebView interface encountered an error. Open the details below or refresh the script.</p><pre data-webview-diagnostics></pre></section>
  ${noticeHtml}
    <section id="sms" class="tab${smsActive}" role="tabpanel"><div class="inline-toolbar"><button aria-expanded="false" aria-controls="smsComposer" onclick="toggleSmsComposer(undefined,this)">📝 Compose SMS</button></div>
    <form id="smsComposer" class="composer card" onsubmit="submitSmsInline(event)" hidden><input name="to" placeholder="Recipient" autocomplete="tel"><textarea name="text" placeholder="SMS text" rows="3" maxlength="1000"></textarea><div><button class="primary" type="submit">Send SMS</button><button type="button" onclick="toggleSmsComposer(false)">Cancel</button></div><p class="formStatus" data-status></p></form>
    ${model.sms.loading ? `<div class="notice" data-history-warning>Loading message history…</div>` : ""}${smsCards}${smsLimitWarning}${model.sms.warning ? `<div class="warning">⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}</section>
    <section id="router" class="tab${routerActive}" role="tabpanel">${statusWarning}<h2 class="section-title">Overview</h2>${topCards}
    <article class="card network"><small>Mobile network</small><h2 data-network-signal>${signalHtml}</h2><div class="quality" data-network-current>${escapeHtml(network.mode || "Unknown")}</div><p>Operator: <strong data-network-operator>${escapeHtml(network.networkError || network.operator || "Unknown operator")}</strong></p><p>Signal: <strong data-network-dbm>${network.dbm === null || network.dbm === undefined ? "Not returned by firmware" : `${escapeHtml(network.dbm)} dBm`}</strong></p><p>Preferred protocol: <strong data-network-preferred>${escapeHtml(network.preferredMode || "Unknown")}</strong></p><p class="codes">LAC/TAC <strong data-network-lac>${escapeHtml(network.lac||"Not returned")}</strong> · Cell <strong data-network-cell>${escapeHtml(network.cellId||"Not returned")}</strong> · PCI <strong data-network-pci>${escapeHtml(network.pci||"Not returned")}</strong></p><p class="codes" data-network-raw>Source: ${escapeHtml(network.networkSource||"none")} · raw: ${escapeHtml(network.rawMode||"none")}</p></article>
    ${diagnosticBlock}
    <article class="card warning" data-cellular-control-section><small>Cellular controls · Experimental</small><h2>Cellular controls</h2><p>${escapeHtml(cellular.detail||'Detection determines whether reconnect and mode selection are safe.')}</p>${cellularReconnect}<h3>Preferred protocol control · Experimental</h3>${cellularModeSelect}<div data-cellular-confirm hidden></div></article>
    <article class="card" data-ussd-section><small>USSD</small><h2>USSD: ${stateLabel(model.ussd)}</h2><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><button type="button" onclick="toggleUssdComposer(true)"${capabilityState(model.ussd)==='available'?'':' disabled title="Status unavailable; retry detection"'}>${capabilityState(model.ussd)==='available'?'Dial USSD':'Dial USSD — Status unavailable'}</button><form id="ussdComposer" class="composer" onsubmit="submitUssdInline(event)" hidden><input name="code" placeholder="Code, for example *100#"><button class="primary" type="submit">Send USSD</button></form></article>
    <article class="card" data-device-access-section><small>Device access · Experimental</small><h2>Device access: ${stateLabel(model.deviceAccess)}</h2><p>${escapeHtml(model.errors.deviceAccess || model.deviceAccess.detail || "")}</p><div class="inline-toolbar">${deviceActions}</div>${deviceConfirm}</article>
    <article class="card experimental" id="routerExperimental"><small>Experimental detection</small><h2>Feature detection</h2><div class="inline-toolbar"><button type="button" data-detect-experimental>Detect experimental features</button><span role="status" aria-live="polite" data-detection-status>Detection has not started</span></div></article>
    <article class="card"><small>System</small><h2>System commands</h2><button class="danger buttonlike" type="button" data-power-action="resetTraffic">Reset traffic</button> <button class="buttonlike" type="button" data-power-action="reboot">Restart</button> <button class="danger buttonlike" type="button" data-power-action="powerOff">Power off</button>${powerConfirmCard}</article></section></main>
  <script>${clientScript(model)}</script></body></html>`;
}

function clientScript(model) {
  return `var model={tab:${JSON.stringify(model.tab)},poll:${POLL_SECONDS},translateEndpoint:${JSON.stringify(TRANSLATE_ENDPOINT)},sms:{fingerprint:${JSON.stringify(model.sms&&model.sms.fingerprint||"")},totalPages:${JSON.stringify(model.sms&&model.sms.totalPages)},totalMessages:${JSON.stringify(model.sms&&model.sms.totalMessages)}}};
var remaining=model.poll,paused=false,timer=null,pending={},pendingKeys={},sequence=0,detectionAttempt=0,detectionStarted=0,detectionCompleted=0,detectionTotal=3,detectionTimer=null,lastDiagnostics={values:{},stages:{},loadedAt:null};
function safeStorageGet(k){try{return localStorage.getItem?localStorage.getItem(k):localStorage[k]}catch(e){return null}}
function safeStorageSet(k,v){try{if(localStorage.setItem)localStorage.setItem(k,v);else localStorage[k]=v}catch(e){}}
function selectedTab(){return safeStorageGet('zmiTab')||model.tab}
function tab(name){name=name==='router'?'router':'sms';var current=document.querySelector('.tab.active');if(current)safeStorageSet('zmiScrollY:'+current.id,String(window.scrollY||0));document.querySelectorAll('.tab').forEach(function(x){var on=x.id===name;x.classList.toggle('active',on);x.hidden=!on});document.querySelectorAll('[data-tab-button]').forEach(function(x){var on=x.getAttribute('data-tab-button')===name;x.classList.toggle('active',on);x.setAttribute('aria-selected',on?'true':'false')});safeStorageSet('zmiTab',name);var saved=safeStorageGet('zmiScrollY:'+name);setTimeout(function(){window.scrollTo(0,saved===null?0:Number(saved)||0)},0)}
function describeError(e){return String(e&&e.message||e||'Unknown error')}
function setActionStatus(text){fillActionStatus('Dashboard',text||'','',false)}
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
window.zmiApplyActionResult=function(payload){var p=payload&&pending[payload.id];if(p){delete pending[payload.id];delete pendingKeys[p.key];var deletion=p.action==='deleteSms',verified=deletion&&payload.ok&&payload.result&&payload.result.id===String(p.params.id)&&payload.result.history&&!smsHistoryContains(payload.result.history,p.params.id);if(payload.ok&&(!deletion||verified)){var destructive=p.action==='reboot'||p.action==='powerOff'||p.action==='cellularReconnect';if(deletion)setDeleteStatus(p,'SMS deleted and verified in the updated history.',false);finishButton(p.button,'success',destructive?'Submitted':p.action==='sendSms'||p.action==='ussd'?'Sent':deletion?'Deleted':p.action==='cellularMode'?'Applied':'Done');p.resolve(payload.result);if(deletion)setTimeout(function(){window.zmiApplySmsHistory(payload.result.history)},0)}else{var message=payload.error||(deletion?'SMS deletion was not confirmed by the updated history.':'Command failed'),error=new Error(message);error.diagnostics=payload.diagnostics||'';finishButton(p.button,'error',deletion?'Retry':'Failed');if(deletion)setDeleteStatus(p,message+(error.diagnostics?'\\n'+error.diagnostics:''),true);p.reject(error)}}if(!payload.ok&&(!p||p.action!=='deleteSms')){stopProgress();showActionError('Command failed',payload.error||'Unknown error','')}};
function renderPolledSms(payload){var messages=payload.messages||payload.smsMessages;if(!Array.isArray(messages))return false;var section=document.getElementById('sms');if(!section)return false;section.querySelectorAll('.sms,.empty,[data-history-warning]').forEach(function(x){x.remove()});if(messages.length===0){var empty=document.createElement('article');empty.className='card empty';var title=document.createElement('h2');title.textContent='No SMS found';var description=document.createElement('p');description.textContent='No inbox messages are available. They may not have arrived yet, or message history could not be loaded.';empty.appendChild(title);empty.appendChild(description);section.appendChild(empty)}messages.slice(0,200).forEach(function(item,index){var card=document.createElement('article');card.className='card sms';card.setAttribute('data-msg-id',item.id||'');card.setAttribute('data-msg-text',item.content||'');card.setAttribute('data-msg-sender',item.phone||'');card.setAttribute('data-msg-date',item.date||'');card.innerHTML='<header><div><h3></h3><small></small></div><time></time></header><p class="body"></p><div class="translation" data-translation><span></span></div><footer><button data-copy>Copy</button><button class="danger" data-delete-action>Delete</button></footer><div class="warning" data-delete-confirm role="status" aria-live="polite" hidden></div>';card.querySelector('h3').textContent=item.phone||'Unknown sender';card.querySelector('small').textContent='SMS #'+(item.row||index+1);card.querySelector('time').textContent=item.date||'Unknown time';card.querySelector('.body').textContent=item.content||'';section.appendChild(card)});return true}
window.zmiApplySmsHistory=function(payload){payload=payload||{};renderPolledSms(payload);model.sms.fingerprint=payload.fingerprint||model.sms.fingerprint;var hero=document.querySelector('.hero strong');if(hero)hero.textContent='SMS: '+((payload.messages||[]).length);var note=document.createElement('div');note.setAttribute('data-history-warning','');note.className=payload.warning?'warning':'notice';note.textContent=payload.loading?'Loading message history…':payload.warning?'⚠️ '+payload.warning:'Message history loaded';var section=document.getElementById('sms');if(section)section.insertBefore(note,section.firstChild)};
function setAll(selector,value){document.querySelectorAll(selector).forEach(function(el){el.textContent=value})}
function diagnosticFailure(error){var x=String(error||'').toLowerCase();return /timeout|timed out/.test(x)?'Timeout':/401|403|auth/.test(x)?'HTTP/authentication error':/http/.test(x)?'HTTP error':/parse|xml/.test(x)?'Parse error':/unsupported|404/.test(x)?'Endpoint not supported':'Endpoint error'}
window.zmiApplyCellularDiagnostics=function(payload){payload=payload||{};var hasSuccess=payload.values&&Object.keys(payload.values).some(function(k){return payload.values[k]&&payload.values[k].value!=null});if(hasSuccess){lastDiagnostics={values:payload.values||{},stages:payload.stages||{},loadedAt:payload.loadedAt||Date.now()}}var values=hasSuccess?payload.values:lastDiagnostics.values||{};document.querySelectorAll('[data-diag]').forEach(function(el){var key=el.getAttribute('data-diag'),item=values[key]||{};if(item.value!=null){el.textContent=item.value;el.dataset.raw=item.raw==null?'':item.raw;el.dataset.source=item.source||'';el.classList.toggle('stale',!hasSuccess)}else if(!lastDiagnostics.loadedAt)el.textContent='Not returned by firmware'});var stages=hasSuccess?payload.stages||{}:lastDiagnostics.stages||{};document.querySelectorAll('[data-diag-stage]').forEach(function(el){var item=stages[el.getAttribute('data-diag-stage')];if(!item)return;el.className='diag-stage '+(item.state||'unknown')+(!hasSuccess&&lastDiagnostics.loadedAt?' stale':'');var span=el.querySelector('span');if(span)span.textContent=(item.detail||'Not returned by firmware')+(item.raw==null?'':' (raw: '+item.raw+')')});var box=document.querySelector('[data-diag-endpoint-errors]');if(box){box.innerHTML='';Object.keys(payload.endpointErrors||{}).forEach(function(endpoint){var p=document.createElement('p');p.className='diag-endpoint-error';p.setAttribute('data-diag-endpoint',endpoint);p.textContent=endpoint+': '+diagnosticFailure(payload.endpointErrors[endpoint])+' — '+payload.endpointErrors[endpoint];box.appendChild(p)})}var updated=document.querySelector('[data-diag-updated]');if(updated&&lastDiagnostics.loadedAt)updated.textContent=(hasSuccess?'Last successful update ':'Stale · last successful update ')+new Date(lastDiagnostics.loadedAt).toLocaleTimeString()};
window.zmiApplyStatus=function(payload){payload=payload||{};remaining=model.poll;drawTimer();var spans=document.querySelectorAll('.statusline span');if(spans[0]&&payload.networkMode)spans[0].textContent='📶 '+payload.networkMode;if(spans[1]&&payload.batteryInline)spans[1].textContent=payload.batteryInline;if(spans[2]&&payload.trafficTotal)spans[2].textContent='⇅ '+payload.trafficTotal;var statusUpdated=document.querySelector('[data-status-updated]');if(statusUpdated&&!payload.errors.status)statusUpdated.textContent='⟳ '+new Date(payload.loadedAt||Date.now()).toLocaleTimeString();setAll('[data-network-current]',payload.networkMode||'Unknown');setAll('[data-network-operator]',payload.operator||'Unknown operator');setAll('[data-network-preferred]',payload.preferredMode||'Unknown');setAll('[data-network-dbm]',payload.dbm==null?'Not returned by firmware':payload.dbm+' dBm');setAll('[data-network-lac]',payload.lac||'Not returned');setAll('[data-network-cell]',payload.cellId||'Not returned');setAll('[data-network-pci]',payload.pci||'Not returned');setAll('[data-network-raw]','Source: '+(payload.networkSource||'none')+' · raw: '+(payload.networkRawCode||'none'));setAll('[data-battery-percent]',payload.batteryPercent==null?'—':payload.batteryPercent+'%');setAll('[data-battery-inline]',payload.batteryInline||'Unknown');setAll('[data-traffic-total]',payload.trafficTotal||'—');setAll('[data-traffic-down]',payload.trafficDown||'—');setAll('[data-traffic-up]',payload.trafficUp||'—');if(payload.cellularDiagnostics)window.zmiApplyCellularDiagnostics(payload.cellularDiagnostics);if(payload.smsMessages)window.zmiApplySmsHistory({messages:payload.smsMessages,fingerprint:payload.smsFingerprint,totalMessages:payload.smsTotalMessages});stopProgress()};
window.zmiApplyCapability=function(payload){if(payload.progress){detectionCompleted=payload.progress.completed;detectionTotal=payload.progress.total;drawDetectionProgress()}var value=payload.value||{},state=value.state||(value.supported===true?'available':value.supported===false?'unavailable':'unchecked'),label={unchecked:'Not checked',detecting:'Detecting…',available:'Available',unavailable:'Unavailable',error:'Status unavailable'}[state]||'Status unavailable',section=document.querySelector('[data-'+(payload.kind==='deviceAccess'?'device-access':payload.kind==='cellularControl'?'cellular-control':'ussd')+'-section]');if(section){var h=section.querySelector('h3'),p=section.querySelector('p');if(h)h.textContent=(payload.kind==='ussd'?'USSD':payload.kind==='deviceAccess'?'Device access':'Cellular control')+': '+label;if(p)p.textContent=value.detail||'';if(payload.kind==='deviceAccess')section.querySelectorAll('[data-device-action]').forEach(function(b){var item=(value.capabilities||[]).find(function(x){return x.id===b.getAttribute('data-device-action')}),enabled=state==='available'&&item&&item.supported===true;b.disabled=!enabled;b.title=enabled?'':value.detail||'Status unavailable; retry detection'});if(payload.kind==='ussd'){var dial=section.querySelector('[onclick*="toggleUssdComposer"]');if(dial){dial.disabled=state!=='available';dial.textContent=state==='available'?'Dial USSD':'Dial USSD — Status unavailable'}}}};
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
function showInlineConfirm(button){var action=button.getAttribute('data-power-action');makeConfirm(button.closest('.card'),powerActionCopy(action),action,{},'data-power-confirm',button)}
function showCellularConfirm(el){var mode=el.getAttribute('data-cellular-mode-select')!==null?el.value:'',action=mode?'cellularMode':'cellularReconnect',copy=cellularActionCopy(mode?'mode':'reconnect',mode);makeConfirm(el.closest('.card'),copy,action,mode?{mode:mode}:{},'data-cellular-confirm')}
function showDeviceConfirm(button){makeConfirm(button.closest('.card'),{title:'Run this device-access action?',detail:'The action can change router services.'},'deviceAccess',{deviceAction:button.getAttribute('data-device-action')},'data-device-confirm')}
function confirmSmsDelete(card,item){var box=card.querySelector('[data-delete-confirm]');box.hidden=false;box.classList.remove('error');box.setAttribute('role','status');box.setAttribute('aria-live','polite');box.innerHTML='';var prompt=document.createElement('p');prompt.textContent='Delete this SMS? '+String(item.content||'').slice(0,80);var yes=document.createElement('button');yes.className='danger';yes.textContent='Confirm';yes.onclick=function(){box.setAttribute('aria-busy','true');bridge('deleteSms',{id:String(item.id||'')},yes).catch(function(){}).finally(function(){box.setAttribute('aria-busy','false')})};var no=document.createElement('button');no.textContent='Cancel';no.onclick=function(){box.hidden=true};box.appendChild(prompt);box.appendChild(yes);box.appendChild(no)}
function detectionElapsed(){return Math.max(0,Math.floor((Date.now()-detectionStarted)/1000))}
function formatDetectionElapsed(seconds){var m=Math.floor(seconds/60),s=seconds%60;return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0')}
function drawDetectionProgress(){var status=document.querySelector('[data-detection-status]');if(status)status.textContent='Attempt '+detectionAttempt+' · '+formatDetectionElapsed(detectionElapsed())+' · '+detectionCompleted+'/'+detectionTotal+' checks'}
function detectExperimental(button){button=button||document.querySelector('[data-detect-experimental]');if(!button)return Promise.resolve();detectionAttempt++;detectionStarted=Date.now();detectionCompleted=0;detectionTotal=3;drawDetectionProgress();if(detectionTimer)clearInterval(detectionTimer);detectionTimer=setInterval(drawDetectionProgress,1000);return bridge('detectExperimental',{},button).then(function(r){var failed=r&&r.failed||[],elapsed=detectionElapsed(),status=document.querySelector('[data-detection-status]');detectionCompleted=r&&r.completed==null?detectionTotal:r.completed;if(status)status.textContent='Attempt '+detectionAttempt+(failed.length?(detectionCompleted?' partially completed in ':' failed after '):' completed in ')+formatDetectionElapsed(elapsed)+' · '+detectionCompleted+'/'+detectionTotal+' checks'}).catch(function(e){var status=document.querySelector('[data-detection-status]');if(status)status.textContent='Attempt '+detectionAttempt+' failed after '+formatDetectionElapsed(detectionElapsed())+' · '+detectionCompleted+'/'+detectionTotal+' checks';button.dataset.originalLabel='Retry experimental detection';showActionError('Detection failed',describeError(e),'')}).finally(function(){if(detectionTimer){clearInterval(detectionTimer);detectionTimer=null}})}
function initDashboard(){paused=safeStorageGet('zmiPaused')==='1';tab(selectedTab());var draft=safeStorageGet('zmiSmsDraft'),form=document.getElementById('smsComposer');if(form&&draft)form.elements.text.value=draft;if(form)form.elements.text.addEventListener('input',function(){safeStorageSet('zmiSmsDraft',this.value)});window.addEventListener('scroll',function(){var active=document.querySelector('.tab.active');if(active)safeStorageSet('zmiScrollY:'+active.id,String(window.scrollY||0))});timer=setInterval(tick,1000);drawTimer();setTimeout(function(){detectExperimental()},0);document.addEventListener('change',function(e){if(e.target.matches&&e.target.matches('[data-cellular-mode-select]'))showCellularConfirm(e.target)});document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-delete-action],[data-power-action],[data-cellular-action],[data-device-action],[data-detect-experimental]');if(!b)return;if(b.hasAttribute('data-delete-action')){var c=b.closest('.sms');confirmSmsDelete(c,{id:c.getAttribute('data-msg-id'),content:c.getAttribute('data-msg-text')})}else if(b.hasAttribute('data-power-action'))showInlineConfirm(b);else if(b.hasAttribute('data-cellular-action'))showCellularConfirm(b);else if(b.hasAttribute('data-device-action'))showDeviceConfirm(b);else detectExperimental(b)})}
var dashboardReady=false;
function markDashboardReady(){if(dashboardReady)return;dashboardReady=true;document.documentElement.dataset.zmiReady='true';initDashboard()}
if(document.readyState==='interactive'||document.readyState==='complete')markDashboardReady();else document.addEventListener('DOMContentLoaded',markDashboardReady,{once:true});
async function copySms(button){var card=button&&button.closest('.sms'),body=card&&card.querySelector('.body'),value=body?body.innerText:'',original=button&&button.textContent||'Copy';if(!navigator.clipboard||!navigator.clipboard.writeText){showActionError('Copy SMS manually','Clipboard is unavailable in this WebView.',value);return}button.disabled=true;try{await navigator.clipboard.writeText(value);button.textContent='Copied';button.setAttribute('aria-label','SMS copied');button.setAttribute('role','status');setActionStatus('SMS copied to clipboard');setTimeout(function(){button.textContent=original;button.removeAttribute('aria-label');button.removeAttribute('role');button.disabled=false},1500)}catch(e){showActionError('Could not copy SMS',describeError(e),value);button.disabled=false}}
async function translateSms(button){var card=button&&button.closest('.sms'),box=card&&card.querySelector('[data-translation] span'),text=card?card.getAttribute('data-msg-text')||'':'';if(!box||!model.translateEndpoint)return;var key='zmiTr:'+card.getAttribute('data-msg-id')+':'+text,cached=safeStorageGet(key);if(cached){box.textContent=cached;return}button.disabled=true;try{var res=await fetch(model.translateEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'en',format:'text'})}),raw=await res.text(),data=JSON.parse(raw),tr=data.translatedText||data.translation||'';if(!res.ok||!tr)throw new Error('HTTP '+res.status+'\\nResponse: '+raw);safeStorageSet(key,tr);box.textContent=tr}catch(e){showActionError('Could not prepare translation',describeError(e),text)}finally{button.disabled=false}}
`;
}
function css() { return `:root{color-scheme:dark;--bg:#0b1020;--panel:#111827;--panel2:#172033;--text:#f8fafc;--muted:#a8b3c7;--line:#253044;--cyan:#67e8f9;--blue:#60a5fa;--purple:#a78bfa;--bad:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#101827 0%,var(--bg) 45%,#070b13 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:env(safe-area-inset-top) 10px 30px}main{max-width:720px;margin:auto}.hero{padding:12px 4px 6px}.hero.compact{display:block}.hero h1{font-size:26px;line-height:1;margin:0 0 4px}.hero strong{color:var(--cyan)}.statusline{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0;color:var(--muted);font-size:14px}.statusline span{border:1px solid var(--line);border-radius:999px;padding:5px 8px;background:#0d1424}.hero>small,.card small,.mini > span{color:var(--cyan);font-weight:800;letter-spacing:.1em;font-size:10px;text-transform:uppercase}.card p,.mini small{color:var(--muted)}.topgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.mini,.card,.notice,.warning{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,var(--panel2),var(--panel));box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.mini{min-height:86px;position:relative}.mini:after{display:none}.mini strong{display:block;font-size:21px;margin:8px 0 3px}.seg{display:flex;background:#080d18;border:1px solid var(--line);border-radius:14px;padding:4px;margin:8px 0}.seg button{flex:1}.seg button.active,.primary{background:#dff8ff;color:#03111d;border-color:transparent;font-weight:800}button,a,.buttonlike{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:8px 11px;background:#182235;color:var(--text);text-decoration:none;font:inherit}button{transition:transform .12s ease,background-color .16s ease,border-color .16s ease}button:active,a:active{transform:scale(.94);filter:brightness(1.25)}button[data-state="pending"]{border-color:var(--cyan);background:#123044;cursor:progress}button[data-state="pending"]:before{content:'◌';display:inline-block;margin-right:5px;animation:spin .7s linear infinite}button[data-state="success"]{border-color:var(--good);background:#12352d}button[data-state="error"]{border-color:var(--bad);background:#401824}button:disabled,button[data-state="disabled"]{opacity:.48;cursor:not-allowed;filter:saturate(.4)}button[aria-pressed="true"],button.active{outline:2px solid var(--cyan);outline-offset:1px}.danger{color:var(--bad)}.refresh{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0 10px;color:var(--muted);font-size:14px}.actions,.inline-toolbar{display:flex;gap:8px;flex-wrap:wrap}.inline-toolbar{margin:8px 0}.tab{display:none}.tab.active{display:block}.card{margin:8px 0}.card h2{font-size:24px;margin:6px 0}.composer input,.composer textarea,.selectline select{width:100%;margin:0 0 8px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.formStatus{margin:8px 0 0;color:#fbbf24}.selectline{display:block;color:var(--muted);margin:8px 0}.selectline select{display:block;margin-top:6px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.sms{padding:11px;margin:8px 0}.sms header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;border-bottom:1px solid #253044aa;padding-bottom:7px}.sms h3{margin:0 0 2px;font-size:15px}.sms time,.sms footer{color:var(--muted);font-size:12px}.sms footer{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #253044aa;padding-top:8px}.sms footer button,.sms footer a{padding:6px 9px;border-radius:10px}.sms .body{white-space:pre-wrap;word-break:break-word;font-size:17px;line-height:1.45;color:#f8fafc;margin:10px 0}.translation{color:var(--muted);font-size:14px}.translation span:empty{display:none}.cellular-diagnostics ol{padding-left:22px}.diag-stage{margin:7px 0}.diag-stage.ok{color:var(--good)}.diag-stage.pending{color:#fbbf24}.diag-stage.failed{color:var(--bad)}.diag-stage.unknown{color:var(--muted)}.diag-grid{border-top:1px solid var(--line);margin-top:10px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.diag-grid p{min-width:0;overflow-wrap:anywhere;margin:7px 0}.diag-grid p span{display:block;color:var(--muted);font-size:11px}.stale{opacity:.7}.diag-endpoint-error{color:var(--bad);overflow-wrap:anywhere}.section-title{font-size:14px;color:var(--cyan);margin:16px 4px 4px}.active-apn{color:var(--cyan)}.quality{display:inline-block;padding:6px 10px;border-radius:999px;background:#34d39922;color:var(--good)}.codes{font-family:ui-monospace,Menlo,monospace}.bar{height:10px;background:#ffffff14;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue),var(--cyan));border-radius:inherit}.progressbar{position:fixed;left:0;right:0;top:0;height:3px;z-index:1000;background:transparent;overflow:hidden}.progressbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--blue));box-shadow:0 0 16px var(--cyan)}.progressbar.active i{animation:progressStart 1.2s ease-in-out infinite}@keyframes spin{to{transform:rotate(360deg)}}@keyframes progressStart{0%{width:0;transform:translateX(0)}55%{width:72%;transform:translateX(12%)}100%{width:40%;transform:translateX(160%)}}.notice{color:var(--good);margin:8px 0}.notice.warning{color:#fbbf24;border-color:#fbbf2466;background:linear-gradient(180deg,#3b2f14,#1f1a0f)}.notice.error{color:var(--bad);border-color:#fb718566;background:linear-gradient(180deg,#3b1720,#1f0f14)}.warning{color:#fbbf24}.signal-bars{display:inline-flex;gap:3px;align-items:flex-end;height:22px;vertical-align:middle}.signal-bars i{display:block;width:5px;border-radius:3px;background:#ffffff30}.signal-bars i:nth-child(1){height:6px}.signal-bars i:nth-child(2){height:9px}.signal-bars i:nth-child(3){height:12px}.signal-bars i:nth-child(4){height:16px}.signal-bars i:nth-child(5){height:20px}.signal-bars i.on{background:var(--cyan)}.action-status{margin:8px 0;border:1px solid #fbbf2466;border-radius:18px;background:linear-gradient(180deg,#3b2f14,#1f1a0f);box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.action-status header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.action-status p{white-space:pre-wrap;color:#fde68a;margin:8px 0}.action-status textarea,.action-status pre{width:100%;max-width:100%;min-height:96px;margin:8px 0 0;padding:10px;border-radius:12px;border:1px solid #fbbf2466;background:#0b1220;color:#f8fafc;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto;user-select:text;-webkit-user-select:text}.action-status textarea[hidden],.action-status pre[hidden]{display:none}.empty{text-align:center}@media(prefers-reduced-motion:reduce){button{transition:none}.progressbar.active i,button[data-state="pending"]:before{animation:none}}@media(max-width:520px){.topgrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.topgrid .mini-traffic{grid-column:1 / -1}.diag-grid{grid-template-columns:1fr}.card,.mini{max-width:100%}.codes{overflow-wrap:anywhere}.refresh{align-items:flex-start}.actions{justify-content:flex-end}}@media(max-width:340px){.topgrid{grid-template-columns:1fr}.topgrid .mini-traffic{grid-column:auto}}`; }
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
