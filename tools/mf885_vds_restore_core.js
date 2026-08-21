"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");

const SCHEMA = 1;
const EXT4_MAGIC = 0xef53;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_RECORD_BYTES = 1024 * 1024;
const GOLDEN_SLOT_ID = "golden-qualification-v1";
const GOLDEN_RETRY_SLOT_ID = "golden-qualification-retry-v2";
const GOLDEN_IMAGE_SHA256 = "2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531";
const GOLDEN_BODY_BYTES = 8323893;
const GOLDEN_BODY_SHA256 = "5a58dbb564229dc118d305c51dfbb4ecb925075574086aeb86bb05e1add39d22";
const GOLDEN_BOUNDARY = "----mf885-stage0-dryrun-2b5880fc26805918bb574d07";
const RESTORE_ROUTE = "/xml_action.cgi?Action=RestoreFw";
const RESTORE_HOST = "192.168.21.1";
const RESTORE_PORT = 80;
const RESTORE_LOCAL_ADDRESS = "10.73.255.1";
const RESTORE_UNIT_FINGERPRINT_SHA256 = "4c6903eeabd85384c10d42ae3b337d718aae7ed1d036be2ca9ad781997bbb47e";
const FENCE_REPOSITORY = "nryabkov/mf885-smsreader";
const FENCE_TARGET_COMMIT = "be1bc6902910afa1a4f83feadfb956280629c99e";
const DEFAULT_FENCE_TIMEOUT_MS = 5000;
const MIN_POST_DISPATCH_BUDGET_MS = 2000;
const WEB_RESTORE_SESSION_PROFILE = "fresh-web-digest-sms-read-next-post-no-server-cookie-v1";
const APP_RETRY_SESSION_PROFILE = "fresh-app-digest-post-nc4-client-app-no-server-cookie-v2";
const V1_GATE_SHA256 = "77dfaa4aff412aa29a003d5274684c9dc8abcf35fa066219664ab26e5ab5226c";
const V1_TERMINAL_RECORD_SHA256 = "915f05c09305720db6241eb53352f2086ebd222a7a1139115644bd9dd3c433d6";
const V1_EXTERNAL_FENCE_RECORD_SHA256 = "8acb1b719142974f3c83480a8ee48ee38f357a49ea4ddf89bc09f4f2c1e42a6a";
const V1_EXTERNAL_FENCE_REF = "refs/tags/mf885-restore-fence-v1-42063835281d6f41828bc7a1b1960e21559b6dad5dada8016991fd1dc0351167";

const STATES = Object.freeze({
  PRECHECK_OK: "PRECHECK_OK",
  EXTERNAL_FENCE_COMMITTED: "EXTERNAL_FENCE_COMMITTED",
  POST_ARMED: "POST_ARMED",
  DISPATCH_STARTED: "DISPATCH_STARTED",
  POST_ACCEPTED: "POST_ACCEPTED",
  RESTORING: "RESTORING",
  REBOOT_WAIT: "REBOOT_WAIT",
  BOOT_VERIFIED: "BOOT_VERIFIED",
  FAILED_PRE_SEND: "FAILED_PRE_SEND",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN"
});

const ALLOWED_TRANSITIONS = Object.freeze({
  [STATES.PRECHECK_OK]: new Set([STATES.POST_ARMED, STATES.FAILED_PRE_SEND]),
  [STATES.POST_ARMED]: new Set([STATES.EXTERNAL_FENCE_COMMITTED, STATES.UNKNOWN]),
  [STATES.EXTERNAL_FENCE_COMMITTED]: new Set([STATES.DISPATCH_STARTED, STATES.UNKNOWN]),
  [STATES.DISPATCH_STARTED]: new Set([STATES.POST_ACCEPTED, STATES.UNKNOWN]),
  [STATES.POST_ACCEPTED]: new Set([STATES.RESTORING, STATES.REBOOT_WAIT, STATES.BOOT_VERIFIED, STATES.FAILED, STATES.UNKNOWN]),
  [STATES.RESTORING]: new Set([STATES.RESTORING, STATES.REBOOT_WAIT, STATES.BOOT_VERIFIED, STATES.FAILED, STATES.UNKNOWN]),
  [STATES.REBOOT_WAIT]: new Set([STATES.REBOOT_WAIT, STATES.BOOT_VERIFIED, STATES.UNKNOWN]),
  [STATES.BOOT_VERIFIED]: new Set(),
  [STATES.FAILED_PRE_SEND]: new Set(),
  [STATES.FAILED]: new Set(),
  [STATES.UNKNOWN]: new Set()
});

const TERMINAL_STATES = Object.freeze([
  STATES.BOOT_VERIFIED,
  STATES.FAILED_PRE_SEND,
  STATES.FAILED,
  STATES.UNKNOWN
]);

class RestoreStateError extends Error {
  constructor(message, code = "RESTORE_STATE_INVALID", details = {}) {
    super(message);
    this.name = "RestoreStateError";
    this.code = code;
    this.details = details;
  }
}

class RestoreHttpError extends Error {
  constructor(message, code = "RESTORE_HTTP_UNKNOWN", details = {}) {
    super(message);
    this.name = "RestoreHttpError";
    this.code = code;
    this.details = details;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function md5(value) {
  return crypto.createHash("md5").update(String(value), "utf8").digest("hex");
}

function stableValue(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RestoreStateError("State records cannot contain non-finite numbers.");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(item => stableValue(item, seen));
  if (!value || typeof value !== "object" || Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    throw new RestoreStateError("State records must contain JSON-safe plain values only.");
  }
  if (seen.has(value)) throw new RestoreStateError("State records cannot contain cycles.");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new RestoreStateError(`State field ${key} is undefined.`);
    result[key] = stableValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(stableValue(value))}\n`, "utf8");
}

function sealRecord(payload) {
  const body = stableValue(payload);
  return Object.freeze({ ...body, recordSha256: sha256(canonicalJson(body)) });
}

function verifySealedRecord(record, label = "record") {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new RestoreStateError(`${label} is not a JSON object.`, "RESTORE_STATE_CORRUPT");
  }
  const actual = String(record.recordSha256 || "");
  const body = { ...record };
  delete body.recordSha256;
  const expected = sha256(canonicalJson(body));
  if (!/^[0-9a-f]{64}$/.test(actual) || actual !== expected) {
    throw new RestoreStateError(`${label} checksum is invalid.`, "RESTORE_STATE_CORRUPT");
  }
  return Object.freeze({ ...body, recordSha256: actual });
}

function assertHex(value, bytes, label) {
  const text = String(value || "").toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(text)) {
    throw new RestoreStateError(`${label} must be a ${bytes * 2}-character hexadecimal value.`);
  }
  return text;
}

function assertToken(value, label, pattern = /^[A-Za-z0-9._:-]{1,180}$/) {
  const text = String(value || "");
  if (!pattern.test(text)) throw new RestoreStateError(`${label} is invalid.`);
  return text;
}

function assertTimestamp(value, label = "timestamp") {
  const text = String(value || "");
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new RestoreStateError(`${label} must be an ISO-8601 UTC timestamp.`);
  }
  return text;
}

function optionalDiagnosticText(value, label) {
  if (value === undefined || value === null) return null;
  const text = String(value);
  if (text.length > 180 || /[\r\n\x00-\x1f\x7f]/.test(text)) {
    throw new RestoreStateError(`${label} is invalid.`);
  }
  return text;
}

function safeRestoreHttpEvidence(error) {
  const details = error && error.details && typeof error.details === "object" ? error.details : {};
  const result = {};
  const statusCode = Number(details.statusCode);
  if (details.statusCode !== undefined && details.statusCode !== null && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599) result.httpStatus = statusCode;
  if (typeof details.contentType === "string" && details.contentType.length <= 180 && !/[\r\n\x00-\x1f\x7f]/.test(details.contentType)) result.responseContentType = details.contentType;
  if (typeof details.server === "string" && details.server.length <= 180 && !/[\r\n\x00-\x1f\x7f]/.test(details.server)) result.responseServer = details.server;
  if (/^[0-9a-f]{64}$/.test(String(details.bodySha256 || ""))) result.responseBodySha256 = String(details.bodySha256);
  const bodyBytes = Number(details.bodyBytes);
  if (details.bodyBytes !== undefined && details.bodyBytes !== null && Number.isInteger(bodyBytes) && bodyBytes >= 0 && bodyBytes <= 4096) result.responseBodyBytes = bodyBytes;
  if (/^[A-Z0-9._-]{1,100}$/.test(String(details.causeCode || ""))) result.networkCauseCode = String(details.causeCode);
  for (const [source, target] of [["wwwAuthenticatePresent", "wwwAuthenticatePresent"], ["locationPresent", "locationPresent"], ["setCookiePresent", "setCookiePresent"]]) {
    if (typeof details[source] === "boolean") result[target] = details[source];
  }
  return Object.freeze(result);
}

function checkedRealDirectory(directory, expectedMode = DIRECTORY_MODE) {
  const resolved = path.resolve(String(directory || ""));
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RestoreStateError("Restore state path must be a real directory.", "RESTORE_STATE_UNSAFE_PATH");
  }
  const real = fs.realpathSync.native(resolved);
  if (real !== resolved) throw new RestoreStateError("Restore state path cannot traverse symbolic links.", "RESTORE_STATE_UNSAFE_PATH");
  if (stat.uid !== process.getuid()) throw new RestoreStateError("Restore state directory has the wrong owner.", "RESTORE_STATE_UNSAFE_OWNER");
  if ((stat.mode & 0o777) !== expectedMode) throw new RestoreStateError("Restore state directory must have mode 0700.", "RESTORE_STATE_UNSAFE_MODE");
  const type = Number(fs.statfsSync(resolved).type);
  if (type !== EXT4_MAGIC) throw new RestoreStateError("Restore state directory must be on local ext4 storage.", "RESTORE_STATE_UNSAFE_FILESYSTEM");
  return Object.freeze({ path: resolved, uid: stat.uid, mode: stat.mode & 0o777, fsType: "ext4", fsMagic: type });
}

function openDirectory(directory) {
  return fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
}

function fsyncDirectory(directory) {
  const fd = openDirectory(directory);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function ensureStateDirectory(directory, options = {}) {
  const resolved = path.resolve(String(directory || ""));
  const missing = [];
  let cursor = resolved;
  while (!fs.existsSync(cursor)) {
    missing.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new RestoreStateError("Restore state has no existing parent directory.", "RESTORE_STATE_UNSAFE_PATH");
    cursor = parent;
  }
  const ancestor = fs.lstatSync(cursor);
  if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || fs.realpathSync.native(cursor) !== cursor) {
    throw new RestoreStateError("Restore state cannot be provisioned through symbolic links.", "RESTORE_STATE_UNSAFE_PATH");
  }
  for (const component of missing) {
    const parent = cursor;
    cursor = path.join(cursor, component);
    fs.mkdirSync(cursor, { mode: DIRECTORY_MODE });
    fs.chmodSync(cursor, DIRECTORY_MODE);
    fsyncDirectory(cursor);
    fsyncDirectory(parent);
    if (typeof options.boundary === "function") options.boundary("state-directory-durable", { pathSha256: sha256(Buffer.from(cursor)) });
  }
  // Re-fsync both the entry and its parent even when the directory existed
  // before this process. The permanent gate must not depend on an unflushed
  // directory entry created by an earlier run.
  fsyncDirectory(resolved);
  fsyncDirectory(path.dirname(resolved));
  return checkedRealDirectory(resolved);
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(written) || written <= 0) throw new RestoreStateError("Durable record write was incomplete.", "RESTORE_STATE_IO");
    offset += written;
  }
}

function readFileNoFollow(file, maxBytes = MAX_RECORD_BYTES) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new RestoreStateError("Durable record is not a regular file.", "RESTORE_STATE_CORRUPT");
    if (stat.size <= 0 || stat.size > maxBytes) throw new RestoreStateError("Durable record size is invalid.", "RESTORE_STATE_CORRUPT");
    if ((stat.mode & 0o777) !== FILE_MODE) throw new RestoreStateError("Durable records must have mode 0600.", "RESTORE_STATE_UNSAFE_MODE");
    const result = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < result.length) {
      const count = fs.readSync(fd, result, offset, result.length - offset, offset);
      if (count <= 0) throw new RestoreStateError("Durable record was truncated while reading.", "RESTORE_STATE_CORRUPT");
      offset += count;
    }
    return result;
  } finally { fs.closeSync(fd); }
}

function readSealedJson(file, label) {
  let parsed;
  try { parsed = JSON.parse(readFileNoFollow(file).toString("utf8")); }
  catch (error) {
    if (error instanceof RestoreStateError) throw error;
    throw new RestoreStateError(`${label} is not valid JSON.`, "RESTORE_STATE_CORRUPT");
  }
  return verifySealedRecord(parsed, label);
}

function publishImmutable(directory, filename, payload, options = {}) {
  checkedRealDirectory(directory);
  const finalName = assertToken(filename, "durable filename", /^[A-Za-z0-9._-]{1,180}$/);
  const finalPath = path.join(directory, finalName);
  const sealed = sealRecord(payload);
  const bytes = canonicalJson(sealed);
  if (bytes.length > MAX_RECORD_BYTES) throw new RestoreStateError("Durable record is too large.");
  const candidate = path.join(directory, `.pending-${finalName}-${crypto.randomUUID()}`);
  let fd = null;
  let linked = false;
  try {
    fd = fs.openSync(candidate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, FILE_MODE);
    fs.fchmodSync(fd, FILE_MODE);
    writeAll(fd, bytes);
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (typeof options.boundary === "function") options.boundary("candidate-durable", { candidate, finalPath, sealed });
    fs.linkSync(candidate, finalPath);
    linked = true;
    fsyncDirectory(directory);
    if (typeof options.boundary === "function") options.boundary("published-durable", { candidate, finalPath, sealed });
    const reread = readSealedJson(finalPath, finalName);
    if (reread.recordSha256 !== sealed.recordSha256) throw new RestoreStateError("Durable record read-back differs from the published value.", "RESTORE_STATE_IO");
    fs.unlinkSync(candidate);
    fsyncDirectory(directory);
    return Object.freeze({ path: finalPath, bytes: bytes.length, record: reread, recordSha256: reread.recordSha256 });
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    if (!linked && error && error.code === "EEXIST") {
      try { fs.unlinkSync(candidate); fsyncDirectory(directory); } catch (_) {}
      throw new RestoreStateError(`${finalName} already exists; this restore slot is permanently locked.`, "RESTORE_STATE_ALREADY_LOCKED", { finalPath });
    }
    // Ambiguous I/O after publication deliberately leaves both names behind.
    // Any later inspection treats the orphan as locked/corrupt and never sends.
    throw error;
  }
}

function externalFenceSpec(input = {}) {
  const slotId = assertToken(input.slotId, "slotId", /^[A-Za-z0-9._-]{1,120}$/);
  if (![GOLDEN_SLOT_ID, GOLDEN_RETRY_SLOT_ID].includes(slotId)) throw new RestoreStateError("This reviewed sender permits only the two fixed golden qualification slots.");
  const unitFingerprintSha256 = assertHex(input.unitFingerprintSha256, 32, "unitFingerprintSha256");
  if (unitFingerprintSha256 !== RESTORE_UNIT_FINGERPRINT_SHA256) throw new RestoreStateError("This reviewed sender permits only the exact live MF885 unit.");
  const imageSha256 = assertHex(input.imageSha256, 32, "imageSha256");
  if (imageSha256 !== GOLDEN_IMAGE_SHA256) throw new RestoreStateError("This reviewed sender permits only the exact stock golden image.");
  const fenceVersion = slotId === GOLDEN_RETRY_SLOT_ID ? 2 : 1;
  const canonical = Buffer.from([
    `mf885-restore-fence-v${fenceVersion}`,
    `slot=${slotId}`,
    `unitFingerprintSha256=${unitFingerprintSha256}`,
    `imageSha256=${imageSha256}`,
    `route=${RESTORE_ROUTE}`,
    ...(slotId === GOLDEN_RETRY_SLOT_ID ? [
      `predecessorGateSha256=${V1_GATE_SHA256}`,
      `predecessorTerminalRecordSha256=${V1_TERMINAL_RECORD_SHA256}`,
      `predecessorFenceRef=${V1_EXTERNAL_FENCE_REF}`,
      `localAddress=${RESTORE_LOCAL_ADDRESS}`,
      `sessionProfile=${APP_RETRY_SESSION_PROFILE}`
    ] : []),
    ""
  ].join("\n"), "utf8");
  const fenceIdSha256 = sha256(canonical);
  return Object.freeze({
    schema: SCHEMA,
    profile: "github-create-reference-v1",
    repository: FENCE_REPOSITORY,
    targetCommit: FENCE_TARGET_COMMIT,
    ref: `refs/tags/mf885-restore-fence-v${fenceVersion}-${fenceIdSha256}`,
    fenceIdSha256
  });
}

function gatePayload(input = {}) {
  const slotId = assertToken(input.slotId, "slotId", /^[A-Za-z0-9._-]{1,120}$/);
  const unitFingerprintSha256 = assertHex(input.unitFingerprintSha256, 32, "unitFingerprintSha256");
  const imageSha256 = assertHex(input.imageSha256, 32, "imageSha256");
  const fence = externalFenceSpec({ slotId, unitFingerprintSha256, imageSha256 });
  return {
    schema: SCHEMA,
    kind: "mf885-restore-permanent-gate",
    transactionId: assertToken(input.transactionId, "transactionId", /^[0-9a-f-]{36}$/),
    ownerToken: assertHex(input.ownerToken, 32, "ownerToken"),
    operation: "RestoreFw",
    slotId,
    unitFingerprintSha256,
    imageSha256,
    bodySha256: (() => {
      const value = assertHex(input.bodySha256, 32, "bodySha256");
      if (value !== GOLDEN_BODY_SHA256) throw new RestoreStateError("Permanent gate body checksum is not the reviewed golden multipart.");
      return value;
    })(),
    contractSha256: assertHex(input.contractSha256, 32, "contractSha256"),
    preflightEvidenceSha256: assertHex(input.preflightEvidenceSha256, 32, "preflightEvidenceSha256"),
    externalFenceIdSha256: fence.fenceIdSha256,
    externalFenceRef: fence.ref,
    ...(slotId === GOLDEN_RETRY_SLOT_ID ? {
      predecessorGateSha256: V1_GATE_SHA256,
      predecessorTerminalRecordSha256: V1_TERMINAL_RECORD_SHA256,
      predecessorFenceRef: V1_EXTERNAL_FENCE_REF
    } : {}),
    bootId: assertToken(input.bootId, "bootId", /^[0-9a-f-]{36}$/),
    pid: Number.isSafeInteger(input.pid) && input.pid > 0 ? input.pid : (() => { throw new RestoreStateError("pid is invalid."); })(),
    createdAt: assertTimestamp(input.createdAt, "createdAt")
  };
}

function acquirePermanentGate(directory, input, options = {}) {
  ensureStateDirectory(directory);
  const payload = gatePayload(input);
  try {
    const published = publishImmutable(directory, "gate.lock", payload, options);
    return Object.freeze({ acquired: true, gate: published.record, gateSha256: published.recordSha256 });
  } catch (error) {
    if (error instanceof RestoreStateError && error.code === "RESTORE_STATE_ALREADY_LOCKED") {
      let existing = null;
      try { existing = readGate(directory); } catch (_) {}
      return Object.freeze({ acquired: false, gate: existing, gateSha256: existing && existing.recordSha256 || null, reason: error.message });
    }
    throw error;
  }
}

function readGate(directory) {
  checkedRealDirectory(directory);
  const gate = readSealedJson(path.join(directory, "gate.lock"), "gate.lock");
  if (gate.schema !== SCHEMA || gate.kind !== "mf885-restore-permanent-gate" || gate.operation !== "RestoreFw") {
    throw new RestoreStateError("Permanent gate schema is invalid.", "RESTORE_STATE_CORRUPT");
  }
  const normalized = gatePayload(gate);
  const keys = ["slotId", "unitFingerprintSha256", "imageSha256", "bodySha256", "contractSha256", "preflightEvidenceSha256", "externalFenceIdSha256", "externalFenceRef"];
  if (gate.slotId === GOLDEN_RETRY_SLOT_ID) keys.push("predecessorGateSha256", "predecessorTerminalRecordSha256", "predecessorFenceRef");
  for (const key of keys) {
    if (gate[key] !== normalized[key]) throw new RestoreStateError(`Permanent gate ${key} is invalid.`, "RESTORE_STATE_CORRUPT");
  }
  return gate;
}

function assertGateOwner(directory, receipt) {
  const gate = readGate(directory);
  if (!receipt || gate.transactionId !== receipt.transactionId || gate.ownerToken !== receipt.ownerToken || gate.recordSha256 !== receipt.gateSha256) {
    throw new RestoreStateError("Permanent gate ownership was lost or changed.", "RESTORE_STATE_OWNER_LOST");
  }
  return gate;
}

function journalFiles(directory) {
  const names = fs.readdirSync(directory);
  const unexpected = names.filter(name => !/^(?:gate\.lock|armed\.json|external-fence\.json|http-response\.json|journal-\d{6}\.json)$/.test(name));
  if (unexpected.length) throw new RestoreStateError("Restore state contains an orphan or unexpected object.", "RESTORE_STATE_CORRUPT", { unexpected: unexpected.sort() });
  return names.filter(name => /^journal-\d{6}\.json$/.test(name)).sort();
}

function validateJournalRecord(record, gate, previous, expectedRevision) {
  if (record.schema !== SCHEMA || record.kind !== "mf885-restore-journal" || record.revision !== expectedRevision) {
    throw new RestoreStateError("Journal revision schema or sequence is invalid.", "RESTORE_STATE_CORRUPT");
  }
  if (!Object.values(STATES).includes(record.state)) throw new RestoreStateError("Journal state is unknown.", "RESTORE_STATE_CORRUPT");
  const bindings = ["transactionId", "unitFingerprintSha256", "imageSha256", "bodySha256", "contractSha256", "preflightEvidenceSha256", "externalFenceIdSha256"];
  if (gate.slotId === GOLDEN_RETRY_SLOT_ID) bindings.push("predecessorGateSha256", "predecessorTerminalRecordSha256", "predecessorFenceRef");
  for (const key of bindings) if (record[key] !== gate[key]) throw new RestoreStateError(`Journal ${key} does not match the permanent gate.`, "RESTORE_STATE_CORRUPT");
  if (record.gateSha256 !== gate.recordSha256) throw new RestoreStateError("Journal gate checksum does not match.", "RESTORE_STATE_CORRUPT");
  const expectedPrevious = previous ? previous.recordSha256 : null;
  if (record.previousRecordSha256 !== expectedPrevious) throw new RestoreStateError("Journal hash chain is broken.", "RESTORE_STATE_CORRUPT");
  if (previous && !ALLOWED_TRANSITIONS[previous.state].has(record.state)) throw new RestoreStateError(`Illegal journal transition ${previous.state} -> ${record.state}.`, "RESTORE_STATE_CORRUPT");
  if (!previous && record.state !== STATES.PRECHECK_OK) throw new RestoreStateError("Journal must begin with PRECHECK_OK.", "RESTORE_STATE_CORRUPT");
  if (!previous && record.evidenceSha256 !== gate.preflightEvidenceSha256) throw new RestoreStateError("PRECHECK_OK evidence does not match the permanent gate.", "RESTORE_STATE_CORRUPT");
  const allowanceExpected = ![STATES.PRECHECK_OK, STATES.FAILED_PRE_SEND].includes(record.state);
  if (record.allowanceConsumed !== allowanceExpected) throw new RestoreStateError("Journal allowance-consumed flag is inconsistent.", "RESTORE_STATE_CORRUPT");
  const attemptedExpected = [STATES.DISPATCH_STARTED, STATES.POST_ACCEPTED, STATES.RESTORING, STATES.REBOOT_WAIT, STATES.BOOT_VERIFIED, STATES.FAILED, STATES.UNKNOWN].includes(record.state) && record.state !== STATES.UNKNOWN ? 1 : record.firmwarePostsAttempted;
  if (![0, 1].includes(record.firmwarePostsAttempted) || (allowanceExpected && record.state !== STATES.POST_ARMED && record.firmwarePostsAttempted !== attemptedExpected)) {
    throw new RestoreStateError("Journal firmware-attempt count is inconsistent.", "RESTORE_STATE_CORRUPT");
  }
  if (record.state === STATES.POST_ARMED && record.firmwarePostsAttempted !== 0) throw new RestoreStateError("POST_ARMED cannot claim a network attempt.", "RESTORE_STATE_CORRUPT");
  if (record.state === STATES.EXTERNAL_FENCE_COMMITTED && record.firmwarePostsAttempted !== 0) throw new RestoreStateError("The external fence state cannot claim a router POST.", "RESTORE_STATE_CORRUPT");
  if (record.httpStatus !== undefined && record.httpStatus !== null && (!Number.isInteger(record.httpStatus) || record.httpStatus < 100 || record.httpStatus > 599)) throw new RestoreStateError("Journal HTTP status is invalid.", "RESTORE_STATE_CORRUPT");
  for (const key of ["responseContentType", "responseServer"]) {
    if (record[key] !== undefined && record[key] !== null) optionalDiagnosticText(record[key], `journal ${key}`);
  }
  if (record.responseBodySha256 !== undefined && record.responseBodySha256 !== null) assertHex(record.responseBodySha256, 32, "journal responseBodySha256");
  if (record.responseBodyBytes !== undefined && record.responseBodyBytes !== null && (!Number.isInteger(record.responseBodyBytes) || record.responseBodyBytes < 0 || record.responseBodyBytes > 4096)) throw new RestoreStateError("Journal response body length is invalid.", "RESTORE_STATE_CORRUPT");
  if (record.networkCauseCode !== undefined && record.networkCauseCode !== null) assertToken(record.networkCauseCode, "journal networkCauseCode", /^[A-Z0-9._-]{1,100}$/);
  for (const key of ["wwwAuthenticatePresent", "locationPresent", "setCookiePresent"]) {
    if (record[key] !== undefined && record[key] !== null && typeof record[key] !== "boolean") throw new RestoreStateError(`Journal ${key} is invalid.`, "RESTORE_STATE_CORRUPT");
  }
  assertTimestamp(record.recordedAt, "journal recordedAt");
  return record;
}

function readJournal(directory, suppliedGate = null) {
  checkedRealDirectory(directory);
  const gate = suppliedGate || readGate(directory);
  const files = journalFiles(directory);
  const records = [];
  for (let index = 0; index < files.length; index++) {
    const expected = `journal-${String(index + 1).padStart(6, "0")}.json`;
    if (files[index] !== expected) throw new RestoreStateError("Journal contains a missing or duplicate revision.", "RESTORE_STATE_CORRUPT");
    const record = readSealedJson(path.join(directory, files[index]), files[index]);
    records.push(validateJournalRecord(record, gate, records[index - 1] || null, index + 1));
  }
  const fenceRecord = readExternalFence(directory, gate);
  const fenceJournal = records.find(record => record.state === STATES.EXTERNAL_FENCE_COMMITTED);
  if (fenceJournal && (!fenceRecord || fenceJournal.evidenceSha256 !== fenceRecord.recordSha256)) {
    throw new RestoreStateError("Journal external-fence evidence is missing or mismatched.", "RESTORE_STATE_CORRUPT");
  }
  const responseRecord = readRestoreHttpResponse(directory, gate, records);
  const dispatchRecord = records.find(record => record.state === STATES.DISPATCH_STARTED) || null;
  const acceptedRecord = records.find(record => record.state === STATES.POST_ACCEPTED) || null;
  if (responseRecord && !dispatchRecord) throw new RestoreStateError("HTTP response evidence exists without a durable dispatch record.", "RESTORE_STATE_CORRUPT");
  const terminalUnknown = records.find(record => record.state === STATES.UNKNOWN && record.firmwarePostsAttempted === 1) || null;
  if (gate.slotId === GOLDEN_RETRY_SLOT_ID && (acceptedRecord || terminalUnknown)) {
    if (!responseRecord) throw new RestoreStateError("Retry-v2 dispatched without durable HTTP response evidence.", "RESTORE_STATE_CORRUPT");
    if (acceptedRecord) {
      if (responseRecord.accepted !== true || acceptedRecord.evidenceSha256 !== responseRecord.recordSha256) throw new RestoreStateError("Accepted retry-v2 response is not bound to its journal transition.", "RESTORE_STATE_CORRUPT");
    } else {
      if (terminalUnknown && terminalUnknown.evidenceSha256 !== responseRecord.recordSha256) throw new RestoreStateError("Unknown retry-v2 response is not bound to its journal transition.", "RESTORE_STATE_CORRUPT");
    }
  }
  return Object.freeze({ gate, records: Object.freeze(records), last: records[records.length - 1] || null });
}

function journalPayload(gate, previous, state, input = {}) {
  const allowanceConsumed = ![STATES.PRECHECK_OK, STATES.FAILED_PRE_SEND].includes(state);
  const defaultAttempts = [STATES.DISPATCH_STARTED, STATES.POST_ACCEPTED, STATES.RESTORING, STATES.REBOOT_WAIT, STATES.BOOT_VERIFIED, STATES.FAILED].includes(state) ? 1 : 0;
  const attempts = input.firmwarePostsAttempted === undefined ? defaultAttempts : Number(input.firmwarePostsAttempted);
  const payload = {
    schema: SCHEMA,
    kind: "mf885-restore-journal",
    revision: previous ? previous.revision + 1 : 1,
    state,
    recordedAt: assertTimestamp(input.recordedAt, "recordedAt"),
    transactionId: gate.transactionId,
    gateSha256: gate.recordSha256,
    unitFingerprintSha256: gate.unitFingerprintSha256,
    imageSha256: gate.imageSha256,
    bodySha256: gate.bodySha256,
    contractSha256: gate.contractSha256,
    preflightEvidenceSha256: gate.preflightEvidenceSha256,
    externalFenceIdSha256: gate.externalFenceIdSha256,
    ...(gate.slotId === GOLDEN_RETRY_SLOT_ID ? {
      predecessorGateSha256: gate.predecessorGateSha256,
      predecessorTerminalRecordSha256: gate.predecessorTerminalRecordSha256,
      predecessorFenceRef: gate.predecessorFenceRef
    } : {}),
    previousRecordSha256: previous ? previous.recordSha256 : null,
    allowanceConsumed,
    firmwarePostsAttempted: attempts,
    evidenceSha256: input.evidenceSha256 ? assertHex(input.evidenceSha256, 32, "evidenceSha256") : null,
    statusRaw: input.statusRaw === undefined || input.statusRaw === null ? null : assertToken(input.statusRaw, "statusRaw", /^[0-9]{1,3}$/),
    progress: input.progress === undefined || input.progress === null ? null : Number(input.progress),
    reasonCode: input.reasonCode ? assertToken(input.reasonCode, "reasonCode", /^[A-Z0-9._-]{1,100}$/) : null,
    httpStatus: input.httpStatus === undefined || input.httpStatus === null ? null : Number(input.httpStatus),
    responseContentType: optionalDiagnosticText(input.responseContentType, "responseContentType"),
    responseServer: optionalDiagnosticText(input.responseServer, "responseServer"),
    responseBodySha256: input.responseBodySha256 === undefined || input.responseBodySha256 === null ? null : assertHex(input.responseBodySha256, 32, "responseBodySha256"),
    responseBodyBytes: input.responseBodyBytes === undefined || input.responseBodyBytes === null ? null : Number(input.responseBodyBytes),
    networkCauseCode: input.networkCauseCode ? assertToken(input.networkCauseCode, "networkCauseCode", /^[A-Z0-9._-]{1,100}$/) : null,
    wwwAuthenticatePresent: typeof input.wwwAuthenticatePresent === "boolean" ? input.wwwAuthenticatePresent : null,
    locationPresent: typeof input.locationPresent === "boolean" ? input.locationPresent : null,
    setCookiePresent: typeof input.setCookiePresent === "boolean" ? input.setCookiePresent : null
  };
  if (![0, 1].includes(payload.firmwarePostsAttempted)) throw new RestoreStateError("firmwarePostsAttempted must be zero or one.");
  if (payload.progress !== null && (!Number.isFinite(payload.progress) || payload.progress < 0 || payload.progress > 100)) throw new RestoreStateError("Journal progress is invalid.");
  if (payload.httpStatus !== null && (!Number.isInteger(payload.httpStatus) || payload.httpStatus < 100 || payload.httpStatus > 599)) throw new RestoreStateError("Journal HTTP status is invalid.");
  if (payload.responseBodyBytes !== null && (!Number.isInteger(payload.responseBodyBytes) || payload.responseBodyBytes < 0 || payload.responseBodyBytes > 4096)) throw new RestoreStateError("Journal response body length is invalid.");
  return payload;
}

function appendJournal(directory, receipt, state, input = {}, options = {}) {
  const gate = assertGateOwner(directory, receipt);
  const journal = readJournal(directory, gate);
  const previous = journal.last;
  if (!Object.values(STATES).includes(state)) throw new RestoreStateError("Refusing to append an unknown journal state.");
  if (previous && !ALLOWED_TRANSITIONS[previous.state].has(state)) throw new RestoreStateError(`Refusing transition ${previous.state} -> ${state}.`);
  if (!previous && state !== STATES.PRECHECK_OK) throw new RestoreStateError("First journal state must be PRECHECK_OK.");
  const payload = journalPayload(gate, previous, state, input);
  const filename = `journal-${String(payload.revision).padStart(6, "0")}.json`;
  const published = publishImmutable(directory, filename, payload, options);
  validateJournalRecord(published.record, gate, previous, payload.revision);
  const reread = readJournal(directory, gate);
  if (!reread.last || reread.last.recordSha256 !== published.recordSha256) throw new RestoreStateError("Journal append did not survive read-back.", "RESTORE_STATE_IO");
  return reread.last;
}

function armedPayload(gate, input = {}) {
  return {
    schema: SCHEMA,
    kind: "mf885-restore-allowance-burn",
    transactionId: gate.transactionId,
    gateSha256: gate.recordSha256,
    unitFingerprintSha256: gate.unitFingerprintSha256,
    imageSha256: gate.imageSha256,
    bodySha256: gate.bodySha256,
    contractSha256: gate.contractSha256,
    externalFenceIdSha256: gate.externalFenceIdSha256,
    externalFenceRef: gate.externalFenceRef,
    ...(gate.slotId === GOLDEN_RETRY_SLOT_ID ? {
      predecessorGateSha256: gate.predecessorGateSha256,
      predecessorTerminalRecordSha256: gate.predecessorTerminalRecordSha256,
      predecessorFenceRef: gate.predecessorFenceRef
    } : {}),
    allowanceConsumed: 1,
    armedAt: assertTimestamp(input.armedAt, "armedAt")
  };
}

function readArmed(directory, gate = null) {
  checkedRealDirectory(directory);
  const file = path.join(directory, "armed.json");
  if (!fs.existsSync(file)) return null;
  const armed = readSealedJson(file, "armed.json");
  const expectedGate = gate || readGate(directory);
  const bindings = ["transactionId", "unitFingerprintSha256", "imageSha256", "bodySha256", "contractSha256", "externalFenceIdSha256", "externalFenceRef"];
  if (expectedGate.slotId === GOLDEN_RETRY_SLOT_ID) bindings.push("predecessorGateSha256", "predecessorTerminalRecordSha256", "predecessorFenceRef");
  for (const key of bindings) {
    if (armed[key] !== expectedGate[key]) throw new RestoreStateError(`armed.json ${key} does not match the permanent gate.`, "RESTORE_STATE_CORRUPT");
  }
  if (armed.gateSha256 !== expectedGate.recordSha256 || armed.kind !== "mf885-restore-allowance-burn" || armed.allowanceConsumed !== 1) {
    throw new RestoreStateError("armed.json schema or gate binding is invalid.", "RESTORE_STATE_CORRUPT");
  }
  return armed;
}

function readExternalFence(directory, gate = null) {
  checkedRealDirectory(directory);
  const file = path.join(directory, "external-fence.json");
  if (!fs.existsSync(file)) return null;
  const record = readSealedJson(file, "external-fence.json");
  const expectedGate = gate || readGate(directory);
  if (record.schema !== SCHEMA || record.kind !== "mf885-restore-external-fence" || record.profile !== "github-create-reference-v1") {
    throw new RestoreStateError("External fence record schema is invalid.", "RESTORE_STATE_CORRUPT");
  }
  for (const key of ["transactionId", "externalFenceIdSha256", "externalFenceRef"]) {
    if (record[key] !== expectedGate[key]) throw new RestoreStateError(`External fence ${key} does not match the permanent gate.`, "RESTORE_STATE_CORRUPT");
  }
  if (record.gateSha256 !== expectedGate.recordSha256 || record.repository !== FENCE_REPOSITORY || record.targetCommit !== FENCE_TARGET_COMMIT || record.responseStatus !== 201) {
    throw new RestoreStateError("External fence response binding is invalid.", "RESTORE_STATE_CORRUPT");
  }
  assertHex(record.responseBodySha256, 32, "external fence responseBodySha256");
  assertTimestamp(record.createdAt, "external fence createdAt");
  return record;
}

function restoreHttpResponsePayload(gate, dispatchRecord, input = {}) {
  if (!dispatchRecord || dispatchRecord.state !== STATES.DISPATCH_STARTED || dispatchRecord.gateSha256 !== gate.recordSha256) {
    throw new RestoreStateError("HTTP response evidence requires the exact durable dispatch record.", "RESTORE_STATE_CORRUPT");
  }
  const encoded = input.responseBodyBase64 === undefined || input.responseBodyBase64 === null ? null : String(input.responseBodyBase64);
  let body = null, bodyBytes = null, bodySha256 = null;
  if (encoded !== null) {
    if (encoded.length > 8192 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new RestoreStateError("HTTP response evidence is not bounded canonical base64.", "RESTORE_STATE_CORRUPT");
    body = Buffer.from(encoded, "base64");
    if (body.length > 4096 || body.toString("base64") !== encoded) throw new RestoreStateError("HTTP response evidence bytes are invalid.", "RESTORE_STATE_CORRUPT");
    bodyBytes = body.length;
    bodySha256 = sha256(body);
    if (input.bodyBytes !== undefined && input.bodyBytes !== null && Number(input.bodyBytes) !== bodyBytes) throw new RestoreStateError("HTTP response evidence length changed.", "RESTORE_STATE_CORRUPT");
    if (input.bodySha256 !== undefined && input.bodySha256 !== null && String(input.bodySha256) !== bodySha256) throw new RestoreStateError("HTTP response evidence checksum changed.", "RESTORE_STATE_CORRUPT");
  }
  const statusCode = input.statusCode === undefined || input.statusCode === null ? null : Number(input.statusCode);
  if (statusCode !== null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) throw new RestoreStateError("HTTP response evidence status is invalid.", "RESTORE_STATE_CORRUPT");
  const contentType = optionalDiagnosticText(input.contentType, "HTTP response contentType");
  const server = optionalDiagnosticText(input.server, "HTTP response server");
  const accepted = input.accepted === true;
  const complete = input.responseComplete === true;
  if (complete && body === null) throw new RestoreStateError("A complete HTTP response must retain its exact bytes.", "RESTORE_STATE_CORRUPT");
  if (accepted) {
    const expected = Buffer.from("Server get upload file successfully\n", "utf8");
    if (!complete || statusCode !== 200 || contentType !== "text/html" || server !== "Mongoose/3.0" || !body || !body.equals(expected)) throw new RestoreStateError("Accepted HTTP response evidence does not match the native predicate.", "RESTORE_STATE_CORRUPT");
  }
  return {
    schema: SCHEMA,
    kind: "mf885-restore-http-response",
    slotId: gate.slotId,
    transactionId: gate.transactionId,
    gateSha256: gate.recordSha256,
    dispatchRecordSha256: dispatchRecord.recordSha256,
    accepted,
    requestAttempted: input.requestAttempted === true,
    complete,
    oversized: input.responseOversized === true,
    statusCode,
    contentType,
    server,
    bodyBytes,
    bodySha256,
    bodyBase64: encoded,
    wwwAuthenticatePresent: input.wwwAuthenticatePresent === true,
    locationPresent: input.locationPresent === true,
    setCookiePresent: input.setCookiePresent === true,
    networkCauseCode: input.causeCode ? assertToken(input.causeCode, "HTTP response networkCauseCode", /^[A-Z0-9._-]{1,100}$/) : null,
    outcomeCode: assertToken(input.outcomeCode || (accepted ? "RESTORE_HTTP_ACCEPTED" : "RESTORE_HTTP_UNKNOWN"), "HTTP response outcomeCode", /^[A-Z0-9._-]{1,100}$/),
    capturedAt: assertTimestamp(input.capturedAt, "HTTP response capturedAt")
  };
}

function persistRestoreHttpResponse(directory, receipt, input = {}, options = {}) {
  const gate = assertGateOwner(directory, receipt);
  if (gate.slotId !== GOLDEN_RETRY_SLOT_ID) throw new RestoreStateError("Durable raw response evidence is restricted to retry-v2.");
  const journal = readJournal(directory, gate);
  const dispatchRecord = journal.last;
  if (!dispatchRecord || dispatchRecord.state !== STATES.DISPATCH_STARTED) throw new RestoreStateError("HTTP response evidence can be committed only at DISPATCH_STARTED.");
  const published = publishImmutable(directory, "http-response.json", restoreHttpResponsePayload(gate, dispatchRecord, input), options);
  const reread = readRestoreHttpResponse(directory, gate, journal.records);
  if (!reread || reread.recordSha256 !== published.recordSha256) throw new RestoreStateError("HTTP response evidence did not survive read-back.", "RESTORE_STATE_IO");
  return reread;
}

function readRestoreHttpResponse(directory, suppliedGate = null, suppliedRecords = null) {
  checkedRealDirectory(directory);
  const file = path.join(directory, "http-response.json");
  if (!fs.existsSync(file)) return null;
  const gate = suppliedGate || readGate(directory);
  const records = suppliedRecords || journalFiles(directory).map(name => readSealedJson(path.join(directory, name), name));
  const dispatchRecord = records.find(record => record.state === STATES.DISPATCH_STARTED) || null;
  const record = readSealedJson(file, "http-response.json");
  const normalized = restoreHttpResponsePayload(gate, dispatchRecord, {
    accepted: record.accepted,
    requestAttempted: record.requestAttempted,
    responseComplete: record.complete,
    responseOversized: record.oversized,
    statusCode: record.statusCode,
    contentType: record.contentType,
    server: record.server,
    responseBodyBase64: record.bodyBase64,
    bodyBytes: record.bodyBytes,
    bodySha256: record.bodySha256,
    wwwAuthenticatePresent: record.wwwAuthenticatePresent,
    locationPresent: record.locationPresent,
    setCookiePresent: record.setCookiePresent,
    causeCode: record.networkCauseCode,
    outcomeCode: record.outcomeCode,
    capturedAt: record.capturedAt
  });
  for (const key of Object.keys(normalized)) if (record[key] !== normalized[key]) throw new RestoreStateError(`HTTP response evidence ${key} is invalid.`, "RESTORE_STATE_CORRUPT");
  return record;
}

function githubFenceRequest(spec, token, options = {}) {
  const secret = String(token || "");
  if (!secret || secret.length > 512 || /[\s\x00-\x1f\x7f]/.test(secret)) {
    return Promise.reject(new RestoreStateError("A bounded GitHub token is required for the independent create-once fence.", "RESTORE_FENCE_AUTH_MISSING"));
  }
  if (!spec || spec.repository !== FENCE_REPOSITORY || spec.targetCommit !== FENCE_TARGET_COMMIT || !/^refs\/tags\/mf885-restore-fence-v(?:1|2)-[0-9a-f]{64}$/.test(String(spec.ref || ""))) {
    return Promise.reject(new RestoreStateError("External fence specification is invalid.", "RESTORE_FENCE_PLAN_INVALID"));
  }
  const body = Buffer.from(JSON.stringify({ ref: spec.ref, sha: spec.targetCommit }), "utf8");
  const timeoutMs = Number(options.timeoutMs || DEFAULT_FENCE_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 60000) return Promise.reject(new RestoreStateError("External fence timeout is outside the reviewed bound."));
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const fail = (message, code, details = {}) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(new RestoreStateError(message, code, details));
    };
    let request;
    try {
      request = https.request({
        protocol: "https:",
        hostname: "api.github.com",
        port: 443,
        method: "POST",
        path: `/repos/${FENCE_REPOSITORY}/git/refs`,
        agent: false,
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${secret}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "mf885-vds-restore/1",
          "Content-Type": "application/json",
          "Content-Length": String(body.length),
          "Connection": "close"
        }
      }, response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 65536) {
            response.destroy();
            fail("GitHub fence response exceeded the reviewed envelope.", "RESTORE_FENCE_RESPONSE_INVALID");
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("aborted", () => fail("GitHub fence response was truncated; router POST remains blocked.", "RESTORE_FENCE_OUTCOME_UNKNOWN"));
        response.on("error", error => fail("GitHub fence response failed; router POST remains blocked.", "RESTORE_FENCE_OUTCOME_UNKNOWN", { causeCode: error && error.code || "UNKNOWN" }));
        response.on("end", () => {
          if (settled) return;
          const responseBody = Buffer.concat(chunks);
          const responseContentType = String(response.headers && response.headers["content-type"] || "").toLowerCase();
          let value = null;
          try { value = JSON.parse(responseBody.toString("utf8")); } catch (_) {}
          const exact = response.statusCode === 201 && /^application\/json(?:\s*;|$)/.test(responseContentType) && value && value.ref === spec.ref && value.object && value.object.type === "commit" && value.object.sha === spec.targetCommit;
          if (!exact) {
            fail("GitHub did not prove creation of the unique external fence; router POST remains blocked.", "RESTORE_FENCE_NOT_CREATED", {
              statusCode: Number(response.statusCode) || null,
              bodySha256: sha256(responseBody),
              bodyBytes: responseBody.length
            });
            return;
          }
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(Object.freeze({
            schema: SCHEMA,
            profile: spec.profile,
            repository: spec.repository,
            targetCommit: spec.targetCommit,
            externalFenceRef: spec.ref,
            externalFenceIdSha256: spec.fenceIdSha256,
            responseStatus: 201,
            responseBodySha256: sha256(responseBody)
          }));
        });
      });
    } catch (error) {
      fail("GitHub fence request could not be constructed; router POST remains blocked.", "RESTORE_FENCE_OUTCOME_UNKNOWN", { causeCode: error && error.code || "UNKNOWN" });
      return;
    }
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("GitHub fence deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
    request.setTimeout(Math.min(timeoutMs, 10000), () => request.destroy(Object.assign(new Error("GitHub fence stalled."), { code: "ETIMEDOUT" })));
    request.on("error", error => fail("GitHub fence outcome is unknown; router POST remains blocked.", "RESTORE_FENCE_OUTCOME_UNKNOWN", { causeCode: error && error.code || "UNKNOWN" }));
    request.end(body);
  });
}

async function commitExternalFence(directory, receipt, token, input = {}, options = {}) {
  const gate = assertGateOwner(directory, receipt);
  const journal = readJournal(directory, gate);
  const armed = readArmed(directory, gate);
  if (!armed || !journal.last || journal.last.state !== STATES.POST_ARMED) throw new RestoreStateError("External fence creation requires a durable POST_ARMED allowance burn.");
  if (readExternalFence(directory, gate)) throw new RestoreStateError("External fence was already recorded; replay is forbidden.", "RESTORE_STATE_ALREADY_LOCKED");
  const spec = externalFenceSpec(gate);
  let remote;
  try { remote = await githubFenceRequest(spec, token, { timeoutMs: input.timeoutMs }); }
  catch (error) {
    const evidence = sha256(canonicalJson({ code: error && error.code || "RESTORE_FENCE_OUTCOME_UNKNOWN", details: error && error.details || {} }));
    try { appendJournal(directory, receipt, STATES.UNKNOWN, { recordedAt: input.createdAt, evidenceSha256: evidence, reasonCode: error && error.code || "RESTORE_FENCE_OUTCOME_UNKNOWN", firmwarePostsAttempted: 0 }, options); } catch (_) {}
    throw error;
  }
  const payload = {
    schema: SCHEMA,
    kind: "mf885-restore-external-fence",
    ...remote,
    transactionId: gate.transactionId,
    gateSha256: gate.recordSha256,
    createdAt: assertTimestamp(input.createdAt, "external fence createdAt")
  };
  const published = publishImmutable(directory, "external-fence.json", payload, options);
  const reread = readExternalFence(directory, gate);
  if (!reread || reread.recordSha256 !== published.recordSha256) throw new RestoreStateError("External fence record did not survive read-back.", "RESTORE_STATE_IO");
  appendJournal(directory, receipt, STATES.EXTERNAL_FENCE_COMMITTED, { recordedAt: input.createdAt, evidenceSha256: reread.recordSha256, firmwarePostsAttempted: 0 }, options);
  assertGateOwner(directory, receipt);
  return reread;
}

function burnPostAllowance(directory, receipt, input = {}, options = {}) {
  const gate = assertGateOwner(directory, receipt);
  const journal = readJournal(directory, gate);
  if (!journal.last || journal.last.state !== STATES.PRECHECK_OK) {
    throw new RestoreStateError("POST allowance can be burned only after the exact preflight is durably committed.");
  }
  if (readArmed(directory, gate)) throw new RestoreStateError("POST allowance is already consumed.", "RESTORE_STATE_ALREADY_LOCKED");
  const published = publishImmutable(directory, "armed.json", armedPayload(gate, input), options);
  const armed = readArmed(directory, gate);
  if (!armed || armed.recordSha256 !== published.recordSha256) throw new RestoreStateError("POST allowance burn did not survive read-back.", "RESTORE_STATE_IO");
  appendJournal(directory, receipt, STATES.POST_ARMED, { recordedAt: input.armedAt, evidenceSha256: armed.recordSha256, firmwarePostsAttempted: 0 }, options);
  assertGateOwner(directory, receipt);
  return armed;
}

function inspectTransaction(directory) {
  checkedRealDirectory(directory);
  const gate = readGate(directory);
  const journal = readJournal(directory, gate);
  const armed = readArmed(directory, gate);
  const last = journal.last;
  let disposition = "LOCKED_UNKNOWN";
  if (!last) disposition = "LOCKED_UNKNOWN";
  else if ([STATES.POST_ACCEPTED, STATES.RESTORING, STATES.REBOOT_WAIT].includes(last.state) && armed) disposition = "MONITOR_ONLY";
  else if (last.state === STATES.BOOT_VERIFIED && armed) disposition = "COMPLETE_LOCKED";
  else if (last.state === STATES.FAILED_PRE_SEND && !armed) disposition = "FAILED_PRE_SEND_LOCKED";
  else if ([STATES.FAILED, STATES.UNKNOWN].includes(last.state)) disposition = "TERMINAL_LOCKED";
  if (armed && (!last || last.state === STATES.PRECHECK_OK)) disposition = "LOCKED_UNKNOWN";
  if (!armed && last && ![STATES.PRECHECK_OK, STATES.FAILED_PRE_SEND].includes(last.state)) {
    throw new RestoreStateError("Journal claims a consumed POST allowance but armed.json is missing.", "RESTORE_STATE_CORRUPT");
  }
  return Object.freeze({ gate, journal, armed, last, disposition, postAllowed: false });
}

function validateRestoreRequestPlan(input = {}, body) {
  const payload = Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body || []);
  if (!payload.length) throw new RestoreHttpError("Restore request body is empty.", "RESTORE_HTTP_PLAN_INVALID");
  const host = String(input.host || "");
  if (net.isIP(host) !== 4 || host !== RESTORE_HOST) throw new RestoreHttpError("Restore host is not the reviewed MF885 route.", "RESTORE_HTTP_PLAN_INVALID");
  const port = Number(input.port === undefined ? 80 : input.port);
  if (!Number.isInteger(port) || port !== RESTORE_PORT) throw new RestoreHttpError("Restore port is not the reviewed MF885 route.", "RESTORE_HTTP_PLAN_INVALID");
  const requestPath = String(input.path || "");
  if (requestPath !== RESTORE_ROUTE) throw new RestoreHttpError("Restore request path is not the exact native route.", "RESTORE_HTTP_PLAN_INVALID");
  const boundary = assertToken(input.boundary, "multipart boundary", /^[0-9A-Za-z'()+_,.\-/:=?]{1,70}$/);
  if (boundary !== GOLDEN_BOUNDARY) throw new RestoreHttpError("Multipart boundary is not the reviewed golden envelope.", "RESTORE_HTTP_PLAN_INVALID");
  const contentType = `multipart/form-data; boundary=${boundary}`;
  const timeoutMs = Number(input.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new RestoreHttpError("Restore timeout is outside the reviewed bound.", "RESTORE_HTTP_PLAN_INVALID");
  const expectedBodySha256 = assertHex(input.bodySha256, 32, "bodySha256");
  const actualBodySha256 = sha256(payload);
  if (actualBodySha256 !== expectedBodySha256 || actualBodySha256 !== GOLDEN_BODY_SHA256 || payload.length !== GOLDEN_BODY_BYTES) throw new RestoreHttpError("Restore body is not the exact reviewed golden multipart envelope.", "RESTORE_HTTP_PLAN_INVALID");
  const localAddress = String(input.localAddress || "");
  if (net.isIP(localAddress) !== 4 || localAddress !== RESTORE_LOCAL_ADDRESS) throw new RestoreHttpError("The exact reviewed VDS router source interface is missing.", "RESTORE_HTTP_PLAN_INVALID");
  const sessionProfile = String(input.sessionProfile || "");
  if (![WEB_RESTORE_SESSION_PROFILE, APP_RETRY_SESSION_PROFILE].includes(sessionProfile)) throw new RestoreHttpError("The reviewed RestoreFw session proof is missing.", "RESTORE_HTTP_PLAN_INVALID");
  const sessionProvenAtMs = Number(input.sessionProvenAtMs);
  const maxSessionAgeMs = Number(input.maxSessionAgeMs);
  if (!Number.isFinite(sessionProvenAtMs) || !Number.isInteger(maxSessionAgeMs) || maxSessionAgeMs < 1000 || maxSessionAgeMs > 15000) throw new RestoreHttpError("The active-session freshness bound is invalid.", "RESTORE_HTTP_PLAN_INVALID");
  const sessionCookie = String(input.sessionCookie || "");
  const expectedCookie = sessionProfile === WEB_RESTORE_SESSION_PROFILE ? "locale=en; hard_ver=Ver.D; platform=mifi" : "";
  if (sessionCookie !== expectedCookie || input.serverCookieReceived !== false) throw new RestoreHttpError("The exact reviewed session cookie profile is missing or unsafe.", "RESTORE_HTTP_PLAN_INVALID");
  const sessionAuthorization = String(input.sessionAuthorization || "");
  const digest = sessionProfile === WEB_RESTORE_SESSION_PROFILE
    ? sessionAuthorization.match(/^Digest username="admin", realm="([^"\\]{1,180})", nonce="([^"\\]{1,300})", uri="\/cgi\/xml_action\.cgi", response="([0-9a-f]{32})", qop=auth, nc=00000004, cnonce="([0-9a-f]{16})"(?:, opaque="([^"\\]{1,300})")?$/)
    : sessionAuthorization.match(/^Digest username="admin", realm="([^"\\]{1,180})", nonce="([^"\\]{1,300})", uri="\/cgi\/xml_action\.cgi", response="([0-9a-f]{32})", qop=auth, nc=00000004, cnonce="([0-9a-f]{16})", client=APP$/);
  if (sessionAuthorization.length > 2048 || /[\r\n\x00-\x1f\x7f]/.test(sessionAuthorization) || !digest) {
    throw new RestoreHttpError("The exact reviewed POST Authorization header is missing or unsafe.", "RESTORE_HTTP_PLAN_INVALID");
  }
  const expectedDigestResponse = md5(`${md5(`admin:${digest[1]}:zimifi`)}:${digest[2]}:00000004:${digest[4]}:auth:${md5("POST:/cgi/xml_action.cgi")}`);
  if (digest[3] !== expectedDigestResponse) throw new RestoreHttpError("The reviewed POST Digest proof is internally invalid.", "RESTORE_HTTP_PLAN_INVALID");
  return Object.freeze({
    host,
    port,
    method: "POST",
    path: requestPath,
    boundary,
    contentType,
    contentLength: payload.length,
    bodySha256: actualBodySha256,
    timeoutMs,
    localAddress,
    sessionProfile,
    sessionProvenAtMs,
    maxSessionAgeMs,
    sessionCookie,
    serverCookieReceived: false,
    sessionAuthorization,
    body: payload
  });
}

function sendRestoreHttpOnce(plan) {
  if (!plan || plan.method !== "POST" || !Buffer.isBuffer(plan.body)) return Promise.reject(new RestoreHttpError("Restore request plan is not sealed.", "RESTORE_HTTP_PLAN_INVALID"));
  // The high-level dispatcher keeps the plan private. Make one final private
  // snapshot and never expose that snapshot to callbacks or adapters.
  const body = Buffer.from(plan.body);
  const expectedBody = Buffer.from("Server get upload file successfully\n", "utf8");
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const fail = (message, code, details = {}) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      reject(new RestoreHttpError(message, code, { ...details, attempted: true, automaticRetries: 0, redirectsFollowed: 0 }));
    };
    let request;
    try {
      request = http.request({
        host: plan.host,
        port: plan.port,
        localAddress: plan.localAddress,
        family: 4,
        method: "POST",
        path: plan.path,
        agent: false,
        headers: {
          "Content-Type": plan.contentType,
          "Content-Length": String(plan.contentLength),
          "Connection": "close",
          "Authorization": plan.sessionAuthorization,
          "X-Requested-With": "XMLHttpRequest",
          ...(plan.sessionCookie ? { "Cookie": plan.sessionCookie } : {})
        }
      }, response => {
        const chunks = [];
        let bytes = 0;
        const snapshot = (complete, extra = {}) => {
          const captured = Buffer.concat(chunks, bytes);
          return {
            statusCode: response.statusCode,
            contentType: String(response.headers["content-type"] || "").trim().toLowerCase(),
            server: String(response.headers.server || "").trim(),
            bodySha256: sha256(captured),
            bodyBytes: captured.length,
            responseBodyBase64: captured.toString("base64"),
            responseComplete: complete === true,
            wwwAuthenticatePresent: !!response.headers["www-authenticate"],
            locationPresent: !!response.headers.location,
            setCookiePresent: !!response.headers["set-cookie"],
            ...extra
          };
        };
        response.on("data", chunk => {
          const item = Buffer.from(chunk);
          const remaining = 4096 - bytes;
          if (item.length > remaining) {
            if (remaining > 0) { chunks.push(item.subarray(0, remaining)); bytes += remaining; }
            response.destroy();
            fail("Restore response exceeded the exact acceptance envelope.", "RESTORE_HTTP_RESPONSE_INVALID", snapshot(false, { responseOversized: true }));
            return;
          }
          chunks.push(item);
          bytes += item.length;
        });
        response.on("aborted", () => fail("Restore response was truncated.", "RESTORE_HTTP_RESPONSE_TRUNCATED", snapshot(false)));
        response.on("error", error => fail("Restore response failed after dispatch.", "RESTORE_HTTP_RESPONSE_ERROR", snapshot(false, { causeCode: error && error.code || "UNKNOWN" })));
        response.on("end", () => {
          if (settled) return;
          const body = Buffer.concat(chunks);
          const contentType = String(response.headers["content-type"] || "").trim().toLowerCase();
          const server = String(response.headers.server || "").trim();
          const responseDiagnostics = snapshot(true);
          const accepted = response.statusCode === 200 && contentType === "text/html" && server === "Mongoose/3.0" && body.equals(expectedBody);
          if (!accepted) {
            fail("Restore response did not match the exact native acceptance predicate.", "RESTORE_HTTP_NOT_ACCEPTED", {
              ...responseDiagnostics
            });
            return;
          }
          settled = true;
          if (deadline) clearTimeout(deadline);
          resolve(Object.freeze({
            attempted: true,
            accepted: true,
            statusCode: 200,
            contentType,
            server,
            bodyBytes: body.length,
            bodySha256: sha256(body),
            responseBodyBase64: body.toString("base64"),
            responseComplete: true,
            wwwAuthenticatePresent: !!response.headers["www-authenticate"],
            locationPresent: !!response.headers.location,
            setCookiePresent: !!response.headers["set-cookie"],
            automaticRetries: 0,
            redirectsFollowed: 0
          }));
        });
      });
    } catch (error) {
      fail("Restore request could not be constructed after dispatch was durably recorded.", "RESTORE_HTTP_CONSTRUCTION_FAILED", { causeCode: error && error.code || "UNKNOWN" });
      return;
    }
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("Restore request total deadline exceeded."), { code: "ETIMEDOUT" })), plan.timeoutMs);
    request.setTimeout(Math.min(plan.timeoutMs, 15000), () => request.destroy(Object.assign(new Error("Restore request stalled."), { code: "ETIMEDOUT" })));
    request.on("error", error => fail("Restore request outcome is unknown after network failure.", "RESTORE_HTTP_NETWORK_UNKNOWN", { causeCode: error && error.code || "UNKNOWN" }));
    request.end(body);
  });
}

async function dispatchRestoreAtMostOnce(input = {}) {
  const directory = input.directory;
  const receipt = input.receipt;
  const now = typeof input.now === "function" ? input.now : () => new Date().toISOString();
  const nowMs = typeof input.nowMs === "function" ? input.nowMs : () => Date.now();
  const plan = validateRestoreRequestPlan(input.request, input.body);
  const fenceTimeoutMs = Number(input.fenceTimeoutMs === undefined ? DEFAULT_FENCE_TIMEOUT_MS : input.fenceTimeoutMs);
  if (!Number.isInteger(fenceTimeoutMs) || fenceTimeoutMs < 5000 || fenceTimeoutMs > 60000) throw new RestoreStateError("External fence timeout is outside the reviewed bound.");
  const entryAgeMs = nowMs() - plan.sessionProvenAtMs;
  const remainingSessionMs = plan.maxSessionAgeMs - entryAgeMs;
  if (entryAgeMs < 0 || remainingSessionMs < fenceTimeoutMs + MIN_POST_DISPATCH_BUDGET_MS) {
    throw new RestoreStateError("The fresh Web Digest session lacks enough remaining time for the external fence and one dispatch; no allowance was consumed.", "RESTORE_SESSION_BUDGET_LOW", { remainingSessionMs, requiredMs: fenceTimeoutMs + MIN_POST_DISPATCH_BUDGET_MS });
  }
  const gate = assertGateOwner(directory, receipt);
  const expectedSessionProfile = gate.slotId === GOLDEN_RETRY_SLOT_ID ? APP_RETRY_SESSION_PROFILE : WEB_RESTORE_SESSION_PROFILE;
  if (plan.sessionProfile !== expectedSessionProfile) throw new RestoreStateError("Restore session profile does not match the permanent slot.", "RESTORE_SESSION_PROFILE_MISMATCH");
  if (gate.bodySha256 !== plan.bodySha256) throw new RestoreStateError("Request body does not match the permanent gate.");
  const before = readJournal(directory, gate);
  if (!before.last || before.last.state !== STATES.PRECHECK_OK) throw new RestoreStateError("Restore dispatch is not at the preflight boundary.");
  burnPostAllowance(directory, receipt, { armedAt: now() });
  assertGateOwner(directory, receipt);
  await commitExternalFence(directory, receipt, input.githubToken, { createdAt: now(), timeoutMs: fenceTimeoutMs });
  assertGateOwner(directory, receipt);
  const postFenceAgeMs = nowMs() - plan.sessionProvenAtMs;
  if (postFenceAgeMs < 0 || plan.maxSessionAgeMs - postFenceAgeMs < MIN_POST_DISPATCH_BUDGET_MS) {
    const error = new RestoreStateError("The fresh Web Digest SMS-read POST session proof expired before dispatch; router POST remains blocked.", "RESTORE_SESSION_STALE");
    const evidence = sha256(canonicalJson({ code: error.code }));
    try { appendJournal(directory, receipt, STATES.UNKNOWN, { recordedAt: now(), evidenceSha256: evidence, reasonCode: error.code, firmwarePostsAttempted: 0 }); } catch (_) {}
    throw error;
  }
  appendJournal(directory, receipt, STATES.DISPATCH_STARTED, { recordedAt: now(), evidenceSha256: plan.bodySha256, firmwarePostsAttempted: 1 });
  assertGateOwner(directory, receipt);
  try {
    const dispatchAgeMs = nowMs() - plan.sessionProvenAtMs;
    if (dispatchAgeMs < 0 || dispatchAgeMs > plan.maxSessionAgeMs) throw new RestoreHttpError("The Web Digest session expired after the durable dispatch record; router POST remains blocked.", "RESTORE_SESSION_STALE", { attempted: false });
    const response = await sendRestoreHttpOnce(plan);
    const responseRecord = gate.slotId === GOLDEN_RETRY_SLOT_ID ? persistRestoreHttpResponse(directory, receipt, {
      accepted: true,
      requestAttempted: response.attempted === true,
      responseComplete: response.responseComplete === true,
      statusCode: response.statusCode,
      contentType: response.contentType,
      server: response.server,
      responseBodyBase64: response.responseBodyBase64,
      bodyBytes: response.bodyBytes,
      bodySha256: response.bodySha256,
      wwwAuthenticatePresent: response.wwwAuthenticatePresent,
      locationPresent: response.locationPresent,
      setCookiePresent: response.setCookiePresent,
      outcomeCode: "RESTORE_HTTP_ACCEPTED",
      capturedAt: now()
    }) : null;
    appendJournal(directory, receipt, STATES.POST_ACCEPTED, { recordedAt: now(), evidenceSha256: responseRecord ? responseRecord.recordSha256 : response.bodySha256, firmwarePostsAttempted: 1 });
    return Object.freeze({ state: STATES.POST_ACCEPTED, response, firmwarePostsAttempted: 1, allowanceConsumed: true });
  } catch (error) {
    const evidence = sha256(canonicalJson({ code: error && error.code || "RESTORE_HTTP_UNKNOWN", details: error && error.details || {} }));
    const httpEvidence = safeRestoreHttpEvidence(error);
    let responseRecord = null;
    if (gate.slotId === GOLDEN_RETRY_SLOT_ID) {
      const details = error && error.details && typeof error.details === "object" ? error.details : {};
      try { responseRecord = readRestoreHttpResponse(directory, gate); } catch (_) {}
      if (!responseRecord && !(error instanceof RestoreHttpError)) {
        if (!error.details || typeof error.details !== "object") error.details = {};
        error.details.durableResponseCaptureFailed = true;
        throw error;
      }
      try {
        if (!responseRecord) responseRecord = persistRestoreHttpResponse(directory, receipt, {
          accepted: false,
          requestAttempted: details.attempted === true,
          responseComplete: details.responseComplete === true,
          responseOversized: details.responseOversized === true,
          statusCode: details.statusCode,
          contentType: details.contentType,
          server: details.server,
          responseBodyBase64: details.responseBodyBase64,
          bodyBytes: details.bodyBytes,
          bodySha256: details.bodySha256,
          wwwAuthenticatePresent: details.wwwAuthenticatePresent,
          locationPresent: details.locationPresent,
          setCookiePresent: details.setCookiePresent,
          causeCode: details.causeCode,
          outcomeCode: error && error.code || "RESTORE_HTTP_UNKNOWN",
          capturedAt: now()
        });
      } catch (captureError) {
        if (!error.details || typeof error.details !== "object") error.details = {};
        error.details.durableResponseCaptureFailed = true;
        error.details.durableResponseCaptureCode = captureError && captureError.code || "RESTORE_STATE_IO";
        throw error;
      }
    }
    try { appendJournal(directory, receipt, STATES.UNKNOWN, { recordedAt: now(), evidenceSha256: responseRecord ? responseRecord.recordSha256 : evidence, reasonCode: error && error.code || "RESTORE_HTTP_UNKNOWN", firmwarePostsAttempted: 1, ...httpEvidence }); }
    catch (_) {}
    throw error;
  }
}

function createGateInput(input = {}) {
  return gatePayload({
    ...input,
    transactionId: input.transactionId || crypto.randomUUID(),
    ownerToken: input.ownerToken || crypto.randomBytes(32).toString("hex"),
    pid: input.pid || process.pid,
    createdAt: input.createdAt || new Date().toISOString()
  });
}

module.exports = {
  SCHEMA,
  EXT4_MAGIC,
  GOLDEN_SLOT_ID,
  GOLDEN_RETRY_SLOT_ID,
  GOLDEN_IMAGE_SHA256,
  GOLDEN_BODY_BYTES,
  GOLDEN_BODY_SHA256,
  GOLDEN_BOUNDARY,
  RESTORE_ROUTE,
  RESTORE_HOST,
  RESTORE_PORT,
  RESTORE_LOCAL_ADDRESS,
  RESTORE_UNIT_FINGERPRINT_SHA256,
  FENCE_REPOSITORY,
  FENCE_TARGET_COMMIT,
  DEFAULT_FENCE_TIMEOUT_MS,
  MIN_POST_DISPATCH_BUDGET_MS,
  WEB_RESTORE_SESSION_PROFILE,
  APP_RETRY_SESSION_PROFILE,
  V1_GATE_SHA256,
  V1_TERMINAL_RECORD_SHA256,
  V1_EXTERNAL_FENCE_RECORD_SHA256,
  V1_EXTERNAL_FENCE_REF,
  STATES,
  TERMINAL_STATES,
  RestoreStateError,
  RestoreHttpError,
  sha256,
  safeRestoreHttpEvidence,
  canonicalJson,
  sealRecord,
  verifySealedRecord,
  ensureStateDirectory,
  checkedRealDirectory,
  publishImmutable,
  externalFenceSpec,
  createGateInput,
  acquirePermanentGate,
  readGate,
  assertGateOwner,
  appendJournal,
  readJournal,
  readArmed,
  readExternalFence,
  readRestoreHttpResponse,
  persistRestoreHttpResponse,
  githubFenceRequest,
  burnPostAllowance,
  inspectTransaction,
  validateRestoreRequestPlan,
  dispatchRestoreAtMostOnce
};
