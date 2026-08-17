# MF885 power controls: stock WebUI and ZMI Android app

This note separates four different claims that are easy to conflate when reverse-engineering MF885 power controls:

1. the XML model/schema shipped in WEBI;
2. the semantic meaning of that model in firmware;
3. the HTTP request shape used by a stock-family client;
4. the observed side effect on a live router.

The first three are established for reboot, power-off and factory reset on the MF885 / MF96 Ver.D generation. Project runtime support is deliberately narrower: reboot and power-off require a fresh exact LV01/MF885 2.5.94 match; live execution on the target device remains a separate evidence level.

## Evidence baseline

Firmware baseline: clean MF885 / MF96 Ver.D 2.5.94 image documented in `MF885_2.5.94_STATIC_ANALYSIS.md`.

```text
BackupFw SHA-256  2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531
raw OSLO SHA-256 d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c
```

Android evidence analysed for this note:

```text
file        ZMI_MiFi_1.2.42_english.apk
package     com.xiaomi.mifi
version     1.2.42
APK SHA-256 66547e5a9423c380845ad4d49e069009c6623e0c36956fd1cabd2fe1df22f8ca
APK SHA-1   1529ba86cacc907b53d98092381dd4d1efedd6bd
classes.dex SHA-256 5d679764de58c25d8866068108a01361d0571a0e2e05ad8a55f23ca1b1516eba
```

The APK files are dated December 2016, placing this client in the same product generation as MF885 2.5.94.

### APK provenance caveat

The supplied English APK is not signed with the original ZMI production certificate. Its `META-INF/CERT.RSA` is the standard Android/AOSP test key:

```text
certificate SHA-1
61:ED:37:7E:85:D3:86:A8:DF:EE:6B:86:4B:D8:5B:0B:FA:A5:AF:81
```

Therefore the correct provenance label is **repacked English 1.2.42 companion APK**, not cryptographically verified original store APK. The power implementation is in `classes.dex`, not in translated resources, and the DEX contains the expected ZMI package/class structure and product mappings.

---

## 1. Target-hardware relevance

The APK is not merely a generic Xiaomi-router client. Its DEX contains explicit product/hardware handling for this family, including:

```text
MF815
MF855
MF885
MF96 Ver.B
MF96 Ver.C
MF96 Ver.D
```

`LocalRouterApi` inspects the router software/hardware information and explicitly branches on `MF96 Ver.D`. The same APK also contains the `MF885` product name in application/UI logic.

---

## 2. HTTP and Digest implementation in the APK

The local router API falls back to `http://192.168.21.1` and sends management requests to the physical path `/xml_action.cgi`.

The APK independently confirms the same Digest quirk used by this project:

```text
realm = Highwmg
qop   = auth
login HA2 uses GET:/cgi/protected.cgi
XML Authorization URI / HA2 uses /cgi/xml_action.cgi
physical XML HTTP path remains /xml_action.cgi
login query carries client=APP
XML Digest Authorization ends with client=APP
```

The APP login uses two independent proofs: the query hashes `/cgi/protected.cgi` with one nonce count/`cnonce`, while the Authorization header hashes `/cgi/xml_action.cgi` with the next nonce count and a different `cnonce`. The first process pair is `2/3`. The shared client then repeats that exact login Authorization header for power GETs instead of generating new proofs. It also retains only cookies actually issued by APP login. The project does not synthesize its WebUI `locale/platform` cookie and does not add `X-Requested-With` or GET `Content-Type` to this scoped transport.

---

## 3. Power-command result: GET is confirmed by companion client

`HttpBasedRouterApi` contains literal endpoint strings for all three destructive management operations and passes them to its common HTTP helper with literal method `GET`, null parameters and no XML payload.

### Reboot / Restart

```http
GET /xml_action.cgi?method=get&module=duster&file=reset
```

WEBI semantic tree:

```xml
<RGW><reboot/></RGW>
```

The XML tree establishes semantics; it is not the request body used by the recovered companion client.

### Power off

```http
GET /xml_action.cgi?method=get&module=duster&file=poweroff
```

WEBI semantic tree:

```xml
<RGW><shutdown/></RGW>
```

### Factory reset

```http
GET /xml_action.cgi?method=get&module=duster&file=restore_defaults
```

This independently confirms that `reset` is reboot, not factory reset.

### `trueshutdown`

A `trueshutdown` model exists in the firmware family, but the recovered ordinary shutdown UI uses `poweroff`, not `trueshutdown`. It remains unadvertised.

---

## 4. Reboot call chain recovered from DEX

```text
RouterRebootActivity
  -> RouterManager.b(callback)
  -> RouterApi.a(callback)
  -> HttpBasedRouterApi.a(callback)
  -> GET /xml_action.cgi?method=get&module=duster&file=reset
```

After submission the app waits for the router to become reachable again. It does not intentionally submit a second reset command.

---

## 5. Power-off call chain recovered from DEX

```text
RouterShutdownActivity
  -> confirmation dialog
  -> RouterManager.d(callback)
  -> RouterApi.c(callback)
  -> HttpBasedRouterApi.c(callback)
  -> GET /xml_action.cgi?method=get&module=duster&file=poweroff
```

There is no second-stage XML POST.

---

## 6. Factory-reset call chain

```text
SettingRecoveryFactoryActivity
  -> RouterManager.a(Boolean, callback)
  -> RouterApi.a(Boolean, callback)
  -> HttpBasedRouterApi.a(Boolean, callback)
  -> GET /xml_action.cgi?method=get&module=duster&file=restore_defaults
```

---

## 7. Why this is not an accidental generic GET

Ordinary settings in the same DEX use POST/SET with XML/body parameters. Examples include:

```text
admin
device_management
message
pin_puk
smart_set
statistics
status1
uapxb_wlan_security_settings
wan
```

The authors therefore deliberately modelled `reset`, `poweroff`, and `restore_defaults` as command-on-read operations.

---

## 8. Broader endpoint inventory recovered from APK

Observed GET-style routes include:

```text
Action=BackupFwStart
Action=GetInfo&Id=Base
file=GetRestoreStatus
file=upgrade_firmware
admin
device_management
pin_puk
poweroff
reset
restore_defaults
sd_info
smart_set
statistics
status1
uapxb_wlan_basic_settings
uapxb_wlan_security_settings
uploadcrashlog
wan
```

Observed POST/SET models include:

```text
admin
device_management
message
pin_puk
smart_set
statistics
status1
uapxb_wlan_security_settings
wan
```

---

## 9. Native libraries and proprietary companion protocol

The APK contains `libsdk_patcher_jni.so` and `libp.so`, but the recovered reboot and shutdown implementations do not depend on them. The power calls are implemented directly in Java/DEX through `HttpBasedRouterApi`.

The firmware's separate `idle_socket` service is therefore not the power transport used by these recovered call chains.

---

## 10. Confidence matrix

### Reboot / Restart

```text
WEBI reset schema present                  confirmed
reset -> reboot semantics                  firmware-confirmed
MF96 Ver.D/MF885 relevant APK              confirmed
APK UI -> API call chain recovered         confirmed
HTTP method                                GET, companion-app-confirmed
endpoint                                   /xml_action.cgi?method=get&module=duster&file=reset
XML request body                           none
project runtime support                    persisted-header client=APP session + exact live LV01/MF885 2.5.94 match
old WebUI-style flow live observation      response returned; user observed no reboot effect
regenerating APP-header flow observation   response returned; user observed no reboot effect
post-3.1.7 user observation                no reboot observed; no result sheet appeared
copied artifact from that observation      read-only preflight, writesAttempted=0
active revision / reset transport outcome  unknown until versioned APP-probe or saved power report
persisted-header APP live effect           unresolved; do not infer from the preflight
```

### Power off

```text
WEBI poweroff schema present               confirmed
poweroff -> shutdown semantics             firmware-confirmed / strong static evidence
APK UI -> API call chain recovered         confirmed
HTTP method                                GET, companion-app-confirmed
endpoint                                   /xml_action.cgi?method=get&module=duster&file=poweroff
XML request body                           none
project runtime support                    persisted-header client=APP session + exact live LV01/MF885 2.5.94 match
```

### Factory reset

```text
separate restore_defaults model            confirmed
HTTP method                                GET
endpoint                                   /xml_action.cgi?method=get&module=duster&file=restore_defaults
project dashboard control                  not exposed
```

---

## 11. Project runtime implementation

The transport gap and runtime-expression gap are closed.



Conceptually:

```text
2.5.94 reset:
  method: GET
  file: reset
  body: none

2.5.94 poweroff:
  method: GET
  file: poweroff
  body: none
```

The helper also fixes an independent bug: destructive calls no longer require a normal `verify` callback before submission.

The runtime profile is selected only from a fresh live `status1`: model must be exactly `LV01` or `MF885`, firmware must be exactly `2.5.94_release_MF855_NZ_CP_2.129.003`, and a reported hardware revision must be Ver.D. A missing revision is accepted only with the firmware's `LV01` product label. Missing/mismatched identity otherwise disables the controls. There is no configuration override, cached fallback, MF96 activation, shortened-version match, or `2.5.96` power profile.

### Retry semantics

Immediately before submission, the backend obtains a fresh challenge, completes the recovered `client=APP` login, persists its exact Authorization header plus any in-scope login cookie, performs a harmless APP-authenticated `status1` read with that same header, and re-evaluates the exact profile. The subsequent destructive GET repeats the same header and is configured for one HTTP attempt only. Redirects are disabled; redirects, HTML, unexpected text, HTTP `401`, and XML `login_status` values `UNAUTHORIZED`, `TIMEOUT`, or `KICKOFF` fail closed. A rejected/stale session therefore fails the command instead of risking a second side effect.

HTTP 2xx with an expected empty/XML response produces `request-accepted` with `effectConfirmed: false`; even a returned schema tree is not proof of a reboot or shutdown. Family-native analysis explains why: the CGI recognizes reset-class filenames and returns HTTP 200 after queuing the Duster request, without waiting for the power handler to finish. An ambiguous transport drop produces `delivery-unknown`. Neither result causes an automatic replay.

The backend writes a redacted, versioned phase journal before network login and immediately before handing the one-shot command to the transport. At that checkpoint, `destructiveAttempts: 1` conservatively means the request may have been sent; it is not proof of delivery. The UI and backend single-flight power actions, preventing a concurrent second request. The dashboard exposes the latest Keychain-persisted copy through **Last power report**; if Keychain persistence fails, only the in-memory copy remains. A separate **APP auth probe (GET only)** performs only challenge, APP login and `status1`; its report explicitly records zero writes and zero destructive attempts.

---

## 12. Remaining evidence gaps

The request-shape and runtime-expression gaps are closed. Remaining checks are:

1. update the loader/application with normal Internet access, then return to MF885 Wi-Fi and launch it again so the replacement loader reports the active SHA; require the intended Software version and a non-`unknown` 40-character Dashboard build;
2. run the zero-write APP authentication probe and retain its redacted report before considering any further reboot attempt;
3. if APP authentication is confirmed but an exact request still has no effect, capture the stock WebUI reboot flow as a controlled A/B comparison; the project's older “WebUI-style” login was not byte-exact;
4. decode the exact target-build native `reset`/`poweroff` descriptors/handlers; current address-level handler evidence is from a related family image, not the exact OSLO hash;
5. research `trueshutdown` only if needed.
