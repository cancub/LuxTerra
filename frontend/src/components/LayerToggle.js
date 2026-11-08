/**
 * LayerToggle Component
 * Provides seamless toggle between OSM Street and ESRI Satellite tile layers.
 */

export class LayerToggle {
  constructor(map, container) {
    this.map = map;
    this.container = container;
    this.activeLayer = 'osm'; // 'osm' or 'esri'
    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel layer-toggle-group';
    this.element.style.display = 'inline-flex';
    this.element.style.padding = '3px';
    this.element.style.gap = '3px';

    this.osmBtn = document.createElement('button');
    this.osmBtn.className = 'btn btn-sm active';
    this.osmBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"></polygon>
        <line x1="8" y1="2" x2="8" y2="18"></line>
        <line x1="16" y1="6" x2="16" y2="22"></line>
      </svg>
      <span>Street</span>
    `;

    this.esriBtn = document.createElement('button');
    this.esriBtn.className = 'btn btn-sm';
    this.esriBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="2" y1="12" x2="22" y2="12"></line>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
      </svg>
      <span>Satellite</span>
    `;

    this.osmBtn.addEventListener('click', () => this.setLayer('osm'));
    this.esriBtn.addEventListener('click', () => this.setLayer('esri'));

    this.element.appendChild(this.osmBtn);
    this.element.appendChild(this.esriBtn);
    this.container.appendChild(this.element);
  }

  setLayer(layerId) {
    if (this.activeLayer === layerId) return;
    this.activeLayer = layerId;

    if (layerId === 'osm') {
      this.osmBtn.classList.add('active');
      this.esriBtn.classList.remove('active');
      this.map.setLayoutProperty('osm-layer', 'visibility', 'visible');
      this.map.setLayoutProperty('esri-layer', 'visibility', 'none');
    } else {
      this.esriBtn.classList.add('active');
      this.osmBtn.classList.remove('active');
      this.map.setLayoutProperty('esri-layer', 'visibility', 'visible');
      this.map.setLayoutProperty('osm-layer', 'visibility', 'none');
    }
  }
}
