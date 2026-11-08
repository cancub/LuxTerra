/**
 * LuxTerra - Main Application Entrypoint
 * Orchestrates MapLibre viewer, real-time GPU shadow projection, interactive box drawing,
 * 24-hour timeline scrubbing, and real-time PV generation telemetry.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { initMap } from './components/MapViewer.js';
import { LayerToggle } from './components/LayerToggle.js';
import { BoxDrawer } from './components/BoxDrawer.js';
import { SavedViewsPanel } from './components/SavedViewsPanel.js';
import { ShadowCanvasLayer } from './components/ShadowCanvasLayer.js';
import { DateSelector } from './components/DateSelector.js';
import { TimeScrubber } from './components/TimeScrubber.js';
import { PlaybackEngine } from './components/PlaybackEngine.js';
import { PVConfigPanel } from './components/PVConfigPanel.js';
import { SolarDashboard } from './components/SolarDashboard.js';
import { runSimulation } from './services/api.js';
import {
  loadAppState,
  updateMapState,
  updateLayerState,
  updateSelectionState,
  updateDateState
} from './utils/stateStorage.js';

const appContainer = document.getElementById('app');
if (appContainer) {
  // Load persisted application state (orientation, zoom, satellite/map, rectangle location)
  const savedState = loadAppState();
  appContainer.innerHTML = `
    <div id="map"></div>
    <div class="top-bar">
      <div class="top-left-group" style="display: flex; align-items: center; gap: 8px;">
        <button id="settings-cog-btn" class="glass-panel settings-cog-btn" title="PV System Configuration" aria-label="Settings">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <div class="glass-panel brand-badge">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="5"></circle>
            <line x1="12" y1="1" x2="12" y2="3"></line>
            <line x1="12" y1="21" x2="12" y2="23"></line>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
            <line x1="1" y1="12" x2="3" y2="12"></line>
            <line x1="21" y1="12" x2="23" y2="12"></line>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
          </svg>
          <span>LuxTerra</span>
          <span class="pill">QC Solar 1m</span>
        </div>
      </div>
      <div class="top-right-controls" id="top-right-controls"></div>
    </div>

    <!-- PV System Configuration Settings Modal -->
    <div id="pv-settings-modal" class="modal-backdrop" style="display: none;">
      <div class="glass-panel modal-card">
        <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-card); padding-bottom: 12px; margin-bottom: 14px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-solar);">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
            <span style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary);">PV System Configuration</span>
          </div>
          <button id="modal-close-btn" class="modal-close-btn" title="Close Settings" aria-label="Close" style="background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border-card); border-radius: 6px; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
        <div id="pv-config-modal-mount"></div>
      </div>
    </div>

    <!-- Notification Toasts -->
    <div class="toast-container" id="toast-container"></div>

    <!-- Floating Right Sidebar Dock -->
    <div class="right-dock" id="right-dock">
      <div id="views-panel-mount"></div>
    </div>

    <!-- Bottom Timeline Dock -->
    <div class="bottom-dock" id="bottom-dock">
      <div class="energy-metrics-mount" id="energy-metrics-mount"></div>
      <div class="timeline-cluster" id="timeline-cluster">
        <div class="timeline-controls-row" id="timeline-controls-row">
          <div id="date-selector-mount"></div>
          <div id="playback-controls-mount"></div>
        </div>
        <div id="timeline-scrubber-mount" style="width: 100%; display: flex; justify-content: center;"></div>
      </div>
    </div>
  `;

  const map = initMap('map', {
    center: savedState.map.center,
    zoom: savedState.map.zoom,
    pitch: savedState.map.pitch,
    bearing: savedState.map.bearing,
    activeLayer: savedState.layer
  });
  const viewsPanelMount = document.getElementById('views-panel-mount');
  const topRightControls = document.getElementById('top-right-controls');
  const dateSelectorMount = document.getElementById('date-selector-mount');
  const playbackControlsMount = document.getElementById('playback-controls-mount');
  const timelineScrubberMount = document.getElementById('timeline-scrubber-mount');
  const energyMetricsMount = document.getElementById('energy-metrics-mount');
  const pvConfigModalMount = document.getElementById('pv-config-modal-mount');

  const settingsModal = document.getElementById('pv-settings-modal');
  const settingsCogBtn = document.getElementById('settings-cog-btn');
  const modalCloseBtn = document.getElementById('modal-close-btn');

  function openSettingsModal() {
    if (settingsModal) settingsModal.style.display = 'flex';
  }

  function closeSettingsModal() {
    if (settingsModal) settingsModal.style.display = 'none';
  }

  if (settingsCogBtn) {
    settingsCogBtn.addEventListener('click', openSettingsModal);
  }

  if (modalCloseBtn) {
    modalCloseBtn.addEventListener('click', closeSettingsModal);
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        closeSettingsModal();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && settingsModal && settingsModal.style.display !== 'none') {
      closeSettingsModal();
    }
  });

  const shadowCanvasLayer = new ShadowCanvasLayer(map);

  let currentBbox = null;
  let currentPolygon = null;
  let currentSimulationData = null;
  let baseSimulationConfig = {
    gcr: 1.0,
    moduleEfficiency: 0.20,
    systemDerate: 0.80
  };

  let playbackEngine = null;
  let solarDashboard = null;

  const timeScrubber = new TimeScrubber(timelineScrubberMount, (index, metric) => {
    if (playbackEngine) {
      playbackEngine.setCurrentStep(index);
    }
    if (solarDashboard) {
      solarDashboard.updateTelemetry(metric, index);
    }

    if (currentSimulationData) {
      const meta = currentSimulationData.metadata;
      if (metric.is_daylight && metric.mask_index !== null && currentSimulationData.masks) {
        const maskStr = currentSimulationData.masks[metric.mask_index];
        const canopyMaskStr = currentSimulationData.canopy_masks ? currentSimulationData.canopy_masks[metric.mask_index] : null;
        shadowCanvasLayer.renderFrame(maskStr, meta.grid_rows, meta.grid_cols, canopyMaskStr);
      } else if (currentSimulationData.night_mask) {
        // Nighttime: render 100% shade inside the user's selected shape (polygon or rectangle)
        shadowCanvasLayer.renderFrame(
          currentSimulationData.night_mask,
          meta.grid_rows,
          meta.grid_cols,
          currentSimulationData.night_canopy_mask
        );
      } else {
        // Fallback: render shade masked to active polygon geometry
        shadowCanvasLayer.renderFullShade(meta.grid_rows, meta.grid_cols, currentPolygon, meta.patch_bounds_wgs84);
      }
    } else {
      shadowCanvasLayer.clear();
    }
  });

  solarDashboard = new SolarDashboard(energyMetricsMount, (seekIndex) => {
    timeScrubber.setStep(seekIndex);
  }, { chartContainer: timeScrubber.getPowerCurveMount() });

  playbackEngine = new PlaybackEngine(playbackControlsMount, (stepIndex) => {
    timeScrubber.setStep(stepIndex);
  });

  const pvConfigPanel = new PVConfigPanel(pvConfigModalMount, (newConfig) => {
    if (!currentSimulationData || !baseSimulationConfig) return;

    // If deployment mode or canopy settings changed, trigger a fresh simulation
    if (
      newConfig.deploymentMode !== baseSimulationConfig.deploymentMode ||
      newConfig.includeTreeCanopy !== baseSimulationConfig.includeTreeCanopy ||
      newConfig.canopyMode !== baseSimulationConfig.canopyMode
    ) {
      triggerSimulation();
      return;
    }

    // Real-time instantaneous local power recalculation without server roundtrip for slider changes
    const gcrRatio = newConfig.gcr / baseSimulationConfig.gcr;
    const effRatio = newConfig.moduleEfficiency / baseSimulationConfig.moduleEfficiency;
    const prRatio = newConfig.systemDerate / baseSimulationConfig.systemDerate;
    const scaleFactor = gcrRatio * effRatio * prRatio;

    solarDashboard.setScaleFactor(scaleFactor);
  }, { isModal: true });

  const toastContainer = document.getElementById('toast-container');
  const statusPill = document.querySelector('.brand-badge .pill');

  function showToast(message, type = 'warning', durationMs = 5000) {
    if (!toastContainer) return;
    const msgStr = (typeof message === 'object' && message !== null)
      ? (message.message || JSON.stringify(message))
      : String(message);

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <span>${msgStr}</span>
    `;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  let lastSimulationKey = null;

  async function triggerSimulation() {
    if (!currentBbox) return;
    const pvConfig = pvConfigPanel.getConfig();
    const date = dateSelector.getDate();

    const simKey = JSON.stringify({
      bbox: currentBbox,
      polygon: currentPolygon,
      date: date,
      deployment_mode: pvConfig.deploymentMode,
      include_tree_canopy: pvConfig.includeTreeCanopy,
      canopy_mode: pvConfig.canopyMode
    });

    if (lastSimulationKey === simKey && currentSimulationData) {
      return;
    }

    if (statusPill) {
      statusPill.innerHTML = `<span class="spinner" style="display: inline-block; vertical-align: middle; margin-right: 4px;"></span> Ray-marching...`;
    }

    let loadingPill = document.getElementById('sim-loading-pill');
    if (!loadingPill) {
      loadingPill = document.createElement('div');
      loadingPill.id = 'sim-loading-pill';
      loadingPill.className = 'sim-loading-pill';
      loadingPill.innerHTML = `<span class="spinner"></span> <span>Calculating GPU Terrain Shadows & Solar Power...</span>`;
      document.body.appendChild(loadingPill);
    } else {
      loadingPill.style.display = 'flex';
    }

    try {
      const payload = {
        bbox: {
          min_lon: currentBbox[0],
          min_lat: currentBbox[1],
          max_lon: currentBbox[2],
          max_lat: currentBbox[3]
        },
        polygon: currentPolygon || undefined,
        date: date,
        time_step_minutes: 1,
        deployment_mode: pvConfig.deploymentMode,
        module_efficiency: pvConfig.moduleEfficiency,
        system_derate: pvConfig.systemDerate,
        gcr: pvConfig.gcr,
        include_tree_canopy: pvConfig.includeTreeCanopy !== undefined ? pvConfig.includeTreeCanopy : true,
        canopy_mode: pvConfig.canopyMode || 'seasonal'
      };

      const data = await runSimulation(payload);
      currentSimulationData = data;
      baseSimulationConfig = {
        deploymentMode: data.metadata.deployment_mode,
        gcr: data.metadata.effective_gcr,
        moduleEfficiency: data.metadata.module_efficiency,
        systemDerate: data.metadata.system_derate,
        includeTreeCanopy: data.metadata.include_tree_canopy,
        canopyMode: data.metadata.canopy_mode
      };

      shadowCanvasLayer.setPatchBounds(data.metadata.patch_bounds_wgs84);
      solarDashboard.setSimulationData(data, 1.0);
      timeScrubber.setTimeseries(data.timeseries, data.daily_summary);
      playbackEngine.setSimulationContext(data.timeseries.length, data.metadata.time_step_minutes);
      lastSimulationKey = simKey;
    } catch (err) {
      console.warn('Simulation execution error:', err);
      showToast(err.message, 'warning');
    } finally {
      if (loadingPill) {
        loadingPill.remove();
      }
      if (statusPill) {
        statusPill.textContent = 'QC Solar 1m';
      }
    }
  }

  // Map camera state persistence (orientation: pitch, bearing, center; zoom)
  let cameraSaveTimeout = null;
  const persistCamera = () => {
    try {
      const center = map.getCenter();
      const zoom = map.getZoom();
      const pitch = map.getPitch();
      const bearing = map.getBearing();
      updateMapState({
        center: [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))],
        zoom: Number(zoom.toFixed(2)),
        pitch: Number(pitch.toFixed(1)),
        bearing: Number(bearing.toFixed(1))
      });
    } catch (e) {
      // Map may not be fully initialized or already destroyed
    }
  };

  map.on('moveend', persistCamera);
  map.on('rotateend', persistCamera);
  map.on('pitchend', persistCamera);

  map.on('move', () => {
    if (cameraSaveTimeout) clearTimeout(cameraSaveTimeout);
    cameraSaveTimeout = setTimeout(persistCamera, 400);
  });

  window.addEventListener('beforeunload', persistCamera);

  const dateSelector = new DateSelector(dateSelectorMount, savedState.date || '2026-06-21', () => {
    updateDateState(dateSelector.getDate());
    triggerSimulation();
  });

  const boxDrawer = new BoxDrawer(map, null, (selection) => {
    if (selection && selection.bbox) {
      currentBbox = selection.bbox;
      currentPolygon = selection.polygon || null;
      updateSelectionState({
        bbox: selection.bbox,
        polygon: selection.polygon,
        shapeType: selection.shapeType || (selection.isRectangle ? 'rectangle' : 'polygon')
      });
      triggerSimulation();
    } else {
      currentBbox = null;
      currentPolygon = null;
      lastSimulationKey = null;
      updateSelectionState(null);
      shadowCanvasLayer.clear();
      currentSimulationData = null;
      solarDashboard.setSimulationData(null);
    }
  });

  // Restore saved rectangle/oblong shape on initial startup if persisted
  if (savedState.selection) {
    boxDrawer.setSelection(savedState.selection);
  }

  new SavedViewsPanel({
    map,
    container: viewsPanelMount,
    boxDrawer,
    dateSelector,
    onRestoreView: (view) => {
      map.flyTo({
        center: view.center,
        zoom: view.zoom,
        pitch: view.pitch,
        bearing: view.bearing,
        essential: true,
        duration: 1200
      });

      if (view.date) {
        dateSelector.setDate(view.date, false);
        updateDateState(view.date);
      }

      if (view.polygon || view.bbox) {
        boxDrawer.setSelection({
          bbox: view.bbox,
          polygon: view.polygon,
          shapeType: view.shapeType || (view.detail && view.detail.includes('Rectangle') ? 'rectangle' : (view.polygon && view.polygon.length !== 5 ? 'polygon' : 'rectangle'))
        });
      } else {
        boxDrawer.clearSelection();
      }
    },
    showToast
  });

  new LayerToggle(map, topRightControls, {
    initialLayer: savedState.layer,
    onLayerChange: (layerId) => {
      updateLayerState(layerId);
    }
  });
}
