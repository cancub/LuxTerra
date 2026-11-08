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

/**
 * Computes metric surface area (m²), perimeter (m), and bounding box for an arbitrary polygon.
 * Uses high-precision geodesic equirectangular projection to metric coordinates and the Shoelace formula.
 */
export function computePolygonDimensions(coordinates) {
  if (!coordinates || coordinates.length < 3) {
    return {
      areaM2: 0,
      perimeterM: 0,
      bbox: [0, 0, 0, 0],
      centroid: [0, 0]
    };
  }

  // Remove duplicate closing point if present for vertex processing
  const pts = [...coordinates];
  if (
    pts.length > 3 &&
    pts[0][0] === pts[pts.length - 1][0] &&
    pts[0][1] === pts[pts.length - 1][1]
  ) {
    pts.pop();
  }

  const n = pts.length;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let sumLon = 0;
  let sumLat = 0;

  for (let i = 0; i < n; i++) {
    const [lon, lat] = pts[i];
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    sumLon += lon;
    sumLat += lat;
  }

  const centerLon = sumLon / n;
  const centerLat = sumLat / n;
  const midLatRad = centerLat * (Math.PI / 180.0);
  const cosMidLat = Math.cos(midLatRad);

  // Convert to local metric planar coordinates (x East, y North)
  const metricCoords = pts.map(([lon, lat]) => [
    EARTH_RADIUS_METERS * cosMidLat * (lon * (Math.PI / 180.0)),
    EARTH_RADIUS_METERS * (lat * (Math.PI / 180.0))
  ]);

  // Shoelace formula for area & perimeter
  let areaSum = 0;
  let perimeter = 0;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, y0] = metricCoords[i];
    const [x1, y1] = metricCoords[j];
    areaSum += (x0 * y1) - (x1 * y0);
    const dx = x1 - x0;
    const dy = y1 - y0;
    perimeter += Math.sqrt(dx * dx + dy * dy);
  }

  const areaM2 = Math.abs(areaSum) / 2.0;

  return {
    areaM2: Math.round(areaM2 * 100) / 100,
    perimeterM: Math.round(perimeter * 100) / 100,
    bbox: [minLon, minLat, maxLon, maxLat],
    centroid: [centerLon, centerLat]
  };
}

/**
 * Clamps a polygon so that its surface area never exceeds maxAreaM2,
 * scaling vertices radially towards its centroid.
 */
export function clampPolygonToMaxArea(coordinates, maxAreaM2 = MAX_PATCH_AREA_M2) {
  const dims = computePolygonDimensions(coordinates);

  if (dims.areaM2 <= maxAreaM2 || dims.areaM2 <= 0) {
    return {
      coordinates,
      areaM2: dims.areaM2,
      bbox: dims.bbox,
      isClamped: false
    };
  }

  const scale = Math.sqrt(maxAreaM2 / dims.areaM2);
  const [cLon, cLat] = dims.centroid;

  // Scale each vertex around centroid
  const clampedCoords = coordinates.map(([lon, lat]) => [
    cLon + (lon - cLon) * scale,
    cLat + (lat - cLat) * scale
  ]);

  const clampedDims = computePolygonDimensions(clampedCoords);

  return {
    coordinates: clampedCoords,
    areaM2: Math.min(maxAreaM2, clampedDims.areaM2),
    bbox: clampedDims.bbox,
    isClamped: true
  };
}

/**
 * Converts an array of coordinates into a GeoJSON Polygon feature.
 */
export function polygonToGeoJSON(coordinates) {
  if (!coordinates || coordinates.length < 3) {
    return {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [[]]
      }
    };
  }

  const ring = [...coordinates];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    ring.push([first[0], first[1]]);
  }

  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring]
    }
  };
}

/**
 * Computes high-precision metric geodesic distance between two WGS84 points.
 */
export function computeDistanceMeters(lon1, lat1, lon2, lat2) {
  const midLat = ((lat1 + lat2) / 2.0) * (Math.PI / 180.0);
  const dx = EARTH_RADIUS_METERS * Math.cos(midLat) * ((lon2 - lon1) * (Math.PI / 180.0));
  const dy = EARTH_RADIUS_METERS * ((lat2 - lat1) * (Math.PI / 180.0));
  return Math.hypot(dx, dy);
}

/**
 * Computes a screen-aligned rectangle polygon from two screen points.
 * Corners are ordered clockwise: Top-Left, Top-Right, Bottom-Right, Bottom-Left, Top-Left (closed).
 * All 4 edges in screen space are strictly horizontal and vertical (parallel to viewport edges),
 * regardless of the camera's bearing or pitch.
 *
 * @param {{x: number, y: number}} startPoint Screen coordinate of start point
 * @param {{x: number, y: number}} endPoint Screen coordinate of current/end point
 * @param {Function} unproject Function converting [x, y] screen point to {lng, lat} or [lng, lat]
 * @param {number} maxAreaM2 Maximum allowed area in square meters (default: 100,000)
 */
export function computeScreenAlignedRect(startPoint, endPoint, unproject, maxAreaM2 = MAX_PATCH_AREA_M2) {
  if (!startPoint || !endPoint || typeof unproject !== 'function') {
    return null;
  }

  let x1 = startPoint.x;
  let y1 = startPoint.y;
  let x2 = endPoint.x;
  let y2 = endPoint.y;

  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  if (dx < 2 || dy < 2) {
    return null;
  }

  const toLngLat = (pt) => {
    const res = unproject(pt);
    if (!res) return [0, 0];
    const lng = (res.lng !== undefined) ? res.lng : res[0];
    const lat = (res.lat !== undefined) ? res.lat : res[1];
    return [lng, lat];
  };

  const getCorners = (p1x, p1y, p2x, p2y) => {
    const minX = Math.min(p1x, p2x);
    const maxX = Math.max(p1x, p2x);
    const minY = Math.min(p1y, p2y);
    const maxY = Math.max(p1y, p2y);

    const tl = toLngLat([minX, minY]);
    const tr = toLngLat([maxX, minY]);
    const br = toLngLat([maxX, maxY]);
    const bl = toLngLat([minX, maxY]);

    return [tl, tr, br, bl, tl];
  };

  let coords = getCorners(x1, y1, x2, y2);
  let dims = computePolygonDimensions(coords);
  let isClamped = false;

  if (dims.areaM2 > maxAreaM2 && dims.areaM2 > 0) {
    let scale = Math.sqrt(maxAreaM2 / dims.areaM2);
    x2 = x1 + (x2 - x1) * scale;
    y2 = y1 + (y2 - y1) * scale;

    coords = getCorners(x1, y1, x2, y2);
    dims = computePolygonDimensions(coords);

    // One refinement step if geodesic projection curvature introduced slight variance
    if (Math.abs(dims.areaM2 - maxAreaM2) > 1.0 && dims.areaM2 > 0) {
      scale = Math.sqrt((maxAreaM2 - 0.5) / dims.areaM2);
      x2 = x1 + (x2 - x1) * scale;
      y2 = y1 + (y2 - y1) * scale;
      coords = getCorners(x1, y1, x2, y2);
      dims = computePolygonDimensions(coords);
    }
    isClamped = true;
  }

  // Metric width & height from opposing parallel edges
  const widthM = computeDistanceMeters(coords[0][0], coords[0][1], coords[1][0], coords[1][1]);
  const heightM = computeDistanceMeters(coords[1][0], coords[1][1], coords[2][0], coords[2][1]);

  return {
    coordinates: coords,
    bbox: dims.bbox,
    areaM2: dims.areaM2,
    widthM: Math.round(widthM * 10) / 10,
    heightM: Math.round(heightM * 10) / 10,
    isClamped,
    dimensions: {
      ...dims,
      widthM: Math.round(widthM * 10) / 10,
      heightM: Math.round(heightM * 10) / 10
    }
  };
}
