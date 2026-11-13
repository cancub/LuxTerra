import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_STATE_STORAGE_KEY,
  DEFAULT_APP_STATE,
  loadAppState,
  saveAppState,
  updateMapState,
  updateLayerState,
  updateSelectionState,
  updateDateState,
  clearAppState,
  validateMapState,
  validateSelection,
  isValidCenter,
  isValidZoom,
  isValidPitch,
  isValidBearing,
  isValidLayer,
  isValidBbox,
  isValidPolygon
} from '../src/utils/stateStorage.js';

function createMockStorage(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear(),
    _store: store
  };
}

test('stateStorage: returns default state when storage is empty or null', () => {
  const emptyStorage = createMockStorage();
  const state = loadAppState(emptyStorage);
  assert.equal(state.version, 1);
  assert.deepEqual(state.map.center, [-71.208, 46.813]);
  assert.equal(state.map.zoom, 6);
  assert.equal(state.map.pitch, 0);
  assert.equal(state.map.bearing, 0);
  assert.equal(state.layer, 'osm');
  assert.equal(state.selection, null);
  assert.equal(state.date, '2026-06-21');

  // When storage is completely null/unavailable
  const nullState = loadAppState(null);
  assert.deepEqual(nullState.map.center, [-71.208, 46.813]);
});

test('stateStorage: validates map orientation and zoom parameters', () => {
  assert.equal(isValidCenter([-73.618, 45.503]), true);
  assert.equal(isValidCenter([-190, 45]), false);
  assert.equal(isValidCenter(['-73.6', '45.5']), false);
  assert.equal(isValidCenter([0, 95]), false);

  assert.equal(isValidZoom(16.5), true);
  assert.equal(isValidZoom(-1), false);
  assert.equal(isValidZoom(30), false);
  assert.equal(isValidZoom(NaN), false);

  assert.equal(isValidPitch(45), true);
  assert.equal(isValidPitch(85), true);
  assert.equal(isValidPitch(90), false);
  assert.equal(isValidPitch(-5), false);

  assert.equal(isValidBearing(180), true);
  assert.equal(isValidBearing(-180), true);
  assert.equal(isValidBearing(-35), true);
  assert.equal(isValidBearing(200), false);
});

test('stateStorage: validates layers and dates', () => {
  assert.equal(isValidLayer('osm'), true);
  assert.equal(isValidLayer('esri'), true);
  assert.equal(isValidLayer('satellite'), false);
  assert.equal(isValidLayer(null), false);
});

test('stateStorage: validates rectangle and polygon selections', () => {
  const validBbox = [-73.62, 45.50, -73.61, 45.51];
  assert.equal(isValidBbox(validBbox), true);
  assert.equal(isValidBbox([-73.61, 45.50, -73.62, 45.51]), false); // west > east

  const validPolygon = [
    [-73.619, 45.502],
    [-73.617, 45.502],
    [-73.617, 45.504],
    [-73.619, 45.502]
  ];
  assert.equal(isValidPolygon(validPolygon), true);
  assert.equal(isValidPolygon([[-73.619, 45.502]]), false); // less than 3 points

  const sanitized = validateSelection({
    bbox: validBbox,
    polygon: validPolygon,
    shapeType: 'polygon'
  });
  assert.ok(sanitized);
  assert.deepEqual(sanitized.bbox, validBbox);
  assert.equal(sanitized.shapeType, 'polygon');

  assert.equal(validateSelection(null), null);
  assert.equal(validateSelection({ invalid: true }), null);
});

test('stateStorage: saves and loads full application state', () => {
  const storage = createMockStorage();

  const customState = {
    version: 1,
    map: {
      center: [-73.618456, 45.503123],
      zoom: 16.25,
      pitch: 52.4,
      bearing: -35.2
    },
    layer: 'esri',
    selection: {
      bbox: [-73.619, 45.501, -73.615, 45.504],
      polygon: [
        [-73.619, 45.501],
        [-73.615, 45.501],
        [-73.615, 45.504],
        [-73.619, 45.504],
        [-73.619, 45.501]
      ],
      shapeType: 'rectangle'
    },
    date: '2026-09-22'
  };

  const saved = saveAppState(customState, storage);
  assert.equal(saved, true);
  assert.ok(storage._store.has(APP_STATE_STORAGE_KEY));

  const loaded = loadAppState(storage);
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.map.center, [-73.618456, 45.503123]);
  assert.equal(loaded.map.zoom, 16.25);
  assert.equal(loaded.map.pitch, 52.4);
  assert.equal(loaded.map.bearing, -35.2);
  assert.equal(loaded.layer, 'esri');
  assert.equal(loaded.selection.shapeType, 'polygon');
  assert.equal(loaded.selection.polygon.length, 5);
  assert.equal(loaded.date, '2026-09-22');
});

test('stateStorage: recovers gracefully from corrupted JSON or out-of-bounds parameters', () => {
  const storage = createMockStorage({
    [APP_STATE_STORAGE_KEY]: 'NOT_VALID_JSON{['
  });

  const state = loadAppState(storage);
  assert.deepEqual(state.map.center, [-71.208, 46.813]);
  assert.equal(state.layer, 'osm');

  // Corrupted map values
  storage.setItem(
    APP_STATE_STORAGE_KEY,
    JSON.stringify({
      version: 1,
      map: {
        center: [999, -999], // out of range
        zoom: -10, // out of range
        pitch: 120, // out of range
        bearing: 500 // out of range
      },
      layer: 'unknown_layer',
      selection: 'not_an_object'
    })
  );

  const repaired = loadAppState(storage);
  assert.deepEqual(repaired.map.center, [-71.208, 46.813]);
  assert.equal(repaired.map.zoom, 6);
  assert.equal(repaired.map.pitch, 0);
  assert.equal(repaired.map.bearing, 0);
  assert.equal(repaired.layer, 'osm');
  assert.equal(repaired.selection, null);
});

test('stateStorage: partial update helpers preserve existing fields', () => {
  const storage = createMockStorage();

  // Set initial custom state
  saveAppState(
    {
      map: { center: [-73.618, 45.503], zoom: 16, pitch: 45, bearing: 0 },
      layer: 'osm',
      selection: {
        bbox: [-73.619, 45.501, -73.615, 45.504],
        polygon: null,
        shapeType: 'rectangle'
      },
      date: '2026-06-21'
    },
    storage
  );

  // 1. Update camera orientation & zoom only
  updateMapState({ pitch: 60, bearing: -45, zoom: 17.5 }, storage);
  let current = loadAppState(storage);
  assert.equal(current.map.pitch, 60);
  assert.equal(current.map.bearing, -45);
  assert.equal(current.map.zoom, 17.5);
  assert.deepEqual(current.map.center, [-73.618, 45.503]); // Preserved
  assert.equal(current.layer, 'osm'); // Preserved
  assert.ok(current.selection !== null); // Preserved

  // 2. Update layer to satellite ('esri')
  updateLayerState('esri', storage);
  current = loadAppState(storage);
  assert.equal(current.layer, 'esri');
  assert.equal(current.map.pitch, 60); // Preserved

  // 3. Update selection to oblong polygon
  const newPolygon = [
    [-73.619, 45.503],
    [-73.617, 45.504],
    [-73.616, 45.502],
    [-73.619, 45.503]
  ];
  updateSelectionState({ bbox: [-73.619, 45.502, -73.616, 45.504], polygon: newPolygon, shapeType: 'polygon' }, storage);
  current = loadAppState(storage);
  assert.equal(current.selection.shapeType, 'polygon');
  assert.equal(current.selection.polygon.length, 4);
  assert.equal(current.layer, 'esri'); // Preserved

  // 4. Clear selection
  updateSelectionState(null, storage);
  current = loadAppState(storage);
  assert.equal(current.selection, null);
  assert.equal(current.layer, 'esri'); // Preserved

  // 5. Clear all app state
  clearAppState(storage);
  assert.equal(storage.getItem(APP_STATE_STORAGE_KEY), null);
});
