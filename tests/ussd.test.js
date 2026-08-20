const test = require("node:test");
const assert = require("node:assert/strict");
const ussd = require("../modules/ussd.js");

function api(handler, responsePolls = 2) {
  return {
    xmlRequest: handler,
    escapeXml: value => String(value),
    firstText(xml, names) {
      for (const name of names) {
        const match = String(xml).match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, "i"));
        if (match) return match[1];
      }
      return "";
    },
    decodeSms: value => String(value || ""),
    cleanError: error => String(error && error.message || error),
    sleep: async () => {},
    responsePolls
  };
}

test("a timed-out USSD POST is never replayed through another candidate", async () => {
  const calls = [];
  const result = await ussd.execute(api(async (method, file, body, retry) => {
    calls.push({ method, file, body, retry });
    throw new Error("timeout");
  }), { supported:null, candidates:[
    { file:"ussd", root:"ussd", field:"ussd_cmd" },
    { file:"ussd", root:"USSD", field:"ussd_command" }
  ] }, "*#21#");

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].retry, false);
});

test("an explicit router rejection consumes the single USSD POST", async () => {
  const calls = [];
  const result = await ussd.execute(api(async (method, file, body, retry) => {
    calls.push({ method, file, body, retry });
    return "<RGW><ussd><status>2</status></ussd></RGW>";
  }), { supported:null, candidates:[
    { file:"ussd", root:"ussd", field:"ussd_cmd" },
    { file:"ussd_status", root:"ussd", field:"ussd_cmd" }
  ] }, "*#21#");

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
});

test("USSD response polling uses GET only after the one POST", async () => {
  const calls = [];
  const responses = [
    "<RGW><ussd><status>0</status></ussd></RGW>",
    "<RGW><ussd><status>0</status></ussd></RGW>",
    "<RGW><ussd><ussd_response>Forwarding disabled</ussd_response></ussd></RGW>"
  ];
  const result = await ussd.execute(api(async (method, file, body, retry) => {
    calls.push({ method, file, body, retry });
    return responses.shift();
  }), { supported:true, candidates:[{ file:"ussd", root:"ussd", field:"ussd_cmd" }] }, "*#21#");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Forwarding disabled");
  assert.deepEqual(calls.map(call => call.method), ["POST", "GET", "GET"]);
  assert.equal(calls.filter(call => call.method === "POST").length, 1);
});
