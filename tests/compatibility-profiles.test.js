const test = require("node:test");
const assert = require("node:assert/strict");

const { selectProfile } = require("../modules/compatibility-profiles.js");

test("MF885 2.5.94 advertises only the firmware-confirmed reboot destructive mapping", () => {
  const profile = selectProfile("2.5.94");

  assert.deepEqual(profile.destructive.reset, { file: "reset", tree: "reboot" });
  assert.equal(profile.destructive.poweroff, undefined);
  assert.equal(profile.destructive.trueshutdown, undefined);
});

test("full 2.5.94 release-lineage profile preserves the confirmed reboot mapping", () => {
  const profile = selectProfile("2.5.94_release_MF855_NZ_CP_2.129.003");

  assert.deepEqual(profile.destructive.reset, { file: "reset", tree: "reboot" });
  assert.equal(profile.destructive.poweroff, undefined);
});

test("2.5.96 keeps its separately confirmed reboot and power-off mappings", () => {
  const profile = selectProfile("2.5.96");

  assert.deepEqual(profile.destructive.reset, { file: "reset", tree: "reboot" });
  assert.deepEqual(profile.destructive.poweroff, { file: "poweroff", tree: "shutdown" });
  assert.equal(profile.destructive.trueshutdown, undefined);
});
