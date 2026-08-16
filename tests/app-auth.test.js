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

function persistedAppAuth(overrides = {}) {
  const state = auth({ nc:2, ...overrides });
  const login = app.buildAppLogin(state, { queryCnonce:"1111111111111111", headerCnonce:"2222222222222222" });
  state.appAuthorization = login.authorization;
  state.nc = login.nextNc;
  return state;
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
        this.response={statusCode:200,headers:{"Set-Cookie":"app_session=test-session; Path=/; HttpOnly"}};
        return "<RGW><login_status>0</login_status></RGW>";
      }
      const isStatus = this.url.includes("file=status1");
      const isReset = this.url.includes("file=reset");
      if (!isStatus && !isReset) throw new Error(`Unexpected URL ${this.url}`);
      if ((stage === "probe" && isStatus) || (stage === "reset" && isReset)) {
        if (failure.redirect) {
          if (typeof this.onRedirect === "function") this.onRedirect({ url:"http://192.168.21.1/login.html" });
          this.response={statusCode:302,headers:{Location:"/login.html"}};
          return "<html><body>Login</body></html>";
        }
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
  const state = auth({ nc:2 });
  const login = app.buildAppLogin(state, { queryCnonce:"1111111111111111", headerCnonce:"2222222222222222" });
  const query = Object.fromEntries(new URLSearchParams(login.query));

  assert.equal(login.queryProof.uri, "/cgi/protected.cgi");
  assert.equal(login.queryProof.nc, "00000002");
  assert.equal(login.headerProof.uri, "/cgi/xml_action.cgi");
  assert.equal(login.headerProof.nc, "00000003");
  assert.notEqual(login.queryProof.response, login.headerProof.response);
  assert.equal(query.client, "APP");
  assert.equal(query.cnonce, "1111111111111111");
  assert.equal(query.response, login.queryProof.response);
  assert.equal(login.queryProof.response, "7a549f577adbaf84a231357814c11463");
  assert.equal(login.headerProof.response, "ea39cdc5ce7a7f8231aea4b54af6f883");
  assert.match(login.authorization, /uri="\/cgi\/xml_action\.cgi"/);
  assert.match(login.authorization, /nc=00000003/);
  assert.match(login.authorization, /cnonce="2222222222222222"/);
  assert.match(login.authorization, /, client=APP$/);
  assert.equal(login.nextNc, 4);
  assert.equal(state.nc, 2, "pure builder must not mutate the live session");
});

test("live power flow reuses the exact APK login header for status and one reset", async () => {
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
      if (this.url.includes("/login.cgi?")) {
        this.response={statusCode:200,headers:{"Set-Cookie":"app_session=test-session; Path=/; HttpOnly"}};
        return "<RGW><login_status>0</login_status></RGW>";
      }
      if (this.url.includes("file=status1")) return "<RGW><model>LV01</model><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num></RGW>";
      if (this.url.includes("file=reset")) return "<RGW><reboot/></RGW>";
      throw new Error(`Unexpected URL ${this.url}`);
    }
  };
  try {
    const result = await app.executePowerCommand({}, "reboot");
    assert.equal(result.outcome, "request-accepted");
    assert.equal(result.effectConfirmed, false);
    const report = JSON.parse(result.diagnostics);
    assert.equal(report.authFlow, "zmi-apk-1.2.42-persisted-login-header");
    assert.equal(report.session.initialNonceCount, 2);
    assert.equal(report.session.loginHeaderNonceCount, 3);
    assert.equal(report.session.authorizationPersisted, true);
    assert.equal(report.session.authorizationReusedForProbeAndCommand, true);
    assert.equal(report.session.sessionCookieReceived, true);
    assert.equal(report.session.sessionCookieSent, true);
    assert.equal(report.safety.destructiveAttempts, 1);
    assert.equal(report.safety.automaticRetries, 0);
    assert.equal(report.safety.replayed, false);
    assert.doesNotMatch(result.diagnostics, /test-session|Digest username|cnonce|response=/i);
    assert.equal(requests.length, 4);
    const [challenge, login, status, reset] = requests;
    assert.equal(challenge.url, "http://192.168.21.1/login.cgi");
    assert.equal(typeof challenge.onRedirect, "function");
    assert.match(login.url, /\/login\.cgi\?.*client=APP/);
    assert.match(login.headers.Authorization, /uri="\/cgi\/xml_action\.cgi".*client=APP$/);
    assert.match(login.headers.Authorization, /nc=00000003/);
    assert.equal(typeof login.onRedirect, "function");
    assert.match(status.url, /file=status1$/);
    assert.match(reset.url, /file=reset$/);
    assert.equal(status.headers.Authorization, login.headers.Authorization);
    assert.equal(reset.headers.Authorization, login.headers.Authorization);
    assert.equal(typeof status.onRedirect, "function");
    assert.equal(typeof reset.onRedirect, "function");
    assert.equal(login.headers.Cookie, undefined);
    assert.equal(status.headers.Cookie, "app_session=test-session");
    assert.equal(reset.headers.Cookie, "app_session=test-session");
    assert.equal(reset.method, "GET");
    assert.equal(reset.body, undefined);
    assert.equal(reset.timeoutInterval, 5);
    assert.equal(reset.headers["X-Requested-With"], undefined);
    assert.equal(requests.filter(request => /file=reset$/.test(request.url)).length, 1);
  } finally {
    global.Request = originalRequest;
  }
});

test("APP GET headers are APK-faithful and exclude WebUI identity headers", () => {
  const state = persistedAppAuth();
  const headers = app.appRequestHeaders(state, "GET");
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

test("APP reset transport is one GET with no body and preserves the persisted header", async () => {
  const originalRequest = global.Request;
  const requests = [];
  global.Request = class {
    constructor(url) { this.url=url; requests.push(this); }
    async loadString() { this.response={statusCode:200,headers:{}}; return "<RGW><reboot/></RGW>"; }
  };
  try {
    const state = persistedAppAuth();
    const authorization = state.appAuthorization;
    const nextNc = state.nc;
    const result = await app.appXmlGet(state, "reset", 5);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].body, undefined);
    assert.equal(requests[0].timeoutInterval, 5);
    assert.equal(requests[0].url, "http://192.168.21.1/xml_action.cgi?method=get&module=duster&file=reset");
    assert.match(requests[0].headers.Authorization, /, client=APP$/);
    assert.equal(requests[0].headers.Authorization, authorization);
    assert.equal(state.nc, nextNc);
    assert.equal(result.responseClass, "model-schema");
    assert.equal(result.authHeaderReused, true);
  } finally {
    global.Request = originalRequest;
  }
});

test("APP session cookie extraction is bounded to cookie name/value pairs", () => {
  assert.equal(app.responseCookieHeader({ cookies:[{name:"session",value:"abc=123"}] }), "session=abc=123");
  assert.equal(app.responseCookieHeader({ cookies:[{name:"wrong_path",value:"one",path:"/login.cgi"}] }), "");
  assert.equal(app.responseCookieHeader({ cookies:[{name:"wrong_domain",value:"one",domain:"example.com",path:"/"}] }), "");
  assert.equal(app.responseCookieHeader({ cookies:[{name:"secure_only",value:"one",domain:"192.168.21.1",path:"/",secure:true}] }), "");
  assert.equal(app.responseCookieHeader({ headers:{"Set-Cookie":"sid=one; Path=/; HttpOnly, token=two; Path=/"} }), "sid=one; token=two");
  assert.equal(app.responseCookieHeader({ headers:{"Set-Cookie":"login_only=one; Path=/login.cgi"} }), "");
  assert.equal(app.responseCookieHeader({ headers:{"Set-Cookie":"safe=name; injected=1\r\nX-Evil: yes"} }), "safe=name");
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
      const report=JSON.parse(result.error.diagnostics);
      assert.equal(report.safety.destructiveAttempts,0);
      assert.equal(report.command.response.statusCode,failure.value.statusCode===undefined?null:failure.value.statusCode);
      assert.equal(report.command.response.responseClass,failure.value.body?`auth-${failure.value.body.match(/<login_status>([^<]+)/)[1].toLowerCase()}`:"empty");
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
      const report=JSON.parse(result.error.diagnostics);
      assert.equal(report.safety.destructiveAttempts,1);
      assert.equal(report.command.response.statusCode,failure.value.statusCode);
      assert.equal(report.session.authorizationReusedForProbeAndCommand,true);
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
  assert.equal(JSON.parse(result.error.diagnostics).safety.destructiveAttempts,0);
  assert.equal(requestCount(result.requests, /^http:\/\/192\.168\.21\.1\/login\.cgi$/), 1);
  assert.equal(requestCount(result.requests, /\/login\.cgi\?/), 1);
  assert.equal(requestCount(result.requests, /file=status1$/), 1);
  assert.equal(requestCount(result.requests, /file=reset$/), 0);
});

test("redirected and HTML command responses fail closed without replay", async t => {
  for (const failure of [
    { name:"redirect", value:{redirect:true}, expected:/reset request was redirected/i },
    { name:"HTML 200", value:{statusCode:200,body:"<!doctype html><html><body>Login</body></html>"}, expected:/unexpected html-response/i }
  ]) {
    await t.test(failure.name, async () => {
      const result=await failedPowerFlow("reset",failure.value);
      assert.match(result.error.message,failure.expected);
      const report=JSON.parse(result.error.diagnostics);
      assert.equal(report.safety.destructiveAttempts,1);
      assert.equal(report.command.response.statusCode,failure.value.redirect?302:200);
      assert.equal(report.command.response.responseClass,"html-response");
      assert.ok(report.command.responseFingerprint);
      assert.equal(requestCount(result.requests,/file=reset$/),1);
    });
  }
});

test("connection loss returns one copyable delivery-unknown report without replay", async () => {
  const originalRequest=global.Request,requests=[];
  global.Request=class {
    constructor(url){this.url=url;requests.push(this);}
    async loadString(){
      if(this.url===ROUTER_LOGIN){this.response={statusCode:401,headers:{"WWW-Authenticate":'Digest realm="Highwmg", nonce="1000", qop="auth"'}};throw new Error("HTTP 401 challenge");}
      if(this.url.includes("/login.cgi?")){this.response={statusCode:200,headers:{"Set-Cookie":"sid=one; Path=/"}};return "<RGW><login_status>0</login_status></RGW>";}
      if(this.url.includes("file=status1")){this.response={statusCode:200,headers:{}};return EXACT_STATUS;}
      if(this.url.includes("file=reset"))throw new Error("network connection was lost");
      throw new Error(`Unexpected URL ${this.url}`);
    }
  };
  try{
    const result=await app.executePowerCommand({},"reboot"),report=JSON.parse(result.diagnostics);
    assert.equal(result.outcome,"delivery-unknown");
    assert.equal(requestCount(requests,/file=reset$/),1);
    assert.equal(report.safety.destructiveAttempts,1);
    assert.equal(report.safety.automaticRetries,0);
    assert.equal(report.safety.replayed,false);
    assert.equal(report.session.authorizationReusedForProbeAndCommand,true);
    assert.equal(report.command.response.statusCode,null);
  } finally {global.Request=originalRequest;}
});
