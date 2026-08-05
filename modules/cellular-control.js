// Experimental cellular-network controls isolated from the dashboard.
// Safe detection only uses GET probes. Reconnect and mode changes require UI confirmation.

const PROBE_FILES = ["wan", "network", "dialup", "connection", "mobile_connection", "lte", "net_select", "network_setting", "net_mode"];
const MODES = [
  { id: "auto", title: "Automatic", values: ["auto", "0", "00"] },
  { id: "lteOnly", title: "4G/LTE only", values: ["lte_only", "lte", "4g_only", "4", "19"] },
  { id: "ltePreferred", title: "LTE preferred", values: ["lte_preferred", "4g_preferred", "0203", "2"] },
  { id: "wcdmaOnly", title: "3G only", values: ["wcdma_only", "wcdma", "3g_only", "3"] },
  { id: "gsmOnly", title: "2G only", values: ["gsm_only", "gsm", "2g_only", "1"] }
];
const MODE_FIELDS = ["network_mode", "NetworkMode", "sys_mode", "rat_mode", "preferred_network_type", "net_select"];
const RECONNECT_XML = [
  { file: "wan", root: "wan", field: "connect_mode", off: "disconnect", on: "connect" },
  { file: "dialup", root: "dialup", field: "dialup_action", off: "disconnect", on: "connect" },
  { file: "connection", root: "connection", field: "wan_action", off: "disconnect", on: "connect" },
  { file: "mobile_connection", root: "mobile_connection", field: "action", off: "disconnect", on: "connect" },
  { file: "network", root: "network", field: "register", off: "0", on: "1" }
];
const RECONNECT_ROUTER = [
  ["dialup", "disconnect"], ["dialup", "connect"], ["wan", "wan_disconnect"], ["wan", "wan_connect"],
  ["connection", "disconnect"], ["connection", "connect"], ["wan", "reconnect"], ["network", "net_reconnect"]
];

async function detect(api) {
  const diagnostics = [];
  const responded = [];
  for (const file of PROBE_FILES) {
    try {
      const xml = await api.xmlRequest("GET", file, null, true, 5);
      const status = classify(xml);
      diagnostics.push({ file, status, root: xmlRoot(xml), field: firstKnownField(xml), detail: compact(xml) });
      if (status === "responded") responded.push(file);
    } catch (error) {
      diagnostics.push({ file, status: "error", detail: compact(api.cleanError(error)) });
    }
  }
  return {
    supported: responded.length ? true : null,
    detail: responded.length ? `Firmware responded to: ${responded.join(", ")}.` : "No cellular-control endpoint was confirmed by safe GET probes.",
    diagnostics,
    reconnectAvailable: responded.length ? true : null,
    modes: MODES.map(({ id, title }) => ({ id, title, supported: id === "ltePreferred" ? null : true }))
  };
}

async function executeReconnect(api, capability) {
  const diagnostics = [];
  for (const attempt of RECONNECT_XML) {
    try {
      const off = buildRequest(attempt.root, attempt.field, attempt.off, api.escapeXml);
      const r1 = await api.xmlRequest("POST", attempt.file, off, true, 12);
      diagnostics.push(diag({ file: attempt.file, root: attempt.root, field: attempt.field, response: compact(r1) }));
      await api.sleep(900);
      const on = buildRequest(attempt.root, attempt.field, attempt.on, api.escapeXml);
      const r2 = await api.xmlRequest("POST", attempt.file, on, true, 12);
      diagnostics.push(diag({ file: attempt.file, root: attempt.root, field: attempt.field, response: compact(r2) }));
      const verified = await verify(api, capability);
      diagnostics.push(`verification=${verified.detail}`);
      if (accepted(r1) || accepted(r2) || verified.ok) return result(true, "Cellular reconnect requested", "The router accepted a mobile network reconnect command. Temporary internet loss is expected.", diagnostics);
    } catch (error) { diagnostics.push(diag({ file: attempt.file, root: attempt.root, field: attempt.field, error: api.cleanError(error) })); }
  }
  for (const [path, method] of RECONNECT_ROUTER) {
    try {
      const response = await api.routerCall(path, method);
      diagnostics.push(diag({ obj_path: path, obj_method: method, response: compact(response) }));
      const verified = await verify(api, capability);
      diagnostics.push(`verification=${verified.detail}`);
      if (accepted(response) || verified.ok) return result(true, "Cellular reconnect requested", "The router accepted a mobile network reconnect command. Temporary internet loss is expected.", diagnostics);
    } catch (error) { diagnostics.push(diag({ obj_path: path, obj_method: method, error: api.cleanError(error) })); }
  }
  return result(false, "Cellular reconnect failed", "This firmware did not accept known reconnect commands.", diagnostics);
}

async function executeSetMode(api, capability, modeId) {
  const mode = MODES.find(item => item.id === modeId);
  if (!mode) throw new Error("Unknown cellular mode");
  const diagnostics = [];
  const files = candidateFiles(capability);
  for (const file of files) for (const field of MODE_FIELDS) for (const value of mode.values) {
    const root = file === "network_setting" ? "network_setting" : file;
    try {
      const response = await api.xmlRequest("POST", file, buildRequest(root, field, value, api.escapeXml), true, 12);
      diagnostics.push(diag({ file, root, field, response: compact(response) }));
      const verified = await verify(api, capability, mode);
      diagnostics.push(`verification=${verified.detail}`);
      if (accepted(response) || verified.ok) return result(true, `Network mode: ${mode.title}`, "The router accepted the preferred cellular protocol command.", diagnostics);
    } catch (error) { diagnostics.push(diag({ file, root, field, error: api.cleanError(error) })); }
  }
  for (const value of mode.values) {
    try {
      const response = await api.routerCall("network", `set_${mode.id}_${value}`);
      diagnostics.push(diag({ obj_path: "network", obj_method: `set_${mode.id}_${value}`, response: compact(response) }));
      const verified = await verify(api, capability, mode);
      diagnostics.push(`verification=${verified.detail}`);
      if (accepted(response) || verified.ok) return result(true, `Network mode: ${mode.title}`, "The router accepted the preferred cellular protocol command.", diagnostics);
    } catch (error) { diagnostics.push(diag({ obj_path: "network", obj_method: `set_${mode.id}_${value}`, error: api.cleanError(error) })); }
  }
  return result(false, `Network mode: ${mode.title}`, "This firmware did not accept known mode commands.", diagnostics);
}

async function verify(api, capability, mode) {
  try { const parsed = api.parseNetwork ? await api.parseNetwork() : null; if (parsed && parsed.hasData) return { ok: mode ? matchesMode(parsed, mode.id) : true, detail: compact(JSON.stringify({ mode: parsed.mode, rawMode: parsed.rawMode, registered: parsed.registered })) }; } catch (error) { return { ok: false, detail: `status error=${api.cleanError(error)}` }; }
  for (const file of candidateFiles(capability)) try { const xml = await api.xmlRequest("GET", file, null, true, 6); return { ok: mode ? matchesMode({ mode: xml, rawMode: xml }, mode.id) : accepted(xml), detail: `${file}: ${compact(xml)}` }; } catch (_) {}
  return { ok: false, detail: "no verification response" };
}
function matchesMode(parsed, id) { const text = `${parsed.mode || ""} ${parsed.rawMode || ""}`.toLowerCase(); if (id === "auto") return /auto|automatic/.test(text); if (id === "lteOnly" || id === "ltePreferred") return /lte|4g/.test(text); if (id === "wcdmaOnly") return /wcdma|umts|3g/.test(text); if (id === "gsmOnly") return /gsm|2g/.test(text); return false; }
function candidateFiles(capability) { const files = (capability && capability.diagnostics || []).map(d => d.file).filter(Boolean); return Array.from(new Set(files.length ? files : PROBE_FILES)); }
function buildRequest(root, field, value, escapeXml) { return `<?xml version="1.0" encoding="US-ASCII"?><RGW><${root}><${field}>${escapeXml(value)}</${field}></${root}></RGW>`; }
function classify(xml) { return isUnsupported(xml) ? "rejected" : "responded"; }
function isUnsupported(xml) { return /not.?found|unknown.?file|not.?support|unsupported|invalid.?file|unauthorized/i.test(String(xml || "")); }
function accepted(xml) { const text = String(xml || ""); return !isUnsupported(text) && !/error|fail|denied|<status>\s*(?:2|3|4|5|-1)\s*<\/status>/i.test(text); }
function xmlRoot(xml) { const hit = String(xml || "").match(/<([A-Za-z_][\w.-]*)\b/); return hit ? hit[1] : ""; }
function firstKnownField(xml) { for (const f of MODE_FIELDS.concat(["connect_mode", "dialup_action", "wan_action", "action", "register"])) if (new RegExp(`<${f}\\b`, "i").test(String(xml || ""))) return f; return ""; }
function compact(value) { return sanitize(String(value || "").replace(/\s+/g, " ").trim().slice(0, 500)); }
function sanitize(value) { return String(value || "").replace(/(authorization:\s*Digest[^\n]*)/ig, "Authorization: <redacted>").replace(/(password|passwd|pwd)([=:\s]+)[^\s&|<]+/ig, "$1$2<redacted>").replace(/(response|nonce|cnonce)([=:\s\"]+)[0-9a-f]{8,}/ig, "$1$2<redacted>"); }
function diag(item) { const parts = []; if (item.file) parts.push(`file=${item.file}`); if (item.root) parts.push(`root=${item.root}`); if (item.field) parts.push(`field=${item.field}`); if (item.obj_path) parts.push(`routerCall obj_path=${item.obj_path}`); if (item.obj_method) parts.push(`obj_method=${item.obj_method}`); if (item.status) parts.push(`status=${item.status}`); if (item.response) parts.push(`response=${compact(item.response)}`); if (item.error) parts.push(`error=${compact(item.error)}`); return parts.join(" "); }
function result(ok, title, message, diagnostics) { return { ok, title, message, diagnostics: diagnostics.join("\n") }; }
function modeById(id) { return MODES.find(mode => mode.id === id) || null; }
function modes() { return MODES.map(({ id, title }) => ({ id, title })); }
module.exports = { detect, executeReconnect, executeSetMode, modes, modeById, buildRequest, accepted, sanitize };
