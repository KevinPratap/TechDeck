// The editor's only bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['obs', 'clients', 'log', 'pairing', 'devices']);

contextBridge.exposeInMainWorld('pd', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  save: (patch) => ipcRenderer.invoke('save', patch),
  resetToken: () => ipcRenderer.invoke('reset-token'),
  revokeDevice: (id) => ipcRenderer.invoke('revoke-device', id),
  setAutostart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  test: (action) => ipcRenderer.invoke('test', action),
  targetGet: (target) => ipcRenderer.invoke('target-get', target),
  foreground: () => ipcRenderer.invoke('foreground'),
  audioApps: () => ipcRenderer.invoke('audio-apps'),
  audioDevices: () => ipcRenderer.invoke('audio-devices'),
  iconList: () => ipcRenderer.invoke('icon-list'),
  pickMedia: (kind) => ipcRenderer.invoke('pick-media', kind),
  on: (channel, fn) => {
    if (EVENTS.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
