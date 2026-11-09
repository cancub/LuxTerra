/**
 * ShadowRenderer Component
 * Manages an offscreen canvas for decoding and rendering GPU shadow masks.
 */

import {
  decodeBitmaskToImageData,
  decodeDualBitmasksToImageData,
  TERRAIN_SHADOW_WORD
} from '../utils/maskDecoder.js';

export class ShadowRenderer {
  constructor() {
    this.canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    this.ctx = this.canvas && this.canvas.getContext ? this.canvas.getContext('2d', { willReadFrequently: false }) : null;
    this.currentMaskBase64 = null;
    this.currentCanopyBase64 = null;
    this.rows = 0;
    this.cols = 0;
  }

  /**
   * Renders the Base64 bitmask(s) onto the offscreen canvas.
   * Supports single terrain bitmasks, dual terrain + canopy bitmasks, and unified panel ground shadows.
   * Returns the updated canvas element or ImageData.
   */
  renderMask(base64Str, rows, cols, canopyBase64Str = null, panelShadowBytes = null) {
    if (!base64Str || rows <= 0 || cols <= 0) {
      this.clear();
      return this.canvas;
    }

    if (this.canvas) {
      if (this.canvas.width !== cols || this.canvas.height !== rows) {
        this.canvas.width = cols;
        this.canvas.height = rows;
        this.rows = rows;
        this.cols = cols;
      }
    }

    const imgData = canopyBase64Str
      ? decodeDualBitmasksToImageData(base64Str, canopyBase64Str, rows, cols, this.ctx, panelShadowBytes)
      : decodeBitmaskToImageData(base64Str, rows, cols, this.ctx, panelShadowBytes);

    if (this.ctx) {
      this.ctx.putImageData(imgData, 0, 0);
    }
    this.currentMaskBase64 = base64Str;
    this.currentCanopyBase64 = canopyBase64Str;

    return this.canvas || imgData;
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

    if (this.canvas) {
      if (this.canvas.width !== cols || this.canvas.height !== rows) {
        this.canvas.width = cols;
        this.canvas.height = rows;
        this.rows = rows;
        this.cols = cols;
      }
    }

    if (this.ctx) {
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
          this.ctx.fillStyle = 'rgba(15, 23, 42, 0.70)';
          this.ctx.fill();
          this.ctx.restore();
          this.currentMaskBase64 = '__FULL_SHADE_POLYGON__';
          this.currentCanopyBase64 = null;
          return this.canvas;
        }
      }

      const imgData = this.ctx.createImageData(cols, rows);
      const data32 = new Uint32Array(imgData.data.buffer);
      data32.fill(TERRAIN_SHADOW_WORD);
      this.ctx.putImageData(imgData, 0, 0);
    }

    this.currentMaskBase64 = '__FULL_SHADE__';
    this.currentCanopyBase64 = null;

    return this.canvas;
  }

  clear() {
    if (this.canvas && this.canvas.width > 0 && this.canvas.height > 0 && this.ctx) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }
    this.currentMaskBase64 = null;
    this.currentCanopyBase64 = null;
  }

  getCanvas() {
    return this.canvas;
  }
}
