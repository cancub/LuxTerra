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
  MAX_PATCH_AREA_M2
} from '../utils/geometry.js';

export class BoxDrawer {
  constructor(map, container, onSelectionComplete) {
    this.map = map;
    this.container = container;
    this.onSelectionComplete = onSelectionComplete || (() => {});

    this.isDrawingActive = false;
    this.isDragging = false;
    this.isResizing = false;
    this.activeVertexIndex = null;
    this.startLngLat = null;
    this.currentBbox = null;
    this.currentPolygon = null;

    // Multi-point polygon drawing state
    this.points = []; // Array of [lon, lat]
    this.isShiftHeld = false;
    this.isSnapToStart = false;
    this.lastMousePoint = null;
    this.lastMouseLngLat = null;

    // Legacy compatibility dictionary
    this.handles = { nw: null, ne: null, se: null, sw: null };

    this.initLayers();
    this.initTooltip();
    this.render();
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
        'line-width': 2,
        'line-dasharray': [2, 2]
      }
    });

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
            ['boolean', ['feature-state', 'snapped'], false],
            '#38bdf8',
            '#ffffff'
          ],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': [
            'case',
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
        this.updateHandles(this.currentPolygon, false);
      } else if (this.currentBbox) {
        this.updateHandles(this.currentBbox, false);
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

  toggleDrawing() {
    this.isDrawingActive = !this.isDrawingActive;
    if (this.isDrawingActive) {
      this.button.classList.add('active', 'btn-accent');
      this.map.getCanvas().style.cursor = 'crosshair';
      this.map.dragPan.disable();
      this.points = [];
      this.isSnapToStart = false;
      this.isDragging = false;
      this.removeHandles();
      this.showTooltip(0, 0, 'Click map to place 1st point • Esc to cancel');
    } else {
      this.button.classList.remove('active', 'btn-accent');
      this.map.getCanvas().style.cursor = '';
      this.map.dragPan.enable();
      this.points = [];
      this.isSnapToStart = false;
      this.isDragging = false;
      this.hideTooltip();
    }
  }

  cancelDrawing() {
    if (this.isDrawingActive) {
      this.toggleDrawing();
      if (this.currentPolygon) {
        this.renderFinalShape(this.currentPolygon, false);
        this.updateHandles(this.currentPolygon, false);
      } else if (this.currentBbox) {
        this.renderFinalBbox(this.currentBbox, false);
        this.updateHandles(this.currentBbox, false);
      } else {
        this.clearSource();
      }
    }
  }

  bindKeyboardEvents() {
    window.addEventListener('keydown', (e) => {
      if (!this.isDrawingActive) return;

      if (e.key === 'Shift') {
        this.isShiftHeld = true;
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
        if (this.isDrawingActive && this.lastMouseLngLat) {
          this.updateDrawingPreview(this.lastMouseLngLat, this.lastMousePoint);
        }
      }
    });
  }

  bindMapEvents() {
    // 1. Mouse down: can start a quick drag-rectangle if held & moved
    this.map.on('mousedown', (e) => {
      if (!this.isDrawingActive) return;
      this.startLngLat = e.lngLat;
      this.startPoint = e.point;
      this.isPotentialDrag = true;
    });

    // 2. Mouse move: updates preview for polygon line or drag-rectangle
    this.map.on('mousemove', (e) => {
      this.lastMousePoint = e.point;
      this.lastMouseLngLat = e.lngLat;

      if (!this.isDrawingActive) return;

      // Check if user is drag-drawing a box
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
        const bbox = [this.startLngLat.lng, this.startLngLat.lat, clamped.curLon, clamped.curLat];
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

    // 3. Click: places vertices or closes polygon
    this.map.on('click', (e) => {
      if (!this.isDrawingActive) return;
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

    // 4. Mouse up: finalizes quick drag-box if in drag mode
    const finalizeMouseUp = () => {
      this.isPotentialDrag = false;
      if (this.isDragging && this.currentBbox) {
        this.isDragging = false;
        this.hideTooltip();
        this.toggleDrawing();
        const dims = computeBboxDimensions(...this.currentBbox);
        if (dims.areaM2 >= 100.0) {
          this.createHandles();
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

    // 5. Double-click: finishes polygon
    this.map.on('dblclick', (e) => {
      if (this.isDrawingActive && this.points.length >= 3) {
        e.preventDefault();
        this.finalizePolygon(this.points);
      }
    });

    // 6. Interactive WebGL Handle Events (zero DOM lag during scroll or zoom)
    let hoveredHandleId = null;

    this.map.on('mouseenter', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive || this.isDragging || this.isResizing) return;
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        hoveredHandleId = feat.id;
        this.map.getCanvas().style.cursor = feat.properties.cursor || 'pointer';
        this.map.setFeatureState(
          { source: 'draw-handles-source', id: hoveredHandleId },
          { hover: true }
        );
      }
    });

    this.map.on('mouseleave', 'draw-handles-hit', () => {
      if (hoveredHandleId !== null) {
        this.map.setFeatureState(
          { source: 'draw-handles-source', id: hoveredHandleId },
          { hover: false }
        );
        hoveredHandleId = null;
      }
      if (!this.isDrawingActive && !this.isResizing) {
        this.map.getCanvas().style.cursor = '';
      }
    });

    this.map.on('mousedown', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive) return;
      e.preventDefault();
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.startVertexDrag(feat.properties.vertexIndex, feat.properties.cornerId, feat.properties.cursor);
      }
    });

    this.map.on('touchstart', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive) return;
      if (e.points && e.points.length !== 1) return;
      e.preventDefault();
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.startVertexDrag(feat.properties.vertexIndex, feat.properties.cornerId, feat.properties.cursor);
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
    this.toggleDrawing();

    this.onSelectionComplete({
      bbox: dims.bbox,
      polygon: finalPoints,
      dimensions: dims
    });
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
    this.hideTooltip();
    if (this.currentPolygon) {
      const dims = computePolygonDimensions(this.currentPolygon);
      this.onSelectionComplete({
        bbox: dims.bbox,
        polygon: this.currentPolygon,
        dimensions: dims
      });
      return;
    }

    if (this.currentBbox) {
      const dims = computeBboxDimensions(...this.currentBbox);
      this.onSelectionComplete({
        bbox: this.currentBbox,
        polygon: null,
        dimensions: dims
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
      targetBbox = clampBboxToMaxArea(bbox, MAX_PATCH_AREA_M2);
      dims = computeBboxDimensions(...targetBbox);
    }
    this.currentBbox = targetBbox;
    this.currentPolygon = null;
    this.renderFinalBbox(targetBbox, false);
    this.createHandles();
    this.onSelectionComplete({
      bbox: targetBbox,
      polygon: null,
      dimensions: dims
    });
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
    this.points = [];
    this.clearSource();
    this.hideTooltip();
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
  }

  updateHandles(target, isClamped = false) {
    const source = this.map.getSource('draw-handles-source');
    if (!source || !target) return;

    // Check if target is polygon coordinates [[lon, lat], ...] or bbox [minLon, minLat, maxLon, maxLat]
    let handleFeatures = [];

    if (Array.isArray(target) && target.length > 0 && Array.isArray(target[0])) {
      // Polygon vertices
      const pts = [...target];
      if (
        pts.length > 3 &&
        pts[0][0] === pts[pts.length - 1][0] &&
        pts[0][1] === pts[pts.length - 1][1]
      ) {
        pts.pop(); // Don't duplicate start/end vertex handle
      }

      handleFeatures = pts.map((pt, idx) => ({
        type: 'Feature',
        id: idx + 1,
        properties: {
          id: idx + 1,
          vertexIndex: idx,
          cursor: 'grab'
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
