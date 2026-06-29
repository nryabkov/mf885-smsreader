# MF885 SMS Reader

MF885 SMS Reader is a [Scriptable](https://scriptable.app/) script for iPhone that connects to a ZMI/MF885-family mobile router and works with the router's built-in SMS module.

The script does **not** read or send messages through Apple Messages on the iPhone. Instead, it talks directly to the router over its local web interface, authenticates with HTTP Digest authentication, and uses the router XML API to read and send SMS messages stored on or sent through the router.

## What it does

- Prompts you to either open the SMS inbox or send an SMS.
- Logs in to the router at the configured local IP address.
- Retrieves received SMS messages from the router XML API.
- Displays messages in a mobile-friendly WebView with search, copy-all, copy-text, and copy-full actions.
- Sends SMS messages through the router and displays the router response.
- Decodes router SMS fields that are returned as UTF-16BE hexadecimal strings.

## Prerequisites

- An iPhone with the Scriptable app installed.
- A ZMI/MF885-family router with SMS support and accessible local web interface.
- The iPhone connected to the router's Wi-Fi network.
- The router administrator username and password.
- The router's local IP address. The script defaults to `192.168.21.1`.

## Setup

1. Copy `scriptable.js` into a new script in the Scriptable iOS app.
2. Edit the configuration constants at the top of the script:

   ```javascript
   const ROUTER_HOST = "192.168.21.1";
   const USERNAME = "admin";
   const PASSWORD = "YOUR_PASSWORD_HERE";
   const PAGE = 1;
   ```

3. Replace `PASSWORD` with your own router administrator password before running the script; the placeholder value will not work.
4. Change `ROUTER_HOST` if your router uses a different local IP address.
5. Keep the iPhone connected to the router Wi-Fi network while running the script.

## Run instructions

There is no package manifest or build step in this repository. Run the script directly in Scriptable:

1. Open Scriptable on the iPhone.
2. Open the script containing `scriptable.js`.
3. Tap Run.
4. Choose one of the actions in the prompt:
   - Open inbox
   - Send SMS

For local development, you can run a JavaScript syntax check with Node.js:

```bash
node --check scriptable.js
```

The Scriptable-specific APIs such as `Alert`, `Request`, and `WebView` are only available inside the Scriptable app, so the script cannot be fully executed in a normal Node.js runtime without mocks.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
