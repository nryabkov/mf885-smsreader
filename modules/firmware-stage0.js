const GOLDEN_IMAGE = Object.freeze({
  id: "golden-2.5.94",
  kind: "golden",
  file: "MF885_firmware_backup_20260808_095130.bin",
  size: 8323644,
  sha256: "2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531",
  restoreMethod: "RestoreFw"
});

const WEBUI_CANARY_R3 = Object.freeze({
  id: "0.0-canary-webui-r3",
  kind: "webui-canary",
  file: "MF885_Community_0.0-canary-webui-r3.bin",
  size: 8323644,
  sha256: "f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c",
  baseSha256: GOLDEN_IMAGE.sha256,
  restoreMethod: "RestoreFw",
  nativeOsloPatch: false,
  logicalChanges: ["WEBI:www/index.html"]
});

const SAFE_IMAGES = Object.freeze([GOLDEN_IMAGE, WEBUI_CANARY_R3]);
const REQUIRED_FIRMWARE = "2.5.94_release_MF855_NZ_CP_2.129.003";
const MIN_BATTERY_PERCENT = 50;

const TRANSACTION_STATES = Object.freeze({
  IDLE: "IDLE",
  PRECHECK_OK: "PRECHECK_OK",
  POST_SENT: "POST_SENT",
  RESTORING: "RESTORING",
  REBOOT_WAIT: "REBOOT_WAIT",
  BOOT_VERIFIED: "BOOT_VERIFIED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN"
});

function cleanSha(value) {
  return String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
}

function lookupImage(meta) {
  const size = Number(meta && meta.size);
  const sha256 = cleanSha(meta && meta.sha256);
  return SAFE_IMAGES.find(image => image.size === size && image.sha256 === sha256) || null;
}

function validateImage(meta) {
  const image = lookupImage(meta);
  const errors = [];
  if (!meta || Number(meta.size) !== GOLDEN_IMAGE.size) errors.push(`Unexpected image size; expected ${GOLDEN_IMAGE.size} bytes.`);
  if (!/^[0-9a-f]{64}$/.test(cleanSha(meta && meta.sha256))) errors.push("A full SHA-256 digest is required.");
  if (!image) errors.push("Image SHA-256 is not present in the Stage 0 allowlist.");
  return { ok: errors.length === 0, image, errors };
}

function normalizedDevice(device) {
  const source = device || {};
  return {
    model: String(source.model || source.modelName || source.deviceName || "").trim(),
    hardware: String(source.hardware || source.hardwareVersion || source.revision || "").trim(),
    firmware: String(source.firmware || source.version || source.versionNum || "").trim()
  };
}

function validateDevice(device) {
  const value = normalizedDevice(device);
  const errors = [];
  if (!/(?:^|\b)MF885(?:\b|$)|MF96-ROUTER-C2/i.test(value.model)) errors.push("Device model is not positively identified as MF885 / MF96-ROUTER-C2.");
  if (!/Ver\.?\s*D/i.test(value.hardware)) errors.push("Hardware revision is not positively identified as Ver.D.");
  if (value.firmware !== REQUIRED_FIRMWARE) errors.push(`Base firmware must be exactly ${REQUIRED_FIRMWARE}.`);
  return { ok: errors.length === 0, value, errors };
}

function validatePower(power) {
  const batteryPercent = Number(power && power.batteryPercent);
  const chargerConnected = power && power.chargerConnected === true;
  const errors = [];
  if (!Number.isFinite(batteryPercent)) errors.push("Battery percentage is unavailable.");
  else if (batteryPercent < MIN_BATTERY_PERCENT) errors.push(`Battery must be at least ${MIN_BATTERY_PERCENT}%.`);
  if (!chargerConnected) errors.push("Stable external USB power must be connected.");
  return { ok: errors.length === 0, batteryPercent, chargerConnected, errors };
}

function preflight(input) {
  const image = validateImage(input && input.image);
  const device = validateDevice(input && input.device);
  const power = validatePower(input && input.power);
  const transportVerified = input && input.restoreTransportVerified === true;
  const errors = [...image.errors, ...device.errors, ...power.errors];
  if (!transportVerified) errors.push("RestoreFw multipart transport is not live-verified; destructive send is locked.");
  return {
    ok: errors.length === 0,
    destructiveAllowed: errors.length === 0,
    image: image.image,
    device: device.value,
    power: { batteryPercent: power.batteryPercent, chargerConnected: power.chargerConnected },
    restoreTransportVerified: transportVerified,
    errors
  };
}

function parseRestoreStatus(xml, firstText) {
  const get = typeof firstText === "function"
    ? names => firstText(xml, names) || ""
    : names => {
        const source = String(xml || "");
        for (const name of names) {
          const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
          if (match) return String(match[1]).replace(/<[^>]+>/g, "").trim();
        }
        return "";
      };
  return {
    status: get(["restore_status"]),
    progress: get(["restore_progress"]),
    failCause: get(["restore_fail_cause"])
  };
}

function createTransaction(preflightReport, now = Date.now()) {
  if (!preflightReport || !preflightReport.destructiveAllowed) {
    throw new Error("Stage 0 transaction cannot start before all destructive gates pass.");
  }
  return {
    schema: 1,
    startedAt: now,
    state: TRANSACTION_STATES.PRECHECK_OK,
    imageId: preflightReport.image.id,
    imageSha256: preflightReport.image.sha256,
    destructivePostCount: 0,
    events: [{ at: now, event: "PRECHECK_OK" }]
  };
}

function transition(transaction, event, detail = "", now = Date.now()) {
  if (!transaction || typeof transaction !== "object") throw new Error("Invalid Stage 0 transaction.");
  const tx = { ...transaction, events: Array.isArray(transaction.events) ? transaction.events.slice() : [] };
  const name = String(event || "");
  if (name === "POST_SENT") {
    if (tx.destructivePostCount !== 0) throw new Error("RestoreFw destructive POST must never be retried automatically.");
    if (tx.state !== TRANSACTION_STATES.PRECHECK_OK) throw new Error("RestoreFw POST is only allowed immediately after PRECHECK_OK.");
    tx.destructivePostCount = 1;
    tx.state = TRANSACTION_STATES.POST_SENT;
  } else if (name === "RESTORING") {
    if (tx.destructivePostCount !== 1) throw new Error("RESTORING requires exactly one prior destructive POST.");
    tx.state = TRANSACTION_STATES.RESTORING;
  } else if (name === "REBOOT_WAIT") {
    if (tx.destructivePostCount !== 1) throw new Error("REBOOT_WAIT requires exactly one prior destructive POST.");
    tx.state = TRANSACTION_STATES.REBOOT_WAIT;
  } else if (name === "BOOT_VERIFIED") {
    if (tx.destructivePostCount !== 1) throw new Error("BOOT_VERIFIED requires exactly one prior destructive POST.");
    tx.state = TRANSACTION_STATES.BOOT_VERIFIED;
  } else if (name === "FAILED") {
    tx.state = TRANSACTION_STATES.FAILED;
  } else if (name === "UNKNOWN") {
    tx.state = TRANSACTION_STATES.UNKNOWN;
  } else {
    throw new Error(`Unknown Stage 0 transaction event: ${name}`);
  }
  tx.events.push({ at: now, event: name, detail: String(detail || "") });
  return tx;
}

function canSendRestore(transaction) {
  return !!transaction && transaction.state === TRANSACTION_STATES.PRECHECK_OK && transaction.destructivePostCount === 0;
}

module.exports = {
  GOLDEN_IMAGE,
  WEBUI_CANARY_R3,
  SAFE_IMAGES,
  REQUIRED_FIRMWARE,
  MIN_BATTERY_PERCENT,
  TRANSACTION_STATES,
  lookupImage,
  validateImage,
  normalizedDevice,
  validateDevice,
  validatePower,
  preflight,
  parseRestoreStatus,
  createTransaction,
  transition,
  canSendRestore
};
