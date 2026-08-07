const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cellular = require("../modules/cellular-control.js");
const { selectProfile } = require("../modules/compatibility-profiles.js");
function api(xml="<RGW><wan><connect_mode>1</connect_mode></wan></RGW>"){return {xmlRequest:async()=>xml,escapeXml:String,writeThenVerify:async()=>({outcome:"confirmed"})}}

test("detect is profile-driven and unknown firmware is explicitly read-only", async()=>{
  const unknown=selectProfile("other"); const result=await cellular.detect(api(),unknown);
  assert.equal(result.supported,true); assert.equal(result.readOnly,true); assert.deepEqual(result.modes,[]);
});
test("unconfirmed operations cannot write",async()=>{
  const result=await cellular.executeReconnect(api(),{},selectProfile("other"));
  assert.equal(result.outcome,"unsupported"); assert.equal(result.ok,false);
});
test("mode lookup exposes only profile whitelist",()=>{
  assert.equal(cellular.modeById("evil",selectProfile("2.5.96")),null);
  assert.deepEqual(cellular.modes(selectProfile("other")),[]);
});
test("scriptable passes ACTIVE_PROFILE to all cellular-control calls",()=>{
  const source=fs.readFileSync(require.resolve("../scriptable.js"),"utf8");
  assert.match(source,/\.detect\(cellularControlApi\(auth\), ACTIVE_PROFILE\)/);
  assert.match(source,/\.modeById\(modeId, ACTIVE_PROFILE\)/);
  assert.match(source,/\.executeReconnect\(cellularControlApi\(auth\), capability, ACTIVE_PROFILE\)/);
  assert.match(source,/\.executeSetMode\(cellularControlApi\(auth\), capability, mode\.id, ACTIVE_PROFILE\)/);
});
