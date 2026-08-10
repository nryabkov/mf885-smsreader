# Reverse-engineered XML API reference

Base address used by factory configuration:

```text
http://192.168.21.1
```

Physical XML request endpoint:

```text
/xml_action.cgi
```

For XML requests the Digest Authorization URI / HA2 input is instead:

```text
/cgi/xml_action.cgi
```

This physical-path/Digest-URI split is confirmed both by the working project client and by reverse engineering the ZMI Android companion client 1.2.42.

The API is XML-over-HTTP and behaves like a firmware RPC/data-model interface rather than REST.

## Transport forms

Ordinary model read:

```http
GET /xml_action.cgi?method=get&module=duster&file=<model>
```

Ordinary model write:

```http
POST /xml_action.cgi?method=set&module=duster&file=<model>
Content-Type: application/xml
```

Some command models are deliberately **command-on-read**: a GET is the side-effecting request and carries no XML body. The ZMI Android 1.2.42 client confirms this pattern for reboot, power-off and restore-defaults on the MF885/MF96 Ver.D product generation.

Additional forms seen in firmware/clients include:

```text
GET /xml_action.cgi?method=get&file=<model>
GET /xml_action.cgi?method=get&file=<model>&command=<command>
GET /xml_action.cgi?Action=GetInfo&Id=<id>
GET /xml_action.cgi?Action=BackupFwStart
GET /xml_action.cgi?Action=BackupFw
```

Firmware/configuration uploads use multipart POST actions rather than normal Duster model writes.

For authentication details see [AUTHENTICATION.md](AUTHENTICATION.md). For the exact MF885 2.5.94 firmware baseline see [MF885_2.5.94_STATIC_ANALYSIS.md](MF885_2.5.94_STATIC_ANALYSIS.md). For recovered power call chains see [POWER_CLIENTS.md](POWER_CLIENTS.md).

---

## Evidence labels

- **live-tested** — operation/result observed on hardware;
- **firmware-confirmed** — implementation/semantics established from firmware;
- **frontend-confirmed** — firmware-resident WebUI actively calls it;
- **companion-app-confirmed** — relevant ZMI companion application contains the concrete request implementation;
- **schema-only** — XML contract exists but use/handler is not established.

Semantics, request transport and live side effect are separate claims.

---

## `status1`

**Purpose:** primary router status snapshot.  
**Access:** read.  
**Risk:** sensitive.  
**Confidence:** firmware-confirmed / used by project and companion client.  
**Provenance:** `xml-schema`, `web-ui-js`, `project-client`, `android-apk`.

```http
GET /xml_action.cgi?method=get&module=duster&file=status1
```

Important groups include:

```text
RGW/sysinfo/*
RGW/batteryinfo/*
RGW/wan/*
RGW/WanStatistics/*
```

Common fields:

```text
hardware_version
device_name
version_num
version_date
model_name
Battery_percent
Battery_status
Charger_status
NW_register_status
ip
ConnType
proto
```

Values can be empty, `NA`, stale during transitions, or firmware-specific numeric enums.

---

## `wan`

**Purpose:** cellular WAN state/configuration.  
**Access:** GET read; POST/SET for confirmed settings.  
**Confidence:** firmware-confirmed; companion APK contains both read and set routes.  

Relevant leaves include:

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

Never reuse numeric enum meaning across firmware without evidence.

---

## `Engineer_parameter`

**Purpose:** GSM/UMTS/LTE engineering telemetry.  
**Access:** read.  
**Confidence:** firmware-confirmed.  

The schema exposes radio values used for band/EARFCN/PCI/cell/TAC/RSRP/RSRQ/SINR/CQI and related diagnostics.

---

## `message`

**Purpose:** SMS list/read/send/delete/settings.  
**Access:** POST command model.  
**Confidence:** live-tested / firmware-confirmed / companion-client-confirmed.  

The analysed clients use command selectors such as:

```text
GET_RCV_SMS_LOCAL
SEND_SMS      sms_cmd=4
DELETE_SMS    sms_cmd=6
```

Message content on the analysed path is represented as UTF-16BE hexadecimal.

Example send tree:

```xml
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

SMS pagination fields can behave inconsistently across builds; deduplicate and guard against repeated/empty pages.

---

## `statistics` / `WanStatistics`

**Purpose:** WAN traffic counters and reset workflows.  
**Access:** read/write-command depending on operation.  
**Confidence:** live-tested for project-supported variants.  

Important WAN byte totals:

```text
tx_byte_all   upload
rx_byte_all   download
```

Do not mix these with LAN/WLAN, per-device or billing-period counters.

Statistics reset is unrelated to the `reset` reboot model.

---

## `admin`

**Purpose:** management/account configuration.  
**Access:** read/write.  
**Risk:** critical secrets.  

Known fields include administrator credentials, HTTP-management settings and session timeout. Never publish unredacted responses.

---

## Reboot: `reset`

**Purpose:** restart/reboot router.  
**Risk:** destructive / connection-dropping.  
**Semantic confidence on MF885 2.5.94:** firmware-confirmed.  
**Trigger confidence:** companion-app-confirmed by ZMI Android 1.2.42.  
**Provenance:** `xml-schema`, `native-handler`, `android-apk`.

Firmware WEBI tree:

```xml
<RGW><reboot/></RGW>
```

The tree documents model semantics. The recovered Android client does **not** POST that XML to trigger reboot. It issues:

```http
GET /xml_action.cgi?method=get&module=duster&file=reset
```

Request body:

```text
none
```

Recovered logical chain:

```text
RouterRebootActivity
 -> RouterManager
 -> RouterApi
 -> HttpBasedRouterApi
 -> GET file=reset
```

After submission the app waits/polls for the router to return. Do not automatically retry the destructive GET after connection loss.

`reset` is **not factory reset**.

---

## Power off: `poweroff`

**Purpose:** normal router shutdown/power-off.  
**Risk:** destructive / connection-dropping.  
**Semantic confidence on MF885 2.5.94:** firmware-confirmed / strong static evidence.  
**Trigger confidence:** companion-app-confirmed by ZMI Android 1.2.42.  

Firmware WEBI tree:

```xml
<RGW><shutdown/></RGW>
```

Recovered client trigger:

```http
GET /xml_action.cgi?method=get&module=duster&file=poweroff
```

Request body:

```text
none
```

Recovered chain:

```text
RouterShutdownActivity
 -> confirmation dialog
 -> RouterManager
 -> RouterApi
 -> HttpBasedRouterApi
 -> GET file=poweroff
```

The normal shutdown UI uses `poweroff`; no recovered path here uses `trueshutdown`.

Do not automatically replay this command after timeout/connection loss.

---

## Factory reset: `restore_defaults`

**Purpose:** restore factory defaults.  
**Risk:** critical destructive configuration reset.  
**Confidence:** firmware-confirmed semantics + companion-app-confirmed request.  

Recovered client trigger:

```http
GET /xml_action.cgi?method=get&module=duster&file=restore_defaults
```

Request body: none.

The Android client therefore independently establishes this safety-critical distinction:

```text
reset             -> reboot
poweroff          -> power off
restore_defaults  -> factory reset
```

Never substitute `restore_defaults` for `reset`.

---

## `trueshutdown`

A shutdown-related schema/model exists in the firmware family, but its practical distinction from `poweroff` is unresolved. The recovered 1.2.42 shutdown UI does not use it.

**Project status:** unadvertised.

---

## `upgrade_firmware`

**Purpose:** firmware update/backup state.  
**Risk:** high.  
**Confidence:** firmware-confirmed; routes also appear in companion client.  

Known fields include:

```text
backup_status
backup_progress
backup_fail_cause
```

Firmware upload itself uses a separate multipart action.

---

## Firmware backup actions

Start preparation:

```http
GET /xml_action.cgi?Action=BackupFwStart
```

Download prepared backup:

```http
GET /xml_action.cgi?Action=BackupFw
```

Treat firmware/configuration backups as sensitive.

---

## Firmware upload / configuration restore

Firmware upload observed in vendor UI:

```text
POST multipart /xml_action.cgi?Action=Upload&file=upgrade&command=
```

Configuration restore:

```text
POST multipart /xml_action.cgi?Action=Upload&file=backfile&config_backup=
```

Both are destructive/high-risk operations.

---

## `debugmodeon`

Firmware contains:

```xml
<RGW><debugon><openmode/></debugon></RGW>
```

Native analysis ties this path to a real engineering/modem/USB state transition. Exact externally exposed interfaces remain firmware/hardware-specific.

---

## `control_telnet`

Firmware/configuration contains:

```xml
<RGW><control_telnet><enable_telnet/></control_telnet></RGW>
```

Field presence is not proof of a listening Telnet daemon or Unix shell. The project requires firmware-specific values and verification before exposing control.

---

## `diagnostic`

A diagnostic-looking schema exists, but schema presence must not be described as arbitrary command execution. Handler availability differs by build and requires native callback evidence.

---

## Android companion client evidence

The analysed artifact is:

```text
package     com.xiaomi.mifi
version     1.2.42
APK SHA-256 66547e5a9423c380845ad4d49e069009c6623e0c36956fd1cabd2fe1df22f8ca
classes.dex SHA-256 5d679764de58c25d8866068108a01361d0571a0e2e05ad8a55f23ca1b1516eba
```

Its DEX explicitly recognises MF885 and `MF96 Ver.D`. The supplied English APK is repacked/test-key-signed, so it is documented as code evidence rather than a cryptographically verified original-store binary.

Power calls are implemented in the Java/DEX `HttpBasedRouterApi` layer, not hidden in the included native libraries.

The same DEX contains normal POST/SET routes for settings such as `wan`, `admin`, `message`, etc. That contrast is why the literal GET used for `reset`, `poweroff`, and `restore_defaults` is meaningful rather than an artefact of a generic helper.

---

## Client design guidance

1. Keep `/xml_action.cgi` (physical request) separate from `/cgi/xml_action.cgi` (Digest URI/HA2).
2. Treat semantics, transport and live side effect as distinct evidence levels.
3. For normal writes use POST/SET and verify by read-back where possible.
4. For MF885 2.5.94 reboot/poweroff/restore-defaults, the recovered companion client uses GET `method=get` with **no XML request body**.
5. Never blindly retry reboot/shutdown after connection loss or an ambiguous authentication failure.
6. Keep `restore_defaults` completely separate from reboot.
7. Do not expose `trueshutdown` merely because its schema exists.
8. Keep firmware enum mappings scoped to the exact build.
9. Redact credentials, Digest material and device identifiers from diagnostics.

## Runtime note for this project

The current Scriptable destructive helper assumes POST/SET plus an XML tree. That abstraction cannot directly represent the APK-confirmed MF885 2.5.94 power requests. Runtime support should therefore be changed to encode the HTTP method/body explicitly before enabling 2.5.94 Restart/Power off in the compatibility profile.