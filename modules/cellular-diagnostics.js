// Normalise the read-only cellular information exposed by different ZMI XML trees.
// Enum labels are used only when the active compatibility profile confirms them.
const FIELD_ALIASES = {
  configuredApn: ["apn", "APN", "profile_apn", "configured_apn"],
  activeApn: ["active_apn", "current_apn", "used_apn", "wan_apn"],
  pdpType: ["pdp_type", "PDP_type", "ip_type", "PDPType"],
  sim: ["SIM_status", "sim_status", "sim_state", "sim_ready"],
  registration: ["NW_register_status", "network_registration", "registration_status", "reg_status"],
  roaming: ["roaming", "roaming_status", "roam_status"],
  pdpState: ["connect_disconnect", "pdp_state", "pdp_status", "connection_status"],
  pdpError: ["pdp_error", "PDP_error", "last_error", "error_code"],
  pdpCause: ["pdp_cause", "PDP_cause", "cause", "cause_code"],
  ipv4: ["ipv4", "ip_address", "wan_ip", "IP_address"],
  ipv6: ["ipv6", "ipv6_address", "wan_ipv6", "IPv6_address"],
  gateway4: ["gateway", "ipv4_gateway", "wan_gateway", "gateway_ip"],
  gateway6: ["ipv6_gateway", "gateway_ipv6"],
  dns1: ["dns1", "primary_dns", "pri_dns", "DNS1"],
  dns2: ["dns2", "secondary_dns", "sec_dns", "DNS2"],
  band: ["band", "lte_band", "LTE_band", "frequency_band"],
  pci: ["pci", "PCI", "physical_cell_id"],
  earfcn: ["earfcn", "EARFCN", "dl_earfcn"],
  rsrp: ["rsrp", "RSRP"], rsrq: ["rsrq", "RSRQ"], sinr: ["sinr", "SINR", "snr"]
};

function decode(value) { return String(value).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'"); }
function leafValues(xml) {
  const out = []; let match;
  const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/gi;
  while ((match = re.exec(String(xml || "")))) out.push({ name: match[1], value: decode(match[2].trim()) });
  return out;
}
function find(responses, aliases) {
  for (const source of Object.keys(responses || {})) {
    const leaves = leafValues(responses[source]);
    for (const alias of aliases) {
      const hit = leaves.find(item => item.name.toLowerCase() === alias.toLowerCase() && item.value !== "");
      if (hit) return { raw: hit.value, source: `${source}:${hit.name}` };
    }
  }
  return { raw: null, source: null };
}
function diagnostic(name, responses, profile) {
  const hit = find(responses, FIELD_ALIASES[name]);
  const mapping = profile && profile.wan && profile.wan.mappings && profile.wan.mappings[name];
  const mapped = hit.raw !== null && mapping && Object.prototype.hasOwnProperty.call(mapping, hit.raw) ? mapping[hit.raw] : null;
  // Plain values are not enums and therefore do not need decoding, but their
  // origin still remains visible. Enum-like fields never receive guessed labels.
  const enumField = ["sim", "registration", "roaming", "pdpState", "pdpError", "pdpCause", "pdpType"].includes(name);
  return { value: hit.raw === null ? null : (mapped !== null ? mapped : enumField ? `Unknown (raw: ${hit.raw})` : hit.raw), raw: hit.raw, source: hit.source, confirmed: mapped !== null };
}
function stage(state, detail, raw) { return { state, detail, raw: raw === undefined ? null : raw }; }
function normalize(responses, profile) {
  const values = {}; for (const name of Object.keys(FIELD_ALIASES)) values[name] = diagnostic(name, responses, profile);
  const is = (field, values) => field.confirmed && values.includes(String(field.raw));
  const sim = values.sim.raw === null ? stage("unknown", "SIM status unavailable") : is(values.sim, ["1", "ready", "READY"]) ? stage("ok", values.sim.value) : is(values.sim, ["0", "initializing"]) ? stage("pending", values.sim.value) : values.sim.confirmed ? stage("failed", values.sim.value, values.sim.raw) : stage("unknown", values.sim.value, values.sim.raw);
  const registration = values.registration.raw === null ? stage("unknown", "Registration unavailable") : is(values.registration, ["1", "registered", "home", "5", "roaming"]) ? stage("ok", values.registration.value) : is(values.registration, ["2", "searching"]) ? stage("pending", values.registration.value) : values.registration.confirmed ? stage("failed", values.registration.value, values.registration.raw) : stage("unknown", values.registration.value, values.registration.raw);
  const pdp = values.pdpState.raw === null ? stage("unknown", "PDP status unavailable") : is(values.pdpState, ["1", "connected", "active"]) ? stage("ok", values.pdpState.value) : is(values.pdpState, ["2", "connecting"]) ? stage("pending", values.pdpState.value) : values.pdpState.confirmed ? stage("failed", values.pdpState.value, values.pdpCause.raw || values.pdpError.raw) : stage("unknown", values.pdpState.value, values.pdpCause.raw || values.pdpError.raw);
  const hasIp = !!(values.ipv4.raw || values.ipv6.raw); const hasDns = !!(values.dns1.raw || values.dns2.raw);
  return { values, stages: { sim, registration: { ...registration, roaming: values.roaming }, pdp, ip: stage(hasIp ? "ok" : pdp.state === "ok" ? "pending" : "unknown", hasIp ? "Address assigned" : "No IP address"), dns: stage(hasDns ? "ok" : hasIp ? "pending" : "unknown", hasDns ? "DNS available" : "No DNS servers") }, endpointErrors: responses && responses.__errors || {} };
}

module.exports = { FIELD_ALIASES, leafValues, normalize };
