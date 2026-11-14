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
import { ShapeToolbar } from './components/ShapeToolbar.js';
import { ShadowCanvasLayer } from './components/ShadowCanvasLayer.js';
import { DateSelector } from './components/DateSelector.js';
import { TimeScrubber } from './components/TimeScrubber.js';
import { PlaybackEngine } from './components/PlaybackEngine.js';
import { PVConfigPanel } from './components/PVConfigPanel.js';
import { SolarDashboard } from './components/SolarDashboard.js';
import { SolarPanel3DLayer } from './components/SolarPanel3DLayer.js';
import { rasterizePanelShadowMask, base64ToBytes, decodeBitmask } from './utils/maskDecoder.js';
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
      <div class="top-left-column">
        <div class="glass-panel top-command-bar">
          <div class="brand-badge-inline">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
          </div>
          <div class="command-divider"></div>
          <div id="shape-toolbar-primary-mount"></div>
          <div class="command-divider"></div>
          <button id="settings-cog-btn" class="command-nav-btn command-icon-btn" title="PV System Configuration" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
        </div>
        <div id="shape-toolbar-mount"></div>
      </div>
      <div class="top-right-controls" id="top-right-controls"></div>
    </div>

    <!-- Notification Toasts -->
    <div class="toast-container" id="toast-container"></div>

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
  const shapeToolbarMount = document.getElementById('shape-toolbar-mount');
  const topRightControls = document.getElementById('top-right-controls');
  const dateSelectorMount = document.getElementById('date-selector-mount');
  const playbackControlsMount = document.getElementById('playback-controls-mount');
  const timelineScrubberMount = document.getElementById('timeline-scrubber-mount');
  const energyMetricsMount = document.getElementById('energy-metrics-mount');
  const settingsCogBtn = document.getElementById('settings-cog-btn');
  const settingsMount = document.createElement('div');
  settingsMount.className = 'settings-card-mount';

  const shadowCanvasLayer = new ShadowCanvasLayer(map);
  const solarPanel3DLayer = new SolarPanel3DLayer();

  const addSolarPanelLayer = () => {
    if (map.getLayer(solarPanel3DLayer.id)) return;
    const beforeId = map.getLayer('draw-box-stroke') ? 'draw-box-stroke' : undefined;
    try {
      map.addLayer(solarPanel3DLayer, beforeId);
    } catch (err) {
      console.warn('Failed to add SolarPanel3DLayer:', err);
    }
  };

  if (map.isStyleLoaded()) {
    addSolarPanelLayer();
  } else {
    map.once('load', addSolarPanelLayer);
  }

  let currentBbox = null;
  let currentPolygon = null;
  let currentContextBbox = null;
  let currentSimulationData = null;
  let currentChmBytes = null;
  let currentOutsideMaskBytes = null;
  let activeBaseLayer = savedState.layer === 'esri' ? 'esri' : 'osm';
  let baseSimulationConfig = {
    gcr: 1.0,
    moduleEfficiency: 0.20,
    systemDerate: 0.80
  };

  let playbackEngine = null;
  let solarDashboard = null;
  let pendingRenderRafId = null;
  let latestScrubMetric = null;

  const renderScrubFrame = () => {
    pendingRenderRafId = null;
    const metric = latestScrubMetric;
    if (!metric || !currentSimulationData) return;

    const meta = currentSimulationData.metadata;
    if (metric.is_daylight && metric.mask_index !== null && currentSimulationData.masks) {
      const isSatellite = activeBaseLayer === 'esri';
      const maskStr = isSatellite
        ? ((currentSimulationData.visual_masks && currentSimulationData.visual_masks[metric.mask_index]) || currentSimulationData.masks[metric.mask_index])
        : currentSimulationData.masks[metric.mask_index];
      const canopyMaskStr = isSatellite
        ? ((currentSimulationData.visual_canopy_masks && currentSimulationData.visual_canopy_masks[metric.mask_index]) || (currentSimulationData.canopy_masks ? currentSimulationData.canopy_masks[metric.mask_index] : null))
        : (currentSimulationData.canopy_masks ? currentSimulationData.canopy_masks[metric.mask_index] : null);

      const canopyShadeStr = isSatellite
        ? (currentSimulationData.canopy_shade_levels ? currentSimulationData.canopy_shade_levels[metric.mask_index] : null)
        : ((currentSimulationData.ground_canopy_shade_levels && currentSimulationData.ground_canopy_shade_levels[metric.mask_index])
          || (currentSimulationData.canopy_shade_levels ? currentSimulationData.canopy_shade_levels[metric.mask_index] : null));

      let panelShadowBytes = null;
      if (solarPanel3DLayer.isVisible() && currentSimulationData.layout) {
        panelShadowBytes = rasterizePanelShadowMask(
          currentSimulationData.layout,
          metric.solar_azimuth_deg,
          metric.solar_elevation_deg,
          meta.patch_bounds_wgs84,
          meta.grid_rows,
          meta.grid_cols,
          isSatellite ? currentChmBytes : null,
          currentOutsideMaskBytes
        );
      }

      shadowCanvasLayer.renderFrame(maskStr, meta.grid_rows, meta.grid_cols, canopyMaskStr, panelShadowBytes, canopyShadeStr);
      solarPanel3DLayer.updateSunPosition(
        metric.solar_azimuth_deg,
        metric.solar_elevation_deg,
        true,
        maskStr,
        canopyMaskStr,
        meta.patch_bounds_wgs84,
        meta.grid_rows,
        meta.grid_cols,
        metric,
        currentSimulationData.canopy_transmittance !== undefined ? currentSimulationData.canopy_transmittance : (meta.canopy_transmittance || 0.15)
      );
    } else if (currentSimulationData.night_mask) {
      // Nighttime: render 100% shade inside the user's selected shape (polygon or rectangle)
      shadowCanvasLayer.renderFrame(
        currentSimulationData.night_mask,
        meta.grid_rows,
        meta.grid_cols,
        currentSimulationData.night_canopy_mask
      );
      solarPanel3DLayer.updateSunPosition(
        metric.solar_azimuth_deg,
        metric.solar_elevation_deg,
        false,
        null,
        null,
        null,
        0,
        0,
        metric
      );
    } else {
      // Fallback: render shade masked to active polygon geometry
      shadowCanvasLayer.renderFullShade(meta.grid_rows, meta.grid_cols, currentPolygon, meta.patch_bounds_wgs84);
      solarPanel3DLayer.updateSunPosition(
        metric.solar_azimuth_deg,
        metric.solar_elevation_deg,
        false,
        null,
        null,
        null,
        0,
        0,
        metric
      );
    }
  };

  const timeScrubber = new TimeScrubber(timelineScrubberMount, (index, metric) => {
    if (playbackEngine) {
      playbackEngine.setCurrentStep(index);
    }
    if (solarDashboard) {
      solarDashboard.updateTelemetry(metric, index);
    }

    if (currentSimulationData) {
      latestScrubMetric = metric;
      if (pendingRenderRafId === null) {
        pendingRenderRafId = requestAnimationFrame(renderScrubFrame);
      }
    } else {
      if (pendingRenderRafId !== null) {
        cancelAnimationFrame(pendingRenderRafId);
        pendingRenderRafId = null;
      }
      shadowCanvasLayer.clear();
    }
  });

  const dailyEnergyMount = document.createElement('div');
  dailyEnergyMount.className = 'daily-energy-mount';

  solarDashboard = new SolarDashboard(energyMetricsMount, (seekIndex) => {
    timeScrubber.setStep(seekIndex);
  }, {
    chartContainer: timeScrubber.getPowerCurveMount(),
    dailyEnergyContainer: dailyEnergyMount
  });

  solarPanel3DLayer.setOnPanelHover((panel, breakdown) => {
    if (panel && breakdown) {
      solarDashboard.showPanelTelemetry(panel, breakdown);
    } else {
      solarDashboard.clearPanelTelemetry();
    }
  });

  map.on('mousemove', (e) => {
    if (!solarPanel3DLayer || !solarPanel3DLayer.isVisible()) return;
    if (map.isMoving() || (boxDrawer && boxDrawer.isDrawingActive)) {
      solarPanel3DLayer.setHoveredPanel(null);
      return;
    }
    const canvas = map.getCanvas();
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const panel = solarPanel3DLayer.findPanelAtPoint(e.point.x, e.point.y, width, height);
    solarPanel3DLayer.setHoveredPanel(panel);
  });

  map.on('mouseout', () => {
    if (solarPanel3DLayer) {
      solarPanel3DLayer.setHoveredPanel(null);
    }
  });

  playbackEngine = new PlaybackEngine(playbackControlsMount, (stepIndex) => {
    timeScrubber.setStep(stepIndex);
  });

  const pvConfigPanel = new PVConfigPanel(settingsMount, (newConfig) => {
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
      <span class="toast-msg"></span>
    `;
    toast.querySelector('.toast-msg').textContent = msgStr;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, durationMs);
  }

  let lastSimulationKey = null;
  let activeSimulationAbort = null;
  let latestSimulationSeqId = 0;
  const MAX_SIM_CACHE_SIZE = 12;
  const simulationCache = new Map();

  function getCachedSimulation(key) {
    if (!simulationCache.has(key)) return null;
    const cached = simulationCache.get(key);
    simulationCache.delete(key);
    simulationCache.set(key, cached);
    return cached;
  }

  function setCachedSimulation(key, data) {
    if (simulationCache.has(key)) {
      simulationCache.delete(key);
    }
    simulationCache.set(key, data);
    if (simulationCache.size > MAX_SIM_CACHE_SIZE) {
      const oldestKey = simulationCache.keys().next().value;
      simulationCache.delete(oldestKey);
    }
  }

  function clearSimulationLoadingUI() {
    const loadingPill = document.getElementById('sim-loading-pill');
    if (loadingPill) {
      loadingPill.remove();
    }
    if (statusPill) {
      statusPill.textContent = 'QC Solar 1m';
    }
  }

  function applySimulationData(data, simKey) {
    currentSimulationData = data;
    currentChmBytes = data.chm_base64 ? base64ToBytes(data.chm_base64) : null;
    currentOutsideMaskBytes = (data.night_mask && !currentContextBbox)
      ? decodeBitmask(data.night_mask, data.metadata.grid_rows, data.metadata.grid_cols)
      : null;
    baseSimulationConfig = {
      deploymentMode: data.metadata.deployment_mode,
      gcr: data.metadata.effective_gcr,
      moduleEfficiency: data.metadata.module_efficiency,
      systemDerate: data.metadata.system_derate,
      includeTreeCanopy: data.metadata.include_tree_canopy,
      canopyMode: data.metadata.canopy_mode
    };

    shadowCanvasLayer.setPatchBounds(data.metadata.patch_bounds_wgs84);
    solarPanel3DLayer.setLayout(data.layout);
    solarDashboard.setSimulationData(data, 1.0);
    timeScrubber.setTimeseries(data.timeseries, data.daily_summary);
    playbackEngine.setSimulationContext(data.timeseries.length, data.metadata.time_step_minutes);
    lastSimulationKey = simKey;
  }

  function roundCoord5(n) {
    return Number(Number(n).toFixed(5));
  }

  function normalizeBboxKey(bbox) {
    return Array.isArray(bbox) ? bbox.map(roundCoord5) : null;
  }

  function normalizePolygonKey(polygon) {
    return Array.isArray(polygon) ? polygon.map(pt => [roundCoord5(pt[0]), roundCoord5(pt[1])]) : null;
  }

  async function triggerSimulation() {
    if (!currentBbox) return;
    const seqId = ++latestSimulationSeqId;

    // Always cancel any in-flight request first so rapid Undo/Redo (e.g. A -> B -> A)
    // cannot let an older request overwrite the latest selection.
    if (activeSimulationAbort) {
      activeSimulationAbort.abort();
      activeSimulationAbort = null;
    }

    const pvConfig = pvConfigPanel.getConfig();
    const date = dateSelector.getDate();

    const simKey = JSON.stringify({
      bbox: normalizeBboxKey(currentBbox),
      polygon: normalizePolygonKey(currentPolygon),
      contextBbox: normalizeBboxKey(currentContextBbox),
      date: date,
      deployment_mode: pvConfig.deploymentMode,
      module_efficiency: pvConfig.moduleEfficiency,
      system_derate: pvConfig.systemDerate,
      gcr: pvConfig.gcr,
      include_tree_canopy: pvConfig.includeTreeCanopy,
      canopy_mode: pvConfig.canopyMode
    });

    if (lastSimulationKey === simKey && currentSimulationData) {
      clearSimulationLoadingUI();
      return;
    }

    const cachedData = getCachedSimulation(simKey);
    if (cachedData) {
      clearSimulationLoadingUI();
      applySimulationData(cachedData, simKey);
      return;
    }

    const abortController = new AbortController();
    activeSimulationAbort = abortController;

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
        context_bbox: currentContextBbox ? {
          min_lon: currentContextBbox[0],
          min_lat: currentContextBbox[1],
          max_lon: currentContextBbox[2],
          max_lat: currentContextBbox[3]
        } : undefined,
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

      const data = await runSimulation(payload, abortController.signal);
      if (abortController.signal.aborted || seqId !== latestSimulationSeqId) return;
      setCachedSimulation(simKey, data);
      applySimulationData(data, simKey);
    } catch (err) {
      if (err.name === 'AbortError' || seqId !== latestSimulationSeqId) return;
      console.warn('Simulation execution error:', err);
      showToast(err.message, 'warning');
    } finally {
      if (seqId === latestSimulationSeqId || activeSimulationAbort === abortController) {
        if (activeSimulationAbort === abortController) {
          activeSimulationAbort = null;
        }
        if (seqId === latestSimulationSeqId) {
          clearSimulationLoadingUI();
        }
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
      currentContextBbox = selection.contextBbox || null;
      updateSelectionState({
        bbox: selection.bbox,
        polygon: selection.polygon,
        contextBbox: selection.contextBbox,
        shapeType: 'polygon'
      });
      triggerSimulation();
    } else {
      latestSimulationSeqId++;
      if (activeSimulationAbort) {
        activeSimulationAbort.abort();
        activeSimulationAbort = null;
      }
      clearSimulationLoadingUI();
      if (playbackEngine) {
        playbackEngine.pause();
      }
      currentBbox = null;
      currentPolygon = null;
      currentContextBbox = null;
      lastSimulationKey = null;
      updateSelectionState(null);
      shadowCanvasLayer.clear();
      solarPanel3DLayer.clear();
      currentSimulationData = null;
      currentChmBytes = null;
      currentOutsideMaskBytes = null;
      if (timeScrubber) {
        timeScrubber.setTimeseries([]);
      }
      solarDashboard.setSimulationData(null);
    }
  });

  // Restore saved rectangle/oblong shape on initial startup if persisted
  if (savedState.selection) {
    boxDrawer.setSelection(savedState.selection);
  }

  new ShapeToolbar({
    map,
    container: shapeToolbarMount,
    primaryContainer: document.getElementById('shape-toolbar-primary-mount'),
    dailyEnergyMount,
    settingsMount,
    settingsBtn: settingsCogBtn,
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
          contextBbox: view.contextBbox || null,
          shapeType: 'polygon'
        });
      } else {
        boxDrawer.clearSelection();
      }
    },
    showToast
  });
  boxDrawer.notifyState();

  // 3D Solar Panels Toggle Button
  const panelsToggleBtn = document.createElement('button');
  panelsToggleBtn.id = 'panels-toggle-btn';
  panelsToggleBtn.className = 'btn btn-sm panels-toggle-btn active';
  panelsToggleBtn.title = 'Current: 3D Solar Panels Visible. Click to Hide.';
  panelsToggleBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="20" height="14" rx="2"></rect>
      <line x1="2" y1="10" x2="22" y2="10"></line>
      <line x1="12" y1="3" x2="12" y2="17"></line>
      <path d="M4 21l3-4"></path>
      <path d="M20 21l-3-4"></path>
      <path d="M12 17v4"></path>
    </svg>
    <span>3D Panels</span>
  `;
  panelsToggleBtn.addEventListener('click', () => {
    const isNowVisible = !solarPanel3DLayer.isVisible();
    solarPanel3DLayer.setVisible(isNowVisible);
    if (isNowVisible) {
      panelsToggleBtn.classList.add('active');
      panelsToggleBtn.title = 'Current: 3D Solar Panels Visible. Click to Hide.';
    } else {
      panelsToggleBtn.classList.remove('active');
      panelsToggleBtn.title = 'Current: 3D Solar Panels Hidden. Click to Show.';
      solarPanel3DLayer.setHoveredPanel(null);
      solarDashboard.clearPanelTelemetry();
    }
    if (timeScrubber && currentSimulationData) {
      const curIdx = timeScrubber.currentIndex !== undefined ? timeScrubber.currentIndex : 0;
      timeScrubber.setStep(curIdx);
    }
  });

  if (topRightControls) {
    topRightControls.appendChild(panelsToggleBtn);
  }

  new LayerToggle(map, topRightControls, {
    initialLayer: savedState.layer,
    onLayerChange: (layerId) => {
      activeBaseLayer = layerId;
      updateLayerState(layerId);
      if (timeScrubber && currentSimulationData) {
        const curIdx = timeScrubber.currentIndex !== undefined ? timeScrubber.currentIndex : 0;
        timeScrubber.setStep(curIdx);
      }
    }
  });
}
