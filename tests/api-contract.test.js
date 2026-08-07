const test = require("node:test");
const assert = require("node:assert/strict");

const api = require("../modules/api-contract.js");
const scriptable = require("../scriptable.js");

test("physical XML endpoint can differ from the Digest URI", () => {
  const url = api.requestUrl("192.168.21.1", "POST", "status1", undefined, "/xml_action.cgi");

  assert.equal(url, "http://192.168.21.1/xml_action.cgi?method=set&module=duster&file=status1");
  assert.equal(api.XML_DIGEST_URI, "/cgi/xml_action.cgi");
});

test("scriptable URL construction does not change the authorization URI", () => {
  const url = scriptable.xmlRequestUrl("router.test", "GET", "status1", undefined, "/xml_action.cgi");
  const header = scriptable.authorization({
    nc: 1,
    ha1: "0123456789abcdef0123456789abcdef",
    nonce: "nonce",
    qop: "auth",
    realm: "router"
  }, "GET");

  assert.match(url, /^http:\/\/router\.test\/xml_action\.cgi\?/);
  assert.match(header, /uri="\/cgi\/xml_action\.cgi"/);
  assert.equal(scriptable.XML_DIGEST_URI, "/cgi/xml_action.cgi");
});
