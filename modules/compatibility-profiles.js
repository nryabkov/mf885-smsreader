// Values in this file must come from the named firmware, never from probing.
const PROFILES = Object.freeze({
  "2.5.96": Object.freeze({
    id: "zmi-mf855-mf885-2.5.96",
    firmware: "2.5.96",
    confirmed: true,
    xmlRequestPath: "/cgi/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    wan: Object.freeze({
      // These read mappings were captured from 2.5.96. No write operation is
      // advertised until its complete request and verification are confirmed.
      mappings: Object.freeze({
        sim: Object.freeze({ "1": "Ready", ready: "Ready", "0": "Initializing" }),
        registration: Object.freeze({ "0": "Not registered", "1": "Registered (home)", "2": "Searching", "5": "Registered (roaming)" }),
        roaming: Object.freeze({ "0": "Home network", "1": "Roaming" }),
        pdpState: Object.freeze({ "0": "Disconnected", "1": "Connected", "2": "Connecting" }),
        pdpType: Object.freeze({ "0": "IPv4", "1": "IPv6", "2": "IPv4/IPv6", IP: "IPv4", IPV6: "IPv6", IPV4V6: "IPv4/IPv6" })
      }),
      modes: Object.freeze([]), operations: Object.freeze({})
    }),
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
