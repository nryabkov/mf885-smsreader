"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const core = require("../tools/mf885_vds_restore_core.js");
const router = require("../tools/mf885_vds_router.js");
const restoreCli = require("../tools/mf885_vds_restore.js");

const FIXED_TIME = "2026-08-21T12:00:00.000Z";
const FIXED_BOOT_ID = "639e3eea-1ec2-4a65-bd19-9006cc03fea5";
const EXTERNAL_FENCE_SHA = "f".repeat(64);
const GOLDEN_FIXTURE_PATH = process.env.MF885_GOLDEN_FIXTURE || path.resolve(__dirname, "../.runtime/private/MF885_golden_capture_a.bin");
const SETTINGS_FIXTURE_PATH = process.env.MF885_SETTINGS_FIXTURE || path.resolve(__dirname, "../.runtime/private/MF885_private_settings_current.json");
const HAS_GOLDEN_FIXTURE = (() => {
  try {
    const stat = fs.lstatSync(GOLDEN_FIXTURE_PATH);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === router.GOLDEN_BYTES;
  } catch (_) { return false; }
})();
const HAS_SETTINGS_FIXTURE = (() => {
  try {
    const stat = fs.lstatSync(SETTINGS_FIXTURE_PATH);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o600 && stat.size > 0;
  } catch (_) { return false; }
})();

function temporaryState(prefix = "mf885-restore-") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(directory, 0o700);
  return directory;
}

function gateFixture(directory, overrides = {}) {
  const input = core.createGateInput({
    slotId: core.GOLDEN_SLOT_ID,
    unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256,
    imageSha256: core.GOLDEN_IMAGE_SHA256,
    bodySha256: core.GOLDEN_BODY_SHA256,
    contractSha256: "3".repeat(64),
    preflightEvidenceSha256: "4".repeat(64),
    bootId: FIXED_BOOT_ID,
    createdAt: FIXED_TIME,
    ...overrides
  });
  const acquired = core.acquirePermanentGate(directory, input);
  assert.equal(acquired.acquired, true);
  const receipt = { transactionId: acquired.gate.transactionId, ownerToken: acquired.gate.ownerToken, gateSha256: acquired.gateSha256 };
  core.appendJournal(directory, receipt, core.STATES.PRECHECK_OK, { recordedAt: FIXED_TIME, evidenceSha256: input.preflightEvidenceSha256 });
  return { directory, input, acquired, receipt };
}

function exactAuthorization(nc = "00000004", client = "") {
  const realm = "router", nonce = "nonce", cnonce = "b".repeat(16);
  const md5 = value => crypto.createHash("md5").update(value, "utf8").digest("hex");
  const response = md5(`${md5(`admin:${realm}:zimifi`)}:${nonce}:${nc}:${cnonce}:auth:${md5("POST:/cgi/xml_action.cgi")}`);
  return `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="/cgi/xml_action.cgi", response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}"${client ? `, client=${client}` : ""}`;
}

function requestFixture(body, overrides = {}) {
  return {
    host: core.RESTORE_HOST,
    port: core.RESTORE_PORT,
    path: core.RESTORE_ROUTE,
    boundary: core.GOLDEN_BOUNDARY,
    bodySha256: core.sha256(body),
    timeoutMs: 5000,
    localAddress: core.RESTORE_LOCAL_ADDRESS,
    sessionProfile: "fresh-web-digest-sms-read-next-post-no-server-cookie-v1",
    sessionProvenAtMs: Date.now(),
    maxSessionAgeMs: 15000,
    sessionCookie: "locale=en; hard_ver=Ver.D; platform=mifi",
    serverCookieReceived: false,
    sessionAuthorization: exactAuthorization(),
    ...overrides
  };
}

function retryRequestFixture(body, overrides = {}) {
  return requestFixture(body, {
    sessionProfile: core.APP_RETRY_SESSION_PROFILE,
    sessionCookie: "",
    serverCookieReceived: false,
    sessionAuthorization: exactAuthorization("00000004", "APP"),
    ...overrides
  });
}

function goldenCapsule() {
  if (!HAS_GOLDEN_FIXTURE) return null;
  return router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH);
}

test("restore HTTP evidence keeps bounded metadata and drops secrets", () => {
  const error = new core.RestoreHttpError("rejected", "RESTORE_HTTP_NOT_ACCEPTED", {
    statusCode: 401,
    contentType: "text/html",
    server: "Mongoose/3.0",
    bodySha256: "a".repeat(64),
    bodyBytes: 17,
    causeCode: "ECONNRESET",
    authorization: "Digest secret",
    cookie: "session=secret"
  });
  const evidence = core.safeRestoreHttpEvidence(error);
  assert.deepEqual(evidence, {
    httpStatus: 401,
    responseContentType: "text/html",
    responseServer: "Mongoose/3.0",
    responseBodySha256: "a".repeat(64),
    responseBodyBytes: 17,
    networkCauseCode: "ECONNRESET"
  });
  assert.doesNotMatch(JSON.stringify(evidence), /Digest|session|secret/i);
  assert.deepEqual(core.safeRestoreHttpEvidence(new core.RestoreHttpError("bad", "BAD", { contentType: "text/html\r\nInjected: yes", server: "x\nsecret", bodyBytes: 9000 })), {});
});

function installGithubFenceMock(handler = () => ({ statusCode: 201 })) {
  const original = https.request;
  const calls = [];
  https.request = (options, onResponse) => {
    const request = new EventEmitter();
    let idleHandler = null;
    request.setTimeout = (_milliseconds, callback) => { idleHandler = callback; return request; };
    request.destroy = error => queueMicrotask(() => request.emit("error", error));
    request.end = body => {
      const bytes = Buffer.from(body);
      const parsed = JSON.parse(bytes.toString("utf8"));
      calls.push({ options, body: bytes, parsed });
      const result = handler({ options, parsed, index: calls.length - 1 }) || {};
      if (result.idleTimeout) { queueMicrotask(() => idleHandler()); return; }
      if (result.error) { queueMicrotask(() => request.emit("error", result.error)); return; }
      const response = new EventEmitter();
      response.statusCode = result.statusCode === undefined ? 201 : result.statusCode;
      response.headers = { "content-type": "application/json", ...(result.headers || {}) };
      response.destroy = () => {};
      const responseValue = result.body === undefined
        ? { ref: parsed.ref, object: { type: "commit", sha: core.FENCE_TARGET_COMMIT } }
        : result.body;
      const responseBody = Buffer.isBuffer(responseValue) ? responseValue : Buffer.from(typeof responseValue === "string" ? responseValue : JSON.stringify(responseValue));
      queueMicrotask(() => {
        onResponse(response);
        if (responseBody.length) response.emit("data", responseBody);
        if (result.aborted) response.emit("aborted");
        else response.emit("end");
      });
    };
    return request;
  };
  return { calls, restore: () => { https.request = original; } };
}

function installRouterMock(handler = () => ({})) {
  const original = http.request;
  const calls = [];
  http.request = (options, onResponse) => {
    const request = new EventEmitter();
    let idleHandler = null;
    request.setTimeout = (_milliseconds, callback) => { idleHandler = callback; return request; };
    request.destroy = error => queueMicrotask(() => request.emit("error", error));
    request.end = body => {
      const bytes = Buffer.from(body);
      calls.push({ options, body: bytes });
      const result = handler({ options, body: bytes, index: calls.length - 1 }) || {};
      if (result.idleTimeout) { queueMicrotask(() => idleHandler()); return; }
      if (result.error) { queueMicrotask(() => request.emit("error", result.error)); return; }
      const response = new EventEmitter();
      response.statusCode = result.statusCode === undefined ? 200 : result.statusCode;
      response.headers = { "content-type": "text/html", "server": "Mongoose/3.0", ...(result.headers || {}) };
      response.destroy = () => {};
      const responseBody = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body === undefined ? "Server get upload file successfully\n" : String(result.body));
      queueMicrotask(() => {
        onResponse(response);
        if (responseBody.length) response.emit("data", responseBody);
        if (result.aborted) response.emit("aborted");
        else response.emit("end");
      });
    };
    return request;
  };
  return { calls, restore: () => { http.request = original; } };
}

function installRetryPreflightRouterMock(status1) {
  const original = http.request;
  const calls = [];
  http.request = (options, onResponse) => {
    const request = new EventEmitter();
    request.reusedSocket = false;
    request.setTimeout = () => request;
    request.destroy = error => queueMicrotask(() => request.emit("error", error));
    request.end = body => {
      const payload = body ? Buffer.from(body) : Buffer.alloc(0);
      calls.push({ options, body: payload });
      const response = new EventEmitter();
      response.statusCode = 200;
      response.socket = { localAddress: core.RESTORE_LOCAL_ADDRESS };
      response.headers = {};
      let responseBody = Buffer.alloc(0);
      if (options.path === "/login.cgi") {
        response.headers["www-authenticate"] = 'Digest realm="router", nonce="nonce-live", qop="auth"';
      } else if (String(options.path).startsWith("/login.cgi?")) {
        responseBody = Buffer.from("<RGW><login_status>0</login_status></RGW>");
      } else if (String(options.path).includes("file=status1")) {
        responseBody = Buffer.from(status1);
      } else if (String(options.path).includes("file=GetRestoreStatus")) {
        responseBody = Buffer.from("<process><status>0</status><progress>0</progress><cause>No Error!</cause></process>");
      } else if (String(options.path).includes("file=upgrade_firmware")) {
        responseBody = Buffer.from("<RGW><webui_upgrade><support_32m_flash>1</support_32m_flash></webui_upgrade></RGW>");
      } else if (options.method === "POST") {
        responseBody = Buffer.from("<RGW><message><total_count>0</total_count></message></RGW>");
      } else {
        throw new Error(`Unexpected retry preflight request ${options.method} ${options.path}`);
      }
      queueMicrotask(() => {
        onResponse(response);
        if (responseBody.length) response.emit("data", responseBody);
        response.emit("end");
      });
    };
    return request;
  };
  return { calls, restore: () => { http.request = original; } };
}

function recordExternalFence(fixture) {
  const gate = core.readGate(fixture.directory);
  const spec = core.externalFenceSpec(gate);
  const published = core.publishImmutable(fixture.directory, "external-fence.json", {
    schema: core.SCHEMA,
    kind: "mf885-restore-external-fence",
    profile: spec.profile,
    repository: spec.repository,
    targetCommit: spec.targetCommit,
    externalFenceRef: spec.ref,
    externalFenceIdSha256: spec.fenceIdSha256,
    responseStatus: 201,
    responseBodySha256: EXTERNAL_FENCE_SHA,
    transactionId: gate.transactionId,
    gateSha256: gate.recordSha256,
    createdAt: FIXED_TIME
  });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.EXTERNAL_FENCE_COMMITTED, { recordedAt: FIXED_TIME, evidenceSha256: published.recordSha256, firmwarePostsAttempted: 0 });
  return published.record;
}

function recordRetryHttpResponse(fixture, overrides = {}) {
  const accepted = overrides.accepted === true;
  const body = Buffer.from(overrides.body === undefined ? (accepted ? "Server get upload file successfully\n" : "rejected\n") : overrides.body);
  return core.persistRestoreHttpResponse(fixture.directory, fixture.receipt, {
    accepted,
    requestAttempted: true,
    responseComplete: overrides.responseComplete !== false,
    responseOversized: overrides.responseOversized === true,
    statusCode: overrides.statusCode === undefined ? (accepted ? 200 : 401) : overrides.statusCode,
    contentType: overrides.contentType === undefined ? "text/html" : overrides.contentType,
    server: overrides.server === undefined ? "Mongoose/3.0" : overrides.server,
    responseBodyBase64: body.toString("base64"),
    bodyBytes: body.length,
    bodySha256: core.sha256(body),
    wwwAuthenticatePresent: overrides.wwwAuthenticatePresent === true,
    locationPresent: overrides.locationPresent === true,
    setCookiePresent: overrides.setCookiePresent === true,
    outcomeCode: overrides.outcomeCode || (accepted ? "RESTORE_HTTP_ACCEPTED" : "RESTORE_HTTP_NOT_ACCEPTED"),
    capturedAt: FIXED_TIME
  });
}

async function spawnGateWorker(modulePath, directory, suffix) {
  const source = `
    const fs=require("node:fs");
    const core=require(${JSON.stringify(modulePath)});
    const input=core.createGateInput({
      slotId:core.GOLDEN_SLOT_ID,
      unitFingerprintSha256:core.RESTORE_UNIT_FINGERPRINT_SHA256,
      imageSha256:core.GOLDEN_IMAGE_SHA256,
      bodySha256:core.GOLDEN_BODY_SHA256,
      contractSha256:"4".repeat(64),
      preflightEvidenceSha256:"5".repeat(64),
      bootId:${JSON.stringify(FIXED_BOOT_ID)},
      createdAt:${JSON.stringify(FIXED_TIME)},
      transactionId:"00000000-0000-4000-8000-00000000000${suffix}",
      ownerToken:${JSON.stringify(String(suffix).repeat(64))}
    });
    fs.writeSync(1,JSON.stringify(core.acquirePermanentGate(${JSON.stringify(directory)},input)));
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `gate worker exited ${code}`)));
  });
}

test("the permanent fence is a fixed vector bound to this exact unit and golden", () => {
  const spec = core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  assert.equal(spec.fenceIdSha256, "42063835281d6f41828bc7a1b1960e21559b6dad5dada8016991fd1dc0351167");
  assert.equal(spec.ref, `refs/tags/mf885-restore-fence-v1-${spec.fenceIdSha256}`);
  assert.throws(() => core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: "1".repeat(64), imageSha256: core.GOLDEN_IMAGE_SHA256 }), /exact live MF885 unit/i);
  assert.throws(() => core.createGateInput({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: "2".repeat(64), imageSha256: core.GOLDEN_IMAGE_SHA256, bodySha256: core.GOLDEN_BODY_SHA256, contractSha256: "3".repeat(64), preflightEvidenceSha256: "4".repeat(64), bootId: FIXED_BOOT_ID }), /exact live MF885 unit/i);
});

test("retry-v2 has one distinct fixed fence and exact immutable v1 predecessor", () => {
  const first = core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  const retry = core.externalFenceSpec({ slotId: core.GOLDEN_RETRY_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  assert.equal(first.ref, core.V1_EXTERNAL_FENCE_REF);
  assert.equal(retry.fenceIdSha256, "11bd72d61565751a87584516bd41b29473609c4e31c0a192ef0723881ae7b456");
  assert.equal(retry.ref, `refs/tags/mf885-restore-fence-v2-${retry.fenceIdSha256}`);
  assert.notEqual(retry.ref, first.ref);
  assert.equal(core.V1_GATE_SHA256, "77dfaa4aff412aa29a003d5274684c9dc8abcf35fa066219664ab26e5ab5226c");
  assert.equal(core.V1_TERMINAL_RECORD_SHA256, "915f05c09305720db6241eb53352f2086ebd222a7a1139115644bd9dd3c433d6");
  assert.equal(core.V1_EXTERNAL_FENCE_RECORD_SHA256, "8acb1b719142974f3c83480a8ee48ee38f357a49ea4ddf89bc09f4f2c1e42a6a");
  assert.throws(() => core.externalFenceSpec({ slotId: "golden-qualification-retry-v3", unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 }), /only the two fixed/i);

  const input = core.createGateInput({ slotId: core.GOLDEN_RETRY_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256, bodySha256: core.GOLDEN_BODY_SHA256, contractSha256: "3".repeat(64), preflightEvidenceSha256: "4".repeat(64), bootId: FIXED_BOOT_ID, createdAt: FIXED_TIME });
  assert.equal(input.predecessorGateSha256, core.V1_GATE_SHA256);
  assert.equal(input.predecessorTerminalRecordSha256, core.V1_TERMINAL_RECORD_SHA256);
  assert.equal(input.predecessorFenceRef, core.V1_EXTERNAL_FENCE_REF);
});

test("two independent processes race the permanent ext4 gate and exactly one wins", async () => {
  const directory = temporaryState("mf885-gate-race-");
  const modulePath = path.resolve(__dirname, "../tools/mf885_vds_restore_core.js");
  const results = await Promise.all([spawnGateWorker(modulePath, directory, "a"), spawnGateWorker(modulePath, directory, "b")]);
  assert.equal(results.filter(result => result.acquired).length, 1);
  assert.equal(results.filter(result => !result.acquired).length, 1);
  assert.equal(core.readGate(directory).kind, "mf885-restore-permanent-gate");
  assert.equal(core.checkedRealDirectory(directory).fsType, "ext4");
});

test("GitHub create-reference request and response are byte-bound and one-shot", async () => {
  const spec = core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  const mock = installGithubFenceMock();
  try {
    const result = await core.githubFenceRequest(spec, "test-token", { timeoutMs: 5000 });
    assert.equal(result.externalFenceRef, spec.ref);
    assert.equal(mock.calls.length, 1);
    const call = mock.calls[0];
    assert.equal(call.options.hostname, "api.github.com");
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.path, "/repos/nryabkov/mf885-smsreader/git/refs");
    assert.equal(call.options.agent, false);
    assert.equal(call.options.headers.Authorization, "Bearer test-token");
    assert.equal(call.options.headers.Connection, "close");
    assert.deepEqual(call.parsed, { ref: spec.ref, sha: core.FENCE_TARGET_COMMIT });
    assert.equal(Number(call.options.headers["Content-Length"]), call.body.length);
  } finally { mock.restore(); }
});

test("every ambiguous or non-exact GitHub fence response fails closed", async t => {
  const spec = core.externalFenceSpec({ slotId: core.GOLDEN_SLOT_ID, unitFingerprintSha256: core.RESTORE_UNIT_FINGERPRINT_SHA256, imageSha256: core.GOLDEN_IMAGE_SHA256 });
  const exact = { ref: spec.ref, object: { type: "commit", sha: core.FENCE_TARGET_COMMIT } };
  const scenarios = [
    ["HTTP 200", { statusCode: 200 }],
    ["redirect", { statusCode: 301, headers: { location: "/again" } }],
    ["pre-existing 422", { statusCode: 422, body: { message: "exists" } }],
    ["wrong content type", { headers: { "content-type": "text/plain" } }],
    ["malformed JSON", { body: "{" }],
    ["wrong ref", { body: { ...exact, ref: `${spec.ref}-wrong` } }],
    ["wrong object type", { body: { ref: spec.ref, object: { type: "tag", sha: core.FENCE_TARGET_COMMIT } } }],
    ["wrong commit", { body: { ref: spec.ref, object: { type: "commit", sha: "0".repeat(40) } } }],
    ["truncated", { body: exact, aborted: true }],
    ["oversized", { body: Buffer.alloc(65537, 0x78) }],
    ["network reset", { error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }],
    ["idle timeout", { idleTimeout: true }]
  ];
  for (const [name, outcome] of scenarios) {
    await t.test(name, async () => {
      const mock = installGithubFenceMock(() => outcome);
      try {
        await assert.rejects(() => core.githubFenceRequest(spec, "test-token", { timeoutMs: 5000 }));
        assert.equal(mock.calls.length, 1);
      } finally { mock.restore(); }
    });
  }
});

test("restart after allowance burn or dispatch remains permanently locked", () => {
  for (const phase of ["armed", "dispatch"]) {
    const fixture = gateFixture(temporaryState(`mf885-restart-${phase}-`));
    core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
    if (phase === "dispatch") {
      recordExternalFence(fixture);
      core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
    }
    const inspected = core.inspectTransaction(fixture.directory);
    assert.equal(inspected.disposition, "LOCKED_UNKNOWN");
    assert.equal(inspected.postAllowed, false);
    assert.throws(() => core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME }));
  }
});

test("state storage fails closed on owner loss, orphans, corruption, unsafe mode, and symlinks", () => {
  const fixture = gateFixture(temporaryState("mf885-fail-closed-"));
  assert.throws(() => core.assertGateOwner(fixture.directory, { ...fixture.receipt, ownerToken: "0".repeat(64) }), /ownership was lost/i);
  const orphan = path.join(fixture.directory, ".pending-crash-leftover");
  fs.writeFileSync(orphan, "uncertain", { mode: 0o600 });
  assert.throws(() => core.readJournal(fixture.directory), /orphan or unexpected/i);
  fs.unlinkSync(orphan);
  const journal = path.join(fixture.directory, "journal-000001.json");
  const original = fs.readFileSync(journal);
  fs.writeFileSync(journal, Buffer.concat([original.subarray(0, original.length - 2), Buffer.from("x\n")]));
  assert.throws(() => core.readJournal(fixture.directory), /valid JSON|checksum/i);
  const unsafe = temporaryState("mf885-unsafe-mode-");
  fs.chmodSync(unsafe, 0o755);
  assert.throws(() => core.checkedRealDirectory(unsafe), /mode 0700/i);
  const target = temporaryState("mf885-symlink-target-");
  const link = `${target}-link`;
  fs.symlinkSync(target, link);
  assert.throws(() => core.ensureStateDirectory(link), /real directory|symbolic/i);
});

test("exact golden request plan rejects every material mutation", { skip: !HAS_GOLDEN_FIXTURE }, () => {
  const capsule = goldenCapsule();
  const valid = requestFixture(capsule.body);
  assert.equal(core.validateRestoreRequestPlan(valid, capsule.body).bodySha256, core.GOLDEN_BODY_SHA256);
  const changed = Buffer.from(capsule.body);
  changed[Math.floor(changed.length / 2)] ^= 1;
  assert.throws(() => core.validateRestoreRequestPlan(requestFixture(changed), changed), /exact reviewed golden/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, host: "127.0.0.1" }, capsule.body), /reviewed MF885 route/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, port: 8080 }, capsule.body), /reviewed MF885 route/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, path: `${core.RESTORE_ROUTE}&again=1` }, capsule.body), /exact native route/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, boundary: `${core.GOLDEN_BOUNDARY}x` }, capsule.body), /reviewed golden envelope/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, localAddress: "not-an-ip" }, capsule.body), /source interface/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, localAddress: "127.0.0.1" }, capsule.body), /source interface/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionProfile: "legacy" }, capsule.body), /session proof/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionCookie: "sid=x\r\nInjected: yes" }, capsule.body), /cookie profile/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, serverCookieReceived: true }, capsule.body), /cookie profile/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: exactAuthorization("00000003") }, capsule.body), /Authorization header/i);
  const alteredDigest = valid.sessionAuthorization.replace(/response="([0-9a-f])/, (_all, first) => `response="${first === "0" ? "1" : "0"}`);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: alteredDigest }, capsule.body), /internally invalid/i);
});

test("retry-v2 request requires exact APP nc4, client marker, empty cookie, and digest", { skip: !HAS_GOLDEN_FIXTURE }, () => {
  const capsule = router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH, { retryV2: true });
  const valid = retryRequestFixture(capsule.body);
  const plan = core.validateRestoreRequestPlan(valid, capsule.body);
  assert.equal(plan.sessionProfile, core.APP_RETRY_SESSION_PROFILE);
  assert.equal(plan.sessionCookie, "");
  assert.match(plan.sessionAuthorization, /nc=00000004.*client=APP$/);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: exactAuthorization("00000004") }, capsule.body), /Authorization header/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: exactAuthorization("00000005", "APP") }, capsule.body), /Authorization header/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: exactAuthorization("00000004", "WEB") }, capsule.body), /Authorization header/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionCookie: "locale=en" }, capsule.body), /cookie profile/i);
  assert.throws(() => core.validateRestoreRequestPlan({ ...valid, sessionProfile: core.WEB_RESTORE_SESSION_PROFILE }, capsule.body), /cookie profile|Authorization/i);

  const session = { authorization: exactAuthorization("00000003", "APP") };
  const generated = router.appPostAuthorization(session);
  assert.match(generated, /uri="\/cgi\/xml_action\.cgi"/);
  assert.match(generated, /nc=00000004/);
  assert.match(generated, /, client=APP$/);
  assert.doesNotThrow(() => core.validateRestoreRequestPlan({ ...valid, sessionAuthorization: generated }, capsule.body));
});

test("retry preflight proves APP nc4 with SMS-read, then reserves a distinct fresh APP nc4 without another router call", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const status1 = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE_PATH, "utf8")).status1;
  const mock = installRetryPreflightRouterMock(status1);
  try {
    const result = await router.collectRestoreRetryPreflight();
    assert.equal(result.report.session.profile, core.APP_RETRY_SESSION_PROFILE);
    assert.equal(result.report.session.appPostSmsReadProofPassed, true);
    assert.equal(result.report.session.proofAndFinalSessionsDistinct, true);
    assert.equal(result.report.session.restoreNonceCount, 4);
    assert.equal(result.report.session.clientMarker, "APP");
    assert.equal(result.report.safety.routerGetsAttempted, 8);
    assert.equal(result.report.safety.readOnlyHttpPostsAttempted, 1);
    assert.equal(result.report.safety.firmwarePostsAttempted, 0);
    assert.equal(result.report.safety.smsPayloadsEmitted, 0);
    assert.equal(result.session.cookie, "");
    assert.equal(result.session.serverCookieReceived, false);
    assert.match(result.session.restoreAuthorization, /nc=00000004.*client=APP$/);
    assert.equal(mock.calls.length, 9);
    assert.equal(mock.calls.filter(call => call.options.method === "POST").length, 1);
    const proofPost = mock.calls.find(call => call.options.method === "POST");
    assert.match(proofPost.options.headers.Authorization, /nc=00000004.*client=APP$/);
    assert.notEqual(proofPost.options.headers.Authorization, result.session.restoreAuthorization);
    assert.equal(proofPost.options.headers.Cookie, undefined);
    assert.equal(mock.calls[mock.calls.length - 1].options.method, "GET");
    assert.match(mock.calls[mock.calls.length - 1].options.path, /file=upgrade_firmware$/);
    assert.doesNotMatch(JSON.stringify(result.report), /message_content|Digest username|nonce-live/i);
  } finally { mock.restore(); }
});

test("retry-v2 slot dispatches one APP POST without synthetic cookies", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH, { retryV2: true });
  const fixture = gateFixture(temporaryState("mf885-retry-v2-"), { slotId: core.GOLDEN_RETRY_SLOT_ID, contractSha256: capsule.contractSha256 });
  const fence = installGithubFenceMock();
  const transport = installRouterMock();
  try {
    const result = await core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: retryRequestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME });
    assert.equal(result.state, core.STATES.POST_ACCEPTED);
    assert.equal(Buffer.from(result.response.responseBodyBase64, "base64").toString("utf8"), "Server get upload file successfully\n");
    assert.equal(fence.calls.length, 1);
    assert.match(fence.calls[0].parsed.ref, /mf885-restore-fence-v2-/);
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.equal(call.options.headers.Cookie, undefined);
    assert.match(call.options.headers.Authorization, /nc=00000004.*client=APP$/);
    assert.equal(call.options.headers["Content-Length"], String(core.GOLDEN_BODY_BYTES));
    assert.equal(call.options.headers.Expect, undefined);
    assert.equal(call.options.headers["Transfer-Encoding"], undefined);
    const inspected = core.inspectTransaction(fixture.directory);
    assert.equal(inspected.armed.predecessorGateSha256, core.V1_GATE_SHA256);
    assert.equal(inspected.last.predecessorTerminalRecordSha256, core.V1_TERMINAL_RECORD_SHA256);
    const durableResponse = core.readRestoreHttpResponse(fixture.directory);
    assert.equal(durableResponse.accepted, true);
    assert.equal(durableResponse.complete, true);
    assert.equal(Buffer.from(durableResponse.bodyBase64, "base64").toString("utf8"), "Server get upload file successfully\n");
    assert.equal(inspected.journal.records.find(record => record.state === core.STATES.POST_ACCEPTED).evidenceSha256, durableResponse.recordSha256);
    await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: retryRequestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }));
    assert.equal(transport.calls.length, 1);
    fs.unlinkSync(path.join(fixture.directory, "http-response.json"));
    assert.throws(() => core.inspectTransaction(fixture.directory), /HTTP response evidence/i);
  } finally { transport.restore(); fence.restore(); }
});

test("slot and auth-profile swaps fail before allowance, fence, or router", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = goldenCapsule();
  const cases = [
    [core.GOLDEN_RETRY_SLOT_ID, requestFixture(capsule.body)],
    [core.GOLDEN_SLOT_ID, retryRequestFixture(capsule.body)]
  ];
  for (const [slotId, request] of cases) {
    const fixture = gateFixture(temporaryState("mf885-profile-swap-"), { slotId });
    const fence = installGithubFenceMock();
    const transport = installRouterMock();
    try {
      await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request, body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }), /profile does not match/i);
      assert.equal(core.readArmed(fixture.directory), null);
      assert.equal(fence.calls.length, 0);
      assert.equal(transport.calls.length, 0);
    } finally { transport.restore(); fence.restore(); }
  }
});

test("one exact RestoreFw attempt uses exact headers and caller mutation cannot change bytes", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = goldenCapsule();
  const expectedBody = Buffer.from(capsule.body);
  const callerBody = Buffer.from(capsule.body);
  const fixture = gateFixture(temporaryState());
  const fence = installGithubFenceMock(() => { callerBody.fill(0x78); return { statusCode: 201 }; });
  const transport = installRouterMock();
  try {
    const result = await core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(callerBody), body: callerBody, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME });
    assert.equal(result.state, core.STATES.POST_ACCEPTED);
    assert.equal(fence.calls.length, 1);
    assert.equal(transport.calls.length, 1);
    const call = transport.calls[0];
    assert.deepEqual(call.body, expectedBody);
    assert.equal(call.options.host, core.RESTORE_HOST);
    assert.equal(call.options.port, core.RESTORE_PORT);
    assert.equal(call.options.method, "POST");
    assert.equal(call.options.path, core.RESTORE_ROUTE);
    assert.equal(call.options.localAddress, core.RESTORE_LOCAL_ADDRESS);
    assert.equal(call.options.agent, false);
    assert.equal(call.options.headers["Content-Length"], String(core.GOLDEN_BODY_BYTES));
    assert.equal(call.options.headers["Content-Type"], `multipart/form-data; boundary=${core.GOLDEN_BOUNDARY}`);
    assert.equal(call.options.headers.Connection, "close");
    assert.match(call.options.headers.Authorization, /nc=00000004/);
    assert.equal(call.options.headers.Cookie, "locale=en; hard_ver=Ver.D; platform=mifi");
    assert.equal(call.options.headers.Expect, undefined);
    assert.equal(call.options.headers["Transfer-Encoding"], undefined);
    assert.equal(core.inspectTransaction(fixture.directory).disposition, "MONITOR_ONLY");
    await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(expectedBody), body: expectedBody, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }), /preflight boundary/i);
    assert.equal(transport.calls.length, 1);
  } finally { transport.restore(); fence.restore(); }
});

test("non-exact router responses consume one attempt and never retry", { skip: !HAS_GOLDEN_FIXTURE }, async t => {
  const capsule = goldenCapsule();
  const scenarios = [
    ["401", { statusCode: 401, body: "auth" }],
    ["redirect", { statusCode: 302, headers: { location: "/again" }, body: "redirect" }],
    ["wrong content type", { headers: { "content-type": "application/json" } }],
    ["wrong server", { headers: { server: "other" } }],
    ["wrong body", { body: "almost\n" }],
    ["truncated", { aborted: true }],
    ["reset", { error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }],
    ["idle timeout", { idleTimeout: true }]
  ];
  for (const [name, outcome] of scenarios) {
    await t.test(name, async () => {
      const fixture = gateFixture(temporaryState(`mf885-${name.replace(/\s/g, "-")}-`));
      const fence = installGithubFenceMock();
      const transport = installRouterMock(() => outcome);
      try {
        await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }), error => error instanceof core.RestoreHttpError);
        assert.equal(transport.calls.length, 1);
        const inspected = core.inspectTransaction(fixture.directory);
        assert.equal(inspected.last.state, core.STATES.UNKNOWN);
        assert.equal(inspected.last.firmwarePostsAttempted, 1);
        assert.equal(inspected.postAllowed, false);
        if (name === "401") {
          assert.equal(inspected.last.httpStatus, 401);
          assert.equal(inspected.last.responseContentType, "text/html");
          assert.equal(inspected.last.responseServer, "Mongoose/3.0");
          assert.equal(inspected.last.responseBodyBytes, 4);
          assert.equal(inspected.last.responseBodySha256, core.sha256(Buffer.from("auth")));
          assert.doesNotMatch(JSON.stringify(inspected.last), /"Authorization"|"Cookie"|Digest secret|session=secret/i);
        }
        if (name === "reset") assert.equal(inspected.last.networkCauseCode, "ECONNRESET");
      } finally { transport.restore(); fence.restore(); }
    });
  }
});

test("retry-v2 durably seals a rejected complete response before terminal UNKNOWN", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH, { retryV2: true });
  const fixture = gateFixture(temporaryState("mf885-retry-rejected-"), { slotId: core.GOLDEN_RETRY_SLOT_ID, contractSha256: capsule.contractSha256 });
  const fence = installGithubFenceMock();
  const transport = installRouterMock(() => ({ statusCode: 401, headers: { "www-authenticate": "Digest redacted" }, body: "auth rejected\n" }));
  try {
    await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: retryRequestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }), /acceptance predicate/i);
    assert.equal(transport.calls.length, 1);
    const inspected = core.inspectTransaction(fixture.directory);
    const response = core.readRestoreHttpResponse(fixture.directory);
    assert.equal(inspected.last.state, core.STATES.UNKNOWN);
    assert.equal(inspected.last.evidenceSha256, response.recordSha256);
    assert.equal(response.accepted, false);
    assert.equal(response.complete, true);
    assert.equal(response.statusCode, 401);
    assert.equal(response.wwwAuthenticatePresent, true);
    assert.equal(Buffer.from(response.bodyBase64, "base64").toString("utf8"), "auth rejected\n");
    assert.doesNotMatch(JSON.stringify(inspected.last), /Digest redacted|auth rejected/i);
  } finally { transport.restore(); fence.restore(); }
});

test("stale or insufficient session budget burns no allowance and calls neither fence nor router", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = goldenCapsule();
  for (const ageMs of [16000, 9000, -1000]) {
    const fixture = gateFixture(temporaryState("mf885-session-budget-"));
    const fence = installGithubFenceMock();
    const transport = installRouterMock();
    try {
      await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(capsule.body, { sessionProvenAtMs: Date.now() - ageMs }), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME }), /session|remaining time/i);
      assert.equal(fence.calls.length, 0);
      assert.equal(transport.calls.length, 0);
      assert.equal(core.readArmed(fixture.directory), null);
      assert.equal(core.readJournal(fixture.directory).last.state, core.STATES.PRECHECK_OK);
    } finally { transport.restore(); fence.restore(); }
  }
});

test("a fence that consumes the reserved session budget permanently blocks the router POST", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = goldenCapsule();
  const fixture = gateFixture(temporaryState("mf885-post-fence-budget-"));
  const fence = installGithubFenceMock();
  const transport = installRouterMock();
  const base = Date.now();
  const clock = [base, base + 14000];
  try {
    await assert.rejects(() => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(capsule.body, { sessionProvenAtMs: base }), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME, nowMs: () => clock.shift() ?? base + 14000 }), /expired before dispatch/i);
    assert.equal(fence.calls.length, 1);
    assert.equal(transport.calls.length, 0);
    const inspected = core.inspectTransaction(fixture.directory);
    assert.equal(inspected.last.state, core.STATES.UNKNOWN);
    assert.equal(inspected.last.firmwarePostsAttempted, 0);
    assert.equal(inspected.postAllowed, false);
  } finally { transport.restore(); fence.restore(); }
});

test("two rolled-back directories share the same remote fuse and only one can reach RestoreFw", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = goldenCapsule();
  let created = false;
  const fence = installGithubFenceMock(() => {
    if (created) return { statusCode: 422, body: { message: "Reference already exists" } };
    created = true;
    return { statusCode: 201 };
  });
  const transport = installRouterMock();
  try {
    const first = gateFixture(temporaryState("mf885-dir-a-"));
    const second = gateFixture(temporaryState("mf885-dir-b-"));
    assert.equal(first.acquired.gate.externalFenceRef, second.acquired.gate.externalFenceRef);
    const results = await Promise.allSettled([first, second].map(fixture => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: requestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(fence.calls.length, 2);
    assert.equal(transport.calls.length, 1);
  } finally { transport.restore(); fence.restore(); }
});

test("two retry-v2 rollback copies share one v2 fuse and permit one router POST total", { skip: !HAS_GOLDEN_FIXTURE }, async () => {
  const capsule = router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH, { retryV2: true });
  let created = false;
  const fence = installGithubFenceMock(() => {
    if (created) return { statusCode: 422, body: { message: "Reference already exists" } };
    created = true;
    return { statusCode: 201 };
  });
  const transport = installRouterMock();
  try {
    const first = gateFixture(temporaryState("mf885-retry-dir-a-"), { slotId: core.GOLDEN_RETRY_SLOT_ID, contractSha256: capsule.contractSha256 });
    const second = gateFixture(temporaryState("mf885-retry-dir-b-"), { slotId: core.GOLDEN_RETRY_SLOT_ID, contractSha256: capsule.contractSha256 });
    assert.equal(first.acquired.gate.externalFenceRef, second.acquired.gate.externalFenceRef);
    const results = await Promise.allSettled([first, second].map(fixture => core.dispatchRestoreAtMostOnce({ directory: fixture.directory, receipt: fixture.receipt, request: retryRequestFixture(capsule.body), body: capsule.body, githubToken: "test-token", fenceTimeoutMs: 5000, now: () => FIXED_TIME })));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.filter(result => result.status === "rejected").length, 1);
    assert.equal(fence.calls.length, 2);
    assert.equal(transport.calls.length, 1);
  } finally { transport.restore(); fence.restore(); }
});

test("private retry response capture preserves exact partial bytes with transaction binding and no request secrets", () => {
  const fixture = gateFixture(temporaryState("mf885-response-capture-"), { slotId: core.GOLDEN_RETRY_SLOT_ID });
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  const body = Buffer.from("partial response bytes\n", "utf8");
  const durableResponse = recordRetryHttpResponse(fixture, { body, responseComplete: false, outcomeCode: "RESTORE_HTTP_RESPONSE_TRUNCATED", wwwAuthenticatePresent: true });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.UNKNOWN, { recordedAt: FIXED_TIME, evidenceSha256: durableResponse.recordSha256, reasonCode: "RESTORE_HTTP_RESPONSE_TRUNCATED", firmwarePostsAttempted: 1 });
  const state = core.inspectTransaction(fixture.directory);
  const error = new core.RestoreHttpError("truncated", "RESTORE_HTTP_RESPONSE_TRUNCATED", {
    statusCode: 401,
    contentType: "text/html",
    server: "Mongoose/3.0",
    bodyBytes: body.length,
    bodySha256: core.sha256(body),
    responseBodyBase64: body.toString("base64"),
    responseComplete: false,
    wwwAuthenticatePresent: true,
    authorization: "Digest secret",
    cookie: "session=secret"
  });
  const saved = restoreCli.writePrivateRestoreResponse(error, "test-retry-v2-response", { slotId: core.GOLDEN_RETRY_SLOT_ID, gateSha256: state.gate.recordSha256, journalRecordSha256: state.last.recordSha256 });
  try {
    assert.deepEqual(fs.readFileSync(saved.bodyFile), body);
    assert.equal(fs.lstatSync(saved.bodyFile).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(saved.metadataFile).mode & 0o777, 0o600);
    const metadata = JSON.parse(fs.readFileSync(saved.metadataFile, "utf8"));
    assert.equal(metadata.complete, false);
    assert.equal(metadata.gateSha256, state.gate.recordSha256);
    assert.equal(metadata.journalRecordSha256, state.last.recordSha256);
    assert.equal(metadata.bodySha256, core.sha256(body));
    assert.equal(metadata.headerPresence.wwwAuthenticate, true);
    assert.doesNotMatch(JSON.stringify(metadata), /Digest secret|session=secret|message_content/i);
  } finally {
    fs.unlinkSync(saved.bodyFile);
    fs.unlinkSync(saved.metadataFile);
  }
});

test("retry UNKNOWN observer is exact-state-bound, GET-only, bounded, and identity-checked", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const source = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE_PATH, "utf8"));
  const fixture = gateFixture(temporaryState("mf885-unknown-observer-"), { slotId: core.GOLDEN_RETRY_SLOT_ID });
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  const durableResponse = recordRetryHttpResponse(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.UNKNOWN, { recordedAt: FIXED_TIME, evidenceSha256: durableResponse.recordSha256, reasonCode: "RESTORE_HTTP_NOT_ACCEPTED", firmwarePostsAttempted: 1 });
  const calls = [];
  const routerApi = {
    ...router,
    async createFreshAppSession() { calls.push("GET:login"); return { localAddress: core.RESTORE_LOCAL_ADDRESS }; },
    async sessionModelGet(_session, model) {
      calls.push(`GET:${model}`);
      if (model === "status1") return { text: source.status1 };
      return { text: "<process><status>0</status><progress>0</progress><cause>No Error!</cause></process>" };
    }
  };
  const result = await restoreCli.observeUnknownAfterDispatch({ directory: fixture.directory, routerApi, sleep: async () => {}, maxPolls: 2, intervalMs: 0 });
  try {
    assert.equal(result.polls, 2);
    assert.equal(result.sawOffline, false);
    assert.equal(calls.every(call => call.startsWith("GET:")), true);
    assert.deepEqual(calls, ["GET:login", "GET:GetRestoreStatus", "GET:status1", "GET:GetRestoreStatus"]);
    await assert.rejects(() => restoreCli.observeUnknownAfterDispatch({ directory: fixture.directory, routerApi, maxPolls: 0 }), /bounds/i);
  } finally {
    fs.unlinkSync(path.join(restoreCli.PRIVATE_DIRECTORY, result.evidenceFile));
  }
});

test("the real immutable v1 UNKNOWN predecessor matches the retry contract when present", { skip: !fs.existsSync(restoreCli.STATE_DIRECTORY) }, () => {
  const predecessor = restoreCli.verifyLegacyRetryPrerequisite();
  assert.equal(predecessor.gateSha256, core.V1_GATE_SHA256);
  assert.equal(predecessor.terminalRecordSha256, core.V1_TERMINAL_RECORD_SHA256);
  assert.equal(predecessor.externalFenceRef, core.V1_EXTERNAL_FENCE_REF);
  assert.equal(predecessor.state, core.STATES.UNKNOWN);
  assert.equal(predecessor.firmwarePostsAttempted, 1);
  assert.doesNotThrow(() => restoreCli.assertLegacySnapshotUnchanged(predecessor));
});

test("retry-v2 execute rejects without its one exact confirmation before creating state or contacting transports", { skip: fs.existsSync(restoreCli.RETRY_STATE_DIRECTORY) }, async () => {
  const original = process.argv;
  process.argv = original.filter(value => !value.startsWith("--confirm="));
  try {
    await assert.rejects(() => restoreCli.executeGoldenRetryV2(), new RegExp(restoreCli.RETRY_EXECUTE_CONFIRMATION));
    assert.equal(fs.existsSync(restoreCli.RETRY_STATE_DIRECTORY), false);
  } finally { process.argv = original; }
});

test("private settings gate recomputes identity, raw Wi-Fi/APN presence, provenance, and freshness", { skip: !HAS_SETTINGS_FIXTURE }, () => {
  const source = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE_PATH, "utf8"));
  const capturedAtMs = Date.parse(source.capturedAt);
  const valid = router.validatePrivateSettingsEvidence(source, { nowMs: capturedAtMs + 1000 });
  assert.equal(valid.unitFingerprintSha256, core.RESTORE_UNIT_FINGERPRINT_SHA256);
  assert.equal(valid.modelsCaptured >= 6, true);
  assert.equal(valid.wifiSettingsRecorded, true);
  assert.equal(valid.apnSettingsRecorded, true);

  const alteredIdentity = structuredClone(source);
  alteredIdentity.unitFingerprintSha256 = "0".repeat(64);
  assert.throws(() => router.validatePrivateSettingsEvidence(alteredIdentity, { nowMs: capturedAtMs + 1000 }), /exact reviewed MF885/i);

  const alteredModels = structuredClone(source);
  [alteredModels.modelsAttempted[0], alteredModels.modelsAttempted[1]] = [alteredModels.modelsAttempted[1], alteredModels.modelsAttempted[0]];
  assert.throws(() => router.validatePrivateSettingsEvidence(alteredModels, { nowMs: capturedAtMs + 1000 }), /model order/i);

  const emptyWifi = structuredClone(source);
  for (const name of Object.keys(emptyWifi.responses)) {
    emptyWifi.responses[name] = emptyWifi.responses[name]
      .replace(/<(ssid|ssid_name)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1></$1>")
      .replace(/<(key|wpa_key|wpa_psk|psk|password|network_key|wpa_passphrase)\b[^>]*>[\s\S]*?<\/\1>/gi, "<$1></$1>");
  }
  assert.throws(() => router.validatePrivateSettingsEvidence(emptyWifi, { nowMs: capturedAtMs + 1000 }), /usable Wi-Fi or APN/i);

  const alteredProof = structuredClone(source);
  alteredProof.stockExportUnavailableProof.rawHttp.bytes = 1;
  assert.throws(() => router.validatePrivateSettingsEvidence(alteredProof, { nowMs: capturedAtMs + 1000 }), /fallback proof/i);

  assert.throws(() => router.validatePrivateSettingsEvidence(source, { nowMs: capturedAtMs + 7 * 60 * 60 * 1000 }), /stale/i);
});

test("golden capture reports are bound to the exact artifact, power, and complete status sequence", { skip: !HAS_GOLDEN_FIXTURE }, () => {
  const reportPath = GOLDEN_FIXTURE_PATH.replace(/\.bin$/, ".json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const nowMs = Date.parse(report.completedAt) + 1000;
  assert.equal(restoreCli.validateCaptureReport(report, GOLDEN_FIXTURE_PATH, nowMs).artifact.sha256, core.GOLDEN_IMAGE_SHA256);
  const wrongArtifact = structuredClone(report);
  wrongArtifact.artifact.sha256 = "0".repeat(64);
  assert.throws(() => restoreCli.validateCaptureReport(wrongArtifact, GOLDEN_FIXTURE_PATH, nowMs), /incomplete or unsafe/i);
  const noPower = structuredClone(report);
  noPower.power.externalPowerConnected = false;
  assert.throws(() => restoreCli.validateCaptureReport(noPower, GOLDEN_FIXTURE_PATH, nowMs), /incomplete or unsafe/i);
  const noProcessing = structuredClone(report);
  noProcessing.statusHistory = noProcessing.statusHistory.filter(item => item.status !== "2");
  assert.throws(() => restoreCli.validateCaptureReport(noProcessing, GOLDEN_FIXTURE_PATH, nowMs), /incomplete or unsafe/i);
  const wrongFinal = structuredClone(report);
  wrongFinal.statusHistory[wrongFinal.statusHistory.length - 1].progress = "99";
  assert.throws(() => restoreCli.validateCaptureReport(wrongFinal, GOLDEN_FIXTURE_PATH, nowMs), /incomplete or unsafe/i);
});

test("GET-only monitor tolerates transient status failures and requires a reboot boundary", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const source = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE_PATH, "utf8"));
  const status1 = source.status1;
  const baseline = { operator: router.firstText(status1, ["network_name", "ISP_name", "operator"]) };
  const fixture = gateFixture(temporaryState("mf885-monitor-"));
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.POST_ACCEPTED, { recordedAt: FIXED_TIME, evidenceSha256: "9".repeat(64), firmwarePostsAttempted: 1 });

  let sessionCreates = 0, restoreReads = 0, rootReads = 0, saves = 0;
  const routerApi = {
    ...router,
    async createFreshAppSession() {
      sessionCreates += 1;
      if (sessionCreates === 1) throw Object.assign(new Error("temporary"), { code: "ECONNRESET" });
      return { localAddress: core.RESTORE_LOCAL_ADDRESS };
    },
    async sessionModelGet(_session, model) {
      if (model === "status1") return { text: status1 };
      restoreReads += 1;
      if (restoreReads === 1) return { text: "<process><status>2</status><progress>40</progress><cause>Processing...!</cause></process>" };
      if (restoreReads === 2) throw Object.assign(new Error("temporary"), { code: "ECONNRESET" });
      return { text: "<process><status>1</status><progress>100</progress><cause>Success!</cause></process>" };
    },
    async routerGetOnce(input) {
      if (input.path === "/") {
        rootReads += 1;
        if (rootReads === 1) throw Object.assign(new Error("reboot boundary"), { code: "ECONNREFUSED" });
        return { statusCode: 200, redirected: false, body: Buffer.from("<html>MF885</html>") };
      }
      throw new Error("unexpected route");
    },
    async collectRestorePreflight() {
      const identity = router.identityFromStatus(status1);
      return { report: { identity, power: { batteryPercent: 99, externalPowerConnected: true }, restoreStatus: { status: "0", progress: "0", cause: "No Error!" }, upgradeStatus: { support32mFlash: "1" }, networkBaseline: baseline, session: { standardDigestSmsReadPassed: true }, safety: { firmwarePostsAttempted: 0 } } };
    }
  };
  const result = await restoreCli.monitorRestore(fixture.directory, fixture.receipt, baseline, {
    routerApi,
    sleep: async () => {},
    statusMaxPolls: 8,
    bootBoundaryMaxPolls: 3,
    postbootMaxPolls: 3,
    saveEvidence(_prefix, value) { saves += 1; assert.equal(value.bootBoundary.kind, "observed-router-unavailable-after-restore-success"); return { file: "/private/test-postboot.json" }; }
  });
  assert.equal(result.state, core.STATES.BOOT_VERIFIED);
  assert.equal(core.inspectTransaction(fixture.directory).last.state, core.STATES.BOOT_VERIFIED);
  assert.equal(sessionCreates >= 4, true);
  assert.equal(restoreReads, 3);
  assert.equal(rootReads, 2);
  assert.equal(saves, 1);
});

test("GET-only monitor accepts an immediate reboot boundary before status=1 only after full postboot verification", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const source = JSON.parse(fs.readFileSync(SETTINGS_FIXTURE_PATH, "utf8"));
  const status1 = source.status1;
  const baseline = { operator: router.firstText(status1, ["network_name", "ISP_name", "operator"]) };
  const fixture = gateFixture(temporaryState("mf885-immediate-reboot-"), { slotId: core.GOLDEN_RETRY_SLOT_ID });
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  const durableResponse = recordRetryHttpResponse(fixture, { accepted: true });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.POST_ACCEPTED, { recordedAt: FIXED_TIME, evidenceSha256: durableResponse.recordSha256, firmwarePostsAttempted: 1 });

  let sessionCreates = 0, rootReads = 0, saves = 0;
  const routerApi = {
    ...router,
    async createFreshAppSession() {
      sessionCreates += 1;
      if (sessionCreates <= 2) throw Object.assign(new Error("router rebooting"), { code: "ECONNREFUSED" });
      return { localAddress: core.RESTORE_LOCAL_ADDRESS };
    },
    async sessionModelGet(_session, model) {
      if (model === "status1") return { text: status1 };
      throw new Error("Restore status must not be retried after the proven immediate reboot boundary.");
    },
    async routerGetOnce(input) {
      if (input.path === "/") {
        rootReads += 1;
        if (rootReads === 1) throw Object.assign(new Error("router root unavailable"), { code: "ECONNREFUSED" });
        return { statusCode: 200, redirected: false, body: Buffer.from("<html>MF885</html>") };
      }
      throw new Error("unexpected route");
    },
    async collectRestorePreflight() {
      return { report: { identity: router.identityFromStatus(status1), power: { batteryPercent: 100, externalPowerConnected: true }, restoreStatus: { status: "0", progress: "0", cause: "No Error!" }, upgradeStatus: { support32mFlash: "1" }, networkBaseline: baseline, session: { standardDigestSmsReadPassed: true }, safety: { firmwarePostsAttempted: 0 } } };
    }
  };
  const result = await restoreCli.monitorRestore(fixture.directory, fixture.receipt, baseline, {
    routerApi,
    sleep: async () => {},
    statusMaxPolls: 4,
    bootBoundaryMaxPolls: 2,
    postbootMaxPolls: 2,
    saveEvidence() { saves += 1; return { file: "/private/immediate-reboot.json" }; }
  });
  assert.equal(result.state, core.STATES.BOOT_VERIFIED);
  assert.equal(core.inspectTransaction(fixture.directory).last.state, core.STATES.BOOT_VERIFIED);
  assert.equal(core.readJournal(fixture.directory).records.some(record => record.reasonCode === "ROUTER_BOOT_BOUNDARY"), true);
  assert.equal(sessionCreates, 3);
  assert.equal(rootReads, 2);
  assert.equal(saves, 1);
});

test("two semantic auth failures never count as a reboot boundary while the router remains reachable", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const fixture = gateFixture(temporaryState("mf885-auth-not-reboot-"), { slotId: core.GOLDEN_RETRY_SLOT_ID });
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  const durableResponse = recordRetryHttpResponse(fixture, { accepted: true });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.POST_ACCEPTED, { recordedAt: FIXED_TIME, evidenceSha256: durableResponse.recordSha256, firmwarePostsAttempted: 1 });
  let sessionCreates = 0, rootReads = 0;
  const routerApi = {
    ...router,
    async createFreshAppSession() {
      sessionCreates += 1;
      if (sessionCreates <= 2) throw Object.assign(new Error("login rejected"), { code: "ROUTER_AUTH_LOGIN_FAILED" });
      return { localAddress: core.RESTORE_LOCAL_ADDRESS };
    },
    async sessionModelGet() { return { text: "<process><status>0</status><progress>0</progress><cause>No Error!</cause></process>" }; },
    async routerGetOnce() { rootReads += 1; return { statusCode: 200, redirected: false, body: Buffer.from("<html>online</html>") }; }
  };
  await assert.rejects(() => restoreCli.monitorRestore(fixture.directory, fixture.receipt, null, { routerApi, sleep: async () => {}, statusMaxPolls: 3, bootBoundaryMaxPolls: 2, postbootMaxPolls: 2 }), /status did not reach/i);
  const journal = core.readJournal(fixture.directory);
  assert.equal(journal.last.state, core.STATES.UNKNOWN);
  assert.equal(journal.records.some(record => record.reasonCode === "ROUTER_BOOT_BOUNDARY"), false);
  assert.equal(rootReads, 0);
});

test("HTTP redirect after status=1 is reachable, not a reboot boundary", { skip: !HAS_SETTINGS_FIXTURE }, async () => {
  const fixture = gateFixture(temporaryState("mf885-redirect-not-reboot-"), { slotId: core.GOLDEN_RETRY_SLOT_ID });
  core.burnPostAllowance(fixture.directory, fixture.receipt, { armedAt: FIXED_TIME });
  recordExternalFence(fixture);
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.DISPATCH_STARTED, { recordedAt: FIXED_TIME, evidenceSha256: core.GOLDEN_BODY_SHA256, firmwarePostsAttempted: 1 });
  const durableResponse = recordRetryHttpResponse(fixture, { accepted: true });
  core.appendJournal(fixture.directory, fixture.receipt, core.STATES.POST_ACCEPTED, { recordedAt: FIXED_TIME, evidenceSha256: durableResponse.recordSha256, firmwarePostsAttempted: 1 });
  let rootReads = 0;
  const routerApi = {
    ...router,
    async createFreshAppSession() { return { localAddress: core.RESTORE_LOCAL_ADDRESS }; },
    async sessionModelGet() { return { text: "<process><status>1</status><progress>100</progress><cause>Success!</cause></process>" }; },
    async routerGetOnce() { rootReads += 1; return { statusCode: 302, redirected: true, body: Buffer.alloc(0) }; }
  };
  await assert.rejects(() => restoreCli.monitorRestore(fixture.directory, fixture.receipt, null, { routerApi, sleep: async () => {}, statusMaxPolls: 2, bootBoundaryMaxPolls: 2, postbootMaxPolls: 2 }), /reboot boundary was not observed/i);
  const journal = core.readJournal(fixture.directory);
  assert.equal(journal.last.state, core.STATES.UNKNOWN);
  assert.equal(journal.records.some(record => record.reasonCode === "ROUTER_BOOT_BOUNDARY"), false);
  assert.equal(rootReads, 2);
});
