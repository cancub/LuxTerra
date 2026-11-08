/**
 * SolarDashboard Component
 * Real-time telemetry dashboard displaying instantaneous power (kW), shaded percentage,
 * total daily cumulative energy (kWh), interactive daily power curve, and integrated PV configuration.
 * Enhanced to reflect tree canopy impacts across all visual elements, curves, and numerical measures.
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
          <div style="display: flex; justify-content: space-between; align-items: center;">
            <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Instantaneous AC Power</span>
            <span class="unshaded-kw-ref" style="font-size: 0.70rem; font-family: var(--font-mono); color: var(--text-muted); display: none;">Clear-Sky: <strong class="unshaded-kw-val" style="color: #f59e0b;">0.0 kW</strong></span>
          </div>
          <div style="display: flex; align-items: baseline; gap: 6px; margin-top: 4px;">
            <span class="kw-gauge" style="font-size: 2.1rem; font-weight: 800; font-family: var(--font-mono); color: var(--accent-solar); line-height: 1;">0.0</span>
            <span style="font-size: 1.0rem; font-weight: 600; color: var(--text-secondary);">kW</span>
          </div>

          <!-- Canopy Shading Impact Pill on Instantaneous Power -->
          <div class="canopy-loss-pill" style="margin-top: 6px; display: none; align-items: center; justify-content: space-between; font-size: 0.70rem; font-family: var(--font-mono); background: rgba(16, 185, 129, 0.12); border: 1px solid rgba(16, 185, 129, 0.28); padding: 3px 8px; border-radius: 4px; color: #34d399;">
            <span style="display: flex; align-items: center; gap: 4px;">
              <span>🌲 Canopy Loss:</span>
              <strong class="canopy-loss-kw" style="color: #34d399;">-0.0 kW</strong>
            </span>
            <span class="canopy-loss-pct" style="color: rgba(52, 211, 153, 0.85);">(-0.0%)</span>
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
          <div class="canopy-effective-attenuation" style="display: none; justify-content: space-between; font-size: 0.66rem; font-family: var(--font-mono); color: var(--text-muted); margin-top: 1px;">
            <span>Direct Beam Transmission:</span>
            <span class="canopy-transmission-val" style="color: #34d399; font-weight: 600;">100%</span>
          </div>
        </div>

        <!-- Daily Energy Summary -->
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size: 0.68rem; color: var(--text-muted);">Daily Energy</div>
            <div style="font-size: 1.15rem; font-weight: 700; font-family: var(--font-mono); color: #10b981; margin-top: 2px;">
              <span class="kwh-total">0.0</span> <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">kWh</span>
            </div>
            <!-- Daily Canopy Energy Loss Badge -->
            <div class="daily-canopy-loss-subtext" style="font-size: 0.65rem; font-family: var(--font-mono); color: #34d399; margin-top: 3px; display: none;">
              🌲 Loss: <span class="daily-canopy-loss-val">-0.0 kWh</span> <span class="daily-canopy-loss-pct">(-0.0%)</span>
            </div>
          </div>
          <div style="background: rgba(0,0,0,0.2); padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.05);">
            <div style="font-size: 0.68rem; color: var(--text-muted);">Peak Power</div>
            <div style="font-size: 1.15rem; font-weight: 700; font-family: var(--font-mono); color: var(--accent-solar); margin-top: 2px;">
              <span class="peak-kw">0.0</span> <span style="font-size: 0.75rem; font-weight: normal; color: var(--text-secondary);">kW</span>
            </div>
            <!-- Potential Clear-Sky Peak Subtext -->
            <div class="daily-unshaded-peak-subtext" style="font-size: 0.65rem; font-family: var(--font-mono); color: #f59e0b; margin-top: 3px; display: none;">
              Clear-Sky: <span class="unshaded-peak-val">0.0 kW</span>
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
    this.unshadedKwRef = this.element.querySelector('.unshaded-kw-ref');
    this.unshadedKwVal = this.element.querySelector('.unshaded-kw-val');
    this.canopyLossPill = this.element.querySelector('.canopy-loss-pill');
    this.canopyLossKw = this.element.querySelector('.canopy-loss-kw');
    this.canopyLossPct = this.element.querySelector('.canopy-loss-pct');
    this.shadedPctVal = this.element.querySelector('.shaded-pct-val');
    this.shadedProgressBar = this.element.querySelector('.shaded-progress-bar');
    this.canopyShadingContainer = this.element.querySelector('.canopy-shading-container');
    this.canopyTauBadge = this.element.querySelector('.canopy-tau-badge');
    this.canopyShadedPctVal = this.element.querySelector('.canopy-shaded-pct-val');
    this.canopyShadedProgressBar = this.element.querySelector('.canopy-shaded-progress-bar');
    this.canopyEffectiveAttenuation = this.element.querySelector('.canopy-effective-attenuation');
    this.canopyTransmissionVal = this.element.querySelector('.canopy-transmission-val');
    this.kwhTotal = this.element.querySelector('.kwh-total');
    this.dailyCanopyLossSubtext = this.element.querySelector('.daily-canopy-loss-subtext');
    this.dailyCanopyLossVal = this.element.querySelector('.daily-canopy-loss-val');
    this.dailyCanopyLossPct = this.element.querySelector('.daily-canopy-loss-pct');
    this.peakKw = this.element.querySelector('.peak-kw');
    this.dailyUnshadedPeakSubtext = this.element.querySelector('.daily-unshaded-peak-subtext');
    this.unshadedPeakVal = this.element.querySelector('.unshaded-peak-val');
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

    if (this.canopyTauBadge) {
      this.canopyTauBadge.textContent = `(τ ${(this.canopyTransmittance * 100).toFixed(0)}%)`;
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

    // Tree canopy cumulative daily energy loss
    const rawCanopyLossKwh = this.dailySummary.canopy_loss_kwh || 0.0;
    const scaledCanopyLossKwh = rawCanopyLossKwh * this.currentScaleFactor;
    const canopyLossPct = this.dailySummary.canopy_loss_pct || 0.0;

    if (this.dailyCanopyLossSubtext) {
      if (scaledCanopyLossKwh > 0.05) {
        this.dailyCanopyLossSubtext.style.display = 'block';
        this.dailyCanopyLossVal.textContent = `-${scaledCanopyLossKwh.toFixed(1)} kWh`;
        this.dailyCanopyLossPct.textContent = `(-${canopyLossPct.toFixed(1)}%)`;
      } else {
        this.dailyCanopyLossSubtext.style.display = 'none';
      }
    }

    // Potential clear-sky peak power
    const rawUnshadedPeak = this.dailySummary.unshaded_peak_kw || 0.0;
    const scaledUnshadedPeak = rawUnshadedPeak * this.currentScaleFactor;

    if (this.dailyUnshadedPeakSubtext) {
      if (scaledUnshadedPeak > scaledPeakKw + 0.1) {
        this.dailyUnshadedPeakSubtext.style.display = 'block';
        this.unshadedPeakVal.textContent = `${scaledUnshadedPeak.toFixed(1)} kW`;
      } else {
        this.dailyUnshadedPeakSubtext.style.display = 'none';
      }
    }
  }

  updateTelemetry(metric, stepIndex = 0) {
    if (!metric) return;
    this.currentMetric = metric;
    this.currentIndex = stepIndex;

    const currentKw = (metric.power_kw || 0.0) * this.currentScaleFactor;
    const rawUnshadedKw = metric.unshaded_power_kw !== undefined ? metric.unshaded_power_kw : metric.power_kw;
    const unshadedKw = (rawUnshadedKw || 0.0) * this.currentScaleFactor;
    const canopyLossKw = (metric.canopy_loss_kw || 0.0) * this.currentScaleFactor;

    this.kwGauge.textContent = currentKw.toFixed(1);
    this.headerPowerBadge.textContent = `${currentKw.toFixed(1)} kW`;

    // Instantaneous clear-sky potential reference & canopy loss badge
    if (this.canopyLossPill && this.unshadedKwRef) {
      if (canopyLossKw > 0.05) {
        this.canopyLossPill.style.display = 'flex';
        this.canopyLossKw.textContent = `-${canopyLossKw.toFixed(1)} kW`;
        const lossRatio = unshadedKw > 0 ? (canopyLossKw / unshadedKw) * 100 : 0;
        this.canopyLossPct.textContent = `(-${lossRatio.toFixed(1)}%)`;

        this.unshadedKwRef.style.display = 'inline';
        this.unshadedKwVal.textContent = `${unshadedKw.toFixed(1)} kW`;
      } else {
        this.canopyLossPill.style.display = 'none';
        if (unshadedKw > currentKw + 0.1) {
          this.unshadedKwRef.style.display = 'inline';
          this.unshadedKwVal.textContent = `${unshadedKw.toFixed(1)} kW`;
        } else {
          this.unshadedKwRef.style.display = 'none';
        }
      }
    }

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

    // Effective direct beam transmission under canopy
    if (this.canopyEffectiveAttenuation && this.canopyTransmissionVal) {
      if (canopyPct > 0.0) {
        this.canopyEffectiveAttenuation.style.display = 'flex';
        const tau = this.canopyTransmittance;
        // Direct beam transmission = 100% - canopy_pct * (1 - tau)
        const netTransmission = Math.max(0, 100 - canopyPct * (1 - tau));
        this.canopyTransmissionVal.textContent = `${netTransmission.toFixed(1)}% (${(100 - netTransmission).toFixed(1)}% canopy blocked)`;
      } else {
        this.canopyEffectiveAttenuation.style.display = 'none';
      }
    }

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }
}
