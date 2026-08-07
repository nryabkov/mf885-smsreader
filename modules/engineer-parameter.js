const SECTIONS = ["LTE", "UMTS", "GSM", "GPRS"];
function decode(s) { return String(s).replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&"); }
function parseSection(xml, name) {
  const match = String(xml || "").match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"));
  if (!match) return { available: false, raw: {} };
  const raw = {}; let node; const re = /<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  while ((node = re.exec(match[1]))) { const key = node[1], value = decode(node[2].trim()); if (raw[key] === undefined) raw[key] = value; else raw[key] = [].concat(raw[key], value); }
  return { available: Object.keys(raw).length > 0, raw };
}
function parseEngineerParameter(xml) { const sections = {}; for (const name of SECTIONS) sections[name] = parseSection(xml, name); return { sections, active: SECTIONS.find(name => sections[name].available) || null }; }
async function load(api) { return parseEngineerParameter(await api.xmlRequest("GET", "Engineer_parameter")); }
module.exports = { SECTIONS, parseEngineerParameter, load };
