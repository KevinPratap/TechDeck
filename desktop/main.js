// Electron entry: runs the deck server, the editor window and the tray icon.
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { ConfigStore } = require('./config');
const { DeckServer } = require('./server');
const { MediaStore } = require('./media');
const { SoundPlayer } = require('./sound');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const CONFIG_DIR = process.env.POCKETDECK_DIR || path.join(os.homedir(), '.pocketdeck');
const LOG_FILE = path.join(CONFIG_DIR, 'pocketdeck.log');
const MAX_LOG_BYTES = 512 * 1024;
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let server = null;
let player = null;
let quitting = false;
let trayHintShown = false;
let clients = [];
const activity = [];

// Unexpected errors go to a log file next to the config instead of taking the app down.
function logError(where, err) {
  const line = `${new Date().toISOString()} ${where}: ${err && err.stack ? err.stack : err}\n`;
  console.error(line.trim());
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // Keep one previous log: when the current one is full it becomes pocketdeck.log.1.
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Nothing else to do if the log can't be written.
  }
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled rejection', e));

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Encrypts the OBS password with the Windows account (DPAPI) so it isn't readable in the config file.
function secretsCodec() {
  if (!safeStorage.isEncryptionAvailable()) return null;
  return {
    encrypt: (text) => safeStorage.encryptString(text).toString('base64'),
    decrypt: (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64')),
  };
}

const urlsWithQr = () => Promise.all(server.urls().map(async (u) => ({ ...u, qr: await QRCode.toDataURL(u.url, { margin: 1, width: 520 }) })));

async function snapshot() {
  const urls = await urlsWithQr();
  const { profiles, obs, port, autostart } = server.config.data;
  return {
    devices: server.config.publicDevices(),
    config: { profiles, obs, port },
    autostart: !!autostart,
    urls,
    obs: { ...server.obs.snapshot(), error: server.obs.lastError },
    clients,
    logs: activity,
  };
}

/* ---------- windows ---------- */

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 620,
    show: false,
    backgroundColor: '#09090b',
    title: 'PocketDeck',
    icon: path.join(__dirname, 'ui', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // The editor never navigates; links open in the browser.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing hides to the tray; only Quit stops the server.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({ title: 'PocketDeck is still running', content: 'Phones stay connected. Right-click the tray icon to quit.', iconType: 'info' });
    }
  });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/* ---------- start with Windows ---------- */

function setAutostart(enabled) {
  server.config.update({ autostart: enabled });
  if (process.env.POCKETDECK_NO_AUTOSTART) return;
  // An unpackaged run is electron.exe plus the app folder.
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  app.setLoginItemSettings({ openAtLogin: enabled, args });
  updateTrayMenu();
}

/* ---------- tray ---------- */

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open PocketDeck', click: showWindow },
    { label: 'Start with Windows', type: 'checkbox', checked: !!server.config.data.autostart, click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png')));
  tray.setToolTip('PocketDeck');
  tray.on('click', showWindow);
  updateTrayMenu();
}

/* ---------- IPC ---------- */

// Wraps a handler so failures come back as { ok: false, error } instead of throwing in the renderer.
const safely = (fn) => async (...args) => {
  try {
    return { ok: true, ...(await fn(...args)) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

function registerIpc() {
  ipcMain.handle('snapshot', snapshot);
  ipcMain.handle('save', safely((_e, patch) => {
    server.applyConfig({ profiles: patch.profiles, obs: patch.obs });
    return {};
  }));
  ipcMain.handle('revoke-device', (_e, id) => {
    server.revokeDevice(String(id));
    return server.config.publicDevices();
  });
  ipcMain.handle('reset-token', () => {
    server.resetToken();
    return snapshot();
  });
  ipcMain.handle('set-autostart', (_e, enabled) => setAutostart(!!enabled));
  ipcMain.handle('test', safely((_e, action) => server.runAction(action).then(() => ({}))));
  ipcMain.handle('target-get', safely(async (_e, target) => ({ text: (await server.targets.get(target)).text })));
  ipcMain.handle('foreground', safely(async () => ({ app: (await server.targets.win.call('foreground')).process })));
  ipcMain.handle('audio-apps', () => server.targets.audioApps().catch(() => []));
  ipcMain.handle('audio-devices', () => player.devices().catch(() => []));
  ipcMain.handle('icon-list', () => {
    const tags = require('lucide-static/tags.json');
    return Object.entries(tags).map(([name, t]) => ({ name, tags: t.join(' ') }));
  });
  ipcMain.handle('pick-media', async (_e, kind) => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: MediaStore.filters(kind) });
    if (r.canceled || !r.filePaths[0]) return null;
    try {
      return { ok: true, ...server.media.importFile(kind, r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
}

/* ---------- lifecycle ---------- */

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  server = new DeckServer(new ConfigStore(CONFIG_DIR, secretsCodec()));
  server.on('clients', (c) => {
    clients = c;
    send('clients', c);
  });
  server.on('log', (text) => {
    activity.unshift({ at: Date.now(), text });
    activity.length = Math.min(activity.length, 50);
    send('log', activity[0]);
  });
  server.on('pairing', () => { if (win) urlsWithQr().then((u) => send('pairing', u)).catch((e) => logError('pairing', e)); });
  server.on('devices', (d) => send('devices', d));
  server.obs.on('state', (s) => send('obs', { ...s, error: server.obs.lastError }));

  try {
    await server.start();
  } catch (e) {
    const busy = e.code === 'EADDRINUSE';
    dialog.showErrorBox('PocketDeck could not start',
      busy ? `Port ${server.config.data.port} is already in use. Is PocketDeck already running?` : e.message);
    app.exit(1);
    return;
  }

  player = new SoundPlayer(server.media, `http://127.0.0.1:${server.config.data.port}`);
  server.sound = (action) => player.play(action);
  registerIpc();

  // First run of an installed copy starts with Windows; the user can turn it off.
  if (server.config.data.autostart === undefined) setAutostart(app.isPackaged);
  createTray();
  createWindow();
});

app.on('before-quit', () => {
  quitting = true;
  if (server) server.stop();
  if (player) player.stop();
});

// The app lives in the tray, so closing every window does not quit.
app.on('window-all-closed', () => {});
