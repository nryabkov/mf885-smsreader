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

module.exports = { run };

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
  const challenge = headers["WWW-Authenticate"] || headers["www-authenticate"];
  if (!challenge) throw new Error("No authentication challenge. Check the ZMI Wi-Fi connection and router address.");
  const realm = digestValue(challenge, "realm");
  const nonce = digestValue(challenge, "nonce");
  const qop = digestValue(challenge, "qop") || "auth";
  if (!realm || !nonce) throw new Error("Could not parse the Digest authentication challenge");
  return { realm, nonce, qop, nc: 1, ha1: md5(`${USERNAME}:${realm}:${PASSWORD}`) };
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
function digestValue(header, key) { const hit = String(header).match(new RegExp(`${key}="?([^",]+)"?`, "i")); return hit ? hit[1] : ""; }
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
  const wan = tag(xml, "wan") || xml; const cellular = tag(wan, "cellular") || wan;
  const operator = firstText(wan, ["network_name", "ISP_name", "ISP", "operator_name"]);
  const mode = firstText(wan, ["data_conn_mode", "network_mode", "radio_mode", "rat"]);
  const raw = firstSigned(cellular, ["rsrp", "rssi", "signal_strength", "signalbar"]);
  let bars = null; if (raw !== null) bars = raw >= 0 && raw <= 5 ? Math.round(raw) : raw < 0 ? (raw < -105 ? 0 : raw < -95 ? 1 : raw < -85 ? 2 : raw < -75 ? 3 : raw < -65 ? 4 : 5) : null;
  return { operator, mode: mode || "Unknown mode", raw, bars };
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
  const smsCards = model.sms.messages.length ? model.sms.messages.map((item, index) => `
    <article class="card sms"><header><strong>${escapeHtml(item.phone || "Unknown sender")}</strong><span>${escapeHtml(item.date)}</span></header><p>${escapeHtml(item.content)}</p><footer>#${escapeHtml(item.row || index + 1)} · <button onclick="copy(this)">Copy text</button> <a class="danger" href="${runUrl("delete", "sms", { id: item.id })}">Delete</a></footer></article>`).join("") : `<article class="card empty"><h2>No SMS found</h2><p>${escapeHtml(model.errors.sms || "The inbox is empty.")}</p></article>`;
  const battery = model.battery || {}; const network = model.network || {}; const traffic = model.traffic || {};
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>ZMI Router</title><style>${css()}</style></head>
  <body><header class="hero"><small>ZMI ROUTER</small><h1>MF855 / MF885</h1><p>Automatic refresh every ${POLL_SECONDS} seconds</p><nav><button onclick="tab('sms')">SMS (${model.sms.messages.length})</button><button onclick="tab('router')">Router</button></nav></header>
  <main>${model.notice ? `<div class="notice">✓ ${escapeHtml(model.notice)}</div>` : ""}
    <section id="sms" class="tab"><div class="summary"><h2>All received SMS</h2><a href="${runUrl("send", "sms")}">Send SMS</a></div>${smsCards}${model.sms.warning ? `<div class="warning">⚠️ ${escapeHtml(model.sms.warning)}</div>` : ""}</section>
    <section id="router" class="tab"><article class="card"><small>CELLULAR NETWORK</small><h2>${escapeHtml(network.mode || "No data")}</h2><p>${escapeHtml(network.operator || "Operator unavailable")} · Signal ${network.bars === null || network.bars === undefined ? "—" : network.bars + "/5"}</p></article>
    <article class="card"><small>BATTERY</small><h2>${battery.percent === null || battery.percent === undefined ? "—" : battery.percent + "%"}</h2><p>${battery.charging ? "Charging" : escapeHtml(battery.status || "Status unavailable")}</p></article>
    <article class="card"><small>TOTAL MOBILE TRAFFIC</small><h2>${formatBytes(traffic.total)}</h2><p>Downloaded ${formatBytes(traffic.download)} · Uploaded ${formatBytes(traffic.upload)}</p><a class="danger" href="${runUrl("resetTraffic", "router")}">Reset traffic</a></article>
    <article class="card"><small>USSD</small><h2>${model.ussd.supported ? "Endpoint detected" : "Detection inconclusive"}</h2><p>${escapeHtml(model.errors.ussd || model.ussd.detail || "")}</p><a href="${runUrl("ussd", "router")}">Try USSD</a></article>
    <article class="card"><small>POWER</small><h2>System commands</h2><a href="${runUrl("reboot", "router")}">Restart</a> <a class="danger" href="${runUrl("powerOff", "router")}">Power off</a></article>${model.errors.status ? `<div class="warning">Status: ${escapeHtml(model.errors.status)}</div>` : ""}</section></main>
  <script>function tab(id){document.querySelectorAll('.tab').forEach(function(x){x.classList.toggle('active',x.id===id)});localStorage.zmiTab=id}tab(localStorage.zmiTab||${JSON.stringify(model.tab)});function copy(button){var value=button.closest('.sms').querySelector('p').innerText;navigator.clipboard.writeText(value)}setTimeout(function(){location.href=${JSON.stringify(runUrl("dashboard", model.tab))}},${POLL_SECONDS * 1000});</script></body></html>`;
}
function css() { return `:root{color-scheme:dark;--bg:#070b13;--panel:#182131;--text:#f4f7fb;--muted:#9aa4b5;--accent:#63e6ff;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;background:linear-gradient(#101827,var(--bg));color:var(--text);font-family:-apple-system,sans-serif;padding-bottom:30px}.hero{position:sticky;top:0;padding:calc(env(safe-area-inset-top) + 18px) 16px 12px;background:#070b13ee;border-bottom:1px solid #ffffff20}.hero small{color:var(--accent);font-weight:900}.hero h1{margin:5px 0}.hero p,.card p{color:var(--muted)}nav{display:flex;gap:8px}button,a{display:inline-block;border:1px solid #ffffff25;border-radius:999px;padding:9px 13px;background:#ffffff0d;color:var(--text);text-decoration:none;font:inherit}.danger{color:var(--bad)}main{max-width:720px;margin:auto;padding:14px}.tab{display:none}.tab.active{display:block}.summary{display:flex;align-items:center;justify-content:space-between}.card,.notice,.warning{margin-bottom:12px;padding:16px;border:1px solid #ffffff20;border-radius:20px;background:linear-gradient(#202a3b,var(--panel))}.card header{display:flex;justify-content:space-between;gap:10px}.card header span,.card footer{color:var(--muted);font-size:12px}.sms p{white-space:pre-wrap;word-break:break-word}.notice{color:#34d399}.warning{color:#fbbf24}.empty{text-align:center}`; }
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
