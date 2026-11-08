import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBboxDimensions,
  clampBboxToMaxArea,
  normalizeBbox,
  bboxToGeoJSON,
  computePolygonDimensions,
  clampPolygonToMaxArea,
  polygonToGeoJSON,
  computeDistanceMeters,
  computeScreenAlignedRect,
  MAX_PATCH_AREA_M2
} from '../src/utils/geometry.js';

test('normalizeBbox handles reversed coordinates', () => {
  const [minLon, minLat, maxLon, maxLat] = normalizeBbox(-73.60, 45.51, -73.62, 45.49);
  assert.equal(minLon, -73.62);
  assert.equal(minLat, 45.49);
  assert.equal(maxLon, -73.60);
  assert.equal(maxLat, 45.51);
});

test('computeBboxDimensions calculates metric area in Montreal', () => {
  // ~200m x 200m box in Montreal (lat ~45.503)
  // At lat 45.503, 1 deg lat = ~111,139m. 0.0018 deg lat ~= 200m.
  // 1 deg lon = ~77,910m. 0.00256 deg lon ~= 200m.
  const dims = computeBboxDimensions(-73.619, 45.502, -73.61644, 45.5038);
  assert.ok(dims.widthM > 195 && dims.widthM < 205);
  assert.ok(dims.heightM > 195 && dims.heightM < 205);
  assert.ok(dims.areaM2 > 38000 && dims.areaM2 < 42000);
});

test('clampBboxToMaxArea does not clamp small areas', () => {
  const res = clampBboxToMaxArea(-73.619, 45.502, -73.618, 45.503, MAX_PATCH_AREA_M2);
  assert.equal(res.isClamped, false);
  assert.ok(res.areaM2 < MAX_PATCH_AREA_M2);
});

test('clampBboxToMaxArea strictly clamps area exceeding 100,000 m²', () => {
  // Large box (1km x 1km = 1,000,000 m²)
  const res = clampBboxToMaxArea(-73.62, 45.50, -73.60, 45.51, MAX_PATCH_AREA_M2);
  assert.equal(res.isClamped, true);
  assert.ok(res.areaM2 <= MAX_PATCH_AREA_M2);
  assert.ok(res.areaM2 > 99900); // Very close to 100,000 m²
});

test('bboxToGeoJSON generates valid Polygon GeoJSON', () => {
  const geojson = bboxToGeoJSON(-73.62, 45.50, -73.61, 45.51);
  assert.equal(geojson.type, 'Feature');
  assert.equal(geojson.geometry.type, 'Polygon');
  assert.equal(geojson.geometry.coordinates[0].length, 5);
});

test('computePolygonDimensions calculates oblong polygon area accurately', () => {
  // Oblong triangle in Montreal: ~200m base, ~100m height => Area ~10,000 m²
  const triangle = [
    [-73.619, 45.502],
    [-73.61644, 45.502],
    [-73.619, 45.5029]
  ];
  const dims = computePolygonDimensions(triangle);
  assert.ok(dims.areaM2 > 9500 && dims.areaM2 < 10500, `Area ${dims.areaM2} should be ~10,000 m²`);
  assert.equal(dims.bbox[0], -73.619);
  assert.equal(dims.bbox[1], 45.502);
});

test('clampPolygonToMaxArea scales large oblong polygon down to <= 100,000 m²', () => {
  // Large triangle ~200,000 m²
  const largePoly = [
    [-73.63, 45.50],
    [-73.61, 45.50],
    [-73.63, 45.52]
  ];
  const res = clampPolygonToMaxArea(largePoly, MAX_PATCH_AREA_M2);
  assert.equal(res.isClamped, true);
  assert.ok(res.areaM2 <= MAX_PATCH_AREA_M2);
  assert.ok(res.areaM2 > 99500);
});

test('polygonToGeoJSON closes ring if open', () => {
  const coords = [
    [-73.619, 45.502],
    [-73.616, 45.502],
    [-73.619, 45.503]
  ];
  const geojson = polygonToGeoJSON(coords);
  assert.equal(geojson.geometry.type, 'Polygon');
  assert.equal(geojson.geometry.coordinates[0].length, 4);
  assert.deepEqual(geojson.geometry.coordinates[0][0], geojson.geometry.coordinates[0][3]);
});

test('computeDistanceMeters accurately calculates distance in Montreal', () => {
  // 100m north-south at lat 45.5
  // deltaLat = 100 / 111195 ~= 0.0008993
  const d = computeDistanceMeters(-73.60, 45.50, -73.60, 45.5008993);
  assert.ok(Math.abs(d - 100) < 0.5, `Distance should be ~100m, got ${d}`);
});

test('computeScreenAlignedRect creates screen-parallel rectangle (bearing 0)', () => {
  // Simple unproject where 1 px = 1m = (0.000013 deg lon, 0.000009 deg lat)
  const unproject = ([x, y]) => ({
    lng: -73.60 + x * 0.000013,
    lat: 45.50 - y * 0.000009
  });

  const startPoint = { x: 100, y: 100 };
  const endPoint = { x: 200, y: 250 }; // 100px width x 150px height

  const rect = computeScreenAlignedRect(startPoint, endPoint, unproject, MAX_PATCH_AREA_M2);
  assert.ok(rect !== null);
  assert.equal(rect.coordinates.length, 5); // 4 corners + closed
  assert.deepEqual(rect.coordinates[0], rect.coordinates[4]); // closed ring
  assert.ok(rect.areaM2 > 10000 && rect.areaM2 < 20000);
  assert.equal(rect.isClamped, false);
});

test('computeScreenAlignedRect handles rotated camera (bearing 45)', () => {
  // 45 degree camera rotation mock
  const cos45 = Math.cos(Math.PI / 4);
  const sin45 = Math.sin(Math.PI / 4);
  const unproject = ([x, y]) => {
    // Rotated ground space (meters)
    const gx = x * cos45 - y * sin45;
    const gy = x * sin45 + y * cos45;
    return {
      lng: -73.60 + gx * 0.000013,
      lat: 45.50 + gy * 0.000009
    };
  };

  const startPoint = { x: 50, y: 50 };
  const endPoint = { x: 150, y: 150 };

  const rect = computeScreenAlignedRect(startPoint, endPoint, unproject, MAX_PATCH_AREA_M2);
  assert.ok(rect !== null);
  assert.equal(rect.coordinates.length, 5);
  // Ground coordinates are rotated (not axis-aligned in lon/lat)
  assert.notEqual(rect.coordinates[0][0], rect.coordinates[1][0]);
  assert.notEqual(rect.coordinates[0][1], rect.coordinates[1][1]);
  assert.ok(rect.areaM2 > 0);
});

test('computeScreenAlignedRect clamps area exceeding maxAreaM2', () => {
  // Massive 2000px x 2000px box
  const unproject = ([x, y]) => ({
    lng: -73.60 + x * 0.001,
    lat: 45.50 - y * 0.001
  });

  const startPoint = { x: 0, y: 0 };
  const endPoint = { x: 2000, y: 2000 };

  const rect = computeScreenAlignedRect(startPoint, endPoint, unproject, MAX_PATCH_AREA_M2);
  assert.ok(rect !== null);
  assert.equal(rect.isClamped, true);
  assert.ok(rect.areaM2 <= MAX_PATCH_AREA_M2);
  assert.ok(rect.areaM2 > 99000);
});

test('computeScreenAlignedRect ignores tiny drags < 2px', () => {
  const unproject = ([x, y]) => ({ lng: x, lat: y });
  const rect = computeScreenAlignedRect({ x: 10, y: 10 }, { x: 11, y: 10 }, unproject);
  assert.equal(rect, null);
});
