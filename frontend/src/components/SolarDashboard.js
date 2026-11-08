/**
 * SolarDashboard Component
 * Real-time telemetry dashboard displaying daily cumulative energy (kWh),
 * instantaneous power breakdown as a stacked subtraction (Clear-Sky − Geological Shade − Tree Shade = AC Power),
 * 24-hour interactive power curve, continuous 3-part shade status bar, and integrated PV configuration.
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
    this.canopyTransmittance = 0.15;

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
          <span class="panel-card-title">Solar Studio</span>
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
      <div class="dashboard-body" style="display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border-card); padding-top: 10px;">
        <!-- Daily Energy Summary (Moved to top of card, loss not mentioned) -->
        <div class="daily-energy-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 9px 12px; border: 1px solid rgba(255,255,255,0.06); display: flex; justify-content: space-between; align-items: baseline;">
          <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Daily Energy</span>
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

        <!-- 24-Hour Power Curve -->
        <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 1px;">
          <div style="font-size: 0.70rem; color: var(--text-muted); font-weight: 600; text-transform: uppercase;">24-Hour Power Curve</div>
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

    // Daily energy metric
    this.kwhTotal = this.element.querySelector('.kwh-total');

    // Instantaneous stacked subtraction elements
    this.subClearSkyVal = this.element.querySelector('.sub-clearsky-val');
    this.subGeoShadeVal = this.element.querySelector('.sub-geoshade-val');
    this.subTreeShadeVal = this.element.querySelector('.sub-treeshade-val');
    this.subAcPowerVal = this.element.querySelector('.sub-acpower-val');
    this.kwGauge = this.subAcPowerVal;

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
    this.canopyTransmittance = data.canopy_transmittance !== undefined ? data.canopy_transmittance : 0.15;

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
    this.headerPowerBadge.textContent = `${currentKw.toFixed(1)} kW`;

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }
}

