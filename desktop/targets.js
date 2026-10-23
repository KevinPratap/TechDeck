// Things a slider or dial can control. Every target reads and writes a value
// between 0 and 1, plus a short text for display ("42%", "-12.0 dB").
//
//   { type: 'win.master' }                       computer volume
//   { type: 'win.app', app: 'spotify' }          one program's volume
//   { type: 'win.brightness' }                   laptop screen brightness
//   { type: 'obs.volume', input: 'Mic/Aux' }     OBS audio source volume
//   { type: 'obs.filter', source, filter, setting, min, max }
//   { type: 'obs.transition', min, max }         transition length in ms
const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const clamp = (v) => Math.min(1, Math.max(0, v));
const pct = (v) => `${Math.round(v * 100)}%`;

// One hidden PowerShell process shared by all Windows targets.
class WinHelper {
  constructor() {
    this.proc = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      // In the installed app this file ships outside app.asar, where PowerShell can read it.
      const script = path.join(__dirname, 'native', 'winaudio.ps1').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = proc;
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.ready) return resolve();
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error || 'helper error'));
      });
      proc.on('error', reject);
      proc.on('exit', () => {
        this.proc = null;
        this.ready = null; // next call starts a fresh helper
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Audio helper stopped')); }
        this.pending.clear();
        reject(new Error('Audio helper stopped'));
      });
    });
    return this.ready;
  }

  async call(cmd, args = {}) {
    if (process.platform !== 'win32') throw new Error('This control only works on Windows');
    await this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Audio helper did not answer'));
      }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n');
    });
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}

class Targets {
  constructor(obs) {
    this.obs = obs;
    this.win = new WinHelper();
  }

  // -> { v: 0..1, text }
  async get(t) {
    switch (t.type) {
      case 'win.master': {
        const r = await this.win.call('getMaster');
        return { v: r.v, text: r.mute ? 'muted' : pct(r.v) };
      }
      case 'win.app': {
        const r = await this.win.call('getApp', { app: t.app });
        return { v: r.v, text: r.mute ? 'muted' : pct(r.v) };
      }
      case 'win.brightness': {
        const r = await this.win.call('getBrightness');
        return { v: r.v, text: pct(r.v) };
      }
      case 'obs.volume': {
        const r = await this.obs.call('GetInputVolume', { inputName: t.input });
        // Fader runs -60 dB..0 dB like OBS's mixer; anything quieter is "off".
        const db = r.inputVolumeDb;
        return { v: clamp((db + 60) / 60), text: db <= -60 ? 'off' : `${db.toFixed(1)} dB` };
      }
      case 'obs.filter': {
        const r = await this.obs.call('GetSourceFilter', { sourceName: t.source, filterName: t.filter });
        const raw = Number(r.filterSettings[t.setting]);
        const [min, max] = range(t);
        return { v: clamp((raw - min) / (max - min)), text: String(Math.round(raw * 100) / 100) };
      }
      case 'obs.transition': {
        const r = await this.obs.call('GetCurrentSceneTransition');
        const [min, max] = range(t, 50, 2000);
        const ms = r.transitionDuration || min;
        return { v: clamp((ms - min) / (max - min)), text: `${ms} ms` };
      }
      default:
        throw new Error(`Unknown control "${t.type}"`);
    }
  }

  // Sets the value and returns { v, text } as it ended up.
  async set(t, v) {
    v = clamp(v);
    switch (t.type) {
      case 'win.master':
        await this.win.call('setMaster', { v });
        return { v, text: pct(v) };
      case 'win.app':
        await this.win.call('setApp', { app: t.app, v });
        return { v, text: pct(v) };
      case 'win.brightness':
        await this.win.call('setBrightness', { v });
        return { v, text: pct(v) };
      case 'obs.volume': {
        if (v === 0) await this.obs.call('SetInputVolume', { inputName: t.input, inputVolumeMul: 0 });
        else await this.obs.call('SetInputVolume', { inputName: t.input, inputVolumeDb: -60 + 60 * v });
        return { v, text: v === 0 ? 'off' : `${(-60 + 60 * v).toFixed(1)} dB` };
      }
      case 'obs.filter': {
        const [min, max] = range(t);
        const raw = min + v * (max - min);
        await this.obs.call('SetSourceFilterSettings', {
          sourceName: t.source, filterName: t.filter, filterSettings: { [t.setting]: raw }, overlay: true,
        });
        return { v, text: String(Math.round(raw * 100) / 100) };
      }
      case 'obs.transition': {
        const [min, max] = range(t, 50, 2000);
        const ms = Math.round(min + v * (max - min));
        await this.obs.call('SetCurrentSceneTransitionDuration', { transitionDuration: ms });
        return { v, text: `${ms} ms` };
      }
      default:
        throw new Error(`Unknown control "${t.type}"`);
    }
  }

  async step(t, n, size) {
    const cur = await this.get(t);
    return this.set(t, cur.v + n * size);
  }

  // Programs that currently play audio, for the editor's picker.
  async audioApps() {
    const r = await this.win.call('sessions');
    return [...new Set(r.sessions.map((s) => s.name).filter((n) => n !== 'System sounds'))];
  }

  // Whether this target needs OBS to be connected, so the poller can skip it quietly.
  needsObs(t) {
    return t.type.startsWith('obs.');
  }

  stop() {
    this.win.stop();
  }
}

function range(t, dMin = 0, dMax = 100) {
  const min = t.min === undefined || t.min === '' ? dMin : Number(t.min);
  let max = t.max === undefined || t.max === '' ? dMax : Number(t.max);
  if (!(max > min)) max = min + 1;
  return [min, max];
}

module.exports = { Targets };
