/**
 * SolarDashboard Component
 * Real-time telemetry dashboard displaying instantaneous power (kW), shaded percentage,
 * total daily cumulative energy (kWh), interactive daily power curve, and integrated PV configuration.
 * Fully collapsible to minimize screen footprint over the map.
 */

import { SparklineChart } from './SparklineChart.js';

export class SolarDashboard {
  constructor(container, onSeekTime = () => {}) {
    this.container = container;
    this.onSeekTime = onSeekTime;
    this.currentScaleFactor = 1.0;
    this.dailySummary = null;
    this.timeseries = [];
    this.currentMetric = null;
    this.isCollapsed = false;

    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel solar-dashboard';
    this.element.style.padding = '14px 16px';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '12px';
    this.element.style.width = '320px';
    this.element.style.transition = 'all 0.25s ease';

    this.element.innerHTML = `
      <!-- Collapsible Card Header -->
      <div class="dashboard-header" style="display: flex; align-items: center; justify-content: space-between; cursor: pointer; user-select: none;">
        <span style="font-weight: 700; font-size: 0.92rem; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-sun); flex-shrink: 0;">
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
          <span>Solar & PV Studio</span>
        </span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <span class="header-power-badge" style="display: none; font-size: 0.8rem; font-family: var(--font-mono); font-weight: 700; color: var(--accent-solar); background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.3); padding: 2px 7px; border-radius: 4px;">0.0 kW</span>
          <span class="patch-size-pill pill" style="font-size: 0.68rem; font-family: var(--font-mono); color: var(--text-muted); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">-- m²</span>
          <button class="collapse-btn" title="Collapse / Expand Studio Panel" style="background: rgba(255, 255, 255, 0.08); border: 1px solid var(--border-card); border-radius: 4px; color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0;">
            <svg class="chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="transition: transform 0.2s ease;">
              <polyline points="18 15 12 9 6 15"></polyline>
            </svg>
          </button>
        </div>
      </div>

      <!-- Card Body (Collapsible Content) -->
      <div class="dashboard-body" style="display: flex; flex-direction: column; gap: 12px; border-top: 1px solid var(--border-card); padding-top: 12px;">
        <!-- Instantaneous Power -->
        <div style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.06);">
          <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Instantaneous AC Power</div>
          <div style="display: flex; align-items: baseline; gap: 6px; margin-top: 4px;">
            <span class="kw-gauge" style="font-size: 2.1rem; font-weight: 800; font-family: var(--font-mono); color: var(--accent-solar); line-height: 1;">0.0</span>
            <span style="font-size: 1.0rem; font-weight: 600; color: var(--text-secondary);">kW</span>
          </div>
        </div>

        <!-- Shaded Percentage & Progress Bar (Terrain) -->
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; font-size: 0.78rem;">
            <span style="color: var(--text-secondary);">Terrain Shadow Shading</span>
            <span class="shaded-pct-val" style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-sun);">0.0%</span>
          </div>
          <div style="width: 100%; height: 5px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
            <div class="shaded-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981 0%, #f59e0b 60%, #ef4444 100%); transition: width 0.15s ease;"></div>
          </div>
        </div>

        <!-- Canopy Shaded Percentage & Progress Bar (Canopy) -->
        <div class="canopy-shading-container" style="display: flex; flex-direction: column; gap: 4px;">
          <div style="display: flex; justify-content: space-between; font-size: 0.78rem;">
            <span style="color: var(--text-secondary); display: flex; align-items: center; gap: 4px;">
              <span>🌲 Tree Canopy Shading</span>
              <span class="canopy-tau-badge" style="font-size: 0.68rem; color: #34d399; font-family: var(--font-mono);">(τ 15%)</span>
            </span>
            <span class="canopy-shaded-pct-val" style="font-family: var(--font-mono); font-weight: 700; color: #34d399;">0.0%</span>
          </div>
          <div style="width: 100%; height: 5px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
            <div class="canopy-shaded-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981 0%, #059669 50%, #047857 100%); transition: width 0.15s ease;"></div>
          </div>
        </div>

        <!-- Daily Energy Summary -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size: 0.68rem; color: var(--text-muted);">Daily Energy</div>
            <div style="font-size: 1.15rem; font-weight: 700; font-family: var(--font-mono); color: #10b981; margin-top: 2px;">
              <span class="kwh-total">0.0</span> <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">kWh</span>
            </div>
          </div>
          <div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size: 0.68rem; color: var(--text-muted);">Peak Power</div>
            <div style="font-size: 1.15rem; font-weight: 700; font-family: var(--font-mono); color: var(--accent-solar); margin-top: 2px;">
              <span class="peak-kw">0.0</span> <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">kW</span>
            </div>
          </div>
        </div>

        <!-- 24-Hour Power Curve -->
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 2px;">
          <div style="font-size: 0.72rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">24-Hour Power Curve</div>
          <div class="chart-mount"></div>
        </div>

        <!-- Integrated PV System Configuration Mount -->
        <div class="pv-config-internal-mount" style="border-top: 1px solid var(--border-card); padding-top: 10px; margin-top: 2px;"></div>
      </div>
    `;

    this.header = this.element.querySelector('.dashboard-header');
    this.body = this.element.querySelector('.dashboard-body');
    this.chevron = this.element.querySelector('.chevron-icon');
    this.headerPowerBadge = this.element.querySelector('.header-power-badge');
    this.patchSizePill = this.element.querySelector('.patch-size-pill');
    this.kwGauge = this.element.querySelector('.kw-gauge');
    this.shadedPctVal = this.element.querySelector('.shaded-pct-val');
    this.shadedProgressBar = this.element.querySelector('.shaded-progress-bar');
    this.canopyShadingContainer = this.element.querySelector('.canopy-shading-container');
    this.canopyTauBadge = this.element.querySelector('.canopy-tau-badge');
    this.canopyShadedPctVal = this.element.querySelector('.canopy-shaded-pct-val');
    this.canopyShadedProgressBar = this.element.querySelector('.canopy-shaded-progress-bar');
    this.kwhTotal = this.element.querySelector('.kwh-total');
    this.peakKw = this.element.querySelector('.peak-kw');
    this.pvConfigMount = this.element.querySelector('.pv-config-internal-mount');
    const chartMount = this.element.querySelector('.chart-mount');

    this.chart = new SparklineChart(chartMount, (idx) => {
      this.onSeekTime(idx);
    });

    this.header.addEventListener('click', () => {
      this.toggleCollapse();
    });

    this.container.appendChild(this.element);
  }

  getPVConfigMount() {
    return this.pvConfigMount;
  }

  toggleCollapse() {
    this.isCollapsed = !this.isCollapsed;
    if (this.isCollapsed) {
      this.body.style.display = 'none';
      this.chevron.style.transform = 'rotate(180deg)';
      this.headerPowerBadge.style.display = 'inline-block';
    } else {
      this.body.style.display = 'flex';
      this.chevron.style.transform = 'rotate(0deg)';
      this.headerPowerBadge.style.display = 'none';
    }
  }

  setSimulationData(data, scaleFactor = 1.0) {
    if (!data) return;
    this.timeseries = data.timeseries || [];
    this.dailySummary = data.daily_summary || {};
    this.currentScaleFactor = scaleFactor;

    if (data.metadata) {
      this.patchSizePill.textContent = `${data.metadata.patch_area_m2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²`;
    }

    if (data.canopy_transmittance !== undefined && this.canopyTauBadge) {
      this.canopyTauBadge.textContent = `(τ ${(data.canopy_transmittance * 100).toFixed(0)}%)`;
    }

    if (this.canopyShadingContainer) {
      const showCanopy = data.metadata ? (data.metadata.has_canopy_data && data.metadata.include_tree_canopy) : true;
      this.canopyShadingContainer.style.opacity = showCanopy ? '1.0' : '0.4';
    }

    this.updateDailyMetrics();
    this.chart.setData(this.timeseries, this.currentScaleFactor);
  }

  setScaleFactor(scaleFactor) {
    this.currentScaleFactor = scaleFactor;
    this.updateDailyMetrics();
    this.chart.setData(this.timeseries, this.currentScaleFactor);
    if (this.currentMetric) {
      this.updateTelemetry(this.currentMetric, this.currentIndex);
    }
  }

  updateDailyMetrics() {
    if (!this.dailySummary) return;
    const scaledDailyKwh = (this.dailySummary.total_daily_kwh || 0.0) * this.currentScaleFactor;
    const scaledPeakKw = (this.dailySummary.peak_power_kw || 0.0) * this.currentScaleFactor;

    this.kwhTotal.textContent = scaledDailyKwh.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    this.peakKw.textContent = scaledPeakKw.toFixed(1);
  }

  updateTelemetry(metric, stepIndex = 0) {
    if (!metric) return;
    this.currentMetric = metric;
    this.currentIndex = stepIndex;

    const currentKw = (metric.power_kw || 0.0) * this.currentScaleFactor;
    this.kwGauge.textContent = currentKw.toFixed(1);
    this.headerPowerBadge.textContent = `${currentKw.toFixed(1)} kW`;

    const shadedPct = metric.percent_shaded || 0.0;
    this.shadedPctVal.textContent = `${shadedPct.toFixed(1)}%`;
    this.shadedProgressBar.style.width = `${Math.min(100, Math.max(0, shadedPct))}%`;

    const canopyPct = metric.canopy_shaded_pct || 0.0;
    if (this.canopyShadedPctVal) {
      this.canopyShadedPctVal.textContent = `${canopyPct.toFixed(1)}%`;
    }
    if (this.canopyShadedProgressBar) {
      this.canopyShadedProgressBar.style.width = `${Math.min(100, Math.max(0, canopyPct))}%`;
    }

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }
}
