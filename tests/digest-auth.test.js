const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDigestChallenge } = require("../scriptable.js");

const fixtures = [
  {
    name: 'quoted qop="auth"',
    header: 'Digest realm="router", nonce="one", qop="auth"'
  },
  {
    name: "quoted comma-separated qop selects auth",
    header: 'Digest realm="router", nonce="two", qop="auth-int,auth", opaque="value"'
  },
  {
    name: "unquoted qop is normalized case-insensitively",
    header: 'Digest realm="router", nonce="three", qop=AuTh'
  }
];

for (const fixture of fixtures) {
  test(fixture.name, () => {
    assert.deepEqual(parseDigestChallenge(fixture.header), {
      realm: "router",
      nonce: fixture.header.match(/nonce="([^"]+)/)[1],
      qop: "auth"
    });
  });
}

test("missing qop is rejected clearly", () => {
  assert.throws(
    () => parseDigestChallenge('Digest realm="router", nonce="four"'),
    /qop is required.*no-qop authentication is not implemented/i
  );
});

test("auth-int without auth is rejected clearly", () => {
  assert.throws(
    () => parseDigestChallenge('Digest realm="router", nonce="five", qop="auth-int"'),
    /auth-int requires entity-body hashing.*auth was not offered/i
  );
});
