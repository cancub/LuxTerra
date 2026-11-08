import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  filterLegacyPresets
} from '../src/components/SavedViewsPanel.js';

test('filterLegacyPresets removes default presets and preserves user shapes', () => {
  const legacyData = [
    { id: 'preset_montreal', name: 'Montréal', isPreset: true },
    { id: 'preset_sainte_lucie', name: 'Sainte-Lucie', isPreset: true },
    { id: 'preset_laval', name: 'Laval', isPreset: true },
    { id: 'view_1794150000', name: 'Custom Solar Array', isPreset: false }
  ];

  const cleaned = filterLegacyPresets(legacyData);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0].id, 'view_1794150000');
  assert.equal(cleaned[0].name, 'Custom Solar Array');
});

test('filterLegacyPresets returns empty array for empty or invalid input', () => {
  assert.deepEqual(filterLegacyPresets([]), []);
  assert.deepEqual(filterLegacyPresets(null), []);
  assert.deepEqual(filterLegacyPresets(undefined), []);
  assert.deepEqual(filterLegacyPresets('invalid'), []);
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
