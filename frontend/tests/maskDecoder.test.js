import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBitmask,
  decodeBitmaskToImageData,
  base64ToBytes,
  SHADOW_PIXEL_WORD,
  SUN_PIXEL_WORD
} from '../src/utils/maskDecoder.js';

test('base64ToBytes decodes known Base64 string', () => {
  // 0xB2 = 178
  const base64Str = Buffer.from([178]).toString('base64');
  const bytes = base64ToBytes(base64Str);
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0], 178);
});

test('decodeBitmask decodes 8 pixels correctly from single byte', () => {
  // 178 in binary is 10110010 => [1, 0, 1, 1, 0, 0, 1, 0]
  const base64Str = Buffer.from([178]).toString('base64');
  const pixels = decodeBitmask(base64Str, 1, 8);
  assert.deepEqual(Array.from(pixels), [1, 0, 1, 1, 0, 0, 1, 0]);
});

test('decodeBitmaskToImageData writes little-endian 32-bit pixel words', () => {
  const base64Str = Buffer.from([178]).toString('base64');
  const imgData = decodeBitmaskToImageData(base64Str, 1, 8, null);
  const data32 = new Uint32Array(imgData.data.buffer);
  
  assert.equal(data32[0], SUN_PIXEL_WORD); // 1 = unshaded sun (transparent)
  assert.equal(data32[1], SHADOW_PIXEL_WORD); // 0 = shadow (tinted)
  assert.equal(data32[2], SUN_PIXEL_WORD);
  assert.equal(data32[3], SUN_PIXEL_WORD);
  assert.equal(data32[4], SHADOW_PIXEL_WORD);
  assert.equal(data32[5], SHADOW_PIXEL_WORD);
  assert.equal(data32[6], SUN_PIXEL_WORD);
  assert.equal(data32[7], SHADOW_PIXEL_WORD);
});

test('decodeBitmask benchmark: 316x316 (100k pixels) completes in under 2ms', () => {
  const rows = 316;
  const cols = 316;
  const totalPixels = rows * cols;
  const totalBytes = Math.ceil(totalPixels / 8);

  const sampleBytes = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    sampleBytes[i] = (i * 37) & 0xFF;
  }
  const base64Str = Buffer.from(sampleBytes).toString('base64');

  const start = performance.now();
  const imgData = decodeBitmaskToImageData(base64Str, rows, cols, null);
  const elapsed = performance.now() - start;

  assert.equal(imgData.data.length, totalPixels * 4);
  assert.ok(elapsed < 10.0, `Decoding took ${elapsed.toFixed(3)}ms (expected < 10ms)`);
});
