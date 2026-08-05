const test = require("node:test");
const assert = require("node:assert/strict");
const cellular = require("../modules/cellular-control.js");

function api(responses) {
  const calls = [];
  return {
    calls,
    xmlRequest: async (method, file, body) => {
      calls.push({ type: "xml", method, file, body });
      const value = responses[file];
      if (value instanceof Error) throw value;
      return value || "<RGW><status>0</status></RGW>";
    },
    routerCall: async (path, method) => { calls.push({ type: "router", path, method }); return "<RGW><result>0</result></RGW>"; },
    cleanError: e => String(e && e.message || e),
    escapeXml: v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"),
    firstText: () => "",
    sleep: async () => {},
    parseNetwork: async () => ({ hasData: true, mode: "4G · LTE", rawMode: "LTE" })
  };
}

test("detect classifies accepted and rejected firmware responses", async () => {
  const capability = await cellular.detect(api({ wan: "<RGW><wan><network_mode>19</network_mode></wan></RGW>", network: "unknown file" }));

  assert.equal(capability.supported, true);
  assert.equal(capability.reconnectAvailable, true);
  assert.equal(capability.diagnostics.find(item => item.file === "wan").status, "responded");
  assert.equal(capability.diagnostics.find(item => item.file === "network").status, "rejected");
});

test("mode values are exposed only from whitelist and unknown modes are rejected", async () => {
  assert.deepEqual(cellular.modes().map(mode => mode.id), ["auto", "lteOnly", "ltePreferred", "wcdmaOnly", "gsmOnly"]);
  await assert.rejects(() => cellular.executeSetMode(api({}), {}, "evil"), /Unknown cellular mode/);
});

test("XML builder escapes values", () => {
  const xml = cellular.buildRequest("network", "network_mode", "a&b<'\"", v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&apos;"));

  assert.match(xml, /a&amp;b&lt;&apos;&quot;/);
});

test("set mode uses whitelisted candidate XML fields", async () => {
  const mock = api({ net_mode: "<RGW><status>0</status></RGW>" });
  await cellular.executeSetMode(mock, { diagnostics: [{ file: "net_mode" }] }, "lteOnly");

  assert.equal(mock.calls[0].type, "xml");
  assert.equal(mock.calls[0].file, "net_mode");
  assert.match(mock.calls[0].body, /<(network_mode|NetworkMode|sys_mode|rat_mode|preferred_network_type|net_select)>/);
  assert.doesNotMatch(mock.calls[0].body, /evil/);
});

test("module diagnostics sanitizer redacts sensitive data", () => {
  const clean = cellular.sanitize('Authorization: Digest nonce="abcdef123456" response="1234567890abcdef" password: secret');

  assert.doesNotMatch(clean, /abcdef123456|1234567890abcdef|secret/);
});
