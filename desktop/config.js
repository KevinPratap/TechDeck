// Loads and saves the deck config as JSON.
//
//   profiles: [{ id, name, apps: ['obs64', ...], pages: [...] }]
//   page:     { id, name, cols, rows, widgets: [...] }
//   widget:   { id, kind, x, y, w, h, ...settings }   kinds: key, slider, dial, info, trackpad
//
// A phone shows one profile. In "auto" mode it follows whichever program is in
// front on the PC: the first profile that lists that program in `apps`.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 5;
const id = () => crypto.randomBytes(4).toString('hex');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

// What the editor may change. Anything else in a patch is dropped.
const PATCH_KEYS = ['profiles', 'obs', 'autostart'];
const KINDS = new Set(['key', 'slider', 'dial', 'info', 'trackpad']);
const ACTION_FIELDS = ['action', 'hold', 'double', 'press', 'cw', 'ccw'];
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

function validateAction(a, depth = 0) {
  if (!isObj(a) || typeof a.type !== 'string') throw new Error('An action needs a type');
  if (depth > 5) throw new Error('Macros are nested too deeply');
  if (a.type === 'multi') {
    if (!Array.isArray(a.steps) || a.steps.length > 50) throw new Error('A macro can have up to 50 steps');
    for (const step of a.steps) validateAction(step, depth + 1);
  }
}

// Throws a readable error when the editor sends something the server can't safely run.
function validateProfiles(profiles) {
  if (!Array.isArray(profiles) || !profiles.length || profiles.length > 50) throw new Error('There must be 1 to 50 profiles');
  const seen = new Set();
  const unique = (what, v) => {
    if (typeof v !== 'string' || !v || v.length > 64) throw new Error(`A ${what} has an invalid id`);
    if (seen.has(v)) throw new Error(`Duplicate id "${v}"`);
    seen.add(v);
  };
  for (const p of profiles) {
    if (!isObj(p) || typeof p.name !== 'string') throw new Error('A profile needs a name');
    unique('profile', p.id);
    if (p.apps !== undefined && !(Array.isArray(p.apps) && p.apps.length <= 100 && p.apps.every((a) => typeof a === 'string'))) throw new Error('Profile apps must be a list of names');
    if (!Array.isArray(p.pages) || !p.pages.length || p.pages.length > 50) throw new Error('A profile needs 1 to 50 pages');
    for (const pg of p.pages) {
      if (!isObj(pg) || typeof pg.name !== 'string') throw new Error('A page needs a name');
      unique('page', pg.id);
      if (!isInt(pg.cols, 1, 12) || !isInt(pg.rows, 1, 12)) throw new Error('Page size must be 1 to 12 columns and rows');
      if (!Array.isArray(pg.widgets) || pg.widgets.length > 200) throw new Error('A page can hold up to 200 widgets');
      for (const w of pg.widgets) {
        if (!isObj(w) || !KINDS.has(w.kind)) throw new Error('A widget has an unknown kind');
        unique('widget', w.id);
        if (!isInt(w.x, 0, 99) || !isInt(w.y, 0, 99) || !isInt(w.w, 1, 12) || !isInt(w.h, 1, 12)) throw new Error('A widget has an invalid position');
        for (const f of ACTION_FIELDS) if (w[f] !== undefined) validateAction(w[f]);
      }
    }
  }
}

function validateObs(obs) {
  if (!isObj(obs)) throw new Error('OBS settings are missing');
  if (typeof obs.url !== 'string' || obs.url.length > 300 || !/^wss?:\/\//i.test(obs.url.trim())) throw new Error('The OBS address must start with ws:// or wss://');
  if (typeof obs.password !== 'string' || obs.password.length > 200) throw new Error('The OBS password is invalid');
}

const key = (x, y, label, icon, color, action) => ({ id: id(), kind: 'key', x, y, w: 1, h: 1, label, icon, color, action });

function defaultPages() {
  const main = id();
  const media = id();
  return [
    {
      id: main,
      name: 'Main',
      cols: 4,
      rows: 3,
      widgets: [
        key(0, 0, 'Record', 'lucide:circle', '#ef4444', { type: 'obs.record', mode: 'toggle' }),
        key(1, 0, 'Go Live', 'lucide:radio', '#a855f7', { type: 'obs.stream', mode: 'toggle' }),
        key(2, 0, 'Mic', 'lucide:mic', '#64748b', { type: 'obs.mute', input: 'Mic/Aux' }),
        key(3, 0, 'Replay', 'lucide:history', '#14b8a6', { type: 'obs.replaySave' }),
        key(0, 1, 'Scene 1', 'lucide:clapperboard', '#3b82f6', { type: 'obs.scene', scene: 'Scene' }),
        key(0, 2, 'Media', 'lucide:music', '#f97316', { type: 'page', page: media }),
        key(3, 2, 'Copy', 'lucide:copy', '#94a3b8', { type: 'hotkey', keys: 'ctrl+c' }),
      ],
    },
    {
      id: media,
      name: 'Media',
      cols: 4,
      rows: 3,
      widgets: [
        key(0, 0, 'Back', 'lucide:arrow-left', '#64748b', { type: 'page', page: main }),
        key(0, 1, 'Previous', 'lucide:skip-back', '#f97316', { type: 'media', key: 'prev' }),
        key(1, 1, 'Play', 'lucide:play', '#f97316', { type: 'media', key: 'playpause' }),
        key(2, 1, 'Next', 'lucide:skip-forward', '#f97316', { type: 'media', key: 'next' }),
        key(3, 1, 'Mute', 'lucide:volume-x', '#f97316', { type: 'media', key: 'mute' }),
        key(1, 2, 'Volume down', 'lucide:volume-1', '#f97316', { type: 'media', key: 'voldown' }),
        key(2, 2, 'Volume up', 'lucide:volume-2', '#f97316', { type: 'media', key: 'volup' }),
      ],
    },
  ];
}

function defaultConfig() {
  return {
    version: VERSION,
    port: 8787,
    devices: [],
    obs: { url: 'ws://127.0.0.1:4455', password: '' },
    profiles: [{ id: id(), name: 'Main', apps: [], pages: defaultPages() }],
  };
}

// Each step upgrades one version, so an old file walks through all of them.
const STEPS = {
  // v1 stored `buttons: { [cellIndex]: button }`; v2 stores widgets with x/y/w/h.
  1(data) {
    for (const p of data.pages) {
      p.widgets = Object.entries(p.buttons || {}).map(([idx, b]) => ({
        id: id(), kind: 'key', x: idx % p.cols, y: Math.floor(idx / p.cols), w: 1, h: 1,
        label: b.label, icon: b.icon, color: b.color, action: b.action,
      }));
      delete p.buttons;
    }
  },
  // v3 wraps the pages in a profile.
  2(data) {
    data.profiles = [{ id: id(), name: 'Main', apps: [], pages: data.pages }];
    delete data.pages;
  },
  // v4 swaps the old built-in emoji and colours for the icon set and current palette.
  // Only exact old defaults change; anything the user picked stays.
  3(data) {
    for (const prof of data.profiles) {
      for (const p of prof.pages) {
        for (const w of p.widgets) {
          for (const k of ['icon', 'activeIcon']) if (OLD_ICONS[w[k]]) w[k] = `lucide:${OLD_ICONS[w[k]]}`;
          for (const k of ['color', 'activeColor']) if (OLD_COLORS[w[k]]) w[k] = OLD_COLORS[w[k]];
        }
      }
    }
  },
  // v5 pairs each phone separately: the shared token becomes one device entry (stored hashed),
  // so phones paired before the upgrade keep working until they are revoked.
  4(data) {
    data.devices = [];
    if (typeof data.token === 'string' && data.token) {
      data.devices.push({ id: id(), name: 'Phone paired earlier', hash: hashToken(data.token), created: Date.now(), lastSeen: 0 });
    }
    delete data.token;
  },
};

const OLD_ICONS = {
  '⏺': 'circle', '📡': 'radio', '🎙': 'mic', '🎤': 'mic', '⏪': 'history', '🎬': 'clapperboard', '🎵': 'music',
  '📋': 'copy', '⬅': 'arrow-left', '⏮': 'skip-back', '⏯': 'play', '⏭': 'skip-forward', '🔇': 'volume-x',
  '🔉': 'volume-1', '🔊': 'volume-2', '🌐': 'globe', '💡': 'lightbulb', '📣': 'megaphone', '🎧': 'headphones',
};

const OLD_COLORS = {
  '#c0392b': '#ef4444', '#d35400': '#f97316', '#f39c12': '#f59e0b', '#16a085': '#14b8a6', '#27ae60': '#22c55e',
  '#2980b9': '#3b82f6', '#8e44ad': '#a855f7', '#2c3e50': '#64748b', '#34495e': '#64748b', '#7f8c8d': '#94a3b8',
};

function migrate(data) {
  for (let v = data.version || 1; v < VERSION; v++) STEPS[v](data);
  data.version = VERSION;
  return data;
}

class ConfigStore {
  // secrets (optional): { encrypt(text) -> string, decrypt(string) -> text }, used for the OBS password.
  constructor(dir, secrets = null) {
    this.dir = dir;
    this.secrets = secrets;
    this.encPassword = null; // an encrypted password we can't read here (the CLI) is kept as-is
    this.file = path.join(dir, 'pocketdeck.json');
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.file)) {
      this.data = defaultConfig();
      this.save();
      return;
    }
    const raw = fs.readFileSync(this.file, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      const from = parsed.version || 1;
      // Keep a copy of the old file before the upgraded one overwrites it.
      if (from < VERSION) fs.writeFileSync(`${this.file}.v${from}.bak`, raw);
      this.data = migrate(parsed);
    } catch (e) {
      // Never silently replace a file we can't read: keep it for recovery, then start fresh.
      const kept = `${this.file}.unreadable-${Date.now()}`;
      fs.writeFileSync(kept, raw);
      console.error(`Config could not be read (${e.message}); kept a copy at ${kept}`);
      this.data = defaultConfig();
    }
    this.unlockSecrets();
    this.save();
  }

  unlockSecrets() {
    const obs = this.data.obs || (this.data.obs = { url: 'ws://127.0.0.1:4455', password: '' });
    if (!obs.passwordEnc) return;
    if (this.secrets) {
      try {
        obs.password = this.secrets.decrypt(obs.passwordEnc);
      } catch (e) {
        console.error(`The saved OBS password could not be decrypted (${e.message}); enter it again in Settings.`);
        obs.password = '';
      }
    } else {
      this.encPassword = obs.passwordEnc;
      obs.password = obs.password || '';
    }
    delete obs.passwordEnc;
  }

  // Write to a temporary file and swap it in, so a crash mid-write can't corrupt the config.
  save() {
    const out = { ...this.data, obs: { ...this.data.obs } };
    if (this.secrets && out.obs.password) {
      out.obs.passwordEnc = this.secrets.encrypt(out.obs.password);
      delete out.obs.password;
    } else if (!out.obs.password && this.encPassword) {
      out.obs.passwordEnc = this.encPassword;
      delete out.obs.password;
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
    fs.renameSync(tmp, this.file);
  }

  // Replace profiles/obs/autostart from the editor. Invalid input throws and changes nothing.
  update(patch) {
    if (!isObj(patch)) throw new Error('Nothing to save');
    const clean = {};
    for (const k of PATCH_KEYS) if (patch[k] !== undefined) clean[k] = patch[k];
    if (clean.profiles) validateProfiles(clean.profiles);
    if (clean.obs) {
      validateObs(clean.obs);
      if (clean.obs.password === '' && this.encPassword) this.encPassword = null; // the user cleared it
    }
    this.data = { ...this.data, ...clean };
    this.save();
  }

  /* ---------- paired phones ---------- */

  // Registers a phone and returns its secret token. Only a hash is stored.
  addDevice(name) {
    const token = crypto.randomBytes(24).toString('hex');
    const clean = String(name || '').replace(/[^\p{L}\p{N} ._()-]/gu, '').trim().slice(0, 40) || 'Phone';
    this.data.devices.push({ id: id(), name: clean, hash: hashToken(token), created: Date.now(), lastSeen: Date.now() });
    this.save();
    return token;
  }

  deviceForToken(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    const want = Buffer.from(hashToken(token));
    for (const d of this.data.devices) {
      const have = Buffer.from(d.hash);
      if (have.length === want.length && crypto.timingSafeEqual(have, want)) return d;
    }
    return null;
  }

  touchDevice(deviceId) {
    const d = this.data.devices.find((x) => x.id === deviceId);
    if (!d) return;
    d.lastSeen = Date.now();
    this.save();
  }

  revokeDevice(deviceId) {
    const before = this.data.devices.length;
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    if (this.data.devices.length !== before) this.save();
    return this.data.devices.length !== before;
  }

  revokeAll() {
    this.data.devices = [];
    this.save();
  }

  // What the editor shows about paired phones; never the hash.
  publicDevices() {
    return this.data.devices.map(({ id: did, name, created, lastSeen }) => ({ id: did, name, created, lastSeen }));
  }

  // What the phone gets: never the OBS password, any token or the app list.
  publicDeck() {
    return { profiles: this.data.profiles.map(({ id: pid, name, pages }) => ({ id: pid, name, pages })) };
  }

  *allWidgets() {
    for (const prof of this.data.profiles) for (const p of prof.pages) yield* p.widgets;
  }

  findWidget(widgetId) {
    for (const w of this.allWidgets()) if (w.id === widgetId) return w;
    return null;
  }

  // The profile that should be on screen when `app` (a process name like "obs64") is in front.
  profileForApp(app) {
    const name = String(app || '').toLowerCase().replace(/\.exe$/, '');
    if (!name) return null;
    const hit = this.data.profiles.find((p) => (p.apps || []).some((a) => String(a).toLowerCase().replace(/\.exe$/, '') === name));
    return hit ? hit.id : null;
  }

  hasAppRules() {
    return this.data.profiles.some((p) => (p.apps || []).length);
  }
}

module.exports = { ConfigStore, newId: id, migrate, validateProfiles, validateObs, hashToken };
