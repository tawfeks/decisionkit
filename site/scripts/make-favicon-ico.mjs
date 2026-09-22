import sharp from "sharp";
import { readFile, writeFile } from "node:fs/promises";

const svg = await readFile(new URL("../public/favicon.svg", import.meta.url));

const sizes = [16, 32, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) =>
    sharp(svg, { density: Math.ceil((72 * size) / 128) })
      .resize(size, size)
      .png()
      .toBuffer()
  )
);

const count = sizes.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(count, 4);

const dir = Buffer.alloc(16 * count);
let offset = 6 + 16 * count;
pngs.forEach((png, i) => {
  const size = sizes[i];
  const b = i * 16;
  dir.writeUInt8(size >= 256 ? 0 : size, b);
  dir.writeUInt8(size >= 256 ? 0 : size, b + 1);
  dir.writeUInt8(0, b + 2);
  dir.writeUInt8(0, b + 3);
  dir.writeUInt16LE(1, b + 4);
  dir.writeUInt16LE(32, b + 6);
  dir.writeUInt32LE(png.length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += png.length;
});

await writeFile(new URL("../public/favicon.ico", import.meta.url), Buffer.concat([header, dir, ...pngs]));
console.log("favicon.ico written:", count, "entries:", sizes.join(","));