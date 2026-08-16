# MF885 read-only preflight

This is the first live-device check before any reboot, shutdown, debug, restore, configuration, or firmware experiment. It gathers narrowly scoped evidence without changing router state.

## Fixed request allowlist

The collector sends one authenticated GET to each of these model names, in this order:

```text
status1
wan
Engineer_parameter
miautosleep
smart_set
uapxb_wlan_basic_settings
autoreboot
```

The allowlist is a constant in `modules/read-only-preflight.js`; user input cannot add an endpoint. Individual failures are recorded and do not cause a write fallback.

The collector also maintains an explicit denylist containing:

```text
RestoreFw
BackupFwStart
RestoreBackup
reset
poweroff
restore_defaults
debugmodeon
```

No POST, SET, `routerCall`, upload, configuration restore, reboot, shutdown, factory reset, debug-mode, or firmware endpoint belongs to this flow.

## Report contents

The copyable JSON report contains only:

- normalized and raw model label, reported hardware revision, and firmware version;
- battery percentage and raw battery/charger enums;
- boolean presence of operator and APN fields, never their values;
- selected autosleep, Wi-Fi sleep, WPS-button, and auto-reboot values;
- per-endpoint success, response byte count, authorization indicator, or sanitized bounded error;
- an ordered list of attempted method/model pairs;
- explicit safety assertions: `writesAttempted: 0`, `forbiddenEndpointsTouched: false`, `restoreTransportVerified: false`, and `flashAllowed: false`.

Raw XML is discarded after extraction. The report does not include IMEI, ICCID, IMSI, MSISDN, phone numbers, SMS data, SSID/Wi-Fi keys, APN/operator values, credentials, Digest material, configuration backups, or response field values from the generic endpoint summaries.

`restoreTransportVerified: false` and `flashAllowed: false` are deliberate. A successful preflight proves only that these seven reads completed; it cannot authorize a restore or flash operation.

## First live run

1. Keep the MF885 on normal battery/USB power and connect the iPhone to its Wi-Fi.
2. Open the dashboard and do not use any System command.
3. Select **Run read-only preflight** in Experimental features.
4. Copy the report and review it before choosing any later experiment.
5. Confirm `identity.rawModel` is `LV01` (or `MF885`), `identity.firmware` is the full expected 2.5.94 string, `writesAttempted` is `0`, and `forbiddenEndpointsTouched` is `false`.

The next eligible experiment, after human review, is one confirmed reboot—not power-off or firmware restore. Reboot remains a destructive, connection-dropping request and is outside this preflight.
