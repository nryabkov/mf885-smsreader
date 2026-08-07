// ZMI MF855/MF885 dashboard: all SMS, new-message polling, network, battery,
// traffic, power controls, and experimental USSD support.
// Scriptable for iPhone

let ROUTER_HOST = "192.168.21.1";
const USERNAME = "admin";
let PASSWORD = "zimifi";
let ussdModule = null;
let deviceAccessModule = null;
let cellularControlModule = null;
let apiContractModule = null;
let compatibilityModule = null;
let ACTIVE_PROFILE = { id: "unknown", confirmed: false };

const XML_API_PATH = "/cgi/xml_action.cgi";

let POLL_SECONDS = 30;
const SMS_PAGE_SIZE = 10;
const SMS_MAX_PAGES = 500;
const USSD_RESPONSE_POLLS = 8;
const DEBUG = false;
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
  if (options.ip) ROUTER_HOST = String(options.ip);
  if (options.password) PASSWORD = String(options.password);
  POLL_SECONDS = Math.max(15, Math.min(300, Number(options.pollSeconds) || 30));
  if (!options.moduleDirectory) {
    throw new Error("The application module directory was not provided by the loader.");
  }
  ussdModule = importModule(`${options.moduleDirectory}/modules/ussd.js`);
  deviceAccessModule = importModule(`${options.moduleDirectory}/modules/device-access.js`);
  cellularControlModule = importModule(`${options.moduleDirectory}/modules/cellular-control.js`);
  apiContractModule = importModule(`${options.moduleDirectory}/modules/api-contract.js`);
  compatibilityModule = importModule(`${options.moduleDirectory}/modules/compatibility-profiles.js`);
  ACTIVE_PROFILE = compatibilityModule.selectProfile(options.compatibilityProfile);
  await main();
}

module.exports = { run, XML_API_PATH, xmlRequestUrl, parseDigestChallenge, authorization, authenticatedRequest, buildHtml, clientScript, parseCounter, formatBytes, parseBattery, parseNetwork, parseTraffic, parseSmsPage, loadAllSms, inspectSmsEdges, smsEdgeFingerprint, pageMessageFingerprint, unchangedSms, batteryInlineLabel, networkModeLabel, signalBarsHtml, sanitizeDiagnostics, smsSegments, webPollPayload };

async function main() {
  try {
    const auth = await getAuthChallenge();
    await login(auth);
    if (ACTION === "send") return await sendFlow(auth);
    if (ACTION === "delete") return await deleteFlow(auth);
    if (ACTION === "ussd") return await ussdFlow(auth);
    if (ACTION === "deviceAccess") return await deviceAccessFlow(auth);
    if (ACTION === "cellularReconnect") return await cellularReconnectFlow(auth);
    if (ACTION === "cellularMode") return await cellularModeFlow(auth);
    if (ACTION === "resetTraffic") return await resetTrafficFlow(auth);
    if (ACTION === "reboot" || ACTION === "powerOff") return await powerFlow(auth, ACTION);
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

async function dashboardFlow(auth, notice = "", tab = "sms") {
  const model = await loadModel(auth);
  model.notice = normalizeNotice(notice);
  model.tab = tab;
  const web = new WebView();
  await web.loadHTML(buildHtml(model));
  let pollTimer = null;
  let pollInFlight = false;
  async function pollWebView() {
    if (pollInFlight) return;
    pollInFlight = true;
    try {
      await web.evaluateJavaScript("window.zmiTick && window.zmiTick()", false);
      const fresh = await loadPollingSnapshot(auth, model.sms);
      fresh.loadedAt = Date.now();
      await web.evaluateJavaScript(`window.zmiApply && window.zmiApply(${JSON.stringify(webPollPayload(fresh))})`, false);
    } catch (error) {
      try {
        await web.evaluateJavaScript(`window.zmiApply && window.zmiApply(${JSON.stringify({ error: cleanError(error), loadedAt: Date.now() })})`, false);
      } catch (_) {}
    } finally {
      pollInFlight = false;
      if (pollTimer) pollTimer.invalidate();
      pollTimer = Timer.schedule(POLL_SECONDS * 1000, false, pollWebView);
    }
  }
  pollTimer = Timer.schedule(POLL_SECONDS * 1000, false, pollWebView);
  await web.present();
  if (pollTimer) pollTimer.invalidate();
}

async function loadPollingSnapshot(auth, currentSms) {
  const model={sms:currentSms||emptySms(),traffic:{},battery:{},network:{},errors:{},loadedAt:Date.now()};
  try { const status=await getStatus(auth); model.traffic=parseTraffic(status); model.battery=parseBattery(status); model.network=parseNetwork(status); }
  catch(error){ model.errors.status=cleanError(error); return model; }
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
    batteryInline: batteryInlineLabel(model.battery || {}),
    batteryStatus: model.battery && model.battery.status || "Unknown",
    batteryPercent: model.battery && model.battery.percent,
    operator: model.network && model.network.operator || "",
    roaming: model.network && model.network.fields && model.network.fields.roaming || null,
    signalRaw: model.network && model.network.signalRaw || null,
    trafficTotal: formatBytes(model.traffic && model.traffic.total),
    trafficDown: formatBytes(model.traffic && model.traffic.download),
    trafficUp: formatBytes(model.traffic && model.traffic.upload),
    errors: model.errors || {}
  };
}

async function loadModel(auth) {
  const model = {
    sms: emptySms(), traffic: {}, battery: {}, network: {}, ussd: {}, deviceAccess: {}, cellularControl: {},
    errors: {}, notice: "", tab: "sms", loadedAt: Date.now()
  };
  try {
    const status = await getStatus(auth);
    model.traffic = sectionWithError(parseTraffic(status), "trafficError", "status1 has no WanStatistics data");
    model.battery = sectionWithError(parseBattery(status), "batteryError", "status1 has no batteryinfo data");
    model.network = sectionWithError(parseNetwork(status), "networkError", "status1 has no cellular network data");
  } catch (error) {
    model.errors.status = cleanError(error);
  }
  try { model.sms = await loadAllSms(auth); }
  catch (error) { model.errors.smsError = cleanError(error); model.errors.sms = model.errors.smsError; }
  try { model.ussd = await detectUssdCapability(auth); }
  catch (error) { model.errors.ussdError = cleanError(error); model.errors.ussd = model.errors.ussdError; }
  try { model.deviceAccess = await detectDeviceAccess(auth); }
  catch (error) { model.errors.deviceAccess = cleanError(error); }
  try { model.cellularControl = await detectCellularControl(auth); }
  catch (error) { model.errors.cellularControl = cleanError(error); }
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
  if (!confirm) return dashboardFlow(auth, warningNotice(`Confirm the experimental action: ${action.title}. This action will reopen the script.`), "router");

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
  try { await req.loadString(); } catch (_) {}
  const headers = req.response ? req.response.headers : {};
  const challengeKey = Object.keys(headers).find(key => key.toLowerCase() === "www-authenticate");
  const challenge = challengeKey ? headers[challengeKey] : undefined;
  if (!challenge) throw new Error("No authentication challenge. Check the ZMI Wi-Fi connection and router address.");
  const auth = parseDigestChallenge(challenge);
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
  await req.loadString();
  auth.nc++;
}

function authorization(auth, method) {
  const nc = Number(auth.nc).toString(16).padStart(8, "0");
  const cnonce = randomCnonce();
  const response = md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`${method}:${XML_API_PATH}`)}`);
  return digestAuthorization(auth, method, XML_API_PATH, nc, cnonce, response);
}
function digestAuthorization(auth, method, path, nc, cnonce, response) { const opaque=auth.opaque?`, opaque="${auth.opaque}"`:""; return `Digest username="${USERNAME}", realm="${auth.realm}", nonce="${auth.nonce}", uri="${path}", response="${response}", qop=${auth.qop}, nc=${nc}, cnonce="${cnonce}"${opaque}`; }

function xmlRequestUrl(host, method, file, command) {
  const query = [`method=${method === "GET" ? "get" : "set"}`, "module=duster", `file=${encodeURIComponent(file)}`];
  if (command !== undefined && command !== null) query.push(`command=${encodeURIComponent(command)}`);
  return `http://${host}${XML_API_PATH}?${query.join("&")}`;
}

async function xmlRequest(auth, method, file, body = null, retry = true, timeout = 15) {
  const operation = method === "GET" ? "get" : "set";
  const text = await authenticatedRequest(auth, () => {
    const req = new Request(xmlRequestUrl(ROUTER_HOST, method, file));
    req.method = method;
    req.headers = requestHeaders(auth, method);
    req.timeoutInterval = timeout;
    if (body !== null) req.body = body;
    return req;
  }, file, retry);
  if (DEBUG) console.log(text);
  return text;
}

async function routerCall(auth, path, method) {
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><param><method>call</method><session>000</session><obj_path>${escapeXml(path)}</obj_path><obj_method>${escapeXml(method)}</obj_method></param></RGW>`;
  return authenticatedRequest(auth, () => {
    const req = new Request(xmlRequestUrl(ROUTER_HOST, "POST", path, method));
    req.method = "POST"; req.headers = requestHeaders(auth, "POST"); req.body = xml;
    return req;
  }, method);
}

async function loadResponse(req) {
  let text = "";
  let exception = null;
  try { text = await req.loadString(); }
  catch (error) { exception = error; }
  return { text, exception, response: req.response };
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
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await loadResponse(makeRequest());
    auth.nc++;
    const statusCode = result.response && Number(result.response.statusCode);
    const authenticationFailed = statusCode === 401 || unauthorized(result.text);
    if (authenticationFailed) {
      if (attempt + 1 < attempts) {
        const fresh = await getAuthChallenge();
        await login(fresh);
        Object.assign(auth, fresh);
        continue;
      }
      throw new Error(`Authorization failed for ${operation}`);
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
      const status = firstText(response, ["sms_cmd_status_result", "delete_status", "status", "result"]);
      if (!routerAccepted(response)) { rejected = true; continue; }
      await sleep(500);
      let current;
      try { current = await loadAllSms(auth); }
      catch (verifyError) { lostConnection = true; diagnostics.push(cleanError(verifyError)); continue; }
      if (!current.messages.some(message => String(message.id) === String(id))) return { ok: true, message: "The SMS was removed from the router." };
      stillPresent = true;
      diagnostics.push("The message was still present after the command.");
      if (status === "3") rejected = true;
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
  const text = String(xml || "").toLowerCase();
  return Boolean(text) &&
    !/unauthorized|error|fail|invalid|denied|not.?support/.test(text) &&
    (text.includes("<rgw") || text.includes("success") ||
      text.includes("<result>0</result>") || text.includes("<status>0</status>"));
}

// SMS pagination and parsing
function emptySms() { return { messages: [], loadedPages: 0, totalPages: null, totalMessages: null, hasMore: false, fingerprint: "", warning: "" }; }
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
  const chargerCurrent = firstNumber(source, ["Charger_current", "charger_current"]);
  const outputCurrent = firstNumber(source, ["Output_current", "output_current"]);
  const status = batteryStatus ? `Unknown (raw: ${batteryStatus})` : "Unknown";
  return { hasData: percentRaw !== "" || !!batteryStatus || !!chargerStatus || chargerCurrent !== null || outputCurrent !== null, percent, percentRaw, percentValid: percent !== null, charging:null, state:"unknown", status, detailText:status, chargerCurrent, outputCurrent, rawStatus:batteryStatus || "", chargerStatus:chargerStatus || "", rawChargerStatus:chargerStatus || "", rawOutputCurrent:firstText(source,["Output_current"]) };
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
function parseNetwork(xml, profile = ACTIVE_PROFILE) {
  const wan=tag(xml,"wan")||xml, cellular=tag(wan,"cellular")||wan, source=[wan,cellular,xml].join("\n");
  const names=["connect_disconnect","NW_register_status","ConnType","proto","sys_mode","sys_submode","connect_mode","LWG_flag","roaming"];
  const raw={}; for(const name of names) raw[name]=firstText(source,[name])||null;
  const mappings=profile&&profile.wan&&profile.wan.mappings||{}; const fields={}; for(const name of names) fields[name]=enumRaw(raw[name],mappings[name]);
  const rawRssi=firstText(cellular,["rssi"]); const operator=firstText(source,["network_name","ISP_name","home_operator","roaming_operator"]);
  const rawMode=raw.sys_submode||raw.sys_mode||raw.ConnType||raw.proto;
  const mapped=rawMode!==null&&((mappings.sys_submode||{})[rawMode]||(mappings.sys_mode||{})[rawMode]||(mappings.ConnType||{})[rawMode]||(mappings.proto||{})[rawMode]);
  const mode=mapped|| (rawMode!==null?`Unknown (raw: ${rawMode})`:"Unknown");
  return { hasData:Object.values(raw).some(v=>v!==null)||!!operator||rawRssi!=="", raw, fields, operator, mode, protocol:mode, rawMode,
    registered:fields.NW_register_status.confirmed?fields.NW_register_status.label:null, roaming:fields.roaming.confirmed?fields.roaming.label:null,
    rssi:{raw:rawRssi||null,label:null,confirmed:false}, signalRaw:rawRssi||null, bars:null, dbm:null, percent:null, signalText:rawRssi?`Vendor raw: ${rawRssi}`:"Unavailable",
    imei:firstText(source,["IMEI","imei"])||null, simStatus:enumRaw(firstText(source,["SIM_status","sim_status"]),mappings.SIM_status), pinStatus:enumRaw(firstText(source,["PIN_status","pin_status"]),mappings.PIN_status),
    pinAttempts:firstText(source,["PIN_attempts","pin_attempts"])||null, pukAttempts:firstText(source,["PUK_attempts","puk_attempts"])||null,
    pdp:{context:firstText(source,["pdp_context","PDP_context"])||null,automatic:firstText(source,["automatic_pdp_list","auto_pdp_list"])||null} };
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
const NETWORK_SUBMODES = { 1:["2G · GSM","2G"], 2:["2G · GPRS","2G"], 3:["2G · EDGE","2G"], 4:["3G · WCDMA","3G"], 5:["3G · HSDPA","3G"], 6:["3G · HSUPA","3G"], 7:["3G · HSPA","3G"], 8:["3G · TD-SCDMA","3G"], 9:["3G · HSPA+","3G"], 17:["3G · HSPA+ 64QAM","3G"], 18:["3G · HSPA+ MIMO","3G"], 25:["4G · LTE TDD","4G"], 26:["4G · LTE FDD","4G"] };
const NETWORK_MODES = { 3:["2G · GSM/GPRS","2G"], 4:["3G · WCDMA","3G"], 5:["3G · TD-SCDMA","3G"], 6:["4G · LTE","4G"], 15:["3G · TD-SCDMA","3G"], 16:["4G · LTE FDD","4G"], 17:["4G · LTE","4G"] };
function networkProtocol(value, mode, submode) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (mode === 0 || submode === 0 || /unknown|none|no service|limited/.test(lower)) return { protocol: mode === 0 || submode === 0 ? "No service" : "Unknown", generation: "Unknown" };
  if (/5g|nr/.test(lower)) return { protocol: "5G", generation: "5G" };
  if (/lte|4g/.test(lower)) { var lte = /fdd/.test(lower) ? "LTE FDD" : /tdd/.test(lower) ? "LTE TDD" : /lte-?a|advanced/.test(lower) ? "LTE-A" : "LTE"; return { protocol: "4G · "+lte, generation: "4G" }; }
  if (/hspa|hsdpa|hsupa|wcdma|umts|3g/.test(lower)) { var g3 = /hspa\+.*64qam|64qam.*hspa\+/.test(lower) ? "HSPA+ 64QAM" : /hspa\+/.test(lower) ? "HSPA+" : /hsdpa/.test(lower) ? "HSDPA" : /hsupa/.test(lower) ? "HSUPA" : /hspa/.test(lower) ? "HSPA" : /umts/.test(lower) ? "UMTS" : /wcdma/.test(lower) ? "WCDMA" : "3G"; return { protocol: g3 === "3G" ? "3G" : "3G · "+g3, generation: "3G" }; }
  if (/edge|gprs|gsm|2g/.test(lower)) { var g2 = /edge/.test(lower) ? "EDGE" : /gprs/.test(lower) ? "GPRS" : /gsm/.test(lower) ? "GSM" : "2G"; return { protocol: g2 === "2G" ? "2G" : "2G · "+g2, generation: "2G" }; }
  if (submode !== null && NETWORK_SUBMODES[submode]) return { protocol: NETWORK_SUBMODES[submode][0], generation: NETWORK_SUBMODES[submode][1] };
  if (mode !== null && NETWORK_MODES[mode]) return { protocol: NETWORK_MODES[mode][0], generation: NETWORK_MODES[mode][1] };
  const code = /^\d+$/.test(text) ? Number(text) : null;
  if ([20,21,101].includes(code)) return { protocol: "5G", generation: "5G" };
  if ([4,7,13,14,19,38,39,40,41].includes(code)) return { protocol: "4G · LTE", generation: "4G" };
  if ([2,3,5,6,8,9,10,11,12,15].includes(code)) return { protocol: "3G", generation: "3G" };
  if ([1,16].includes(code)) return { protocol: "2G", generation: "2G" };
  return { protocol: text || "Unknown", generation: "Unknown" };
}
function networkModeLabel(value) { return networkProtocol(value, null, null).protocol; }
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
  return deviceAccessModule.execute(deviceAccessApi(auth), capability, action);
}
function deviceAccessApi(auth) {
  return {
    xmlRequest: (method, file, body, retry, timeout) =>
      xmlRequest(auth, method, file, body, retry, timeout),
    routerCall: (path, method) => routerCall(auth, path, method),
    cleanError,
    escapeXml
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
  const topCards = `<section class="topgrid router-only">
    <article class="mini"><span>Signal</span><strong>${signalHtml}</strong><small>${escapeHtml(network.networkError || network.mode || "Unknown")}${network.dbm === null || network.dbm === undefined ? "" : ` · ${escapeHtml(network.dbm)} dBm`}</small></article>
    <article class="mini"><span>Battery</span><strong>${batteryLabel}</strong><small>${escapeHtml(batteryInline)}</small></article>
    <article class="mini"><span>Traffic</span><strong>${totalTraffic}</strong><small>Downloaded: ${formatBytes(traffic.download)} · Uploaded: ${formatBytes(traffic.upload)}</small></article>
  </section>`;
  const smsCards = smsCount ? visibleMessages.map((item, index) => {
    const key = escapeHtml(String(item.id || smsKey(item) || index));
    const translateButton = TRANSLATE_ENDPOINT ? `<button onclick="translateSms(this)">Translate</button>` : "";
    return `<article class="card sms" data-msg-id="${key}" data-msg-text="${escapeHtml(item.content)}" data-msg-sender="${escapeHtml(item.phone)}" data-msg-date="${escapeHtml(item.date)}"><header><div><h3>${escapeHtml(item.phone || "Unknown sender")}</h3><small>SMS #${escapeHtml(item.row || index + 1)}</small></div><time>${escapeHtml(item.date || "Unknown time")}</time></header><p class="body">${escapeHtml(item.content || "")}</p><div class="translation" data-translation><span></span></div><footer><button onclick="copySms(this)">Copy</button>${translateButton}<a class="danger" data-action="delete" href="${runUrl("delete", "sms", { id: item.id })}">Delete</a></footer></article>`;
  }).join("") : `<article class="card empty"><h2>No SMS found</h2><p>${escapeHtml(model.errors.sms || "There are no inbox messages.")}</p></article>`;
  const smsLimitWarning = hiddenSmsCount ? `<div class="warning">⚠️ Showing the latest ${visibleMessages.length} SMS out of ${smsCount} to keep the WebView responsive.</div>` : "";
  const codes = [network.lac ? `LAC/TAC ${escapeHtml(network.lac)}` : "", network.cellId ? `Cell ${escapeHtml(network.cellId)}` : "", network.pci ? `PCI ${escapeHtml(network.pci)}` : ""].filter(Boolean).join(" · ");
  const deviceActions = (model.deviceAccess.capabilities || []).map(action => `<a class="danger buttonlike" href="${runUrl("deviceAccess", "router", { deviceAction: action.id })}">${escapeHtml(action.title)}</a>`).join(" ");
  const pendingDeviceAction = ACTION === "deviceAccess" ? (model.deviceAccess.capabilities || []).find(action => action.id === String(QUERY.deviceAction || "")) : null;
  const deviceConfirm = pendingDeviceAction && String(QUERY.confirm || "") !== "1"
    ? `<div class="warning"><strong>Confirm experimental action: ${escapeHtml(pendingDeviceAction.title)}</strong><p>ADB, Telnet, and shell commands are experimental firmware/debug actions and may be unsupported or ignored. This action will reopen the script. ${escapeHtml(pendingDeviceAction.description || "The command may change router state.")}</p><a class="danger buttonlike" href="${runUrl("deviceAccess", "router", { deviceAction: pendingDeviceAction.id, confirm: "1" })}">Confirm</a> <a class="buttonlike" href="${runUrl("dashboard", "router")}">Cancel</a></div>` : "";
  const cellular = model.cellularControl || {};
  const defaultCellularModes = [{ id: "auto", title: "Automatic" }, { id: "lteOnly", title: "4G/LTE only" }, { id: "ltePreferred", title: "LTE preferred" }, { id: "wcdmaOnly", title: "3G only" }, { id: "gsmOnly", title: "2G only" }];
  const activePreferredMode = preferredModeId(network.preferredMode || network.mode || "");
  const cellularModeOptions = (cellular.modes || (cellularControlModule && cellularControlModule.modes ? cellularControlModule.modes() : defaultCellularModes)).map(mode => `<option value="${escapeHtml(mode.id)}"${mode.id === activePreferredMode ? " selected" : ""}>${escapeHtml(mode.title)}</option>`).join("");
  const cellularModeSelect = `<label class="selectline">Current preferred protocol <select data-cellular-mode-select>${cellularModeOptions}</select></label>`;
  const cellularReconnect = `<button class="danger buttonlike" type="button" data-cellular-action="reconnect" data-cellular-url="${runUrl("cellularReconnect", "router")}">Reconnect cellular network</button>`;
  const resetTrafficConfirm = "";
  const powerConfirmCard = `<div class="warning" data-power-confirm hidden></div>`;
  const baseRun = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}`;
  const activeTab = model.tab === "router" ? "router" : "sms";
  const smsActive = activeTab === "sms" ? " active" : "";
  const routerActive = activeTab === "router" ? " active" : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZMI Router</title><style>${css()}</style></head>
  <body><div id="progressbar" class="progressbar" aria-hidden="true"><i></i></div><main><header class="hero compact"><div><h1>MF855 / MF885</h1><strong>SMS: ${smsCount}</strong></div><p class="statusline"><span>📶 ${escapeHtml(network.mode || "Unknown")}</span><span>${escapeHtml(batteryInline)}</span><span>⇅ ${totalTraffic}</span><span>⟳ ${escapeHtml(updated.slice(0,5))}</span></p></header>
  <nav class="seg"><button data-tab-button="sms" class="${smsActive.trim()}" onclick="tab('sms')">SMS</button><button data-tab-button="router" class="${routerActive.trim()}" onclick="tab('router')">Router</button></nav>
  <section class="refresh"><span id="countdown">Next refresh: ${escapeHtml(nextUpdate)}</span><div class="actions"><a id="refreshLink" class="buttonlike" href="${runUrl("dashboard", model.tab)}" onclick="refreshNow(event)">Refresh</a><button id="pauseBtn" onclick="togglePause()">Pause</button></div></section>
  <section id="actionStatus" class="action-status warning" hidden><header><strong data-status-title></strong><button type="button" onclick="hideActionStatus()">Close</button></header><p data-status-detail></p><textarea data-status-copy rows="5" readonly></textarea><pre data-status-pre></pre></section>
  <section id="webviewDiagnostics" class="action-status warning" hidden><header><strong>WebView interface error</strong><button type="button" onclick="hideWebviewDiagnostics()">Close</button></header><p>The WebView interface encountered an error. Open the details below or refresh the script.</p><pre data-webview-diagnostics></pre></section>
  ${noticeHtml}
    <section id="sms" class="tab${smsActive}"><div class="inline-toolbar"><button onclick="toggleSmsComposer()">📝 Compose SMS</button></div>
    <form id="smsComposer" class="composer card" onsubmit="submitSmsInline(event)" hidden><input name="to" placeholder="Recipient" autocomplete="tel"><textarea name="text" placeholder="SMS text" rows="3" maxlength="1000"></textarea><div><button class="primary" type="submit">Send SMS</button><button type="button" onclick="toggleSmsComposer(false)">Cancel</button></div><p class="formStatus" data-status></p></form>
    ${smsCards}${smsLimitWarning}${model.sms.warning ? `<div class="warning">⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}</section>
    <section id="router" class="tab${routerActive}">${topCards}<article class="card network"><small>Cellular network</small><h2>${signalHtml}</h2><div class="quality">${escapeHtml(network.mode || "Unknown")}</div><p>Current network: <strong>${escapeHtml(network.mode || "Unknown")}</strong></p><p>Current preferred protocol: <strong>${escapeHtml(network.preferredMode || "Unknown")}</strong></p><p>${escapeHtml(network.networkError || network.operator || "Unknown operator")}</p><p>${network.dbm === null || network.dbm === undefined ? "dBm: —" : `dBm: ${escapeHtml(network.dbm)}`}</p>${codes ? `<p class="codes">${codes}</p>` : `<p class="codes">Cell codes unavailable</p>`}${DEBUG && network.rawMode ? `<p class="codes">Raw network code: ${escapeHtml(network.rawMode)}</p>` : ""}<div class="warning"><strong>Experimental cellular controls</strong><p>Firmware endpoints differ across MF855/MF885 builds. Reconnect and protocol changes can temporarily interrupt mobile internet; unsupported firmware should be reported with diagnostics.</p>${cellularReconnect}<h3>Preferred protocol</h3>${cellularModeSelect}</div></article>
    <article class="card battery"><small>Battery</small><h2>${escapeHtml(batteryInline)}</h2><p>${escapeHtml(battery.batteryError || battery.status || "Unknown")}</p>${battery.percentValid ? `<div class="bar"><i style="width:${battery.percent}%"></i></div>` : `<p>Battery percentage unavailable</p>`}</article>
    <article class="card traffic"><small>Traffic</small><h2>${totalTraffic}</h2><p>Downloaded: ${formatBytes(traffic.download)}</p><p>Uploaded: ${formatBytes(traffic.upload)}</p><p>Session: ↓ ${formatBytes(traffic.sessionDownload)} · ↑ ${formatBytes(traffic.sessionUpload)}${traffic.sessionSeconds !== null && traffic.sessionSeconds !== undefined ? ` · ${escapeHtml(formatDuration(traffic.sessionSeconds))}` : ""}</p>${traffic.trafficError ? `<p class="warning">${escapeHtml(traffic.trafficError)}</p>` : ""}<button class="danger buttonlike" type="button" data-power-action="resetTraffic">Reset traffic</button>${resetTrafficConfirm}</article>
    <article class="card experimental" id="routerExperimental"><small>Experimental router controls</small><h2>USSD and device access</h2><section data-ussd-section><h3>USSD: ${model.ussd.supported ? "Available" : "Not confirmed"}</h3><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><button type="button" onclick="toggleUssdComposer(true)">Dial USSD</button><form id="ussdComposer" class="composer" onsubmit="submitUssdInline(event)" hidden><input name="code" placeholder="Code, for example *100#"><div><button class="primary" type="submit">Send USSD</button><button type="button" onclick="toggleUssdComposer(false)">Cancel</button></div><p class="formStatus" data-status></p></form></section><section data-device-access-section><h3>Device access: ${model.deviceAccess.supported ? "Diagnostics available" : "Detection inconclusive"}</h3><p>${escapeHtml(model.errors.deviceAccess || model.deviceAccess.detail || "")}</p><div class="inline-toolbar">${deviceActions || "<span>No actions available</span>"}</div>${deviceConfirm}</section></article>
    <article class="card"><small>Power</small><h2>System commands</h2><button class="buttonlike" type="button" data-power-action="reboot">Restart</button> <button class="danger buttonlike" type="button" data-power-action="powerOff">Power off</button>${powerConfirmCard}</article>${model.errors.status ? `<div class="warning">Status: ${escapeHtml(model.errors.status)}</div>` : ""}</section></main>
  <script>${clientScript(model, baseRun)}</script></body></html>`;
}

function clientScript(model, baseRun) {
  return `var model={tab:${JSON.stringify(model.tab)},poll:${POLL_SECONDS},baseRun:${JSON.stringify(baseRun)},translateEndpoint:${JSON.stringify(TRANSLATE_ENDPOINT)},sms:{fingerprint:${JSON.stringify(model.sms && model.sms.fingerprint || "")},totalPages:${JSON.stringify(model.sms && model.sms.totalPages)},totalMessages:${JSON.stringify(model.sms && model.sms.totalMessages)}}};
var remaining=model.poll,paused=false,timer=null,navigationInProgress=false;
function selectedTab(){try{return localStorage.zmiTab||model.tab}catch(e){return model.tab}}
function safeStorageGet(key){try{return localStorage.getItem(key)}catch(e){return ''}}
function safeStorageSet(key,value){try{localStorage.setItem(key,value)}catch(e){}}
function runUrl(action,tab,params){var q=new URLSearchParams();q.set('action',action||'dashboard');q.set('tab',tab||selectedTab());if(params){Object.keys(params).forEach(function(k){q.set(k,params[k])})}return model.baseRun+'&'+q.toString()}
function actionStatus(){return document.getElementById('actionStatus')}
function hideActionStatus(){var el=actionStatus();if(el)el.hidden=true}
function hideWebviewDiagnostics(){var el=document.getElementById('webviewDiagnostics');if(el)el.hidden=true}
function showWebviewDiagnostics(message,source,lineno,colno,error){var el=document.getElementById('webviewDiagnostics');if(!el)return;var pre=el.querySelector('[data-webview-diagnostics]');if(pre)pre.textContent=['message: '+String(message||''),'source: '+String(source||''),'location: '+String(lineno||0)+':'+String(colno||0),describeError(error)].filter(Boolean).join('\\n');el.hidden=false}
function selectFallbackText(ta){if(!ta||ta.hidden)return;setTimeout(function(){try{ta.focus();ta.select();if(ta.setSelectionRange)ta.setSelectionRange(0,ta.value.length)}catch(e){}},50)}
function fillActionStatus(title,detail,copyText,isError){var el=actionStatus();if(!el)return;var t=el.querySelector('[data-status-title]'),d=el.querySelector('[data-status-detail]'),ta=el.querySelector('[data-status-copy]'),pre=el.querySelector('[data-status-pre]');if(t)t.textContent=title||'Status';if(d)d.textContent=detail||'';if(ta){ta.value=copyText||'';ta.hidden=!copyText;if(copyText)selectFallbackText(ta)}if(pre){pre.textContent=copyText||detail||'';pre.hidden=!!copyText}el.classList.toggle('warning',!!isError);el.hidden=false}
function describeError(e){var parts=[];try{if(e&&e.name)parts.push('name: '+e.name);if(e&&e.message)parts.push('message: '+e.message);parts.push('string: '+String(e));if(e&&typeof e==='object'){Object.keys(e).forEach(function(k){if(k==='name'||k==='message')return;try{parts.push(k+': '+JSON.stringify(e[k]))}catch(_){parts.push(k+': '+String(e[k]))}});if(e.stack)parts.push('stack: '+e.stack)}}catch(inner){parts.push('describeError failed: '+String(inner))}return parts.join('\\n')}
function showActionError(title,detail,copyText){fillActionStatus(title,detail,copyText,true)}
function setActionStatus(message){fillActionStatus('Action status',message,'',false)}
window.onerror=function(message,source,lineno,colno,error){showActionError('WebView JavaScript error',[message,source,lineno+':'+colno,describeError(error)].filter(Boolean).join('\\n'),'');showWebviewDiagnostics(message,source,lineno,colno,error);return false};
window.onunhandledrejection=function(event){var reason=event&&event.reason?event.reason:event;showActionError('WebView JavaScript error',describeError(reason),'');showWebviewDiagnostics('Unhandled promise rejection','',0,0,reason);};
function tab(id){document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id===id)});document.querySelectorAll('[data-tab-button]').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-tab-button')===id)});try{localStorage.zmiTab=id}catch(e){}var link=document.getElementById('refreshLink');if(link)link.href=runUrl('dashboard',id)}
function fmt(s){s=Math.max(0,s|0);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function drawTimer(){var c=document.getElementById('countdown'),p=document.getElementById('pauseBtn');if(c)c.textContent=paused?'Paused':'Next refresh: '+fmt(remaining);if(p)p.textContent=paused?'Resume':'Pause'}
function navigateTo(url,label){if(navigationInProgress)return false;navigationInProgress=true;paused=true;if(timer)clearInterval(timer);document.querySelectorAll('button,a').forEach(function(x){x.disabled=true;x.setAttribute('aria-disabled','true')});setActionStatus('This action will reopen the script. Scriptable is rerunning the dashboard; if the screen closes, open the script again. '+(label||''));setTimeout(function(){window.location.href=url},250);return true}
function saveSmsFingerprint(){try{localStorage.zmiSmsFingerprint=model.sms.fingerprint||'';localStorage.zmiSmsTotalPages=model.sms.totalPages==null?'':String(model.sms.totalPages);localStorage.zmiSmsTotalMessages=model.sms.totalMessages==null?'':String(model.sms.totalMessages)}catch(e){}}
function tick(){if(!paused){remaining-=1;if(remaining<=0){remaining=model.poll;window.zmiTick()}}drawTimer()}
window.zmiTick=function(){startProgress()}
function renderPolledSms(payload){if(!Array.isArray(payload.smsMessages))return true;var section=document.getElementById('sms');if(!section)return false;section.querySelectorAll('.sms,.empty').forEach(function(x){x.remove()});payload.smsMessages.forEach(function(item,index){var card=document.createElement('article');card.className='card sms';card.setAttribute('data-msg-id',item.id||'');card.setAttribute('data-msg-text',item.content||'');var header=document.createElement('header'),title=document.createElement('h3'),time=document.createElement('time'),body=document.createElement('p'),footer=document.createElement('footer'),del=document.createElement('button');title.textContent=item.phone||'Unknown sender';time.textContent=item.date||'Unknown time';body.className='body';body.textContent=item.content||'';del.className='danger';del.textContent='Delete';del.onclick=function(){confirmSmsDelete(card,item)};header.appendChild(title);header.appendChild(time);footer.appendChild(del);card.appendChild(header);card.appendChild(body);card.appendChild(footer);section.appendChild(card)});return true}
function confirmSmsDelete(card,item){var old=card.querySelector('[data-delete-confirm]');if(old){old.hidden=false;return}var box=document.createElement('div');box.className='warning';box.setAttribute('data-delete-confirm','');var preview=String(item.content||'').slice(0,80);var p=document.createElement('p');p.textContent='Delete this SMS from '+(item.phone||'Unknown sender')+', received '+(item.date||'at an unknown time')+'? Preview: '+preview;var yes=document.createElement('a');yes.className='danger buttonlike';yes.textContent='Confirm deletion';yes.href=runUrl('delete','sms',{id:item.id,confirm:'1'});yes.setAttribute('data-final-confirm','1');var no=document.createElement('button');no.textContent='Cancel';no.onclick=function(){box.hidden=true};box.appendChild(p);box.appendChild(yes);box.appendChild(document.createTextNode(' '));box.appendChild(no);card.appendChild(box)}
window.zmiApply=function(payload){payload=payload||{};remaining=model.poll;drawTimer();if(payload.error){stopProgress();showActionError('Refresh failed',payload.error,'');return}var hero=document.querySelector('.hero strong');if(hero&&payload.smsCount!==undefined)hero.textContent='SMS: '+payload.smsCount;var spans=document.querySelectorAll('.statusline span');if(spans[0]&&payload.networkMode)spans[0].textContent='📶 '+payload.networkMode;if(spans[1]&&payload.batteryInline)spans[1].textContent=payload.batteryInline;if(spans[2]&&payload.trafficTotal)spans[2].textContent='⇅ '+payload.trafficTotal;if(spans[3]&&payload.loadedAt)spans[3].textContent='⟳ '+new Date(payload.loadedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});if(payload.smsFingerprint!==model.sms.fingerprint&&renderPolledSms(payload)){model.sms.fingerprint=payload.smsFingerprint||'';model.sms.totalMessages=payload.smsTotalMessages;saveSmsFingerprint()}stopProgress()}
function startProgress(label){var bar=document.getElementById('progressbar');if(bar)bar.classList.add('active');if(label)label.textContent='Working…'}
function stopProgress(){var bar=document.getElementById('progressbar');if(bar)bar.classList.remove('active')}
function refreshNow(e){if(e)e.preventDefault();var link=document.getElementById('refreshLink');startProgress(link);navigateTo(runUrl('dashboard',selectedTab()),'Refresh requested.')}
function togglePause(){paused=!paused;try{localStorage.zmiPaused=paused?'1':'0'}catch(e){}drawTimer()}
function toggleSmsComposer(force){var el=document.getElementById('smsComposer');if(el)el.hidden=force===undefined?!el.hidden:!force}
function toggleUssdComposer(force){var el=document.getElementById('ussdComposer');if(el)el.hidden=force===undefined?!el.hidden:!force}
function submitSmsInline(e){e.preventDefault();if(navigationInProgress)return;var f=e.target,s=f.querySelector('[data-status]'),to=f.elements.to.value.trim(),text=f.elements.text.value.trim();if(!to||!text){s.textContent=!to?'Enter a recipient number':'Enter SMS text';return}if(text.length>1000){s.textContent='SMS text is too long';return}s.textContent='Sending…';startProgress();navigateTo(runUrl('send','sms',{to:to,text:text}),'Sending SMS.')}
function submitUssdInline(e){e.preventDefault();if(navigationInProgress)return;var f=e.target,s=f.querySelector('[data-status]'),code=f.elements.code.value.trim();if(!code){s.textContent='Enter a USSD code';return}if(code.length>128){s.textContent='USSD code is too long';return}s.textContent='Sending…';startProgress();navigateTo(runUrl('ussd','router',{code:code}),'Sending USSD.')}
function cellularActionCopy(kind,label){if(kind==='reconnect')return{title:'Reconnect cellular network?',detail:'Experimental action: mobile internet may be temporarily unavailable while the router disconnects and reconnects.'};return{title:'Set cellular mode?',detail:'Experimental mode change to '+(label||'selected mode')+'. Mobile internet may be temporarily unavailable and firmware support varies.'}}
function showCellularConfirm(el){if(!el||navigationInProgress)return;var mode=el.getAttribute('data-cellular-mode')||(el.getAttribute('data-cellular-mode-select')!==null?el.value:''),kind=el.getAttribute('data-cellular-action'),label=el.options&&el.selectedIndex>=0?el.options[el.selectedIndex].text:el.textContent||mode,url=mode?runUrl('cellularMode','router',{mode:mode,confirm:'1'}):runUrl('cellularReconnect','router',{confirm:'1'});var card=el.closest('.card')||el.parentNode;var box=card&&card.querySelector('[data-cellular-confirm]');if(!box){box=document.createElement('div');box.className='warning';box.setAttribute('data-cellular-confirm','');card.appendChild(box)}var copy=cellularActionCopy(kind,label);box.hidden=false;box.innerHTML='';var strong=document.createElement('strong');strong.textContent=copy.title;var p=document.createElement('p');p.textContent=copy.detail;var final=document.createElement('a');final.className='danger buttonlike';final.href=url;final.textContent='Confirm';final.setAttribute('data-final-confirm','1');box.appendChild(strong);box.appendChild(p);box.appendChild(final);box.appendChild(document.createTextNode(' '));var cancel=document.createElement('button');cancel.type='button';cancel.className='buttonlike';cancel.textContent='Cancel';cancel.onclick=function(){box.hidden=true};box.appendChild(cancel);fillActionStatus(copy.title,copy.detail+' Final confirmation will reopen the script.','',true)}
function powerActionCopy(action){if(action==='reboot')return{title:'Restart router?',detail:'\\u0422\\u043e\\u0447\\u043d\\u043e \\u043f\\u0435\\u0440\\u0435\\u0437\\u0430\\u0433\\u0440\\u0443\\u0437\\u0438\\u0442\\u044c? Wi‑Fi and mobile internet will be temporarily unavailable.'};if(action==='powerOff')return{title:'Power off router?',detail:'\\u0422\\u043e\\u0447\\u043d\\u043e \\u0432\\u044b\\u043a\\u043b\\u044e\\u0447\\u0438\\u0442\\u044c? The physical power button is required to turn the router on again.'};return{title:'Reset total traffic?',detail:'\\u0422\\u043e\\u0447\\u043d\\u043e \\u0441\\u0431\\u0440\\u043e\\u0441\\u0438\\u0442\\u044c \\u0441\\u0447\\u0451\\u0442\\u0447\\u0438\\u043a \\u0442\\u0440\\u0430\\u0444\\u0438\\u043a\\u0430? Only the total mobile WAN counters will be reset.'}}
function showInlineConfirm(button){var action=button&&button.getAttribute('data-power-action');if(!action||navigationInProgress)return;var card=button.closest('.card')||button.parentNode;var box=card&&card.querySelector('[data-power-confirm]');if(!box){box=document.createElement('div');box.className='warning';box.setAttribute('data-power-confirm','');card.appendChild(box)}var copy=powerActionCopy(action);box.hidden=false;box.innerHTML='';var strong=document.createElement('strong');strong.textContent=copy.title;var p=document.createElement('p');p.textContent=copy.detail;var final=document.createElement('a');final.className='danger buttonlike';final.href=runUrl(action,'router',{confirm:'1'});final.textContent='Confirm';final.setAttribute('data-final-confirm','1');var cancel=document.createElement('button');cancel.type='button';cancel.className='buttonlike';cancel.textContent='Cancel';cancel.onclick=function(){box.hidden=true};box.appendChild(strong);box.appendChild(p);box.appendChild(final);box.appendChild(document.createTextNode(' '));box.appendChild(cancel);fillActionStatus(copy.title,copy.detail+' Final confirmation will reopen the script.','',true)}
function initDashboard(){try{paused=localStorage.zmiPaused==='1'}catch(e){paused=false}saveSmsFingerprint();tab(selectedTab());drawTimer();timer=setInterval(tick,1000);document.addEventListener('change',function(e){var select=e.target&&e.target.closest?e.target.closest('[data-cellular-mode-select]'):null;if(select)showCellularConfirm(select)});document.addEventListener('click',function(e){var cellularButton=e.target&&e.target.closest?e.target.closest('[data-cellular-action],[data-cellular-mode]'):null;if(cellularButton){e.preventDefault();showCellularConfirm(cellularButton);return}var powerButton=e.target&&e.target.closest?e.target.closest('[data-power-action]'):null;if(powerButton){e.preventDefault();showInlineConfirm(powerButton);return}var a=e.target&&e.target.closest?e.target.closest('a[href^="scriptable:///run"]'):null;if(!a)return;e.preventDefault();if(a.dataset.action==='delete'){var c=a.closest('.sms');confirmSmsDelete(c,{id:c.getAttribute('data-msg-id'),phone:c.getAttribute('data-msg-sender'),date:c.getAttribute('data-msg-date'),content:c.getAttribute('data-msg-text')});return}if(navigationInProgress)return;startProgress(a);var final=a.getAttribute('data-final-confirm')==='1';navigateTo(a.href,final?'Final confirmation. This action will reopen the script.':'This action will reopen the script.')})}
document.addEventListener('DOMContentLoaded',initDashboard);
async function copySms(button){if(button.disabled)return;var card=button&&button.closest('.sms'),body=card&&card.querySelector('.body');var value=body?body.innerText:'';var old=button.textContent;if(!navigator.clipboard||!navigator.clipboard.writeText){button.textContent='Manual copy';showActionError('Copy SMS manually','Clipboard is unavailable in this WebView. Select the text below and copy it manually.',value);setTimeout(function(){button.textContent=old},1500);return}button.disabled=true;try{await navigator.clipboard.writeText(value);button.textContent='Copied';setActionStatus('SMS copied to the clipboard.')}catch(e){button.textContent='Error';showActionError('Could not copy SMS',describeError(e),value)}finally{setTimeout(function(){button.textContent=old;button.disabled=false},1500)}}
async function translateSms(button){if(button.disabled)return;var card=button&&button.closest('.sms'),box=card&&card.querySelector('[data-translation] span'),text=card?card.getAttribute('data-msg-text')||'':'';if(!box)return;if(!model.translateEndpoint){box.textContent='Translation is not configured';return}var key='zmiTr:'+card.getAttribute('data-msg-id')+':'+text;if(!text){box.textContent='No text to translate';return}var cached=safeStorageGet(key);if(cached){box.textContent=cached;return}var old=button.textContent;button.disabled=true;button.textContent='…';try{var res=await fetch(model.translateEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'en',format:'text'})});var raw=await res.text();if(!res.ok)throw new Error('HTTP '+res.status+' '+res.statusText+'\\n'+raw);var data;try{data=JSON.parse(raw)}catch(jsonError){throw new Error('HTTP '+res.status+', JSON parse error: '+describeError(jsonError)+'\\nResponse: '+raw)}var tr=data.translatedText||data.translation||'';if(!tr)throw new Error('HTTP '+res.status+', empty translation response: '+raw);safeStorageSet(key,tr);box.textContent=tr}catch(e){box.textContent='Translation is unavailable — details are shown below.';showActionError('Could not prepare translation',describeError(e),text)}finally{button.textContent=old;button.disabled=false}}
`;
}
function css() { return `:root{color-scheme:dark;--bg:#0b1020;--panel:#111827;--panel2:#172033;--text:#f8fafc;--muted:#a8b3c7;--line:#253044;--cyan:#67e8f9;--blue:#60a5fa;--purple:#a78bfa;--bad:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#101827 0%,var(--bg) 45%,#070b13 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:env(safe-area-inset-top) 10px 30px}main{max-width:720px;margin:auto}.hero{padding:12px 4px 6px}.hero.compact{display:block}.hero h1{font-size:26px;line-height:1;margin:0 0 4px}.hero strong{color:var(--cyan)}.statusline{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0;color:var(--muted);font-size:14px}.statusline span{border:1px solid var(--line);border-radius:999px;padding:5px 8px;background:#0d1424}.hero>small,.card small,.mini span{color:var(--cyan);font-weight:800;letter-spacing:.1em;font-size:10px;text-transform:uppercase}.card p,.mini small{color:var(--muted)}.topgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.mini,.card,.notice,.warning{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,var(--panel2),var(--panel));box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.mini{min-height:86px;position:relative}.mini:after{display:none}.mini strong{display:block;font-size:21px;margin:8px 0 3px}.seg{display:flex;background:#080d18;border:1px solid var(--line);border-radius:14px;padding:4px;margin:8px 0}.seg button{flex:1}.seg button.active,.primary{background:#dff8ff;color:#03111d;border-color:transparent;font-weight:800}button,a,.buttonlike{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:8px 11px;background:#182235;color:var(--text);text-decoration:none;font:inherit}button:active,a:active{transform:scale(.98)}.danger{color:var(--bad)}.refresh{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0 10px;color:var(--muted);font-size:14px}.actions,.inline-toolbar{display:flex;gap:8px;flex-wrap:wrap}.inline-toolbar{margin:8px 0}.tab{display:none}.tab.active{display:block}.card{margin:8px 0}.card h2{font-size:24px;margin:6px 0}.composer input,.composer textarea,.selectline select{width:100%;margin:0 0 8px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.formStatus{margin:8px 0 0;color:#fbbf24}.selectline{display:block;color:var(--muted);margin:8px 0}.selectline select{display:block;margin-top:6px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.sms{padding:11px;margin:8px 0}.sms header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;border-bottom:1px solid #253044aa;padding-bottom:7px}.sms h3{margin:0 0 2px;font-size:15px}.sms time,.sms footer{color:var(--muted);font-size:12px}.sms footer{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #253044aa;padding-top:8px}.sms footer button,.sms footer a{padding:6px 9px;border-radius:10px}.sms .body{white-space:pre-wrap;word-break:break-word;font-size:17px;line-height:1.45;color:#f8fafc;margin:10px 0}.translation{color:var(--muted);font-size:14px}.translation span:empty{display:none}.quality{display:inline-block;padding:6px 10px;border-radius:999px;background:#34d39922;color:var(--good)}.codes{font-family:ui-monospace,Menlo,monospace}.bar{height:10px;background:#ffffff14;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue),var(--cyan));border-radius:inherit}.progressbar{position:fixed;left:0;right:0;top:0;height:3px;z-index:1000;background:transparent;overflow:hidden}.progressbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--blue));box-shadow:0 0 16px var(--cyan)}.progressbar.active i{animation:progressStart 1.2s ease-in-out infinite}@keyframes progressStart{0%{width:0;transform:translateX(0)}55%{width:72%;transform:translateX(12%)}100%{width:40%;transform:translateX(160%)}}.notice{color:var(--good);margin:8px 0}.notice.warning{color:#fbbf24;border-color:#fbbf2466;background:linear-gradient(180deg,#3b2f14,#1f1a0f)}.notice.error{color:var(--bad);border-color:#fb718566;background:linear-gradient(180deg,#3b1720,#1f0f14)}.warning{color:#fbbf24}.signal-bars{display:inline-flex;gap:3px;align-items:flex-end;height:22px;vertical-align:middle}.signal-bars i{display:block;width:5px;border-radius:3px;background:#ffffff30}.signal-bars i:nth-child(1){height:6px}.signal-bars i:nth-child(2){height:9px}.signal-bars i:nth-child(3){height:12px}.signal-bars i:nth-child(4){height:16px}.signal-bars i:nth-child(5){height:20px}.signal-bars i.on{background:var(--cyan)}.action-status{margin:8px 0;border:1px solid #fbbf2466;border-radius:18px;background:linear-gradient(180deg,#3b2f14,#1f1a0f);box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.action-status header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.action-status p{white-space:pre-wrap;color:#fde68a;margin:8px 0}.action-status textarea,.action-status pre{width:100%;max-width:100%;min-height:96px;margin:8px 0 0;padding:10px;border-radius:12px;border:1px solid #fbbf2466;background:#0b1220;color:#f8fafc;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto;user-select:text;-webkit-user-select:text}.action-status textarea[hidden],.action-status pre[hidden]{display:none}.empty{text-align:center}@media(max-width:520px){.topgrid{grid-template-columns:1fr}.refresh{align-items:flex-start}.actions{justify-content:flex-end}}`; }
function runUrl(action, tab, parameters = {}) {
  const query = Object.assign({ action, tab: tab || "sms" }, parameters);
  return "scriptable:///run?scriptName=" + encodeURIComponent(Script.name()) +
    "&" + Object.keys(query).map(key =>
      `${encodeURIComponent(key)}=${encodeURIComponent(query[key] == null ? "" : query[key])}`
    ).join("&");
}
async function showMessage(title, message, icon) { const web = new WebView(); await web.loadHTML(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style></head><body><main><article class="card empty"><h1>${icon} ${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></article></main></body></html>`); await web.present(); }

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
