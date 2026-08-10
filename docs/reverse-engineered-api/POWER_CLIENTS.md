# MF885 power controls: stock WebUI and ZMI Android app

This note separates the evidence for the two stock user-facing clients that can manage MF885 power state:

1. the firmware-resident WEBI/WebUI;
2. the official ZMI Android application (`com.xiaomi.mifi`).

The purpose is to avoid conflating a model's XML schema, its semantic meaning, the HTTP method that triggers a native callback, and the transport used by the Android companion application.

## Evidence baseline

The firmware-specific baseline is the clean MF885 / MF96 Ver.D 2.5.94 image documented in `MF885_2.5.94_STATIC_ANALYSIS.md`:

```text
BackupFw SHA-256  2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531
raw OSLO SHA-256 d51fb378d8ccf68662174f39d6b8c4f6be5571280790bc3a4dc4a9e8a967078c
```

The 2.5.94 and analysed 2.5.96 WEBI trees have the same 320 filenames, 319/320 byte-identical files, identical 123/123 XML schemas and identical 51/51 JavaScript files. Native OSLO images are not byte-compatible, so transport/callback conclusions still need firmware-specific proof.

---

## 1. Stock WebUI

### 1.1 Generic Duster transport

The stock management CGI supports the ordinary model forms:

```text
GET  /xml_action.cgi?method=get&module=duster&file=<model>
POST /xml_action.cgi?method=set&module=duster&file=<model>
```

The actual HTTP request path is `/xml_action.cgi`. Digest authentication uses `/cgi/xml_action.cgi` as the XML Authorization URI/HA2 input.

For ordinary settings, the frontend normally uses GET for reading and POST/SET plus XML for changing state. Command-like power models are special: a side effect can be bound to a Duster pre/post GET or SET callback, so the existence of both generic forms does not identify the trigger by itself.

### 1.2 Reboot model

Stock WEBI contains `xmldata/reset.xml` with the tree:

```xml
<RGW><reboot/></RGW>
```

Firmware model name:

```text
reset
```

The semantic mapping is established:

```text
reset model -> reboot/restart router
```

This is **not** factory reset. `restore_defaults` is a separate firmware model.

### 1.3 Power-off model

Stock WEBI contains `xmldata/poweroff.xml` with the tree:

```xml
<RGW><shutdown/></RGW>
```

Firmware model name:

```text
poweroff
```

The model/schema combination provides strong firmware evidence for:

```text
poweroff model -> router shutdown/power-off
```

A separate `trueshutdown` model/schema also exists in the family. Its practical distinction from `poweroff` is not established strongly enough to expose it to clients.

### 1.4 What the JavaScript inventory proves — and does not prove

The generated WEBI inventory did not recover a literal stock JavaScript call site for `poweroff` (`javascript_usage.call_kinds` and source-file list are empty for that model). The same limitation applies to using a literal search alone to prove the reboot trigger.

This is important: the absence of a literal `poweroff` string in the indexed panel JavaScript does **not** disprove the function. It can be invoked through common helper code, dynamically assembled arguments, inline HTML, or another management path. But it also means that schema presence cannot honestly be upgraded to `frontend-confirmed` without the missing call site or a packet capture.

### 1.5 GET versus POST/SET discrepancy

An earlier static API reconstruction records the stock-style power triggers as command-on-read:

```text
GET /xml_action.cgi?method=get&module=duster&file=reset
GET /xml_action.cgi?method=get&module=duster&file=poweroff
```

This is plausible in the Duster architecture because the exact 2.5.94 model descriptor has separate native callback slots:

```text
+0x10  pre_set
+0x18  post_set
+0x20  pre_get
+0x28  post_get
```

However, the currently preserved evidence set does not contain the exact `reset`/`poweroff` descriptor callback decode or stock 2.5.94 packet capture needed to prove that GET is the side-effecting direction and exclude POST/SET.

The current Scriptable client uses POST/SET for the separately confirmed 2.5.96 profile. That must not be treated as proof for 2.5.94.

### 1.6 Stock-WebUI confidence result

For exact MF885 2.5.94:

```text
reset model exists                         confirmed
reset means reboot                         firmware-confirmed
reset != restore_defaults                  confirmed
poweroff model exists                      confirmed
poweroff/shutdown semantics                strong static evidence
trueshutdown exists                        family/static evidence
stock WebUI literal poweroff call site     not recovered
exact side-effecting GET/SET transport     unresolved
```

Therefore the correct wording is **not** “the stock WebUI definitely POSTs `<shutdown/>`”, and it is also not yet strong enough to say “the stock WebUI definitely GETs `file=poweroff`”. The remaining gap is specifically the invocation direction.

---

## 2. Official ZMI Android application

### 2.1 Application identity

The official application is distributed as:

```text
package     com.xiaomi.mifi
name        ZMI Mobile Router / ZMI 随身路由器
developer   ZIMI Corporation / ZMI USA Corporation
```

Archived store descriptions explicitly advertise router-management functions that can remotely **restart** and **shut down/close** the router.

A period-relevant release close to the MF885 2.5.94 generation is:

```text
version     1.2.50
release     2017-03-08
size        about 19.94 MB
arch        armeabi
min Android Android 2.3.2+
package     com.xiaomi.mifi
APK SHA-1   d77181b4f0b8aacacd42af9a93bdef8b89c2e5de
signer SHA1 e3:4c:85:1e:c8:e4:e4:83:cf:bd:58:0d:a2:aa:bb:89:bb:87:80:02
```

The signer fingerprint is also reported for later releases, supporting a common official signing lineage.

Archive references used during research include APKPure, APKFab and Aptoide metadata pages for `com.xiaomi.mifi`. A 4PDA-era archive also lists `ZMI_1.2.50_en.apk` and a Russian-localized build; those filenames alone are not used as code evidence.

### 2.2 APK acquisition status

During this analysis, public mirror metadata was reachable, but the 1.2.50 APK body itself could not be retrieved into the reverse-engineering environment. Therefore this document does **not** claim a JADX/apktool decompilation of 1.2.50 and does not invent Android class names, request paths or opcodes.

The APK remains a high-value evidence target because a decompilation can answer whether the power buttons use:

- the Duster XML HTTP API;
- the proprietary companion TCP service described below;
- or a mixture of both.

### 2.3 Firmware-side companion service: `idle_socket`

The exact MF885 firmware contains a separate proprietary TCP-oriented management component named `idle_socket`. Static strings/native evidence identify tasks such as:

```text
IdleSocketLoopTask
IdleReceiveTask
IdleCheckUpdateTask
```

and application-oriented operations including authentication/binding and retrieval/update of router state, for example:

```text
idle_socket_process_command
idle_socket_process_authentication
idle_socket_process_bind_mifi
idle_socket_process_get_info
idle_socket_process_get_wan_statistics
idle_socket_process_updata_wan_setting
idle_socket_process_get_new_sms_num
idle_socket_process_get_plmn_network_name
idle_socket_process_get_wan_speed
idle_socket_process_get_tf_freesize
idle_socket_package_notify_new_sms
idle_socket_package_kickoff_client
```

This service is strong firmware evidence for a dedicated mobile-companion protocol. It is materially different from the Mongoose/Duster XML HTTP API.

The firmware also contains internal task/event labels including a shutdown flag. That does **not** by itself prove that the Android app has a public “shutdown” opcode on this socket: an internal shutdown flag can simply tell the service to terminate when the router itself is shutting down.

### 2.4 Android-app confidence result

What is established:

```text
official app identity                      confirmed by archived stores
official app advertises remote reboot      confirmed
official app advertises remote shutdown    confirmed
firmware has mobile companion service       firmware-confirmed (`idle_socket`)
```

What is not yet established:

```text
APK 1.2.50 decompiled                       no
app power transport = HTTP XML              unknown
app power transport = idle_socket           unknown
idle_socket shutdown/reboot opcode           not recovered
idle_socket wire framing/port for power      not recovered
```

So the Android application is independent evidence that both user-facing operations existed in the stock product ecosystem, but it does not yet close the 2.5.94 HTTP GET/SET question.

---

## 3. Cross-client interpretation

The currently justified model is:

```text
                         +--> Duster XML models (WebUI)
user power action -------|
                         +--> companion protocol / HTTP (Android app; exact split unresolved)

firmware semantics:
  reset             -> reboot
  restore_defaults  -> factory reset
  poweroff          -> shutdown/power-off
  trueshutdown      -> present, distinction unresolved
```

The semantic layer is much better established than the invocation layer.

## 4. Consequence for this project

For MF885 2.5.94, destructive controls should remain disabled until the side-effecting transport is proven. In particular:

- do not copy the 2.5.96 POST/SET invocation merely because the XML trees match;
- do not switch to GET solely because an older static reference names GET;
- do not use connection loss from an unverified request shape as proof of success;
- keep `restore_defaults` completely separate from reboot;
- keep `trueshutdown` unadvertised.

Once the trigger is proven, the compatibility profile should encode transport explicitly, e.g. conceptually:

```text
model: reset
semantic: reboot
method: GET | POST
body: none | <RGW><reboot/></RGW>
```

rather than relying on one global POST assumption.

## 5. Evidence that would close the remaining gap

The highest-value artifacts are, in order:

1. exact stock WebUI network capture while pressing Restart and Power off;
2. exact 2.5.94 Duster descriptor decode for `reset` and `poweroff`, including active callback slot and target handler;
3. original `com.xiaomi.mifi` 1.2.50 APK followed by JADX/apktool/native-library analysis and extraction of its router power requests;
4. controlled device execution only after a candidate trigger is established statically.

Until one of these closes the invocation gap, documentation should preserve the distinction between **confirmed semantics** and **unconfirmed trigger transport**.