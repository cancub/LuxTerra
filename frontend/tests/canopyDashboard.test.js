import test from 'node:test';
import assert from 'node:assert/strict';

function createMockElement(tag = 'div') {
  const attributes = {};
  const el = {
    tagName: tag.toUpperCase(),
    className: '',
    style: {},
    textContent: '',
    innerHTML: '',
    attributes,
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: (k) => (k in attributes ? attributes[k] : null),
    appendChild: () => {},
    addEventListener: () => {},
    querySelector: (sel) => createMockElement('div'),
    querySelectorAll: () => []
  };
  return el;
}

// Polyfill minimal DOM for SolarDashboard and SparklineChart testing in Node.js
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: (tag) => createMockElement(tag)
  };
}

import { SolarDashboard } from '../src/components/SolarDashboard.js';
import { SparklineChart } from '../src/components/SparklineChart.js';
import { PVConfigPanel } from '../src/components/PVConfigPanel.js';

test('canopy physics: direct beam attenuation formula matches winter and summer transmittance', () => {
  const unshadedDirectKw = 80.0;
  const diffuseKw = 10.0;
  const canopyPct = 92.1; // 92.1% of cells under canopy

  // Winter leaf-off (tau = 0.66)
  const tauWinter = 0.66;
  const netTransmissionWinter = (100 - canopyPct * (1 - tauWinter)) / 100.0;
  const actualDirectWinter = unshadedDirectKw * netTransmissionWinter;
  const actualPowerWinter = actualDirectWinter + diffuseKw;
  const canopyLossWinter = unshadedDirectKw * (1 - netTransmissionWinter);

  assert.ok(Math.abs(netTransmissionWinter - 0.68686) < 0.001);
  assert.ok(Math.abs(actualPowerWinter - 64.95) < 0.1);
  assert.ok(Math.abs(canopyLossWinter - 25.05) < 0.1);

  // Summer leaf-on (tau = 0.15)
  const tauSummer = 0.15;
  const netTransmissionSummer = (100 - canopyPct * (1 - tauSummer)) / 100.0;
  const actualDirectSummer = unshadedDirectKw * netTransmissionSummer;
  const actualPowerSummer = actualDirectSummer + diffuseKw;
  const canopyLossSummer = unshadedDirectKw * (1 - netTransmissionSummer);

  // In summer dense leaf-on, canopy blocks 85% of direct sunlight!
  assert.ok(netTransmissionSummer < netTransmissionWinter);
  assert.ok(canopyLossSummer > canopyLossWinter);
});

test('SolarDashboard: telemetry correctly populates stacked subtraction and 3-part shade bar', () => {
  const container = createMockElement('div');
  const dashboard = new SolarDashboard(container);

  const mockSimulationData = {
    metadata: {
      patch_area_m2: 622,
      has_canopy_data: true,
      include_tree_canopy: true
    },
    canopy_transmittance: 0.66,
    daily_summary: {
      total_daily_kwh: 231.9,
      unshaded_daily_kwh: 337.3,
      canopy_loss_kwh: 105.4,
      canopy_loss_pct: 31.2,
      peak_power_kw: 54.4,
      unshaded_peak_kw: 82.1,
      optimal_tilt_deg: 69.6
    },
    timeseries: [
      {
        timestamp: '2026-12-21T11:36:00-05:00',
        power_kw: 53.1,
        unshaded_power_kw: 81.9,
        canopy_loss_kw: 28.8,
        geological_loss_kw: 0.0,
        percent_shaded: 0.0,
        canopy_shaded_pct: 92.1,
        is_daylight: true,
        is_diffuse_only: false
      },
      {
        timestamp: '2026-12-21T16:15:00-05:00',
        power_kw: 1.2,
        unshaded_power_kw: 1.2,
        canopy_loss_kw: 0.0,
        geological_loss_kw: 0.0,
        percent_shaded: 0.0,
        canopy_shaded_pct: 0.0,
        is_daylight: true,
        is_diffuse_only: true
      },
      {
        timestamp: '2026-12-21T22:00:00-05:00',
        power_kw: 0.0,
        unshaded_power_kw: 0.0,
        canopy_loss_kw: 0.0,
        geological_loss_kw: 0.0,
        percent_shaded: 100.0,
        canopy_shaded_pct: 0.0,
        is_daylight: false,
        is_diffuse_only: false
      }
    ]
  };

  dashboard.setSimulationData(mockSimulationData);

  // Daily energy is displayed at top without loss mention, and seasonal optimal tilt is shown
  assert.equal(dashboard.kwhTotal.textContent, '231.9');
  assert.equal(dashboard.tiltVal.textContent, '69.6°');

  // Update telemetry for daylight frame (11:36)
  dashboard.updateTelemetry(mockSimulationData.timeseries[0], 0);

  // Stacked subtraction: Clear-Sky (81.9) - Geological Shade (0.0) - Tree Shade (28.8) - Panel Self-Shade (0.0) = AC Power (53.1)
  assert.equal(dashboard.subClearSkyVal.textContent, '81.9 kW');
  assert.equal(dashboard.subGeoShadeVal.textContent, '0.0 kW');
  assert.equal(dashboard.subTreeShadeVal.textContent, '28.8 kW');
  assert.equal(dashboard.subSelfShadeVal.textContent, '0.0 kW');
  assert.equal(dashboard.subAcPowerVal.textContent, '53.1 kW');
  assert.equal(dashboard.kwGauge.textContent, '53.1 kW');
  assert.equal(dashboard.diffuseOnlyOverlay.style.display, 'none');

  // Update telemetry for diffuse-only twilight frame (16:15)
  dashboard.updateTelemetry(mockSimulationData.timeseries[1], 1);
  assert.equal(dashboard.subClearSkyVal.textContent, '1.2 kW');
  assert.equal(dashboard.subAcPowerVal.textContent, '1.2 kW');
  assert.equal(dashboard.diffuseOnlyOverlay.style.display, 'flex');

  // Verify diffuse tooltip content and pill structure
  assert.ok(dashboard.diffuseOnlyOverlay, 'Diffuse overlay element must exist');
  assert.match(dashboard.element.innerHTML, /Ambient Sky Light Only/);
  assert.match(dashboard.element.innerHTML, /Direct sunbeams are no longer hitting/);
  assert.match(dashboard.element.innerHTML, /no direct shadows to subtract/);

  // Update telemetry for nighttime frame
  dashboard.updateTelemetry(mockSimulationData.timeseries[2], 2);
  assert.equal(dashboard.subAcPowerVal.textContent, '0.0 kW');
  assert.equal(dashboard.diffuseOnlyOverlay.style.display, 'none');
});

test('SolarDashboard: displays ground-mount layout specifications in Daily Energy card', () => {
  const container = createMockElement('div');
  const dashboard = new SolarDashboard(container);

  const mockGroundMountData = {
    metadata: {
      patch_area_m2: 4000,
      effective_gcr: 0.422
    },
    daily_summary: {
      total_daily_kwh: 1250.0,
      peak_power_kw: 210.0,
      unshaded_peak_kw: 220.0,
      optimal_tilt_deg: 30.0,
      total_panels: 480,
      installed_dc_kw: 264.0
    },
    layout: {
      total_panels: 480,
      total_tables: 30,
      installed_dc_kw: 264.0,
      physical_gcr: 0.422
    },
    timeseries: []
  };

  dashboard.setSimulationData(mockGroundMountData);

  assert.equal(dashboard.arraySpecsRow.style.display, 'flex');
  assert.equal(dashboard.arrayPanelsBadge.textContent, '480 Panels');
  assert.equal(dashboard.arrayDcBadge.textContent, '264.0 kWp');
  assert.equal(dashboard.arrayGcrBadge.textContent, 'GCR 42.2%');
  assert.equal(dashboard.arrayDcAcBadge.textContent, '(DC/AC 1.20)');

  // When cleared, layout row is hidden
  dashboard.setSimulationData(null);
  assert.equal(dashboard.arraySpecsRow.style.display, 'none');
});

test('SolarDashboard: showPanelTelemetry and clearPanelTelemetry display individual panel breakdown in card', () => {
  const container = createMockElement('div');
  const dashboard = new SolarDashboard(container);

  const mockMetric = {
    is_daylight: true,
    power_kw: 31.6,
    unshaded_power_kw: 55.8,
    geological_loss_kw: 0.2,
    canopy_loss_kw: 21.5,
    self_shading_loss_kw: 2.5
  };

  dashboard.updateTelemetry(mockMetric, 12);
  assert.equal(dashboard.subAcPowerVal.textContent, '31.6 kW');
  assert.equal(dashboard.subClearSkyVal.textContent, '55.8 kW');

  // Hover over an individual module
  const mockPanel = {
    id: 't0_c0_B',
    label: 'Table 1 · Row 1 · Module 1 (Bottom)'
  };
  const mockBreakdown = {
    unshadedW: 845.0,
    geoLossW: 0.0,
    treeLossW: 320.0,
    selfLossW: 0.0,
    acPowerW: 525.0
  };

  dashboard.showPanelTelemetry(mockPanel, mockBreakdown);

  assert.equal(dashboard.panelHoverBanner.style.display, 'flex');
  assert.equal(dashboard.panelHoverLabel.textContent, 'Table 1 · Row 1 · Module 1 (Bottom)');
  assert.equal(dashboard.hoveredPanelIndicator.style.display, 'inline-block');
  assert.equal(dashboard.instantaneousTitle.textContent, 'Individual Panel AC Power');

  assert.equal(dashboard.subClearSkyVal.textContent, '845 W');
  assert.equal(dashboard.subGeoShadeVal.textContent, '0 W');
  assert.equal(dashboard.subTreeShadeVal.textContent, '320 W');
  assert.equal(dashboard.subSelfShadeVal.textContent, '0 W');
  assert.equal(dashboard.subAcPowerVal.textContent, '525 W');

  // Unhover restores array-wide kW values
  dashboard.clearPanelTelemetry();
  assert.equal(dashboard.panelHoverBanner.style.display, 'none');
  assert.equal(dashboard.hoveredPanelIndicator.style.display, 'none');
  assert.equal(dashboard.instantaneousTitle.textContent, 'Instantaneous AC Power');
  assert.equal(dashboard.subAcPowerVal.textContent, '31.6 kW');
  assert.equal(dashboard.subClearSkyVal.textContent, '55.8 kW');
});

test('PVConfigPanel: collapsible by default and toggles expand/collapse', (t, done) => {
  const container = createMockElement('div');
  const panel = new PVConfigPanel(container);

  let scrollCalled = false;
  panel.element.scrollIntoView = (opts) => {
    scrollCalled = true;
  };

  assert.equal(panel.isCollapsed, true);
  assert.equal(panel.body.style.display, 'none');
  assert.equal(panel.deploymentMode, 'ground_mount');
  assert.equal(panel.gcr, 0.45);

  panel.toggleCollapse();
  assert.equal(panel.isCollapsed, false);
  assert.equal(panel.body.style.display, 'flex');

  // Verify scrollIntoView triggered on expansion
  setTimeout(() => {
    assert.equal(scrollCalled, true);

    panel.toggleCollapse();
    assert.equal(panel.isCollapsed, true);
    assert.equal(panel.body.style.display, 'none');
    done();
  }, 60);
});

test('SparklineChart: correctly builds clear-sky potential curve and canopy loss region', () => {
  const container = createMockElement('div');
  const chart = new SparklineChart(container);

  const timeseries = [
    { power_kw: 0.0, unshaded_power_kw: 0.0, canopy_loss_kw: 0.0 },
    { power_kw: 30.0, unshaded_power_kw: 50.0, canopy_loss_kw: 20.0 },
    { power_kw: 53.1, unshaded_power_kw: 81.9, canopy_loss_kw: 28.8 },
    { power_kw: 25.0, unshaded_power_kw: 45.0, canopy_loss_kw: 20.0 },
    { power_kw: 0.0, unshaded_power_kw: 0.0, canopy_loss_kw: 0.0 }
  ];

  chart.setData(timeseries, 1.0);

  // Maximum power should reflect the unshaded potential peak (81.9 kW), not just actual
  assert.equal(chart.maxPowerKw, 81.9);

  // Lines and areas must be populated
  assert.ok(chart.line.getAttribute('points').length > 0);
  assert.ok(chart.area.getAttribute('points').length > 0);
  assert.ok(chart.potentialLine.getAttribute('points').length > 0);
  assert.ok(chart.canopyLossArea.getAttribute('points').length > 0);
  assert.equal(chart.canopyLossArea.style.display, 'block');

  // Verify chart collapsible toggle
  assert.equal(chart.isCollapsed, false);
  chart.toggleCurveCollapse();
  assert.equal(chart.isCollapsed, true);
  assert.equal(chart.curveBody.style.display, 'none');
  chart.toggleCurveCollapse();
  assert.equal(chart.isCollapsed, false);
  assert.equal(chart.curveBody.style.display, 'flex');

  // Verify legend collapsible toggle
  assert.equal(chart.isLegendCollapsed, false);
  chart.toggleLegendCollapse();
  assert.equal(chart.isLegendCollapsed, true);
  assert.equal(chart.legendItems.style.display, 'none');
  chart.toggleLegendCollapse();
  assert.equal(chart.isLegendCollapsed, false);
  assert.equal(chart.legendItems.style.display, 'flex');
});

test('PVConfigPanel: modal mode opens body expanded with hidden inner header', () => {
  const container = createMockElement('div');
  const panel = new PVConfigPanel(container, () => {}, { isModal: true });

  assert.equal(panel.isModal, true);
  assert.equal(panel.isCollapsed, false);
  assert.equal(panel.body.style.display, 'flex');
  assert.equal(panel.header.style.display, 'none');
});
