// Plays soundboard files on this PC through a hidden window, so each sound can
// go to a chosen output device (for example a virtual cable that feeds OBS).
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

class SoundPlayer {
  // baseUrl: where the deck server serves /snd/<file>, e.g. http://127.0.0.1:8787
  constructor(media, baseUrl) {
    this.media = media;
    this.baseUrl = baseUrl;
    this.win = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    ipcMain.on('audio-reply', (_e, m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
    });
  }

  start() {
    if (this.ready) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'ui', 'audio-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    this.win.on('closed', () => { this.win = null; this.ready = null; });
    this.ready = this.win.loadFile(path.join(__dirname, 'ui', 'audio.html'));
    return this.ready;
  }

  async call(cmd, args = {}) {
    await this.start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The sound player did not answer')); }, 8000);
      this.pending.set(id, { resolve, reject, timer });
      this.win.webContents.send('audio', { id, cmd, ...args });
    });
  }

  // The action from a key: { type: 'sound', file, device, volume, mode }.
  play(action) {
    if (!this.media.exists('sound', action.file)) throw new Error('Choose a sound file for this key');
    return this.call('play', {
      url: `${this.baseUrl}/snd/${action.file}`,
      file: action.file,
      device: action.device || '',
      volume: Math.min(1, Math.max(0, (action.volume ?? 100) / 100)),
      mode: action.mode || 'restart',
    });
  }

  devices() {
    return this.call('devices');
  }

  stop() {
    if (this.win) this.win.destroy();
  }
}

module.exports = { SoundPlayer };
