# Firmware compatibility

The MF855/MF885 family shares substantial web/API code, but hardware revision and firmware build matter. This document separates **observed compatibility** from assumptions.

## Known models / firmware

### MF885 — firmware 2.5.94

This build now has both live-device evidence and a clean firmware image analysed specifically for MF885 / MF96 Ver.D.

Clean golden `BackupFw` evidence:

- target: ZMI MF885 / MF96 Ver.D;
- release lineage: `2.5.94_release_MF855_NZ_CP_2.129.003`;
- device-facing version: `2.5.94`;
- image size: `8,323,644` bytes;
- image SHA-256: `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- decompressed OSLO size: `9,648,064` bytes;
- decompressed OSLO SHA-256: `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c`.

Two consecutive post-reboot backups were byte-identical. An older backup with one all-zero `0x10000` OSLO span is excluded from compatibility evidence.

Static WEBI comparison against the analysed 2.5.96 image found the same 320 filenames, the same 123 XML schemas and the same 51 JavaScript files; 319/320 WEBI files are byte-identical and the only observed stock difference is `www/data/4_apn.txt`. Native OSLO addresses and enum values are still treated as firmware-specific because the OSLO images differ materially.

Live/API evidence includes:

- the physical local XML endpoint `/xml_action.cgi` with Digest `uri=/cgi/xml_action.cgi`;
- `status1`, `wan` and `Engineer_parameter` reads;
- SMS/router behaviour consistent with the project client;
- an Auto APN recovery observation where LTE registration remained present while PDP was stuck `connecting`, and toggling Auto APN off/on restored the data session;
- firmware-scoped LTE/SIM/registration/PDP mappings recorded in `tests/fixtures/mf885-2.5.94`.

Destructive-command evidence now also confirms the reboot contract for this build:

```text
Restart (UI) -> reboot (client action) -> reset (firmware model) -> RGW/reboot
```

The model write is `POST /xml_action.cgi?method=set&module=duster&file=reset` with an XML body equivalent to `<RGW><reboot/></RGW>`. `restore_defaults` is a separate model, so this is a reboot and not a factory-default reset. Connection loss before the HTTP response is expected and must not trigger an automatic replay.

**Status:** 2.5.94 is statically analysed and live-observed. The reboot mapping is **firmware-confirmed**. `poweroff`/`trueshutdown` remain disabled in the 2.5.94 client profile until their exact external trigger/effect reaches the same evidence standard.

See [MF885 2.5.94 static analysis](MF885_2.5.94_STATIC_ANALYSIS.md) for the full firmware-specific evidence set.

### MF855 / MF885 family — firmware 2.5.96

This remains the broadest general API inventory image.

Confirmed static properties include:

- `Marvell_FBF` update container;
- Nucleus PLUS-based monolithic runtime rather than Linux userspace;
- extracted vendor web interface and XML model files;
- roughly 118 XML schemas, ~120 model names and ~1,540 leaf fields in the generated inventory;
- explicit product mapping in vendor JavaScript for several hardware revisions, including a Ver.D / MF885 mapping;
- working Digest/XML API flow used by this project;
- `status1`, `wan`, `Engineer_parameter`, `message`, statistics, management, firmware and other models present in the analysed firmware.

The `2.5.96` compatibility profile contains only mappings considered confirmed for that build. Unknown write operations remain unavailable.

## Compatibility terminology

Use these words precisely:

- **tested** — exercised on a real router and the result was observed.
- **present in firmware** — schema, frontend use or native implementation is found statically.
- **firmware-confirmed** — the exact firmware contract is sufficiently established to advertise in the firmware profile, even if a destructive effect has not been re-exercised during every analysis pass.
- **likely** — evidence suggests compatibility, but it has not been demonstrated sufficiently for a write profile.
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
6. Restart/shutdown requests are one-shot operations: a transport drop is not a reason to replay them blindly.

## Suggested evidence when reporting another firmware

Please include only non-secret diagnostics:

- router model and hardware revision;
- firmware version;
- model/endpoint names attempted;
- XML root/field names;
- redacted responses or raw enum values;
- whether the operation came from the vendor web UI, this project, a packet capture or static firmware analysis.

Do **not** include passwords, Digest responses/nonces, IMEI, ICCID, IMSI, MSISDN, Wi-Fi keys, APN credentials, ACS/TR-069 credentials or configuration backups.

## Profile selection precedence

The application selects exactly one profile in this order: an explicit
`compatibilityProfileOverride`, the firmware version (and model when needed)
reported by the device, and finally `compatibilityProfile`. The configured
`2.5.96` fallback remains a real profile and is never rewritten to `unknown`.

The reboot mapping is present both on the short `2.5.94` MF885 profile and on the full release-lineage profile `2.5.94_release_MF855_NZ_CP_2.129.003`, so a device that reports either version form does not lose the confirmed restart capability.

## MF885 2.5.94 mapping evidence

The dedicated `2.5.94` profile is not an alias for another firmware's enum table. Its confirmed status mappings come from anonymized simultaneous `status1`, `wan`, and `Engineer_parameter` responses in `tests/fixtures/mf885-2.5.94`: `sys_mode=17` (LTE), SIM `1` (ready), registration `1` (home), roaming `0` (home), PDP state `1` (connected), PDP type `IP` (IPv4), and firmware `signalbar` values 0–5. RSRP, RSRQ, SINR, RSSI, band, PCI and EARFCN retain their measured values.

Codes absent from this list—including the fixture's deliberately unknown `sys_submode=99`—are rendered raw with low confidence rather than borrowed from another profile.

RAT roles are profile data: `sys_mode` is current RAT; `sys_submode`, `ConnType` and `proto` are supplemental diagnostics; `preferred_mode`/`connect_mode` are configuration; and `ConnType` is also a connection-type observation. Only fields listed in `alternativeSources` may produce a current-RAT conflict.
