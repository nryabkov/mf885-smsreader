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
const MAX_LIVE_EVIDENCE_AGE_MS = 60 * 1000;
const MAX_IMAGE_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const JOURNAL_SCHEMA = 2;
const JOURNAL_KEY = "mf885-safeflash-stage0-transaction-v2";

// Intentionally empty. A caller-provided boolean or object must never be able
// to unlock RestoreFw. A captured contract is added here only after its exact
// multipart shape and status polling have been reproduced on the target build.
const VERIFIED_RESTORE_TRANSPORTS = Object.freeze([]);
const AUTHORIZED_PREFLIGHTS = new WeakSet();
const COMPUTED_IMAGE_EVIDENCE = new WeakSet();

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const TRANSACTION_STATES = Object.freeze({
  IDLE: "IDLE",
  PRECHECK_OK: "PRECHECK_OK",
  POST_ARMED: "POST_ARMED",
  POST_SENT: "POST_SENT",
  RESTORING: "RESTORING",
  REBOOT_WAIT: "REBOOT_WAIT",
  BOOT_VERIFIED: "BOOT_VERIFIED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN"
});

const TERMINAL_STATES = Object.freeze([
  TRANSACTION_STATES.BOOT_VERIFIED,
  TRANSACTION_STATES.FAILED,
  TRANSACTION_STATES.UNKNOWN
]);

const ALLOWED_TRANSITIONS = Object.freeze({
  [TRANSACTION_STATES.PRECHECK_OK]: Object.freeze(["POST_ARMED", "FAILED"]),
  [TRANSACTION_STATES.POST_ARMED]: Object.freeze(["POST_SENT", "FAILED", "UNKNOWN"]),
  [TRANSACTION_STATES.POST_SENT]: Object.freeze(["RESTORING", "REBOOT_WAIT", "FAILED", "UNKNOWN"]),
  [TRANSACTION_STATES.RESTORING]: Object.freeze(["RESTORING", "REBOOT_WAIT", "FAILED", "UNKNOWN"]),
  [TRANSACTION_STATES.REBOOT_WAIT]: Object.freeze(["BOOT_VERIFIED", "FAILED", "UNKNOWN"]),
  [TRANSACTION_STATES.BOOT_VERIFIED]: Object.freeze([]),
  [TRANSACTION_STATES.FAILED]: Object.freeze([]),
  [TRANSACTION_STATES.UNKNOWN]: Object.freeze([])
});

function cleanSha(value) {
  return String(value || "").trim().toLowerCase().replace(/^sha256:/, "");
}

function byteView(value) {
  if (value && typeof value.getBytes === "function") return value.getBytes();
  if (Array.isArray(value) || value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Firmware bytes must be Scriptable Data, an ArrayBuffer, or a byte array.");
}

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256Hex(value) {
  const bytes = byteView(value);
  const length = Number(bytes.length);
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Firmware byte length is invalid.");
  const totalLength = Math.ceil((length + 9) / 64) * 64;
  const bitLengthHigh = Math.floor(length / 0x20000000) >>> 0;
  const bitLengthLow = (length << 3) >>> 0;
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);

  function paddedByte(index) {
    if (index < length) return Number(bytes[index]) & 0xff;
    if (index === length) return 0x80;
    if (index >= totalLength - 8) {
      const position = index - (totalLength - 8);
      const word = position < 4 ? bitLengthHigh : bitLengthLow;
      return (word >>> ((3 - (position % 4)) * 8)) & 0xff;
    }
    return 0;
  }

  for (let offset = 0; offset < totalLength; offset += 64) {
    for (let index = 0; index < 16; index++) {
      const start = offset + index * 4;
      words[index] = ((paddedByte(start) << 24) | (paddedByte(start + 1) << 16) | (paddedByte(start + 2) << 8) | paddedByte(start + 3)) >>> 0;
    }
    for (let index = 16; index < 64; index++) {
      const w15 = words[index - 15];
      const w2 = words[index - 2];
      const sigma0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = hash[0]; let b = hash[1]; let c = hash[2]; let d = hash[3];
    let e = hash[4]; let f = hash[5]; let g = hash[6]; let h = hash[7];
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return Array.from(hash, word => word.toString(16).padStart(8, "0")).join("");
}

function createImageEvidence(value, verifiedAt = Date.now()) {
  const bytes = byteView(value);
  const digest = sha256Hex(bytes);
  const evidence = Object.freeze({
    size: Number(bytes.length),
    sha256: digest,
    byteLength: Number(bytes.length),
    computedSha256: digest,
    verification: "computed-from-bytes",
    verifiedAt
  });
  COMPUTED_IMAGE_EVIDENCE.add(evidence);
  return evidence;
}

function finiteTimestamp(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function evidenceFresh(observedAt, now, maxAge) {
  const timestamp = finiteTimestamp(observedAt);
  const current = finiteTimestamp(now);
  return timestamp !== null && current !== null && timestamp <= current + 5000 && current - timestamp <= maxAge;
}

function lookupImage(meta) {
  const size = Number(meta && (meta.size === undefined ? meta.byteLength : meta.size));
  const sha256 = cleanSha(meta && (meta.sha256 || meta.computedSha256));
  return SAFE_IMAGES.find(image => image.size === size && image.sha256 === sha256) || null;
}

function validateImage(meta) {
  const image = lookupImage(meta);
  const errors = [];
  const size = Number(meta && (meta.size === undefined ? meta.byteLength : meta.size));
  const sha256 = cleanSha(meta && (meta.sha256 || meta.computedSha256));
  if (!meta || size !== GOLDEN_IMAGE.size) errors.push(`Unexpected image size; expected ${GOLDEN_IMAGE.size} bytes.`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) errors.push("A full SHA-256 digest is required.");
  if (!image) errors.push("Image SHA-256 is not present in the Stage 0 allowlist.");
  return { ok: errors.length === 0, image, errors };
}

function validateImageEvidence(meta, now = Date.now()) {
  const validation = validateImage(meta);
  const errors = validation.errors.slice();
  const byteLength = Number(meta && meta.byteLength);
  const computedSha256 = cleanSha(meta && meta.computedSha256);
  if (!meta || !COMPUTED_IMAGE_EVIDENCE.has(meta)) {
    errors.push("Image evidence was not produced by the Stage 0 byte hasher in this process.");
  }
  if (!meta || meta.verification !== "computed-from-bytes") {
    errors.push("Image evidence must be computed from the exact bytes selected for upload.");
  }
  if (!Number.isFinite(byteLength) || byteLength !== Number(meta && meta.size)) {
    errors.push("Computed byte length does not match image metadata.");
  }
  if (!/^[0-9a-f]{64}$/.test(computedSha256) || computedSha256 !== cleanSha(meta && meta.sha256)) {
    errors.push("Computed SHA-256 does not match image metadata.");
  }
  if (!evidenceFresh(meta && meta.verifiedAt, now, MAX_IMAGE_EVIDENCE_AGE_MS)) {
    errors.push("Image byte verification is missing, stale, or timestamped in the future.");
  }
  return { ok: errors.length === 0, image: validation.image, errors };
}

function normalizedDevice(device) {
  const source = device || {};
  return {
    model: String(source.model || source.modelName || source.deviceName || "").trim(),
    hardware: String(source.hardware || source.hardwareVersion || source.revision || "").trim(),
    firmware: String(source.firmware || source.version || source.versionNum || "").trim(),
    observedAt: finiteTimestamp(source.observedAt),
    source: String(source.source || "").trim()
  };
}

function validateDevice(device, now = Date.now()) {
  const value = normalizedDevice(device);
  const errors = [];
  if (!/^(?:LV01|MF885|MF96-ROUTER-C2)$/i.test(value.model)) errors.push("Device model is not positively identified as LV01 / MF885 / MF96-ROUTER-C2.");
  if (!/Ver\.?\s*D/i.test(value.hardware)) errors.push("Hardware revision is not positively identified as Ver.D.");
  if (value.firmware !== REQUIRED_FIRMWARE) errors.push(`Base firmware must be exactly ${REQUIRED_FIRMWARE}.`);
  if (value.source !== "status1-live") errors.push("Device identity must come from a fresh live status1 read.");
  if (!evidenceFresh(value.observedAt, now, MAX_LIVE_EVIDENCE_AGE_MS)) errors.push("Live device identity is missing, stale, or timestamped in the future.");
  return { ok: errors.length === 0, value, errors };
}

function validatePower(power, now = Date.now()) {
  const batteryPercent = Number(power && power.batteryPercent);
  const chargerConnected = power && power.chargerConnected === true;
  const observedAt = finiteTimestamp(power && power.observedAt);
  const source = String(power && power.source || "").trim();
  const errors = [];
  if (!Number.isFinite(batteryPercent)) errors.push("Battery percentage is unavailable.");
  else if (batteryPercent < MIN_BATTERY_PERCENT) errors.push(`Battery must be at least ${MIN_BATTERY_PERCENT}%.`);
  if (!chargerConnected) errors.push("Stable external USB power must be connected.");
  if (source !== "status1-live") errors.push("Power state must come from a fresh live status1 read.");
  if (!evidenceFresh(observedAt, now, MAX_LIVE_EVIDENCE_AGE_MS)) errors.push("Live power evidence is missing, stale, or timestamped in the future.");
  return { ok: errors.length === 0, batteryPercent, chargerConnected, observedAt, source, errors };
}

function normalizedTransportEvidence(evidence) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  return {
    contractId: String(source.contractId || "").trim(),
    firmware: String(source.firmware || "").trim(),
    restoreMethod: String(source.restoreMethod || "").trim(),
    httpMethod: String(source.httpMethod || "").trim().toUpperCase(),
    requestPath: String(source.requestPath || "").trim(),
    digestUri: String(source.digestUri || "").trim(),
    multipartField: String(source.multipartField || "").trim(),
    statusModel: String(source.statusModel || "").trim(),
    captureSha256: cleanSha(source.captureSha256),
    verifiedAt: finiteTimestamp(source.verifiedAt)
  };
}

function sameTransportContract(evidence, contract) {
  return ["contractId", "firmware", "restoreMethod", "httpMethod", "requestPath", "digestUri", "multipartField", "statusModel", "captureSha256"]
    .every(field => evidence[field] === contract[field]);
}

function validateTransportEvidence(evidence) {
  const value = normalizedTransportEvidence(evidence);
  const errors = [];
  if (!evidence || typeof evidence !== "object") errors.push("RestoreFw requires an immutable transport evidence record; a boolean cannot unlock it.");
  if (value.firmware !== REQUIRED_FIRMWARE) errors.push("RestoreFw evidence does not target the exact base firmware.");
  if (value.restoreMethod !== "RestoreFw" || value.httpMethod !== "POST") errors.push("RestoreFw evidence has the wrong operation or HTTP method.");
  if (value.requestPath !== "/xml_action.cgi" || value.digestUri !== "/cgi/xml_action.cgi") errors.push("RestoreFw request and Digest URIs are not the expected exact pair.");
  if (!value.multipartField || !value.statusModel) errors.push("RestoreFw multipart field and status model must both be proven.");
  if (!/^[0-9a-f]{64}$/.test(value.captureSha256)) errors.push("RestoreFw evidence requires the SHA-256 of a redacted capture artifact.");
  const matched = VERIFIED_RESTORE_TRANSPORTS.find(contract => sameTransportContract(value, contract)) || null;
  if (!matched) errors.push("No matching RestoreFw transport contract is allowlisted in this build; destructive send remains locked.");
  return { ok: errors.length === 0, value, contract: matched, errors };
}

function preflight(input, now = Date.now()) {
  const image = validateImageEvidence(input && input.image, now);
  const device = validateDevice(input && input.device, now);
  const power = validatePower(input && input.power, now);
  const transport = validateTransportEvidence(input && input.restoreTransportEvidence);
  const errors = [...image.errors, ...device.errors, ...power.errors, ...transport.errors];
  if (input && input.restoreTransportVerified === true) {
    errors.push("Legacy restoreTransportVerified=true is ignored; only an allowlisted immutable evidence record can unlock RestoreFw.");
  }
  const report = {
    ok: errors.length === 0,
    destructiveAllowed: errors.length === 0,
    image: image.image,
    device: device.value,
    power: { batteryPercent: power.batteryPercent, chargerConnected: power.chargerConnected, observedAt: power.observedAt, source: power.source },
    restoreTransportEvidence: transport.value,
    errors
  };
  if (report.destructiveAllowed) AUTHORIZED_PREFLIGHTS.add(report);
  return report;
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

function transactionIdFor(report, now) {
  return `stage0-${now}-${report.image.sha256.slice(0, 12)}`;
}

function preflightFingerprint(report) {
  const device = report.device || {};
  const transport = report.restoreTransportEvidence || {};
  return [report.image && report.image.sha256, device.model, device.hardware, device.firmware, transport.contractId, transport.captureSha256].join("|");
}

function createTransaction(preflightReport, now = Date.now(), transactionId = "") {
  if (!preflightReport || !preflightReport.destructiveAllowed || !AUTHORIZED_PREFLIGHTS.has(preflightReport)) {
    throw new Error("Stage 0 transaction cannot start before all destructive gates pass.");
  }
  const id = String(transactionId || transactionIdFor(preflightReport, now));
  return {
    schema: JOURNAL_SCHEMA,
    transactionId: id,
    revision: 0,
    startedAt: now,
    updatedAt: now,
    state: TRANSACTION_STATES.PRECHECK_OK,
    imageId: preflightReport.image.id,
    imageSha256: preflightReport.image.sha256,
    preflightFingerprint: preflightFingerprint(preflightReport),
    destructivePostCount: 0,
    events: [{ at: now, event: "PRECHECK_OK" }]
  };
}

function validateTransaction(transaction) {
  const errors = [];
  if (!transaction || typeof transaction !== "object") return { ok: false, errors: ["Invalid Stage 0 transaction."] };
  if (transaction.schema !== JOURNAL_SCHEMA) errors.push(`Unsupported Stage 0 journal schema: ${transaction.schema}.`);
  if (!transaction.transactionId) errors.push("Stage 0 transaction ID is missing.");
  if (!Object.values(TRANSACTION_STATES).includes(transaction.state) || transaction.state === TRANSACTION_STATES.IDLE) errors.push("Stage 0 transaction state is invalid.");
  if (!Number.isInteger(transaction.revision) || transaction.revision < 0) errors.push("Stage 0 transaction revision is invalid.");
  if (![0, 1].includes(transaction.destructivePostCount)) errors.push("Stage 0 destructive POST count is invalid.");
  if (transaction.state === TRANSACTION_STATES.PRECHECK_OK && transaction.destructivePostCount !== 0) errors.push("PRECHECK_OK cannot have a destructive send count.");
  if (![TRANSACTION_STATES.PRECHECK_OK, TRANSACTION_STATES.FAILED].includes(transaction.state) && transaction.destructivePostCount !== 1) errors.push("Post-arm states require exactly one destructive send allowance to be consumed.");
  if (!Array.isArray(transaction.events) || !transaction.events.length) errors.push("Stage 0 journal events are missing.");
  return { ok: errors.length === 0, errors };
}

function validateBootVerification(transaction, verification) {
  const value = verification && typeof verification === "object" ? verification : {};
  const device = normalizedDevice(value.device);
  const checks = value.checks || {};
  const errors = [];
  if (String(value.transactionId || "") !== String(transaction && transaction.transactionId || "")) errors.push("Boot verification is not bound to this transaction.");
  if (cleanSha(value.imageSha256) !== cleanSha(transaction && transaction.imageSha256)) errors.push("Boot verification is not bound to this image.");
  if (!finiteTimestamp(value.observedAt) || Number(value.observedAt) < Number(transaction && transaction.updatedAt || 0)) errors.push("Boot verification predates the restore transaction.");
  if (!/^(?:LV01|MF885|MF96-ROUTER-C2)$/i.test(device.model) || !/Ver\.?\s*D/i.test(device.hardware) || device.firmware !== REQUIRED_FIRMWARE) errors.push("Post-boot device identity does not match the exact MF885 target.");
  for (const name of ["status1Reachable", "wifiReachable", "smsApiReachable", "mobileDataConnected"]) {
    if (checks[name] !== true) errors.push(`Boot verification check failed or is missing: ${name}.`);
  }
  if (transaction && transaction.imageId === WEBUI_CANARY_R3.id && value.webuiMarker !== WEBUI_CANARY_R3.id) {
    errors.push("WEBUI canary marker is missing after reboot.");
  }
  return { ok: errors.length === 0, value: { ...value, device, checks: { ...checks } }, errors };
}

function transition(transaction, event, detail = "", now = Date.now()) {
  const valid = validateTransaction(transaction);
  if (!valid.ok) throw new Error(valid.errors.join(" "));
  const name = String(event || "");
  const allowed = ALLOWED_TRANSITIONS[transaction.state] || [];
  if (!allowed.includes(name)) throw new Error(`Invalid Stage 0 transition: ${transaction.state} -> ${name}.`);

  const tx = { ...transaction, events: transaction.events.slice(), revision: transaction.revision + 1, updatedAt: now };
  if (name === "POST_ARMED") {
    if (tx.destructivePostCount !== 0) throw new Error("RestoreFw destructive POST allowance has already been consumed.");
    tx.destructivePostCount = 1;
  }
  if (name === "POST_SENT" && tx.destructivePostCount !== 1) throw new Error("POST_SENT requires a durably armed destructive transaction.");
  if (name === "BOOT_VERIFIED") {
    const boot = validateBootVerification(tx, detail);
    if (!boot.ok) throw new Error(boot.errors.join(" "));
    tx.bootVerification = boot.value;
  }
  tx.state = TRANSACTION_STATES[name];
  tx.events.push({ at: now, event: name, detail: name === "BOOT_VERIFIED" ? "all required live checks passed" : String(detail || "") });
  return tx;
}

function canSendRestore(transaction) {
  const valid = validateTransaction(transaction);
  return valid.ok && transaction.state === TRANSACTION_STATES.PRECHECK_OK && transaction.destructivePostCount === 0;
}

function createMemoryJournal(initial = null) {
  let raw = initial ? JSON.stringify(initial) : null;
  return {
    async load() { return raw; },
    async save(transaction) { raw = JSON.stringify(transaction); },
    async clear() { raw = null; },
    inspect() { return raw; }
  };
}

function createKeychainJournal(key = JOURNAL_KEY, keychain) {
  const storage = keychain || (typeof Keychain !== "undefined" ? Keychain : null);
  if (!storage || typeof storage.get !== "function" || typeof storage.set !== "function") {
    throw new Error("Persistent Keychain storage is unavailable for the Stage 0 journal.");
  }
  return {
    async load() {
      if (typeof storage.contains === "function" && !storage.contains(key)) return null;
      try { return storage.get(key); } catch (_) { return null; }
    },
    async save(transaction) { storage.set(key, JSON.stringify(transaction)); },
    async clear() { if (typeof storage.remove === "function") storage.remove(key); else storage.set(key, ""); }
  };
}

async function loadJournal(journal) {
  if (!journal || typeof journal.load !== "function") throw new Error("Stage 0 journal adapter is invalid.");
  const raw = await journal.load();
  if (!raw) return null;
  let transaction;
  try { transaction = typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch (_) { throw new Error("Stage 0 journal is corrupt; destructive operations are locked."); }
  const valid = validateTransaction(transaction);
  if (!valid.ok) throw new Error(`Stage 0 journal is invalid; destructive operations are locked. ${valid.errors.join(" ")}`);
  return transaction;
}

async function saveJournal(journal, transaction) {
  const valid = validateTransaction(transaction);
  if (!valid.ok) throw new Error(valid.errors.join(" "));
  if (!journal || typeof journal.save !== "function" || typeof journal.load !== "function") throw new Error("Stage 0 journal adapter is invalid.");
  await journal.save(transaction);
  const persisted = await loadJournal(journal);
  if (!persisted || persisted.transactionId !== transaction.transactionId || persisted.revision !== transaction.revision || persisted.state !== transaction.state) {
    throw new Error("Stage 0 journal write could not be verified; destructive operations are locked.");
  }
  return persisted;
}

async function createPersistentTransaction(journal, report, now = Date.now(), transactionId = "") {
  const existing = await loadJournal(journal);
  if (existing) throw new Error(`Stage 0 journal already contains transaction ${existing.transactionId} in state ${existing.state}.`);
  return saveJournal(journal, createTransaction(report, now, transactionId));
}

async function persistTransition(journal, expected, event, detail = "", now = Date.now()) {
  const current = await loadJournal(journal);
  if (!current) throw new Error("Stage 0 journal is missing; destructive operations are locked.");
  if (!expected || current.transactionId !== expected.transactionId || current.revision !== expected.revision) {
    throw new Error("Stage 0 journal changed concurrently; destructive operations are locked.");
  }
  return saveJournal(journal, transition(current, event, detail, now));
}

async function armPersistentRestore(journal, transaction, now = Date.now()) {
  // This durable transition consumes the single send allowance before any
  // network code is permitted to construct or submit RestoreFw.
  return persistTransition(journal, transaction, "POST_ARMED", "single destructive send allowance consumed", now);
}

async function recoverPersistentTransaction(journal, now = Date.now()) {
  const current = await loadJournal(journal);
  if (!current || TERMINAL_STATES.includes(current.state)) return current;
  if (current.state === TRANSACTION_STATES.PRECHECK_OK) {
    return persistTransition(journal, current, "FAILED", "process restarted before send; run a fresh preflight", now);
  }
  return persistTransition(journal, current, "UNKNOWN", "process restarted after destructive send was armed; automatic retry is permanently locked", now);
}

async function clearCompletedJournal(journal, transactionId) {
  const current = await loadJournal(journal);
  if (!current) return false;
  if (current.transactionId !== String(transactionId || "")) throw new Error("Stage 0 journal acknowledgement does not match the stored transaction.");
  if (![TRANSACTION_STATES.BOOT_VERIFIED, TRANSACTION_STATES.FAILED].includes(current.state)) {
    throw new Error(`Stage 0 journal in state ${current.state} cannot be cleared. UNKNOWN requires manual recovery evidence.`);
  }
  if (!journal || typeof journal.clear !== "function") throw new Error("Stage 0 journal adapter cannot clear completed transactions.");
  await journal.clear();
  if (await journal.load()) throw new Error("Stage 0 journal clear could not be verified.");
  return true;
}

module.exports = {
  GOLDEN_IMAGE,
  WEBUI_CANARY_R3,
  SAFE_IMAGES,
  REQUIRED_FIRMWARE,
  MIN_BATTERY_PERCENT,
  MAX_LIVE_EVIDENCE_AGE_MS,
  MAX_IMAGE_EVIDENCE_AGE_MS,
  JOURNAL_SCHEMA,
  JOURNAL_KEY,
  VERIFIED_RESTORE_TRANSPORTS,
  TRANSACTION_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  sha256Hex,
  createImageEvidence,
  lookupImage,
  validateImage,
  validateImageEvidence,
  normalizedDevice,
  validateDevice,
  validatePower,
  normalizedTransportEvidence,
  validateTransportEvidence,
  preflight,
  parseRestoreStatus,
  createTransaction,
  validateTransaction,
  validateBootVerification,
  transition,
  canSendRestore,
  createMemoryJournal,
  createKeychainJournal,
  loadJournal,
  saveJournal,
  createPersistentTransaction,
  persistTransition,
  armPersistentRestore,
  recoverPersistentTransaction,
  clearCompletedJournal
};
