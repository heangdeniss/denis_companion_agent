// A small PNG reader and writer.
//
// The tools of this project have to run without dependencies, so the codec is
// kept here instead of pulling in a package. It handles the 8 bit formats that
// the artwork uses: greyscale, RGB, indexed, greyscale+alpha and RGBA.
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Reads a PNG file into `{ width, height, data }`, data is RGBA, 8 bit. */
export function decodePng(buffer) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") transparency = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (depth !== 8) throw new Error(`unsupported PNG bit depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const q = x * channels;
      if (colorType === 6) {
        out[o] = cur[q];
        out[o + 1] = cur[q + 1];
        out[o + 2] = cur[q + 2];
        out[o + 3] = cur[q + 3];
      } else if (colorType === 2) {
        out[o] = cur[q];
        out[o + 1] = cur[q + 1];
        out[o + 2] = cur[q + 2];
        out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[q];
        out[o + 3] = cur[q + 1];
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[q];
        out[o + 3] = 255;
      } else if (colorType === 3) {
        if (!palette) throw new Error("palette PNG without PLTE");
        const index = cur[q];
        out[o] = palette[index * 3];
        out[o + 1] = palette[index * 3 + 1];
        out[o + 2] = palette[index * 3 + 2];
        out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** Writes `{ width, height, data }` (RGBA, 8 bit) as a PNG file. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
