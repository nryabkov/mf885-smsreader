const test = require("node:test");
const assert = require("node:assert/strict");
const deviceAccess = require("../modules/device-access.js");
const telnetControl = require("../modules/telnet-control.js");

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

test("safe metadata exposes Telnet before detection", () => {
  assert.ok(deviceAccess.capabilities().some(item => item.id === "tryEnableTelnet"));
});

test("Telnet stays disabled without a universal contract", async () => {
  const api={};
  assert.deepEqual(await telnetControl.control(api,true,false),{outcome:"rejected",reason:"confirmation-required"});
  assert.equal((await telnetControl.control(api,true,true)).outcome,"unsupported");
});

test("generic access module refuses Telnet and sends no write", async () => {
  const calls = [];
  await assert.rejects(() => deviceAccess.execute({
    routerCall: async (path, method) => {
      calls.push({ type: "routerCall", path, method });
      return "<RGW><status>0</status></RGW>";
    },
    xmlRequest: async () => { throw new Error("unexpected fallback"); },
    escapeXml: value => String(value),
    cleanError: error => String(error.message || error)
  }, "tryEnableTelnet", "tryEnableTelnet"), /Unknown device-access capability/);
  assert.deepEqual(calls, []);
});
