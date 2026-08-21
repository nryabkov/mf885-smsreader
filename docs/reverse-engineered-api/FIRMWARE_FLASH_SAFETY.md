# MF885 SafeFlash Stage 0

Stage 0 is deliberately a safety contract, not a generic firmware uploader.

## Physical flash evidence

High-resolution teardown photographs identify the external firmware storage as Macronix `MX25U25635FZ4I-10G`: 256 Mbit (32 MiB) 1.8 V Serial NOR in an 8-WSON package. This supersedes the earlier working assumption that the main external firmware store was NAND.

Consequences for the safety model:

- a full physical dump should cover the complete 32 MiB Serial NOR address space, not just the 8,323,644-byte BackupFw container;
- direct 3.3 V/5 V programming equipment must not be attached to this 1.8 V part;
- an ordinary SOIC-8 clip is not assumed to fit the WSON package; test pads or a WSON-specific fixture must be mapped first;
- previous `NAND`/`BBT` labels in reverse-engineering notes are now gated until we prove what storage layer those routines actually describe. They must not be treated as evidence that this physical boot flash is NAND.

This remains the preferred recoverable engineering route. The operator has chosen not to provide a full-chip dump, so [the RestoreFw reverse record](RESTOREFW_REVERSE.md) also defines a separate software-only bounded-risk route. That route is not equivalent to recovery: its maximum failure mode is still a bricked router.

## Scope

The initial implementation recognizes two exact 8,323,644-byte ZIMI images:

- stock golden `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`;
- WEBI-only Canary r3 `f2ee088574634d822d5feed8210578a62788c8837fabc80129c6ce51ddfb429c`, retained only as a quarantined known artifact.

A replacement observer-only WEBI artifact is now structurally built but not
restore-qualified:

- Canary Logs `0.0-logs-r1`
  `65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517`.

It keeps `www/index.html` at the exact stock size, replaces only its reviewed
41-byte pre-body whitespace slot with a loader, and appends
`www/js/canary_logs.js` inside existing WEBI padding. The full inspector passes,
all non-WEBI partitions are byte-identical, and a second build is byte-identical.
It remains outside `SAFE_IMAGES`: structural verification does not satisfy the
golden-to-golden, transport, risk/recovery or live-boot gates.

Only golden is currently in `SAFE_IMAGES`. Native reverse engineering proved that Canary r3 preserves a 32-bit word sum while RestoreFw verifies additive byte sums. Its global and WEBI sums are both low by `0x5fc`; despite a valid CAFE archive and only one logical `WEBI:www/index.html` change, it is not restorable.

## Destructive gates

A destructive restore is permitted only when all of the following are true:

1. full SHA-256 and size match an allowlisted image;
2. device is positively identified as the exact LV01 / MF885 target;
3. hardware revision is Ver.D;
4. base firmware is exactly `2.5.94_release_MF855_NZ_CP_2.129.003`;
5. external USB power is connected;
6. battery is at least 50%;
7. the exact `RestoreFw` multipart transport has been live-verified and its immutable full wire contract exactly matches the compiled allowlist;
8. the current build's physical recovery evidence exactly matches a compiled record: three identical full 32 MiB dumps of the 1.8 V `MX25U25635FZ4I`, the exact golden backup, a positively verified recovery-mode entry, and the privacy-safe fingerprint of the same live router;
9. the separately implemented `software-only-risk-v1` alternative, when its reviewed record is compiled, must replace—not forge—the physical record and bind two fresh identical logical backups, configuration evidence, exact unit/transport identity, typed no-recovery risk acceptance, 80% battery, wall power and the one-shot journal;
10. a future WEBUI Canary restore has a prior golden-to-golden transaction under the same contract/capture that reached `BOOT_VERIFIED` and uses a new structurally verified artifact; r3 can never satisfy this gate.

The transport, physical-recovery, and software-risk allowlists are intentionally empty. `restoreTransportVerified=true`, caller-built evidence, or a configuration override cannot unlock them. Transport evidence binds the exact firmware, operation, HTTP method, physical request path, Digest URI, upload query order/escaping, multipart field/MIME/filename/encoding, authentication/session profile, acceptance predicate, GET-only status route/query/raw-value map, polling bounds, reviewed adapter artifact SHA-256, platform-backed exclusive-lease profile, and SHA-256 of a redacted capture artifact. Physical evidence independently binds the NOR facts, one live unit fingerprint, and reviewed recovery artifact. The separate software-only schema instead binds two fresh golden captures, configuration/Wi-Fi/APN evidence, explicit no-recovery acceptance, the same live unit, and the reviewed transport. Configuration evidence is either a real stock export or a separate reviewed private-settings bundle with at least six captured models and proof that the stock export is unavailable. Pretending physical fields exist is forbidden. Filling only a URL, multipart field, or risk-acceptance boolean is insufficient. The shipped build also has no production adapter fallback: adding allowlist data alone leaves the UI locked until a core-owned adapter is reviewed into `scriptable.js`.

On 2026-08-20 a GET-only live read-side observation on the exact LV01 / Ver.D / 2.5.94 target confirmed that both `method=get&file=GetRestoreStatus` variants (with and without `module=duster`) return `<process><status>0</status><progress>0</progress><cause>No Error!</cause></process>` while idle. Native reverse additionally proves the POST route, exact MIME marker, byte extraction, HTTP acceptance body, raw restore states and the preceding active-login-session gate; `RestoreFw` is not in that gate's public-request bypass list. The corresponding `upgrade_firmware` reads expose `support_32m_flash=1` and separate upgrade, backup, and restore status fields. The dashboard can reproduce and export the redacted read-side observation through **Capture firmware status contract (GET only)**. A reviewed exact APP session bootstrap and first-POST behavior are still absent and therefore cannot populate `VERIFIED_RESTORE_TRANSPORTS`.

On 2026-08-21 two independent live `BackupFwStart` acquisitions were completed on
that same target, at 97% and 96% battery with external power confirmed. Each
used exactly one start and one accepted download, produced 8,323,644 bytes with
SHA-256 `2b5880fc26805918bb574d07341ea9b863f8261be34c3bf9766fac0929204531`,
and compared byte-for-byte identical to the other acquisition and the reviewed
golden. Independent inspection again verified the global and six partition byte
sums, every LZMA stream, and every CAFE/Adler archive. The legacy Mongoose
download holds the connection without response headers for about 181 seconds;
over the VDS `wg-mesh` path it requires TCP keepalive, but this affects only the
read-side acquisition harness. A separate clean session captured six private
configuration models with both Wi-Fi and APN settings present (artifact SHA-256
`b0c4df72c3357b401f3bcdb55333d3cf917c296dcc14dbdb242ab990f7cf799e`).
The stock `config_save` flow returned an empty response through fresh fetch and
raw HTTP reproductions, and its own headless-browser `doLogin`/`getHeader`/form
flow emitted no download. The bundle is therefore the explicit fallback
configuration-evidence candidate; it still requires review/compilation and
does not unlock `RestoreFw`.

Image metadata is also insufficient. Stage 0 computes SHA-256 itself from the exact Scriptable `Data`/byte array selected for upload and seals that evidence for the current process; caller-built metadata is rejected. The installer retains immutable native `Data` privately and completes the second hash before authentication/arming, so no fallible local hash occurs after `POST_ARMED`. Device identity, unit fingerprint, hardware revision, firmware, battery level, and charger state come from the final live status observation of the prepared session immediately before arming.

The Scriptable dashboard exposes **Audit WEBUI Canary Logs r1 (no flash)** as a
read-only identification action and a separate **Firmware restore (Stage 0)**
control. The exact Logs r1 bytes may proceed to one harmless live identity/power
read; old Canary r3 and unknown images fail before a router read. The audit never
constructs multipart data and always reports zero firmware POSTs. The restore
WebView command exists so the complete workflow can be tested, but the runtime
control and backend both fail closed before file selection while either compiled
allowlist is empty. No restore Request or router POST is constructed in that
state.

For the exact LV01/MF885 firmware above, the recovered companion client defines `Battery_status=1` as external charging input; `Charger_status=0` is normal charging, `4` is full, and `5` is abnormal charging. `Battery_status=2` means USB-A feeding and `3` means normal battery operation. Any future live Stage 0 integration must derive its normalized power gate from those raw fields and reject missing or mismatched identity; the current validate-only module still accepts a normalized boolean and cannot transmit because the restore transport allowlist is empty.

## One-shot destructive rule

A firmware restore transaction may issue exactly one destructive POST. Before network submission the client must durably persist `POST_ARMED`, consuming the only send allowance. A crash between arming and submission is therefore treated as potentially sent, not as permission to try again. A timeout, connection loss or reboot after arming must never cause an automatic replay.

Transaction states:

`IDLE -> PRECHECK_OK -> POST_ARMED -> POST_SENT -> RESTORING -> REBOOT_WAIT -> BOOT_VERIFIED`

Transitions use an explicit adjacency matrix. `FAILED`, `UNKNOWN`, and `BOOT_VERIFIED` are terminal. A Scriptable restart before arming invalidates the preflight; a restart after arming records terminal `UNKNOWN`. The persistent Keychain journal is read back after every write, rejects stale concurrent revisions, and an `UNKNOWN` journal cannot be cleared through the normal completion API.

The in-process sender guard rejects concurrent calls sharing one journal object, but two wrappers/processes can race on Scriptable Keychain because it has no compare-and-set. Cross-process safety is therefore a separate hard source gate: `ATOMIC_RESTORE_LEASE_PROVEN` remains false. The future core adapter must hold a platform-backed, non-stealable exclusive lease and Stage 0 must recheck an exact true ownership result before arming and again immediately before the sole Request. A false/null lease result now stops execution; a Keychain read error or an existing empty/non-string value is never treated as an absent journal, journal readback compares the complete record, and the adapter requires native `contains`/`remove` instead of clearing to an empty sentinel. Without an independently proven atomic lease, production restore stays unavailable. While firmware mode is active, WebView auto-refresh is paused and the backend rejects SMS, USSD, cellular, power, refresh, and other router actions. The **Stage 0 journal** view recovers interrupted states and permits acknowledgement only for `BOOT_VERIFIED` or explicit `FAILED`; `UNKNOWN` stays locked.

The Scriptable **RestoreFw dry-run** is deliberately outside that live transaction state machine. It does not create a `Request` with method POST, does not call `executePersistentRestoreOnce`, does not persist `POST_ARMED`, and does not touch the live journal. It reads native `Data` once into a private byte snapshot, hashes that same snapshot twice, builds a deterministic local multipart fixture, extracts the payload back with the native `application/octet-stream\r\n\r\n` and closing-boundary rules, and verifies exact size/SHA before a fresh APP GET-only session. The fixture's field and filename are labeled conservative, unverified assumptions rather than transport qualification. This validates local byte handling and current identity/power/status reads, but it does not qualify Scriptable's real multipart serialization, the first POST session boundary, or a cross-process lease.

`BOOT_VERIFIED` is not a label-only transition. It requires a transaction- and image-bound post-boot observation confirming the exact MF885 identity and firmware plus live `status1`, Wi-Fi, SMS API, and mobile-data checks. A future replacement WEBUI Canary additionally requires its expected marker; quarantined r3 cannot enter a transaction.

## Intended first live sequence without a NOR dump

1. retain physical recovery as the preferred alternative, but record the operator's explicit decision to proceed without it;
2. acquire two new clean BackupFw files and hashed configuration evidence (stock export, or the reviewed private bundle only after stock-export failure is proven); verify both images against the exact golden hash and full ZIMI structure;
3. finish the native session/auth reverse and review the exact RestoreFw sender without sending a payload;
4. populate and review the implemented `software-only-risk-v1` schema, typed no-recovery confirmation, 80% battery gate and one-shot exclusive execution; do not weaken or fabricate physical evidence;
5. run the Scriptable Stage 0 dry path and verify all gates with zero POSTs;
6. stock golden -> stock golden exactly once;
7. verify restore status, reboot, identity, Wi-Fi, SMS and mobile-data service, then save another clean backup;
8. build and fully validate a replacement Canary with a new hash; Canary r3 stays quarantined;
9. only after a successful golden qualification consider golden -> replacement WEBUI Canary -> golden rollback;
10. only then consider native OSLO canaries.

Static validation is not hardware validation. Stage 0 now has the guarded installer transaction path and a fail-closed software-only evidence schema, but the shipped build cannot construct or send `RestoreFw` because all production evidence allowlists and the reviewed transport adapter are absent. The no-dump route is not a boolean override: it becomes available only after exact evidence is captured, compiled and reviewed. Stage 0 remains conservative when any identity, power, image, journal, risk/recovery, transport, sequence, or post-boot evidence is missing.
