# Reverse-engineered XML API reference

Base address used by factory configuration:

```text
http://192.168.21.1
```

Main endpoint:

```text
/cgi/xml_action.cgi
```

The API is XML-over-HTTP and behaves more like a firmware RPC/data-model interface than REST.

## Transport forms

The common model reads/writes are:

```text
GET  /cgi/xml_action.cgi?method=get&module=duster&file=<model>
POST /cgi/xml_action.cgi?method=set&module=duster&file=<model>
```

Additional forms seen in the vendor UI/firmware include:

```text
GET /cgi/xml_action.cgi?method=get&file=<model>
GET /cgi/xml_action.cgi?method=get&file=<model>&command=<command>
GET /cgi/xml_action.cgi?Action=GetInfo&Id=<id>
GET /cgi/xml_action.cgi?Action=BackupFwStart
GET /cgi/xml_action.cgi?Action=BackupFw
```

Firmware/configuration upload uses multipart POST actions rather than a normal XML model write.

For authentication, see [AUTHENTICATION.md](AUTHENTICATION.md).

---

## `status1`

**Purpose:** primary router status snapshot.  
**Access:** read.  
**Risk:** sensitive — includes device/SIM identifiers and, on analysed firmware, Wi-Fi-related configuration fields.  
**Confidence:** firmware-confirmed; used by this project.  
**Provenance:** `xml-schema`, `web-ui-js`, `project-client`.

Typical request:

```http
GET /cgi/xml_action.cgi?method=get&module=duster&file=status1
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
**Confidence:** firmware-confirmed for reads on 2.5.96; write mappings are intentionally not advertised by this project until verified.  
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

The 2.5.96 schema exposes more than 100 leaf fields. Examples include:

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

The 2.5.96 schema contains roughly 147 leaf fields and may include:

- administrator credentials;
- Wi-Fi keys;
- APN/DDNS credentials;
- LAN/DHCP configuration;
- firewall/NAT/routes;
- device lists;
- Telnet-related persistent state.

Treat configuration backups as secrets.

---

## `reset`

**Purpose:** restart/reboot.  
**Access:** write-command.  
**Risk:** destructive/connection-dropping.  
**Confidence:** firmware-confirmed; project profile contains a confirmed 2.5.96 mapping.  
**Provenance:** `native-handler`, `project-client`.

Analysed tree:

```xml
<RGW><reboot>...</reboot></RGW>
```

The connection may disappear before an HTTP response is received. Do not blindly retry.

---

## Power-off / shutdown

Power control varies by firmware. The project compatibility profile for 2.5.96 contains a confirmed destructive `poweroff` mapping with a `shutdown` tree, while intentionally omitting unconfirmed variants such as `trueshutdown`.

**Rule:** never probe guessed shutdown field values.

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
GET /cgi/xml_action.cgi?Action=BackupFwStart
```

Download prepared backup:

```http
GET /cgi/xml_action.cgi?Action=BackupFw
```

**Risk:** sensitive download / high device load.  
**Confidence:** firmware-confirmed; exact contents of a live backup should be analysed per device.  

Static analysis shows `Action=BackupFw` in an allowlist before the ordinary session gate. This does **not** prove that every request succeeds unauthenticated: downstream handlers can enforce additional checks.

---

## Firmware upload

Vendor UI path observed:

```text
POST multipart /cgi/xml_action.cgi?Action=Upload&file=upgrade&command=
```

This is destructive and outside the normal XML-model POST pattern.

---

## Configuration restore

Vendor UI path observed:

```text
POST multipart /cgi/xml_action.cgi?Action=Upload&file=backfile&config_backup=
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
**Confidence:** schema-only to firmware-confirmed for the flag; Telnet service itself is **not proven** on 2.5.96.  
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

However, static analysis of the 2.5.96 model-registration entry found the handler slots to be zero. Therefore this is documented as **schema-only / inactive in the analysed build**, not as an arbitrary command-execution API.

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
5. For restart/shutdown: connection loss may itself be expected; do not retry blindly.
6. Treat `status1`, `admin`, `config_save`, SIM identifiers and backups as sensitive.
7. Do not probe unknown write values merely because a schema exists.
8. Record provenance and confidence when adding a newly discovered model.
