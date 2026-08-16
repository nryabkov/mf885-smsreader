const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");
const power = require("../modules/power-compatibility.js");

function exactIdentity(overrides = {}) {
  return {
    model: "LV01",
    hardware: "",
    firmware: power.EXACT_FIRMWARE,
    ...overrides
  };
}

test("exact LV01/MF885 2.5.94 identity enables only APK-confirmed GET commands", () => {
  for (const identity of [exactIdentity(), exactIdentity({ model: "MF885", hardware: "Ver.D" })]) {
    const profile = power.resolve(identity);
    assert.equal(profile.supported, true);
    assert.deepEqual(profile.commands.reboot.file, { name: "reset", method: "GET" });
    assert.deepEqual(profile.commands.powerOff.file, { name: "poweroff", method: "GET" });
  }
});

test("wrong model, firmware, or reported hardware fails closed", () => {
  assert.equal(power.resolve(exactIdentity({ model: "MF855" })).supported, false);
  assert.equal(power.resolve(exactIdentity({ model: "MF96-ROUTER-C2", hardware: "Ver.D" })).supported, false);
  assert.equal(power.resolve(exactIdentity({ model: "MF885", hardware: "" })).supported, false);
  assert.equal(power.resolve(exactIdentity({ firmware: "2.5.96" })).supported, false);
  assert.equal(power.resolve(exactIdentity({ hardware: "Ver.C" })).supported, false);
  assert.equal(power.resolve({}).supported, false);
});

test("power backend re-reads exact live identity immediately before one GET command", async () => {
  const writes = [];
  const status = `<RGW><model>LV01</model><version_num>${power.EXACT_FIRMWARE}</version_num></RGW>`;
  const result = await app.executePowerCommand({}, "reboot", {
    getStatus: async () => status,
    writeThenVerify: async operation => {
      writes.push(operation);
      return { outcome: "submitted", method: "GET", model: "reset" };
    }
  });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].model, { name: "reset", method: "GET" });
  assert.equal(writes[0].destructive, true);
  assert.equal(result.outcome, "submitted");
});

test("identity mismatch blocks before transport is called", async () => {
  let writes = 0;
  const status = "<RGW><model>LV01</model><version_num>2.5.96</version_num></RGW>";
  await assert.rejects(app.executePowerCommand({}, "powerOff", {
    getStatus: async () => status,
    writeThenVerify: async () => { writes++; return { outcome: "submitted" }; }
  }), /firmware does not exactly match/i);
  assert.equal(writes, 0);
});

test("connection loss is returned as unknown and is never replayed", async () => {
  const profile = power.resolve(exactIdentity());
  let calls = 0;
  const result = await app.executePowerCommand({}, "powerOff", {
    profile,
    writeThenVerify: async () => {
      calls++;
      return { outcome: "unknown", connectionLost: true, method: "GET", model: "poweroff", error: new Error("connection lost") };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, "unknown");
});
