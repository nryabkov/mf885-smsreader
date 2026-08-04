const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDigestChallenge } = require("../scriptable.js");

test("parses quoted commas, escaped quotes, and optional whitespace", () => {
  assert.deepEqual(
    parseDigestChallenge(' Digest  realm = "Pocket, Router" , nonce="abc\\\"123" , qop = auth '),
    { realm: "Pocket, Router", nonce: 'abc"123', qop: "auth" }
  );
});

test("normalizes mixed-case parameter names and accepts no scheme", () => {
  assert.deepEqual(
    parseDigestChallenge('ReAlM="router", NONCE = token, QoP="auth", OPAQUE="state", Algorithm=MD5'),
    { realm: "router", nonce: "token", qop: "auth", opaque: "state", algorithm: "MD5" }
  );
});

test("rejects duplicate critical parameters without exposing their values", () => {
  const secret = "do-not-report-this";
  assert.throws(
    () => parseDigestChallenge(`Digest realm="router", nonce="first", NONCE="${secret}"`),
    error => error.message.includes("nonce") && !error.message.includes(secret)
  );
});

test("rejects malformed parameters with a value-free diagnostic", () => {
  const secret = "do-not-report-this";
  assert.throws(
    () => parseDigestChallenge(`Digest realm="router", opaque="${secret}`),
    error => error.message.includes("opaque") && !error.message.includes(secret)
  );
});
