const test = require('node:test');
const assert = require('node:assert/strict');
const stage0 = require('../modules/firmware-stage0.js');

const device = {
  model: 'MF885',
  hardware: 'Ver.D',
  firmware: stage0.REQUIRED_FIRMWARE
};
const power = { batteryPercent: 80, chargerConnected: true };

function imageMeta(image) {
  return { size: image.size, sha256: image.sha256 };
}

test('allows only exact golden and WEBUI canary SHA-256 values', () => {
  assert.equal(stage0.validateImage(imageMeta(stage0.GOLDEN_IMAGE)).ok, true);
  assert.equal(stage0.validateImage(imageMeta(stage0.WEBUI_CANARY_R3)).ok, true);
  assert.equal(stage0.validateImage({ size: 8323644, sha256: '0'.repeat(64) }).ok, false);
  assert.equal(stage0.validateImage({ size: 8323643, sha256: stage0.GOLDEN_IMAGE.sha256 }).ok, false);
});

test('requires exact MF885 Ver.D and exact 2.5.94 base firmware', () => {
  assert.equal(stage0.validateDevice(device).ok, true);
  assert.equal(stage0.validateDevice({ ...device, model: 'MF855' }).ok, false);
  assert.equal(stage0.validateDevice({ ...device, hardware: 'Ver.C' }).ok, false);
  assert.equal(stage0.validateDevice({ ...device, firmware: '2.5.96' }).ok, false);
});

test('requires external power and at least 50 percent battery', () => {
  assert.equal(stage0.validatePower(power).ok, true);
  assert.equal(stage0.validatePower({ batteryPercent: 49, chargerConnected: true }).ok, false);
  assert.equal(stage0.validatePower({ batteryPercent: 80, chargerConnected: false }).ok, false);
});

test('destructive gate stays locked until RestoreFw transport is live-verified', () => {
  const locked = stage0.preflight({ image: imageMeta(stage0.GOLDEN_IMAGE), device, power, restoreTransportVerified: false });
  assert.equal(locked.destructiveAllowed, false);
  assert.match(locked.errors.join(' '), /transport is not live-verified/i);

  const unlocked = stage0.preflight({ image: imageMeta(stage0.GOLDEN_IMAGE), device, power, restoreTransportVerified: true });
  assert.equal(unlocked.destructiveAllowed, true);
});

test('restore status parser reads status, progress and fail cause', () => {
  const parsed = stage0.parseRestoreStatus('<RGW><upgrade_firmware><restore_status>2</restore_status><restore_progress>47</restore_progress><restore_fail_cause>0</restore_fail_cause></upgrade_firmware></RGW>');
  assert.deepEqual(parsed, { status: '2', progress: '47', failCause: '0' });
});

test('transaction state machine permits exactly one destructive POST', () => {
  const report = stage0.preflight({ image: imageMeta(stage0.WEBUI_CANARY_R3), device, power, restoreTransportVerified: true });
  let tx = stage0.createTransaction(report, 1);
  assert.equal(stage0.canSendRestore(tx), true);
  tx = stage0.transition(tx, 'POST_SENT', '', 2);
  assert.equal(stage0.canSendRestore(tx), false);
  assert.equal(tx.destructivePostCount, 1);
  assert.throws(() => stage0.transition(tx, 'POST_SENT', '', 3), /must never be retried/i);
  tx = stage0.transition(tx, 'RESTORING', 'progress=47', 4);
  tx = stage0.transition(tx, 'REBOOT_WAIT', '', 5);
  tx = stage0.transition(tx, 'BOOT_VERIFIED', '', 6);
  assert.equal(tx.state, stage0.TRANSACTION_STATES.BOOT_VERIFIED);
  assert.equal(tx.destructivePostCount, 1);
});
