const DRY_RUN_SCHEMA = 1;

function freezeTree(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.keys(value).forEach(key => freezeTree(value[key]));
  return Object.freeze(value);
}

const RESTORE_DRY_RUN_PROFILE = freezeTree({
  schema: DRY_RUN_SCHEMA,
  firmware: "2.5.94_release_MF855_NZ_CP_2.129.003",
  upload: {
    method: "POST",
    requestPath: "/xml_action.cgi",
    query: "Action=RestoreFw",
    digestUri: "/cgi/xml_action.cgi",
    multipartMimeType: "application/octet-stream",
    acceptanceStatus: 200,
    acceptanceBody: "Server get upload file successfully\n",
    fixtureAssumptions: {
      multipartField: "file",
      filenameRule: "exact-known-image-filename"
    }
  },
  status: {
    method: "GET",
    requestPath: "/xml_action.cgi",
    query: "method=get&file=GetRestoreStatus",
    rawMap: { "0": "IDLE", "2": "RESTORING", "1": "REBOOT_WAIT", "3": "FAILED" }
  },
  provenance: {
    uploadEnvelope: "native-confirmed",
    multipartMimeMarker: "native-confirmed",
    acceptancePredicate: "native-confirmed",
    multipartField: "conservative-unverified",
    multipartFilename: "conservative-unverified",
    idleStatusSchema: "live-read-confirmed",
    dynamicStatusMap: "native-confirmed"
  }
});

const LIVE_BLOCKERS = Object.freeze([
  "The first RestoreFw POST session/header/cookie behavior is not live-qualified.",
  "Scriptable multipart boundary and transfer serialization have not been captured on a harmless endpoint.",
  "No atomic, non-stealable cross-process Scriptable lease has been proven.",
  "Production transport and risk/recovery evidence allowlists remain empty.",
  "No production RestoreFw adapter is compiled."
]);

function byteView(value) {
  if (value && typeof value.getBytes === "function") return value.getBytes();
  if (Array.isArray(value) || value instanceof Uint8Array) return value;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new Error("Dry-run multipart input must be immutable Scriptable Data or a byte array.");
}

function asciiBytes(value) {
  const text = String(value || "");
  const result = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0x7f) throw new Error("Dry-run multipart metadata must be ASCII.");
    result[index] = code;
  }
  return result;
}

function concatBytes(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function findBytes(haystack, needle, from = 0) {
  outer: for (let index = Math.max(0, Number(from) || 0); index <= haystack.length - needle.length; index++) {
    for (let inner = 0; inner < needle.length; inner++) if (haystack[index + inner] !== needle[inner]) continue outer;
    return index;
  }
  return -1;
}

function safeMultipartToken(value, label, pattern) {
  const text = String(value || "");
  if (!pattern.test(text) || /[\r\n"\\]/.test(text)) throw new Error(`Unsafe dry-run multipart ${label}.`);
  return text;
}

function deterministicBoundary(image) {
  const sha = String(image && image.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("Dry-run image SHA-256 is invalid.");
  return `----mf885-stage0-dryrun-${sha.slice(0, 24)}`;
}

function buildDeterministicMultipart(input = {}) {
  const image = input.image || {};
  const payload = byteView(input.data);
  const boundary = safeMultipartToken(input.boundary || deterministicBoundary(image), "boundary", /^[0-9A-Za-z'()+_,.\-/:=?]{1,70}$/);
  const field = safeMultipartToken(input.field || RESTORE_DRY_RUN_PROFILE.upload.fixtureAssumptions.multipartField, "field", /^[0-9A-Za-z_.-]{1,64}$/);
  const filename = safeMultipartToken(input.filename || image.file, "filename", /^[0-9A-Za-z_+ .()-]{1,180}$/);
  const head = asciiBytes(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${RESTORE_DRY_RUN_PROFILE.upload.multipartMimeType}\r\n\r\n`);
  const tail = asciiBytes(`\r\n--${boundary}--\r\n`);
  return { body: concatBytes([head, payload, tail]), boundary, field, filename, payloadOffset: head.length, payloadLength: payload.length };
}

function extractNativePayload(bodyValue, boundaryValue) {
  const body = byteView(bodyValue);
  const boundary = safeMultipartToken(boundaryValue, "boundary", /^[0-9A-Za-z'()+_,.\-/:=?]{1,70}$/);
  const marker = asciiBytes(`${RESTORE_DRY_RUN_PROFILE.upload.multipartMimeType}\r\n\r\n`);
  const close = asciiBytes(`\r\n--${boundary}--`);
  const markerAt = findBytes(body, marker);
  if (markerAt < 0 || findBytes(body, marker, markerAt + 1) >= 0) throw new Error("Dry-run multipart MIME marker is missing or ambiguous.");
  const start = markerAt + marker.length;
  const end = findBytes(body, close, start);
  if (end < start || findBytes(body, close, end + 1) >= 0) throw new Error("Dry-run multipart closing boundary is missing or ambiguous.");
  return typeof body.subarray === "function" ? body.subarray(start, end) : body.slice(start, end);
}

function verifiedMultipartManifest(input = {}) {
  const image = input.image || {};
  const sha256Hex = input.sha256Hex;
  if (typeof sha256Hex !== "function") throw new Error("Dry-run SHA-256 implementation is unavailable.");
  const built = buildDeterministicMultipart(input);
  const extracted = extractNativePayload(built.body, built.boundary);
  const payloadSha256 = sha256Hex(extracted);
  const expectedSha256 = String(image.sha256 || "").toLowerCase();
  if (extracted.length !== Number(image.size) || payloadSha256 !== expectedSha256) {
    throw new Error("Dry-run multipart payload does not reproduce the exact selected image.");
  }
  return freezeTree({
    schema: DRY_RUN_SCHEMA,
    requestPath: RESTORE_DRY_RUN_PROFILE.upload.requestPath,
    query: RESTORE_DRY_RUN_PROFILE.upload.query,
    digestUri: RESTORE_DRY_RUN_PROFILE.upload.digestUri,
    intendedMethod: RESTORE_DRY_RUN_PROFILE.upload.method,
    boundary: built.boundary,
    multipartField: built.field,
    multipartFilename: built.filename,
    multipartMimeType: RESTORE_DRY_RUN_PROFILE.upload.multipartMimeType,
    fixtureAssumptions: {
      multipartFieldProvenance: RESTORE_DRY_RUN_PROFILE.provenance.multipartField,
      multipartFilenameProvenance: RESTORE_DRY_RUN_PROFILE.provenance.multipartFilename
    },
    bodyBytes: built.body.length,
    bodySha256: sha256Hex(built.body),
    payloadOffset: built.payloadOffset,
    payloadBytes: extracted.length,
    payloadSha256,
    payloadRoundTripVerified: true,
    networkRequestConstructed: false,
    qualification: false,
    flashAllowed: false
  });
}

function processStatus(xml, firstText) {
  const read = typeof firstText === "function"
    ? names => String(firstText(xml, names) || "").trim()
    : names => {
      const source = String(xml || "");
      for (const name of names) {
        const match = source.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
        if (match) return String(match[1]).replace(/<[^>]+>/g, "").trim();
      }
      return "";
    };
  return { status: read(["status"]), progress: read(["progress"]), cause: read(["cause"]) };
}

function classifyProcessStatus(value) {
  const status = String(value && value.status !== undefined ? value.status : value || "").trim();
  return RESTORE_DRY_RUN_PROFILE.status.rawMap[status] || "UNKNOWN";
}

function validateGetOnlyTrace(entries) {
  const trace = Array.isArray(entries) ? entries : [];
  const errors = [];
  trace.forEach((entry, index) => {
    if (String(entry && entry.method || "").toUpperCase() !== "GET") errors.push(`Trace entry ${index + 1} is not GET-only.`);
    if (entry && entry.bodyPresent === true) errors.push(`Trace entry ${index + 1} contains a request body.`);
    if (/Action=RestoreFw/i.test(String(entry && (entry.query || entry.url) || ""))) errors.push(`Trace entry ${index + 1} touches RestoreFw.`);
  });
  return freezeTree({ ok: errors.length === 0, routerGetsAttempted: trace.length, writesAttempted: 0, firmwarePostsAttempted: 0, errors });
}

module.exports = {
  DRY_RUN_SCHEMA,
  RESTORE_DRY_RUN_PROFILE,
  LIVE_BLOCKERS,
  byteView,
  deterministicBoundary,
  buildDeterministicMultipart,
  extractNativePayload,
  verifiedMultipartManifest,
  processStatus,
  classifyProcessStatus,
  validateGetOnlyTrace
};
