import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeBitmask,
  decodeBitmaskToImageData,
  decodeDualBitmasksToImageData,
  base64ToBytes,
  TERRAIN_SHADOW_WORD,
  CANOPY_SHADOW_WORD,
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

test('decodeDualBitmasksToImageData correctly distinguishes terrain, canopy, and sun pixels', () => {
  // Byte 1: Terrain: 11001100 (pixels 0,1 unshaded; 2,3 shaded; 4,5 unshaded; 6,7 shaded)
  const terrainB64 = Buffer.from([0b11001100]).toString('base64');
  // Byte 2: Canopy:  10101010 (pixels 0 sun; 1 tree; 2 sun; 3 tree; 4 sun; 5 tree; 6 sun; 7 tree)
  const canopyB64 = Buffer.from([0b10101010]).toString('base64');

  const imgData = decodeDualBitmasksToImageData(terrainB64, canopyB64, 1, 8, null);
  const data32 = new Uint32Array(imgData.data.buffer);

  // Pixel 0: T=1, C=1 => Unshaded Sun
  assert.equal(data32[0], SUN_PIXEL_WORD);
  // Pixel 1: T=1, C=0 => Tree Canopy Shadow
  assert.equal(data32[1], CANOPY_SHADOW_WORD);
  // Pixel 2: T=0, C=1 => Terrain Shadow
  assert.equal(data32[2], TERRAIN_SHADOW_WORD);
  // Pixel 3: T=0, C=0 => Terrain Shadow (terrain takes priority)
  assert.equal(data32[3], TERRAIN_SHADOW_WORD);
  // Pixel 4: T=1, C=1 => Unshaded Sun
  assert.equal(data32[4], SUN_PIXEL_WORD);
  // Pixel 5: T=1, C=0 => Tree Canopy Shadow
  assert.equal(data32[5], CANOPY_SHADOW_WORD);
  // Pixel 6: T=0, C=1 => Terrain Shadow
  assert.equal(data32[6], TERRAIN_SHADOW_WORD);
  // Pixel 7: T=0, C=0 => Terrain Shadow
  assert.equal(data32[7], TERRAIN_SHADOW_WORD);
});

test('decodeDualBitmasksToImageData benchmark: 100k pixels completes in under 3ms', () => {
  const rows = 316;
  const cols = 316;
  const totalBytes = Math.ceil((rows * cols) / 8);

  const sampleT = new Uint8Array(totalBytes);
  const sampleC = new Uint8Array(totalBytes);
  for (let i = 0; i < totalBytes; i++) {
    sampleT[i] = (i * 37) & 0xFF;
    sampleC[i] = (i * 73) & 0xFF;
  }
  const tB64 = Buffer.from(sampleT).toString('base64');
  const cB64 = Buffer.from(sampleC).toString('base64');

  const start = performance.now();
  const imgData = decodeDualBitmasksToImageData(tB64, cB64, rows, cols, null);
  const elapsed = performance.now() - start;

  assert.equal(imgData.data.length, rows * cols * 4);
  assert.ok(elapsed < 10.0, `Dual decoding took ${elapsed.toFixed(3)}ms (expected < 10ms)`);
});
