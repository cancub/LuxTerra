/**
 * SolarDashboard Component (Energy & Instantaneous AC Power Cards)
 * Displays daily cumulative energy (kWh) and instantaneous power breakdown
 * as a stacked subtraction (Clear-Sky − Geological Shade − Tree Shade = AC Power).
 * Coordinates synchronized 24-hour power curve updates.
 */

import { SparklineChart } from './SparklineChart.js';

export class SolarDashboard {
  constructor(container, onSeekTime = () => {}, options = {}) {
    this.container = container;
    this.onSeekTime = onSeekTime;
    this.chartContainer = options.chartContainer || null;
    this.currentScaleFactor = 1.0;
    this.dailySummary = null;
    this.timeseries = [];
    this.currentMetric = null;
    this.canopyTransmittance = 0.15;

    this.render();
  }

  render() {
    this.element = document.createElement('div');
    this.element.className = 'glass-panel energy-metrics-card';
    this.element.style.padding = '10px 14px';
    this.element.style.display = 'flex';
    this.element.style.flexDirection = 'column';
    this.element.style.gap = '8px';
    this.element.style.width = '100%';
    this.element.style.boxSizing = 'border-box';
    this.element.style.transition = 'all 0.25s ease';

    this.element.innerHTML = `
      <!-- Daily Energy Card (Moved to left dock, loss not mentioned) -->
      <div class="daily-energy-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 8px 12px; border: 1px solid rgba(255,255,255,0.06); display: flex; justify-content: space-between; align-items: baseline;">
        <div style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Daily Energy</span>
          <span class="patch-size-pill pill" style="font-size: 0.65rem; font-family: var(--font-mono); color: var(--text-muted); background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 4px;">-- m²</span>
        </div>
        <div style="font-family: var(--font-mono); font-weight: 700; color: #10b981; font-size: 1.25rem; line-height: 1;">
          <span class="kwh-total">0.0</span> <span style="font-size: 0.75rem; font-weight: 500; color: var(--text-secondary);">kWh</span>
        </div>
      </div>

      <!-- Instantaneous AC Power (Stacked Subtraction: Clear-Sky − Geological Shade − Tree Shade = AC Power) -->
      <div class="instantaneous-subtraction-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06);">
        <div style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; margin-bottom: 6px;">
          Instantaneous AC Power
        </div>
        <div class="subtraction-breakdown" style="display: flex; flex-direction: column; gap: 4px; font-family: var(--font-mono); font-size: 0.76rem;">
          <!-- Clear-Sky Potential -->
          <div class="subtraction-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary);">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #facc15;"></span>
              <span>Clear-Sky</span>
            </span>
            <span class="sub-clearsky-val" style="font-weight: 600; color: #facc15;">0.0 kW</span>
          </div>
          <!-- Geological Shade Loss -->
          <div class="subtraction-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary);">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="font-weight: 700; color: #a16207; width: 8px; text-align: center;">−</span>
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #78350f;"></span>
              <span>Geological Shade</span>
            </span>
            <span class="sub-geoshade-val" style="font-weight: 600; color: #d97706;">0.0 kW</span>
          </div>
          <!-- Tree Canopy Shade Loss -->
          <div class="subtraction-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary);">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="font-weight: 700; color: #22c55e; width: 8px; text-align: center;">−</span>
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #22c55e;"></span>
              <span>Tree Shade</span>
            </span>
            <span class="sub-treeshade-val" style="font-weight: 600; color: #22c55e;">0.0 kW</span>
          </div>
          <!-- Subtraction Divider -->
          <div class="subtraction-divider" style="height: 1px; background: rgba(255,255,255,0.1); margin: 3px 0;"></div>
          <!-- AC Power Result -->
          <div class="subtraction-row total-ac" style="display: flex; justify-content: space-between; align-items: center;">
            <span style="display: flex; align-items: center; gap: 6px; font-weight: 700; color: var(--text-primary);">
              <span style="font-weight: 700; color: var(--accent-solar); width: 8px; text-align: center;">=</span>
              <span>AC Power</span>
            </span>
            <span class="sub-acpower-val kw-gauge" style="font-size: 1.25rem; font-weight: 800; color: var(--accent-solar);">0.0 kW</span>
          </div>
        </div>
      </div>
      <div class="internal-chart-mount" style="display: none;"></div>
      <div class="pv-config-internal-mount" style="display: none;"></div>
    `;

    this.patchSizePill = this.element.querySelector('.patch-size-pill');
    this.kwhTotal = this.element.querySelector('.kwh-total');
    this.subClearSkyVal = this.element.querySelector('.sub-clearsky-val');
    this.subGeoShadeVal = this.element.querySelector('.sub-geoshade-val');
    this.subTreeShadeVal = this.element.querySelector('.sub-treeshade-val');
    this.subAcPowerVal = this.element.querySelector('.sub-acpower-val');
    this.kwGauge = this.subAcPowerVal;

    this.pvConfigMount = this.element.querySelector('.pv-config-internal-mount');
    const targetChartMount = this.chartContainer || this.element.querySelector('.internal-chart-mount');

    this.chart = new SparklineChart(targetChartMount, (idx) => {
      this.onSeekTime(idx);
    });

    this.container.appendChild(this.element);
  }

  getPVConfigMount() {
    return this.pvConfigMount;
  }

  setSimulationData(data, scaleFactor = 1.0) {
    if (!data) {
      if (this.kwhTotal) this.kwhTotal.textContent = '0.0';
      if (this.subClearSkyVal) this.subClearSkyVal.textContent = '0.0 kW';
      if (this.subGeoShadeVal) this.subGeoShadeVal.textContent = '0.0 kW';
      if (this.subTreeShadeVal) this.subTreeShadeVal.textContent = '0.0 kW';
      if (this.subAcPowerVal) this.subAcPowerVal.textContent = '0.0 kW';
      if (this.patchSizePill) this.patchSizePill.textContent = '-- m²';
      this.chart.setData([], 1.0);
      return;
    }
    this.timeseries = data.timeseries || [];
    this.dailySummary = data.daily_summary || {};
    this.currentScaleFactor = scaleFactor;
    this.canopyTransmittance = data.canopy_transmittance !== undefined ? data.canopy_transmittance : 0.15;

    if (data.metadata && this.patchSizePill) {
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
    this.kwhTotal.textContent = scaledDailyKwh.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }

  updateTelemetry(metric, stepIndex = 0) {
    if (!metric) return;
    this.currentMetric = metric;
    this.currentIndex = stepIndex;

    const currentKw = (metric.power_kw || 0.0) * this.currentScaleFactor;
    const rawUnshadedKw = metric.unshaded_power_kw !== undefined ? metric.unshaded_power_kw : metric.power_kw;
    const unshadedKw = (rawUnshadedKw || 0.0) * this.currentScaleFactor;
    const canopyLossKw = (metric.canopy_loss_kw || 0.0) * this.currentScaleFactor;
    const rawGeoLossKw = metric.geological_loss_kw !== undefined
      ? metric.geological_loss_kw
      : Math.max(0.0, rawUnshadedKw - (metric.canopy_loss_kw || 0.0) - (metric.power_kw || 0.0));
    const geoLossKw = (rawGeoLossKw || 0.0) * this.currentScaleFactor;

    // Stacked subtraction values: Clear-Sky − Geological Shade − Tree Shade = AC Power
    this.subClearSkyVal.textContent = `${unshadedKw.toFixed(1)} kW`;
    this.subGeoShadeVal.textContent = `${geoLossKw.toFixed(1)} kW`;
    this.subTreeShadeVal.textContent = `${canopyLossKw.toFixed(1)} kW`;
    this.subAcPowerVal.textContent = `${currentKw.toFixed(1)} kW`;

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }
}
