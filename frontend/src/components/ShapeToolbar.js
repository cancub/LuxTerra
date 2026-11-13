/**
 * ShapeToolbar Component
 * Positioned directly under the top-left LuxTerra card.
 * Provides:
 * 1. "New shape" dropdown (Rectangle, Free-draw)
 * 2. "Load shape" dropdown (saved projects/shapes from localStorage)
 * 3. Post-draw / post-load editing bar:
 *    - Add / modify / clear extra shadow container box (contextBbox)
 *    - "Save shape" (highlighted only when shape geometry or shadow box is modified)
 *    - "Save view" (highlighted only when camera view is modified for a loaded shape)
 *    - Clear active shape
 */

import { computePolygonDimensions } from '../utils/geometry.js';

export const STORAGE_KEY = 'luxterra_saved_views';
export const ACTIVE_VIEW_STORAGE_KEY = 'luxterra_active_view_id';

export function filterLegacyPresets(views) {
  if (!Array.isArray(views)) return [];
  return views.filter(v => v && !v.isPreset && !v.id?.startsWith('preset_'));
}

function roundCoord(n) {
  return Number(Number(n).toFixed(5));
}

function normalizePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return null;
  return polygon.map(pt => [roundCoord(pt[0]), roundCoord(pt[1])]);
}

function normalizeBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  return bbox.map(roundCoord);
}

/**
 * Compare two shape snapshots (polygon, bbox, contextBbox) for equality.
 */
export function areShapesEqual(a, b) {
  if (!a || !b) return false;
  const polyA = normalizePolygon(a.polygon);
  const polyB = normalizePolygon(b.polygon);
  const bboxA = normalizeBbox(a.bbox);
  const bboxB = normalizeBbox(b.bbox);
  const ctxA = normalizeBbox(a.contextBbox);
  const ctxB = normalizeBbox(b.contextBbox);

  return (
    JSON.stringify(polyA) === JSON.stringify(polyB) &&
    JSON.stringify(bboxA) === JSON.stringify(bboxB) &&
    JSON.stringify(ctxA) === JSON.stringify(ctxB)
  );
}

/**
 * Compare two camera view snapshots with small tolerances so flyTo settling
 * does not falsely trigger a view-modified state.
 */
export function areViewsEqual(a, b) {
  if (!a || !b) return false;
  if (!Array.isArray(a.center) || !Array.isArray(b.center)) return false;
  const dLng = Math.abs(a.center[0] - b.center[0]);
  const dLat = Math.abs(a.center[1] - b.center[1]);
  const dZoom = Math.abs((a.zoom ?? 0) - (b.zoom ?? 0));
  const dPitch = Math.abs((a.pitch ?? 0) - (b.pitch ?? 0));
  const dBearing = Math.abs((((a.bearing ?? 0) - (b.bearing ?? 0) + 540) % 360) - 180);

  return dLng < 1e-4 && dLat < 1e-4 && dZoom < 0.05 && dPitch < 1.0 && dBearing < 1.0;
}

export class ShapeToolbar {
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

    this.savedViews = this.loadSavedViews();
    this.activeViewId = null;
    this.loadedShapeSnapshot = null;
    this.loadedViewSnapshot = null;
    this.isShapeModified = false;
    this.isViewModified = false;
    this.isSavingNewName = false;
    this.isRestoringCamera = false;

    this.render();
    this.bindEvents();
    this.restoreActiveViewContext();
  }

  setActiveViewId(id) {
    this.activeViewId = id || null;
    try {
      if (this.activeViewId) {
        localStorage.setItem(ACTIVE_VIEW_STORAGE_KEY, this.activeViewId);
      } else {
        localStorage.removeItem(ACTIVE_VIEW_STORAGE_KEY);
      }
    } catch (e) {
      // Ignore storage errors
    }
  }

  restoreActiveViewContext() {
    const currentShape = this.getCurrentShapeSnapshot();
    if (!currentShape) return;

    let matchedView = null;
    try {
      const storedId = localStorage.getItem(ACTIVE_VIEW_STORAGE_KEY);
      if (storedId) {
        matchedView = this.savedViews.find(v => v.id === storedId) || null;
      }
    } catch (e) {
      // Ignore storage errors
    }

    if (!matchedView) {
      matchedView = this.savedViews.find(v =>
        areShapesEqual(currentShape, {
          bbox: v.bbox,
          polygon: v.polygon,
          contextBbox: v.contextBbox || null
        })
      ) || null;
    }

    if (matchedView) {
      this.setActiveViewId(matchedView.id);
      this.loadedShapeSnapshot = (matchedView.polygon || matchedView.bbox)
        ? {
            bbox: normalizeBbox(matchedView.bbox),
            polygon: normalizePolygon(matchedView.polygon),
            contextBbox: normalizeBbox(matchedView.contextBbox || null)
          }
        : null;
      this.loadedViewSnapshot = {
        center: [...matchedView.center],
        zoom: matchedView.zoom,
        pitch: matchedView.pitch,
        bearing: matchedView.bearing
      };
      this.refreshModificationState();
    }
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
      console.warn('Failed to parse saved shapes from localStorage:', e);
    }
    return [];
  }

  saveToStorage(views) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
    } catch (e) {
      console.warn('Failed to save shapes to localStorage:', e);
    }
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'shape-toolbar';

    this.element.innerHTML = `
      <div class="shape-toolbar-primary">
        <div class="toolbar-dropdown-group">
          <button class="glass-panel btn btn-sm toolbar-btn btn-new-shape" title="Draw a new solar area">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
            <span>New shape</span>
            <svg class="dropdown-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="glass-panel toolbar-dropdown new-shape-menu" style="display: none;">
            <button class="toolbar-menu-item btn-draw-rectangle" title="Click & drag on the map to draw a rectangular solar area">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
              </svg>
              <span>Rectangle</span>
            </button>
            <button class="toolbar-menu-item btn-draw-freedraw" title="Free-draw multi-point solar area. Hold Shift or click #1 to close, Enter to finish.">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                <polyline points="2 17 12 22 22 17"></polyline>
                <polyline points="2 12 12 17 22 12"></polyline>
              </svg>
              <span>Free-draw</span>
            </button>
          </div>
        </div>

        <div class="toolbar-dropdown-group">
          <button class="glass-panel btn btn-sm toolbar-btn btn-load-shape" title="Load a saved shape">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
            </svg>
            <span>Load shape</span>
            <svg class="dropdown-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          <div class="glass-panel toolbar-dropdown load-shape-menu" style="display: none;">
            <div class="load-shape-list"></div>
          </div>
        </div>
      </div>

      <div class="glass-panel shape-edit-bar" style="display: none;">
        <button class="btn btn-sm btn-context-toggle" title="Add or modify the extra shadow container box">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="2" width="20" height="20" rx="3" ry="3" stroke-dasharray="3 3"></rect>
            <rect x="7" y="7" width="10" height="10" rx="1" ry="1"></rect>
          </svg>
          <span class="context-label">+ Shadow Box</span>
        </button>
        <button class="btn btn-sm btn-save-shape" title="Save changes to shape" disabled>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
          <span>Save shape</span>
        </button>
        <button class="btn btn-sm btn-save-view" title="Save changes to camera view" disabled>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
            <circle cx="12" cy="13" r="4"></circle>
          </svg>
          <span>Save view</span>
        </button>
        <button class="btn btn-sm btn-shape-clear" title="Clear active shape">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>

      <div class="glass-panel save-name-popover" style="display: none;">
        <input type="text" class="save-name-input" placeholder="Shape name..." />
        <button class="btn btn-sm btn-accent save-name-confirm">Save</button>
        <button class="btn btn-sm save-name-cancel">Cancel</button>
      </div>
    `;

    this.btnNewShape = this.element.querySelector('.btn-new-shape');
    this.newShapeMenu = this.element.querySelector('.new-shape-menu');
    this.btnDrawRectangle = this.element.querySelector('.btn-draw-rectangle');
    this.btnDrawFreedraw = this.element.querySelector('.btn-draw-freedraw');

    this.btnLoadShape = this.element.querySelector('.btn-load-shape');
    this.loadShapeMenu = this.element.querySelector('.load-shape-menu');
    this.loadShapeList = this.element.querySelector('.load-shape-list');

    this.editBar = this.element.querySelector('.shape-edit-bar');
    this.btnContextToggle = this.element.querySelector('.btn-context-toggle');
    this.contextLabel = this.element.querySelector('.context-label');
    this.btnSaveShape = this.element.querySelector('.btn-save-shape');
    this.btnSaveView = this.element.querySelector('.btn-save-view');
    this.btnClear = this.element.querySelector('.btn-shape-clear');

    this.saveNamePopover = this.element.querySelector('.save-name-popover');
    this.saveNameInput = this.element.querySelector('.save-name-input');
    this.saveNameConfirm = this.element.querySelector('.save-name-confirm');
    this.saveNameCancel = this.element.querySelector('.save-name-cancel');

    this.renderSavedList();
    this.container.appendChild(this.element);
  }

  bindEvents() {
    // Dropdown toggles
    this.btnNewShape.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.newShapeMenu.style.display !== 'none';
      this.closeDropdowns();
      if (!isOpen) {
        this.newShapeMenu.style.display = 'flex';
      }
    });

    this.btnLoadShape.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.loadShapeMenu.style.display !== 'none';
      this.closeDropdowns();
      if (!isOpen) {
        this.renderSavedList();
        this.loadShapeMenu.style.display = 'flex';
      }
    });

    document.addEventListener('click', (e) => {
      if (!this.element.contains(e.target)) {
        this.closeDropdowns();
      }
    });

    // New shape options
    this.btnDrawRectangle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.hideSaveNamePopover();
      this.boxDrawer.startDrawing('rectangle');
    });

    this.btnDrawFreedraw.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.hideSaveNamePopover();
      this.boxDrawer.startDrawing('polygon');
    });

    // Context / Shadow Box toggle
    this.btnContextToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      const selection = this.boxDrawer.getSelection();
      if (selection.contextBbox) {
        this.boxDrawer.clearContext();
        this.showToast('Cleared extra shadow container box', 'info');
      } else {
        this.boxDrawer.addDefaultContext(40.0);
        this.showToast('Added shadow container box — drag corners to adjust', 'info');
      }
      this.refreshModificationState();
    });

    // Save shape
    this.btnSaveShape.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.isShapeModified) return;
      if (this.activeViewId !== null) {
        this.saveChangesToActiveShape();
      } else {
        this.openSaveNamePopover();
      }
    });

    // Save view
    this.btnSaveView.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.isViewModified || this.activeViewId === null) return;
      this.saveChangesToActiveView();
    });

    // Clear shape
    this.btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxDrawer.clearSelection();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.hideSaveNamePopover();
      this.refreshModificationState();
    });

    // Inline save name popover
    this.saveNameConfirm.addEventListener('click', (e) => {
      e.stopPropagation();
      this.commitNewShapeSave();
    });

    this.saveNameCancel.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hideSaveNamePopover();
    });

    this.saveNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        this.commitNewShapeSave();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        this.hideSaveNamePopover();
      }
    });

    // Listen to BoxDrawer state changes
    if (typeof this.boxDrawer.setStateChangeListener === 'function') {
      this.boxDrawer.setStateChangeListener((state) => {
        this.updateDrawerState(state);
      });
    }

    // Listen to Map camera movements
    if (this.map && typeof this.map.on === 'function') {
      this.map.on('moveend', () => {
        if (this.isRestoringCamera) {
          this.isRestoringCamera = false;
          if (this.activeViewId !== null) {
            this.loadedViewSnapshot = this.getCurrentCameraSnapshot();
          }
        }
        this.refreshModificationState();
      });
    }
  }

  closeDropdowns() {
    this.newShapeMenu.style.display = 'none';
    this.loadShapeMenu.style.display = 'none';
  }

  openSaveNamePopover() {
    const center = this.map.getCenter();
    this.saveNameInput.value = '';
    this.saveNameInput.placeholder = `Area at ${center.lat.toFixed(3)}°N, ${Math.abs(center.lng).toFixed(3)}°W`;
    this.saveNamePopover.style.display = 'flex';
    this.saveNameInput.focus();
  }

  hideSaveNamePopover() {
    this.saveNamePopover.style.display = 'none';
    this.saveNameInput.value = '';
  }

  getCurrentCameraSnapshot() {
    const center = this.map.getCenter();
    return {
      center: [roundCoord(center.lng), roundCoord(center.lat)],
      zoom: Number(this.map.getZoom().toFixed(2)),
      pitch: Math.round(this.map.getPitch()),
      bearing: Math.round(this.map.getBearing())
    };
  }

  getCurrentShapeSnapshot() {
    const selection = this.boxDrawer.getSelection();
    if (!selection || (!selection.polygon && !selection.bbox)) return null;
    return {
      bbox: normalizeBbox(selection.bbox),
      polygon: normalizePolygon(selection.polygon),
      contextBbox: normalizeBbox(selection.contextBbox)
    };
  }

  updateDrawerState(state) {
    if (!state) return;

    if (state.isDrawingActive) {
      this.btnNewShape.classList.add('active');
    } else {
      this.btnNewShape.classList.remove('active');
    }

    if (state.hasShape && state.dimensions) {
      this.editBar.style.display = 'flex';
      if (state.hasContext) {
        this.btnContextToggle.classList.add('active', 'btn-accent');
        this.contextLabel.textContent = 'Shadow Box ✓';
      } else {
        this.btnContextToggle.classList.remove('active', 'btn-accent');
        this.contextLabel.textContent = '+ Shadow Box';
      }
    } else {
      this.editBar.style.display = 'none';
      this.hideSaveNamePopover();
    }

    this.refreshModificationState();
  }

  refreshModificationState() {
    const currentShape = this.getCurrentShapeSnapshot();
    if (!currentShape) {
      this.isShapeModified = false;
      this.isViewModified = false;
    } else if (this.activeViewId === null || !this.loadedShapeSnapshot) {
      // Newly drawn or restored from startup state without a saved entry
      this.isShapeModified = true;
      this.isViewModified = false;
    } else {
      this.isShapeModified = !areShapesEqual(currentShape, this.loadedShapeSnapshot);
      if (this.isRestoringCamera) {
        this.isViewModified = false;
      } else {
        const currentView = this.getCurrentCameraSnapshot();
        this.isViewModified = this.loadedViewSnapshot
          ? !areViewsEqual(currentView, this.loadedViewSnapshot)
          : false;
      }
    }

    // Update Save shape button highlight
    this.btnSaveShape.disabled = !this.isShapeModified;
    if (this.isShapeModified) {
      this.btnSaveShape.classList.add('btn-accent', 'modified');
    } else {
      this.btnSaveShape.classList.remove('btn-accent', 'modified');
    }

    // Update Save view button highlight
    const canSaveView = this.activeViewId !== null && this.isViewModified;
    this.btnSaveView.style.display = this.activeViewId !== null ? 'inline-flex' : 'none';
    this.btnSaveView.disabled = !canSaveView;
    if (canSaveView) {
      this.btnSaveView.classList.add('btn-accent', 'modified');
    } else {
      this.btnSaveView.classList.remove('btn-accent', 'modified');
    }
  }

  commitNewShapeSave() {
    const selection = this.boxDrawer.getSelection();
    if (!selection || (!selection.polygon && !selection.bbox)) return;

    const camera = this.getCurrentCameraSnapshot();
    const rawName = this.saveNameInput.value.trim();
    const name = rawName || `Area at ${camera.center[1].toFixed(3)}°N, ${Math.abs(camera.center[0]).toFixed(3)}°W`;
    const dims = selection.dimensions || (selection.polygon ? computePolygonDimensions(selection.polygon) : null);
    const area = dims ? Math.round(dims.areaM2).toLocaleString('en-US') : '0';
    const date = this.dateSelector ? this.dateSelector.getDate() : '2026-06-21';

    const newView = {
      id: `view_${Date.now()}`,
      name,
      detail: `${area} m²`,
      center: camera.center,
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
      bbox: normalizeBbox(selection.bbox),
      polygon: normalizePolygon(selection.polygon),
      contextBbox: normalizeBbox(selection.contextBbox),
      shapeType: 'polygon',
      date,
      createdAt: new Date().toISOString()
    };

    this.savedViews.unshift(newView);
    this.saveToStorage(this.savedViews);
    this.setActiveViewId(newView.id);
    this.loadedShapeSnapshot = this.getCurrentShapeSnapshot();
    this.loadedViewSnapshot = camera;

    this.hideSaveNamePopover();
    this.renderSavedList();
    this.refreshModificationState();
    this.showToast(`Saved shape "${name}"!`, 'info');
  }

  saveChangesToActiveShape() {
    const idx = this.savedViews.findIndex(v => v.id === this.activeViewId);
    if (idx === -1) return;

    const selection = this.boxDrawer.getSelection();
    if (!selection || (!selection.polygon && !selection.bbox)) return;

    const dims = selection.dimensions || (selection.polygon ? computePolygonDimensions(selection.polygon) : null);
    const area = dims ? Math.round(dims.areaM2).toLocaleString('en-US') : '0';

    this.savedViews[idx] = {
      ...this.savedViews[idx],
      detail: `${area} m²`,
      bbox: normalizeBbox(selection.bbox),
      polygon: normalizePolygon(selection.polygon),
      contextBbox: normalizeBbox(selection.contextBbox),
      shapeType: 'polygon'
    };

    this.saveToStorage(this.savedViews);
    this.loadedShapeSnapshot = this.getCurrentShapeSnapshot();
    this.renderSavedList();
    this.refreshModificationState();
    this.showToast(`Saved changes to "${this.savedViews[idx].name}"`, 'info');
  }

  saveChangesToActiveView() {
    const idx = this.savedViews.findIndex(v => v.id === this.activeViewId);
    if (idx === -1) return;

    const camera = this.getCurrentCameraSnapshot();
    const date = this.dateSelector ? this.dateSelector.getDate() : this.savedViews[idx].date;

    this.savedViews[idx] = {
      ...this.savedViews[idx],
      center: camera.center,
      zoom: camera.zoom,
      pitch: camera.pitch,
      bearing: camera.bearing,
      date
    };

    this.saveToStorage(this.savedViews);
    this.loadedViewSnapshot = camera;
    this.renderSavedList();
    this.refreshModificationState();
    this.showToast(`Saved view for "${this.savedViews[idx].name}"`, 'info');
  }

  loadView(view) {
    this.setActiveViewId(view.id);
    this.loadedShapeSnapshot = (view.polygon || view.bbox)
      ? {
          bbox: normalizeBbox(view.bbox),
          polygon: normalizePolygon(view.polygon),
          contextBbox: normalizeBbox(view.contextBbox || null)
        }
      : null;
    this.loadedViewSnapshot = {
      center: [...view.center],
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing
    };
    this.isRestoringCamera = true;
    this.closeDropdowns();
    this.hideSaveNamePopover();
    this.renderSavedList();
    this.onRestoreView(view);
    if (areViewsEqual(this.getCurrentCameraSnapshot(), this.loadedViewSnapshot)) {
      this.isRestoringCamera = false;
    } else {
      setTimeout(() => {
        if (this.isRestoringCamera) {
          this.isRestoringCamera = false;
          this.loadedViewSnapshot = this.getCurrentCameraSnapshot();
          this.refreshModificationState();
        }
      }, 1600);
    }
    this.refreshModificationState();
  }

  renderSavedList() {
    this.loadShapeList.innerHTML = '';

    if (this.savedViews.length === 0) {
      this.loadShapeList.innerHTML = `
        <div class="load-shape-empty">No saved shapes yet.</div>
      `;
      return;
    }

    this.savedViews.forEach(view => {
      const item = document.createElement('div');
      item.className = `saved-view-item ${this.activeViewId === view.id ? 'active' : ''}`;
      item.title = `Click to load ${view.name}`;

      item.innerHTML = `
        <div class="view-item-info">
          <div class="view-item-name"></div>
          <div class="view-item-detail"></div>
        </div>
        <div class="view-item-actions">
          <button class="btn-delete-view" title="Delete saved shape">&times;</button>
        </div>
      `;

      item.querySelector('.view-item-name').textContent = view.name;
      item.querySelector('.view-item-detail').textContent = (view.detail || '').replace(/^.*•\s*/, '');

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.loadView(view);
      });

      item.querySelector('.btn-delete-view').addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteView(view.id);
      });

      this.loadShapeList.appendChild(item);
    });
  }

  deleteView(id) {
    const deleted = this.savedViews.find(v => v.id === id);
    this.savedViews = this.savedViews.filter(v => v.id !== id);
    if (this.activeViewId === id) {
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.refreshModificationState();
    }
    this.saveToStorage(this.savedViews);
    this.renderSavedList();
    if (deleted) {
      this.showToast(`Removed saved shape "${deleted.name}"`, 'info');
    }
  }
}
