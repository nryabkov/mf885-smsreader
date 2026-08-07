function field(xml,name){const m=String(xml||"").match(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`,"i"));return m?m[0].replace(/^<[^>]+>|<\/[^>]+>$/g,"").trim():null;}
function parse(xml){return { enabled:field(xml,"autoreboot_enabled"), time:field(xml,"autoreboot_time") };}
async function read(api){return parse(await api.xmlRequest("GET","autoreboot"));}
async function set(api,profile,enabled,time){
  const spec=profile&&profile.autoreboot; if(!spec||!spec.confirmed||!spec.booleans.includes(enabled)||!spec.timePattern.test(time)) return {outcome:"unsupported"};
  const xml=`<RGW><auto_reboot><autoreboot_enabled>${api.escapeXml(enabled)}</autoreboot_enabled><autoreboot_time>${api.escapeXml(time)}</autoreboot_time></auto_reboot></RGW>`;
  return api.writeThenVerify({model:"autoreboot",xml,verificationModel:"autoreboot",post:(m,x)=>api.xmlRequest("POST",m,x),get:m=>api.xmlRequest("GET",m),verify:x=>{const v=parse(x);return v.enabled===enabled&&v.time===time;}});
}
module.exports={parse,read,set};
