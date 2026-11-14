import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeThumbnailTilePlan,
  formatLocationFromAddress
} from '../src/utils/shapePreview.js';

test('computeThumbnailTilePlan frames a square 1.5x the largest bbox dimension', () => {
  // Wide rectangle in Montreal
  const bbox = [-73.602, 45.505, -73.598, 45.506];
  const plan = computeThumbnailTilePlan(bbox, 1.5, 100);

  assert.ok(plan);
  assert.ok(plan.zoom >= 12 && plan.zoom <= 18);

  const width = plan.squareBounds.maxX - plan.squareBounds.minX;
  const height = plan.squareBounds.maxY - plan.squareBounds.minY;
  assert.ok(Math.abs(width - height) < 1e-12, 'thumbnail bounds must be square in Mercator space');
  assert.ok(Math.abs(width - plan.squareBounds.span) < 1e-12);
  assert.ok(plan.pxMaxX - plan.pxMinX >= 100, 'tile zoom should provide >= 100px resolution');
});

test('formatLocationFromAddress prefers city/town/village and falls back to coords', () => {
  assert.equal(formatLocationFromAddress({ city: 'Montréal', state: 'Québec' }, 45.5, -73.6), 'Montréal');
  assert.equal(formatLocationFromAddress({ town: 'Boucherville' }, 45.5, -73.4), 'Boucherville');
  assert.equal(formatLocationFromAddress({ village: 'Oka' }, 45.4, -74.0), 'Oka');
  assert.equal(formatLocationFromAddress(null, 45.512, -73.601), '45.51°N, 73.60°W');
});
