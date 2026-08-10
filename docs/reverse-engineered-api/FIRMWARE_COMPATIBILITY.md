# Firmware compatibility

The MF855/MF885 family shares substantial web/API code, but hardware revision and firmware build matter. This document separates **observed compatibility** from assumptions.

## Known models / firmware

### MF885 — firmware 2.5.94

This build has now been analysed both on a live MF885 and statically from an exact stock BackupFw image.

Static-analysis baseline:

- stock BackupFw size: `8,323,644` bytes;
- stock BackupFw SHA-256: `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- decompressed OSLO size: `9,648,064` bytes (`0x9337c0`);
- decompressed OSLO SHA-256: `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c`;
- extracted WEBI contains the same 320 paths as the analysed 2.5.96 image, with 319/320 files byte-identical; the stock difference is `www/data/4_apn.txt`;
- GRBI, WIFI, WCAL and RFBN are byte-identical between the analysed 2.5.94 and 2.5.96 images;
- raw OSLO is **not** byte-identical: after accounting for the known 64-byte insertion, roughly 16.35% of raw bytes still differ. Native offsets and callbacks must therefore be established per build rather than copied from 2.5.96.

The exact 2.5.94 OSLO was used for native descriptor/callback analysis and for the project's staged firmware research. The Duster registry uses 0x38-byte model descriptors; the active callback slots are `pre_set`, `post_set`, `pre_get`, and `post_get`. This is important because an XML schema alone does not tell us which HTTP method actually causes a command side effect.

Live evidence from the MF885 includes:

- local management at `192.168.21.1` with the project's Digest/XML flow;
- confirmed `status1`, `wan`, and `Engineer_parameter` data used by `tests/fixtures/mf885-2.5.94`;
- an Auto APN recovery observation: LTE registration remained present while PDP was stuck in `connecting` with IPv4 `NA`; toggling Auto APN off/on restored the data session.

#### Power-command static findings

The stock web payload contains these XML contracts:

```xml
<!-- reset.xml -->
<RGW><reboot/></RGW>

<!-- poweroff.xml -->
<RGW><shutdown/></RGW>
```

The firmware also distinguishes the `reset`, `poweroff`, and `restore_defaults` models. Therefore:

- `reset` / `reboot` is a **router reboot**, not a factory reset;
- `restore_defaults` is the separate factory-default path;
- `poweroff` / `shutdown` is the shutdown model;
- `trueshutdown` exists in the wider firmware family, but its practical semantics are not sufficiently established to expose it.

What is **not** yet promoted to runtime-confirmed support on 2.5.94 is the destructive trigger transport. Older static notes identify `reset` and `poweroff` as command-on-read models (`GET ...&file=reset` / `GET ...&file=poweroff`), while the generic schema inventory lists both ordinary Duster GET and SET forms and the current project client implements destructive commands through a POST/SET path. No preserved live packet capture or exact 2.5.94 callback-direction proof currently closes that disagreement.

For that reason the `2.5.94` compatibility profile intentionally keeps `destructive: {}`. This does **not** mean the reboot model is absent; it means the project refuses to guess the side-effecting transport for a destructive command.

See [MF885 2.5.94 static analysis](MF885_2.5.94_STATIC_ANALYSIS.md) for the evidence and confidence split.

**Status:** deeply statically analysed and partially live-tested; read mappings are supported, power-model semantics are firmware-confirmed, destructive trigger transport remains deliberately unadvertised until independently verified.

### MF855 / MF885 family — firmware 2.5.96

This is the other deeply analysed image.

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
- **firmware-confirmed semantics** — the model/payload meaning is established statically, but the exact side-effecting transport may still be unverified.
- **likely** — evidence suggests compatibility, but it has not been demonstrated.
- **unknown** — no reliable evidence.

## Important differences to expect

Firmware may differ in:

- XML model names and field casing;
- numeric enum values;
- callback direction (`GET` versus `SET`) for command-like models;
- reboot/power-off trigger transport;
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
3. A write control is enabled only when the active firmware profile contains a confirmed mapping **including its trigger transport**.
4. Destructive actions are never inferred from neighbouring field names or from another firmware's callback layout.
5. Ordinary writes are verified by a control read when possible.
6. For reboot/shutdown, a dropped connection can be expected after a valid trigger, but connection loss alone is not proof that an unverified request shape is correct.

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
