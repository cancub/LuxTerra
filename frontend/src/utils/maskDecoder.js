/**
 * High-performance bitmask decoder for LuxTerra shadow masks.
 * Unpacks 1-bit-per-pixel Base64 buffers into typed arrays and ImageData.
 */

// RGBA: (15, 23, 42, 0.70) => Little-endian 32-bit unsigned word: (178 << 24) | (42 << 16) | (23 << 8) | 15
export const TERRAIN_SHADOW_WORD = (((178 << 24) | (42 << 16) | (23 << 8) | 15) >>> 0); // 0xB22a170f
export const SHADOW_PIXEL_WORD = TERRAIN_SHADOW_WORD; // Backwards compatibility

// RGBA: (22, 60, 45, 0.45) => Little-endian 32-bit unsigned word: (115 << 24) | (45 << 16) | (60 << 8) | 22
export const CANOPY_SHADOW_WORD = (((115 << 24) | (45 << 16) | (60 << 8) | 22) >>> 0);  // 0x732d3c16

export const SUN_PIXEL_WORD = 0x00000000; // 100% transparent

/**
 * Decodes a Base64 string into a Uint8Array byte buffer.
 * Compatible with both Browser (atob) and Node (Buffer).
 */
export function base64ToBytes(base64Str) {
  if (!base64Str) return new Uint8Array(0);
  if (typeof atob === 'function') {
    const binary = atob(base64Str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } else if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64Str, 'base64'));
  }
  throw new Error('No base64 decoding implementation available');
}

/**
 * Decodes a bit-packed Base64 string into a flat Uint8Array (1 = unshaded, 0 = shaded).
 */
export function decodeBitmask(base64Str, rows, cols) {
  const totalPixels = rows * cols;
  const result = new Uint8Array(totalPixels);
  if (totalPixels === 0 || !base64Str) return result;

  const packed = base64ToBytes(base64Str);
  let pixelIdx = 0;

  for (let i = 0; i < packed.length && pixelIdx < totalPixels; i++) {
    const byte = packed[i];
    for (let b = 7; b >= 0 && pixelIdx < totalPixels; b--) {
      result[pixelIdx++] = (byte >> b) & 1;
    }
  }

  return result;
}

/**
 * Decodes a bit-packed Base64 string directly into an HTML5 Canvas ImageData.
 * Directly writes 32-bit pixel words for maximum rendering throughput.
 * If panelShadowBytes is provided, panel shadows are merged as TERRAIN_SHADOW_WORD
 * without double-darkening on intersection.
 */
export function decodeBitmaskToImageData(base64Str, rows, cols, ctx, panelShadowBytes = null) {
  const totalPixels = rows * cols;
  const imgData = ctx ? ctx.createImageData(cols, rows) : { data: new Uint8ClampedArray(totalPixels * 4) };
  const data32 = new Uint32Array(imgData.data.buffer);
  
  if (totalPixels === 0 || !base64Str) return imgData;

  const packed = base64ToBytes(base64Str);
  let pixelIdx = 0;

  for (let i = 0; i < packed.length && pixelIdx < totalPixels; i++) {
    const byte = packed[i];
    for (let b = 7; b >= 0 && pixelIdx < totalPixels; b--) {
      const isTerrainSun = (byte >> b) & 1;
      const inPanelShadow = panelShadowBytes ? (panelShadowBytes[pixelIdx] !== 0) : false;
      data32[pixelIdx++] = (isTerrainSun && !inPanelShadow) ? SUN_PIXEL_WORD : TERRAIN_SHADOW_WORD;
    }
  }

  return imgData;
}

/**
 * Decodes dual-channel bit-packed Base64 strings (terrain + canopy) into an HTML5 Canvas ImageData.
 * Directly writes:
 *   - TERRAIN_SHADOW_WORD if terrain is occluded (bit == 0) OR if in panel shadow on sunlit ground
 *   - CANOPY_SHADOW_WORD if canopy is occluded (bit == 0 and terrain bit == 1)
 *   - SUN_PIXEL_WORD if unshaded (both bits == 1 and not in panel shadow)
 *
 * Ensures strictly binary shadow coloring and physical occlusion precedence:
 *   - Tree canopy blocks direct sunbeams; panel ground shadows cannot penetrate or override tree canopy shade
 *   - Panel ground shadows only project onto direct sunlit ground (terrain bit == 1 && canopy bit == 1)
 *   - geological shadow = TERRAIN_SHADOW_WORD
 *   - panel shadow = TERRAIN_SHADOW_WORD
 *   - geological + panel shadow = TERRAIN_SHADOW_WORD (no darkening)
 */
export function decodeDualBitmasksToImageData(terrainB64, canopyB64, rows, cols, ctx, panelShadowBytes = null) {
  const totalPixels = rows * cols;
  const imgData = ctx ? ctx.createImageData(cols, rows) : { data: new Uint8ClampedArray(totalPixels * 4) };
  const data32 = new Uint32Array(imgData.data.buffer);

  if (totalPixels === 0 || (!terrainB64 && !canopyB64)) return imgData;

  const packedTerrain = terrainB64 ? base64ToBytes(terrainB64) : null;
  const packedCanopy = canopyB64 ? base64ToBytes(canopyB64) : null;

  if (!packedCanopy) {
    return decodeBitmaskToImageData(terrainB64, rows, cols, ctx, panelShadowBytes);
  }

  let pixelIdx = 0;
  const byteCount = Math.min(
    packedTerrain ? packedTerrain.length : packedCanopy.length,
    packedCanopy.length
  );

  for (let i = 0; i < byteCount && pixelIdx < totalPixels; i++) {
    const tByte = packedTerrain ? packedTerrain[i] : 0xFF;
    const cByte = packedCanopy[i];

    for (let b = 7; b >= 0 && pixelIdx < totalPixels; b--) {
      const isTerrainSun = (tByte >> b) & 1;
      const isCanopySun = (cByte >> b) & 1;
      const inPanelShadow = panelShadowBytes ? (panelShadowBytes[pixelIdx] !== 0) : false;

      if (!isTerrainSun) {
        // Geological terrain shadow always dominates
        data32[pixelIdx++] = TERRAIN_SHADOW_WORD;
      } else if (!isCanopySun) {
        // Tree canopy shadow: trees intercept direct sunbeams, so panel shadow does not penetrate tree canopy shade
        data32[pixelIdx++] = CANOPY_SHADOW_WORD;
      } else if (inPanelShadow) {
        // Panel ground shadow projects onto direct sunlit ground
        data32[pixelIdx++] = TERRAIN_SHADOW_WORD;
      } else {
        // Direct sunlight
        data32[pixelIdx++] = SUN_PIXEL_WORD;
      }
    }
  }

  return imgData;
}

/**
 * Fast scanline quad rasterization into a binary mask array.
 */
function rasterizeQuad(p0, p1, p2, p3, mask, cols, rows) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x)));
  const maxX = Math.min(cols - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x, p3.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y, p3.y)));
  const maxY = Math.min(rows - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y, p3.y)));

  const poly = [p0, p1, p2, p3];

  for (let y = minY; y <= maxY; y++) {
    const cy = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const cx = x + 0.5;
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > cy) !== (yj > cy)) && (cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) {
        mask[y * cols + x] = 1;
      }
    }
  }
}

/**
 * Synthesizes a binary ground shadow mask for all 3D solar panel racks in the layout.
 * Returns a Uint8Array of size rows * cols (1 = panel shadow, 0 = no panel shadow),
 * or null if unshaded / nighttime.
 */
export function rasterizePanelShadowMask(layout, solarAzimuthDeg, solarElevationDeg, patchBounds, rows, cols) {
  if (!layout || !layout.tables || layout.tables.length === 0 || !patchBounds || rows <= 0 || cols <= 0 || solarElevationDeg <= 0) {
    return null;
  }

  const [minLon, minLat, maxLon, maxLat] = patchBounds;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  if (lonSpan <= 0 || latSpan <= 0) return null;

  const centerLat = 0.5 * (minLat + maxLat);
  const metersPerDegLat = 111132.95;
  const metersPerDegLon = 111412.84 * Math.cos((centerLat * Math.PI) / 180.0);

  const azRad = (solarAzimuthDeg * Math.PI) / 180.0;
  const elRad = (Math.max(1.5, solarElevationDeg) * Math.PI) / 180.0;
  const tanEl = Math.tan(elRad);

  const maxShadowMeters = 50.0;
  const shadowDistPerM = Math.min(maxShadowMeters, 1.0 / tanEl);
  const dX_m = -Math.sin(azRad) * shadowDistPerM;
  const dY_m = -Math.cos(azRad) * shadowDistPerM; // +y is North in meters

  const dX_grid_per_meter = (1.0 / (metersPerDegLon * lonSpan)) * cols;
  const dY_grid_per_meter = -(1.0 / (metersPerDegLat * latSpan)) * rows; // North is row 0

  const dX_grid_unit = dX_m * dX_grid_per_meter;
  const dY_grid_unit = dY_m * dY_grid_per_meter;

  const mask = new Uint8Array(rows * cols);

  for (let t = 0; t < layout.tables.length; t++) {
    const tbl = layout.tables[t];
    const corners = tbl.corners_wgs84;
    if (!corners || corners.length < 4) continue;

    const tiltRad = ((tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0) * Math.PI) / 180.0;
    const hBottom = tbl.stand_height_m !== undefined ? tbl.stand_height_m : 1.0;
    const slantH = tbl.slant_height_m !== undefined ? tbl.slant_height_m : 4.56;
    const hTop = hBottom + slantH * Math.sin(tiltRad);

    const dX_bot = dX_grid_unit * hBottom;
    const dY_bot = dY_grid_unit * hBottom;
    const dX_top = dX_grid_unit * hTop;
    const dY_top = dY_grid_unit * hTop;

    // Grid coordinates of table ground post corners: SW, SE, NE, NW
    const p0 = {
      x: ((corners[0][0] - minLon) / lonSpan) * cols,
      y: ((maxLat - corners[0][1]) / latSpan) * rows
    };
    const p1 = {
      x: ((corners[1][0] - minLon) / lonSpan) * cols,
      y: ((maxLat - corners[1][1]) / latSpan) * rows
    };
    const p2 = {
      x: ((corners[2][0] - minLon) / lonSpan) * cols,
      y: ((maxLat - corners[2][1]) / latSpan) * rows
    };
    const p3 = {
      x: ((corners[3][0] - minLon) / lonSpan) * cols,
      y: ((maxLat - corners[3][1]) / latSpan) * rows
    };

    // Projected elevated corners on ground plane
    const p0_proj = { x: p0.x + dX_bot, y: p0.y + dY_bot };
    const p1_proj = { x: p1.x + dX_bot, y: p1.y + dY_bot };
    const p2_proj = { x: p2.x + dX_top, y: p2.y + dY_top };
    const p3_proj = { x: p3.x + dX_top, y: p3.y + dY_top };

    // 1. Rack footprint quad
    rasterizeQuad(p0, p1, p2, p3, mask, cols, rows);

    // 2. Projected rack face quad
    rasterizeQuad(p0_proj, p1_proj, p2_proj, p3_proj, mask, cols, rows);

    // 3. Bridging quads
    rasterizeQuad(p3, p2, p2_proj, p3_proj, mask, cols, rows);
    rasterizeQuad(p0, p1, p1_proj, p0_proj, mask, cols, rows);
  }

  return mask;
}
