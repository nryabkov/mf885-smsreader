"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const childProcess = require("node:child_process");
const core = require("./mf885_vds_restore_core.js");
const router = require("./mf885_vds_router.js");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const PRIVATE_DIRECTORY = path.join(REPOSITORY_ROOT, ".runtime", "private");
const STATE_DIRECTORY = path.join(REPOSITORY_ROOT, ".runtime", "mf885-restore", core.GOLDEN_SLOT_ID);
const RETRY_STATE_DIRECTORY = path.join(REPOSITORY_ROOT, ".runtime", "mf885-restore", core.GOLDEN_RETRY_SLOT_ID);
const CAPTURE_A = path.join(PRIVATE_DIRECTORY, "MF885_golden_capture_a.bin");
const CAPTURE_B = path.join(PRIVATE_DIRECTORY, "MF885_golden_capture_b.bin");
const SETTINGS_EVIDENCE = path.join(PRIVATE_DIRECTORY, "MF885_private_settings_current.json");
const EXECUTE_CONFIRMATION = "FLASH-GOLDEN-2b5880fc";
const RETRY_EXECUTE_CONFIRMATION = "RETRY-APP-NC4-GOLDEN-2b5880fc";

function safeFile(file, expectedMode = 0o600) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(resolved) !== resolved) throw new Error("Private evidence must be a real local file.");
  if (stat.uid !== process.getuid() || (stat.mode & 0o777) !== expectedMode) throw new Error("Private evidence has unsafe ownership or permissions.");
  return Object.freeze({ path: resolved, size: stat.size, mtime: stat.mtime.toISOString() });
}

function readJsonFile(file) {
  const checked = safeFile(file);
  if (checked.size <= 0 || checked.size > 4 * 1024 * 1024) throw new Error("Private JSON evidence size is invalid.");
  let value;
  try { value = JSON.parse(fs.readFileSync(checked.path, "utf8")); }
  catch (_) { throw new Error("Private JSON evidence is invalid."); }
  return Object.freeze({ checked, value });
}

function writePrivateEvidence(prefix, value) {
  fs.mkdirSync(PRIVATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRIVATE_DIRECTORY, 0o700);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const file = path.join(PRIVATE_DIRECTORY, `${prefix}-${stamp}.json`);
  const bytes = core.canonicalJson(value);
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  const dfd = fs.openSync(PRIVATE_DIRECTORY, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  return Object.freeze({ file, bytes: bytes.length, sha256: core.sha256(bytes) });
}

function writePrivateRestoreResponse(error, prefix = "restore-retry-v2-http-response", context = {}) {
  const details = error && error.details && typeof error.details === "object" ? error.details : {};
  if (typeof details.responseBodyBase64 !== "string") return null;
  let body;
  try { body = Buffer.from(details.responseBodyBase64, "base64"); }
  catch (_) { throw new Error("Restore response capture was not valid base64."); }
  if (body.length > 4096 || body.length !== Number(details.bodyBytes) || core.sha256(body) !== details.bodySha256 || body.toString("base64") !== details.responseBodyBase64) throw new Error("Restore response capture failed its private byte/hash validation.");
  const gateSha256 = String(context.gateSha256 || ""), journalRecordSha256 = String(context.journalRecordSha256 || "");
  if (!/^[0-9a-f]{64}$/.test(gateSha256) || !/^[0-9a-f]{64}$/.test(journalRecordSha256) || context.slotId !== core.GOLDEN_RETRY_SLOT_ID) throw new Error("Restore response capture lacks its exact retry-v2 transaction binding.");
  fs.mkdirSync(PRIVATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRIVATE_DIRECTORY, 0o700);
  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const captureId = `${prefix}-${stamp}-${process.pid}`;
  const bodyFile = path.join(PRIVATE_DIRECTORY, `${captureId}.bin`);
  writeExclusivePrivateFile(bodyFile, body);
  const record = Object.freeze({
    schema: "mf885-restore-http-response/v2",
    capturedAt: new Date().toISOString(),
    complete: details.responseComplete !== false,
    oversized: details.responseOversized === true,
    slotId: context.slotId,
    gateSha256,
    journalRecordSha256,
    errorCode: String(error && error.code || "RESTORE_HTTP_UNKNOWN"),
    statusCode: Number(details.statusCode) || null,
    contentType: String(details.contentType || ""),
    server: String(details.server || ""),
    bodyBytes: body.length,
    bodySha256: core.sha256(body),
    bodyFile: path.basename(bodyFile),
    headerPresence: Object.freeze({ wwwAuthenticate: details.wwwAuthenticatePresent === true, location: details.locationPresent === true, setCookie: details.setCookiePresent === true }),
    sensitiveRequestMaterialStored: false,
    smsPayloadsStored: false
  });
  const metadata = writePrivateEvidence(`${captureId}-metadata`, record);
  const dfd = fs.openSync(PRIVATE_DIRECTORY, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  return Object.freeze({ bodyFile, metadataFile: metadata.file, bodyBytes: body.length, bodySha256: record.bodySha256, metadataSha256: metadata.sha256 });
}

function writeExclusivePrivateFile(file, bytes) {
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== PRIVATE_DIRECTORY) throw new Error("Private capture path escaped its reviewed directory.");
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const fd = fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

async function captureBackup(slot) {
  if (!/^[ab]$/.test(String(slot || ""))) throw new Error("Capture slot must be exactly a or b.");
  fs.mkdirSync(PRIVATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRIVATE_DIRECTORY, 0o700);
  const imageFile = slot === "a" ? CAPTURE_A : CAPTURE_B;
  const reportFile = imageFile.replace(/\.bin$/, ".json");
  if (fs.existsSync(imageFile) || fs.existsSync(reportFile)) throw new Error(`Golden capture slot ${slot} is already occupied; it will not be overwritten.`);
  const captured = await router.captureGoldenBackup();
  if (captured.bytes !== router.GOLDEN_BYTES || captured.sha256 !== core.GOLDEN_IMAGE_SHA256 || core.sha256(captured.body) !== core.GOLDEN_IMAGE_SHA256) {
    throw new Error("The completed backup did not match the exact reviewed golden image.");
  }
  const report = Object.freeze({
    schema: "mf885-logical-backup-capture/v2",
    completedAt: captured.completedAt,
    artifact: Object.freeze({ file: path.basename(imageFile), size: captured.bytes, sha256: captured.sha256 }),
    power: Object.freeze({ batteryPercent: captured.batteryPercent, externalPowerConnected: captured.externalPowerConnected }),
    statusHistory: captured.statusHistory,
    transport: Object.freeze({ localAddress: captured.localAddress, connectionTerminatedAfterExactBody: captured.connectionTerminatedAfterExactBody }),
    safety: Object.freeze({ backupStartsAttempted: captured.startRequests, backupDownloadsAttempted: captured.downloadRequests, automaticRetries: captured.automaticRetries, restorePostsAttempted: captured.restorePostsAttempted })
  });
  writeExclusivePrivateFile(imageFile, captured.body);
  writeExclusivePrivateFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  const dfd = fs.openSync(PRIVATE_DIRECTORY, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  return Object.freeze({ slot, completedAt: captured.completedAt, bytes: captured.bytes, sha256: captured.sha256, batteryPercent: captured.batteryPercent, externalPowerConnected: captured.externalPowerConnected, backupStartsAttempted: captured.startRequests, backupDownloadsAttempted: captured.downloadRequests, automaticRetries: captured.automaticRetries, restorePostsAttempted: captured.restorePostsAttempted });
}

async function captureSettings() {
  fs.mkdirSync(PRIVATE_DIRECTORY, { recursive: true, mode: 0o700 });
  fs.chmodSync(PRIVATE_DIRECTORY, 0o700);
  if (fs.existsSync(SETTINGS_EVIDENCE)) throw new Error("The current private settings evidence already exists; it will not be overwritten.");
  const captured = await router.capturePrivateSettings();
  const bytes = core.canonicalJson(captured.record);
  writeExclusivePrivateFile(SETTINGS_EVIDENCE, bytes);
  const dfd = fs.openSync(PRIVATE_DIRECTORY, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  return Object.freeze({ file: path.basename(SETTINGS_EVIDENCE), bytes: bytes.length, sha256: core.sha256(bytes), capturedAt: captured.report.capturedAt, modelsAttempted: captured.report.modelsAttempted, modelsCaptured: captured.report.modelsCaptured, modelsFailed: captured.report.modelsFailed, wifiSettingsRecorded: captured.report.wifiSettingsRecorded, apnSettingsRecorded: captured.report.apnSettingsRecorded, stockExportUnavailable: captured.report.stockExportUnavailable, routerStateWritesAttempted: 0, restorePostsAttempted: 0 });
}

function validateCaptureReport(report, imageFile, nowMs = Date.now()) {
  const completedAtMs = report && Date.parse(String(report.completedAt || ""));
  const history = report && report.statusHistory;
  const statusItems = Array.isArray(history) ? history.filter(item => item && item.status !== undefined) : [];
  const firstStatus = statusItems[0], lastStatus = statusItems[statusItems.length - 1];
  let previousProgress = -1;
  const validProgression = statusItems.every(item => {
    const progress = Number(item.progress);
    if (!/^[123]$/.test(String(item.status)) || !Number.isInteger(progress) || progress < 0 || progress > 100) return false;
    if (item.status === "2" && progress < previousProgress) return false;
    if (item.status === "2") previousProgress = progress;
    return true;
  });
  if (
    !report ||
    report.schema !== "mf885-logical-backup-capture/v2" ||
    !Number.isFinite(completedAtMs) || completedAtMs > nowMs + 5 * 60 * 1000 ||
    !report.artifact || report.artifact.file !== path.basename(imageFile) || report.artifact.size !== router.GOLDEN_BYTES || report.artifact.sha256 !== core.GOLDEN_IMAGE_SHA256 ||
    !report.power || report.power.externalPowerConnected !== true || !Number.isInteger(report.power.batteryPercent) || report.power.batteryPercent < 80 ||
    !Array.isArray(history) || statusItems.length < 3 || !validProgression || !firstStatus || firstStatus.status !== "3" || Number(firstStatus.progress) !== 0 || !statusItems.some(item => item.status === "2") || !lastStatus || lastStatus.status !== "1" || Number(lastStatus.progress) !== 100 || !/^Success!?$/i.test(String(lastStatus.cause || "")) ||
    !report.transport || report.transport.localAddress !== core.RESTORE_LOCAL_ADDRESS || typeof report.transport.connectionTerminatedAfterExactBody !== "boolean" ||
    !report.safety ||
    report.safety.backupStartsAttempted !== 1 ||
    report.safety.backupDownloadsAttempted !== 1 ||
    report.safety.automaticRetries !== 0 ||
    report.safety.restorePostsAttempted !== 0
  ) throw new Error("Golden capture report is incomplete or unsafe.");
  return report;
}

function captureReport(imageFile) {
  const reportFile = imageFile.replace(/\.bin$/, ".json");
  return validateCaptureReport(readJsonFile(reportFile).value, imageFile);
}

function verifyBackupPair() {
  const first = safeFile(CAPTURE_A), second = safeFile(CAPTURE_B);
  if (first.size !== router.GOLDEN_BYTES || second.size !== router.GOLDEN_BYTES) throw new Error("Both backup captures must have the exact golden size.");
  const firstBytes = fs.readFileSync(first.path), secondBytes = fs.readFileSync(second.path);
  const firstSha256 = core.sha256(firstBytes), secondSha256 = core.sha256(secondBytes);
  if (firstSha256 !== core.GOLDEN_IMAGE_SHA256 || secondSha256 !== core.GOLDEN_IMAGE_SHA256 || !firstBytes.equals(secondBytes)) throw new Error("The two backup captures are not byte-identical exact golden images.");
  const firstReport = captureReport(CAPTURE_A), secondReport = captureReport(CAPTURE_B);
  const firstAt = String(firstReport.completedAt), secondAt = String(secondReport.completedAt);
  if (!Number.isFinite(Date.parse(firstAt)) || !Number.isFinite(Date.parse(secondAt)) || Date.parse(firstAt) >= Date.parse(secondAt)) throw new Error("Golden backup captures are not independently time-ordered.");
  return Object.freeze({ count: 2, size: first.size, sha256: firstSha256, byteIdentical: true, firstCapturedAt: firstAt, secondCapturedAt: secondAt });
}

function verifySettingsEvidence() {
  const item = readJsonFile(SETTINGS_EVIDENCE);
  const value = item.value;
  const verified = router.validatePrivateSettingsEvidence(value);
  const bytes = fs.readFileSync(item.checked.path);
  return Object.freeze({ sha256: core.sha256(bytes), bytes: bytes.length, capturedAt: verified.capturedAt, modelsCaptured: verified.modelsCaptured, modelsFailed: verified.modelsFailed, wifiSettingsRecorded: verified.wifiSettingsRecorded, apnSettingsRecorded: verified.apnSettingsRecorded, stockExportUnavailable: verified.stockExportUnavailable });
}

function loadGithubToken() {
  const result = childProcess.spawnSync("/usr/local/bin/gh-vds", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", timeout: 10000, maxBuffer: 4096, stdio: ["ignore", "pipe", "pipe"] });
  const token = String(result.stdout || "").trim();
  if (result.status !== 0 || !token || token.length > 512 || /\s/.test(token)) throw new Error("The VDS GitHub credential is unavailable; no restore state was created.");
  return token;
}

function githubGet(pathname, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let settled = false, deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    let request;
    try {
      request = https.request({ protocol: "https:", hostname: "api.github.com", port: 443, method: "GET", path: pathname, agent: false, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "mf885-vds-restore/1", Connection: "close" } }, response => {
        const chunks = [];
        let bytes = 0;
        response.on("data", chunk => {
          bytes += chunk.length;
          if (bytes > 65536) { response.destroy(); finish(new Error("GitHub readiness response exceeded the reviewed bound.")); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on("aborted", () => finish(new Error("GitHub readiness response was truncated.")));
        response.on("error", () => finish(new Error("GitHub readiness response failed.")));
        response.on("end", () => {
          let value = null;
          const body = Buffer.concat(chunks);
          try { value = JSON.parse(body.toString("utf8")); } catch (_) {}
          finish(null, Object.freeze({ statusCode: Number(response.statusCode) || null, contentType: String(response.headers["content-type"] || ""), value, bytes: body.length, sha256: core.sha256(body) }));
        });
      });
    } catch (_) { finish(new Error("GitHub readiness request could not be constructed.")); return; }
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("GitHub readiness request timed out."), { code: "ETIMEDOUT" })));
    request.on("error", () => finish(new Error("GitHub readiness request failed.")));
    deadline = setTimeout(() => request.destroy(Object.assign(new Error("GitHub readiness total deadline exceeded."), { code: "ETIMEDOUT" })), timeoutMs);
    request.end();
  });
}

async function verifyGithubReadiness(token, slotId = core.GOLDEN_SLOT_ID) {
  const spec = core.externalFenceSpec({ slotId, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  const repository = await githubGet(`/repos/${core.FENCE_REPOSITORY}`, token);
  if (repository.statusCode !== 200 || !repository.value || repository.value.full_name !== core.FENCE_REPOSITORY) throw new Error("GitHub repository readiness was not proven.");
  const commit = await githubGet(`/repos/${core.FENCE_REPOSITORY}/git/commits/${core.FENCE_TARGET_COMMIT}`, token);
  if (commit.statusCode !== 200 || !commit.value || commit.value.sha !== core.FENCE_TARGET_COMMIT) throw new Error("Pinned GitHub fence target commit was not proven.");
  const tagName = spec.ref.replace(/^refs\/tags\//, "");
  const existing = await githubGet(`/repos/${core.FENCE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tagName)}`, token);
  if (existing.statusCode !== 404) throw new Error("The permanent restore fence already exists or its absence could not be proven.");
  return Object.freeze({ repository: core.FENCE_REPOSITORY, targetCommit: core.FENCE_TARGET_COMMIT, ref: spec.ref, absentBeforeArm: true });
}

function verifyLegacyRetryPrerequisite() {
  const inspected = core.inspectTransaction(STATE_DIRECTORY);
  const gate = inspected.gate, last = inspected.last, fence = inspected.journal && core.readExternalFence(STATE_DIRECTORY, gate);
  if (
    gate.slotId !== core.GOLDEN_SLOT_ID || gate.recordSha256 !== core.V1_GATE_SHA256 || gate.externalFenceRef !== core.V1_EXTERNAL_FENCE_REF ||
    !last || last.recordSha256 !== core.V1_TERMINAL_RECORD_SHA256 || last.state !== core.STATES.UNKNOWN || last.reasonCode !== "RESTORE_HTTP_NOT_ACCEPTED" || last.revision !== 5 || last.firmwarePostsAttempted !== 1 ||
    inspected.disposition !== "TERMINAL_LOCKED" || inspected.postAllowed !== false || !inspected.armed ||
    !fence || fence.recordSha256 !== core.V1_EXTERNAL_FENCE_RECORD_SHA256 || fence.responseStatus !== 201 || fence.externalFenceRef !== core.V1_EXTERNAL_FENCE_REF
  ) throw new Error("The immutable first RestoreFw UNKNOWN transaction does not match the reviewed retry prerequisite.");
  const files = fs.readdirSync(STATE_DIRECTORY).sort();
  const snapshot = Object.freeze(files.map(name => {
    const file = path.join(STATE_DIRECTORY, name);
    const checked = safeFile(file);
    const bytes = fs.readFileSync(checked.path);
    return Object.freeze({ name, bytes: bytes.length, sha256: core.sha256(bytes) });
  }));
  return Object.freeze({ gateSha256: gate.recordSha256, terminalRecordSha256: last.recordSha256, externalFenceRef: gate.externalFenceRef, firmwarePostsAttempted: 1, state: last.state, snapshot });
}

function assertLegacySnapshotUnchanged(before) {
  const after = verifyLegacyRetryPrerequisite();
  if (!core.canonicalJson(before.snapshot).equals(core.canonicalJson(after.snapshot))) throw new Error("The immutable first RestoreFw transaction changed during retry preparation.");
  return after;
}

async function verifyGithubRetryReadiness(token) {
  const retry = await verifyGithubReadiness(token, core.GOLDEN_RETRY_SLOT_ID);
  const oldName = core.V1_EXTERNAL_FENCE_REF.replace(/^refs\/tags\//, "");
  const old = await githubGet(`/repos/${core.FENCE_REPOSITORY}/git/ref/tags/${encodeURIComponent(oldName)}`, token);
  if (old.statusCode !== 200 || !old.value || old.value.ref !== core.V1_EXTERNAL_FENCE_REF || !old.value.object || old.value.object.type !== "commit" || old.value.object.sha !== core.FENCE_TARGET_COMMIT) throw new Error("The immutable first RestoreFw GitHub fence is missing or changed.");
  return Object.freeze({ ...retry, predecessorRef: core.V1_EXTERNAL_FENCE_REF, predecessorPresent: true });
}

function safeTransactionStatus(directory = STATE_DIRECTORY) {
  if (!fs.existsSync(directory)) return Object.freeze({ exists: false, state: "NONE", disposition: "UNLOCKED_LOCAL_ONLY" });
  const inspected = core.inspectTransaction(directory);
  const last = inspected.last || null;
  const lastHttpEvidence = last ? Object.fromEntries(Object.entries({ httpStatus: last.httpStatus, responseContentType: last.responseContentType, responseServer: last.responseServer, responseBodySha256: last.responseBodySha256, responseBodyBytes: last.responseBodyBytes, networkCauseCode: last.networkCauseCode, wwwAuthenticatePresent: last.wwwAuthenticatePresent, locationPresent: last.locationPresent, setCookiePresent: last.setCookiePresent }).filter(([, value]) => value !== undefined && value !== null)) : {};
  return Object.freeze({ exists: true, slotId: inspected.gate.slotId, state: last && last.state || "NO_JOURNAL", reasonCode: last && last.reasonCode || null, disposition: inspected.disposition, revision: last && last.revision || 0, terminalRecordSha256: last && last.recordSha256 || null, gateSha256: inspected.gate.recordSha256, imageSha256: inspected.gate.imageSha256, bodySha256: inspected.gate.bodySha256, contractSha256: inspected.gate.contractSha256, externalFenceRef: inspected.gate.externalFenceRef, firmwarePostsAttempted: last && last.firmwarePostsAttempted || 0, allowanceConsumed: !!inspected.armed, postAllowed: false, ...(Object.keys(lastHttpEvidence).length ? { lastHttpEvidence: Object.freeze(lastHttpEvidence) } : {}) });
}

function receiptFromGate(gate) {
  return Object.freeze({ transactionId: gate.transactionId, ownerToken: gate.ownerToken, gateSha256: gate.recordSha256 });
}

function appendUnknownIfPossible(directory, receipt, reasonCode) {
  try {
    const journal = core.readJournal(directory);
    if (journal.last && !core.TERMINAL_STATES.includes(journal.last.state)) core.appendJournal(directory, receipt, core.STATES.UNKNOWN, { recordedAt: new Date().toISOString(), evidenceSha256: core.sha256(core.canonicalJson({ reasonCode })), reasonCode, firmwarePostsAttempted: journal.last.firmwarePostsAttempted });
  } catch (_) {}
}

function isNetworkUnavailability(error) {
  const cause = String(error && error.details && error.details.causeCode || error && error.code || "");
  return /^(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE)$/.test(cause);
}

async function monitorRestore(directory, receipt, baseline, options = {}) {
  const routerApi = options.routerApi || router;
  const sleep = typeof options.sleep === "function" ? options.sleep : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const statusMaxPolls = Number.isInteger(options.statusMaxPolls) ? options.statusMaxPolls : 120;
  const bootBoundaryMaxPolls = Number.isInteger(options.bootBoundaryMaxPolls) ? options.bootBoundaryMaxPolls : 60;
  const postbootMaxPolls = Number.isInteger(options.postbootMaxPolls) ? options.postbootMaxPolls : 90;
  const saveEvidence = typeof options.saveEvidence === "function" ? options.saveEvidence : writePrivateEvidence;
  if (statusMaxPolls < 1 || statusMaxPolls > 600 || bootBoundaryMaxPolls < 1 || bootBoundaryMaxPolls > 300 || postbootMaxPolls < 1 || postbootMaxPolls > 300) throw new Error("Restore monitor bounds are invalid.");
  let journal = core.readJournal(directory);
  if (!journal.last) throw new Error("Restore monitor has no journal.");
  if ([core.STATES.POST_ACCEPTED, core.STATES.RESTORING].includes(journal.last.state)) {
    let session = null;
    let observedSuccess = false, lastStatus = "", lastProgress = "", transportFailures = 0, consecutiveTransportFailures = 0, invalidStatuses = 0;
    for (let poll = 0; poll < statusMaxPolls; poll += 1) {
      if (poll) await sleep(1000);
      let current;
      try {
        if (!session) session = await routerApi.createFreshAppSession();
        current = await routerApi.sessionModelGet(session, "GetRestoreStatus", { direct: true, operation: "restore monitor" });
      } catch (error) {
        transportFailures += 1;
        const unavailable = isNetworkUnavailability(error);
        consecutiveTransportFailures = unavailable ? consecutiveTransportFailures + 1 : 0;
        session = null;
        // RestoreFw can reboot quickly enough that status=1 is never sampled.
        // Two consecutive failures after exact HTTP acceptance are retained as
        // the boot boundary; full identity/WebUI/SMS verification is still
        // mandatory after the router returns.
        if (consecutiveTransportFailures >= 2) {
          let rootUnavailable = false;
          try {
            await routerApi.routerGetOnce({ path: "/", timeoutMs: 2000, maxBytes: 2 * 1024 * 1024, localAddress: core.RESTORE_LOCAL_ADDRESS });
          } catch (rootError) {
            rootUnavailable = isNetworkUnavailability(rootError);
          }
          if (rootUnavailable) {
            const evidence = Object.freeze({ kind: "observed-router-unavailable-after-exact-restore-acceptance", observedAt: new Date().toISOString(), sourceAddress: core.RESTORE_LOCAL_ADDRESS, statusSuccessSampled: false, consecutiveTransportFailures, independentRootGetUnavailable: true });
            core.appendJournal(directory, receipt, core.STATES.REBOOT_WAIT, { recordedAt: evidence.observedAt, evidenceSha256: core.sha256(core.canonicalJson(evidence)), reasonCode: "ROUTER_BOOT_BOUNDARY", firmwarePostsAttempted: 1 });
            observedSuccess = true;
            break;
          }
          consecutiveTransportFailures = 0;
        }
        continue;
      }
      consecutiveTransportFailures = 0;
      const status = routerApi.parseRestoreStatus(current.text);
      if (status.status === "3") {
        core.appendJournal(directory, receipt, core.STATES.FAILED, { recordedAt: new Date().toISOString(), evidenceSha256: core.sha256(core.canonicalJson(status)), statusRaw: "3", progress: Number(status.progress) || 0, reasonCode: "ROUTER_RESTORE_FAILED", firmwarePostsAttempted: 1 });
        throw new Error("Router reported terminal RestoreFw failure.");
      }
      if (status.status === "2" && (status.status !== lastStatus || status.progress !== lastProgress)) core.appendJournal(directory, receipt, core.STATES.RESTORING, { recordedAt: new Date().toISOString(), evidenceSha256: core.sha256(core.canonicalJson(status)), statusRaw: "2", progress: Number(status.progress) || 0, firmwarePostsAttempted: 1 });
      if (status.status === "1") {
        core.appendJournal(directory, receipt, core.STATES.REBOOT_WAIT, { recordedAt: new Date().toISOString(), evidenceSha256: core.sha256(core.canonicalJson({ status, transportFailures, invalidStatuses })), statusRaw: "1", progress: Number(status.progress) || 100, reasonCode: "ROUTER_RESTORE_SUCCESS", firmwarePostsAttempted: 1 });
        observedSuccess = true;
        break;
      }
      if (!/^[02]$/.test(status.status) || !/^\d{1,3}$/.test(status.progress)) invalidStatuses += 1;
      lastStatus = status.status;
      lastProgress = status.progress;
    }
    if (!observedSuccess) { appendUnknownIfPossible(directory, receipt, "STATUS_SUCCESS_NOT_OBSERVED"); throw new Error("Restore status did not reach the captured success state before the poll limit."); }
  }

  journal = core.readJournal(directory);
  if (journal.last.state !== core.STATES.REBOOT_WAIT) throw new Error(`Restore monitor cannot continue from ${journal.last.state}.`);
  let bootBoundary = journal.records.find(record => record.state === core.STATES.REBOOT_WAIT && record.reasonCode === "ROUTER_BOOT_BOUNDARY") || null;
  if (!bootBoundary) {
    for (let poll = 0; poll < bootBoundaryMaxPolls; poll += 1) {
      if (poll) await sleep(1000);
      let unavailable = false;
      try {
        await routerApi.routerGetOnce({ path: "/", timeoutMs: 2000, maxBytes: 2 * 1024 * 1024, localAddress: core.RESTORE_LOCAL_ADDRESS });
      } catch (error) {
        unavailable = isNetworkUnavailability(error);
      }
      if (!unavailable) continue;
      const evidence = Object.freeze({ kind: "observed-router-unavailable-after-restore-success", observedAt: new Date().toISOString(), sourceAddress: core.RESTORE_LOCAL_ADDRESS });
      bootBoundary = core.appendJournal(directory, receipt, core.STATES.REBOOT_WAIT, { recordedAt: evidence.observedAt, evidenceSha256: core.sha256(core.canonicalJson(evidence)), reasonCode: "ROUTER_BOOT_BOUNDARY", firmwarePostsAttempted: 1 });
      break;
    }
  }
  if (!bootBoundary) { appendUnknownIfPossible(directory, receipt, "BOOT_BOUNDARY_NOT_OBSERVED"); throw new Error("Restore succeeded but an actual router reboot boundary was not observed before the limit."); }

  let postboot = null;
  for (let poll = 0; poll < postbootMaxPolls; poll += 1) {
    if (poll) await sleep(2000);
    try {
      const session = await routerApi.createFreshAppSession();
      const statusRead = await routerApi.sessionModelGet(session, "status1", { operation: "postboot status1" });
      const identity = routerApi.identityFromStatus(statusRead.text);
      const operator = routerApi.firstText(statusRead.text, ["network_name", "ISP_name", "operator"]);
      if (identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256 || identity.rawModel !== routerApi.EXACT_MODEL || identity.hardware !== routerApi.EXACT_HARDWARE || identity.firmware !== routerApi.EXACT_FIRMWARE) continue;
      if (baseline && baseline.operator && operator !== baseline.operator) continue;
      const web = await routerApi.routerGetOnce({ path: "/", timeoutMs: 10000, maxBytes: 2 * 1024 * 1024, localAddress: session.localAddress });
      if (web.statusCode !== 200 || web.redirected || !/<html\b/i.test(web.body.toString("utf8"))) continue;
      const final = await routerApi.collectRestorePreflight();
      postboot = Object.freeze({ bootBoundary: Object.freeze({ kind: "observed-router-unavailable-after-restore-success", observedAt: bootBoundary.recordedAt, evidenceSha256: bootBoundary.evidenceSha256 }), identity: final.report.identity, power: final.report.power, restoreStatus: final.report.restoreStatus, upgradeStatus: final.report.upgradeStatus, networkBaseline: final.report.networkBaseline, webUi: Object.freeze({ statusCode: 200, bytes: web.body.length }), smsReadPassed: final.report.session.standardDigestSmsReadPassed === true, safety: final.report.safety });
      break;
    } catch (_) {}
  }
  if (!postboot) { appendUnknownIfPossible(directory, receipt, "POSTBOOT_NOT_VERIFIED"); throw new Error("Router returned no complete exact postboot verification before the limit."); }
  const evidenceSha256 = core.sha256(core.canonicalJson(postboot));
  core.appendJournal(directory, receipt, core.STATES.BOOT_VERIFIED, { recordedAt: new Date().toISOString(), evidenceSha256, firmwarePostsAttempted: 1 });
  const saved = saveEvidence("restore-postboot", postboot);
  return Object.freeze({ state: core.STATES.BOOT_VERIFIED, evidenceSha256, evidenceFile: path.basename(saved.file), firmwarePostsAttempted: 1, smsReadPassed: true, webUiPassed: true });
}

async function observeUnknownAfterDispatch(options = {}) {
  const routerApi = options.routerApi || router;
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const maxPolls = Number(options.maxPolls === undefined ? 120 : options.maxPolls);
  const intervalMs = Number(options.intervalMs === undefined ? 1000 : options.intervalMs);
  const directory = options.directory || RETRY_STATE_DIRECTORY;
  if (!Number.isInteger(maxPolls) || maxPolls < 1 || maxPolls > 300 || !Number.isInteger(intervalMs) || intervalMs < 0 || intervalMs > 5000) throw new Error("Retry GET-only observation bounds are invalid.");
  const transaction = core.inspectTransaction(directory);
  if (transaction.gate.slotId !== core.GOLDEN_RETRY_SLOT_ID || !transaction.last || transaction.last.state !== core.STATES.UNKNOWN || transaction.last.firmwarePostsAttempted !== 1 || transaction.disposition !== "TERMINAL_LOCKED") {
    throw new Error("GET-only retry observation requires the exact terminal retry-v2 UNKNOWN transaction.");
  }
  const observations = [];
  let session = null, previousKey = "", sawOffline = false, sawActive = false, sawSuccess = false, sawFailure = false;
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const item = { poll, observedAt: new Date().toISOString() };
    try {
      if (!session) session = await routerApi.createFreshAppSession();
      const statusRead = await routerApi.sessionModelGet(session, "GetRestoreStatus", { direct: true, operation: "retry UNKNOWN GET-only observation", timeoutMs: 5000 });
      item.online = true;
      item.restoreStatus = routerApi.parseRestoreStatus(statusRead.text);
      if (item.restoreStatus.status === "2") sawActive = true;
      if (item.restoreStatus.status === "1") sawSuccess = true;
      if (item.restoreStatus.status === "3") sawFailure = true;
      if (poll % 10 === 0) {
        const identityRead = await routerApi.sessionModelGet(session, "status1", { operation: "retry UNKNOWN identity observation", timeoutMs: 5000 });
        const identity = routerApi.identityFromStatus(identityRead.text);
        if (identity.unitFingerprintSha256 !== core.RESTORE_UNIT_FINGERPRINT_SHA256 || identity.rawModel !== routerApi.EXACT_MODEL || identity.hardware !== routerApi.EXACT_HARDWARE || identity.firmware !== routerApi.EXACT_FIRMWARE) {
          throw Object.assign(new Error("Retry observer reached a different router identity."), { code: "ROUTER_IDENTITY_CHANGED" });
        }
        item.identity = { rawModel: identity.rawModel, hardware: identity.hardware, firmware: identity.firmware, unitFingerprintSha256: identity.unitFingerprintSha256 };
      }
    } catch (error) {
      if (error && error.code === "ROUTER_IDENTITY_CHANGED") throw error;
      item.online = false;
      item.errorCode = String(error && error.code || "ROUTER_GET_FAILED");
      session = null;
      sawOffline = true;
    }
    const key = core.sha256(core.canonicalJson({ online: item.online, restoreStatus: item.restoreStatus || null, identity: item.identity || null, errorCode: item.errorCode || null }));
    if (key !== previousKey || poll % 10 === 0) observations.push(Object.freeze(item));
    previousKey = key;
    if (poll + 1 < maxPolls) await sleep(intervalMs);
  }
  const result = Object.freeze({ schema: "mf885-restore-unknown-observation/v2", generatedAt: new Date().toISOString(), methodsUsed: Object.freeze(["GET"]), maxPolls, intervalMs, sawOffline, sawActive, sawSuccess, sawFailure, observations: Object.freeze(observations), firmwarePostsAttemptedByObserver: 0, explicitRebootAttempted: false, shutdownAttempted: false });
  const saved = writePrivateEvidence("restore-retry-v2-unknown-observation", result);
  return Object.freeze({ evidenceFile: path.basename(saved.file), evidenceSha256: saved.sha256, sawOffline, sawActive, sawSuccess, sawFailure, polls: maxPolls });
}

function loadBoundPreflightEvidence(gate) {
  const candidates = fs.readdirSync(PRIVATE_DIRECTORY).filter(name => /^restore-(?:retry-v2-)?preflight-\d{8}T\d{6}Z\.json$/.test(name)).sort().reverse();
  for (const name of candidates) {
    const file = path.join(PRIVATE_DIRECTORY, name);
    const bytes = fs.readFileSync(file);
    if (core.sha256(bytes) === gate.preflightEvidenceSha256) return JSON.parse(bytes.toString("utf8"));
  }
  throw new Error("The private preflight evidence bound to this transaction is missing.");
}

async function runPreflight(options = {}) {
  const capsule = router.buildGoldenRestoreCapsule(options.imagePath || CAPTURE_A);
  const live = await router.collectRestorePreflight();
  const plan = core.validateRestoreRequestPlan(restoreRequestInput(live, capsule), capsule.body);
  return Object.freeze({ mode: "preflight", image: capsule.image, multipart: capsule.contract.multipart, contractSha256: capsule.contractSha256, router: live.report, requestPlan: Object.freeze({ validated: true, host: plan.host, port: plan.port, path: plan.path, localAddress: plan.localAddress, sessionProfile: plan.sessionProfile, bodyBytes: plan.contentLength, bodySha256: plan.bodySha256, digestProofInternallyValid: true, serverCookieReceived: plan.serverCookieReceived }), localState: safeTransactionStatus(), firmwarePostsAttempted: 0, flashExecuted: false });
}

function restoreRequestInput(live, capsule) {
  return { host: live.session.host, port: live.session.port, path: core.RESTORE_ROUTE, boundary: capsule.boundary, bodySha256: capsule.bodySha256, timeoutMs: 120000, localAddress: live.session.localAddress, sessionProfile: live.report.session.profile, sessionProvenAtMs: live.sessionProvenAtMs, maxSessionAgeMs: 15000, sessionCookie: live.session.cookie, serverCookieReceived: live.session.serverCookieReceived, sessionAuthorization: live.session.restoreAuthorization };
}

async function runReadiness() {
  const backups = verifyBackupPair();
  const settings = verifySettingsEvidence();
  const capsule = router.buildGoldenRestoreCapsule(CAPTURE_A);
  const github = await verifyGithubReadiness(loadGithubToken());
  return Object.freeze({ mode: "readiness", backups, settings, multipart: capsule.contract.multipart, contractSha256: capsule.contractSha256, github, localState: safeTransactionStatus(), firmwarePostsAttempted: 0, flashExecuted: false });
}

function retryStatusBundle() {
  const first = safeTransactionStatus(STATE_DIRECTORY);
  const retry = safeTransactionStatus(RETRY_STATE_DIRECTORY);
  return Object.freeze({
    first,
    retry,
    totalRestorePostsAttempted: Number(first.firmwarePostsAttempted || 0) + Number(retry.firmwarePostsAttempted || 0),
    anyPostAllowed: false
  });
}

function safeRequestPlan(plan) {
  return Object.freeze({
    validated: true,
    host: plan.host,
    port: plan.port,
    path: plan.path,
    localAddress: plan.localAddress,
    sessionProfile: plan.sessionProfile,
    bodyBytes: plan.contentLength,
    bodySha256: plan.bodySha256,
    digestProofInternallyValid: true,
    serverCookieReceived: plan.serverCookieReceived
  });
}

function safeDispatchResult(dispatched) {
  if (!dispatched || typeof dispatched !== "object") return null;
  const response = dispatched.response && typeof dispatched.response === "object"
    ? Object.fromEntries(Object.entries(dispatched.response).filter(([key]) => key !== "responseBodyBase64"))
    : null;
  return Object.freeze({
    state: dispatched.state,
    firmwarePostsAttempted: dispatched.firmwarePostsAttempted,
    allowanceConsumed: dispatched.allowanceConsumed,
    ...(response ? { response: Object.freeze(response) } : {})
  });
}

async function runRetryReadiness() {
  if (fs.existsSync(RETRY_STATE_DIRECTORY)) throw new Error("The permanent retry-v2 restore slot already exists; another firmware POST is forbidden.");
  const predecessor = verifyLegacyRetryPrerequisite();
  const backups = verifyBackupPair();
  const settings = verifySettingsEvidence();
  const capsule = router.buildGoldenRestoreCapsule(CAPTURE_A, { retryV2: true });
  const github = await verifyGithubRetryReadiness(loadGithubToken());
  assertLegacySnapshotUnchanged(predecessor);
  return Object.freeze({
    mode: "retry-v2-readiness",
    predecessor: Object.freeze({ gateSha256: predecessor.gateSha256, terminalRecordSha256: predecessor.terminalRecordSha256, externalFenceRef: predecessor.externalFenceRef, state: predecessor.state, firmwarePostsAttempted: predecessor.firmwarePostsAttempted, immutable: true }),
    backups,
    settings,
    multipart: capsule.contract.multipart,
    contractSha256: capsule.contractSha256,
    github,
    localState: safeTransactionStatus(RETRY_STATE_DIRECTORY),
    totalRestorePostsAttempted: 1,
    firmwarePostsAttempted: 0,
    flashExecuted: false
  });
}

async function runRetryPreflight() {
  if (fs.existsSync(RETRY_STATE_DIRECTORY)) throw new Error("The permanent retry-v2 restore slot already exists; preflight cannot authorize another attempt.");
  const predecessor = verifyLegacyRetryPrerequisite();
  const backups = verifyBackupPair();
  const settings = verifySettingsEvidence();
  const capsule = router.buildGoldenRestoreCapsule(CAPTURE_A, { retryV2: true });
  const github = await verifyGithubRetryReadiness(loadGithubToken());
  assertLegacySnapshotUnchanged(predecessor);
  const live = await router.collectRestoreRetryPreflight();
  const plan = core.validateRestoreRequestPlan(restoreRequestInput(live, capsule), capsule.body);
  assertLegacySnapshotUnchanged(predecessor);
  if (fs.existsSync(RETRY_STATE_DIRECTORY)) throw new Error("The retry-v2 slot appeared during preflight; execution is locked.");
  return Object.freeze({
    mode: "retry-v2-preflight",
    image: capsule.image,
    multipart: capsule.contract.multipart,
    contractSha256: capsule.contractSha256,
    predecessor: Object.freeze({ gateSha256: predecessor.gateSha256, terminalRecordSha256: predecessor.terminalRecordSha256, externalFenceRef: predecessor.externalFenceRef, immutable: true }),
    backups,
    settings,
    github,
    router: live.report,
    requestPlan: safeRequestPlan(plan),
    localState: safeTransactionStatus(RETRY_STATE_DIRECTORY),
    totalRestorePostsAttempted: 1,
    firmwarePostsAttempted: 0,
    flashExecuted: false
  });
}

function acceptedResponseCapture(dispatched) {
  const response = dispatched && dispatched.response || {};
  const state = safeTransactionStatus(RETRY_STATE_DIRECTORY);
  return writePrivateRestoreResponse({
    code: "RESTORE_HTTP_ACCEPTED",
    details: {
      statusCode: response.statusCode,
      contentType: response.contentType,
      server: response.server,
      bodyBytes: response.bodyBytes,
      bodySha256: response.bodySha256,
      responseBodyBase64: response.responseBodyBase64,
      responseComplete: response.responseComplete,
      wwwAuthenticatePresent: response.wwwAuthenticatePresent,
      locationPresent: response.locationPresent,
      setCookiePresent: response.setCookiePresent
    }
  }, "restore-retry-v2-http-response", { slotId: state.slotId, gateSha256: state.gateSha256, journalRecordSha256: state.terminalRecordSha256 });
}

async function diagnoseRetryFailure(error, predecessor) {
  let state;
  try { state = safeTransactionStatus(RETRY_STATE_DIRECTORY); }
  catch (_) { state = Object.freeze({ exists: fs.existsSync(RETRY_STATE_DIRECTORY), disposition: "LOCKED_UNREADABLE" }); }
  const attempted = state && state.firmwarePostsAttempted === 1;
  let responseCapture = null, responseCaptureError = null, observation = null, observationError = null;
  if (attempted && error && error.details && typeof error.details.responseBodyBase64 === "string") {
    try {
      const saved = writePrivateRestoreResponse(error, "restore-retry-v2-http-response", { slotId: state.slotId, gateSha256: state.gateSha256, journalRecordSha256: state.terminalRecordSha256 });
      responseCapture = saved && Object.freeze({ bodyFile: path.basename(saved.bodyFile), metadataFile: path.basename(saved.metadataFile), bodyBytes: saved.bodyBytes, bodySha256: saved.bodySha256, metadataSha256: saved.metadataSha256 });
    } catch (captureError) {
      responseCaptureError = String(captureError && captureError.code || "PRIVATE_RESPONSE_CAPTURE_FAILED");
    }
  }
  if (attempted) {
    try { observation = await observeUnknownAfterDispatch(); }
    catch (observerError) { observationError = String(observerError && observerError.code || "GET_ONLY_OBSERVATION_FAILED"); }
  }
  let predecessorUnchanged = false;
  try { assertLegacySnapshotUnchanged(predecessor); predecessorUnchanged = true; } catch (_) {}
  error.retryDiagnostics = Object.freeze({
    responseCapture,
    responseCaptureError,
    observation,
    observationError,
    predecessorUnchanged,
    retryState: state,
    totalRestorePostsAttempted: 1 + Number(state && state.firmwarePostsAttempted || 0),
    anotherRetryAllowed: false
  });
  return error;
}

async function executeGoldenRetryV2() {
  if (!process.argv.includes(`--confirm=${RETRY_EXECUTE_CONFIRMATION}`)) throw new Error(`Execution requires the exact --confirm=${RETRY_EXECUTE_CONFIRMATION} argument.`);
  if (fs.existsSync(RETRY_STATE_DIRECTORY)) throw new Error("The permanent retry-v2 restore slot already exists; replay is forbidden.");
  const predecessor = verifyLegacyRetryPrerequisite();
  const pair = verifyBackupPair();
  const settings = verifySettingsEvidence();
  const capsule = router.buildGoldenRestoreCapsule(CAPTURE_A, { retryV2: true });
  const githubToken = loadGithubToken();
  const github = await verifyGithubRetryReadiness(githubToken);
  assertLegacySnapshotUnchanged(predecessor);

  // The final APP session is deliberately created last. From the moment its
  // nc=4 RestoreFw proof is reserved, only local durable writes, the unique
  // GitHub fence and the single core-owned router POST are permitted.
  const live = await router.collectRestoreRetryPreflight();
  const plan = core.validateRestoreRequestPlan(restoreRequestInput(live, capsule), capsule.body);
  const evidence = Object.freeze({
    schema: "mf885-vds-golden-retry-preflight/v2",
    generatedAt: new Date().toISOString(),
    slotId: core.GOLDEN_RETRY_SLOT_ID,
    predecessor: Object.freeze({ gateSha256: predecessor.gateSha256, terminalRecordSha256: predecessor.terminalRecordSha256, externalFenceRef: predecessor.externalFenceRef, state: predecessor.state, firmwarePostsAttempted: predecessor.firmwarePostsAttempted }),
    unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256,
    image: capsule.image,
    multipart: capsule.contract.multipart,
    contractSha256: capsule.contractSha256,
    backups: pair,
    settings,
    github,
    routerPreflight: live.report,
    requestPlan: safeRequestPlan(plan),
    riskAcceptance: Object.freeze({ physicalRecoveryAvailable: false, softwareOnlyRiskAccepted: true, maximumFailureMode: "device-brick", authorization: "explicit-operator-thread-retry-v2" }),
    safety: Object.freeze({ automaticRetries: 0, routerPostAllowance: 1, totalLifetimeRestorePostLimit: 2, shutdownAttempted: false })
  });
  const savedEvidence = writePrivateEvidence("restore-retry-v2-preflight", evidence);
  assertLegacySnapshotUnchanged(predecessor);
  if (fs.existsSync(RETRY_STATE_DIRECTORY)) throw new Error("The retry-v2 slot appeared before gate creation; execution is locked.");
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const input = core.createGateInput({ slotId: core.GOLDEN_RETRY_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256, bodySha256: capsule.bodySha256, contractSha256: capsule.contractSha256, preflightEvidenceSha256: savedEvidence.sha256, bootId });
  const acquired = core.acquirePermanentGate(RETRY_STATE_DIRECTORY, input);
  if (!acquired.acquired) throw new Error("The permanent retry-v2 gate could not be acquired.");
  const receipt = receiptFromGate(acquired.gate);
  core.appendJournal(RETRY_STATE_DIRECTORY, receipt, core.STATES.PRECHECK_OK, { recordedAt: new Date().toISOString(), evidenceSha256: savedEvidence.sha256 });

  let dispatched;
  try {
    dispatched = await core.dispatchRestoreAtMostOnce({ directory: RETRY_STATE_DIRECTORY, receipt, body: capsule.body, githubToken, fenceTimeoutMs: core.DEFAULT_FENCE_TIMEOUT_MS, request: restoreRequestInput(live, capsule) });
  } catch (error) {
    throw await diagnoseRetryFailure(error, predecessor);
  }

  let responseCapture;
  try {
    const saved = acceptedResponseCapture(dispatched);
    responseCapture = Object.freeze({ bodyFile: path.basename(saved.bodyFile), metadataFile: path.basename(saved.metadataFile), bodyBytes: saved.bodyBytes, bodySha256: saved.bodySha256, metadataSha256: saved.metadataSha256 });
  } catch (captureError) {
    appendUnknownIfPossible(RETRY_STATE_DIRECTORY, receipt, "PRIVATE_RESPONSE_CAPTURE_FAILED");
    captureError.code = "PRIVATE_RESPONSE_CAPTURE_FAILED";
    captureError.details = Object.freeze({ attempted: true });
    throw await diagnoseRetryFailure(captureError, predecessor);
  }

  let monitored;
  try { monitored = await monitorRestore(RETRY_STATE_DIRECTORY, receipt, live.report.networkBaseline); }
  catch (error) { throw await diagnoseRetryFailure(error, predecessor); }
  assertLegacySnapshotUnchanged(predecessor);
  return Object.freeze({
    mode: "retry-v2-executed",
    dispatched: safeDispatchResult(dispatched),
    responseCapture,
    monitored,
    localState: safeTransactionStatus(RETRY_STATE_DIRECTORY),
    predecessorUnchanged: true,
    totalRestorePostsAttempted: 2,
    anotherRetryAllowed: false,
    preflightEvidenceFile: path.basename(savedEvidence.file)
  });
}

async function executeGolden() {
  if (!process.argv.includes(`--confirm=${EXECUTE_CONFIRMATION}`)) throw new Error(`Execution requires the exact --confirm=${EXECUTE_CONFIRMATION} argument.`);
  if (fs.existsSync(STATE_DIRECTORY)) throw new Error("The permanent local restore slot already exists; replay is forbidden.");
  const pair = verifyBackupPair();
  const settings = verifySettingsEvidence();
  const capsule = router.buildGoldenRestoreCapsule(CAPTURE_A);
  const githubToken = loadGithubToken();
  const github = await verifyGithubReadiness(githubToken);
  const live = await router.collectRestorePreflight();
  const evidence = Object.freeze({ schema: "mf885-vds-golden-preflight/v1", generatedAt: new Date().toISOString(), slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, image: capsule.image, multipart: capsule.contract.multipart, contractSha256: capsule.contractSha256, backups: pair, settings, github, routerPreflight: live.report, riskAcceptance: Object.freeze({ physicalRecoveryAvailable: false, softwareOnlyRiskAccepted: true, maximumFailureMode: "device-brick", authorization: "explicit-operator-thread" }), safety: Object.freeze({ automaticRetries: 0, routerPostAllowance: 1, shutdownAttempted: false }) });
  const savedEvidence = writePrivateEvidence("restore-preflight", evidence);
  const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const input = core.createGateInput({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256, bodySha256: capsule.bodySha256, contractSha256: capsule.contractSha256, preflightEvidenceSha256: savedEvidence.sha256, bootId });
  const acquired = core.acquirePermanentGate(STATE_DIRECTORY, input);
  if (!acquired.acquired) throw new Error("The permanent local restore gate could not be acquired.");
  const receipt = receiptFromGate(acquired.gate);
  core.appendJournal(STATE_DIRECTORY, receipt, core.STATES.PRECHECK_OK, { recordedAt: new Date().toISOString(), evidenceSha256: savedEvidence.sha256 });
  const dispatched = await core.dispatchRestoreAtMostOnce({ directory: STATE_DIRECTORY, receipt, body: capsule.body, githubToken, fenceTimeoutMs: core.DEFAULT_FENCE_TIMEOUT_MS, request: restoreRequestInput(live, capsule) });
  const monitored = await monitorRestore(STATE_DIRECTORY, receipt, live.report.networkBaseline);
  return Object.freeze({ dispatched, monitored, localState: safeTransactionStatus(), preflightEvidenceFile: path.basename(savedEvidence.file) });
}

async function resumeMonitorAt(directory) {
  const inspected = core.inspectTransaction(directory);
  if (![core.STATES.POST_ACCEPTED, core.STATES.RESTORING, core.STATES.REBOOT_WAIT].includes(inspected.last && inspected.last.state)) throw new Error("This transaction is not eligible for GET-only monitoring.");
  const evidence = loadBoundPreflightEvidence(inspected.gate);
  return monitorRestore(directory, receiptFromGate(inspected.gate), evidence.routerPreflight && evidence.routerPreflight.networkBaseline || null);
}

async function resumeMonitor() { return resumeMonitorAt(STATE_DIRECTORY); }
async function resumeRetryMonitor() { return resumeMonitorAt(RETRY_STATE_DIRECTORY); }

async function main() {
  const command = process.argv[2] || "status";
  let result;
  if (command === "status") result = safeTransactionStatus();
  else if (command === "status-all") result = retryStatusBundle();
  else if (command === "retry-status") result = safeTransactionStatus(RETRY_STATE_DIRECTORY);
  else if (command === "preflight") result = await runPreflight();
  else if (command === "readiness") result = await runReadiness();
  else if (command === "retry-preflight") result = await runRetryPreflight();
  else if (command === "retry-readiness") result = await runRetryReadiness();
  else if (command === "capture-backup-a") result = await captureBackup("a");
  else if (command === "capture-backup-b") result = await captureBackup("b");
  else if (command === "capture-settings") result = await captureSettings();
  else if (command === "execute-golden") result = await executeGolden();
  else if (command === "execute-golden-retry-v2") result = await executeGoldenRetryV2();
  else if (command === "monitor") result = await resumeMonitor();
  else if (command === "retry-monitor") result = await resumeRetryMonitor();
  else if (command === "retry-observe") result = await observeUnknownAfterDispatch();
  else throw new Error("Usage: mf885_vds_restore.js status|status-all|retry-status|preflight|readiness|retry-preflight|retry-readiness|capture-backup-a|capture-backup-b|capture-settings|execute-golden|execute-golden-retry-v2|monitor|retry-monitor|retry-observe");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main().catch(error => {
  const httpEvidence = core.safeRestoreHttpEvidence(error);
  const retryCommand = /retry-v2|^retry-/.test(String(process.argv[2] || ""));
  const selectedDirectory = retryCommand ? RETRY_STATE_DIRECTORY : STATE_DIRECTORY;
  process.stderr.write(`${JSON.stringify({ ok: false, code: error && error.code || "MF885_RESTORE_FAILED", message: String(error && error.message || error), ...(Object.keys(httpEvidence).length ? { httpEvidence } : {}), ...(error && error.retryDiagnostics ? { retryDiagnostics: error.retryDiagnostics } : {}), localState: (() => { try { return safeTransactionStatus(selectedDirectory); } catch (_) { return { exists: fs.existsSync(selectedDirectory), disposition: "LOCKED_UNREADABLE" }; } })(), ...(retryCommand ? { immutablePredecessorState: (() => { try { return safeTransactionStatus(STATE_DIRECTORY); } catch (_) { return { exists: fs.existsSync(STATE_DIRECTORY), disposition: "LOCKED_UNREADABLE" }; } })() } : {}) }, null, 2)}\n`);
  process.exitCode = 1;
});

module.exports = { PRIVATE_DIRECTORY, STATE_DIRECTORY, RETRY_STATE_DIRECTORY, CAPTURE_A, CAPTURE_B, SETTINGS_EVIDENCE, EXECUTE_CONFIRMATION, RETRY_EXECUTE_CONFIRMATION, captureBackup, captureSettings, validateCaptureReport, verifyBackupPair, verifySettingsEvidence, verifyGithubReadiness, verifyGithubRetryReadiness, verifyLegacyRetryPrerequisite, assertLegacySnapshotUnchanged, safeTransactionStatus, retryStatusBundle, writePrivateRestoreResponse, runPreflight, runReadiness, runRetryPreflight, runRetryReadiness, executeGoldenRetryV2, monitorRestore, observeUnknownAfterDispatch, resumeRetryMonitor };
