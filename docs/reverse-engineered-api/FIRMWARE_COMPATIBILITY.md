# Firmware compatibility

The MF855/MF885 family shares substantial web/API code, but hardware revision and firmware build matter. This document separates firmware semantics, client request shape and live-tested behaviour.

## Known models / firmware

### MF885 — firmware 2.5.94

This build has been analysed on a live MF885, from an exact stock BackupFw image, and against a period-relevant ZMI Android companion client that explicitly supports MF885 / MF96 Ver.D.

Static firmware baseline:

- BackupFw size: `8,323,644` bytes;
- BackupFw SHA-256: `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- decompressed OSLO size: `9,648,064` bytes (`0x9337c0`);
- decompressed OSLO SHA-256: `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c`;
- WEBI has the same 320 paths as the analysed 2.5.96 image, with 319/320 files byte-identical;
- GRBI, WIFI, WCAL and RFBN are byte-identical between the analysed 2.5.94 and 2.5.96 images;
- raw OSLO is not byte-identical, so native offsets/callbacks remain firmware-specific.

Live evidence includes local management at `192.168.21.1`, the working Digest/XML flow, and confirmed `status1`, `wan`, and `Engineer_parameter` fixtures.

#### Power models and semantics

Stock WEBI contains:

```xml
<!-- reset.xml -->
<RGW><reboot/></RGW>

<!-- poweroff.xml -->
<RGW><shutdown/></RGW>
```

The firmware distinguishes:

```text
reset             -> reboot/restart
poweroff          -> power off/shutdown
restore_defaults  -> factory reset
```

`trueshutdown` exists in the wider firmware family but remains unadvertised because its distinct practical semantics are unresolved.

#### Power trigger transport — resolved by Android client

Reverse engineering `ZMI_MiFi_1.2.42_english.apk` (`com.xiaomi.mifi`) closes the earlier GET/SET ambiguity. The APK explicitly recognises `MF885` and `MF96 Ver.D` and its `HttpBasedRouterApi` uses these one-shot requests:

```http
GET /xml_action.cgi?method=get&module=duster&file=reset
GET /xml_action.cgi?method=get&module=duster&file=poweroff
GET /xml_action.cgi?method=get&module=duster&file=restore_defaults
```

No XML request body is supplied by those methods.

The reboot UI call chain then waits for the router/host to return rather than submitting another reboot request. The shutdown UI requires confirmation before the `poweroff` GET.

The supplied English APK is repacked and test-key-signed, so it is recorded as companion-client code evidence rather than a cryptographically verified original store APK. The relevant implementation is in `classes.dex` and contains the expected ZMI package, local-router classes and MF885/MF96 Ver.D mappings.

See [Power clients](POWER_CLIENTS.md) for the DEX call chains and provenance.

#### Runtime support status

The evidence gap is now closed, but the current project implementation still assumes destructive commands are POST/SET operations carrying an XML tree. For that reason the current `2.5.94` compatibility profile should remain destructive-disabled until the client can encode the transport explicitly.

This status means:

```text
power request shape known        yes
safe request shape documented    yes
current runtime can express it   not yet
live exact-device execution      separate validation step
```

The future profile should express at least `method`, `file`, and whether a body exists instead of assuming every destructive model is POST.

**Status:** deeply statically analysed, partially live-tested, and companion-client power transport confirmed as GET/no-body. Runtime enablement remains pending transport-aware implementation and exact-device validation.

### MF855 / MF885 family — firmware 2.5.96

This is the other deeply analysed image.

Confirmed static properties include:

- `Marvell_FBF` container;
- Nucleus PLUS monolithic runtime rather than Linux userspace;
- extracted vendor web interface/XML models;
- roughly 118 XML schemas, ~120 model names and ~1,540 leaf fields in the generated inventory;
- product mapping including Ver.D / MF885;
- working Digest/XML flow;
- `status1`, `wan`, `Engineer_parameter`, `message`, statistics, management, firmware and other models.

The project currently contains 2.5.96 destructive mappings based on the project's prior evidence. Those mappings must not be used to infer the 2.5.94 request method; the companion APK demonstrates why transport belongs in firmware/profile data.

## Compatibility terminology

Use these words precisely:

- **tested** — exercised on a real router and the result was observed;
- **present in firmware** — schema, frontend use or native implementation is found statically;
- **firmware-confirmed semantics** — model/payload meaning established from firmware;
- **companion-app-confirmed transport** — a relevant stock-family application implementation contains the concrete request method/path;
- **frontend-confirmed** — firmware-resident WebUI actively calls the operation;
- **likely** — evidence suggests compatibility but has not been demonstrated;
- **unknown** — no reliable evidence.

These labels can coexist. For example, MF885 2.5.94 reboot currently has firmware-confirmed semantics and companion-app-confirmed GET transport, while a live execution result is a separate evidence level.

## Important differences to expect

Firmware may differ in:

- XML model names/field casing;
- numeric enums;
- callback direction (`GET` versus `SET`) for command models;
- reboot/power-off trigger transport;
- statistics reset;
- APN/profile behaviour;
- cellular controls;
- Telnet/debug availability;
- backup/update handling;
- session checks/allowlists.

Client code should therefore prefer firmware-specific profiles over broad probing.

## Current project policy

1. Read-only diagnostic discovery may try known model names.
2. Unknown enum values remain raw.
3. A destructive control is enabled only when both semantics and concrete trigger transport can be represented by the active profile/client.
4. Destructive actions are never inferred from neighbouring fields or another firmware's callback layout.
5. Ordinary writes are read back where possible.
6. Restart/shutdown are one-shot operations; do not automatically replay after connection loss.
7. Connection loss alone is not evidence that an unverified request shape was correct.

## Suggested evidence when reporting another firmware

Include only non-secret diagnostics:

- router model/hardware revision;
- firmware version;
- endpoint/model attempted;
- HTTP method;
- XML root/field names where applicable;
- redacted response/raw enum;
- provenance: WebUI, mobile app, packet capture, live client, or static firmware.

Do not publish passwords, Digest responses/nonces, IMEI, ICCID, IMSI, MSISDN, Wi-Fi keys, APN credentials, ACS/TR-069 credentials or configuration backups.

## Profile selection precedence

The application selects exactly one profile in this order: explicit `compatibilityProfileOverride`, detected firmware/model, and configured `compatibilityProfile`. Unknown firmware must not silently inherit destructive operations from another build.

## MF885 2.5.94 read-mapping evidence

The dedicated `2.5.94` profile's read mappings come from simultaneous `status1`, `wan`, and `Engineer_parameter` responses in `tests/fixtures/mf885-2.5.94`: `sys_mode=17` (LTE), SIM `1` (ready), registration `1` (home), roaming `0`, PDP state `1` (connected), PDP type `IP` (IPv4), and `signalbar` 0–5.

Unknown values—including the fixture's deliberately unknown `sys_submode=99`—remain raw rather than borrowing enum meaning from MF855 or 2.5.96.