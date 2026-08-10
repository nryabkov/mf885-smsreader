const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../modules/api-contract.js");
const scriptable = require("../scriptable.js");

test("physical XML endpoint can differ from the Digest URI", () => {
  const url = api.requestUrl("192.168.21.1", "POST", "status1");

  assert.equal(url, "http://192.168.21.1/xml_action.cgi?method=set&module=duster&file=status1");
  assert.equal(api.XML_REQUEST_PATH, "/xml_action.cgi");
  assert.equal(api.XML_DIGEST_URI, "/cgi/xml_action.cgi");
});

test("requestUrl accepts a transport-bearing model descriptor", () => {
  const url = api.requestUrl("192.168.21.1", "GET", { name: "reset", method: "GET" });

  assert.equal(url, "http://192.168.21.1/xml_action.cgi?method=get&module=duster&file=reset");
  assert.deepEqual(api.normalizeModelDescriptor({ name: "poweroff", method: "get" }), {
    name: "poweroff",
    method: "GET"
  });
});

test("router request URL and corresponding Digest header use their distinct paths", () => {
  const url = scriptable.xmlRequestUrl("192.168.21.1", "GET", "status1");
  const header = scriptable.authorization({
    nc: 1,
    ha1: "0123456789abcdef0123456789abcdef",
    nonce: "nonce",
    qop: "auth",
    realm: "router"
  }, "GET");

  assert.equal(url, "http://192.168.21.1/xml_action.cgi?method=get&module=duster&file=status1");
  assert.match(header, /uri="\/cgi\/xml_action\.cgi"/);
  assert.equal(scriptable.XML_REQUEST_PATH, "/xml_action.cgi");
  assert.equal(scriptable.XML_DIGEST_URI, "/cgi/xml_action.cgi");
});
