import test from 'node:test';
import assert from 'node:assert/strict';

// Setup minimal DOM polyfill for BoxDrawer instantiation in Node.js
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      className: '',
      style: {},
      innerHTML: '',
      addEventListener: () => {},
      appendChild: () => {},
      classList: { add: () => {}, remove: () => {} }
    }),
    body: { appendChild: () => {} }
  };
}
if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    addEventListener: () => {},
    removeEventListener: () => {}
  };
}

import { BoxDrawer } from '../src/components/BoxDrawer.js';

function createMockMap(bearing = 0) {
  const eventHandlers = {};
  const sources = {};
  const rad = (bearing * Math.PI) / 180;
  const cosB = Math.cos(rad);
  const sinB = Math.sin(rad);

  return {
    isStyleLoaded: () => true,
    getSource: (id) => sources[id],
    addSource: (id, data) => {
      sources[id] = {
        data,
        setData: (d) => { sources[id].data = d; }
      };
    },
    addLayer: () => {},
    setFeatureState: () => {},
    getCanvas: () => ({ style: {} }),
    dragPan: { disable: () => {}, enable: () => {} },
    doubleClickZoom: { disable: () => {}, enable: () => {} },
    on: (evt, ...args) => {
      const handler = typeof args[0] === 'function' ? args[0] : args[1];
      if (!handler) return;
      if (!eventHandlers[evt]) eventHandlers[evt] = [];
      eventHandlers[evt].push(handler);
    },
    off: (evt, ...args) => {
      const handler = typeof args[0] === 'function' ? args[0] : args[1];
      if (handler && eventHandlers[evt]) {
        eventHandlers[evt] = eventHandlers[evt].filter(h => h !== handler);
      }
    },
    trigger: (evt, data) => {
      if (eventHandlers[evt]) {
        eventHandlers[evt].forEach(h => h(data));
      }
    },
    project: (lngLat) => {
      const lng = lngLat.lng !== undefined ? lngLat.lng : lngLat[0];
      const lat = lngLat.lat !== undefined ? lngLat.lat : lngLat[1];
      const gx = (lng - (-73.60)) / 0.000013;
      const gy = (45.50 - lat) / 0.000009;
      const sx = gx * cosB - gy * sinB + 500;
      const sy = gx * sinB + gy * cosB + 500;
      return { x: sx, y: sy };
    },
    unproject: (point) => {
      const ptX = point.x !== undefined ? point.x : point[0];
      const ptY = point.y !== undefined ? point.y : point[1];
      const sx = ptX - 500;
      const sy = ptY - 500;
      const gx = sx * cosB + sy * sinB;
      const gy = -sx * sinB + sy * cosB;
      return {
        lng: -73.60 + gx * 0.000013,
        lat: 45.50 - gy * 0.000009
      };
    }
  };
}

test('BoxDrawer click-and-hold (drag to draw) creates screen-parallel rectangle', () => {
  const map = createMockMap(0);
  let selectionResult = null;
  const drawer = new BoxDrawer(map, null, (sel) => {
    selectionResult = sel;
  });

  drawer.startDrawing('rectangle');
  assert.equal(drawer.isDrawingActive, true);
  assert.equal(drawer.drawMode, 'rectangle');
  assert.equal(drawer.rectState, 'idle');

  // Mouse down at screen (100, 100)
  const p1 = { x: 100, y: 100 };
  const lngLat1 = map.unproject(p1);
  map.trigger('mousedown', { point: p1, lngLat: lngLat1 });
  assert.equal(drawer.isRectMouseDown, true);

  // Mouse move to (200, 200) -> distance > 5px -> enters dragging state
  const p2 = { x: 200, y: 200 };
  const lngLat2 = map.unproject(p2);
  map.trigger('mousemove', { point: p2, lngLat: lngLat2, originalEvent: { clientX: 200, clientY: 200 } });
  assert.equal(drawer.rectState, 'dragging');
  assert.equal(drawer.rectMovedDuringDown, true);

  // Mouse up at (200, 200) -> finalizes drag
  map.trigger('mouseup', { point: p2, lngLat: lngLat2 });
  assert.equal(drawer.isDrawingActive, false);
  assert.equal(drawer.rectState, 'idle');
  assert.ok(selectionResult !== null);
  assert.equal(selectionResult.shapeType, 'rectangle');
  assert.equal(selectionResult.isRectangle, true);
  assert.equal(selectionResult.polygon.length, 5); // 4 corners + closed ring
  assert.ok(selectionResult.dimensions.areaM2 > 0);
});

test('BoxDrawer click-and-release (click to start, click to finish) mode', () => {
  const map = createMockMap(0);
  let selectionResult = null;
  const drawer = new BoxDrawer(map, null, (sel) => {
    selectionResult = sel;
  });

  drawer.startDrawing('rectangle');

  // First click: down and up at same location (< 5px movement)
  const p1 = { x: 150, y: 150 };
  const lngLat1 = map.unproject(p1);
  map.trigger('mousedown', { point: p1, lngLat: lngLat1 });
  map.trigger('mouseup', { point: p1, lngLat: lngLat1, originalEvent: { clientX: 150, clientY: 150 } });

  // Should transition to expanding mode!
  assert.equal(drawer.isDrawingActive, true);
  assert.equal(drawer.rectState, 'expanding');

  // Mouse move freely across the map without holding mouse button
  const p2 = { x: 300, y: 250 };
  const lngLat2 = map.unproject(p2);
  map.trigger('mousemove', { point: p2, lngLat: lngLat2, originalEvent: { clientX: 300, clientY: 250 } });
  assert.equal(drawer.rectState, 'expanding');

  // Second click: mouse down at current position completes rectangle
  map.trigger('mousedown', { point: p2, lngLat: lngLat2 });
  assert.equal(drawer.isDrawingActive, false);
  assert.equal(drawer.rectState, 'idle');
  assert.ok(selectionResult !== null);
  assert.equal(selectionResult.shapeType, 'rectangle');
  assert.equal(selectionResult.isRectangle, true);
  assert.equal(selectionResult.polygon.length, 5);
});

test('BoxDrawer ignores double click in rectangle mode', () => {
  const map = createMockMap(0);
  let completed = false;
  const drawer = new BoxDrawer(map, null, () => {
    completed = true;
  });

  drawer.startDrawing('rectangle');

  let defaultPrevented = false;
  let propagationStopped = false;
  const mockDblClickEvent = {
    preventDefault: () => { defaultPrevented = true; },
    stopPropagation: () => { propagationStopped = true; }
  };

  map.trigger('dblclick', mockDblClickEvent);

  assert.equal(defaultPrevented, true);
  assert.equal(propagationStopped, true);
  assert.equal(drawer.isDrawingActive, true); // Still active, not prematurely terminated or broken
  assert.equal(completed, false);
});

test('BoxDrawer follows map orientation under rotated bearing (bearing 45)', () => {
  const bearing = 45;
  const map = createMockMap(bearing);
  let selectionResult = null;
  const drawer = new BoxDrawer(map, null, (sel) => {
    selectionResult = sel;
  });

  drawer.startDrawing('rectangle');

  // Click & drag on screen from (200, 200) to (400, 350)
  const p1 = { x: 200, y: 200 };
  const p2 = { x: 400, y: 350 };
  const lngLat1 = map.unproject(p1);
  const lngLat2 = map.unproject(p2);

  map.trigger('mousedown', { point: p1, lngLat: lngLat1 });
  map.trigger('mousemove', { point: p2, lngLat: lngLat2, originalEvent: { clientX: 400, clientY: 350 } });
  map.trigger('mouseup', { point: p2, lngLat: lngLat2 });

  assert.ok(selectionResult !== null);
  assert.equal(selectionResult.shapeType, 'rectangle');

  // Project the 4 resulting polygon corners back to screen coordinates
  const screenCorners = selectionResult.polygon.slice(0, 4).map(pt => map.project(pt));

  // The 4 screen corners must form a screen-parallel rectangle:
  // Top edge: y coordinates match (horizontal)
  assert.ok(Math.abs(screenCorners[0].y - screenCorners[1].y) < 0.01, 'Top edge is strictly horizontal on screen');
  // Right edge: x coordinates match (vertical)
  assert.ok(Math.abs(screenCorners[1].x - screenCorners[2].x) < 0.01, 'Right edge is strictly vertical on screen');
  // Bottom edge: y coordinates match (horizontal)
  assert.ok(Math.abs(screenCorners[2].y - screenCorners[3].y) < 0.01, 'Bottom edge is strictly horizontal on screen');
  // Left edge: x coordinates match (vertical)
  assert.ok(Math.abs(screenCorners[3].x - screenCorners[0].x) < 0.01, 'Left edge is strictly vertical on screen');
});

test('BoxDrawer oblong shape: delete vertex connects points on either side', () => {
  const map = createMockMap(0);
  let selectionResult = null;
  const drawer = new BoxDrawer(map, null, (sel) => {
    selectionResult = sel;
  });

  // Setup initial 4-point oblong quadrilateral: A -> B -> C -> D -> A
  // Kept within MAX_PATCH_AREA_M2 (~34,000 m2) so clamping is not triggered
  const pA = [-73.619, 45.502];
  const pB = [-73.617, 45.502];
  const pC = [-73.617, 45.504];
  const pD = [-73.619, 45.504];
  drawer.setPolygon([pA, pB, pC, pD, pA], 'polygon');

  assert.equal(drawer.shapeType, 'polygon');
  assert.equal(drawer.currentPolygon.length, 5); // 4 unique + closed

  // Delete vertex 1 (point B)
  drawer.deletePolygonVertex(1);

  assert.equal(drawer.currentPolygon.length, 4); // 3 unique + closed: A -> C -> D -> A
  assert.deepEqual(drawer.currentPolygon[0], pA);
  assert.deepEqual(drawer.currentPolygon[1], pC); // Point A now directly connects to Point C!
  assert.deepEqual(drawer.currentPolygon[2], pD);
  assert.deepEqual(drawer.currentPolygon[3], pA); // Closed ring
  assert.equal(selectionResult.shapeType, 'polygon');
  assert.equal(selectionResult.polygon.length, 4);
});

test('BoxDrawer oblong shape: enforces minimum of 3 points for deletion', () => {
  const map = createMockMap(0);
  const drawer = new BoxDrawer(map);

  // Setup 3-point triangle: A -> B -> C -> A
  const triangle = [
    [-73.619, 45.502],
    [-73.617, 45.502],
    [-73.618, 45.504],
    [-73.619, 45.502]
  ];
  drawer.setPolygon(triangle, 'polygon');
  assert.equal(drawer.getUniqueVertexCount(), 3);

  // Attempt to delete vertex 0 from 3-point triangle
  drawer.deletePolygonVertex(0);

  // Polygon must remain untouched (still 3 unique points)
  assert.equal(drawer.getUniqueVertexCount(), 3);
  assert.equal(drawer.currentPolygon.length, 4);
});

test('BoxDrawer oblong shape: hovering line displays semi-opaque midpoint', () => {
  const map = createMockMap(0);
  const drawer = new BoxDrawer(map);

  const pA = [-73.619, 45.502];
  const pB = [-73.617, 45.502];
  const pC = [-73.618, 45.504];
  drawer.setPolygon([pA, pB, pC, pA], 'polygon');

  // Compute screen coordinate of segment 0 (A -> B) midpoint
  const sA = map.project(pA);
  const sB = map.project(pB);
  const screenMidpoint = {
    x: (sA.x + sB.x) / 2,
    y: (sA.y + sB.y) / 2
  };

  // Find closest segment near the midpoint
  const segData = drawer.findClosestSegment(screenMidpoint);
  assert.ok(segData !== null);
  assert.equal(segData.segmentIndex, 0);
  assert.ok(segData.distancePx < 1.0);

  // Trigger showMidpoint
  drawer.showMidpoint(segData.segmentIndex, segData.midpoint);
  assert.ok(drawer.activeMidpoint !== null);
  assert.equal(drawer.activeMidpoint.segmentIndex, 0);

  const midpointSource = map.getSource('draw-midpoint-source');
  assert.ok(midpointSource);
  assert.equal(midpointSource.data.features.length, 1);
  assert.equal(midpointSource.data.features[0].properties.isMidpoint, true);
});

test('BoxDrawer oblong shape: click & drag midpoint adds new vertex and supports subsequent delete', () => {
  const map = createMockMap(0);
  let selectionResult = null;
  const drawer = new BoxDrawer(map, null, (sel) => {
    selectionResult = sel;
  });

  const pA = [-73.619, 45.502];
  const pB = [-73.617, 45.502];
  const pC = [-73.618, 45.504];
  drawer.setPolygon([pA, pB, pC, pA], 'polygon');
  assert.equal(drawer.getUniqueVertexCount(), 3);

  // Midpoint of segment 0 (A -> B)
  const midAB = [
    (pA[0] + pB[0]) / 2,
    (pA[1] + pB[1]) / 2
  ];

  // Insert vertex at segment 0 and start dragging
  drawer.insertVertexAndStartDrag(0, midAB);

  // Polygon now has 4 unique vertices (inserted at index 1 between A and B)
  assert.equal(drawer.getUniqueVertexCount(), 4);
  assert.equal(drawer.isResizing, true);
  assert.equal(drawer.activeVertexIndex, 1);

  // Drag the newly inserted vertex to a new position
  const draggedLngLat = { lng: -73.618, lat: 45.501 };
  drawer.onVertexDrag(draggedLngLat);
  assert.deepEqual(drawer.currentPolygon[1], [-73.618, 45.501]);

  // Finish dragging
  drawer.onVertexDragEnd();
  assert.equal(drawer.isResizing, false);
  assert.equal(drawer.activeVertexIndex, null);
  assert.equal(selectionResult.polygon.length, 5); // 4 unique + closed
  assert.deepEqual(selectionResult.polygon[1], [-73.618, 45.501]);

  // Now delete this newly added vertex with Shift + Click
  drawer.deletePolygonVertex(1);
  assert.equal(drawer.getUniqueVertexCount(), 3);
  assert.deepEqual(drawer.currentPolygon[0], pA);
  assert.deepEqual(drawer.currentPolygon[1], pB);
  assert.deepEqual(drawer.currentPolygon[2], pC);
  assert.deepEqual(drawer.currentPolygon[3], pA);
});

test('BoxDrawer: restores saved selection when style finishes loading', () => {
  let styleLoaded = false;
  const eventHandlers = {};
  const sources = {};
  const mockMap = {
    isStyleLoaded: () => styleLoaded,
    getSource: (id) => sources[id],
    addSource: (id, data) => {
      sources[id] = {
        data,
        setData: (d) => { sources[id].data = d; }
      };
    },
    addLayer: () => {},
    setFeatureState: () => {},
    getCanvas: () => ({ style: {} }),
    dragPan: { disable: () => {}, enable: () => {} },
    doubleClickZoom: { disable: () => {}, enable: () => {} },
    on: (evt, ...args) => {
      const handler = typeof args[0] === 'function' ? args[0] : args[1];
      if (!eventHandlers[evt]) eventHandlers[evt] = [];
      eventHandlers[evt].push(handler);
    },
    off: () => {}
  };

  const drawer = new BoxDrawer(mockMap);
  const savedSelection = {
    bbox: [-73.619, 45.502, -73.617, 45.504],
    polygon: [
      [-73.619, 45.502],
      [-73.617, 45.502],
      [-73.617, 45.504],
      [-73.619, 45.504],
      [-73.619, 45.502]
    ],
    shapeType: 'rectangle'
  };

  // Restore selection while style is not yet loaded
  drawer.setSelection(savedSelection);
  assert.equal(drawer.currentPolygon.length, 5);

  // Now simulate map style 'load' event
  styleLoaded = true;
  eventHandlers['load']?.forEach((fn) => fn());

  // Sources must now exist and draw-box-source must contain the restored feature
  assert.ok(mockMap.getSource('draw-box-source'));
  assert.equal(mockMap.getSource('draw-box-source').data.features.length, 1);
  assert.ok(mockMap.getSource('draw-handles-source'));
  assert.equal(mockMap.getSource('draw-handles-source').data.features.length, 4);
});

