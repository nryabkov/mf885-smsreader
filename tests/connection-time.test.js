const test = require('node:test');
const assert = require('node:assert/strict');
global.Script = { name: () => 'MF885 Test' };
const app = require('../scriptable.js');

function model(traffic = {}) {
  return {
    tab: 'router', loadedAt: Date.now(),
    sms: { messages: [], loading: false }, errors: {},
    network: {}, battery: {}, traffic,
    cellularDiagnostics: {},
    ussd: { state: 'unchecked', detail: 'Not checked' },
    deviceAccess: { state: 'unchecked', detail: 'Not checked', capabilities: [] },
    cellularControl: { state: 'unchecked', detail: 'Not checked' }
  };
}

test('WAN connection time comes from current-session conn_* counters', () => {
  const xml = '<RGW><WanStatistics>' +
    '<conn_days>3</conn_days><conn_hours>4</conn_hours>' +
    '<conn_minutes>17</conn_minutes><conn_seconds>12</conn_seconds>' +
    '</WanStatistics></RGW>';
  const traffic = app.parseTraffic(xml);
  assert.equal(traffic.sessionSeconds, 274632);
  assert.equal(app.formatDuration(traffic.sessionSeconds), '3d 04h 17m');
});

test('connection time is labelled as WAN connection time, not router uptime', () => {
  const html = app.buildHtml(model({ sessionSeconds: 274632 }));
  const toolbar = html.slice(html.indexOf('<section class="power-toolbar"'), html.indexOf('<nav class="seg dashboard-tabs"'));
  assert.match(toolbar, /Connection time: <strong data-connection-time>3d 04h 17m<\/strong>/);
  assert.doesNotMatch(toolbar, /Uptime:/);
  assert.match(toolbar, /data-power-action="powerOff"/);
});

test('missing connection counter has an explicit fallback', () => {
  const html = app.buildHtml(model({}));
  assert.match(html, /Connection time: <strong data-connection-time>—<\/strong>/);
});

test('normal status polling carries and updates connection time', () => {
  const payload = app.webPollPayload(model({ sessionSeconds: 274632 }));
  assert.equal(payload.connectionTime, '3d 04h 17m');
  const js = app.clientScript(model());
  assert.match(js, /\[data-connection-time\]/);
  assert.match(js, /payload\.connectionTime/);
});
