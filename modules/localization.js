const EN = Object.freeze({
  confirm: "Confirm", cancel: "Cancel", unsupported: "Unsupported",
  unknownRaw: "Unknown (raw: {value})", unavailable: "Unavailable",
  multipartWarning: "This message uses {segments} SMS segments and may incur multiple charges.",
  telnetWarning: "Telnet commonly provides unencrypted remote shell access.",
  deletePrompt: "Delete the message from {sender}, received {date}? Preview: {preview}"
});
function escape(value){return String(value == null ? "" : value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");}
function t(key, parameters={}, locale="en"){const template=(locale==="en"&&EN[key])||EN[key]||key;return template.replace(/\{([A-Za-z0-9_]+)\}/g,(_,name)=>escape(parameters[name]));}
module.exports={EN,t,escape};
