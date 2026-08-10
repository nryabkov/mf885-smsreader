const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../modules/api-contract.js");
const compatibility = require("../modules/compatibility-profiles.js");

function assertGetPowerProfile(profile) {
  assert.deepEqual(profile.destructive.reset.file, { name: "reset", method: "GET" });
  assert.equal(profile.destructive.reset.tree, "reboot");
  assert.deepEqual(profile.destructive.poweroff.file, { name: "poweroff", method: "GET" });
  assert.equal(profile.destructive.poweroff.tree, "shutdown");
}

test("MF885 2.5.94 advertises APK-confirmed GET reboot and power-off commands", () => {
  const profile = compatibility.selectProfile("2.5.94");
  assert.equal(profile.id, "zmi-mf885-2.5.94");
  assertGetPowerProfile(profile);
});

test("full 2.5.94 release lineage preserves the same GET power commands", () => {
  const profile = compatibility.selectProfile("2.5.94_release_MF855_NZ_CP_2.129.003");
  assert.equal(profile.id, "zmi-mf855-nz-2.5.94");
  assertGetPowerProfile(profile);
});

test("2.5.96 preserves the existing POST/SET destructive mapping", () => {
  const profile = compatibility.selectProfile("2.5.96");

  assert.equal(profile.destructive.reset.file, "reset");
  assert.equal(profile.destructive.reset.tree, "reboot");
  assert.equal(profile.destructive.poweroff.file, "poweroff");
  assert.equal(profile.destructive.poweroff.tree, "shutdown");
});

test("destructive GET command does not require verify and never calls POST", async () => {
  const calls = [];
  const result = await api.writeThenVerify({
    model: { name: "reset", method: "GET" },
    xml: "<RGW><reboot></reboot></RGW>",
    destructive: true,
    post: async () => {
      throw new Error("POST must not be called");
    },
    get: async model => {
      calls.push(["GET", model]);
      return "submitted";
    },
    pollAvailability: async () => {
      calls.push(["poll"]);
      return false;
    }
  });

  assert.deepEqual(calls, [["GET", "reset"], ["poll"]]);
  assert.equal(result.outcome, "pending/unknown");
  assert.equal(result.method, "GET");
  assert.equal(result.model, "reset");
});

test("legacy destructive string descriptor still uses POST with retry disabled", async () => {
  const calls = [];
  const result = await api.writeThenVerify({
    model: "poweroff",
    xml: "<RGW><shutdown></shutdown></RGW>",
    destructive: true,
    post: async (model, xml, options) => {
      calls.push(["POST", model, xml, options]);
      return "submitted";
    },
    get: async () => {
      throw new Error("GET must not be called");
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "POST");
  assert.equal(calls[0][1], "poweroff");
  assert.equal(calls[0][3].retry401, false);
  assert.equal(result.outcome, "pending/unknown");
  assert.equal(result.method, "POST");
});

test("ordinary writes still require verify and perform POST then GET", async () => {
  const calls = [];
  const result = await api.writeThenVerify({
    model: "wan",
    xml: "<RGW><wan><x>1</x></wan></RGW>",
    post: async (model, xml, options) => {
      calls.push(["POST", model, options.retry401]);
      return "write-response";
    },
    get: async model => {
      calls.push(["GET", model]);
      return "control";
    },
    verify: control => control === "control"
  });

  assert.deepEqual(calls, [["POST", "wan", true], ["GET", "wan"]]);
  assert.equal(result.outcome, "confirmed");
});
