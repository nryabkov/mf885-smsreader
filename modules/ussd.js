// Experimental ZMI USSD support isolated from the dashboard application.

const CANDIDATES = [
  { file: "ussd", root: "ussd", field: "ussd_cmd" },
  { file: "ussd", root: "USSD", field: "ussd_command" },
  { file: "ussd_status", root: "ussd", field: "ussd_cmd" },
  { file: "ussd_setting", root: "ussd", field: "ussd_cmd" }
];

async function detect(api) {
  const probes = [];
  for (const candidate of uniqueFiles()) {
    try {
      const xml = await api.xmlRequest("GET", candidate.file, null, true, 5);
      const rejected = isUnsupported(xml);
      probes.push(`${candidate.file}: ${rejected ? "rejected" : "responded"}`);

      // Several MF855/MF885 firmware builds return an empty RGW container for
      // a valid USSD endpoint. A successful, non-error router response is
      // therefore a usable candidate even when it has no <ussd> element yet.
      if (!rejected && /<RGW\b|<ussd\b|<USSD\b/i.test(String(xml || ""))) {
        return {
          supported: true,
          candidates: CANDIDATES.filter(item => item.file === candidate.file),
          detail: `Firmware responded to the ${candidate.file} endpoint.`,
          probes
        };
      }
    } catch (error) {
      probes.push(`${candidate.file}: ${api.cleanError(error)}`);
    }
  }

  // Detection is deliberately inconclusive rather than "unsupported". Some
  // firmware accepts POST but rejects or hides GET, so the user may still try
  // the known request variants explicitly.
  return {
    supported: null,
    candidates: CANDIDATES,
    detail: "No endpoint was confirmed by a safe GET probe. A manual USSD attempt is still available.",
    probes
  };
}

async function execute(api, capability, code) {
  const attempts = [];
  const candidates = capability.candidates && capability.candidates.length
    ? capability.candidates
    : CANDIDATES;

  for (const candidate of candidates) {
    const xml = buildRequest(candidate, code, api.escapeXml);
    try {
      let response = await api.xmlRequest("POST", candidate.file, xml, true, 20);
      attempts.push(`${candidate.file}/${candidate.field}: ${compact(response)}`);
      let parsed = parseResponse(response, code, api);
      if (parsed.response) return success(parsed.response, candidate, attempts);
      if (parsed.rejected) continue;

      for (let poll = 0; poll < api.responsePolls; poll++) {
        await api.sleep(1000);
        response = await api.xmlRequest("GET", candidate.file, null, true, 10);
        parsed = parseResponse(response, code, api);
        if (parsed.response) return success(parsed.response, candidate, attempts);
        if (parsed.rejected) break;
      }

      if (!parsed.rejected) {
        return {
          ok: true,
          title: "USSD command accepted",
          message: "The firmware accepted the request but did not expose response text.",
          diagnostics: attempts.join("\n")
        };
      }
    } catch (error) {
      attempts.push(`${candidate.file}/${candidate.field}: ${api.cleanError(error)}`);
    }
  }

  return {
    ok: false,
    title: "USSD request failed",
    message: "The firmware rejected all known USSD request variants.",
    diagnostics: attempts.join("\n")
  };
}

function parseResponse(xml, code, api) {
  const text = String(xml || "");
  const raw = api.firstText(text, [
    "ussd_response", "ussd_result", "network_response", "response_text",
    "result_text", "response", "content"
  ]);
  const response = api.decodeSms(raw);
  return {
    response: response && response !== code ? response : "",
    rejected: isUnsupported(text) || /<status>\s*(?:2|3|4|5|-1)\s*<\/status>/i.test(text)
  };
}

function buildRequest(candidate, code, escapeXml) {
  return `<?xml version="1.0" encoding="US-ASCII"?>` +
    `<RGW><${candidate.root}><${candidate.field}>${escapeXml(code)}` +
    `</${candidate.field}></${candidate.root}></RGW>`;
}

function isUnsupported(xml) {
  return /not.?found|unknown.?file|not.?support|unsupported|invalid.?file|unauthorized/i
    .test(String(xml || ""));
}

function uniqueFiles() {
  const seen = new Set();
  return CANDIDATES.filter(item => {
    if (seen.has(item.file)) return false;
    seen.add(item.file);
    return true;
  });
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function success(response, candidate, attempts) {
  return {
    ok: true,
    title: "USSD response",
    message: response,
    diagnostics: [`Endpoint: ${candidate.file}/${candidate.field}`, ...attempts].join("\n")
  };
}

module.exports = { detect, execute };
