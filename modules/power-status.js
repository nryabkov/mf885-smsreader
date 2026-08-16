const EXACT_FIRMWARE = "2.5.94_release_MF855_NZ_CP_2.129.003";

function text(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isLv01Family(identity = {}) {
  const models = [identity.rawModel, identity.actualRawModel, identity.actualModel, identity.model].map(text);
  return models.some(model => /^(?:LV01|MF885)$/i.test(model));
}

function isLv01Profile(identity = {}) {
  const firmware = text(identity.firmware || identity.actualFirmware);
  return isLv01Family(identity) && firmware === EXACT_FIRMWARE;
}

function decode(fields = {}, identity = {}) {
  if (!isLv01Profile(identity)) return { confirmed: false, state: "unknown", firmwareState: "unknown" };

  const batteryStatus = text(fields.batteryStatus);
  const chargerStatus = text(fields.chargerStatus);
  if (batteryStatus === "1") {
    if (chargerStatus === "4") {
      return { confirmed: true, firmwareState: "charging", state: "full", inputConnected: true, usbOutputActive: false, chargeHealth: "full" };
    }
    if (chargerStatus === "5") {
      return { confirmed: true, firmwareState: "charging", state: "charging-error", inputConnected: true, usbOutputActive: false, chargeHealth: "abnormal" };
    }
    return { confirmed: true, firmwareState: "charging", state: "charging", inputConnected: true, usbOutputActive: false, chargeHealth: chargerStatus === "" ? "unknown" : "normal" };
  }
  if (batteryStatus === "2") {
    return { confirmed: true, firmwareState: "feeding", state: "powering-usb", inputConnected: false, usbOutputActive: true, chargeHealth: "not-charging" };
  }
  if (batteryStatus === "3") {
    return { confirmed: true, firmwareState: "normal", state: "not-charging", inputConnected: false, usbOutputActive: false, chargeHealth: "not-charging" };
  }
  return { confirmed: true, firmwareState: "unknown", state: "unknown", inputConnected: false, usbOutputActive: false, chargeHealth: "unknown" };
}

module.exports = { EXACT_FIRMWARE, isLv01Family, isLv01Profile, decode };
