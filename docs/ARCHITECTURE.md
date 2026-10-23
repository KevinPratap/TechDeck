# Architecture

PocketDeck is two programs that share one folder:

- **The desktop app** (`desktop/`), an Electron tray app. It owns the config, runs the server and carries out actions on the PC.
- **The phone app** (`phone/`), plain HTML, CSS and JavaScript without a build step. The server serves it as static files.

```
phone browser ──HTTP──▶ /            static phone app
              ──POST──▶ /pair        trade a one-time code for a device token
              ──WS────▶ /ws?token=…  deck, taps and live values
```

## Pairing

1. The server keeps one **pairing code** in memory (16 random bytes). It is shown as a QR code, works once, and is replaced after 10 minutes, after use and when phones are unpaired.
2. The phone sends `POST /pair {code, name}`. On success the server creates a **device** with its own random token and replies `{token}`. Only `sha256(token)` is stored in `pocketdeck.json`.
3. The phone opens `/ws?token=…`. The server looks the token up (constant-time compare), rejects other origins, and registers the connection.
4. Removing a device deletes its hash and closes its sockets with code `4001`.

Failed pairings are limited to 10 per minute per address.

## WebSocket messages

Phone to PC (`t` is the type; everything else is validated and clamped):

| `t` | Fields | Meaning |
| --- | --- | --- |
| `press` | `id`, `gesture` (`tap`, `hold`, `double`) | Run a key's action |
| `down`, `up` | `id` | Hold a key down (push-to-talk) |
| `value` | `id`, `v` (0..1) | Move a slider |
| `turn` | `id`, `steps` | Turn a dial |
| `move`, `click`, `scroll` | `id`, … | Trackpad |
| `ping` | `at` | Latency check |

PC to phone: `deck` (profiles, pages and widgets without secrets), `state` (active keys, values, texts, OBS state), `values` (changed values and texts), `focus` (which profile the program in front calls for), `result` (success or error of an action), `pong`.

Each connection is limited to 300 messages per second, and phones that stop answering pings every 15 seconds are dropped, which also releases any held keys.

## Config

`pocketdeck.json` holds profiles, pages and widgets, the OBS address and password (the password is encrypted with Electron `safeStorage` on disk), and the paired devices. `config.js` migrates old versions on load and keeps a `.bak` of the previous file. Everything the editor sends is validated by `validateProfiles` and `validateObs` before it is saved.

## Windows helpers

Volume, per-app volume, brightness and the foreground program come from `desktop/native/winaudio.ps1`, a long-running PowerShell process that talks JSON lines over stdin and stdout. Keyboard and mouse input use `nut.js`.
