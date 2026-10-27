// Generates icons/icon-192.png, icon-512.png and icon-maskable-512.png (pure Node, hand-written PNG encoder).
//   node tools/make-icons.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (t, d) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4); d.copy(b, 8); b.writeUInt32BE(crc(b.subarray(4, 8 + d.length)), 8 + d.length); return b; };
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Scene in unit coordinates: wooden board with grid, a black and a white stone. `pad` shrinks it (maskable safe zone).
function sample(u, v, pad, round) {
  const bg = [20, 22, 26];
  const s = (u - 0.5) / (1 - 2 * pad) + 0.5, t = (v - 0.5) / (1 - 2 * pad) + 0.5;
  if (s < 0 || s > 1 || t < 0 || t > 1) return bg;
  if (round) { const dx = Math.max(0, Math.abs(s - 0.5) - 0.5 + 0.16), dy = Math.max(0, Math.abs(t - 0.5) - 0.5 + 0.16); if (dx * dx + dy * dy > 0.16 * 0.16) return bg; }
  let c = [214, 168, 98];
  const gx = (s * 4 + 0.5) % 1, gy = (t * 4 + 0.5) % 1;
  if ((Math.abs(gx - 0.5) < 0.012 * 4 && s > 0.12 && s < 0.88 && t > 0.12 && t < 0.88) || (Math.abs(gy - 0.5) < 0.012 * 4 && s > 0.12 && s < 0.88 && t > 0.12 && t < 0.88)) c = [70, 48, 20];
  const st = (cx, cy, col, hi) => {
    const d = Math.hypot(s - cx, t - cy);
    if (d < 0.13) { const k = Math.hypot(s - cx + 0.04, t - cy + 0.04); return col.map((x) => Math.min(255, x + hi * Math.max(0, 1 - k / 0.12))); }
    return null;
  };
  return st(0.37, 0.37, [24, 24, 24], 60) || st(0.63, 0.63, [238, 238, 238], 17) || st(0.62, 0.37, [24, 24, 24], 60) || c;
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size, pad, round] of [['icon-192.png', 192, 0.04, true], ['icon-512.png', 512, 0.04, true], ['icon-maskable-512.png', 512, 0.12, false]]) {
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) { const p = sample((x + ox) / size, (y + oy) / size, pad, round); r += p[0]; g += p[1]; b += p[2]; }
    buf.set([r / 4, g / 4, b / 4, 255], (y * size + x) * 4);
  }
  fs.writeFileSync(path.join(out, name), png(size, size, buf));
  console.log('wrote', name);
}
