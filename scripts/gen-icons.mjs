/**
 * Generates clean monochrome extension icons (no image library).
 * Charcoal square + a white document glyph with text lines.
 * Run: node scripts/gen-icons.mjs
 */

import zlib from "zlib";
import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const here = dirname(fileURLToPath(import.meta.url));

const crcTable = (() => {
  const t = new Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter byte
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, y * size * 4 + size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function makeIcon(S) {
  const rgba = Buffer.alloc(S * S * 4);
  const set = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  const fillRect = (x0, y0, x1, y1, r, g, b) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, r, g, b);
  };

  // Charcoal background.
  fillRect(0, 0, S, S, 17, 17, 17);

  // White page.
  const mx = Math.round(S * 0.26);
  const y0 = Math.round(S * 0.18);
  const y1 = S - Math.round(S * 0.18);
  fillRect(mx, y0, S - mx, y1, 245, 245, 245);

  // Gray text lines.
  const lh = Math.max(1, Math.round(S * 0.045));
  const lx0 = mx + Math.round(S * 0.07);
  const lx1 = S - mx - Math.round(S * 0.07);
  for (let k = 1; k <= 3; k++) {
    const ly = y0 + Math.round(((y1 - y0) * k) / 4);
    fillRect(lx0, ly, lx1, ly + lh, 150, 150, 150);
  }

  return png(S, rgba);
}

for (const S of [16, 48, 128]) {
  writeFileSync(join(here, "..", "icons", `icon${S}.png`), makeIcon(S));
}
console.log("Wrote icon16/48/128.png");
