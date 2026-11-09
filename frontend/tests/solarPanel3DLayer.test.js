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
});

test('SolarPanel3DLayer buildGeometry converts layout tables into 3D quads and mounting posts', () => {
  const layer = new SolarPanel3DLayer();

  const mockLayout = {
    total_panels: 16,
    total_tables: 2,
    installed_dc_kw: 8.8,
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
  // 2 tables * 2 triangles * 3 vertices = 12 face vertices
  assert.equal(layer.faceVertexCount, 12);
  assert.ok(layer.faceVertices instanceof Float32Array);
  assert.equal(layer.faceVertices.length, 12 * 7);

  // Line vertices must include perimeter + mid seam + pair vertical seams + 4 posts per table
  assert.ok(layer.lineVertexCount > 0);
  assert.ok(layer.lineVertices instanceof Float32Array);
  assert.equal(layer.lineVertices.length, layer.lineVertexCount * 7);

  // Verify elevation differential: top vertices (z) must be higher than bottom vertices (z)
  // Triangle 1: SW (v0), SE (v1), NE (v2)
  const swZ = layer.faceVertices[2]; // vertex 0 z
  const neZ = layer.faceVertices[2 + 2 * 7]; // vertex 2 z
  assert.ok(neZ > swZ, `NE vertex elevation (${neZ}) must be higher than SW (${swZ}) to face south`);
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
  assert.equal(layer.faceVertexCount, 6);

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

  let drawCalled = false;
  const mockGl = {
    useProgram: () => {},
    uniformMatrix4fv: () => {},
    enable: () => {},
    disable: () => {},
    depthFunc: () => {},
    blendFunc: () => {},
    bindBuffer: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    drawArrays: () => { drawCalled = true; }
  };

  // When hidden, render must return early and never call drawArrays
  layer.faceVertexCount = 12;
  layer.program = {};
  layer.render(mockGl, new Float32Array(16));
  assert.equal(drawCalled, false);

  // When visible, render executes drawArrays
  layer.setVisible(true);
  layer.render(mockGl, new Float32Array(16));
  assert.equal(drawCalled, true);
});
