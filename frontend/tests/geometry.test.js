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
