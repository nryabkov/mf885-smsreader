const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const ui=require("../modules/ui-v2.js");
const fixes=require("../modules/ui-v2-fixes.js");

let parseHTML=null;
for(const candidate of ["linkedom","/opt/openclaw-runtime/releases/2026.7.1-2/lib/node_modules/openclaw/node_modules/linkedom"]){
  try{({parseHTML}=require(candidate));break}catch(_){}
}

function model(){return {loadedAt:Date.now(),pollSeconds:30,actualModel:"MF885",actualFirmware:"2.5.94_release_MF855_NZ_CP_2.129.003",softwareVersion:"test",softwareRevision:"a".repeat(40),errors:{},network:{mode:"LTE",generation:"4G",operator:"Carrier",dbm:-91,bars:3},battery:{percent:100},traffic:{},sms:{messages:[]},cellularDiagnostics:{values:{},stages:{},routerLog:{available:true,pdpSessions:0,clientSessions:0,events:[]}},cellularControl:{},ussd:{},deviceAccess:{},powerControls:{available:true,reason:"Exact profile",actions:{reboot:true,powerOff:true}},firmwareRestore:{available:false,reason:"Locked"}};}

function storage(){const values=new Map();return {getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}

function responseFor(action){
  if(action==="diagnosticLogSnapshot")return {events:[],nextCursor:0};
  if(action==="copyDiagnosticLog")return {copied:true,events:0};
  if(action==="safePreflight")return {text:"read-only"};
  if(action==="appAuthProbe"||action==="firmwareTransportProbe")return {text:"GET only",readSideComplete:true};
  if(action==="firmwareCanaryValidate")return {cancelled:true};
  if(action==="firmwareJournalStatus")return {transaction:null,text:"",clearable:false};
  if(action==="lastPowerReport")return {diagnostics:"saved report"};
  return {};
}

function createPage(){
  const data=model(),markup=fixes.enhanceHtml(ui.buildHtml(data),data),parsed=parseHTML(markup),window=parsed.window,document=window.document,commands=[];
  const browserTimeout=(fn,delay,...args)=>{const timer=setTimeout(fn,delay,...args);if(timer&&typeof timer.unref==="function")timer.unref();return timer};
  const context={window,document,console,CustomEvent:window.CustomEvent,Event:window.Event,HTMLElement:window.HTMLElement,Node:window.Node,navigator:{clipboard:{writeText:async()=>{}}},location:{href:"http://192.168.21.1/"},sessionStorage:storage(),localStorage:storage(),confirm:()=>true,alert:()=>{},setTimeout:browserTimeout,clearTimeout,setInterval:()=>1,clearInterval:()=>{},Date,Math,Map,Set,Promise,JSON,Array,Object,String,Number,Boolean,RegExp,Error,URL,Blob};
  window.window=window;window.document=document;window.confirm=context.confirm;window.alert=context.alert;window.scrollTo=()=>{};document.execCommand=()=>true;
  if(window.HTMLElement&&window.HTMLElement.prototype)window.HTMLElement.prototype.scrollIntoView=function(){};
  vm.createContext(context);
  for(const script of Array.from(document.querySelectorAll("script")))vm.runInContext(script.textContent,context);
  window.addEventListener("ZMICommand",event=>{const command=event.detail;commands.push(command);setTimeout(()=>window.zmiApplyActionResult({id:command.id,ok:true,result:responseFor(command.action)}),0)});
  return {window,document,commands};
}

function wait(){return new Promise(resolve=>setTimeout(resolve,8));}

test("v2 enabled primary controls execute a local change or exactly one bridge command",{skip:!parseHTML},async()=>{
  const ids=["settingsBtn","powerBtn","newSms","refreshNow","diagRefresh","pauseBtn","detectAll","safePreflight","appAuthProbe","firmwareTransportProbe","firmwareCanaryValidate","firmwareJournalBtn","lastPowerReportBtn"];
  for(const id of ids){
    const page=createPage(),button=page.document.getElementById(id);
    assert.ok(button,`${id} exists`);assert.equal(button.disabled,false,`${id} is enabled in fixture`);assert.equal(typeof button.onclick,"function",`${id} has a handler`);
    const before=page.document.getElementById("sheetRoot").innerHTML+"|"+button.textContent+"|"+button.className,beforeCommands=page.commands.length;
    button.click();await wait();
    const after=page.document.getElementById("sheetRoot").innerHTML+"|"+button.textContent+"|"+button.className;
    const emitted=page.commands.length-beforeCommands;
    assert.ok(after!==before||emitted===1,`${id} was inert`);
    assert.ok(emitted<=1,`${id} emitted duplicate commands`);
    assert.notEqual(page.commands.at(-1)&&page.commands.at(-1).action,"powerOff",`${id} must not test shutdown`);
  }
});

test("Logs subtab executes streaming controls and never polls while hidden",{skip:!parseHTML},async()=>{
  const page=createPage();
  assert.equal(page.commands.length,0);
  page.document.querySelector('[data-diag-tab="logs"]').click();await wait();
  assert.equal(page.commands.filter(command=>command.action==="diagnosticLogSnapshot").length,1);
  assert.equal(page.document.querySelector('[data-diag-section="logs"]').classList.contains("diag-hidden"),false);
  const pause=page.document.getElementById("liveLogPause");pause.click();assert.equal(pause.textContent,"Resume");pause.click();await wait();assert.equal(pause.textContent,"Pause");
  page.document.getElementById("liveLogClear").click();
  page.document.getElementById("liveLogRefresh").click();await wait();
  page.document.getElementById("liveLogCopy").click();await wait();
  assert.equal(page.commands.filter(command=>command.action==="copyDiagnosticLog").length,1);
  page.document.querySelector('[data-diag-tab="connection"]').click();
  const hiddenCount=page.commands.length;await wait();assert.equal(page.commands.length,hiddenCount);
});

test("help and navigation buttons produce visible state changes",{skip:!parseHTML},()=>{
  const page=createPage(),help=page.document.querySelector(".help-button"),tab=page.document.querySelector('[data-tab="diagnostics"]');
  help.click();assert.ok(page.document.querySelector('[data-overlay="help"]'));
  page.document.querySelector("[data-help-close]").click();assert.equal(page.document.querySelector('[data-overlay="help"]'),null);
  tab.click();assert.equal(tab.classList.contains("active"),true);
  assert.equal(page.document.getElementById("screen-diagnostics").classList.contains("active"),true);
});
