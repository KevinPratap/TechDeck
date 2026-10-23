// Runs the deck server without the Electron window: `npm run server`.
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');
const { ConfigStore } = require('./config');
const { DeckServer } = require('./server');

const dir = process.env.POCKETDECK_DIR || path.join(os.homedir(), '.pocketdeck');
const server = new DeckServer(new ConfigStore(dir));
server.on('log', (l) => console.log('[press]', l));
server.on('clients', (c) => console.log(`[server] ${c.length} phone(s) connected`));

async function showPairing() {
  const [first, ...rest] = server.urls();
  if (!first) return console.log('No network adapter found. Is Wi-Fi connected?');
  console.log('\nScan with your phone camera (the code works once, for 10 minutes):\n');
  console.log(await QRCode.toString(first.url, { type: 'terminal', small: true }));
  console.log(`  ${first.url}   (${first.name})`);
  for (const r of rest) console.log(`  ${r.url}   (${r.name})`);
  console.log(`\nConfig: ${server.config.file}`);
}

server.start().then(() => {
  showPairing();
  // A used or expired code is replaced; show the new one so the next phone can pair.
  server.on('pairing', (reason) => { if (reason === 'paired' || reason === 'reset') showPairing(); });
});
