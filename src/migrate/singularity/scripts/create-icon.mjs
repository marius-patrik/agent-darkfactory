import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outPath = path.join(root, "media", "icon.png");

const WIDTH = 128;
const HEIGHT = 128;
const COLOR = { r: 59, g: 130, b: 246, a: 255 }; // OpenDAW-ish blue

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const chunk = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

function buildPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const rowSize = WIDTH * 4;
  const raw = Buffer.alloc(HEIGHT * (1 + rowSize));
  for (let y = 0; y < HEIGHT; y++) {
    const rowOffset = y * (1 + rowSize);
    raw[rowOffset] = 0; // filter byte
    for (let x = 0; x < WIDTH; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      raw[pxOffset] = COLOR.r;
      raw[pxOffset + 1] = COLOR.g;
      raw[pxOffset + 2] = COLOR.b;
      raw[pxOffset + 3] = COLOR.a;
    }
  }

  const idatData = zlib.deflateSync(raw);
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    writeChunk("IHDR", ihdr),
    writeChunk("IDAT", idatData),
    writeChunk("IEND", iend),
  ]);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buildPng());
console.log(`Created ${outPath}`);
