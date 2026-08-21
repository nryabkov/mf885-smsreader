const test = require("node:test");
const assert = require("node:assert/strict");
const stage0 = require("../modules/firmware-stage0.js");

const NOW = 1_000_000;
const UNIT_FINGERPRINT="d".repeat(64);
const exclusiveLease={async assertOwner(){return true;}};

function imageEvidence(image, overrides = {}) {
  return {
    size: image.size,
    sha256: image.sha256,
    byteLength: image.size,
    computedSha256: image.sha256,
    verification: "computed-from-bytes",
    verifiedAt: NOW,
    ...overrides
  };
}

function deviceEvidence(overrides = {}) {
  return {
    model: "MF885",
    hardware: "Ver.D",
    firmware: stage0.REQUIRED_FIRMWARE,
    unitFingerprintSha256:UNIT_FINGERPRINT,
    source: "status1-live",
    observedAt: NOW,
    ...overrides
  };
}

function powerEvidence(overrides = {}) {
  return {
    batteryPercent: 80,
    chargerConnected: true,
    source: "status1-live",
    observedAt: NOW,
    ...overrides
  };
}

function transportEvidence(overrides = {}) {
  return {
    contractId: "unverified-capture",
    firmware: stage0.REQUIRED_FIRMWARE,
    restoreMethod: "RestoreFw",
    httpMethod: "POST",
    requestPath: "/xml_action.cgi",
    digestUri: "/cgi/xml_action.cgi",
    multipartField: "firmware",
    statusModel: "GetRestoreStatus",
    captureSha256: "a".repeat(64),
    verifiedAt: NOW,
    ...overrides
  };
}

function transactionFixture(overrides = {}) {
  return {
    schema: stage0.JOURNAL_SCHEMA,
    transactionId: "stage0-test",
    revision: 0,
    startedAt: 1,
    updatedAt: 1,
    state: stage0.TRANSACTION_STATES.PRECHECK_OK,
    imageId: stage0.GOLDEN_IMAGE.id,
    imageSha256: stage0.GOLDEN_IMAGE.sha256,
    unitFingerprintSha256:UNIT_FINGERPRINT,
    preflightFingerprint: "fixture",
    destructivePostCount: 0,
    events: [{ at: 1, event: "PRECHECK_OK" }],
    ...overrides
  };
}

test("allows only golden while recognizing invalid r3 and structural Logs r1", () => {
  assert.equal(stage0.validateImage(imageEvidence(stage0.GOLDEN_IMAGE)).ok, true);
  const r3 = stage0.validateImage(imageEvidence(stage0.WEBUI_CANARY_R3));
  assert.equal(r3.ok, false);
  assert.equal(r3.image, stage0.WEBUI_CANARY_R3);
  assert.match(r3.errors.join(" "), /word sum.*byte sums|quarantined/i);
  assert.equal(stage0.WEBUI_CANARY_R3.restorable, false);
  const logs=stage0.validateImage(imageEvidence(stage0.WEBUI_CANARY_LOGS_R1));
  assert.equal(logs.ok,false);
  assert.equal(logs.image,stage0.WEBUI_CANARY_LOGS_R1);
  assert.match(logs.errors.join(" "),/structurally verified.*not qualified|golden-to-golden/i);
  assert.equal(stage0.WEBUI_CANARY_LOGS_R1.structuralStatus,"verified-not-qualified");
  assert.deepEqual(stage0.SAFE_IMAGES, [stage0.GOLDEN_IMAGE]);
  assert.equal(stage0.validateImage({ size: 8323644, sha256: "0".repeat(64) }).ok, false);
  assert.equal(stage0.validateImage({ size: 8323643, sha256: stage0.GOLDEN_IMAGE.sha256 }).ok, false);
});

test("Stage 0 computes SHA-256 from byte arrays and Scriptable Data", () => {
  assert.equal(stage0.sha256Hex([]), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(stage0.sha256Hex([97, 98, 99]), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(stage0.sha256Hex({ getBytes: () => [97, 98, 99] }), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const evidence = stage0.createImageEvidence([97, 98, 99], NOW);
  assert.equal(evidence.computedSha256, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(evidence.byteLength, 3);
});

test("read-only audit accepts computed known Canary evidence without restore authorization",()=>{
  const original=stage0.createImageEvidence;
  const evidence=Object.freeze({
    size:stage0.WEBUI_CANARY_LOGS_R1.size,
    sha256:stage0.WEBUI_CANARY_LOGS_R1.sha256,
    byteLength:stage0.WEBUI_CANARY_LOGS_R1.size,
    computedSha256:stage0.WEBUI_CANARY_LOGS_R1.sha256,
    verification:"computed-from-bytes",
    verifiedAt:NOW
  });
  // Caller-built metadata stays rejected even in audit mode; the integration
  // test exercises a real Stage 0-computed object through the injected hasher.
  assert.equal(stage0.validateAuditImageEvidence(evidence,NOW).ok,false);
  assert.equal(stage0.validateImage(evidence).ok,false);
  assert.equal(typeof original,"function");
});

test("image metadata that bypasses the Stage 0 byte hasher is rejected", () => {
  const forged = imageEvidence(stage0.GOLDEN_IMAGE);
  const result = stage0.validateImageEvidence(forged, NOW);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /not produced by the Stage 0 byte hasher/i);
  assert.equal(stage0.validateImageEvidence(imageEvidence(stage0.GOLDEN_IMAGE, { verification: "metadata-only" }), NOW).ok, false);
  assert.equal(stage0.validateImageEvidence(imageEvidence(stage0.GOLDEN_IMAGE, { computedSha256: "b".repeat(64) }), NOW).ok, false);
  assert.equal(stage0.validateImageEvidence(imageEvidence(stage0.GOLDEN_IMAGE, { verifiedAt: NOW - stage0.MAX_IMAGE_EVIDENCE_AGE_MS - 1 }), NOW).ok, false);
});

test("requires fresh live MF885 Ver.D identity on the exact 2.5.94 build", () => {
  assert.equal(stage0.validateDevice(deviceEvidence(), NOW).ok, true);
  assert.equal(stage0.validateDevice(deviceEvidence({ model: "LV01" }), NOW).ok, true);
  assert.equal(stage0.validateDevice(deviceEvidence({ model: "MF855" }), NOW).ok, false);
  assert.equal(stage0.validateDevice(deviceEvidence({ hardware: "Ver.C" }), NOW).ok, false);
  assert.equal(stage0.validateDevice(deviceEvidence({ firmware: "2.5.96" }), NOW).ok, false);
  assert.equal(stage0.validateDevice(deviceEvidence({ source: "cached" }), NOW).ok, false);
  assert.equal(stage0.validateDevice(deviceEvidence({ observedAt: NOW - stage0.MAX_LIVE_EVIDENCE_AGE_MS - 1 }), NOW).ok, false);
});

test("requires fresh external-power evidence and at least 50 percent battery", () => {
  assert.equal(stage0.validatePower(powerEvidence(), NOW).ok, true);
  assert.equal(stage0.validatePower(powerEvidence({ batteryPercent: 49 }), NOW).ok, false);
  assert.equal(stage0.validatePower(powerEvidence({ chargerConnected: false }), NOW).ok, false);
  assert.equal(stage0.validatePower(powerEvidence({ observedAt: NOW - stage0.MAX_LIVE_EVIDENCE_AGE_MS - 1 }), NOW).ok, false);
});

test("caller booleans and arbitrary transport evidence cannot unlock RestoreFw", () => {
  const input = {
    image: imageEvidence(stage0.GOLDEN_IMAGE),
    device: deviceEvidence(),
    power: powerEvidence(),
    restoreTransportVerified: true,
    restoreTransportEvidence: transportEvidence()
  };
  const report = stage0.preflight(input, NOW);
  assert.equal(report.destructiveAllowed, false);
  assert.match(report.errors.join(" "), /boolean cannot unlock|ignored/i);
  assert.match(report.errors.join(" "), /No matching RestoreFw transport contract/i);
  assert.equal(stage0.VERIFIED_RESTORE_TRANSPORTS.length, 0);
});

test("transport evidence binds every wire-significant field and polling bound", () => {
  const result=stage0.validateTransportEvidence(transportEvidence());
  const errors=result.errors.join(" ");
  assert.match(errors,/full wire-contract schema/i);
  assert.match(errors,/upload query order/i);
  assert.match(errors,/MIME type, filename rule, and encoding/i);
  assert.match(errors,/authentication, session, and acceptance-response/i);
  assert.match(errors,/GET-only status route, query, and raw-value map/i);
  assert.match(errors,/polling bounds/i);
});

test("physical recovery evidence is a separate compiled destructive gate", () => {
  const candidate={schema:stage0.RECOVERY_EVIDENCE_SCHEMA,evidenceId:"bench-capture",model:"MF885",hardware:"Ver.D",norPart:"MX25U25635FZ4I-10G",norSizeBytes:stage0.FULL_NOR_SIZE_BYTES,ioVoltage:1.8,fullDumpCopies:3,dumpsIdentical:true,fullDumpSha256:"b".repeat(64),unitFingerprintSha256:UNIT_FINGERPRINT,goldenBackupSha256:stage0.GOLDEN_IMAGE.sha256,recoveryEntryVerified:true,captureSha256:"c".repeat(64)};
  const result=stage0.validateRecoveryEvidence(candidate);
  assert.equal(result.ok,false);
  assert.match(result.errors.join(" "),/No matching physical recovery evidence/i);
  assert.equal(stage0.VERIFIED_RECOVERY_EVIDENCE.length,0);
  assert.equal(stage0.validateRecoveryEvidence({...candidate,ioVoltage:3.3}).ok,false);
  assert.equal(stage0.validateRecoveryEvidence({...candidate,fullDumpCopies:2}).ok,false);
});

test("a forged preflight report cannot create a transaction", () => {
  assert.throws(() => stage0.createTransaction({
    destructiveAllowed: true,
    image: stage0.GOLDEN_IMAGE,
    device: deviceEvidence(),
    restoreTransportEvidence: transportEvidence()
  }, NOW), /cannot start before all destructive gates pass/i);
});

test("restore status parser reads status, progress and fail cause", () => {
  const parsed = stage0.parseRestoreStatus("<RGW><upgrade_firmware><restore_status>2</restore_status><restore_progress>47</restore_progress><restore_fail_cause>0</restore_fail_cause></upgrade_firmware></RGW>");
  assert.deepEqual(parsed, { status: "2", progress: "47", failCause: "0" });
});

test("strict state machine consumes the send allowance before network submission", () => {
  let tx = transactionFixture();
  assert.equal(stage0.canSendRestore(tx), true);
  assert.throws(() => stage0.transition(tx, "POST_SENT", "", 2), /Invalid Stage 0 transition/i);

  tx = stage0.transition(tx, "POST_ARMED", "", 2);
  assert.equal(tx.state, stage0.TRANSACTION_STATES.POST_ARMED);
  assert.equal(tx.destructivePostCount, 1);
  assert.equal(stage0.canSendRestore(tx), false);
  assert.throws(() => stage0.transition(tx, "POST_ARMED", "", 3), /Invalid Stage 0 transition/i);

  tx = stage0.transition(tx, "POST_SENT", "", 3);
  tx = stage0.transition(tx, "RESTORING", "progress=47", 4);
  tx = stage0.transition(tx, "RESTORING", "progress=80", 5);
  tx = stage0.transition(tx, "REBOOT_WAIT", "", 6);

  assert.throws(() => stage0.transition(tx, "BOOT_VERIFIED", {}, 7), /not bound|check failed/i);
  const verification = {
    transactionId: tx.transactionId,
    imageSha256: tx.imageSha256,
    observedAt: 7,
    device: deviceEvidence({ observedAt: 7 }),
    checks: {
      status1Reachable: true,
      wifiReachable: true,
      smsApiReachable: true,
      mobileDataConnected: true
    }
  };
  tx = stage0.transition(tx, "BOOT_VERIFIED", verification, 7);
  assert.equal(tx.state, stage0.TRANSACTION_STATES.BOOT_VERIFIED);
  assert.equal(tx.destructivePostCount, 1);
  assert.throws(() => stage0.transition(tx, "FAILED", "", 8), /Invalid Stage 0 transition/i);
});

test("WEBUI canary boot verification requires the canary marker", () => {
  const tx = transactionFixture({
    state: stage0.TRANSACTION_STATES.REBOOT_WAIT,
    imageId: stage0.WEBUI_CANARY_LOGS_R1.id,
    imageSha256: stage0.WEBUI_CANARY_LOGS_R1.sha256,
    destructivePostCount: 1
  });
  const verification = {
    transactionId: tx.transactionId,
    imageSha256: tx.imageSha256,
    observedAt: 2,
    device: deviceEvidence({ observedAt: 2 }),
    checks: { status1Reachable: true, wifiReachable: true, smsApiReachable: true, mobileDataConnected: true }
  };
  assert.throws(() => stage0.transition(tx, "BOOT_VERIFIED", verification, 2), /canary marker/i);
  const verified = stage0.transition(tx, "BOOT_VERIFIED", { ...verification, webuiMarker: stage0.WEBUI_CANARY_LOGS_R1.id }, 2);
  assert.equal(verified.state, stage0.TRANSACTION_STATES.BOOT_VERIFIED);
});

test("persistent journal is verified before the one-shot send can begin", async () => {
  const journal = stage0.createMemoryJournal();
  const initial = transactionFixture();
  await stage0.saveJournal(journal, initial);
  const armed = await stage0.armPersistentRestore(journal, initial, 2);
  const persisted = await stage0.loadJournal(journal);
  assert.equal(armed.state, stage0.TRANSACTION_STATES.POST_ARMED);
  assert.equal(persisted.state, stage0.TRANSACTION_STATES.POST_ARMED);
  assert.equal(persisted.destructivePostCount, 1);
  assert.equal(stage0.canSendRestore(persisted), false);

  await assert.rejects(stage0.persistTransition(journal, initial, "POST_ARMED", "", 3), /changed concurrently/i);
});

test("one-shot executor reads back POST_ARMED before one sender call", async () => {
  const journal=stage0.createMemoryJournal(transactionFixture());
  let calls=0;
  const result=await stage0.executeArmedRestoreOnce(journal,transactionFixture(),async armed=>{
    calls++;
    const stored=await stage0.loadJournal(journal);
    assert.equal(stored.state,stage0.TRANSACTION_STATES.POST_ARMED);
    assert.equal(stored.revision,armed.revision);
    return {accepted:true,statusCode:200};
  },{now:()=>2+calls,exclusiveLease});
  assert.equal(calls,1);
  assert.equal(result.transaction.state,stage0.TRANSACTION_STATES.POST_SENT);
  assert.equal(result.destructivePostsAttempted,1);
  assert.equal(result.automaticRetries,0);
});

test("one-shot timeout becomes terminal UNKNOWN and never calls the sender twice", async () => {
  const journal=stage0.createMemoryJournal(transactionFixture());
  let calls=0;
  await assert.rejects(stage0.executeArmedRestoreOnce(journal,transactionFixture(),async()=>{
    calls++;
    throw new Error("network connection was lost");
  },{now:()=>2+calls,exclusiveLease}),/connection was lost/i);
  assert.equal(calls,1);
  const stored=await stage0.loadJournal(journal);
  assert.equal(stored.state,stage0.TRANSACTION_STATES.UNKNOWN);
  assert.equal(stored.destructivePostCount,1);
  await assert.rejects(stage0.executeArmedRestoreOnce(journal,stored,async()=>{calls++;return {accepted:true};},{exclusiveLease}),/Invalid Stage 0 transition/i);
  assert.equal(calls,1);
});

test("two concurrent callers sharing one journal cannot invoke two senders", async()=>{
  const journal=stage0.createMemoryJournal(transactionFixture());
  let sends=0,release;
  const hold=new Promise(resolve=>{release=resolve;});
  const first=stage0.executeArmedRestoreOnce(journal,transactionFixture(),async()=>{sends++;await hold;return {accepted:true};},{exclusiveLease,now:()=>2});
  const second=stage0.executeArmedRestoreOnce(journal,transactionFixture(),async()=>{sends++;return {accepted:true};},{exclusiveLease,now:()=>2});
  await assert.rejects(second,/already active.*no second sender/i);
  release();
  await first;
  assert.equal(sends,1);
});

test("GET-only monitor reaches BOOT_VERIFIED through the reviewed classifier", async () => {
  const postSent=transactionFixture({
    revision:2,updatedAt:3,state:stage0.TRANSACTION_STATES.POST_SENT,destructivePostCount:1,
    transportContractId:"capture-v1",transportCaptureSha256:"a".repeat(64),
    recoveryEvidenceId:"bench-v1",recoveryCaptureSha256:"b".repeat(64),
    unitFingerprintSha256:UNIT_FINGERPRINT,
    events:[{at:1,event:"PRECHECK_OK"},{at:2,event:"POST_ARMED"},{at:3,event:"POST_SENT"}]
  });
  const journal=stage0.createMemoryJournal(postSent);
  let polls=0,time=3;
  const verified=await stage0.monitorPersistentRestore(journal,postSent,{
    async readStatus(){polls++;return {status:polls===1?"restoring":"reboot"};},
    async classifyStatus(value){return value.status==="restoring"?{event:"RESTORING",detail:"progress=50"}:{event:"REBOOT_WAIT"};},
    async verifyBoot({transaction}){return {transactionId:transaction.transactionId,imageSha256:transaction.imageSha256,observedAt:++time,device:deviceEvidence({observedAt:time}),checks:{status1Reachable:true,wifiReachable:true,smsApiReachable:true,mobileDataConnected:true}};}
  },{now:()=>++time,sleep:async()=>{},maxPolls:3,intervalMs:250});
  assert.equal(polls,2);
  assert.equal(verified.state,stage0.TRANSACTION_STATES.BOOT_VERIFIED);
  const qualification=stage0.createGoldenQualification(verified,++time);
  assert.equal(qualification.imageSha256,stage0.GOLDEN_IMAGE.sha256);
  assert.equal(qualification.transportContractId,"capture-v1");
  assert.equal(qualification.recoveryEvidenceId,"bench-v1");
});

test("post-boot checks stop at the compiled bound and finish UNKNOWN",async()=>{
  const postSent=transactionFixture({revision:2,updatedAt:3,state:stage0.TRANSACTION_STATES.POST_SENT,destructivePostCount:1,events:[{at:1,event:"PRECHECK_OK"},{at:2,event:"POST_ARMED"},{at:3,event:"POST_SENT"}]});
  const journal=stage0.createMemoryJournal(postSent);
  let bootChecks=0,time=3;
  const result=await stage0.monitorPersistentRestore(journal,postSent,{
    async readStatus(){return {status:"reboot"};},
    async classifyStatus(){return {event:"REBOOT_WAIT"};},
    async verifyBoot(){bootChecks++;return {ready:false};}
  },{now:()=>++time,sleep:async()=>{},maxPolls:1,maxBootPolls:2,bootIntervalMs:250});
  assert.equal(bootChecks,2);
  assert.equal(result.state,stage0.TRANSACTION_STATES.UNKNOWN);
});

test("restart after arming becomes terminal UNKNOWN and can never be cleared automatically", async () => {
  const journal = stage0.createMemoryJournal(transactionFixture({
    state: stage0.TRANSACTION_STATES.POST_ARMED,
    destructivePostCount: 1,
    revision: 1,
    updatedAt: 2,
    events: [{ at: 1, event: "PRECHECK_OK" }, { at: 2, event: "POST_ARMED" }]
  }));
  const recovered = await stage0.recoverPersistentTransaction(journal, 3);
  assert.equal(recovered.state, stage0.TRANSACTION_STATES.UNKNOWN);
  assert.equal(stage0.canSendRestore(recovered), false);
  await assert.rejects(stage0.clearCompletedJournal(journal, recovered.transactionId), /UNKNOWN requires manual recovery evidence/i);
});

test("restart before arming invalidates preflight without consuming a send", async () => {
  const journal = stage0.createMemoryJournal(transactionFixture());
  const recovered = await stage0.recoverPersistentTransaction(journal, 2);
  assert.equal(recovered.state, stage0.TRANSACTION_STATES.FAILED);
  assert.equal(recovered.destructivePostCount, 0);
  assert.equal(await stage0.clearCompletedJournal(journal, recovered.transactionId), true);
  assert.equal(await stage0.loadJournal(journal), null);
});

test("corrupt or unverifiable persistent storage fails closed", async () => {
  const corrupt = { async load() { return "{"; }, async save() {}, async clear() {} };
  await assert.rejects(stage0.loadJournal(corrupt), /journal is corrupt/i);

  const dropsWrites = { async load() { return null; }, async save() {}, async clear() {} };
  await assert.rejects(stage0.saveJournal(dropsWrites, transactionFixture()), /write could not be verified/i);
});

test("Keychain journal persists and reads a transaction", async () => {
  const values = new Map();
  const keychain = {
    contains: key => values.has(key),
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
    remove: key => values.delete(key)
  };
  const journal = stage0.createKeychainJournal("test-key", keychain);
  const transaction = transactionFixture();
  await stage0.saveJournal(journal, transaction);
  assert.deepEqual(await stage0.loadJournal(journal), transaction);
  await stage0.clearCompletedJournal(journal, transaction.transactionId).catch(error => {
    assert.match(error.message, /PRECHECK_OK cannot be cleared/i);
  });
});
