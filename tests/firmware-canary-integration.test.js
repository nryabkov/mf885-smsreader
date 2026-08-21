const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");
const stage0 = require("../modules/firmware-stage0.js");

const NOW = 1_000_000;
const STATUS = `<?xml version="1.0"?><RGW>
  <model>LV01</model>
  <imei>359762080000001</imei>
  <revision>Ver.D</revision>
  <version_num>${stage0.REQUIRED_FIRMWARE}</version_num>
  <batteryinfo><Battery_percent>80</Battery_percent><Battery_status>1</Battery_status><Charger_status>0</Charger_status></batteryinfo>
</RGW>`;

function acceptedStage0() {
  return {
    ...stage0,
    createImageEvidence() {
      return Object.freeze({
        size: stage0.WEBUI_CANARY_LOGS_R1.size,
        sha256: stage0.WEBUI_CANARY_LOGS_R1.sha256,
        byteLength: stage0.WEBUI_CANARY_LOGS_R1.size,
        computedSha256: stage0.WEBUI_CANARY_LOGS_R1.sha256,
        verification: "computed-from-bytes",
        verifiedAt: NOW
      });
    },
    validateAuditImageEvidence() {
      return { ok: true, image: stage0.WEBUI_CANARY_LOGS_R1, errors: [] };
    }
  };
}

test("Scriptable canary validation reads the selected bytes and one fresh status without a flash POST", async () => {
  let downloads = 0;
  let reads = 0;
  let statusReads = 0;
  const result = await app.validateFirmwareCanary({}, {
    stage0: acceptedStage0(),
    now: () => NOW,
    documentPicker: { openFile: async () => "/private/mobile/Documents/MF885_Community_0.0-logs-r1.bin" },
    fileManager: {
      async downloadFileFromiCloud() { downloads++; },
      read() { reads++; return [1, 2, 3]; }
    },
    getStatus: async () => { statusReads++; return STATUS; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.readyForTransportCapture, true);
  assert.equal(result.flashAllowed, false);
  assert.equal(result.report.selectedFile.name, stage0.WEBUI_CANARY_LOGS_R1.file);
  assert.equal(result.report.image.match, true);
  assert.equal(result.report.device.model, "LV01");
  assert.equal(result.report.device.ok, true);
  assert.equal(result.report.power.chargerConnected, true);
  assert.equal(result.report.power.ok, true);
  assert.equal(result.report.restoreTransport.allowlistedContracts, 0);
  assert.deepEqual(result.report.safety, {
    routerReadsAttempted: 1,
    routerWritesAttempted: 0,
    firmwarePostsAttempted: 0,
    automaticRetries: 0,
    flashAllowed: false
  });
  assert.equal(downloads, 1);
  assert.equal(reads, 1);
  assert.equal(statusReads, 1);
  assert.doesNotMatch(result.text, /private\/mobile/);
});

test("a non-canary file fails before contacting the router", async () => {
  let statusReads = 0;
  const rejectedStage0 = {
    ...acceptedStage0(),
    validateAuditImageEvidence() { return { ok: false, image: null, errors: ["Image SHA-256 is not a recognized audited MF885 artifact."] }; }
  };
  const result = await app.validateFirmwareCanary({}, {
    stage0: rejectedStage0,
    now: () => NOW,
    documentPicker: { openFile: async () => "/tmp/not-the-canary.bin" },
    fileManager: { read() { return [9]; } },
    getStatus: async () => { statusReads++; return STATUS; }
  });

  assert.equal(result.ok, false);
  assert.equal(result.readyForTransportCapture, false);
  assert.equal(result.flashAllowed, false);
  assert.equal(result.report.safety.routerReadsAttempted, 0);
  assert.equal(result.report.safety.firmwarePostsAttempted, 0);
  assert.equal(statusReads, 0);
});

test("cancelling the native file picker does not read files or contact the router", async () => {
  let reads = 0;
  const result = await app.validateFirmwareCanary({}, {
    stage0: acceptedStage0(),
    documentPicker: { openFile: async () => "" },
    fileManager: { read() { reads++; return []; } },
    getStatus: async () => { throw new Error("must not be called"); }
  });
  assert.deepEqual(result, { cancelled: true, ok: false, flashAllowed: false });
  assert.equal(reads, 0);
});

test("Stage 0 restore is compiled but makes zero calls while the transport allowlist is empty", async () => {
  let pickerCalls=0,statusReads=0,sends=0;
  await assert.rejects(app.runFirmwareRestore({}, {
    stage0,
    documentPicker:{async openFile(){pickerCalls++;return "/tmp/golden.bin";}},
    fileManager:{read(){throw new Error("must not read");}},
    getStatus:async()=>{statusReads++;return STATUS;},
    transportAdapter:{
      safety:{destructivePostLimit:1,automaticRetries:0,redirectsAllowed:false,statusHttpMethod:"GET"},
      async prepare(){},async sendOnce(){sends++;return {accepted:true};},async readStatus(){},async classifyStatus(){},async verifyBoot(){}
    }
  }),/Locked until the exact RestoreFw/i);
  assert.equal(pickerCalls,0);
  assert.equal(statusReads,0);
  assert.equal(sends,0);
});

test("software-only restore requires the explicit no-recovery native phrase",async()=>{
  let observed=null;
  const accepted=await app.confirmFirmwareRestore(
    stage0.GOLDEN_IMAGE,
    {model:"MF885",hardware:"Ver.D",unitFingerprintSha256:"d".repeat(64)},
    {batteryPercent:100},
    {contractId:"restore-v1",captureSha256:"a".repeat(64)},
    {profile:stage0.SOFTWARE_RISK_PROFILE,evidenceId:"software-risk-v1"},
    {confirm:async value=>{observed=value;return true;}}
  );
  assert.equal(accepted,true);
  assert.equal(observed.phrase,`NO RECOVERY FLASH ${stage0.GOLDEN_IMAGE.sha256.slice(0,12)}`);
  assert.equal(observed.risk.profile,stage0.SOFTWARE_RISK_PROFILE);
});

test("compiled Stage 0 flow rehashes the same Data and submits exactly once after native confirmation", async () => {
  const timeline=[];
  const data={getBytes:()=>[1,2,3]};
  const tx={transactionId:"stage0-live",state:"POST_SENT",imageId:stage0.GOLDEN_IMAGE.id,imageSha256:stage0.GOLDEN_IMAGE.sha256,unitFingerprintSha256:"d".repeat(64),destructivePostCount:1};
  let evidenceCalls=0,statusReads=0,reads=0,sends=0,savedQualification=0;
  const fakeStage0={
    ...stage0,
    restoreAvailability:()=>({available:true,allowlistedContracts:1,recoveryEvidenceRecords:1,reason:"reviewed"}),
    createImageEvidence(value){assert.equal(value,data);evidenceCalls++;timeline.push(`hash${evidenceCalls}`);return {size:stage0.GOLDEN_IMAGE.size,sha256:stage0.GOLDEN_IMAGE.sha256};},
    validateImageEvidence:()=>({ok:true,image:stage0.GOLDEN_IMAGE,errors:[]}),
    loadJournal:async()=>null,
    preflight:input=>({destructiveAllowed:true,image:stage0.GOLDEN_IMAGE,device:input.device,power:input.power,restoreTransportEvidence:input.restoreTransportEvidence,recoveryEvidence:input.recoveryEvidence,errors:[]}),
    async executePersistentRestoreOnce(_journal,_report,sendOnce){timeline.push("armed");const result=await sendOnce(tx);assert.equal(result.accepted,true);return {transaction:tx};},
    async monitorPersistentRestore(){timeline.push("get-status-monitor");return {...tx,state:stage0.TRANSACTION_STATES.BOOT_VERIFIED};},
    createGoldenQualification:()=>({transactionId:tx.transactionId,transportCaptureSha256:"a".repeat(64),recoveryCaptureSha256:"b".repeat(64),unitFingerprintSha256:"d".repeat(64)})
  };
  const transportEvidence=Object.freeze({contractId:"restore-capture-v1",captureSha256:"a".repeat(64),adapterArtifactSha256:"e".repeat(64),exclusiveLeaseProfile:"test-atomic-lease-v1",maxStatusPolls:10,statusPollIntervalMs:1000,maxBootPolls:10,bootPollIntervalMs:1000});
  const recoveryEvidence=Object.freeze({evidenceId:"bench-v1",captureSha256:"b".repeat(64)});
  const adapter={
    artifactSha256:"e".repeat(64),safety:{destructivePostLimit:1,automaticRetries:0,redirectsAllowed:false,statusHttpMethod:"GET",platformExclusiveLease:true,exclusiveLeaseProfile:"test-atomic-lease-v1"},transportEvidence,recoveryEvidence,
    async prepare(){timeline.push("prepare");statusReads++;timeline.push(`status${statusReads}`);return {session:"sealed",status:STATUS,statusObservedAt:NOW,exclusiveLease:{async assertOwner(){return true;}}};},
    async sendOnce(input){sends++;timeline.push("post");assert.equal(input.data,data);return {accepted:true};},
    async readStatus(){},async classifyStatus(){},async verifyBoot(){}
  };
  const result=await app.runFirmwareRestore({}, {
    stage0:fakeStage0,transportAdapter:adapter,now:()=>NOW,
    documentPicker:{async openFile(){timeline.push("pick");return "/private/mobile/Documents/golden.bin";}},
    fileManager:{read(){reads++;return data;}},
    journal:{async load(){return null;},async save(){},async clear(){}},
    qualificationStore:{async load(){return null;},async save(){savedQualification++;}},
    getStatus:async()=>{statusReads++;timeline.push(`status${statusReads}`);return STATUS;},
    confirm:async()=>{timeline.push("confirm");return true;},sleep:async()=>{}
  });
  assert.equal(result.ok,true);
  assert.equal(result.state,stage0.TRANSACTION_STATES.BOOT_VERIFIED);
  assert.equal(reads,1);
  assert.equal(statusReads,2);
  assert.equal(evidenceCalls,2);
  assert.equal(sends,1);
  assert.equal(savedQualification,1);
  assert.ok(timeline.indexOf("confirm")<timeline.indexOf("prepare"));
  assert.ok(timeline.indexOf("armed")<timeline.indexOf("post"));
  assert.doesNotMatch(result.text,/private\/mobile/);
});

test("journal status recovers an interrupted armed run to non-clearable UNKNOWN",async()=>{
  const transaction={schema:stage0.JOURNAL_SCHEMA,transactionId:"interrupted",revision:1,startedAt:1,updatedAt:2,state:stage0.TRANSACTION_STATES.POST_ARMED,imageId:stage0.GOLDEN_IMAGE.id,imageSha256:stage0.GOLDEN_IMAGE.sha256,unitFingerprintSha256:"d".repeat(64),riskProfile:"physical-nor-v1",riskEvidenceId:"bench-v1",riskCaptureSha256:"b".repeat(64),preflightFingerprint:"fixture",destructivePostCount:1,events:[{at:1,event:"PRECHECK_OK"},{at:2,event:"POST_ARMED"}]};
  const journal=stage0.createMemoryJournal(transaction);
  const result=await app.readFirmwareJournalStatus({stage0,journal,now:()=>3});
  assert.equal(result.transaction.state,stage0.TRANSACTION_STATES.UNKNOWN);
  assert.equal(result.clearable,false);
  assert.equal(result.unknownLocked,true);
  await assert.rejects(app.acknowledgeFirmwareJournal({stage0,journal}),/UNKNOWN requires manual recovery evidence/i);
});

test("completed golden journal can clear only after its qualification was saved",async()=>{
  const transaction={schema:stage0.JOURNAL_SCHEMA,transactionId:"golden-complete",revision:5,startedAt:1,updatedAt:6,state:stage0.TRANSACTION_STATES.BOOT_VERIFIED,imageId:stage0.GOLDEN_IMAGE.id,imageSha256:stage0.GOLDEN_IMAGE.sha256,unitFingerprintSha256:"d".repeat(64),riskProfile:"physical-nor-v1",riskEvidenceId:"bench-v1",riskCaptureSha256:"b".repeat(64),preflightFingerprint:"fixture",destructivePostCount:1,events:[{at:1,event:"PRECHECK_OK"},{at:2,event:"POST_ARMED"},{at:3,event:"POST_SENT"},{at:4,event:"RESTORING"},{at:5,event:"REBOOT_WAIT"},{at:6,event:"BOOT_VERIFIED"}]};
  const missingJournal=stage0.createMemoryJournal(transaction);
  await assert.rejects(app.acknowledgeFirmwareJournal({stage0,journal:missingJournal,qualificationStore:{async load(){return null;}}}),/qualification is missing/i);
  const journal=stage0.createMemoryJournal(transaction);
  const result=await app.acknowledgeFirmwareJournal({stage0,journal,qualificationStore:{async load(){return {transactionId:transaction.transactionId,unitFingerprintSha256:transaction.unitFingerprintSha256};}}});
  assert.equal(result.cleared,true);
  assert.equal(await stage0.loadJournal(journal),null);
});

test("firmware-exclusive mode rejects other router actions until journal acknowledgement",async()=>{
  const guard=()=>app.createInFlightGuard();
  const web={async evaluateJavaScript(){return null;}};
  const dispatcher=app.createDashboardDispatcher({}, {sms:{messages:[]}}, web, {smsGuard:guard(),refreshGuard:guard(),powerGuard:guard(),firmwareGuard:guard()}, {
    runFirmwareRestore:async()=>({ok:false,state:"UNKNOWN"}),
    readFirmwareJournalStatus:async()=>({present:true,transaction:{state:"UNKNOWN"},clearable:false}),
    acknowledgeFirmwareJournal:async()=>({cleared:true})
  });
  const flash=await dispatcher({id:"f1",action:"firmwareFlash",params:{confirmed:true}});
  assert.equal(flash.ok,true);
  const refresh=await dispatcher({id:"f2",action:"refresh",params:{}});
  assert.equal(refresh.ok,false);
  assert.match(refresh.error,/Firmware-exclusive mode/i);
  const ack=await dispatcher({id:"f3",action:"firmwareJournalAcknowledge",params:{confirmed:true}});
  assert.equal(ack.ok,true);
  const status=await dispatcher({id:"f4",action:"firmwareJournalStatus",params:{}});
  assert.equal(status.ok,true);
});
