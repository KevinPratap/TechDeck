// Draws the PocketDeck logo (four coloured keys) into PNGs: `node scripts/make-icons.js`.
// Windows trays and window icons need PNG/ICO; they can't use the SVG.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Coverage (0..1) of a rounded rectangle in a 100x100 design space, for soft edges.
function inRound(x, y, rx, ry, w, h, r) {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

function logo(withBackground) {
  const keys = [
    [16, 16, '#3b82f6'], [54, 16, '#ef4444'], [16, 54, '#a855f7'], [54, 54, '#14b8a6'],
  ];
  return (px, py, size) => {
    const s = 100 / size;
    const x = px * s;
    const y = py * s;
    for (const [kx, ky, c] of keys) {
      const a = inRound(x / s, y / s, kx / s, ky / s, 30 / s, 30 / s, 7 / s);
      if (a > 0) {
        const bg = withBackground ? hex('#09090b') : hex(c);
        const [r, g, b] = hex(c).map((v, i) => Math.round(v * a + bg[i] * (1 - a)));
        return [r, g, b, withBackground ? 255 : Math.round(a * 255)];
      }
    }
    if (!withBackground) return [0, 0, 0, 0];
    const a = inRound(x / s, y / s, 0, 0, 100 / s, 100 / s, 22 / s);
    return [...hex('#09090b'), Math.round(a * 255)];
  };
}

const out = path.join(__dirname, '..', 'desktop', 'ui');
fs.writeFileSync(path.join(out, 'icon.png'), png(256, logo(true)));
fs.writeFileSync(path.join(out, 'tray.png'), png(32, logo(false)));
console.log('wrote icon.png and tray.png');
