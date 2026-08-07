function parseCounter(value) {
  if (value === undefined || value === null || String(value).trim() === "") return { state: "missing", raw: value == null ? "" : String(value), value: null };
  const raw = String(value).trim();
  if (!/^[0-9]+$/.test(raw)) return { state: "invalid", raw, value: null };
  return { state: "valid", raw, value: BigInt(raw) };
}

function formatBytes(value) {
  if (value && typeof value === "object" && "state" in value) value = value.value;
  if (typeof value !== "bigint" || value < 0n) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB", "ZiB", "YiB"];
  let unit = 0, divisor = 1n;
  while (unit + 1 < units.length && value >= divisor * 1024n) { divisor *= 1024n; unit++; }
  if (!unit) return `${value} B`;
  const tenths = (value * 10n + divisor / 2n) / divisor;
  return `${tenths / 10n}.${tenths % 10n} ${units[unit]}`;
}

module.exports = { parseCounter, formatBytes };
