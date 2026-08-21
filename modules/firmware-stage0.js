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
  logicalChanges: ["WEBI:www/index.html"],
  restorable: false,
  structuralStatus: "quarantined-invalid-byte-sums",
  quarantineReason: "Canary r3 preserves a 32-bit word sum, but RestoreFw verifies additive byte sums; its ZIMI global and WEBI checksums are invalid."
});

const WEBUI_CANARY_LOGS_R1 = Object.freeze({
  id: "0.0-logs-r1",
  kind: "webui-canary",
  file: "MF885_Community_0.0-logs-r1.bin",
  size: 8323644,
  sha256: "65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517",
  baseSha256: GOLDEN_IMAGE.sha256,
  restoreMethod: "RestoreFw",
  nativeOsloPatch: false,
  logicalChanges: ["WEBI:www/index.html", "WEBI:www/js/canary_logs.js"],
  restorable: false,
  structuralStatus: "verified-not-qualified",
  quarantineReason: "Canary Logs r1 is structurally verified and reproducible, but golden-to-golden, RestoreFw transport, software-only risk, and live-boot gates are not qualified."
});

const KNOWN_IMAGES = Object.freeze([GOLDEN_IMAGE, WEBUI_CANARY_R3, WEBUI_CANARY_LOGS_R1]);
const SAFE_IMAGES = Object.freeze([GOLDEN_IMAGE]);
const REQUIRED_FIRMWARE = "2.5.94_release_MF855_NZ_CP_2.129.003";
const MIN_BATTERY_PERCENT = 50;
const MAX_LIVE_EVIDENCE_AGE_MS = 60 * 1000;
const MAX_IMAGE_EVIDENCE_AGE_MS = 5 * 60 * 1000;
const JOURNAL_SCHEMA = 3;
const JOURNAL_KEY = "mf885-safeflash-stage0-transaction-v3";
const GOLDEN_QUALIFICATION_SCHEMA = 2;
const GOLDEN_QUALIFICATION_KEY = "mf885-safeflash-stage0-golden-qualification-v2";
const RECOVERY_EVIDENCE_SCHEMA = 1;
const FULL_NOR_SIZE_BYTES = 32 * 1024 * 1024;
const SOFTWARE_RISK_EVIDENCE_SCHEMA = 1;
const SOFTWARE_RISK_PROFILE = "software-only-risk-v1";
const SOFTWARE_ONLY_MIN_BATTERY_PERCENT = 80;
const MAX_SOFTWARE_RISK_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
// Scriptable Keychain provides no compare-and-set primitive. This flag can be
// changed only after a non-stealable cross-process lease is proven on-device.
const ATOMIC_RESTORE_LEASE_PROVEN = false;

// Intentionally empty. A caller-provided boolean or object must never be able
// to unlock RestoreFw. A captured contract is added here only after its exact
// multipart shape and status polling have been reproduced on the target build.
const VERIFIED_RESTORE_TRANSPORTS = Object.freeze([]);
// Also intentionally empty until the target unit has three identical full
// 32 MiB dumps from the 1.8 V MX25U25635FZ4I and a proven recovery entry.
const VERIFIED_RECOVERY_EVIDENCE = Object.freeze([]);
// This is a separate, explicitly higher-risk alternative to physical
// recovery. It is populated only from reviewed fresh BackupFw/configuration
// evidence for one exact unit; it never fabricates NOR dump fields.
const VERIFIED_SOFTWARE_RISK_EVIDENCE = Object.freeze([]);
const AUTHORIZED_PREFLIGHTS = new WeakSet();
const COMPUTED_IMAGE_EVIDENCE = new WeakSet();
const ACTIVE_RESTORE_JOURNALS = new WeakSet();

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
  return KNOWN_IMAGES.find(image => image.size === size && image.sha256 === sha256) || null;
}

function validateImage(meta) {
  const image = lookupImage(meta);
  const errors = [];
  const size = Number(meta && (meta.size === undefined ? meta.byteLength : meta.size));
  const sha256 = cleanSha(meta && (meta.sha256 || meta.computedSha256));
  if (!meta || size !== GOLDEN_IMAGE.size) errors.push(`Unexpected image size; expected ${GOLDEN_IMAGE.size} bytes.`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) errors.push("A full SHA-256 digest is required.");
  if (!image) errors.push("Image SHA-256 is not present in the Stage 0 allowlist.");
  else if (!SAFE_IMAGES.includes(image)) errors.push(image.quarantineReason || "The recognized image is quarantined and is not in the Stage 0 restore allowlist.");
  return { ok: errors.length === 0, image, errors };
}

function validateImageEvidence(meta, now = Date.now()) {
  const validation = validateImage(meta);
  const errors = validation.errors.concat(validateComputedImageEvidence(meta, now));
  return { ok: errors.length === 0, image: validation.image, errors };
}

function validateComputedImageEvidence(meta, now = Date.now()) {
  const errors = [];
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
  return errors;
}

function validateAuditImageEvidence(meta, now = Date.now()) {
  const image = lookupImage(meta);
  const errors = validateComputedImageEvidence(meta, now);
  if (!image) errors.unshift("Image SHA-256 is not a recognized audited MF885 artifact.");
  return { ok: errors.length === 0, image, errors };
}

function normalizedDevice(device) {
  const source = device || {};
  return {
    model: String(source.model || source.modelName || source.deviceName || "").trim(),
    hardware: String(source.hardware || source.hardwareVersion || source.revision || "").trim(),
    firmware: String(source.firmware || source.version || source.versionNum || "").trim(),
    unitFingerprintSha256:cleanSha(source.unitFingerprintSha256),
    observedAt: finiteTimestamp(source.observedAt),
    source: String(source.source || "").trim()
  };
}

function validateDevice(device, now = Date.now()) {
  const value = normalizedDevice(device);
  const errors = [];
  if (!/^(?:LV01|MF885)$/i.test(value.model)) errors.push("Device model is not positively identified as the exact LV01 / MF885 target.");
  if (!/Ver\.?\s*D/i.test(value.hardware)) errors.push("Hardware revision is not positively identified as Ver.D.");
  if (value.firmware !== REQUIRED_FIRMWARE) errors.push(`Base firmware must be exactly ${REQUIRED_FIRMWARE}.`);
  if(!/^[0-9a-f]{64}$/.test(value.unitFingerprintSha256))errors.push("A privacy-safe fingerprint of the exact physical router is required.");
  if (value.source !== "status1-live") errors.push("Device identity must come from a fresh live status1 read.");
  if (!evidenceFresh(value.observedAt, now, MAX_LIVE_EVIDENCE_AGE_MS)) errors.push("Live device identity is missing, stale, or timestamped in the future.");
  return { ok: errors.length === 0, value, errors };
}

function validatePower(power, now = Date.now(), minimumBatteryPercent = MIN_BATTERY_PERCENT) {
  const batteryPercent = Number(power && power.batteryPercent);
  const chargerConnected = power && power.chargerConnected === true;
  const observedAt = finiteTimestamp(power && power.observedAt);
  const source = String(power && power.source || "").trim();
  const requiredPercent = Number.isFinite(Number(minimumBatteryPercent)) ? Number(minimumBatteryPercent) : MIN_BATTERY_PERCENT;
  const errors = [];
  if (!Number.isFinite(batteryPercent)) errors.push("Battery percentage is unavailable.");
  else if (batteryPercent < requiredPercent) errors.push(`Battery must be at least ${requiredPercent}%.`);
  if (!chargerConnected) errors.push("Stable external USB power must be connected.");
  if (source !== "status1-live") errors.push("Power state must come from a fresh live status1 read.");
  if (!evidenceFresh(observedAt, now, MAX_LIVE_EVIDENCE_AGE_MS)) errors.push("Live power evidence is missing, stale, or timestamped in the future.");
  return { ok: errors.length === 0, batteryPercent, chargerConnected, observedAt, source, minimumBatteryPercent:requiredPercent, errors };
}

function normalizedTransportEvidence(evidence) {
  const source = evidence && typeof evidence === "object" ? evidence : {};
  return {
    contractSchema: Number(source.contractSchema),
    contractId: String(source.contractId || "").trim(),
    firmware: String(source.firmware || "").trim(),
    restoreMethod: String(source.restoreMethod || "").trim(),
    httpMethod: String(source.httpMethod || "").trim().toUpperCase(),
    requestPath: String(source.requestPath || "").trim(),
    digestUri: String(source.digestUri || "").trim(),
    uploadQuery: String(source.uploadQuery || "").trim(),
    multipartField: String(source.multipartField || "").trim(),
    multipartMimeType: String(source.multipartMimeType || "").trim().toLowerCase(),
    multipartFilenameRule: String(source.multipartFilenameRule || "").trim(),
    multipartEncoding: String(source.multipartEncoding || "").trim(),
    authProfile: String(source.authProfile || "").trim(),
    sessionProfile: String(source.sessionProfile || "").trim(),
    acceptanceProfile: String(source.acceptanceProfile || "").trim(),
    adapterArtifactSha256:cleanSha(source.adapterArtifactSha256),
    exclusiveLeaseProfile:String(source.exclusiveLeaseProfile||"").trim(),
    statusModel: String(source.statusModel || "").trim(),
    statusHttpMethod: String(source.statusHttpMethod || "").trim().toUpperCase(),
    statusRequestPath: String(source.statusRequestPath || "").trim(),
    statusDigestUri: String(source.statusDigestUri || "").trim(),
    statusQuery: String(source.statusQuery || "").trim(),
    statusMapId: String(source.statusMapId || "").trim(),
    maxStatusPolls: Number(source.maxStatusPolls),
    statusPollIntervalMs: Number(source.statusPollIntervalMs),
    maxBootPolls: Number(source.maxBootPolls),
    bootPollIntervalMs: Number(source.bootPollIntervalMs),
    captureSha256: cleanSha(source.captureSha256),
    verifiedAt: finiteTimestamp(source.verifiedAt)
  };
}

function sameTransportContract(evidence, contract) {
  return ["contractSchema", "contractId", "firmware", "restoreMethod", "httpMethod", "requestPath", "digestUri", "uploadQuery", "multipartField", "multipartMimeType", "multipartFilenameRule", "multipartEncoding", "authProfile", "sessionProfile", "acceptanceProfile","adapterArtifactSha256","exclusiveLeaseProfile", "statusModel", "statusHttpMethod", "statusRequestPath", "statusDigestUri", "statusQuery", "statusMapId", "maxStatusPolls", "statusPollIntervalMs", "maxBootPolls", "bootPollIntervalMs", "captureSha256"]
    .every(field => evidence[field] === contract[field]);
}

function validateTransportEvidence(evidence) {
  const value = normalizedTransportEvidence(evidence);
  const errors = [];
  if (!evidence || typeof evidence !== "object") errors.push("RestoreFw requires an immutable transport evidence record; a boolean cannot unlock it.");
  if (value.contractSchema !== 1) errors.push("RestoreFw evidence does not use the reviewed full wire-contract schema.");
  if (value.firmware !== REQUIRED_FIRMWARE) errors.push("RestoreFw evidence does not target the exact base firmware.");
  if (value.restoreMethod !== "RestoreFw" || value.httpMethod !== "POST") errors.push("RestoreFw evidence has the wrong operation or HTTP method.");
  if (value.requestPath !== "/xml_action.cgi" || value.digestUri !== "/cgi/xml_action.cgi") errors.push("RestoreFw request and Digest URIs are not the expected exact pair.");
  if (!value.uploadQuery) errors.push("RestoreFw upload query order and escaping must be captured exactly.");
  if (!value.multipartField || !value.multipartMimeType || !value.multipartFilenameRule || !value.multipartEncoding) errors.push("RestoreFw multipart field, MIME type, filename rule, and encoding must all be proven.");
  if (!value.authProfile || !value.sessionProfile || !value.acceptanceProfile) errors.push("RestoreFw authentication, session, and acceptance-response profiles must all be proven.");
  if(!/^[0-9a-f]{64}$/.test(value.adapterArtifactSha256)||!value.exclusiveLeaseProfile)errors.push("RestoreFw requires a reviewed adapter artifact hash and a platform-backed exclusive lease profile.");
  if (!value.statusModel || value.statusHttpMethod !== "GET" || !value.statusRequestPath || !value.statusDigestUri || !value.statusQuery || !value.statusMapId) errors.push("RestoreFw GET-only status route, query, and raw-value map must all be proven.");
  if (!Number.isInteger(value.maxStatusPolls) || value.maxStatusPolls < 1 || value.maxStatusPolls > 120 || !Number.isInteger(value.statusPollIntervalMs) || value.statusPollIntervalMs < 250 || value.statusPollIntervalMs > 30000) errors.push("RestoreFw status polling bounds are missing or unsafe.");
  if (!Number.isInteger(value.maxBootPolls) || value.maxBootPolls < 1 || value.maxBootPolls > 120 || !Number.isInteger(value.bootPollIntervalMs) || value.bootPollIntervalMs < 250 || value.bootPollIntervalMs > 30000) errors.push("RestoreFw post-boot polling bounds are missing or unsafe.");
  if (!/^[0-9a-f]{64}$/.test(value.captureSha256)) errors.push("RestoreFw evidence requires the SHA-256 of a redacted capture artifact.");
  const matched = VERIFIED_RESTORE_TRANSPORTS.find(contract => sameTransportContract(value, contract)) || null;
  if (!matched) errors.push("No matching RestoreFw transport contract is allowlisted in this build; destructive send remains locked.");
  return { ok: errors.length === 0, value, contract: matched, errors };
}

function normalizedRecoveryEvidence(evidence) {
  const source=evidence&&typeof evidence==="object"?evidence:{};
  return {
    schema:Number(source.schema),
    evidenceId:String(source.evidenceId||"").trim(),
    model:String(source.model||"").trim(),
    hardware:String(source.hardware||"").trim(),
    norPart:String(source.norPart||"").trim(),
    norSizeBytes:Number(source.norSizeBytes),
    ioVoltage:Number(source.ioVoltage),
    fullDumpCopies:Number(source.fullDumpCopies),
    dumpsIdentical:source.dumpsIdentical===true,
    fullDumpSha256:cleanSha(source.fullDumpSha256),
    unitFingerprintSha256:cleanSha(source.unitFingerprintSha256),
    goldenBackupSha256:cleanSha(source.goldenBackupSha256),
    recoveryEntryVerified:source.recoveryEntryVerified===true,
    captureSha256:cleanSha(source.captureSha256)
  };
}

function sameRecoveryEvidence(value, compiled) {
  return ["schema","evidenceId","model","hardware","norPart","norSizeBytes","ioVoltage","fullDumpCopies","dumpsIdentical","fullDumpSha256","unitFingerprintSha256","goldenBackupSha256","recoveryEntryVerified","captureSha256"]
    .every(field=>value[field]===compiled[field]);
}

function validateRecoveryEvidence(evidence) {
  const value=normalizedRecoveryEvidence(evidence),errors=[];
  if(value.schema!==RECOVERY_EVIDENCE_SCHEMA)errors.push("Reviewed physical recovery evidence is missing.");
  if(!/^(?:LV01|MF885)$/i.test(value.model)||!/Ver\.?\s*D/i.test(value.hardware))errors.push("Recovery evidence is not bound to the exact LV01 / MF885 Ver.D target.");
  if(!/^MX25U25635FZ4I(?:-10G)?$/i.test(value.norPart)||value.norSizeBytes!==FULL_NOR_SIZE_BYTES||value.ioVoltage!==1.8)errors.push("Recovery evidence must identify the full 32 MiB 1.8 V MX25U25635FZ4I NOR.");
  if(!Number.isInteger(value.fullDumpCopies)||value.fullDumpCopies<3||value.dumpsIdentical!==true||!/^[0-9a-f]{64}$/.test(value.fullDumpSha256))errors.push("At least three identical full NOR dumps with SHA-256 are required.");
  if(!/^[0-9a-f]{64}$/.test(value.unitFingerprintSha256))errors.push("Recovery evidence is not bound to a privacy-safe fingerprint of one physical router.");
  if(value.goldenBackupSha256!==GOLDEN_IMAGE.sha256)errors.push("Recovery evidence is not bound to the exact stock golden backup.");
  if(value.recoveryEntryVerified!==true)errors.push("Recovery-mode entry has not been positively verified.");
  if(!/^[0-9a-f]{64}$/.test(value.captureSha256))errors.push("Recovery evidence requires the SHA-256 of its reviewed redacted artifact.");
  const matched=VERIFIED_RECOVERY_EVIDENCE.find(compiled=>sameRecoveryEvidence(value,compiled))||null;
  if(!matched)errors.push("No matching physical recovery evidence is compiled into this build; destructive send remains locked.");
  return {ok:errors.length===0,value,evidence:matched,errors};
}

function normalizedSoftwareRiskEvidence(evidence) {
  const source=evidence&&typeof evidence==="object"?evidence:{};
  return {
    schema:Number(source.schema),
    profile:String(source.profile||"").trim(),
    evidenceId:String(source.evidenceId||"").trim(),
    model:String(source.model||"").trim(),
    hardware:String(source.hardware||"").trim(),
    firmware:String(source.firmware||"").trim(),
    unitFingerprintSha256:cleanSha(source.unitFingerprintSha256),
    goldenBackupSha256:cleanSha(source.goldenBackupSha256),
    backupCaptureCount:Number(source.backupCaptureCount),
    backup1Sha256:cleanSha(source.backup1Sha256),
    backup1CapturedAt:finiteTimestamp(source.backup1CapturedAt),
    backup2Sha256:cleanSha(source.backup2Sha256),
    backup2CapturedAt:finiteTimestamp(source.backup2CapturedAt),
    backupsByteIdentical:source.backupsByteIdentical===true,
    configurationEvidenceKind:String(source.configurationEvidenceKind||"").trim(),
    configurationEvidenceSha256:cleanSha(source.configurationEvidenceSha256||source.configurationExportSha256),
    configurationCapturedAt:finiteTimestamp(source.configurationCapturedAt),
    configurationModelsCaptured:Number(source.configurationModelsCaptured),
    stockConfigurationExportUnavailable:source.stockConfigurationExportUnavailable===true,
    wifiSettingsRecorded:source.wifiSettingsRecorded===true,
    apnSettingsRecorded:source.apnSettingsRecorded===true,
    noHardwareRecoveryAccepted:source.noHardwareRecoveryAccepted===true,
    transportContractId:String(source.transportContractId||"").trim(),
    transportCaptureSha256:cleanSha(source.transportCaptureSha256),
    captureSha256:cleanSha(source.captureSha256)
  };
}

function sameSoftwareRiskEvidence(value,compiled) {
  return ["schema","profile","evidenceId","model","hardware","firmware","unitFingerprintSha256","goldenBackupSha256","backupCaptureCount","backup1Sha256","backup1CapturedAt","backup2Sha256","backup2CapturedAt","backupsByteIdentical","configurationEvidenceKind","configurationEvidenceSha256","configurationCapturedAt","configurationModelsCaptured","stockConfigurationExportUnavailable","wifiSettingsRecorded","apnSettingsRecorded","noHardwareRecoveryAccepted","transportContractId","transportCaptureSha256","captureSha256"]
    .every(field=>value[field]===compiled[field]);
}

function validateSoftwareRiskEvidence(evidence,transportEvidence,now=Date.now()) {
  const value=normalizedSoftwareRiskEvidence(evidence),transport=normalizedTransportEvidence(transportEvidence),errors=[];
  if(value.schema!==SOFTWARE_RISK_EVIDENCE_SCHEMA||value.profile!==SOFTWARE_RISK_PROFILE)errors.push("Reviewed software-only-risk-v1 evidence is missing.");
  if(!/^(?:LV01|MF885)$/i.test(value.model)||!/Ver\.?\s*D/i.test(value.hardware)||value.firmware!==REQUIRED_FIRMWARE)errors.push("Software-only risk evidence is not bound to the exact LV01 / MF885 Ver.D target firmware.");
  if(!/^[0-9a-f]{64}$/.test(value.unitFingerprintSha256))errors.push("Software-only risk evidence is not bound to one privacy-safe router fingerprint.");
  if(value.goldenBackupSha256!==GOLDEN_IMAGE.sha256||value.backupCaptureCount!==2||value.backup1Sha256!==GOLDEN_IMAGE.sha256||value.backup2Sha256!==GOLDEN_IMAGE.sha256||value.backupsByteIdentical!==true)errors.push("Exactly two byte-identical fresh BackupFw captures with the stock golden SHA-256 are required.");
  if(!value.backup1CapturedAt||!value.backup2CapturedAt||value.backup1CapturedAt>=value.backup2CapturedAt||!evidenceFresh(value.backup1CapturedAt,now,MAX_SOFTWARE_RISK_EVIDENCE_AGE_MS)||!evidenceFresh(value.backup2CapturedAt,now,MAX_SOFTWARE_RISK_EVIDENCE_AGE_MS))errors.push("The two BackupFw acquisition timestamps are missing, stale, future-dated, or not independent.");
  if(!["stock-config-export-v1","private-settings-bundle-v1"].includes(value.configurationEvidenceKind)||!/^[0-9a-f]{64}$/.test(value.configurationEvidenceSha256)||!evidenceFresh(value.configurationCapturedAt,now,MAX_SOFTWARE_RISK_EVIDENCE_AGE_MS))errors.push("Fresh hashed router configuration evidence is required.");
  if(value.configurationEvidenceKind==="private-settings-bundle-v1"&&(!Number.isInteger(value.configurationModelsCaptured)||value.configurationModelsCaptured<6||!value.stockConfigurationExportUnavailable))errors.push("A private settings bundle requires at least six captured configuration models and reviewed evidence that the stock export is unavailable.");
  if(!value.wifiSettingsRecorded||!value.apnSettingsRecorded)errors.push("Wi-Fi and APN settings must be recorded separately from the configuration export.");
  if(!value.noHardwareRecoveryAccepted)errors.push("The operator has not explicitly accepted that this profile has no hardware recovery guarantee.");
  if(!transport.contractId||value.transportContractId!==transport.contractId||value.transportCaptureSha256!==transport.captureSha256)errors.push("Software-only risk evidence is not bound to the current reviewed RestoreFw transport contract.");
  if(!/^[0-9a-f]{64}$/.test(value.captureSha256))errors.push("Software-only risk evidence requires the SHA-256 of its reviewed redacted evidence artifact.");
  const matched=VERIFIED_SOFTWARE_RISK_EVIDENCE.find(compiled=>sameSoftwareRiskEvidence(value,compiled))||null;
  if(!matched)errors.push("No matching software-only-risk-v1 evidence is compiled into this build; destructive send remains locked.");
  return {ok:errors.length===0,value,evidence:matched,errors};
}

function validateRiskEvidence(recoveryEvidence,softwareRiskEvidence,transportEvidence,now=Date.now()) {
  const hasPhysical=!!(recoveryEvidence&&typeof recoveryEvidence==="object"&&Object.keys(recoveryEvidence).length);
  const hasSoftware=!!(softwareRiskEvidence&&typeof softwareRiskEvidence==="object"&&Object.keys(softwareRiskEvidence).length);
  if(hasPhysical&&hasSoftware)return {ok:false,profile:"ambiguous",value:{},evidence:null,minBatteryPercent:SOFTWARE_ONLY_MIN_BATTERY_PERCENT,errors:["Choose exactly one recovery/risk profile; physical and software-only evidence cannot be combined."]};
  if(hasSoftware){
    const checked=validateSoftwareRiskEvidence(softwareRiskEvidence,transportEvidence,now);
    return {...checked,profile:SOFTWARE_RISK_PROFILE,minBatteryPercent:SOFTWARE_ONLY_MIN_BATTERY_PERCENT};
  }
  const checked=validateRecoveryEvidence(recoveryEvidence);
  return {...checked,profile:"physical-nor-v1",minBatteryPercent:MIN_BATTERY_PERCENT};
}

function restoreAvailability() {
  const count = VERIFIED_RESTORE_TRANSPORTS.length;
  const recoveryCount=VERIFIED_RECOVERY_EVIDENCE.length;
  const softwareRiskCount=VERIFIED_SOFTWARE_RISK_EVIDENCE.length;
  const riskCount=recoveryCount+softwareRiskCount;
  return {
    available: count > 0&&riskCount>0&&ATOMIC_RESTORE_LEASE_PROVEN,
    allowlistedContracts: count,
    recoveryEvidenceRecords:recoveryCount,
    softwareRiskEvidenceRecords:softwareRiskCount,
    atomicCrossProcessLeaseProven:ATOMIC_RESTORE_LEASE_PROVEN,
    reason: count===0
      ? "Locked until the exact RestoreFw upload, authentication, response, and GET-only status contract is captured and compiled into the allowlist."
      : riskCount===0
        ? "Locked until either physical recovery evidence or a complete software-only-risk-v1 record is reviewed and compiled."
        : !ATOMIC_RESTORE_LEASE_PROVEN
          ? "Locked until an atomic, non-stealable cross-process firmware lease is proven on-device. Keychain read/write/read is not sufficient."
        : softwareRiskCount>0&&recoveryCount===0
          ? "Reviewed RestoreFw and software-only-risk-v1 evidence are compiled. The 80% power gate, typed no-recovery confirmation, native preflight, and persistent one-shot journal still apply."
          : "Reviewed RestoreFw and physical recovery evidence are compiled. Native preflight and the persistent one-shot journal still apply."
  };
}

function validateGoldenQualification(qualification, transportEvidence, recoveryEvidence, softwareRiskEvidence) {
  const value = qualification && typeof qualification === "object" ? qualification : {};
  const transport = normalizedTransportEvidence(transportEvidence);
  const useSoftware=!!(softwareRiskEvidence&&typeof softwareRiskEvidence==="object"&&Object.keys(softwareRiskEvidence).length);
  const risk=useSoftware?normalizedSoftwareRiskEvidence(softwareRiskEvidence):normalizedRecoveryEvidence(recoveryEvidence);
  const riskProfile=useSoftware?SOFTWARE_RISK_PROFILE:"physical-nor-v1";
  const riskEvidenceId=risk.evidenceId;
  const riskCaptureSha256=risk.captureSha256;
  const qualifiedProfile=String(value.riskProfile||(!useSoftware&&value.recoveryEvidenceId?"physical-nor-v1":""));
  const qualifiedEvidenceId=String(value.riskEvidenceId||value.recoveryEvidenceId||"");
  const qualifiedCaptureSha256=cleanSha(value.riskCaptureSha256||value.recoveryCaptureSha256);
  const errors = [];
  if(value.integrityVerified!==true)errors.push("The stock golden qualification did not pass local integrity verification.");
  if (value.schema !== GOLDEN_QUALIFICATION_SCHEMA) errors.push("A completed stock golden-to-golden qualification is required before the WEBUI canary can be flashed.");
  if (String(value.imageId || "") !== GOLDEN_IMAGE.id || cleanSha(value.imageSha256) !== GOLDEN_IMAGE.sha256) {
    errors.push("The stored qualification is not for the exact stock golden image.");
  }
  if (String(value.state || "") !== TRANSACTION_STATES.BOOT_VERIFIED) errors.push("The stock golden qualification did not reach BOOT_VERIFIED.");
  if (String(value.transportContractId || "") !== transport.contractId || cleanSha(value.transportCaptureSha256) !== transport.captureSha256) {
    errors.push("The stock golden qualification belongs to a different RestoreFw contract or capture.");
  }
  if(qualifiedProfile!==riskProfile||qualifiedEvidenceId!==riskEvidenceId||qualifiedCaptureSha256!==riskCaptureSha256){
    errors.push("The stock golden qualification belongs to a different recovery/risk evidence profile.");
  }
  if(cleanSha(value.unitFingerprintSha256)!==risk.unitFingerprintSha256)errors.push("The stock golden qualification belongs to a different physical router.");
  if (!finiteTimestamp(value.completedAt)) errors.push("The stock golden qualification completion time is missing.");
  return { ok: errors.length === 0, value: { ...value }, errors };
}

function validateRestoreSequence(image, qualification, transportEvidence, recoveryEvidence, softwareRiskEvidence) {
  if (!image || image.id === GOLDEN_IMAGE.id) return { ok: true, errors: [] };
  if (image.id !== WEBUI_CANARY_LOGS_R1.id) return { ok: false, errors: ["The selected image is not part of the Stage 0 restore sequence."] };
  return validateGoldenQualification(qualification, transportEvidence, recoveryEvidence, softwareRiskEvidence);
}

function preflight(input, now = Date.now()) {
  const image = validateImageEvidence(input && input.image, now);
  const device = validateDevice(input && input.device, now);
  const transport = validateTransportEvidence(input && input.restoreTransportEvidence);
  const risk = validateRiskEvidence(input && input.recoveryEvidence,input && input.softwareRiskEvidence,transport.value,now);
  const power = validatePower(input && input.power, now,risk.minBatteryPercent);
  const recoveryEvidence=risk.profile==="physical-nor-v1"?risk.value:{};
  const softwareRiskEvidence=risk.profile===SOFTWARE_RISK_PROFILE?risk.value:{};
  const sequence = validateRestoreSequence(image.image, input && input.goldenQualification, transport.value, recoveryEvidence, softwareRiskEvidence);
  const errors = [...image.errors, ...device.errors, ...power.errors, ...transport.errors, ...risk.errors, ...sequence.errors];
  if(device.value.unitFingerprintSha256!==risk.value.unitFingerprintSha256)errors.push("Live router fingerprint does not match the selected recovery/risk evidence.");
  if (input && input.restoreTransportVerified === true) {
    errors.push("Legacy restoreTransportVerified=true is ignored; only an allowlisted immutable evidence record can unlock RestoreFw.");
  }
  const report = {
    ok: errors.length === 0,
    destructiveAllowed: errors.length === 0,
    image: image.image,
    device: device.value,
    power: { batteryPercent: power.batteryPercent, chargerConnected: power.chargerConnected, observedAt: power.observedAt, source: power.source, minimumBatteryPercent:power.minimumBatteryPercent },
    restoreTransportEvidence: transport.value,
    riskProfile:risk.profile,
    riskEvidence:risk.value,
    recoveryEvidence,
    softwareRiskEvidence,
    restoreSequence: { ok: sequence.ok, goldenQualified: image.image && image.image.id === GOLDEN_IMAGE.id ? false : sequence.ok },
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
  const risk=report.riskEvidence||report.recoveryEvidence||{};
  return [report.image && report.image.sha256, device.model, device.hardware, device.firmware,device.unitFingerprintSha256, transport.contractId, transport.captureSha256,report.riskProfile,risk.evidenceId,risk.captureSha256].join("|");
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
    unitFingerprintSha256:cleanSha(preflightReport.device&&preflightReport.device.unitFingerprintSha256),
    transportContractId: String(preflightReport.restoreTransportEvidence && preflightReport.restoreTransportEvidence.contractId || ""),
    transportCaptureSha256: cleanSha(preflightReport.restoreTransportEvidence && preflightReport.restoreTransportEvidence.captureSha256),
    riskProfile:String(preflightReport.riskProfile||""),
    riskEvidenceId:String(preflightReport.riskEvidence&&preflightReport.riskEvidence.evidenceId||""),
    riskCaptureSha256:cleanSha(preflightReport.riskEvidence&&preflightReport.riskEvidence.captureSha256),
    recoveryEvidenceId:String(preflightReport.recoveryEvidence&&preflightReport.recoveryEvidence.evidenceId||""),
    recoveryCaptureSha256:cleanSha(preflightReport.recoveryEvidence&&preflightReport.recoveryEvidence.captureSha256),
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
  if(!["physical-nor-v1",SOFTWARE_RISK_PROFILE].includes(String(transaction.riskProfile||""))||!String(transaction.riskEvidenceId||"")||!/^[0-9a-f]{64}$/.test(cleanSha(transaction.riskCaptureSha256)))errors.push("Stage 0 transaction is not bound to one reviewed recovery/risk profile.");
  if (![0, 1].includes(transaction.destructivePostCount)) errors.push("Stage 0 destructive POST count is invalid.");
  if (transaction.state === TRANSACTION_STATES.PRECHECK_OK && transaction.destructivePostCount !== 0) errors.push("PRECHECK_OK cannot have a destructive send count.");
  if (![TRANSACTION_STATES.PRECHECK_OK, TRANSACTION_STATES.FAILED].includes(transaction.state) && transaction.destructivePostCount !== 1) errors.push("Post-arm states require exactly one destructive send allowance to be consumed.");
  if (!Array.isArray(transaction.events) || !transaction.events.length) errors.push("Stage 0 journal events are missing.");
  return { ok: errors.length === 0, errors };
}

function validateBootVerification(transaction, verification, now = Date.now()) {
  const value = verification && typeof verification === "object" ? verification : {};
  const device = normalizedDevice(value.device);
  const checks = value.checks || {};
  const errors = [];
  if (String(value.transactionId || "") !== String(transaction && transaction.transactionId || "")) errors.push("Boot verification is not bound to this transaction.");
  if (cleanSha(value.imageSha256) !== cleanSha(transaction && transaction.imageSha256)) errors.push("Boot verification is not bound to this image.");
  if (!finiteTimestamp(value.observedAt) || Number(value.observedAt) < Number(transaction && transaction.updatedAt || 0)) errors.push("Boot verification predates the restore transaction.");
  if(!evidenceFresh(value.observedAt,now,MAX_LIVE_EVIDENCE_AGE_MS))errors.push("Boot verification is stale or timestamped in the future.");
  const liveDevice=validateDevice(device,now);
  if(!liveDevice.ok)errors.push(...liveDevice.errors.map(error=>`Post-boot ${error}`));
  if(device.unitFingerprintSha256!==cleanSha(transaction&&transaction.unitFingerprintSha256))errors.push("Post-boot router fingerprint does not match the preflight target.");
  for (const name of ["status1Reachable", "wifiReachable", "smsApiReachable", "mobileDataConnected"]) {
    if (checks[name] !== true) errors.push(`Boot verification check failed or is missing: ${name}.`);
  }
  const canary=[WEBUI_CANARY_R3,WEBUI_CANARY_LOGS_R1].find(image=>transaction&&transaction.imageId===image.id);
  if(canary&&value.webuiMarker!==canary.id)errors.push("WEBUI canary marker is missing after reboot.");
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
    // The observation is made after REBOOT_WAIT and before this transition is
    // journaled, so compare it with the prior persisted revision, not the new
    // journal-write timestamp assigned above.
    const boot = validateBootVerification(transaction, detail, now);
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
  if (!storage || typeof storage.contains !== "function" || typeof storage.get !== "function" || typeof storage.set !== "function" || typeof storage.remove !== "function") {
    throw new Error("Persistent Keychain storage is unavailable for the Stage 0 journal.");
  }
  return {
    async load() {
      try {
        if (!storage.contains(key)) return null;
        const raw=storage.get(key);
        if(typeof raw!=="string"||raw.length===0)throw new Error("empty or non-string journal");
        return raw;
      }
      catch (_) { throw new Error("Stage 0 Keychain journal read failed; destructive operations are locked."); }
    },
    async save(transaction) { storage.set(key, JSON.stringify(transaction)); },
    async clear() { storage.remove(key); }
  };
}

async function loadJournal(journal) {
  if (!journal || typeof journal.load !== "function") throw new Error("Stage 0 journal adapter is invalid.");
  const raw = await journal.load();
  if (raw === null || raw === undefined) return null;
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
  if (!persisted || JSON.stringify(persisted) !== JSON.stringify(transaction)) {
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

async function persistUnknownAfterArming(journal, fallback, detail, now = Date.now()) {
  let current;
  try { current = await loadJournal(journal); }
  catch (_) { return fallback; }
  if (!current || TERMINAL_STATES.includes(current.state)) return current || fallback;
  if (![TRANSACTION_STATES.POST_ARMED, TRANSACTION_STATES.POST_SENT, TRANSACTION_STATES.RESTORING, TRANSACTION_STATES.REBOOT_WAIT].includes(current.state)) return current;
  try { return await persistTransition(journal, current, "UNKNOWN", detail, now); }
  catch (_) { return current; }
}

async function executeArmedRestoreOnce(journal, precheckTransaction, sendOnce, options = {}) {
  if (typeof sendOnce !== "function") throw new Error("Stage 0 one-shot RestoreFw sender is unavailable.");
  const lease=options.exclusiveLease;
  if(!lease||typeof lease.assertOwner!=="function")throw new Error("A platform-backed exclusive firmware lease is required before arming.");
  if(!journal||typeof journal!=="object")throw new Error("Stage 0 journal adapter is invalid.");
  if(ACTIVE_RESTORE_JOURNALS.has(journal))throw new Error("A Stage 0 send is already active for this journal; no second sender was called.");
  ACTIVE_RESTORE_JOURNALS.add(journal);
  const clock = typeof options.now === "function" ? options.now : Date.now;
  let sendAllowanceConsumed=false;
  try {
    const beforeArm=await lease.assertOwner(precheckTransaction.transactionId,"before-arm");
    if(beforeArm!==true)throw new Error("The exclusive firmware lease did not confirm ownership before arming.");
    const armed = await armPersistentRestore(journal, precheckTransaction, clock());
    sendAllowanceConsumed=true;
    let result;
    // The durable POST_ARMED read-back above is the final boundary before any
    // transport code may construct or submit the single destructive request.
    const beforeSend=await lease.assertOwner(armed.transactionId,"before-send");
    if(beforeSend!==true)throw new Error("The exclusive firmware lease did not confirm ownership before send.");
    result = await sendOnce(armed);
    if (!result || result.accepted !== true) throw new Error("RestoreFw did not return a captured, explicitly accepted response.");
    const sent = await persistTransition(journal, armed, "POST_SENT", "captured acceptance response received", clock());
    return { transaction: sent, transportResult: result, destructivePostsAttempted: 1, automaticRetries: 0 };
  } catch (error) {
    const current=await loadJournal(journal).catch(()=>null);
    const unknown = current&&current.state!==TRANSACTION_STATES.PRECHECK_OK
      ? await persistUnknownAfterArming(journal, current, "one-shot RestoreFw outcome is unknown; automatic retry is permanently locked", clock())
      : current;
    error.stage0Transaction = unknown;
    error.destructivePostsAttempted = (sendAllowanceConsumed || (unknown && unknown.destructivePostCount === 1)) ? 1 : 0;
    error.automaticRetries = 0;
    throw error;
  }finally{
    ACTIVE_RESTORE_JOURNALS.delete(journal);
  }
}

async function executePersistentRestoreOnce(journal, preflightReport, sendOnce, options = {}) {
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const transaction = await createPersistentTransaction(journal, preflightReport, clock(), options.transactionId || "");
  return executeArmedRestoreOnce(journal, transaction, sendOnce, { now: clock,exclusiveLease:options.exclusiveLease });
}

async function monitorPersistentRestore(journal, postSentTransaction, monitor, options = {}) {
  if (!monitor || typeof monitor.readStatus !== "function" || typeof monitor.classifyStatus !== "function" || typeof monitor.verifyBoot !== "function") {
    throw new Error("The reviewed GET-only restore-status and post-boot monitor is unavailable.");
  }
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const sleep = typeof options.sleep === "function" ? options.sleep : async () => {};
  const maxPolls = Math.max(1, Math.min(120, Number(options.maxPolls) || 40));
  const intervalMs = Math.max(250, Math.min(30000, Number(options.intervalMs) || 2000));
  const maxBootPolls=Math.max(1,Math.min(120,Number(options.maxBootPolls)||30));
  const bootIntervalMs=Math.max(250,Math.min(30000,Number(options.bootIntervalMs)||2000));
  let current = await loadJournal(journal);
  if (!current || !postSentTransaction || current.transactionId !== postSentTransaction.transactionId || current.revision !== postSentTransaction.revision || current.state !== TRANSACTION_STATES.POST_SENT) {
    throw new Error("Stage 0 status monitoring requires the exact persisted POST_SENT transaction.");
  }
  try {
    for (let index = 0; index < maxPolls; index++) {
      let observation;
      try { observation = await monitor.readStatus({ transaction: current, poll: index + 1 }); }
      catch (error) { observation = { error: String(error && error.message || error || "status read failed") }; }
      const classified = await monitor.classifyStatus(observation, { transaction: current, poll: index + 1 });
      const event = String(classified && classified.event || "");
      if (!["RESTORING", "REBOOT_WAIT", "FAILED", "UNKNOWN"].includes(event)) {
        throw new Error("The reviewed restore-status classifier returned an unknown state.");
      }
      current = await persistTransition(journal, current, event, String(classified && classified.detail || ""), clock());
      if (event === "FAILED" || event === "UNKNOWN") return current;
      if (event === "REBOOT_WAIT") {
        let lastBootErrors=[];
        for(let bootPoll=0;bootPoll<maxBootPolls;bootPoll++){
          try{
            const candidate=await monitor.verifyBoot({transaction:current,poll:bootPoll+1});
            const verification=candidate&&candidate.ready===true?candidate.verification:candidate&&candidate.ready===false?null:candidate;
            if(verification){
              const checked=validateBootVerification(current,verification,clock());
              if(checked.ok)return persistTransition(journal,current,"BOOT_VERIFIED",verification,clock());
              lastBootErrors=checked.errors;
            }
          }catch(error){lastBootErrors=[String(error&&error.message||error||"post-boot check failed")];}
          if(bootPoll+1<maxBootPolls)await sleep(bootIntervalMs);
        }
        const suffix=lastBootErrors.length?` Last checks: ${lastBootErrors.join(" ")}`:"";
        return persistTransition(journal,current,"UNKNOWN",`bounded post-boot verification did not pass.${suffix}`,clock());
      }
      if (index + 1 < maxPolls) await sleep(intervalMs);
    }
    return persistTransition(journal, current, "UNKNOWN", "GET-only restore-status polling reached its reviewed bound", clock());
  } catch (error) {
    const unknown = await persistUnknownAfterArming(journal, current, "restore-status or post-boot verification was inconclusive; automatic retry is permanently locked", clock());
    error.stage0Transaction = unknown;
    throw error;
  }
}

function createGoldenQualification(transaction, now = Date.now()) {
  const valid = validateTransaction(transaction);
  if (!valid.ok) throw new Error(valid.errors.join(" "));
  if (transaction.state !== TRANSACTION_STATES.BOOT_VERIFIED || transaction.imageId !== GOLDEN_IMAGE.id || cleanSha(transaction.imageSha256) !== GOLDEN_IMAGE.sha256) {
    throw new Error("Only an exact stock golden transaction that reached BOOT_VERIFIED can qualify the canary stage.");
  }
  const riskProfile=String(transaction.riskProfile||(transaction.recoveryEvidenceId?"physical-nor-v1":""));
  const riskEvidenceId=String(transaction.riskEvidenceId||transaction.recoveryEvidenceId||"");
  const riskCaptureSha256=cleanSha(transaction.riskCaptureSha256||transaction.recoveryCaptureSha256);
  if (!transaction.transportContractId || !/^[0-9a-f]{64}$/.test(cleanSha(transaction.transportCaptureSha256))||!["physical-nor-v1",SOFTWARE_RISK_PROFILE].includes(riskProfile)||!riskEvidenceId||!/^[0-9a-f]{64}$/.test(riskCaptureSha256)||!/^[0-9a-f]{64}$/.test(cleanSha(transaction.unitFingerprintSha256))) {
    throw new Error("The completed golden transaction is not bound to reviewed RestoreFw and recovery/risk evidence.");
  }
  return Object.freeze({
    schema: GOLDEN_QUALIFICATION_SCHEMA,
    completedAt: now,
    transactionId: transaction.transactionId,
    state: transaction.state,
    imageId: transaction.imageId,
    imageSha256: transaction.imageSha256,
    unitFingerprintSha256:cleanSha(transaction.unitFingerprintSha256),
    transportContractId: transaction.transportContractId,
    transportCaptureSha256: cleanSha(transaction.transportCaptureSha256),
    riskProfile,
    riskEvidenceId,
    riskCaptureSha256,
    recoveryEvidenceId:riskProfile==="physical-nor-v1"?riskEvidenceId:"",
    recoveryCaptureSha256:riskProfile==="physical-nor-v1"?riskCaptureSha256:""
  });
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
  WEBUI_CANARY_LOGS_R1,
  KNOWN_IMAGES,
  SAFE_IMAGES,
  REQUIRED_FIRMWARE,
  MIN_BATTERY_PERCENT,
  MAX_LIVE_EVIDENCE_AGE_MS,
  MAX_IMAGE_EVIDENCE_AGE_MS,
  JOURNAL_SCHEMA,
  JOURNAL_KEY,
  GOLDEN_QUALIFICATION_SCHEMA,
  GOLDEN_QUALIFICATION_KEY,
  RECOVERY_EVIDENCE_SCHEMA,
  FULL_NOR_SIZE_BYTES,
  SOFTWARE_RISK_EVIDENCE_SCHEMA,
  SOFTWARE_RISK_PROFILE,
  SOFTWARE_ONLY_MIN_BATTERY_PERCENT,
  MAX_SOFTWARE_RISK_EVIDENCE_AGE_MS,
  ATOMIC_RESTORE_LEASE_PROVEN,
  VERIFIED_RESTORE_TRANSPORTS,
  VERIFIED_RECOVERY_EVIDENCE,
  VERIFIED_SOFTWARE_RISK_EVIDENCE,
  TRANSACTION_STATES,
  TERMINAL_STATES,
  ALLOWED_TRANSITIONS,
  sha256Hex,
  createImageEvidence,
  lookupImage,
  validateImage,
  validateImageEvidence,
  validateAuditImageEvidence,
  normalizedDevice,
  validateDevice,
  validatePower,
  normalizedTransportEvidence,
  validateTransportEvidence,
  normalizedRecoveryEvidence,
  validateRecoveryEvidence,
  normalizedSoftwareRiskEvidence,
  validateSoftwareRiskEvidence,
  validateRiskEvidence,
  restoreAvailability,
  validateGoldenQualification,
  validateRestoreSequence,
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
  executeArmedRestoreOnce,
  executePersistentRestoreOnce,
  monitorPersistentRestore,
  createGoldenQualification,
  recoverPersistentTransaction,
  clearCompletedJournal
};
