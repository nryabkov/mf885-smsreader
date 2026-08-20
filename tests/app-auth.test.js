const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../scriptable.js");
const power = require("../modules/power-compatibility.js");

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

test("APP login accepts only the exact captured Mongoose success envelope", async () => {
  const result=app.assertAppLoginResponse({response:{statusCode:200},redirectCount:0,exception:null,text:"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nServer: Mongoose/3.0\r\n\r\n"});
  assert.deepEqual(result,{responseClass:"captured-mongoose-login-envelope",statusCode:200});
});

test("APP login still rejects arbitrary HTTP 200 text", async () => {
  assert.throws(()=>app.assertAppLoginResponse({response:{statusCode:200},redirectCount:0,exception:null,text:"login accepted"}),/unexpected text-response/i);
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
    const software = { version:"3.1.8-ui2", revision:"a".repeat(40) };
    const result = await app.executePowerCommand({}, "reboot", { software });
    assert.equal(result.outcome, "request-accepted");
    assert.equal(result.effectConfirmed, false);
    const report = JSON.parse(result.diagnostics);
    assert.deepEqual(report.software, software);
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
    assert.equal(challenge.timeoutInterval, 10);
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
    assert.equal(app.readLastPowerReport(), result.diagnostics, "the redacted result must be journaled before UI dispatch");
  } finally {
    global.Request = originalRequest;
  }
});

test("mocked power-off flow has reboot-parity without touching a live router", async () => {
  const originalRequest=global.Request;
  const requests=[];
  global.Request=class {
    constructor(url){this.url=url;requests.push(this);}
    async loadString(){
      if(this.url===ROUTER_LOGIN){this.response={statusCode:401,headers:{"WWW-Authenticate":'Digest realm="Highwmg", nonce="1000", qop="auth"'}};throw new Error("HTTP 401 challenge");}
      if(this.url.includes("/login.cgi?")){this.response={statusCode:200,headers:{"Set-Cookie":"app_session=poweroff-test; Path=/; HttpOnly"}};return "<RGW><login_status>0</login_status></RGW>";}
      if(this.url.includes("file=status1")){this.response={statusCode:200,headers:{}};return EXACT_STATUS;}
      if(this.url.includes("file=poweroff")){this.response={statusCode:200,headers:{}};return "<RGW><shutdown/></RGW>";}
      throw new Error(`Unexpected URL ${this.url}`);
    }
  };
  try {
    const result=await app.executePowerCommand({},"powerOff"),report=JSON.parse(result.diagnostics);
    assert.equal(result.outcome,"request-accepted");
    assert.match(result.message,/shutdown effect is not yet confirmed/i);
    assert.doesNotMatch(result.message,/reboot effect/i);
    assert.equal(requests.length,4);
    const login=requests.find(request=>request.url.includes("/login.cgi?"));
    const status=requests.find(request=>/file=status1$/.test(request.url));
    const poweroff=requests.find(request=>/file=poweroff$/.test(request.url));
    assert.ok(login&&status&&poweroff);
    assert.equal(status.headers.Authorization,login.headers.Authorization);
    assert.equal(poweroff.headers.Authorization,login.headers.Authorization);
    assert.equal(status.headers.Cookie,"app_session=poweroff-test");
    assert.equal(poweroff.headers.Cookie,"app_session=poweroff-test");
    assert.equal(poweroff.method,"GET");
    assert.equal(poweroff.body,undefined);
    assert.equal(requestCount(requests,/file=poweroff$/),1);
    assert.equal(requestCount(requests,/file=reset$/),0);
    assert.equal(report.command.file,"poweroff");
    assert.equal(report.command.effectConfirmed,false);
    assert.equal(report.safety.destructiveAttempts,1);
    assert.equal(report.safety.automaticRetries,0);
    assert.equal(report.safety.replayed,false);
  } finally { global.Request=originalRequest; }
});

test("standalone APP auth probe is GET-only and never touches reset or poweroff", async () => {
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
        this.response={statusCode:200,headers:{"Set-Cookie":"sid=probe; Path=/"}};
        return "<RGW><login_status>0</login_status></RGW>";
      }
      if (this.url.includes("file=status1")) {
        this.response={statusCode:200,headers:{}};
        return EXACT_STATUS;
      }
      throw new Error(`Unexpected URL ${this.url}`);
    }
  };
  try {
    const software={version:"3.1.8-ui2",revision:"b".repeat(40)};
    const result=await app.runAppAuthProbe({software}),report=JSON.parse(result.diagnostics);
    assert.equal(result.ok,true);
    assert.equal(report.mode,"app-auth-probe");
    assert.equal(report.outcome,"authenticated");
    assert.deepEqual(report.software,software);
    assert.equal(report.identity.model,"MF885");
    assert.equal(report.identity.exactFirmware,true);
    assert.equal(report.session.authorizationPersisted,true);
    assert.equal(report.session.authorizationReusedForProbe,true);
    assert.equal(report.safety.writesAttempted,0);
    assert.equal(report.safety.destructiveAttempts,0);
    assert.deepEqual(report.safety.methodsUsed,["GET"]);
    assert.equal(requests.length,3);
    assert.ok(requests.every(request=>request.method==="GET"));
    assert.ok(requests.every(request=>request.body===undefined));
    assert.equal(requestCount(requests,/file=status1$/),1);
    assert.equal(requestCount(requests,/file=(?:reset|poweroff)$/),0);
    assert.doesNotMatch(result.diagnostics,/sid=probe|Digest username|cnonce|response=/i);
  } finally { global.Request=originalRequest; }
});

test("APP auth probe assigns a login failure to the login stage", async () => {
  const stage={statusCode:403,bytes:12,durationMs:4,responseClass:"html-response",redirectCount:0};
  await assert.rejects(
    app.runAppAuthProbe({createAppSession:async()=>{const error=new Error("APP login request failed: HTTP 403");error.appStage=stage;throw error;}}),
    error=>{
      const report=JSON.parse(error.diagnostics);
      assert.equal(report.phase,"app-login");
      assert.equal(report.session.login.statusCode,403);
      assert.equal(report.session.identityProbe,null);
      assert.equal(report.safety.destructiveAttempts,0);
      return true;
    }
  );
});

test("last power report is persisted in Keychain and remains redacted/copyable", () => {
  const originalKeychain=global.Keychain,stored=new Map();
  global.Keychain={
    contains:key=>stored.has(key),
    get:key=>stored.get(key),
    set:(key,value)=>stored.set(key,value)
  };
  try {
    const source=JSON.stringify({schema:1,mode:"power-command",software:{version:"3.1.8-ui2",revision:"c".repeat(40)},error:null},null,2);
    const saved=app.rememberLastPowerReport(source);
    assert.equal(stored.size,1);
    assert.equal(app.readLastPowerReport(),saved);
    assert.deepEqual(JSON.parse(saved).software,{version:"3.1.8-ui2",revision:"c".repeat(40)});
  } finally { global.Keychain=originalKeychain; }
});

test("credential-bearing power errors stay valid JSON and are redacted before persistence", () => {
  const source=JSON.stringify({
    schema:1,
    mode:"power-command",
    error:"Authorization: Digest username=admin, nonce=secret-nonce; Cookie: sid=secret-cookie"
  },null,2);
  const saved=app.rememberLastPowerReport(source);
  assert.ok(saved,"a redacted report must still be persisted");
  const report=JSON.parse(saved);
  assert.match(report.error,/<redacted>/);
  assert.doesNotMatch(saved,/secret-nonce|secret-cookie|Digest username/);
  assert.equal(app.readLastPowerReport(),saved);
});

test("power flow journals the APP-login checkpoint before awaiting network I/O", async () => {
  let rejectLogin;
  const stalled=new Promise((_,reject)=>{rejectLogin=reject;});
  const pending=app.executePowerCommand({},"reboot",{
    createAppSession:()=>stalled,
    software:{version:"3.1.8-ui2",revision:"d".repeat(40)}
  });
  const checkpoint=JSON.parse(app.readLastPowerReport());
  assert.equal(checkpoint.checkpoint,"app-login");
  assert.equal(checkpoint.command.outcome,"in-progress");
  assert.equal(checkpoint.safety.destructiveAttempts,0);
  rejectLogin(new Error("test login stop"));
  await assert.rejects(pending,/test login stop/);
});

test("power flow journals a possible destructive attempt before awaiting one-shot dispatch", async () => {
  let rejectSubmit;
  const stalled=new Promise((_,reject)=>{rejectSubmit=reject;});
  const profile=power.resolve({model:"LV01",hardware:"",firmware:power.EXACT_FIRMWARE});
  const pending=app.executePowerCommand({},"reboot",{
    profile,
    writeThenVerify:()=>stalled,
    software:{version:"3.1.8-ui2",revision:"e".repeat(40)}
  });
  const checkpoint=JSON.parse(app.readLastPowerReport());
  assert.equal(checkpoint.checkpoint,"destructive-request-started");
  assert.equal(checkpoint.command.file,"reset");
  assert.equal(checkpoint.command.outcome,"in-progress");
  assert.equal(checkpoint.safety.destructiveAttempts,1);
  rejectSubmit(new Error("test dispatch stop"));
  await assert.rejects(pending,/test dispatch stop/);
  const failed=JSON.parse(app.readLastPowerReport());
  assert.equal(failed.checkpoint,"failed");
  assert.equal(failed.safety.destructiveAttempts,1);
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

test("reboot and power-off submit once, stay effect-unconfirmed, and never replay", async () => {
  for(const file of ["reset","poweroff"]){
    let calls=0;
    const accepted=await app.submitAppPowerCommand(auth(),{name:file,method:"GET"},{
      get:async actual=>{calls++;assert.equal(actual,file);return {responseClass:"model-schema",statusCode:200,bytes:22,durationMs:8};}
    });
    assert.equal(calls,1);
    assert.equal(accepted.outcome,"request-accepted");
    assert.equal(accepted.effectConfirmed,false);

    calls=0;
    const unknown=await app.submitAppPowerCommand(auth(),{name:file,method:"GET"},{
      get:async()=>{calls++;throw new Error("network connection was lost");}
    });
    assert.equal(calls,1);
    assert.equal(unknown.outcome,"delivery-unknown");
    assert.equal(unknown.effectConfirmed,false);
  }
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
