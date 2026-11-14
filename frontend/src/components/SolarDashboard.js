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
    this.dailyEnergyContainer = options.dailyEnergyContainer || null;
    this.currentScaleFactor = 1.0;
    this.dailySummary = null;
    this.timeseries = [];
    this.currentMetric = null;
    this.canopyTransmittance = 0.15;
    this.isShadeExpanded = true;
    this.isArrayDetailsExpanded = false;

    this.render();
  }

  buildArraySpecRowsHtml() {
    return `
      <div class="array-spec-line" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted);">
        <span>Tilt</span>
        <span class="tilt-val" style="color: #38bdf8; font-weight: 600;">--°</span>
      </div>
      <div class="array-spec-line" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted);">
        <span>Panels</span>
        <span class="array-panels-badge" style="color: #38bdf8; font-weight: 600;">--</span>
      </div>
      <div class="array-spec-line" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted);">
        <span>Installed DC</span>
        <span class="array-dc-badge" style="color: #fbbf24; font-weight: 600;">-- kWp</span>
      </div>
      <div class="array-spec-line array-dcac-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted);">
        <span>DC/AC Ratio</span>
        <span class="array-dcac-badge" style="color: #a78bfa; font-weight: 600;">--</span>
      </div>
      <div class="array-spec-line" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-muted);">
        <span>GCR</span>
        <span class="array-gcr-badge" style="color: #94a3b8; font-weight: 600;">--%</span>
      </div>
    `;
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

    const dailyEnergyHtml = this.dailyEnergyContainer ? '' : `
      <!-- Daily Energy Card (Displays daily energy and an expandable Array Details section) -->
      <div class="daily-energy-card" style="background: rgba(0,0,0,0.25); border-radius: 8px; padding: 8px 12px; border: 1px solid rgba(255,255,255,0.06); display: flex; flex-direction: column; gap: 4px;">
        <div style="display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">Daily Energy</span>
          <div style="display: flex; align-items: baseline; gap: 4px; white-space: nowrap; font-family: var(--font-mono); font-weight: 700; color: #10b981; font-size: 1.25rem; line-height: 1;">
            <span class="kwh-total">0.0</span> <span style="font-size: 0.75rem; font-weight: 600; color: var(--text-secondary); margin-left: 2px;">kWh</span>
          </div>
        </div>

        <!-- Expandable Array Specifications Section -->
        <div class="array-specs-row" style="display: none; flex-direction: column; gap: 4px; margin-top: 2px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.06);">
          <div class="array-specs-header-row" role="button" tabindex="0" title="Click to toggle array details" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.68rem; color: var(--text-muted); cursor: pointer; user-select: none; border-radius: 4px; padding: 2px 2px;">
            <span style="display: flex; align-items: center; gap: 4px; font-weight: 600; letter-spacing: 0.02em;">
              <span class="array-specs-chevron" style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; transition: transform 0.2s ease; transform: rotate(-90deg); color: #94a3b8;">
                <svg style="width: 10px; height: 10px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </span>
              <span>Array Details</span>
            </span>
          </div>

          <div class="array-specs-details-container" style="display: none; flex-direction: column; gap: 3px; padding-left: 18px; border-left: 1px dashed rgba(255,255,255,0.12); margin-left: 6px; font-family: var(--font-mono); font-size: 0.72rem;">
            ${this.buildArraySpecRowsHtml()}
          </div>
        </div>
      </div>
    `;

    const instantaneousCardStyle = this.dailyEnergyContainer
      ? 'padding: 2px 0;'
      : 'background: rgba(0,0,0,0.25); border-radius: 8px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.06);';

    this.element.innerHTML = `
      ${dailyEnergyHtml}

      <!-- Instantaneous AC Power (Stacked Subtraction: Clear-Sky − Geological Shade − Tree Shade = AC Power) -->
      <div class="instantaneous-subtraction-card" style="${instantaneousCardStyle}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <span class="instantaneous-title" style="font-size: 0.68rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">
            Instantaneous AC Power
          </span>
          <span class="hovered-panel-indicator" style="display: none; font-size: 0.62rem; color: #38bdf8; font-weight: 700; font-family: var(--font-mono); background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.35); padding: 1px 6px; border-radius: 4px;">
            1 MODULE
          </span>
        </div>

        <!-- Hovered Panel Breakdown Banner -->
        <div class="panel-hover-banner" style="display: none; align-items: center; justify-content: space-between; background: rgba(56, 189, 248, 0.10); border: 1px solid rgba(56, 189, 248, 0.30); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px;">
          <div style="display: flex; align-items: center; gap: 5px;">
            <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 6px #38bdf8;"></span>
            <span class="panel-hover-label" style="font-size: 0.68rem; color: #38bdf8; font-weight: 700; font-family: var(--font-mono);">Table 1 · Row 1 · Module 1 (Bottom)</span>
          </div>
          <span style="font-size: 0.60rem; color: #94a3b8; font-family: var(--font-mono);">Hover Preview</span>
        </div>

        <div class="subtraction-breakdown" style="display: flex; flex-direction: column; gap: 4px; font-family: var(--font-mono); font-size: 0.76rem;">
          <!-- Incident Potential -->
          <div class="subtraction-row incident-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary);">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #facc15;"></span>
              <span>Incident Potential</span>
            </span>
            <span class="sub-incident-val sub-clearsky-val" style="font-weight: 600; color: #facc15;">+ 0.0 kW</span>
          </div>

          <!-- Master Shade Section (Clickable to Expand / Collapse Contributions) -->
          <div class="shade-master-section" style="position: relative; display: flex; flex-direction: column; gap: 3px;">
            <div class="subtraction-row shade-header-row" role="button" tabindex="0" title="Click to toggle shade breakdown" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary); cursor: pointer; user-select: none; border-radius: 4px; padding: 2px 2px;">
              <span style="display: flex; align-items: center; gap: 4px;">
                <span class="shade-expand-chevron" style="display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; transition: transform 0.2s ease; color: #94a3b8;">
                  <svg style="width: 10px; height: 10px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="6 9 12 15 18 9"></polyline>
                  </svg>
                </span>
                <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #ef4444;"></span>
                <span>Shade</span>
              </span>
              <span class="sub-totalshade-val" style="font-weight: 600; color: #f87171;">- 0.0 kW</span>
            </div>

            <!-- Expandable Shade Contributions Wrapper -->
            <div class="shade-contributions-container" style="display: flex; flex-direction: column; gap: 3px; padding-left: 18px; border-left: 1px dashed rgba(255,255,255,0.12); margin-left: 6px;">
              <!-- Geological Shade Loss -->
              <div class="subtraction-row geo-shade-row" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.72rem; color: var(--text-muted);">
                <span style="display: flex; align-items: center; gap: 6px;">
                  <span style="display: inline-block; width: 6px; height: 6px; border-radius: 2px; background: #d97706;"></span>
                  <span>Geological</span>
                </span>
                <span class="sub-geoshade-val" style="font-weight: 600; color: #d97706;">- 0.0 kW</span>
              </div>
              <!-- Tree Canopy Shade Loss -->
              <div class="subtraction-row tree-shade-row" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.72rem; color: var(--text-muted);">
                <span style="display: flex; align-items: center; gap: 6px;">
                  <span style="display: inline-block; width: 6px; height: 6px; border-radius: 2px; background: #22c55e;"></span>
                  <span>Tree Canopy</span>
                </span>
                <span class="sub-treeshade-val" style="font-weight: 600; color: #22c55e;">- 0.0 kW</span>
              </div>
              <!-- Panel Self-Shade Loss -->
              <div class="subtraction-row panel-shade-row" style="display: flex; justify-content: space-between; align-items: center; font-size: 0.72rem; color: var(--text-muted);">
                <span style="display: flex; align-items: center; gap: 6px;">
                  <span style="display: inline-block; width: 6px; height: 6px; border-radius: 2px; background: #818cf8;"></span>
                  <span>Panel Self-Shade</span>
                </span>
                <span class="sub-selfshade-val" style="font-weight: 600; color: #a5b4fc;">- 0.0 kW</span>
              </div>
            </div>

            <!-- Diffuse Only Overlay Badge with Layperson Hover Tooltip -->
            <div class="diffuse-only-overlay">
              <div class="diffuse-badge-pill" title="Direct sunbeams are not hitting the panels. Power comes purely from ambient sky light, so trees and hills cast no direct shadows.">
                <span style="display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #38bdf8; box-shadow: 0 0 6px #38bdf8;"></span>
                <span>Diffuse Only</span>
                <svg style="width: 11px; height: 11px; opacity: 0.8; margin-left: 1px;" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>

                <!-- Hover-triggered Tooltip -->
                <div class="diffuse-tooltip">
                  <div style="font-weight: 700; color: #38bdf8; margin-bottom: 4px; display: flex; align-items: center; gap: 5px; font-size: 0.74rem;">
                    <span>Ambient Sky Light Only</span>
                  </div>
                  <div style="color: #cbd5e1; font-size: 0.71rem; line-height: 1.35; font-family: var(--font-sans); text-transform: none; letter-spacing: normal; font-weight: 400;">
                    Direct sunbeams are no longer hitting the front of the solar panels (the sun is behind the array or below direct angle). All generated power comes from scattered ambient daylight, so trees and hills cast no direct shadows to subtract.
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Diffuse Radiation Row -->
          <div class="subtraction-row diffuse-row" style="display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary);">
            <span style="display: flex; align-items: center; gap: 6px;">
              <span style="display: inline-block; width: 8px; height: 8px; border-radius: 2px; background: #38bdf8;"></span>
              <span>Diffuse</span>
            </span>
            <span class="sub-diffuse-val" style="font-weight: 600; color: #38bdf8;">+ 0.0 kW</span>
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

    if (this.dailyEnergyContainer) {
      this.dailyElement = document.createElement('div');
      this.dailyElement.className = 'daily-energy-flat';
      this.dailyElement.innerHTML = `
        <div class="daily-energy-flat-header">
          <span class="daily-energy-flat-title">Daily Energy</span>
          <div class="daily-energy-flat-value">
            <span class="kwh-total">0.0</span> <span class="daily-energy-flat-unit">kWh</span>
          </div>
        </div>
        <div class="array-specs-row array-specs-flat" style="display: none; flex-direction: column; gap: 3px; font-family: var(--font-mono); font-size: 0.72rem;">
          ${this.buildArraySpecRowsHtml()}
        </div>
      `;
      this.dailyEnergyContainer.appendChild(this.dailyElement);

      this.kwhTotal = this.dailyElement.querySelector('.kwh-total');
      this.tiltVal = this.dailyElement.querySelector('.tilt-val');
      this.arraySpecsRow = this.dailyElement.querySelector('.array-specs-row');
      this.arraySpecsHeaderRow = null;
      this.arraySpecsDetails = null;
      this.arraySpecsChevron = null;
      this.arrayPanelsBadge = this.dailyElement.querySelector('.array-panels-badge');
      this.arrayDcBadge = this.dailyElement.querySelector('.array-dc-badge');
      this.arrayDcAcRow = this.dailyElement.querySelector('.array-dcac-row');
      this.arrayDcAcBadge = this.dailyElement.querySelector('.array-dcac-badge');
      this.arrayGcrBadge = this.dailyElement.querySelector('.array-gcr-badge');
    } else {
      this.kwhTotal = this.element.querySelector('.kwh-total');
      this.tiltVal = this.element.querySelector('.tilt-val');
      this.arraySpecsRow = this.element.querySelector('.array-specs-row');
      this.arraySpecsHeaderRow = this.element.querySelector('.array-specs-header-row');
      this.arraySpecsDetails = this.element.querySelector('.array-specs-details-container');
      this.arraySpecsChevron = this.element.querySelector('.array-specs-chevron');
      this.arrayPanelsBadge = this.element.querySelector('.array-panels-badge');
      this.arrayDcBadge = this.element.querySelector('.array-dc-badge');
      this.arrayDcAcRow = this.element.querySelector('.array-dcac-row');
      this.arrayDcAcBadge = this.element.querySelector('.array-dcac-badge');
      this.arrayGcrBadge = this.element.querySelector('.array-gcr-badge');

      if (this.arraySpecsHeaderRow) {
        this.arraySpecsHeaderRow.addEventListener('click', () => {
          this.toggleArrayDetailsExpanded();
        });
        this.arraySpecsHeaderRow.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.toggleArrayDetailsExpanded();
          }
        });
      }
      this.toggleArrayDetailsExpanded(false);
    }
    this.diffuseOnlyOverlay = this.element.querySelector('.diffuse-only-overlay');
    this.subIncidentVal = this.element.querySelector('.sub-incident-val');
    this.subClearSkyVal = this.subIncidentVal; // Compatibility alias
    this.subTotalShadeVal = this.element.querySelector('.sub-totalshade-val');
    this.subGeoShadeVal = this.element.querySelector('.sub-geoshade-val');
    this.subTreeShadeVal = this.element.querySelector('.sub-treeshade-val');
    this.subSelfShadeVal = this.element.querySelector('.sub-selfshade-val');
    this.subDiffuseVal = this.element.querySelector('.sub-diffuse-val');
    this.subAcPowerVal = this.element.querySelector('.sub-acpower-val');
    this.kwGauge = this.subAcPowerVal;

    this.shadeHeaderRow = this.element.querySelector('.shade-header-row');
    this.shadeContributions = this.element.querySelector('.shade-contributions-container');
    this.shadeChevron = this.element.querySelector('.shade-expand-chevron');

    if (this.shadeHeaderRow) {
      this.shadeHeaderRow.addEventListener('click', () => {
        this.toggleShadeExpanded();
      });
      this.shadeHeaderRow.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          this.toggleShadeExpanded();
        }
      });
    }

    this.instantaneousTitle = this.element.querySelector('.instantaneous-title');
    this.hoveredPanelIndicator = this.element.querySelector('.hovered-panel-indicator');
    this.panelHoverBanner = this.element.querySelector('.panel-hover-banner');
    this.panelHoverLabel = this.element.querySelector('.panel-hover-label');
    this.isHoveringPanel = false;

    this.pvConfigMount = this.element.querySelector('.pv-config-internal-mount');
    const targetChartMount = this.chartContainer || this.element.querySelector('.internal-chart-mount');

    this.chart = new SparklineChart(targetChartMount, (idx) => {
      this.onSeekTime(idx);
    });

    this.container.appendChild(this.element);
  }

  toggleShadeExpanded(forceState) {
    this.isShadeExpanded = forceState !== undefined ? forceState : !this.isShadeExpanded;
    if (this.shadeContributions) {
      this.shadeContributions.style.display = this.isShadeExpanded ? 'flex' : 'none';
    }
    if (this.shadeChevron) {
      this.shadeChevron.style.transform = this.isShadeExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
  }

  toggleArrayDetailsExpanded(forceState) {
    this.isArrayDetailsExpanded = forceState !== undefined ? forceState : !this.isArrayDetailsExpanded;
    if (this.arraySpecsDetails) {
      this.arraySpecsDetails.style.display = this.isArrayDetailsExpanded ? 'flex' : 'none';
    }
    if (this.arraySpecsChevron) {
      this.arraySpecsChevron.style.transform = this.isArrayDetailsExpanded ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
  }

  getPVConfigMount() {
    return this.pvConfigMount;
  }

  setSimulationData(data, scaleFactor = 1.0) {
    if (!data) {
      this.timeseries = [];
      this.dailySummary = null;
      this.currentMetric = null;
      this.currentIndex = 0;
      this.isHoveringPanel = false;
      if (this.panelHoverBanner) this.panelHoverBanner.style.display = 'none';
      if (this.hoveredPanelIndicator) this.hoveredPanelIndicator.style.display = 'none';
      if (this.instantaneousTitle) this.instantaneousTitle.textContent = 'Instantaneous AC Power';
      if (this.kwhTotal) this.kwhTotal.textContent = '0.0';
      if (this.tiltVal) this.tiltVal.textContent = '--°';
      if (this.arraySpecsRow) this.arraySpecsRow.style.display = 'none';
      if (this.diffuseOnlyOverlay) this.diffuseOnlyOverlay.style.display = 'none';
      if (this.subIncidentVal) this.subIncidentVal.textContent = '+ 0.0 kW';
      if (this.subTotalShadeVal) this.subTotalShadeVal.textContent = '- 0.0 kW';
      if (this.subGeoShadeVal) this.subGeoShadeVal.textContent = '- 0.0 kW';
      if (this.subTreeShadeVal) this.subTreeShadeVal.textContent = '- 0.0 kW';
      if (this.subSelfShadeVal) this.subSelfShadeVal.textContent = '- 0.0 kW';
      if (this.subDiffuseVal) this.subDiffuseVal.textContent = '+ 0.0 kW';
      if (this.subAcPowerVal) this.subAcPowerVal.textContent = '0.0 kW';
      this.chart.setData([], 1.0);
      return;
    }
    this.timeseries = data.timeseries || [];
    this.dailySummary = data.daily_summary || {};
    this.currentScaleFactor = scaleFactor;
    this.canopyTransmittance = data.canopy_transmittance !== undefined ? data.canopy_transmittance : 0.15;

    this.updateDailyMetrics(data);
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

  updateDailyMetrics(data = null) {
    if (!this.dailySummary) return;

    const scaledDailyKwh = (this.dailySummary.total_daily_kwh || 0.0) * this.currentScaleFactor;
    if (this.kwhTotal) {
      this.kwhTotal.textContent = scaledDailyKwh.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }

    const optimalTilt = this.dailySummary.optimal_tilt_deg ?? data?.metadata?.optimal_tilt_deg ?? this.timeseries?.[0]?.optimal_tilt_deg;
    if (this.tiltVal) {
      this.tiltVal.textContent = optimalTilt !== undefined ? `${optimalTilt.toFixed(1)}°` : '--°';
    }

    // Solar Panel Array Specifications & Telemetry
    const layout = data?.layout;
    const totalPanels = layout?.total_panels ?? this.dailySummary.total_panels;
    const installedDcKw = layout?.installed_dc_kw ?? this.dailySummary.installed_dc_kw;
    const physicalGcr = layout?.physical_gcr ?? data?.metadata?.effective_gcr;

    if (totalPanels && installedDcKw) {
      if (this.arraySpecsRow) this.arraySpecsRow.style.display = 'flex';
      if (this.arrayPanelsBadge) this.arrayPanelsBadge.textContent = `${totalPanels.toLocaleString()}`;
      if (this.arrayDcBadge) this.arrayDcBadge.textContent = `${installedDcKw.toFixed(1)} kWp`;
      if (this.arrayGcrBadge) {
        this.arrayGcrBadge.textContent = physicalGcr !== undefined ? `${(physicalGcr * 100).toFixed(1)}%` : '--%';
      }
      if (this.arrayDcAcBadge) {
        const peakKw = this.dailySummary.unshaded_peak_kw || this.dailySummary.peak_power_kw;
        if (peakKw && peakKw > 0) {
          const ratio = (installedDcKw / peakKw).toFixed(2);
          this.arrayDcAcBadge.textContent = `${ratio}`;
          if (this.arrayDcAcRow) this.arrayDcAcRow.style.display = 'flex';
        } else {
          this.arrayDcAcBadge.textContent = '--';
          if (this.arrayDcAcRow) this.arrayDcAcRow.style.display = 'none';
        }
      }
    } else {
      if (this.arraySpecsRow) this.arraySpecsRow.style.display = 'none';
    }
  }

  updateTelemetry(metric, stepIndex = 0) {
    if (!metric) return;
    this.currentMetric = metric;
    this.currentIndex = stepIndex;

    if (this.isHoveringPanel) {
      this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
      return;
    }

    const currentKw = (metric.power_kw || 0.0) * this.currentScaleFactor;
    const rawUnshadedKw = metric.unshaded_power_kw !== undefined ? metric.unshaded_power_kw : metric.power_kw;
    const unshadedKw = (rawUnshadedKw || 0.0) * this.currentScaleFactor;

    let incidentKw;
    let diffuseKw;
    if (metric.incident_power_kw !== undefined) {
      incidentKw = (metric.incident_power_kw || 0.0) * this.currentScaleFactor;
      diffuseKw = (metric.diffuse_power_kw !== undefined ? metric.diffuse_power_kw : Math.max(0.0, rawUnshadedKw - metric.incident_power_kw)) * this.currentScaleFactor;
    } else if (metric.diffuse_power_kw !== undefined) {
      diffuseKw = (metric.diffuse_power_kw || 0.0) * this.currentScaleFactor;
      incidentKw = Math.max(0.0, unshadedKw - diffuseKw);
    } else {
      incidentKw = unshadedKw;
      diffuseKw = 0.0;
    }

    const canopyLossKw = (metric.canopy_loss_kw || 0.0) * this.currentScaleFactor;
    const selfLossKw = (metric.self_shading_loss_kw || 0.0) * this.currentScaleFactor;
    const rawGeoLossKw = metric.geological_loss_kw !== undefined
      ? metric.geological_loss_kw
      : Math.max(0.0, rawUnshadedKw - (metric.canopy_loss_kw || 0.0) - (metric.self_shading_loss_kw || 0.0) - (metric.power_kw || 0.0));
    const geoLossKw = (rawGeoLossKw || 0.0) * this.currentScaleFactor;
    const totalShadeKw = geoLossKw + canopyLossKw + selfLossKw;

    // Stacked subtraction values: Incident (+ X) − Shade (− Y) + Diffuse (+ Z) = AC Power
    if (this.subIncidentVal) this.subIncidentVal.textContent = `+ ${incidentKw.toFixed(1)} kW`;
    if (this.subTotalShadeVal) this.subTotalShadeVal.textContent = `- ${totalShadeKw.toFixed(1)} kW`;
    if (this.subGeoShadeVal) this.subGeoShadeVal.textContent = `- ${geoLossKw.toFixed(1)} kW`;
    if (this.subTreeShadeVal) this.subTreeShadeVal.textContent = `- ${canopyLossKw.toFixed(1)} kW`;
    if (this.subSelfShadeVal) this.subSelfShadeVal.textContent = `- ${selfLossKw.toFixed(1)} kW`;
    if (this.subDiffuseVal) this.subDiffuseVal.textContent = `+ ${diffuseKw.toFixed(1)} kW`;
    if (this.subAcPowerVal) this.subAcPowerVal.textContent = `${currentKw.toFixed(1)} kW`;

    // Overlay 'Diffuse Only' badge when direct beam is blocked by racking tilt or past direct cutoff
    const isDiffuseOnly = Boolean(
      metric.is_diffuse_only ||
      (metric.is_daylight && rawUnshadedKw > 0 && canopyLossKw === 0 && geoLossKw === 0 && (metric.power_kw || 0) === rawUnshadedKw && (metric.solar_elevation_deg || 0) > 0 && (metric.poa_direct_w_m2 !== undefined ? metric.poa_direct_w_m2 <= 0.001 : false))
    );

    if (this.diffuseOnlyOverlay) {
      this.diffuseOnlyOverlay.style.display = isDiffuseOnly ? 'flex' : 'none';
    }

    this.chart.setPlayhead(stepIndex, this.currentScaleFactor);
  }

  showPanelTelemetry(panel, breakdown) {
    if (!panel || !breakdown) return;
    this.isHoveringPanel = true;

    if (this.panelHoverBanner && this.panelHoverLabel) {
      this.panelHoverBanner.style.display = 'flex';
      this.panelHoverLabel.textContent = panel.label || 'Hovered Solar Panel';
    }
    if (this.hoveredPanelIndicator) {
      this.hoveredPanelIndicator.style.display = 'inline-block';
    }
    if (this.instantaneousTitle) {
      this.instantaneousTitle.textContent = 'Individual Panel AC Power';
    }

    const sf = this.currentScaleFactor || 1.0;
    const incW = Math.round((breakdown.incidentW !== undefined ? breakdown.incidentW : (breakdown.unshadedW * 0.85)) * sf);
    const diffW = Math.round((breakdown.diffuseW !== undefined ? breakdown.diffuseW : (breakdown.unshadedW - incW)) * sf);
    const gW = Math.round((breakdown.geoLossW || 0) * sf);
    const tW = Math.round((breakdown.treeLossW || 0) * sf);
    const sW = Math.round((breakdown.selfLossW || 0) * sf);
    const totShadeW = Math.round((breakdown.totalShadeW !== undefined ? breakdown.totalShadeW : (gW + tW + sW)) * sf);
    const acW = Math.round((breakdown.acPowerW || 0) * sf);

    if (this.subIncidentVal) this.subIncidentVal.textContent = `+ ${incW} W`;
    if (this.subTotalShadeVal) this.subTotalShadeVal.textContent = `- ${totShadeW} W`;
    if (this.subGeoShadeVal) this.subGeoShadeVal.textContent = `- ${gW} W`;
    if (this.subTreeShadeVal) this.subTreeShadeVal.textContent = `- ${tW} W`;
    if (this.subSelfShadeVal) this.subSelfShadeVal.textContent = `- ${sW} W`;
    if (this.subDiffuseVal) this.subDiffuseVal.textContent = `+ ${diffW} W`;
    if (this.subAcPowerVal) this.subAcPowerVal.textContent = `${acW} W`;
  }

  clearPanelTelemetry() {
    this.isHoveringPanel = false;
    if (this.panelHoverBanner) {
      this.panelHoverBanner.style.display = 'none';
    }
    if (this.hoveredPanelIndicator) {
      this.hoveredPanelIndicator.style.display = 'none';
    }
    if (this.instantaneousTitle) {
      this.instantaneousTitle.textContent = 'Instantaneous AC Power';
    }
    if (this.currentMetric) {
      this.updateTelemetry(this.currentMetric, this.currentIndex);
    }
  }
}
