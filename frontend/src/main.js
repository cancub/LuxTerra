/**
 * LuxTerra - Main Application Entrypoint
 * Orchestrates MapLibre viewer, real-time GPU shadow projection, interactive box drawing,
 * 24-hour timeline scrubbing, and real-time PV generation telemetry.
 */

import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { initMap } from './components/MapViewer.js';
import { LayerToggle } from './components/LayerToggle.js';
import { Bookmarks } from './components/Bookmarks.js';
import { Geocoder } from './components/Geocoder.js';
import { BoxDrawer } from './components/BoxDrawer.js';
import { ShadowCanvasLayer } from './components/ShadowCanvasLayer.js';
import { DateSelector } from './components/DateSelector.js';
import { TimeScrubber } from './components/TimeScrubber.js';
import { PlaybackEngine } from './components/PlaybackEngine.js';
import { PVConfigPanel } from './components/PVConfigPanel.js';
import { SolarDashboard } from './components/SolarDashboard.js';
import { runSimulation } from './services/api.js';

const appContainer = document.getElementById('app');
if (appContainer) {
  appContainer.innerHTML = `
    <div id="map"></div>
    <div class="top-bar">
      <div class="top-left-group" style="display: flex; align-items: center; gap: 10px;">
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
        <div id="geocoder-mount"></div>
      </div>
      <div class="top-center-controls" id="top-center-controls"></div>
      <div class="top-right-controls" id="top-right-controls"></div>
    </div>

    <!-- Notification Toasts -->
    <div class="toast-container" id="toast-container"></div>

    <!-- Floating Right Sidebar Dock -->
    <div class="right-dock" id="right-dock">
      <div id="solar-dashboard-mount"></div>
    </div>

    <!-- Bottom Timeline Dock -->
    <div class="bottom-dock" id="bottom-dock">
      <div class="timeline-controls-row" id="timeline-controls-row">
        <div id="date-selector-mount"></div>
        <div id="playback-controls-mount"></div>
      </div>
      <div id="timeline-scrubber-mount" style="width: 100%; display: flex; justify-content: center;"></div>
    </div>
  `;

  const map = initMap('map');
  const geocoderMount = document.getElementById('geocoder-mount');
  const topCenterControls = document.getElementById('top-center-controls');
  const topRightControls = document.getElementById('top-right-controls');
  const dateSelectorMount = document.getElementById('date-selector-mount');
  const playbackControlsMount = document.getElementById('playback-controls-mount');
  const timelineScrubberMount = document.getElementById('timeline-scrubber-mount');
  const solarDashboardMount = document.getElementById('solar-dashboard-mount');

  const shadowCanvasLayer = new ShadowCanvasLayer(map);

  let currentBbox = null;
  let currentSimulationData = null;
  let baseSimulationConfig = {
    gcr: 1.0,
    moduleEfficiency: 0.20,
    systemDerate: 0.80
  };

  const solarDashboard = new SolarDashboard(solarDashboardMount, (seekIndex) => {
    timeScrubber.setStep(seekIndex);
  });

  const pvConfigPanel = new PVConfigPanel(solarDashboard.getPVConfigMount(), (newConfig) => {
    if (!currentSimulationData) return;
    // Real-time instantaneous local power recalculation without server roundtrip
    const gcrRatio = newConfig.gcr / baseSimulationConfig.gcr;
    const effRatio = newConfig.moduleEfficiency / baseSimulationConfig.moduleEfficiency;
    const prRatio = newConfig.systemDerate / baseSimulationConfig.systemDerate;
    const scaleFactor = gcrRatio * effRatio * prRatio;

    solarDashboard.setScaleFactor(scaleFactor);
  });

  const timeScrubber = new TimeScrubber(timelineScrubberMount, (index, metric) => {
    if (playbackEngine) {
      playbackEngine.setCurrentStep(index);
    }
    solarDashboard.updateTelemetry(metric, index);

    if (currentSimulationData) {
      const meta = currentSimulationData.metadata;
      if (metric.is_daylight && metric.mask_index !== null && currentSimulationData.masks) {
        const maskStr = currentSimulationData.masks[metric.mask_index];
        shadowCanvasLayer.renderFrame(maskStr, meta.grid_rows, meta.grid_cols);
      } else {
        // Nighttime or sun below horizon: 100% full shade across the entire selected rectangle
        shadowCanvasLayer.renderFullShade(meta.grid_rows, meta.grid_cols);
      }
    } else {
      shadowCanvasLayer.clear();
    }
  });

  const playbackEngine = new PlaybackEngine(playbackControlsMount, (stepIndex) => {
    timeScrubber.setStep(stepIndex);
  });

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

  async function triggerSimulation() {
    if (!currentBbox) return;
    const pvConfig = pvConfigPanel.getConfig();
    const date = dateSelector.getDate();

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
        date: date,
        time_step_minutes: 5,
        deployment_mode: pvConfig.deploymentMode,
        module_efficiency: pvConfig.moduleEfficiency,
        system_derate: pvConfig.systemDerate,
        gcr: pvConfig.gcr
      };

      const data = await runSimulation(payload);
      currentSimulationData = data;
      baseSimulationConfig = {
        gcr: data.metadata.effective_gcr,
        moduleEfficiency: data.metadata.module_efficiency,
        systemDerate: data.metadata.system_derate
      };

      shadowCanvasLayer.setPatchBounds(data.metadata.patch_bounds_wgs84);
      solarDashboard.setSimulationData(data, 1.0);
      timeScrubber.setTimeseries(data.timeseries, data.daily_summary);
      playbackEngine.setSimulationContext(data.timeseries.length, data.metadata.time_step_minutes);
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

  const dateSelector = new DateSelector(dateSelectorMount, '2026-06-21', () => {
    triggerSimulation();
  });

  const boxDrawer = new BoxDrawer(map, topRightControls, (selection) => {
    currentBbox = selection.bbox;
    triggerSimulation();
  });

  new Geocoder(map, geocoderMount, (loc) => {
    console.log('Selected geocoder location:', loc.name);
  });

  new Bookmarks(map, topCenterControls, (preset) => {
    if (preset.sampleBbox) {
      boxDrawer.setBox(preset.sampleBbox);
    }
  });

  new LayerToggle(map, topRightControls);
}
