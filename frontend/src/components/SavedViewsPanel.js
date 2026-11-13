/**
 * SavedViewsPanel Component
 * Collapsible glassmorphism right card overlay integrating:
 * 1. Quebec City / Address Search Geocoder
 * 2. Shape Selection Type (Oblong / Polygon vs Rectangle vs Clear)
 * 3. Save View & Shape combos with custom labels to persistent localStorage
 * 4. Interactive list of saved views with one-click Fly & Restore and Delete actions
 */

import { Geocoder } from './Geocoder.js';
import {
  computeBboxDimensions,
  computePolygonDimensions
} from '../utils/geometry.js';

export const STORAGE_KEY = 'luxterra_saved_views';

export function filterLegacyPresets(views) {
  if (!Array.isArray(views)) return [];
  return views.filter(v => v && !v.isPreset && !v.id?.startsWith('preset_'));
}

export class SavedViewsPanel {
  constructor({
    map,
    container,
    boxDrawer,
    dateSelector,
    onRestoreView,
    showToast
  }) {
    this.map = map;
    this.container = container;
    this.boxDrawer = boxDrawer;
    this.dateSelector = dateSelector;
    this.onRestoreView = onRestoreView || (() => {});
    this.showToast = showToast || console.log;

    this.isCollapsed = false;
    this.activeViewId = null;
    this.savedViews = this.loadSavedViews();

    this.render();
    this.initGeocoder();
    this.bindDrawerEvents();
  }

  loadSavedViews() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        const filtered = filterLegacyPresets(parsed);
        if (filtered.length !== parsed.length) {
          this.saveToStorage(filtered);
        }
        return filtered;
      }
    } catch (e) {
      console.warn('Failed to parse saved views from localStorage:', e);
    }
    return [];
  }

  saveToStorage(views) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
    } catch (e) {
      console.warn('Failed to save views to localStorage:', e);
    }
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel saved-views-panel';

    this.element.innerHTML = `
      <!-- Collapsible Card Header -->
      <div class="panel-header" title="Click to collapse / expand">
        <span class="panel-title">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-solar); flex-shrink: 0;">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
          <span>Projects</span>
        </span>
        <div class="panel-header-actions">
          <span class="views-count-badge pill">${this.savedViews.length} saved</span>
          <button class="collapse-btn" title="Collapse / Expand Panel">
            <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
        </div>
      </div>

      <!-- Collapsible Card Body -->
      <div class="panel-body">
        <!-- Section 1: City Locator -->
        <div class="panel-section">
          <div class="geocoder-slot"></div>
        </div>

        <!-- Section 2: Shape Selection Type -->
        <div class="panel-section">
          <div class="shape-type-buttons">
            <button class="btn btn-sm btn-shape-type btn-polygon" title="Free-draw multi-point solar area. Hold Shift or click #1 to close, Enter to finish.">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
              <span>Free-draw</span>
            </button>
            <button class="btn btn-sm btn-shape-type btn-rectangle" title="Click & drag on the map to draw a rectangular solar area.">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              </svg>
              <span>Rectangle</span>
            </button>
            <button class="btn btn-sm btn-context-toggle" title="Add or clear a wider visual context envelope for surrounding shadow visualization" style="display: none;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="2" width="20" height="20" rx="3" ry="3" stroke-dasharray="3 3"></rect>
                <rect x="7" y="7" width="10" height="10" rx="1" ry="1"></rect>
              </svg>
              <span class="context-label">Context</span>
            </button>
            <button class="btn btn-sm btn-shape-clear" title="Clear active shape selection and reset shadows" disabled>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </div>
        </div>

        <!-- Section 3: Save Current View & Shape -->
        <div class="panel-section">
          <div class="save-view-row">
            <input type="text" class="save-view-input" placeholder="New shape name" />
            <button class="btn btn-sm btn-accent save-view-btn" title="Save current camera position & shape combo">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
              </svg>
              <span>Save</span>
            </button>
          </div>
        </div>

        <!-- Section 4: Saved Views List -->
        <div class="panel-section">
          <div class="saved-views-list"></div>
        </div>
      </div>
    `;

    // Query sub-elements
    this.header = this.element.querySelector('.panel-header');
    this.body = this.element.querySelector('.panel-body');
    this.chevron = this.element.querySelector('.chevron-icon');
    this.countBadge = this.element.querySelector('.views-count-badge');
    this.geocoderSlot = this.element.querySelector('.geocoder-slot');

    this.btnPolygon = this.element.querySelector('.btn-polygon');
    this.btnRectangle = this.element.querySelector('.btn-rectangle');
    this.btnContextToggle = this.element.querySelector('.btn-context-toggle');
    this.contextLabel = this.element.querySelector('.context-label');
    this.btnClear = this.element.querySelector('.btn-shape-clear');

    this.saveInput = this.element.querySelector('.save-view-input');
    this.saveBtn = this.element.querySelector('.save-view-btn');
    this.savedListContainer = this.element.querySelector('.saved-views-list');

    // Bind collapse toggle
    this.header.addEventListener('click', () => this.toggleCollapse());

    // Bind shape buttons
    this.btnPolygon.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxDrawer.startDrawing('polygon');
    });

    this.btnRectangle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxDrawer.startDrawing('rectangle');
    });

    this.btnContextToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const selection = this.boxDrawer.getSelection();
      if (selection.contextBbox) {
        this.boxDrawer.clearContext();
        this.showToast('Cleared visual context boundary', 'info');
      } else {
        this.boxDrawer.addDefaultContext(40.0);
        this.showToast('Added surrounding visual context boundary', 'info');
      }
    });

    this.btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxDrawer.clearSelection();
      this.activeViewId = null;
      this.renderSavedList();
    });

    // Bind save combo
    this.saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.saveCurrentCombo();
    });

    this.saveInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        this.saveCurrentCombo();
      }
    });



    this.renderSavedList();
    this.container.appendChild(this.element);
  }

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.body.style.display = 'none';
      this.chevron.style.transform = 'rotate(180deg)';
      this.countBadge.style.display = 'inline-block';
    } else {
      this.body.style.display = 'flex';
      this.chevron.style.transform = 'rotate(0deg)';
      this.countBadge.style.display = 'inline-block';
    }
  }

  initGeocoder() {
    this.geocoder = new Geocoder(this.map, this.geocoderSlot, (loc) => {
      if (loc && loc.name) {
        const shortName = loc.name.split(',')[0].trim();
        this.saveInput.value = shortName;
        this.showToast(`Navigated to ${shortName}`, 'info');
      }
    });
  }

  bindDrawerEvents() {
    if (typeof this.boxDrawer.setStateChangeListener === 'function') {
      this.boxDrawer.setStateChangeListener((state) => {
        this.updateDrawerState(state);
      });
    }
  }

  updateDrawerState(state) {
    if (!state) return;

    // Reset active saved view if user starts drawing a new shape or clears the shape
    if (state.isDrawingActive || !state.hasShape) {
      if (this.activeViewId !== null) {
        this.activeViewId = null;
        this.renderSavedList();
      }
    }

    // 1. Tool button active states
    if (state.isDrawingActive) {
      if (state.drawMode === 'polygon') {
        this.btnPolygon.classList.add('active');
        this.btnRectangle.classList.remove('active');
      } else {
        this.btnRectangle.classList.add('active');
        this.btnPolygon.classList.remove('active');
      }
    } else {
      this.btnPolygon.classList.remove('active');
      this.btnRectangle.classList.remove('active');
    }

    // 2. Context toggle button visibility & state
    if (state.hasShape && state.dimensions) {
      this.btnContextToggle.style.display = 'flex';
      if (state.hasContext) {
        this.btnContextToggle.classList.add('active', 'btn-accent');
        this.contextLabel.textContent = 'Context ✓';
      } else {
        this.btnContextToggle.classList.remove('active', 'btn-accent');
        this.contextLabel.textContent = '+ Context';
      }
    } else {
      this.btnContextToggle.style.display = 'none';
    }

    // 3. Clear button
    if (state.hasShape && state.dimensions) {
      this.btnClear.disabled = false;
      this.btnClear.style.opacity = '1';
    } else {
      this.btnClear.disabled = true;
      this.btnClear.style.opacity = '0.35';
    }
  }

  saveCurrentCombo() {
    const rawName = this.saveInput.value.trim();
    const center = this.map.getCenter();
    const zoom = this.map.getZoom();
    const pitch = this.map.getPitch();
    const bearing = this.map.getBearing();

    const selection = this.boxDrawer.getSelection();
    let detail = '📷 Camera View';

    if ((selection.polygon || selection.bbox) && selection.dimensions) {
      const area = Math.round(selection.dimensions.areaM2).toLocaleString('en-US');
      detail = `${area} m²`;
    }

    const defaultName = selection.bbox
      ? `Area at ${center.lat.toFixed(3)}°N, ${Math.abs(center.lng).toFixed(3)}°W`
      : `View at ${center.lat.toFixed(3)}°N, ${Math.abs(center.lng).toFixed(3)}°W`;

    const name = rawName || defaultName;
    const date = this.dateSelector ? this.dateSelector.getDate() : '2026-06-21';

    const newView = {
      id: `view_${Date.now()}`,
      name: name,
      detail: detail,
      center: [Number(center.lng.toFixed(5)), Number(center.lat.toFixed(5))],
      zoom: Number(zoom.toFixed(2)),
      pitch: Math.round(pitch),
      bearing: Math.round(bearing),
      bbox: selection.bbox ? selection.bbox.map(n => Number(n.toFixed(5))) : null,
      polygon: selection.polygon ? selection.polygon.map(pt => [Number(pt[0].toFixed(5)), Number(pt[1].toFixed(5))]) : null,
      contextBbox: selection.contextBbox ? selection.contextBbox.map(n => Number(n.toFixed(5))) : null,
      shapeType: (selection.polygon || selection.bbox) ? 'polygon' : null,
      date: date,
      createdAt: new Date().toISOString()
    };

    this.savedViews.unshift(newView);
    this.saveToStorage(this.savedViews);
    this.activeViewId = newView.id;
    this.saveInput.value = '';

    this.renderSavedList();
    this.showToast(`Saved view & shape combo "${name}"!`, 'info');
  }

  renderSavedList() {
    this.savedListContainer.innerHTML = '';
    this.countBadge.textContent = `${this.savedViews.length} saved`;

    if (this.savedViews.length === 0) {
      this.savedListContainer.innerHTML = `
        <div style="padding: 10px 8px; font-size: 0.74rem; color: var(--text-muted); text-align: center; border: 1px dashed var(--border-card); border-radius: 6px;">
          No saved views yet. Draw an area and save above.
        </div>
      `;
      return;
    }

    this.savedViews.forEach(view => {
      const item = document.createElement('div');
      item.className = `saved-view-item ${this.activeViewId === view.id ? 'active' : ''}`;
      item.title = `Click to fly to ${view.name} and restore shape`;

      item.innerHTML = `
        <div class="view-item-info">
          <div class="view-item-name"></div>
          <div class="view-item-detail"></div>
        </div>
        <div class="view-item-actions">
          <button class="btn-delete-view" title="Delete saved view">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;
      item.querySelector('.view-item-name').textContent = view.name;
      item.querySelector('.view-item-detail').textContent = (view.detail || 'View & Shape').replace(/^.*•\s*/, '');

      // Click to fly & restore
      const triggerRestore = (e) => {
        e.stopPropagation();
        if (this.activeViewId === view.id) {
          // If shape is already active and loaded, fly camera to it without reloading simulation on GPU
          this.map.flyTo({
            center: view.center,
            zoom: view.zoom,
            pitch: view.pitch,
            bearing: view.bearing,
            essential: true,
            duration: 1200
          });
          return;
        }
        this.activeViewId = view.id;
        this.renderSavedList();
        this.onRestoreView(view);
      };

      item.addEventListener('click', triggerRestore);

      // Delete action
      item.querySelector('.btn-delete-view').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteView(view.id);
      });

      this.savedListContainer.appendChild(item);
    });
  }

  deleteView(id) {
    const deleted = this.savedViews.find(v => v.id === id);
    this.savedViews = this.savedViews.filter(v => v.id !== id);
    if (this.activeViewId === id) {
      this.activeViewId = null;
    }
    this.saveToStorage(this.savedViews);
    this.renderSavedList();
    if (deleted) {
      this.showToast(`Removed saved view "${deleted.name}"`, 'info');
    }
  }
}
