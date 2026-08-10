// MF885 UI v2 entrypoint.
// It preserves the proven router backend in scriptable.js and replaces only
// the WebView renderer plus the polling payload used by that renderer.

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
function buildHtml(model) {
  let html = __MF885_UI_V2.buildHtml(model);
  html = __MF885_UI_V2_FIXES.enhanceHtml(html, model);
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
  const battery = model && model.battery || {};
  const network = model && model.network || {};
  const traffic = model && model.traffic || {};
  const chargerCurrent = battery.chargerCurrent === undefined ? null : battery.chargerCurrent;
  const outputCurrent = battery.outputCurrent === undefined ? null : battery.outputCurrent;
  const chargerStatus = String(battery.chargerStatus || battery.rawChargerStatus || "");
  const chargerConnected = !!battery.charging || (Number(chargerCurrent) > 0) || /charg|adapter|usb|ac|plug|online/i.test(chargerStatus);
  const usbHostActive = Number(outputCurrent) > 0;
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
    cellularDiagnostics: model.cellularDiagnostics || {},
    errors: model.errors || {}
  };
}
` + source;

  const moduleShim = { exports: {} };
  globalThis.__MF885_UI_V2 = ui;
  globalThis.__MF885_UI_V2_FIXES = uiFixes;
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
  }
}

module.exports = { run };
