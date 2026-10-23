# PocketDeck

Use any phone as a Stream Deck. PocketDeck runs on your PC and serves a web app to phones on the same Wi-Fi. There is nothing to install on the phone: scan a QR code and the deck opens in the browser.

## Features

- **Keys** with tap, hold and double-tap actions, icons or images, and an active state driven by OBS.
- **Sliders and dials** for system volume, per-app volume, screen brightness and OBS levels. They follow changes made on the PC.
- **Info tiles** for the clock, recording and stream timers, OBS FPS, CPU and memory, or a countdown.
- **Trackpad** to control the mouse pointer.
- **Profiles** that switch automatically with the program in front, chosen per phone.
- **Actions**: OBS scenes, recording, streaming, mute, sources, filters, replay buffer, virtual camera, studio mode and chapters; hotkeys (including push-to-talk), media keys, typing, opening apps and URLs, sounds on any output device, web requests and multi-step macros.

## Install

Download `PocketDeck-Setup-<version>.exe` from the latest release and run it. PocketDeck starts with Windows and lives in the system tray; closing the window keeps phones connected.

Windows asks whether to allow PocketDeck on the network the first time it runs. Allow it on **private** networks.

## Connect a phone

1. Put the phone on the same Wi-Fi as the PC.
2. In PocketDeck, click **Connect phone** and scan the QR code.
3. On iPhone use Share → Add to Home Screen for full screen. On Android use the full-screen button.

Each QR code works once and expires after 10 minutes; PocketDeck shows a fresh one by itself. Every phone gets its own secret, so you can **Remove** a single phone under *Paired phones*, or use **Unpair all phones** to disconnect everyone.

## Troubleshooting

| Problem | Try |
| --- | --- |
| The phone says the code expired | The code is single-use. Open **Connect phone** again and scan the new one. |
| The phone can't reach the PC | Same Wi-Fi? Allow PocketDeck on **private** networks in Windows Firewall. Pick the right network in the **Network** drop-down if the PC has several (VPN, VM adapters). |
| "Port 8787 is already in use" | Another copy of PocketDeck, or another program, uses the port. Quit it and start PocketDeck again. |
| OBS shows "offline" | In OBS: Tools → WebSocket Server Settings → enable it, then copy the password into PocketDeck's settings. |
| Something else | Open `%USERPROFILE%\.pocketdeck\pocketdeck.log` — errors are written there. |

## OBS

PocketDeck uses the WebSocket server built into OBS 28 and later. In OBS open **Tools → WebSocket Server Settings**, enable the server, then copy the password from **Show Connect Info** into PocketDeck's settings.

## Development

Requires Node.js 20 or later on Windows.

```bash
npm install
npm start        # run the desktop app
npm test         # unit and integration tests
npm run lint     # ESLint
npm run dist     # build the Windows installer into dist/
```

`npm run server` runs only the phone server in a terminal, without the editor. Sound playback needs the desktop app.

Configuration, images and sounds are stored in `%USERPROFILE%\.pocketdeck`. Errors are logged to `pocketdeck.log` in the same folder (the current and one previous file are kept).

Pushing a tag such as `v1.1.0` makes GitHub Actions build the installer and attach it to a release.

### Layout

| Path | Contents |
| --- | --- |
| `desktop/main.js` | Electron entry: window, tray, IPC |
| `desktop/server.js` | HTTP and WebSocket server for phones |
| `desktop/config.js` | Config storage and migrations |
| `desktop/actions.js` | Key actions: OBS, keyboard, mouse, web requests |
| `desktop/targets.js` | Values for sliders and dials |
| `desktop/native/winaudio.ps1` | Windows audio, brightness and foreground-app helper |
| `desktop/ui/` | Editor window |
| `phone/` | The web app served to phones |
| `test/` | Tests (`node --test`) |

## Security

The server listens on your local network only while PocketDeck runs. A phone pairs with a one-time code from the QR code and then holds its own random token; the PC keeps only a hash of it. Removing a phone disconnects it at once. The OBS password is encrypted with your Windows account, and neither it nor any token is ever sent to phones. The connection is plain HTTP, so use PocketDeck on trusted networks only. See [SECURITY.md](SECURITY.md).

## License

MIT
