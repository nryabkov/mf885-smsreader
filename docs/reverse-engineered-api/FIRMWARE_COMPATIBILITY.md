# Firmware compatibility

The MF855/MF885 family shares substantial web/API code, but hardware revision and firmware build matter. This document separates firmware semantics, client request shape and live-tested behaviour.

## Known models / firmware

### MF885 — firmware 2.5.94

This build has been analysed on a live MF885, from an exact stock BackupFw image, and against a period-relevant ZMI Android companion client that explicitly supports MF885 / MF96 Ver.D.

Static firmware baseline:

- BackupFw size: `8,323,644` bytes;
- BackupFw SHA-256: `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- decompressed OSLO size: `9,648,064` bytes;
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

The project runtime is transport-aware for destructive commands. The exact MF885 `2.5.94` profile advertises:

```text
reset:    GET /xml_action.cgi?method=get&module=duster&file=reset
poweroff: GET /xml_action.cgi?method=get&module=duster&file=poweroff
```

with no XML request body. The firmware semantic trees (`reboot` / `shutdown`) remain profile metadata and are not sent by the GET path.

The API helper also fixes the earlier destructive-validation bug: destructive operations no longer require a normal write/read-back `verify` callback before submission. Runtime selection is deliberately narrower than the companion APK's family support:

- the fresh live model must be exactly `LV01` or `MF885`;
- the full firmware string must be exactly `2.5.94_release_MF855_NZ_CP_2.129.003`;
- a reported hardware revision must be Ver.D; a missing revision is accepted only with the firmware's `LV01` product label;
- no configuration flag, cached profile, shortened version, or neighbouring model can override a mismatch;
- the backend repeats the identity read immediately before every power command;
- the destructive GET itself is submitted once, with automatic retry disabled.

This status means:

```text
power request shape known        yes
safe request shape documented    yes
current runtime can express it   yes
2.5.94 profile advertises it     yes
live exact-device execution      separate validation level
```

Restart and Power off are therefore conditionally enabled only for that exact live identity. A live run on the exact router remains a separate behavioural validation step; request-shape evidence is not side-effect evidence.

**Status:** deeply statically analysed, partially live-tested, companion-client power transport confirmed as GET/no-body, and runtime support implemented.

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

Read-only compatibility remains broad, but the project does not enable power controls for `2.5.96`. No `2.5.94` transport is inherited by another build, and no legacy POST/SET power mapping is selected as a fallback.

## Compatibility terminology

Use these words precisely:

- **tested** — exercised on a real router and the result was observed;
- **present in firmware** — schema, frontend use or native implementation is found statically;
- **firmware-confirmed semantics** — model/payload meaning established from firmware;
- **companion-app-confirmed transport** — a relevant stock-family application implementation contains the concrete request method/path;
- **frontend-confirmed** — firmware-resident WebUI actively calls the operation;
- **likely** — evidence suggests compatibility but has not been demonstrated;
- **unknown** — no reliable evidence.

These labels can coexist. MF885 2.5.94 reboot now has firmware-confirmed semantics, companion-app-confirmed GET transport and implemented project support; live execution remains a separate evidence level.

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
3. A destructive control is enabled only when both semantics and concrete trigger transport are confirmed and a fresh live identity exactly selects that profile.
4. Destructive actions are never inferred from neighbouring fields or another firmware's callback layout.
5. Ordinary writes are read back where possible.
6. Restart/shutdown are one-shot operations; do not automatically replay after connection loss.
7. Connection loss alone is not evidence that an unverified request shape was correct.
8. WAN traffic reset remains disabled because its exact write contract is not confirmed.
9. Firmware restore/upload, configuration restore, debug mode, factory reset, and `trueshutdown` remain outside the power profile.

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

There is no precedence chain for destructive power actions. Selection is a single fail-closed predicate over the newest live `status1` response:

```text
(model is LV01 or MF885)
AND (firmware is exactly 2.5.94_release_MF855_NZ_CP_2.129.003)
AND (hardware revision is Ver.D, or is absent only when model is LV01)
```

Only that predicate selects `mf885-ver-d-2.5.94-apk-get-power`. Missing fields, read failure, a changed identity during polling, or any mismatch selects `unavailable`. User configuration and cached detection results are not consulted.

The companion APK also contains MF96 Ver.D mappings, but this project's runtime intentionally does not use those mappings: the implemented profile is scoped to the observed MF885/LV01 target.

For a first live check, use the fixed [read-only preflight](READ_ONLY_PREFLIGHT.md). It does not select or invoke a power, restore, debug, reset, or firmware endpoint.


## MF885 2.5.94 read-mapping evidence

The dedicated `2.5.94` profile's read mappings come from simultaneous `status1`, `wan`, and `Engineer_parameter` responses plus the live firmware WebUI: `sys_mode=17` (LTE), `sim_status=0` (SIM present/ready), registration `1` (home), roaming `0`, `connect_disconnect=cellular` (connected), PDP type `IP` (IPv4), and `signalbar` 0–5.

Unknown values—including the fixture's deliberately unknown `sys_submode=99`—remain raw rather than borrowing enum meaning from MF855 or 2.5.96.
