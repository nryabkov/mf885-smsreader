const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");
const stage0 = require("../modules/firmware-stage0.js");

const NOW = 1_000_000;
const STATUS = `<?xml version="1.0"?><RGW>
  <model>LV01</model>
  <revision>Ver.D</revision>
  <version_num>${stage0.REQUIRED_FIRMWARE}</version_num>
  <batteryinfo><Battery_percent>80</Battery_percent><Battery_status>1</Battery_status><Charger_status>0</Charger_status></batteryinfo>
</RGW>`;

function acceptedStage0() {
  return {
    ...stage0,
    createImageEvidence() {
      return Object.freeze({
        size: stage0.WEBUI_CANARY_R3.size,
        sha256: stage0.WEBUI_CANARY_R3.sha256,
        byteLength: stage0.WEBUI_CANARY_R3.size,
        computedSha256: stage0.WEBUI_CANARY_R3.sha256,
        verification: "computed-from-bytes",
        verifiedAt: NOW
      });
    },
    validateImageEvidence() {
      return { ok: true, image: stage0.WEBUI_CANARY_R3, errors: [] };
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
    documentPicker: { openFile: async () => "/private/mobile/Documents/MF885_Community_0.0-canary-webui-r3.bin" },
    fileManager: {
      async downloadFileFromiCloud() { downloads++; },
      read() { reads++; return [1, 2, 3]; }
    },
    getStatus: async () => { statusReads++; return STATUS; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.readyForTransportCapture, true);
  assert.equal(result.flashAllowed, false);
  assert.equal(result.report.selectedFile.name, stage0.WEBUI_CANARY_R3.file);
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
    validateImageEvidence() { return { ok: false, image: null, errors: ["Image SHA-256 is not present in the Stage 0 allowlist."] }; }
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
