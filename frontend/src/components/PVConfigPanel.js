/**
 * PVConfigPanel Component
 * Interactive PV system configuration subsection embedded within the Solar & PV Studio card.
 * Controls Rooftop (100% GCR) vs Ground-Mount (45% GCR) deployment modes and live parameter tuning.
 */

export const PV_DEPLOYMENT_MODE_KEY = 'luxterra_deployment_mode';

export class PVConfigPanel {
  constructor(container, onConfigChange = () => {}) {
    this.container = container;
    this.onConfigChange = onConfigChange;

    let savedMode = null;
    try {
      if (typeof localStorage !== 'undefined') {
        savedMode = localStorage.getItem(PV_DEPLOYMENT_MODE_KEY);
      }
    } catch (e) {}

    this.deploymentMode = (savedMode === 'rooftop' || savedMode === 'ground_mount') ? savedMode : 'ground_mount';
    this.moduleEfficiency = 0.20; // 20%
    this.systemDerate = 0.80; // 80%
    this.gcr = this.deploymentMode === 'rooftop' ? 1.0 : 0.45; // 45% for ground-mount, 100% for rooftop
    this.includeTreeCanopy = true; // Enabled by default per user request
    this.canopyMode = 'seasonal'; // Seasonal Auto by default per user request
    this.isCollapsed = true; // Collapsed by default

    this.render();
  }

  get effectiveGCR() {
    return this.deploymentMode === 'rooftop' ? 1.0 : 0.45;
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'pv-config-section';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '8px';
    this.element.style.width = '100%';

    this.element.innerHTML = `
      <!-- Collapsible Section Header -->
      <div class="pv-config-header" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;">
        <span style="font-weight: 600; font-size: 0.82rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-solar);">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          <span>PV System Configuration</span>
        </span>
        <button class="pv-collapse-btn" title="Toggle PV Configuration" style="background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border-card); border-radius: 4px; color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0;">
          <svg class="pv-chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transform: rotate(180deg); transition: transform 0.2s ease;">
            <polyline points="18 15 12 9 6 15"></polyline>
          </svg>
        </button>
      </div>

      <!-- Collapsible Body (Hidden by default) -->
      <div class="pv-config-body" style="display: none; flex-direction: column; gap: 10px; margin-top: 4px;">
        <!-- Deployment Mode Toggle -->
        <div class="pv-mode-selector" style="display: flex; background: rgba(0, 0, 0, 0.3); padding: 3px; border-radius: 8px; border: 1px solid var(--border-card);">
          <button class="btn btn-sm mode-btn mode-rooftop ${this.deploymentMode === 'rooftop' ? 'active' : ''}" data-mode="rooftop" style="flex: 1; justify-content: center; font-size: 0.76rem; padding: 5px 8px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
            </svg>
            <span>Rooftop (100% GCR)</span>
          </button>
          <button class="btn btn-sm mode-btn mode-ground ${this.deploymentMode === 'ground_mount' ? 'active' : ''}" data-mode="ground_mount" style="flex: 1; justify-content: center; font-size: 0.76rem; padding: 5px 8px;">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
              <line x1="8" y1="21" x2="16" y2="21"></line>
              <line x1="12" y1="17" x2="12" y2="21"></line>
            </svg>
            <span>Ground-Mount (45% GCR)</span>
          </button>
        </div>

        <!-- Efficiency & PR Sliders -->
        <div class="pv-accordion" style="display: flex; flex-direction: column; gap: 6px; font-size: 0.78rem;">
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="color: var(--text-secondary);">Module Efficiency (η):</span>
            <span class="efficiency-val" style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-solar);">20.0%</span>
          </div>
          <input type="range" class="efficiency-slider" min="15" max="24" step="0.5" value="20" style="width: 100%; accent-color: var(--accent-solar); cursor: pointer; height: 6px;" />

          <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
            <span style="color: var(--text-secondary);">Performance Ratio (PR):</span>
            <span class="derate-val" style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-solar);">80%</span>
          </div>
          <input type="range" class="derate-slider" min="60" max="95" step="1" value="80" style="width: 100%; accent-color: var(--accent-solar); cursor: pointer; height: 6px;" />
        </div>

        <!-- Tree Canopy Shading Section -->
        <div style="border-top: 1px solid var(--border-card); padding-top: 8px; margin-top: 2px; display: flex; flex-direction: column; gap: 8px;">
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <span style="font-weight: 600; font-size: 0.80rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
              <span>🌲 Tree Canopy Shading</span>
            </span>
            <label class="canopy-toggle-switch">
              <input type="checkbox" class="canopy-toggle-input" ${this.includeTreeCanopy ? 'checked' : ''}>
              <span class="canopy-toggle-slider"></span>
            </label>
          </div>

          <!-- Foliage Mode Selector -->
          <div class="canopy-mode-container" style="display: flex; flex-direction: column; gap: 4px; ${this.includeTreeCanopy ? '' : 'opacity: 0.45; pointer-events: none;'}">
            <span style="font-size: 0.74rem; color: var(--text-secondary);">Canopy Foliage Mode:</span>
            <select class="canopy-mode-select" style="width: 100%; background: rgba(0,0,0,0.3); color: var(--text-primary); border: 1px solid var(--border-card); border-radius: 6px; padding: 4px 8px; font-size: 0.76rem; cursor: pointer;">
              <option value="seasonal" ${this.canopyMode === 'seasonal' ? 'selected' : ''}>Auto (Seasonal Phenology)</option>
              <option value="leaf_on" ${this.canopyMode === 'leaf_on' ? 'selected' : ''}>Dense Summer (Leaf-On, 15% τ)</option>
              <option value="leaf_off" ${this.canopyMode === 'leaf_off' ? 'selected' : ''}>Bare Winter (Leaf-Off, 60% τ)</option>
              <option value="bare_terrain" ${this.canopyMode === 'bare_terrain' ? 'selected' : ''}>Bare Terrain Only (Canopy Ignored)</option>
            </select>
          </div>
        </div>
      </div>
    `;

    this.header = this.element.querySelector('.pv-config-header');
    this.body = this.element.querySelector('.pv-config-body');
    this.chevron = this.element.querySelector('.pv-chevron-icon');

    if (this.body) {
      this.body.style.display = 'none';
    }

    this.modeButtons = this.element.querySelectorAll('.mode-btn');
    this.efficiencySlider = this.element.querySelector('.efficiency-slider');
    this.efficiencyVal = this.element.querySelector('.efficiency-val');
    this.derateSlider = this.element.querySelector('.derate-slider');
    this.derateVal = this.element.querySelector('.derate-val');
    this.canopyToggle = this.element.querySelector('.canopy-toggle-input');
    this.canopyModeSelect = this.element.querySelector('.canopy-mode-select');
    this.canopyModeContainer = this.element.querySelector('.canopy-mode-container');

    this.modeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const mode = e.currentTarget.dataset.mode;
        this.setMode(mode);
      });
    });

    this.efficiencySlider.addEventListener('input', (e) => {
      this.moduleEfficiency = parseFloat(e.target.value) / 100.0;
      this.efficiencyVal.textContent = `${parseFloat(e.target.value).toFixed(1)}%`;
      this.notifyChange();
    });

    this.derateSlider.addEventListener('input', (e) => {
      this.systemDerate = parseFloat(e.target.value) / 100.0;
      this.derateVal.textContent = `${parseInt(e.target.value, 10)}%`;
      this.notifyChange();
    });

    if (this.canopyToggle) {
      this.canopyToggle.addEventListener('change', (e) => {
        this.includeTreeCanopy = e.target.checked;
        if (this.canopyModeContainer) {
          this.canopyModeContainer.style.opacity = this.includeTreeCanopy ? '1.0' : '0.45';
          this.canopyModeContainer.style.pointerEvents = this.includeTreeCanopy ? 'auto' : 'none';
        }
        this.notifyChange();
      });
    }

    if (this.canopyModeSelect) {
      this.canopyModeSelect.addEventListener('change', (e) => {
        this.canopyMode = e.target.value;
        this.notifyChange();
      });
    }

    if (this.header) {
      this.header.addEventListener('click', () => {
        this.toggleCollapse();
      });
    }

    this.container.appendChild(this.element);
  }

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.body.style.display = 'none';
      this.chevron.style.transform = 'rotate(180deg)';
    } else {
      this.body.style.display = 'flex';
      this.chevron.style.transform = 'rotate(0deg)';
      if (typeof this.element.scrollIntoView === 'function') {
        setTimeout(() => {
          this.element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 50);
      }
    }
  }

  setMode(mode) {
    if (this.deploymentMode === mode) return;
    this.deploymentMode = mode;
    this.gcr = this.effectiveGCR;

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PV_DEPLOYMENT_MODE_KEY, mode);
      }
    } catch (e) {}

    this.modeButtons.forEach(b => {
      if (b.dataset.mode === mode) {
        b.classList.add('active');
      } else {
        b.classList.remove('active');
      }
    });

    this.notifyChange();
  }

  notifyChange() {
    this.onConfigChange({
      deploymentMode: this.deploymentMode,
      gcr: this.gcr,
      moduleEfficiency: this.moduleEfficiency,
      systemDerate: this.systemDerate,
      includeTreeCanopy: this.includeTreeCanopy,
      canopyMode: this.canopyMode
    });
  }

  getConfig() {
    return {
      deploymentMode: this.deploymentMode,
      gcr: this.gcr,
      moduleEfficiency: this.moduleEfficiency,
      systemDerate: this.systemDerate,
      includeTreeCanopy: this.includeTreeCanopy,
      canopyMode: this.canopyMode
    };
  }
}
