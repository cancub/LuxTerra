/**
 * ShadowRenderer Component
 * Manages an offscreen canvas for decoding and rendering GPU shadow masks.
 */

import { decodeBitmaskToImageData, SHADOW_PIXEL_WORD } from '../utils/maskDecoder.js';

export class ShadowRenderer {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.currentMaskBase64 = null;
    this.rows = 0;
    this.cols = 0;
  }

  /**
   * Renders the Base64 bitmask onto the offscreen canvas.
   * Returns the updated canvas element.
   */
  renderMask(base64Str, rows, cols) {
    if (!base64Str || rows <= 0 || cols <= 0) {
      this.clear();
      return this.canvas;
    }

    if (this.canvas.width !== cols || this.canvas.height !== rows) {
      this.canvas.width = cols;
      this.canvas.height = rows;
      this.rows = rows;
      this.cols = cols;
    }

    const imgData = decodeBitmaskToImageData(base64Str, rows, cols, this.ctx);
    this.ctx.putImageData(imgData, 0, 0);
    this.currentMaskBase64 = base64Str;

    return this.canvas;
  }

  /**
   * Fills the canvas with 100% shadow for the active shape (used during nighttime / sun below horizon).
   * If polygon coordinates and patch bounds are provided, shades strictly inside the polygon.
   */
  renderFullShade(rows, cols, polygonCoords = null, patchBounds = null) {
    if (rows <= 0 || cols <= 0) {
      this.clear();
      return this.canvas;
    }

    if (this.canvas.width !== cols || this.canvas.height !== rows) {
      this.canvas.width = cols;
      this.canvas.height = rows;
      this.rows = rows;
      this.cols = cols;
    }

    this.ctx.clearRect(0, 0, cols, rows);

    if (polygonCoords && Array.isArray(polygonCoords) && polygonCoords.length >= 3 && patchBounds) {
      const [minLon, minLat, maxLon, maxLat] = patchBounds;
      const lonSpan = maxLon - minLon;
      const latSpan = maxLat - minLat;

      if (lonSpan > 0 && latSpan > 0) {
        this.ctx.save();
        this.ctx.beginPath();
        polygonCoords.forEach(([lon, lat], i) => {
          const x = ((lon - minLon) / lonSpan) * cols;
          const y = ((maxLat - lat) / latSpan) * rows; // North is top
          if (i === 0) this.ctx.moveTo(x, y);
          else this.ctx.lineTo(x, y);
        });
        this.ctx.closePath();
        this.ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
        this.ctx.fill();
        this.ctx.restore();
        this.currentMaskBase64 = '__FULL_SHADE_POLYGON__';
        return this.canvas;
      }
    }

    const imgData = this.ctx.createImageData(cols, rows);
    const data32 = new Uint32Array(imgData.data.buffer);
    data32.fill(SHADOW_PIXEL_WORD);
    this.ctx.putImageData(imgData, 0, 0);
    this.currentMaskBase64 = '__FULL_SHADE__';

    return this.canvas;
  }

  clear() {
    if (this.canvas.width > 0 && this.canvas.height > 0) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.currentMaskBase64 = null;
  }

  getCanvas() {
    return this.canvas;
  }
}
