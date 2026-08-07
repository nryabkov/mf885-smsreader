const test = require('node:test');
const assert = require('node:assert/strict');
global.Script = { name: () => 'MF885 Test' };
const app = require('../scriptable.js');

function model(tab='sms') { return {tab,loadedAt:Date.now(),sms:{messages:[{id:'1',phone:'+1',date:'now',content:'hello'}],loading:true},errors:{},network:{},battery:{},traffic:{},cellularDiagnostics:{},ussd:{state:'unchecked',detail:'Not checked'},deviceAccess:{state:'unchecked',detail:'Not checked',capabilities:[]},cellularControl:{state:'unchecked',detail:'Not checked'}}; }

test('initial HTML is immediately useful and marks history as loading',()=>{const html=app.buildHtml(model());assert.match(html,/hello/);assert.match(html,/Loading message history…/);assert.match(html,/Not checked/);assert.match(html,/data-detect-experimental/);assert.match(html,/Detect experimental features/);assert.doesNotMatch(html,/data-detect="ussd"/);});
test('SMS and router models render a non-empty main with the requested active tab',()=>{for(const tab of ['sms','router']){const html=app.buildHtml(model(tab));const main=html.match(/<main>([\s\S]*?)<\/main>/i);assert.ok(main&&main[1].trim(),`${tab} main must not be empty`);assert.match(html,new RegExp(`<section id="${tab}" class="tab active"`));}});
test('dashboard has a readiness marker and native Alert fallback for WebView failures',()=>{const source=require('node:fs').readFileSync(require.resolve('../scriptable.js'),'utf8');assert.match(source,/dataset\.zmiReady\s*=\s*'true'/);assert.match(source,/WebView loadHTML stage failed/);assert.match(source,/WebView present stage failed/);const fallback=source.match(/async function showMessage[\s\S]*?\n}/);assert.ok(fallback);assert.match(fallback[0],/new Alert\(\)/);assert.doesNotMatch(fallback[0],/new WebView\(\)/);});

function dashboardLifecycle(documentState) {
  const calls=[];
  let closePresentation;
  const closed=new Promise(resolve=>{closePresentation=resolve});
  const web={
    loadHTML:async()=>{calls.push('loadHTML')},
    present:()=>{calls.push('present');return closed},
    evaluateJavaScript:async script=>{
      if(script.includes("document.querySelector('main')")){calls.push('documentCheck');return documentState}
      if(script.includes('window.__zmiCommandQueue=[]')){calls.push('registerChannel');return true}
      if(script.includes('window.__zmiCommandQueue &&'))return null;
      calls.push('webUpdate');
      return null;
    },
    dismiss:()=>calls.push('dismiss')
  };
  const alerts=[];
  const flow=app.dashboardFlow({},'', 'sms',{
    loadModel:async()=>model(),buildHtml:app.buildHtml,WebView:()=>web,
    showMessage:async(title,message)=>alerts.push({title,message}),
    loadRemainingSms:async(_auth,sms)=>sms,
    createDispatcher:()=>async()=>{},sleep:()=>new Promise(resolve=>setImmediate(resolve))
  });
  return {calls,alerts,flow,closePresentation};
}

test('dashboardFlow presents and checks the rendered document before registering command polling',async()=>{
  const fixture=dashboardLifecycle({readyState:'complete',hasMain:true,mainText:'Dashboard',body:{scrollWidth:390,scrollHeight:844,width:390,height:844},zmiReady:'true'});
  while(!fixture.calls.includes('registerChannel'))await new Promise(resolve=>setImmediate(resolve));
  fixture.closePresentation();
  await fixture.flow;
  assert.deepEqual(fixture.calls.slice(0,4),['loadHTML','present','documentCheck','registerChannel']);
  assert.deepEqual(fixture.alerts,[]);
});

test('dashboardFlow dismisses an empty rendered document and shows document diagnostics',async()=>{
  const state={readyState:'complete',hasMain:true,mainText:'',body:{scrollWidth:390,scrollHeight:0,width:390,height:0},zmiReady:''};
  const fixture=dashboardLifecycle(state);
  await fixture.flow;
  assert.deepEqual(fixture.calls,['loadHTML','present','documentCheck','dismiss']);
  assert.equal(fixture.alerts.length,1);
  assert.match(fixture.alerts[0].message,/WebView document check failed/);
  assert.match(fixture.alerts[0].message,/"mainText": ""/);
  assert.match(fixture.alerts[0].message,/"zmiReady": ""/);
});
test('dashboardFlow uses the native Scriptable Timer when no sleep override is provided',async()=>{
  const originalTimer=global.Timer;
  const originalSetTimeout=global.setTimeout;
  const scheduled=[];
  let closePresentation;
  const closed=new Promise(resolve=>{closePresentation=resolve});
  global.Timer={schedule:(milliseconds,repeats,callback)=>{
    scheduled.push({milliseconds,repeats});
    if(scheduled.length===2)closePresentation();
    queueMicrotask(callback);
  }};
  global.setTimeout=()=>{throw new Error('native dashboard sleep must not use setTimeout')};
  const web={
    loadHTML:async()=>{},present:()=>closed,
    evaluateJavaScript:async script=>script.includes("document.querySelector('main')")
      ? {readyState:'complete',hasMain:true,mainText:'Dashboard',body:{scrollWidth:390,scrollHeight:844,width:390,height:844},zmiReady:'true'}
      : script.includes('window.__zmiCommandQueue=[]') ? true : null
  };
  try {
    await app.dashboardFlow({},'', 'sms',{
      loadModel:async()=>model(),buildHtml:app.buildHtml,WebView:()=>web,
      showMessage:async()=>{},loadRemainingSms:async(_auth,sms)=>sms,
      createDispatcher:()=>async()=>{}
    });
  } finally {
    global.Timer=originalTimer;
    global.setTimeout=originalSetTimeout;
  }
  assert.deepEqual(scheduled,[{milliseconds:0,repeats:false},{milliseconds:150,repeats:false}]);
});
test('native dashboard sleep paths do not contain setTimeout Promise wrappers',()=>{
  const source=require('node:fs').readFileSync(require.resolve('../scriptable.js'),'utf8');
  const dashboard=source.match(/async function dashboardFlow[\s\S]*?\n}/);
  const nextCommand=source.match(/async function nextWebViewCommand[\s\S]*?\n}/);
  assert.ok(dashboard);
  assert.ok(nextCommand);
  for(const nativeFunction of [dashboard[0],nextCommand[0]])assert.doesNotMatch(nativeFunction,/new Promise\s*\(\s*resolve\s*=>\s*setTimeout/);
});
test('client applies complete and partial SMS history without document reload',()=>{const js=app.clientScript(model());assert.match(js,/window\.zmiApplySmsHistory=function/);assert.match(js,/payload\.warning/);assert.match(js,/Message history is incomplete|⚠️/);assert.doesNotMatch(js,/location\.(?:href|assign|replace)|location\s*=/);});
test('document has no Scriptable relaunch links',()=>{const text=app.buildHtml(model())+app.clientScript(model());assert.doesNotMatch(text,/scriptable:\/\/\/run|This action will reopen|runUrl|navigationInProgress/);});
test('client exposes targeted status, capability and action updates',()=>{const js=app.clientScript(model());for(const name of ['zmiApplyStatus','zmiApplySmsHistory','zmiApplyCapability','zmiApplyActionResult'])assert.match(js,new RegExp('window\\.'+name));assert.match(js,/CustomEvent\('ZMICommand'/);});
test('tab, scroll and unsent SMS draft survive DOM updates',()=>{const js=app.clientScript(model());assert.match(js,/zmiTab/);assert.match(js,/zmiScrollY/);assert.match(js,/zmiSmsDraft/);assert.match(js,/window\.scrollTo/);});
test('SMS pages merge with deduplication',()=>{let r={messages:[],loadedPages:0,totalPages:null,totalMessages:null};app.mergeSmsPage(r,{page:1,totalPages:2,totalMessages:2,messages:[{id:'1',phone:'a',date:'d',content:'x'}]});app.mergeSmsPage(r,{page:2,messages:[{id:'1',phone:'a',date:'d',content:'x'},{id:'2',phone:'b',date:'d',content:'y'}]});assert.deepEqual(r.messages.map(x=>x.id),['1','2']);assert.equal(r.loadedPages,2);});
test('in-flight guard shares concurrent operation',async()=>{const guard=app.createInFlightGuard();let calls=0,release;const gate=new Promise(r=>release=r);const a=guard.run(async()=>{calls++;await gate;return 7});const b=guard.run(async()=>{calls++;return 8});assert.equal(a,b);release();assert.equal(await b,7);assert.equal(calls,1);});
test('capability cache keeps positives and expires negative entries after 24 hours',()=>{const now=Date.now(),base={schema:1,host:'router',checkedAt:now};assert.equal(app.capabilityCacheValid({...base,positive:true},'router',now+99*86400000),true);assert.equal(app.capabilityCacheValid({...base,positive:false},'router',now+23*3600000),true);assert.equal(app.capabilityCacheValid({...base,positive:false},'router',now+25*3600000),false);assert.equal(app.capabilityCacheValid({...base,positive:true,schema:2},'router',now),false);});
test('dispatcher whitelists actions, validates parameters and correlates ids',async()=>{const replies=[];const dispatch=app.createWebViewDispatcher({refresh:async()=>({fresh:true}),sendSms:async p=>p.text},r=>replies.push(r));assert.equal((await dispatch({id:'one',action:'refresh',params:{}})).id,'one');assert.equal((await dispatch({id:'two',action:'sendSms',params:{to:'+1',text:'hi'}})).result,'hi');assert.equal((await dispatch({id:'bad',action:'arbitraryFunction',params:{}})).ok,false);assert.deepEqual(replies.map(x=>x.id),['one','two','bad']);});
test('dispatcher requires danger confirmation and converts handler errors',async()=>{let called=0;const dispatch=app.createWebViewDispatcher({reboot:async()=>{called++;return 'ok'},refresh:async()=>{throw new Error('offline')} });assert.equal((await dispatch({id:'a',action:'reboot',params:{}})).ok,false);assert.equal(called,0);assert.equal((await dispatch({id:'b',action:'reboot',params:{confirmed:true}})).ok,true);const failed=await dispatch({id:'c',action:'refresh',params:{}});assert.equal(failed.ok,false);assert.equal(failed.error,'offline');});
test('arbitrary function names can never be selected by WebView data',()=>{assert.throws(()=>app.validateWebViewCommand({id:'x',action:'constructor',params:{}}),/not allowed/);assert.throws(()=>app.validateWebViewCommand({id:'x',action:'cellularMode',params:{mode:'evil',confirmed:true}}),/Invalid cellular mode/);});

test('polled empty SMS history renders an empty card and preserves its warning',()=>{
  const js=app.clientScript(model());
  assert.match(js,/messages\.length===0/);
  assert.match(js,/empty\.className='card empty'/);
  assert.match(js,/title\.textContent='No SMS found'/);
  assert.match(js,/payload\.warning\?'⚠️ '\+payload\.warning/);
});

test('tabs have independent scroll positions and unsaved tabs restore to top',()=>{
  const js=app.clientScript(model());
  assert.match(js,/zmiScrollY:'\+current\.id/);
  assert.match(js,/zmiScrollY:'\+active\.id/);
  assert.match(js,/saved===null\?0:Number\(saved\)\|\|0/);
  assert.doesNotMatch(js,/safeStorage(?:Get|Set)\('zmiScrollY'/);
});

test('structurally incompatible status1 gets a profile-specific aggregate error',()=>{
  const error=app.statusCompatibilityError('<RGW><status><foo>ok</foo></status></RGW>',{id:'fixture-profile'});
  assert.match(error,/Router responded successfully/); assert.match(error,/fixture-profile/);
  for(const missing of ['WanStatistics','batteryinfo','cellular\/network fields'])assert.match(error,new RegExp(missing));
  assert.equal(app.statusCompatibilityError('<RGW><status><batteryinfo/></status></RGW>',{id:'fixture-profile'}),'');
});

test('status compatibility warning precedes Router cards',()=>{
  const fixture=model('router');
  fixture.errors.status='Router responded successfully, but status1 format does not match compatibility profile fixture.';
  const html=app.buildHtml(fixture);
  assert.ok(html.indexOf('data-status-warning') < html.indexOf('topgrid router-only'));
  assert.match(html,/Status compatibility warning/);
});

test('firmware RAT fixtures distinguish LTE, 3G, unknown codes and conflicts',()=>{
  const profile=require('../modules/compatibility-profiles.js').selectProfile('2.5.96');
  const lte=app.parseNetwork('<RGW><wan><cellular><ConnType>LTE</ConnType><sys_mode>6</sys_mode><rssi>25</rssi></cellular></wan></RGW>',profile);
  assert.match(lte.mode,/4G/); assert.equal(lte.dbm,-63); assert.match(lte.networkDiagnostic,/ConnType=LTE/);
  const threeG=app.parseNetwork('<RGW><wan><cellular><sys_mode>4</sys_mode><sys_submode>17</sys_submode></cellular></wan></RGW>',profile);
  assert.match(threeG.mode,/3G/);
  const unknown=app.parseNetwork('<RGW><wan><cellular><sys_submode>777</sys_submode></cellular></wan></RGW>',profile);
  assert.equal(unknown.mode,'Unknown (raw: 777)');
  const conflict=app.parseNetwork('<RGW><wan><cellular><ConnType>LTE</ConnType><sys_mode>4</sys_mode></cellular></wan></RGW>',profile);
  assert.equal(conflict.mode,'Conflicting network data'); assert.equal(conflict.networkConflict,true);
});

test('MF855 NZ 2.5.94 confirmed connected 17/17 fixture is LTE',()=>{
  const profile=require('../modules/compatibility-profiles.js').selectProfile('2.5.94_release_MF855_NZ_CP_2.129.003');
  const xml='<RGW><status><version_num>2.5.94_release_MF855_NZ_CP_2.129.003</version_num><wan><cellular><connect_disconnect>1</connect_disconnect><sys_mode>17</sys_mode><sys_submode>17</sys_submode><network_type>106512140</network_type></cellular></wan></status></RGW>';
  const result=app.parseNetwork(xml,profile);
  assert.equal(result.mode,'4G · LTE');
  assert.equal(result.generation,'4G');
  assert.equal(result.networkSource,'firmware combination rule');
  assert.match(result.rawMode,/sys_mode=17, sys_submode=17/);
});

test('17/17 without connected-WAN evidence is unknown rather than guessed 3G',()=>{
  const profile=require('../modules/compatibility-profiles.js').selectProfile('2.5.94_release_MF855_NZ_CP_2.129.003');
  const result=app.parseNetwork('<RGW><wan><cellular><sys_mode>17</sys_mode><sys_submode>17</sys_submode></cellular></wan></RGW>',profile);
  assert.match(result.mode,/Unknown/);
  assert.equal(result.generation,'Unknown');
});

test('firmware mismatch stays out of UI while a real status request error remains visible',()=>{
  const fixture=model('router'); fixture.errors.profile='Firmware profile mismatch'; fixture.firmwareWarning={id:'firmware-x',configured:'x',detected:'y'};
  let html=app.buildHtml(fixture); assert.doesNotMatch(html,/Firmware profile mismatch|data-warning-id|data-warning-dismiss/);
  fixture.errors.status='HTTP 401 authentication failed'; fixture.errors.statusRequest=true;
  html=app.buildHtml(fixture); assert.match(html,/Status request error/); assert.match(html,/HTTP 401 authentication failed/);
});

test('debug defaults are safe and explicit false silences the central logger',()=>{
  const config=require('../mf885-smsreader-config.json');
  const loader=require('node:fs').readFileSync(require.resolve('../loader.js'),'utf8');
  assert.equal(config.debug,true);
  assert.equal(config.debugSensitivePayloads,false);
  assert.equal(config.skipSmsContentLog,true);
  assert.match(loader,/debug: true/);
  assert.match(loader,/debugSensitivePayloads: false/);
  assert.match(loader,/skipSmsContentLog: true/);
  const original=console.log,calls=[]; console.log=(...values)=>calls.push(values.join(' '));
  try { app.configureDebug({debug:false}); app.debugLog('hidden',{status:200}); assert.deepEqual(calls,[]); }
  finally { app.configureDebug({debug:true}); console.log=original; }
});

test('debug redaction removes secrets and retains useful structural fields',()=>{
  const original=console.log,calls=[]; console.log=(...values)=>calls.push(values.join(' '));
  try {
    app.configureDebug({debug:true,debugSensitivePayloads:false});
    app.debugLog('request:12:response',{operation:'status1',method:'GET',attempt:1,status:200,durationMs:184,bytes:2371,password:'zimifi',token:'github-secret',Authorization:'Digest response=deadbeef',Cookie:'sid=secret',phone:'+12345678901',content:'private SMS',ussd:'*100#'});
    app.logXmlSummary('status1','<RGW><status><WanStatistics/><batteryinfo/><network_type>LTE</network_type></status></RGW>');
  } finally { console.log=original; }
  const log=calls.join('\n');
  for(const secret of ['zimifi','github-secret','deadbeef','sid=secret','+12345678901','private SMS','*100#'])assert.doesNotMatch(log,new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  for(const safe of ['request:12:response','operation=status1','method=GET','attempt=1','status=200','durationMs=184','bytes=2371','WanStatistics','batteryinfo','cellularFields'])assert.match(log,new RegExp(safe));
});

test('XML debug redacts device, subscriber, Wi-Fi, address and APN identifiers',()=>{
  const value=app.redactDebugValue('<current_device_mac>aa:bb:cc:dd:ee:ff</current_device_mac><IMEI>123456789012345</IMEI><ICCID>8901000000000000000</ICCID><IMSI>250000000000000</IMSI><ssid>Private WiFi</ssid><wifi_key>secret-key</wifi_key><ip_address>10.0.0.2</ip_address><apn>private.apn</apn>');
  for(const secret of ['aa:bb:cc:dd:ee:ff','123456789012345','8901000000000000000','250000000000000','Private WiFi','secret-key','10.0.0.2','private.apn'])assert.doesNotMatch(value,new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('large debug XML is emitted in bounded numbered chunks with truncation',()=>{
  const original=console.log,calls=[]; console.log=(...values)=>calls.push(values.join(' '));
  try { app.configureDebug({debug:true}); app.debugXml('request:99:response-xml','<RGW><status>'+('x'.repeat(6000))+'</status></RGW>'); } finally { console.log=original; }
  assert.equal(calls.length,4);
  assert.match(calls[0],/part=1\/4/); assert.match(calls[3],/part=4\/4/);
  assert.ok(calls.every(line=>line.length<1200)); assert.ok(calls.every(line=>/truncated=true/.test(line)));
});

test('SMS XML bodies are omitted by default and opt-in still uses central redaction',()=>{
  const original=console.log,calls=[]; console.log=(...values)=>calls.push(values.join(' '));
  try {
    app.configureDebug({debug:true});
    app.debugXml('request:1:message:response-xml','<RGW><message><content>private words</content><sender>+15551234567</sender></message></RGW>');
    assert.match(calls.join('\n'),/SMS content logging disabled/); assert.doesNotMatch(calls.join('\n'),/private words/);
    calls.length=0; app.configureDebug({debug:true,skipSmsContentLog:false});
    app.debugXml('request:2:message:response-xml','<RGW><message><content>private words</content></message></RGW>');
    assert.match(calls.join('\n'),/<redacted>/); assert.doesNotMatch(calls.join('\n'),/private words/);
  } finally { app.configureDebug({debug:true}); console.log=original; }
});

test('Router groups are ordered, compact, and retain command hooks',()=>{
  const page=app.buildHtml(model('router')),html=page.slice(page.indexOf('<section id=\"router\"'),page.indexOf('</section></main>'));
  const labels=['Overview','Mobile network','Connection diagnostics','Cellular controls','USSD','Device access','System'];
  for(let i=1;i<labels.length;i++)assert.ok(html.indexOf(labels[i-1])<html.indexOf(labels[i]));
  for(const hook of ['data-ussd-section','data-device-access-section','data-cellular-control-section','data-power-action'])assert.match(html,new RegExp(hook));
  assert.equal((html.match(/topgrid router-only/g)||[]).length,1); assert.match(html,/Loading diagnostics…/);
});

test('polling exposes full Router and diagnostics update hooks with stale preservation',()=>{
  const js=app.clientScript(model('router'));
  assert.match(js,/window\.zmiApplyCellularDiagnostics/); assert.match(js,/lastDiagnostics/); assert.match(js,/classList\.toggle\('stale'/);
  for(const hook of ['data-network-current','data-network-preferred','data-network-operator','data-network-dbm','data-diag-stage'])assert.match(app.buildHtml(model('router')),new RegExp(hook));
});

test('experimental progress is a live region with attempts, elapsed time and timer cleanup',()=>{
  const html=app.buildHtml(model('router')),js=app.clientScript(model());
  assert.match(html,/role="status" aria-live="polite" data-detection-status/);
  assert.match(js,/Attempt '\+detectionAttempt/); assert.match(js,/formatDetectionElapsed/); assert.match(js,/clearInterval\(detectionTimer\)/); assert.match(js,/1000/);
});

test('one experimental command is validated and automatically dispatched with independent results',()=>{
  assert.equal(app.validateWebViewCommand({id:'detect-1',action:'detectExperimental',params:{}}).action,'detectExperimental');
  const js=app.clientScript(model()); assert.match(js,/bridge\('detectExperimental'/); assert.match(js,/setTimeout\(function\(\)\{detectExperimental\(\)\},0\)/);
  assert.match(js,/Retry experimental detection/); assert.match(js,/item&&item\.supported===true/);
});

test('copy success and failure both provide visible accessible feedback',()=>{
  const js=app.clientScript(model()); assert.match(js,/textContent='Copied'/); assert.match(js,/aria-label','SMS copied'/);
  assert.match(js,/setActionStatus\('SMS copied to clipboard'\)/); assert.match(js,/Could not copy SMS/); assert.match(js,/Copy SMS manually/);
});
