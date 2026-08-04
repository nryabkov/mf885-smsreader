# MF885 SMS Reader

MF885 SMS Reader is an English-language [Scriptable](https://scriptable.app/) dashboard for iPhone that connects directly to a ZMI MF855/MF885-family mobile router.

The script does **not** read or send messages through Apple Messages on the iPhone. Instead, it talks directly to the router over its local web interface, authenticates with HTTP Digest authentication, and uses the router XML API to read and send SMS messages stored on or sent through the router.

## What it does

- Loads every available SMS page, removes duplicate messages, and guards against firmware that repeats pages.
- Refreshes the dashboard automatically to check for new messages and router status changes.
- Displays cellular network, signal, battery, and mobile traffic information.
- Sends SMS messages and provides copy actions in a mobile-friendly WebView.
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
2. Run it once. The loader creates `mf885-smsreader-config.json` in Scriptable's **local** Documents directory. Edit that stable file (rather than the replaceable loader source) to select a fork, branch, router, and application storage:

   ```javascript
   {
     "repositoryOwner": "nryabkov",
     "repositoryName": "mf885-smsreader",
     "branch": "main",
     "routerAddress": "192.168.21.1",
     "storage": "local"
   }
   ```

3. Run the loader again after editing configuration. It asks GitHub's commits API for the configured branch HEAD, validates the full 40-character SHA, then fetches the manifest, loader, and every application file from raw GitHub URLs containing that exact SHA. A branch move between requests therefore cannot mix commits.
4. The router password is stored in Keychain as `mf885_router_password_<router address>`. An optional GitHub token may be stored as `mf885_github_token`; it is useful when unauthenticated API rate limits are too low. Neither secret is written to configuration or logs. Use a temporary Scriptable script to set or replace these Keychain values.
5. Keep the iPhone connected to the router Wi-Fi network while using the dashboard.

The loader uses Scriptable's local storage by default. Set `storage` to `icloud` only for the downloaded application and synchronization state. Loader discovery checks the script named by `Script.name()` in both local and iCloud Documents, requires the stable MF885 marker before overwriting it, and does not assume application storage is also loader storage.

### Update identity and transaction model

The configured branch's **commit SHA is the sole snapshot identity**. Every new commit advances it—even a documentation-only commit or a commit that retains optional display `version` metadata. Semantic versions never suppress synchronization.

Application files first download into `mf885-smsreader.staging-<sha>` beside the active `mf885-smsreader` directory. Each safe relative path must be present and non-empty. Only then is the active directory moved to `mf885-smsreader.backup` and the staged snapshot activated. The backup remains until the active SHA is recorded successfully; download, activation, or state-write failure rolls back and preserves the prior complete application.

The manifest-declared loader is also downloaded at the same SHA. It is validated for non-empty content and the stable marker, staged as a sibling `.mf885-staging` file, and backed up as `<Script name>.js.mf885-backup` before replacement. Loader code already executing does not change in memory. If the application requires a newer loader protocol, `mf885-smsreader-sync-state.json` records the target as pending, leaves the old application active, and displays **Loader updated; restart required**. The next invocation validates the replacement and finishes application activation. Unsupported application code is never launched early.

Synchronization state lives beside the application directory as `mf885-smsreader-sync-state.json` (in the selected storage) and contains active SHA, optional pending SHA, loader protocol, and status. It is written to `.tmp` and replaced only after successful activation. Missing/corrupt state or any missing/empty required artifact forces a full repair, even when the remote SHA equals the formerly active SHA.

### Migration, offline behavior, and troubleshooting

An installation containing only `mf885-smsreader/installed-version.txt` has no trustworthy commit identity: for example, version `2.0.0` corresponds to multiple commits. The loader announces migration and performs one complete synchronization. It removes the legacy file only after activation succeeds; failure retains the old application and legacy evidence.

GitHub commit lookup, rate-limit, malformed response, manifest, download, staging, and persistence errors are reported as **`[Sync warning]`** and the last complete local application is launched. A fatal installation error occurs only if no usable local entry exists. These messages are separate from **`[Router/startup error]`** failures such as `No authentication challenge`, which usually mean the phone is off the router Wi-Fi, the address is wrong, or router authentication failed.

Recovery procedures:

1. **Interrupted/bad loader replacement:** close Scriptable and restore `<Script name>.js.mf885-backup` over the loader. If its path cannot be verified, copy the repository's `loader.js` into a new Scriptable script manually; the application is deliberately left untouched.
2. **Corrupt state:** preserve the application and backups, then remove `mf885-smsreader-sync-state.json`. The next online run treats the commit as unknown and performs a full synchronization.
3. **Force a complete synchronization:** remove only the sync-state file (not `mf885-smsreader`), reconnect to the internet, and run the loader. Missing application files also trigger repair automatically.
4. **Rate limiting:** wait for GitHub's limit to reset or set a GitHub token in Keychain under `mf885_github_token`. Never paste a token into the loader or configuration.
5. **Offline use:** do nothing destructive. The loader reports the precise sync failure and runs the last complete snapshot. Restore connectivity only when an update is desired.

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
