import test from 'node:test';
import assert from 'node:assert/strict';
import { SolarPanel3DLayer } from '../src/components/SolarPanel3DLayer.js';
import {
  rasterizePanelShadowMask,
  decodeDualBitmasksToImageData,
  decodeBitmaskToImageData,
  TERRAIN_SHADOW_WORD,
  CANOPY_SHADOW_WORD,
  SUN_PIXEL_WORD
} from '../src/utils/maskDecoder.js';

test('SolarPanel3DLayer initializes with custom 3D layer contract', () => {
  const layer = new SolarPanel3DLayer();
  assert.equal(layer.id, 'solar-panel-3d-layer');
  assert.equal(layer.type, 'custom');
  assert.equal(layer.renderingMode, '3d');
  assert.equal(layer.isVisible(), true);
  assert.equal(layer.getTotalPanels(), 0);
  assert.equal(layer.getTotalTables(), 0);
});

test('SolarPanel3DLayer buildGeometry converts layout tables into independent per-panel quads', () => {
  const layer = new SolarPanel3DLayer();

  const mockLayout = {
    total_panels: 16,
    total_tables: 2,
    installed_dc_kw: 8.8,
    row_pitch_m: 10.57,
    physical_gcr: 0.43,
    tables: [
      {
        table_id: 0,
        row_index: 0,
        panel_count: 8, // 4 pairs = 8 individual modules (4 bottom, 4 top)
        corners_wgs84: [
          [-73.5000, 45.5000], // SW
          [-73.4996, 45.5000], // SE
          [-73.4996, 45.5001], // NE
          [-73.5000, 45.5001]  // NW
        ],
        center_wgs84: [-73.4998, 45.50005],
        azimuth_deg: 180.0,
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56,
        width_m: 4.62,
        depth_m: 3.95
      },
      {
        table_id: 1,
        row_index: 1,
        panel_count: 8,
        corners_wgs84: [
          [-73.5000, 45.5002],
          [-73.4996, 45.5002],
          [-73.4996, 45.5003],
          [-73.5000, 45.5003]
        ],
        center_wgs84: [-73.4998, 45.50025],
        azimuth_deg: 180.0,
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56,
        width_m: 4.62,
        depth_m: 3.95
      }
    ]
  };

  layer.setLayout(mockLayout);

  assert.equal(layer.getTotalPanels(), 16);
  assert.equal(layer.getTotalTables(), 2);

  // 16 individual panels * 2 triangles * 3 vertices = 96 face vertices
  assert.equal(layer.faceVertexCount, 96);
  assert.ok(layer.faceVertices instanceof Float32Array);
  assert.equal(layer.faceVertices.length, 96 * 7);

  // Line vertices must include perimeter + mid seam + pair vertical seams + 4 posts per table
  assert.ok(layer.lineVertexCount > 0);
  assert.ok(layer.lineVertices instanceof Float32Array);
  assert.equal(layer.lineVertices.length, layer.lineVertexCount * 7);

  // Verify default unshaded color is sunlit white (R, G, B > 0.85)
  const r0 = layer.faceVertices[3];
  const g0 = layer.faceVertices[4];
  const b0 = layer.faceVertices[5];
  assert.ok(r0 > 0.85 && g0 > 0.85 && b0 > 0.85, 'Unshaded panel must be crisp architectural white');
});

test('SolarPanel3DLayer: each individual panel is independently shaded (not all-or-nothing)', () => {
  const layer = new SolarPanel3DLayer();

  // Single table with 4 pairs (8 panels total: 4 along bottom row, 4 along top row)
  const mockLayout = {
    total_panels: 8,
    total_tables: 1,
    row_pitch_m: 10.57,
    tables: [
      {
        table_id: 0,
        row_index: 0,
        panel_count: 8,
        corners_wgs84: [
          [-73.5000, 45.5000], // SW
          [-73.4960, 45.5000], // SE
          [-73.4960, 45.5010], // NE
          [-73.5000, 45.5010]  // NW
        ],
        center_wgs84: [-73.4980, 45.5005],
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56
      }
    ]
  };

  layer.setLayout(mockLayout);

  // Create a 4x1 grid mask where the left 2 cells are shaded by canopy and right 2 cells are sunlit
  // Terrain is 100% lit (11110000 = 0xF0)
  // Canopy is shaded on left, sun on right (00110000 = 0x30 in bit 7..4 -> bits: 0, 0, 1, 1)
  const terrainB64 = Buffer.from([0xF0]).toString('base64');
  const canopyB64 = Buffer.from([0x30]).toString('base64');
  const patchBounds = [-73.5000, 45.5000, -73.4960, 45.5010];

  layer.updateSunPosition(180.0, 45.0, true, terrainB64, canopyB64, patchBounds, 1, 4);

  // Total panels = 8 -> 8 panels * 6 vertices = 48 vertices
  assert.equal(layer.faceVertexCount, 48);

  // Panel 0 (left column bottom): under canopy -> forest green (G > R and G > B)
  const p0_r = layer.faceVertices[3];
  const p0_g = layer.faceVertices[4];
  const p0_b = layer.faceVertices[5];
  assert.ok(p0_g > p0_r && p0_g > p0_b, 'Left panel under canopy must be green');

  // Pair column 3 (right column bottom): in sun -> architectural white (R, G, B > 0.85)
  // Each pair column has 2 panels (12 vertices total: 6 for bottom panel, 6 for top panel)
  // Column 3 bottom panel starts at vertex 3 * 12 = 36 -> float index 36 * 7 + 3
  const p3_vertex = 3 * 12;
  const p3_r = layer.faceVertices[p3_vertex * 7 + 3];
  const p3_g = layer.faceVertices[p3_vertex * 7 + 4];
  const p3_b = layer.faceVertices[p3_vertex * 7 + 5];
  assert.ok(p3_r > 0.85 && p3_g > 0.85 && p3_b > 0.85, 'Right panel on same table must remain white in sun');
});

test('Binary ground shadows: geological shadow and panel shadow never produce deeper color on overlap', () => {
  const rows = 4;
  const cols = 4;
  const totalPixels = rows * cols;

  // Mock layout with 1 table
  const mockLayout = {
    total_panels: 4,
    total_tables: 1,
    tables: [
      {
        table_id: 0,
        row_index: 0,
        panel_count: 4,
        corners_wgs84: [
          [-73.50, 45.50],
          [-73.49, 45.50],
          [-73.49, 45.51],
          [-73.50, 45.51]
        ],
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56
      }
    ]
  };

  // 1. Generate panel shadow mask
  const patchBounds = [-73.51, 45.49, -73.48, 45.52];
  const panelShadowBytes = rasterizePanelShadowMask(mockLayout, 180.0, 45.0, patchBounds, rows, cols);
  assert.ok(panelShadowBytes instanceof Uint8Array);

  // 2. Decode dual bitmasks with panel shadows
  // All terrain unshaded (0xFFFF) except top-left pixel (bit 7 = 0)
  const terrainB64 = Buffer.from([0x7F, 0xFF]).toString('base64');
  const canopyB64 = Buffer.from([0xFF, 0xFF]).toString('base64');

  const imgData = decodeDualBitmasksToImageData(terrainB64, canopyB64, rows, cols, null, panelShadowBytes);
  const data32 = new Uint32Array(imgData.data.buffer);

  // Every shaded pixel must be EXACTLY TERRAIN_SHADOW_WORD or CANOPY_SHADOW_WORD
  // It is mathematically impossible for an overlap pixel to have any deeper color
  for (let i = 0; i < totalPixels; i++) {
    const val = data32[i];
    assert.ok(
      val === SUN_PIXEL_WORD || val === TERRAIN_SHADOW_WORD || val === CANOPY_SHADOW_WORD,
      `Pixel ${i} must have strictly binary shadow word (got ${val.toString(16)})`
    );
  }

  // Ensure geological shadow = X colour, panel shadow = X colour, geological + panel shadow = X colour
  const sampleGeoOnly = decodeBitmaskToImageData(Buffer.from([0x00]).toString('base64'), 1, 1, null, null);
  const samplePanelOnly = decodeBitmaskToImageData(Buffer.from([0x80]).toString('base64'), 1, 1, null, new Uint8Array([1]));
  const sampleBoth = decodeBitmaskToImageData(Buffer.from([0x00]).toString('base64'), 1, 1, null, new Uint8Array([1]));

  const wordGeo = new Uint32Array(sampleGeoOnly.data.buffer)[0];
  const wordPanel = new Uint32Array(samplePanelOnly.data.buffer)[0];
  const wordBoth = new Uint32Array(sampleBoth.data.buffer)[0];

  assert.equal(wordGeo, TERRAIN_SHADOW_WORD);
  assert.equal(wordPanel, TERRAIN_SHADOW_WORD);
  assert.equal(wordBoth, TERRAIN_SHADOW_WORD);
  assert.equal(wordGeo, wordBoth, 'Geological + panel shadow must be identical in color to geological shadow alone');
});

test('SolarPanel3DLayer clear resets geometries and buffer counts', () => {
  const layer = new SolarPanel3DLayer();
  const mockLayout = {
    total_panels: 8,
    total_tables: 1,
    tables: [
      {
        table_id: 0,
        corners_wgs84: [[-73.5, 45.5], [-73.49, 45.5], [-73.49, 45.51], [-73.5, 45.51]],
        panel_count: 8,
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56
      }
    ]
  };

  layer.setLayout(mockLayout);
  assert.ok(layer.faceVertexCount > 0);

  layer.clear();
  assert.equal(layer.faceVertexCount, 0);
  assert.equal(layer.lineVertexCount, 0);
  assert.equal(layer.layout, null);
});

test('SolarPanel3DLayer toggles visibility and respects render suppression', () => {
  const layer = new SolarPanel3DLayer();
  assert.equal(layer.isVisible(), true);

  layer.setVisible(false);
  assert.equal(layer.isVisible(), false);

  let drawCallCount = 0;
  const mockGl = {
    useProgram: () => {},
    uniformMatrix4fv: () => {},
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    blendFunc: () => {},
    bindBuffer: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    drawArrays: () => { drawCallCount++; }
  };

  // When hidden, render must return early and never call drawArrays
  layer.faceVertexCount = 12;
  layer.faceBuffer = {};
  layer.program = {};
  layer.render(mockGl, new Float32Array(16));
  assert.equal(drawCallCount, 0);

  // When visible, render executes drawArrays
  layer.setVisible(true);
  layer.render(mockGl, new Float32Array(16));
  assert.ok(drawCallCount > 0);
});
