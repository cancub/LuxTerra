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
 */
export function decodeBitmaskToImageData(base64Str, rows, cols, ctx) {
  const totalPixels = rows * cols;
  const imgData = ctx ? ctx.createImageData(cols, rows) : { data: new Uint8ClampedArray(totalPixels * 4) };
  const data32 = new Uint32Array(imgData.data.buffer);
  
  if (totalPixels === 0 || !base64Str) return imgData;

  const packed = base64ToBytes(base64Str);
  let pixelIdx = 0;

  for (let i = 0; i < packed.length && pixelIdx < totalPixels; i++) {
    const byte = packed[i];
    for (let b = 7; b >= 0 && pixelIdx < totalPixels; b--) {
      const isSun = (byte >> b) & 1;
      data32[pixelIdx++] = isSun ? SUN_PIXEL_WORD : SHADOW_PIXEL_WORD;
    }
  }

  return imgData;
}

/**
 * Decodes dual-channel bit-packed Base64 strings (terrain + canopy) into an HTML5 Canvas ImageData.
 * Directly writes:
 *   - TERRAIN_SHADOW_WORD if terrain is occluded (bit == 0)
 *   - CANOPY_SHADOW_WORD if canopy is occluded (bit == 0 and terrain bit == 1)
 *   - SUN_PIXEL_WORD if unshaded (both bits == 1)
 */
export function decodeDualBitmasksToImageData(terrainB64, canopyB64, rows, cols, ctx) {
  const totalPixels = rows * cols;
  const imgData = ctx ? ctx.createImageData(cols, rows) : { data: new Uint8ClampedArray(totalPixels * 4) };
  const data32 = new Uint32Array(imgData.data.buffer);

  if (totalPixels === 0 || (!terrainB64 && !canopyB64)) return imgData;

  const packedTerrain = terrainB64 ? base64ToBytes(terrainB64) : null;
  const packedCanopy = canopyB64 ? base64ToBytes(canopyB64) : null;

  if (!packedCanopy) {
    return decodeBitmaskToImageData(terrainB64, rows, cols, ctx);
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
      if (!isTerrainSun) {
        data32[pixelIdx++] = TERRAIN_SHADOW_WORD;
      } else {
        const isCanopySun = (cByte >> b) & 1;
        data32[pixelIdx++] = isCanopySun ? SUN_PIXEL_WORD : CANOPY_SHADOW_WORD;
      }
    }
  }

  return imgData;
}
