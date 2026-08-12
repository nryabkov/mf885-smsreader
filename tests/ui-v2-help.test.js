const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHtml, HELP_DEFINITIONS } = require('../modules/ui-v2');
const { enhanceHtml } = require('../modules/ui-v2-fixes');

function model(){return {loadedAt:Date.now(),actualModel:'MF885',actualFirmware:'2.5',softwareVersion:'3',errors:{},network:{mode:'LTE',generation:'4G',operator:'Carrier',dbm:-91,bars:3,rsrq:-9,sinr:12,band:3},battery:{percent:60,chargerCurrent:200,outputCurrent:0},traffic:{download:1024,upload:512,sessionDownload:100,sessionUpload:50,sessionSeconds:30},sms:{messages:[{id:'1',phone:'+1',content:'hello?',date:'now'}]},cellularDiagnostics:{loadedAt:Date.now(),stages:{sim:{detail:'Ready'},registration:{detail:'Registered'},pdp:{detail:'Connected'}},values:{activeApn:{value:'internet'},ipv4:{value:'10.0.0.2'},rsrp:{value:-91}}},cellularControl:{},ussd:{},deviceAccess:{}}}

test('v2 help covers overview, panel, diagnostics, capability, battery, footer, and actions',()=>{
  const html=enhanceHtml(buildHtml(model()),model());
  for(const key of ['routerPanel','onlineState','headerNetwork','connection','rsrp','battery','chargeCurrent','device','capabilities','cellularControl','diagnosticUpdated','refreshStatus','refreshNow','settings','powerAction','resetTraffic']) {
    assert.match(html,new RegExp(`data-help-key=["']${key}["']`),`missing ${key}`);
  }
});

test('every rendered help key has complete centralized content and SMS contains none',()=>{
  const html=enhanceHtml(buildHtml(model()),model());
  const markup=html.slice(0,html.indexOf('<script>'));
  const keys=[...markup.matchAll(/data-help-key=["']([^"']+)["']/g)].map(match=>match[1]);
  assert.ok(keys.length>20);
  for(const key of keys){
    assert.ok(HELP_DEFINITIONS[key],`undefined help key ${key}`);
    for(const field of ['title','meaning','guidance'])assert.ok(HELP_DEFINITIONS[key][field],`${key}.${field} is empty`);
  }
  const sms=html.match(/<section class="screen" id="screen-sms">([\s\S]*?)<\/section>/);
  assert.ok(sms);
  assert.doesNotMatch(sms[1],/help-button|data-help-key|>\?<\/button>/);
});

test('help client is delegated, accessible, dismissible, and refresh diagnostics recreate hooks',()=>{
  const html=enhanceHtml(buildHtml(model()),model());
  const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join('\n');
  assert.match(scripts,/document\.addEventListener\('click',[\s\S]*?closest\('\[data-help-key\]'\)/);
  assert.match(scripts,/role=\\?"dialog\\?"[^\n]*aria-modal=\\?"true\\?"/);
  assert.match(scripts,/\.focus\(\)/);
  assert.match(scripts,/overlayTrigger[\s\S]*?target\.focus\(\)/);
  assert.match(scripts,/e\.key==='Escape'/);
  assert.match(scripts,/classList\.contains\('help-backdrop'\)/);
  assert.match(scripts,/function renderDiagnostics[\s\S]*?helpButton\(k/);
  assert.match(scripts,/diagNetwork[\s\S]*?helpButton\(k\)/);
  assert.match(scripts,/if\(root\(\)&&root\(\)\.firstElementChild\)return/);
});
