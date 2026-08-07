# MF885 SMS Reader

## API safety and firmware compatibility

The application sends ZMI XML API requests to the router's physical endpoint at
`/xml_action.cgi`. Digest authentication deliberately uses the distinct firmware
digest URI `/cgi/xml_action.cgi` in HA2 and the Authorization header; the vendor login handshake remains separate. Ordinary
writes use a single POST followed by a control GET. A successful HTTP response alone
is not treated as proof that a setting changed.

Compatibility profiles contain only values confirmed for a named firmware. Unknown
enum values are displayed with their raw vendor value, and controls remain read-only
when their field names or action values are not confirmed. The application never
probes write values. In particular, Telnet, cellular, statistics-reset, autoreboot,
and true-shutdown controls can remain unavailable even when their read model exists.

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
- Sends SMS messages and provides copy actions in a mobile-friendly WebView, including a manual selectable fallback when iOS/WebView clipboard access is unavailable.
- Offers SMS copy actions in the WebView. Without a configured translation endpoint, the **Translate** button is hidden and only SMS copying is available. With optional `TRANSLATE_ENDPOINT` advanced setup, a LibreTranslate-compatible service enables a **Translate** button that returns the translation inline in the SMS card and reports HTTP/JSON/empty-response diagnostics in the WebView status block. The dashboard does not start automatic bulk translation when opened.
- Deletes individual SMS messages from the router after confirmation.
- Resets total WAN traffic and provides confirmed restart and power-off controls.
- Probes known hidden firmware endpoints and allows an experimental USSD attempt even when safe detection is inconclusive.
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

   The confirmed `2.5.96` compatibility profile sends HTTP requests to
   `/xml_action.cgi` by default. This physical request path is separate from the
   Digest URI: HA2 and the Authorization header's `uri` field always use the
   firmware value `/cgi/xml_action.cgi`. The `xmlRequestPath` setting changes only
   the physical request URL for firmware variants that expose a different endpoint.

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

GitHub commit lookup, rate-limit, malformed response, manifest, download, staging, loader self-update, and persistence errors are reported as **`[Sync warning]`** and the last complete local application is launched when one exists. Long synchronization runs also log progress before branch lookup, manifest loading, loader loading, and each application-file download. A fatal installation error occurs only if no usable local entry exists. These messages are separate from **`[Router/startup error]`** failures such as `No authentication challenge`, which usually mean the phone is off the router Wi-Fi, the address is wrong, or router authentication failed.

Recovery procedures:

1. **Interrupted/bad loader replacement:** the Scriptable script should not disappear from the script list during self-update because the loader no longer removes the active file before writing the new source. If it still disappears after an iOS/Scriptable storage issue, close Scriptable, find `<Script name>.js.mf885-backup` in Scriptable Documents, and restore its contents into a script with the same name. If the backup is unavailable or its path cannot be verified, copy the repository's `loader.js` into a new Scriptable script manually; the application is deliberately left untouched.
2. **Corrupt state:** preserve the application and backups, then remove `mf885-smsreader-sync-state.json`. The next online run treats the commit as unknown and performs a full synchronization.
3. **Force a complete synchronization:** remove only the sync-state file (not `mf885-smsreader`), reconnect to the internet, and run the loader. Missing application files also trigger repair automatically.
4. **Rate limiting:** wait for GitHub's limit to reset or set a GitHub token in Keychain under `mf885_github_token`. Never paste a token into the loader or configuration.
5. **Offline use:** do nothing destructive. The loader reports the precise sync failure and runs the last complete snapshot. Restore connectivity only when an update is desired.


### Copying, translation, and refresh behavior

The WebView contains a reusable action status panel for copy, translation, refresh, and JavaScript diagnostics. If iOS or Scriptable denies `navigator.clipboard`, **Copy** shows the SMS text in a read-only selectable field so you can copy it manually.

`TRANSLATE_ENDPOINT` is empty by default, so automatic translation is not configured and SMS cards do not show a **Translate** button. In that default mode, only SMS copying is available. To get inline automatic translation and show **Translate** beside **Copy** and **Delete**, configure a LibreTranslate-compatible endpoint in `scriptable.js`; endpoint failures include HTTP status, JSON parsing, or empty-response details in the diagnostics panel.

Dashboard refreshes use Scriptable's `scriptable:///run` callback URL, which can close and relaunch the running script. Before manual or automatic refresh, the UI warns that Scriptable is restarting the script and prevents repeated rapid taps/navigation while the transition is in progress, avoiding refresh loops that can look like the app is blinking. If the screen closes during refresh, open the Scriptable script again.

Dangerous router actions now use an inline WebView confirmation before any callback URL is opened. The first tap on **Reset traffic**, **Restart**, **Power off**, **Reconnect cellular network**, or a cellular mode button only expands a local warning in the current WebView; Scriptable relaunches the script only after the final confirmation button executes the command with `confirm=1`. The application still keeps server-side `confirm=1` checks for these flows as a safety guard.

### Experimental cellular controls

The Router tab includes an experimental **Cellular network** control block. **Reconnect cellular network** attempts known MF855/MF885 mobile-WAN disconnect/connect and registration commands, then verifies the result through status/network reads when available. The preferred protocol controls are restricted to a fixed whitelist: **Automatic**, **4G/LTE only**, **LTE preferred** (only where firmware accepts it), **3G only**, and **2G only**.

The dashboard has one **Detect experimental features** button for USSD, device-access, and cellular controls. The same detection starts in the background after first paint. Probes run concurrently and their results are cached and applied independently, so one failure does not hide successful features. Controls consistently report **Not checked**, **Detecting…**, **Available**, **Unavailable**, or **Status unavailable**. An unavailable or indeterminate control remains disabled with its reason; if a probe fails, the button becomes **Retry experimental detection**.

These controls are firmware-dependent and may be ignored or rejected on some builds. They use only safe GET probes during detection, but confirmed actions can temporarily drop mobile internet while the modem disconnects, reconnects, or changes radio access technology. If your firmware is not supported, please send the copyable diagnostics from the notice/details area with your report. Diagnostics include endpoint/file names, XML root/field names, `routerCall` object path/method pairs, compact responses/errors, and verification results, while redacting passwords, Digest nonces/responses, and sensitive headers.

### Power endpoint diagnostics

Power-off and restart commands vary across MF855/MF885-family firmware builds. If a power command is rejected or the router stops responding before confirmation is received, the dashboard shows copyable diagnostics in the status/notice area. Please send those diagnostics when reporting power-control problems; they include attempted XML endpoints such as `xml_action.cgi?method=set&module=duster&file=device_management`, XML root/field names, and `routerCall` object path/method pairs, while omitting passwords, Digest responses, and sensitive headers. If possible, also include a packet capture from the router's native web UI while using its own restart or shutdown button so the correct firmware endpoint can be matched safely.

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

Safe diagnostic logging is enabled by default. In Scriptable, run the loader, then open the script's run log/console from the Scriptable editor (the console icon at the bottom of the editor) to copy lines beginning with `[ZMI DEBUG]`. SMS response bodies and fields containing message text, subjects, contacts, senders, or recipients are omitted by default by `"skipSmsContentLog": true`; safe request metadata and sanitized XML structure summaries remain available.

The log records authentication **stages** (never the Digest challenge), request IDs, operation names, HTTP methods, safe URLs, attempts and retries, timeout and timing information, HTTP status and selected non-sensitive response headers, response sizes, XML summaries, and failures. XML bodies are redacted before logging and large values are emitted as bounded, numbered parts with an explicit `truncated` marker.

Passwords, GitHub tokens, Authorization and Digest values, cookies, phone numbers, SMS text and contacts, USSD codes, and credential-like fields are removed. Set `"debug": false` in `mf885-smsreader-config.json` to disable all diagnostic records.

For a short, private troubleshooting session only, set `"skipSmsContentLog": false`, run the diagnostic, then restore it to `true`. **Disabling this setting may expose private SMS data** (including fields not recognized by the sanitizer). The central redaction layer remains active as defense in depth even while content logging is opted in, but it must not be treated as permission to share the resulting log.

`debugSensitivePayloads` is an explicitly dangerous troubleshooting option and is `false` by default. Enabling it may expose otherwise private application payload fields to the Scriptable console; do so only temporarily, away from shared logs or screen recordings. Security-critical credentials, Digest material, cookies, SMS/contact fields, phone numbers, and USSD values remain redacted by the central logger.

For an incompatible `status1` response, look for `status1:xml-summary` (especially `WanStatistics`, `batteryinfo`, and `cellularFields`) and `loadModel:complete`. These show whether the selected compatibility profile recognizes the router response without revealing the response's private values.

### Router dashboard and cellular troubleshooting

The Router tab is ordered as **Overview**, **Mobile network**, **Connection diagnostics**, **Cellular controls**, **USSD**, **Device access**, and **System**. The overview is intentionally compact; polling updates it and the detailed network fields from the same snapshot. Diagnostics load after first paint, show endpoint-specific failures, and retain the last successful values as stale when a later poll fails.

Current RAT and preferred/configured mode are separate. Numeric RAT values are decoded only by a mapping confirmed for the active firmware profile; unknown values display their safe raw field/code and conflicting fields are reported without guessing. Debug logging records firmware-profile mismatches and safe RAT sources/codes. Logs redact IMEI/ICCID, telephone numbers, credentials, cookies, tokens, Digest material, SMS, and USSD payloads. For troubleshooting, enable debug logging, reproduce while the stock router network screen is visible, and share only anonymized XML summaries—never raw authentication or subscriber identifiers.
