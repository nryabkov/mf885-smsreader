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
const CAPTURE_A = path.join(PRIVATE_DIRECTORY, "MF885_golden_capture_a.bin");
const CAPTURE_B = path.join(PRIVATE_DIRECTORY, "MF885_golden_capture_b.bin");
const SETTINGS_EVIDENCE = path.join(PRIVATE_DIRECTORY, "MF885_private_settings_current.json");
const EXECUTE_CONFIRMATION = "FLASH-GOLDEN-2b5880fc";

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

async function verifyGithubReadiness(token) {
  const spec = core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  const repository = await githubGet(`/repos/${core.FENCE_REPOSITORY}`, token);
  if (repository.statusCode !== 200 || !repository.value || repository.value.full_name !== core.FENCE_REPOSITORY) throw new Error("GitHub repository readiness was not proven.");
  const commit = await githubGet(`/repos/${core.FENCE_REPOSITORY}/git/commits/${core.FENCE_TARGET_COMMIT}`, token);
  if (commit.statusCode !== 200 || !commit.value || commit.value.sha !== core.FENCE_TARGET_COMMIT) throw new Error("Pinned GitHub fence target commit was not proven.");
  const tagName = spec.ref.replace(/^refs\/tags\//, "");
  const existing = await githubGet(`/repos/${core.FENCE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tagName)}`, token);
  if (existing.statusCode !== 404) throw new Error("The permanent restore fence already exists or its absence could not be proven.");
  return Object.freeze({ repository: core.FENCE_REPOSITORY, targetCommit: core.FENCE_TARGET_COMMIT, ref: spec.ref, absentBeforeArm: true });
}

function safeTransactionStatus() {
  if (!fs.existsSync(STATE_DIRECTORY)) return Object.freeze({ exists: false, state: "NONE", disposition: "UNLOCKED_LOCAL_ONLY" });
  const inspected = core.inspectTransaction(STATE_DIRECTORY);
  return Object.freeze({ exists: true, state: inspected.last && inspected.last.state || "NO_JOURNAL", disposition: inspected.disposition, revision: inspected.last && inspected.last.revision || 0, imageSha256: inspected.gate.imageSha256, bodySha256: inspected.gate.bodySha256, contractSha256: inspected.gate.contractSha256, externalFenceRef: inspected.gate.externalFenceRef, firmwarePostsAttempted: inspected.last && inspected.last.firmwarePostsAttempted || 0, allowanceConsumed: !!inspected.armed, postAllowed: false });
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
    let observedSuccess = false, lastStatus = "", lastProgress = "", transportFailures = 0, invalidStatuses = 0;
    for (let poll = 0; poll < statusMaxPolls; poll += 1) {
      if (poll) await sleep(1000);
      let current;
      try {
        if (!session) session = await routerApi.createFreshAppSession();
        current = await routerApi.sessionModelGet(session, "GetRestoreStatus", { direct: true, operation: "restore monitor" });
      } catch (_) {
        transportFailures += 1;
        session = null;
        continue;
      }
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
        const check = await routerApi.routerGetOnce({ path: "/", timeoutMs: 2000, maxBytes: 2 * 1024 * 1024, localAddress: core.RESTORE_LOCAL_ADDRESS });
        unavailable = check.statusCode !== 200 || check.redirected;
      } catch (_) {
        unavailable = true;
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

function loadBoundPreflightEvidence(gate) {
  const candidates = fs.readdirSync(PRIVATE_DIRECTORY).filter(name => /^restore-preflight-\d{8}T\d{6}Z\.json$/.test(name)).sort().reverse();
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

async function resumeMonitor() {
  const inspected = core.inspectTransaction(STATE_DIRECTORY);
  if (![core.STATES.POST_ACCEPTED, core.STATES.RESTORING, core.STATES.REBOOT_WAIT].includes(inspected.last && inspected.last.state)) throw new Error("This transaction is not eligible for GET-only monitoring.");
  const evidence = loadBoundPreflightEvidence(inspected.gate);
  return monitorRestore(STATE_DIRECTORY, receiptFromGate(inspected.gate), evidence.routerPreflight && evidence.routerPreflight.networkBaseline || null);
}

async function main() {
  const command = process.argv[2] || "status";
  let result;
  if (command === "status") result = safeTransactionStatus();
  else if (command === "preflight") result = await runPreflight();
  else if (command === "readiness") result = await runReadiness();
  else if (command === "capture-backup-a") result = await captureBackup("a");
  else if (command === "capture-backup-b") result = await captureBackup("b");
  else if (command === "capture-settings") result = await captureSettings();
  else if (command === "execute-golden") result = await executeGolden();
  else if (command === "monitor") result = await resumeMonitor();
  else throw new Error("Usage: mf885_vds_restore.js status|preflight|readiness|capture-backup-a|capture-backup-b|capture-settings|execute-golden|monitor");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main().catch(error => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error && error.code || "MF885_RESTORE_FAILED", message: String(error && error.message || error), localState: (() => { try { return safeTransactionStatus(); } catch (_) { return { exists: fs.existsSync(STATE_DIRECTORY), disposition: "LOCKED_UNREADABLE" }; } })() }, null, 2)}\n`);
  process.exitCode = 1;
});

module.exports = { PRIVATE_DIRECTORY, STATE_DIRECTORY, CAPTURE_A, CAPTURE_B, SETTINGS_EVIDENCE, EXECUTE_CONFIRMATION, captureBackup, captureSettings, validateCaptureReport, verifyBackupPair, verifySettingsEvidence, verifyGithubReadiness, safeTransactionStatus, runPreflight, runReadiness, monitorRestore };
