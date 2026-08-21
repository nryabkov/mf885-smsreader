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

function exactAuthorization(nc = "00000004") {
  const realm = "router", nonce = "nonce", cnonce = "b".repeat(16);
  const md5 = value => crypto.createHash("md5").update(value, "utf8").digest("hex");
  const response = md5(`${md5(`admin:${realm}:zimifi`)}:${nonce}:${nc}:${cnonce}:auth:${md5("POST:/cgi/xml_action.cgi")}`);
  return `Digest username="admin", realm="${realm}", nonce="${nonce}", uri="/cgi/xml_action.cgi", response="${response}", qop=auth, nc=${nc}, cnonce="${cnonce}"`;
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

function goldenCapsule() {
  if (!HAS_GOLDEN_FIXTURE) return null;
  return router.buildGoldenRestoreCapsule(GOLDEN_FIXTURE_PATH);
}

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
      } finally { transport.restore(); fence.restore(); }
    });
  }
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
