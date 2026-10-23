const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audioBridge', {
  on: (fn) => ipcRenderer.on('audio', (_e, msg) => fn(msg)),
  reply: (msg) => ipcRenderer.send('audio-reply', msg),
});
