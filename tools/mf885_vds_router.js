"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const core = require("./mf885_vds_restore_core.js");
const dryRun = require("../modules/firmware-restore-dry-run.js");
const powerStatus = require("../modules/power-status.js");

const ROUTER_HOST = "192.168.21.1";
const ROUTER_PORT = 80;
const USERNAME = "admin";
const DEFAULT_PASSWORD = "zimifi";
const EXACT_MODEL = "LV01";
const EXACT_HARDWARE = "MF96 Ver.D";
const EXACT_FIRMWARE = "2.5.94_release_MF855_NZ_CP_2.129.003";
const GOLDEN_BYTES = 8323644;
const GOLDEN_MULTIPART_FILENAME = "MF885_firmware_backup_20260808_095130.bin";
const GOLDEN_BODY_SHA256 = "5a58dbb564229dc118d305c51dfbb4ecb925075574086aeb86bb05e1add39d22";
const SETTINGS_MODELS = Object.freeze([
  "wan",
  "wlan_settings",
  "wlan_primary_network_security_settings",
  "uapx_wlan_basic_settings",
  "uapx_wlan_security_settings",
  "uapxb_wlan_basic_settings",
  "uapxb_wlan_security_settings"
]);
const STOCK_EXPORT_UNAVAILABLE_PROOF = Object.freeze({
  schema: "mf885-stock-config-export-unavailable/v1",
  provenance: "reviewed-live-project-session-2026-08-21",
  fetch: Object.freeze({ httpStatus: 200, bytes: 0, redirected: false }),
  rawHttp: Object.freeze({ httpStatus: 200, bytes: 0, redirected: false }),
  stockBrowser: Object.freeze({ stockDoLogin: true, stockGetHeader: true, formSubmitted: true, waitMs: 30000, downloadWillBegin: false, filesCreated: 0 }),
  safety: Object.freeze({ configurationDownloadPostsAttempted: 3, routerStateWritesAttempted: 0, restorePostsAttempted: 0, automaticRetries: 0 })
});
const BASE_HEADERS = Object.freeze({
  "Expires": "-1",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Pragma": "no-cache"
});

class RouterReadError extends Error {
  constructor(message, code = "ROUTER_READ_FAILED", details = {}) {
    super(message);
    this.name = "RouterReadError";
    this.code = code;
    this.details = details;
  }
}

function firstText(xml, names) {
  const source = String(xml || "");
  for (const name of names) {
    const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return String(match[1]).replace(/<[^>]+>/g, "").trim();
  }
  return "";
}

function firstSection(xml, name) {
  const match = String(xml || "").match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return match ? match[0] : "";
}

function parseDigestParameters(header) {
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
      const start = offset;
      while (offset < source.length && source[offset] !== ",") offset++;
      value = source.slice(start, offset).trim();
    }
    result[key] = value;
  }
  const qops = String(result.qop || "").split(",").map(value => value.trim().toLowerCase());
  if (!result.realm || !result.nonce || !qops.includes("auth")) throw new RouterReadError("The router Digest challenge is incomplete or unsupported.", "ROUTER_AUTH_CHALLENGE_INVALID");
  return Object.freeze({ realm: result.realm, nonce: result.nonce, qop: "auth", opaque: result.opaque || "" });
}

function md5(value) {
  return crypto.createHash("md5").update(String(value), "utf8").digest("hex");
}

function digestProof(auth, password, uri, nonceCount, cnonce, method = "GET") {
  const nc = Number(nonceCount).toString(16).padStart(8, "0");
  const normalizedMethod = String(method).toUpperCase();
  if (!/^(?:GET|POST)$/.test(normalizedMethod)) throw new RouterReadError("Digest proof method is invalid.");
  const ha1 = md5(`${USERNAME}:${auth.realm}:${password}`);
  const response = md5(`${ha1}:${auth.nonce}:${nc}:${cnonce}:${auth.qop}:${md5(`${normalizedMethod}:${uri}`)}`);
  return Object.freeze({ method: normalizedMethod, uri, nc, cnonce, response });
}

function appLoginEnvelope(challenge, password) {
  const queryProof = digestProof(challenge, password, "/cgi/protected.cgi", 2, crypto.randomBytes(8).toString("hex"));
  const headerProof = digestProof(challenge, password, "/cgi/xml_action.cgi", 3, crypto.randomBytes(8).toString("hex"));
  const query = new URLSearchParams({
    Action: "Digest",
    username: USERNAME,
    realm: challenge.realm,
    nonce: challenge.nonce,
    response: queryProof.response,
    qop: challenge.qop,
    cnonce: queryProof.cnonce,
    temp: "marvell",
    client: "APP"
  }).toString();
  const authorization = `Digest username="${USERNAME}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${headerProof.uri}", response="${headerProof.response}", qop=${challenge.qop}, nc=${headerProof.nc}, cnonce="${headerProof.cnonce}", client=APP`;
  return Object.freeze({ query, authorization });
}

function digestHeader(challenge, proof, client = "") {
  const opaque = challenge.opaque ? `, opaque="${challenge.opaque}"` : "";
  const suffix = client ? `, client=${client}` : "";
  return `Digest username="${USERNAME}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${proof.uri}", response="${proof.response}", qop=${challenge.qop}, nc=${proof.nc}, cnonce="${proof.cnonce}"${opaque}${suffix}`;
}

function webLoginEnvelope(challenge, password) {
  const queryProof = digestProof(challenge, password, "/cgi/protected.cgi", 1, crypto.randomBytes(8).toString("hex"));
  const headerProof = digestProof(challenge, password, "/cgi/xml_action.cgi", 1, crypto.randomBytes(8).toString("hex"));
  const query = new URLSearchParams({
    realm: challenge.realm,
    nonce: challenge.nonce,
    response: queryProof.response,
    qop: challenge.qop,
    cnonce: queryProof.cnonce,
    Action: "Digest",
    username: USERNAME,
    temp: "marvell"
  }).toString();
  return Object.freeze({ query, authorization: digestHeader(challenge, headerProof), queryProof, headerProof });
}

function assertSafeGetPath(value, options = {}) {
  const requestPath = String(value || "");
  if (!requestPath.startsWith("/") || /[\r\n]/.test(requestPath)) throw new RouterReadError("Router GET path is invalid.", "ROUTER_GET_REFUSED");
  const forbidden = /Action=(?:RestoreFw|Upload)|method=set|file=(?:reset|poweroff|restore_defaults)|Action=BackupFwStart/i;
  if (forbidden.test(requestPath) && !(options.allowBackupStart === true && /\?Action=BackupFwStart$/.test(requestPath))) {
    throw new RouterReadError("Router GET safety allowlist refused a state-changing route.", "ROUTER_GET_REFUSED");
  }
  return requestPath;
}

function scopedCookies(headers, host) {
  const values = headers && headers["set-cookie"];
  const source = Array.isArray(values) ? values : values ? [values] : [];
  const pairs = [];
  for (const value of source) {
    const parts = String(value).split(";");
    const pair = String(parts.shift() || "").trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[^;\r\n\x00-\x1f\x7f]*$/.test(pair)) continue;
    let cookiePath = "/", domain = host, secure = false;
    for (const part of parts) {
      const [rawName, ...rest] = part.trim().split("=");
      const name = rawName.toLowerCase(), item = rest.join("=").trim();
      if (name === "path") cookiePath = item || "/";
      else if (name === "domain") domain = item.replace(/^\./, "").toLowerCase();
      else if (name === "secure") secure = true;
    }
    if (secure || cookiePath !== "/" || !(host === domain || host.endsWith(`.${domain}`))) continue;
    pairs.push(pair);
  }
  return pairs.join("; ");
}

function routerGetOnce(input = {}) {
  const host = String(input.host || ROUTER_HOST);
  if (net.isIP(host) !== 4) return Promise.reject(new RouterReadError("Router host must be a literal IPv4 address."));
  const port = Number(input.port === undefined ? ROUTER_PORT : input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new RouterReadError("Router port is invalid."));
  let requestPath;
  try { requestPath = assertSafeGetPath(input.path, { allowBackupStart: input.allowBackupStart === true }); }
  catch (error) { return Promise.reject(error); }
  const timeoutMs = Number(input.timeoutMs || 10000);
  const maxBytes = Number(input.maxBytes || 1024 * 1024);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 300000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16 * 1024 * 1024) {
    return Promise.reject(new RouterReadError("Router GET limits are invalid."));
  }
  const headers = { ...BASE_HEADERS, ...(input.headers || {}), "Connection": input.agent ? "keep-alive" : "close" };
  for (const [name, value] of Object.entries(headers)) if (/\r|\n/.test(String(name)) || /\r|\n/.test(String(value))) return Promise.reject(new RouterReadError("Router GET headers are unsafe."));
  return new Promise((resolve, reject) => {
    let settled = false, deadline = null;
    const startedAt = Date.now();
    const fail = (message, code, details = {}) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(new RouterReadError(message, code, details));
    };
    let request;
    try {
      request = http.request({ host, port, method: "GET", path: requestPath, agent: input.agent || false, family: 4, localAddress: input.localAddress || undefined, headers }, response => {
        const chunks = [];
        let bytes = 0;
        const localAddress = String(response.socket && response.socket.localAddress || "");
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > maxBytes) { response.destroy(); fail("Router GET response exceeded the reviewed bound.", "ROUTER_GET_TOO_LARGE"); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on("aborted", () => fail("Router GET response was truncated.", "ROUTER_GET_TRUNCATED"));
        response.on("error", error => fail("Router GET response failed.", "ROUTER_GET_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(Object.freeze({
            statusCode: Number(response.statusCode) || null,
            headers: response.headers || {},
            body: Buffer.concat(chunks),
            localAddress,
            durationMs: Date.now() - startedAt,
            redirected: Number(response.statusCode) >= 300 && Number(response.statusCode) < 400 || !!response.headers.location,
            reusedSocket: request.reusedSocket === true
          }));
        });
      });
    } catch (error) { fail("Router GET could not be constructed.", "ROUTER_GET_FAILED", { causeCode: error && error.code || "UNKNOWN" }); return; }
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("Router GET deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
    request.setTimeout(Math.min(timeoutMs, input.allowLongIdle === true ? timeoutMs : 10000), () => request.destroy(Object.assign(new Error("Router GET stalled."), { code: "ETIMEDOUT" })));
    request.on("error", error => fail("Router GET failed or timed out.", "ROUTER_GET_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
    request.end();
  });
}

function assertXmlResponse(response, operation, expectedStatus = 200) {
  const text = response && response.body ? response.body.toString("utf8") : "";
  if (!response || response.statusCode !== expectedStatus || response.redirected) throw new RouterReadError(`${operation} did not return the exact expected HTTP status.`, "ROUTER_RESPONSE_INVALID", { statusCode: response && response.statusCode || null });
  if (!/^\s*(?:<\?xml\b[^>]*>\s*)?<[A-Za-z_][\s\S]*>\s*$/i.test(text) || /^\s*<!doctype|^\s*<html\b/i.test(text) || /unauthorized|<login_status>\s*(?:UNAUTHORIZED|TIMEOUT|KICKOFF)/i.test(text)) {
    throw new RouterReadError(`${operation} did not return an authorized XML model.`, "ROUTER_RESPONSE_INVALID");
  }
  return text;
}

async function createFreshAppSession(options = {}) {
  const host = String(options.host || ROUTER_HOST), port = Number(options.port || ROUTER_PORT), password = String(options.password || DEFAULT_PASSWORD);
  const agent = options.keepAlive === true ? new http.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1, timeout: 15000 }) : null;
  const challengeResponse = await routerGetOnce({ host, port, path: "/login.cgi", timeoutMs: 10000, agent });
  const challengeHeader = challengeResponse.headers["www-authenticate"];
  // This exact Mongoose build returns an empty HTTP 200 carrying only the
  // WWW-Authenticate challenge, rather than a conventional 401.
  if (challengeResponse.redirected || challengeResponse.statusCode !== 200 || challengeResponse.body.length !== 0 || !challengeHeader) throw new RouterReadError("APP challenge did not return the exact Digest envelope.", "ROUTER_AUTH_CHALLENGE_INVALID");
  const challenge = parseDigestParameters(challengeHeader);
  const login = appLoginEnvelope(challenge, password);
  const loginResponse = await routerGetOnce({ host, port, path: `/login.cgi?${login.query}`, headers: { Authorization: login.authorization }, timeoutMs: 10000, localAddress: challengeResponse.localAddress, agent });
  const loginText = loginResponse.body.toString("utf8");
  if (loginResponse.statusCode !== 200 || loginResponse.redirected || /^\s*<!doctype|^\s*<html\b/i.test(loginText) || /unauthorized|<login_status>\s*(?:UNAUTHORIZED|TIMEOUT|KICKOFF)/i.test(loginText)) {
    throw new RouterReadError("APP login was not accepted.", "ROUTER_AUTH_LOGIN_FAILED", { statusCode: loginResponse.statusCode });
  }
  const cookie = scopedCookies(loginResponse.headers, host);
  return Object.freeze({
    host,
    port,
    authorization: login.authorization,
    cookie,
    agent,
    localAddress: loginResponse.localAddress,
    createdAtMs: Date.now(),
    safety: Object.freeze({ methodsUsed: Object.freeze(["GET"]), requestBodiesPresent: false, automaticRetries: 0, redirectsAllowed: false })
  });
}

async function createFreshWebPostSession(options = {}) {
  const host = String(options.host || ROUTER_HOST), port = Number(options.port || ROUTER_PORT), password = String(options.password || DEFAULT_PASSWORD);
  const challengeResponse = await routerGetOnce({ host, port, path: "/login.cgi", timeoutMs: 10000 });
  const challengeHeader = challengeResponse.headers["www-authenticate"];
  if (challengeResponse.redirected || challengeResponse.statusCode !== 200 || challengeResponse.body.length !== 0 || !challengeHeader) throw new RouterReadError("Web POST challenge did not return the exact Digest envelope.", "ROUTER_AUTH_CHALLENGE_INVALID");
  const challenge = parseDigestParameters(challengeHeader);
  const login = webLoginEnvelope(challenge, password);
  const loginResponse = await routerGetOnce({ host, port, path: `/login.cgi?${login.query}`, headers: { Authorization: login.authorization }, timeoutMs: 10000, localAddress: challengeResponse.localAddress });
  const loginText = loginResponse.body.toString("utf8");
  if (loginResponse.statusCode !== 200 || loginResponse.redirected || /^\s*<!doctype|^\s*<html\b/i.test(loginText) || /unauthorized|<login_status>\s*(?:UNAUTHORIZED|TIMEOUT|KICKOFF)/i.test(loginText)) throw new RouterReadError("Web POST login was not accepted.", "ROUTER_AUTH_LOGIN_FAILED", { statusCode: loginResponse.statusCode });
  const responseCookie = scopedCookies(loginResponse.headers, host);
  const cookie = ["locale=en", "hard_ver=Ver.D", "platform=mifi", responseCookie].filter(Boolean).join("; ");
  const state = { nc: 2 };
  return {
    host,
    port,
    localAddress: loginResponse.localAddress,
    cookie,
    serverCookieReceived: responseCookie.length > 0,
    nextAuthorization(method) {
      const normalized = String(method).toUpperCase();
      if (!/^(?:GET|POST)$/.test(normalized)) throw new RouterReadError("Web restore session permits only GET and POST proofs.");
      const proof = digestProof(challenge, password, "/cgi/xml_action.cgi", state.nc, crypto.randomBytes(8).toString("hex"), normalized);
      state.nc += 1;
      return digestHeader(challenge, proof);
    },
    nextNonceCount() { return state.nc; },
    safety: Object.freeze({ automaticRetries: 0, redirectsAllowed: false })
  };
}

async function webSessionModelGet(session, model, options = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(String(model || ""))) throw new RouterReadError("Web session model name is invalid.");
  const authorization = session.nextAuthorization("GET");
  const modulePart = options.direct === true ? "" : "module=duster&";
  const response = await routerGetOnce({
    host: session.host,
    port: session.port,
    localAddress: session.localAddress,
    path: `/xml_action.cgi?method=get&${modulePart}file=${encodeURIComponent(model)}`,
    headers: { Authorization: authorization, Cookie: session.cookie, "X-Requested-With": "XMLHttpRequest", "Content-Type": "text/xml;charset=UTF-8" },
    timeoutMs: 10000
  });
  const text = assertXmlResponse(response, String(options.operation || `Web Digest ${model}`));
  if (response.localAddress !== session.localAddress) throw new RouterReadError("Web Digest source interface changed.", "ROUTER_SESSION_SOURCE_CHANGED");
  return Object.freeze({ text, response });
}

function hasNonemptyElement(xml, names) {
  return names.some(name => firstText(xml, [name]).length > 0);
}

function hasElement(xml, names) {
  const source = String(xml || "");
  return names.some(name => new RegExp(`<${name}\\b`, "i").test(source));
}

function settingsPresence(responses) {
  const wifi = SETTINGS_MODELS.filter(name => name !== "wan").map(name => String(responses[name] || ""));
  const wan = String(responses.wan || "");
  return Object.freeze({
    wifiSettingsRecorded: wifi.some(xml => hasNonemptyElement(xml, ["ssid", "ssid_name"])) && wifi.some(xml => hasNonemptyElement(xml, ["key", "wpa_key", "wpa_psk", "psk", "password", "network_key", "wpa_passphrase"])),
    apnSettingsRecorded: /<wan\b/i.test(wan) && hasElement(wan, ["auto_apn"]) && hasElement(wan, ["pdp_supported_list"]) && hasElement(wan, ["apn", "lte_apn"])
  });
}

function validatePrivateSettingsEvidence(value, options = {}) {
  if (!value || value.schema !== "mf885-private-settings-capture/v2" || value.sensitive !== true) throw new RouterReadError("Private settings evidence schema is invalid.", "SETTINGS_EVIDENCE_INVALID");
  const capturedAtMs = Date.parse(String(value.capturedAt || ""));
  const nowMs = Number(options.nowMs === undefined ? Date.now() : options.nowMs);
  const maxAgeMs = Number(options.maxAgeMs === undefined ? 6 * 60 * 60 * 1000 : options.maxAgeMs);
  if (!Number.isFinite(capturedAtMs) || !Number.isFinite(nowMs) || capturedAtMs > nowMs + 5 * 60 * 1000 || nowMs - capturedAtMs > maxAgeMs) throw new RouterReadError("Private settings evidence is stale or has an invalid timestamp.", "SETTINGS_EVIDENCE_INVALID");
  if (!Array.isArray(value.modelsAttempted) || value.modelsAttempted.length !== SETTINGS_MODELS.length || value.modelsAttempted.some((name, index) => name !== SETTINGS_MODELS[index])) throw new RouterReadError("Private settings evidence model order is invalid.", "SETTINGS_EVIDENCE_INVALID");
  if (!value.responses || typeof value.responses !== "object" || Array.isArray(value.responses) || !value.errors || typeof value.errors !== "object" || Array.isArray(value.errors)) throw new RouterReadError("Private settings evidence response map is invalid.", "SETTINGS_EVIDENCE_INVALID");
  const responseNames = Object.keys(value.responses).sort();
  const errorNames = Object.keys(value.errors).sort();
  const combined = [...responseNames, ...errorNames].sort();
  const expected = [...SETTINGS_MODELS].sort();
  if (combined.length !== expected.length || combined.some((name, index) => name !== expected[index]) || responseNames.some(name => errorNames.includes(name)) || responseNames.length < 6) throw new RouterReadError("Private settings evidence is incomplete.", "SETTINGS_EVIDENCE_INVALID");
  for (const name of responseNames) {
    const xml = value.responses[name];
    if (typeof xml !== "string" || xml.length < 16 || xml.length > 1024 * 1024 || !/<RGW\b/i.test(xml) || /^\s*<!doctype|^\s*<html\b/i.test(xml) || /unauthorized|<login_status>\s*(?:UNAUTHORIZED|TIMEOUT|KICKOFF)/i.test(xml)) throw new RouterReadError("Private settings evidence contains an invalid model response.", "SETTINGS_EVIDENCE_INVALID");
  }
  for (const name of errorNames) {
    const error = value.errors[name];
    if (!error || typeof error !== "object" || typeof error.code !== "string" || !/^[A-Z0-9_]{1,64}$/.test(error.code)) throw new RouterReadError("Private settings evidence contains an invalid error record.", "SETTINGS_EVIDENCE_INVALID");
  }
  if (typeof value.status1 !== "string" || value.status1.length < 16 || value.status1.length > 1024 * 1024) throw new RouterReadError("Private settings identity response is invalid.", "SETTINGS_EVIDENCE_INVALID");
  const identity = identityFromStatus(value.status1);
  if (identity.rawModel !== EXACT_MODEL || identity.hardware !== EXACT_HARDWARE || identity.firmware !== EXACT_FIRMWARE || identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256 || value.unitFingerprintSha256 !== identity.unitFingerprintSha256) throw new RouterReadError("Private settings evidence is not bound to the exact reviewed MF885.", "SETTINGS_EVIDENCE_INVALID");
  const presence = settingsPresence(value.responses);
  if (value.modelsCaptured !== responseNames.length || value.wifiSettingsRecorded !== presence.wifiSettingsRecorded || value.apnSettingsRecorded !== presence.apnSettingsRecorded || !presence.wifiSettingsRecorded || !presence.apnSettingsRecorded) throw new RouterReadError("Private settings evidence lacks usable Wi-Fi or APN data.", "SETTINGS_EVIDENCE_INVALID");
  if (!core.canonicalJson(value.stockExportUnavailableProof).equals(core.canonicalJson(STOCK_EXPORT_UNAVAILABLE_PROOF)) || value.stockExportUnavailable !== true) throw new RouterReadError("The reviewed stock configuration export fallback proof is missing.", "SETTINGS_EVIDENCE_INVALID");
  const safety = value.safety;
  if (!safety || safety.statusGetsAttempted !== 1 || safety.settingsGetsAttempted !== SETTINGS_MODELS.length || safety.requestBodiesPresent !== false || safety.routerStateWritesAttempted !== 0 || safety.restorePostsAttempted !== 0 || safety.automaticRetries !== 0 || safety.redirectsAllowed !== false) throw new RouterReadError("Private settings evidence safety counters are invalid.", "SETTINGS_EVIDENCE_INVALID");
  return Object.freeze({ capturedAt: new Date(capturedAtMs).toISOString(), modelsAttempted: SETTINGS_MODELS.length, modelsCaptured: responseNames.length, modelsFailed: Object.freeze(errorNames), wifiSettingsRecorded: true, apnSettingsRecorded: true, stockExportUnavailable: true, unitFingerprintSha256: identity.unitFingerprintSha256 });
}

async function capturePrivateSettings(options = {}) {
  const session = await createFreshWebPostSession(options);
  const status = await webSessionModelGet(session, "status1", { operation: "private settings identity" });
  const identity = identityFromStatus(status.text);
  if (identity.rawModel !== EXACT_MODEL || identity.hardware !== EXACT_HARDWARE || identity.firmware !== EXACT_FIRMWARE || identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256) throw new RouterReadError("Private settings target is not the exact reviewed MF885.", "SETTINGS_IDENTITY_MISMATCH");
  const responses = {};
  const errors = {};
  for (const model of SETTINGS_MODELS) {
    try {
      const result = await webSessionModelGet(session, model, { operation: `private settings ${model}` });
      responses[model] = result.text;
    } catch (error) {
      errors[model] = Object.freeze({ code: String(error && error.code || "ROUTER_READ_FAILED").replace(/[^A-Z0-9_]/g, "_").slice(0, 64) || "ROUTER_READ_FAILED" });
    }
  }
  const presence = settingsPresence(responses);
  const record = {
    schema: "mf885-private-settings-capture/v2",
    capturedAt: new Date().toISOString(),
    sensitive: true,
    unitFingerprintSha256: identity.unitFingerprintSha256,
    status1: status.text,
    modelsAttempted: [...SETTINGS_MODELS],
    responses,
    errors,
    modelsCaptured: Object.keys(responses).length,
    wifiSettingsRecorded: presence.wifiSettingsRecorded,
    apnSettingsRecorded: presence.apnSettingsRecorded,
    stockExportUnavailable: true,
    stockExportUnavailableProof: STOCK_EXPORT_UNAVAILABLE_PROOF,
    transport: Object.freeze({ host: session.host, port: session.port, localAddress: session.localAddress, profile: "fresh-web-digest-get-only-v1" }),
    safety: Object.freeze({ statusGetsAttempted: 1, settingsGetsAttempted: SETTINGS_MODELS.length, requestBodiesPresent: false, routerStateWritesAttempted: 0, restorePostsAttempted: 0, automaticRetries: 0, redirectsAllowed: false })
  };
  const verified = validatePrivateSettingsEvidence(record);
  return Object.freeze({ record: Object.freeze(record), report: verified });
}

function sessionHeaders(session, authenticated = true) {
  const headers = { ...BASE_HEADERS };
  if (authenticated) headers.Authorization = session.authorization;
  if (session.cookie) headers.Cookie = session.cookie;
  return headers;
}

async function sessionModelGet(session, model, options = {}) {
  if (!/^[A-Za-z0-9_]+$/.test(String(model || ""))) throw new RouterReadError("Router model name is invalid.");
  const modulePart = options.direct === true ? "" : "module=duster&";
  const response = await routerGetOnce({
    host: session.host,
    port: session.port,
    localAddress: session.localAddress,
    path: `/xml_action.cgi?method=get&${modulePart}file=${encodeURIComponent(model)}`,
    headers: sessionHeaders(session, options.authenticated !== false),
    timeoutMs: options.timeoutMs || 10000,
    agent: session.agent
  });
  const text = assertXmlResponse(response, String(options.operation || model));
  if (response.localAddress !== session.localAddress) throw new RouterReadError("Router source interface changed inside the active session.", "ROUTER_SESSION_SOURCE_CHANGED");
  return Object.freeze({ response, text });
}

function postReadStatusProbe(session, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 10000);
  const requestPath = "/xml_action.cgi?method=get&file=GetRestoreStatus";
  return new Promise((resolve, reject) => {
    let settled = false, deadline = null;
    const fail = (message, code, details = {}) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(new RouterReadError(message, code, details));
    };
    let request;
    try {
      request = http.request({
        host: session.host,
        port: session.port,
        localAddress: session.localAddress,
        family: 4,
        method: "POST",
        path: requestPath,
        agent: false,
        headers: { ...sessionHeaders(session, options.authenticated !== false), "Content-Length": "0", "Connection": "close" }
      }, response => {
        const chunks = [];
        let bytes = 0;
        const localAddress = String(response.socket && response.socket.localAddress || "");
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 65536) { response.destroy(); fail("POST-read probe response exceeded the reviewed bound.", "ROUTER_POST_READ_INVALID"); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on("aborted", () => fail("POST-read probe response was truncated.", "ROUTER_POST_READ_INVALID"));
        response.on("error", error => fail("POST-read probe failed.", "ROUTER_POST_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
        response.on("end", () => {
          if (settled) return;
          const wrapped = { statusCode: Number(response.statusCode) || null, headers: response.headers || {}, body: Buffer.concat(chunks), localAddress, redirected: Number(response.statusCode) >= 300 && Number(response.statusCode) < 400 || !!response.headers.location };
          let text;
          try { text = assertXmlResponse(wrapped, "POST-read GetRestoreStatus"); }
          catch (error) { fail(error.message, error.code, { statusCode: wrapped.statusCode, bodyBytes: wrapped.body.length, bodySha256: core.sha256(wrapped.body), contentType: String(wrapped.headers["content-type"] || "") }); return; }
          if (localAddress !== session.localAddress) { fail("POST-read probe changed router source interface.", "ROUTER_SESSION_SOURCE_CHANGED"); return; }
          const status = parseRestoreStatus(text);
          if (status.status !== "0" || status.progress !== "0" || !/^No Error!?$/i.test(status.cause)) { fail("POST-read GetRestoreStatus was not at the exact idle baseline.", "ROUTER_POST_READ_INVALID"); return; }
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(Object.freeze({ text, status, localAddress, provenAtMs: Date.now(), httpMethod: "POST", semanticMethod: "GET", requestBodyBytes: 0 }));
        });
      });
    } catch (error) { fail("POST-read probe could not be constructed.", "ROUTER_POST_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }); return; }
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("POST-read probe deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
    request.setTimeout(Math.min(timeoutMs, 10000), () => request.destroy(Object.assign(new Error("POST-read probe stalled."), { code: "ETIMEDOUT" })));
    request.on("error", error => fail("POST-read probe failed or timed out.", "ROUTER_POST_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
    request.end();
  });
}

function postSmsReadProbe(session, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const requestPath = "/xml_action.cgi?method=set&module=duster&file=message";
  const body = Buffer.from('<?xml version="1.0" encoding="US-ASCII"?><RGW><message><flag><message_flag>GET_RCV_SMS_LOCAL</message_flag></flag><get_message><page_number>1</page_number></get_message></message></RGW>', "utf8");
  const authorization = typeof session.nextAuthorization === "function" ? session.nextAuthorization("POST") : session.authorization;
  return new Promise((resolve, reject) => {
    let settled = false, deadline = null;
    const fail = (message, code, details = {}) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(new RouterReadError(message, code, details));
    };
    let request;
    try {
      request = http.request({
        host: session.host,
        port: session.port,
        localAddress: session.localAddress,
        family: 4,
        method: "POST",
        path: requestPath,
        agent: false,
        headers: {
          ...BASE_HEADERS,
          "Authorization": authorization,
          ...(session.cookie ? { "Cookie": session.cookie } : {}),
          "X-Requested-With": "XMLHttpRequest",
          "Content-Type": "text/xml;charset=UTF-8",
          "Content-Length": String(body.length),
          "Connection": "close"
        }
      }, response => {
        const chunks = [];
        let bytes = 0;
        const localAddress = String(response.socket && response.socket.localAddress || "");
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) { response.destroy(); fail("SMS read probe response exceeded the reviewed bound.", "ROUTER_SMS_READ_INVALID"); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on("aborted", () => fail("SMS read probe response was truncated.", "ROUTER_SMS_READ_INVALID"));
        response.on("error", error => fail("SMS read probe failed.", "ROUTER_SMS_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
        response.on("end", () => {
          if (settled) return;
          const wrapped = { statusCode: Number(response.statusCode) || null, headers: response.headers || {}, body: Buffer.concat(chunks), localAddress, redirected: Number(response.statusCode) >= 300 && Number(response.statusCode) < 400 || !!response.headers.location };
          let text;
          try { text = assertXmlResponse(wrapped, "Web Digest SMS read probe"); }
          catch (error) { fail("The fresh Web Digest session did not authorize the SMS read POST.", "ROUTER_SMS_READ_UNAUTHORIZED", { statusCode: wrapped.statusCode, responseBytes: wrapped.body.length }); return; }
          if (localAddress !== session.localAddress || !/<message\b/i.test(text)) { fail("SMS read probe did not return the expected model on the same source interface.", "ROUTER_SMS_READ_INVALID"); return; }
          const totalRaw = firstText(text, ["total_count", "sms_count", "message_count", "all_message_count"]);
          const returnedMessages = (text.match(/<message_content\b/gi) || []).length;
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(Object.freeze({ httpMethod: "POST", semanticOperation: "GET_RCV_SMS_LOCAL", requestBodyBytes: body.length, responseBytes: wrapped.body.length, returnedMessages, totalMessages: /^\d+$/.test(totalRaw) ? Number(totalRaw) : null, localAddress, provenAtMs: Date.now() }));
        });
      });
    } catch (error) { fail("SMS read probe could not be constructed.", "ROUTER_SMS_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }); return; }
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("SMS read probe deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
    request.setTimeout(Math.min(timeoutMs, 10000), () => request.destroy(Object.assign(new Error("SMS read probe stalled."), { code: "ETIMEDOUT" })));
    request.on("error", error => fail("SMS read probe failed or timed out.", "ROUTER_SMS_READ_FAILED", { causeCode: error && error.code || "UNKNOWN" }));
    request.end(body);
  });
}

function identityFromStatus(xml) {
  const rawModel = firstText(xml, ["model", "model_name", "product_name", "device_name"]);
  const hardware = firstText(xml, ["revision", "hardware_version", "hardware_ver", "hw_version"]);
  const firmware = firstText(xml, ["version_num"]);
  const candidates = [
    ["imei", firstText(xml, ["imei", "IMEI", "device_imei", "modem_imei"])],
    ["serial", firstText(xml, ["serial_number", "serial", "device_sn", "sn"])],
    ["lan-mac", firstText(xml, ["lan_mac", "mac_address", "device_mac", "mac"])]
  ];
  const selected = candidates.find(item => String(item[1] || "").trim());
  const unitFingerprintSha256 = selected ? core.sha256(Buffer.from(`mf885-unit-v1|${selected[0]}|${String(selected[1]).trim().toLowerCase()}`, "utf8")) : "";
  return Object.freeze({ rawModel, model: /^LV01$/i.test(rawModel) ? "MF885" : rawModel, hardware, firmware, unitFingerprintSha256 });
}

function powerFromStatus(xml, identity) {
  const source = firstSection(xml, "batteryinfo") || xml;
  const percentRaw = firstText(source, ["Battery_percent", "battery_percent"]);
  const batteryPercent = /^\d+$/.test(percentRaw) ? Number(percentRaw) : null;
  const fields = {
    batteryStatus: firstText(source, ["Battery_status", "battery_status"]),
    chargerStatus: firstText(source, ["Charger_status", "charger_status"]),
    batteryLevel: firstText(source, ["Battery_level", "battery_level"]),
    chargerCurrent: firstText(source, ["Charger_current", "charger_current"]),
    outputCurrent: firstText(source, ["Output_current", "output_current"]),
    cDetectStatus: firstText(source, ["CDetectStatus", "c_detect_status"])
  };
  const decoded = powerStatus.decode(fields, { rawModel: identity.rawModel, firmware: identity.firmware });
  return Object.freeze({ batteryPercent, batteryStatus: fields.batteryStatus, chargerStatus: fields.chargerStatus, externalPowerConnected: decoded.confirmed === true && decoded.inputConnected === true, powerState: decoded.state, interpretationConfirmed: decoded.confirmed === true });
}

function networkBaseline(xml) {
  return Object.freeze({
    operator: firstText(xml, ["network_name", "ISP_name", "operator"]),
    networkType: firstText(xml, ["network_type", "network_mode", "network_status"]),
    registration: firstText(xml, ["registration_status", "network_registration", "roaming"])
  });
}

function parseRestoreStatus(xml) {
  return Object.freeze({ status: firstText(xml, ["status"]), progress: firstText(xml, ["progress"]), cause: firstText(xml, ["cause"]) });
}

function parseUpgradeStatus(xml) {
  return Object.freeze({ support32mFlash: firstText(xml, ["support_32m_flash"]), backupStatus: firstText(xml, ["backup_status"]), backupProgress: firstText(xml, ["backup_progress"]), backupFailCause: firstText(xml, ["backup_fail_cause"]) });
}

async function collectRestorePreflight(options = {}) {
  const targetHost = String(options.host || ROUTER_HOST), targetPort = Number(options.port || ROUTER_PORT);
  if (targetHost !== ROUTER_HOST || targetPort !== ROUTER_PORT) throw new RouterReadError("Restore preflight is bound to the reviewed MF885 endpoint.", "RESTORE_PREFLIGHT_ENDPOINT_MISMATCH");
  const startedAt = Date.now();
  const session = await createFreshAppSession(options);
  const identityRead = await sessionModelGet(session, "status1", { operation: "APP status1" });
  const restoreRead = await sessionModelGet(session, "GetRestoreStatus", { direct: true, operation: "direct GetRestoreStatus" });
  // The direct route exposes the live backup/restore fields but omits the
  // hardware capability flag on 2.5.94. The Duster route returns the same
  // webui_upgrade section plus the native support_32m_flash flag.
  const upgradeRead = await sessionModelGet(session, "upgrade_firmware", { operation: "Duster upgrade_firmware" });
  const firstIdentity = identityFromStatus(identityRead.text), identity = firstIdentity;
  // Use a separate fresh standard Web Digest session for the POST side. The
  // first POST reads SMS page 1; the next nonce-count is then reserved for the
  // one RestoreFw request and is never used by another probe.
  const webSession = await createFreshWebPostSession(options);
  if (webSession.localAddress !== session.localAddress) throw new RouterReadError("APP and Web Digest sessions used different source interfaces.", "ROUTER_SESSION_SOURCE_CHANGED");
  const webStatus = await webSessionModelGet(webSession, "status1");
  if (identityFromStatus(webStatus.text).unitFingerprintSha256 !== identity.unitFingerprintSha256) throw new RouterReadError("Web Digest identity did not match the APP preflight.", "ROUTER_SESSION_SOURCE_CHANGED");
  const postRead = await postSmsReadProbe(webSession);
  const restoreAuthorization = webSession.nextAuthorization("POST");
  const power = powerFromStatus(identityRead.text, identity);
  const restoreStatus = parseRestoreStatus(restoreRead.text), upgradeStatus = parseUpgradeStatus(upgradeRead.text);
  const errors = [];
  if (identity.rawModel !== EXACT_MODEL || identity.hardware !== EXACT_HARDWARE || identity.firmware !== EXACT_FIRMWARE || identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256) errors.push("Exact reviewed LV01 / MF96 Ver.D / 2.5.94 unit identity was not proven.");
  if (firstIdentity.unitFingerprintSha256 !== identity.unitFingerprintSha256 || firstIdentity.firmware !== identity.firmware || firstIdentity.hardware !== identity.hardware) errors.push("Router identity changed inside the fresh APP session.");
  if (!power.interpretationConfirmed || !power.externalPowerConnected || !Number.isInteger(power.batteryPercent) || power.batteryPercent < 80) errors.push("Battery must be at least 80% with externally powered LV01 semantics.");
  if (restoreStatus.status !== "0" || restoreStatus.progress !== "0" || !/^No Error!?$/i.test(restoreStatus.cause)) errors.push("Direct GetRestoreStatus is not at the exact idle baseline.");
  if (upgradeStatus.support32mFlash !== "1") errors.push("The 32 MiB flash capability flag is missing.");
  if (session.localAddress !== core.RESTORE_LOCAL_ADDRESS || webSession.localAddress !== core.RESTORE_LOCAL_ADDRESS) errors.push("The exact reviewed VDS source interface was not proven.");
  if (webSession.serverCookieReceived !== false) errors.push("The fresh Web login no-server-cookie profile changed unexpectedly.");
  const sessionProvenAtMs = postRead.provenAtMs;
  const safeReport = Object.freeze({
    schema: 1,
    mode: "mf885-vds-restore-preflight",
    generatedAt: new Date(sessionProvenAtMs).toISOString(),
    identity: Object.freeze({ model: identity.model, rawModel: identity.rawModel, hardware: identity.hardware, firmware: identity.firmware, unitFingerprintSha256: identity.unitFingerprintSha256 }),
    power,
    restoreStatus,
    upgradeStatus,
    networkBaseline: networkBaseline(identityRead.text),
    session: Object.freeze({ profile: "fresh-web-digest-sms-read-next-post-no-server-cookie-v1", localAddress: webSession.localAddress, serverCookieReceived: false, standardDigestSmsReadPassed: true, restoreNonceCount: webSession.nextNonceCount() - 1, smsMessagesReturned: postRead.returnedMessages, provenAtMs: sessionProvenAtMs, elapsedMs: sessionProvenAtMs - startedAt }),
    safety: Object.freeze({ methodsUsed: Object.freeze(["GET", "POST-read-sms"]), routerGetsAttempted: 8, readOnlyHttpPostsAttempted: 1, requestBodyBytes: postRead.requestBodyBytes, routerStateWritesAttempted: 0, firmwarePostsAttempted: 0, smsPayloadsEmitted: 0, automaticRetries: 0, redirectsAllowed: false }),
    errors: Object.freeze(errors)
  });
  if (errors.length) throw new RouterReadError(errors.join(" "), "RESTORE_PREFLIGHT_FAILED", { report: safeReport });
  return Object.freeze({ report: safeReport, session: Object.freeze({ host: targetHost, port: targetPort, localAddress: webSession.localAddress, cookie: webSession.cookie, serverCookieReceived: webSession.serverCookieReceived, restoreAuthorization }), sessionProvenAtMs });
}

function buildGoldenRestoreCapsule(imagePath) {
  const resolved = path.resolve(String(imagePath || ""));
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new RouterReadError("Golden image must be a real local file.", "GOLDEN_IMAGE_INVALID");
  const source = fs.readFileSync(resolved);
  const firstSha256 = core.sha256(source), secondSha256 = core.sha256(source);
  if (source.length !== GOLDEN_BYTES || firstSha256 !== core.GOLDEN_IMAGE_SHA256 || secondSha256 !== firstSha256) throw new RouterReadError("The selected file is not the exact stock golden image.", "GOLDEN_IMAGE_INVALID");
  const image = Object.freeze({ id: "mf885-stock-golden-2.5.94", file: GOLDEN_MULTIPART_FILENAME, size: source.length, sha256: firstSha256 });
  const built = dryRun.buildDeterministicMultipart({ data: source, image, field: "file", filename: GOLDEN_MULTIPART_FILENAME });
  const body = Buffer.from(built.body.buffer, built.body.byteOffset, built.body.byteLength);
  const extracted = dryRun.extractNativePayload(body, built.boundary);
  if (extracted.length !== source.length || core.sha256(extracted) !== firstSha256) throw new RouterReadError("Native-style multipart extraction did not reproduce the golden image.", "GOLDEN_MULTIPART_INVALID");
  const bodySha256 = core.sha256(body);
  if (bodySha256 !== GOLDEN_BODY_SHA256) throw new RouterReadError("Golden multipart body differs from the reviewed deterministic envelope.", "GOLDEN_MULTIPART_INVALID");
  const contract = Object.freeze({
    schema: 1,
    profile: "mf885-vds-restore-transport-v1",
    firmware: EXACT_FIRMWARE,
    operation: "RestoreFw",
    method: "POST",
    host: ROUTER_HOST,
    physicalRoute: core.RESTORE_ROUTE,
    digestUri: "/cgi/xml_action.cgi",
    authProfile: "fresh-web-digest-sms-read-next-post-no-server-cookie-v1",
    multipart: Object.freeze({ boundary: built.boundary, field: built.field, filename: built.filename, mimeType: "application/octet-stream", bodyBytes: body.length, bodySha256, payloadBytes: source.length, payloadSha256: firstSha256 }),
    acceptance: Object.freeze({ statusCode: 200, contentType: "text/html", server: "Mongoose/3.0", bodySha256: core.sha256(Buffer.from("Server get upload file successfully\n")) }),
    status: Object.freeze({ method: "GET", path: "/xml_action.cgi?method=get&file=GetRestoreStatus", rawMap: Object.freeze({ "0": "AMBIGUOUS_AFTER_POST", "2": "RESTORING", "1": "REBOOT_WAIT", "3": "FAILED" }), maxPolls: 120, pollIntervalMs: 1000 }),
    sender: Object.freeze({ routerPostLimit: 1, automaticRetries: 0, redirectsAllowed: false, transferEncoding: "content-length", connection: "close", expectContinue: false })
  });
  const contractSha256 = core.sha256(core.canonicalJson(contract));
  return { image, source, body, boundary: built.boundary, bodySha256, contract, contractSha256 };
}

function rawBackupDownload(options = {}) {
  const host = String(options.host || ROUTER_HOST), port = Number(options.port || ROUTER_PORT);
  if (host !== ROUTER_HOST || port !== ROUTER_PORT) return Promise.reject(new RouterReadError("Backup download is bound to the reviewed MF885 endpoint.", "BACKUP_ENDPOINT_MISMATCH"));
  const timeoutMs = Number(options.timeoutMs || 300000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 30000 || timeoutMs > 600000) return Promise.reject(new RouterReadError("Backup download timeout is outside the reviewed bound."));
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false, deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    let request;
    try {
      request = http.get({ host, port, localAddress: options.localAddress || undefined, family: 4, path: "/xml_action.cgi?Action=BackupFw", method: "GET", agent: false, headers: { Connection: "close" } }, response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > GOLDEN_BYTES) {
            response.destroy();
            finish(new RouterReadError("BackupFw response exceeded the exact golden byte bound.", "BACKUP_DOWNLOAD_INVALID", { bytes }));
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        const complete = connectionTerminated => {
          const body = Buffer.concat(chunks, bytes);
          if (response.statusCode === 500) { finish(null, null); return; }
          if (Number(response.statusCode) >= 300 && Number(response.statusCode) < 400 || response.headers.location) { finish(new RouterReadError("BackupFw download redirected.", "BACKUP_DOWNLOAD_INVALID")); return; }
          if (response.statusCode !== 200) { finish(new RouterReadError("BackupFw download returned an unexpected HTTP status.", "BACKUP_DOWNLOAD_INVALID", { statusCode: response.statusCode, bytes })); return; }
          if (body.length !== GOLDEN_BYTES || core.sha256(body) !== core.GOLDEN_IMAGE_SHA256) { finish(new RouterReadError("BackupFw connection ended without the exact golden bytes.", "BACKUP_DOWNLOAD_INVALID", { bytes: body.length, sha256: core.sha256(body) })); return; }
          finish(null, Object.freeze({ body, statusCode: 200, durationMs: Date.now() - startedAt, contentType: String(response.headers["content-type"] || ""), contentDispositionPresent: !!response.headers["content-disposition"], connectionTerminated: connectionTerminated === true, localAddress: String(response.socket && response.socket.localAddress || options.localAddress || "") }));
        };
        response.on("end", () => complete(false));
        response.on("aborted", () => complete(true));
        response.on("error", error => {
          if (bytes === GOLDEN_BYTES) complete(true);
          else finish(new RouterReadError("BackupFw response failed before the exact body completed.", "BACKUP_DOWNLOAD_INVALID", { bytes, causeCode: error && error.code || "UNKNOWN" }));
        });
      });
    } catch (error) { finish(new RouterReadError("BackupFw request could not be constructed.", "BACKUP_DOWNLOAD_INVALID", { causeCode: error && error.code || "UNKNOWN" })); return; }
    request.on("socket", socket => socket.setKeepAlive(true, 15000));
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("BackupFw raw download timed out."), { code: "ETIMEDOUT" })));
    request.on("error", error => finish(new RouterReadError("BackupFw raw download failed.", "BACKUP_DOWNLOAD_INVALID", { causeCode: error && error.code || "UNKNOWN" })));
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("BackupFw total deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
  });
}

async function captureGoldenBackup(options = {}) {
  const host = String(options.host || ROUTER_HOST), port = Number(options.port || ROUTER_PORT);
  if (host !== ROUTER_HOST || port !== ROUTER_PORT) throw new RouterReadError("Golden backup capture is bound to the reviewed MF885 endpoint.", "BACKUP_ENDPOINT_MISMATCH");
  const session = await createFreshWebPostSession({ ...options, host, port });
  const statusRead = await webSessionModelGet(session, "status1", { operation: "backup preflight status1" });
  const identity = identityFromStatus(statusRead.text), power = powerFromStatus(statusRead.text, identity);
  if (identity.rawModel !== EXACT_MODEL || identity.hardware !== EXACT_HARDWARE || identity.firmware !== EXACT_FIRMWARE || identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256) {
    throw new RouterReadError("Backup target is not the exact reviewed MF885 unit.", "BACKUP_IDENTITY_MISMATCH");
  }
  if (!power.interpretationConfirmed || !power.externalPowerConnected || !Number.isInteger(power.batteryPercent) || power.batteryPercent < 80) {
    throw new RouterReadError("Golden backup requires at least 80% battery and confirmed external power.", "BACKUP_POWER_GATE_FAILED");
  }
  const beforeRead = await webSessionModelGet(session, "upgrade_firmware", { direct: true, operation: "backup state before start" });
  const before = parseUpgradeStatus(beforeRead.text);
  if (["0", "1", "2"].includes(before.backupStatus)) throw new RouterReadError("An existing backup transaction is already active or complete; a new start was refused.", "BACKUP_ALREADY_ACTIVE", { status: before.backupStatus, progress: before.backupProgress });
  const startAuthorization = session.nextAuthorization("GET");
  const start = await routerGetOnce({ host, port, path: "/xml_action.cgi?Action=BackupFwStart", headers: { Authorization: startAuthorization, ...(session.cookie ? { Cookie: session.cookie } : {}) }, timeoutMs: 30000, maxBytes: 65536, allowBackupStart: true, localAddress: session.localAddress });
  const startText = start.body.toString("utf8");
  if (start.statusCode !== 200 || start.redirected || /^\s*<!doctype|^\s*<html\b/i.test(startText) || /unauthorized|<login_status>\s*(?:UNAUTHORIZED|TIMEOUT|KICKOFF)/i.test(startText)) {
    throw new RouterReadError("Authenticated BackupFwStart was not accepted; it will not be retried automatically.", "BACKUP_START_FAILED", { statusCode: start.statusCode, responseBytes: start.body.length });
  }
  const statusHistory = [Object.freeze({ status: before.backupStatus, progress: before.backupProgress, cause: before.backupFailCause })];
  let finalBackupStatus = "";
  for (let poll = 0; poll < 300; poll += 1) {
    await new Promise(resolve => setTimeout(resolve, poll === 0 ? 100 : 1000));
    try {
      const current = await webSessionModelGet(session, "upgrade_firmware", { direct: true, operation: "BackupFw preparation status" });
      const parsed = parseUpgradeStatus(current.text);
      const item = Object.freeze({ status: parsed.backupStatus, progress: parsed.backupProgress, cause: parsed.backupFailCause });
      const previous = statusHistory[statusHistory.length - 1];
      if (!previous || previous.status !== item.status || previous.progress !== item.progress || previous.cause !== item.cause) statusHistory.push(item);
      finalBackupStatus = item.status;
      if (item.status === "1") break;
      if (item.status === "3") throw new RouterReadError("BackupFwStart reported a terminal failure; it will not be retried automatically.", "BACKUP_START_FAILED", { cause: item.cause || "unknown", progress: item.progress });
    } catch (error) {
      if (error instanceof RouterReadError && error.code === "BACKUP_START_FAILED") throw error;
      const item = Object.freeze({ transportError: error && error.code || "ROUTER_READ_FAILED" });
      const previous = statusHistory[statusHistory.length - 1];
      if (!previous || previous.transportError !== item.transportError) statusHistory.push(item);
    }
  }
  if (finalBackupStatus !== "1") throw new RouterReadError("BackupFwStart did not reach success before the bounded poll limit; it will not be retried automatically.", "BACKUP_START_TIMEOUT");
  const download = await rawBackupDownload({ host, port, localAddress: session.localAddress, timeoutMs: 300000 });
  if (!download) throw new RouterReadError("BackupFw returned a terminal 500 after preparation success; it will not be retried automatically.", "BACKUP_DOWNLOAD_INVALID");
  return Object.freeze({ body: download.body, localAddress: download.localAddress, startedAt: new Date(Date.now() - download.durationMs).toISOString(), completedAt: new Date().toISOString(), bytes: download.body.length, sha256: core.GOLDEN_IMAGE_SHA256, batteryPercent: power.batteryPercent, externalPowerConnected: power.externalPowerConnected, statusHistory: Object.freeze(statusHistory), connectionTerminatedAfterExactBody: download.connectionTerminated, startRequests: 1, downloadRequests: 1, automaticRetries: 0, restorePostsAttempted: 0 });
}

module.exports = {
  ROUTER_HOST,
  ROUTER_PORT,
  USERNAME,
  EXACT_MODEL,
  EXACT_HARDWARE,
  EXACT_FIRMWARE,
  GOLDEN_BYTES,
  GOLDEN_MULTIPART_FILENAME,
  GOLDEN_BODY_SHA256,
  SETTINGS_MODELS,
  STOCK_EXPORT_UNAVAILABLE_PROOF,
  RouterReadError,
  firstText,
  parseDigestParameters,
  appLoginEnvelope,
  routerGetOnce,
  createFreshAppSession,
  createFreshWebPostSession,
  webSessionModelGet,
  validatePrivateSettingsEvidence,
  capturePrivateSettings,
  sessionModelGet,
  postReadStatusProbe,
  postSmsReadProbe,
  identityFromStatus,
  powerFromStatus,
  parseRestoreStatus,
  parseUpgradeStatus,
  collectRestorePreflight,
  buildGoldenRestoreCapsule,
  rawBackupDownload,
  captureGoldenBackup
};
