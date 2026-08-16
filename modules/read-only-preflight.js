const READ_ONLY_ENDPOINTS = Object.freeze([
  "status1",
  "wan",
  "Engineer_parameter",
  "miautosleep",
  "smart_set",
  "uapxb_wlan_basic_settings",
  "autoreboot"
]);

const FORBIDDEN_ENDPOINTS = Object.freeze([
  "RestoreFw",
  "BackupFwStart",
  "RestoreBackup",
  "reset",
  "poweroff",
  "restore_defaults",
  "debugmodeon"
]);

function cleanError(error) {
  const source = String(error && error.message || error || "");
  const http = source.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) return `HTTP ${http[1]}`;
  if (/authori[sz]ation|unauthorized|\b401\b/i.test(source)) return "Authorization failed";
  if (/timed?\s*out|timeout/i.test(source)) return "Request timed out";
  if (/network|connection|socket|offline|not connected/i.test(source)) return "Network request failed";
  return "Endpoint unavailable";
}

function firstText(xml, names) {
  const source = String(xml || "");
  for (const name of names) {
    const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
    if (match) return String(match[1]).replace(/<[^>]+>/g, "").trim();
  }
  return "";
}

function present(xml, names) {
  return names.some(name => new RegExp(`<${name}\\b`, "i").test(String(xml || "")));
}

function endpointSummary(xml) {
  const source = String(xml || "");
  return {
    ok: true,
    bytes: source.length,
    unauthorized: /unauthorized/i.test(source)
  };
}

function normalizeModel(value) {
  return /^LV01$/i.test(String(value || "").trim()) ? "MF885" : String(value || "").trim();
}

function sleepSettings(responses) {
  const sources = [responses.miautosleep, responses.smart_set, responses.uapxb_wlan_basic_settings].filter(Boolean).join("\n");
  return {
    autosleepStatus: firstText(sources, ["autosleep_status"]),
    wifiSleepTime: firstText(sources, ["wifi_sleep_time"]),
    wifiSleepAction: firstText(sources, ["wifi_sleep_action"]),
    wpsButtonEffect: firstText(sources, ["wpsbtneffect"]),
    fieldsPresent: {
      autosleepStatus: present(sources, ["autosleep_status"]),
      wifiSleepTime: present(sources, ["wifi_sleep_time"]),
      wifiSleepAction: present(sources, ["wifi_sleep_action"]),
      wpsButtonEffect: present(sources, ["wpsbtneffect"])
    }
  };
}

function rebootSettings(xml) {
  return {
    enabled: firstText(xml, ["autoreboot_enabled"]),
    time: firstText(xml, ["autoreboot_time"]),
    fieldsPresent: {
      enabled: present(xml, ["autoreboot_enabled"]),
      time: present(xml, ["autoreboot_time"])
    }
  };
}

async function collect(api, options = {}) {
  if (!api || typeof api.get !== "function") throw new Error("Read-only preflight requires a GET-only API adapter.");
  const startedAt = Number(options.now || Date.now());
  const responses = {};
  const endpoints = {};
  const calls = [];

  for (const endpoint of READ_ONLY_ENDPOINTS) {
    if (FORBIDDEN_ENDPOINTS.includes(endpoint)) throw new Error(`Unsafe endpoint entered read-only allowlist: ${endpoint}`);
    calls.push({ method: "GET", endpoint });
    try {
      const xml = await api.get(endpoint);
      responses[endpoint] = String(xml || "");
      endpoints[endpoint] = endpointSummary(xml);
    } catch (error) {
      endpoints[endpoint] = { ok: false, error: cleanError(error) };
    }
  }

  const status = responses.status1 || "";
  const wan = responses.wan || "";
  const rawModel = firstText(status, ["model", "model_name", "product_name"]);
  const firmware = firstText(status, ["version_num"]);
  const hardware = firstText(status, ["revision", "hardware_version", "hardware_ver", "hw_version"]);
  const batteryPercent = firstText(status, ["Battery_percent", "battery_percent"]);
  const batteryStatus = firstText(status, ["Battery_status", "battery_status"]);
  const chargerStatus = firstText(status, ["Charger_status", "charger_status", "CDetectStatus"]);
  const operatorPresent = present(status + wan, ["network_name", "ISP_name", "operator"]);
  const apnPresent = present(status + wan, ["lte_apn", "configured_apn", "active_apn", "APN"]);

  return {
    schema: 1,
    mode: "read-only",
    generatedAt: startedAt,
    identity: {
      model: normalizeModel(rawModel),
      rawModel,
      hardware,
      firmware,
      exactFirmware: firmware === "2.5.94_release_MF855_NZ_CP_2.129.003"
    },
    power: { batteryPercent, batteryStatus, chargerStatus },
    network: { operatorPresent, apnPresent },
    sleep: sleepSettings(responses),
    autoReboot: rebootSettings(responses.autoreboot || ""),
    endpoints,
    safety: {
      methodsUsed: ["GET"],
      calls,
      writesAttempted: 0,
      forbiddenEndpointsTouched: calls.some(call => FORBIDDEN_ENDPOINTS.includes(call.endpoint)),
      restoreTransportVerified: false,
      flashAllowed: false
    }
  };
}

function format(report) {
  return JSON.stringify(report, null, 2);
}

module.exports = {
  READ_ONLY_ENDPOINTS,
  FORBIDDEN_ENDPOINTS,
  cleanError,
  firstText,
  collect,
  format
};
