async function control(_api, _enable, confirmed) {
  if (!confirmed) return { outcome: "rejected", reason: "confirmation-required" };
  return { outcome: "unsupported", reason: "No universal Telnet contract is confirmed" };
}
module.exports = { control };
