/**
 * LuxTerra - Main Application Entrypoint
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
  const timelineScrubberMount = document.getElementById('timeline-scrubber-mount');

  const shadowCanvasLayer = new ShadowCanvasLayer(map);

  let currentSimulationData = null;

  const timeScrubber = new TimeScrubber(timelineScrubberMount, (index, metric) => {
    if (currentSimulationData && currentSimulationData.masks && metric.mask_index !== null) {
      const maskStr = currentSimulationData.masks[metric.mask_index];
      const meta = currentSimulationData.metadata;
      shadowCanvasLayer.renderFrame(maskStr, meta.grid_rows, meta.grid_cols);
    } else {
      shadowCanvasLayer.clear();
    }
  });

  const dateSelector = new DateSelector(dateSelectorMount, '2026-06-21', (newDate) => {
    console.log('Date changed to:', newDate);
  });

  const boxDrawer = new BoxDrawer(map, topRightControls, (selection) => {
    console.log('Selection complete:', selection);
  });

  new Geocoder(map, geocoderMount, (loc) => {
    console.log('Selected geocoder location:', loc.name);
  });

  new Bookmarks(map, topCenterControls, (preset) => {
    console.log('Selected preset:', preset.name);
    if (preset.sampleBbox) {
      boxDrawer.setBox(preset.sampleBbox);
    }
  });

  new LayerToggle(map, topRightControls);
}
