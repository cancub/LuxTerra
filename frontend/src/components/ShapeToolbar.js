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
import { captureShapeThumbnail, lookupShapeLocation } from '../utils/shapePreview.js';

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

/**
 * Pure history stack for shape snapshots supporting undo (back), redo (forward),
 * and pushing new snapshots while truncating any forward branch.
 */
export class ShapeHistory {
  constructor() {
    this.entries = [];
    this.index = -1;
  }

  reset(initialSnapshot = null) {
    if (initialSnapshot) {
      this.entries = [initialSnapshot];
      this.index = 0;
    } else {
      this.entries = [];
      this.index = -1;
    }
  }

  push(snapshot) {
    if (!snapshot) return false;
    const current = this.current();
    if (current && areShapesEqual(current, snapshot)) {
      return false;
    }
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(snapshot);
    this.index = this.entries.length - 1;
    return true;
  }

  current() {
    return this.index >= 0 && this.index < this.entries.length
      ? this.entries[this.index]
      : null;
  }

  canUndo() {
    return this.index > 0;
  }

  canRedo() {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  undo() {
    if (!this.canUndo()) return null;
    this.index -= 1;
    return this.current();
  }

  redo() {
    if (!this.canRedo()) return null;
    this.index += 1;
    return this.current();
  }
}

export class ShapeToolbar {
  constructor({
    map,
    container,
    primaryContainer = null,
    dailyEnergyMount = null,
    settingsMount = null,
    settingsBtn = null,
    boxDrawer,
    dateSelector,
    onRestoreView,
    showToast
  }) {
    this.map = map;
    this.container = container;
    this.primaryContainer = primaryContainer || container;
    this.dailyEnergyMount = dailyEnergyMount;
    this.settingsMount = settingsMount;
    this.settingsBtn = settingsBtn;
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
    this.isApplyingHistory = false;
    this.hasActiveShape = false;
    this.cardMode = null; // 'load' | 'new' | 'edit' | null
    this.cardTransitionTimer = null;
    this.isBackfillingPreviews = false;
    this.shapeHistory = new ShapeHistory();

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
    this.syncShapeNameInput();
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
      this.shapeHistory.reset(this.loadedShapeSnapshot);
      this.shapeHistory.push(currentShape);
      this.refreshModificationState();
    } else {
      this.shapeHistory.reset(currentShape);
    }
  }

  loadSavedViews() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (!Array.isArray(parsed)) return [];
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
    this.primaryElement = document.createElement('div');
    this.primaryElement.className = 'shape-toolbar-primary';
    this.primaryElement.innerHTML = `
      <button class="command-nav-btn btn-load-shape" title="Load a saved shape">Load</button>
      <div class="command-divider"></div>
      <button class="command-nav-btn btn-new-shape" title="Draw a new solar area">New</button>
    `;

    this.element = document.createElement('div');
    this.element.className = 'shape-toolbar';

    this.element.innerHTML = `
      <div class="glass-panel shape-card" style="display: none;">
        <div class="shape-card-content">
          <!-- Load Mode -->
          <div class="shape-card-pane shape-load-pane" style="display: none;">
            <div class="load-shape-list"></div>
          </div>

          <!-- New Mode -->
          <div class="shape-card-pane shape-new-pane" style="display: none;">
            <div class="new-shape-tools">
              <button class="new-tool-btn btn-draw-rectangle" title="Click & drag on the map to draw a rectangular solar area">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                </svg>
                <div class="new-tool-text">
                  <span class="new-tool-title">Rectangle</span>
                  <span class="new-tool-desc">Click & drag a solar rectangle</span>
                </div>
              </button>
              <button class="new-tool-btn btn-draw-freedraw" title="Free-draw multi-point solar area. Hold Shift or click #1 to close, Enter to finish.">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="12 2 2 7 12 12 22 7 12 2"></polygon>
                  <polyline points="2 17 12 22 22 17"></polyline>
                  <polyline points="2 12 12 17 22 12"></polyline>
                </svg>
                <div class="new-tool-text">
                  <span class="new-tool-title">Free-draw</span>
                  <span class="new-tool-desc">Draw a custom multi-point polygon</span>
                </div>
              </button>
            </div>
          </div>

          <!-- Settings Mode -->
          <div class="shape-card-pane shape-settings-pane" style="display: none;">
            <div class="shape-settings-header">PV System Configuration</div>
            <div class="shape-settings-mount"></div>
          </div>

          <!-- Edit Mode -->
          <div class="shape-card-pane shape-edit-pane" style="display: none;">
            <div class="shape-name-row">
              <input type="text" class="shape-name-input" placeholder="Untitled shape..." />
            </div>
            <div class="shape-edit-bar">
              <button class="btn btn-sm btn-square-icon btn-history-back" title="Undo last shape change" disabled>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="9 14 4 9 9 4"></polyline>
                  <path d="M20 20v-7a4 4 0 0 0-4-4H4"></path>
                </svg>
              </button>
              <button class="btn btn-sm btn-square-icon btn-history-forward" title="Redo shape change" disabled>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="15 14 20 9 15 4"></polyline>
                  <path d="M4 20v-7a4 4 0 0 1 4-4h12"></path>
                </svg>
              </button>
              <div class="edit-bar-divider"></div>
              <div class="toolbar-dropdown-group save-menu-group">
                <button class="btn btn-sm btn-save-menu" title="Save or reset shape & view">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                  </svg>
                  <span class="save-menu-label">Save</span>
                  <svg class="dropdown-caret" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </button>
                <div class="glass-panel toolbar-dropdown save-menu" style="display: none;">
                  <button class="toolbar-menu-item btn-save-shape" title="Save changes to shape">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                      <polyline points="17 21 17 13 7 13 7 21"></polyline>
                      <polyline points="7 3 7 8 15 8"></polyline>
                    </svg>
                    <span class="save-shape-label">Save changes</span>
                  </button>
                  <button class="toolbar-menu-item btn-save-as-new" title="Save as a new named shape">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="12" y1="18" x2="12" y2="12"></line>
                      <line x1="9" y1="15" x2="15" y2="15"></line>
                    </svg>
                    <span>Save as new…</span>
                  </button>
                  <button class="toolbar-menu-item btn-save-view" title="Save current camera position to this shape">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                      <circle cx="12" cy="13" r="4"></circle>
                    </svg>
                    <span>Update camera view</span>
                  </button>
                  <div class="save-menu-divider"></div>
                  <button class="toolbar-menu-item btn-shape-reset" title="Reset shape to original state">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 12a9 9 0 1 0 3-6.7L3 8"></path>
                      <polyline points="3 3 3 8 8 8"></polyline>
                    </svg>
                    <span>Reset to original</span>
                  </button>
                </div>
              </div>
              <button class="btn btn-sm btn-square-icon btn-shape-clear" title="Clear active shape">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
              </button>
            </div>
            <div class="shape-context-row">
              <button class="btn btn-sm btn-context-toggle" title="Add or modify the extra shadow container box">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="2" y="2" width="20" height="20" rx="3" ry="3" stroke-dasharray="3 3"></rect>
                  <rect x="7" y="7" width="10" height="10" rx="1" ry="1"></rect>
                </svg>
                <span class="context-label">Shadow Box</span>
              </button>
            </div>
            <div class="shape-daily-energy-mount"></div>
          </div>
        </div>
      </div>

      <div class="glass-panel thumb-hover-preview" style="display: none;">
        <img class="thumb-hover-img" alt="Shape preview" width="100" height="100" />
      </div>

      <div class="glass-panel save-name-popover" style="display: none;">
        <input type="text" class="save-name-input" placeholder="Shape name..." />
        <button class="btn btn-sm btn-accent save-name-confirm">Save</button>
        <button class="btn btn-sm save-name-cancel">Cancel</button>
      </div>
    `;

    this.btnLoadShape = this.primaryElement.querySelector('.btn-load-shape');
    this.btnNewShape = this.primaryElement.querySelector('.btn-new-shape');

    this.shapeCard = this.element.querySelector('.shape-card');
    this.shapeCardContent = this.element.querySelector('.shape-card-content');
    this.loadPane = this.element.querySelector('.shape-load-pane');
    this.newPane = this.element.querySelector('.shape-new-pane');
    this.settingsPane = this.element.querySelector('.shape-settings-pane');
    this.editPane = this.element.querySelector('.shape-edit-pane');
    this.settingsHost = this.element.querySelector('.shape-settings-mount');
    if (this.settingsMount) {
      this.settingsHost.appendChild(this.settingsMount);
    }

    this.loadShapeList = this.element.querySelector('.load-shape-list');
    this.btnDrawRectangle = this.element.querySelector('.btn-draw-rectangle');
    this.btnDrawFreedraw = this.element.querySelector('.btn-draw-freedraw');

    this.shapeNameInput = this.element.querySelector('.shape-name-input');
    this.editBar = this.element.querySelector('.shape-edit-bar');
    this.btnContextToggle = this.element.querySelector('.btn-context-toggle');
    this.contextLabel = this.element.querySelector('.context-label');
    this.btnHistoryBack = this.element.querySelector('.btn-history-back');
    this.btnHistoryForward = this.element.querySelector('.btn-history-forward');
    this.btnSaveMenu = this.element.querySelector('.btn-save-menu');
    this.saveMenu = this.element.querySelector('.save-menu');
    this.saveMenuLabel = this.element.querySelector('.save-menu-label');
    this.btnShapeReset = this.element.querySelector('.btn-shape-reset');
    this.btnSaveShape = this.element.querySelector('.btn-save-shape');
    this.saveShapeLabel = this.element.querySelector('.save-shape-label');
    this.btnSaveAsNew = this.element.querySelector('.btn-save-as-new');
    this.btnSaveView = this.element.querySelector('.btn-save-view');
    this.btnClear = this.element.querySelector('.btn-shape-clear');
    this.dailyEnergyHost = this.element.querySelector('.shape-daily-energy-mount');
    if (this.dailyEnergyMount) {
      this.dailyEnergyHost.appendChild(this.dailyEnergyMount);
    }

    this.thumbHoverPreview = this.element.querySelector('.thumb-hover-preview');
    this.thumbHoverImg = this.element.querySelector('.thumb-hover-img');

    this.saveNamePopover = this.element.querySelector('.save-name-popover');
    this.saveNameInput = this.element.querySelector('.save-name-input');
    this.saveNameConfirm = this.element.querySelector('.save-name-confirm');
    this.saveNameCancel = this.element.querySelector('.save-name-cancel');

    this.renderSavedList();
    this.primaryContainer.appendChild(this.primaryElement);
    this.container.appendChild(this.element);
  }

  bindEvents() {
    // Top bar Load & New toggles
    this.btnLoadShape.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      if (this.cardMode === 'load') {
        this.setCardMode(this.hasActiveShape ? 'edit' : null);
      } else {
        this.renderSavedList();
        this.setCardMode('load');
        this.backfillMissingPreviews();
      }
    });

    this.btnNewShape.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      if (this.cardMode === 'new') {
        this.setCardMode(this.hasActiveShape ? 'edit' : null);
      } else {
        this.setCardMode('new');
      }
    });

    if (this.settingsBtn) {
      this.settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeDropdowns();
        if (this.cardMode === 'settings') {
          this.setCardMode(this.hasActiveShape ? 'edit' : null);
        } else {
          this.setCardMode('settings');
        }
      });
    }

    document.addEventListener('click', (e) => {
      this.closeDropdowns();
      const clickedInsidePrimary = this.primaryElement.contains(e.target);
      const clickedInsideSettingsBtn = this.settingsBtn ? this.settingsBtn.contains(e.target) : false;
      const clickedInsideCard = this.element.contains(e.target);
      if (!clickedInsidePrimary && !clickedInsideSettingsBtn && !clickedInsideCard) {
        this.hideThumbPreview();
        if (this.cardMode === 'load' || this.cardMode === 'new' || this.cardMode === 'settings') {
          this.setCardMode(this.hasActiveShape ? 'edit' : null);
        }
      }
    });

    // New shape options
    this.btnDrawRectangle.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.shapeHistory.reset();
      this.hideSaveNamePopover();
      if (this.shapeNameInput) this.shapeNameInput.value = '';
      this.boxDrawer.startDrawing('rectangle');
      this.setCardMode('edit');
    });

    this.btnDrawFreedraw.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.shapeHistory.reset();
      this.hideSaveNamePopover();
      if (this.shapeNameInput) this.shapeNameInput.value = '';
      this.boxDrawer.startDrawing('polygon');
      this.setCardMode('edit');
    });

    // Inline shape name input
    if (this.shapeNameInput) {
      this.shapeNameInput.addEventListener('input', () => {
        this.refreshModificationState();
      });
      this.shapeNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.shapeNameInput.blur();
          if (this.isShapeModified || this.isNameModified) {
            if (this.activeViewId !== null) {
              this.saveChangesToActiveShape();
            } else {
              this.saveNewShapeFromInlineOrPopover();
            }
          }
        }
      });
    }

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

    // Save menu toggle
    this.btnSaveMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = this.saveMenu.style.display !== 'none';
      this.closeDropdowns();
      this.saveMenu.style.display = isOpen ? 'none' : 'flex';
    });

    // Save shape
    this.btnSaveShape.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      if (!this.isShapeModified && !this.isNameModified) return;
      if (this.activeViewId !== null) {
        this.saveChangesToActiveShape();
      } else {
        this.saveNewShapeFromInlineOrPopover();
      }
    });

    // Save as new
    this.btnSaveAsNew.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      this.openSaveNamePopover();
    });

    // Save view
    this.btnSaveView.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      if (!this.isViewModified || this.activeViewId === null) return;
      this.saveChangesToActiveView();
    });

    // History Back / Forward / Reset
    this.btnHistoryBack.addEventListener('click', (e) => {
      e.stopPropagation();
      const prev = this.shapeHistory.undo();
      if (prev) {
        this.applyShapeSnapshot(prev);
      }
    });

    this.btnHistoryForward.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = this.shapeHistory.redo();
      if (next) {
        this.applyShapeSnapshot(next);
      }
    });

    this.btnShapeReset.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeDropdowns();
      const original = this.getOriginalShapeSnapshot();
      if (!original) return;
      this.shapeHistory.push(original);
      this.applyShapeSnapshot(original);
      this.showToast('Reset shape to original state', 'info');
    });

    // Clear shape
    this.btnClear.addEventListener('click', (e) => {
      e.stopPropagation();
      this.boxDrawer.clearSelection();
      this.setActiveViewId(null);
      this.loadedShapeSnapshot = null;
      this.loadedViewSnapshot = null;
      this.shapeHistory.reset();
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
    if (this.saveMenu) {
      this.saveMenu.style.display = 'none';
    }
  }

  showThumbPreview(thumbnailUrl, anchorEl) {
    if (!thumbnailUrl || !this.thumbHoverPreview || !this.thumbHoverImg) return;
    this.thumbHoverImg.src = thumbnailUrl;
    const rect = anchorEl.getBoundingClientRect();
    this.thumbHoverPreview.style.left = `${Math.round(rect.right + 10)}px`;
    this.thumbHoverPreview.style.top = `${Math.round(Math.max(12, rect.top - 24))}px`;
    this.thumbHoverPreview.style.display = 'flex';
  }

  hideThumbPreview() {
    if (this.thumbHoverPreview) {
      this.thumbHoverPreview.style.display = 'none';
    }
  }

  setCardMode(mode) {
    if (this.cardTransitionTimer) {
      clearTimeout(this.cardTransitionTimer);
      this.cardTransitionTimer = null;
    }
    this.hideThumbPreview();

    if (this.btnLoadShape) {
      this.btnLoadShape.classList.toggle('active', mode === 'load');
    }
    if (this.btnNewShape) {
      this.btnNewShape.classList.toggle('active', mode === 'new');
    }
    if (this.settingsBtn) {
      this.settingsBtn.classList.toggle('active', mode === 'settings');
    }

    if (this.cardMode === mode) return;

    const applyPane = (targetMode) => {
      this.loadPane.style.display = targetMode === 'load' ? 'flex' : 'none';
      this.newPane.style.display = targetMode === 'new' ? 'flex' : 'none';
      this.settingsPane.style.display = targetMode === 'settings' ? 'flex' : 'none';
      this.editPane.style.display = targetMode === 'edit' ? 'flex' : 'none';
      this.shapeCard.classList.remove('mode-load', 'mode-new', 'mode-settings', 'mode-edit');
      if (targetMode) {
        this.shapeCard.classList.add(`mode-${targetMode}`);
      }
    };

    const wasVisible = this.shapeCard.style.display !== 'none' && this.cardMode !== null;
    this.cardMode = mode;

    if (!mode) {
      this.shapeCard.classList.remove('is-visible');
      this.cardTransitionTimer = setTimeout(() => {
        if (!this.cardMode) {
          this.shapeCard.style.display = 'none';
          applyPane(null);
        }
      }, 160);
      return;
    }

    if (!wasVisible) {
      applyPane(mode);
      this.shapeCard.style.display = 'flex';
      this.shapeCardContent.style.opacity = '1';
      requestAnimationFrame(() => {
        this.shapeCard.classList.add('is-visible');
      });
      return;
    }

    // Smoothly fade out contents -> resize card -> fade in new contents
    this.shapeCardContent.style.opacity = '0';
    this.cardTransitionTimer = setTimeout(() => {
      applyPane(mode);
      requestAnimationFrame(() => {
        this.shapeCardContent.style.opacity = '1';
      });
    }, 140);
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

  getOriginalShapeSnapshot() {
    return this.loadedShapeSnapshot || this.shapeHistory.entries[0] || null;
  }

  applyShapeSnapshot(snapshot) {
    if (!snapshot) return;
    this.isApplyingHistory = true;
    try {
      this.boxDrawer.setSelection({
        bbox: snapshot.bbox ? [...snapshot.bbox] : null,
        polygon: snapshot.polygon ? snapshot.polygon.map(pt => [...pt]) : null,
        contextBbox: snapshot.contextBbox ? [...snapshot.contextBbox] : null,
        shapeType: 'polygon'
      });
    } finally {
      this.isApplyingHistory = false;
    }
    this.refreshModificationState();
  }

  updateDrawerState(state) {
    if (!state) return;

    const hadShape = this.hasActiveShape;
    this.hasActiveShape = Boolean(state.hasShape && state.dimensions);

    if (this.hasActiveShape) {
      if (!this.isApplyingHistory) {
        const currentShape = this.getCurrentShapeSnapshot();
        if (currentShape) {
          this.shapeHistory.push(currentShape);
        }
      }
      if (state.hasContext) {
        this.btnContextToggle.classList.add('active', 'btn-accent');
        this.contextLabel.textContent = 'Shadow Box ✓';
      } else {
        this.btnContextToggle.classList.remove('active', 'btn-accent');
        this.contextLabel.textContent = 'Shadow Box';
      }
      if (!hadShape || (this.cardMode !== 'load' && this.cardMode !== 'new' && this.cardMode !== 'settings')) {
        this.setCardMode('edit');
      }
    } else {
      this.hideSaveNamePopover();
      if (state.isDrawingActive) {
        this.setCardMode('edit');
      } else if (this.cardMode === 'edit') {
        this.setCardMode(null);
      }
    }

    this.latestDimensions = state.hasShape ? state.dimensions : null;
    this.refreshModificationState();
  }

  syncShapeNameInput() {
    if (!this.shapeNameInput) return;
    const activeView = this.activeViewId !== null
      ? this.savedViews.find((v) => v.id === this.activeViewId)
      : null;

    if (activeView) {
      this.shapeNameInput.value = activeView.name;
    } else {
      this.shapeNameInput.value = '';
    }
  }

  refreshModificationState() {
    const currentShape = this.getCurrentShapeSnapshot();
    const activeView = this.activeViewId !== null
      ? this.savedViews.find((v) => v.id === this.activeViewId)
      : null;

    const editedName = this.shapeNameInput ? this.shapeNameInput.value.trim() : '';
    this.isNameModified = Boolean(
      activeView && editedName && editedName !== activeView.name
    );

    if (!currentShape) {
      this.isShapeModified = false;
      this.isViewModified = false;
    } else if (this.activeViewId === null || !this.loadedShapeSnapshot) {
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

    // Update Back / Forward / Reset buttons
    this.btnHistoryBack.disabled = !this.shapeHistory.canUndo();
    this.btnHistoryForward.disabled = !this.shapeHistory.canRedo();
    const original = this.getOriginalShapeSnapshot();
    const canReset = Boolean(currentShape && original && !areShapesEqual(currentShape, original));
    this.btnShapeReset.style.display = this.activeViewId !== null ? 'flex' : 'none';
    this.btnShapeReset.disabled = !canReset;

    // Update Save menu highlight and dropdown items
    const canSaveShape = this.isShapeModified || this.isNameModified;
    const canSaveView = this.activeViewId !== null && this.isViewModified;
    const hasPendingSave = canSaveShape || canSaveView;
    if (hasPendingSave) {
      this.btnSaveMenu.classList.add('btn-accent', 'modified');
      this.saveMenuLabel.textContent = 'Save*';
    } else {
      this.btnSaveMenu.classList.remove('btn-accent', 'modified');
      this.saveMenuLabel.textContent = 'Save';
    }

    this.btnSaveShape.disabled = !canSaveShape;
    this.saveShapeLabel.textContent = this.activeViewId !== null ? 'Save changes' : 'Save shape...';

    this.btnSaveAsNew.style.display = this.activeViewId !== null ? 'flex' : 'none';

    this.btnSaveView.style.display = this.activeViewId !== null ? 'flex' : 'none';
    this.btnSaveView.disabled = !canSaveView;
  }

  saveNewShapeFromInlineOrPopover() {
    const inlineName = this.shapeNameInput ? this.shapeNameInput.value.trim() : '';
    if (inlineName) {
      this.commitNewShapeSave(inlineName);
    } else {
      this.openSaveNamePopover();
    }
  }

  commitNewShapeSave(overrideName = null) {
    const selection = this.boxDrawer.getSelection();
    if (!selection || (!selection.polygon && !selection.bbox)) return;

    const camera = this.getCurrentCameraSnapshot();
    const rawName = overrideName !== null ? overrideName : this.saveNameInput.value.trim();
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
    this.captureAndAttachPreview(newView.id, newView.bbox, newView.polygon);
  }

  saveChangesToActiveShape() {
    const idx = this.savedViews.findIndex(v => v.id === this.activeViewId);
    if (idx === -1) return;

    const selection = this.boxDrawer.getSelection();
    if (!selection || (!selection.polygon && !selection.bbox)) return;

    const dims = selection.dimensions || (selection.polygon ? computePolygonDimensions(selection.polygon) : null);
    const area = dims ? Math.round(dims.areaM2).toLocaleString('en-US') : '0';
    const editedName = this.shapeNameInput ? this.shapeNameInput.value.trim() : '';
    const updatedName = editedName || this.savedViews[idx].name;

    this.savedViews[idx] = {
      ...this.savedViews[idx],
      name: updatedName,
      detail: `${area} m²`,
      bbox: normalizeBbox(selection.bbox),
      polygon: normalizePolygon(selection.polygon),
      contextBbox: normalizeBbox(selection.contextBbox),
      shapeType: 'polygon'
    };

    this.saveToStorage(this.savedViews);
    this.loadedShapeSnapshot = this.getCurrentShapeSnapshot();
    this.syncShapeNameInput();
    this.renderSavedList();
    this.refreshModificationState();
    this.showToast(`Saved changes to "${updatedName}"`, 'info');
    this.captureAndAttachPreview(
      this.savedViews[idx].id,
      this.savedViews[idx].bbox,
      this.savedViews[idx].polygon
    );
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
      center: Array.isArray(view.center) ? [...view.center] : view.center,
      zoom: view.zoom,
      pitch: view.pitch,
      bearing: view.bearing
    };
    this.shapeHistory.reset(this.loadedShapeSnapshot);
    this.isRestoringCamera = true;
    this.closeDropdowns();
    this.hideSaveNamePopover();
    this.hideThumbPreview();
    this.setCardMode('edit');
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

  async captureAndAttachPreview(viewId, bbox, polygon) {
    if (!viewId || !bbox) return;
    const [thumbnail, location] = await Promise.all([
      captureShapeThumbnail(bbox, polygon, 100),
      lookupShapeLocation(bbox)
    ]);
    const idx = this.savedViews.findIndex(v => v.id === viewId);
    if (idx === -1) return;

    let changed = false;
    if (thumbnail && this.savedViews[idx].thumbnail !== thumbnail) {
      this.savedViews[idx].thumbnail = thumbnail;
      changed = true;
    }
    if (location && this.savedViews[idx].location !== location) {
      this.savedViews[idx].location = location;
      changed = true;
    }
    if (changed) {
      this.saveToStorage(this.savedViews);
      this.renderSavedList();
    }
  }

  async backfillMissingPreviews() {
    if (this.isBackfillingPreviews) return;
    const missing = this.savedViews.filter(v => v.bbox && (!v.thumbnail || !v.location));
    if (missing.length === 0) return;

    this.isBackfillingPreviews = true;
    try {
      for (const view of missing) {
        await this.captureAndAttachPreview(view.id, view.bbox, view.polygon);
      }
    } finally {
      this.isBackfillingPreviews = false;
    }
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

      const fallbackLocation = Array.isArray(view.center)
        ? `${Math.abs(view.center[1]).toFixed(2)}°${view.center[1] >= 0 ? 'N' : 'S'}, ${Math.abs(view.center[0]).toFixed(2)}°${view.center[0] >= 0 ? 'E' : 'W'}`
        : '';

      item.innerHTML = `
        <div class="view-item-info">
          <div class="view-item-name"></div>
          <div class="view-item-location"></div>
        </div>
        <div class="view-item-actions">
          <button class="btn-delete-view" title="Delete saved shape">&times;</button>
          <div class="view-item-thumb"></div>
        </div>
      `;

      item.querySelector('.view-item-name').textContent = view.name;
      item.querySelector('.view-item-location').textContent = view.location || fallbackLocation;

      const thumbEl = item.querySelector('.view-item-thumb');
      if (view.thumbnail) {
        const img = document.createElement('img');
        img.src = view.thumbnail;
        img.alt = view.name;
        thumbEl.appendChild(img);

        thumbEl.addEventListener('mouseenter', () => {
          this.showThumbPreview(view.thumbnail, thumbEl);
        });
        thumbEl.addEventListener('mouseleave', () => {
          this.hideThumbPreview();
        });
      } else {
        thumbEl.classList.add('is-placeholder');
      }

      item.addEventListener('click', (e) => {
        e.stopPropagation();
        this.loadView(view);
      });

      item.querySelector('.btn-delete-view').addEventListener('click', (e) => {
        e.stopPropagation();
        this.hideThumbPreview();
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
