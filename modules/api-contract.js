const XML_API_PATH = "/cgi/xml_action.cgi";

function requestUrl(host, method, file, command) {
  const query = [`method=${method === "GET" ? "get" : "set"}`, "module=duster", `file=${encodeURIComponent(file)}`];
  if (command !== undefined && command !== null) query.push(`command=${encodeURIComponent(command)}`);
  return `http://${host}${XML_API_PATH}?${query.join("&")}`;
}

async function writeThenVerify(options) {
  const { model, xml, verificationModel = model, verify, destructive = false, post, get, pollAvailability } = options;
  if (!model || !xml || typeof post !== "function" || typeof verify !== "function") throw new Error("Invalid write-then-verify operation");
  let response;
  try { response = await post(model, xml, { retry401: !destructive }); }
  catch (error) {
    if (!destructive) return { outcome: "unknown", error };
    if (typeof pollAvailability === "function") await pollAvailability();
    return { outcome: "pending/unknown", error };
  }
  if (destructive) {
    if (typeof pollAvailability === "function") await pollAvailability();
    return { outcome: "pending/unknown", response };
  }
  let control;
  try { control = await get(verificationModel); }
  catch (error) { return { outcome: "unknown", response, error }; }
  const verdict = await verify(control, response);
  if (verdict === true || verdict === "confirmed") return { outcome: "confirmed", response, control };
  if (verdict === false || verdict === "rejected") return { outcome: "rejected", response, control };
  return { outcome: "unknown", response, control };
}

module.exports = { XML_API_PATH, requestUrl, writeThenVerify };
