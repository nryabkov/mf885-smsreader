// WAN writes are profile-driven. Unknown firmware remains read-only.
const RAW_FIELDS = ["connect_disconnect", "connect_mode", "NW_mode", "prefer_mode", "prefer_lte_type", "pdp_enable", "connect_action", "disconnect_action", "pdp_action", "manual_network", "network_select", "apn", "pdp_type", "username", "auth_type"];

function text(xml, name) { const m = String(xml || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i")); return m ? m[1].trim() : null; }
function parseWan(xml) { const raw = {}; for (const field of RAW_FIELDS) raw[field] = text(xml, field); return { raw, hasData: Object.values(raw).some(v => v !== null) }; }
function operation(profile, name) { return profile && profile.wan && profile.wan.operations && profile.wan.operations[name] && profile.wan.operations[name].confirmed !== false ? profile.wan.operations[name] : null; }
function buildTree(op, escapeXml = value => String(value)) {
  const root = op.root === "cellular" ? "<wan><cellular>" : "<wan>";
  const close = op.root === "cellular" ? "</cellular></wan>" : "</wan>";
  return `<RGW>${root}${Object.keys(op.fields).map(k => `<${k}>${escapeXml(op.fields[k])}</${k}>`).join("")}${close}</RGW>`;
}
async function read(api) { return parseWan(await api.xmlRequest("GET", "wan")); }
async function detect(api, profile) { const wan = await read(api); return { supported: wan.hasData, readOnly: !profile || !profile.wan, wan, modes: profile && profile.wan && profile.wan.modes || [] }; }
async function execute(api, profile, name) {
  const op = operation(profile, name);
  if (!op) return { outcome: "unsupported", ok: false, title: "Cellular control unavailable", message: "No confirmed mapping exists for this firmware." };
  const before = await read(api);
  const result = await api.writeThenVerify({ model: "wan", xml: buildTree(op, api.escapeXml), verificationModel: "wan", post: (m,x) => api.xmlRequest("POST",m,x), get: () => api.xmlRequest("GET","wan"), verify: xml => op.verify(parseWan(xml), before) });
  return { ...result, ok: result.outcome === "confirmed", title: "Cellular operation", message: result.outcome };
}
async function executeReconnect(api, capability, profile) { return execute(api, profile || capability && capability.profile, "reconnect"); }
async function executeSetMode(api, capability, modeId, profile) { return execute(api, profile || capability && capability.profile, `mode:${modeId}`); }
function modeById(id, profile) { return profile && profile.wan && (profile.wan.modes || []).find(x => x.id === id) || null; }
function modes(profile) { return profile && profile.wan ? profile.wan.modes || [] : []; }
module.exports = { RAW_FIELDS, parseWan, read, detect, execute, executeReconnect, executeSetMode, modeById, modes, buildTree };
