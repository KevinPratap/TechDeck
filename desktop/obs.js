// Keeps a connection to OBS (obs-websocket v5) and tracks the state buttons show.
const { EventEmitter } = require('events');
const { OBSWebSocket } = require('obs-websocket-js');

class ObsBridge extends EventEmitter {
  constructor() {
    super();
    this.obs = new OBSWebSocket();
    this.connected = false;
    this.state = { scene: null, recording: false, streaming: false, muted: {}, scenes: [], inputs: [] };
    this.settings = null;
    this.retry = null;

    const o = this.obs;
    o.on('ConnectionClosed', () => {
      if (this.connected) console.log('[obs] disconnected');
      this.connected = false;
      this.changed();
      this.scheduleRetry();
    });
    o.on('CurrentProgramSceneChanged', (e) => this.set({ scene: e.sceneName }));
    o.on('RecordStateChanged', (e) => this.set({ recording: e.outputActive }));
    o.on('StreamStateChanged', (e) => this.set({ streaming: e.outputActive }));
    o.on('InputMuteStateChanged', (e) =>
      this.set({ muted: { ...this.state.muted, [e.inputName]: e.inputMuted } }));
    o.on('SceneListChanged', () => this.refresh());
    o.on('InputCreated', () => this.refresh());
    o.on('InputRemoved', () => this.refresh());
    o.on('InputNameChanged', () => this.refresh());
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.changed();
  }

  changed() {
    this.emit('state', this.snapshot());
  }

  snapshot() {
    return { connected: this.connected, ...this.state };
  }

  configure(settings) {
    this.settings = settings;
    clearTimeout(this.retry);
    this.obs.disconnect().catch(() => {});
    this.connect();
  }

  // Stops reconnecting and closes the connection.
  stop() {
    this.settings = null;
    clearTimeout(this.retry);
    this.obs.disconnect().catch(() => {});
  }

  async connect() {
    if (!this.settings) return;
    try {
      await this.obs.connect(this.settings.url, this.settings.password || undefined);
      this.connected = true;
      console.log('[obs] connected to', this.settings.url);
      await this.refresh();
    } catch (e) {
      this.connected = false;
      this.lastError = e.message;
      this.changed();
      this.scheduleRetry();
    }
  }

  scheduleRetry() {
    clearTimeout(this.retry);
    if (!this.settings) return; // stopped
    this.retry = setTimeout(() => this.connect(), 5000);
  }

  async refresh() {
    if (!this.connected) return;
    const o = this.obs;
    const [scenes, inputs, rec, stream] = await Promise.all([
      o.call('GetSceneList'),
      o.call('GetInputList'),
      o.call('GetRecordStatus'),
      o.call('GetStreamStatus'),
    ]);
    const muted = {};
    await Promise.all(inputs.inputs.map(async (i) => {
      try {
        muted[i.inputName] = (await o.call('GetInputMute', { inputName: i.inputName })).inputMuted;
      } catch { /* input has no audio */ }
    }));
    this.set({
      scene: scenes.currentProgramSceneName,
      scenes: scenes.scenes.map((s) => s.sceneName).reverse(),
      inputs: Object.keys(muted),
      recording: rec.outputActive,
      streaming: stream.outputActive,
      muted,
    });
  }

  call(req, data) {
    if (!this.connected) throw new Error('OBS is not connected');
    return this.obs.call(req, data);
  }
}

module.exports = { ObsBridge };
