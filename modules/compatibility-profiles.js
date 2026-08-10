// Values in this file must come from the named firmware, never from probing.
const PROFILES = Object.freeze({
  "2.5.94": Object.freeze({
    id: "zmi-mf885-2.5.94",
    model: "MF885",
    firmware: "2.5.94",
    confirmed: true,
    evidence: "tests/fixtures/mf885-2.5.94",
    xmlRequestPath: "/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    wan: Object.freeze({
      mappings: Object.freeze({
        sys_mode: Object.freeze({ "17": "4G · LTE" }),
        sim: Object.freeze({ "1": "Ready" }),
        registration: Object.freeze({ "1": "Registered (home)" }),
        roaming: Object.freeze({ "0": "Home network" }),
        pdpState: Object.freeze({ "1": "Connected" }),
        pdpType: Object.freeze({ IP: "IPv4" }),
        signalbar: Object.freeze({ "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5" })
      }),
      rat: Object.freeze({
        current: Object.freeze(["sys_mode"]),
        alternativeSources: Object.freeze([]),
        supplemental: Object.freeze(["sys_submode", "ConnType", "proto"]),
        preferred: Object.freeze(["preferred_mode", "connect_mode"]),
        connectionType: Object.freeze(["ConnType"])
      }),
      signalMetrics: Object.freeze({ rsrp: true, rsrq: true, sinr: true, rssi: true, signalbar: true, signalStrength: "csq" }),
      modes: Object.freeze([]), operations: Object.freeze({})
    }),
    destructive: Object.freeze({
      reset: Object.freeze({ file: "reset", tree: "reboot" })
    })
  }),
  "2.5.94_release_MF855_NZ_CP_2.129.003": Object.freeze({
    id: "zmi-mf855-nz-2.5.94",
    firmware: "2.5.94_release_MF855_NZ_CP_2.129.003",
    confirmed: true,
    xmlRequestPath: "/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    wan: Object.freeze({
      mappings: Object.freeze({
        ConnType: Object.freeze({ LTE: "4G · LTE", WCDMA: "3G · WCDMA", GSM: "2G · GSM" }),
        proto: Object.freeze({ LTE: "4G · LTE", WCDMA: "3G · WCDMA", GSM: "2G · GSM" })
      }),
      rat: Object.freeze({ current: Object.freeze(["sys_mode"]), alternativeSources: Object.freeze(["sys_mode", "network_mode"]), supplemental: Object.freeze(["sys_submode", "ConnType", "proto"]), preferred: Object.freeze(["preferred_mode", "connect_mode"]), connectionType: Object.freeze(["ConnType"]) }),
      signalMetrics: Object.freeze({ rsrp: true, rsrq: true, sinr: true, rssi: true, signalbar: true, signalStrength: "csq" }),
      currentRatRules: Object.freeze([
        Object.freeze({ fields: Object.freeze({ sys_mode: "17", sys_submode: "17" }), connected: true, label: "4G · LTE", source: "firmware combination rule" })
      ]),
      modes: Object.freeze([]), operations: Object.freeze({})
    }),
    destructive: Object.freeze({
      reset: Object.freeze({ file: "reset", tree: "reboot" })
    })
  }),
  "2.5.96": Object.freeze({
    id: "zmi-mf855-mf885-2.5.96",
    firmware: "2.5.96",
    confirmed: true,
    xmlRequestPath: "/xml_action.cgi",
    diagnosticEndpoints: Object.freeze(["status1", "wan", "Engineer_parameter"]),
    wan: Object.freeze({
      mappings: Object.freeze({
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
      rat: Object.freeze({ current: Object.freeze(["sys_mode"]), alternativeSources: Object.freeze(["sys_mode", "network_mode"]), supplemental: Object.freeze(["sys_submode", "ConnType", "proto"]), preferred: Object.freeze(["preferred_mode", "connect_mode"]), connectionType: Object.freeze(["ConnType"]) }),
      signalMetrics: Object.freeze({ rsrp: true, rsrq: true, sinr: true, rssi: true, signalbar: true, signalStrength: "csq" }),
      modes: Object.freeze([]), operations: Object.freeze({})
    }),
    destructive: Object.freeze({
      reset: { file: "reset", tree: "reboot" },
      poweroff: { file: "poweroff", tree: "shutdown" }
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
