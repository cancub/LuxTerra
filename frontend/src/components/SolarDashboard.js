/**
 * SolarDashboard Component
 * Real-time telemetry dashboard displaying instantaneous power (kW), shaded percentage,
 * total daily cumulative energy (kWh), and interactive daily power curve.
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

    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel solar-dashboard';
    this.element.style.padding = '16px';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '14px';
    this.element.style.width = '310px';

    this.element.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--border-card); padding-bottom: 10px;">
        <span style="font-weight: 700; font-size: 0.95rem; color: var(--text-primary); display: flex; align-items: center; gap: 8px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: var(--accent-sun);">
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
          Solar Generation
        </span>
        <span class="patch-size-pill pill" style="font-size: 0.68rem; font-family: var(--font-mono); color: var(--text-muted); background: rgba(255,255,255,0.06); padding: 2px 6px; border-radius: 4px;">-- m²</span>
      </div>

      <!-- Instantaneous Power -->
      <div style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 12px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Instantaneous AC Power</div>
        <div style="display: flex; align-items: baseline; gap: 6px; margin-top: 4px;">
          <span class="kw-gauge" style="font-size: 2.1rem; font-weight: 800; font-family: var(--font-mono); color: var(--accent-solar); line-height: 1;">0.0</span>
          <span style="font-size: 1.0rem; font-weight: 600; color: var(--text-secondary);">kW</span>
        </div>
      </div>

      <!-- Shaded Percentage & Progress Bar -->
      <div style="display: flex; flex-direction: column; gap: 6px;">
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem;">
          <span style="color: var(--text-secondary);">Terrain Shadow Shading</span>
          <span class="shaded-pct-val" style="font-family: var(--font-mono); font-weight: 700; color: var(--accent-sun);">0.0%</span>
        </div>
        <div style="width: 100%; height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;">
          <div class="shaded-progress-bar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #10b981 0%, #f59e0b 60%, #ef4444 100%); transition: width 0.15s ease;"></div>
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
    `;

    this.patchSizePill = this.element.querySelector('.patch-size-pill');
    this.kwGauge = this.element.querySelector('.kw-gauge');
    this.shadedPctVal = this.element.querySelector('.shaded-pct-val');
    this.shadedProgressBar = this.element.querySelector('.shaded-progress-bar');
    this.kwhTotal = this.element.querySelector('.kwh-total');
    this.peakKw = this.element.querySelector('.peak-kw');
    const chartMount = this.element.querySelector('.chart-mount');

    this.chart = new SparklineChart(chartMount, (idx) => {
      this.onSeekTime(idx);
    });

    this.container.appendChild(this.element);
  }

  setSimulationData(data, scaleFactor = 1.0) {
    if (!data) return;
    this.timeseries = data.timeseries || [];
    this.dailySummary = data.daily_summary || {};
    this.currentScaleFactor = scaleFactor;

    if (data.metadata) {
      this.patchSizePill.textContent = `${data.metadata.patch_area_m2.toLocaleString('en-US', { maximumFractionDigits: 0 })} m²`;
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

    const shadedPct = metric.percent_shaded || 0.0;
    this.shadedPctVal.textContent = `${shadedPct.toFixed(1)}%`;
    this.shadedProgressBar.style.width = `${Math.min(100, Math.max(0, shadedPct))}%`;

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }
}
