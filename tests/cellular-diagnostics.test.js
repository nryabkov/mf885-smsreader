const test = require("node:test");
const assert = require("node:assert/strict");
const diagnostics = require("../modules/cellular-diagnostics.js");
const { selectProfile } = require("../modules/compatibility-profiles.js");
const profile = selectProfile("2.5.96");

test("normalizes mixed-case nested WAN and Engineer_parameter XML", () => {
  const result = diagnostics.normalize({
    wan: "<RGW><WAN><CELLULAR><APN>configured.example</APN><ACTIVE_APN>live.example</ACTIVE_APN><PDP_TYPE>2</PDP_TYPE><SIM_STATUS>1</SIM_STATUS><NW_REGISTER_STATUS>5</NW_REGISTER_STATUS><ROAMING>1</ROAMING><CONNECT_DISCONNECT>1</CONNECT_DISCONNECT><IP_ADDRESS>10.2.3.4</IP_ADDRESS><IPV6_ADDRESS>2001:db8::2</IPV6_ADDRESS><GATEWAY>10.2.3.1</GATEWAY><IPV6_GATEWAY>2001:db8::1</IPV6_GATEWAY><DNS1>1.1.1.1</DNS1><DNS2>2606:4700:4700::1111</DNS2></CELLULAR></WAN></RGW>",
    Engineer_parameter: "<RGW><LTE><LTE_band>3</LTE_band><PCI>42</PCI><EARFCN>1300</EARFCN><RSRP>-97</RSRP><RSRQ>-11</RSRQ><SINR>18</SINR></LTE></RGW>"
  }, profile);
  assert.equal(result.values.configuredApn.value, "configured.example");
  assert.equal(result.values.activeApn.value, "live.example");
  assert.equal(result.values.pdpType.value, "IPv4/IPv6");
  assert.equal(result.values.ipv6.raw, "2001:db8::2");
  assert.equal(result.values.rsrp.source, "Engineer_parameter:RSRP");
  assert.equal(result.stages.registration.state, "ok");
  assert.deepEqual(Object.keys(result.stages), ["sim", "registration", "pdp"]);
});

test("preserves missing fields, partial endpoint errors, IPv4-only, and unknown enums", () => {
  const result = diagnostics.normalize({ status1: "<RGW><SIM_status>77</SIM_status><pdp_state>9</pdp_state><pdp_cause>33</pdp_cause><ip_address>100.64.1.2</ip_address></RGW>", __errors: { wan: "timeout" } }, profile);
  assert.equal(result.values.sim.value, "Unknown (raw: 77)");
  assert.equal(result.values.sim.confirmed, false);
  assert.equal(result.values.sim.raw, "77");
  assert.equal(result.values.ipv6.value, null);
  assert.equal(result.stages.pdp.raw, "33");
  assert.equal(result.endpointErrors.wan, "timeout");
});

test("2.5.94 status1 aliases are decoded without guessing enum meanings", () => {
  const firmware = selectProfile("2.5.94_release_MF855_NZ_CP_2.129.003");
  const result = diagnostics.normalize({status1:"<RGW><sim_status>0</sim_status><ip>10.0.0.2</ip><v4gateway>10.0.0.1</v4gateway><v4dns1>1.1.1.1</v4dns1><v4dns2>8.8.8.8</v4dns2><lte_apn>internet</lte_apn></RGW>"}, firmware);
  assert.equal(result.values.sim.value, "Unknown (raw: 0)");
  assert.equal(result.values.sim.confirmed, false);
  assert.equal(result.values.ipv4.raw, "10.0.0.2");
  assert.equal(result.values.gateway4.raw, "10.0.0.1");
  assert.equal(result.values.dns2.raw, "8.8.8.8");
  assert.equal(result.values.configuredApn.raw, "internet");
});

test("MF885 2.5.94 fixture provides canonical provenance and conservative enums", () => {
  const fs=require("node:fs"), path=require("node:path"), dir=path.join(__dirname,"fixtures/mf885-2.5.94");
  const responses={}; for(const name of ["status1","wan","Engineer_parameter"])responses[name]=fs.readFileSync(path.join(dir,`${name}.xml`),"utf8");
  const result=diagnostics.normalize(responses,selectProfile("2.5.94"));
  assert.deepEqual(result.values.rat.value,"4G · LTE");
  assert.equal(result.values.sys_mode.raw,"17"); assert.equal(result.values.sys_mode.source,"status1:sys_mode"); assert.equal(result.values.sys_mode.confidence,"confirmed");
  assert.equal(result.values.sys_submode.value,"Unknown (raw: 99)"); assert.equal(result.values.sys_submode.confidence,"low");
  assert.equal(result.values.sim.value,"Ready"); assert.equal(result.values.registration.value,"Registered (home)"); assert.equal(result.values.roaming.value,"Home network");
  assert.equal(result.values.pdpState.value,"Connected"); assert.equal(result.values.pdpType.value,"IPv4");
  assert.equal(result.signal.metric,"RSRP"); assert.equal(result.signal.dbm,-97); assert.equal(result.values.rsrq.raw,"-11"); assert.equal(result.values.sinr.raw,"18");
});

test("signal priority rejects arbitrary percentages and keeps RSRQ/SINR separate",()=>{
  let result=diagnostics.normalize({status1:"<RGW><signal_strength>80</signal_strength><RSRQ>-12</RSRQ><SINR>9</SINR></RGW>"},selectProfile("2.5.94"));
  assert.equal(result.signal.bars,null); assert.equal(result.signal.dbm,null); assert.equal(result.signal.rsrq.raw,"-12"); assert.equal(result.signal.sinr.raw,"9");
  result=diagnostics.normalize({status1:"<RGW><signalbar>3</signalbar><RSSI>-88</RSSI></RGW>"},selectProfile("2.5.94")); assert.equal(result.signal.metric,"signalbar"); assert.equal(result.signal.bars,3);
});

test("rejects placeholder network values without discarding concrete addresses", () => {
  const result=diagnostics.normalize({wan:"<RGW><ip_address>0.0.0.0</ip_address><ipv6_address>2001:db8::8</ipv6_address><gateway>NA</gateway><ipv6_gateway>2001:db8::1</ipv6_gateway><dns1></dns1><dns2>1.1.1.1</dns2></RGW>"},profile);
  assert.equal(result.values.ipv4.value,null);
  assert.equal(result.values.gateway4.value,null);
  assert.equal(result.values.dns1.value,null);
  assert.equal(result.values.ipv6.raw,"2001:db8::8");
  assert.equal(result.values.gateway6.raw,"2001:db8::1");
  assert.equal(result.values.dns2.raw,"1.1.1.1");
  assert.deepEqual(Object.keys(result.stages),["sim","registration","pdp"]);
});
