/**
 * Geocoder Component
 * Free address & city search via OpenStreetMap Nominatim bounded to Quebec.
 */

import maplibregl from 'maplibre-gl';

export const QUEBEC_VIEWBOX = '-79.76,44.99,-57.10,62.58';

export class Geocoder {
  constructor(map, container, onSelect) {
    this.map = map;
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.debounceTimeout = null;
    this.marker = null;
    this.render();
  }

  render() {
    this.wrapper = document.createElement('div');
    this.wrapper.className = 'glass-panel geocoder-wrapper';
    this.wrapper.style.position = 'relative';
    this.wrapper.style.display = 'flex';
    this.wrapper.style.alignItems = 'center';
    this.wrapper.style.padding = '3px 8px';
    this.wrapper.style.minWidth = '260px';

    this.wrapper.innerHTML = `
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--text-muted); margin-right: 6px;">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
      </svg>
      <input type="text" class="geocoder-input" placeholder="Search address or city in Quebec..." style="background: transparent; border: none; padding: 4px; width: 100%; font-size: 0.85rem; color: var(--text-primary); outline: none;" />
      <button class="geocoder-clear" style="display: none; background: transparent; border: none; color: var(--text-muted); cursor: pointer; padding: 2px;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
      <div class="geocoder-dropdown glass-panel" style="display: none; position: absolute; top: calc(100% + 6px); left: 0; right: 0; max-height: 240px; overflow-y: auto; z-index: 100; border-radius: 8px;"></div>
    `;

    this.input = this.wrapper.querySelector('.geocoder-input');
    this.clearBtn = this.wrapper.querySelector('.geocoder-clear');
    this.dropdown = this.wrapper.querySelector('.geocoder-dropdown');

    this.input.addEventListener('input', () => this.handleInput());
    this.clearBtn.addEventListener('click', () => {
      this.input.value = '';
      this.clearBtn.style.display = 'none';
      this.closeDropdown();
      if (this.marker) {
        this.marker.remove();
        this.marker = null;
      }
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (!this.wrapper.contains(e.target)) {
        this.closeDropdown();
      }
    });

    this.container.appendChild(this.wrapper);
  }

  handleInput() {
    const query = this.input.value.trim();
    if (!query) {
      this.clearBtn.style.display = 'none';
      this.closeDropdown();
      return;
    }

    this.clearBtn.style.display = 'block';
    clearTimeout(this.debounceTimeout);
    this.debounceTimeout = setTimeout(() => {
      this.search(query);
    }, 320);
  }

  async search(query) {
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.searchParams.set('q', query);
      url.searchParams.set('format', 'json');
      url.searchParams.set('countrycodes', 'ca');
      url.searchParams.set('viewbox', QUEBEC_VIEWBOX);
      url.searchParams.set('bounded', '1');
      url.searchParams.set('limit', '5');

      const response = await fetch(url.toString(), {
        headers: {
          'Accept-Language': 'fr,en'
        }
      });

      if (!response.ok) return;
      const data = await response.json();
      this.renderResults(data);
    } catch (err) {
      console.warn('Nominatim search failed:', err);
    }
  }

  renderResults(results) {
    this.dropdown.innerHTML = '';
    if (!results || results.length === 0) {
      this.dropdown.innerHTML = `
        <div style="padding: 10px 14px; font-size: 0.8rem; color: var(--text-muted);">
          No locations found in Quebec
        </div>
      `;
      this.dropdown.style.display = 'block';
      return;
    }

    results.forEach(res => {
      const item = document.createElement('div');
      item.className = 'geocoder-result-item';
      item.style.padding = '8px 12px';
      item.style.fontSize = '0.82rem';
      item.style.cursor = 'pointer';
      item.style.borderBottom = '1px solid rgba(255, 255, 255, 0.06)';
      item.style.display = 'flex';
      item.style.flexDirection = 'column';
      item.style.gap = '2px';

      const parts = res.display_name.split(',');
      const title = parts[0];
      const subtitle = parts.slice(1).join(',').trim();

      item.innerHTML = `
        <div style="font-weight: 600; color: var(--text-primary);">${title}</div>
        <div style="font-size: 0.72rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${subtitle}</div>
      `;

      item.addEventListener('mouseenter', () => {
        item.style.background = 'rgba(255, 255, 255, 0.08)';
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
      });

      item.addEventListener('click', () => {
        this.selectResult(res, title);
      });

      this.dropdown.appendChild(item);
    });

    this.dropdown.style.display = 'block';
  }

  selectResult(res, title) {
    const lon = parseFloat(res.lon);
    const lat = parseFloat(res.lat);
    this.input.value = title;
    this.closeDropdown();

    if (this.marker) {
      this.marker.remove();
    }

    this.marker = new maplibregl.Marker({ color: '#f59e0b' })
      .setLngLat([lon, lat])
      .setPopup(new maplibregl.Popup({ offset: 25 }).setText(res.display_name))
      .addTo(this.map);

    this.map.flyTo({
      center: [lon, lat],
      zoom: 16,
      pitch: 45,
      essential: true,
      duration: 2000
    });

    this.onSelect({
      name: title,
      fullName: res.display_name,
      lon,
      lat,
      bbox: res.boundingbox
    });
  }

  closeDropdown() {
    this.dropdown.style.display = 'none';
  }
}
