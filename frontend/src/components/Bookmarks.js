/**
 * Bookmarks Component
 * Provides one-click camera navigation to benchmark Quebec test locations.
 */

import { fetchLocations } from '../services/api.js';

export const PRESET_LOCATIONS = [
  {
    id: 'montreal',
    name: 'Montréal',
    detail: 'Édouard-Montpetit (Mount Royal)',
    center: [-73.618, 45.503],
    zoom: 16.2,
    pitch: 52,
    bearing: -35,
    sampleBbox: [-73.619, 45.504, -73.616, 45.506]
  },
  {
    id: 'sainte-lucie',
    name: 'Sainte-Lucie',
    detail: 'Chemin du Golf (Laurentians)',
    center: [-74.195, 46.136],
    zoom: 15.5,
    pitch: 56,
    bearing: 40,
    sampleBbox: [-74.197, 46.134, -74.194, 46.136]
  }
];

export class Bookmarks {
  constructor(map, container, onSelect) {
    this.map = map;
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.activeId = null;
    this.locations = [...PRESET_LOCATIONS];
    this.render();
    this.syncWithBackend();
  }

  async syncWithBackend() {
    try {
      const data = await fetchLocations();
      if (data && Array.isArray(data.locations)) {
        data.locations.forEach(serverLoc => {
          const match = this.locations.find(l => l.id === serverLoc.id);
          if (match) {
            match.is_cached = serverLoc.is_cached;
            if (serverLoc.bbox && !match.sampleBbox) {
              match.sampleBbox = serverLoc.bbox;
            }
          }
        });
      }
    } catch (_) {
      // Offline fallback: keep default PRESET_LOCATIONS
    }
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel bookmarks-group';
    this.element.style.display = 'inline-flex';
    this.element.style.padding = '3px';
    this.element.style.gap = '4px';

    PRESET_LOCATIONS.forEach(loc => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm bookmark-btn';
      btn.title = loc.detail;
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
          <circle cx="12" cy="10" r="3"></circle>
        </svg>
        <span>${loc.name}</span>
      `;

      btn.addEventListener('click', () => {
        this.selectLocation(loc);
      });

      this.element.appendChild(btn);
    });

    this.container.appendChild(this.element);
  }

  selectLocation(loc) {
    this.activeId = loc.id;
    Array.from(this.element.querySelectorAll('.bookmark-btn')).forEach((b, idx) => {
      if (PRESET_LOCATIONS[idx].id === loc.id) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    this.map.flyTo({
      center: loc.center,
      zoom: loc.zoom,
      pitch: loc.pitch,
      bearing: loc.bearing,
      essential: true,
      duration: 2200
    });

    this.onSelect(loc);
  }
}
