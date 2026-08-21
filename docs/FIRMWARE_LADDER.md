# MF885 firmware ladder: one variable at a time

This is the working order for the exact LV01 / MF885 Ver.D unit running
`2.5.94_release_MF855_NZ_CP_2.129.003`. Every custom image is rebuilt directly
from the same exact golden; a later image never uses an earlier Canary as its
base. Each stage has its own SHA-256, manifest, logical diff, live report and
golden rollback.

The operator has elected to continue without a physical 32 MiB NOR dump. That
is a bounded-risk route, not recovery. Its maximum failure remains a router that
cannot boot and cannot be repaired through WebUI. The production RestoreFw
adapter therefore remains locked until the exact active-session POST contract,
one-shot execution lock and `software-only-risk-v1` evidence are implemented and
reviewed.

| Gate | Image / action | Only new variable | Pass before continuing | Rollback |
|---|---|---|---|---|
| 0 | Scriptable on stock firmware | richer live logs and safe API exercises | status/SMS/detailed_log and every non-power control behave correctly; no shutdown test | no firmware change |
| 1 | golden -> golden | RestoreFw transport itself | exactly one POST, bounded GET-only status, boot identity, Wi-Fi, mobile data and SMS all verified | the uploaded image is already golden |
| 2 | `0.0-logs-r1` | WEBI loader + observer-only log panel | marker loads; login and normal menus still work; XHR/fetch/forms/errors and `detailed_log` appear; SMS payloads stay hidden | exact golden |
| 3 | `0.0-sms-r1` | repair/simplify the existing stock SMS page | list/send/delete each verified independently; duplicate submission blocked; Logs explain failures | exact golden |
| 4 | `0.0-ussd-r1` | one WebUI USSD form using a Scriptable-proven exact contract | one known non-destructive carrier code, one POST, bounded GET polling, response visible; no replay on timeout | exact golden |
| 5 | `0.1-ttl-ram-r1` | native runtime-only TTL rule | hook identity and packet path proven; TTL changes only in RAM; reboot restores stock behavior | exact golden |
| 6 | `0.2-ttl-persistent-r1` | persist the already-proven TTL setting | value validation, boot persistence, disable path and golden rollback all pass | exact golden |
| 7 | `0.3-imei-lab-r1` | IMEI control alone, never bundled with first TTL test | exact modem command/storage target, checksum/length validation, original-value backup and restore all pass | exact golden plus original identity record |
| 8 | combined release candidate | only capabilities that passed separately | full regression of WebUI, SMS, USSD, mobile data, reboot and golden rollback | exact golden |

## Rules shared by every firmware gate

1. Verify source golden size and SHA-256 before building.
2. Produce a deterministic artifact twice and require byte-identical output.
3. Run the full ZIMI inspector: device-bound header, global byte sum, all six
   partition sums, all LZMA streams, all CAFE Adler-32 values and path diff.
4. Reject any unexplained partition, path, size or offset change.
5. Record battery/external-power state, unit fingerprint, artifact hash and the
   exact before/after service checklist.
6. Use one RestoreFw POST with no redirect or automatic retry. Ambiguous loss is
   `UNKNOWN`, not permission to send again.
7. Do not run SMS, USSD, refresh, power or another Scriptable instance during a
   restore transaction.
8. After each Canary, prove the exact golden rollback before starting the next
   feature.

## Current point

Gate 0 has confirmed live identity/power, status/SMS/detailed-log reads and one
verified SMS deletion. Its first safe `*#06#` USSD attempt was rejected, proving
that the guessed XML models are not the target firmware contract; USSD stays
locked until the native handler is recovered instead of being retried. Two new
independent live BackupFw acquisitions are byte-identical to each other and the
exact golden, and both pass the complete structural inspector. Six live private
configuration models separately preserve Wi-Fi and APN settings; the stock
`config_save` path was also proven empty through fetch, raw HTTP and its own
browser form, so that bundle requires review as the explicit fallback evidence
type. A new Scriptable zero-POST RestoreFw dry-run now double-hashes the exact
golden, locally round-trips its deterministic multipart payload and performs
only fresh APP identity/status GETs; it never constructs a POST Request or
touches the live journal. The exact golden fixture round-trips 8,323,644 payload
bytes inside an 8,323,893-byte body. The exclusive sender, actual Scriptable
multipart wire behavior, atomic cross-process lease and production RestoreFw
transport are still unqualified. Therefore `0.0-logs-r1` is available for
audit, not for upload.

The structural artifact is 8,323,644 bytes with SHA-256
`65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517`.
Its only logical changes are a same-size loader in `WEBI:www/index.html` and the
new `WEBI:www/js/canary_logs.js`; all non-WEBI partitions are byte-identical.
