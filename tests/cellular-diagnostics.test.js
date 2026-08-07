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
  assert.equal(result.stages.dns.state, "ok");
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
