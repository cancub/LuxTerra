/**
 * LayerToggle Component
 * Provides a single toggle button to switch between OSM Street and ESRI Satellite tile layers.
 */

export class LayerToggle {
  constructor(map, container, options = {}) {
    this.map = map;
    this.container = container;
    this.activeLayer = options.initialLayer === 'esri' ? 'esri' : 'osm';
    this.onLayerChange = options.onLayerChange || (() => {});
    this.render();
  }

  render() {
    this.button = document.createElement('button');
    this.button.className = 'btn btn-sm layer-toggle-btn';
    this.button.style.userSelect = 'none';
    this.updateButtonUI();

    this.button.addEventListener('click', () => {
      this.toggle();
    });

    this.container.appendChild(this.button);
  }

  toggle() {
    const nextLayer = this.activeLayer === 'osm' ? 'esri' : 'osm';
    this.setLayer(nextLayer);
  }

  updateButtonUI() {
    if (this.activeLayer === 'esri') {
      this.button.classList.add('active');
      this.button.title = 'Current: Satellite Imagery. Click to switch to Street Map.';
      this.button.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="2" y1="12" x2="22" y2="12"></line>
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
        </svg>
        <span>Satellite</span>
      `;
    } else {
      this.button.classList.remove('active');
      this.button.title = 'Current: Street Map. Click to switch to Satellite Imagery.';
      this.button.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
          <line x1="8" y1="2" x2="8" y2="18"></line>
          <line x1="16" y1="6" x2="16" y2="22"></line>
        </svg>
        <span>Street</span>
      `;
    }
  }

  setLayer(layerId) {
    if (this.activeLayer === layerId) return;
    this.activeLayer = layerId;
    this.updateButtonUI();

    const apply = () => {
      if (!this.map.isStyleLoaded()) {
        this.map.once('load', apply);
        return;
      }
      try {
        if (layerId === 'osm') {
          this.map.setLayoutProperty('osm-layer', 'visibility', 'visible');
          this.map.setLayoutProperty('esri-layer', 'visibility', 'none');
        } else {
          this.map.setLayoutProperty('esri-layer', 'visibility', 'visible');
          this.map.setLayoutProperty('osm-layer', 'visibility', 'none');
        }
      } catch (err) {
        console.warn('Error applying layer visibility:', err);
      }
    };
    apply();

    this.onLayerChange(this.activeLayer);
  }
}
