import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import {
  clampBboxToMaxArea,
  computeBboxDimensions,
  MAX_PATCH_AREA_M2
} from '../src/utils/geometry.js';
import {
  decodeBitmaskToImageData,
  SHADOW_PIXEL_WORD,
  SUN_PIXEL_WORD
} from '../src/utils/maskDecoder.js';

let serverProc = null;
const SERVER_URL = 'http://127.0.0.1:8000';

before(async () => {
  // Check if server is already running
  try {
    const res = await fetch(`${SERVER_URL}/api/health`);
    if (res.ok) {
      console.log('FastAPI backend already active on port 8000');
      return;
    }
  } catch (_) {
    // Not running; spawn it
  }

  const projectRoot = resolve(process.cwd(), '..');
  const uvicornPath = resolve(projectRoot, '.venv/bin/uvicorn');

  console.log('Spawning FastAPI server for e2e integration test...');
  serverProc = spawn(uvicornPath, ['backend.app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
    cwd: projectRoot,
    stdio: 'ignore'
  });

  // Poll until healthy
  const startTime = Date.now();
  let online = false;
  while (Date.now() - startTime < 12000) {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      if (res.ok) {
        online = true;
        break;
      }
    } catch (_) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!online) {
    if (serverProc) serverProc.kill();
    throw new Error('Failed to boot FastAPI backend within timeout');
  }
});

after(() => {
  if (serverProc) {
    console.log('Terminating test FastAPI server process...');
    serverProc.kill('SIGTERM');
  }
});

test('E2E: Query elevation locations preset metadata', async () => {
  const res = await fetch(`${SERVER_URL}/api/elevation/locations`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.locations));
  assert.equal(data.locations.length, 2);

  const montreal = data.locations.find(l => l.id === 'montreal');
  assert.ok(montreal);
  assert.equal(montreal.is_cached, true);
  assert.equal(montreal.utm_crs, 'EPSG:32618');
});

test('E2E: Draw box on Mount Royal hillside and clamp to <= 100,000 m²', () => {
  // Montreal test coordinates around Édouard-Montpetit
  const startLon = -73.619;
  const startLat = 45.502;
  const endLon = -73.617;
  const endLat = 45.504;

  const clamped = clampBboxToMaxArea(startLon, startLat, endLon, endLat, MAX_PATCH_AREA_M2);
  assert.ok(clamped.areaM2 <= MAX_PATCH_AREA_M2);
  assert.ok(clamped.widthM > 0);
  assert.ok(clamped.heightM > 0);
});

test('E2E: Execute batch simulation and verify timeseries and shadow masks', async () => {
  const payload = {
    bbox: {
      min_lon: -73.619,
      min_lat: 45.502,
      max_lon: -73.617,
      max_lat: 45.504
    },
    date: '2026-06-21',
    time_step_minutes: 15,
    deployment_mode: 'rooftop'
  };

  const res = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const data = await res.json();

  // 1. Verify metadata & patch bounds for canvas projection
  assert.ok(data.metadata.patch_bounds_wgs84);
  assert.equal(data.metadata.patch_bounds_wgs84.length, 4);
  assert.equal(data.metadata.deployment_mode, 'rooftop');
  assert.equal(data.metadata.effective_gcr, 1.0);

  // 2. Verify summary metrics
  assert.ok(data.daily_summary.total_daily_kwh > 0);
  assert.ok(data.daily_summary.peak_power_kw > 0);
  assert.ok(data.daily_summary.daylight_hours > 14);

  // 3. Verify timeseries structure
  const timeseries = data.timeseries;
  assert.equal(timeseries.length, 96); // 24 hours * 4 steps/hour

  // 4. Verify binary masks decoding across morning vs noon
  const masks = data.masks;
  const daylightSteps = timeseries.filter(s => s.is_daylight);
  assert.equal(masks.length, daylightSteps.length);

  const rows = data.metadata.grid_rows;
  const cols = data.metadata.grid_cols;

  // Morning frame (first daylight mask)
  const morningImg = decodeBitmaskToImageData(masks[0], rows, cols, null);
  const morningWords = new Uint32Array(morningImg.data.buffer);
  const morningShadowCount = morningWords.filter(w => w === SHADOW_PIXEL_WORD).length;

  // Solar noon frame (middle daylight mask)
  const noonMaskIdx = Math.floor(masks.length / 2);
  const noonImg = decodeBitmaskToImageData(masks[noonMaskIdx], rows, cols, null);
  const noonWords = new Uint32Array(noonImg.data.buffer);
  const noonSunCount = noonWords.filter(w => w === SUN_PIXEL_WORD).length;

  // Noon must have significant direct sunlight
  assert.ok(noonSunCount > 0, 'Solar noon should have unshaded direct sunlight');
  assert.ok(morningWords.length === rows * cols);
});

test('E2E: Instantaneous PV Scaling (Rooftop 100% GCR vs Ground-Mount 45% GCR)', async () => {
  const basePayload = {
    bbox: {
      min_lon: -73.619,
      min_lat: 45.502,
      max_lon: -73.617,
      max_lat: 45.504
    },
    date: '2026-06-21',
    time_step_minutes: 30,
    include_tree_canopy: false,
    deployment_mode: 'rooftop'
  };

  const rooftopRes = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(basePayload)
  });
  const rooftopData = await rooftopRes.json();

  const groundPayload = { ...basePayload, deployment_mode: 'ground_mount' };
  const groundRes = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(groundPayload)
  });
  const groundData = await groundRes.json();

  // Validate bare terrain ground power is scaled by 0.45 GCR
  const rooftopKwh = rooftopData.daily_summary.total_daily_kwh;
  const groundKwh = groundData.daily_summary.total_daily_kwh;
  const ratio = groundKwh / rooftopKwh;

  assert.ok(Math.abs(ratio - 0.45) < 0.01, `Ground-mount ratio ${ratio} expected to be ~0.45`);

  // Ground mount with canopy enabled suffers additional structure/tree shade
  const canopyRes = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...groundPayload, include_tree_canopy: true })
  });
  const canopyData = await canopyRes.json();
  assert.ok(canopyData.daily_summary.total_daily_kwh < groundKwh, 'Canopy shade should reduce ground mount yield');
});

test('E2E: Tree Canopy Shading Dual Bitmasks and Phenology Mode', async () => {
  const payload = {
    bbox: {
      min_lon: -73.619,
      min_lat: 45.502,
      max_lon: -73.617,
      max_lat: 45.504
    },
    date: '2026-06-21',
    time_step_minutes: 30,
    include_tree_canopy: true,
    canopy_mode: 'seasonal',
    deployment_mode: 'ground_mount'
  };

  const res = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.metadata.include_tree_canopy, true);
  assert.equal(data.metadata.canopy_mode, 'seasonal');
  assert.equal(data.metadata.has_canopy_data, true);
  assert.ok(Array.isArray(data.masks) && data.masks.length > 0);
  assert.ok(Array.isArray(data.canopy_masks) && data.canopy_masks.length === data.masks.length);
  assert.equal(data.canopy_transmittance, 0.15); // Summer solstice = 0.15
  assert.ok(data.daily_summary.avg_canopy_shaded_pct >= 0.0);
});

test('E2E: Foliage Mode Overrides (leaf_on vs leaf_off)', async () => {
  const base = {
    bbox: {
      min_lon: -73.619,
      min_lat: 45.502,
      max_lon: -73.617,
      max_lat: 45.504
    },
    date: '2026-06-21',
    time_step_minutes: 30,
    include_tree_canopy: true,
    deployment_mode: 'ground_mount'
  };

  const resSummer = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, canopy_mode: 'leaf_on' })
  });
  const dataSummer = await resSummer.json();

  const resWinter = await fetch(`${SERVER_URL}/api/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...base, canopy_mode: 'leaf_off' })
  });
  const dataWinter = await resWinter.json();

  assert.equal(dataSummer.canopy_transmittance, 0.15);
  assert.equal(dataWinter.canopy_transmittance, 0.60);
  assert.ok(
    dataWinter.daily_summary.total_daily_kwh > dataSummer.daily_summary.total_daily_kwh,
    'Bare branches in winter mode should permit more sunlight than dense summer foliage'
  );
});
