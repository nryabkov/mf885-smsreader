// ZMI MF855/MF885 dashboard: all SMS, new-message polling, network, battery,
// traffic, power controls, and experimental USSD support.
// Scriptable for iPhone

let ROUTER_HOST = "192.168.21.1";
const USERNAME = "admin";
let PASSWORD = "zimifi";
let ussdModule = null;

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
    sms: emptySms(), traffic: {}, battery: {}, network: {}, ussd: {},
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
  return model;
}

async function sendFlow(auth) {
  const alert = new Alert();
  alert.title = "Send SMS";
  alert.message = "Enter the recipient number and message text.";
  alert.addTextField("Number, for example +15551234567", "");
  alert.addTextField("SMS text", "");
  alert.addAction("Send");
  alert.addCancelAction("Cancel");
  if ((await alert.present()) === -1) return dashboardFlow(auth);
  const to = alert.textFieldValue(0).trim();
  const text = alert.textFieldValue(1).trim();
  if (!to) throw new Error("Recipient number is missing");
  if (!text) throw new Error("SMS text is missing");
  const result = parseSendResult(await sendSms(auth, to, text));
  if (!result.ok) throw new Error(result.message);
  return dashboardFlow(auth, `The router accepted the SMS to ${to}`);
}

async function deleteFlow(auth) {
  const id = String(QUERY.id || "").trim();
  if (!id) throw new Error("The SMS identifier is missing");

  const alert = new Alert();
  alert.title = "Delete this SMS?";
  alert.message = "The message will be permanently removed from the router.";
  alert.addDestructiveAction("Delete SMS");
  alert.addCancelAction("Cancel");
  if ((await alert.present()) === -1) return dashboardFlow(auth, "", "sms");

  const result = await deleteSms(auth, id);
  if (!result.ok) throw new Error(result.message);
  return dashboardFlow(auth, "SMS deleted", "sms");
}

async function ussdFlow(auth) {
  const capability = await detectUssdCapability(auth);
  const alert = new Alert();
  alert.title = "Send USSD";
  alert.message = capability.supported
    ? capability.detail
    : `${capability.detail}\n\nExperimental: support depends on the router firmware.`;
  alert.addTextField("USSD code, for example *100#", "");
  alert.addAction("Send");
  alert.addCancelAction("Cancel");
  if ((await alert.present()) === -1) return dashboardFlow(auth, "", "router");
  const code = alert.textFieldValue(0).trim();
  if (!code) throw new Error("USSD code is missing");
  if (code.length > 128) throw new Error("USSD code is too long");
  const result = await executeUssd(auth, capability, code);
  const detail = DEBUG && result.diagnostics
    ? `${result.message}\n\n${result.diagnostics}`
    : result.message;
  return showMessage(result.title, detail, result.ok ? "📟" : "⚠️");
}

async function resetTrafficFlow(auth) {
  const alert = new Alert();
  alert.title = "Reset total traffic?";
  alert.message = "Only the total mobile WAN counters will be reset.";
  alert.addDestructiveAction("Reset traffic");
  alert.addCancelAction("Cancel");
  if ((await alert.present()) === -1) return dashboardFlow(auth, "", "router");
  await routerCall(auth, "statistics", "stat_clear_common_data");
  return dashboardFlow(auth, "Total mobile traffic was reset", "router");
}

async function powerFlow(auth, kind) {
  const reboot = kind === "reboot";
  const alert = new Alert();
  alert.title = reboot ? "Restart the router?" : "Power off the router?";
  alert.message = reboot
    ? "Wi-Fi and mobile data will be temporarily unavailable."
    : "The physical power button is required to turn it on again.";
  alert.addDestructiveAction(reboot ? "Restart" : "Power off");
  alert.addCancelAction("Cancel");
  if ((await alert.present()) === -1) return dashboardFlow(auth, "", "router");
  const file = reboot ? "reset" : "shutdown";
  const field = reboot ? "reset" : "shutdown";
  const xml = `<?xml version="1.0" encoding="US-ASCII"?><RGW><${file}><${field}>1</${field}></${file}></RGW>`;
  try { await xmlRequest(auth, "POST", file, xml, false); } catch (_) {}
  return showMessage(
    reboot ? "Restart command sent" : "Power-off command sent",
    "Losing the connection to the router is expected.", reboot ? "🔄" : "⏻"
  );
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
  return { percent: percent === null ? null : Math.min(100, percent), charging, status: status || "Status unavailable" };
}
function parseNetwork(xml) {
  const wan = tag(xml, "wan") || xml;
  const cellular = tag(wan, "cellular") || wan;
  const operator = firstText(wan, ["network_name", "ISP_name", "ISP", "operator_name", "mccmnc"]);
  const rawMode = firstText(wan, ["network_type", "network_mode", "data_conn_mode", "radio_mode", "rat", "service_type"]);
  const mode = normalizeNetworkMode(rawMode);
  const signalBar = firstNumber(cellular, ["signalbar", "signal_bar", "signal_level", "SignalBar"]);
  const bars = signalBar === null ? null : Math.max(0, Math.min(5, Math.round(signalBar)));
  const dbm = firstSigned(cellular, ["rsrp", "rssi", "rscp", "ecio", "sinr", "signal_strength", "SignalStrength"]);
  const lac = firstText(cellular, ["lac", "LAC", "tac", "TAC", "location_area_code"]);
  const cellId = firstText(cellular, ["cell_id", "cellid", "CellID", "cid", "eci"]);
  const pci = firstText(cellular, ["pci", "PCI", "psc"]);
  return { operator, mode, rawMode, bars, dbm, lac, tac: lac, cellId, pci, quality: signalQuality(bars, dbm) };
}
function normalizeNetworkMode(value) {
  const text = String(value || "").trim();
  if (!text) return "Unknown";
  if (/\b(lte|4g)\b/i.test(text)) return /lte/i.test(text) ? "LTE" : "4G";
  if (/\b(5g|nr)\b/i.test(text)) return "5G";
  if (/\b(3g|umts|hspa|wcdma)\b/i.test(text)) return "3G";
  if (/\b(2g|edge|gsm|gprs)\b/i.test(text)) return "2G";
  return text;
}
function signalQuality(bars, dbm) {
  if (bars !== null && bars !== undefined) return bars >= 4 ? "Отличный" : bars >= 3 ? "Хороший" : bars >= 1 ? "Слабый" : "Нет сигнала";
  if (dbm !== null && dbm !== undefined) return dbm >= -75 ? "Отличный" : dbm >= -90 ? "Хороший" : dbm >= -105 ? "Слабый" : "Очень слабый";
  return "Неизвестно";
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
function sleep(ms) { return new Promise(resolve => { const timer = Timer.schedule(ms, false, () => { timer.invalidate(); resolve(); }); }); }

// WebView rendering
function buildHtml(model) {
  const battery = model.battery || {}; const network = model.network || {}; const traffic = model.traffic || {};
  const updated = new Date(model.loadedAt || Date.now()).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const smsCount = model.sms && model.sms.messages ? model.sms.messages.length : 0;
  const topCards = `<section class="topgrid">
    <article class="mini accent-cyan"><span>Сигнал</span><strong>${escapeHtml(network.mode || "—")}</strong><small>${escapeHtml(network.quality || "Неизвестно")} ${network.bars === null || network.bars === undefined ? "" : "· " + network.bars + "/5"}</small></article>
    <article class="mini accent-blue"><span>Батарея</span><strong>${battery.percent === null || battery.percent === undefined ? "—" : battery.percent + "%"}</strong><small>${battery.charging ? "Заряжается" : escapeHtml(battery.status || "Статус неизвестен")}</small></article>
    <article class="mini accent-purple"><span>Трафик</span><strong>${formatBytes(traffic.total)}</strong><small>↓ ${formatBytes(traffic.download)} · ↑ ${formatBytes(traffic.upload)}</small></article>
  </section>`;
  const smsCards = smsCount ? model.sms.messages.map((item, index) => {
    const key = escapeHtml(String(item.id || smsKey(item) || index));
    return `<article class="card sms" data-msg-id="${key}" data-msg-text="${escapeHtml(item.content)}"><header><div><small>Сообщение #${escapeHtml(item.row || index + 1)}</small><h3>${escapeHtml(item.phone || "Неизвестный отправитель")}</h3></div><time>${escapeHtml(item.date || "Время неизвестно")}</time></header><p class="body">${escapeHtml(item.content || "")}</p><div class="translation" data-translation>Перевод: <span>…</span></div><footer><button onclick="copySms(this)">Копировать</button><button onclick="translateSms(this)">Перевести</button><a class="danger" href="${runUrl("delete", "sms", { id: item.id })}">Удалить</a></footer></article>`;
  }).join("") : `<article class="card empty"><h2>SMS не найдены</h2><p>${escapeHtml(model.errors.sms || "Входящие сообщения отсутствуют.")}</p></article>`;
  const codes = [network.lac ? `LAC/TAC ${escapeHtml(network.lac)}` : "", network.cellId ? `Cell ${escapeHtml(network.cellId)}` : "", network.pci ? `PCI ${escapeHtml(network.pci)}` : ""].filter(Boolean).join(" · ");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZMI Router</title><style>${css()}</style></head>
  <body><main><header class="hero"><small>ZMI ROUTER</small><h1>MF855 / MF885</h1><p>Панель SMS и роутера</p>${topCards}<nav class="seg"><button data-tab-button="sms" onclick="tab('sms')">SMS (${smsCount})</button><button data-tab-button="router" onclick="tab('router')">Роутер</button></nav><section class="refresh card"><div><small>Автообновление</small><h2 id="countdown">Следующий опрос через --:--</h2><p>Интервал: ${POLL_SECONDS} сек · Обновлено: ${escapeHtml(updated)}</p><p>Сеть: ${model.errors.status ? "ошибка" : "обновлена"} · Трафик: ${traffic.total === null || traffic.total === undefined ? "нет данных" : "обновлен"} · SMS: ${model.errors.sms ? "ошибка" : "обновлены"}</p></div><div class="actions"><button onclick="refreshNow()">Сейчас</button><button id="pauseBtn" onclick="togglePause()">Пауза</button></div></section></header>
  ${model.notice ? `<div class="notice">✓ ${escapeHtml(model.notice)}</div>` : ""}
    <section id="sms" class="tab"><article class="card smsSummary"><small>Входящие SMS</small><h2>${smsCount}</h2><p>Загружено страниц: ${escapeHtml(model.sms.loadedPages || 0)}</p><a class="primary" href="${runUrl("send", "sms")}">Отправить SMS</a></article>${smsCards}${model.sms.warning ? `<div class="warning">⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}</section>
    <section id="router" class="tab"><article class="card network"><small>СОТОВАЯ СЕТЬ</small><h2>${escapeHtml(network.mode || "Unknown")}</h2><div class="quality">${escapeHtml(network.quality || "Неизвестно")}</div><p>${escapeHtml(network.operator || "Оператор неизвестен")}</p><p>Уровень: ${network.bars === null || network.bars === undefined ? "—" : network.bars + "/5"} · dBm: ${network.dbm === null || network.dbm === undefined ? "—" : escapeHtml(network.dbm)}</p>${codes ? `<p class="codes">${codes}</p>` : `<p class="codes">Коды соты недоступны</p>`}</article>
    <article class="card battery"><small>БАТАРЕЯ</small><h2>${battery.percent === null || battery.percent === undefined ? "—" : battery.percent + "%"}</h2><p>${battery.charging ? "Заряжается" : escapeHtml(battery.status || "Статус неизвестен")}</p><div class="bar"><i style="width:${battery.percent === null || battery.percent === undefined ? 0 : battery.percent}%"></i></div></article>
    <article class="card traffic"><small>ТРАФИК</small><h2>${formatBytes(traffic.total)}</h2><p>Скачано: ${formatBytes(traffic.download)}</p><p>Загружено: ${formatBytes(traffic.upload)}</p><a class="danger buttonlike" href="${runUrl("resetTraffic", "router")}">Сбросить трафик</a></article>
    <article class="card"><small>USSD</small><h2>${model.ussd.supported ? "Endpoint detected" : "Detection inconclusive"}</h2><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><a class="buttonlike" href="${runUrl("ussd", "router")}">Try USSD</a></article>
    <article class="card"><small>ПИТАНИЕ</small><h2>Системные команды</h2><a class="buttonlike" href="${runUrl("reboot", "router")}">Перезапуск</a> <a class="danger buttonlike" href="${runUrl("powerOff", "router")}">Выключить</a></article>${model.errors.status ? `<div class="warning">Status: ${escapeHtml(model.errors.status)}</div>` : ""}</section></main>
  <script>var model={tab:${JSON.stringify(model.tab)},poll:${POLL_SECONDS},translateEndpoint:${JSON.stringify(TRANSLATE_ENDPOINT)}};function selectedTab(){return localStorage.zmiTab||model.tab}function runUrl(action,tab){return ${JSON.stringify(runUrl("dashboard", "__TAB__"))}.replace('__TAB__',encodeURIComponent(tab||selectedTab())).replace('action=dashboard','action='+encodeURIComponent(action||'dashboard'))}function tab(id){document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id===id)});document.querySelectorAll('[data-tab-button]').forEach(function(x){x.classList.toggle('active',x.getAttribute('data-tab-button')===id)});localStorage.zmiTab=id}tab(model.tab);var remaining=model.poll,timer=null,paused=localStorage.zmiPaused==='1';function drawTimer(){document.getElementById('countdown').textContent=paused?'Автоопрос на паузе':'Следующий опрос через 00:'+String(remaining).padStart(2,'0');document.getElementById('pauseBtn').textContent=paused?'Продолжить':'Пауза'}function tick(){drawTimer();if(paused)return;if(--remaining<=0)location.href=runUrl('dashboard',selectedTab())}function refreshNow(){location.href=runUrl('dashboard',selectedTab())}function togglePause(){paused=!paused;localStorage.zmiPaused=paused?'1':'0';drawTimer()}drawTimer();timer=setInterval(tick,1000);async function copySms(button){var value=button.closest('.sms').querySelector('.body').innerText;var old=button.textContent;try{await navigator.clipboard.writeText(value);button.textContent='Скопировано'}catch(e){button.textContent='Ошибка'}setTimeout(function(){button.textContent=old},1500)}async function translateSms(button){var card=button.closest('.sms'),box=card.querySelector('[data-translation] span'),text=card.getAttribute('data-msg-text')||'';var key='zmiTr:'+card.getAttribute('data-msg-id')+':'+text;if(!text){box.textContent='Нет текста для перевода';return}var cached=localStorage.getItem(key);if(cached){box.textContent=cached;return}var old=button.textContent;button.textContent='…';try{if(model.translateEndpoint){var res=await fetch(model.translateEndpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q:text,source:'auto',target:'en',format:'text'})});if(!res.ok)throw new Error('HTTP '+res.status);var data=await res.json();var tr=data.translatedText||data.translation||'';if(!tr)throw new Error('Empty translation');localStorage.setItem(key,tr);box.textContent=tr}else{await navigator.clipboard.writeText(text);box.textContent='Текст скопирован. Откройте приложение «Перевод» на iPhone и вставьте его.'}}catch(e){box.textContent=model.translateEndpoint?'Перевод недоступен':'Не удалось скопировать текст для перевода'}button.textContent=old}</script></body></html>`;
}
function css() { return `:root{color-scheme:dark;--bg:#070b13;--panel:#121a29;--panel2:#182338;--text:#f6f8ff;--muted:#9aa6ba;--line:#ffffff1c;--cyan:#54e8ff;--blue:#5b8cff;--purple:#a855f7;--bad:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0%,#17365f 0,#070b13 38%,#05070d 100%);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:env(safe-area-inset-top) 10px 30px}main{max-width:720px;margin:auto}.hero{padding:18px 4px 8px}.hero>small,.card small,.mini span{color:var(--cyan);font-weight:800;letter-spacing:.12em;font-size:11px;text-transform:uppercase}.hero h1{font-size:38px;line-height:1;margin:6px 0}.hero p,.card p,.mini small{color:var(--muted)}.topgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}.mini,.card,.notice,.warning{border:1px solid var(--line);border-radius:24px;background:linear-gradient(180deg,#1c2940cc,var(--panel));box-shadow:0 18px 40px #0006;padding:16px;overflow:hidden}.mini{min-height:110px;position:relative}.mini:after{content:'';position:absolute;inset:auto -20px -35px 35%;height:75px;filter:blur(10px);opacity:.55}.accent-cyan:after{background:var(--cyan)}.accent-blue:after{background:var(--blue)}.accent-purple:after{background:var(--purple)}.mini strong{display:block;font-size:25px;margin:12px 0 4px}.seg{display:flex;background:#060a12;border:1px solid var(--line);border-radius:18px;padding:5px;margin:10px 0}.seg button{flex:1}.seg button.active,.primary{background:linear-gradient(90deg,var(--cyan),var(--blue));color:#03111d;border-color:transparent;font-weight:800}button,a,.buttonlike{display:inline-block;border:1px solid var(--line);border-radius:14px;padding:10px 14px;background:#ffffff0d;color:var(--text);text-decoration:none;font:inherit}button:active,a:active{transform:scale(.98)}.danger{color:var(--bad)}.refresh{display:flex;justify-content:space-between;gap:12px;align-items:center}.actions{display:flex;gap:8px;flex-wrap:wrap}.tab{display:none}.tab.active{display:block}.card{margin:12px 0}.card h2{font-size:30px;margin:8px 0}.smsSummary{position:relative}.sms header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.sms h3{margin:4px 0 0}.sms time,.sms footer{color:var(--muted);font-size:12px}.sms .body{white-space:pre-wrap;word-break:break-word;font-size:16px;color:var(--text)}.translation{border-left:3px solid var(--blue);padding-left:10px;color:var(--muted);font-size:14px}.quality{display:inline-block;padding:6px 10px;border-radius:999px;background:#34d39922;color:var(--good)}.codes{font-family:ui-monospace,Menlo,monospace}.bar{height:12px;background:#ffffff14;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--purple),var(--blue),var(--cyan));border-radius:inherit}.notice{color:var(--good)}.warning{color:#fbbf24}.empty{text-align:center}@media(max-width:520px){.topgrid{grid-template-columns:1fr}.hero h1{font-size:34px}.refresh{display:block}.actions{margin-top:12px}}`; }
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
