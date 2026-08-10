# Firmware compatibility

The MF855/MF885 family shares substantial web/API code, but hardware revision and firmware build matter. This document separates **observed compatibility** from assumptions.

## Known models / firmware

### MF885 — firmware 2.5.94

Evidence available from a live device/UI:

- vendor web UI identifies current software version as `2.5.94`;
- the router exposes the same local management host pattern (`192.168.21.1`);
- SMS/router UI behaviour is consistent with the family API;
- an Auto APN recovery behaviour was observed on a live MF885: LTE registration was present, PDP remained `connecting`, IPv4 stayed `NA`, and toggling Auto APN off/on restored data service.

**Status:** live device exists; API coverage has not been statically enumerated from a 2.5.94 firmware image in this repository.

### MF855 / MF885 family — firmware 2.5.96

This is the most deeply analysed image.

Confirmed static properties include:

- `Marvell_FBF` container;
- Nucleus PLUS-based monolithic runtime rather than Linux userspace;
- extracted vendor web interface and XML model files;
- roughly 118 XML schemas, ~120 model names and ~1,540 leaf fields in the generated inventory;
- explicit product mapping in vendor JavaScript for several hardware revisions, including a Ver.D / MF885 mapping;
- working Digest/XML API flow used by this project;
- `status1`, `wan`, `Engineer_parameter`, `message`, statistics, management, firmware and other models present in the analysed firmware.

The project currently has a `2.5.96` compatibility profile. It deliberately contains only mappings considered confirmed for that build. Unknown write operations remain unavailable.

## Compatibility terminology

Use these words precisely:

- **tested** — exercised on a real router and the result was observed.
- **present in firmware** — schema, frontend use or native implementation is found statically.
- **likely** — evidence suggests compatibility, but it has not been demonstrated.
- **unknown** — no reliable evidence.

## Important differences to expect

Firmware may differ in:

- XML model names and field casing;
- numeric enum values;
- reboot/power-off fields;
- statistics reset mechanism;
- APN/profile behaviour;
- cellular mode controls;
- Telnet/debug availability;
- firmware-backup/update handling;
- session checks and allowlists.

Client code should therefore prefer firmware-specific compatibility profiles over broad probing.

## Current project policy

The application follows these rules:

1. Read-only diagnostic discovery may try known model names.
2. Unknown enum values are displayed raw.
3. A write control is enabled only when the active firmware profile contains a confirmed mapping.
4. Destructive actions are never inferred from neighbouring field names.
5. Ordinary writes are verified by a control read when possible.

## Suggested evidence when reporting another firmware

Please include only non-secret diagnostics:

- router model and hardware revision;
- firmware version;
- model/endpoint names attempted;
- XML root/field names;
- redacted responses or raw enum values;
- whether the operation came from the vendor web UI, this project, or a packet capture.

Do **not** include passwords, Digest responses/nonces, IMEI, ICCID, IMSI, MSISDN, Wi-Fi keys, APN credentials, ACS/TR-069 credentials or configuration backups.

## Profile selection precedence

The application selects exactly one profile in this order: an explicit
`compatibilityProfileOverride`, the firmware version (and model when needed)
reported by the device, and finally `compatibilityProfile`. The configured
`2.5.96` fallback remains a real profile and is never rewritten to `unknown`.

## MF885 2.5.94 mapping evidence

The dedicated `2.5.94` profile is not an alias for the MF855 NZ build. Its
confirmed mappings come from anonymized simultaneous `status1`, `wan`, and
`Engineer_parameter` responses in `tests/fixtures/mf885-2.5.94`: `sys_mode=17`
(LTE), SIM `1` (ready), registration `1` (home), roaming `0` (home), PDP state
`1` (connected), PDP type `IP` (IPv4), and firmware `signalbar` values 0–5.
RSRP, RSRQ, SINR, RSSI, band, PCI and EARFCN retain their measured values.
Codes absent from this list—including the fixture's deliberately unknown
`sys_submode=99`—are rendered raw with low confidence rather than borrowed from
MF855 or 2.5.96.

RAT roles are profile data: `sys_mode` is current RAT; `sys_submode`, `ConnType`
and `proto` are supplemental diagnostics; `preferred_mode`/`connect_mode` are
configuration; and `ConnType` is also a connection-type observation. Only fields
listed in `alternativeSources` may produce a current-RAT conflict.
