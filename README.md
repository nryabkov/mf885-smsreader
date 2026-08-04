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

## Recommended setup: self-updating loader

The repository keeps the updater, manifest, application, and feature modules side by side:

- `loader.js` is the Scriptable entry point that you install once.
- `manifest.json` is the loader's only remote endpoint and lists every file in a release.
- `scriptable.js` is the application module downloaded by the loader.
- `modules/ussd.js` contains the firmware-specific USSD probing and request variants.

1. Copy `loader.js` into a new script in the Scriptable iOS app.
2. In `loader.js`, verify the repository and router settings:

   ```javascript
   const MANIFEST_URL =
     "https://raw.githubusercontent.com/nryabkov/mf885-smsreader/main/manifest.json";
   const ROUTER_IP = "192.168.21.1";
   const DEFAULT_ROUTER_PASSWORD = "zimifi";
   const USE_ICLOUD = false;
   ```

3. Run the loader. It reads the single manifest endpoint, expands its file list into a local application directory, and starts the entry module's exported `run(options)` function.
4. The loader stores the router password in iOS Keychain on first run. If you change the router password later, remove the `zmifi_pass_<router IP>` Keychain entry or update it from a temporary Scriptable script.
5. Keep the iPhone connected to the router Wi-Fi network while using the dashboard.

The loader uses Scriptable's local storage by default. Set `USE_ICLOUD` to `true` only if you want the downloaded application and its last known Git commit to be synchronized through iCloud Drive.

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
