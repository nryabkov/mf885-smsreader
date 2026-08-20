const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const vm=require("node:vm");
const path=require("node:path");

let parseHTML=null;
for(const candidate of ["linkedom","/opt/openclaw-runtime/releases/2026.7.1-2/lib/node_modules/openclaw/node_modules/linkedom"]){try{({parseHTML}=require(candidate));break}catch(_){}}

class FakeXHR{
  constructor(){this.listeners={};this.readyState=0;this.status=0;this.responseText="";FakeXHR.instances.push(this)}
  open(method,url){this.method=method;this.url=url;this.readyState=1}
  addEventListener(name,handler){(this.listeners[name]||(this.listeners[name]=[])).push(handler)}
  send(body){this.body=body;this.status=200;this.readyState=4;this.responseText=/file=message/.test(this.url)?'<RGW><message><sender>+15551234567</sender><content>PRIVATE SMS WORDS</content></message></RGW>':'<RGW><detailed_log><pdp_name>internet.apn</pdp_name><ip_addr>10.0.0.2</ip_addr><wifimac>aa:bb:cc:dd:ee:ff</wifimac></detailed_log></RGW>';if(this.onreadystatechange)this.onreadystatechange();for(const handler of this.listeners.loadend||[])handler.call(this)}
}
FakeXHR.instances=[];

test("firmware Canary panel runs, polls exact detailed_log and hides only SMS payloads",{skip:!parseHTML},async()=>{
  FakeXHR.instances=[];
  const {window}=parseHTML('<html><head></head><body></body></html>'),document=window.document,script=fs.readFileSync(path.join(__dirname,"../firmware/webui-canary-logs/canary_logs.js"),"utf8");
  let copied="";
  const context={window,document,console,XMLHttpRequest:FakeXHR,navigator:{clipboard:{writeText:async value=>{copied=value}}},location:{href:"http://192.168.21.1/"},setInterval:()=>1,setTimeout,clearTimeout,Date,JSON,Array,Object,String,Number,Boolean,RegExp,Error,Promise,Map,Set,Blob,URL:{createObjectURL:()=>"blob:test",revokeObjectURL:()=>{}},XMLSerializer:window.XMLSerializer};
  window.window=window;window.document=document;window.XMLHttpRequest=FakeXHR;window.fetch=null;
  vm.createContext(context);vm.runInContext(script,context);
  assert.equal(window.MF885_COMMUNITY_CANARY.id,"0.0-logs-r1");
  assert.ok(document.getElementById("zmiDbgToggle"));assert.ok(document.getElementById("zmiDbgPanel"));
  document.getElementById("zmiDbgToggle").click();
  const poll=FakeXHR.instances.at(-1);assert.equal(poll.method,"GET");assert.equal(poll.url,"xml_action.cgi?method=get&module=duster&file=detailed_log");
  const technical=new FakeXHR();technical.open("GET","xml_action.cgi?method=get&module=duster&file=status1");technical.send(null);
  const sms=new FakeXHR();sms.open("POST","xml_action.cgi?method=set&module=duster&file=message");sms.send('<content>PRIVATE REQUEST</content><phone_number>+15557654321</phone_number>');
  window.console.warn("call +15559876543 failed");
  const visible=document.getElementById("zmiDbgList").textContent;
  for(const technicalValue of ["internet.apn","10.0.0.2","aa:bb:cc:dd:ee:ff"])assert.match(visible,new RegExp(technicalValue.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  for(const smsValue of ["PRIVATE SMS WORDS","PRIVATE REQUEST","+15551234567","+15557654321","+15559876543"])assert.doesNotMatch(visible,new RegExp(smsValue.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(visible,/SMS payload hidden/);
  document.getElementById("zmiDbgCopy").click();await Promise.resolve();
  assert.match(copied,/internet\.apn/);assert.doesNotMatch(copied,/PRIVATE SMS WORDS/);
});
