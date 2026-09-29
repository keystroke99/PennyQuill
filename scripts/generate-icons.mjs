import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index, index += 1) {
    const [xi, yi] = points[index];
    const [xj, yj] = points[previous];
    if (((yi > y) !== (yj > y)) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = dx * dx + dy * dy;
  const amount = length ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / length)) : 0;
  return Math.hypot(x - (x1 + amount * dx), y - (y1 + amount * dy));
}

function iconPng(size, maskable = false) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  const scale = size / 512;
  const safe = maskable ? 0.76 : 1;
  const feather = [[177, 354], [184, 321], [192, 283], [210, 238], [239, 199], [275, 170], [317, 151], [361, 148], [359, 190], [341, 229], [311, 263], [274, 287], [231, 307], [184, 321]];
  const barbs = [
    [230, 298, 192, 300], [258, 266, 213, 251], [291, 231, 256, 207], [318, 198, 290, 177],
    [255, 283, 310, 275], [279, 250, 334, 228], [306, 214, 349, 187],
  ];
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    rows[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = row + 1 + x * 4;
      const cx = (x - size / 2) / safe + size / 2;
      const cy = (y - size / 2) / safe + size / 2;
      const dx = cx / scale - 256;
      const dy = cy / scale - 256;
      let color = [23, 37, 29, 255];
      if (dx * dx + dy * dy < 166 * 166) color = [217, 242, 106, 255];
      const px = cx / scale;
      const py = cy / scale;
      if (insidePolygon(px, py, feather)) color = [255, 253, 247, 255];
      if (barbs.some(([x1, y1, x2, y2]) => distanceToSegment(px, py, x1, y1, x2, y2) < 4.5)) color = [23, 37, 29, 255];
      if (distanceToSegment(px, py, 185, 350, 341, 166) < 6.5) color = [231, 131, 60, 255];
      rows.set(color, offset);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

await mkdir("public/icons", { recursive: true });
await Promise.all([
  writeFile("public/icons/icon-192.png", iconPng(192)),
  writeFile("public/icons/icon-512.png", iconPng(512)),
  writeFile("public/icons/apple-touch-icon.png", iconPng(180)),
  writeFile("public/icons/icon-maskable-512.png", iconPng(512, true)),
]);

console.log("Generated PWA icons in public/icons");
