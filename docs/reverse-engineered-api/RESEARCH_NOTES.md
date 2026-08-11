# Reverse-engineering research notes

These notes capture findings that are relevant to API users but are not normal application-level API guarantees.

## Runtime architecture

The analysed 2.5.96 firmware is not a conventional Linux distribution with BusyBox/package management. The main runtime is a monolithic **Nucleus PLUS RTOS** image with Marvell networking/modem components and an embedded web server/UI.

Practical consequence: an administrator account is powerful at the router control-plane level, but it does not automatically provide `/bin/sh`, SSH, `opkg`, `apt`, or a normal filesystem/package model.

## Debug mode

Firmware contains the contract:

```xml
<RGW><debugon><openmode/></debugon></RGW>
```

Static native-handler tracing shows that the handler switches an internal state machine to **mode 8**. Nearby code/strings tie this state to Duster, AT-command exchange and USB/modem handling.

What is confirmed:

- a real native handler exists;
- invoking the model is more than a UI-only flag;
- internal mode 8 is selected.

What is not yet confirmed:

- the exact USB descriptors/interfaces exposed by mode 8;
- whether it enables a serial console, diagnostic port, shell, or a combination;
- behaviour differences on 2.5.94.

The safest live experiment is to capture USB enumeration before and after the command and compare descriptors rather than guessing commands.

## Telnet / `control_telnet`

A persistent XML/configuration contract exists:

```xml
<RGW><control_telnet><enable_telnet/></control_telnet></RGW>
```

However, static analysis of 2.5.96 did not reveal obvious `telnetd`, BusyBox, Dropbear or `/bin/sh` strings. Therefore:

- existence of the field is confirmed;
- existence of a listening Telnet service is not;
- if a service appears, it may be a vendor engineering CLI rather than a Unix shell.

The project's `telnet-control.js` disables Telnet because no universal field, value, and port contract has been confirmed.

## SAC shell

Strings such as `sac_shell.c`, `sac_shell_engine.c`, CI request/response traces and cellular primitive dispatch evidence indicate an internal **cellular/baseband engineering shell or command layer**.

This should not be interpreted as a Unix shell. Its likely domain is modem/CI/SIM/radio engineering operations. The exact expansion of `SAC` has not been proven from the available binary evidence and is intentionally left undocumented rather than guessed.

## `diagnostic` schema

A schema resembling:

```xml
<diagnostic><command/><arg/><output/></diagnostic>
```

exists, but the corresponding 2.5.96 model-registration entry was found with zero handler slots. It should therefore be treated as an inactive/dead contract in that build, not an arbitrary native command dispatcher.

## CWMP / TR-069

CWMP (CPE WAN Management Protocol), standardized through TR-069, is the remote-management plane used by an ACS (Auto Configuration Server) to manage a CPE such as this router.

The analysed firmware contains evidence for:

- ACS configuration;
- periodic Inform sessions;
- connection-request credentials/path;
- STUN/TR-111-related support;
- remote download/update workflows.

TR-069 is not a shell, but an ACS can have broad device-management privileges, including configuration and firmware delivery depending on the data model and implementation.

Never publish live ACS usernames/passwords or configuration exports.

## FBF / RSAI firmware signature

The analysed 2.5.96 image is a `Marvell_FBF` container. The final `RSAI` section is a 128-byte RSA signature block.

Static and mathematical verification recovered the signature scheme as:

```text
RSA-1024
PKCS#1 v1.5
SHA-1
```

The signed data is the FBF prefix up to the start of the RSAI section in the analysed image.

Important consequence: modifying the image and recomputing SHA-1 is not enough. A stock verifier requires a signature produced by the OEM private key unless the trust anchor/verifier or update path is changed.

## `IASR`

Strings containing `IASR` are the byte-reversed rendering of the four-character section tag `RSAI` in parts of the firmware. `IASR` is not a program, task or shell and cannot be "started".

## TR-069 download-path observation

The binary contains a string equivalent to:

```text
IASR[download] RSA image, always mark to pass
```

This is interesting evidence around the remote-download validation path, but a string alone is not sufficient proof that arbitrary unsigned firmware can be installed. Treat this as a hypothesis requiring control-flow and live/recovery testing, not a documented exploit.

## Firmware backup

Two concepts must be distinguished:

1. **Firmware backup** via `BackupFwStart` / `BackupFw`.
2. **Configuration/PSM backup**, which can contain credentials and persistent settings.

The exact byte-level contents of a firmware backup can vary and should be analysed from a real download. Configuration backup should always be treated as secret material.

## TTL modification research

Static analysis located an IPv4 forwarding path (`ip_forward`) in the 2.5.96 OSLO image and confirmed access to the IPv4 header, including TTL at byte offset `+8`.

A robust tethering-oriented TTL patch needs to modify **forwarded IPv4 packets** at the correct point in the forwarding path and maintain the IPv4 header checksum. Blindly changing a generic default TTL constant can affect router-originated packets instead of forwarded client traffic.

A small freestanding ARM/Thumb helper can be compiled for this purpose; the difficult parts are choosing a safe hook/trampoline, preserving ABI/register state, repacking the RTOS image, and obtaining a safe first-flash/recovery path.

## Public documentation policy

This directory intentionally separates:

- active API contracts;
- schemas without handlers;
- static security/research findings;
- live-tested behaviour.

When adding a finding, include confidence/provenance and prefer a precise "unknown" over a plausible but unverified explanation.
