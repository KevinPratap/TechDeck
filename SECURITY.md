# Security

PocketDeck lets a paired phone press keys, type text, open programs and links, and send web requests on your PC. Treat a paired phone like a keyboard that is plugged into your computer.

## How pairing works
- The QR code contains a one-time code. It works once and expires after 10 minutes.
- The phone trades the code for its own secret token and keeps it in the browser. The PC stores only a hash of each token.
- Remove a phone in **Connect phone → Paired phones**, or use **Unpair all phones**. Removed phones are disconnected immediately.

## What to know
- The connection uses plain HTTP and WebSocket on your local network. Anyone who can watch your Wi-Fi traffic could read it, so use PocketDeck only on networks you trust (home, your own hotspot), and allow it in Windows Firewall on **private** networks only.
- Do not show the QR code on stream. It is single-use, but it still pairs whoever scans it first.
- The OBS password is stored encrypted with your Windows account.

## Reporting a problem
Please [open a private security advisory](https://github.com/KevinPratap/TechDeck/security/advisories/new) rather than a public issue.
