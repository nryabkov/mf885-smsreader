// ZMI MF855/MF885 dashboard: all SMS, new-message polling, network, battery,
// traffic, power controls, and experimental USSD support.
// Scriptable for iPhone

let ROUTER_HOST = "192.168.21.1";
const USERNAME = "admin";
let PASSWORD = "zimifi";
let ussdModule = null;
let deviceAccessModule = null;

const POLL_SECONDS = 30;
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
  if (!options.moduleDirectory) {
    throw new Error("The application module directory was not provided by the loader.");
  }
  ussdModule = importModule(`${options.moduleDirectory}/modules/ussd.js`);
  deviceAccessModule = importModule(`${options.moduleDirectory}/modules/device-access.js`);
  await main();
}

module.exports = { run, parseDigestChallenge };

async function main() {
  try {
    const auth = await getAuthChallenge();
    await login(auth);
    if (ACTION === "send") return await sendFlow(auth);
    if (ACTION === "delete") return await deleteFlow(auth);
    if (ACTION === "ussd") return await ussdFlow(auth);
    if (ACTION === "deviceAccess") return await deviceAccessFlow(auth);
    if (ACTION === "resetTraffic") return await resetTrafficFlow(auth);
    if (ACTION === "reboot" || ACTION === "powerOff") return await powerFlow(auth, ACTION);
    return await dashboardFlow(auth, "", INITIAL_TAB);
  } catch (error) {
    console.error(String(error));
    await showMessage("ZMI error", cleanError(error), "⚠️");
  }
}

// Application flows
async function dashboardFlow(auth, notice = "", tab = "sms") {
  const model = await loadModel(auth);
  model.notice = notice;
  model.tab = tab;
  const web = new WebView();
  await web.loadHTML(buildHtml(model));
  await web.present();
}

async function loadModel(auth) {
  const model = {
    sms: emptySms(), traffic: {}, battery: {}, network: {}, ussd: {}, deviceAccess: {},
    errors: {}, notice: "", tab: "sms", loadedAt: Date.now()
  };
  try {
    const status = await getStatus(auth);
    model.traffic = parseTraffic(status);
    model.battery = parseBattery(status);
    model.network = parseNetwork(status);
  } catch (error) {
    model.errors.status = cleanError(error);
  }
  try { model.sms = await loadAllSms(auth); }
  catch (error) { model.errors.sms = cleanError(error); }
  try { model.ussd = await detectUssdCapability(auth); }
  catch (error) { model.errors.ussd = cleanError(error); }
  try { model.deviceAccess = await detectDeviceAccess(auth); }
  catch (error) { model.errors.deviceAccess = cleanError(error); }
  return model;
}

async function sendFlow(auth) {
  const inlineTo = String(QUERY.to || "").trim();
  const inlineText = String(QUERY.text || "").trim();
  const inlineTab = INITIAL_TAB || "sms";
  if (inlineTo || inlineText) {
    if (!inlineTo) return dashboardFlow(auth, "Ошибка: укажите номер получателя", inlineTab);
    if (!inlineText) return dashboardFlow(auth, "Ошибка: введите текст SMS", inlineTab);
    if (inlineText.length > 1000) return dashboardFlow(auth, "Ошибка: текст SMS слишком длинный", inlineTab);
    const result = parseSendResult(await sendSms(auth, inlineTo, inlineText));
    if (!result.ok) return dashboardFlow(auth, `Ошибка отправки SMS: ${result.message}`, inlineTab);
    return dashboardFlow(auth, `SMS отправлено на ${inlineTo}`, inlineTab);
  }
  return dashboardFlow(auth, "Откройте форму «Написать SMS»", "sms");
}

async function deleteFlow(auth) {
  const id = String(QUERY.id || "").trim();
  if (!id) return dashboardFlow(auth, "Ошибка: не найден идентификатор SMS", "sms");

  const result = await deleteSms(auth, id);
  if (!result.ok) return dashboardFlow(auth, `Ошибка удаления SMS: ${result.message}`, "sms");
  return dashboardFlow(auth, "SMS удалено", "sms");
}

async function ussdFlow(auth) {
  const capability = await detectUssdCapability(auth);
  const inlineCode = String(QUERY.code || "").trim();
  const inlineTab = INITIAL_TAB || "sms";
  if (inlineCode) {
    if (inlineCode.length > 128) return dashboardFlow(auth, "Ошибка: USSD-код слишком длинный", inlineTab);
    const result = await executeUssd(auth, capability, inlineCode);
    const detail = DEBUG && result.diagnostics ? `${result.message} (${result.diagnostics})` : result.message;
    return dashboardFlow(auth, `${result.ok ? "USSD" : "Ошибка USSD"}: ${detail}`, inlineTab);
  }
  return dashboardFlow(auth, "Откройте форму «Набрать USSD»", "sms");
}

async function deviceAccessFlow(auth) {
  const capability = await detectDeviceAccess(auth);
  const actions = capability.capabilities || [];
  const actionId = String(QUERY.deviceAction || "").trim();
  const confirm = String(QUERY.confirm || "") === "1";
  const action = actions.find(item => item.id === actionId);
  if (!actionId || !action) return dashboardFlow(auth, "Выберите экспериментальное действие в карточке роутера", "router");
  if (!confirm) return dashboardFlow(auth, `Подтвердите экспериментальное действие: ${action.title}`, "router");

  const result = await executeDeviceAccess(auth, action.id, action.id);
  const detail = DEBUG && result.diagnostics
    ? `${result.message} (${result.diagnostics})`
    : result.message;
  return dashboardFlow(auth, `${result.title}: ${detail}`, "router");
}

async function resetTrafficFlow(auth) {
  if (String(QUERY.confirm || "") !== "1") {
    return dashboardFlow(auth, "Подтвердите сброс общего трафика", "router");
  }
  await routerCall(auth, "statistics", "stat_clear_common_data");
  return dashboardFlow(auth, "Общий мобильный трафик сброшен", "router");
}

async function powerFlow(auth, kind) {
  const reboot = kind === "reboot";
  if (String(QUERY.confirm || "") !== "1") {
    return dashboardFlow(auth, reboot ? "Подтвердите перезапуск роутера" : "Подтвердите выключение роутера", "router");
  }
  const file = reboot ? "reset" : "shutdown";
  const field = reboot ? "reset" : "shutdown";
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><${file}><${field}>1</${field}></${file}></RGW>`;
  try { await xmlRequest(auth, "POST", file, xml, false); } catch (_) {}
  return dashboardFlow(auth, reboot ? "Команда перезапуска отправлена; временная потеря связи ожидаема" : "Команда выключения отправлена; включение возможно физической кнопкой", "router");
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
  const response = md5(`${auth.ha1}:${auth.nonce}:00000001:${cnonce}:${auth.qop}:${md5("GET:/cgi/protected.cgi")}`);
  const query = formEncode({ realm: auth.realm, nonce: auth.nonce, response,
    qop: auth.qop, cnonce, Action: "Digest", username: USERNAME, temp: "marvell" });
  const req = new Request(`http://${ROUTER_HOST}/login.cgi?${query}`);
  req.method = "GET";
  req.headers = Object.assign({}, baseHeaders(), { Authorization: authorization(auth, "GET") });
  await req.loadString();
  auth.nc++;
}

function authorization(auth, method) {
  const nc = Number(auth.nc).toString(16).padStart(8, "0");
  const cnonce = randomCnonce();
  const response = md5(`${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`${method}:/cgi/xml_action.cgi`)}`);
  return `Digest username="${USERNAME}", realm="${auth.realm}", nonce="${auth.nonce}", uri="/cgi/xml_action.cgi", response="${response}", qop=${auth.qop}, nc=${nc}, cnonce="${cnonce}"`;
}

async function xmlRequest(auth, method, file, body = null, retry = true, timeout = 15) {
  const operation = method === "GET" ? "get" : "set";
  const text = await authenticatedRequest(auth, () => {
    const req = new Request(`http://${ROUTER_HOST}/xml_action.cgi?method=${operation}&module=duster&file=${encodeURIComponent(file)}`);
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
    const req = new Request(`http://${ROUTER_HOST}/xml_action.cgi?method=set`);
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
  return { realm, nonce, qop: "auth" };
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

  for (const payload of attempts) {
    const xml = `<?xml version="1.0" encoding="US-ASCII"?>${payload}`;
    try {
      const response = await xmlRequest(auth, "POST", "message", xml);
      diagnostics.push(String(response || "").replace(/\s+/g, " ").slice(0, 200));
      if (routerAccepted(response)) {
        await sleep(500);
        const current = await loadAllSms(auth);
        if (!current.messages.some(message => String(message.id) === String(id))) {
          return { ok: true, message: "The SMS was removed from the router" };
        }
        diagnostics.push("The message was still present after the command");
      }
    } catch (error) {
      diagnostics.push(cleanError(error));
    }
  }
  return {
    ok: false,
    message: `The firmware rejected the known SMS deletion commands. ${diagnostics.join("; ")}`
  };
}

function routerAccepted(xml) {
  const text = String(xml || "").toLowerCase();
  return Boolean(text) &&
    !/unauthorized|error|fail|invalid|denied|not.?support/.test(text) &&
    (text.includes("<rgw") || text.includes("success") ||
      text.includes("<result>0</result>") || text.includes("<status>0</status>"));
}

// SMS pagination and parsing
function emptySms() { return { messages: [], loadedPages: 0, totalPages: null, warning: "" }; }
async function loadAllSms(auth) {
  const result = emptySms();
  let previous = "";
  for (let page = 1; page <= SMS_MAX_PAGES; page++) {
    const parsed = parseSmsPage(await getSmsPage(auth, page), page);
    if (page === 1) result.totalPages = parsed.totalPages;
    if (!parsed.messages.length) break;
    const fingerprint = parsed.messages.map(smsKey).join("|");
    if (fingerprint === previous) { result.warning = "The router repeated a page; loading stopped."; break; }
    result.messages.push(...parsed.messages); result.loadedPages++; previous = fingerprint;
    if (result.totalPages !== null && page >= result.totalPages) break;
    if (result.totalPages === null && parsed.messages.length < SMS_PAGE_SIZE) break;
    if (page === SMS_MAX_PAGES) result.warning = `The ${SMS_MAX_PAGES}-page safety limit was reached.`;
  }
  const seen = new Set();
  result.messages = result.messages.filter(message => { const key = smsKey(message); if (seen.has(key)) return false; seen.add(key); return true; });
  return result;
}
function parseSmsPage(xml, page) {
  const totalPages = firstNumber(xml, ["total_pages", "total_page", "page_count", "total_number"]);
  return { page, totalPages, messages: parseSmsItems(xml) };
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
function smsTime() { const d = new Date(); const offset = -d.getTimezoneOffset(); const sign = offset >= 0 ? "%2B" : "-"; return [d.getFullYear() % 100, d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), `${sign}${Math.floor(Math.abs(offset) / 60)}`].join(","); }
function parseSendResult(xml) { const lower = String(xml || "").toLowerCase(); const status = firstText(xml, ["sms_cmd_status_result", "send_status"]); const ok = !unauthorized(xml) && !/error|fail/.test(lower) && status !== "0" && status !== "2"; return { ok, message: ok ? "The router accepted the send command" : "The router rejected the send command" }; }

// Router status
function parseTraffic(xml) {
  const source = tag(xml, "WanStatistics") || xml;
  const upload = firstNumber(source, ["tx_byte_all", "total_tx_bytes"]);
  const download = firstNumber(source, ["rx_byte_all", "total_rx_bytes"]);
  return { upload, download, total: sum(upload, download), sessionUpload: firstNumber(source, ["tx_byte", "tx_bytes"]), sessionDownload: firstNumber(source, ["rx_byte", "rx_bytes"]) };
}
function parseBattery(xml) {
  const source = tag(xml, "batteryinfo") || xml;
  const percent = firstNumber(source, ["Battery_percent", "battery_percent", "battery_value"]);
  const status = firstText(source, ["Battery_status", "battery_status", "Charger_status"]);
  const charging = /charg|adapter|usb|plug|online/i.test(status);
  return { percent: percent === null ? null : Math.min(100, percent), charging, status: batteryStatusLabel(status, charging), rawStatus: status || "" };
}
function parseNetwork(xml) {
  const wan = tag(xml, "wan") || xml;
  const cellular = tag(wan, "cellular") || wan;
  const operator = firstText(wan, ["network_name", "ISP_name", "ISP", "operator_name", "mccmnc"]);
  const rawMode = firstText(wan, ["network_type", "network_mode", "data_conn_mode", "radio_mode", "rat", "service_type"]);
  const mode = networkModeLabel(rawMode);
  const signalBar = firstNumber(cellular, ["signalbar", "signal_bar", "signal_level", "SignalBar"]);
  const bars = signalBar === null ? null : Math.max(0, Math.min(5, Math.round(signalBar)));
  const dbm = firstSigned(cellular, ["rsrp", "rssi", "rscp", "ecio", "sinr", "signal_strength", "SignalStrength"]);
  const lac = firstText(cellular, ["lac", "LAC", "tac", "TAC", "location_area_code"]);
  const cellId = firstText(cellular, ["cell_id", "cellid", "CellID", "cid", "eci"]);
  const pci = firstText(cellular, ["pci", "PCI", "psc"]);
  return { operator, mode, rawMode, bars, dbm, lac, tac: lac, cellId, pci, quality: signalQuality(bars, dbm) };
}
function batteryStatusLabel(value, charging) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (/full|complete|100/.test(lower) || text === "3") return "Полная";
  if (charging || /charg|adapter|usb|plug|online/.test(lower) || text === "2") return "Заряжается";
  if (/battery|discharg|offline/.test(lower) || text === "1") return "Работает от батареи";
  return "Неизвестно";
}
function networkModeLabel(value) {
  const text = String(value || "").trim();
  if (!text) return "Не определён";
  if (/^\d+$/.test(text)) return `Режим ${text}`;
  if (/\b(lte|4g)\b/i.test(text)) return /lte/i.test(text) ? "LTE" : "4G";
  if (/\b(5g|nr)\b/i.test(text)) return "5G";
  if (/\b(3g|umts|hspa|wcdma)\b/i.test(text)) return "3G";
  if (/\b(2g|edge|gsm|gprs)\b/i.test(text)) return "2G";
  return text;
}
function signalQuality(bars, dbm) {
  if (bars !== null && bars !== undefined) return bars >= 4 ? "Отличный" : bars >= 3 ? "Хороший" : bars >= 1 ? "Слабый" : "Нет сигнала";
  if (dbm !== null && dbm !== undefined) return dbm >= -75 ? "Отличный" : dbm >= -90 ? "Хороший" : dbm >= -105 ? "Слабый" : "Очень слабый";
  return "Нет данных";
}
function formatBytes(bytes) { if (bytes === null || !Number.isFinite(bytes)) return "—"; if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB", "TB"]; const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4); return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`; }

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

function sleep(ms) { return new Promise(resolve => { const timer = Timer.schedule(ms, false, () => { timer.invalidate(); resolve(); }); }); }

// WebView rendering
function buildHtml(model) {
  const battery = model.battery || {}; const network = model.network || {}; const traffic = model.traffic || {};
  const updated = new Date(model.loadedAt || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const allMessages = model.sms && model.sms.messages ? model.sms.messages : [];
  const smsCount = allMessages.length;
  const maxVisibleSms = 200;
  const visibleMessages = allMessages.slice(0, maxVisibleSms);
  const hiddenSmsCount = Math.max(0, smsCount - visibleMessages.length);
  const nextUpdate = new Date((model.loadedAt || Date.now()) + POLL_SECONDS * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const networkLabel = network.quality || "Нет данных";
  const batteryLabel = battery.percent === null || battery.percent === undefined ? "—" : `${battery.percent}%`;
  const totalTraffic = formatBytes(traffic.total);
  const topCards = `<section class="topgrid router-only">
    <article class="mini"><span>Сигнал</span><strong>${escapeHtml(networkLabel)}</strong><small>${escapeHtml(network.mode || "Режим неизвестен")}${network.rawMode ? ` · Код сети: ${escapeHtml(network.rawMode)}` : ""}</small></article>
    <article class="mini"><span>Батарея</span><strong>${batteryLabel}</strong><small>${escapeHtml(battery.status || "Неизвестно")}</small></article>
    <article class="mini"><span>Трафик</span><strong>${totalTraffic}</strong><small>Скачано: ${formatBytes(traffic.download)} · Отправлено: ${formatBytes(traffic.upload)}</small></article>
  </section>`;
  const smsCards = smsCount ? visibleMessages.map((item, index) => {
    const key = escapeHtml(String(item.id || smsKey(item) || index));
    return `<article class="card sms" data-msg-id="${key}" data-msg-text="${escapeHtml(item.content)}"><header><div><h3>${escapeHtml(item.phone || "Неизвестный отправитель")}</h3><small>SMS #${escapeHtml(item.row || index + 1)}</small></div><time>${escapeHtml(item.date || "Время неизвестно")}</time></header><p class="body">${escapeHtml(item.content || "")}</p><div class="translation" data-translation><span></span></div><footer><button onclick="copySms(this)">Копировать</button><button onclick="translateSms(this)">Перевести</button><a class="danger" data-action="delete" href="${runUrl("delete", "sms", { id: item.id })}">Удалить</a></footer></article>`;
  }).join("") : `<article class="card empty"><h2>SMS не найдены</h2><p>${escapeHtml(model.errors.sms || "Входящие сообщения отсутствуют.")}</p></article>`;
  const smsLimitWarning = hiddenSmsCount
    ? `<div class="warning">⚠️ Показаны последние ${visibleMessages.length} SMS из ${smsCount}, чтобы WebView не перегружался и не перерисовывался слишком тяжело.</div>`
    : "";
  const codes = [network.rawMode ? `Код сети: ${escapeHtml(network.rawMode)}` : "", network.lac ? `LAC/TAC ${escapeHtml(network.lac)}` : "", network.cellId ? `Cell ${escapeHtml(network.cellId)}` : "", network.pci ? `PCI ${escapeHtml(network.pci)}` : ""].filter(Boolean).join(" · ");
  const deviceActions = (model.deviceAccess.capabilities || []).map(action => `<a class="danger buttonlike" href="${runUrl("deviceAccess", "router", { deviceAction: action.id })}">${escapeHtml(action.title)}</a>`).join(" ");
  const pendingDeviceAction = ACTION === "deviceAccess" ? (model.deviceAccess.capabilities || []).find(action => action.id === String(QUERY.deviceAction || "")) : null;
  const deviceConfirm = pendingDeviceAction && String(QUERY.confirm || "") !== "1"
    ? `<div class="warning"><strong>Подтвердите экспериментальное действие: ${escapeHtml(pendingDeviceAction.title)}</strong><p>${escapeHtml(pendingDeviceAction.description || "Команда может изменить состояние роутера.")}</p><a class="danger buttonlike" href="${runUrl("deviceAccess", "router", { deviceAction: pendingDeviceAction.id, confirm: "1" })}">Подтвердить</a> <a class="buttonlike" href="${runUrl("dashboard", "router")}">Отмена</a></div>`
    : "";
  const resetTrafficConfirm = ACTION === "resetTraffic" && String(QUERY.confirm || "") !== "1"
    ? `<div class="warning"><strong>Сбросить общий трафик?</strong><p>Будут сброшены только общие счётчики мобильного WAN.</p><a class="danger buttonlike" href="${runUrl("resetTraffic", "router", { confirm: "1" })}">Подтвердить</a> <a class="buttonlike" href="${runUrl("dashboard", "router")}">Отмена</a></div>`
    : "";
  const powerConfirm = (ACTION === "reboot" || ACTION === "powerOff") && String(QUERY.confirm || "") !== "1";
  const powerConfirmCard = powerConfirm
    ? `<div class="warning"><strong>${ACTION === "reboot" ? "Перезапустить роутер?" : "Выключить роутер?"}</strong><p>${ACTION === "reboot" ? "Wi‑Fi и мобильный интернет будут временно недоступны." : "Для включения понадобится физическая кнопка питания."}</p><a class="danger buttonlike" href="${runUrl(ACTION, "router", { confirm: "1" })}">Подтвердить</a> <a class="buttonlike" href="${runUrl("dashboard", "router")}">Отмена</a></div>`
    : "";
  const baseRun = `scriptable:///run?scriptName=${encodeURIComponent(Script.name())}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZMI Router</title><style>${css()}</style></head>
  <body><div id="progressbar" class="progressbar" aria-hidden="true"><i></i></div><main><header class="hero compact"><div><h1>MF855 / MF885</h1><strong>SMS: ${smsCount}</strong></div><p class="statusline"><span>📶 ${escapeHtml(networkLabel)}</span><span>🔋 ${batteryLabel}</span><span>⇅ ${totalTraffic}</span><span>⟳ ${escapeHtml(updated.slice(0,5))}</span></p></header>
  <nav class="seg"><button data-tab-button="sms" onclick="tab('sms')">SMS</button><button data-tab-button="router" onclick="tab('router')">Роутер</button></nav>
  <section class="refresh"><span id="countdown">Следующее обновление: ${escapeHtml(nextUpdate)}</span><div class="actions"><a id="refreshLink" class="buttonlike" href="${runUrl("dashboard", model.tab)}" onclick="refreshNow(event)">Обновить</a><button id="pauseBtn" onclick="togglePause()">Пауза</button></div></section>
  <section id="actionStatus" class="action-status warning" hidden><header><strong data-status-title></strong><button type="button" onclick="hideActionStatus()">Закрыть</button></header><p data-status-detail></p><textarea data-status-copy rows="5" readonly></textarea><pre data-status-pre></pre></section>
  ${model.notice ? `<div class="notice">${escapeHtml(model.notice)}</div>` : ""}
    <section id="sms" class="tab"><div class="inline-toolbar"><button onclick="toggleSmsComposer()">📝 Написать SMS</button><button onclick="toggleUssdComposer()">☎️ Набрать USSD</button></div>
    <form id="smsComposer" class="composer card" onsubmit="submitSmsInline(event)" hidden><input name="to" placeholder="Кому" autocomplete="tel"><textarea name="text" placeholder="Текст SMS" rows="3" maxlength="1000"></textarea><div><button class="primary" type="submit">Отправить SMS</button><button type="button" onclick="toggleSmsComposer(false)">Отмена</button></div><p class="formStatus" data-status></p></form>
    <form id="ussdComposer" class="composer card" onsubmit="submitUssdInline(event)" hidden><input name="code" placeholder="Код, например *100#"><div><button class="primary" type="submit">Отправить USSD</button><button type="button" onclick="toggleUssdComposer(false)">Отмена</button></div><p class="formStatus" data-status></p></form>
    ${smsCards}${smsLimitWarning}${model.sms.warning ? `<div class="warning">⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}</section>
    <section id="router" class="tab">${topCards}<article class="card network"><small>СОТОВАЯ СЕТЬ</small><h2>${escapeHtml(networkLabel)}</h2><div class="quality">${escapeHtml(network.mode || "Режим неизвестен")}</div><p>${escapeHtml(network.operator || "Оператор неизвестен")}</p><p>Уровень: ${network.bars === null || network.bars === undefined ? "—" : network.bars + "/5"} · dBm: ${network.dbm === null || network.dbm === undefined ? "—" : escapeHtml(network.dbm)}</p>${codes ? `<p class="codes">${codes}</p>` : `<p class="codes">Коды соты недоступны</p>`}</article>
    <article class="card battery"><small>БАТАРЕЯ</small><h2>${batteryLabel}</h2><p>${escapeHtml(battery.status || "Неизвестно")}</p><div class="bar"><i style="width:${battery.percent === null || battery.percent === undefined ? 0 : battery.percent}%"></i></div></article>
    <article class="card traffic"><small>ТРАФИК</small><h2>${totalTraffic}</h2><p>Скачано: ${formatBytes(traffic.download)}</p><p>Отправлено: ${formatBytes(traffic.upload)}</p><a class="danger buttonlike" href="${runUrl("resetTraffic", "router")}">Сбросить трафик</a>${resetTrafficConfirm}</article>
    <article class="card"><small>USSD</small><h2>${model.ussd.supported ? "Доступно" : "Не подтверждено"}</h2><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><button onclick="tab('sms');toggleUssdComposer(true)">Набрать USSD</button></article>
    <article class="card"><small>DEVICE ACCESS</small><h2>${model.deviceAccess.supported ? "Diagnostics available" : "Detection inconclusive"}</h2><p>${escapeHtml(model.errors.deviceAccess || model.deviceAccess.detail || "")}</p><div class="inline-toolbar">${deviceActions || "<span>Действия недоступны</span>"}</div>${deviceConfirm}</article>
    <article class="card"><small>ПИТАНИЕ</small><h2>Системные команды</h2><a class="buttonlike" href="${runUrl("reboot", "router")}">Перезапуск</a> <a class="danger buttonlike" href="${runUrl("powerOff", "router")}">Выключить</a>${powerConfirmCard}</article>${model.errors.status ? `<div class="warning">Status: ${escapeHtml(model.errors.status)}</div>` : ""}</section></main>
  <script>${clientScript(model, baseRun)}</script></body></html>`;
}

function clientScript(model, baseRun) {
  return `var model={tab:${JSON.stringify(model.tab)},poll:${POLL_SECONDS},baseRun:${JSON.stringify(baseRun)},translateEndpoint:${JSON.stringify(TRANSLATE_ENDPOINT)}};
var remaining=model.poll,paused=false,timer=null,navigationInProgress=false;
function selectedTab(){try{return localStorage.zmiTab||model.tab}catch(e){return model.tab}}
function runUrl(action,tab,params){var q=new URLSearchParams();q.set('action',action||'dashboard');q.set('tab',tab||selectedTab());if(params){Object.keys(params).forEach(function(k){q.set(k,params[k])})}return model.baseRun+'&'+q.toString()}
function actionStatus(){return document.getElementById('actionStatus')}
function hideActionStatus(){var el=actionStatus();if(el)el.hidden=true}
function fillActionStatus(title,detail,copyText,isError){var el=actionStatus();if(!el)return;var t=el.querySelector('[data-status-title]'),d=el.querySelector('[data-status-detail]'),ta=el.querySelector('[data-status-copy]'),pre=el.querySelector('[data-status-pre]');if(t)t.textContent=title||'Статус';if(d)d.textContent=detail||'';if(ta){ta.value=copyText||'';ta.hidden=!copyText}if(pre){pre.textContent=copyText||detail||'';pre.hidden=!!copyText}el.classList.toggle('warning',!!isError);el.hidden=false}
function describeError(e){var parts=[];try{if(e&&e.name)parts.push('name: '+e.name);if(e&&e.message)parts.push('message: '+e.message);parts.push('string: '+String(e));if(e&&typeof e==='object'){Object.keys(e).forEach(function(k){if(k==='name'||k==='message')return;try{parts.push(k+': '+JSON.stringify(e[k]))}catch(_){parts.push(k+': '+String(e[k]))}});if(e.stack)parts.push('stack: '+e.stack)}}catch(inner){parts.push('describeError failed: '+String(inner))}return parts.join('\n')}
function showActionError(title,detail,copyText){fillActionStatus(title,detail,copyText,true)}
function setActionStatus(message){fillActionStatus('Статус действия',message,'',false)}
window.onerror=function(message,source,lineno,colno,error){showActionError('Ошибка JavaScript в WebView',[message,source,lineno+':'+colno,describeError(error)].filter(Boolean).join('\n'),'');return false};
window.onunhandledrejection=function(event){showActionError('Ошибка JavaScript в WebView',describeError(event&&event.reason?event.reason:event),'');};
function tab(id){document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id===id)});document.querySelectorAll('[data-tab-button]').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-tab-button')===id)});try{localStorage.zmiTab=id}catch(e){}var link=document.getElementById('refreshLink');if(link)link.href=runUrl('dashboard',id)}
function fmt(s){s=Math.max(0,s|0);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function drawTimer(){var c=document.getElementById('countdown'),p=document.getElementById('pauseBtn');if(c)c.textContent=paused?'На паузе':'Следующее обновление: '+fmt(remaining);if(p)p.textContent=paused?'Продолжить':'Пауза'}
function navigateTo(url,label){if(navigationInProgress)return false;navigationInProgress=true;paused=true;if(timer)clearInterval(timer);document.querySelectorAll('button,a').forEach(function(x){x.disabled=true;x.setAttribute('aria-disabled','true')});setActionStatus('Scriptable перезапускает скрипт для обновления; если экран закрылся, откройте скрипт снова. '+(label||''));setTimeout(function(){window.location.href=url},250);return true}
function tick(){if(!paused){remaining-=1;if(remaining<=0){navigateTo(runUrl('dashboard',selectedTab()),'Автообновление.');return}}drawTimer()}
function startProgress(label){var bar=document.getElementById('progressbar');if(bar)bar.classList.add('active');if(label)label.textContent='Выполняю…'}
function refreshNow(e){if(e)e.preventDefault();var link=document.getElementById('refreshLink');startProgress(link);navigateTo(runUrl('dashboard',selectedTab()),'Нажато «Обновить».')}
function togglePause(){paused=!paused;try{localStorage.zmiPaused=paused?'1':'0'}catch(e){}drawTimer()}
function toggleSmsComposer(force){var el=document.getElementById('smsComposer');if(el)el.hidden=force===undefined?!el.hidden:!force}
function toggleUssdComposer(force){var el=document.getElementById('ussdComposer');if(el)el.hidden=force===undefined?!el.hidden:!force}
function submitSmsInline(e){e.preventDefault();if(navigationInProgress)return;var f=e.target,s=f.querySelector('[data-status]'),to=f.elements.to.value.trim(),text=f.elements.text.value.trim();if(!to||!text){s.textContent=!to?'Укажите номер':'Введите текст SMS';return}if(text.length>1000){s.textContent='Текст SMS слишком длинный';return}s.textContent='Отправляю…';startProgress();navigateTo(runUrl('send','sms',{to:to,text:text}),'Отправка SMS.')}
function submitUssdInline(e){e.preventDefault();if(navigationInProgress)return;var f=e.target,s=f.querySelector('[data-status]'),code=f.elements.code.value.trim();if(!code){s.textContent='Введите USSD-код';return}if(code.length>128){s.textContent='USSD-код слишком длинный';return}s.textContent='Отправляю…';startProgress();navigateTo(runUrl('ussd',selectedTab(),{code:code}),'Отправка USSD.')}
function initDashboard(){try{paused=localStorage.zmiPaused==='1'}catch(e){paused=false}tab(selectedTab());drawTimer();timer=setInterval(tick,1000);document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href^="scriptable:///run"]'):null;if(!a)return;e.preventDefault();if(navigationInProgress)return;startProgress(a);if(a.dataset.action==='delete')a.textContent='Удаляю…';navigateTo(a.href,'Переход к действию Scriptable.')})}
document.addEventListener('DOMContentLoaded',initDashboard);
async function copySms(button){if(button.disabled)return;var card=button&&button.closest('.sms'),body=card&&card.querySelector('.body');var value=body?body.innerText:'';var old=button.textContent;if(!navigator.clipboard||!navigator.clipboard.writeText){button.textContent='Вручную';showActionError('Скопируйте SMS вручную','Буфер обмена недоступен в этом WebView. Выделите текст ниже и скопируйте вручную.',value);setTimeout(function(){button.textContent=old},1500);return}button.disabled=true;try{await navigator.clipboard.writeText(value);button.textContent='Скопировано';setActionStatus('SMS скопировано в буфер обмена.')}catch(e){button.textContent='Ошибка';showActionError('Не удалось скопировать SMS',describeError(e),value)}finally{setTimeout(function(){button.textContent=old;button.disabled=false},1500)}}
async function translateSms(button){if(button.disabled)return;var card=button&&button.closest('.sms'),box=card&&card.querySelector('[data-translation] span'),text=card?card.getAttribute('data-msg-text')||'':'';if(!box)return;var key='zmiTr:'+card.getAttribute('data-msg-id')+':'+text;if(!text){box.textContent='Нет текста для перевода';return}var cached=localStorage.getItem(key);if(cached){box.textContent=cached;return}var old=button.textContent;button.disabled=true;button.textContent='…';try{if(!model.translateEndpoint){box.textContent='Автоперевод не настроен; пытаюсь скопировать текст для Apple Translate.';if(!navigator.clipboard||!navigator.clipboard.writeText){showActionError('Скопировать для перевода','Буфер обмена недоступен. Выделите SMS ниже и скопируйте вручную для Apple Translate.',text);return}await navigator.clipboard.writeText(text);setActionStatus('Скопировать для перевода: текст SMS скопирован для Apple Translate.');box.textContent='Текст скопирован. Откройте приложение «Перевод» на iPhone и вставьте его.';return}var res=await fetch(model.translateEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'en',format:'text'})});var raw=await res.text();if(!res.ok)throw new Error('HTTP '+res.status+' '+res.statusText+'\n'+raw);var data;try{data=JSON.parse(raw)}catch(jsonError){throw new Error('HTTP '+res.status+', JSON parse error: '+describeError(jsonError)+'\nResponse: '+raw)}var tr=data.translatedText||data.translation||'';if(!tr)throw new Error('HTTP '+res.status+', empty translation response: '+raw);localStorage.setItem(key,tr);box.textContent=tr}catch(e){box.textContent=model.translateEndpoint?'Перевод недоступен — подробности показаны ниже.':'Не удалось скопировать текст для перевода';showActionError('Не удалось подготовить перевод',describeError(e),text)}finally{button.textContent=old;button.disabled=false}}
`;
}
function css() { return `:root{color-scheme:dark;--bg:#0b1020;--panel:#111827;--panel2:#172033;--text:#f8fafc;--muted:#a8b3c7;--line:#253044;--cyan:#67e8f9;--blue:#60a5fa;--purple:#a78bfa;--bad:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#101827 0%,var(--bg) 45%,#070b13 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:env(safe-area-inset-top) 10px 30px}main{max-width:720px;margin:auto}.hero{padding:12px 4px 6px}.hero.compact{display:block}.hero h1{font-size:26px;line-height:1;margin:0 0 4px}.hero strong{color:var(--cyan)}.statusline{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0;color:var(--muted);font-size:14px}.statusline span{border:1px solid var(--line);border-radius:999px;padding:5px 8px;background:#0d1424}.hero>small,.card small,.mini span{color:var(--cyan);font-weight:800;letter-spacing:.1em;font-size:10px;text-transform:uppercase}.card p,.mini small{color:var(--muted)}.topgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.mini,.card,.notice,.warning{border:1px solid var(--line);border-radius:18px;background:linear-gradient(180deg,var(--panel2),var(--panel));box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.mini{min-height:86px;position:relative}.mini:after{display:none}.mini strong{display:block;font-size:21px;margin:8px 0 3px}.seg{display:flex;background:#080d18;border:1px solid var(--line);border-radius:14px;padding:4px;margin:8px 0}.seg button{flex:1}.seg button.active,.primary{background:#dff8ff;color:#03111d;border-color:transparent;font-weight:800}button,a,.buttonlike{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:8px 11px;background:#182235;color:var(--text);text-decoration:none;font:inherit}button:active,a:active{transform:scale(.98)}.danger{color:var(--bad)}.refresh{display:flex;justify-content:space-between;gap:8px;align-items:center;margin:8px 0 10px;color:var(--muted);font-size:14px}.actions,.inline-toolbar{display:flex;gap:8px;flex-wrap:wrap}.inline-toolbar{margin:8px 0}.tab{display:none}.tab.active{display:block}.card{margin:8px 0}.card h2{font-size:24px;margin:6px 0}.composer input,.composer textarea{width:100%;margin:0 0 8px;padding:10px;border-radius:12px;border:1px solid var(--line);background:#0b1220;color:var(--text);font:inherit}.formStatus{margin:8px 0 0;color:#fbbf24}.sms{padding:11px;margin:8px 0}.sms header{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;border-bottom:1px solid #253044aa;padding-bottom:7px}.sms h3{margin:0 0 2px;font-size:15px}.sms time,.sms footer{color:var(--muted);font-size:12px}.sms footer{display:flex;gap:6px;flex-wrap:wrap;border-top:1px solid #253044aa;padding-top:8px}.sms footer button,.sms footer a{padding:6px 9px;border-radius:10px}.sms .body{white-space:pre-wrap;word-break:break-word;font-size:17px;line-height:1.45;color:#f8fafc;margin:10px 0}.translation{color:var(--muted);font-size:14px}.translation span:empty{display:none}.quality{display:inline-block;padding:6px 10px;border-radius:999px;background:#34d39922;color:var(--good)}.codes{font-family:ui-monospace,Menlo,monospace}.bar{height:10px;background:#ffffff14;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue),var(--cyan));border-radius:inherit}.progressbar{position:fixed;left:0;right:0;top:0;height:3px;z-index:1000;background:transparent;overflow:hidden}.progressbar i{display:block;height:100%;width:0;background:linear-gradient(90deg,var(--cyan),var(--blue));box-shadow:0 0 16px var(--cyan)}.progressbar.active i{animation:progressStart 1.2s ease-in-out infinite}@keyframes progressStart{0%{width:0;transform:translateX(0)}55%{width:72%;transform:translateX(12%)}100%{width:40%;transform:translateX(160%)}}.notice{color:var(--good);margin:8px 0}.warning{color:#fbbf24}.action-status{margin:8px 0;border:1px solid #fbbf2466;border-radius:18px;background:linear-gradient(180deg,#3b2f14,#1f1a0f);box-shadow:0 8px 22px #0004;padding:12px;overflow:hidden}.action-status header{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px}.action-status p{white-space:pre-wrap;color:#fde68a;margin:8px 0}.action-status textarea,.action-status pre{width:100%;max-width:100%;min-height:96px;margin:8px 0 0;padding:10px;border-radius:12px;border:1px solid #fbbf2466;background:#0b1220;color:#f8fafc;font:13px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto;user-select:text;-webkit-user-select:text}.action-status textarea[hidden],.action-status pre[hidden]{display:none}.empty{text-align:center}@media(max-width:520px){.topgrid{grid-template-columns:1fr}.refresh{align-items:flex-start}.actions{justify-content:flex-end}}`; }
function runUrl(action, tab, parameters = {}) {
  const query = Object.assign({ action, tab: tab || "sms" }, parameters);
  return "scriptable:///run?scriptName=" + encodeURIComponent(Script.name()) +
    "&" + Object.keys(query).map(key =>
      `${encodeURIComponent(key)}=${encodeURIComponent(query[key] == null ? "" : query[key])}`
    ).join("&");
}
async function showMessage(title, message, icon) { const web = new WebView(); await web.loadHTML(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css()}</style></head><body><main><article class="card empty"><h1>${icon} ${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></article></main></body></html>`); await web.present(); }

// Generic XML and text helpers
function tag(xml, name) { const hit = String(xml || "").match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")); return hit ? htmlDecode(hit[1].trim()) : ""; }
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
