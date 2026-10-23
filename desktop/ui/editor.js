// PocketDeck editor window.
'use strict';

const $ = (s) => document.querySelector(s);
const api = window.pd;

const ICON_DIR = '../../node_modules/lucide-static/icons';
const CELL = 92;
const GAP = 10;

const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'];

let cfg = null;            // { profiles, obs, port }
let obs = { connected: false, scenes: [], inputs: [] };
let urls = [];
let devices = [];   // paired phones
let clients = [];   // phones connected right now
let profileId = null;
let pageId = null;
let sel = null;            // { id } for a widget, { x, y } for an empty cell
let saveTimer = null;
let iconIndex = null;

const profile = () => cfg.profiles.find((p) => p.id === profileId);
const page = () => profile().pages.find((p) => p.id === pageId);
const widgetOf = () => (sel && sel.id ? page().widgets.find((w) => w.id === sel.id) : null);
const newId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, '0');
const hasAction = (a) => !!a && a.type !== 'none';

/* ---------- small helpers ---------- */

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null) continue;
    if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids.filter((k) => k !== null && k !== undefined && k !== false));
  return e;
}

function iconEl(name, className = 'icon') {
  const s = el('span', { className });
  s.style.setProperty('--icon', `url("${ICON_DIR}/${name}.svg")`);
  return s;
}

// "lucide:mic" draws that icon; anything else (an emoji, a letter) is shown as text.
function glyphEl(value) {
  const m = /^lucide:([a-z0-9-]+)$/.exec(value || '');
  if (m) return iconEl(m[1], 'glyph icon');
  return el('span', { className: 'glyph', textContent: value || '' });
}

function field(label, input, className = 'field') {
  return el('label', { className }, label, input);
}

function group(title, ...kids) {
  return el('section', { className: 'group' }, title ? el('h3', { textContent: title }) : null, ...kids);
}

function dropdown(choices, value, onChange) {
  const s = el('select', { onchange: (e) => onChange(e.target.value) },
    ...Object.entries(choices).map(([v, t]) => el('option', { value: v, textContent: t })));
  s.value = value;
  return s;
}

function textInput(obj, key, { max, placeholder, onChange } = {}) {
  return el('input', {
    value: obj[key] ?? '',
    maxLength: max,
    placeholder,
    spellcheck: false,
    oninput: (e) => {
      obj[key] = e.target.value;
      save();
      if (onChange) onChange();
    },
  });
}

function numberInput(value, { min, max, step, onChange }) {
  return el('input', {
    type: 'number', min, max, step, value,
    oninput: (e) => {
      const n = Number(e.target.value);
      const ok = e.target.value !== '' && Number.isFinite(n) && n >= min && n <= max;
      e.target.classList.toggle('invalid', !ok);
      if (ok) onChange(n);
    },
  });
}

// Changes are saved shortly after the last edit; the server pushes them to phones.
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const r = await api.save({ profiles: cfg.profiles, obs: cfg.obs });
    if (r && r.ok === false) addLog({ at: Date.now(), text: `Not saved: ${r.error}` });
  }, 250);
}

function setIcons(root = document) {
  for (const s of root.querySelectorAll('[data-icon]')) s.style.setProperty('--icon', `url("${ICON_DIR}/${s.dataset.icon}.svg")`);
}

/* ---------- catalogue of actions, controls and widgets ---------- */

const ACTION_GROUPS = [
  ['OBS', {
    'obs.scene': 'Switch scene',
    'obs.record': 'Recording',
    'obs.stream': 'Streaming',
    'obs.mute': 'Mute audio source',
    'obs.sourceVisible': 'Show or hide source',
    'obs.filter': 'Filter on or off',
    'obs.replaySave': 'Save replay buffer',
    'obs.virtualcam': 'Virtual camera',
    'obs.studio': 'Studio mode',
    'obs.studioTransition': 'Studio mode transition',
    'obs.chapter': 'Add recording chapter',
  }],
  ['System', {
    hotkey: 'Hotkey',
    media: 'Media key',
    text: 'Type text',
    open: 'Open app, file or URL',
    sound: 'Play sound',
    http: 'Web request',
    lock: 'Lock computer',
  }],
  ['Deck', { page: 'Go to page', multi: 'Multi-action', none: 'Nothing' }],
];

const START_STOP = { toggle: 'Start or stop', start: 'Start', stop: 'Stop' };

// Extra fields per action type. Field options: choices, options (suggestions),
// load (async suggestions), textarea, json, number, capture (hotkey), pick (file), devices.
const ACTION_FIELDS = {
  'obs.scene': [{ key: 'scene', label: 'Scene', options: () => obs.scenes }],
  'obs.record': [{ key: 'mode', label: 'When pressed', choices: START_STOP }],
  'obs.stream': [{ key: 'mode', label: 'When pressed', choices: START_STOP }],
  'obs.mute': [{ key: 'input', label: 'Audio source', options: () => obs.inputs }],
  'obs.sourceVisible': [
    { key: 'scene', label: 'Scene', options: () => obs.scenes },
    { key: 'source', label: 'Source' },
  ],
  'obs.filter': [{ key: 'source', label: 'Source or scene' }, { key: 'filter', label: 'Filter' }],
  'obs.chapter': [{ key: 'name', label: 'Chapter name', placeholder: 'Optional' }],
  hotkey: [
    { key: 'keys', label: 'Keys', capture: true, placeholder: 'Click, then press the shortcut' },
    { key: 'mode', label: 'Behaviour', choices: { tap: 'Press once', held: 'Hold while pressed' } },
  ],
  media: [{
    key: 'key',
    label: 'Key',
    choices: { playpause: 'Play / pause', next: 'Next track', prev: 'Previous track', stop: 'Stop', mute: 'Mute', volup: 'Volume up', voldown: 'Volume down' },
  }],
  text: [{ key: 'text', label: 'Text', textarea: true }],
  open: [{ key: 'target', label: 'Path or URL', placeholder: 'https://… or C:\\Program Files\\…' }],
  sound: [
    { key: 'file', label: 'Sound file', pick: 'sound' },
    { key: 'device', label: 'Output', devices: true },
    { key: 'volume', label: 'Volume (%)', number: [0, 100], placeholder: '100' },
    { key: 'mode', label: 'Pressed while playing', choices: { restart: 'Restart', toggle: 'Stop', overlap: 'Play again on top' } },
  ],
  http: [
    { key: 'method', label: 'Method', choices: { GET: 'GET', POST: 'POST', PUT: 'PUT', DELETE: 'DELETE' } },
    { key: 'url', label: 'URL', placeholder: 'https://' },
    { key: 'headers', label: 'Headers', textarea: true, placeholder: 'Name: value' },
    { key: 'body', label: 'Body', textarea: true },
  ],
  page: [{ key: 'page', label: 'Page', choices: () => Object.fromEntries(profile().pages.map((p) => [p.id, p.name])) }],
  multi: [{ key: 'steps', label: 'Steps (JSON)', json: true }],
};

const ACTION_DEFAULTS = {
  'obs.record': { mode: 'toggle' },
  'obs.stream': { mode: 'toggle' },
  hotkey: { mode: 'tap' },
  media: { key: 'playpause' },
  sound: { mode: 'restart' },
  http: { method: 'POST' },
  multi: { steps: [{ type: 'obs.scene', scene: 'Scene' }, { type: 'delay', ms: 500 }, { type: 'obs.record', mode: 'start' }] },
};

const TARGETS = {
  'win.master': { name: 'System volume', fields: [] },
  'win.app': { name: 'App volume', fields: [{ key: 'app', label: 'Program', placeholder: 'spotify', load: () => api.audioApps() }] },
  'win.brightness': { name: 'Screen brightness', fields: [] },
  'obs.volume': { name: 'OBS source volume', fields: [{ key: 'input', label: 'Audio source', options: () => obs.inputs }] },
  'obs.filter': {
    name: 'OBS filter setting',
    fields: [
      { key: 'source', label: 'Source or scene' },
      { key: 'filter', label: 'Filter' },
      { key: 'setting', label: 'Setting', placeholder: 'brightness' },
      { key: 'min', label: 'Minimum', number: [-1e6, 1e6], placeholder: '0' },
      { key: 'max', label: 'Maximum', number: [-1e6, 1e6], placeholder: '100' },
    ],
  },
  'obs.transition': {
    name: 'OBS transition length',
    fields: [
      { key: 'min', label: 'Shortest (ms)', number: [0, 60000], placeholder: '50' },
      { key: 'max', label: 'Longest (ms)', number: [0, 60000], placeholder: '2000' },
    ],
  },
};

const INFO_SOURCES = {
  clock: 'Clock',
  clocksec: 'Clock with seconds',
  date: 'Date',
  rec: 'Recording time',
  stream: 'Stream time',
  obsstats: 'OBS FPS and CPU',
  cpu: 'CPU usage',
  ram: 'Memory usage',
  countdown: 'Countdown',
};

const KINDS = {
  key: {
    name: 'Key', icon: 'square', blurb: 'Runs an action when pressed.', sizes: [[1, 1]],
    make: () => ({ label: '', icon: '', color: PALETTE[5], action: { type: 'none' } }),
  },
  slider: {
    name: 'Slider', icon: 'sliders-horizontal', blurb: 'Sets a level such as volume or brightness.', sizes: [[1, 3], [1, 2], [1, 1]],
    make: () => ({ label: 'Volume', icon: 'lucide:volume-2', color: '#22c55e', orient: 'v', target: { type: 'win.master' } }),
  },
  dial: {
    name: 'Dial', icon: 'circle-gauge', blurb: 'Turn to change a value or send keys.', sizes: [[2, 2], [1, 2], [1, 1]],
    make: () => ({
      label: 'Volume', color: '#3b82f6', mode: 'value', step: 2, target: { type: 'win.master' },
      cw: { type: 'media', key: 'volup' }, ccw: { type: 'media', key: 'voldown' }, press: { type: 'media', key: 'mute' },
    }),
  },
  info: {
    name: 'Info tile', icon: 'clock', blurb: 'Shows the time, a timer or usage stats.', sizes: [[2, 1], [1, 1]],
    make: () => ({ label: 'Time', color: '#64748b', source: 'clock', action: { type: 'none' } }),
  },
  trackpad: {
    name: 'Trackpad', icon: 'mouse-pointer-2', blurb: 'Controls the mouse pointer.', sizes: [[3, 2], [2, 2], [2, 1], [1, 1]],
    make: () => ({ label: 'Trackpad', color: '#3b82f6', speed: 1.5, natural: true }),
  },
};

// Shown first in the icon picker before searching.
const POPULAR_ICONS = [
  'circle', 'square', 'radio', 'mic', 'mic-off', 'video', 'video-off', 'camera', 'monitor', 'clapperboard',
  'gamepad-2', 'message-square', 'headphones', 'volume-2', 'volume-x', 'music', 'play', 'pause', 'skip-forward', 'skip-back',
  'scissors', 'bookmark', 'history', 'clock', 'timer', 'zap', 'bell', 'heart', 'star', 'flag',
  'eye', 'eye-off', 'layers', 'image', 'globe', 'link', 'copy', 'clipboard', 'keyboard', 'mouse-pointer-2',
  'lock', 'sun', 'moon', 'lightbulb', 'power', 'settings', 'home', 'arrow-left', 'arrow-right', 'refresh-cw',
];

/* ---------- top bar and dialogs ---------- */

function ago(ts) {
  if (!ts) return 'never connected';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(ts).toLocaleDateString();
}

function renderDevices() {
  const online = new Set(clients.map((c) => c.id));
  $('#clients').replaceChildren(...(devices.length
    ? devices.map((d) => el('li', {},
      el('span', { className: `dot${online.has(d.id) ? ' on' : ''}` }),
      el('span', { className: 'grow' }, d.name, el('span', { className: 'sub', textContent: ` · ${online.has(d.id) ? 'connected' : ago(d.lastSeen)}` })),
      el('button', {
        className: 'btn ghost sm danger',
        type: 'button',
        textContent: 'Remove',
        onclick: async () => {
          if (!confirm(`Remove "${d.name}"? It will need to scan a new code.`)) return;
          devices = await api.revokeDevice(d.id);
          renderDevices();
        },
      })))
    : [el('li', { textContent: 'No phones paired yet' })]));
}

function renderClients(list) {
  clients = list;
  renderDevices();
  const n = list.length;
  $('#phones-dot').classList.toggle('on', n > 0);
  $('#phones-text').textContent = n ? `${n} phone${n > 1 ? 's' : ''} connected` : 'No phones';
}

function renderConnect() {
  const s = $('#adapter');
  const prev = s.value;
  s.replaceChildren(...urls.map((u, i) => el('option', { value: i, textContent: `${u.address} (${u.name})` })));
  if (prev && urls[prev]) s.value = prev;
  showUrl();
}

// The QR code is single-use and replaced every 10 minutes; show how long this one has left.
let pairExpires = 0;
function tickPair() {
  const left = pairExpires ? Math.max(0, Math.round((pairExpires - Date.now()) / 1000)) : 0;
  $('#pair-timer').textContent = pairExpires ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : '–';
}
setInterval(tickPair, 1000);

function showUrl() {
  pairExpires = urls[0] ? urls[0].expires : 0;
  tickPair();
  const u = urls[$('#adapter').value || 0];
  $('#qr').src = u ? u.qr : '';
  $('#url').textContent = u ? u.url : 'No network connection found';
}

function renderObs() {
  $('#obs-dot').classList.toggle('on', obs.connected);
  $('#obs-text').textContent = obs.connected ? 'OBS connected' : 'OBS offline';
  const pill = $('#obs-status');
  pill.textContent = obs.connected ? 'Connected' : 'Not connected';
  pill.classList.toggle('on', obs.connected);
  $('#obs-error').textContent = obs.connected ? '' : obs.error || '';
}

/* ---------- sidebar ---------- */

function renderProfiles() {
  $('#profiles').replaceChildren(...cfg.profiles.map((p) => el('li', { className: p.id === profileId ? 'current' : '' },
    el('button', {
      type: 'button',
      className: 'name',
      onclick: () => selectProfile(p.id),
    }, el('span', { textContent: p.name }), (p.apps || []).length ? el('span', { className: 'meta', textContent: p.apps.join(', ') }) : null),
    el('button', {
      type: 'button',
      className: 'btn ghost square sm',
      title: 'Profile settings',
      'aria-label': `Settings for ${p.name}`,
      onclick: () => { selectProfile(p.id); openProfileDialog(); },
    }, iconEl('settings')))));
}

function renderPages() {
  $('#pages').replaceChildren(...profile().pages.map((p) => el('li', { className: p.id === pageId ? 'current' : '' },
    el('button', { type: 'button', className: 'name', onclick: () => selectPage(p.id) }, el('span', { textContent: p.name })))));
  const p = page();
  $('#page-name').value = p.name;
  $('#cols').value = p.cols;
  $('#rows').value = p.rows;
  $('#del-page').disabled = profile().pages.length < 2;
}

function selectProfile(id) {
  profileId = id;
  pageId = profile().pages[0].id;
  sel = null;
  renderAll();
}

function selectPage(id) {
  pageId = id;
  sel = null;
  $('#page-msg').hidden = true;
  renderAll();
}

function addLog(entry) {
  const failed = !/: ok$/.test(entry.text);
  const time = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#log').prepend(el('li', { className: failed ? 'err' : '' }, el('time', { textContent: time }), el('span', { textContent: entry.text })));
  while ($('#log').children.length > 50) $('#log').lastChild.remove();
}

/* ---------- grid ---------- */

// Whether a w x h widget fits at (x, y) without leaving the grid or overlapping another.
function fits(p, self, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > p.cols || y + h > p.rows) return false;
  return !p.widgets.some((o) => o !== self && o.x < x + w && x < o.x + o.w && o.y < y + h && y < o.y + o.h);
}

function moveWidget(id, x, y) {
  const p = page();
  const w = p.widgets.find((o) => o.id === id);
  if (!w || (w.x === x && w.y === y)) return;
  if (fits(p, w, x, y, w.w, w.h)) {
    w.x = x;
    w.y = y;
  } else {
    // Dropping one single-cell widget on another swaps them.
    const other = p.widgets.find((o) => o !== w && o.x === x && o.y === y && o.w === 1 && o.h === 1);
    if (!other || w.w !== 1 || w.h !== 1) return;
    [other.x, other.y, w.x, w.y] = [w.x, w.y, other.x, other.y];
  }
  sel = { id };
  save();
  renderGrid();
  renderInspector();
}

function startResize(e, w) {
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.parentElement.draggable = false;
  const p = page();
  const start = { x: e.clientX, y: e.clientY, w: w.w, h: w.h };
  const move = (ev) => {
    const nw = Math.max(1, start.w + Math.round((ev.clientX - start.x) / (CELL + GAP)));
    const nh = Math.max(1, start.h + Math.round((ev.clientY - start.y) / (CELL + GAP)));
    if ((nw !== w.w || nh !== w.h) && fits(p, w, w.x, w.y, nw, nh)) {
      w.w = nw;
      w.h = nh;
      renderGrid();
    }
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    save();
    renderGrid();
    renderInspector();
  }, { once: true });
}

function cellFor(w) {
  const selected = sel && sel.id === w.id;
  const c = el('div', {
    className: `cell kind-${w.kind}${selected ? ' selected' : ''}`,
    tabIndex: 0,
    draggable: true,
    role: 'button',
    'aria-label': `${KINDS[w.kind]?.name || 'Widget'} ${w.label || ''}`.trim(),
    onclick: () => selectCell({ id: w.id }),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCell({ id: w.id }); } },
    ondragstart: (e) => e.dataTransfer.setData('text/plain', w.id),
  });
  dropTarget(c, w.x, w.y);
  c.style.gridColumn = `${w.x + 1} / span ${w.w}`;
  c.style.gridRow = `${w.y + 1} / span ${w.h}`;
  c.style.setProperty('--c', w.color || PALETTE[9]);
  if (w.image) {
    c.classList.add('has-img');
    c.style.setProperty('--img', `url("http://127.0.0.1:${cfg.port}/img/${w.image}")`);
  }
  if (w.kind !== 'key') c.append(el('span', { className: 'kind-tag', textContent: KINDS[w.kind].name }));
  const icon = w.kind === 'key' || w.kind === 'slider' ? w.icon : `lucide:${KINDS[w.kind].icon}`;
  c.append(w.image && !w.icon ? '' : glyphEl(icon), el('span', { className: 'label', textContent: w.label || '' }));
  if (selected) c.append(el('span', { className: 'handle', title: 'Resize', onpointerdown: (e) => startResize(e, w) }));
  return c;
}

function dropTarget(node, x, y) {
  node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('drop'); });
  node.addEventListener('dragleave', () => node.classList.remove('drop'));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    node.classList.remove('drop');
    moveWidget(e.dataTransfer.getData('text/plain'), x, y);
  });
}

function renderGrid() {
  const p = page();
  const grid = $('#grid');
  grid.style.gridTemplateColumns = `repeat(${p.cols}, ${CELL}px)`;
  grid.style.gridTemplateRows = `repeat(${p.rows}, ${CELL}px)`;
  const taken = new Set();
  const nodes = p.widgets.map((w) => {
    for (let dy = 0; dy < w.h; dy++) for (let dx = 0; dx < w.w; dx++) taken.add((w.y + dy) * p.cols + w.x + dx);
    return cellFor(w);
  });
  for (let i = 0; i < p.cols * p.rows; i++) {
    if (taken.has(i)) continue;
    const x = i % p.cols;
    const y = Math.floor(i / p.cols);
    const c = el('div', {
      className: `cell empty${sel && sel.x === x && sel.y === y ? ' selected' : ''}`,
      tabIndex: 0,
      role: 'button',
      'aria-label': `Empty cell ${x + 1}, ${y + 1}`,
      onclick: () => selectCell({ x, y }),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCell({ x, y }); } },
    }, iconEl('plus'));
    c.style.gridColumn = String(x + 1);
    c.style.gridRow = String(y + 1);
    dropTarget(c, x, y);
    nodes.push(c);
  }
  grid.replaceChildren(...nodes);
}

function selectCell(s) {
  sel = s;
  renderGrid();
  renderInspector();
}

/* ---------- inspector: field builders ---------- */

function pickField(obj, f) {
  const button = el('button', { type: 'button', className: 'icon-pick' }, iconEl('file-audio'), el('span', { className: 'text', textContent: obj.name || 'Choose a file…' }));
  const msg = el('p', { className: 'hint error' });
  button.addEventListener('click', async () => {
    const r = await api.pickMedia(f.pick);
    if (!r) return;
    msg.textContent = r.ok ? '' : r.error;
    if (!r.ok) return;
    obj[f.key] = r.file;
    obj.name = r.name;
    button.querySelector('.text').textContent = r.name;
    save();
  });
  return el('div', {}, field(f.label, button), msg);
}

function deviceField(obj, f) {
  const s = dropdown({ '': 'Default output' }, obj[f.key] || '', (v) => {
    if (v) obj[f.key] = v;
    else delete obj[f.key];
    save();
  });
  api.audioDevices().then((list) => {
    s.replaceChildren(el('option', { value: '', textContent: 'Default output' }), ...list.map((d) => el('option', { value: d.id, textContent: d.label })));
    s.value = obj[f.key] || '';
  });
  return field(f.label, s);
}

function hotkeyInput(obj, f) {
  const input = el('input', { value: obj[f.key] || '', placeholder: f.placeholder, readOnly: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      input.value = '';
    } else {
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace(/^arrow/, '');
      if (['control', 'shift', 'alt', 'meta'].includes(key)) return;
      const mods = ['ctrl', 'shift', 'alt', 'meta'].filter((m) => e[`${m}Key`]).map((m) => (m === 'meta' ? 'win' : m));
      input.value = [...mods, key === ' ' ? 'space' : key].join('+');
    }
    obj[f.key] = input.value;
    save();
  });
  return input;
}

// Inputs for the fields of an action or control; they edit `obj` in place.
function buildFields(obj, defs) {
  const nodes = [];
  defs.forEach((f, i) => {
    if (f.pick) return nodes.push(pickField(obj, f));
    if (f.devices) return nodes.push(deviceField(obj, f));
    const set = (v) => {
      if (v === undefined || v === '') delete obj[f.key];
      else obj[f.key] = v;
      save();
    };
    let input;
    if (f.choices) {
      const choices = typeof f.choices === 'function' ? f.choices() : f.choices;
      const first = Object.keys(choices)[0];
      if (obj[f.key] === undefined && first !== undefined) set(first);
      input = dropdown(choices, obj[f.key], set);
    } else if (f.json) {
      input = el('textarea', {
        value: JSON.stringify(obj[f.key] || [], null, 2),
        oninput: (e) => {
          try {
            set(JSON.parse(e.target.value));
            e.target.classList.remove('invalid');
          } catch {
            e.target.classList.add('invalid');
          }
        },
      });
    } else if (f.textarea) {
      input = el('textarea', { value: obj[f.key] || '', placeholder: f.placeholder, oninput: (e) => set(e.target.value) });
    } else if (f.capture) {
      input = hotkeyInput(obj, f);
    } else if (f.number) {
      const [min, max] = f.number;
      input = el('input', {
        type: 'number', min, max, value: obj[f.key] ?? '', placeholder: f.placeholder,
        oninput: (e) => {
          const raw = e.target.value;
          const n = Number(raw);
          const ok = raw === '' || (Number.isFinite(n) && n >= min && n <= max);
          e.target.classList.toggle('invalid', !ok);
          if (ok) set(raw === '' ? undefined : n);
        },
      });
    } else {
      input = el('input', { value: obj[f.key] || '', placeholder: f.placeholder, spellcheck: false, oninput: (e) => set(e.target.value) });
      if (f.options || f.load) {
        const listId = `opts-${f.key}-${i}`;
        const list = el('datalist', { id: listId }, ...(f.options ? f.options() : []).map((o) => el('option', { value: o })));
        input.setAttribute('list', listId);
        nodes.push(list);
        if (f.options && !obs.connected && !input.placeholder) input.placeholder = 'Connect OBS to see a list';
        if (f.load) f.load().then((items) => list.replaceChildren(...items.map((o) => el('option', { value: o })))).catch(() => {});
      }
    }
    nodes.push(field(f.label, input));
  });
  return nodes;
}

// A picker for "what happens" plus that action's fields; edits holder[key].
function actionEditor(holder, key, label) {
  const box = el('div');
  const render = () => {
    if (!holder[key]) holder[key] = { type: 'none' };
    const action = holder[key];
    const picker = el('select', {
      onchange: (e) => {
        holder[key] = { type: e.target.value, ...structuredClone(ACTION_DEFAULTS[e.target.value] || {}) };
        save();
        render();
      },
    }, ...ACTION_GROUPS.map(([name, items]) =>
      el('optgroup', { label: name }, ...Object.entries(items).map(([v, t]) => el('option', { value: v, textContent: t })))));
    picker.value = action.type;
    box.replaceChildren(field(label, picker), ...buildFields(action, ACTION_FIELDS[action.type] || []));
    if (action.type === 'multi') {
      box.append(el('p', { className: 'hint', textContent: 'A list of actions run in order. Use {"type":"delay","ms":500} to wait.' }));
    }
  };
  render();
  return box;
}

function targetEditor(w) {
  const box = el('div');
  const render = () => {
    const picker = dropdown(Object.fromEntries(Object.entries(TARGETS).map(([v, d]) => [v, d.name])), w.target.type, (v) => {
      w.target = { type: v };
      save();
      render();
    });
    box.replaceChildren(field('Controls', picker), ...buildFields(w.target, TARGETS[w.target.type].fields));
  };
  render();
  return box;
}

function iconButton(obj, key, onChange) {
  const b = el('button', { type: 'button', className: 'icon-pick' });
  const draw = () => {
    const v = obj[key];
    b.replaceChildren(glyphEl(v), el('span', { className: 'text', textContent: v ? v.replace(/^lucide:/, '') : 'None' }));
  };
  b.addEventListener('click', () => openIconPicker(obj[key], (v) => {
    if (v) obj[key] = v;
    else delete obj[key];
    save();
    draw();
    onChange();
  }));
  draw();
  return b;
}

function colorRow(obj, key, fallback, onChange) {
  const row = el('div', { className: 'swatches' });
  const pick = (c) => {
    obj[key] = c;
    save();
    draw();
    onChange();
  };
  const draw = () => row.replaceChildren(
    ...PALETTE.map((c) => el('button', {
      type: 'button',
      className: c === obj[key] ? 'current' : '',
      style: `background:${c}`,
      title: c,
      'aria-label': `Colour ${c}`,
      onclick: () => pick(c),
    })),
    el('input', { type: 'color', value: obj[key] || fallback, title: 'Custom colour', oninput: (e) => pick(e.target.value) }),
  );
  draw();
  return row;
}

function appearanceGroup(w, { icon = true } = {}) {
  const refresh = () => renderGrid();
  return group('Appearance',
    el('div', { className: 'row' },
      field('Label', textInput(w, 'label', { max: 24, onChange: refresh })),
      icon ? field('Icon', iconButton(w, 'icon', refresh)) : null),
    field('Colour', colorRow(w, 'color', PALETTE[5], refresh)));
}

/* ---------- inspector ---------- */

function renderAddMenu(body) {
  body.replaceChildren(el('div', { className: 'add-menu' }, ...Object.entries(KINDS).map(([kind, k]) =>
    el('button', { type: 'button', onclick: () => addWidget(kind) },
      iconEl(k.icon), el('span', {}, el('strong', { textContent: k.name }), el('small', { textContent: k.blurb }))))));
}

function addWidget(kind) {
  const p = page();
  const size = KINDS[kind].sizes.find(([w, h]) => fits(p, null, sel.x, sel.y, w, h)) || [1, 1];
  const w = { id: newId(), kind, x: sel.x, y: sel.y, w: size[0], h: size[1], ...KINDS[kind].make() };
  p.widgets.push(w);
  sel = { id: w.id };
  save();
  renderGrid();
  renderInspector();
}

function keyGroups(w) {
  return [
    appearanceGroup(w),
    group('Action', actionEditor(w, 'action', 'When pressed')),
    group('', el('details', { open: hasAction(w.hold) || hasAction(w.double) },
      el('summary', { textContent: 'Hold and double-tap' }),
      actionEditor(w, 'hold', 'When held'),
      actionEditor(w, 'double', 'When double-tapped'))),
    group('', el('details', { open: !!(w.image || w.activeIcon || w.activeLabel || w.activeColor) },
      el('summary', { textContent: 'Image and active state' }),
      imageField(w),
      el('p', { className: 'hint', textContent: 'Shown while OBS reports this key as active (recording, live, muted, current scene).' }),
      el('div', { className: 'row' },
        field('Active label', textInput(w, 'activeLabel', { max: 24 })),
        field('Active icon', iconButton(w, 'activeIcon', () => {}))),
      field('Active colour', colorRow(w, 'activeColor', w.color || PALETTE[5], () => {})))),
  ];
}

function imageField(w) {
  const msg = el('p', { className: 'hint error' });
  const choose = async () => {
    const r = await api.pickMedia('image');
    if (!r) return;
    if (!r.ok) {
      msg.textContent = r.error;
      return;
    }
    w.image = r.file;
    save();
    renderGrid();
    renderInspector();
  };
  const remove = () => {
    delete w.image;
    save();
    renderGrid();
    renderInspector();
  };
  return el('div', {},
    el('div', { className: 'row' },
      el('button', { type: 'button', className: 'btn sm', onclick: choose }, iconEl('image'), w.image ? 'Replace image' : 'Add image'),
      w.image ? el('button', { type: 'button', className: 'btn ghost sm danger', onclick: remove }, 'Remove') : null),
    msg);
}

function sliderGroups(w) {
  return [
    appearanceGroup(w),
    group('Control',
      field('Direction', dropdown({ v: 'Vertical', h: 'Horizontal' }, w.orient || 'v', (v) => { w.orient = v; save(); })),
      targetEditor(w)),
  ];
}

function dialGroups(w) {
  const control = w.mode === 'relative'
    ? [actionEditor(w, 'cw', 'Turned clockwise'), actionEditor(w, 'ccw', 'Turned anticlockwise')]
    : [targetEditor(w), field('Change per step (%)', numberInput(w.step ?? 2, { min: 1, max: 25, onChange: (n) => { w.step = n; save(); } }))];
  return [
    appearanceGroup(w, { icon: false }),
    group('Control',
      field('Mode', dropdown({ value: 'Adjusts a value', relative: 'Sends an action per step' }, w.mode || 'value', (v) => { w.mode = v; save(); renderInspector(); })),
      ...control),
    group('Press', actionEditor(w, 'press', 'When tapped')),
  ];
}

function infoGroups(w) {
  return [
    appearanceGroup(w, { icon: false }),
    group('Content',
      field('Shows', dropdown(INFO_SOURCES, w.source || 'clock', (v) => { w.source = v; save(); renderInspector(); })),
      w.source === 'countdown'
        ? field('Counts down to', el('input', { type: 'datetime-local', value: w.until || '', oninput: (e) => { w.until = e.target.value; save(); } }))
        : null),
    group('Press', actionEditor(w, 'action', 'When tapped')),
  ];
}

function trackpadGroups(w) {
  return [
    appearanceGroup(w, { icon: false }),
    group('Behaviour',
      field('Speed', numberInput(w.speed ?? 1.5, { min: 0.5, max: 4, step: 0.1, onChange: (n) => { w.speed = n; save(); } })),
      field('Two-finger scroll', dropdown({ natural: 'Natural', reversed: 'Reversed' }, w.natural === false ? 'reversed' : 'natural', (v) => { w.natural = v === 'natural'; save(); })),
      el('p', { className: 'hint', textContent: 'Tap to click. Two-finger tap or long press to right-click.' })),
  ];
}

const GROUPS = { key: keyGroups, slider: sliderGroups, dial: dialGroups, info: infoGroups, trackpad: trackpadGroups };

function renderInspector() {
  $('#insp-empty').hidden = sel !== null;
  $('#insp').hidden = sel === null;
  setResult('');
  if (sel === null) return;
  const w = widgetOf();
  const body = $('#insp-body');
  $('#insp-actions').hidden = !w;
  if (!w) {
    $('#insp-kind').textContent = 'Add to this cell';
    $('#insp-where').textContent = `Column ${sel.x + 1}, row ${sel.y + 1}`;
    renderAddMenu(body);
    return;
  }
  $('#insp-kind').textContent = KINDS[w.kind].name;
  $('#insp-where').textContent = `${w.w} × ${w.h}`;
  const testable = w.kind === 'key' || w.kind === 'slider' || w.kind === 'dial';
  $('#test').hidden = !testable;
  $('#test').textContent = w.kind === 'key' || (w.kind === 'dial' && w.mode === 'relative') ? 'Test' : 'Read value';
  body.replaceChildren(...GROUPS[w.kind](w));
}

function setResult(text, kind = '') {
  const r = $('#test-result');
  r.textContent = text;
  r.className = `result ${kind}`;
}

async function runTest() {
  const w = widgetOf();
  if (!w) return;
  if (w.kind === 'key') {
    if (w.action.type === 'hotkey' || w.action.type === 'text') {
      setResult('Switch to the target window. Running in 2 seconds…');
      await new Promise((r) => setTimeout(r, 2000));
    }
    const r = await api.test(w.action);
    setResult(r.ok ? 'Done' : r.error, r.ok ? 'ok' : 'error');
  } else if (w.kind === 'dial' && w.mode === 'relative') {
    const r = await api.test(w.cw);
    setResult(r.ok ? 'Ran the clockwise action' : r.error, r.ok ? 'ok' : 'error');
  } else {
    const r = await api.targetGet(w.target);
    setResult(r.ok ? `Current value: ${r.text}` : r.error, r.ok ? 'ok' : 'error');
  }
}

/* ---------- icon picker ---------- */

async function openIconPicker(current, onPick) {
  if (!iconIndex) {
    const all = await api.iconList();
    const popular = new Set(POPULAR_ICONS);
    iconIndex = [...POPULAR_ICONS.map((n) => all.find((i) => i.name === n)).filter(Boolean), ...all.filter((i) => !popular.has(i.name))];
  }
  const dialog = $('#icon-dialog');
  const search = $('#icon-search');
  const grid = $('#icon-grid');
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = (q ? iconIndex.filter((i) => i.name.includes(q) || i.tags.includes(q)) : iconIndex).slice(0, 400);
    grid.replaceChildren(...(hits.length
      ? hits.map((i) => el('button', {
        type: 'button',
        className: current === `lucide:${i.name}` ? 'current' : '',
        title: i.name,
        'aria-label': i.name,
        onclick: () => { dialog.close(); onPick(`lucide:${i.name}`); },
      }, iconEl(i.name)))
      : [el('p', { className: 'icon-grid-empty', textContent: 'No icons match.' })]));
  };
  search.value = '';
  search.oninput = draw;
  $('#icon-text').value = current && !current.startsWith('lucide:') ? current : '';
  $('#icon-use-text').onclick = () => { dialog.close(); onPick($('#icon-text').value.trim()); };
  $('#icon-none').onclick = () => { dialog.close(); onPick(''); };
  draw();
  dialog.showModal();
  search.focus();
}

/* ---------- profile dialog ---------- */

function openProfileDialog() {
  const p = profile();
  $('#profile-name').value = p.name;
  $('#profile-apps').value = (p.apps || []).join(', ');
  $('#profile-msg').textContent = '';
  $('#del-profile').disabled = cfg.profiles.length < 2;
  $('#profile-dialog').showModal();
}

async function detectProgram() {
  const msg = $('#profile-msg');
  const button = $('#detect-app');
  button.disabled = true;
  try {
    for (let n = 5; n > 0; n--) {
      msg.textContent = `Switch to the program… ${n}`;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const r = await api.foreground();
    if (!r.ok) {
      msg.textContent = r.error;
      return;
    }
    if (/^(electron|pocketdeck)$/i.test(r.app)) {
      msg.textContent = 'PocketDeck was in front. Try again and switch to the other program.';
      return;
    }
    const p = profile();
    p.apps = p.apps || [];
    if (!p.apps.some((a) => a.toLowerCase() === r.app.toLowerCase())) p.apps.push(r.app);
    $('#profile-apps').value = p.apps.join(', ');
    msg.textContent = `Added ${r.app}`;
    save();
    renderProfiles();
  } finally {
    button.disabled = false;
  }
}

/* ---------- wiring ---------- */

function renderAll() {
  renderProfiles();
  renderPages();
  renderGrid();
  renderInspector();
}

function wire() {
  for (let n = 1; n <= 8; n++) {
    $('#cols').append(el('option', { value: n, textContent: n }));
    $('#rows').append(el('option', { value: n, textContent: n }));
  }

  const openConnect = () => $('#connect-dialog').showModal();
  const openSettings = () => $('#settings-dialog').showModal();
  $('#open-connect').addEventListener('click', openConnect);
  $('#open-connect-cta').addEventListener('click', openConnect);
  $('#open-settings').addEventListener('click', openSettings);
  $('#open-settings-obs').addEventListener('click', openSettings);

  $('#adapter').addEventListener('change', showUrl);
  $('#copy-url').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#url').textContent);
    $('#copy-url').textContent = 'Copied';
    setTimeout(() => { $('#copy-url').textContent = 'Copy'; }, 1500);
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Unpair every phone? Each one will need to scan the new code.')) return;
    const s = await api.resetToken();
    urls = s.urls;
    devices = s.devices;
    renderConnect();
    renderDevices();
  });

  $('#obs-url').value = cfg.obs.url;
  $('#obs-pass').value = cfg.obs.password;
  $('#obs-url').addEventListener('change', (e) => { cfg.obs.url = e.target.value.trim(); save(); });
  $('#obs-pass').addEventListener('change', (e) => { cfg.obs.password = e.target.value; save(); });
  $('#autostart').addEventListener('change', (e) => api.setAutostart(e.target.checked));

  $('#add-profile').addEventListener('click', () => {
    const first = { id: newId(), name: 'Main', cols: 4, rows: 3, widgets: [] };
    const p = { id: newId(), name: `Profile ${cfg.profiles.length + 1}`, apps: [], pages: [first] };
    cfg.profiles.push(p);
    save();
    selectProfile(p.id);
    openProfileDialog();
  });
  $('#profile-name').addEventListener('input', (e) => {
    profile().name = e.target.value.trim() || 'Profile';
    save();
    renderProfiles();
  });
  $('#profile-apps').addEventListener('change', (e) => {
    profile().apps = e.target.value.split(',').map((a) => a.trim().replace(/\.exe$/i, '')).filter(Boolean);
    save();
    renderProfiles();
  });
  $('#detect-app').addEventListener('click', detectProgram);
  $('#del-profile').addEventListener('click', () => {
    if (cfg.profiles.length < 2 || !confirm(`Delete the profile "${profile().name}" and all its pages?`)) return;
    cfg.profiles = cfg.profiles.filter((p) => p.id !== profileId);
    save();
    $('#profile-dialog').close();
    selectProfile(cfg.profiles[0].id);
  });

  $('#add-page').addEventListener('click', () => {
    const p = { id: newId(), name: `Page ${profile().pages.length + 1}`, cols: page().cols, rows: page().rows, widgets: [] };
    profile().pages.push(p);
    save();
    selectPage(p.id);
    $('#page-name').select();
  });
  $('#del-page').addEventListener('click', () => {
    if (profile().pages.length < 2 || !confirm(`Delete the page "${page().name}"?`)) return;
    profile().pages = profile().pages.filter((p) => p.id !== pageId);
    save();
    selectPage(profile().pages[0].id);
  });
  $('#page-name').addEventListener('input', (e) => {
    page().name = e.target.value.trim() || 'Page';
    save();
    renderPages();
  });
  const resize = () => {
    const p = page();
    const cols = Number($('#cols').value);
    const rows = Number($('#rows').value);
    const clipped = p.widgets.filter((w) => w.x + w.w > cols || w.y + w.h > rows).length;
    const msg = $('#page-msg');
    if (clipped) {
      msg.textContent = `${clipped} widget${clipped > 1 ? 's' : ''} would not fit. Move or remove ${clipped > 1 ? 'them' : 'it'} first.`;
      msg.hidden = false;
      $('#cols').value = p.cols;
      $('#rows').value = p.rows;
      return;
    }
    msg.hidden = true;
    p.cols = cols;
    p.rows = rows;
    sel = null;
    save();
    renderGrid();
    renderInspector();
  };
  $('#cols').addEventListener('change', resize);
  $('#rows').addEventListener('change', resize);

  $('#test').addEventListener('click', runTest);
  $('#clear').addEventListener('click', () => {
    if (sel && sel.id) page().widgets = page().widgets.filter((w) => w.id !== sel.id);
    sel = null;
    save();
    renderGrid();
    renderInspector();
  });

  addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === 'Escape' && sel && !document.querySelector('dialog[open]')) selectCell(null);
    if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && sel && sel.id && !document.querySelector('dialog[open]')) $('#clear').click();
  });

  api.on('obs', (s) => { obs = s; renderObs(); });
  api.on('clients', renderClients);
  api.on('devices', (d) => { devices = d; renderDevices(); });
  api.on('pairing', (u) => { urls = u; renderConnect(); }); // the code changes after each pairing and every 10 minutes
  api.on('log', addLog);
}

(async () => {
  setIcons();
  const s = await api.snapshot();
  cfg = s.config;
  obs = s.obs;
  urls = s.urls;
  devices = s.devices;
  profileId = cfg.profiles[0].id;
  pageId = profile().pages[0].id;
  $('#autostart').checked = s.autostart;
  wire();
  renderConnect();
  renderClients(s.clients);
  renderObs();
  [...s.logs].reverse().forEach(addLog);
  renderAll();
})();
