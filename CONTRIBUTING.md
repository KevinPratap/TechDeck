# Contributing

Thanks for helping make PocketDeck better. Small fixes, bug reports and ideas are all welcome.

## Getting set up

```bash
git clone https://github.com/KevinPratap/TechDeck.git
cd TechDeck
npm install
npm start
```

You need Node.js 20 or later. The desktop app targets Windows; the server, phone app and tests also run on macOS and Linux.

## Before you open a pull request

```bash
npm run lint
npm test
```

Both must pass. CI runs them on Windows for every pull request.

- Keep a change focused. One fix or feature per pull request is easier to review.
- Add or update a test when you change behaviour, especially in `desktop/config.js` and `desktop/server.js`.
- Follow the style that is already there. ESLint enforces the basics (`const`, `===`, no unused variables).
- Touching the phone app or the editor? Include a screenshot in the pull request.
- Add a line to the "Unreleased" part of [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

## Reporting bugs and ideas

Use the issue templates. For a bug, the app version, your Windows version and the last lines of `%USERPROFILE%\.pocketdeck\pocketdeck.log` help a lot. **Do not post QR codes, tokens or your OBS password.**

Security problems should not go in public issues. See [SECURITY.md](SECURITY.md).

## Project layout

See the table in the [README](README.md#development) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
