const EXACT_FIRMWARE = "2.5.94_release_MF855_NZ_CP_2.129.003";

const EXACT_PROFILE = Object.freeze({
  id: "mf885-ver-d-2.5.94-apk-get-power",
  firmware: EXACT_FIRMWARE,
  evidence: "ZMI_MiFi_1.2.42_english.apk and MF885 2.5.94 static analysis",
  commands: Object.freeze({
    reboot: Object.freeze({
      operation: "reset",
      file: Object.freeze({ name: "reset", method: "GET" }),
      tree: "reboot"
    }),
    powerOff: Object.freeze({
      operation: "poweroff",
      file: Object.freeze({ name: "poweroff", method: "GET" }),
      tree: "shutdown"
    })
  })
});

function normalizedIdentity(identity = {}) {
  return {
    model: String(identity.model || identity.actualModel || "").trim(),
    hardware: String(identity.hardware || identity.revision || identity.actualRevision || "").trim(),
    firmware: String(identity.firmware || identity.actualFirmware || "").trim()
  };
}

function recognizedModel(model) {
  return /^(?:LV01|MF885)$/i.test(String(model || "").trim());
}

function unsupported(identity, reason) {
  return Object.freeze({
    id: "unavailable",
    supported: false,
    identity: Object.freeze({ ...identity }),
    reason,
    commands: Object.freeze({})
  });
}

function resolve(identity = {}) {
  const value = normalizedIdentity(identity);
  if (!recognizedModel(value.model)) {
    return unsupported(value, "Power commands are disabled because the live model is not the confirmed MF885/LV01 target.");
  }
  if (value.firmware !== EXACT_FIRMWARE) {
    return unsupported(value, "Power commands are disabled because the live firmware does not exactly match the confirmed 2.5.94 build.");
  }
  if (!value.hardware && !/^LV01$/i.test(value.model)) {
    return unsupported(value, "Power commands are disabled because the live hardware revision is missing for a non-LV01 model label.");
  }
  if (value.hardware && !/Ver\.?\s*D/i.test(value.hardware)) {
    return unsupported(value, "Power commands are disabled because the reported hardware revision is not Ver.D.");
  }
  return Object.freeze({
    ...EXACT_PROFILE,
    supported: true,
    identity: Object.freeze({ ...value }),
    hardwareEvidence: value.hardware ? "status1" : "LV01 product mapping",
    reason: "Exact MF885/LV01 2.5.94 command-on-read profile matched."
  });
}

function publicState(profile) {
  const value = profile || unsupported(normalizedIdentity(), "Live device identity has not been read.");
  return {
    available: value.supported === true,
    profileId: value.id,
    reason: value.reason,
    actions: {
      reboot: !!(value.commands && value.commands.reboot),
      powerOff: !!(value.commands && value.commands.powerOff)
    }
  };
}

function command(profile, action) {
  if (!profile || profile.supported !== true) throw new Error(profile && profile.reason || "Power commands are disabled until the exact live device profile is confirmed.");
  const spec = profile.commands && profile.commands[action];
  if (!spec) throw new Error(`Unsupported power action: ${String(action || "")}`);
  return spec;
}

module.exports = {
  EXACT_FIRMWARE,
  EXACT_PROFILE,
  normalizedIdentity,
  recognizedModel,
  resolve,
  publicState,
  command
};
