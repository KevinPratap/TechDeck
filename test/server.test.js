const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const actions = require('../desktop/actions');
const { ConfigStore } = require('../desktop/config');
const { DeckServer } = require('../desktop/server');

// Record actions instead of pressing real keys or moving the real mouse.
const ran = [];
const held = [];
actions.run = async (action) => { ran.push(action); };
actions.pressKeys = async (combo) => { held.push(combo); return [combo]; };
actions.releaseKeys = async ([combo]) => { held.splice(held.indexOf(combo), 1); };
actions.mouseMove = async (dx, dy) => { ran.push({ type: 'move', dx, dy }); };

const PORT = 18790;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(urlPath) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: PORT, path: urlPath }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
  });
}

async function phone(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  const msgs = [];
  ws.on('message', (m) => msgs.push(JSON.parse(m)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
  return { ws, msgs, send: (m) => ws.send(JSON.stringify(m)) };
}

let server;
let cfg;
let deviceToken;

function post(urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test.before(async () => {
  cfg = new ConfigStore(fs.mkdtempSync(path.join(os.tmpdir(), 'pocketdeck-test-')));
  cfg.data.port = PORT;
  const action = (name) => ({ type: 'http', url: `http://x/${name}` });
  cfg.data.profiles = [{
    id: 'p', name: 'P', apps: [],
    pages: [{
      id: 'pg', name: 'Main', cols: 4, rows: 3,
      widgets: [
        { id: 'k', kind: 'key', x: 0, y: 0, w: 1, h: 1, action: action('tap'), hold: action('hold'), double: action('double') },
        { id: 'ptt', kind: 'key', x: 1, y: 0, w: 1, h: 1, action: { type: 'hotkey', keys: 'f24', mode: 'held' } },
        { id: 'pad', kind: 'trackpad', x: 2, y: 0, w: 2, h: 1 },
        { id: 'clock', kind: 'info', x: 0, y: 1, w: 1, h: 1, source: 'clocksec', action: { type: 'none' } },
      ],
    }],
  }];
  deviceToken = cfg.addDevice('Test phone');
  cfg.save();
  server = new DeckServer(cfg);
  server.obs.configure = () => {}; // no OBS in tests
  await server.start();
});

test.after(() => server.stop());

test('a wrong token is refused with close code 4001', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${'0'.repeat(32)}`);
  const code = await new Promise((resolve) => ws.on('close', resolve));
  assert.equal(code, 4001);
});

test('tap, hold and double-tap run their own actions', async () => {
  const p = await phone(deviceToken);
  ran.length = 0;
  for (const gesture of ['tap', 'hold', 'double']) p.send({ t: 'press', id: 'k', gesture });
  await wait(200);
  assert.deepEqual(ran.map((a) => a.url), ['http://x/tap', 'http://x/hold', 'http://x/double']);
  p.ws.close();
});

test('push-to-talk keys are released when the phone disconnects', async () => {
  const p = await phone(deviceToken);
  p.send({ t: 'down', id: 'ptt' });
  await wait(150);
  assert.deepEqual(held, ['f24']);
  p.ws.close();
  await wait(200);
  assert.deepEqual(held, []);
});

test('trackpad motion is clamped and ignored for other widgets', async () => {
  const p = await phone(deviceToken);
  ran.length = 0;
  p.send({ t: 'move', id: 'pad', dx: 99999, dy: -5 });
  p.send({ t: 'move', id: 'k', dx: 10, dy: 10 });
  await wait(200);
  assert.deepEqual(ran, [{ type: 'move', dx: 600, dy: -5 }]);
  p.ws.close();
});

test('info tiles push their text', async () => {
  const p = await phone(deviceToken);
  await wait(1300);
  const texts = Object.assign({}, ...p.msgs.filter((m) => m.texts).map((m) => m.texts));
  assert.match(texts.clock, /\d{1,2}:\d{2}:\d{2}/);
  p.ws.close();
});

test('static files: phone page, icons, and bad paths', async () => {
  assert.equal(await get('/'), 200);
  assert.equal(await get('/icons/mic.svg'), 200);
  assert.equal(await get('/..%2Fdesktop%2Fconfig.js'), 403);
  assert.equal(await get('/%E0'), 400);
  assert.equal(await get('/img/0000000000000000.png'), 404);
});

test('a busy port fails start() cleanly without an uncaught error', async () => {
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);
  const second = new DeckServer(cfg);
  second.obs.configure = () => {};
  await assert.rejects(second.start(), { code: 'EADDRINUSE' });
  await wait(100);
  process.off('uncaughtException', onUncaught);
  second.stop();
  assert.equal(uncaught, null);
});

test('malformed messages are ignored and the connection keeps working', async () => {
  const p = await phone(deviceToken);
  for (const raw of ['null', '[]', '"str"', '42', '{"t":"nope"}', '{"t":{}}', 'not json']) p.ws.send(raw);
  p.send({ t: 'ping', at: 7 });
  await wait(200);
  assert.ok(p.msgs.some((m) => m.t === 'pong' && m.at === 7));
  p.ws.close();
});

test('a phone that floods messages is throttled', async () => {
  const p = await phone(deviceToken);
  ran.length = 0;
  for (let i = 0; i < 700; i++) p.send({ t: 'press', id: 'k', gesture: 'tap' });
  await wait(500);
  assert.ok(ran.length > 0 && ran.length < 700, `ran ${ran.length} of 700`);
  p.ws.close();
});

test('a phone that stops answering pings is dropped and its keys released', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${deviceToken}`, { autoPong: false });
  await new Promise((resolve) => ws.on('open', resolve));
  const closed = new Promise((resolve) => ws.on('close', resolve));
  ws.send(JSON.stringify({ t: 'down', id: 'ptt' }));
  await wait(150);
  assert.deepEqual(held, ['f24']);
  server.checkClients(); // pings; no pong comes back
  await wait(100);
  server.checkClients(); // still silent: terminated
  await closed;
  await wait(100);
  assert.deepEqual(held, []);
});

test('pairing: the QR code works once, then a new one is issued', async () => {
  const code = server.pairing.code;
  const ok = await post('/pair', { code, name: 'Pixel 8' });
  assert.equal(ok.status, 200);
  assert.match(ok.body.token, /^[a-f0-9]{48}$/);
  assert.notEqual(server.pairing.code, code);
  assert.equal(cfg.deviceForToken(ok.body.token).name, 'Pixel 8');
  const p = await phone(ok.body.token); // the new token opens a connection
  p.ws.close();
  assert.equal((await post('/pair', { code, name: 'Replay' })).status, 403);
});

test('pairing: expired or wrong codes and bad bodies are refused', async () => {
  server.pairing.expires = Date.now() - 1;
  assert.equal((await post('/pair', { code: server.pairing.code })).status, 403);
  server.newPairing('test');
  assert.equal((await post('/pair', { code: 'f'.repeat(32) })).status, 403);
  assert.equal((await post('/pair', 'not json')).status, 400);
  assert.equal((await post('/nope', {})).status, 404);
  assert.equal((await post('/pair', { code: 12345 })).status, 403);
  server.pairFails.clear();
});

test('pairing: repeated wrong codes are rate limited', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/pair', { code: 'e'.repeat(32) });
  assert.equal(last.status, 429);
  assert.equal((await post('/pair', { code: server.pairing.code })).status, 429, 'even the right code waits out the block');
  server.pairFails.clear();
});

test('connections from another website are refused', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${deviceToken}`, { headers: { Origin: 'http://evil.example' } });
  const code = await new Promise((resolve) => ws.on('close', resolve));
  assert.equal(code, 4003);
  const same = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${deviceToken}`, { headers: { Origin: `http://127.0.0.1:${PORT}` } });
  await new Promise((resolve, reject) => { same.on('open', resolve); same.on('close', reject); });
  same.close();
});

test('removing a phone disconnects it right away and its token stops working', async () => {
  const token = cfg.addDevice('Doomed');
  const id = cfg.deviceForToken(token).id;
  const p = await phone(token);
  const closed = new Promise((resolve) => p.ws.on('close', resolve));
  assert.ok(server.revokeDevice(id));
  assert.equal(await closed, 4001);
  const again = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
  assert.equal(await new Promise((resolve) => again.on('close', resolve)), 4001);
  assert.equal(server.revokeDevice('nope'), false);
});

test('"unpair all" disconnects every phone and retires the old QR code', async () => {
  const token = cfg.addDevice('Another');
  const p = await phone(token);
  const closed = new Promise((resolve) => p.ws.on('close', resolve));
  const oldCode = server.pairing.code;
  server.resetToken();
  assert.equal(await closed, 4001);
  assert.notEqual(server.pairing.code, oldCode);
  assert.equal(cfg.data.devices.length, 0);
  deviceToken = cfg.addDevice('Test phone'); // later tests, if any, still have a valid phone
});
