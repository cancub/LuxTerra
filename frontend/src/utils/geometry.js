/**
 * Geodesic Geometry Utilities
 * High-precision area calculation and coordinate clamping for bounding boxes.
 */

export const EARTH_RADIUS_METERS = 6371008.8; // Mean Earth radius (IUGG / WGS84)
export const MAX_PATCH_AREA_M2 = 100000.0; // 10 hectares (LuxTerra specification limit)

/**
 * Normalizes coordinates ensuring min <= max.
 */
export function normalizeBbox(minLon, minLat, maxLon, maxLat) {
  return [
    Math.min(minLon, maxLon),
    Math.min(minLat, maxLat),
    Math.max(minLon, maxLon),
    Math.max(minLat, maxLat)
  ];
}

/**
 * Computes metric width (m), height (m), and surface area (m²) for a WGS84 bounding box.
 * Uses high-precision geodesic cosine projection.
 */
export function computeBboxDimensions(minLon, minLat, maxLon, maxLat) {
  const [nMinLon, nMinLat, nMaxLon, nMaxLat] = normalizeBbox(minLon, minLat, maxLon, maxLat);
  const midLat = ((nMinLat + nMaxLat) / 2.0) * (Math.PI / 180.0);

  const deltaLonRad = (nMaxLon - nMinLon) * (Math.PI / 180.0);
  const deltaLatRad = (nMaxLat - nMinLat) * (Math.PI / 180.0);

  const widthM = EARTH_RADIUS_METERS * Math.cos(midLat) * deltaLonRad;
  const heightM = EARTH_RADIUS_METERS * deltaLatRad;
  const areaM2 = Math.max(0.0, widthM * heightM);

  return {
    widthM: Math.round(widthM * 100) / 100,
    heightM: Math.round(heightM * 100) / 100,
    areaM2: Math.round(areaM2 * 100) / 100
  };
}

/**
 * Clamps the drag target coordinate so that the resulting bounding box
 * never exceeds maxAreaM2, preserving aspect ratio during user dragging.
 */
export function clampBboxToMaxArea(startLon, startLat, curLon, curLat, maxAreaM2 = MAX_PATCH_AREA_M2) {
  const dims = computeBboxDimensions(startLon, startLat, curLon, curLat);

  if (dims.areaM2 <= maxAreaM2 || dims.areaM2 <= 0) {
    return {
      curLon,
      curLat,
      areaM2: dims.areaM2,
      widthM: dims.widthM,
      heightM: dims.heightM,
      isClamped: false
    };
  }

  // Scale factor preserving aspect ratio: Area' = Area * scale^2 = maxAreaM2 => scale = sqrt(maxAreaM2 / Area)
  const scale = Math.sqrt(maxAreaM2 / dims.areaM2);
  const clampedLon = startLon + (curLon - startLon) * scale;
  const clampedLat = startLat + (curLat - startLat) * scale;

  const clampedDims = computeBboxDimensions(startLon, startLat, clampedLon, clampedLat);

  return {
    curLon: clampedLon,
    curLat: clampedLat,
    areaM2: Math.min(maxAreaM2, clampedDims.areaM2),
    widthM: clampedDims.widthM,
    heightM: clampedDims.heightM,
    isClamped: true
  };
}

/**
 * Converts bounding box coordinates into GeoJSON Polygon feature.
 */
export function bboxToGeoJSON(minLon, minLat, maxLon, maxLat) {
  const [w, s, e, n] = normalizeBbox(minLon, minLat, maxLon, maxLat);
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s]
        ]
      ]
    }
  };
}
