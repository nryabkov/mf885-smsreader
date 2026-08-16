const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");

function auth(overrides = {}) {
  return {
    realm: "Highwmg",
    nonce: "1000",
    qop: "auth",
    ha1: "0123456789abcdef0123456789abcdef",
    nc: 1,
    ...overrides
  };
}

const ROUTER_LOGIN = "http://192.168.21.1/login.cgi";
const EXACT_STATUS = "<RGW><model>LV01</model><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num></RGW>";

function requestCount(requests, pattern) {
  return requests.filter(request => pattern.test(request.url)).length;
}

async function failedPowerFlow(stage, failure) {
  const originalRequest = global.Request;
  const requests = [];
  global.Request = class {
    constructor(url) { this.url=url; requests.push(this); }
    async loadString() {
      if (this.url === ROUTER_LOGIN) {
        this.response={statusCode:401,headers:{"WWW-Authenticate":'Digest realm="Highwmg", nonce="1000", qop="auth"'}};
        throw new Error("HTTP 401 challenge");
      }
      if (this.url.includes("/login.cgi?")) {
        this.response={statusCode:200,headers:{}};
        return "<RGW><login_status>0</login_status></RGW>";
      }
      const isStatus = this.url.includes("file=status1");
      const isReset = this.url.includes("file=reset");
      if (!isStatus && !isReset) throw new Error(`Unexpected URL ${this.url}`);
      if ((stage === "probe" && isStatus) || (stage === "reset" && isReset)) {
        if (!failure.missingStatus) this.response={statusCode:failure.statusCode,headers:{}};
        if (failure.error) throw failure.error;
        return failure.body || "";
      }
      this.response={statusCode:200,headers:{}};
      return isStatus ? EXACT_STATUS : "<RGW><reboot/></RGW>";
    }
  };
  let error;
  try {
    await app.executePowerCommand({}, "reboot");
  } catch (caught) {
    error = caught;
  } finally {
    global.Request = originalRequest;
  }
  assert.ok(error, "power flow must reject the injected transport failure");
  return { error, requests };
}

test("APP login uses separate protected-query and XML-header Digest proofs", () => {
  const state = auth();
  const login = app.buildAppLogin(state, { queryCnonce:"1111111111111111", headerCnonce:"2222222222222222" });
  const query = Object.fromEntries(new URLSearchParams(login.query));

  assert.equal(login.queryProof.uri, "/cgi/protected.cgi");
  assert.equal(login.queryProof.nc, "00000001");
  assert.equal(login.headerProof.uri, "/cgi/xml_action.cgi");
  assert.equal(login.headerProof.nc, "00000002");
  assert.notEqual(login.queryProof.response, login.headerProof.response);
  assert.equal(query.client, "APP");
  assert.equal(query.cnonce, "1111111111111111");
  assert.equal(query.response, login.queryProof.response);
  assert.equal(login.queryProof.response, "1470f5f320ad12d8ded709913e6d6fb0");
  assert.equal(login.headerProof.response, "d83ff1d53b6965d7db7d72100cffacf0");
  assert.match(login.authorization, /uri="\/cgi\/xml_action\.cgi"/);
  assert.match(login.authorization, /nc=00000002/);
  assert.match(login.authorization, /cnonce="2222222222222222"/);
  assert.match(login.authorization, /, client=APP$/);
  assert.equal(login.nextNc, 3);
  assert.equal(state.nc, 1, "pure builder must not mutate the live session");
});

test("live power flow performs challenge, APP login, harmless status probe, then one reset", async () => {
  const originalRequest = global.Request;
  const requests = [];
  global.Request = class {
    constructor(url) { this.url=url; requests.push(this); }
    async loadString() {
      if (this.url === "http://192.168.21.1/login.cgi") {
        this.response={statusCode:401,headers:{"WWW-Authenticate":'Digest realm="Highwmg", nonce="1000", qop="auth"'}};
        throw new Error("HTTP 401 challenge");
      }
      this.response={statusCode:200,headers:{}};
      if (this.url.includes("/login.cgi?")) return "<RGW><login_status>0</login_status></RGW>";
      if (this.url.includes("file=status1")) return "<RGW><model>LV01</model><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num></RGW>";
      if (this.url.includes("file=reset")) return "<RGW><reboot/></RGW>";
      throw new Error(`Unexpected URL ${this.url}`);
    }
  };
  try {
    const result = await app.executePowerCommand({}, "reboot");
    assert.equal(result.outcome, "request-accepted");
    assert.equal(result.effectConfirmed, false);
    assert.equal(requests.length, 4);
    const [challenge, login, status, reset] = requests;
    assert.equal(challenge.url, "http://192.168.21.1/login.cgi");
    assert.match(login.url, /\/login\.cgi\?.*client=APP/);
    assert.match(login.headers.Authorization, /uri="\/cgi\/xml_action\.cgi".*client=APP$/);
    assert.match(status.url, /file=status1$/);
    assert.match(reset.url, /file=reset$/);
    assert.equal(reset.method, "GET");
    assert.equal(reset.body, undefined);
    assert.equal(reset.timeoutInterval, 5);
    assert.equal(reset.headers.Cookie, undefined);
    assert.equal(reset.headers["X-Requested-With"], undefined);
    assert.equal(requests.filter(request => /file=reset$/.test(request.url)).length, 1);
  } finally {
    global.Request = originalRequest;
  }
});

test("APP GET headers are APK-faithful and exclude WebUI identity headers", () => {
  const headers = app.appRequestHeaders(auth({ nc:3 }), "GET", "request-cnonce");
  assert.match(headers.Authorization, /uri="\/cgi\/xml_action\.cgi"/);
  assert.match(headers.Authorization, /nc=00000003/);
  assert.match(headers.Authorization, /, client=APP$/);
  assert.equal(headers.Expires, "-1");
  assert.equal(headers.Cookie, undefined);
  assert.equal(headers["X-Requested-With"], undefined);
  assert.equal(headers["Content-Type"], undefined);
});

test("control responses reject every recovered authentication failure state", () => {
  for (const value of ["UNAUTHORIZED", "TIMEOUT", "KICKOFF"]) {
    assert.equal(app.classifyControlResponse(`<RGW><login_status>${value}</login_status></RGW>`), `auth-${value.toLowerCase()}`);
  }
  assert.equal(app.classifyControlResponse("<RGW><reboot/></RGW>"), "model-schema");
  assert.equal(app.classifyControlResponse(""), "empty");
});

test("APP reset transport is one GET with no body and advances nonce count once", async () => {
  const originalRequest = global.Request;
  const requests = [];
  global.Request = class {
    constructor(url) { this.url=url; requests.push(this); }
    async loadString() { this.response={statusCode:200,headers:{}}; return "<RGW><reboot/></RGW>"; }
  };
  try {
    const state = auth({ nc:3 });
    const result = await app.appXmlGet(state, "reset", 5);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].body, undefined);
    assert.equal(requests[0].timeoutInterval, 5);
    assert.equal(requests[0].url, "http://192.168.21.1/xml_action.cgi?method=get&module=duster&file=reset");
    assert.match(requests[0].headers.Authorization, /, client=APP$/);
    assert.equal(state.nc, 4);
    assert.equal(result.responseClass, "model-schema");
  } finally {
    global.Request = originalRequest;
  }
});

test("power submit reports effect-unconfirmed acceptance and never replays", async () => {
  let calls = 0;
  const accepted = await app.submitAppPowerCommand(auth(), { name:"reset", method:"GET" }, {
    get: async file => { calls++; assert.equal(file, "reset"); return { responseClass:"model-schema", statusCode:200, bytes:22, durationMs:8 }; }
  });
  assert.equal(calls, 1);
  assert.equal(accepted.outcome, "request-accepted");
  assert.equal(accepted.effectConfirmed, false);

  calls = 0;
  const unknown = await app.submitAppPowerCommand(auth(), { name:"reset", method:"GET" }, {
    get: async () => { calls++; throw new Error("network connection was lost"); }
  });
  assert.equal(calls, 1);
  assert.equal(unknown.outcome, "delivery-unknown");
  assert.equal(unknown.effectConfirmed, false);
});

test("probe authentication failures stop before reset without reauth", async t => {
  const failures = [
    { name:"HTTP 401", value:{ statusCode:401, error:new Error("HTTP 401") }, expected:/status1 request failed: HTTP 401/i },
    ...["UNAUTHORIZED", "TIMEOUT", "KICKOFF"].map(status => ({
      name:`XML ${status}`,
      value:{ statusCode:200, body:`<RGW><login_status>${status}</login_status></RGW>` },
      expected:new RegExp(`Authorization failed for status1: ${status}`, "i")
    }))
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const result = await failedPowerFlow("probe", failure.value);
      assert.match(result.error.message, failure.expected);
      assert.equal(requestCount(result.requests, /^http:\/\/192\.168\.21\.1\/login\.cgi$/), 1, "challenge must not repeat");
      assert.equal(requestCount(result.requests, /\/login\.cgi\?/), 1, "APP login must not repeat");
      assert.equal(requestCount(result.requests, /file=status1$/), 1, "probe must not retry");
      assert.equal(requestCount(result.requests, /file=reset$/), 0, "failed probe must block reset");
    });
  }
});

test("reset authentication failures reject after exactly one send without reauth or replay", async t => {
  const failures = [
    { name:"HTTP 401", value:{ statusCode:401, error:new Error("HTTP 401") }, expected:/reset request failed: HTTP 401/i },
    ...["UNAUTHORIZED", "TIMEOUT", "KICKOFF"].map(status => ({
      name:`XML ${status}`,
      value:{ statusCode:200, body:`<RGW><login_status>${status}</login_status></RGW>` },
      expected:new RegExp(`Authorization failed for reset: ${status}`, "i")
    }))
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const result = await failedPowerFlow("reset", failure.value);
      assert.match(result.error.message, failure.expected);
      assert.equal(requestCount(result.requests, /^http:\/\/192\.168\.21\.1\/login\.cgi$/), 1, "challenge must not repeat");
      assert.equal(requestCount(result.requests, /\/login\.cgi\?/), 1, "APP login must not repeat");
      assert.equal(requestCount(result.requests, /file=status1$/), 1, "identity probe must run once");
      assert.equal(requestCount(result.requests, /file=reset$/), 1, "destructive GET must never replay");
    });
  }
});

test("missing HTTP status fails closed before reset", async () => {
  const result = await failedPowerFlow("probe", { missingStatus:true, body:EXACT_STATUS });
  assert.match(result.error.message, /status1 request failed without an HTTP status/i);
  assert.equal(requestCount(result.requests, /^http:\/\/192\.168\.21\.1\/login\.cgi$/), 1);
  assert.equal(requestCount(result.requests, /\/login\.cgi\?/), 1);
  assert.equal(requestCount(result.requests, /file=status1$/), 1);
  assert.equal(requestCount(result.requests, /file=reset$/), 0);
});
