const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ConfigStore } = require('../desktop/config');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pocketdeck-test-'));
const write = (dir, data) => fs.writeFileSync(path.join(dir, 'pocketdeck.json'), typeof data === 'string' ? data : JSON.stringify(data));

test('a new folder gets a default config with one profile', () => {
  const c = new ConfigStore(tmp());
  assert.equal(c.data.version, 5);
  assert.equal(c.data.profiles.length, 1);
  assert.deepEqual(c.data.devices, []);
  assert.equal(c.data.token, undefined);
  assert.ok(c.data.profiles[0].pages[0].widgets.length > 0);
});

test('v1 button maps migrate to widgets inside a profile, keeping positions', () => {
  const dir = tmp();
  write(dir, {
    port: 8787, token: 'a'.repeat(32), obs: {},
    pages: [{ id: 'p', name: 'Main', cols: 4, rows: 3, buttons: { 0: { label: 'A', action: { type: 'none' } }, 6: { label: 'B', action: { type: 'none' } } } }],
  });
  const c = new ConfigStore(dir);
  const widgets = c.data.profiles[0].pages[0].widgets;
  assert.deepEqual(widgets.map((w) => [w.label, w.x, w.y]), [['A', 0, 0], ['B', 2, 1]]);
  assert.equal(c.data.pages, undefined);
  assert.ok(fs.existsSync(path.join(dir, 'pocketdeck.json.v1.bak')));
});

test('an unreadable file is kept, not overwritten', () => {
  const dir = tmp();
  write(dir, '{ not json');
  const original = console.error;
  console.error = () => {};
  try {
    const c = new ConfigStore(dir);
    assert.equal(c.data.profiles.length, 1);
  } finally {
    console.error = original;
  }
  const kept = fs.readdirSync(dir).find((f) => f.includes('unreadable'));
  assert.ok(kept);
  assert.equal(fs.readFileSync(path.join(dir, kept), 'utf8'), '{ not json');
});

test('the phone never receives device tokens, the OBS password or app rules', () => {
  const c = new ConfigStore(tmp());
  const token = c.addDevice('Pixel');
  c.data.obs.password = 'secret';
  c.data.profiles[0].apps = ['obs64'];
  const sent = JSON.stringify(c.publicDeck());
  assert.ok(!sent.includes(token));
  assert.ok(!sent.includes(c.data.devices[0].hash));
  assert.ok(!sent.includes('secret'));
  assert.ok(!sent.includes('obs64'));
});

test('profile rules match program names without case or .exe', () => {
  const c = new ConfigStore(tmp());
  c.data.profiles.push({ id: 'chat', name: 'Chat', apps: ['Discord.exe'], pages: [] });
  assert.equal(c.profileForApp('discord'), 'chat');
  assert.equal(c.profileForApp('DISCORD.EXE'), 'chat');
  assert.equal(c.profileForApp('notepad'), null);
});

test('old built-in emoji and colours become icons and the current palette', () => {
  const dir = tmp();
  write(dir, {
    version: 3, port: 8787, token: 'a'.repeat(32), obs: {},
    profiles: [{ id: 'p', name: 'Main', apps: [], pages: [{ id: 'pg', name: 'Main', cols: 2, rows: 1, widgets: [
      { id: 'a', kind: 'key', x: 0, y: 0, w: 1, h: 1, icon: '🎙', color: '#2c3e50', action: { type: 'none' } },
      { id: 'b', kind: 'key', x: 1, y: 0, w: 1, h: 1, icon: '🎉', color: '#123456', action: { type: 'none' } },
    ] }] }],
  });
  const [a, b] = new ConfigStore(dir).data.profiles[0].pages[0].widgets;
  assert.deepEqual([a.icon, a.color], ['lucide:mic', '#64748b']);
  assert.deepEqual([b.icon, b.color], ['🎉', '#123456']);
  assert.ok(fs.existsSync(path.join(dir, 'pocketdeck.json.v3.bak')));
});

test('v4 configs keep their paired phones: the old token becomes a hashed device', () => {
  const dir = tmp();
  const old = 'b'.repeat(32);
  write(dir, { version: 4, port: 8787, token: old, obs: { url: 'ws://127.0.0.1:4455', password: '' }, profiles: [{ id: 'p', name: 'Main', apps: [], pages: [] }] });
  const c = new ConfigStore(dir);
  assert.equal(c.data.token, undefined);
  assert.ok(c.deviceForToken(old));
  assert.ok(!fs.readFileSync(path.join(dir, 'pocketdeck.json'), 'utf8').includes(old), 'the old token must not stay on disk');
  assert.ok(fs.existsSync(path.join(dir, 'pocketdeck.json.v4.bak')));
});

test('devices: add, look up, touch and revoke', () => {
  const c = new ConfigStore(tmp());
  const a = c.addDevice('iPhone');
  const b = c.addDevice('<b>Pixel</b>');
  assert.equal(c.deviceForToken(a).name, 'iPhone');
  assert.equal(c.deviceForToken(b).name, 'bPixelb', 'markup characters are stripped from names');
  assert.equal(c.deviceForToken('0'.repeat(48)), null);
  assert.equal(c.deviceForToken(undefined), null);
  assert.ok(!fs.readFileSync(c.file, 'utf8').includes(a), 'only the hash is stored');
  const id = c.deviceForToken(a).id;
  assert.ok(c.revokeDevice(id));
  assert.equal(c.deviceForToken(a), null);
  assert.ok(c.deviceForToken(b));
  c.revokeAll();
  assert.equal(c.deviceForToken(b), null);
});

test('update() rejects bad profiles and OBS settings and changes nothing', () => {
  const c = new ConfigStore(tmp());
  const good = JSON.parse(JSON.stringify(c.data.profiles));
  const bad = (mutate) => {
    const p = JSON.parse(JSON.stringify(good));
    mutate(p);
    assert.throws(() => c.update({ profiles: p }));
    assert.deepEqual(c.data.profiles, good);
  };
  bad((p) => { p[0].pages[0].widgets[0].kind = 'rocket'; });
  bad((p) => { p[0].pages[0].widgets[1].id = p[0].pages[0].widgets[0].id; });
  bad((p) => { p[0].pages[0].cols = 500; });
  bad((p) => { p[0].pages[0].widgets[0].x = -1; });
  bad((p) => { p[0].pages[0].widgets[0].action = 'rm -rf'; });
  bad((p) => { p[0].pages[0].widgets[0].action = { type: 'multi', steps: [{ nope: 1 }] }; });
  bad((p) => { p.length = 0; });
  assert.throws(() => c.update({ obs: { url: 'http://evil', password: '' } }));
  assert.throws(() => c.update({ obs: { url: 'ws://127.0.0.1:4455', password: 5 } }));
  assert.throws(() => c.update(null));
  c.update({ profiles: good, obs: { url: 'ws://10.0.0.2:4455', password: 'x' } });
  assert.equal(c.data.obs.url, 'ws://10.0.0.2:4455');
});

test('update() ignores keys the editor may not set', () => {
  const c = new ConfigStore(tmp());
  const before = c.data.port;
  c.update({ port: 1, devices: [], autostart: true });
  assert.equal(c.data.port, before);
  assert.equal(c.data.autostart, true);
});

test('the OBS password is encrypted on disk when a codec is given, and read back', () => {
  const dir = tmp();
  const codec = { encrypt: (t) => `enc(${t.split('').reverse().join('')})`, decrypt: (e) => /^enc\((.*)\)$/.exec(e)[1].split('').reverse().join('') };
  const c = new ConfigStore(dir, codec);
  c.update({ obs: { url: 'ws://127.0.0.1:4455', password: 'hunter2' } });
  const disk = fs.readFileSync(c.file, 'utf8');
  assert.ok(!disk.includes('hunter2'));
  assert.equal(new ConfigStore(dir, codec).data.obs.password, 'hunter2');
});

test('a plaintext OBS password from an older version is encrypted on first load', () => {
  const dir = tmp();
  write(dir, { version: 5, port: 8787, devices: [], obs: { url: 'ws://127.0.0.1:4455', password: 'oldsecret' }, profiles: [{ id: 'p', name: 'Main', apps: [], pages: [] }] });
  const codec = { encrypt: (t) => Buffer.from(t).toString('base64'), decrypt: (e) => Buffer.from(e, 'base64').toString() };
  const c = new ConfigStore(dir, codec);
  assert.equal(c.data.obs.password, 'oldsecret');
  assert.ok(!fs.readFileSync(c.file, 'utf8').includes('oldsecret'));
});

test('without a codec (the CLI), an encrypted password is kept intact on save', () => {
  const dir = tmp();
  const codec = { encrypt: (t) => Buffer.from(t).toString('base64'), decrypt: (e) => Buffer.from(e, 'base64').toString() };
  new ConfigStore(dir, codec).update({ obs: { url: 'ws://127.0.0.1:4455', password: 'keepme' } });
  const cli = new ConfigStore(dir); // no codec
  cli.addDevice('Phone'); // forces a save
  assert.equal(new ConfigStore(dir, codec).data.obs.password, 'keepme');
});
