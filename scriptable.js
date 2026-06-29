// ZMI MF855 SMS Reader + Sender for Scriptable iPhone
// Reads SMS, shows a polished WebView, copies from message cards, and sends SMS.
//
// Important:
// This does NOT read or send SMS through iPhone Messages.
// It works with the SMS module in the ZMI/MF885 router.

const ROUTER_HOST = "192.168.21.1";
const USERNAME = "admin";
const PASSWORD = "YOUR_PASSWORD_HERE";
const PAGE = 1;

const DEBUG_RAW_XML = false;

await main();

async function main() {
  try {
    const action = await chooseAction();

    console.log("Getting auth challenge...");
    const auth = await getAuthChallenge();

    console.log("Logging in...");
    await login(auth);

    if (action === "send") {
      await sendFlow(auth);
      return;
    }

    await inboxFlow(auth);
  } catch (e) {
    console.error(String(e));

    await showSmsWebView([], {
      title: "ZMI SMS Error",
      subtitle: "Error",
      error: String(e)
    });
  }
}

// --------------------------------------------------
// App flows
// --------------------------------------------------

async function chooseAction() {
  const a = new Alert();
  a.title = "ZMI SMS";
  a.message = "What would you like to do?";

  a.addAction("Open inbox");
  a.addAction("Send SMS");
  a.addCancelAction("Cancel");

  const r = await a.presentSheet();

  if (r === 0) return "inbox";
  if (r === 1) return "send";
  throw new Error("Canceled");
}

async function inboxFlow(auth) {
  console.log("Reading SMS...");
  const xml = await getSms(PAGE, auth);

  if (DEBUG_RAW_XML) {
    console.log("Raw SMS XML:");
    console.log(xml);
  }

  const messages = parseSmsXml(xml);

  console.log(`Parsed SMS count: ${messages.length}`);

  if (!messages.length) {
    await showSmsWebView([], {
      title: "ZMI SMS",
      subtitle: "No SMS found",
      error: "The router responded, but no messages were found in the XML."
    });
    return;
  }

  await showSmsWebView(messages, {
    title: "ZMI SMS Inbox",
    subtitle: `Messages found: ${messages.length}`
  });
}

async function sendFlow(auth) {
  const draft = await askSmsDraft();

  if (!draft) {
    throw new Error("Sending canceled");
  }

  console.log("Sending SMS...");
  const resultXml = await sendSms(auth, draft.to, draft.text);

  console.log("Send SMS response:");
  console.log(resultXml);

  const sendResult = parseSendResult(resultXml);

  await showSendResultWebView({
    ok: sendResult.ok,
    title: sendResult.ok ? "SMS sent" : "SMS not sent",
    to: draft.to,
    text: draft.text,
    raw: resultXml,
    status: sendResult.status,
    message: sendResult.message
  });
}

async function askSmsDraft() {
  const a = new Alert();
  a.title = "Send SMS";
  a.message = "Enter the recipient number and message text.";

  a.addTextField("Number, for example +15551234567", "");
  a.addTextField("SMS text", "");

  a.addAction("Send");
  a.addCancelAction("Cancel");

  const r = await a.present();

  if (r === -1) return null;

  const to = a.textFieldValue(0).trim();
  const text = a.textFieldValue(1).trim();

  if (!to) {
    throw new Error("Recipient number is missing");
  }

  if (!text) {
    throw new Error("SMS text is missing");
  }

  return { to, text };
}

// --------------------------------------------------
// MF855 API
// --------------------------------------------------

async function getAuthChallenge() {
  const url = `http://${ROUTER_HOST}/login.cgi`;

  const req = new Request(url);
  req.method = "GET";
  req.headers = baseHeaders();

  let body = "";

  try {
    body = await req.loadString();
  } catch (e) {
    console.log("getAuthChallenge loadString error:");
    console.log(String(e));
  }

  const headers = req.response ? req.response.headers : {};
  const www =
    headers["WWW-Authenticate"] ||
    headers["www-authenticate"] ||
    headers["Www-Authenticate"];

  if (!www) {
    console.log("login.cgi body:");
    console.log(body);
    console.log("login.cgi headers:");
    console.log(JSON.stringify(headers, null, 2));

    throw new Error(
      "WWW-Authenticate was not found from /login.cgi. Check the router IP address and the connection to the ZMI Wi-Fi network."
    );
  }

  const realm = getDigestValue(www, "realm");
  const nonce = getDigestValue(www, "nonce");
  const qop = getDigestValue(www, "qop") || "auth";

  if (!realm || !nonce) {
    throw new Error("Could not parse the digest challenge: " + www);
  }

  return {
    realm,
    nonce,
    qop,
    nc: 1,
    ha1: md5(`${USERNAME}:${realm}:${PASSWORD}`)
  };
}

async function login(auth) {
  const cnonce = randomCnonce();

  const ha2 = md5("GET:/cgi/protected.cgi");

  const response = md5(
    `${auth.ha1}:${auth.nonce}:00000001:${cnonce}:${auth.qop}:${ha2}`
  );

  const params = formEncode({
    realm: auth.realm,
    nonce: auth.nonce,
    response,
    qop: auth.qop,
    cnonce,
    Action: "Digest",
    username: USERNAME,
    temp: "marvell"
  });

  const url = `http://${ROUTER_HOST}/login.cgi?${params}`;

  const req = new Request(url);
  req.method = "GET";
  req.headers = Object.assign({}, baseHeaders(), {
    Authorization: makeLoginAuthorization(auth, response, cnonce)
  });

  const text = await req.loadString();

  console.log("Login response:");
  console.log(text);

  auth.nc++;
  return text;
}

async function getSms(page, auth) {
  const xml =
    `<?xml version="1.0" encoding="US-ASCII"?>` +
    `<RGW>` +
      `<message>` +
        `<flag>` +
          `<message_flag>GET_RCV_SMS_LOCAL</message_flag>` +
        `</flag>` +
        `<get_message>` +
          `<page_number>${page}</page_number>` +
        `</get_message>` +
      `</message>` +
    `</RGW>`;

  return await postXmlAction(auth, xml);
}

async function sendSms(auth, to, text) {
  const encodedText = encodeUtf16BeHex(text);
  const smsTime = makeSmsTime();

  const xml =
    `<?xml version="1.0" encoding="US-ASCII"?>` +
    `<RGW>` +
      `<message>` +
        `<flag>` +
          `<message_flag>SEND_SMS</message_flag>` +
          `<sms_cmd>4</sms_cmd>` +
        `</flag>` +
        `<send_save_message>` +
          `<contacts>${escapeXml(to)}</contacts>` +
          `<content>${encodedText}</content>` +
          `<encode_type>GSM7_default</encode_type>` +
          `<sms_time>${smsTime}</sms_time>` +
        `</send_save_message>` +
      `</message>` +
    `</RGW>`;

  return await postXmlAction(auth, xml);
}

async function postXmlAction(auth, xml) {
  const path = "/xml_action.cgi?method=set&module=duster&file=message";
  const url = `http://${ROUTER_HOST}${path}`;

  const req = new Request(url);
  req.method = "POST";
  req.headers = Object.assign({}, baseHeaders(), {
    Authorization: makeXmlAuthorization(auth, "POST"),
    "X-Requested-With": "XMLHttpRequest",
    Cookie: "locale=cn; hard_ver=Ver.A; platform=mifi",
    "Content-Type": "application/xml"
  });
  req.body = xml;

  const text = await req.loadString();

  auth.nc++;
  return text;
}

// --------------------------------------------------
// Digest auth helpers
// --------------------------------------------------

function makeLoginAuthorization(auth, response, cnonce) {
  return [
    `Digest username="${USERNAME}"`,
    `realm="${auth.realm}"`,
    `nonce="${auth.nonce}"`,
    `uri="/cgi/protected.cgi"`,
    `response="${response}"`,
    `qop=${auth.qop}`,
    `nc=00000001`,
    `cnonce="${cnonce}"`
  ].join(", ");
}

function makeXmlAuthorization(auth, method) {
  const nc = padNc(auth.nc);
  const cnonce = randomCnonce();

  const ha2 = md5(`${method}:/cgi/xml_action.cgi`);

  const response = md5(
    `${auth.ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${ha2}`
  );

  return [
    `Digest username="${USERNAME}"`,
    `realm="${auth.realm}"`,
    `nonce="${auth.nonce}"`,
    `uri="/cgi/xml_action.cgi"`,
    `response="${response}"`,
    `qop=${auth.qop}`,
    `nc=${nc}`,
    `cnonce="${cnonce}"`
  ].join(", ");
}

function getDigestValue(header, key) {
  const re = new RegExp(`${key}="?([^",]+)"?`, "i");
  const m = header.match(re);
  return m ? m[1] : "";
}

function randomCnonce() {
  return md5(
    String(Math.floor(Math.random() * 100001)) +
    String(Date.now())
  ).substring(0, 16);
}

function padNc(n) {
  return String(n).padStart(8, "0");
}

function baseHeaders() {
  return {
    Expires: "-1",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache"
  };
}

function formEncode(obj) {
  return Object.keys(obj)
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k]))
    .join("&");
}

// --------------------------------------------------
// Send helpers
// --------------------------------------------------

function encodeUtf16BeHex(text) {
  let out = "";

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code.toString(16).padStart(4, "0").toUpperCase();
  }

  return out;
}

function makeSmsTime() {
  const d = new Date();

  const yy = d.getFullYear() % 100;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hour = d.getHours();
  const minute = d.getMinutes();
  const second = d.getSeconds();

  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "%2B" : "-";
  const absMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absMinutes / 60);

  return [
    yy,
    month,
    day,
    hour,
    minute,
    second,
    `${sign}${offsetHours}`
  ].join(",");
}

function parseSendResult(xml) {
  const flag = tag(xml, "message_flag");
  const status = tag(xml, "sms_cmd_status_result") || tag(xml, "send_status") || "";
  const result = tag(xml, "sms_result") || "";

  // On the MF855, a successful response can differ between firmware versions.
  // Often, the absence of an explicit error already means the command was accepted.
  const lower = String(xml).toLowerCase();

  const hasError =
    lower.includes("error") ||
    lower.includes("fail") ||
    status === "0" ||
    status === "2";

  const ok =
    !hasError &&
    (
      flag === "SEND_SMS" ||
      lower.includes("send_sms") ||
      status === "3" ||
      status === "4" ||
      result === "" ||
      result === "0"
    );

  return {
    ok,
    status,
    message: ok
      ? "The SMS send command was accepted by the router."
      : "The router returned a response that looks like a sending error."
  };
}

function escapeXml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --------------------------------------------------
// SMS XML parsing
// --------------------------------------------------

function parseSmsXml(xml) {
  const blocks = [];

  const itemRegex = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const attrs = match[1] || "";
    const body = match[2] || "";
    const displayIndex = getAttr(attrs, "index");
    blocks.push({ displayIndex, body });
  }

  console.log(`Parsed Item blocks: ${blocks.length}`);

  return blocks.map((item, i) => {
    const b = item.body;

    const rawId =
      tag(b, "index") ||
      item.displayIndex ||
      String(i + 1);

    const rawFrom =
      tag(b, "from") ||
      tag(b, "contacts") ||
      tag(b, "phone_number") ||
      tag(b, "number") ||
      "";

    const rawSubject =
      tag(b, "subject") ||
      tag(b, "content") ||
      tag(b, "message_content") ||
      "";

    const rawDate =
      tag(b, "received") ||
      tag(b, "sms_time") ||
      tag(b, "time") ||
      tag(b, "date") ||
      "";

    const rawStatus = tag(b, "status") || "";
    const rawMessageType = tag(b, "message_type") || "";

    const phone = cleanupSender(decodeZmiSms(rawFrom));
    const content = decodeZmiSms(rawSubject);

    return {
      row: item.displayIndex || String(i + 1),
      id: decodeZmiSms(rawId),
      phone,
      date: formatSmsTime(rawDate),
      content,
      status: rawStatus,
      messageType: rawMessageType,
      preview: makePreview(content)
    };
  }).filter(m => m.id || m.phone || m.content);
}

function getAttr(attrs, name) {
  const re = new RegExp(`${name}=["']([^"']+)["']`, "i");
  const m = String(attrs).match(re);
  return m ? m[1] : "";
}

function tag(xml, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = String(xml).match(re);
  return m ? htmlDecode(m[1].trim()) : "";
}

function decodeZmiSms(s) {
  if (!s) return "";

  s = String(s).trim();

  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 4 === 0) {
    let out = "";

    for (let i = 0; i < s.length; i += 4) {
      const code = parseInt(s.slice(i, i + 4), 16);

      if (code !== 0) {
        out += String.fromCharCode(code);
      }
    }

    return htmlDecode(out);
  }

  return htmlDecode(s);
}

function cleanupSender(s) {
  if (!s) return "";

  return s
    .replace(/^;\s*/, "")
    .trim();
}

function formatSmsTime(s) {
  if (!s) return "";

  const parts = String(s).split(",");

  if (parts.length >= 6) {
    return `20${pad2(parts[0])}-${pad2(parts[1])}-${pad2(parts[2])} ${pad2(parts[3])}:${pad2(parts[4])}:${pad2(parts[5])}`;
  }

  return s;
}

function pad2(v) {
  return String(v).padStart(2, "0");
}

function makePreview(text) {
  const clean = String(text || "")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.length <= 90) return clean;
  return clean.slice(0, 90) + "…";
}

function htmlDecode(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, `"`)
    .replace(/&#39;/g, "'");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --------------------------------------------------
// WebView UI
// --------------------------------------------------

async function showSmsWebView(messages, options) {
  const html = buildSmsHtml(messages, options || {});
  const webView = new WebView();
  await webView.loadHTML(html);
  await webView.present();
}

async function showSendResultWebView(result) {
  const html = buildSendResultHtml(result);
  const webView = new WebView();
  await webView.loadHTML(html);
  await webView.present();
}

function sharedCss() {
  return `
    :root {
      color-scheme: dark;
      --bg: #080b12;
      --bg2: #101727;
      --card: rgba(255, 255, 255, 0.08);
      --card2: rgba(255, 255, 255, 0.12);
      --text: #f5f7fb;
      --muted: rgba(245, 247, 251, 0.62);
      --muted2: rgba(245, 247, 251, 0.42);
      --border: rgba(255, 255, 255, 0.12);
      --accent: #6ee7ff;
      --accent2: #8b5cf6;
      --good: #34d399;
      --danger: #fb7185;
      --shadow: rgba(0, 0, 0, 0.35);
    }

    * {
      box-sizing: border-box;
      -webkit-tap-highlight-color: transparent;
    }

    html,
    body {
      margin: 0;
      min-height: 100%;
      background:
        radial-gradient(circle at top left, rgba(110, 231, 255, 0.18), transparent 35%),
        radial-gradient(circle at top right, rgba(139, 92, 246, 0.20), transparent 35%),
        linear-gradient(180deg, var(--bg2), var(--bg));
      color: var(--text);
      font-family:
        -apple-system,
        BlinkMacSystemFont,
        "SF Pro Display",
        "SF Pro Text",
        Helvetica,
        Arial,
        sans-serif;
    }

    body {
      padding:
        calc(env(safe-area-inset-top) + 18px)
        16px
        calc(env(safe-area-inset-bottom) + 24px);
    }

    .app {
      max-width: 760px;
      margin: 0 auto;
    }

    .hero {
      position: sticky;
      top: 0;
      z-index: 10;
      margin: -18px -16px 18px;
      padding:
        calc(env(safe-area-inset-top) + 18px)
        16px
        16px;
      background:
        linear-gradient(180deg, rgba(8, 11, 18, 0.96), rgba(8, 11, 18, 0.76)),
        radial-gradient(circle at top left, rgba(110, 231, 255, 0.16), transparent 45%);
      backdrop-filter: blur(18px);
      -webkit-backdrop-filter: blur(18px);
      border-bottom: 1px solid var(--border);
    }

    .hero-inner {
      max-width: 760px;
      margin: 0 auto;
    }

    .top-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .title-block {
      min-width: 0;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: var(--good);
      box-shadow: 0 0 18px var(--good);
    }

    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.05;
      letter-spacing: -0.04em;
    }

    .subtitle {
      margin-top: 6px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.35;
    }

    .counter {
      flex: 0 0 auto;
      min-width: 58px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: 0 12px 34px var(--shadow);
      text-align: center;
    }

    .counter-number {
      display: block;
      font-size: 22px;
      font-weight: 800;
      line-height: 1;
    }

    .counter-label {
      display: block;
      margin-top: 3px;
      color: var(--muted2);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .search-wrap {
      margin-top: 16px;
      position: relative;
    }

    .search {
      width: 100%;
      appearance: none;
      border: 1px solid var(--border);
      outline: none;
      border-radius: 18px;
      padding: 14px 44px 14px 16px;
      background: rgba(255, 255, 255, 0.09);
      color: var(--text);
      font-size: 16px;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .search::placeholder {
      color: var(--muted2);
    }

    .search-icon {
      position: absolute;
      right: 15px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--muted2);
      font-size: 18px;
    }

    .actions {
      display: flex;
      gap: 10px;
      margin-top: 12px;
      overflow-x: auto;
      padding-bottom: 2px;
    }

    .btn {
      flex: 0 0 auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 10px 13px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      font-size: 13px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      user-select: none;
    }

    .btn.primary {
      background:
        linear-gradient(135deg, rgba(110, 231, 255, 0.24), rgba(139, 92, 246, 0.24));
      border-color: rgba(110, 231, 255, 0.28);
    }

    .list {
      display: grid;
      gap: 12px;
    }

    .card {
      border: 1px solid var(--border);
      border-radius: 24px;
      background:
        linear-gradient(180deg, var(--card2), var(--card));
      box-shadow:
        0 16px 44px var(--shadow),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 16px 10px;
    }

    .sender {
      min-width: 0;
    }

    .sender-name {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 18px;
      font-weight: 800;
      letter-spacing: -0.02em;
      word-break: break-word;
    }

    .avatar {
      flex: 0 0 auto;
      width: 34px;
      height: 34px;
      border-radius: 13px;
      display: inline-grid;
      place-items: center;
      background:
        linear-gradient(135deg, rgba(110, 231, 255, 0.26), rgba(139, 92, 246, 0.30));
      border: 1px solid rgba(255, 255, 255, 0.14);
      font-size: 15px;
      font-weight: 900;
    }

    .date {
      margin-top: 6px;
      color: var(--muted);
      font-size: 13px;
    }

    .badge {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(110, 231, 255, 0.12);
      border: 1px solid rgba(110, 231, 255, 0.20);
      color: var(--accent);
      font-size: 12px;
      font-weight: 800;
    }

    .message {
      padding: 0 16px 14px;
      color: rgba(245, 247, 251, 0.92);
      font-size: 16px;
      line-height: 1.48;
      white-space: pre-wrap;
      word-break: break-word;
      user-select: text;
      -webkit-user-select: text;
    }

    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 0 16px 14px;
    }

    .mini-btn {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 8px 11px;
      background: rgba(255, 255, 255, 0.08);
      color: var(--text);
      font-size: 12px;
      font-weight: 800;
      cursor: pointer;
    }

    .mini-btn.primary {
      background:
        linear-gradient(135deg, rgba(110, 231, 255, 0.20), rgba(139, 92, 246, 0.20));
      border-color: rgba(110, 231, 255, 0.24);
    }

    .mini-btn:active,
    .btn:active {
      transform: scale(0.97);
      opacity: 0.8;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 11px 16px 14px;
      border-top: 1px solid var(--border);
      background: rgba(0, 0, 0, 0.10);
    }

    .pill {
      max-width: 100%;
      border-radius: 999px;
      padding: 7px 10px;
      background: rgba(255, 255, 255, 0.07);
      color: var(--muted);
      font-size: 12px;
      line-height: 1.2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .empty {
      border: 1px solid var(--border);
      border-radius: 28px;
      padding: 32px 22px;
      background: rgba(255, 255, 255, 0.08);
      text-align: center;
      box-shadow: 0 16px 44px var(--shadow);
    }

    .empty-icon {
      font-size: 44px;
      margin-bottom: 12px;
    }

    .empty-title {
      font-size: 22px;
      font-weight: 850;
      letter-spacing: -0.03em;
    }

    .empty-text {
      margin-top: 8px;
      color: var(--muted);
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .hidden {
      display: none !important;
    }

    .raw {
      display: none;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: calc(env(safe-area-inset-bottom) + 18px);
      transform: translateX(-50%) translateY(20px);
      opacity: 0;
      z-index: 99;
      padding: 11px 14px;
      border-radius: 999px;
      background: rgba(245, 247, 251, 0.92);
      color: #0b1020;
      font-size: 13px;
      font-weight: 800;
      box-shadow: 0 14px 38px rgba(0, 0, 0, 0.35);
      transition: 180ms ease;
      pointer-events: none;
      white-space: nowrap;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .result-card {
      border: 1px solid var(--border);
      border-radius: 28px;
      padding: 22px;
      background:
        linear-gradient(180deg, var(--card2), var(--card));
      box-shadow:
        0 16px 44px var(--shadow),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
    }

    .result-icon {
      font-size: 44px;
      margin-bottom: 12px;
    }

    .result-title {
      font-size: 26px;
      font-weight: 900;
      letter-spacing: -0.04em;
      margin-bottom: 8px;
    }

    .result-text {
      color: var(--muted);
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .raw-box {
      margin-top: 14px;
      padding: 12px;
      border-radius: 16px;
      background: rgba(0, 0, 0, 0.22);
      border: 1px solid var(--border);
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 260px;
      overflow: auto;
    }

    @media (prefers-color-scheme: light) {
      :root {
        color-scheme: light;
        --bg: #eef3ff;
        --bg2: #f7f9ff;
        --card: rgba(255, 255, 255, 0.78);
        --card2: rgba(255, 255, 255, 0.92);
        --text: #101422;
        --muted: rgba(16, 20, 34, 0.64);
        --muted2: rgba(16, 20, 34, 0.42);
        --border: rgba(16, 20, 34, 0.10);
        --shadow: rgba(42, 58, 92, 0.16);
      }

      .hero {
        background:
          linear-gradient(180deg, rgba(247, 249, 255, 0.96), rgba(247, 249, 255, 0.78)),
          radial-gradient(circle at top left, rgba(110, 231, 255, 0.20), transparent 45%);
      }
    }
  `;
}

function buildSmsHtml(messages, options) {
  const title = options.title || "ZMI SMS";
  const subtitle = options.subtitle || "";
  const error = options.error || "";

  const cardsHtml = messages.length
    ? messages.map(renderSmsCard).join("\n")
    : renderEmptyState(error);

  const jsonForCopy = escapeHtml(
    JSON.stringify(messages, null, 2)
  );

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover"
  >
  <title>${escapeHtml(title)}</title>
  <style>${sharedCss()}</style>
</head>
<body>
  <div class="hero">
    <div class="hero-inner">
      <div class="top-row">
        <div class="title-block">
          <div class="eyebrow">
            <span class="dot"></span>
            ZMI Router
          </div>
          <h1>${escapeHtml(title)}</h1>
          <div class="subtitle">${escapeHtml(subtitle)}</div>
        </div>

        <div class="counter">
          <span class="counter-number" id="visibleCount">${messages.length}</span>
          <span class="counter-label">SMS</span>
        </div>
      </div>

      ${
        messages.length
          ? `
            <div class="search-wrap">
              <input
                id="search"
                class="search"
                type="search"
                placeholder="Search by sender and text…"
                autocomplete="off"
              >
              <div class="search-icon">⌕</div>
            </div>

            <div class="actions">
              <button class="btn primary" onclick="copyAll()">Copy all</button>
              <button class="btn" onclick="scrollToTop()">Top</button>
              <button class="btn" onclick="scrollToBottom()">Bottom</button>
              <button class="btn" onclick="clearSearch()">Clear search</button>
            </div>
          `
          : ""
      }
    </div>
  </div>

  <main class="app">
    <section id="list" class="list">
      ${cardsHtml}
    </section>
  </main>

  <textarea id="raw" class="raw">${jsonForCopy}</textarea>
  <div id="toast" class="toast">Copied</div>

  <script>
    const search = document.getElementById("search");
    const visibleCount = document.getElementById("visibleCount");
    const cards = Array.from(document.querySelectorAll(".card"));

    if (search) {
      search.addEventListener("input", () => {
        const q = search.value.trim().toLowerCase();
        let count = 0;

        cards.forEach(card => {
          const haystack = card.dataset.search || "";
          const visible = !q || haystack.includes(q);
          card.classList.toggle("hidden", !visible);
          if (visible) count++;
        });

        visibleCount.textContent = String(count);
      });
    }

    function copyAll() {
      const raw = document.getElementById("raw").value;
      copyToClipboard(raw, "Copied all SMS");
    }

    function copyCardText(button) {
      const card = button.closest(".card");
      if (!card) return;

      const message = card.querySelector(".message");
      const text = message ? message.innerText.trim() : "";

      copyToClipboard(text, "SMS text copied");
    }

    function copyCardFull(button) {
      const card = button.closest(".card");
      if (!card) return;

      const text = card.dataset.copy || "";

      copyToClipboard(text, "SMS copied");
    }

    function copyToClipboard(text, toastText) {
      if (!text) {
        showToast("Nothing to copy");
        return;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showToast(toastText || "Copied");
        }).catch(() => {
          fallbackCopy(text, toastText);
        });
      } else {
        fallbackCopy(text, toastText);
      }
    }

    function fallbackCopy(text, toastText) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        document.execCommand("copy");
        showToast(toastText || "Copied");
      } catch (e) {
        showToast("Copy failed");
      }

      document.body.removeChild(textarea);
    }

    function scrollToTop() {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function scrollToBottom() {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }

    function clearSearch() {
      if (!search) return;
      search.value = "";
      search.dispatchEvent(new Event("input"));
      search.focus();
    }

    function showToast(text) {
      const toast = document.getElementById("toast");
      toast.textContent = text;
      toast.classList.add("show");

      setTimeout(() => {
        toast.classList.remove("show");
      }, 1400);
    }
  </script>
</body>
</html>
  `;
}

function renderSmsCard(message, index) {
  const phone = message.phone || "Unknown";
  const date = message.date || "";
  const content = message.content || "";
  const initials = makeInitials(phone);
  const searchable = [
    phone,
    date,
    content,
    message.id || "",
    message.row || ""
  ].join(" ").toLowerCase();

  const copyText = [
    `From: ${phone}`,
    `Date: ${date}`,
    "",
    content
  ].join("\n");

  return `
<article
  class="card"
  data-search="${escapeHtml(searchable)}"
  data-copy="${escapeHtml(copyText)}"
>
  <div class="card-header">
    <div class="sender">
      <div class="sender-name">
        <span class="avatar">${escapeHtml(initials)}</span>
        <span>${escapeHtml(phone)}</span>
      </div>
      <div class="date">${escapeHtml(date)}</div>
    </div>

    <div class="badge">#${escapeHtml(message.row || String(index + 1))}</div>
  </div>

  <div class="message">${escapeHtml(content)}</div>

  <div class="card-actions">
    <button class="mini-btn primary" onclick="copyCardText(this)">Copy text</button>
    <button class="mini-btn" onclick="copyCardFull(this)">Copy full</button>
  </div>

  <div class="meta">
    <div class="pill">Router ID: ${escapeHtml(message.id || "—")}</div>
    ${
      message.status
        ? `<div class="pill">Status: ${escapeHtml(message.status)}</div>`
        : ""
    }
    ${
      message.messageType
        ? `<div class="pill">Type: ${escapeHtml(message.messageType)}</div>`
        : ""
    }
  </div>
</article>
  `;
}

function renderEmptyState(error) {
  return `
<div class="empty">
  <div class="empty-icon">${error ? "⚠️" : ""}</div>
  <div class="empty-title">${error ? "Could not read SMS" : "No SMS found"}</div>
  <div class="empty-text">${escapeHtml(error || "The router response does not contain messages to display.")}</div>
</div>
  `;
}

function buildSendResultHtml(result) {
  const rawForCopy = escapeHtml(result.raw || "");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover"
  >
  <title>${escapeHtml(result.title)}</title>
  <style>${sharedCss()}</style>
</head>
<body>
  <div class="hero">
    <div class="hero-inner">
      <div class="top-row">
        <div class="title-block">
          <div class="eyebrow">
            <span class="dot"></span>
            ZMI Router
          </div>
          <h1>${escapeHtml(result.title)}</h1>
          <div class="subtitle">Sending SMS through MF855</div>
        </div>

        <div class="counter">
          <span class="counter-number">${result.ok ? "✓" : "!"}</span>
          <span class="counter-label">${result.ok ? "OK" : "ERR"}</span>
        </div>
      </div>
    </div>
  </div>

  <main class="app">
    <div class="result-card">
      <div class="result-icon">${result.ok ? "✅" : "⚠️"}</div>
      <div class="result-title">${escapeHtml(result.title)}</div>
      <div class="result-text">${escapeHtml(result.message || "")}</div>

      <div class="meta" style="margin: 16px -22px -8px; border-bottom: 1px solid var(--border);">
        <div class="pill">To: ${escapeHtml(result.to || "")}</div>
        ${
          result.status
            ? `<div class="pill">Status: ${escapeHtml(result.status)}</div>`
            : ""
        }
      </div>

      <div style="height: 18px"></div>

      <div class="message" style="padding: 0; margin-bottom: 14px;">${escapeHtml(result.text || "")}</div>

      <div class="card-actions" style="padding: 0;">
        <button class="mini-btn primary" onclick="copyText()">Copy text</button>
        <button class="mini-btn" onclick="copyRaw()">Copy raw response</button>
      </div>

      <div class="raw-box">${escapeHtml(result.raw || "")}</div>
    </div>
  </main>

  <textarea id="raw" class="raw">${rawForCopy}</textarea>
  <textarea id="smsText" class="raw">${escapeHtml(result.text || "")}</textarea>
  <div id="toast" class="toast">Copied</div>

  <script>
    function copyText() {
      copyToClipboard(document.getElementById("smsText").value, "SMS text copied");
    }

    function copyRaw() {
      copyToClipboard(document.getElementById("raw").value, "Raw response copied");
    }

    function copyToClipboard(text, toastText) {
      if (!text) {
        showToast("Nothing to copy");
        return;
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          showToast(toastText || "Copied");
        }).catch(() => {
          fallbackCopy(text, toastText);
        });
      } else {
        fallbackCopy(text, toastText);
      }
    }

    function fallbackCopy(text, toastText) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      textarea.style.top = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      try {
        document.execCommand("copy");
        showToast(toastText || "Copied");
      } catch (e) {
        showToast("Copy failed");
      }

      document.body.removeChild(textarea);
    }

    function showToast(text) {
      const toast = document.getElementById("toast");
      toast.textContent = text;
      toast.classList.add("show");

      setTimeout(() => {
        toast.classList.remove("show");
      }, 1400);
    }
  </script>
</body>
</html>
  `;
}

function makeInitials(text) {
  const s = String(text || "").trim();

  if (!s) return "?";

  if (/^\+?\d/.test(s)) {
    return "#";
  }

  const cleaned = s
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();

  if (!cleaned) return s.slice(0, 1).toUpperCase();

  const parts = cleaned.split(/\s+/).filter(Boolean);

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return (parts[0].slice(0, 1) + parts[1].slice(0, 1)).toUpperCase();
}

// --------------------------------------------------
// Pure JS MD5
// --------------------------------------------------

function md5(input) {
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }

  function ff(a, b, c, d, x, s, t) {
    return cmn((b & c) | ((~b) & d), a, b, x, s, t);
  }

  function gg(a, b, c, d, x, s, t) {
    return cmn((b & d) | (c & (~d)), a, b, x, s, t);
  }

  function hh(a, b, c, d, x, s, t) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }

  function ii(a, b, c, d, x, s, t) {
    return cmn(c ^ (b | (~d)), a, b, x, s, t);
  }

  function md5cycle(x, k) {
    let a = x[0], b = x[1], c = x[2], d = x[3];

    a = ff(a, b, c, d, k[0], 7, -680876936);
    d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);
    b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);
    d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341);
    b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);
    d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);
    b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);
    d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);
    b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);
    d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);
    b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);
    d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335);
    b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);
    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);
    b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467);
    d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);
    b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);
    d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562);
    b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);
    d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);
    b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);
    d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);
    b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);
    d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);
    b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);
    d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);
    b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);
    d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);
    b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);
    d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380);
    b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);
    d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);
    b = ii(b, c, d, a, k[9], 21, -343485551);

    x[0] = add32(a, x[0]);
    x[1] = add32(b, x[1]);
    x[2] = add32(c, x[2]);
    x[3] = add32(d, x[3]);
  }

  function md5blk(s) {
    const md5blks = [];
    for (let i = 0; i < 64; i += 4) {
      md5blks[i >> 2] =
        s.charCodeAt(i) +
        (s.charCodeAt(i + 1) << 8) +
        (s.charCodeAt(i + 2) << 16) +
        (s.charCodeAt(i + 3) << 24);
    }
    return md5blks;
  }

  function md51(s) {
    s = unescape(encodeURIComponent(s));

    let n = s.length;
    let state = [1732584193, -271733879, -1732584194, 271733878];
    let i;

    for (i = 64; i <= n; i += 64) {
      md5cycle(state, md5blk(s.substring(i - 64, i)));
    }

    s = s.substring(i - 64);

    const tail = new Array(16).fill(0);

    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }

    tail[i >> 2] |= 0x80 << ((i % 4) << 3);

    if (i > 55) {
      md5cycle(state, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }

    tail[14] = n * 8;
    md5cycle(state, tail);

    return state;
  }

  function rhex(n) {
    let s = "";
    for (let j = 0; j < 4; j++) {
      s +=
        ((n >> (j * 8 + 4)) & 0x0f).toString(16) +
        ((n >> (j * 8)) & 0x0f).toString(16);
    }
    return s;
  }

  function hex(x) {
    return x.map(rhex).join("");
  }

  function add32(a, b) {
    return (a + b) & 0xffffffff;
  }

  return hex(md51(input));
}
