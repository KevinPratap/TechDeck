# Changelog

## Unreleased

## 1.2.0

### Design
- A new look for the editor and the phone: deeper colours, glossy keys with a lit state that glows, glass top bar, smoother dialogs and key entrance animations. Respects reduced-motion settings.
- New logo and icons for the app, the tray and the phone. The iPhone Home Screen icon now works (PNG instead of SVG).
- The Connect dialog shows a countdown until the one-time code refreshes.
- Fixed the Connect dialog clipping its content on narrow windows.
- Long info-tile values such as timers (`00:18:07`) now fit their tile.
- Page tabs on the phone fade out at the edge instead of being cut off by the status badges.

### Project
- New README with screenshots, install guide, FAQ and troubleshooting, plus architecture notes in `docs/`.
- Contributing guide, code of conduct, issue and pull request templates, Dependabot and release-notes configuration.

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
