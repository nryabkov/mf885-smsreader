// MF885 UI v2 entrypoint.
// It preserves the proven router backend in scriptable.js and replaces only
// the WebView renderer plus the polling payload used by that renderer.

function isLv01Device(model) {
  return /^LV01$/i.test(String(model && model.actualModel || "").trim());
}

function uiDeviceModel(rawModel) {
  const value = String(rawModel || "").trim();
  return /^LV01$/i.test(value) ? "MF885" : value;
}

function normalizeUiBattery(battery = {}, model = {}) {
  const source = battery || {};
  const normalized = { ...source };
  if (!isLv01Device(model)) return normalized;

  const rawBattery = String(source.rawStatus || "").trim();
  const rawCharger = String(source.rawChargerStatus || source.chargerStatus || "").trim();
  const chargerCurrent = Number(source.chargerCurrent);
  const outputCurrent = Number(source.outputCurrent);
  const backendInput = !!(source.inputConnected || source.chargerConnected);
  const backendOutput = !!(source.usbOutputActive || source.usbHostActive);
  const measuredInput = Number.isFinite(chargerCurrent) && chargerCurrent > 0;
  const measuredOutput = Number.isFinite(outputCurrent) && outputCurrent > 0;

  // LV01 status1 uses a different numeric battery enum from the legacy parser.
  // On this firmware the observed externally-powered signature is
  // Battery_status=1 together with Charger_status=4. Scope this compatibility
  // rule to LV01 only so other MF855/MF885 builds keep their existing mapping.
  const lv01Input = rawBattery === "1" && rawCharger === "4";
  const inputConnected = backendInput || measuredInput || lv01Input;
  const usbOutputActive = backendOutput || measuredOutput;
  const percent = Number(source.percent);
  const full = inputConnected && Number.isFinite(percent) && percent >= 98;
  const legacyState = String(source.powerStatus || source.state || "").toLowerCase();

  let state;
  if (full) state = usbOutputActive ? "full-and-powering-usb" : "full";
  else if (inputConnected) state = usbOutputActive ? "charging-and-powering-usb" : "charging";
  else if (usbOutputActive) state = "powering-usb";
  else if (legacyState === "full" || legacyState === "discharging") state = legacyState;
  else state = "unknown";

  const labels = {
    charging: "Charging",
    discharging: "Discharging",
    "powering-usb": "Powering USB device",
    "charging-and-powering-usb": "Charging · Powering USB device",
    full: "Full",
    "full-and-powering-usb": "Full · Powering USB device",
    unknown: "Unknown"
  };

  normalized.inputConnected = inputConnected;
  normalized.chargerConnected = inputConnected;
  normalized.charging = inputConnected;
  normalized.usbOutputActive = usbOutputActive;
  normalized.usbHostActive = usbOutputActive;
  normalized.powerStatus = state;
  normalized.state = state;
  normalized.status = labels[state];
  normalized.detailText = labels[state];
  return normalized;
}

function normalizeUiModel(model = {}) {
  const normalized = { ...(model || {}) };
  const rawModel = String(normalized.actualModel || "").trim();
  normalized.actualRawModel = rawModel;
  normalized.actualModel = uiDeviceModel(rawModel) || rawModel;
  normalized.battery = normalizeUiBattery(normalized.battery || {}, model || {});
  return normalized;
}

async function run(options = {}) {
  if (!options.moduleDirectory) throw new Error("The application module directory was not provided by the loader.");
  const fm = FileManager.local();
  const sourcePath = fm.joinPath(options.moduleDirectory, "scriptable.js");
  if (!fm.fileExists(sourcePath)) throw new Error("Base application module scriptable.js is missing.");
  const ui = importModule(`${options.moduleDirectory}/modules/ui-v2.js`);
  const uiFixes = importModule(`${options.moduleDirectory}/modules/ui-v2-fixes.js`);
  if (!ui || typeof ui.buildHtml !== "function") throw new Error("UI v2 module is invalid.");
  if (!uiFixes || typeof uiFixes.enhanceHtml !== "function") throw new Error("UI v2 fixes module is invalid.");

  let source = fm.readString(sourcePath);
  const buildMarker = "function buildHtml(model) {";
  const pollMarker = "function webPollPayload(model) {";
  if (!source.includes(buildMarker) || !source.includes(pollMarker)) {
    throw new Error("Base application changed incompatibly with UI v2 adapter.");
  }

  // Rename only the legacy renderer/payload. The new functions below are in
  // the same lexical module scope, so all existing dashboard/auth/dispatcher
  // code automatically uses them without duplicating router logic.
  source = source.replace(buildMarker, "function legacyBuildHtml(model) {");
  source = source.replace(pollMarker, "function legacyWebPollPayload(model) {");
  source = `
const __MF885_UI_V2 = globalThis.__MF885_UI_V2;
const __MF885_UI_V2_FIXES = globalThis.__MF885_UI_V2_FIXES;
const __MF885_UI_ADAPTER = globalThis.__MF885_UI_ADAPTER;
function buildHtml(model) {
  const uiModel = __MF885_UI_ADAPTER.normalizeUiModel(model);
  let html = __MF885_UI_V2.buildHtml(uiModel);
  html = __MF885_UI_V2_FIXES.enhanceHtml(html, uiModel);
  // The proven backend validates legacy structural hooks before WebView load.
  // UI v2 uses .screen instead of .tab and originally omitted <main>, so add
  // non-visual compatibility structure without changing the rendered design.
  if (!/<main(?:\\s|>)/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, '<body$1><main>')
      .replace(/<\\/body>/i, '</main></body>');
  }
  if (!/<section[^>]*class=["'][^"']*\\btab\\b[^"']*\\bactive\\b[^"']*["']/i.test(html)) {
    html = html.replace(/<main(?:\\s[^>]*)?>/i, match => match + '<section class="tab active" hidden aria-hidden="true"></section>');
  }
  return html;
}
function webPollPayload(model) {
  const battery = __MF885_UI_ADAPTER.normalizeUiBattery(model && model.battery || {}, model || {});
  const network = model && model.network || {};
  const traffic = model && model.traffic || {};
  const chargerCurrent = battery.chargerCurrent === undefined ? null : battery.chargerCurrent;
  const outputCurrent = battery.outputCurrent === undefined ? null : battery.outputCurrent;
  const chargerConnected = !!(battery.inputConnected || battery.chargerConnected);
  const usbHostActive = !!(battery.usbOutputActive || battery.usbHostActive);
  const batteryPowerStatus = battery.powerStatus || battery.state || "unknown";
  return {
    loadedAt: model.loadedAt,
    smsCount: model.sms && model.sms.messages ? model.sms.messages.length : 0,
    smsFingerprint: model.sms && model.sms.fingerprint || "",
    smsMessages: model.sms && model.sms.messages || [],
    smsTotalMessages: model.sms && model.sms.totalMessages,
    networkMode: network.mode || network.networkError || "Unknown",
    networkGeneration: network.generation || "Unknown",
    preferredMode: network.preferredMode || "Unknown",
    networkSource: network.networkSource || null,
    networkRawCode: network.rawMode || null,
    networkConflict: !!network.networkConflict,
    dbm: network.dbm,
    bars: network.bars,
    signalBars: network.bars,
    lac: network.lac || null,
    cellId: network.cellId || null,
    pci: network.pci || null,
    batteryInline: batteryInlineLabel(battery),
    batteryStatus: battery.status || "Unknown",
    batteryPowerStatus,
    batteryPercent: battery.percent,
    batteryChargerCurrent: chargerCurrent,
    batteryOutputCurrent: outputCurrent,
    chargerConnected,
    usbHostActive,
    operator: network.operator || "",
    roaming: network.fields && network.fields.roaming || null,
    signalRaw: network.signalRaw || null,
    trafficTotal: formatBytes(traffic.total),
    trafficDown: formatBytes(traffic.download),
    trafficUp: formatBytes(traffic.upload),
    connectionTime: formatDuration(traffic.sessionSeconds),
    pollSeconds: Number(model.pollSeconds) || POLL_SECONDS,
    powerControls: model.powerControls || { available:false, reason:"Power controls are unavailable for this live device identity.", actions:{} },
    cellularDiagnostics: model.cellularDiagnostics || {},
    errors: model.errors || {}
  };
}
` + source;

  const moduleShim = { exports: {} };
  globalThis.__MF885_UI_V2 = ui;
  globalThis.__MF885_UI_V2_FIXES = uiFixes;
  globalThis.__MF885_UI_ADAPTER = { normalizeUiModel, normalizeUiBattery };
  try {
    // Preserve the base application's original require semantics. On Scriptable
    // require may not exist; passing undefined keeps its top-level optional
    // require() block disabled, after which run(options) loads modules by the
    // absolute moduleDirectory path exactly as before.
    const nativeRequire = typeof require === "function" ? require : undefined;
    const factory = new Function("module", "exports", "require", "importModule", source + "\nreturn module.exports;");
    const application = factory(moduleShim, moduleShim.exports, nativeRequire, importModule);
    if (!application || typeof application.run !== "function") throw new Error("Adapted application does not export run(options).");
    await application.run(options);
  } finally {
    try { delete globalThis.__MF885_UI_V2; } catch (_) { globalThis.__MF885_UI_V2 = null; }
    try { delete globalThis.__MF885_UI_V2_FIXES; } catch (_) { globalThis.__MF885_UI_V2_FIXES = null; }
    try { delete globalThis.__MF885_UI_ADAPTER; } catch (_) { globalThis.__MF885_UI_ADAPTER = null; }
  }
}

module.exports = { run, isLv01Device, uiDeviceModel, normalizeUiBattery, normalizeUiModel };
