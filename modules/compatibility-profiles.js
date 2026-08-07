// Values in this file must come from the named firmware, never from probing.
const PROFILES = Object.freeze({
  "2.5.94_release_MF855_NZ_CP_2.129.003": Object.freeze({
    id: "zmi-mf855-nz-2.5.94",
    firmware: "2.5.94_release_MF855_NZ_CP_2.129.003",
    confirmed: true,
    xmlRequestPath: "/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    // Only the existence of these read endpoints/fields has been observed on
    // this build.  Enum meanings (including SIM_status=0) remain intentionally
    // absent until they are independently confirmed.
    wan: Object.freeze({
      mappings: Object.freeze({
        ConnType: Object.freeze({ LTE: "4G · LTE", WCDMA: "3G · WCDMA", GSM: "2G · GSM" }),
        proto: Object.freeze({ LTE: "4G · LTE", WCDMA: "3G · WCDMA", GSM: "2G · GSM" })
      }),
      // This is a combination observed together with a connected WAN and the
      // stock UI showing 4G. Neither numeric value is a portable enum.
      currentRatRules: Object.freeze([
        Object.freeze({ fields: Object.freeze({ sys_mode: "17", sys_submode: "17" }), connected: true, label: "4G · LTE", source: "firmware combination rule" })
      ]),
      modes: Object.freeze([]), operations: Object.freeze({})
    }),
    destructive: Object.freeze({})
  }),
  "2.5.96": Object.freeze({
    id: "zmi-mf855-mf885-2.5.96",
    firmware: "2.5.96",
    confirmed: true,
    xmlRequestPath: "/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    wan: Object.freeze({
      // These read mappings were captured from 2.5.96. No write operation is
      // advertised until its complete request and verification are confirmed.
      mappings: Object.freeze({
        // Captured simultaneously with the stock network screen on 2.5.96.
        // RAT enums are deliberately firmware-scoped: numeric codes from a
        // different build must never be inferred from this table.
        sys_mode: Object.freeze({ "0": "No service", "3": "2G · GSM/GPRS", "4": "3G · WCDMA", "6": "4G · LTE" }),
        sys_submode: Object.freeze({ "1": "2G · GSM", "2": "2G · GPRS", "3": "2G · EDGE", "4": "3G · WCDMA", "5": "3G · HSDPA", "6": "3G · HSUPA", "7": "3G · HSPA", "9": "3G · HSPA+", "17": "3G · HSPA+ 64QAM", "25": "4G · LTE TDD", "26": "4G · LTE FDD" }),
        ConnType: Object.freeze({ "0": "No service", "1": "2G · GSM", "2": "3G · WCDMA", "3": "4G · LTE", LTE: "4G · LTE", WCDMA: "3G · WCDMA", GSM: "2G · GSM" }),
        proto: Object.freeze({ LTE: "4G · LTE", WCDMA: "3G · WCDMA", HSPA: "3G · HSPA", GSM: "2G · GSM" }),
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
