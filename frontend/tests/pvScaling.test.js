import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Validates instantaneous mathematical scaling for PV power calculations.
 * Avoids unnecessary network requests when user tweaks GCR, efficiency, or PR.
 */
function computeScaledPower(basePowerKw, baseConfig, newConfig) {
  const gcrRatio = newConfig.gcr / baseConfig.gcr;
  const effRatio = newConfig.moduleEfficiency / baseConfig.moduleEfficiency;
  const prRatio = newConfig.systemDerate / baseConfig.systemDerate;
  return basePowerKw * gcrRatio * effRatio * prRatio;
}

test('scaling from rooftop (100% GCR) to ground-mount (45% GCR) scales by exactly 0.45', () => {
  const basePower = 100.0; // kW
  const baseConfig = { gcr: 1.0, moduleEfficiency: 0.20, systemDerate: 0.80 };
  const newConfig = { gcr: 0.45, moduleEfficiency: 0.20, systemDerate: 0.80 };

  const scaled = computeScaledPower(basePower, baseConfig, newConfig);
  assert.equal(Math.round(scaled * 100) / 100, 45.0);
});

test('scaling efficiency from 20% to 22% scales power by 1.1x', () => {
  const basePower = 100.0;
  const baseConfig = { gcr: 1.0, moduleEfficiency: 0.20, systemDerate: 0.80 };
  const newConfig = { gcr: 1.0, moduleEfficiency: 0.22, systemDerate: 0.80 };

  const scaled = computeScaledPower(basePower, baseConfig, newConfig);
  assert.equal(Math.round(scaled * 100) / 100, 110.0);
});
