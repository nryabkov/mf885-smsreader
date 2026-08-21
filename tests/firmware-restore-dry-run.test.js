const test = require("node:test");
const assert = require("node:assert/strict");
const dryRun = require("../modules/firmware-restore-dry-run.js");
const stage0 = require("../modules/firmware-stage0.js");

function fixture(bytes = [1, 2, 3, 4]) {
  const data = { getBytes: () => bytes.slice() };
  return {
    data,
    image: {
      id: "synthetic-golden",
      file: "MF885_test_golden.bin",
      size: bytes.length,
      sha256: stage0.sha256Hex(bytes)
    }
  };
}

test("RestoreFw dry-run profile is immutable, labels assumptions, and exposes no sender", () => {
  assert.equal(Object.isFrozen(dryRun.RESTORE_DRY_RUN_PROFILE), true);
  assert.equal(Object.isFrozen(dryRun.RESTORE_DRY_RUN_PROFILE.upload), true);
  assert.equal(dryRun.RESTORE_DRY_RUN_PROFILE.upload.requestPath, "/xml_action.cgi");
  assert.equal(dryRun.RESTORE_DRY_RUN_PROFILE.upload.query, "Action=RestoreFw");
  assert.equal(dryRun.RESTORE_DRY_RUN_PROFILE.upload.multipartMimeType, "application/octet-stream");
  assert.equal(dryRun.RESTORE_DRY_RUN_PROFILE.provenance.multipartField, "conservative-unverified");
  assert.equal(dryRun.RESTORE_DRY_RUN_PROFILE.provenance.multipartFilename, "conservative-unverified");
  assert.equal(typeof dryRun.sendOnce, "undefined");
  assert.equal(typeof dryRun.submit, "undefined");
});

test("dry-run multipart round-trips the exact payload without constructing a network request", () => {
  const input = fixture();
  const manifest = dryRun.verifiedMultipartManifest({ ...input, sha256Hex: stage0.sha256Hex });
  assert.equal(manifest.payloadRoundTripVerified, true);
  assert.equal(manifest.payloadBytes, input.image.size);
  assert.equal(manifest.payloadSha256, input.image.sha256);
  assert.equal(manifest.multipartField, "file");
  assert.equal(manifest.multipartFilename, input.image.file);
  assert.equal(manifest.networkRequestConstructed, false);
  assert.equal(manifest.qualification, false);
  assert.equal(manifest.flashAllowed, false);
  assert.equal(manifest.fixtureAssumptions.multipartFieldProvenance, "conservative-unverified");
  assert.equal(manifest.intendedMethod, "POST");
  assert.match(manifest.boundary, /^----mf885-stage0-dryrun-/);
  assert.match(manifest.bodySha256, /^[0-9a-f]{64}$/);
});

test("native-style extraction rejects tampering and unsafe multipart metadata", () => {
  const input = fixture();
  const built = dryRun.buildDeterministicMultipart(input);
  const extracted = dryRun.extractNativePayload(built.body, built.boundary);
  assert.deepEqual(Array.from(extracted), input.data.getBytes());
  const tampered = built.body.slice();
  tampered[built.payloadOffset] ^= 0xff;
  assert.notEqual(stage0.sha256Hex(dryRun.extractNativePayload(tampered, built.boundary)), input.image.sha256);
  assert.throws(() => dryRun.buildDeterministicMultipart({ ...input, filename: "../private/golden.bin" }), /unsafe.*filename/i);
  assert.throws(() => dryRun.buildDeterministicMultipart({ ...input, field: "file\r\nX-Evil: 1" }), /unsafe.*field/i);
});

test("GetRestoreStatus process schema uses the native raw state map", () => {
  for (const [raw, expected] of [["0", "IDLE"], ["2", "RESTORING"], ["1", "REBOOT_WAIT"], ["3", "FAILED"], ["9", "UNKNOWN"]]) {
    const parsed = dryRun.processStatus(`<process><status>${raw}</status><progress>7</progress><cause>No Error!</cause></process>`);
    assert.equal(parsed.status, raw);
    assert.equal(parsed.progress, "7");
    assert.equal(dryRun.classifyProcessStatus(parsed), expected);
  }
});

test("GET-only trace validation rejects bodies, POST, and RestoreFw", () => {
  const safe = dryRun.validateGetOnlyTrace([
    { method: "GET", query: "login-challenge", bodyPresent: false },
    { method: "GET", query: "method=get&file=GetRestoreStatus", bodyPresent: false }
  ]);
  assert.equal(safe.ok, true);
  assert.equal(safe.routerGetsAttempted, 2);
  assert.equal(safe.firmwarePostsAttempted, 0);
  for (const unsafe of [
    [{ method: "POST", query: "method=get&file=status1", bodyPresent: false }],
    [{ method: "GET", query: "method=get&file=status1", bodyPresent: true }],
    [{ method: "GET", query: "Action=RestoreFw", bodyPresent: false }]
  ]) assert.equal(dryRun.validateGetOnlyTrace(unsafe).ok, false);
});
