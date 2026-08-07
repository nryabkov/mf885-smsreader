// Values in this file must come from the named firmware, never from probing.
const PROFILES = Object.freeze({
  "2.5.96": Object.freeze({
    id: "zmi-mf855-mf885-2.5.96",
    firmware: "2.5.96",
    confirmed: true,
    destructive: Object.freeze({
      reset: { file: "reset", tree: "reboot" },
      poweroff: { file: "poweroff", tree: "shutdown" }
      // trueshutdown is deliberately absent: no confirmed trigger was supplied.
    })
  })
});

function selectProfile(value) {
  const profile = PROFILES[String(value || "")];
  return profile || { id: "unknown", firmware: String(value || "unknown"), confirmed: false };
}

function confirmed(profile, path) {
  let value = profile;
  for (const part of String(path).split(".")) value = value && value[part];
  return value && value.confirmed !== false ? value : null;
}

module.exports = { PROFILES, selectProfile, confirmed };
