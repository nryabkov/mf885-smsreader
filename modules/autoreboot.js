function field(xml,name){const m=String(xml||"").match(new RegExp(`<${name}>[\\s\\S]*?<\\/${name}>`,"i"));return m?m[0].replace(/^<[^>]+>|<\/[^>]+>$/g,"").trim():null;}
function parse(xml){return { enabled:field(xml,"autoreboot_enabled"), time:field(xml,"autoreboot_time") };}
async function read(api){return parse(await api.xmlRequest("GET","autoreboot"));}
async function set(){return {outcome:"unsupported"};}
module.exports={parse,read,set};
