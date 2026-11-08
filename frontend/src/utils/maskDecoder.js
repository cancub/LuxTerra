/**
 * High-performance bitmask decoder for LuxTerra shadow masks.
 * Unpacks 1-bit-per-pixel Base64 buffers into typed arrays and ImageData.
 */

// RGBA: (15, 23, 42, 0.55) => Little-endian 32-bit unsigned word: (140 << 24) | (42 << 16) | (23 << 8) | 15
export const SHADOW_PIXEL_WORD = (((140 << 24) | (42 << 16) | (23 << 8) | 15) >>> 0);
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
