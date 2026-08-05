# MF885 SMS Reader

MF885 SMS Reader is an English-language [Scriptable](https://scriptable.app/) dashboard for iPhone that connects directly to a ZMI MF855/MF885-family mobile router.

The script does **not** read or send messages through Apple Messages on the iPhone. Instead, it talks directly to the router over its local web interface, authenticates with HTTP Digest authentication, and uses the router XML API to read and send SMS messages stored on or sent through the router.

## What it does

- Loads every available SMS page, removes duplicate messages, and guards against firmware that repeats pages.
- Refreshes the dashboard automatically to check for new messages and router status changes.
- Displays cellular network, signal, battery, and mobile traffic information.
- Sends SMS messages and provides copy actions in a mobile-friendly WebView, including a manual selectable fallback when iOS/WebView clipboard access is unavailable.
- Translates SMS only after tapping **Перевести**. Without an endpoint, there is no automatic translation: the dashboard tries to copy the SMS text for manual use in Apple Translate and shows a selectable fallback if clipboard access fails. With optional `TRANSLATE_ENDPOINT` advanced setup, a LibreTranslate-compatible service returns the translation inline in the SMS card and reports HTTP/JSON/empty-response diagnostics in the WebView status block. The dashboard does not start automatic bulk translation when opened.
- Deletes individual SMS messages from the router after confirmation.
- Resets total WAN traffic and provides confirmed restart and power-off controls.
- Probes known hidden firmware endpoints and allows an experimental USSD attempt even when safe detection is inconclusive.
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

1. Copy `loader.js` into a new script in the Scriptable iOS app.
2. Run it. That is sufficient when using this repository's `main` branch, Scriptable's local application storage, a router at `192.168.21.1`, and the initial router password `zimifi`. During the same run, the loader downloads and launches the application and creates `mf885-smsreader-config.json` automatically in Scriptable's **local** Documents directory.
3. Edit `mf885-smsreader-config.json` only if you need to use a fork, a non-default branch, a different router address, or iCloud application storage. The stable configuration file (rather than the replaceable loader source) contains these settings:

   ```javascript
   {
     "repositoryOwner": "nryabkov",
     "repositoryName": "mf885-smsreader",
     "branch": "main",
     "routerAddress": "192.168.21.1",
     "storage": "local"
   }
   ```

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

The WebView contains a reusable action status panel for copy, translation, refresh, and JavaScript diagnostics. If iOS or Scriptable denies `navigator.clipboard`, **Копировать** and the no-endpoint **Перевести** flow show the SMS text in a read-only selectable field so you can copy it manually.

`TRANSLATE_ENDPOINT` is empty by default, so automatic translation is not configured. In that default mode, **Перевести** means “copy for translation”: the script tries to place the SMS text in the clipboard for Apple Translate. To get inline automatic translation, configure a LibreTranslate-compatible endpoint in `scriptable.js`; endpoint failures now include HTTP status, JSON parsing, or empty-response details in the diagnostics panel.

Dashboard refreshes use Scriptable's `scriptable:///run` callback URL, which can close and relaunch the running script. Before manual or automatic refresh, the UI warns that Scriptable is restarting the script and prevents repeated rapid taps/navigation while the transition is in progress, avoiding refresh loops that can look like the app is blinking. Dangerous router actions such as **Restart**, **Power off**, and **Reset traffic** are now confirmed inline inside the WebView on the first tap; Scriptable is relaunched only after the final confirmation tap sends the command with `confirm=1`. If the screen closes during refresh or final command execution, open the Scriptable script again.

### Power endpoint diagnostics

MF855/MF885-family firmware variants expose restart and shutdown through different internal endpoints. If **Restart** or **Power off** is not confirmed by the router, copy the diagnostics shown in the Power/action status panel and include them in an issue or support message. The diagnostics intentionally list safe endpoint details such as `xml_action.cgi?method=set&module=duster&file=...`, XML root/field names, and `routerCall()` object path/method attempts, but not the router password, digest nonce response, or sensitive headers. If possible, also capture the matching request from the router's native web UI with a packet capture or browser/network proxy so the working firmware endpoint can be added safely.

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
