const XML_REQUEST_PATH = "/xml_action.cgi";
const XML_DIGEST_URI = "/cgi/xml_action.cgi";

function normalizeModelDescriptor(model) {
  if (typeof model === "string") return { name: model, method: "POST" };
  if (!model || typeof model !== "object") return { name: "", method: "POST" };
  return {
    name: String(model.name || model.file || ""),
    method: String(model.method || "POST").toUpperCase()
  };
}

function requestUrl(host, method, file, command, requestPath = XML_REQUEST_PATH) {
  const descriptor = normalizeModelDescriptor(file);
  const model = descriptor.name || String(file || "");
  const query = [`method=${method === "GET" ? "get" : "set"}`, "module=duster", `file=${encodeURIComponent(model)}`];
  if (command !== undefined && command !== null) query.push(`command=${encodeURIComponent(command)}`);
  return `http://${host}${requestPath}?${query.join("&")}`;
}

async function submitDestructive(options) {
  const { model, xml, post, get, pollAvailability } = options;
  const descriptor = normalizeModelDescriptor(model);
  if (!descriptor.name) throw new Error("Invalid destructive command model");

  let response;
  try {
    if (descriptor.method === "GET") {
      if (typeof get !== "function") throw new Error("GET command transport is unavailable");
      response = await get(descriptor.name);
    } else if (descriptor.method === "POST") {
      if (!xml || typeof post !== "function") throw new Error("POST command transport is unavailable");
      response = await post(descriptor.name, xml, { retry401: false });
    } else {
      throw new Error(`Unsupported destructive command method: ${descriptor.method}`);
    }
  } catch (error) {
    if (typeof pollAvailability === "function") await pollAvailability();
    return { outcome: "pending/unknown", error, method: descriptor.method, model: descriptor.name };
  }

  if (typeof pollAvailability === "function") await pollAvailability();
  return { outcome: "pending/unknown", response, method: descriptor.method, model: descriptor.name };
}

async function writeThenVerify(options) {
  const { model, xml, verificationModel, verify, destructive = false, post, get, pollAvailability } = options;
  const descriptor = normalizeModelDescriptor(model);

  if (destructive) {
    return submitDestructive({ model, xml, post, get, pollAvailability });
  }

  if (!descriptor.name || !xml || typeof post !== "function" || typeof get !== "function" || typeof verify !== "function") {
    throw new Error("Invalid write-then-verify operation");
  }

  let response;
  try {
    response = await post(descriptor.name, xml, { retry401: true });
  } catch (error) {
    return { outcome: "unknown", error };
  }

  let control;
  try {
    control = await get(verificationModel || descriptor.name);
  } catch (error) {
    return { outcome: "unknown", response, error };
  }

  const verdict = await verify(control, response);
  if (verdict === true || verdict === "confirmed") return { outcome: "confirmed", response, control };
  if (verdict === false || verdict === "rejected") return { outcome: "rejected", response, control };
  return { outcome: "unknown", response, control };
}

module.exports = {
  XML_REQUEST_PATH,
  XML_DIGEST_URI,
  normalizeModelDescriptor,
  requestUrl,
  submitDestructive,
  writeThenVerify
};
