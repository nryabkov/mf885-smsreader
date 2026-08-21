# MF885 SMS Reader

## API safety and firmware compatibility

The application sends ZMI XML API requests to the router's physical endpoint at
`/xml_action.cgi`. Digest authentication deliberately uses the distinct firmware
digest URI `/cgi/xml_action.cgi` in HA2 and the Authorization header; the vendor login handshake remains separate. Ordinary
writes use a single POST followed by a control GET. A successful HTTP response alone
is not treated as proof that a setting changed.


Unknown enum values are displayed with their raw vendor value. Firmware-dependent writes remain disabled unless a concrete contract is confirmed for the exact live device identity; the application never probes write values. Power controls create a fresh APK-compatible `client=APP` Digest session, repeat the login Authorization header and any scoped login-session cookie exactly as the recovered client does, perform a harmless `status1` read, require model `LV01`/`MF885` and the full firmware string `2.5.94_release_MF855_NZ_CP_2.129.003`, and then make exactly one destructive GET with no automatic retry. APP redirects, HTML login pages, and unexpected text responses fail closed. An HTTP response means only that the request was accepted; it is not reported as proof that reboot or shutdown occurred. There is no manual override or family-wide fallback.

WAN byte totals are parsed as unsigned decimal `BigInt` values. Download is
`rx_byte_all`, upload is `tx_byte_all`, and total is their sum; LAN/WLAN, device, and
billing-period counters are not combined with these values.

## Stable configuration

Copy `mf885-smsreader-config.json` to Scriptable's documents directory. Polling is
bounded to 15–300 seconds and Telnet check settings are bounded to safe values. Only
HTTP(S) translation endpoints are accepted. Passwords and translation credentials
belong in Keychain and must not be placed in the JSON file or URL query strings.

Experimental controls are shown by default. Setting `showExperimentalControls` to
`false` hides them; showing them does not bypass compatibility checks or confirmation
dialogs.

MF885 SMS Reader is an English-language [Scriptable](https://scriptable.app/) dashboard for iPhone that connects directly to a ZMI MF855/MF885-family mobile router.

The script does **not** read or send messages through Apple Messages on the iPhone. Instead, it talks directly to the router over its local web interface, authenticates with HTTP Digest authentication, and uses the router XML API to read and send SMS messages stored on or sent through the router.

## What it does

- Loads every available SMS page, removes duplicate messages, and guards against firmware that repeats pages.
- Refreshes the dashboard automatically to check for new messages and router status changes.
- Displays cellular network, signal, battery, and mobile traffic information.
- Adds a three-layer **Logs** view: parser/endpoint failures, the router's full technical `detailed_log` PDP/client events, and a live in-memory Scriptable request/action stream with Pause, Refresh, Clear and Copy controls.
- Sends SMS messages and provides copy and system **Share** actions in a mobile-friendly WebView, including clipboard fallbacks when the relevant iOS/WebView capability is unavailable.
- Offers SMS copy and share actions in the WebView. Sharing prepares the sender, date, and message body for Scriptable's native system share sheet; if that API is unavailable, the same contextual text is copied to the clipboard and the dashboard clearly reports the fallback. Without a configured translation endpoint, the **Translate** button is hidden. With optional `TRANSLATE_ENDPOINT` advanced setup, a LibreTranslate-compatible service enables a **Translate** button that returns the translation inline in the SMS card and reports HTTP/JSON/empty-response diagnostics in the WebView status block. The dashboard does not start automatic bulk translation when opened.
- Deletes individual SMS messages from the router after confirmation.
- Keeps WAN traffic reset disabled until a verified write contract exists, and exposes restart/power-off only for the exact live MF885 2.5.94 profile.
- Produces a copyable, redacted read-only preflight report from a fixed seven-endpoint GET allowlist before any live power or firmware experiment. The report includes the installed dashboard version and loader-reported commit revision; the revision is explicitly `unknown` until a replacement loader's next invocation.
- Provides a separate **Run APP auth probe (GET only)** action that performs the scoped companion-client login and a harmless `status1` read without touching `reset`, `poweroff`, configuration, debug, restore, or flash endpoints.
- Provides **Capture firmware status contract (GET only)** to record redacted live schemas from `GetRestoreStatus` and `upgrade_firmware`. It performs seven bounded GETs including login and identity, sends no request body, and always reports `firmwarePostsAttempted: 0` and `flashAllowed: false`.
- Provides a read-only firmware audit plus a separate **Firmware restore (Stage 0)** workflow. Native reverse engineering found that old Canary r3 has invalid outer byte sums, so it stays quarantined. The new observer-only `0.0-logs-r1` is structurally verified and reproducible but is also excluded from the restore allowlist until golden-to-golden and transport/risk gates pass. The restore workflow is visibly locked while those allowlists are empty; in that state it stops before the file picker and makes zero router requests.
- Probes known hidden firmware endpoints and allows an experimental USSD attempt even when safe detection is inconclusive. Each user action is limited to exactly one non-retried USSD POST; response polling is GET-only, and an ambiguous timeout is never replayed through another guessed schema.
- Provides experimental, confirmed cellular controls for mobile-WAN reconnect and preferred protocol selection (Automatic, LTE only, LTE preferred where supported, 3G only, or 2G only).
- Decodes router SMS fields that are returned as UTF-16BE hexadecimal strings.

## Prerequisites

- An iPhone with the Scriptable app installed.
- A ZMI/MF885-family router with SMS support and accessible local web interface.
- The iPhone connected to the router's Wi-Fi network.
- The router administrator username and password.
- The router's local IP address. The script defaults to `192.168.21.1`.

## Recommended setup: commit-pinned, self-updating loader

The repository keeps the updater, manifest, application, and feature modules side by side:

- `loader.js` is the Scriptable entry point that you install once.
- `manifest.json` declares the loader artifact, application entry point and files, and loader protocol compatibility.
- `scriptable.js` is the application module downloaded by the loader.
- `modules/ussd.js` contains the firmware-specific USSD probing and request variants.
- `modules/cellular-control.js` isolates experimental mobile-WAN reconnect and network-mode commands from the dashboard UI.
- `modules/power-compatibility.js` fail-closes power controls against the exact live model, firmware, and reported hardware revision.
- `modules/power-status.js` implements the companion-app-confirmed LV01 battery enum (`1` charging, `2` USB feeding, `3` normal battery operation).
- `modules/read-only-preflight.js` implements the fixed GET-only diagnostic allowlist and redacted report.

1. Copy `loader.js` into a new script in the Scriptable iOS app.
2. Run it. That is sufficient when using this repository's `main` branch, Scriptable's local application storage, a router at `192.168.21.1`, and the initial router password `zimifi`. During the same run, the loader downloads and launches the application and creates `mf885-smsreader-config.json` automatically in Scriptable's **local** Documents directory.
3. Edit `mf885-smsreader-config.json` only if you need to use a fork, a non-default branch, a different router address, or iCloud application storage. The stable configuration file (rather than the replaceable loader source) contains these settings:

   ```javascript
   {
     "repositoryOwner": "nryabkov",
     "repositoryName": "mf885-smsreader",
     "branch": "main",
     "routerAddress": "192.168.21.1",
     "storage": "local",
     "xmlRequestPath": "/xml_action.cgi"
   }
   ```

   HTTP requests use the configured `xmlRequestPath` (by default `/xml_action.cgi`). The physical request path remains separate from the Digest URI `/cgi/xml_action.cgi` used in HA2 and the Authorization header.

   If you change the configuration later, run the loader again to apply it. On each run, the loader asks GitHub's commits API for the configured branch HEAD, validates the full 40-character SHA, then fetches the manifest, loader, and every application file from raw GitHub URLs containing that exact SHA. A branch move between requests therefore cannot mix commits.
4. The router password is stored in Keychain as `mf885_router_password_<router address>`. An optional GitHub token may be stored as `mf885_github_token`; it is useful when unauthenticated API rate limits are too low. Neither secret is written to configuration or logs. Use a temporary Scriptable script to set or replace these Keychain values.
5. Keep the iPhone connected to the router Wi-Fi network while using the dashboard.

The loader uses Scriptable's local storage by default. Set `storage` to `icloud` only for the downloaded application and synchronization state. Loader discovery checks the script named by `Script.name()` in both local and iCloud Documents, requires the stable MF885 marker before overwriting it, and does not assume application storage is also loader storage.

### Update identity and transaction model

The configured branch's **commit SHA is the sole snapshot identity**. Every new commit advances it—even a documentation-only commit or a commit that retains optional display `version` metadata. Semantic versions never suppress synchronization.

Application files first download into `mf885-smsreader.staging-<sha>` beside the active `mf885-smsreader` directory. Each safe relative path must be present and non-empty. Only then is the active directory moved to `mf885-smsreader.backup` and the staged snapshot activated. The backup remains until the active SHA is recorded successfully; download, activation, or state-write failure rolls back and preserves the prior complete application.

The manifest-declared loader is also downloaded at the same SHA. It is validated for non-empty content and the stable marker, and the current Scriptable source is backed up as `<Script name>.js.mf885-backup` before any self-update attempt. The loader is overwritten in place instead of being removed and moved back, so the running Scriptable script should not temporarily disappear from Scriptable's script list. Loader code already executing does not change in memory. If the application requires a newer loader protocol, `mf885-smsreader-sync-state.json` records the target as pending, leaves the old application active, and displays **Loader updated; restart required**. The next invocation validates the replacement and finishes application activation. Unsupported application code is never launched early. If in-place loader overwrite is not available or fails, the loader logs a warning, keeps the installed application directory untouched, and falls back to the last complete local application.

Synchronization state lives beside the application directory as `mf885-smsreader-sync-state.json` (in the selected storage) and contains active SHA, optional pending SHA, loader protocol, and status. It is written to `.tmp` and replaced only after successful activation. Missing/corrupt state or any missing/empty required artifact forces a full repair, even when the remote SHA equals the formerly active SHA.

### Migration, offline behavior, and troubleshooting

An installation containing only `mf885-smsreader/installed-version.txt` has no trustworthy commit identity: for example, version `2.0.0` corresponds to multiple commits. The loader announces migration and performs one complete synchronization. It removes the legacy file only after activation succeeds; failure retains the old application and legacy evidence.

GitHub commit lookup, rate-limit, malformed response, manifest, download, staging, loader self-update, and persistence errors are reported as **`[Sync warning]`** and the last complete local application is launched when one exists. Each GitHub request is attempted once with a five-second Scriptable idle timeout; there are no updater retries. A normal artifact may take longer than five seconds while data continues to arrive, but a black-holed route fails fast. A clean first installation still needs a stable Internet connection because it has no local fallback; an already-installed copy keeps launching its last complete snapshot after a failed check. The shorter timeout itself takes effect after the old loader completes one successful online self-update. Long synchronization runs also log progress before branch lookup, manifest loading, loader loading, and each application-file download. A fatal installation error occurs only if no usable local entry exists. These messages are separate from **`[Router/startup error]`** failures such as `No authentication challenge`, which usually mean the phone is off the router Wi-Fi, the address is wrong, or router authentication failed.

The dashboard's Device card and copyable diagnostic JSON show both the semantic **Software** version and the installed **Dashboard build** SHA. When the MF885 has no working mobile data, connect the iPhone to ordinary Internet Wi-Fi and run the loader once through synchronization. Then return to the MF885 Wi-Fi and launch it again: the replacement loader takes effect on that second invocation, its GitHub check fails fast to the complete local snapshot, and it passes the active SHA to the dashboard. An older version or SHA indicates that a different local build is active—often because of safe fallback, but also check the configured branch and `[Sync warning]`. An `unknown` SHA means the replacement loader has not launched yet. Do not run the APP probe until the report contains the intended version and a non-`unknown` 40-character revision.

Recovery procedures:

1. **Interrupted/bad loader replacement:** the Scriptable script should not disappear from the script list during self-update because the loader no longer removes the active file before writing the new source. If it still disappears after an iOS/Scriptable storage issue, close Scriptable, find `<Script name>.js.mf885-backup` in Scriptable Documents, and restore its contents into a script with the same name. If the backup is unavailable or its path cannot be verified, copy the repository's `loader.js` into a new Scriptable script manually; the application is deliberately left untouched.
2. **Corrupt state:** preserve the application and backups, then remove `mf885-smsreader-sync-state.json`. The next online run treats the commit as unknown and performs a full synchronization.
3. **Force a complete synchronization:** remove only the sync-state file (not `mf885-smsreader`), reconnect to the internet, and run the loader. Missing application files also trigger repair automatically.
4. **Rate limiting:** wait for GitHub's limit to reset or set a GitHub token in Keychain under `mf885_github_token`. Never paste a token into the loader or configuration.
5. **Offline use:** do nothing destructive. The loader reports the precise sync failure and runs the last complete snapshot. Restore connectivity only when an update is desired.


### Copying, sharing, translation, and refresh behavior

The WebView contains a reusable action status panel for copy, system sharing, translation, refresh, and JavaScript diagnostics. **Share** sends a contextual value containing the SMS sender, date, and body to Scriptable's native `ShareSheet`. Cancelling the sheet is a neutral outcome rather than an error. If the native share sheet is not available in the installed Scriptable runtime, the prepared value is copied to the clipboard and a visible status explains the fallback. If iOS or Scriptable denies `navigator.clipboard`, **Copy** shows the SMS text in a read-only selectable field so you can copy it manually.

`TRANSLATE_ENDPOINT` is empty by default, so automatic translation is not configured and SMS cards do not show a **Translate** button. Copying and system sharing remain available in that default mode. To get inline automatic translation and show **Translate** alongside **Copy**, **Share**, and **Delete**, configure a LibreTranslate-compatible endpoint in `scriptable.js`; endpoint failures include HTTP status, JSON parsing, or empty-response details in the diagnostics panel.

Dashboard refreshes use Scriptable's `scriptable:///run` callback URL, which can close and relaunch the running script. Before manual or automatic refresh, the UI warns that Scriptable is restarting the script and prevents repeated rapid taps/navigation while the transition is in progress, avoiding refresh loops that can look like the app is blinking. If the screen closes during refresh, open the Scriptable script again.

Dangerous router actions use an inline WebView confirmation before submission. The first tap on **Restart**, **Power off**, **Reconnect cellular network**, or a cellular mode button only expands a local warning; the backend also requires the command-channel confirmation flag. Restart and power-off use a separate fresh `client=APP` session matching the recovered ZMI companion client, including its persisted login header and login cookie store. The APP challenge has a bounded timeout so the backend finishes before the WebView command deadline. The destructive request is never replayed; a response is labelled **accepted, effect unconfirmed**, while connection loss is labelled **delivery unknown**. **Reset traffic** is visible but disabled because no verified write contract is available.

### Experimental cellular controls

The Router tab includes an experimental **Cellular network** control block. **Reconnect cellular network** attempts known MF855/MF885 mobile-WAN disconnect/connect and registration commands, then verifies the result through status/network reads when available. The preferred protocol controls are restricted to a fixed whitelist: **Automatic**, **4G/LTE only**, **LTE preferred** (only where firmware accepts it), **3G only**, and **2G only**.

The dashboard has one **Detect experimental features** button for USSD, device-access, and cellular controls. The same detection starts in the background after first paint. Probes run concurrently and their results are cached and applied independently, so one failure does not hide successful features. Controls consistently report **Not checked**, **Detecting…**, **Available**, **Unavailable**, or **Status unavailable**. An unavailable or indeterminate control remains disabled with its reason; if a probe fails, the button becomes **Retry experimental detection**.

These controls are firmware-dependent and may be ignored or rejected on some builds. They use only safe GET probes during detection, but confirmed actions can temporarily drop mobile internet while the modem disconnects, reconnects, or changes radio access technology. If your firmware is not supported, please send the copyable diagnostics from the notice/details area with your report. Diagnostics include endpoint/file names, XML root/field names, `routerCall` object path/method pairs, compact responses/errors, and verification results, while redacting passwords, Digest nonces/responses, and sensitive headers.

### Read-only preflight

The **Run read-only preflight** button reads only this fixed allowlist: `status1`, `wan`, `Engineer_parameter`, `miautosleep`, `smart_set`, `uapxb_wlan_basic_settings`, and `autoreboot`. Its report contains the dashboard version/build, device identity, power enums, sleep/auto-reboot fields, endpoint success/size, and explicit safety counters. It never includes raw XML, APN values, identifiers, passwords, SMS content, or configuration backups.

The preflight code has an explicit denylist for `RestoreFw`, `BackupFwStart`, `RestoreBackup`, `reset`, `poweroff`, `restore_defaults`, and `debugmodeon`. It reports `writesAttempted: 0`, `restoreTransportVerified: false`, and `flashAllowed: false`; those flags are facts about this diagnostic, not an authorization to proceed with firmware work.

The separate firmware-status capture uses the recovered APP login flow and four fixed GET routes: `GetRestoreStatus` and `upgrade_firmware`, each with and without `module=duster`. It stores only identity, power enums, HTTP/result classes, response sizes, and parsed status fields. It deliberately does not probe the destructive `Action=RestoreFw` route, construct multipart data, start a backup, or infer that the upload contract is safe.

The separate **Run RestoreFw dry-run (GET only)** action accepts only the exact stock golden bytes. It reads native Scriptable `Data` once into a private byte snapshot, hashes that same snapshot twice, builds a deterministic multipart fixture entirely in memory, independently extracts the payload using the recovered native MIME-marker/boundary rule, and verifies the extracted size and SHA-256. The fixture's `file` field and exact-image filename are conservative historical assumptions, explicitly marked unqualified because the native parser does not require them. The action then opens a fresh APP session and reads identity plus the four fixed firmware-status GET routes. It never creates a POST `Request`, calls `POST_ARMED`, opens the live firmware journal, or uploads the body. The report always records `qualification: false`, `firmwarePostsAttempted: 0`, and `flashAllowed: false`, and explicitly lists the unproven live POST serialization/session and atomic-lease blockers.

### WEBUI Canary audit

**Audit WEBUI Canary Logs r1 (no flash)** opens Scriptable's native Files picker and computes SHA-256 from the selected bytes. It recognizes the exact 8,323,644-byte `MF885_Community_0.0-logs-r1.bin` image with SHA-256 `65e5f5b507b9fcf49609a6fd1f010daa6f18111dc6a829d5655fa6bd30553517`. The image has a valid CAFE archive, valid WEBI/global byte sums and byte-identical non-WEBI partitions, but remains outside `SAFE_IMAGES` until the destructive qualification gates pass.

For the exact Logs r1 bytes, the audit may perform one fresh read-only `status1` identity/power check. It never retains the selected bytes, exposes the Files path, constructs multipart data or uploads firmware; `firmwarePostsAttempted` remains `0` and `flashAllowed` remains `false`. The old r3 hash is still recognized separately and reported as quarantined because its outer additive byte sums are invalid by `0x5fc`. See the [source manifest](firmware/webui-canary-logs/manifest.json), [firmware ladder](docs/FIRMWARE_LADDER.md), and [ZIMI / RestoreFw reverse record](docs/reverse-engineered-api/RESTOREFW_REVERSE.md).

### Stage 0 firmware restore

The dashboard now contains a distinct **Firmware restore (Stage 0)** control, backend transaction flow, and **Stage 0 journal** viewer. It is disabled with its current blockers until a complete reviewed RestoreFw contract, exactly one compiled risk/recovery record, and a proven atomic cross-process lease all exist. Stage 0 validates either the preferred physical record (three identical full 32 MiB dumps of the 1.8 V NOR plus verified recovery entry) or the separate `software-only-risk-v1` record. The latter binds two independent fresh golden BackupFw captures, hashed configuration evidence (a stock export, or a reviewed private-settings bundle only when stock export unavailability is proven), separately recorded Wi-Fi/APN settings, the exact unit and transport, explicit no-recovery acceptance, and an 80% battery gate; it never fabricates physical-dump fields. All production evidence lists remain empty and `ATOMIC_RESTORE_LEASE_PROVEN` is false. Scriptable Keychain read/write/read is not compare-and-set and cannot satisfy this gate. No production transport adapter is present in this build; test injection cannot be reached from WebView.

Once those records and the core-owned adapter exist, Scriptable keeps immutable native `Data`, finishes both hashes before arming, obtains the final live identity/power from the prepared session, and requires a typed native `FLASH <sha-prefix>` confirmation. The software-only profile strengthens that phrase to `NO RECOVERY FLASH <sha-prefix>` and states the brick consequence on the native screen. `POST_ARMED` is saved and read back from Keychain, and the exclusive lease is rechecked before the sole Request. There are no redirects or automatic retries. A timeout, disconnect, unknown status, or restart after arming leaves a terminal `UNKNOWN` journal. Status and boot polling are GET-only and bounded. Firmware mode pauses WebView polling and rejects other router actions. The first qualification is golden-to-golden; any future replacement Canary stays blocked until that exact transaction reaches `BOOT_VERIFIED` under the same transport, risk/recovery profile, and unit fingerprint. Completed `BOOT_VERIFIED`/explicit `FAILED` journals require acknowledgement before another run; `UNKNOWN` is never normally clearable.

### Power endpoint diagnostics

Power-off and restart commands vary across MF855/MF885-family firmware builds. The dashboard enables them only after a live `status1` response exactly matches `LV01`/`MF885` plus `2.5.94_release_MF855_NZ_CP_2.129.003`; a reported hardware revision must be Ver.D, and a missing revision is accepted only for the `LV01` product label. The backend repeats that identity read immediately before submitting exactly one APK-confirmed command-on-read request: `GET file=reset` or `GET file=poweroff`, with no body and no automatic replay—not even after an authentication failure. A connection loss produces a `delivery-unknown` outcome and requires human review before any later attempt.

The non-destructive **Run APP auth probe (GET only)** action uses the same short-lived login/session shape and reads only `status1`. Its report records the installed software build, login/probe HTTP metadata, identity fields and exact-firmware flag, header/cookie booleans, and explicit zero-write/zero-destructive-attempt counters. Use this report before another reboot investigation.

Every accepted, rejected, connection-lost, or interrupted power attempt updates a redacted in-memory journal and attempts to persist it in Scriptable's Keychain. It is written as the backend enters each phase and immediately before handing the one-shot request to the transport. A pre-dispatch `destructiveAttempts: 1` therefore means one request may have been sent; it does not prove that bytes left the phone. When Keychain persistence succeeds, the latest copy remains available through **Last power report** after the result sheet, WebView, or dashboard has closed. Power actions are single-flighted in both the UI and backend, so a second tap cannot start a concurrent reboot or power-off request. The report contains only the installed software build, phase, HTTP status/size/timing/classification, a command-response fingerprint, boolean session/header/cookie facts, and one-shot safety counters. It never contains passwords, Digest material, cookie values, identifiers, raw XML/configuration, or SMS data.

## Run instructions

There is no package manifest or build step in this repository. Run the script directly in Scriptable:

1. Open Scriptable on the iPhone.
2. Open the script containing `loader.js`.
3. Tap Run.
4. Use the **SMS** and **Router** tabs to view messages and device status. Actions that change router state ask for confirmation.

For local development, you can run a JavaScript syntax check with Node.js:

```bash
node --check loader.js
node --check scriptable.js
```

The Scriptable-specific APIs such as `Alert`, `Request`, and `WebView` are only available inside the Scriptable app, so the script cannot be fully executed in a normal Node.js runtime without mocks.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Debug logging

Diagnostic logging is enabled by default. The Dashboard v2 **Diagnostics → Logs** tab now shows parser/endpoint errors, the router's full technical `detailed_log`, and a live 400-event Scriptable ring buffer. Live streaming runs only while Logs is visible and can be paused, refreshed, cleared from the view, or copied through the native clipboard. The Scriptable editor console still receives lines beginning with `[ZMI DEBUG]`.

The log records authentication stages, request IDs, operation names, HTTP methods, URLs, attempts/retries, timeout and timing information, HTTP status/headers, response sizes, XML summaries, WebView action lifecycle and failures. Technical APN, IP, MAC, IMEI, IMSI, ICCID, SSID and USSD values remain visible for diagnosis. Large XML values are emitted as bounded, numbered parts with an explicit `truncated` marker.

SMS payloads, message text, subjects, contacts, senders/recipients and phone numbers are removed. Active passwords, Wi-Fi keys, GitHub tokens, Authorization/Digest proofs and cookies are also never emitted because they are credentials rather than telemetry. Set `"debug": false` in `mf885-smsreader-config.json` to disable all diagnostic records.

SMS XML payloads are permanently omitted even if an older local configuration contains `"skipSmsContentLog": false`. `debugSensitivePayloads` also does not unlock SMS or credential logging. Technical device/network fields and USSD are already available in the normal local diagnostic stream.

For an unfamiliar `status1` response, inspect the redacted `status1:xml-summary` and `loadModel:complete` debug entries.

The firmware-side observer source, reproducible builder and exact manifest live
under [`firmware/webui-canary-logs`](firmware/webui-canary-logs/README.md). The
complete progression from logs to SMS, USSD, TTL and IMEI is documented in the
[`firmware ladder`](docs/FIRMWARE_LADDER.md).

### Router dashboard and cellular troubleshooting

The Router tab is ordered as **Overview**, **Mobile network**, **Connection diagnostics**, **Experimental features**, and **System**. The unconfirmed cellular controls, USSD, and device-access features are grouped into subsections of the single **Experimental features** card and share one detection button. The overview is intentionally compact; polling updates it and the detailed network fields from the same snapshot. Diagnostics load after first paint, show endpoint-specific failures, and retain the last successful values as stale when a later poll fails. Status and network parsing checks all known field aliases, preserves unknown raw values, and reports conflicting network data without guessing.


Every command button exposes an accessible lifecycle: immediate action-specific
pending text and spinner, `aria-busy`, disabled duplicate-submit protection, and a
short success/error result before its original label returns. Restart, power-off,
and reconnect report **Submitted** while the dashboard waits for router read-back
instead of claiming an unverified success. Tabs, Pause, compose panels, and
confirmation panels also publish their selected, pressed, or expanded ARIA state.
