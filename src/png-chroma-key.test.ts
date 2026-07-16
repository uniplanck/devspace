import assert from "node:assert/strict";
import { chromaKeyPng, encodeRgbaPng, inspectPngAlpha } from "./png-chroma-key.js";

const rgba = Buffer.from([
  0, 255, 0, 255,
  255, 20, 20, 255,
  60, 150, 70, 255,
]);
const source = encodeRgbaPng(3, 1, rgba);
const converted = chromaKeyPng(source, {
  dominanceStart: 40,
  dominanceEnd: 130,
  minimumGreen: 60,
});
const stats = inspectPngAlpha(converted.buffer);

assert.equal(stats.width, 3);
assert.equal(stats.height, 1);
assert.equal(stats.transparentPixels, 1);
assert.equal(stats.opaquePixels, 1);
assert.equal(stats.partialPixels, 1);
assert.equal(stats.residualGreenPixels, 0);
assert.deepEqual(converted.stats, stats);

console.log("png chroma key tests passed");
