// Runs in the hidden sound-player window.
const playing = new Map(); // file -> Set of Audio elements still playing

function stopFile(file) {
  for (const a of playing.get(file) || []) a.pause();
  playing.delete(file);
}

async function play({ url, file, device, volume, mode }) {
  if (mode === 'toggle' && playing.has(file)) {
    stopFile(file);
    return { stopped: true };
  }
  if (mode === 'restart') stopFile(file);
  const a = new Audio(url);
  a.volume = volume;
  if (device) await a.setSinkId(device);
  if (!playing.has(file)) playing.set(file, new Set());
  playing.get(file).add(a);
  a.addEventListener('ended', () => {
    const set = playing.get(file);
    if (set) { set.delete(a); if (!set.size) playing.delete(file); }
  });
  await a.play();
  return { stopped: false };
}

async function devices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
}

audioBridge.on(async (m) => {
  try {
    const data = m.cmd === 'play' ? await play(m) : m.cmd === 'devices' ? await devices() : null;
    audioBridge.reply({ id: m.id, ok: true, data });
  } catch (e) {
    audioBridge.reply({ id: m.id, ok: false, error: e.message });
  }
});
