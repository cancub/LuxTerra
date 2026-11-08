/**
 * stateStorage.js
 * Persistent state management for LuxTerra application.
 * Synchronizes camera orientation (center, zoom, pitch, bearing), base layer (osm/esri),
 * active selection (rectangle/oblong coordinates & shapeType), and date to localStorage.
 */

export const APP_STATE_STORAGE_KEY = 'luxterra_app_state';

export const QUEBEC_CENTER = [-71.208, 46.813];
export const DEFAULT_ZOOM = 6;

export const DEFAULT_APP_STATE = Object.freeze({
  version: 1,
  map: Object.freeze({
    center: Object.freeze([...QUEBEC_CENTER]),
    zoom: DEFAULT_ZOOM,
    pitch: 0,
    bearing: 0
  }),
  layer: 'osm', // 'osm' | 'esri'
  selection: null, // { bbox: [minLon, minLat, maxLon, maxLat], polygon: [[lon, lat], ...], shapeType: 'rectangle'|'polygon' }
  date: '2026-06-21'
});

/**
 * Safely access localStorage in browser or fallback to null in non-browser/restricted environments.
 */
function getStorage(customStorage) {
  if (customStorage) return customStorage;
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  return null;
}

/**
 * Validate map camera center coordinates [lon, lat]
 */
export function isValidCenter(center) {
  return (
    Array.isArray(center) &&
    center.length === 2 &&
    typeof center[0] === 'number' &&
    typeof center[1] === 'number' &&
    Number.isFinite(center[0]) &&
    Number.isFinite(center[1]) &&
    center[0] >= -180 &&
    center[0] <= 180 &&
    center[1] >= -90 &&
    center[1] <= 90
  );
}

/**
 * Validate zoom level
 */
export function isValidZoom(zoom) {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= 0 && zoom <= 24;
}

/**
 * Validate pitch angle
 */
export function isValidPitch(pitch) {
  return typeof pitch === 'number' && Number.isFinite(pitch) && pitch >= 0 && pitch <= 85;
}

/**
 * Validate bearing angle
 */
export function isValidBearing(bearing) {
  return typeof bearing === 'number' && Number.isFinite(bearing) && bearing >= -180 && bearing <= 180;
}

/**
 * Validate base layer identifier
 */
export function isValidLayer(layer) {
  return layer === 'osm' || layer === 'esri';
}

/**
 * Validate date string (YYYY-MM-DD)
 */
export function isValidDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

/**
 * Validate bounding box [minLon, minLat, maxLon, maxLat]
 */
export function isValidBbox(bbox) {
  return (
    Array.isArray(bbox) &&
    bbox.length === 4 &&
    bbox.every((v) => typeof v === 'number' && Number.isFinite(v)) &&
    bbox[0] < bbox[2] &&
    bbox[1] < bbox[3] &&
    bbox[0] >= -180 &&
    bbox[2] <= 180 &&
    bbox[1] >= -90 &&
    bbox[3] <= 90
  );
}

/**
 * Validate polygon coordinate ring
 */
export function isValidPolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  return polygon.every(
    (pt) =>
      Array.isArray(pt) &&
      pt.length >= 2 &&
      typeof pt[0] === 'number' &&
      typeof pt[1] === 'number' &&
      Number.isFinite(pt[0]) &&
      Number.isFinite(pt[1]) &&
      pt[0] >= -180 &&
      pt[0] <= 180 &&
      pt[1] >= -90 &&
      pt[1] <= 90
  );
}

/**
 * Validate and sanitize selection object
 */
export function validateSelection(selection) {
  if (!selection || typeof selection !== 'object') return null;

  const validBbox = isValidBbox(selection.bbox) ? [...selection.bbox] : null;
  const validPolygon = isValidPolygon(selection.polygon)
    ? selection.polygon.map((p) => [p[0], p[1]])
    : null;

  if (!validBbox && !validPolygon) return null;

  const shapeType = selection.shapeType === 'polygon' ? 'polygon' : 'rectangle';

  return {
    bbox: validBbox,
    polygon: validPolygon,
    shapeType
  };
}

/**
 * Validate and sanitize map camera object
 */
export function validateMapState(mapObj) {
  if (!mapObj || typeof mapObj !== 'object') {
    return { ...DEFAULT_APP_STATE.map };
  }

  const center = isValidCenter(mapObj.center)
    ? [Number(mapObj.center[0].toFixed(6)), Number(mapObj.center[1].toFixed(6))]
    : [...DEFAULT_APP_STATE.map.center];

  const zoom = isValidZoom(mapObj.zoom)
    ? Number(mapObj.zoom.toFixed(2))
    : DEFAULT_APP_STATE.map.zoom;

  const pitch = isValidPitch(mapObj.pitch)
    ? Number(mapObj.pitch.toFixed(1))
    : DEFAULT_APP_STATE.map.pitch;

  const bearing = isValidBearing(mapObj.bearing)
    ? Number(mapObj.bearing.toFixed(1))
    : DEFAULT_APP_STATE.map.bearing;

  return { center, zoom, pitch, bearing };
}

/**
 * Load persisted app state from localStorage.
 * Falls back to default state if not found or corrupted.
 */
export function loadAppState(customStorage = null) {
  const storage = getStorage(customStorage);
  if (!storage) {
    return {
      version: DEFAULT_APP_STATE.version,
      map: { ...DEFAULT_APP_STATE.map },
      layer: DEFAULT_APP_STATE.layer,
      selection: null,
      date: DEFAULT_APP_STATE.date
    };
  }

  try {
    const raw = storage.getItem(APP_STATE_STORAGE_KEY);
    if (!raw) {
      return {
        version: DEFAULT_APP_STATE.version,
        map: { ...DEFAULT_APP_STATE.map },
        layer: DEFAULT_APP_STATE.layer,
        selection: null,
        date: DEFAULT_APP_STATE.date
      };
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        version: DEFAULT_APP_STATE.version,
        map: { ...DEFAULT_APP_STATE.map },
        layer: DEFAULT_APP_STATE.layer,
        selection: null,
        date: DEFAULT_APP_STATE.date
      };
    }

    return {
      version: parsed.version || 1,
      map: validateMapState(parsed.map),
      layer: isValidLayer(parsed.layer) ? parsed.layer : DEFAULT_APP_STATE.layer,
      selection: validateSelection(parsed.selection),
      date: isValidDate(parsed.date) ? parsed.date : DEFAULT_APP_STATE.date
    };
  } catch (err) {
    console.warn('Failed to parse app state from localStorage:', err);
    return {
      version: DEFAULT_APP_STATE.version,
      map: { ...DEFAULT_APP_STATE.map },
      layer: DEFAULT_APP_STATE.layer,
      selection: null,
      date: DEFAULT_APP_STATE.date
    };
  }
}

/**
 * Save complete app state to localStorage.
 */
export function saveAppState(state, customStorage = null) {
  const storage = getStorage(customStorage);
  if (!storage) return false;

  try {
    const sanitized = {
      version: 1,
      map: validateMapState(state.map),
      layer: isValidLayer(state.layer) ? state.layer : DEFAULT_APP_STATE.layer,
      selection: validateSelection(state.selection),
      date: isValidDate(state.date) ? state.date : DEFAULT_APP_STATE.date
    };
    storage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(sanitized));
    return true;
  } catch (err) {
    console.warn('Failed to save app state to localStorage:', err);
    return false;
  }
}

/**
 * Update map camera parameters (orientation & zoom) in persistent storage.
 */
export function updateMapState(mapPartial, customStorage = null) {
  const current = loadAppState(customStorage);
  current.map = {
    ...current.map,
    ...mapPartial
  };
  return saveAppState(current, customStorage);
}

/**
 * Update active base layer (satellite/map) in persistent storage.
 */
export function updateLayerState(layer, customStorage = null) {
  const current = loadAppState(customStorage);
  current.layer = isValidLayer(layer) ? layer : 'osm';
  return saveAppState(current, customStorage);
}

/**
 * Update drawn rectangle/polygon selection in persistent storage.
 */
export function updateSelectionState(selection, customStorage = null) {
  const current = loadAppState(customStorage);
  current.selection = validateSelection(selection);
  return saveAppState(current, customStorage);
}

/**
 * Update selected date in persistent storage.
 */
export function updateDateState(date, customStorage = null) {
  const current = loadAppState(customStorage);
  if (isValidDate(date)) {
    current.date = date;
    return saveAppState(current, customStorage);
  }
  return false;
}

/**
 * Clear persisted app state.
 */
export function clearAppState(customStorage = null) {
  const storage = getStorage(customStorage);
  if (!storage) return false;
  try {
    storage.removeItem(APP_STATE_STORAGE_KEY);
    return true;
  } catch (err) {
    console.warn('Failed to clear app state from localStorage:', err);
    return false;
  }
}
