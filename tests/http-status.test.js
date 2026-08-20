const test = require("node:test");
const assert = require("node:assert/strict");

global.Script = { name: () => "MF885 Test" };
const app = require("../scriptable.js");

function auth() {
  return { realm: "router", nonce: "nonce-secret", qop: "auth", ha1: "digest-secret", nc: 1 };
}

function request(url, statusCode, body) {
  return {
    url,
    method: "GET",
    response: null,
    async loadString() {
      this.response = { statusCode, headers: { Authorization: "Digest secret" } };
      return body;
    }
  };
}

test("authenticated requests reject HTTP 404 with a sanitized operation-specific error", async () => {
  const result = app.authenticatedRequest(
    auth(),
    () => request("http://admin:password@192.168.21.1/cgi/xml_action.cgi?token=secret&file=status1", 404, "<password>response-secret</password>"),
    "status1",
    false
  );

  await assert.rejects(result, error => {
    assert.equal(error.message, "status1 request failed: HTTP 404 from /cgi/xml_action.cgi");
    assert.doesNotMatch(error.message, /password|secret|token|nonce|digest|<password>/i);
    return true;
  });
});

test("HTTP failures produce rejected Promise.allSettled entries", async () => {
  const settled = await Promise.allSettled([
    app.authenticatedRequest(auth(), () => request("http://router/cgi/xml_action.cgi?file=status1", 404, "private status body"), "status1", false),
    app.authenticatedRequest(auth(), () => request("http://router/cgi/xml_action.cgi?file=message", 404, "private message body"), "message", false)
  ]);

  assert.deepEqual(settled.map(entry => entry.status), ["rejected", "rejected"]);
  assert.match(settled[0].reason.message, /^status1 request failed: HTTP 404/);
  assert.match(settled[1].reason.message, /^message request failed: HTTP 404/);
});

test("loadModel exposes request errors and does not parse or continue rejected initial requests", async () => {
  const originalRequest = global.Request;
  const calls = [];
  global.Request = class {
    constructor(url) { this.url = url; this.method = "GET"; this.headers = {}; this.response = null; }
    async loadString() {
      const file = new URL(this.url).searchParams.get("file");
      calls.push(file);
      this.response = { statusCode: 404, headers: {} };
      return file === "status1" ? "<RGW><password>status-secret</password></RGW>" : "<RGW><message><content>sms-secret</content></message></RGW>";
    }
  };

  try {
    const model = await app.loadModel(auth());
    assert.equal(model.errors.status, "status1 request failed: HTTP 404 from /xml_action.cgi");
    assert.equal(model.errors.statusRequest, true);
    assert.equal(model.errors.sms, "message request failed: HTTP 404 from /xml_action.cgi");
    assert.equal(model.sms.loading, false);
    assert.deepEqual(calls, ["status1", "message"]);

    const html = app.buildHtml(model);
    assert.match(html, /Status request error/);
    assert.match(html, /status1 request failed: HTTP 404 from \/xml_action\.cgi/);
    assert.match(html, /message request failed: HTTP 404 from \/xml_action\.cgi/);
    assert.doesNotMatch(html, /Status compatibility warning|status-secret|sms-secret/);
  } finally {
    global.Request = originalRequest;
  }
});

test("dashboard does not load additional SMS pages after the initial message request fails", async () => {
  let closePresentation;
  const closed = new Promise(resolve => { closePresentation = resolve; });
  let historyLoads = 0;
  let sleeps = 0;
  const failedModel = {
    sms: { messages: [], loading: false }, errors: { sms: "message request failed: HTTP 404 from /cgi/xml_action.cgi" },
    network: {}, battery: {}, traffic: {}, cellularDiagnostics: {}, ussd: {}, deviceAccess: {}, cellularControl: {}, loadedAt: Date.now()
  };
  const web = {
    loadHTML: async () => {}, present: () => closed,
    evaluateJavaScript: async source => source.includes("window.__zmiCommandQueue=[]") ? true : null
  };
  const flow = app.dashboardFlow(auth(), "", "sms", {
    loadModel: async () => failedModel, buildHtml: app.buildHtml, WebView: () => web, showMessage: async () => {},
    loadRemainingSms: async () => { historyLoads++; }, createDispatcher: () => async () => {},
    sleep: async () => { if (++sleeps === 2) closePresentation(); }
  });

  await flow;
  assert.equal(historyLoads, 0);
});

test("polling marks a failed status request explicitly for the persistent UI", async () => {
  const originalRequest=global.Request;
  global.Request=class {
    constructor(url){this.url=url;this.method="GET";this.headers={};this.response=null;}
    async loadString(){this.response={statusCode:503,headers:{}};return "<RGW><error>offline</error></RGW>";}
  };
  try {
    const snapshot=await app.loadPollingSnapshot(auth(),{messages:[],loadedPages:0,totalPages:null,totalMessages:null});
    assert.equal(snapshot.errors.statusRequest,true);
    assert.match(snapshot.errors.status,/status1 request failed: HTTP 503/);
    const payload=app.webPollPayload(snapshot);
    assert.equal(payload.errors.statusRequest,true);
    assert.equal(payload.networkMode,"Unknown");
    assert.equal(payload.batteryPercent,undefined);
  } finally { global.Request=originalRequest; }
});
