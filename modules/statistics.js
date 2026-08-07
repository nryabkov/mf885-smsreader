const { parseCounter } = require("./counters.js");
function values(xml, name) { const out=[]; const re=new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,"gi"); let m; while((m=re.exec(String(xml||"")))) out.push(m[1].trim()); return out; }
function parseStatistics(xml) {
  const counterNames=["rx_byte","tx_byte","rx_byte_all","tx_byte_all"];
  const counters={}; for(const name of counterNames) counters[name]=parseCounter(values(xml,name)[0]);
  const raw={}; const re=/<([A-Za-z_][\w.-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g; let m;
  while((m=re.exec(String(xml||"")))) { const value=m[2].trim(); if(raw[m[1]]===undefined) raw[m[1]]=value; else raw[m[1]]=[].concat(raw[m[1]],value); }
  const history=values(xml,"history").map(fragment => ({ raw: fragment }));
  return { counters, raw, history, vendorSpelling: { avaliable: raw.avaliable === undefined ? null : raw.avaliable } };
}
module.exports={ parseStatistics, values };
