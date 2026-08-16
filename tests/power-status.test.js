const test = require("node:test");
const assert = require("node:assert/strict");
const power = require("../modules/power-status.js");

const exact = { rawModel:"LV01", model:"MF885", firmware:power.EXACT_FIRMWARE };

test("exact LV01 battery enum matches the recovered companion client", () => {
  const cases = [
    [{ batteryStatus:"1", chargerStatus:"0" }, "charging", true, false, "normal"],
    [{ batteryStatus:"1", chargerStatus:"4" }, "full", true, false, "full"],
    [{ batteryStatus:"1", chargerStatus:"5" }, "charging-error", true, false, "abnormal"],
    [{ batteryStatus:"2", chargerStatus:"0" }, "powering-usb", false, true, "not-charging"],
    [{ batteryStatus:"3", chargerStatus:"0" }, "not-charging", false, false, "not-charging"]
  ];
  for (const [fields, state, input, output, health] of cases) {
    const decoded = power.decode(fields, exact);
    assert.equal(decoded.confirmed, true);
    assert.equal(decoded.state, state);
    assert.equal(decoded.inputConnected, input);
    assert.equal(decoded.usbOutputActive, output);
    assert.equal(decoded.chargeHealth, health);
  }
});

test("missing Charger_status stays distinct from literal zero", () => {
  const missing = power.decode({ batteryStatus:"1" }, exact);
  const zero = power.decode({ batteryStatus:"1", chargerStatus:"0" }, exact);
  assert.equal(missing.state, "charging");
  assert.equal(missing.chargeHealth, "unknown");
  assert.equal(zero.chargeHealth, "normal");
});

test("unknown enum and non-exact identities fail closed", () => {
  assert.deepEqual(power.decode({ batteryStatus:"99", chargerStatus:"0" }, exact), {
    confirmed:true, firmwareState:"unknown", state:"unknown", inputConnected:false, usbOutputActive:false, chargeHealth:"unknown"
  });
  for (const identity of [
    { rawModel:"LV01", firmware:"" },
    { rawModel:"LV01", firmware:"2.5.96" },
    { model:"MF855", firmware:power.EXACT_FIRMWARE }
  ]) assert.equal(power.decode({ batteryStatus:"1", chargerStatus:"0" }, identity).confirmed, false);
});
