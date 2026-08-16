# MF885 SafeFlash Stage 0

Stage 0 is deliberately a safety contract, not a generic firmware uploader.

## Physical flash evidence

High-resolution teardown photographs identify the external firmware storage as Macronix `MX25U25635FZ4I-10G`: 256 Mbit (32 MiB) 1.8 V Serial NOR in an 8-WSON package. This supersedes the earlier working assumption that the main external firmware store was NAND.

Consequences for the safety model:

- a full physical dump should cover the complete 32 MiB Serial NOR address space, not just the 8,323,644-byte BackupFw container;
- direct 3.3 V/5 V programming equipment must not be attached to this 1.8 V part;
- an ordinary SOIC-8 clip is not assumed to fit the WSON package; test pads or a WSON-specific fixture must be mapped first;
- previous `NAND`/`BBT` labels in reverse-engineering notes are now gated until we prove what storage layer those routines actually describe. They must not be treated as evidence that this physical boot flash is NAND.

## Scope

The initial implementation allowlists only two exact 8,323,644-byte ZIMI images:

- stock golden `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- WEBI-only canary r3 `f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c`.

The canary is derived from the exact golden image, has no native OSLO patch and logically changes only `WEBI:www/index.html`.

## Destructive gates

A destructive restore is permitted only when all of the following are true:

1. full SHA-256 and size match an allowlisted image;
2. device is positively identified as MF885 / MF96-ROUTER-C2;
3. hardware revision is Ver.D;
4. base firmware is exactly `2.5.94_release_MF855_NZ_CP_2.129.003`;
5. external USB power is connected;
6. battery is at least 50%;
7. the exact `RestoreFw` multipart transport has been live-verified on this firmware family and its immutable evidence record exactly matches a contract compiled into the allowlist.

The transport allowlist is intentionally empty. `restoreTransportVerified=true`, a caller-built evidence object, or a configuration override cannot unlock it. Evidence must bind the exact firmware, operation, HTTP method, request path, Digest URI, multipart field, status model, and SHA-256 of a redacted capture artifact. This keeps Stage 0 validate-only until the request contract is proven on hardware and reviewed into the source.

Image metadata is also insufficient. Stage 0 computes SHA-256 itself from the exact Scriptable `Data`/byte array selected for upload and seals that evidence for the current process; caller-built metadata is rejected. Device identity, hardware revision, firmware, battery level, and charger state must come from a fresh live `status1` read immediately before arming a transaction.

## One-shot destructive rule

A firmware restore transaction may issue exactly one destructive POST. Before network submission the client must durably persist `POST_ARMED`, consuming the only send allowance. A crash between arming and submission is therefore treated as potentially sent, not as permission to try again. A timeout, connection loss or reboot after arming must never cause an automatic replay.

Transaction states:

`IDLE -> PRECHECK_OK -> POST_ARMED -> POST_SENT -> RESTORING -> REBOOT_WAIT -> BOOT_VERIFIED`

Transitions use an explicit adjacency matrix. `FAILED`, `UNKNOWN`, and `BOOT_VERIFIED` are terminal. A Scriptable restart before arming invalidates the preflight; a restart after arming records terminal `UNKNOWN`. The persistent Keychain journal is read back after every write, rejects stale concurrent revisions, and an `UNKNOWN` journal cannot be cleared through the normal completion API.

`BOOT_VERIFIED` is not a label-only transition. It requires a transaction- and image-bound post-boot observation confirming the exact MF885 identity and firmware plus live `status1`, Wi-Fi, SMS API, and mobile-data checks. The WEBUI canary additionally requires its expected marker.

## Intended first hardware sequence

1. verify recovery-mode entry without flashing;
2. save golden firmware backup and configuration backup;
3. capture and review the exact RestoreFw transport without sending a firmware payload;
4. add the reviewed immutable transport contract to the source allowlist;
5. stock golden -> stock golden restore;
6. stock golden -> WEBI-only canary r3;
7. canary -> stock golden rollback;
8. only then consider native OSLO canaries.

Static validation is not hardware validation. Stage 0 currently has no uploader and cannot send `RestoreFw`. It must remain conservative when any identity, power, image, journal, transport, or post-boot evidence is missing.
