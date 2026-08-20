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
2. device is positively identified as the exact LV01 / MF885 target;
3. hardware revision is Ver.D;
4. base firmware is exactly `2.5.94_release_MF855_NZ_CP_2.129.003`;
5. external USB power is connected;
6. battery is at least 50%;
7. the exact `RestoreFw` multipart transport has been live-verified and its immutable full wire contract exactly matches the compiled allowlist;
8. physical recovery evidence exactly matches a compiled record: three identical full 32 MiB dumps of the 1.8 V `MX25U25635FZ4I`, the exact golden backup, a positively verified recovery-mode entry, and the privacy-safe fingerprint of the same live router;
9. a WEBUI Canary restore has a prior golden-to-golden transaction under the same contract/capture that reached `BOOT_VERIFIED`.

The transport and recovery allowlists are intentionally empty. `restoreTransportVerified=true`, caller-built evidence, or a configuration override cannot unlock them. Transport evidence binds the exact firmware, operation, HTTP method, physical request path, Digest URI, upload query order/escaping, multipart field/MIME/filename/encoding, authentication/session profile, acceptance predicate, GET-only status route/query/raw-value map, polling bounds, reviewed adapter artifact SHA-256, platform-backed exclusive-lease profile, and SHA-256 of a redacted capture artifact. Recovery evidence independently binds the physical NOR facts, one live unit fingerprint, and reviewed recovery artifact. Filling only a URL or multipart field is insufficient. The shipped build also has no production adapter fallback: adding allowlist data alone leaves the UI locked until a core-owned adapter is reviewed into `scriptable.js`.

On 2026-08-20 a GET-only live read-side observation on the exact LV01 / Ver.D / 2.5.94 target confirmed that both `method=get&file=GetRestoreStatus` variants (with and without `module=duster`) return `<process><status>0</status><progress>0</progress><cause>No Error!</cause></process>` while idle. The corresponding `upgrade_firmware` reads expose `support_32m_flash=1` and separate upgrade, backup, and restore status fields. The dashboard can reproduce and export this redacted observation through **Capture firmware status contract (GET only)**. This confirms only the status-reader side; it does not prove upload multipart/authentication/acceptance semantics and cannot populate `VERIFIED_RESTORE_TRANSPORTS`.

Image metadata is also insufficient. Stage 0 computes SHA-256 itself from the exact Scriptable `Data`/byte array selected for upload and seals that evidence for the current process; caller-built metadata is rejected. The installer retains immutable native `Data` privately and completes the second hash before authentication/arming, so no fallible local hash occurs after `POST_ARMED`. Device identity, unit fingerprint, hardware revision, firmware, battery level, and charger state come from the final live status observation of the prepared session immediately before arming.

The Scriptable dashboard keeps **Verify WEBUI canary file (no flash)** as a read-only action and adds a separate **Firmware restore (Stage 0)** control. Its WebView command exists so the complete workflow can be tested, but the runtime control and backend both fail closed before file selection while either compiled allowlist is empty. No Request is constructed and no router read or POST is made in that state.

For the exact LV01/MF885 firmware above, the recovered companion client defines `Battery_status=1` as external charging input; `Charger_status=0` is normal charging, `4` is full, and `5` is abnormal charging. `Battery_status=2` means USB-A feeding and `3` means normal battery operation. Any future live Stage 0 integration must derive its normalized power gate from those raw fields and reject missing or mismatched identity; the current validate-only module still accepts a normalized boolean and cannot transmit because the restore transport allowlist is empty.

## One-shot destructive rule

A firmware restore transaction may issue exactly one destructive POST. Before network submission the client must durably persist `POST_ARMED`, consuming the only send allowance. A crash between arming and submission is therefore treated as potentially sent, not as permission to try again. A timeout, connection loss or reboot after arming must never cause an automatic replay.

Transaction states:

`IDLE -> PRECHECK_OK -> POST_ARMED -> POST_SENT -> RESTORING -> REBOOT_WAIT -> BOOT_VERIFIED`

Transitions use an explicit adjacency matrix. `FAILED`, `UNKNOWN`, and `BOOT_VERIFIED` are terminal. A Scriptable restart before arming invalidates the preflight; a restart after arming records terminal `UNKNOWN`. The persistent Keychain journal is read back after every write, rejects stale concurrent revisions, and an `UNKNOWN` journal cannot be cleared through the normal completion API.

The in-process sender guard rejects concurrent calls sharing one journal. Cross-process safety is a separate compiled gate: the future core adapter must hold a platform-backed exclusive lease and Stage 0 rechecks its ownership before arming and again immediately before the sole Request. Without that reviewed lease profile, the production adapter remains absent. While firmware mode is active, WebView auto-refresh is paused and the backend rejects SMS, USSD, cellular, power, refresh, and other router actions. The **Stage 0 journal** view recovers interrupted states and permits acknowledgement only for `BOOT_VERIFIED` or explicit `FAILED`; `UNKNOWN` stays locked.

`BOOT_VERIFIED` is not a label-only transition. It requires a transaction- and image-bound post-boot observation confirming the exact MF885 identity and firmware plus live `status1`, Wi-Fi, SMS API, and mobile-data checks. The WEBUI canary additionally requires its expected marker.

## Intended first hardware sequence

1. verify recovery-mode entry without flashing;
2. save golden firmware backup and configuration backup;
3. capture the GET-only status-reader contract, then capture and review the remaining exact RestoreFw upload/authentication contract without sending a firmware payload;
4. add the reviewed immutable transport and physical recovery records to the source allowlists;
5. run the Scriptable Stage 0 installer dry path and verify all gates with zero POSTs;
6. stock golden -> stock golden restore;
7. stock golden -> WEBI-only canary r3;
8. canary -> stock golden rollback;
9. only then consider native OSLO canaries.

Static validation is not hardware validation. Stage 0 now has the guarded installer transaction path, but the shipped build cannot construct or send `RestoreFw` because both compiled evidence allowlists and the reviewed transport adapter are absent. It remains conservative when any identity, power, image, journal, recovery, transport, sequence, or post-boot evidence is missing.
