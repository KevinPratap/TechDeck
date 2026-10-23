# Changelog

## 1.1.0

### Security
- Each phone now pairs separately. The QR code holds a one-time code that works once and expires after 10 minutes; the phone trades it for its own secret token. Tokens are stored only as hashes.
- Paired phones are listed in the connect dialog, each with a **Remove** button. **Unpair all phones** still works.
- Phones paired with 1.0.0 keep working after the upgrade (shown as "Phone paired earlier") until you remove them.
- The OBS password is encrypted with your Windows account instead of sitting in plain text in the config file.
- WebSocket connections from other websites are refused (origin check).
- Pairing attempts are rate limited per address.
- Settings sent by the editor are validated before they are saved or run.

### Reliability
- Phones that go to sleep or leave the Wi-Fi are detected and dropped, and any push-to-talk key they held is released.
- Malformed or flooding messages from a phone are ignored.
- The log file is capped (it keeps the current and one previous file).
- Settings that cannot be saved now show the reason in the activity log.

### Project
- Continuous integration (lint, tests, installer build on version tags).
- More tests: pairing, revoking, migration, validation, encryption, throttling and heartbeat.
- The installer is now named `PocketDeck-Setup-<version>.exe`.

## 1.0.0
- First release.
