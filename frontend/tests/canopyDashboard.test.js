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

test('SolarDashboard: telemetry correctly populates canopy loss badges and daily metrics', () => {
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
      unshaded_peak_kw: 82.1
    },
    timeseries: [
      {
        timestamp: '2026-12-21T11:36:00-05:00',
        power_kw: 53.1,
        unshaded_power_kw: 81.9,
        canopy_loss_kw: 28.8,
        percent_shaded: 0.0,
        canopy_shaded_pct: 92.1,
        is_daylight: true
      }
    ]
  };

  dashboard.setSimulationData(mockSimulationData);

  assert.equal(dashboard.kwhTotal.textContent, '231.9');
  assert.equal(dashboard.peakKw.textContent, '54.4');
  assert.equal(dashboard.dailyCanopyLossVal.textContent, '-105.4 kWh');
  assert.equal(dashboard.dailyCanopyLossPct.textContent, '(-31.2%)');
  assert.equal(dashboard.unshadedPeakVal.textContent, '82.1 kW');

  // Update telemetry for 11:36 frame
  dashboard.updateTelemetry(mockSimulationData.timeseries[0], 0);

  assert.equal(dashboard.kwGauge.textContent, '53.1');
  assert.equal(dashboard.unshadedKwVal.textContent, '81.9 kW');
  assert.equal(dashboard.canopyLossKw.textContent, '-28.8 kW');
  assert.equal(dashboard.canopyLossPct.textContent, '(-35.2%)');
  assert.equal(dashboard.canopyShadedPctVal.textContent, '92.1%');
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
});
