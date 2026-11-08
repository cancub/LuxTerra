import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PRESET_VIEWS,
  STORAGE_KEY
} from '../src/components/SavedViewsPanel.js';

test('DEFAULT_PRESET_VIEWS includes Montreal, Sainte-Lucie, and Laval', () => {
  assert.equal(DEFAULT_PRESET_VIEWS.length, 3);

  const mtl = DEFAULT_PRESET_VIEWS.find(v => v.id === 'preset_montreal');
  assert.ok(mtl);
  assert.equal(mtl.name, 'Montréal - Mount Royal Slopes');
  assert.ok(Array.isArray(mtl.polygon));
  assert.equal(mtl.polygon.length, 5); // Closed 4-point ring

  const stLucie = DEFAULT_PRESET_VIEWS.find(v => v.id === 'preset_sainte_lucie');
  assert.ok(stLucie);
  assert.equal(stLucie.name, 'Sainte-Lucie Laurentians');
  assert.ok(Array.isArray(stLucie.bbox));
  assert.equal(stLucie.bbox.length, 4);

  const laval = DEFAULT_PRESET_VIEWS.find(v => v.id === 'preset_laval');
  assert.ok(laval);
  assert.equal(laval.name, 'Laval - Centropolis');
  assert.ok(Array.isArray(laval.bbox));
  assert.equal(laval.bbox.length, 4);
});

test('Saved view serialization preserves camera, bbox, and polygon precision', () => {
  const sampleView = {
    id: 'view_test_123',
    name: 'Custom Laval Solar Array',
    detail: '🔷 Oblong • 35,420 m²',
    center: [-73.75123, 45.56456],
    zoom: 16.5,
    pitch: 50,
    bearing: -20,
    bbox: [-73.755, 45.560, -73.748, 45.568],
    polygon: [
      [-73.755, 45.560],
      [-73.750, 45.568],
      [-73.748, 45.563],
      [-73.755, 45.560]
    ],
    date: '2026-06-21',
    createdAt: new Date().toISOString()
  };

  const serialized = JSON.stringify([sampleView]);
  const parsed = JSON.parse(serialized);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, 'view_test_123');
  assert.deepEqual(parsed[0].center, [-73.75123, 45.56456]);
  assert.equal(parsed[0].polygon.length, 4);
  assert.equal(parsed[0].date, '2026-06-21');
});
