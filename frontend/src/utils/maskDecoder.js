/**
 * High-performance bitmask decoder for LuxTerra shadow masks.
 * Unpacks 1-bit-per-pixel Base64 buffers into typed arrays and ImageData.
 */

// RGBA: (15, 23, 42, 0.70) => Little-endian 32-bit unsigned word: (178 << 24) | (42 << 16) | (23 << 8) | 15
export const TERRAIN_SHADOW_WORD = (((178 << 24) | (42 << 16) | (23 << 8) | 15) >>> 0); // 0xB22a170f
export const SHADOW_PIXEL_WORD = TERRAIN_SHADOW_WORD; // Backwards compatibility

// RGBA: (22, 60, 45, 0.45) => Little-endian 32-bit unsigned word: (115 << 24) | (45 << 16) | (60 << 8) | 22
export const CANOPY_SHADOW_WORD = (((115 << 24) | (45 << 16) | (60 << 8) | 22) >>> 0);  // 0x732d3c16

// Stepped green-to-dark-shadow canopy gradient (levels 1..6); level 7+ saturates to TERRAIN_SHADOW_WORD
const rgbaWord = (r, g, b, a) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
export const CANOPY_SHADE_WORDS = [
  CANOPY_SHADOW_WORD,             // Level 1: light tree canopy (baseline tau)
  rgbaWord(20, 54, 43, 126),      // Level 2
  rgbaWord(19, 48, 42, 137),      // Level 3
  rgbaWord(17, 42, 40, 148),      // Level 4
  rgbaWord(16, 36, 39, 159),      // Level 5
  rgbaWord(15, 30, 38, 170),      // Level 6: dense stacked canopy
];

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
export function decodeDualBitmasksToImageData(terrainB64, canopyB64, rows, cols, ctx, panelShadowBytes = null, canopyShadeB64 = null) {
  const totalPixels = rows * cols;
  const imgData = ctx ? ctx.createImageData(cols, rows) : { data: new Uint8ClampedArray(totalPixels * 4) };
  const data32 = new Uint32Array(imgData.data.buffer);

  if (totalPixels === 0 || (!terrainB64 && !canopyB64)) return imgData;

  const packedTerrain = terrainB64 ? base64ToBytes(terrainB64) : null;
  const packedCanopy = canopyB64 ? base64ToBytes(canopyB64) : null;
  const canopyShadeBytes = canopyShadeB64
    ? (typeof canopyShadeB64 === 'string' ? base64ToBytes(canopyShadeB64) : canopyShadeB64)
    : null;

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

      if (!isTerrainSun || inPanelShadow) {
        // Geological terrain shadow and panel ground shadow take precedence over tree canopy shade
        data32[pixelIdx++] = TERRAIN_SHADOW_WORD;
      } else if (canopyShadeBytes && pixelIdx < canopyShadeBytes.length) {
        const shadeLevel = canopyShadeBytes[pixelIdx];
        if (shadeLevel >= 7) {
          data32[pixelIdx++] = TERRAIN_SHADOW_WORD;
        } else if (shadeLevel >= 1) {
          data32[pixelIdx++] = CANOPY_SHADE_WORDS[shadeLevel - 1];
        } else if (!isCanopySun) {
          data32[pixelIdx++] = CANOPY_SHADOW_WORD;
        } else {
          data32[pixelIdx++] = SUN_PIXEL_WORD;
        }
      } else if (!isCanopySun) {
        // Legacy binary tree canopy shadow
        data32[pixelIdx++] = CANOPY_SHADOW_WORD;
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
 * If chmBytes is provided, skips marking pixels underneath dense tree canopy (>= 2m).
 */
function rasterizeQuad(p0, p1, p2, p3, mask, cols, rows, chmBytes = null) {
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x)));
  const maxX = Math.min(cols - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x, p3.x)));
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y, p3.y)));
  const maxY = Math.min(rows - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y, p3.y)));

  const poly = [p0, p1, p2, p3];

  for (let y = minY; y <= maxY; y++) {
    const rowOffset = y * cols;
    const cy = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      if (chmBytes && (chmBytes[rowOffset + x] * 0.5) >= 2.0) {
        continue; // Underneath dense tree canopy
      }
      const cx = x + 0.5;
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const xi = poly[i].x, yi = poly[i].y;
        const xj = poly[j].x, yj = poly[j].y;
        const intersect = ((yi > cy) !== (yj > cy)) && (cx < ((xj - xi) * (cy - yi)) / (yj - yi) + xi);
        if (intersect) inside = !inside;
      }
      if (inside) {
        mask[rowOffset + x] = 1;
      }
    }
  }
}

/**
 * Marches a shadow ray from (originX, originY) at height `hMeters` along direction (deltaX, deltaY).
 * Truncates the ray as soon as ray height drops below the local canopy height (Option B).
 */
function marchShadowRay(originX, originY, hMeters, deltaX, deltaY, cols, rows, chmBytes = null) {
  if (!chmBytes || hMeters <= 0) {
    return { x: originX + deltaX, y: originY + deltaY };
  }

  const steps = Math.max(1, Math.ceil(Math.hypot(deltaX, deltaY)));
  let currX = originX + deltaX;
  let currY = originY + deltaY;

  for (let s = 1; s <= steps; s++) {
    const u = s / steps;
    const x = Math.round(originX + u * deltaX);
    const y = Math.round(originY + u * deltaY);

    if (x < 0 || x >= cols || y < 0 || y >= rows) {
      break;
    }

    const rayHeight = hMeters * (1.0 - u);
    const treeHeight = chmBytes[y * cols + x] * 0.5;

    if (treeHeight >= rayHeight && treeHeight >= 1.5) {
      // Ray struck tree canopy taller than the shadow! Truncate ray here
      const uHit = Math.max(0, (s - 1) / steps);
      currX = originX + uHit * deltaX;
      currY = originY + uHit * deltaY;
      break;
    }
  }

  return { x: currX, y: currY };
}

/**
 * Synthesizes a binary ground shadow mask for all 3D solar panel racks in the layout.
 * Returns a Uint8Array of size rows * cols (1 = panel shadow, 0 = no panel shadow),
 * or null if unshaded / nighttime.
 * If chmBytes is provided, performs Option B ray-marching truncation against tree canopy heights.
 */
export function rasterizePanelShadowMask(layout, solarAzimuthDeg, solarElevationDeg, patchBounds, rows, cols, chmBytes = null) {
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

    // Subdivide table along width to allow clean per-section CHM canopy shadow truncation
    const numSegs = chmBytes ? Math.max(1, Math.min(tbl.panel_count || 4, 8)) : 1;
    for (let seg = 0; seg < numSegs; seg++) {
      const u0 = seg / numSegs;
      const u1 = (seg + 1) / numSegs;

      const seg_p0 = { x: (1 - u0) * p0.x + u0 * p1.x, y: (1 - u0) * p0.y + u0 * p1.y };
      const seg_p1 = { x: (1 - u1) * p0.x + u1 * p1.x, y: (1 - u1) * p0.y + u1 * p1.y };
      const seg_p2 = { x: (1 - u1) * p3.x + u1 * p2.x, y: (1 - u1) * p3.y + u1 * p2.y };
      const seg_p3 = { x: (1 - u0) * p3.x + u0 * p2.x, y: (1 - u0) * p3.y + u0 * p2.y };

      const seg_p0_proj = marchShadowRay(seg_p0.x, seg_p0.y, hBottom, dX_bot, dY_bot, cols, rows, chmBytes);
      const seg_p1_proj = marchShadowRay(seg_p1.x, seg_p1.y, hBottom, dX_bot, dY_bot, cols, rows, chmBytes);
      const seg_p2_proj = marchShadowRay(seg_p2.x, seg_p2.y, hTop, dX_top, dY_top, cols, rows, chmBytes);
      const seg_p3_proj = marchShadowRay(seg_p3.x, seg_p3.y, hTop, dX_top, dY_top, cols, rows, chmBytes);

      // 1. Rack footprint quad
      rasterizeQuad(seg_p0, seg_p1, seg_p2, seg_p3, mask, cols, rows, chmBytes);

      // 2. Projected rack face quad
      rasterizeQuad(seg_p0_proj, seg_p1_proj, seg_p2_proj, seg_p3_proj, mask, cols, rows, chmBytes);

      // 3. Bridging quads
      rasterizeQuad(seg_p3, seg_p2, seg_p2_proj, seg_p3_proj, mask, cols, rows, chmBytes);
      rasterizeQuad(seg_p0, seg_p1, seg_p1_proj, seg_p0_proj, mask, cols, rows, chmBytes);
    }
  }

  return mask;
}
