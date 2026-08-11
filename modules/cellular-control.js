// Read-only WAN discovery. Writes stay disabled until one contract is verified
// across every supported router build.
const RAW_FIELDS = ["connect_disconnect", "connect_mode", "NW_mode", "prefer_mode", "prefer_lte_type", "pdp_enable", "connect_action", "disconnect_action", "pdp_action", "manual_network", "network_select", "apn", "pdp_type", "username", "auth_type"];
const NETWORK_MODES = Object.freeze([]);
function text(xml, name) { const m = String(xml || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return m ? m[1].trim() : null; }
function parseWan(xml) { const raw = {}; for (const field of RAW_FIELDS) raw[field] = text(xml, field); return { raw, hasData: Object.values(raw).some(v => v !== null) }; }
async function read(api) { return parseWan(await api.xmlRequest("GET", "wan")); }
async function detect(api) { const wan = await read(api); return { supported: wan.hasData, readOnly: true, wan, modes: NETWORK_MODES }; }
function unsupported() { return { outcome: "unsupported", ok: false, title: "Cellular control unavailable", message: "No universal write contract is confirmed." }; }
async function executeReconnect() { return unsupported(); }
async function executeSetMode() { return unsupported(); }
function modeById() { return null; }
function modes() { return NETWORK_MODES; }
module.exports = { RAW_FIELDS, NETWORK_MODES, parseWan, read, detect, executeReconnect, executeSetMode, modeById, modes };
