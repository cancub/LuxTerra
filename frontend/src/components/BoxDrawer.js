/**
 * BoxDrawer Component
 * Interactive rectangle drawing and resizing tool clamped to <= 100,000 m²
 * with interactive corner handle points for resizing.
 */

import {
  clampBboxToMaxArea,
  computeBboxDimensions,
  bboxToGeoJSON,
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
    this.activeCornerId = null;
    this.startLngLat = null;
    this.currentBbox = null;
    this.handles = { nw: null, ne: null, se: null, sw: null };

    this.initLayers();
    this.initTooltip();
    this.render();
    this.bindMapEvents();
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
            ['boolean', ['feature-state', 'hover'], false],
            12,
            9
          ],
          'circle-color': [
            'case',
            ['boolean', ['feature-state', 'clamped'], false],
            'rgba(239, 68, 68, 0.5)',
            'rgba(56, 189, 248, 0.45)'
          ],
          'circle-blur': 0.4
        }
      });

      this.map.addLayer({
        id: 'draw-handles-core',
        type: 'circle',
        source: 'draw-handles-source',
        paint: {
          'circle-radius': [
            'case',
            ['boolean', ['feature-state', 'hover'], false],
            7.5,
            6
          ],
          'circle-color': '#ffffff',
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
          'circle-radius': 14,
          'circle-color': '#000000',
          'circle-opacity': 0.001
        }
      });

      if (this.currentBbox) {
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
    this.tooltip.style.padding = '6px 10px';
    this.tooltip.style.fontSize = '0.78rem';
    this.tooltip.style.zIndex = '1000';
    this.tooltip.style.transform = 'translate(14px, 14px)';
    this.tooltip.style.fontFamily = 'var(--font-mono)';
    this.tooltip.style.whiteSpace = 'nowrap';
    document.body.appendChild(this.tooltip);
  }

  render() {
    this.button = document.createElement('button');
    this.button.className = 'btn btn-sm btn-draw';
    this.button.title = 'Select Solar Area (<= 100,000 m²)';
    this.button.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
        <line x1="9" y1="3" x2="9" y2="21"></line>
        <line x1="15" y1="3" x2="15" y2="21"></line>
        <line x1="3" y1="9" x2="21" y2="9"></line>
        <line x1="3" y1="15" x2="21" y2="15"></line>
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
    } else {
      this.button.classList.remove('active', 'btn-accent');
      this.map.getCanvas().style.cursor = '';
      this.map.dragPan.enable();
      this.hideTooltip();
    }
  }

  bindMapEvents() {
    this.map.on('mousedown', (e) => {
      if (!this.isDrawingActive) return;
      this.removeHandles();
      this.isDragging = true;
      this.startLngLat = e.lngLat;
      this.updateBox([e.lngLat.lng, e.lngLat.lat, e.lngLat.lng, e.lngLat.lat], false);
      this.showTooltip(e.point.x, e.point.y, 'Drag to select area...');
    });

    this.map.on('mousemove', (e) => {
      if (!this.isDrawingActive || !this.isDragging || !this.startLngLat) return;

      const clamped = clampBboxToMaxArea(
        this.startLngLat.lng,
        this.startLngLat.lat,
        e.lngLat.lng,
        e.lngLat.lat,
        MAX_PATCH_AREA_M2
      );

      const bbox = [
        this.startLngLat.lng,
        this.startLngLat.lat,
        clamped.curLon,
        clamped.curLat
      ];

      this.currentBbox = bbox;
      this.updateBox(bbox, clamped.isClamped);

      const msg = `${clamped.widthM.toFixed(0)}m × ${clamped.heightM.toFixed(0)}m · ${clamped.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${clamped.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
      this.showTooltip(e.originalEvent.clientX, e.originalEvent.clientY, msg, clamped.isClamped);
    });

    const finalizeDraw = () => {
      if (!this.isDrawingActive || !this.isDragging) return;
      this.isDragging = false;
      this.hideTooltip();
      this.toggleDrawing(); // deactivate draw mode on release

      if (this.currentBbox) {
        const dims = computeBboxDimensions(...this.currentBbox);
        if (dims.areaM2 >= 100.0) { // ignore accidental single clicks
          this.createHandles();
          this.onSelectionComplete({
            bbox: this.currentBbox,
            dimensions: dims
          });
        }
      }
    };

    this.map.on('mouseup', finalizeDraw);
    window.addEventListener('mouseup', finalizeDraw);

    // Interactive WebGL Handle Events (zero DOM lag during scroll or zoom)
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
      if (this.isDrawingActive || !this.currentBbox) return;
      e.preventDefault();
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.startResize(feat.properties.cornerId, feat.properties.cursor);
      }
    });

    this.map.on('touchstart', 'draw-handles-hit', (e) => {
      if (this.isDrawingActive || !this.currentBbox) return;
      if (e.points && e.points.length !== 1) return;
      e.preventDefault();
      if (e.features && e.features.length > 0) {
        const feat = e.features[0];
        this.startResize(feat.properties.cornerId, feat.properties.cursor);
      }
    });
  }

  startResize(cornerId, cursor) {
    this.isResizing = true;
    this.activeCornerId = cornerId;
    this.map.dragPan.disable();
    this.map.getCanvas().style.cursor = cursor || 'nwse-resize';

    const onMove = (e) => {
      if (!this.isResizing || !this.activeCornerId) return;
      this.onHandleDrag(this.activeCornerId, e.lngLat);
    };

    const onTouchMove = (e) => {
      if (!this.isResizing || !this.activeCornerId) return;
      if (e.lngLat) {
        this.onHandleDrag(this.activeCornerId, e.lngLat);
      }
    };

    const onUp = () => {
      this.map.off('mousemove', onMove);
      window.removeEventListener('mousemove', onWindowMove);
      window.removeEventListener('mouseup', onUp);
      this.map.off('touchmove', onTouchMove);
      window.removeEventListener('touchend', onUp);

      if (this.isResizing) {
        this.isResizing = false;
        this.activeCornerId = null;
        this.map.dragPan.enable();
        this.map.getCanvas().style.cursor = '';
        this.onHandleDragEnd();
      }
    };

    const onWindowMove = (e) => {
      if (!this.isResizing || !this.activeCornerId) return;
      const rect = this.map.getCanvas().getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        const pt = [e.clientX - rect.left, e.clientY - rect.top];
        const lngLat = this.map.unproject(pt);
        this.onHandleDrag(this.activeCornerId, lngLat);
      }
    };

    this.map.on('mousemove', onMove);
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onUp);
    this.map.on('touchmove', onTouchMove);
    window.addEventListener('touchend', onUp);
  }

  updateBox(bbox, isClamped = false) {
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

  setBox(bbox) {
    let targetBbox = bbox;
    let dims = computeBboxDimensions(...bbox);
    if (dims.areaM2 > MAX_PATCH_AREA_M2) {
      targetBbox = clampBboxToMaxArea(bbox, MAX_PATCH_AREA_M2);
      dims = computeBboxDimensions(...targetBbox);
    }
    this.currentBbox = targetBbox;
    this.updateBox(targetBbox, false);
    this.createHandles();
    this.onSelectionComplete({
      bbox: targetBbox,
      dimensions: dims
    });
  }

  clearBox() {
    this.removeHandles();
    this.currentBbox = null;
    const source = this.map.getSource('draw-box-source');
    if (source) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
    }
    this.hideTooltip();
  }

  createHandles() {
    this.updateHandles(this.currentBbox, false);
  }

  removeHandles() {
    this.updateHandles(null, false);
  }

  updateHandles(bbox, isClamped = false) {
    const source = this.map.getSource('draw-handles-source');
    if (!source) return;

    if (!bbox) {
      source.setData({
        type: 'FeatureCollection',
        features: []
      });
      return;
    }

    const minLon = Math.min(bbox[0], bbox[2]);
    const maxLon = Math.max(bbox[0], bbox[2]);
    const minLat = Math.min(bbox[1], bbox[3]);
    const maxLat = Math.max(bbox[1], bbox[3]);

    const corners = [
      { id: 1, cornerId: 'nw', lngLat: [minLon, maxLat], cursor: 'nwse-resize' },
      { id: 2, cornerId: 'ne', lngLat: [maxLon, maxLat], cursor: 'nesw-resize' },
      { id: 3, cornerId: 'se', lngLat: [maxLon, minLat], cursor: 'nwse-resize' },
      { id: 4, cornerId: 'sw', lngLat: [minLon, minLat], cursor: 'nesw-resize' }
    ];

    const features = corners.map(c => ({
      type: 'Feature',
      id: c.id,
      properties: {
        id: c.id,
        cornerId: c.cornerId,
        cursor: c.cursor
      },
      geometry: {
        type: 'Point',
        coordinates: c.lngLat
      }
    }));

    source.setData({
      type: 'FeatureCollection',
      features
    });

    corners.forEach(c => {
      this.map.setFeatureState(
        { source: 'draw-handles-source', id: c.id },
        { clamped: isClamped }
      );
    });
  }

  onHandleDrag(cornerId, newLngLat) {
    if (!this.currentBbox) return;

    const minLon = Math.min(this.currentBbox[0], this.currentBbox[2]);
    const maxLon = Math.max(this.currentBbox[0], this.currentBbox[2]);
    const minLat = Math.min(this.currentBbox[1], this.currentBbox[3]);
    const maxLat = Math.max(this.currentBbox[1], this.currentBbox[3]);

    // Identify opposite anchor corner
    let anchorLng, anchorLat;
    if (cornerId === 'nw') {
      anchorLng = maxLon;
      anchorLat = minLat;
    } else if (cornerId === 'ne') {
      anchorLng = minLon;
      anchorLat = minLat;
    } else if (cornerId === 'se') {
      anchorLng = minLon;
      anchorLat = maxLat;
    } else { // 'sw'
      anchorLng = maxLon;
      anchorLat = maxLat;
    }

    const clamped = clampBboxToMaxArea(
      anchorLng,
      anchorLat,
      newLngLat.lng,
      newLngLat.lat,
      MAX_PATCH_AREA_M2
    );

    const newMinLon = Math.min(anchorLng, clamped.curLon);
    const newMaxLon = Math.max(anchorLng, clamped.curLon);
    const newMinLat = Math.min(anchorLat, clamped.curLat);
    const newMaxLat = Math.max(anchorLat, clamped.curLat);
    const newBbox = [newMinLon, newMinLat, newMaxLon, newMaxLat];

    this.currentBbox = newBbox;
    this.updateBox(newBbox, clamped.isClamped);
    this.updateHandles(newBbox, clamped.isClamped);

    const dims = computeBboxDimensions(...newBbox);
    const msg = `Resize: ${dims.widthM.toFixed(0)}m × ${dims.heightM.toFixed(0)}m · ${dims.areaM2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²${clamped.isClamped ? ' (Max 100,000 m² reached)' : ''}`;
    const screenPos = this.map.project([newLngLat.lng, newLngLat.lat]);
    this.showTooltip(screenPos.x, screenPos.y, msg, clamped.isClamped);
  }

  onHandleDragEnd() {
    this.hideTooltip();
    if (!this.currentBbox) return;

    this.updateHandles(this.currentBbox, false);

    const dims = computeBboxDimensions(...this.currentBbox);
    if (dims.areaM2 >= 100.0) {
      this.onSelectionComplete({
        bbox: this.currentBbox,
        dimensions: dims
      });
    }
  }

  showTooltip(x, y, text, isClamped = false) {
    this.tooltip.style.left = `${x}px`;
    this.tooltip.style.top = `${y}px`;
    this.tooltip.style.display = 'block';
    this.tooltip.style.borderColor = isClamped ? 'var(--accent-danger)' : 'var(--border-card)';
    this.tooltip.style.color = isClamped ? '#fca5a5' : 'var(--text-primary)';
    this.tooltip.textContent = text;
  }

  hideTooltip() {
    this.tooltip.style.display = 'none';
  }
}
