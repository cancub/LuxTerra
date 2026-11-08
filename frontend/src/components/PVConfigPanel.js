/**
 * PVConfigPanel Component
 * Interactive PV system configuration panel with Rooftop (100% GCR) vs Ground-Mount (45% GCR) toggle
 * and live parameter tuning (efficiency, PR derate) with instant local power recalculation.
 */

export class PVConfigPanel {
  constructor(container, onConfigChange = () => {}) {
    this.container = container;
    this.onConfigChange = onConfigChange;

    this.deploymentMode = 'rooftop'; // 'rooftop' or 'ground_mount'
    this.moduleEfficiency = 0.20; // 20%
    this.systemDerate = 0.80; // 80%
    this.gcr = 1.0; // 100% for rooftop, 0.45 for ground-mount

    this.render();
  }

  get effectiveGCR() {
    return this.deploymentMode === 'rooftop' ? 1.0 : 0.45;
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel pv-config-panel';
    this.element.style.padding = '14px';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '12px';

    this.element.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span style="font-weight: 600; font-size: 0.85rem; color: var(--text-primary); display: flex; align-items: center; gap: 6px;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-solar);">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
          </svg>
          PV System Configuration
        </span>
      </div>

      <!-- Deployment Mode Toggle -->
      <div class="pv-mode-selector" style="display: flex; background: rgba(0, 0, 0, 0.3); padding: 3px; border-radius: 8px; border: 1px solid var(--border-card);">
        <button class="btn btn-sm mode-btn mode-rooftop active" data-mode="rooftop" style="flex: 1; justify-content: center;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
          </svg>
          <span>Rooftop (100% GCR)</span>
        </button>
        <button class="btn btn-sm mode-btn mode-ground" data-mode="ground_mount" style="flex: 1; justify-content: center;">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <span>Ground-Mount (45% GCR)</span>
        </button>
      </div>

      <!-- Advanced Sliders Accordion -->
      <div class="pv-accordion" style="display: flex; flex-direction: column; gap: 8px; font-size: 0.8rem;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="color: var(--text-secondary);">Module Efficiency (η):</span>
          <span class="efficiency-val" style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-solar);">20.0%</span>
        </div>
        <input type="range" class="efficiency-slider" min="15" max="24" step="0.5" value="20" style="width: 100%; accent-color: var(--accent-solar); cursor: pointer;" />

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 4px;">
          <span style="color: var(--text-secondary);">Performance Ratio (PR):</span>
          <span class="derate-val" style="font-family: var(--font-mono); font-weight: 600; color: var(--accent-solar);">80%</span>
        </div>
        <input type="range" class="derate-slider" min="70" max="90" step="1" value="80" style="width: 100%; accent-color: var(--accent-solar); cursor: pointer;" />
      </div>
    `;

    this.rooftopBtn = this.element.querySelector('.mode-rooftop');
    this.groundBtn = this.element.querySelector('.mode-ground');
    this.efficiencySlider = this.element.querySelector('.efficiency-slider');
    this.efficiencyVal = this.element.querySelector('.efficiency-val');
    this.derateSlider = this.element.querySelector('.derate-slider');
    this.derateVal = this.element.querySelector('.derate-val');

    this.rooftopBtn.addEventListener('click', () => this.setMode('rooftop'));
    this.groundBtn.addEventListener('click', () => this.setMode('ground_mount'));

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

    this.container.appendChild(this.element);
  }

  setMode(mode) {
    if (this.deploymentMode === mode) return;
    this.deploymentMode = mode;
    this.gcr = this.effectiveGCR;

    if (mode === 'rooftop') {
      this.rooftopBtn.classList.add('active');
      this.groundBtn.classList.remove('active');
    } else {
      this.groundBtn.classList.add('active');
      this.rooftopBtn.classList.remove('active');
    }

    this.notifyChange();
  }

  notifyChange() {
    this.onConfigChange(this.getConfig());
  }

  getConfig() {
    return {
      deploymentMode: this.deploymentMode,
      moduleEfficiency: this.moduleEfficiency,
      systemDerate: this.systemDerate,
      gcr: this.effectiveGCR
    };
  }
}
