import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STORAGE_KEY,
  filterLegacyPresets,
  areShapesEqual,
  areViewsEqual,
  ShapeHistory
} from '../src/components/ShapeToolbar.js';

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

test('areShapesEqual detects polygon and shadow container box modifications', () => {
  const base = {
    bbox: [-73.755, 45.560, -73.748, 45.568],
    polygon: [
      [-73.755, 45.560],
      [-73.750, 45.568],
      [-73.748, 45.563],
      [-73.755, 45.560]
    ],
    contextBbox: null
  };

  assert.equal(areShapesEqual(base, { ...base }), true);
  assert.equal(
    areShapesEqual(base, { ...base, contextBbox: [-73.756, 45.559, -73.747, 45.569] }),
    false
  );
  assert.equal(
    areShapesEqual(base, {
      ...base,
      polygon: [
        [-73.756, 45.560],
        [-73.750, 45.568],
        [-73.748, 45.563],
        [-73.756, 45.560]
      ]
    }),
    false
  );
});

test('areViewsEqual tolerates tiny flyTo rounding and detects camera changes', () => {
  const baseView = {
    center: [-73.75123, 45.56456],
    zoom: 16.5,
    pitch: 50,
    bearing: -20
  };

  assert.equal(
    areViewsEqual(baseView, { center: [-73.75124, 45.56455], zoom: 16.51, pitch: 50, bearing: -20 }),
    true
  );
  assert.equal(
    areViewsEqual(baseView, { center: [-73.75223, 45.56456], zoom: 16.5, pitch: 50, bearing: -20 }),
    false
  );
  assert.equal(
    areViewsEqual(baseView, { center: [-73.75123, 45.56456], zoom: 17.2, pitch: 50, bearing: -20 }),
    false
  );
});

test('ShapeHistory supports undo, redo, and truncating forward history on new edits', () => {
  const s0 = {
    bbox: [-73.755, 45.560, -73.748, 45.568],
    polygon: [[-73.755, 45.560], [-73.750, 45.568], [-73.748, 45.563], [-73.755, 45.560]],
    contextBbox: null
  };
  const s1 = { ...s0, contextBbox: [-73.756, 45.559, -73.747, 45.569] };
  const s2 = {
    ...s1,
    polygon: [[-73.756, 45.560], [-73.750, 45.568], [-73.748, 45.563], [-73.756, 45.560]]
  };
  const s3 = {
    ...s0,
    polygon: [[-73.754, 45.560], [-73.750, 45.568], [-73.748, 45.563], [-73.754, 45.560]]
  };

  const history = new ShapeHistory();
  history.reset(s0);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);

  // Duplicate push is ignored
  assert.equal(history.push({ ...s0 }), false);

  assert.equal(history.push(s1), true);
  assert.equal(history.push(s2), true);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), false);

  assert.equal(areShapesEqual(history.undo(), s1), true);
  assert.equal(history.canUndo(), true);
  assert.equal(history.canRedo(), true);

  assert.equal(areShapesEqual(history.undo(), s0), true);
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);

  assert.equal(areShapesEqual(history.redo(), s1), true);
  // New edit while in middle truncates forward s2
  assert.equal(history.push(s3), true);
  assert.equal(history.canRedo(), false);
  assert.equal(areShapesEqual(history.current(), s3), true);
});
