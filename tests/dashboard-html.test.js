const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
global.Script = { name: () => 'MF885 Test' };
const app = require('../scriptable.js');

function model(tab='sms') { return {tab,loadedAt:Date.now(),sms:{messages:[{id:'1',phone:'+1',date:'now',content:'hello'}],loading:true},errors:{},network:{},battery:{},traffic:{},cellularDiagnostics:{},ussd:{state:'unchecked',detail:'Not checked'},deviceAccess:{state:'unchecked',detail:'Not checked',capabilities:[]},cellularControl:{state:'unchecked',detail:'Not checked'}}; }

test('initial HTML is immediately useful and marks history as loading',()=>{const html=app.buildHtml(model());assert.match(html,/hello/);assert.match(html,/Loading messages: 1/);assert.match(html,/Not checked/);assert.match(html,/data-detect-experimental/);assert.match(html,/Detect experimental features/);assert.doesNotMatch(html,/data-detect="ussd"/);});
test('dashboard header displays device, firmware and installed software versions',()=>{
  const fixture=model();
  Object.assign(fixture,{actualModel:'MF855',actualRevision:'NZ',actualFirmware:'2.5.94_release_MF855_NZ_CP_2.129.003',softwareVersion:'3.0.0'});
  const html=app.buildHtml(fixture);
  assert.match(html,/<h1>MF855<\/h1><span class="device-revision">Revision NZ<\/span>/);
  assert.match(html,/Firmware version<\/small><b>2\.5\.94<\/b>/);
  assert.match(html,/Application version<\/small><b>3\.0\.0<\/b>/);
  assert.match(html,/Firmware build<\/small><code>2\.5\.94_release_MF855_NZ_CP_2\.129\.003<\/code>/);
  assert.match(html,/<title>MF855 · NZ · firmware 2\.5\.94 · software 3\.0\.0<\/title>/);
  assert.match(html,/\.device-metadata\{[^}]*display:grid/);
  assert.match(html,/\.firmware-build code\{[^}]*overflow-wrap:anywhere/);
  assert.ok(html.indexOf('class="sms-counter"') > html.indexOf('class="firmware-build"'));
});
test('dashboard version metadata is escaped before entering markup',()=>{
  const fixture=model();
  Object.assign(fixture,{actualModel:'MF885<script>',actualRevision:'R&<rev>',actualFirmware:'2.5&<bad>_release_build"<id>',actualFirmwareVersion:'2.5&<version>',softwareVersion:'3"<next>'});
  const html=app.buildHtml(fixture);
  assert.match(html,/MF885&lt;script&gt;/);
  assert.match(html,/R&amp;&lt;rev&gt;/);
  assert.match(html,/2\.5&amp;&lt;version&gt;/);
  assert.match(html,/2\.5&amp;&lt;bad&gt;_release_build&quot;&lt;id&gt;/);
  assert.match(html,/3&quot;&lt;next&gt;/);
  assert.doesNotMatch(html,/<script><\/script>/);
});
test('dashboard uses understandable metadata fallbacks when status1 is unavailable',()=>{
  const html=app.buildHtml(model());
  assert.match(html,/<h1>unknown<\/h1>/);
  assert.doesNotMatch(html,/<span class="device-revision">/);
  assert.match(html,/Firmware version<\/small><b>unknown<\/b>/);
  assert.match(html,/Application version<\/small><b>unknown<\/b>/);
  assert.match(html,/<title>unknown · firmware unknown · software unknown<\/title>/);
});
test('status1 hardware revision accepts common XML field names',()=>{
  for(const field of ['revision','hardware_version','hardware_ver','hw_version']) {
    assert.equal(app.hardwareRevision(`<RGW><status><${field}>rev-${field}<\/${field}></status></RGW>`),`rev-${field}`);
  }
  assert.equal(app.hardwareRevision('<RGW><status></status></RGW>'),'');
  assert.equal(app.firmwareUserVersion('2.5.94_release_MF855_NZ_CP_2.129.003'),'2.5.94');
});
test('SMS and router models render a non-empty main with the requested active tab',()=>{for(const tab of ['sms','router']){const html=app.buildHtml(model(tab));const main=html.match(/<main>([\s\S]*?)<\/main>/i);assert.ok(main&&main[1].trim(),`${tab} main must not be empty`);assert.match(html,new RegExp(`<section id="${tab}" class="tab active"`));}});
test('dashboard has native Alert fallback for WebView failures',()=>{const source=require('node:fs').readFileSync(require.resolve('../scriptable.js'),'utf8');assert.match(source,/WebView loadHTML stage failed/);assert.match(source,/WebView present stage failed/);const fallback=source.match(/async function showMessage[\s\S]*?\n}/);assert.ok(fallback);assert.match(fallback[0],/new Alert\(\)/);assert.doesNotMatch(fallback[0],/new WebView\(\)/);});

function dashboardLifecycle({channelError}={}) {
  const calls=[];
  let closePresentation;
  const closed=new Promise(resolve=>{closePresentation=resolve});
  const web={
    loadHTML:async()=>{calls.push('loadHTML')},
    present:()=>{calls.push('present');return closed},
    evaluateJavaScript:async script=>{
      if(script.includes('window.__zmiCommandQueue=[]')){calls.push('registerChannel');if(channelError)throw channelError;return true}
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

test('dashboardFlow registers command polling after presenting without inspecting the DOM',async()=>{
  const fixture=dashboardLifecycle();
  while(!fixture.calls.includes('registerChannel'))await new Promise(resolve=>setImmediate(resolve));
  fixture.closePresentation();
  await fixture.flow;
  assert.deepEqual(fixture.calls.slice(0,3),['loadHTML','present','registerChannel']);
  assert.deepEqual(fixture.alerts,[]);
});

function clientDom(readyState) {
  const listeners=[];
  const stored=new Map();
  const element=(id,active)=>({id,hidden:!active,focused:false,attributes:{},classList:{active, toggle(name,on){if(name==='active')this.active=on}},focus(){this.focused=true},getAttribute(name){return this.attributes[name]},setAttribute(name,value){this.attributes[name]=value}});
  const sms=element('sms',true),router=element('router',false),smsButton=element('',true),routerButton=element('',false);
  smsButton.attributes['data-tab-button']='sms'; routerButton.attributes['data-tab-button']='router';
  const tabs=[sms,router],buttons=[smsButton,routerButton];
  const document={readyState,documentElement:{dataset:{}},addEventListener:(...args)=>listeners.push(args),getElementById:()=>null,querySelector(selector){if(selector==='.tab.active')return tabs.find(x=>x.classList.active)||null;return null},querySelectorAll(selector){return selector==='.tab'?tabs:selector==='[data-tab-button]'?buttons:[]}};
  const window={scrollY:0,scrollTo(){},addEventListener(){},dispatchEvent(){}};
  const context={document,window,localStorage:{getItem:key=>stored.has(key)?stored.get(key):null,setItem:(key,value)=>stored.set(key,String(value))},setTimeout:callback=>callback(),setInterval:()=>1,clearInterval(){},CustomEvent:function(){},navigator:{},fetch(){}};
  window.window=window;
  return {context,listeners,stored,sms,router,smsButton,routerButton};
}

test('complete generated client script compiles and tabs initialize throughout the DOM lifecycle',()=>{
  const source=app.clientScript(model());
  const script=new vm.Script(source);
  for(const readyState of ['loading','complete']){
    const fixture=clientDom(readyState);
    script.runInNewContext(fixture.context);
    const readyListener=fixture.listeners.find(([name])=>name==='DOMContentLoaded');
    if(readyState==='loading'){
      assert.ok(readyListener,'loading documents must wait for DOMContentLoaded');
      readyListener[1]();
    } else assert.equal(readyListener,undefined,'complete documents initialize immediately');
    fixture.context.tab('router');
    assert.equal(fixture.sms.classList.active,false);
    assert.equal(fixture.sms.hidden,true);
    assert.equal(fixture.router.classList.active,true);
    assert.equal(fixture.router.hidden,false);
    assert.equal(fixture.smsButton.attributes['aria-selected'],'false');
    assert.equal(fixture.routerButton.attributes['aria-selected'],'true');
    assert.equal(fixture.stored.get('zmiTab'),'router');
  }
});

test('dashboard tabs emit dedicated conventional tab styling and active treatment',()=>{
  const html=app.buildHtml(model());
  assert.match(html,/<nav class="seg dashboard-tabs" role="tablist"/);
  assert.match(html,/\.dashboard-tabs\{[^}]*border-bottom:1px solid var\(--line\)[^}]*border-radius:0/);
  assert.match(html,/\.dashboard-tabs button\{[^}]*border-bottom:3px solid transparent[^}]*border-radius:8px 8px 0 0/);
  assert.match(html,/\.dashboard-tabs button\.active\{[^}]*background:var\(--panel\)[^}]*border-color:var\(--line\) var\(--line\) var\(--cyan\)[^}]*outline:none/);
});

test('tab arrow, Home and End keys move focus, selection and the visible panel',()=>{
  const fixture=clientDom('complete');
  new vm.Script(app.clientScript(model())).runInNewContext(fixture.context);
  const keydown=fixture.listeners.find(([name])=>name==='keydown');
  assert.ok(keydown,'tab keyboard handler must be registered');
  const press=(target,key)=>{let prevented=false;keydown[1]({target,key,preventDefault(){prevented=true}});assert.equal(prevented,true);};
  press(fixture.smsButton,'ArrowRight');
  assert.equal(fixture.routerButton.focused,true);
  assert.equal(fixture.smsButton.attributes['aria-selected'],'false');
  assert.equal(fixture.routerButton.attributes['aria-selected'],'true');
  assert.equal(fixture.sms.hidden,true);
  assert.equal(fixture.router.hidden,false);
  press(fixture.routerButton,'ArrowLeft');
  assert.equal(fixture.smsButton.focused,true);
  assert.equal(fixture.smsButton.attributes['aria-selected'],'true');
  press(fixture.smsButton,'End');
  assert.equal(fixture.routerButton.attributes['aria-selected'],'true');
  press(fixture.routerButton,'Home');
  assert.equal(fixture.smsButton.attributes['aria-selected'],'true');
  assert.equal(fixture.sms.hidden,false);
  assert.equal(fixture.router.hidden,true);
});

test('the complete script embedded in buildHtml compiles',()=>{
  const html=app.buildHtml(model());
  const embedded=html.match(/<script>([\s\S]*)<\/script>/i);
  assert.ok(embedded,'buildHtml must contain a complete client script');
  assert.doesNotThrow(()=>new vm.Script(embedded[1]));
});

test('dashboardFlow leaves the presented WebView open when command channel registration fails',async()=>{
  const fixture=dashboardLifecycle({channelError:new Error('registration unavailable')});
  const warnings=[];
  const originalWarn=console.warn;
  console.warn=message=>warnings.push(String(message));
  try { await fixture.flow; } finally { console.warn=originalWarn; }
  assert.deepEqual(fixture.calls,['loadHTML','present','registerChannel']);
  assert.deepEqual(fixture.alerts,[]);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/command channel registration failed: registration unavailable/);
  assert.equal(fixture.calls.includes('dismiss'),false);
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
    evaluateJavaScript:async script=>script.includes('window.__zmiCommandQueue=[]') ? true : null
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
test('SMS history progress derives loaded, total and percent and updates the hero counter',()=>{
  const fixture=model(); fixture.sms.totalMessages=42;
  const html=app.buildHtml(fixture),js=app.clientScript(fixture);
  assert.match(html,/SMS: 1\/42/);
  assert.match(html,/Loading messages: 1\/42 \(2%\)/);
  assert.match(js,/loaded=Array\.isArray\(payload\.messages\)\?payload\.messages\.length:0/);
  assert.match(js,/total=Number\(payload\.totalMessages\)/);
  assert.match(js,/Number\.isFinite\(total\)&&total>=loaded&&total>0/);
  assert.match(js,/Math\.round\(loaded\/total\*100\)/);
  assert.match(js,/hero\.textContent='SMS: '\+counter/);
  assert.match(js,/Loading messages: '\+counter/);
});

test('SMS history uses one warning region and an auto-hiding accessible success toast',()=>{
  const html=app.buildHtml(model()),js=app.clientScript(model());
  const markup=html.slice(0,html.indexOf('<script>'));
  assert.equal((markup.match(/data-history-warning/g)||[]).length,1);
  assert.equal((markup.match(/data-history-toast/g)||[]).length,1);
  assert.match(html,/data-history-toast role="status" aria-live="polite" hidden/);
  assert.match(js,/section&&section\.querySelector\('\[data-history-warning\]'\)/);
  assert.match(js,/if\(!note&&section\)/);
  assert.match(js,/showHistoryToast\('Message history loaded'\)/);
  assert.match(js,/function showHistoryToast\(text\)/);
  assert.match(js,/historyToastTimer=setTimeout/);
  assert.match(js,/toast\.hidden=true;historyToastTimer=null},4000/);
  assert.match(js,/if\(historyToastTimer!==null\)\{clearTimeout\(historyToastTimer\)/);
});

test('client applies complete and partial SMS history without document reload',()=>{const js=app.clientScript(model());assert.match(js,/window\.zmiApplySmsHistory=function/);assert.match(js,/payload\.warning/);assert.match(js,/Message history is incomplete|⚠️/);assert.doesNotMatch(js,/location\.(?:href|assign|replace)|location\s*=/);});
test('document has no Scriptable relaunch links',()=>{const text=app.buildHtml(model())+app.clientScript(model());assert.doesNotMatch(text,/scriptable:\/\/\/run|This action will reopen|runUrl|navigationInProgress/);});
test('client exposes targeted status, capability and action updates',()=>{const js=app.clientScript(model());for(const name of ['zmiApplyStatus','zmiApplySmsHistory','zmiApplyCapability','zmiApplyActionResult'])assert.match(js,new RegExp('window\\.'+name));assert.match(js,/CustomEvent\('ZMICommand'/);});
test('delete result is successful only after updated history no longer contains the SMS',()=>{
  const source=require('node:fs').readFileSync(require.resolve('../scriptable.js'),'utf8');
  const js=app.clientScript(model());
  assert.match(source,/deleteSms:async p=>\{const r=await deleteSms[\s\S]*?if\(!r\.ok\)[\s\S]*?throw error/);
  assert.match(js,/verified=deletion&&payload\.ok/);
  assert.match(js,/!smsHistoryContains\(payload\.result\.history,p\.params\.id\)/);
  assert.match(js,/deletion\?'Deleted'/);
  assert.match(js,/deletion\?'Retry':'Failed'/);
});
test('delete failures stay in the card accessible live region instead of the global error',()=>{
  const html=app.buildHtml(model()),js=app.clientScript(model());
  assert.match(html,/data-delete-confirm role="status" aria-live="polite"/);
  assert.match(js,/setDeleteStatus\(p,message/);
  assert.match(js,/setAttribute\('role',isError\?'alert':'status'\)/);
  assert.match(js,/if\(!payload\.ok&&\(!p\|\|p\.action!==['"]deleteSms['"]\)\)/);
  assert.match(js,/bridge\('deleteSms'[\s\S]*?\.catch\(function\(\)\{\}\)/);
});
test('router deletion statuses require an explicit known success and reject known failures',()=>{
  assert.equal(app.routerAccepted('<RGW><message><sms_cmd_status_result>0</sms_cmd_status_result></message></RGW>'),true);
  assert.equal(app.routerAccepted('<RGW><delete_status>completed</delete_status></RGW>'),true);
  assert.equal(app.routerAccepted('<RGW><delete_status>3</delete_status></RGW>'),false);
  assert.equal(app.routerAccepted('<RGW><status>failed</status></RGW>'),false);
  assert.equal(app.routerAccepted('<RGW><status>mystery</status></RGW>'),false);
  assert.equal(app.routerAccepted('<RGW></RGW>'),false);
});
test('tab, scroll and unsent SMS draft survive DOM updates',()=>{const js=app.clientScript(model());assert.match(js,/zmiTab/);assert.match(js,/zmiScrollY/);assert.match(js,/zmiSmsDraft/);assert.match(js,/window\.scrollTo/);});
test('SMS pages merge with deduplication',()=>{let r={messages:[],loadedPages:0,totalPages:null,totalMessages:null};app.mergeSmsPage(r,{page:1,totalPages:2,totalMessages:2,messages:[{id:'1',phone:'a',date:'d',content:'x'}]});app.mergeSmsPage(r,{page:2,messages:[{id:'1',phone:'a',date:'d',content:'x'},{id:'2',phone:'b',date:'d',content:'y'}]});assert.deepEqual(r.messages.map(x=>x.id),['1','2']);assert.equal(r.loadedPages,2);});
test('total_number is page metadata and never becomes the SMS total',()=>{
  const legacy=app.parseSmsPage('<get_message><total_number>5</total_number><Item index="1"><index>1</index><content>one</content></Item></get_message>',1);
  assert.equal(legacy.totalPages,5);
  assert.equal(legacy.totalMessages,null);
  const explicit=app.parseSmsPage('<get_message><total_number>5</total_number><total_sms_count>42</total_sms_count></get_message>',1);
  assert.equal(explicit.totalPages,5);
  assert.equal(explicit.totalMessages,42);
});
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
  assert.match(js,/note\.textContent='⚠️ '\+payload\.warning/);
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
  assert.equal(unknown.mode,'Unknown'); assert.match(unknown.networkDiagnostic,/sys_submode=777/);
  const conflict=app.parseNetwork('<RGW><wan><cellular><ConnType>LTE</ConnType><sys_mode>4</sys_mode></cellular></wan></RGW>',profile);
  assert.match(conflict.mode,/3G/); assert.equal(conflict.networkConflict,false); assert.match(conflict.networkDiagnostic,/ConnType=LTE/);
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
  const labels=['Overview','Mobile network','Connection diagnostics','Experimental features','Cellular controls','USSD','Device access','System'];
  for(let i=1;i<labels.length;i++)assert.ok(html.indexOf(labels[i-1])<html.indexOf(labels[i]));
  for(const hook of ['data-ussd-section','data-device-access-section','data-cellular-control-section','data-power-action'])assert.match(html,new RegExp(hook));
  assert.match(html,/<ul class="experimental-list">[\s\S]*?<li data-cellular-control-section>[\s\S]*?<ul><li><h4>Preferred protocol control<\/h4>/);
  assert.equal((html.match(/data-capability-status/g)||[]).length,3);
  assert.doesNotMatch(html,/experimental-subsection/);
  assert.equal((html.match(/data-detect-experimental/g)||[]).length,1);
  assert.equal((html.match(/topgrid router-only/g)||[]).length,1); assert.equal((html.match(/class=\"diag-spinner\"/g)||[]).length,1); assert.doesNotMatch(html,/Loading diagnostics…/);
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
  assert.match(js,/Retry experimental detection/); assert.match(js,/item\.supported===true/);
});

test('experimental capabilities use canonical labels and only render confirmed actions',()=>{
  const uncheckedPage=app.buildHtml(model('router')),unchecked=uncheckedPage.slice(uncheckedPage.indexOf('<article class="card experimental'),uncheckedPage.indexOf('<article class="card" data-power-control><small>System'));
  for(const label of ['Cellular controls','USSD','Device access'])assert.match(unchecked,new RegExp('<span data-capability-name>'+label+'<\\/span>: <span data-capability-status>Not checked<\\/span>'));
  for(const action of ['data-cellular-action','data-device-action','Dial USSD'])assert.doesNotMatch(unchecked,new RegExp(action));

  const available=model('router');
  available.ussd={state:'available',supported:true,detail:'Ready'};
  available.cellularControl={state:'available',supported:true,detail:'Ready',modes:[{id:'auto',title:'Automatic'}]};
  available.deviceAccess={state:'available',supported:true,detail:'Ready',capabilities:[{id:'telnet',title:'Enable telnet',supported:true},{id:'ssh',title:'Enable SSH',supported:false}]};
  const html=app.buildHtml(available);
  assert.match(html,/data-cellular-action="reconnect"/); assert.match(html,/>Dial USSD<\/button>/); assert.match(html,/data-device-action="telnet"/); assert.doesNotMatch(html,/data-device-action="ssh"/);
  assert.doesNotMatch(html,/Status unavailable[^<]*<\/button>|Reconnect unavailable/);

  const js=app.clientScript(model());
  assert.match(js,/actions\.innerHTML=''/); assert.match(js,/if\(state==='available'\)/); assert.match(js,/data-capability-status/);
  assert.doesNotMatch(js,/Cellular control'\)\+'|Dial USSD — Status unavailable/);
});

test('copy success and failure both provide visible accessible feedback',()=>{
  const js=app.clientScript(model()); assert.match(js,/textContent='Copied'/); assert.match(js,/aria-label','SMS copied'/);
  assert.match(js,/showHistoryToast\('SMS copied to clipboard'\)/); assert.doesNotMatch(js,/setActionStatus\('SMS copied to clipboard'\)/);
  assert.match(js,/showActionError\('Copy SMS manually','Clipboard access failed\. Select and copy the SMS text below\.',value\)/);
});

test('initial and dynamically rendered SMS cards use the delegated copy hook',()=>{
  const html=app.buildHtml(model()),js=app.clientScript(model());
  assert.match(html,/<button data-copy type="button">Copy<\/button>/);
  assert.doesNotMatch(html,/onclick="copySms\(this\)"/);
  assert.match(js,/card\.innerHTML='[^']*<button data-copy>Copy<\/button>/);
  assert.match(js,/closest\('\[data-copy\],\[data-share\],\[data-delete-action\]/);
  assert.match(js,/if\(b\.hasAttribute\('data-copy'\)\)\{e\.preventDefault\(\);e\.stopPropagation\(\);copySms\(b\);return\}/);
});

test('copy falls back to a dedicated native bridge command',()=>{
  const js=app.clientScript(model());
  assert.match(js,/navigator\.clipboard\.writeText\(value\)/);
  assert.match(js,/bridge\('copySms',\{text:value\}\)/);
  assert.match(js,/Select and copy the SMS text below/);
  const source=require('node:fs').readFileSync(require.resolve('../scriptable.js'),'utf8');
  assert.match(source,/copySms:async p=>\{pasteboard\.copyString\(p\.text\);return \{copied:true\};\}/);
});

test('dispatcher accepts validated copy commands and rejects invalid copy payloads',async()=>{
  const copied=[];
  const dispatch=app.createWebViewDispatcher({copySms:async p=>{copied.push(p.text);return {copied:true}}});
  const accepted=await dispatch({id:'copy-1',action:'copySms',params:{text:'hello'}});
  assert.equal(accepted.ok,true); assert.deepEqual(accepted.result,{copied:true}); assert.deepEqual(copied,['hello']);
  for(const params of [{},{text:''},{text:42},{text:'x'.repeat(10001)}]){
    const rejected=await dispatch({id:'copy-invalid',action:'copySms',params});
    assert.equal(rejected.ok,false); assert.match(rejected.error,/Invalid text/);
  }
  assert.deepEqual(copied,['hello']);
});

test('initial and dynamically rendered SMS cards expose Share beside Copy',()=>{
  const html=app.buildHtml(model()),js=app.clientScript(model());
  assert.match(html,/<button data-copy type="button">Copy<\/button><button data-share type="button">Share<\/button>/);
  assert.match(js,/card\.innerHTML='[^']*<button data-copy>Copy<\/button><button data-share>Share<\/button>/);
});

test('delegated Share clicks route separately from Copy and Delete',()=>{
  const js=app.clientScript(model());
  assert.match(js,/closest\('\[data-copy\],\[data-share\],\[data-delete-action\]/);
  assert.match(js,/hasAttribute\('data-copy'\)[\s\S]*copySms\(b\);return[\s\S]*hasAttribute\('data-share'\)[\s\S]*shareSms\(b\);return[\s\S]*hasAttribute\('data-delete-action'\)/);
  assert.match(js,/value='From: '\+sender\+'\\nDate: '\+date\+'\\n\\n'\+message/);
  assert.match(js,/bridge\('shareSms',\{text:value\},button\)/);
});

test('shareSms validation accepts bounded text and rejects invalid values',()=>{
  assert.equal(app.validateWebViewCommand({id:'share-1',action:'shareSms',params:{text:'From: +1\nDate: now\n\nhello'}}).action,'shareSms');
  for(const params of [{},{text:''},{text:42},{text:'x'.repeat(12001)}])assert.throws(()=>app.validateWebViewCommand({id:'share-bad',action:'shareSms',params}),/Invalid text/);
});

test('dashboard share handler correlates ids and passes prepared text to ShareSheet',async()=>{
  const shared=[],replies=[],text='From: +1\nDate: now\n\nhello';
  const web={evaluateJavaScript:async source=>{replies.push(source)}};
  const dispatch=app.createDashboardDispatcher({},model(),web,{refreshGuard:{run:f=>f()},smsGuard:{run:f=>f()}},{ShareSheet:{present:async items=>{shared.push(items);return true}},Pasteboard:{copyString(){}}});
  const response=await dispatch({id:'share-native-1',action:'shareSms',params:{text}});
  assert.equal(response.id,'share-native-1'); assert.equal(response.ok,true); assert.deepEqual(shared,[[text]]);
  assert.match(replies[0],/share-native-1/);
});

test('share cancellation is neutral, failures are sanitized, and unavailable API copies',async()=>{
  const make=({ShareSheet,Pasteboard={copyString(){}}})=>app.createDashboardDispatcher({},model(),{evaluateJavaScript:async()=>{}},{refreshGuard:{run:f=>f()},smsGuard:{run:f=>f()}},{ShareSheet,Pasteboard});
  const cancelled=await make({ShareSheet:{present:async()=>false}})({id:'cancel-1',action:'shareSms',params:{text:'private SMS'}});
  assert.deepEqual(cancelled.result,{shared:false,cancelled:true});
  const thrownCancel=await make({ShareSheet:{present:async()=>{const error=new Error('User cancelled');error.cancelled=true;throw error}}})({id:'cancel-2',action:'shareSms',params:{text:'private SMS'}});
  assert.equal(thrownCancel.ok,true); assert.equal(thrownCancel.result.cancelled,true);
  const failed=await make({ShareSheet:{present:async()=>{throw new Error('private SMS leaked by API')}}})({id:'fail-1',action:'shareSms',params:{text:'private SMS'}});
  assert.equal(failed.ok,false); assert.equal(failed.error,'System share failed'); assert.doesNotMatch(JSON.stringify(failed),/private SMS/);
  const copied=[]; const fallback=await make({ShareSheet:{},Pasteboard:{copyString:value=>copied.push(value)}})({id:'fallback-1',action:'shareSms',params:{text:'prepared context'}});
  assert.deepEqual(fallback.result,{shared:false,copied:true,fallback:true}); assert.deepEqual(copied,['prepared context']);
});

test('profile selection is override, detection, then configured fallback',()=>{
  const choose=app.chooseCompatibilityProfile;
  assert.equal(choose({compatibilityProfile:'2.5.96',compatibilityProfileOverride:'2.5.94'},'2.5.96').firmware,'2.5.94');
  assert.equal(choose({compatibilityProfile:'2.5.96'},'2.5.94','MF885').firmware,'2.5.94');
  assert.equal(choose({compatibilityProfile:'2.5.96'},'').firmware,'2.5.96');
  assert.equal(choose({compatibilityProfile:'2.5.94'},'9.9.9').id,'unknown');
});

test('battery state and mobile card CSS are canonical and scoped',()=>{
  const cases=[['<Battery_status>2</Battery_status><Battery_percent>40</Battery_percent>','charging'],['<Battery_status>1</Battery_status><Charger_status>0</Charger_status>','discharging'],['<Battery_status>3</Battery_status><Battery_percent>100</Battery_percent>','full'],['<Battery_status>88</Battery_status>','unknown']];
  for(const [body,state] of cases){const b=app.parseBattery(`<batteryinfo>${body}</batteryinfo>`);assert.equal(b.state,state);assert.equal(b.status,state[0].toUpperCase()+state.slice(1));assert.match(app.batteryInlineLabel(b),new RegExp(b.status));}
  const html=app.buildHtml(model('router')); for(const card of ['signal','battery','traffic'])assert.match(html,new RegExp(`data-overview-card="${card}"`));
  assert.match(html,/@media\(max-width:520px\).*mini-traffic\{grid-column:1 \/ -1\}/); assert.match(html,/@media\(max-width:340px\)/); assert.match(html,/\.mini > span\{/); assert.doesNotMatch(html,/\.mini span\{/);
  for(const width of [320,375,390,430,520])assert.ok(width<=520 && /grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)/.test(html));
});

test('only profile-declared alternative RAT sources conflict',()=>{
 const base=require('../modules/compatibility-profiles.js').selectProfile('2.5.96');
 const real={...base,wan:{...base.wan,rat:{...base.wan.rat,alternativeSources:['sys_mode','ConnType']}}};
 assert.equal(app.parseNetwork('<sys_mode>4</sys_mode><ConnType>LTE</ConnType>',base).networkConflict,false);
 assert.equal(app.parseNetwork('<sys_mode>4</sys_mode><ConnType>LTE</ConnType>',real).mode,'Conflicting network data');
});


test('loadRemainingSms progress reports increasing messages and known totalMessages',async()=>{
  const originalRequest=global.Request;
  global.Request=class {
    constructor(url){this.url=url;this.method='GET';this.headers={};this.response=null;}
    async loadString(){
      const page=Number((this.body.match(/<page_number>(\d+)<\/page_number>/)||[])[1]);
      this.response={statusCode:200,headers:{}};
      return `<RGW><message><get_message><total_pages>3</total_pages><total_sms_count>3</total_sms_count><Item index="${page}"><index>${page}</index><from>+${page}</from><content>message ${page}</content></Item></get_message></message></RGW>`;
    }
  };
  const initial={messages:[{id:'1',phone:'+1',date:'',content:'message 1'}],loadedPages:1,totalPages:3,totalMessages:3,loading:true,_first:{page:1,totalPages:3,totalMessages:3,messages:[{id:'1',phone:'+1',date:'',content:'message 1'}]}};
  const progress=[];
  try { await app.loadRemainingSms({realm:'router',nonce:'n',qop:'auth',ha1:'h',nc:1},initial,value=>progress.push({loaded:value.messages.length,total:value.totalMessages})); }
  finally { global.Request=originalRequest; }
  assert.deepEqual(progress,[{loaded:2,total:3},{loaded:3,total:3}]);
});

test('42 messages across five total_number pages finish with a 42/42 SMS counter',async()=>{
  const originalRequest=global.Request;
  const requestedPages=[];
  global.Request=class {
    constructor(url){this.url=url;this.method='GET';this.headers={};this.response=null;}
    async loadString(){
      const page=Number((this.body.match(/<page_number>(\d+)<\/page_number>/)||[])[1]);
      requestedPages.push(page);
      const start=(page-1)*10+1,end=Math.min(42,page*10);
      const items=Array.from({length:Math.max(0,end-start+1)},(_,offset)=>{const id=start+offset;return `<Item index="${id}"><index>${id}</index><from>+${id}</from><content>message ${id}</content></Item>`}).join('');
      this.response={statusCode:200,headers:{}};
      return `<RGW><message><get_message><total_number>5</total_number>${items}</get_message></message></RGW>`;
    }
  };
  try {
    const firstMessages=Array.from({length:10},(_,offset)=>({id:String(offset+1),phone:`+${offset+1}`,date:'',content:`message ${offset+1}`}));
    const initial={messages:firstMessages,loadedPages:1,totalPages:5,totalMessages:null,loading:true,_first:{page:1,totalPages:5,totalMessages:null,messages:firstMessages}};
    const progress=[];
    const history=await app.loadRemainingSms({realm:'router',nonce:'n',qop:'auth',ha1:'h',nc:1},initial,value=>progress.push({loaded:value.messages.length,total:value.totalMessages}));
    assert.deepEqual(progress,[{loaded:20,total:42},{loaded:30,total:42},{loaded:40,total:42},{loaded:42,total:42}]);
    assert.deepEqual(requestedPages,[5,2,3,4]);
    assert.equal(history.totalPages,5);
    assert.equal(history.totalMessages,42);
    assert.equal(history.messages.length,42);
    assert.deepEqual(history.messages.map(message=>message.id),Array.from({length:42},(_,index)=>String(index+1)));
    assert.equal(new Set(history.messages.map(message=>message.id)).size,42);
    assert.ok(!history.warning);
    const html=app.buildHtml({ ...model(), sms:history });
    assert.match(html,/SMS: 42\/42/);
    assert.doesNotMatch(html,/SMS: 42\/5/);
  } finally { global.Request=originalRequest; }
});

test('diagnostics use one accessible spinner, friendly grouped labels and selectable values',()=>{
  const fixture=model('router'); fixture.cellularDiagnostics={loadedAt:Date.now(),values:{ipv4:{value:'10.2.3.4',raw:'10.2.3.4'},gateway4:{value:'10.2.3.1',raw:'10.2.3.1'},dns1:{value:'1.1.1.1',raw:'1.1.1.1'},configuredApn:{value:'internet',raw:'internet'}},stages:{sim:{state:'ok',detail:'Ready'},registration:{state:'ok',detail:'Home'},pdp:{state:'ok',detail:'Connected'}}};
  const html=app.buildHtml(fixture);
  assert.equal((html.match(/class="diag-spinner"/g)||[]).length,1);
  assert.match(html,/role="status"[\s\S]*Loading diagnostics/); assert.doesNotMatch(html,/Loading diagnostics…/);
  for(const label of ['Connection and APN','Configured APN','IP, gateways and DNS','IPv4 gateway','Radio network and signal quality'])assert.match(html,new RegExp(label));
  for(const internal of ['>configuredApn<','>activeApn<','>pdpType<','>gateway4<'])assert.doesNotMatch(html,new RegExp(internal));
  for(const address of ['10.2.3.4','10.2.3.1','1.1.1.1'])assert.equal((html.match(new RegExp(address.replace(/\./g,'\\.'),'g'))||[]).length,2); // text plus data-raw
  assert.match(html,/class="app-value" data-diag="ipv4"/); assert.match(html,/\.app-value\{user-select:text;-webkit-user-select:text;-webkit-touch-callout:default/);
  assert.match(html,/@media\(prefers-reduced-motion:reduce\)[^{]*\{[^}]*[\s\S]*?\.diag-spinner\{animation:none/);
});

test('initial and dynamically inserted SMS values remain selectable',()=>{
  const html=app.buildHtml(model()),js=app.clientScript(model());
  assert.match(html,/<h3 class="app-value">\+1<\/h3>/); assert.match(html,/<p class="body app-value">hello<\/p>/);
  assert.match(js,/querySelectorAll\('h3,time,\.body,\.translation span'\)[\s\S]*classList\.add\('app-value'\)/);
  assert.doesNotMatch(html,/<button[^>]*class="[^"]*app-value/);
});

test('v2 client delegates SMS long press copying and suppresses its following click',()=>{
  const html=require('../modules/ui-v2.js').buildHtml(model());
  const script=html.match(/<script>([\s\S]*)<\/script>/i);
  assert.ok(script,'v2 dashboard must contain a generated client script');
  const js=script[1];
  assert.match(js,/addEventListener\('pointerdown'/);
  assert.match(js,/setTimeout\(async\(\)=>[\s\S]*?,550\)/);
  assert.match(js,/command\('copySms', \{text\}\)/);
  assert.match(js,/addEventListener\('pointermove'[\s\S]*?cancelSmsLongPress/);
  assert.match(js,/addEventListener\('pointerup',cancelSmsLongPress\)/);
  assert.match(js,/addEventListener\('pointercancel',cancelSmsLongPress\)/);
  assert.match(js,/addEventListener\('scroll',cancelSmsLongPress,true\)/);
  assert.match(js,/suppressSmsClick=row/);
  assert.match(js,/stopImmediatePropagation\(\)/);
  assert.match(js,/closest\('\.row-menu'\)/);
});
