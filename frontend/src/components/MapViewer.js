/**
 * MapViewer Component
 * Initializes and manages the MapLibre GL JS map instance with OSM Street and ESRI Satellite raster layers.
 */

import maplibregl from 'maplibre-gl';
import { QUEBEC_CENTER, DEFAULT_ZOOM } from '../utils/stateStorage.js';

export { QUEBEC_CENTER, DEFAULT_ZOOM };

export function initMap(containerId = 'map', options = {}) {
  const center = options.center || QUEBEC_CENTER;
  const zoom = options.zoom !== undefined ? options.zoom : DEFAULT_ZOOM;
  const pitch = options.pitch !== undefined ? options.pitch : 0;
  const bearing = options.bearing !== undefined ? options.bearing : 0;
  const activeLayer = options.activeLayer === 'esri' ? 'esri' : 'osm';

  const style = {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
      },
      esri: {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.esri.com" target="_blank">Esri</a>, Maxar, Earthstar Geographics'
      }
    },
    layers: [
      {
        id: 'osm-layer',
        type: 'raster',
        source: 'osm',
        layout: { visibility: activeLayer === 'esri' ? 'none' : 'visible' },
        minzoom: 0
      },
      {
        id: 'esri-layer',
        type: 'raster',
        source: 'esri',
        layout: { visibility: activeLayer === 'esri' ? 'visible' : 'none' },
        minzoom: 0
      }
    ]
  };

  const map = new maplibregl.Map({
    container: containerId,
    style: style,
    center: center,
    zoom: zoom,
    maxPitch: 85,
    pitch: pitch,
    bearing: bearing
  });

  // Controls
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  return map;
}
