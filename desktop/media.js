// Custom key images and soundboard files. Each is copied into the config
// folder under a hash of its contents, so the phone can fetch it by name.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KINDS = {
  image: { dir: 'images', route: 'img', exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp'], maxBytes: 8 * 1024 * 1024 },
  sound: { dir: 'sounds', route: 'snd', exts: ['.mp3', '.wav', '.ogg', '.m4a', '.flac'], maxBytes: 25 * 1024 * 1024 },
};

const NAME = /^[a-f0-9]{16}\.[a-z0-9]{2,4}$/;

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.flac': 'audio/flac',
};

class MediaStore {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  dirOf(kind) {
    return path.join(this.baseDir, KINDS[kind].dir);
  }

  // Copies a file in and returns { file, name }: the stored name and the original name for display.
  importFile(kind, src) {
    const k = KINDS[kind];
    if (!k) throw new Error(`Unknown media kind "${kind}"`);
    const ext = path.extname(src).toLowerCase();
    if (!k.exts.includes(ext)) throw new Error(`Choose a ${k.exts.join(', ')} file`);
    const size = fs.statSync(src).size;
    if (size > k.maxBytes) throw new Error(`That file is ${(size / 1048576).toFixed(1)} MB; the limit is ${k.maxBytes / 1048576} MB`);
    const body = fs.readFileSync(src);
    const file = crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + ext;
    fs.mkdirSync(this.dirOf(kind), { recursive: true });
    const dest = path.join(this.dirOf(kind), file);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, body);
    return { file, name: path.basename(src) };
  }

  // Path for a request like /img/<name>, or null when it isn't a valid stored file.
  resolve(urlPath) {
    const m = /^\/(img|snd)\/([^/]+)$/.exec(urlPath);
    if (!m || !NAME.test(m[2])) return null;
    const kind = m[1] === 'img' ? 'image' : 'sound';
    const file = path.join(this.dirOf(kind), m[2]);
    return fs.existsSync(file) ? { file, type: TYPES[path.extname(file)] || 'application/octet-stream' } : null;
  }

  exists(kind, name) {
    return NAME.test(name || '') && fs.existsSync(path.join(this.dirOf(kind), name));
  }

  static filters(kind) {
    return [{ name: kind === 'image' ? 'Images' : 'Sounds', extensions: KINDS[kind].exts.map((e) => e.slice(1)) }];
  }
}

module.exports = { MediaStore };
