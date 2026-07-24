import { deflateSync, inflateSync } from "node:zlib";

export interface PngAlphaStats {
  width: number;
  height: number;
  transparentPixels: number;
  partialPixels: number;
  opaquePixels: number;
  residualGreenPixels: number;
}

export interface ChromaKeyOptions {
  dominanceStart?: number;
  dominanceEnd?: number;
  minimumGreen?: number;
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Buffer;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = createCrcTable();

export function chromaKeyPng(
  source: Buffer,
  options: ChromaKeyOptions = {},
): { buffer: Buffer; stats: PngAlphaStats } {
  const decoded = decodePng(source);
  const dominanceStart = clampInteger(options.dominanceStart ?? 50, 0, 254);
  const dominanceEnd = clampInteger(options.dominanceEnd ?? 135, dominanceStart + 1, 255);
  const minimumGreen = clampInteger(options.minimumGreen ?? 70, 0, 255);
  const output = Buffer.from(decoded.rgba);

  for (let offset = 0; offset < output.length; offset += 4) {
    const red = output[offset]!;
    const green = output[offset + 1]!;
    const blue = output[offset + 2]!;
    const originalAlpha = output[offset + 3]!;
    const dominance = green - Math.max(red, blue);
    let keyAlpha = 255;
    if (green >= minimumGreen && dominance > dominanceStart) {
      const position = Math.min(1, (dominance - dominanceStart) / (dominanceEnd - dominanceStart));
      const smooth = position * position * (3 - (2 * position));
      keyAlpha = Math.round(255 * (1 - smooth));
    }
    const alpha = Math.round((originalAlpha * keyAlpha) / 255);
    if (alpha < 255) {
      const spill = Math.max(0, green - Math.max(red, blue));
      const removal = ((255 - alpha) / 255) * spill;
      output[offset + 1] = Math.max(0, Math.round(green - removal));
    }
    output[offset + 3] = alpha;
  }

  return {
    buffer: encodeRgbaPng(decoded.width, decoded.height, output),
    stats: alphaStats(decoded.width, decoded.height, output),
  };
}

export function inspectPngAlpha(source: Buffer): PngAlphaStats {
  const decoded = decodePng(source);
  return alphaStats(decoded.width, decoded.height, decoded.rgba);
}

export function encodeRgbaPng(width: number, height: number, rgba: Buffer): Buffer {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error("PNG dimensions must be positive integers.");
  }
  if (rgba.length !== width * height * 4) {
    throw new Error("RGBA data length does not match PNG dimensions.");
  }
  const rowLength = width * 4;
  const scanlines = Buffer.alloc((rowLength + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const targetOffset = row * (rowLength + 1);
    scanlines[targetOffset] = 0;
    rgba.copy(scanlines, targetOffset + 1, row * rowLength, (row + 1) * rowLength);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function decodePng(source: Buffer): DecodedPng {
  if (source.length < PNG_SIGNATURE.length || !source.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Input is not a PNG file.");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  const idat: Buffer[] = [];
  while (offset + 12 <= source.length) {
    const length = source.readUInt32BE(offset);
    const type = source.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > source.length) throw new Error("PNG chunk exceeds input length.");
    const data = source.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (data.length !== 13) throw new Error("PNG IHDR chunk has an invalid length.");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (data[10] !== 0 || data[11] !== 0) throw new Error("Unsupported PNG compression or filter method.");
      interlace = data[12]!;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || idat.length === 0) throw new Error("PNG is missing required chunks.");
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("Only non-interlaced 8-bit RGB or RGBA PNG files are supported.");
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const rowLength = width * bytesPerPixel;
  const inflated = inflateSync(Buffer.concat(idat));
  const expectedLength = (rowLength + 1) * height;
  if (inflated.length !== expectedLength) {
    throw new Error(`PNG scanline length mismatch: expected ${expectedLength}, got ${inflated.length}.`);
  }
  const raw = Buffer.alloc(rowLength * height);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = inflated[sourceOffset++]!;
    const rowOffset = row * rowLength;
    for (let column = 0; column < rowLength; column += 1) {
      const encoded = inflated[sourceOffset++]!;
      const current = rowOffset + column;
      const left = column >= bytesPerPixel ? raw[current - bytesPerPixel]! : 0;
      const up = row > 0 ? raw[current - rowLength]! : 0;
      const upLeft = row > 0 && column >= bytesPerPixel ? raw[current - rowLength - bytesPerPixel]! : 0;
      const predictor = filter === 0
        ? 0
        : filter === 1
          ? left
          : filter === 2
            ? up
            : filter === 3
              ? Math.floor((left + up) / 2)
              : filter === 4
                ? paeth(left, up, upLeft)
                : -1;
      if (predictor < 0) throw new Error(`Unsupported PNG filter type: ${filter}.`);
      raw[current] = (encoded + predictor) & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourcePixel = pixel * bytesPerPixel;
    const targetPixel = pixel * 4;
    rgba[targetPixel] = raw[sourcePixel]!;
    rgba[targetPixel + 1] = raw[sourcePixel + 1]!;
    rgba[targetPixel + 2] = raw[sourcePixel + 2]!;
    rgba[targetPixel + 3] = colorType === 6 ? raw[sourcePixel + 3]! : 255;
  }
  return { width, height, rgba };
}

function alphaStats(width: number, height: number, rgba: Buffer): PngAlphaStats {
  let transparentPixels = 0;
  let partialPixels = 0;
  let opaquePixels = 0;
  let residualGreenPixels = 0;
  for (let offset = 0; offset < rgba.length; offset += 4) {
    const red = rgba[offset]!;
    const green = rgba[offset + 1]!;
    const blue = rgba[offset + 2]!;
    const alpha = rgba[offset + 3]!;
    if (alpha === 0) transparentPixels += 1;
    else if (alpha === 255) opaquePixels += 1;
    else partialPixels += 1;
    if (alpha > 0 && green - Math.max(red, blue) > 70) residualGreenPixels += 1;
  }
  return { width, height, transparentPixels, partialPixels, opaquePixels, residualGreenPixels };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return output;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(value: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left: number, up: number, upLeft: number): number {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const diagonalDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
