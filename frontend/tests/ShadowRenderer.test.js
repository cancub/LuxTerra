import test from 'node:test';
import assert from 'node:assert/strict';
import { ShadowRenderer } from '../src/components/ShadowRenderer.js';
import {
  TERRAIN_SHADOW_WORD,
  CANOPY_SHADOW_WORD,
  SUN_PIXEL_WORD
} from '../src/utils/maskDecoder.js';

test('ShadowRenderer instantiates and manages offscreen canvas', () => {
  const renderer = new ShadowRenderer();
  assert.ok(renderer);
  assert.equal(renderer.rows, 0);
  assert.equal(renderer.cols, 0);
});

test('ShadowRenderer renderMask handles single bitmask', () => {
  const renderer = new ShadowRenderer();
  // 10110010
  const b64 = Buffer.from([0b10110010]).toString('base64');
  const imgData = renderer.renderMask(b64, 1, 8);
  assert.ok(imgData);
  assert.equal(renderer.currentMaskBase64, b64);
});

test('ShadowRenderer renderMask handles dual-surface terrain and canopy', () => {
  const renderer = new ShadowRenderer();
  // Terrain: 11001100
  const tB64 = Buffer.from([0b11001100]).toString('base64');
  // Canopy:  10101010
  const cB64 = Buffer.from([0b10101010]).toString('base64');

  const result = renderer.renderMask(tB64, 1, 8, cB64);
  assert.ok(result);
  assert.equal(renderer.currentMaskBase64, tB64);
  assert.equal(renderer.currentCanopyBase64, cB64);
});

test('ShadowRenderer renderFullShade sets state and clears', () => {
  const renderer = new ShadowRenderer();
  renderer.renderFullShade(10, 10);
  assert.equal(renderer.currentMaskBase64, '__FULL_SHADE__');

  renderer.clear();
  assert.equal(renderer.currentMaskBase64, null);
  assert.equal(renderer.currentCanopyBase64, null);
});
