const test = require('node:test');
const assert = require('node:assert/strict');
const adapter = require('../scriptable-ui.js');

test('LV01 is displayed as MF885 without rewriting other router models', () => {
  assert.equal(adapter.uiDeviceModel('LV01'), 'MF885');
  assert.equal(adapter.uiDeviceModel('lv01'), 'MF885');
  assert.equal(adapter.uiDeviceModel('MF855'), 'MF855');
});

test('LV01 charging signature activates the micro-USB input indicator', () => {
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
  }, { actualModel: 'LV01' });
  assert.equal(battery.inputConnected, true);
  assert.equal(battery.chargerConnected, true);
  assert.equal(battery.powerStatus, 'charging');
  assert.equal(battery.status, 'Charging');
});

test('LV01 full battery plus charging signature becomes Full', () => {
  const battery = adapter.normalizeUiBattery({
    percent: 100,
    rawStatus: '1', rawChargerStatus: '4', chargerCurrent: 0,
    inputConnected: false, usbOutputActive: false,
    powerStatus: 'discharging'
  }, { actualModel: 'LV01' });
  assert.equal(battery.inputConnected, true);
  assert.equal(battery.powerStatus, 'full');
  assert.equal(battery.status, 'Full');
});

test('LV01 charger compatibility rule is conservative', () => {
  const battery = adapter.normalizeUiBattery({
    percent: 74,
    rawStatus: '1', rawChargerStatus: '0', chargerCurrent: 0,
    inputConnected: false, usbOutputActive: false,
    powerStatus: 'discharging'
  }, { actualModel: 'LV01' });
  assert.equal(battery.inputConnected, false);
  assert.equal(battery.powerStatus, 'discharging');
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
  const source = { actualModel: 'LV01', battery: { rawStatus: '1', rawChargerStatus: '4', powerStatus: 'discharging' } };
  const normalized = adapter.normalizeUiModel(source);
  assert.equal(source.actualModel, 'LV01');
  assert.equal(normalized.actualRawModel, 'LV01');
  assert.equal(normalized.actualModel, 'MF885');
  assert.equal(normalized.battery.inputConnected, true);
});
