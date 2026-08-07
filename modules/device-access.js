// Experimental diagnostic/device-access probes isolated from the dashboard.
// Safe detection only uses GET requests. State-changing commands are exposed
// only through execute() and must be confirmed by the UI before calling it.

const CAPABILITIES = [
  {
    id: "tryEnableAdb",
    title: "Try to enable ADB",
    description: "Attempt to enable the firmware ADB/debug bridge, if this build exposes it.",
    probes: ["adb", "adb_enable", "debug", "debug_adb", "device_debug"],
    attempts: [
      { type: "routerCall", path: "debug", method: "enable_adb" },
      { type: "xml", file: "adb", root: "adb", field: "enable", value: "1" },
      { type: "xml", file: "debug", root: "debug", field: "adb", value: "1" }
    ]
  },
  {
    id: "tryOpenShell",
    title: "Try to enable vendor shell",
    description: "Attempt to enable a vendor shell/debug service, if present.",
    probes: ["shell", "open_shell", "debug_shell", "device_debug"],
    attempts: [
      { type: "routerCall", path: "debug", method: "open_shell" },
      { type: "xml", file: "shell", root: "shell", field: "open", value: "1" },
      { type: "xml", file: "debug", root: "debug", field: "shell", value: "1" }
    ]
  }
];

const TELNET_METADATA = Object.freeze({ id: "tryEnableTelnet", title: "Telnet", description: "Enable Telnet only when the active firmware profile contains a fully confirmed contract.", telnet: true });
function capabilities() {
  return CAPABILITIES.map(({ id, title, description }) => ({ id, title, description })).concat([{ ...TELNET_METADATA }]);
}

async function detect(api) {
  const diagnostics = [];
  for (const file of uniqueProbeFiles()) {
    try {
      const xml = await api.xmlRequest("GET", file, null, true, 5);
      diagnostics.push({ file, status: classify(xml), detail: compact(xml) });
    } catch (error) {
      diagnostics.push({ file, status: "error", detail: api.cleanError(error) });
    }
  }
  return {
    supported: diagnostics.some(item => item.status === "responded") ? true : null,
    detail: "Safe GET diagnostics completed. Execution actions are experimental and require a separate confirmation.",
    capabilities: capabilities().map(item => {
      const definition=CAPABILITIES.find(candidate=>candidate.id===item.id);
      return { ...item, supported:!!definition && definition.probes.some(file=>diagnostics.some(probe=>probe.file===file&&probe.status==="responded")) };
    }),
    diagnostics
  };
}

async function execute(api, capability, action) {
  const item = CAPABILITIES.find(entry => entry.id === capability || entry.id === action);
  if (!item) throw new Error("Unknown device-access capability");
  const attempts = [];
  for (const attempt of item.attempts) {
    try {
      const response = attempt.type === "routerCall"
        ? await api.routerCall(attempt.path, attempt.method)
        : await api.xmlRequest("POST", attempt.file, buildRequest(attempt, api.escapeXml), true, 15);
      attempts.push(`${attemptName(attempt)}: ${compact(response)}`);
      if (accepted(response)) {
        return { ok: true, title: item.title, message: "The router accepted the experimental debug command. If the feature exists, it may take a few seconds to become reachable.", diagnostics: attempts.join("\n") };
      }
    } catch (error) {
      attempts.push(`${attemptName(attempt)}: ${api.cleanError(error)}`);
    }
  }
  return { ok: false, title: item.title, message: "The router did not enable this feature. This firmware may not expose the known debug endpoint.", diagnostics: attempts.join("\n") };
}

function buildRequest(attempt, escapeXml) {
  return `<?xml version="1.0" encoding="US-ASCII"?><RGW><${attempt.root}><${attempt.field}>${escapeXml(attempt.value)}</${attempt.field}></${attempt.root}></RGW>`;
}
function uniqueProbeFiles() { return Array.from(new Set(CAPABILITIES.flatMap(item => item.probes))); }
function classify(xml) { const text = String(xml || ""); return isUnsupported(text) ? "rejected" : "responded"; }
function isUnsupported(xml) { return /not.?found|unknown.?file|not.?support|unsupported|invalid.?file|unauthorized/i.test(String(xml || "")); }
function accepted(xml) { return !isUnsupported(xml) && !/error|fail|denied|<status>\s*(?:2|3|4|5|-1)\s*<\/status>/i.test(String(xml || "")); }
function attemptName(attempt) { return attempt.type === "routerCall" ? `routerCall ${attempt.path}/${attempt.method}` : `${attempt.file}/${attempt.field}`; }
function compact(value) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300); }

module.exports = { capabilities, detect, execute };
