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
- [Research notes](RESEARCH_NOTES.md) — debug mode, Telnet, firmware backup, CWMP/TR-069 and other reverse-engineering findings.
- [`api/mf885-api.yaml`](api/mf885-api.yaml) — machine-readable, commented specification intended for humans and coding agents.

## Confidence and provenance

Every documented capability should be interpreted using two separate labels.

### Confidence

- **live-tested** — observed on a real router.
- **firmware-confirmed** — implementation or use is confirmed in firmware/web UI, but not necessarily exercised on a live device.
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

## Sensitive data

Some models can expose administrator passwords, Wi-Fi keys, APN credentials, IMEI/ICCID/MSISDN, TR-069 credentials and other device-specific secrets. Public examples in this directory intentionally use placeholders. Never paste real configuration exports or Digest values into issues.

## Scope

The most thoroughly analysed firmware image is **2.5.96**, whose extracted web interface contains 118 XML schemas. A generated inventory identified roughly 120 models and 1,540 leaf fields. This documentation deliberately prioritises models that are useful, referenced by the vendor UI, used by this project, or security-relevant. Unknown models are not promoted to "supported" merely because their schema exists.
