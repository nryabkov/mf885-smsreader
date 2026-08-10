# ZMI MF855 / MF885 reverse-engineered API

This directory documents the **unofficial local XML API** used by ZMI MF855/MF885-family mobile routers. The material is based on a combination of:

- live requests exercised by this project;
- JavaScript from the vendor web UI;
- XML model/schema files extracted from firmware;
- static analysis of native firmware handlers;
- reverse engineering of ZMI companion-app code;
- observed device behaviour.

It is **not vendor documentation**. Firmware revisions differ, and the presence of an XML model does not prove that a working backend handler exists.

## Start here

- [API reference](API.md) — transport, important models, commands, fields and quirks.
- [Authentication](AUTHENTICATION.md) — the router's unusual HTTP Digest flow.
- [Firmware compatibility](FIRMWARE_COMPATIBILITY.md) — what is known for MF855/MF885 and firmware 2.5.94/2.5.96.
- [MF885 2.5.94 static analysis](MF885_2.5.94_STATIC_ANALYSIS.md) — exact golden-image fingerprints, native Duster findings, firmware comparison, and the evidence status of reboot/shutdown commands.
- [Power clients: stock WebUI and ZMI Android app](POWER_CLIENTS.md) — recovered reboot, power-off and factory-reset call chains, exact GET endpoints, APK provenance and the distinction between firmware semantics and client transport.
- [Research notes](RESEARCH_NOTES.md) — debug mode, Telnet, firmware backup, CWMP/TR-069 and other reverse-engineering findings.
- [`api/mf885-api.yaml`](api/mf885-api.yaml) — machine-readable, commented specification intended for humans and coding agents.

## Confidence and provenance

Every documented capability should be interpreted using separate confidence and provenance labels.

### Confidence

- **live-tested** — observed on a real router;
- **firmware-confirmed** — implementation or semantics are confirmed in firmware;
- **frontend-confirmed** — the firmware-resident WebUI actively calls it;
- **companion-app-confirmed** — a relevant ZMI companion application contains the concrete call/request implementation;
- **schema-only** — an XML contract exists but an active handler/use is not confirmed;
- **speculative** — hypothesis from static evidence; do not rely on it operationally.

For command-like models, **semantics**, **request transport**, and **live side effect** are separate claims. For example, MF885 2.5.94 reboot now has firmware-confirmed semantics and companion-app-confirmed GET transport; live execution on the exact device remains a distinct evidence level.

### Provenance

Typical provenance values are:

- `live-device`
- `project-client`
- `web-ui-js`
- `android-apk`
- `xml-schema`
- `native-handler`
- `binary-strings`

A model can have several provenance values. Repacked/localized APKs must be identified as such rather than described as cryptographically verified store originals.

## Safety rules used by this project

The router API is not RESTful and frequently returns HTTP success even when an operation is ignored or only queued. For ordinary writes, prefer **write -> read-back -> verify** rather than trusting a response.

Destructive or security-sensitive operations include restart, shutdown, factory reset, traffic reset, firmware/configuration backup, firmware upload, debug mode, Telnet control and CWMP/TR-069 settings. Never infer a destructive request shape from an XML schema alone. Restart/shutdown commands are one-shot operations and must not be blindly replayed after connection loss.

## Sensitive data

Some models can expose administrator passwords, Wi-Fi keys, APN credentials, IMEI/ICCID/MSISDN, TR-069 credentials and other device-specific secrets. Public examples intentionally use placeholders. Never paste real configuration exports or Digest values into issues.

## Scope

Two firmware baselines are deeply analysed:

- **MF885 2.5.94** — exact stock BackupFw/raw OSLO fingerprints and native Duster work are recorded in [MF885_2.5.94_STATIC_ANALYSIS.md](MF885_2.5.94_STATIC_ANALYSIS.md); a period-relevant ZMI Android 1.2.42 client additionally confirms GET/no-body power transport for MF885/MF96 Ver.D-family devices;
- **2.5.96 family image** — extracted web interface, XML inventory and native analysis provide the other main compatibility baseline.

The 2.5.94 and 2.5.96 WEBI payloads are almost identical, but raw OSLO is not. Unknown models or transports are not promoted merely because a schema exists.