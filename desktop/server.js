// LAN server: serves the phone web app and talks to phones over WebSocket.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const { ObsBridge } = require('./obs');
const actions = require('./actions');
const { Targets } = require('./targets');
const { MediaStore } = require('./media');
const { Info } = require('./info');

const PHONE_DIR = path.join(__dirname, '..', 'phone');
const ICON_DIR = path.join(path.dirname(require.resolve('lucide-static/package.json')), 'icons');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

// IPv4 addresses a phone on the same network can reach, Wi-Fi first, VMs last.
function lanAddresses() {
  const virtual = /virtual|vmware|vbox|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier/i;
  const wifi = /wi-?fi|wlan|wireless|^en0$/i;
  const rank = ({ name, address }) => {
    // 192.168.56.x is VirtualBox's host-only network, often named just "Ethernet N".
    if (virtual.test(name) || address.startsWith('192.168.56.') || address.startsWith('169.254.')) return 2;
    return wifi.test(name) ? 0 : 1;
  };
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ name, address: a.address });
    }
  }
  return list.sort((a, b) => rank(a) - rank(b));
}

// A phone that stops answering pings for this long is dropped.
const HEARTBEAT_MS = 15000;
// Per connection: more messages than this in one second are ignored (a flood, not a finger).
const MAX_MSGS_PER_SEC = 300;
// A pairing code (the QR code) works once and for this long.
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_FAILS_PER_MIN = 10;
const MESSAGE_TYPES = new Set(['press', 'down', 'up', 'value', 'turn', 'move', 'click', 'scroll', 'ping']);

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class DeckServer extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.obs = new ObsBridge();
    this.clients = new Set();
    this.targets = new Targets(this.obs);
    this.values = {};   // widget id -> 0..1, the last value we know of
    this.texts = {};    // widget id -> display text
    this.chains = new Map();   // widget id -> promise, so turns on one widget run in order
    this.inflight = new Map(); // widget id -> jobs not finished yet
    this.lastError = new Map();
    this.media = new MediaStore(config.dir);
    this.info = new Info(this.obs);
    this.sound = null;         // set by the desktop app: (action) => Promise
    this.moves = new Map();    // trackpad id -> { dx, dy, running }: pointer motion waiting to be applied
    this.focus = { profile: null, app: '' }; // which profile the program in front calls for
    this.held = new Map();     // widget id -> { keys, client, timer } for push-to-talk keys
    this.obs.on('state', () => this.broadcast(this.stateMessage()));
    this.pairing = null;
    this.pairFails = new Map(); // ip -> { n, at }
    this.newPairing('start');
  }

  // A fresh one-time code for the QR. 'reason' tells listeners why it changed.
  newPairing(reason) {
    this.pairing = { code: crypto.randomBytes(16).toString('hex'), expires: Date.now() + PAIR_TTL_MS };
    this.emit('pairing', reason);
  }

  start() {
    const port = this.config.data.port;
    this.http = http.createServer((req, res) => (req.method === 'POST' ? this.handlePost(req, res) : this.serveStatic(req, res)));
    this.wss = new WebSocketServer({ server: this.http, path: '/ws', maxPayload: 64 * 1024 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));
    // Listen errors (such as a busy port) are reported by start(); the WebSocket server only repeats them.
    this.wss.on('error', () => {});
    this.obs.configure(this.config.data.obs);
    this.pairTimer = setInterval(() => { if (Date.now() >= this.pairing.expires) this.newPairing('expired'); }, 30000);
    this.heartbeat = setInterval(() => this.checkClients(), this.heartbeatMs || HEARTBEAT_MS);
    this.poller = setInterval(() => this.pollValues(), 600);
    this.infoTimer = setInterval(() => this.tickInfo(), 1000);
    this.focusTimer = setInterval(() => this.pollFocus(), 1000);
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(port, '0.0.0.0', () => {
        console.log(`[server] listening on port ${port}`);
        resolve();
      });
    });
  }

  urls() {
    const { port } = this.config.data;
    return lanAddresses().map((a) => ({ ...a, expires: this.pairing.expires, url: `http://${a.address}:${port}/#${this.pairing.code}` }));
  }

  // POST /pair { code, name } -> { token }: trades the one-time code for this phone's own token.
  handlePost(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (new URL(req.url, 'http://x').pathname !== '/pair') return reply(404, { error: 'Not found' });

    const ip = req.socket.remoteAddress;
    const now = Date.now();
    const f = this.pairFails.get(ip);
    if (f && now - f.at < 60000 && f.n >= PAIR_FAILS_PER_MIN) return reply(429, { error: 'Too many attempts. Wait a minute.' });

    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 2048) req.destroy();
    });
    req.on('error', () => {});
    req.on('end', () => {
      let m;
      try { m = JSON.parse(body); } catch { return reply(400, { error: 'Bad request' }); }
      const ok = m && typeof m.code === 'string' && now < this.pairing.expires && safeEqual(m.code, this.pairing.code);
      if (!ok) {
        const cur = f && now - f.at < 60000 ? f : { n: 0, at: now };
        cur.n++;
        this.pairFails.set(ip, cur);
        return reply(403, { error: 'This code has expired or was already used.' });
      }
      this.pairFails.delete(ip);
      const token = this.config.addDevice(m.name);
      this.newPairing('paired'); // the code that was just used is dead
      this.emit('devices', this.config.publicDevices());
      this.emit('log', 'Phone paired: ok');
      reply(200, { token });
    });
  }

  serveStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (file, type, cache) => {
      const stream = fs.createReadStream(file);
      stream.on('error', () => { if (!res.headersSent) res.writeHead(404); res.end(); });
      stream.on('open', () => {
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': cache });
        if (req.method === 'HEAD') { stream.destroy(); res.end(); } else stream.pipe(res);
      });
    };

    // Uploaded images and sounds are named by content hash, so they never change.
    const stored = this.media.resolve(urlPath);
    if (stored) return send(stored.file, stored.type, 'public, max-age=31536000, immutable');

    const icon = /^\/icons\/([a-z0-9-]+)\.svg$/.exec(urlPath);
    if (icon) return send(path.join(ICON_DIR, `${icon[1]}.svg`), 'image/svg+xml', 'public, max-age=86400');

    const file = path.normalize(path.join(PHONE_DIR, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(PHONE_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    send(file, TYPES[path.extname(file)] || 'application/octet-stream', 'no-cache');
  }

  onConnection(ws, req) {
    // A web page on another site must not be able to talk to the deck, even from a paired phone's browser.
    const origin = req.headers.origin;
    if (origin) {
      let same = false;
      try { same = new URL(origin).host === req.headers.host; } catch { /* malformed */ }
      if (!same) {
        ws.close(4003, 'bad origin');
        return;
      }
    }
    const device = this.config.deviceForToken(new URL(req.url, 'http://x').searchParams.get('token'));
    if (!device) {
      ws.close(4001, 'bad token');
      return;
    }
    this.config.touchDevice(device.id);
    this.emit('devices', this.config.publicDevices());
    const client = { id: device.id, name: device.name, ws, addr: req.socket.remoteAddress, ua: req.headers['user-agent'] || '', alive: true, windowStart: Date.now(), count: 0 };
    ws.on('pong', () => { client.alive = true; });
    ws.on('error', () => {}); // a broken socket closes itself; 'close' below cleans up
    this.clients.add(client);
    this.emitClients();
    ws.send(JSON.stringify({ t: 'deck', ...this.config.publicDeck() }));
    ws.send(JSON.stringify(this.stateMessage()));
    ws.send(JSON.stringify({ t: 'focus', ...this.focus }));
    this.tickInfo();

    ws.on('message', (raw) => {
      client.alive = true;
      if (this.throttled(client)) return;
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || !MESSAGE_TYPES.has(msg.t)) return;
      try {
        this.dispatch(client, msg);
      } catch (e) {
        this.emit('log', `bad message: ${e.message}`);
      }
    });
    ws.on('close', () => {
      this.clients.delete(client);
      for (const [id, h] of this.held) if (h.client === client) this.keyUp(id); // a lost phone must not leave keys stuck down
      this.emitClients();
    });
  }

  dispatch(client, msg) {
    if (msg.t === 'press') this.press(client, msg);
    else if (msg.t === 'down') this.keyDown(client, msg);
    else if (msg.t === 'up') this.keyUp(msg.id);
    else if (msg.t === 'value') this.onValue(client, msg);
    else if (msg.t === 'turn') this.onTurn(client, msg);
    else if (msg.t === 'move' || msg.t === 'click' || msg.t === 'scroll') this.onPointer(client, msg);
    else if (msg.t === 'ping') client.ws.send(JSON.stringify({ t: 'pong', at: msg.at }));
  }

  // True when this phone is sending faster than a person could.
  throttled(client) {
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.count = 0;
    }
    return ++client.count > MAX_MSGS_PER_SEC;
  }

  // Phones that went to sleep or left the Wi-Fi never say goodbye: ping them and drop the silent ones.
  checkClients() {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate(); // fires 'close', which releases held keys
        continue;
      }
      c.alive = false;
      try { c.ws.ping(); } catch { /* closing already */ }
    }
  }

  // What an action can use besides the keyboard: OBS and the sound player.
  runAction(action) {
    return actions.run(action, { obs: this.obs, sound: this.sound });
  }

  // Push-to-talk: a hotkey set to "hold" stays down from finger-down to finger-up.
  async keyDown(client, { id }) {
    const w = this.config.findWidget(id);
    if (!w || w.kind !== 'key' || w.action.type !== 'hotkey' || w.action.mode !== 'held' || this.held.has(id)) return;
    try {
      const keys = await actions.pressKeys(w.action.keys);
      // Failsafe: release after a minute even if the "up" never arrives.
      this.held.set(id, { keys, client, timer: setTimeout(() => this.keyUp(id), 60000) });
    } catch (e) {
      this.failed(client, id, e);
    }
  }

  async keyUp(id) {
    const h = this.held.get(id);
    if (!h) return;
    this.held.delete(id);
    clearTimeout(h.timer);
    await actions.releaseKeys(h.keys).catch(() => {});
  }

  // A key was tapped, held or double-tapped on a phone.
  async press(client, { id, gesture }) {
    const w = this.config.findWidget(id);
    let action = null;
    if (w && (w.kind === 'key' || w.kind === 'info')) {
      action = gesture === 'hold' ? w.hold : gesture === 'double' ? w.double : w.action;
    } else if (w && w.kind === 'dial') {
      action = w.press;
    }
    if (!action || action.type === 'none') return;
    const reply = { t: 'result', id, ok: true };
    try {
      await this.runAction(action);
      this.emit('log', `${w.label || 'key'}: ok`);
    } catch (e) {
      reply.ok = false;
      reply.error = e.message;
      this.emit('log', `${w.label || 'key'}: ${e.message}`);
    }
    client.ws.send(JSON.stringify(reply));
  }

  // Runs fn after the previous job for this widget, so quick turns don't race.
  queue(id, fn) {
    this.inflight.set(id, (this.inflight.get(id) || 0) + 1);
    const next = (this.chains.get(id) || Promise.resolve()).then(fn, fn)
      .finally(() => this.inflight.set(id, this.inflight.get(id) - 1));
    this.chains.set(id, next.catch(() => {}));
    return next;
  }

  // Tell a phone about a failed control at most every 2 seconds per widget.
  failed(client, id, e) {
    const now = Date.now();
    if (now - (this.lastError.get(id) || 0) < 2000) return;
    this.lastError.set(id, now);
    client.ws.send(JSON.stringify({ t: 'result', id, ok: false, error: e.message }));
    this.emit('log', `control: ${e.message}`);
  }

  setValue(id, r, except) {
    this.values[id] = r.v;
    this.texts[id] = r.text;
    this.broadcast({ t: 'values', values: { [id]: r.v }, texts: { [id]: r.text } }, except);
  }

  onValue(client, { id, v }) {
    const w = this.config.findWidget(id);
    if (!w || w.kind !== 'slider' || typeof v !== 'number') return;
    this.queue(id, async () => {
      try { this.setValue(id, await this.targets.set(w.target, v), client); } catch (e) { this.failed(client, id, e); }
    });
  }

  onTurn(client, { id, steps }) {
    const w = this.config.findWidget(id);
    steps = Math.max(-20, Math.min(20, Math.trunc(Number(steps)) || 0));
    if (!w || w.kind !== 'dial' || !steps) return;
    this.queue(id, async () => {
      try {
        if (w.mode === 'relative') {
          const action = steps > 0 ? w.cw : w.ccw;
          for (let i = 0; i < Math.abs(steps); i++) await this.runAction(action || { type: 'none' });
        } else {
          const size = (Number(w.step) || 2) / 100;
          this.setValue(id, await this.targets.step(w.target, steps, size), client);
        }
      } catch (e) {
        this.failed(client, id, e);
      }
    });
  }

  // Trackpad widget: relative mouse motion, clicks and scrolling.
  onPointer(client, m) {
    const w = this.config.findWidget(m.id);
    if (!w || w.kind !== 'trackpad') return;
    const num = (v, max) => Math.max(-max, Math.min(max, Math.round(Number(v)) || 0));
    if (m.t === 'move') {
      // Motion arrives faster than the OS can apply it, so add it up and apply in one go.
      const q = this.moves.get(m.id) || { dx: 0, dy: 0, running: false };
      this.moves.set(m.id, q);
      q.dx += num(m.dx, 600);
      q.dy += num(m.dy, 600);
      if (q.running) return;
      q.running = true;
      (async () => {
        try {
          while (q.dx || q.dy) {
            const { dx, dy } = q;
            q.dx = 0;
            q.dy = 0;
            await actions.mouseMove(dx, dy);
          }
        } catch (e) {
          this.failed(client, m.id, e);
        } finally {
          q.running = false;
        }
      })();
      return;
    }
    this.queue(m.id, async () => {
      try {
        if (m.t === 'click') await actions.mouseClick(m.button === 'right' ? 'right' : 'left');
        else await actions.mouseScroll(num(m.steps, 20));
      } catch (e) {
        this.failed(client, m.id, e);
      }
    });
  }

  // Watches which program is in front, so phones in auto mode can switch profile.
  async pollFocus() {
    if (!this.clients.size || this.focusing || process.platform !== 'win32' || !this.config.hasAppRules()) return;
    this.focusing = true;
    try {
      const { process: app } = await this.targets.win.call('foreground');
      const profile = this.config.profileForApp(app);
      // Only change when a rule matches a different profile; a program with no rule keeps the last profile.
      if (profile && profile !== this.focus.profile) {
        this.focus = { profile, app };
        this.broadcast({ t: 'focus', ...this.focus });
      }
    } catch { /* helper not ready yet */ } finally {
      this.focusing = false;
    }
  }

  // Phones should follow changes made on the PC (volume keys, OBS mixer...).
  async pollValues() {
    if (!this.clients.size || this.polling) return;
    this.polling = true;
    try {
      const values = {};
      const texts = {};
      for (const w of this.config.allWidgets()) {
        const t = w.kind === 'slider' || (w.kind === 'dial' && w.mode !== 'relative') ? w.target : null;
        if (!t || (this.targets.needsObs(t) && !this.obs.connected)) continue;
        if (this.inflight.get(w.id) > 0) continue; // a phone is changing it right now
        try {
          const r = await this.targets.get(t);
          if (this.values[w.id] === undefined || Math.abs(r.v - this.values[w.id]) > 0.004 || r.text !== this.texts[w.id]) {
            this.values[w.id] = r.v;
            this.texts[w.id] = r.text;
            values[w.id] = r.v;
            texts[w.id] = r.text;
          }
        } catch { /* app not playing, OBS closed... try again next time */ }
      }
      if (Object.keys(values).length) this.broadcast({ t: 'values', values, texts });
    } finally {
      this.polling = false;
    }
  }

  stateMessage() {
    const s = this.obs.snapshot();
    const active = {};
    for (const w of this.config.allWidgets()) {
      if (w.kind === 'key' && actions.isActive(w.action, s)) active[w.id] = true;
    }
    return { t: 'state', active, values: this.values, texts: this.texts, obs: { connected: s.connected, recording: s.recording, streaming: s.streaming, scene: s.scene } };
  }

  broadcast(msg, except) {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c !== except) c.ws.send(data);
  }

  // Called by the editor after pages or OBS settings change.
  applyConfig(patch) {
    const obsChanged = patch.obs && JSON.stringify(patch.obs) !== JSON.stringify(this.config.data.obs);
    this.config.update(patch);
    if (obsChanged) this.obs.configure(this.config.data.obs);
    this.broadcast({ t: 'deck', ...this.config.publicDeck() });
    this.broadcast(this.stateMessage());
  }

  // Unpairs every phone; they need a new QR code.
  resetToken() {
    this.config.revokeAll();
    for (const c of this.clients) c.ws.close(4001, 'unpaired');
    this.newPairing('reset');
    this.emit('devices', this.config.publicDevices());
  }

  revokeDevice(id) {
    if (!this.config.revokeDevice(id)) return false;
    for (const c of this.clients) if (c.id === id) c.ws.close(4001, 'unpaired');
    this.emit('devices', this.config.publicDevices());
    return true;
  }

  // Refreshes the text of info tiles (clock, timers, stats) and tells phones what changed.
  async tickInfo() {
    if (!this.clients.size || this.ticking) return;
    this.ticking = true;
    try {
      const texts = {};
      for (const w of this.config.allWidgets()) {
        if (w.kind !== 'info') continue;
        let text;
        try { text = await this.info.text(w); } catch { text = '–'; }
        if (text !== this.texts[w.id]) {
          this.texts[w.id] = text;
          texts[w.id] = text;
        }
      }
      if (Object.keys(texts).length) this.broadcast({ t: 'values', values: {}, texts });
    } finally {
      this.ticking = false;
    }
  }

  stop() {
    clearInterval(this.pairTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.poller);
    clearInterval(this.infoTimer);
    clearInterval(this.focusTimer);
    for (const id of [...this.held.keys()]) this.keyUp(id);
    this.targets.stop();
    this.obs.stop();
    for (const c of this.clients) c.ws.terminate();
    if (this.wss) this.wss.close();
    if (this.http) this.http.close();
  }

  emitClients() {
    this.emit('clients', [...this.clients].map((c) => ({ id: c.id, name: c.name, addr: c.addr, ua: c.ua })));
  }
}

module.exports = { DeckServer, lanAddresses };
