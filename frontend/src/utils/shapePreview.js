/**
 * Shape Preview & Location Utilities
 * Generates 100x100 satellite thumbnails framed at 1.5x the largest bbox dimension
 * and resolves city/town names for saved shapes.
 */

const TILE_SIZE = 256;

export function lonToMercatorX(lon) {
  return (lon + 180) / 360;
}

export function latToMercatorY(lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

/**
 * Compute the Web Mercator square bounds and tile plan covering 1.5x the largest
 * dimension of the given WGS84 bbox, targeting outputSize x outputSize pixels.
 */
export function computeThumbnailTilePlan(bbox, scale = 1.5, outputSize = 100) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [minLon, minLat, maxLon, maxLat] = bbox;

  const x0 = lonToMercatorX(Math.min(minLon, maxLon));
  const x1 = lonToMercatorX(Math.max(minLon, maxLon));
  const y0 = latToMercatorY(Math.max(minLat, maxLat)); // north = smaller Y
  const y1 = latToMercatorY(Math.min(minLat, maxLat)); // south = larger Y

  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rawSpan = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  const span = Math.max(rawSpan * scale, 1e-6);

  const half = span / 2;
  const squareBounds = {
    minX: cx - half,
    maxX: cx + half,
    minY: cy - half,
    maxY: cy + half,
    span
  };

  // Pick zoom where the 1.5x square spans at least outputSize * 1.5 pixels (for crisp downsampling)
  const idealZoom = Math.ceil(Math.log2((outputSize * 1.5) / (TILE_SIZE * span)));
  const zoom = Math.max(1, Math.min(18, idealZoom));
  const worldPixels = TILE_SIZE * Math.pow(2, zoom);

  const pxMinX = squareBounds.minX * worldPixels;
  const pxMaxX = squareBounds.maxX * worldPixels;
  const pxMinY = squareBounds.minY * worldPixels;
  const pxMaxY = squareBounds.maxY * worldPixels;

  const maxTile = Math.pow(2, zoom) - 1;
  const txMin = Math.max(0, Math.floor(pxMinX / TILE_SIZE));
  const txMax = Math.min(maxTile, Math.floor(pxMaxX / TILE_SIZE));
  const tyMin = Math.max(0, Math.floor(pxMinY / TILE_SIZE));
  const tyMax = Math.min(maxTile, Math.floor(pxMaxY / TILE_SIZE));

  return {
    zoom,
    squareBounds,
    pxMinX,
    pxMaxX,
    pxMinY,
    pxMaxY,
    txMin,
    txMax,
    tyMin,
    tyMax
  };
}

function loadTileImage(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(null), 5000);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Capture a 100x100px satellite thumbnail centered on the shape, framed at
 * 1.5x the largest dimension of the shape's bounding box.
 */
export async function captureShapeThumbnail(bbox, polygon = null, outputSize = 100) {
  if (typeof document === 'undefined' || !Array.isArray(bbox) || bbox.length !== 4) {
    return null;
  }

  const plan = computeThumbnailTilePlan(bbox, 1.5, outputSize);
  if (!plan) return null;

  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, outputSize, outputSize);

  const { zoom, pxMinX, pxMaxX, pxMinY, pxMaxY, txMin, txMax, tyMin, tyMax, squareBounds } = plan;
  const spanPx = Math.max(1, pxMaxX - pxMinX);
  const scaleToOut = outputSize / spanPx;

  const tilePromises = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${tx}`;
      tilePromises.push(
        loadTileImage(url).then((img) => ({ img, tx, ty }))
      );
    }
  }

  const tiles = await Promise.all(tilePromises);
  let loadedCount = 0;
  for (const { img, tx, ty } of tiles) {
    if (!img) continue;
    loadedCount++;
    const dx = (tx * TILE_SIZE - pxMinX) * scaleToOut;
    const dy = (ty * TILE_SIZE - pxMinY) * scaleToOut;
    const dw = TILE_SIZE * scaleToOut;
    const dh = TILE_SIZE * scaleToOut;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  if (loadedCount === 0) {
    return null;
  }

  // Draw subtle outline of the shape inside the 1.5x square
  const ring = Array.isArray(polygon) && polygon.length >= 3
    ? polygon
    : [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]]
      ];

  ctx.save();
  ctx.beginPath();
  ring.forEach(([lon, lat], idx) => {
    const mx = lonToMercatorX(lon);
    const my = latToMercatorY(lat);
    const px = ((mx - squareBounds.minX) / squareBounds.span) * outputSize;
    const py = ((my - squareBounds.minY) / squareBounds.span) * outputSize;
    if (idx === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.9)';
  ctx.stroke();
  ctx.restore();

  try {
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch (e) {
    return null;
  }
}

export function formatLocationFromAddress(address, lat, lon) {
  if (address && typeof address === 'object') {
    const locality =
      address.city ||
      address.town ||
      address.village ||
      address.municipality ||
      address.borough ||
      address.suburb ||
      address.county;
    if (locality) {
      return String(locality);
    }
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(2)}°${ns}, ${Math.abs(lon).toFixed(2)}°${ew}`;
  }
  return 'Unknown location';
}

export async function lookupShapeLocation(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return 'Unknown location';
  const lon = (bbox[0] + bbox[2]) / 2;
  const lat = (bbox[1] + bbox[3]) / 2;

  if (typeof fetch !== 'function') {
    return formatLocationFromAddress(null, lat, lon);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&zoom=12`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    clearTimeout(timer);
    if (!res.ok) {
      return formatLocationFromAddress(null, lat, lon);
    }
    const data = await res.json();
    return formatLocationFromAddress(data?.address, lat, lon);
  } catch (e) {
    return formatLocationFromAddress(null, lat, lon);
  }
}
