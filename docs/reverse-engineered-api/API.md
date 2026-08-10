# Reverse-engineered XML API reference

Base address used by factory configuration:

```text
http://192.168.21.1
```

Physical request endpoint:

```text
/xml_action.cgi
```

This transport path is not the URI used to calculate HTTP Digest authentication.
For XML API requests, HA2 is calculated with `/cgi/xml_action.cgi`, and the Digest
Authorization header contains `uri="/cgi/xml_action.cgi"`, even though the HTTP
request itself targets `/xml_action.cgi`.

The API is XML-over-HTTP and behaves more like a firmware RPC/data-model interface than REST.

## Transport forms

The common model reads/writes are:

```text
GET  /xml_action.cgi?method=get&module=duster&file=<model>
POST /xml_action.cgi?method=set&module=duster&file=<model>
```

Additional forms seen in the vendor UI/firmware include:

```text
GET /xml_action.cgi?method=get&file=<model>
GET /xml_action.cgi?method=get&file=<model>&command=<command>
GET /xml_action.cgi?Action=GetInfo&Id=<id>
GET /xml_action.cgi?Action=BackupFwStart
GET /xml_action.cgi?Action=BackupFw
```

Firmware/configuration upload uses multipart POST actions rather than a normal XML model write.

For authentication, see [AUTHENTICATION.md](AUTHENTICATION.md).

For exact MF885 2.5.94 native-analysis provenance and the power-command confidence split, see [MF885_2.5.94_STATIC_ANALYSIS.md](MF885_2.5.94_STATIC_ANALYSIS.md).

---

## `status1`

**Purpose:** primary router status snapshot.  
**Access:** read.  
**Risk:** sensitive — includes device/SIM identifiers and, on analysed firmware, Wi-Fi-related configuration fields.  
**Confidence:** firmware-confirmed; used by this project.  
**Provenance:** `xml-schema`, `web-ui-js`, `project-client`.

Typical request:

```http
GET /xml_action.cgi?method=get&module=duster&file=status1
```

Important field groups include:

- `RGW/sysinfo/*` — hardware/model/firmware information;
- `RGW/batteryinfo/*` — battery percentage/status/charger state;
- `RGW/wan/*` — registration, IP and cellular state;
- `RGW/WanStatistics/*` — mobile WAN byte counters;
- Wi-Fi/router state and device identifiers.

Common fields observed/used:

```text
RGW/sysinfo/hardware_version
RGW/sysinfo/device_name
RGW/sysinfo/version_num
RGW/sysinfo/version_date
RGW/sysinfo/model_name
RGW/batteryinfo/Battery_percent
RGW/batteryinfo/Battery_status
RGW/batteryinfo/Charger_status
RGW/wan/NW_register_status
RGW/wan/ip
RGW/wan/ConnType
RGW/wan/proto
```

**Quirk:** values can be empty, `NA`, firmware-specific numeric enums, or stale during modem transitions. Never assume one firmware's enum mapping applies to another.

---

## `wan`

**Purpose:** cellular WAN state/configuration.  
**Access:** read; writes are firmware/profile-specific.  
**Confidence:** firmware-confirmed for reads on analysed builds; write mappings are intentionally not advertised by this project until verified.  
**Provenance:** `xml-schema`, `project-client`.

Fields worth capturing include:

```text
connect_disconnect
connect_mode
NW_mode
prefer_mode
prefer_lte_type
pdp_enable
connect_action
disconnect_action
pdp_action
manual_network
network_select
apn
pdp_type
username
auth_type
```

The current application normalises several vendor aliases for APN, PDP, registration, roaming, IP, gateway, DNS and LTE radio information. Unknown enum values remain raw rather than being guessed.

### Observed Auto APN quirk

On a live MF885, the router was registered on LTE with good signal and an operator name, while PDP remained `connecting` and IPv4 fields stayed `NA`. Toggling **Auto APN off and back on** restored the data session. The exact firmware-side cause has not been proven; document this as an observed recovery action, not a confirmed state-machine explanation.

---

## `Engineer_parameter`

**Purpose:** cellular engineering telemetry for GSM/UMTS/LTE.  
**Access:** read.  
**Risk:** low-to-sensitive depending on identifiers.  
**Confidence:** firmware-confirmed.  
**Provenance:** `xml-schema`, `web-ui-js`, `project-client`.

The analysed schemas expose a large engineering field set. Examples include:

```text
RGW/Engi/Dev/vendor
RGW/Engi/Dev/model
RGW/Engi/Dev/fw_ver
RGW/Engi/GSM/rxSigLevel
RGW/Engi/GSM/mcc
RGW/Engi/GSM/mnc
RGW/Engi/GSM/lac
RGW/Engi/GSM/ci
RGW/Engi/GSM/arfcn
```

LTE-capable builds also expose values used to derive/display band, EARFCN, PCI, cell ID, TAC, RSRP, RSRQ, SINR/CQI and throughput-related engineering information.

---

## `message`

**Purpose:** SMS list/read/send/delete/settings.  
**Access:** read/write/command.  
**Risk:** sensitive.  
**Confidence:** live-tested / firmware-confirmed.  
**Provenance:** `web-ui-js`, `xml-schema`, `project-client`, `live-device`.

Read inbox page:

```xml
<?xml version="1.0" encoding="US-ASCII"?>
<RGW>
  <message>
    <flag>
      <message_flag>GET_RCV_SMS_LOCAL</message_flag>
    </flag>
    <get_message>
      <page_number>1</page_number>
    </get_message>
  </message>
</RGW>
```

Send SMS:

```xml
<?xml version="1.0" encoding="US-ASCII"?>
<RGW>
  <message>
    <flag>
      <message_flag>SEND_SMS</message_flag>
      <sms_cmd>4</sms_cmd>
    </flag>
    <send_save_message>
      <contacts>+10000000000</contacts>
      <content>00480065006C006C006F</content>
      <encode_type>UNICODE</encode_type>
      <sms_time>26,8,7,12,0,0,+5</sms_time>
    </send_save_message>
  </message>
</RGW>
```

`content` is represented as UTF-16BE hexadecimal by the analysed UI/API path.

Relevant schema fields include:

```text
RGW/message/flag/message_flag
RGW/message/flag/sms_cmd
RGW/message/flag/sms_cmd_status_result
RGW/message/get_message/message_list
RGW/message/get_message/page_number
RGW/message/set_message/read_message_id
RGW/message/set_message/delete_message_id
RGW/message/send_save_message/contacts
RGW/message/send_save_message/content
RGW/message/send_save_message/encode_type
RGW/message/send_save_message/sms_time
```

**Quirk:** some firmware reports a value named `total_number` that can behave like a page count rather than an SMS count. The project therefore guards against empty/repeated pages and deduplicates messages.

---

## `statistics` / `WanStatistics`

**Purpose:** WAN traffic counters and reset workflow.  
**Access:** read/write-command.  
**Risk:** reset is destructive to counters.  
**Confidence:** live-tested in the project for read/reset variants.  
**Provenance:** `xml-schema`, `web-ui-js`, `project-client`, `live-device`.

Important byte totals:

```text
tx_byte_all
rx_byte_all
```

The project interprets:

```text
download = rx_byte_all
upload   = tx_byte_all
total    = download + upload
```

Do not mix these WAN totals with per-device/LAN/WLAN/billing-period counters.

Known firmware variants use more than one reset mechanism; a successful POST alone should not be treated as proof. Read back the counters after reset.

---

## `admin`

**Purpose:** management settings/account configuration.  
**Access:** read/write.  
**Risk:** critical secrets.  
**Confidence:** firmware-confirmed.  
**Provenance:** `xml-schema`, `web-ui-js`.

The analysed schema includes fields such as:

```text
RGW/management/router_user_list
RGW/management/router_username
RGW/management/router_password
RGW/management/httpd_port
RGW/management/web_wlan_enable
RGW/management/web_wan_enable
RGW/management/session_timeout
```

Do not log responses from this model in public issue reports.

---

## `config_save`

**Purpose:** configuration export data model.  
**Access:** read/export.  
**Risk:** **critical secrets**.  
**Confidence:** firmware-confirmed.  
**Provenance:** `xml-schema`, `web-ui-js`.

The analysed schemas contain a large set of configuration fields and may include:

- administrator credentials;
- Wi-Fi keys;
- APN/DDNS credentials;
- LAN/DHCP configuration;
- firewall/NAT/routes;
- device lists;
- device-access related state.

Treat configuration backups as secrets.

---

## `reset`

**Purpose:** restart/reboot.  
**Access:** destructive command model.  
**Risk:** connection-dropping.  
**Confidence:** model/tree semantics are firmware-confirmed on the exact MF885 2.5.94 image; exact side-effecting transport is not yet independently confirmed for that build. The project profile contains a separately confirmed 2.5.96 destructive mapping.  
**Provenance:** `xml-schema`, `native-handler`, `project-client`.

Analysed tree:

```xml
<RGW><reboot/></RGW>
```

`reset` is the **firmware model name for reboot**. It is not the factory-reset operation. Factory defaults are represented by the separate `restore_defaults` model.

For exact 2.5.94, preserved static evidence disagrees on the trigger transport: older analysis identifies power models as command-on-read (`GET ...&file=reset`), while the generic model inventory lists normal Duster GET/SET forms and the current project client uses POST/SET for the confirmed 2.5.96 profile. Until a stock packet capture or exact callback-direction proof closes that gap, the 2.5.94 compatibility profile intentionally leaves destructive actions disabled.

The connection may disappear before an HTTP response is received after a valid trigger. Do not blindly retry, and do not treat connection loss from an unverified request shape as proof of success.

---

## `restore_defaults`

**Purpose:** restore factory defaults.  
**Risk:** destructive configuration reset.  
**Confidence:** separate model/schema is firmware-confirmed.  
**Provenance:** `xml-schema`, `web-ui-js`, `native-handler`.

This model is deliberately documented separately from `reset`:

```text
reset             -> reboot semantics
restore_defaults  -> factory-default semantics
```

Never substitute one for the other.

---

## Power-off / shutdown

The analysed firmware family contains a `poweroff` model with this tree:

```xml
<RGW><shutdown/></RGW>
```

On exact MF885 2.5.94 the model/schema and shutdown semantics have strong static evidence, but the exact side-effecting GET/SET transport has the same unresolved confidence gap described for `reset`. Therefore 2.5.94 does not currently advertise `poweroff` in its destructive compatibility profile.

The project compatibility profile for 2.5.96 contains a separately confirmed destructive `poweroff` mapping with a `shutdown` tree. Variants such as `trueshutdown` remain unadvertised because their practical distinction is not sufficiently established.

**Rule:** never probe guessed shutdown field values or copy a destructive trigger transport across firmware versions without evidence.

---

## `upgrade_firmware`

**Purpose:** firmware version/update/backup progress state.  
**Access:** read; firmware upload is a separate multipart action.  
**Risk:** high.  
**Confidence:** firmware-confirmed.  
**Provenance:** `xml-schema`, `web-ui-js`, `native-handler`.

Known status fields include firmware-backup state such as:

```text
backup_status
backup_progress
backup_fail_cause
```

---

## Firmware backup actions

Start:

```http
GET /xml_action.cgi?Action=BackupFwStart
```

Download prepared backup:

```http
GET /xml_action.cgi?Action=BackupFw
```

**Risk:** sensitive download / high device load.  
**Confidence:** firmware-confirmed; exact contents of a live backup should be analysed per device.  

Static analysis shows `Action=BackupFw` in an allowlist before the ordinary session gate. This does **not** prove that every request succeeds unauthenticated: downstream handlers can enforce additional checks.

---

## Firmware upload

Vendor UI path observed:

```text
POST multipart /xml_action.cgi?Action=Upload&file=upgrade&command=
```

This is destructive and outside the normal XML-model POST pattern.

---

## Configuration restore

Vendor UI path observed:

```text
POST multipart /xml_action.cgi?Action=Upload&file=backfile&config_backup=
```

Treat restore input as untrusted and device-specific. Keep a recovery path before experimenting.

---

## `debugmodeon`

**Purpose:** hidden engineering/debug mode.  
**Access:** command-like XML model.  
**Risk:** security-sensitive.  
**Confidence:** firmware-confirmed, effect partially understood.  
**Provenance:** `xml-schema`, `native-handler`, `binary-strings`.

Contract found in firmware:

```xml
<RGW>
  <debugon>
    <openmode/>
  </debugon>
</RGW>
```

Native-handler analysis shows that invoking this model switches an internal modem/USB state machine to **mode 8**. Nearby control-flow/string evidence ties this path to Duster/AT-command/USB handling. The exact USB interfaces/descriptors exposed by mode 8 still require a before/after measurement on a live MF885.

The model appears in a pre-session allowlist in the analysed firmware. That is not a guarantee that every firmware accepts every request without authentication.

---

## `control_telnet`

**Purpose:** persistent Telnet-enable flag/contract.  
**Access:** schema supports control; actual daemon availability is firmware-dependent.  
**Risk:** security-sensitive.  
**Confidence:** schema-only to firmware-confirmed for the flag; Telnet service itself is **not proven** on the analysed stock builds.  
**Provenance:** `xml-schema`, configuration export, project experimental module.

Contract:

```xml
<RGW>
  <control_telnet>
    <enable_telnet/>
  </control_telnet>
</RGW>
```

The project intentionally refuses to advertise Telnet control unless a firmware compatibility profile supplies a confirmed model, field, values and port, followed by read-back/port verification.

Static analysis did not identify clear `telnetd`, BusyBox, Dropbear or `/bin/sh` strings. If a port appears, expect a vendor/engineering CLI rather than a Linux shell unless proven otherwise.

---

## `diagnostic`

An XML schema exists with fields resembling:

```xml
<diagnostic>
  <command/>
  <arg/>
  <output/>
</diagnostic>
```

Stock handler availability is firmware-specific. Static analysis of the 2.5.96 model-registration entry found the handler slots to be zero. Exact 2.5.94 descriptor work likewise demonstrates why schema presence cannot be treated as proof of a callable arbitrary-command backend. Community research builds that attach their own diagnostic callback are separate from stock firmware capability.

---

## CWMP / TR-069

The firmware contains CWMP/TR-069 remote-management support including ACS settings, connection-request support, periodic Inform, STUN/TR-111-related functionality and firmware download paths.

CWMP is a remote management protocol, **not a shell**. It can nevertheless have broad management privileges. Do not expose or publish ACS credentials.

See [RESEARCH_NOTES.md](RESEARCH_NOTES.md) for firmware-signature/download observations.

---

## Pre-session allowlist observed in 2.5.96

Static analysis found the following strings excluded from the ordinary session gate:

```text
Action=GetInfo
file=locale
file=debugmodeon
file=sdenable
file=alert0
file=alert2
file=alert3
Action=BackupFw
```

Interpretation: these routes bypass the **generic** session check. Individual handlers may still reject a request, require state, or perform their own validation.

---

## API design guidance for client authors

1. Authenticate once, but be prepared to reacquire a Digest challenge on `401`.
2. Keep nonce-count handling correct.
3. Never infer enum labels for unknown firmware.
4. For normal writes: `POST -> GET -> verify`.
5. For command-like models, distinguish **payload semantics** from **side-effecting transport**.
6. For restart/shutdown: connection loss may itself be expected after a confirmed trigger; do not retry blindly.
7. Treat `status1`, `admin`, `config_save`, SIM identifiers and backups as sensitive.
8. Do not probe unknown write values merely because a schema exists.
9. Record provenance and confidence when adding a newly discovered model.
