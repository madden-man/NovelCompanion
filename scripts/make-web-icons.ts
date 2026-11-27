import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

/**
 * A58 (PH-24): draws the phone app's icons, an open book in paper on jade
 * (the theme's accent), into src/web/public/icons. The repository has no app
 * icon (the Mac app uses Electron's), so this is the first one. Run once with
 * `node scripts/make-web-icons.ts`; the PNGs are committed.
 */
const ROOT = join(import.meta.dirname, '..');
const OUT = join(ROOT, 'src/web/public/icons');
const JADE = [0x1b, 0x70, 0x5f];
const PAPER = [0xff, 0xff, 0xff];
const INK = [0xb9, 0xd9, 0xd1];

/** What colour the point (u, v) in the unit square is. */
function shade(u: number, v: number): number[] {
  // Two pages that lift toward the outer edges, meeting at a spine.
  const lift = (x: number) => 0.035 * Math.abs(x - 0.5) * 4;
  const top = 0.3 - lift(u);
  const bottom = 0.72 - lift(u) * 0.6;
  const onLeft = u >= 0.17 && u <= 0.485;
  const onRight = u >= 0.515 && u <= 0.83;
  if ((onLeft || onRight) && v >= top && v <= bottom) {
    // A few lines of text on each page.
    const inset = onLeft ? u >= 0.23 && u <= 0.44 : u >= 0.56 && u <= 0.77;
    for (let i = 0; i < 4; i++) {
      const y = top + 0.08 + i * 0.075;
      if (inset && v >= y && v <= y + 0.022) return INK;
    }
    return PAPER;
  }
  return JADE;
}

function png(size: number): Buffer {
  const ss = 4;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let [r, g, b] = [0, 0, 0];
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const [cr = 0, cg = 0, cb = 0] = shade(
            (x + (i + 0.5) / ss) / size,
            (y + (j + 0.5) / ss) / size,
          );
          r += cr;
          g += cg;
          b += cb;
        }
      }
      const at = y * (size * 3 + 1) + 1 + x * 3;
      raw[at] = Math.round(r / (ss * ss));
      raw[at + 1] = Math.round(g / (ss * ss));
      raw[at + 2] = Math.round(b / (ss * ss));
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, size] of [
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
] as const) {
  writeFileSync(join(OUT, name), png(size));
  console.log(`${name} ${size}x${size}`);
}
