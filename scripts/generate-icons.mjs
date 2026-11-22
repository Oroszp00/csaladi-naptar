// PNG ikonok generálása függőségek nélkül (az icons/icon.svg-vel azonos motívum).
// Futtatás: node scripts/generate-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// 512-es koordinátarendszerben, mint az SVG
function shapes(fullBleed) {
  const bg = { type: 'rect', x: 0, y: 0, w: 512, h: 512, r: fullBleed ? 0 : 112, c: hex('#4f46e5') };
  return [
    bg,
    { type: 'rect', x: 96, y: 120, w: 320, h: 296, r: 40, c: hex('#ffffff') },
    { type: 'rect', x: 96, y: 120, w: 320, h: 80, r: 40, c: hex('#c7d2fe') },
    { type: 'rect', x: 96, y: 160, w: 320, h: 40, r: 0, c: hex('#c7d2fe') },
    { type: 'rect', x: 160, y: 88, w: 32, h: 72, r: 16, c: hex('#ffffff') },
    { type: 'rect', x: 320, y: 88, w: 32, h: 72, r: 16, c: hex('#ffffff') },
    { type: 'circle', cx: 186, cy: 290, r: 28, c: hex('#0ea5e9') },
    { type: 'circle', cx: 256, cy: 290, r: 28, c: hex('#f59e0b') },
    { type: 'circle', cx: 326, cy: 290, r: 28, c: hex('#ec4899') },
  ];
}

function inside(s, x, y) {
  if (s.type === 'circle') return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
  if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
  const r = s.r;
  const cx = Math.min(Math.max(x, s.x + r), s.x + s.w - r);
  const cy = Math.min(Math.max(y, s.y + r), s.y + s.h - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function render(size, { fullBleed = false, scale = 1 } = {}) {
  const list = shapes(fullBleed);
  const SS = 4; // 4x4 szuperszamplás az élsimításhoz
  const px = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          let x = (pxl + (sx + 0.5) / SS) * k;
          let y = (py + (sy + 0.5) / SS) * k;
          // maskable: tartalom kicsinyítése a középpont körül (biztonsági zóna)
          x = 256 + (x - 256) / scale;
          y = 256 + (y - 256) / scale;
          let col = null;
          for (const s of list) {
            if (s === list[0] && fullBleed) { col = s.c; continue; }
            if (inside(s, x, y)) col = s.c;
          }
          if (col) { r += col[0]; g += col[1]; b += col[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (py * size + pxl) * 4;
      const cov = a / 255;
      px[i] = cov ? Math.round(r / cov) : 0;
      px[i + 1] = cov ? Math.round(g / cov) : 0;
      px[i + 2] = cov ? Math.round(b / cov) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = new URL('../icons/', import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL('icon-192.png', out), render(192));
// 512: teli háttér + kicsinyített tartalom → „any” és „maskable” célra is jó
writeFileSync(new URL('icon-512.png', out), render(512, { fullBleed: true, scale: 0.82 }));
// iOS: teli háttér (a rendszer maga kerekít)
writeFileSync(new URL('apple-touch-icon.png', out), render(180, { fullBleed: true }));
console.log('Ikonok elkészültek: icons/icon-192.png, icon-512.png, apple-touch-icon.png');
