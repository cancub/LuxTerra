/**
 * BoxDrawer Component
 * Interactive rectangle drawing tool clamped to <= 100,000 m² with real-time dimension readout.
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
    this.startLngLat = null;
    this.currentBbox = null;

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
          this.onSelectionComplete({
            bbox: this.currentBbox,
            dimensions: dims
          });
        }
      }
    };

    this.map.on('mouseup', finalizeDraw);
    window.addEventListener('mouseup', finalizeDraw);
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
    this.currentBbox = bbox;
    const dims = computeBboxDimensions(...bbox);
    this.updateBox(bbox, dims.areaM2 > MAX_PATCH_AREA_M2);
    this.onSelectionComplete({
      bbox: bbox,
      dimensions: dims
    });
  }

  clearBox() {
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
