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

test("Telnet requires a complete confirmed contract and verifies write, read-back and port", async () => {
  let writes=0, reads=0, ports=0;
  const profile={telnet:{confirmed:true,model:"telnet",root:"telnet",field:"enable",values:{enable:"1",disable:"0"},port:23,readable:true,readState:xml=>/<enable>1<\/enable>/.test(xml)?"1":"0"}};
  const api={host:"router",escapeXml:String,xmlRequest:async()=>{reads++;return "<enable>0</enable>";},writeThenVerify:async spec=>{writes++;assert.equal(spec.verify("<enable>1</enable>"),true);return {outcome:"confirmed"};},portCheck:async()=>{ports++;return true;}};
  assert.deepEqual(await telnetControl.control(api,profile,true,false),{outcome:"rejected",reason:"confirmation-required"});
  const result=await telnetControl.control(api,profile,true,true);
  assert.equal(result.outcome,"confirmed"); assert.equal(reads,1); assert.equal(writes,1); assert.equal(ports,1);
  assert.equal((await telnetControl.control(api,{telnet:{confirmed:true}},true,true)).outcome,"unsupported");
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
