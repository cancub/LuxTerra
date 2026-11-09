/**
 * BoxDrawer / ShapeDrawer Component
 * Interactive drawing tool supporting:
 *  1. Oblong & irregular multi-point polygons (sequence of clicks).
 *  2. Standard hotkey/click combos to close:
 *     - Hold Shift: next click jumps straight to the 1st point to close.
 *     - Hover start point (magnetic snapping): jumps straight to 1st point to close.
 *     - Double-click: automatically closes to 1st point.
 *     - Enter key: automatically closes to 1st point.
 *     - Esc key: cancels drawing.
 *     - Backspace/Delete key: removes last placed vertex.
 *  3. Click-and-drag for quick rectangular areas.
 *  4. Native WebGL GeoJSON layers for zero lag during map pan and zoom.
 *  5. Post-completion interactive vertex dragging.
 *  6. Surface area clamping to <= 100,000 m².
 */

import {
  clampBboxToMaxArea,
  computeBboxDimensions,
  bboxToGeoJSON,
  computePolygonDimensions,
  clampPolygonToMaxArea,
  polygonToGeoJSON,
  computeDistanceMeters,
  computeScreenAlignedRect,
  openPolygonRing,
  MAX_PATCH_AREA_M2
} from '../utils/geometry.js';

export class BoxDrawer {
  constructor(map, container, onSelectionComplete, onStateChange) {
    this.map = map;
    this.container = container;
    this.onSelectionComplete = onSelectionComplete || (() => {});
    this.onStateChange = onStateChange || (() => {});

    this.isDrawingActive = false;
    this.drawMode = 'polygon'; // 'polygon' | 'rectangle'
    this.shapeType = 'polygon'; // 'polygon' | 'rectangle' | null
    this.isDragging = false;
    this.isResizing = false;
    this.activeVertexIndex = null;
    this.startLngLat = null;
    this.currentBbox = null;
    this.currentPolygon = null;
    this.currentContextBbox = null; // [minLon, minLat, maxLon, maxLat] enclosing the solar array
    this.currentContextPolygon = null;
    this.isEditingContext = false;
    this.activeContextCorner = null;

    // Multi-point polygon drawing state
    this.points = []; // Array of [lon, lat]
    this.isShiftHeld = false;
    this.isSnapToStart = false;
    this.lastMousePoint = null;
    this.lastMouseLngLat = null;

    // Rectangle interaction state machine
    this.rectState = 'idle'; // 'idle' | 'dragging' | 'expanding'
    this.isRectMouseDown = false;
    this.rectMovedDuringDown = false;
    this.rectStartPoint = null;
    this.rectStartLngLat = null;
    this.justFinishedDrag = false;

    // Oblong vertex modification & line hover state
    this.hoveredHandleId = null;
    this.hoveredVertexIndex = null;
    this.activeMidpoint = null;

    this.initLayers();
    this.initTooltip();
    if (this.container) {
      this.render();
    }
    this.bindMapEvents();
    this.bindKeyboardEvents();
  }

  initLayers() {
    if (this.map.isStyleLoaded()) {
      this.addMapLayers();
    } else {
      this.map.on('load', () => this.addMapLayers());
    }
  }

  addMapLayers() {
    if (this.map.getSource('draw-box-source')) return;

    this.map.addSource('draw-box-source', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: []
      }
    });

    this.map.addLayer({
      id: 'draw-box-fill',
      type: 'fill',
      source: 'draw-box-source',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'fill-color': [
          'case',
          ['boolean', ['feature-state', 'clamped'], false],
          'rgba(239, 68, 68, 0.35)', // Red when clamped
          'rgba(56, 189, 248, 0.25)'  // Cyan default
        ],
        'fill-outline-color': 'transparent'
      }
    });

    this.map.addLayer({
      id: 'draw-box-stroke',
      type: 'line',
      source: 'draw-box-source',
      paint: {
        'line-color': [
          'case',
          ['boolean', ['feature-state', 'clamped'], false],
          '#ef4444',
          '#38bdf8'
        ],
        'line-width': 2.5
      }
    });

    // Outer visual context boundary layers (subtle dashed border & corner handles)
    if (!this.map.getSource('draw-context-source')) {
      this.map.addSource('draw-context-source', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      this.map.addLayer({
        id: 'draw-context-stroke',
        type: 'line',
        source: 'draw-context-source',
        paint: {
          'line-color': '#f59e0b', // Subtle amber/gold dashed context envelope
          'line-width': 2,
          'line-dasharray': [4, 3],
          'line-opacity': 0.85
        }
      });
    }

    // Invisible hit stroke layer for detecting hover & clicks along polygon line segments
    this.map.addLayer({
      id: 'draw-box-stroke-hit',
      type: 'line',
      source: 'draw-box-source',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: {
        'line-width': 22,
        'line-color': '#000000',
        'line-opacity': 0.001
      }
    });

    // Native WebGL-rendered midpoint layer for adding points along oblong edges
    if (!this.map.getSource('draw-midpoint-source')) {
      this.map.addSource('draw-midpoint-source', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      this.map.addLayer({
        id: 'draw-midpoint-glow',
        type: 'circle',
        source: 'draw-midpoint-source',
        paint: {
          'circle-radius': 11,
          'circle-color': 'rgba(56, 189, 248, 0.35)',
          'circle-blur': 0.35
        }
      });

      this.map.addLayer({
        id: 'draw-midpoint-core',
        type: 'circle',
        source: 'draw-midpoint-source',
        paint: {
          'circle-radius': 5.5,
          'circle-color': 'rgba(255, 255, 255, 0.75)',
          'circle-stroke-width': 2,
          'circle-stroke-color': 'rgba(56, 189, 248, 0.85)'
        }
      });

      this.map.addLayer({
        id: 'draw-midpoint-hit',
        type: 'circle',
        source: 'draw-midpoint-source',
        paint: {
          'circle-radius': 18,
          'circle-color': '#000000',
          'circle-opacity': 0.001
        }
      });
    }

    // Native WebGL-rendered interactive handle layers (zero lag during map pan/zoom)
    if (!this.map.getSource('draw-handles-source')) {
      this.map.addSource('draw-handles-source', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: []
        }
      });

      this.map.addLayer({
        id: 'draw-handles-glow',
        type: 'circle',
        source: 'draw-handles-source',
        paint: {
          'circle-radius': [
            'case',
            ['boolean', ['feature-state', 'snapped'], false],
            18,
            ['boolean', ['feature-state', 'hover'], false],
            13,
            9
          ],
          'circle-color': [
            'case',
            ['boolean', ['feature-state', 'deleteHover'], false],
            'rgba(239, 68, 68, 0.5)',
            ['boolean', ['feature-state', 'clamped'], false],
            'rgba(239, 68, 68, 0.5)',
            'rgba(56, 189, 248, 0.5)'
          ],
          'circle-blur': 0.45
        }
      });

      this.map.addLayer({
        id: 'draw-handles-core',
        type: 'circle',
        source: 'draw-handles-source',
        paint: {
          'circle-radius': [
            'case',
            ['boolean', ['feature-state', 'snapped'], false],
            9,
            ['boolean', ['feature-state', 'hover'], false],
            7.5,
            6
          ],
          'circle-color': [
            'case',
            ['boolean', ['feature-state', 'deleteHover'], false],
            '#fee2e2',
            ['boolean', ['feature-state', 'snapped'], false],
            '#38bdf8',
            '#ffffff'
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': [
            'case',
            ['boolean', ['feature-state', 'deleteHover'], false],
            '#ef4444',
            ['boolean', ['feature-state', 'clamped'], false],
            '#ef4444',
            '#38bdf8'
          ]
        }
      });

      this.map.addLayer({
        id: 'draw-handles-hit',
        type: 'circle',
        source: 'draw-handles-source',
        paint: {
          'circle-radius': 16,
          'circle-color': '#000000',
          'circle-opacity': 0.001
        }
      });

      if (this.currentPolygon) {
        this.renderFinalShape(this.currentPolygon, this.isClamped || false);
        this.updateHandles(this.currentPolygon, this.isClamped || false);
      } else if (this.currentBbox) {
        this.renderFinalBbox(this.currentBbox, this.isClamped || false);
        this.updateHandles(this.currentBbox, this.isClamped || false);
      }
    }
  }

  initTooltip() {
    this.tooltip = document.createElement('div');
    this.tooltip.className = 'glass-panel draw-tooltip';
    this.tooltip.style.position = 'fixed';
    this.tooltip.style.display = 'none';
    this.tooltip.style.pointerEvents = 'none';
    this.tooltip.style.padding = '6px 12px';
    this.tooltip.style.fontSize = '0.78rem';
    this.tooltip.style.zIndex = '1000';
    this.tooltip.style.transform = 'translate(14px, 14px)';
    this.tooltip.style.fontFamily = 'var(--font-mono)';
    this.tooltip.style.whiteSpace = 'nowrap';
    this.tooltip.style.borderRadius = '8px';
    this.tooltip.style.backdropFilter = 'blur(12px)';
    document.body.appendChild(this.tooltip);
  }

  render() {
    if (!this.container) return;
    this.button = document.createElement('button');
    this.button.className = 'btn btn-sm btn-draw';
    this.button.title = 'Select Solar Area: Click sequence of points for oblong shape (Hold Shift / double-click to close), or drag rectangle';
    this.button.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
        <polyline points="2 17 12 22 22 17"></polyline>
        <polyline points="2 12 12 17 22 12"></polyline>
      </svg>
      <span>Draw Area</span>
    `;

    this.button.addEventListener('click', () => {
      this.toggleDrawing();
    });

    this.container.appendChild(this.button);
  }

  setStateChangeListener(fn) {
    this.onStateChange = fn;
    this.notifyState();
  }

  notifyState() {
    if (typeof this.onStateChange === 'function') {
      const dims = this.currentPolygon
        ? computePolygonDimensions(this.currentPolygon)
        : (this.currentBbox ? computeBboxDimensions(...this.currentBbox) : null);

      this.onStateChange({
        isDrawingActive: this.isDrawingActive,
        drawMode: this.drawMode,
        shapeType: this.shapeType,
        hasShape: !!(this.currentPolygon || this.currentBbox),
        isPolygon: this.shapeType === 'polygon',
        isRectangle: this.shapeType === 'rectangle',
        currentBbox: this.currentBbox,
        currentPolygon: this.currentPolygon,
        currentContextBbox: this.currentContextBbox,
        hasContext: !!this.currentContextBbox,
        isEditingContext: this.isEditingContext,
        dimensions: dims
      });
    }
  }

  startDrawing(mode = 'polygon') {
    if (this.isDrawingActive && this.drawMode === mode) {
      this.cancelDrawing();
      return;
    }

    this.drawMode = mode;
    this.shapeType = mode;
    this.isDrawingActive = true;
    this.isDragging = false;
    this.points = [];
    this.isSnapToStart = false;

    // Reset rectangle interaction state
    this.rectState = 'idle'; // 'idle' | 'dragging' | 'expanding'
    this.isRectMouseDown = false;
    this.rectMovedDuringDown = false;
    this.rectStartPoint = null;
    this.rectStartLngLat = null;
    this.justFinishedDrag = false;

    if (this.button) {
      this.button.classList.add('active', 'btn-accent');
    }

    this.map.getCanvas().style.cursor = 'crosshair';
    this.map.dragPan.disable();
    this.map.doubleClickZoom.disable();
    this.removeHandles();

    if (mode === 'rectangle') {
      this.showTooltip(0, 0, 'Click & drag, or click to start rectangle • Esc to cancel');
    } else {
      this.showTooltip(0, 0, 'Click map to place 1st point • Esc to cancel');
    }

    this.notifyState();
  }

  stopDrawing() {
    this.isDrawingActive = false;
    this.isDragging = false;
    this.points = [];
    this.isSnapToStart = false;

    this.rectState = 'idle';
    this.isRectMouseDown = false;
    this.rectMovedDuringDown = false;
    this.rectStartPoint = null;
    this.rectStartLngLat = null;

    if (this.button) {
      this.button.classList.remove('active', 'btn-accent');
    }

    this.map.getCanvas().style.cursor = '';
    this.map.dragPan.enable();
    this.map.doubleClickZoom.enable();
    this.hideTooltip();
    this.notifyState();
  }

  toggleDrawing() {
    if (this.isDrawingActive) {
      this.cancelDrawing();
    } else {
      this.startDrawing(this.drawMode || 'polygon');
    }
  }

  cancelDrawing() {
    if (this.isDrawingActive) {
      this.stopDrawing();
      if (this.currentPolygon) {
        this.renderFinalShape(this.currentPolygon, false);
        this.updateHandles(this.currentPolygon, false);
      } else if (this.currentBbox) {
        this.renderFinalBbox(this.currentBbox, false);
        this.updateHandles(this.currentBbox, false);
      } else {
        this.clearSource();
      }
      this.notifyState();
    }
  }

  /**
   * Computes a screen-aligned rectangle polygon between an anchor LngLat and a screen point.
   * Corners are strictly parallel to the screen edges, regardless of camera bearing or pitch.
   */
  computeScreenRectangle(startLngLat, currentScreenPoint) {
    if (!startLngLat || !currentScreenPoint) return null;
    const startScreen = this.map.project(startLngLat);
    return computeScreenAlignedRect(
      startScreen,
      currentScreenPoint,
      (pt) => this.map.unproject(pt),
      MAX_PATCH_AREA_M2
    );
  }

  renderPreviewShape(coordinates, isClamped = false) {
    const boxSource = this.map.getSource('draw-box-source');
    if (boxSource) {
      const feature = polygonToGeoJSON(coordinates);
      feature.id = 1;
      boxSource.setData({
        type: 'FeatureCollection',
        features: [feature]
      });
      this.map.setFeatureState(
        { source: 'draw-box-source', id: 1 },
        { clamped: isClamped }
      );
    }

    // Render corner handle dots during preview
    const handleSource = this.map.getSource('draw-handles-source');
    if (handleSource) {
      const pts = coordinates.slice(0, 4);
      const handleFeatures = pts.map((pt, idx) => ({
        type: 'Feature',
        id: idx + 1,
        properties: { vertexIndex: idx, cursor: 'crosshair' },
        geometry: { type: 'Point', coordinates: pt }
      }));
      handleSource.setData({
        type: 'FeatureCollection',
        features: handleFeatures
      });
      handleFeatures.forEach(feat => {
        this.map.setFeatureState(
          { source: 'draw-handles-source', id: feat.id },
          { clamped: isClamped }
        );
      });
    }
  }

  finalizeRectangle(rectData) {
    if (!rectData || rectData.areaM2 < 25) {
      this.stopDrawing();
      this.clearSource();
      return;
    }

    this.shapeType = 'rectangle';
    this.currentPolygon = rectData.coordinates;
    this.currentBbox = rectData.bbox;

    this.renderFinalShape(rectData.coordinates, rectData.isClamped);
    this.updateHandles(rectData.coordinates, rectData.isClamped);
    this.stopDrawing();
    this.notifyState();

    this.onSelectionComplete({
      bbox: rectData.bbox,
      polygon: rectData.coordinates,
      dimensions: rectData.dimensions,
      shapeType: 'rectangle',
      isRectangle: true
    });
  }

  bindKeyboardEvents() {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Shift') {
        this.isShiftHeld = true;
        if (this.hoveredHandleId !== null && this.shapeType === 'polygon' && this.currentPolygon) {
          this.map.setFeatureState(
            { source: 'draw-handles-source', id: this.hoveredHandleId },
            { deleteHover: true }
          );
        }
      }

      if (!this.isDrawingActive) return;

      if (e.key === 'Shift') {
        if (this.points.length >= 3 && this.lastMouseLngLat) {
          this.updateDrawingPreview(this.lastMouseLngLat, this.lastMousePoint);
        }
      } else if (e.key === 'Enter') {
        if (this.points.length >= 3) {
          this.finalizePolygon(this.points);
        }
      } else if (e.key === 'Escape') {
        this.cancelDrawing();
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (this.points.length > 0) {
          this.points.pop();
          if (this.lastMouseLngLat) {
            this.updateDrawingPreview(this.lastMouseLngLat, this.lastMousePoint);
          }
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.key === 'Shift') {
        this.isShiftHeld = false;
        if (this.hoveredHandleId !== null) {
          this.map.setFeatureState(
            { source: 'draw-handles-source', id: this.hoveredHandleId },
            { deleteHover: false }
          );
        }
        if (this.isDrawingActive && this.lastMouseLngLat) {
          this.updateDrawingPreview(this.lastMouseLngLat, this.lastMousePoint);
        }
      }
    });
  }

  bindMapEvents() {
    // 1. Mouse down: can start a drag-rectangle or finalize click-to-start rectangle
    this.map.on('mousedown', (e) => {
      if (!this.isDrawingActive) return;

      if (this.drawMode === 'rectangle') {
        if (this.rectState === 'idle') {
          this.isRectMouseDown = true;
          this.rectMovedDuringDown = false;
          this.rectStartPoint = e.point;
          this.rectStartLngLat = e.lngLat;
        } else if (this.rectState === 'expanding') {
          // Second click completes the expanding rectangle!
          const rectData = this.computeScreenRectangle(this.rectStartLngLat, e.point);
          if (rectData && rectData.areaM2 >= 25) {
            this.finalizeRectangle(rectData);
            this.justFinishedDrag = true;
            setTimeout(() => { this.justFinishedDrag = false; }, 100);
          } else {
            this.cancelDrawing();
          }
        }
        return;
      }

      this.startLngLat = e.lngLat;
      this.startPoint = e.point;
      this.isPotentialDrag = true;
    });

    // 2. Mouse move: updates preview for screen-parallel rectangle or polygon line
    this.map.on('mousemove', (e) => {
      this.lastMousePoint = e.point;
      this.lastMouseLngLat = e.lngLat;

      if (!this.isDrawingActive) {
        if (!this.isResizing && this.shapeType === 'polygon' && this.currentPolygon && !this.hoveredHandleId) {
          const segData = this.findClosestSegment(e.point);
          if (segData && segData.distancePx <= 18) {
            this.showMidpoint(segData.segmentIndex, segData.midpoint);
          } else {
            this.clearMidpoint();
          }
        } else if (this.activeMidpoint && this.hoveredHandleId) {
          this.clearMidpoint();
        }
        return;
      }

      if (this.drawMode === 'rectangle') {
        if (this.isRectMouseDown && (this.rectState === 'idle' || this.rectState === 'dragging')) {
          const dist = Math.hypot(e.point.x - this.rectStartPoint.x, e.point.y - this.rectStartPoint.y);
          if (dist >= 5) {
            this.rectMovedDuringDown = true;
            this.rectState = 'dragging';
            const rectData = this.computeScreenRectangle(this.rectStartLngLat, e.point);
            if (rectData) {
              this.renderPreviewShape(rectData.coordinates, rectData.isClamped);
              const msg = `${rectData.widthM.toFixed(0)}m × ${rectData.heightM.toFixed(0)}m · ${rectData.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m² • Release to finish${rectData.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
              this.showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, msg, rectData.isClamped);
            }
          }
        } else if (this.rectState === 'expanding') {
          const rectData = this.computeScreenRectangle(this.rectStartLngLat, e.point);
          if (rectData) {
            this.renderPreviewShape(rectData.coordinates, rectData.isClamped);
            const msg = `${rectData.widthM.toFixed(0)}m × ${rectData.heightM.toFixed(0)}m · ${rectData.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m² • Click to finish • Esc to cancel${rectData.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
            this.showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, msg, rectData.isClamped);
          }
        }
        return;
      }

      // Check if user is drag-drawing a box in polygon mode
      if (this.isPotentialDrag && this.points.length === 0 && this.startPoint) {
        const dx = e.point.x - this.startPoint.x;
        const dy = e.point.y - this.startPoint.y;
        if (Math.hypot(dx, dy) > 20) {
          this.isDragging = true;
        }
      }

      if (this.isDragging && this.startLngLat) {
        // Quick drag-box mode
        const clamped = clampBboxToMaxArea(
          this.startLngLat.lng,
          this.startLngLat.lat,
          e.lngLat.lng,
          e.lngLat.lat,
          MAX_PATCH_AREA_M2
        );
        const bbox = [
          Math.min(this.startLngLat.lng, clamped.curLon),
          Math.min(this.startLngLat.lat, clamped.curLat),
          Math.max(this.startLngLat.lng, clamped.curLon),
          Math.max(this.startLngLat.lat, clamped.curLat)
        ];
        this.currentBbox = bbox;
        this.currentPolygon = null;
        this.renderFinalBbox(bbox, clamped.isClamped);

        const msg = `${clamped.widthM.toFixed(0)}m × ${clamped.heightM.toFixed(0)}m · ${clamped.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${clamped.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
        this.showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, msg, clamped.isClamped);
        return;
      }

      // Multi-point polygon drawing mode
      this.updateDrawingPreview(e.lngLat, e.point, e.originalEvent.clientX, e.originalEvent.clientY);
    });

    // 3. Click: places vertices or closes polygon (or absorbs rectangle drag finish)
    this.map.on('click', (e) => {
      if (!this.isDrawingActive) return;
      if (this.drawMode === 'rectangle') {
        if (this.justFinishedDrag) {
          this.justFinishedDrag = false;
        }
        return;
      }
      if (this.isDragging) return; // Ignore clicks if it was a drag gesture

      const clickLngLat = [e.lngLat.lng, e.lngLat.lat];

      if (this.points.length === 0) {
        // First point
        this.points.push(clickLngLat);
        this.updateDrawingPreview(e.lngLat, e.point);
        return;
      }

      // If user has at least 3 points and is snapping to start (or held Shift), close shape!
      if (this.points.length >= 3 && this.isSnapToStart) {
        this.finalizePolygon(this.points);
        return;
      }

      // Add next point in sequence
      this.points.push(clickLngLat);
      this.updateDrawingPreview(e.lngLat, e.point);
    });

    // 4. Mouse up: finalizes drag or transitions to expanding
    const finalizeMouseUp = (e) => {
      if (!this.isDrawingActive) return;

      if (this.drawMode === 'rectangle') {
        if (this.justFinishedDrag) {
          this.justFinishedDrag = false;
          return;
        }

        if (this.rectState === 'dragging') {
          // Click & hold: release to finish!
          this.isRectMouseDown = false;
          const endPoint = e.point || (e.clientX ? { x: e.clientX, y: e.clientY } : this.lastMousePoint);
          const rectData = this.computeScreenRectangle(this.rectStartLngLat, endPoint);
          if (rectData && rectData.areaM2 >= 25) {
            this.finalizeRectangle(rectData);
            this.justFinishedDrag = true;
            setTimeout(() => { this.justFinishedDrag = false; }, 100);
          } else {
            this.cancelDrawing();
          }
        } else if (this.rectState === 'idle' && this.isRectMouseDown) {
          // Click & release: switch to expanding mode!
          this.isRectMouseDown = false;
          if (!this.rectMovedDuringDown) {
            this.rectState = 'expanding';
            const clientX = e.originalEvent ? e.originalEvent.clientX : (e.clientX || 0);
            const clientY = e.originalEvent ? e.originalEvent.clientY : (e.clientY || 0);
            this.showTooltip(clientX, clientY, 'Move mouse to resize • Click again to finish • Esc to cancel');
          }
        }
        return;
      }

      this.isPotentialDrag = false;
      if (this.isDragging && this.currentBbox) {
        this.isDragging = false;
        this.hideTooltip();
        this.stopDrawing();
        const dims = computeBboxDimensions(...this.currentBbox);
        if (dims.areaM2 >= 100.0) {
          this.createHandles();
          this.notifyState();
          this.onSelectionComplete({
            bbox: this.currentBbox,
            polygon: null,
            dimensions: dims
          });
        }
      }
    };

    this.map.on('mouseup', finalizeMouseUp);
    window.addEventListener('mouseup', finalizeMouseUp);

    // 5. Double-click: ignored in rectangle mode; finishes polygon in polygon mode
    this.map.on('dblclick', (e) => {
      if (!this.isDrawingActive) return;
      e.preventDefault();
      e.stopPropagation();
      if (this.drawMode === 'rectangle') {
        // Double click is strictly ignored in rectangle mode
        return;
      }
      if (this.points.length >= 3) {
        this.finalizePolygon(this.points);
      }
    });

    // 6. Interactive WebGL Handle Events (zero DOM lag during scroll or zoom)
    this.map.on('mouseenter', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive || this.isDragging || this.isResizing) return;
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.hoveredHandleId = feat.id;
        this.hoveredVertexIndex = feat.properties.vertexIndex;
        this.clearMidpoint();

        const isDelete = this.isShiftHeld && this.shapeType === 'polygon';
        this.map.getCanvas().style.cursor = isDelete ? 'pointer' : (feat.properties.cursor || 'pointer');
        this.map.setFeatureState(
          { source: 'draw-handles-source', id: this.hoveredHandleId },
          { hover: true, deleteHover: isDelete }
        );

        if (this.shapeType === 'polygon' && this.currentPolygon) {
          const clientX = e.originalEvent ? e.originalEvent.clientX : 0;
          const clientY = e.originalEvent ? e.originalEvent.clientY : 0;
          const count = this.getUniqueVertexCount();
          if (count > 3) {
            this.showTooltip(clientX, clientY, '<span style="color:#f87171; font-weight:600;">Shift + Click</span> to delete point');
          } else {
            this.showTooltip(clientX, clientY, 'Point (min 3 points required)');
          }
        }
      }
    });

    this.map.on('mouseleave', 'draw-handles-hit', () => {
      if (this.hoveredHandleId !== null) {
        this.map.setFeatureState(
          { source: 'draw-handles-source', id: this.hoveredHandleId },
          { hover: false, deleteHover: false }
        );
        this.hoveredHandleId = null;
        this.hoveredVertexIndex = null;
      }
      if (!this.isDrawingActive && !this.isResizing) {
        this.map.getCanvas().style.cursor = '';
        this.hideTooltip();
      }
    });

    this.map.on('mousedown', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (!e.features || e.features.length === 0) return;

      const feat = e.features[0];
      const isShift = (e.originalEvent && e.originalEvent.shiftKey) || this.isShiftHeld;

      if (isShift && this.shapeType === 'polygon' && this.currentPolygon) {
        this.deletePolygonVertex(feat.properties.vertexIndex);
        return;
      }

      this.startVertexDrag(feat.properties.vertexIndex, feat.properties.cornerId, feat.properties.cursor);
    });

    this.map.on('touchstart', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive) return;
      if (e.points && e.points.length !== 1) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (!e.features || e.features.length === 0) return;

      const feat = e.features[0];
      const isShift = (e.originalEvent && e.originalEvent.shiftKey) || this.isShiftHeld;

      if (isShift && this.shapeType === 'polygon' && this.currentPolygon) {
        this.deletePolygonVertex(feat.properties.vertexIndex);
        return;
      }

      this.startVertexDrag(feat.properties.vertexIndex, feat.properties.cornerId, feat.properties.cursor);
    });

    // 7. Interactive Midpoint Handle & Stroke Events for adding vertices
    this.map.on('mouseenter', 'draw-midpoint-hit', (e) => {
      if (this.isDrawingActive || this.isDragging || this.isResizing) return;
      this.map.getCanvas().style.cursor = 'pointer';
      const clientX = e.originalEvent ? e.originalEvent.clientX : 0;
      const clientY = e.originalEvent ? e.originalEvent.clientY : 0;
      this.showTooltip(clientX, clientY, '<span style="color:#38bdf8; font-weight:600;">Click & drag</span> to add point');
    });

    this.map.on('mouseleave', 'draw-midpoint-hit', () => {
      if (!this.isDrawingActive && !this.isResizing) {
        this.map.getCanvas().style.cursor = '';
        this.hideTooltip();
      }
    });

    this.map.on('mousedown', 'draw-midpoint-hit', (e) => {
      if (this.isDrawingActive || this.isResizing) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (this.activeMidpoint) {
        this.insertVertexAndStartDrag(this.activeMidpoint.segmentIndex, this.activeMidpoint.coordinates);
      } else if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.insertVertexAndStartDrag(feat.properties.segmentIndex, feat.geometry.coordinates);
      }
    });

    this.map.on('touchstart', 'draw-midpoint-hit', (e) => {
      if (this.isDrawingActive || this.isResizing) return;
      if (e.points && e.points.length !== 1) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();
      if (this.activeMidpoint) {
        this.insertVertexAndStartDrag(this.activeMidpoint.segmentIndex, this.activeMidpoint.coordinates);
      } else if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.insertVertexAndStartDrag(feat.properties.segmentIndex, feat.geometry.coordinates);
      }
    });

    this.map.on('mousedown', 'draw-box-stroke-hit', (e) => {
      if (this.isDrawingActive || this.isResizing) return;
      if (this.shapeType !== 'polygon' || !this.currentPolygon) return;
      if (typeof e.preventDefault === 'function') e.preventDefault();

      const segData = this.findClosestSegment(e.point);
      if (segData && segData.distancePx <= 22) {
        this.insertVertexAndStartDrag(segData.segmentIndex, segData.midpoint);
      }
    });
  }

  updateDrawingPreview(curLngLat, screenPoint = null, clientX = null, clientY = null) {
    if (!curLngLat) return;
    const currentCoord = [curLngLat.lng, curLngLat.lat];

    if (this.points.length === 0) {
      if (clientX !== null && clientY !== null) {
        this.showTooltip(clientX, clientY, 'Click map to place 1st point • Esc to cancel');
      }
      return;
    }

    // Check snap to start point (Point 1)
    if (this.points.length >= 3) {
      const startScreen = this.map.project(this.points[0]);
      const curScreen = screenPoint || this.map.project(currentCoord);
      const dist = Math.hypot(curScreen.x - startScreen.x, curScreen.y - startScreen.y);
      this.isSnapToStart = dist < 28 || this.isShiftHeld;
    } else {
      this.isSnapToStart = false;
    }

    const previewCoord = this.isSnapToStart ? this.points[0] : currentCoord;

    // Render in-progress lines & polygon fill
    const lineCoords = [...this.points, previewCoord];
    const features = [
      {
        type: 'Feature',
        id: 1,
        properties: { type: 'stroke' },
        geometry: {
          type: 'LineString',
          coordinates: lineCoords
        }
      }
    ];

    if (this.points.length >= 2) {
      const polyCoords = [...this.points, previewCoord, this.points[0]];
      features.unshift({
        type: 'Feature',
        id: 2,
        properties: { type: 'fill' },
        geometry: {
          type: 'Polygon',
          coordinates: [polyCoords]
        }
      });
    }

    const boxSource = this.map.getSource('draw-box-source');
    if (boxSource) {
      boxSource.setData({
        type: 'FeatureCollection',
        features
      });
    }

    // Render handle dots at placed points, highlighting start point
    const handleSource = this.map.getSource('draw-handles-source');
    if (handleSource) {
      const handleFeatures = this.points.map((pt, idx) => ({
        type: 'Feature',
        id: idx + 1,
        properties: {
          vertexIndex: idx,
          isStart: idx === 0,
          cursor: 'pointer'
        },
        geometry: {
          type: 'Point',
          coordinates: pt
        }
      }));

      handleSource.setData({
        type: 'FeatureCollection',
        features: handleFeatures
      });

      // Highlight snapped start point
      this.map.setFeatureState(
        { source: 'draw-handles-source', id: 1 },
        { snapped: this.isSnapToStart }
      );
    }

    // Update floating tooltip
    if (clientX !== null && clientY !== null) {
      if (this.isSnapToStart) {
        this.showTooltip(
          clientX,
          clientY,
          `<span style="color:#38bdf8; font-weight:600;">⚡ Snap to Start</span> · Click to close shape (or Enter)`
        );
      } else {
        const tempPoly = [...this.points, previewCoord];
        const dims = computePolygonDimensions(tempPoly);
        const areaStr = dims.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 });
        const isClamped = dims.areaM2 > MAX_PATCH_AREA_M2;
        let hint;
        if (this.points.length < 3) {
          hint = `Click to place point ${this.points.length + 1} (min 3) • Esc to cancel`;
        } else {
          hint = `<strong>${this.points.length} points</strong> · ${areaStr} m² · Hold Shift or click #1 to close · Enter to finish`;
        }
        this.showTooltip(clientX, clientY, hint, isClamped);
      }
    }
  }

  finalizePolygon(points) {
    if (!points || points.length < 3) return;

    let finalPoints = [...points];
    // Ensure closed
    if (
      finalPoints[0][0] !== finalPoints[finalPoints.length - 1][0] ||
      finalPoints[0][1] !== finalPoints[finalPoints.length - 1][1]
    ) {
      finalPoints.push([finalPoints[0][0], finalPoints[0][1]]);
    }

    let dims = computePolygonDimensions(finalPoints);
    let isClamped = false;
    if (dims.areaM2 > MAX_PATCH_AREA_M2) {
      const clamped = clampPolygonToMaxArea(finalPoints, MAX_PATCH_AREA_M2);
      finalPoints = clamped.coordinates;
      dims = computePolygonDimensions(finalPoints);
      isClamped = true;
    }

    this.currentPolygon = finalPoints;
    this.currentBbox = dims.bbox;

    this.renderFinalShape(finalPoints, isClamped);
    this.updateHandles(finalPoints, isClamped);
    this.stopDrawing();
    this.notifyState();

    this.onSelectionComplete({
      bbox: dims.bbox,
      polygon: finalPoints,
      dimensions: dims
    });
  }

  getUniqueVertexCount() {
    if (!this.currentPolygon || !Array.isArray(this.currentPolygon)) return 0;
    const n = this.currentPolygon.length;
    if (
      n > 3 &&
      this.currentPolygon[0][0] === this.currentPolygon[n - 1][0] &&
      this.currentPolygon[0][1] === this.currentPolygon[n - 1][1]
    ) {
      return n - 1;
    }
    return n;
  }

  deletePolygonVertex(index) {
    if (!this.currentPolygon || this.shapeType !== 'polygon') return;

    let pts = openPolygonRing(this.currentPolygon);

    if (pts.length <= 3) {
      if (this.lastMousePoint) {
        this.showTooltip(
          this.lastMousePoint.x,
          this.lastMousePoint.y,
          '<span style="color:#f87171;">Cannot delete point: oblong shape requires at least 3 points</span>'
        );
        setTimeout(() => this.hideTooltip(), 1800);
      }
      return;
    }

    if (index < 0 || index >= pts.length) return;

    // Delete vertex and close ring connecting adjacent points
    pts.splice(index, 1);
    const closedPts = [...pts, [pts[0][0], pts[0][1]]];

    let dims = computePolygonDimensions(closedPts);
    let isClamped = dims.areaM2 > MAX_PATCH_AREA_M2;
    let finalPts = closedPts;
    if (isClamped) {
      const clamped = clampPolygonToMaxArea(closedPts, MAX_PATCH_AREA_M2);
      finalPts = clamped.coordinates;
      dims = computePolygonDimensions(finalPts);
    }

    this.currentPolygon = finalPts;
    this.currentBbox = dims.bbox;

    this.clearMidpoint();
    this.renderFinalShape(finalPts, isClamped);
    this.updateHandles(finalPts, isClamped);
    this.hideTooltip();
    this.notifyState();

    this.onSelectionComplete({
      bbox: dims.bbox,
      polygon: finalPts,
      dimensions: dims,
      shapeType: 'polygon',
      isPolygon: true
    });
  }

  insertVertexAndStartDrag(segmentIndex, initialCoords) {
    if (this.shapeType !== 'polygon' || !this.currentPolygon) return;

    let pts = openPolygonRing(this.currentPolygon);

    if (segmentIndex < 0 || segmentIndex >= pts.length) return;

    const newIdx = segmentIndex + 1;
    pts.splice(newIdx, 0, [initialCoords[0], initialCoords[1]]);

    const closedPts = [...pts, [pts[0][0], pts[0][1]]];
    this.currentPolygon = closedPts;

    this.clearMidpoint();
    this.renderFinalShape(closedPts, false);
    this.updateHandles(closedPts, false);

    // Immediately start dragging this new vertex
    this.startVertexDrag(newIdx, null, 'grabbing');
  }

  findClosestSegment(screenPoint) {
    if (!this.currentPolygon || this.currentPolygon.length < 3 || !screenPoint) return null;

    let pts = openPolygonRing(this.currentPolygon);

    const n = pts.length;
    let minDistance = Infinity;
    let bestSegmentIndex = -1;
    let bestMidpoint = null;

    for (let i = 0; i < n; i++) {
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];

      const s1 = this.map.project(p1);
      const s2 = this.map.project(p2);

      const dx = s2.x - s1.x;
      const dy = s2.y - s1.y;
      const lenSq = dx * dx + dy * dy;

      if (lenSq < 1e-4) continue;

      const t = Math.max(0, Math.min(1, ((screenPoint.x - s1.x) * dx + (screenPoint.y - s1.y) * dy) / lenSq));
      const projX = s1.x + t * dx;
      const projY = s1.y + t * dy;

      const dist = Math.hypot(screenPoint.x - projX, screenPoint.y - projY);
      if (dist < minDistance) {
        minDistance = dist;
        bestSegmentIndex = i;
        bestMidpoint = [
          (p1[0] + p2[0]) / 2.0,
          (p1[1] + p2[1]) / 2.0
        ];
      }
    }

    if (bestSegmentIndex >= 0) {
      return {
        segmentIndex: bestSegmentIndex,
        distancePx: minDistance,
        midpoint: bestMidpoint
      };
    }
    return null;
  }

  showMidpoint(segmentIndex, midpointCoords) {
    const source = this.map.getSource('draw-midpoint-source');
    if (!source) return;

    this.activeMidpoint = { segmentIndex, coordinates: midpointCoords };
    source.setData({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 1,
          properties: {
            segmentIndex,
            isMidpoint: true
          },
          geometry: {
            type: 'Point',
            coordinates: midpointCoords
          }
        }
      ]
    });
  }

  clearMidpoint() {
    this.activeMidpoint = null;
    const source = this.map.getSource('draw-midpoint-source');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
  }

  startVertexDrag(vertexIndex, cornerId, cursor) {
    this.isResizing = true;
    this.activeVertexIndex = vertexIndex;
    this.activeCornerId = cornerId;
    this.map.dragPan.disable();
    this.map.getCanvas().style.cursor = cursor || 'grab';

    const onMove = (e) => {
      if (!this.isResizing) return;
      this.onVertexDrag(e.lngLat);
    };

    const onUp = () => {
      this.map.off('mousemove', onMove);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onUp);

      if (this.isResizing) {
        this.isResizing = false;
        this.activeVertexIndex = null;
        this.activeCornerId = null;
        this.map.dragPan.enable();
        this.map.getCanvas().style.cursor = '';
        this.onVertexDragEnd();
      }
    };

    const onWindowMove = (e) => {
      if (!this.isResizing) return;
      const rect = this.map.getCanvas().getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        const pt = [e.clientX - rect.left, e.clientY - rect.top];
        const lngLat = this.map.unproject(pt);
        this.onVertexDrag(lngLat);
      }
    };

    this.map.on('mousemove', onMove);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onUp);
  }

  onVertexDrag(newLngLat) {
    if (this.shapeType === 'rectangle' && this.currentPolygon && this.currentPolygon.length >= 4) {
      const idx = this.activeVertexIndex;
      if (idx !== null && idx !== undefined && idx >= 0 && idx < 4) {
        // Diagonally opposite corner is the fixed anchor: (idx + 2) % 4
        const anchorPt = this.currentPolygon[(idx + 2) % 4];
        const anchorLngLat = { lng: anchorPt[0], lat: anchorPt[1] };
        const curScreen = this.map.project(newLngLat);
        const rectData = this.computeScreenRectangle(anchorLngLat, curScreen);
        if (rectData) {
          this.currentPolygon = rectData.coordinates;
          this.currentBbox = rectData.bbox;
          this.renderFinalShape(rectData.coordinates, rectData.isClamped);
          this.updateHandles(rectData.coordinates, rectData.isClamped);

          const msg = `Resize: ${rectData.widthM.toFixed(0)}m × ${rectData.heightM.toFixed(0)}m · ${rectData.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${rectData.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
          this.showTooltip(curScreen.x, curScreen.y, msg, rectData.isClamped);
          return;
        }
      }
    }

    const newCoord = [newLngLat.lng, newLngLat.lat];

    if (this.currentPolygon) {
      const idx = this.activeVertexIndex;
      if (idx === null || idx === undefined || idx < 0 || idx >= this.currentPolygon.length) return;

      const pts = [...this.currentPolygon];
      pts[idx] = newCoord;
      // If start or end point moved, keep closed ring synchronized
      if (idx === 0) pts[pts.length - 1] = newCoord;
      if (idx === pts.length - 1) pts[0] = newCoord;

      let dims = computePolygonDimensions(pts);
      let isClamped = dims.areaM2 > MAX_PATCH_AREA_M2;
      let finalPts = pts;
      if (isClamped) {
        const clamped = clampPolygonToMaxArea(pts, MAX_PATCH_AREA_M2);
        finalPts = clamped.coordinates;
        dims = computePolygonDimensions(finalPts);
      }

      this.currentPolygon = finalPts;
      this.currentBbox = dims.bbox;

      this.renderFinalShape(finalPts, isClamped);
      this.updateHandles(finalPts, isClamped);

      const msg = `Reshape: ${dims.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${isClamped ? ' (Max 100,000 m² reached)' : ''}`;
      const screenPos = this.map.project(newLngLat);
      this.showTooltip(screenPos.x, screenPos.y, msg, isClamped);
      return;
    }

    if (this.currentBbox) {
      // Legacy rectangle corner drag
      const cornerId = this.activeCornerId;
      const minLon = Math.min(this.currentBbox[0], this.currentBbox[2]);
      const maxLon = Math.max(this.currentBbox[0], this.currentBbox[2]);
      const minLat = Math.min(this.currentBbox[1], this.currentBbox[3]);
      const maxLat = Math.max(this.currentBbox[1], this.currentBbox[3]);

      let anchorLng = (cornerId === 'nw' || cornerId === 'sw') ? maxLon : minLon;
      let anchorLat = (cornerId === 'nw' || cornerId === 'ne') ? minLat : maxLat;

      const clamped = clampBboxToMaxArea(anchorLng, anchorLat, newLngLat.lng, newLngLat.lat, MAX_PATCH_AREA_M2);
      const newBbox = [
        Math.min(anchorLng, clamped.curLon),
        Math.min(anchorLat, clamped.curLat),
        Math.max(anchorLng, clamped.curLon),
        Math.max(anchorLat, clamped.curLat)
      ];

      this.currentBbox = newBbox;
      this.renderFinalBbox(newBbox, clamped.isClamped);
      this.updateHandles(newBbox, clamped.isClamped);

      const dims = computeBboxDimensions(...newBbox);
      const msg = `Resize: ${dims.widthM.toFixed(0)}m × ${dims.heightM.toFixed(0)}m · ${dims.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${clamped.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
      const screenPos = this.map.project(newLngLat);
      this.showTooltip(screenPos.x, screenPos.y, msg, clamped.isClamped);
    }
  }

  onVertexDragEnd() {
    this.isResizing = false;
    this.activeVertexIndex = null;
    this.activeCornerId = null;
    this.hideTooltip();
    if (this.currentPolygon) {
      const dims = computePolygonDimensions(this.currentPolygon);
      this.notifyState();
      this.onSelectionComplete({
        bbox: dims.bbox,
        polygon: this.currentPolygon,
        dimensions: dims,
        shapeType: this.shapeType,
        isRectangle: this.shapeType === 'rectangle'
      });
      return;
    }

    if (this.currentBbox) {
      const dims = computeBboxDimensions(...this.currentBbox);
      this.notifyState();
      this.onSelectionComplete({
        bbox: this.currentBbox,
        polygon: null,
        dimensions: dims,
        shapeType: 'rectangle',
        isRectangle: true
      });
    }
  }

  renderFinalShape(coordinates, isClamped = false) {
    const source = this.map.getSource('draw-box-source');
    if (!source) return;

    const feature = polygonToGeoJSON(coordinates);
    feature.id = 1;

    source.setData({
      type: 'FeatureCollection',
      features: [feature]
    });

    this.map.setFeatureState(
      { source: 'draw-box-source', id: 1 },
      { clamped: isClamped }
    );
  }

  renderFinalBbox(bbox, isClamped = false) {
    const source = this.map.getSource('draw-box-source');
    if (!source) return;

    const feature = bboxToGeoJSON(...bbox);
    feature.id = 1;

    source.setData({
      type: 'FeatureCollection',
      features: [feature]
    });

    this.map.setFeatureState(
      { source: 'draw-box-source', id: 1 },
      { clamped: isClamped }
    );
  }

  updateBox(bbox, isClamped = false) {
    this.renderFinalBbox(bbox, isClamped);
  }

  setBox(bbox) {
    let targetBbox = bbox;
    let dims = computeBboxDimensions(...bbox);
    if (dims.areaM2 > MAX_PATCH_AREA_M2) {
      const [w, s, e, n] = bbox;
      const clamped = clampBboxToMaxArea(w, s, e, n, MAX_PATCH_AREA_M2);
      targetBbox = [w, s, clamped.curLon, clamped.curLat];
      dims = computeBboxDimensions(...targetBbox);
    }
    this.currentBbox = targetBbox;
    this.isClamped = targetBbox !== bbox;
    this.shapeType = 'rectangle';
    const [w, s, e, n] = targetBbox;
    this.currentPolygon = [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
      [w, n]
    ];
    this.renderFinalShape(this.currentPolygon, false);
    this.createHandles();
    this.notifyState();
    this.onSelectionComplete({
      bbox: targetBbox,
      polygon: this.currentPolygon,
      dimensions: dims,
      shapeType: 'rectangle',
      isRectangle: true
    });
  }

  setPolygon(points, shapeType = null) {
    if (!points || points.length < 3) return;

    let finalPoints = [...points];
    if (
      finalPoints[0][0] !== finalPoints[finalPoints.length - 1][0] ||
      finalPoints[0][1] !== finalPoints[finalPoints.length - 1][1]
    ) {
      finalPoints.push([finalPoints[0][0], finalPoints[0][1]]);
    }

    let dims = computePolygonDimensions(finalPoints);
    let isClamped = false;
    if (dims.areaM2 > MAX_PATCH_AREA_M2) {
      const clamped = clampPolygonToMaxArea(finalPoints, MAX_PATCH_AREA_M2);
      finalPoints = clamped.coordinates;
      dims = computePolygonDimensions(finalPoints);
      isClamped = true;
    }

    this.shapeType = shapeType || (finalPoints.length === 5 ? 'rectangle' : 'polygon');
    this.currentPolygon = finalPoints;
    this.currentBbox = dims.bbox;
    this.isClamped = isClamped;

    this.renderFinalShape(finalPoints, isClamped);
    this.createHandles();
    this.notifyState();

    this.onSelectionComplete({
      bbox: dims.bbox,
      polygon: finalPoints,
      dimensions: dims,
      shapeType: this.shapeType,
      isRectangle: this.shapeType === 'rectangle'
    });
  }

  setSelection({ bbox, polygon, contextBbox = null, shapeType = null }) {
    if (polygon && Array.isArray(polygon) && polygon.length >= 3) {
      this.setPolygon(polygon, shapeType);
    } else if (bbox && Array.isArray(bbox) && bbox.length === 4) {
      this.setBox(bbox);
    } else {
      this.clearSelection();
      return;
    }

    if (contextBbox && Array.isArray(contextBbox) && contextBbox.length === 4) {
      this.setContextBox(contextBbox);
    } else {
      this.clearContext();
    }
  }

  setContextBox(bbox) {
    if (!bbox || bbox.length !== 4) return;
    let [minLon, minLat, maxLon, maxLat] = bbox;

    // Enclosure invariant: ensure context_bbox fully encloses the inner solar boundary
    const innerBbox = this.currentBbox || (this.currentPolygon ? computePolygonDimensions(this.currentPolygon).bbox : null);
    if (innerBbox) {
      minLon = Math.min(minLon, innerBbox[0]);
      minLat = Math.min(minLat, innerBbox[1]);
      maxLon = Math.max(maxLon, innerBbox[2]);
      maxLat = Math.max(maxLat, innerBbox[3]);
    }

    // Area clamping: clamp context envelope to MAX_PATCH_AREA_M2
    const dims = computeBboxDimensions(minLon, minLat, maxLon, maxLat);
    if (dims.areaM2 > MAX_PATCH_AREA_M2) {
      const clamped = clampBboxToMaxArea(minLon, minLat, maxLon, maxLat, MAX_PATCH_AREA_M2);
      maxLon = clamped.curLon;
      maxLat = clamped.curLat;
    }

    this.currentContextBbox = [minLon, minLat, maxLon, maxLat];
    const [w, s, e, n] = this.currentContextBbox;
    this.currentContextPolygon = [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
      [w, n]
    ];

    this.renderContextShape();
    this.notifyState();
    this.notifySelection();
  }

  clearContext() {
    this.currentContextBbox = null;
    this.currentContextPolygon = null;
    this.isEditingContext = false;
    const ctxSource = this.map.getSource('draw-context-source');
    if (ctxSource) {
      ctxSource.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    this.notifyState();
    this.notifySelection();
  }

  addDefaultContext(marginMeters = 50.0) {
    const innerBbox = this.currentBbox || (this.currentPolygon ? computePolygonDimensions(this.currentPolygon).bbox : null);
    if (!innerBbox) return;

    const [w, s, e, n] = innerBbox;
    const midLat = (s + n) / 2.0;
    const deltaLat = marginMeters / 111320.0;
    const mPerDegLon = 111320.0 * Math.cos(midLat * Math.PI / 180.0);
    const deltaLon = marginMeters / Math.max(1.0, mPerDegLon);

    this.setContextBox([
      w - deltaLon,
      s - deltaLat,
      e + deltaLon,
      n + deltaLat
    ]);
  }

  renderContextShape() {
    const source = this.map.getSource('draw-context-source');
    if (!source || !this.currentContextPolygon) return;

    const feature = polygonToGeoJSON(this.currentContextPolygon);
    feature.id = 2;
    source.setData({
      type: 'FeatureCollection',
      features: [feature]
    });
  }

  notifySelection() {
    const dims = this.currentPolygon
      ? computePolygonDimensions(this.currentPolygon)
      : (this.currentBbox ? computeBboxDimensions(...this.currentBbox) : null);

    this.onSelectionComplete({
      bbox: this.currentBbox,
      polygon: this.currentPolygon,
      contextBbox: this.currentContextBbox,
      dimensions: dims,
      shapeType: this.shapeType,
      isRectangle: this.shapeType === 'rectangle',
      isPolygon: this.shapeType === 'polygon'
    });
  }

  clearSelection() {
    this.clearContext();
    this.clearBox();
    this.notifyState();
    this.onSelectionComplete({
      bbox: null,
      polygon: null,
      contextBbox: null,
      dimensions: null,
      shapeType: null
    });
  }

  getSelection() {
    const dims = this.currentPolygon
      ? computePolygonDimensions(this.currentPolygon)
      : (this.currentBbox ? computeBboxDimensions(...this.currentBbox) : null);

    return {
      bbox: this.currentBbox,
      polygon: this.currentPolygon,
      contextBbox: this.currentContextBbox,
      dimensions: dims,
      shapeType: this.shapeType,
      isRectangle: this.shapeType === 'rectangle',
      isPolygon: this.shapeType === 'polygon'
    };
  }

  clearSource() {
    const source = this.map.getSource('draw-box-source');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    this.removeHandles();
  }

  clearBox() {
    this.currentBbox = null;
    this.currentPolygon = null;
    this.shapeType = null;
    this.isClamped = false;
    this.points = [];
    this.clearSource();
    this.clearMidpoint();
    this.hideTooltip();
    this.notifyState();
  }

  createHandles() {
    if (this.currentPolygon) {
      this.updateHandles(this.currentPolygon, false);
    } else if (this.currentBbox) {
      this.updateHandles(this.currentBbox, false);
    }
  }

  removeHandles() {
    const source = this.map.getSource('draw-handles-source');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    this.clearMidpoint();
  }

  updateHandles(target, isClamped = false) {
    const source = this.map.getSource('draw-handles-source');
    if (!source || !target) return;

    // Check if target is polygon coordinates [[lon, lat], ...] or bbox [minLon, minLat, maxLon, maxLat]
    let handleFeatures = [];

    if (Array.isArray(target) && target.length > 0 && Array.isArray(target[0])) {
      // Polygon or screen-aligned rectangle vertices
      const pts = openPolygonRing(target);

      const rectCursors = ['nwse-resize', 'nesw-resize', 'nwse-resize', 'nesw-resize'];

      handleFeatures = pts.map((pt, idx) => ({
        type: 'Feature',
        id: idx + 1,
        properties: {
          id: idx + 1,
          vertexIndex: idx,
          cursor: this.shapeType === 'rectangle' ? rectCursors[idx % 4] : 'grab'
        },
        geometry: {
          type: 'Point',
          coordinates: pt
        }
      }));
    } else if (Array.isArray(target) && target.length === 4) {
      // 4 corners of rectangle
      const minLon = Math.min(target[0], target[2]);
      const maxLon = Math.max(target[0], target[2]);
      const minLat = Math.min(target[1], target[3]);
      const maxLat = Math.max(target[1], target[3]);

      const corners = [
        { id: 1, cornerId: 'nw', vertexIndex: 0, lngLat: [minLon, maxLat], cursor: 'nwse-resize' },
        { id: 2, cornerId: 'ne', vertexIndex: 1, lngLat: [maxLon, maxLat], cursor: 'nesw-resize' },
        { id: 3, cornerId: 'se', vertexIndex: 2, lngLat: [maxLon, minLat], cursor: 'nwse-resize' },
        { id: 4, cornerId: 'sw', vertexIndex: 3, lngLat: [minLon, minLat], cursor: 'nesw-resize' }
      ];

      handleFeatures = corners.map(c => ({
        type: 'Feature',
        id: c.id,
        properties: {
          id: c.id,
          cornerId: c.cornerId,
          vertexIndex: c.vertexIndex,
          cursor: c.cursor
        },
        geometry: {
          type: 'Point',
          coordinates: c.lngLat
        }
      }));
    }

    source.setData({
      type: 'FeatureCollection',
      features: handleFeatures
    });

    handleFeatures.forEach(feat => {
      this.map.setFeatureState(
        { source: 'draw-handles-source', id: feat.id },
        { clamped: isClamped }
      );
    });
  }

  showTooltip(x, y, textOrHtml, isClamped = false) {
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.borderColor = isClamped ? 'var(--accent-danger)' : 'var(--border-card)';
    this.tooltip.style.color = isClamped ? '#fca5a5' : 'var(--text-primary)';
    this.tooltip.innerHTML = textOrHtml;
  }

  hideTooltip() {
    this.tooltip.style.display = 'none';
  }
}

export { BoxDrawer as ShapeDrawer };
