import { inflateSync } from 'node:zlib';

/** Decode an 8-bit RGB or RGBA PNG into pixels, for checking what an export drew. */
export function decodePng(buf: Buffer): {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number];
} {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error('Only 8-bit PNGs are decoded');
      colorType = data[9]!;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`PNG colour type ${colorType} is not decoded`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[y * stride + i - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + i]! : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * stride + i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + i] = v & 0xff;
    }
  }
  return {
    width,
    height,
    pixel: (x, y) => {
      const o = y * stride + x * bpp;
      return [out[o]!, out[o + 1]!, out[o + 2]!];
    },
  };
}
