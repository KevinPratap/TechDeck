// PocketDeck phone app: draws the deck and talks to the PC over a WebSocket.
(() => {
  const $ = (s) => document.querySelector(s);
  const deckEl = $('#deck');
  const tabsEl = $('#tabs');
  const { glyph } = window.PDWidgets;

  const HOLD_MS = 500;        // press this long for a key's "hold" action
  const DOUBLE_TAP_MS = 280;  // second tap within this window is a double-tap
  const SWIPE_PX = 80;        // horizontal swipe distance that changes page

  let profiles = [];
  let profileId = null;
  let focusProfile = null;    // profile the program in front on the PC calls for
  let profileMode = localStorage.getItem('pd.profile') || 'auto';
  let pages = [];
  let pageId = null;
  let active = {};
  const values = {};
  const texts = {};
  const live = new Map();     // widget id -> (value, text) updater for what's on screen
  let ws = null;
  let retryMs = 500;

  // The QR link carries a one-time pairing code in the URL hash. It is traded for this phone's own token.
  const pairCode = location.hash.length > 1 ? location.hash.slice(1) : '';
  if (pairCode) history.replaceState(null, '', location.pathname);
  let token = localStorage.getItem('pd.token');

  function deviceName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    const android = /Android[^;]*;\s*([^;)]+?)(?:\s+Build|[;)])/.exec(ua);
    if (android) return android[1];
    return /Android/.test(ua) ? 'Android phone' : 'Browser';
  }

  async function pair() {
    overlay('Pairing…', true);
    try {
      const res = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairCode, name: deviceName() }) });
      if (res.status === 429) throw new Error('Too many attempts. Wait a minute and scan again.');
      if (!res.ok) throw new Error('This code has expired or was already used. Scan the QR code on your computer again.');
      localStorage.setItem('pd.token', (await res.json()).token);
      token = localStorage.getItem('pd.token');
      return true;
    } catch (e) {
      overlay(e instanceof TypeError ? 'Could not reach your computer. Check that you are on the same Wi-Fi.' : e.message);
      return false;
    }
  }

  /* ---------- feedback ---------- */

  function overlay(msg, busy = false) {
    $('#overlay').hidden = !msg;
    $('#overlay-msg').textContent = msg || '';
    $('#spinner').hidden = !busy;
  }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  const buzz = (pattern) => navigator.vibrate && navigator.vibrate(pattern);

  function flash(el, cls) {
    el.classList.remove('ok', 'err');
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
  }

  function setConnected(on) {
    const s = $('#status');
    s.classList.toggle('on', on);
    s.setAttribute('aria-label', on ? 'Connected' : 'Disconnected');
  }

  /* ---------- connection ---------- */

  function connect() {
    if (!token) {
      overlay('Open PocketDeck on your computer and scan its QR code.');
      return;
    }
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
      retryMs = 500;
      setConnected(true);
      overlay(null);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = (e) => {
      setConnected(false);
      if (e.code === 4001 || e.code === 4003) {
        localStorage.removeItem('pd.token');
        token = null;
        overlay('This phone was unpaired. Scan the QR code on your computer again.');
        return;
      }
      overlay('Reconnecting…', true);
      setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 5000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else toast('Not connected');
  }

  function onMessage(m) {
    switch (m.t) {
      case 'deck':
        profiles = m.profiles;
        applyProfile(false);
        break;
      case 'focus':
        focusProfile = m.profile;
        if (profileMode === 'auto') applyProfile(true);
        break;
      case 'values':
        applyValues(m.values, m.texts);
        break;
      case 'state':
        active = m.active;
        applyValues(m.values || {}, m.texts || {});
        $('#rec').hidden = !m.obs.recording;
        $('#live').hidden = !m.obs.streaming;
        $('#obs').hidden = m.obs.connected || !usesObs();
        paintActive();
        break;
      case 'result': {
        const el = deckEl.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
        if (el && el.classList.contains('key')) flash(el, m.ok ? 'ok' : 'err');
        if (!m.ok) {
          buzz([30, 60, 30]);
          toast(m.error);
        }
        break;
      }
      default:
        break;
    }
  }

  const usesObs = () => pages.some((p) => p.widgets.some((w) => w.action && w.action.type.startsWith('obs.')));

  function applyValues(v, t = {}) {
    Object.assign(values, v);
    Object.assign(texts, t);
    // Info tiles only have text, so walk the ids of both maps.
    for (const id of new Set([...Object.keys(v), ...Object.keys(t)])) {
      if (live.has(id)) live.get(id)(values[id], texts[id]);
    }
  }

  /* ---------- profiles and pages ---------- */

  // The profile this phone shows: the one picked here, or in auto mode the one the PC asks for.
  function currentProfile() {
    const want = profileMode === 'auto' ? focusProfile : profileMode;
    return profiles.find((p) => p.id === want) || profiles[0];
  }

  function applyProfile(announce) {
    // A profile picked here may have been deleted on the PC; fall back to following the PC.
    if (profileMode !== 'auto' && !profiles.some((p) => p.id === profileMode)) {
      profileMode = 'auto';
      localStorage.setItem('pd.profile', 'auto');
    }
    const prof = currentProfile();
    const changed = prof && prof.id !== profileId;
    profileId = prof ? prof.id : null;
    pages = prof ? prof.pages : [];
    pageId = localStorage.getItem(`pd.page.${profileId}`);
    if (!pages.some((p) => p.id === pageId)) pageId = pages[0] && pages[0].id;
    renderProfilePicker();
    render();
    if (changed && announce) toast(prof.name);
  }

  function renderProfilePicker() {
    const sel = $('#profile');
    sel.hidden = profiles.length < 2;
    const cur = currentProfile();
    const options = [['auto', cur ? `Auto · ${cur.name}` : 'Auto'], ...profiles.map((p) => [p.id, p.name])];
    sel.replaceChildren(...options.map(([value, text]) => new Option(text, value)));
    sel.value = profileMode;
  }

  $('#profile').addEventListener('change', (e) => {
    profileMode = e.target.value;
    localStorage.setItem('pd.profile', profileMode);
    applyProfile(false);
  });

  function setPage(id) {
    pageId = id;
    localStorage.setItem(`pd.page.${profileId}`, id);
    render();
  }

  /* ---------- rendering ---------- */

  function render() {
    tabsEl.replaceChildren(...(pages.length > 1 ? pages.map((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.name;
      if (p.id === pageId) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => setPage(p.id));
      return b;
    }) : []));

    live.clear();
    const page = pages.find((p) => p.id === pageId);
    if (!page) {
      deckEl.replaceChildren();
      return;
    }
    const taken = new Set();
    const nodes = page.widgets.map((w) => {
      for (let dy = 0; dy < w.h; dy++) for (let dx = 0; dx < w.w; dx++) taken.add((w.y + dy) * page.cols + w.x + dx);
      const el = (makers[w.kind] || makers.key)(w);
      el.dataset.id = w.id;
      el.style.gridColumn = `${w.x + 1} / span ${w.w}`;
      el.style.gridRow = `${w.y + 1} / span ${w.h}`;
      return el;
    });
    for (let i = 0; i < page.cols * page.rows; i++) {
      if (taken.has(i)) continue;
      const cell = document.createElement('div');
      cell.className = 'key empty';
      cell.style.gridColumn = String((i % page.cols) + 1);
      cell.style.gridRow = String(Math.floor(i / page.cols) + 1);
      nodes.push(cell);
    }
    deckEl.replaceChildren(...nodes);
    layout();
    paintActive();
    for (const [id, update] of live) if (values[id] !== undefined || texts[id] !== undefined) update(values[id], texts[id]);
  }

  // Square cells, as large as the screen allows.
  function layout() {
    const page = pages.find((p) => p.id === pageId);
    if (!page) return;
    const gap = 10;
    const r = deckEl.getBoundingClientRect();
    const w = r.width - 28;
    const h = r.height - 18;
    const k = Math.floor(Math.min((w - gap * (page.cols - 1)) / page.cols, (h - gap * (page.rows - 1)) / page.rows, 160));
    deckEl.style.gridTemplateColumns = `repeat(${page.cols}, ${k}px)`;
    deckEl.style.gridAutoRows = `${k}px`;
    deckEl.style.setProperty('--k', `${k}px`);
  }
  addEventListener('resize', layout);

  function paintActive() {
    for (const el of deckEl.children) {
      if (!el.dataset.id) continue;
      const on = !!active[el.dataset.id];
      el.classList.toggle('active', on);
      if (el.setLook) el.setLook(on);
    }
  }

  const hasAction = (a) => !!a && a.type !== 'none';
  const ctx = {
    live,
    buzz,
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
  };

  const makers = {
    key: makeKey,
    info: makeInfo,
    slider: (w) => window.PDWidgets.slider(w, ctx),
    dial: (w) => window.PDWidgets.dial(w, ctx),
    trackpad: (w) => window.PDWidgets.trackpad(w, ctx),
  };

  function makeKey(w) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'key';
    const icon = document.createElement('span');
    icon.className = 'glyph';
    const label = document.createElement('span');
    label.className = 'label';
    el.append(icon, label);
    if (w.image) {
      el.classList.add('has-img');
      el.style.setProperty('--img', `url("img/${encodeURIComponent(w.image)}")`);
    }
    // While OBS reports the key as on, it can show a different icon, label and colour.
    el.setLook = (on) => {
      el.style.setProperty('--c', (on && w.activeColor) || w.color || '#64748b');
      glyph(icon, (on && w.activeIcon) || w.icon);
      label.textContent = (on && w.activeLabel) || w.label || '';
      el.setAttribute('aria-label', label.textContent || 'Key');
    };
    el.setLook(false);
    bindPress(el, w);
    return el;
  }

  function makeInfo(w) {
    const el = document.createElement('div');
    el.className = 'info';
    el.style.setProperty('--c', w.color || '#64748b');
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = '–';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = w.label || '';
    el.append(value, label);
    live.set(w.id, (_v, text) => {
      if (text === undefined) return;
      value.textContent = text;
      value.classList.toggle('long', text.length > 6); // timers like 00:18:07 need a smaller size to fit
    });
    if (hasAction(w.action)) {
      el.classList.add('tappable');
      bindPress(el, w);
    }
    return el;
  }

  // Tap, hold, double-tap, and hotkeys that stay down while pressed (push-to-talk).
  function bindPress(el, w) {
    const held = w.kind === 'key' && w.action && w.action.type === 'hotkey' && w.action.mode === 'held';
    const hasHold = hasAction(w.hold);
    const hasDouble = hasAction(w.double);
    let holdTimer = null;
    let tapTimer = null;
    let holdFired = false;
    let isDown = false;

    const fire = (gesture) => {
      const a = gesture === 'hold' ? w.hold : gesture === 'double' ? w.double : w.action;
      if (!hasAction(a)) return;
      if (a.type === 'page') {
        if (pages.some((p) => p.id === a.page)) setPage(a.page);
        return;
      }
      send({ t: 'press', id: w.id, gesture });
    };
    const release = () => {
      el.classList.remove('down');
      clearTimeout(holdTimer);
      if (held && isDown) send({ t: 'up', id: w.id });
      isDown = false;
    };

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('down');
      isDown = true;
      holdFired = false;
      buzz(12);
      if (held) {
        send({ t: 'down', id: w.id });
        return;
      }
      if (hasHold) {
        holdTimer = setTimeout(() => {
          holdFired = true;
          buzz([20, 40, 20]);
          el.classList.remove('down');
          fire('hold');
        }, HOLD_MS);
      }
    });
    el.addEventListener('pointerleave', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerup', () => {
      if (!isDown) return;
      const longPress = holdFired;
      release();
      if (held || longPress) return;
      if (!hasDouble) {
        fire('tap');
      } else if (tapTimer) {
        clearTimeout(tapTimer);
        tapTimer = null;
        fire('double');
      } else {
        tapTimer = setTimeout(() => {
          tapTimer = null;
          fire('tap');
        }, DOUBLE_TAP_MS);
      }
    });
  }

  /* ---------- page swipe ---------- */

  // Swipe sideways to change page. Not on controls that are themselves dragged.
  let swipe = null;
  deckEl.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    const onControl = e.target.closest('.slider, .dial, .trackpad');
    swipe = e.touches.length === 1 && !onControl ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  deckEl.addEventListener('touchmove', (e) => {
    if (e.touches.length > 1) swipe = null;
  }, { passive: true });
  deckEl.addEventListener('touchend', (e) => {
    if (!swipe || pages.length < 2) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipe.x;
    const dy = t.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
    const i = pages.findIndex((p) => p.id === pageId);
    setPage(pages[(i + (dx < 0 ? 1 : -1) + pages.length) % pages.length].id);
  });

  /* ---------- screen ---------- */

  $('#fs').addEventListener('click', () => {
    const d = document.documentElement;
    if (document.fullscreenElement) document.exitFullscreen();
    else if (d.requestFullscreen) d.requestFullscreen().catch(() => toast('Use Add to Home Screen for full screen'));
    else toast('Use Share → Add to Home Screen for full screen');
  });

  async function keepAwake() {
    try {
      if (navigator.wakeLock) await navigator.wakeLock.request('screen');
    } catch {
      // Not allowed on plain http in some browsers.
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') keepAwake();
  });
  keepAwake();

  (async () => {
    if (pairCode && !(await pair())) return;
    connect();
  })();
})();
