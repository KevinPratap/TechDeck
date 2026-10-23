// Slider, dial and trackpad widgets. app.js passes a context with:
//   live  Map of widget id -> (value, text) updater, so the PC can move them
//   send  sends a message to the PC; returns false when not connected
//   buzz  vibrates where supported (Android)
window.PDWidgets = (() => {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  // After a touch ends, ignore updates from the PC briefly so the control doesn't jump back.
  const SETTLE_MS = 700;

  // "lucide:mic" draws that icon; anything else (an emoji, a letter) is shown as text.
  function glyph(el, value) {
    const m = /^lucide:([a-z0-9-]+)$/.exec(value || '');
    el.classList.toggle('icon', !!m);
    el.style.setProperty('--icon', m ? `url("icons/${m[1]}.svg")` : 'none');
    el.textContent = m ? '' : value || '';
  }

  function span(className, text) {
    const s = document.createElement('span');
    s.className = className;
    if (text !== undefined) s.textContent = text;
    return s;
  }

  // Calls fn with the latest argument at most every `ms`; flush() sends at once.
  function throttle(fn, ms = 33) {
    let timer = null;
    let arg;
    const t = (a) => {
      arg = a;
      if (!timer) timer = setTimeout(() => { timer = null; fn(arg); }, ms);
    };
    t.flush = (a) => {
      clearTimeout(timer);
      timer = null;
      fn(a);
    };
    return t;
  }

  function slider(w, ctx) {
    const horiz = w.orient === 'h';
    const el = document.createElement('div');
    el.className = `slider ${horiz ? 'h' : 'v'}`;
    el.style.setProperty('--c', w.color || '#22c55e');
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', w.label || 'Slider');

    const head = span('slider-head');
    const name = span('name');
    const icon = span('glyph');
    glyph(icon, w.icon);
    name.append(icon, span('', w.label || ''));
    const valueEl = span('value', '–');
    head.append(name, valueEl);
    const track = document.createElement('div');
    track.className = 'slider-track';
    track.append(span('slider-fill'));
    el.append(head, track);

    let dragging = false;
    let settledAt = 0;
    let tick = -1;
    const show = (v, text) => {
      el.style.setProperty('--p', v);
      valueEl.textContent = text || `${Math.round(v * 100)}%`;
      el.setAttribute('aria-valuenow', Math.round(v * 100));
    };
    ctx.live.set(w.id, (v, text) => {
      if (!dragging && Date.now() - settledAt > SETTLE_MS) show(v, text);
    });

    const send = throttle((v) => ctx.send({ t: 'value', id: w.id, v }));
    const valueAt = (e) => {
      const r = track.getBoundingClientRect();
      return clamp01(horiz ? (e.clientX - r.left) / r.width : 1 - (e.clientY - r.top) / r.height);
    };
    const update = (e, final) => {
      const v = valueAt(e);
      show(v);
      const step = Math.round(v * 10);
      if (step !== tick) {
        tick = step;
        ctx.buzz(5);
      }
      if (final) send.flush(v);
      else send(v);
    };

    track.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      tick = -1;
      track.setPointerCapture(e.pointerId);
      update(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (dragging) update(e);
    });
    track.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      settledAt = Date.now();
      update(e, true);
    });
    track.addEventListener('pointercancel', () => {
      dragging = false;
      settledAt = Date.now();
    });
    return el;
  }

  const SWEEP = 270; // degrees, from the lower left over the top to the lower right
  const ARC = (2 * Math.PI * 40 * SWEEP) / 360;

  function dial(w, ctx) {
    const relative = w.mode === 'relative';
    const stepPct = Number(w.step) || 2;
    const degPerStep = Number(w.degrees) || 15;
    const el = document.createElement('div');
    el.className = 'dial';
    el.style.setProperty('--c', w.color || '#3b82f6');
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', w.label || 'Dial');
    el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true">'
      + `<circle class="track" cx="50" cy="50" r="40" stroke-dasharray="${ARC} 999" transform="rotate(135 50 50)"/>`
      + '<circle class="arc" cx="50" cy="50" r="40" stroke-dasharray="0 999" transform="rotate(135 50 50)"/>'
      + '<circle class="knob" cx="50" cy="50" r="28"/>'
      + '<line class="pointer" x1="50" y1="50" x2="50" y2="30"/></svg>';
    const strip = span('dial-strip');
    const valueEl = span('value');
    strip.append(span('label', w.label || ''), valueEl);
    el.append(strip);
    const svg = el.querySelector('svg');
    const arc = el.querySelector('.arc');
    const pointer = el.querySelector('.pointer');

    let v = 0;
    let angle = 0;
    let settledAt = 0;
    const draw = (text) => {
      if (relative) {
        pointer.setAttribute('transform', `rotate(${angle} 50 50)`);
        valueEl.textContent = text || '';
        return;
      }
      arc.setAttribute('stroke-dasharray', `${ARC * v} 999`);
      pointer.setAttribute('transform', `rotate(${-SWEEP / 2 + SWEEP * v} 50 50)`);
      valueEl.textContent = text || `${Math.round(v * 100)}%`;
    };
    ctx.live.set(w.id, (nv, text) => {
      if (relative || Date.now() - settledAt < SETTLE_MS) return;
      v = nv;
      draw(text);
    });
    draw(relative ? '' : '–');

    // Steps go out in small batches so a fast spin doesn't flood the connection.
    let pending = 0;
    let flushTimer = null;
    const flush = () => {
      flushTimer = null;
      if (pending) ctx.send({ t: 'turn', id: w.id, steps: pending });
      pending = 0;
    };
    const turned = (steps) => {
      pending += steps;
      if (!flushTimer) flushTimer = setTimeout(flush, 40);
      ctx.buzz(6);
      settledAt = Date.now();
      if (relative) {
        angle += steps * degPerStep;
        draw();
      } else {
        v = clamp01(v + (steps * stepPct) / 100);
        draw();
      }
    };

    let drag = null;
    const angleOf = (e, c) => (Math.atan2(e.clientY - c.y, e.clientX - c.x) * 180) / Math.PI;
    svg.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      const r = svg.getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      drag = { c, last: angleOf(e, c), acc: 0, travelled: 0, steps: 0, t0: Date.now() };
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const a = angleOf(e, drag.c);
      let d = a - drag.last;
      if (d > 180) d -= 360;
      if (d < -180) d += 360;
      drag.last = a;
      drag.acc += d;
      drag.travelled += Math.abs(d);
      const steps = Math.trunc(drag.acc / degPerStep);
      if (steps) {
        drag.acc -= steps * degPerStep;
        drag.steps += Math.abs(steps);
        turned(steps);
      }
    });
    const release = (e) => {
      if (!drag) return;
      const tap = e.type === 'pointerup' && !drag.steps && drag.travelled < 10 && Date.now() - drag.t0 < 400;
      drag = null;
      if (tap && w.press && w.press.type !== 'none') {
        ctx.buzz(12);
        ctx.send({ t: 'press', id: w.id, gesture: 'tap' });
      }
    };
    svg.addEventListener('pointerup', release);
    svg.addEventListener('pointercancel', release);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      turned(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    return el;
  }

  // Drag to move, tap to click, two fingers to scroll, two-finger tap or long press to right-click.
  function trackpad(w, ctx) {
    const speed = Number(w.speed) || 1.5;
    const natural = w.natural !== false;
    const MOVE_AT = 6;     // px of travel before a touch counts as a drag, not a tap
    const SCROLL_PX = 14;  // px of two-finger travel per scroll step
    const LONG_PRESS_MS = 600;

    const el = document.createElement('div');
    el.className = 'trackpad';
    el.style.setProperty('--c', w.color || '#3b82f6');
    el.setAttribute('aria-label', w.label || 'Trackpad');
    const icon = span('glyph');
    glyph(icon, 'lucide:mouse-pointer-2');
    el.append(icon, span('label', w.label || 'Trackpad'));
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    const pointers = new Map();
    let g = null;
    let timer = null;
    let pdx = 0;
    let pdy = 0;
    let scrollAcc = 0;

    // Motion goes out about 60 times a second in whole pixels; the remainder carries over.
    const flush = () => {
      timer = null;
      const dx = Math.trunc(pdx);
      const dy = Math.trunc(pdy);
      if (!dx && !dy) return;
      pdx -= dx;
      pdy -= dy;
      ctx.send({ t: 'move', id: w.id, dx, dy });
    };
    const addMove = (dx, dy) => {
      const gain = speed * (1 + Math.min(2, Math.hypot(dx, dy) / 14)); // quick flicks travel further
      pdx += dx * gain;
      pdy += dy * gain;
      if (!timer) timer = setTimeout(flush, 16);
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.classList.add('touching');
      if (pointers.size === 1) {
        g = { fingers: 1, t0: Date.now(), travelled: 0, longPress: false };
        g.longTimer = setTimeout(() => {
          if (!g || g.fingers !== 1 || g.travelled >= MOVE_AT) return;
          g.longPress = true;
          ctx.buzz(20);
          ctx.send({ t: 'click', id: w.id, button: 'right' });
        }, LONG_PRESS_MS);
      } else if (g) {
        clearTimeout(g.longTimer);
        g.fingers = Math.max(g.fingers, pointers.size);
      }
    });

    el.addEventListener('pointermove', (e) => {
      const p = pointers.get(e.pointerId);
      if (!p || !g) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      g.travelled += Math.abs(dx) + Math.abs(dy);
      if (g.longPress) return;
      if (pointers.size >= 2) {
        // Both fingers report motion, so each counts for half.
        scrollAcc += (natural ? dy : -dy) / 2;
        const steps = Math.trunc(scrollAcc / SCROLL_PX);
        if (steps) {
          scrollAcc -= steps * SCROLL_PX;
          ctx.send({ t: 'scroll', id: w.id, steps });
        }
      } else if (g.travelled >= MOVE_AT) {
        clearTimeout(g.longTimer);
        addMove(dx, dy);
      }
    });

    const end = (e) => {
      if (!pointers.delete(e.pointerId) || pointers.size) return;
      el.classList.remove('touching');
      if (g) {
        clearTimeout(g.longTimer);
        const tap = e.type === 'pointerup' && !g.longPress && g.travelled < MOVE_AT && Date.now() - g.t0 < 300;
        if (tap) {
          ctx.buzz(8);
          ctx.send({ t: 'click', id: w.id, button: g.fingers >= 2 ? 'right' : 'left' });
        }
      }
      g = null;
      scrollAcc = 0;
      clearTimeout(timer);
      flush();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    return el;
  }

  return { glyph, slider, dial, trackpad };
})();
