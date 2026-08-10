# ZMI MF855 / MF885 reverse-engineered API

This directory documents the **unofficial local XML API** used by ZMI MF855/MF885-family mobile routers. The material is based on a combination of:

- live requests exercised by this project;
- JavaScript from the vendor web UI;
- XML model/schema files extracted from firmware;
- static analysis of native firmware handlers;
- observed device behaviour.

It is **not vendor documentation**. Firmware revisions differ, and the presence of an XML model does not prove that a working backend handler exists.

## Start here

- [API reference](API.md) — transport, important models, commands, fields and quirks.
- [Authentication](AUTHENTICATION.md) — the router's unusual HTTP Digest flow.
- [Firmware compatibility](FIRMWARE_COMPATIBILITY.md) — what is known for MF855/MF885 and firmware 2.5.94/2.5.96.
- [MF885 2.5.94 static analysis](MF885_2.5.94_STATIC_ANALYSIS.md) — clean-image hashes, ZIMI/OSLO/WEBI findings and the firmware-specific reboot verdict.
- [Research notes](RESEARCH_NOTES.md) — debug mode, Telnet, firmware backup, CWMP/TR-069 and other reverse-engineering findings.
- [`api/mf885-api.yaml`](api/mf885-api.yaml) — machine-readable, commented specification intended for humans and coding agents.

## Confidence and provenance

Every documented capability should be interpreted using two separate labels.

### Confidence

- **live-tested** — observed on a real router.
- **firmware-confirmed** — implementation or use is confirmed for a named firmware image, but not necessarily exercised on a live device during the same analysis pass.
- **frontend-confirmed** — the vendor web UI actively calls it.
- **schema-only** — an XML contract exists, but an active backend handler is not confirmed.
- **speculative** — hypothesis from static evidence; do not rely on it operationally.

### Provenance

Typical provenance values are:

- `live-device`
- `project-client`
- `web-ui-js`
- `xml-schema`
- `native-handler`
- `binary-strings`

A model can have several provenance values.

## Safety rules used by this project

The router API is not RESTful and frequently returns HTTP success even when an operation is ignored or only queued. For writes, prefer **write -> read-back -> verify** rather than trusting the POST response.

Destructive or security-sensitive operations include restart, shutdown, traffic reset, firmware/configuration backup, firmware upload, debug mode, Telnet control and CWMP/TR-069 settings. Do not probe unknown write values on a device you cannot recover.

Restart/shutdown are special: the command itself can make HTTP disappear. Submit a confirmed destructive mapping once and do not blindly replay it after a 401, timeout or connection drop.

## Sensitive data

Some models can expose administrator passwords, Wi-Fi keys, APN credentials, IMEI/ICCID/MSISDN, TR-069 credentials and other device-specific secrets. Public examples in this directory intentionally use placeholders. Never paste real configuration exports or Digest values into issues.

## Scope

Firmware **2.5.96** remains the broadest general API-inventory image, with roughly 120 model names and 1,540 leaf fields identified from the extracted web/API material.

Firmware **MF885 2.5.94** now also has a clean, firmware-specific static-analysis baseline (`BackupFw` SHA-256 `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`, raw OSLO SHA-256 `d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c`). Its WEBI XML/JavaScript contracts have been compared directly with 2.5.96, while native addresses and enum values remain scoped to their named firmware profile.

Unknown models are not promoted to "supported" merely because their schema exists.
