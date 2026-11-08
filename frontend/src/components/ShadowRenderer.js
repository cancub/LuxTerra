/**
 * ShadowRenderer Component
 * Manages an offscreen canvas for decoding and rendering GPU shadow masks.
 */

import { decodeBitmaskToImageData } from '../utils/maskDecoder.js';

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
