async function control(api, profile, enable, confirmed) {
  const spec = profile && profile.telnet;
  if (!confirmed) return { outcome: "rejected", reason: "confirmation-required" };
  if (!spec || !spec.confirmed || !spec.model || !spec.field || !spec.values || !spec.port) return { outcome: "unsupported" };
  const requested = enable ? spec.values.enable : spec.values.disable;
  if (requested === undefined) return { outcome: "unsupported" };
  if (spec.readable) await api.xmlRequest("GET", spec.model);
  const xml = `<RGW><${spec.root}><${spec.field}>${api.escapeXml(requested)}</${spec.field}></${spec.root}></RGW>`;
  const result = await api.writeThenVerify({model:spec.model,xml,verificationModel:spec.model,post:(m,x)=>api.xmlRequest("POST",m,x),get:m=>api.xmlRequest("GET",m),verify:body=>spec.readState(body)===requested});
  if (result.outcome !== "confirmed") return result;
  if (!api.portCheck) return { outcome: "pending/unknown", message: "API accepted; port verification unavailable" };
  const tries = Math.max(1, Math.min(5, api.portCheckRetries || 2));
  for (let i=0;i<tries;i++) if (await api.portCheck(api.host, spec.port, api.portCheckTimeout || 1000)) return { outcome: enable ? "confirmed" : "rejected" };
  return { outcome: enable ? "api-enabled-port-closed" : "confirmed" };
}
module.exports = { control };
