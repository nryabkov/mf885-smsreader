const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../scriptable-ui.js');
const exactIdentity = { actualModel: 'LV01', actualFirmware: '2.5.94_release_MF855_NZ_CP_2.129.003' };

test('LV01 is displayed as MF885 without rewriting other router models', () => {
  assert.equal(adapter.uiDeviceModel('LV01'), 'MF885');
  assert.equal(adapter.uiDeviceModel('lv01'), 'MF885');
  assert.equal(adapter.uiDeviceModel('MF855'), 'MF855');
});

test('LV01 status 1 with charger substatus 4 is full and activates micro-USB input', () => {
  const battery = adapter.normalizeUiBattery({
    percent: 74,
    rawStatus: '1',
    chargerStatus: '4',
    rawChargerStatus: '4',
    chargerCurrent: null,
    outputCurrent: 0,
    inputConnected: false,
    chargerConnected: false,
    usbOutputActive: false,
    usbHostActive: false,
    state: 'discharging',
    powerStatus: 'discharging',
    status: 'Discharging'
  }, exactIdentity);
  assert.equal(battery.inputConnected, true);
  assert.equal(battery.chargerConnected, true);
  assert.equal(battery.powerStatus, 'full');
  assert.equal(battery.status, 'Full');
});

test('LV01 status 1 with charger substatus 0 is normal charging even at 100 percent', () => {
  const battery = adapter.normalizeUiBattery({
    percent: 100,
    rawStatus: '1', rawChargerStatus: '0', chargerCurrent: 0,
    inputConnected: false, usbOutputActive: false,
    powerStatus: 'discharging'
  }, exactIdentity);
  assert.equal(battery.inputConnected, true);
  assert.equal(battery.powerStatus, 'charging');
  assert.equal(battery.status, 'Charging');
});

test('LV01 live 1/0 signature activates the charging input', () => {
  const battery = adapter.normalizeUiBattery({
    percent: 74,
    rawStatus: '1', rawChargerStatus: '0', chargerCurrent: 0,
    inputConnected: false, usbOutputActive: false,
    powerStatus: 'discharging'
  }, exactIdentity);
  assert.equal(battery.inputConnected, true);
  assert.equal(battery.powerStatus, 'charging');
});

test('LV01 companion-app enum distinguishes abnormal charging, USB feeding, and normal battery use', () => {
  const cases = [
    [{ rawStatus:'1', rawChargerStatus:'5' }, 'charging-error', true, false],
    [{ rawStatus:'2', rawChargerStatus:'0' }, 'powering-usb', false, true],
    [{ rawStatus:'3', rawChargerStatus:'4' }, 'not-charging', false, false]
  ];
  for (const [source, state, input, output] of cases) {
    const battery = adapter.normalizeUiBattery({ percent:74, inputConnected:false, usbOutputActive:false, ...source }, exactIdentity);
    assert.equal(battery.powerStatus, state);
    assert.equal(battery.inputConnected, input);
    assert.equal(battery.usbOutputActive, output);
  }
});

test('non-LV01 battery semantics are not changed by the UI adapter', () => {
  const source = {
    percent: 50, rawStatus: '1', rawChargerStatus: '4',
    inputConnected: false, chargerConnected: false,
    usbOutputActive: false, usbHostActive: false,
    powerStatus: 'discharging', state: 'discharging', status: 'Discharging'
  };
  assert.deepEqual(adapter.normalizeUiBattery(source, { actualModel: 'MF855' }), source);
});

test('normalizing the UI model does not mutate the router model', () => {
  const source = { ...exactIdentity, battery: { rawStatus: '1', rawChargerStatus: '4', powerStatus: 'discharging' } };
  const normalized = adapter.normalizeUiModel(source);
  assert.equal(source.actualModel, 'LV01');
  assert.equal(normalized.actualRawModel, 'LV01');
  assert.equal(normalized.actualModel, 'MF885');
  assert.equal(normalized.battery.inputConnected, true);
});

test('LV01 battery enum fails closed without the exact firmware identity', () => {
  const source = { rawStatus:'1', rawChargerStatus:'0', inputConnected:false, powerStatus:'unknown' };
  const battery = adapter.normalizeUiBattery(source, { actualModel:'LV01' });
  assert.equal(battery.profileConfirmed, false);
  assert.equal(battery.inputConnected, false);
  assert.equal(battery.powerStatus, 'unknown');
});
