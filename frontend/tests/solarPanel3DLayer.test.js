import test from 'node:test';
import assert from 'node:assert/strict';
import { SolarPanel3DLayer } from '../src/components/SolarPanel3DLayer.js';

test('SolarPanel3DLayer initializes with custom 3D layer contract', () => {
  const layer = new SolarPanel3DLayer();
  assert.equal(layer.id, 'solar-panel-3d-layer');
  assert.equal(layer.type, 'custom');
  assert.equal(layer.renderingMode, '3d');
  assert.equal(layer.isVisible(), true);
  assert.equal(layer.getTotalPanels(), 0);
  assert.equal(layer.getTotalTables(), 0);
  assert.equal(layer.shadowVertexCount, 0);
});

test('SolarPanel3DLayer buildGeometry converts layout tables into 3D quads, ground shadows, and mounting posts', () => {
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
        panel_count: 8,
        corners_wgs84: [
          [-73.5000, 45.5000], // SW
          [-73.4999, 45.5000], // SE
          [-73.4999, 45.5001], // NE
          [-73.5000, 45.5001]  // NW
        ],
        center_wgs84: [-73.49995, 45.50005],
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
          [-73.4999, 45.5002],
          [-73.4999, 45.5003],
          [-73.5000, 45.5003]
        ],
        center_wgs84: [-73.49995, 45.50025],
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

  // 2 tables * 2 2P module quads (bottom + top) * 2 triangles * 3 vertices = 24 face vertices
  assert.equal(layer.faceVertexCount, 24);
  assert.ok(layer.faceVertices instanceof Float32Array);
  assert.equal(layer.faceVertices.length, 24 * 7);

  // Ground shadows: each table casts projected shadow quads on ground plane (z = 0)
  assert.ok(layer.shadowVertexCount > 0);
  assert.ok(layer.shadowVertices instanceof Float32Array);
  assert.equal(layer.shadowVertices.length, layer.shadowVertexCount * 7);

  // Line vertices must include perimeter + mid seam + pair vertical seams + 4 posts per table
  assert.ok(layer.lineVertexCount > 0);
  assert.ok(layer.lineVertices instanceof Float32Array);
  assert.equal(layer.lineVertices.length, layer.lineVertexCount * 7);

  // Verify default unshaded color is sunlit white (R, G, B > 0.85)
  // Vertex 0: [x, y, z, r, g, b, a]
  const r0 = layer.faceVertices[3];
  const g0 = layer.faceVertices[4];
  const b0 = layer.faceVertices[5];
  assert.ok(r0 > 0.85 && g0 > 0.85 && b0 > 0.85, 'Unshaded panel must be crisp architectural white');
});

test('SolarPanel3DLayer updates panel colors dynamically under tree canopy vs geological shade', () => {
  const layer = new SolarPanel3DLayer();

  const mockLayout = {
    total_panels: 8,
    total_tables: 1,
    row_pitch_m: 10.57,
    tables: [
      {
        table_id: 0,
        row_index: 0,
        panel_count: 8,
        corners_wgs84: [[-73.5, 45.5], [-73.49, 45.5], [-73.49, 45.51], [-73.5, 45.51]],
        center_wgs84: [-73.495, 45.505],
        tilt_deg: 30.0,
        stand_height_m: 1.0,
        slant_height_m: 4.56
      }
    ]
  };

  layer.setLayout(mockLayout);

  // Case 1: Sunlight without shade -> White panels
  layer.updateSunPosition(180.0, 45.0, true);
  assert.ok(layer.faceVertices[3] > 0.85, 'Panel must be white in direct sun');

  // Case 2: Tree canopy shade (canopy mask bit is 0, terrain mask bit is 1)
  // 1x1 mask: terrain = 'gA==' (byte 0x80 = 10000000 -> bit 0 = 1), canopy = 'AA==' (byte 0x00 = 00000000 -> bit 0 = 0)
  layer.updateSunPosition(180.0, 45.0, true, 'gA==', 'AA==', [-73.51, 45.49, -73.48, 45.52], 1, 1);
  const canopyR = layer.faceVertices[3];
  const canopyG = layer.faceVertices[4];
  const canopyB = layer.faceVertices[5];
  assert.ok(canopyG > canopyR && canopyG > canopyB, 'Panel under tree canopy must darken with rich forest green');

  // Case 3: Geological terrain shade (terrain mask bit is 0)
  layer.updateSunPosition(180.0, 45.0, true, 'AA==', 'AA==', [-73.51, 45.49, -73.48, 45.52], 1, 1);
  const geoR = layer.faceVertices[3];
  const geoG = layer.faceVertices[4];
  const geoB = layer.faceVertices[5];
  assert.ok(geoR < 0.20 && geoG < 0.20 && geoB < 0.25, 'Panel under geological terrain shade must darken with deep dark slate');
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
  assert.equal(layer.faceVertexCount, 12);
  assert.ok(layer.shadowVertexCount > 0);

  layer.clear();
  assert.equal(layer.faceVertexCount, 0);
  assert.equal(layer.shadowVertexCount, 0);
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
  layer.shadowVertexCount = 12;
  layer.shadowBuffer = {};
  layer.program = {};
  layer.render(mockGl, new Float32Array(16));
  assert.equal(drawCallCount, 0);

  // When visible, render executes drawArrays
  layer.setVisible(true);
  layer.render(mockGl, new Float32Array(16));
  assert.ok(drawCallCount > 0);
});
