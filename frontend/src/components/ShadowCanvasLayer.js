/**
 * ShadowCanvasLayer Component
 * Synchronizes the offscreen shadow canvas with MapLibre's spatial projection,
 * locking the shadow raster texture precisely to ground coordinates.
 */

import { ShadowRenderer } from './ShadowRenderer.js';

export class ShadowCanvasLayer {
  constructor(map, shadowRenderer = null) {
    this.map = map;
    this.shadowRenderer = shadowRenderer || new ShadowRenderer();
    this.sourceId = 'shadow-canvas-source';
    this.layerId = 'shadow-canvas-layer';
    this.currentBounds = null; // [minLon, minLat, maxLon, maxLat]
    this.isLayerAttached = false;
  }

  /**
   * Sets the geographic coordinates for the target patch bounding box.
   * Format: [minLon, minLat, maxLon, maxLat]
   */
  setPatchBounds(bounds) {
    if (!bounds || bounds.length !== 4) return;
    this.currentBounds = bounds;
    const [minLon, minLat, maxLon, maxLat] = bounds;

    // 4 corners: [top-left, top-right, bottom-right, bottom-left]
    const coordinates = [
      [minLon, maxLat],
      [maxLon, maxLat],
      [maxLon, minLat],
      [minLon, minLat]
    ];

    const source = this.map.getSource(this.sourceId);
    if (source) {
      source.setCoordinates(coordinates);
    } else {
      this.attachLayer(coordinates);
    }
  }

  attachLayer(coordinates) {
    if (this.map.getSource(this.sourceId)) return;

    this.map.addSource(this.sourceId, {
      type: 'canvas',
      canvas: this.shadowRenderer.getCanvas(),
      coordinates: coordinates,
      animate: true
    });

    // Insert layer beneath labels/draw overlays if possible
    const beforeId = this.map.getLayer('draw-box-fill') ? 'draw-box-fill' : undefined;

    this.map.addLayer(
      {
        id: this.layerId,
        type: 'raster',
        source: this.sourceId,
        paint: {
          'raster-fade-duration': 0,
          'raster-resampling': 'nearest',
          'raster-opacity': 1.0
        }
      },
      beforeId
    );

    this.isLayerAttached = true;
  }

  /**
   * Renders the specified Base64 bitmask onto the offscreen canvas
   * and requests a MapLibre repaint.
   */
  renderFrame(base64Mask, rows, cols) {
    if (!base64Mask || rows <= 0 || cols <= 0) {
      this.clear();
      return;
    }

    this.shadowRenderer.renderMask(base64Mask, rows, cols);

    const source = this.map.getSource(this.sourceId);
    if (source && typeof source.play === 'function') {
      source.play();
    }
    this.map.triggerRepaint();
  }

  /**
   * Renders 100% full shadow across the entire patch (used for nighttime).
   */
  renderFullShade(rows, cols) {
    if (rows <= 0 || cols <= 0) {
      this.clear();
      return;
    }

    this.shadowRenderer.renderFullShade(rows, cols);

    const source = this.map.getSource(this.sourceId);
    if (source && typeof source.play === 'function') {
      source.play();
    }
    this.map.triggerRepaint();
  }

  clear() {
    this.shadowRenderer.clear();
    const source = this.map.getSource(this.sourceId);
    if (source && typeof source.play === 'function') {
      source.play();
    }
    this.map.triggerRepaint();
  }

  getRenderer() {
    return this.shadowRenderer;
  }
}
