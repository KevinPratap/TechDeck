// Runs a button's action on this computer.
const { spawn } = require('child_process');

let nut = null;
function keyboard() {
  if (!nut) {
    nut = require('@nut-tree-fork/nut-js');
    nut.keyboard.config.autoDelayMs = 10;
    nut.mouse.config.autoDelayMs = 0; // the phone already paces its motion
  }
  return nut;
}

const ALIASES = {
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', option: 'LeftAlt',
  win: 'LeftSuper', super: 'LeftSuper', meta: 'LeftSuper', cmd: 'LeftCmd', command: 'LeftCmd',
  enter: 'Enter', return: 'Return', esc: 'Escape', escape: 'Escape', space: 'Space', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PageUp', pagedown: 'PageDown', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  printscreen: 'Print', prtsc: 'Print', '-': 'Minus', '=': 'Equal', ',': 'Comma', '.': 'Period',
  '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'LeftBracket', ']': 'RightBracket', '`': 'Grave',
};

const MEDIA = {
  playpause: 'AudioPlay', next: 'AudioNext', prev: 'AudioPrev', stop: 'AudioStop',
  mute: 'AudioMute', volup: 'AudioVolUp', voldown: 'AudioVolDown',
};

// "ctrl+shift+F13" -> [Key.LeftControl, Key.LeftShift, Key.F13]
function parseKeys(combo) {
  const { Key } = keyboard();
  return combo.split('+').map((raw) => {
    const k = raw.trim();
    const lower = k.toLowerCase();
    let name = ALIASES[lower];
    if (!name && /^[a-z]$/.test(lower)) name = lower.toUpperCase();
    if (!name && /^[0-9]$/.test(lower)) name = 'Num' + lower;
    if (!name && /^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) name = lower.toUpperCase();
    if (!name) name = Object.keys(Key).find((n) => n.toLowerCase() === lower);
    if (!name || Key[name] === undefined) throw new Error(`Unknown key "${k}"`);
    return Key[name];
  });
}

async function tap(keys) {
  const { keyboard: kb } = keyboard();
  await kb.pressKey(...keys);
  await kb.releaseKey(...keys);
}

function openTarget(target) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', target] : [target];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function obsOutput(obs, kind, mode) {
  const name = kind === 'record' ? 'Record' : 'Stream';
  const req = { toggle: `Toggle${name}`, start: `Start${name}`, stop: `Stop${name}` }[mode || 'toggle'];
  await obs.call(req);
}

// A web request for webhooks (Home Assistant, Streamer.bot, IFTTT...). Headers are "Name: value" lines.
async function httpRequest(a) {
  const url = String(a.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('Web request needs a URL starting with http:// or https://');
  const method = a.method || 'GET';
  const headers = {};
  for (const line of String(a.headers || '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const init = { method, headers, signal: AbortSignal.timeout(8000) };
  if (method !== 'GET' && a.body) {
    init.body = a.body;
    const hasType = Object.keys(headers).some((h) => h.toLowerCase() === 'content-type');
    if (!hasType) headers['Content-Type'] = /^\s*[[{]/.test(a.body) ? 'application/json' : 'text/plain';
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    const code = e.cause?.code || e.cause?.errors?.[0]?.code;
    const why = { ECONNREFUSED: 'connection refused', ENOTFOUND: 'address not found', ETIMEDOUT: 'timed out', ECONNRESET: 'connection dropped' }[code];
    throw new Error(`Web request failed: ${e.name === 'TimeoutError' ? 'no answer after 8 seconds' : why || code || e.message}`);
  }
  if (!res.ok) throw new Error(`Web request failed: ${res.status} ${res.statusText}`.trim());
}

// Push-to-talk: keys stay down until released.
async function pressKeys(combo) {
  const keys = parseKeys(combo);
  await keyboard().keyboard.pressKey(...keys);
  return keys;
}

async function releaseKeys(keys) {
  await keyboard().keyboard.releaseKey(...keys);
}

// Trackpad widget: the phone sends relative motion, taps and scroll notches.
async function mouseMove(dx, dy) {
  const { mouse, Point } = keyboard();
  const p = await mouse.getPosition();
  await mouse.setPosition(new Point(p.x + dx, p.y + dy));
}

async function mouseClick(button) {
  const { mouse, Button } = keyboard();
  await mouse.click(button === 'right' ? Button.RIGHT : Button.LEFT);
}

// Positive steps scroll up (content moves down), like a mouse wheel rolled away from you.
// nut-js counts in wheel units: 120 is a full notch (about 100 px of page), so a step is
// a quarter notch and a two-finger drag on the phone scrolls smoothly.
const UNITS_PER_STEP = 30;

async function mouseScroll(steps) {
  const { mouse } = keyboard();
  if (steps > 0) await mouse.scrollUp(steps * UNITS_PER_STEP);
  else if (steps < 0) await mouse.scrollDown(-steps * UNITS_PER_STEP);
}

async function run(action, ctx) {
  const { obs } = ctx;
  switch (action.type) {
    case 'obs.scene':
      return obs.call('SetCurrentProgramScene', { sceneName: action.scene });
    case 'obs.record':
      return obsOutput(obs, 'record', action.mode);
    case 'obs.stream':
      return obsOutput(obs, 'stream', action.mode);
    case 'obs.mute':
      return obs.call('ToggleInputMute', { inputName: action.input });
    case 'obs.replaySave':
      return obs.call('SaveReplayBuffer');
    case 'obs.sourceVisible': {
      const { sceneItemId } = await obs.call('GetSceneItemId', { sceneName: action.scene, sourceName: action.source });
      const { sceneItemEnabled } = await obs.call('GetSceneItemEnabled', { sceneName: action.scene, sceneItemId });
      return obs.call('SetSceneItemEnabled', { sceneName: action.scene, sceneItemId, sceneItemEnabled: !sceneItemEnabled });
    }
    case 'obs.virtualcam':
      return obs.call('ToggleVirtualCam');
    case 'obs.studio': {
      const { studioModeEnabled } = await obs.call('GetStudioModeEnabled');
      return obs.call('SetStudioModeEnabled', { studioModeEnabled: !studioModeEnabled });
    }
    case 'obs.studioTransition':
      return obs.call('TriggerStudioModeTransition');
    case 'obs.filter': {
      const { filterEnabled } = await obs.call('GetSourceFilter', { sourceName: action.source, filterName: action.filter });
      return obs.call('SetSourceFilterEnabled', { sourceName: action.source, filterName: action.filter, filterEnabled: !filterEnabled });
    }
    case 'obs.chapter':
      return obs.call('CreateRecordChapter', action.name ? { chapterName: action.name } : {});
    case 'hotkey':
      return tap(parseKeys(action.keys));
    case 'http':
      return httpRequest(action);
    case 'sound':
      if (!ctx.sound) throw new Error('Sound playback needs the desktop app');
      return ctx.sound(action);
    case 'lock':
      if (process.platform !== 'win32') throw new Error('Lock PC only works on Windows');
      spawn('rundll32.exe', ['user32.dll,LockWorkStation'], { detached: true, stdio: 'ignore' }).unref();
      return;
    case 'media': {
      const { Key } = keyboard();
      return tap([Key[MEDIA[action.key]]]);
    }
    case 'text':
      return keyboard().keyboard.type(action.text);
    case 'open':
      return openTarget(action.target);
    case 'delay':
      return wait(Number(action.ms) || 0);
    case 'multi':
      for (const step of action.steps || []) await run(step, ctx);
      return;
    case 'page':
    case 'none':
      return; // handled on the phone
    default:
      throw new Error(`Unknown action type "${action.type}"`);
  }
}

// Whether a button should look "on", based on OBS state.
function isActive(action, obsState) {
  if (!action || !obsState.connected) return false;
  switch (action.type) {
    case 'obs.scene': return obsState.scene === action.scene;
    case 'obs.record': return obsState.recording;
    case 'obs.stream': return obsState.streaming;
    case 'obs.mute': return !!obsState.muted[action.input];
    default: return false;
  }
}

module.exports = { run, isActive, parseKeys, pressKeys, releaseKeys, mouseMove, mouseClick, mouseScroll };
