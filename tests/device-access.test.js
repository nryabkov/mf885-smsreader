const test = require("node:test");
const assert = require("node:assert/strict");
const deviceAccess = require("../modules/device-access.js");

test("detect uses only safe GET probes and returns diagnostics", async () => {
  const calls = [];
  const result = await deviceAccess.detect({
    xmlRequest: async (method, file, body) => {
      calls.push({ method, file, body });
      return file === "adb" ? "<RGW><adb /></RGW>" : "unknown file";
    },
    cleanError: error => String(error.message || error)
  });

  assert.ok(result.diagnostics.length > 0);
  assert.equal(result.supported, true);
  assert.ok(calls.every(call => call.method === "GET" && call.body === null));
});

test("execute only runs the selected explicit action", async () => {
  const calls = [];
  const result = await deviceAccess.execute({
    routerCall: async (path, method) => {
      calls.push({ type: "routerCall", path, method });
      return "<RGW><status>0</status></RGW>";
    },
    xmlRequest: async () => { throw new Error("unexpected fallback"); },
    escapeXml: value => String(value),
    cleanError: error => String(error.message || error)
  }, "tryEnableTelnet", "tryEnableTelnet");

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ type: "routerCall", path: "debug", method: "enable_telnet" }]);
});
