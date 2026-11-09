/**
 * SolarPanel3DLayer Component
 * Custom MapLibre GL 3D WebGL layer that renders maximal ground-mount solar panel tables
 * in true 3D spatial coordinates:
 * - Monocrystalline anti-reflective blue panel surfaces tilted at fixed seasonal optimal tilt
 * - Aluminum perimeter frames and 2P modular cell seam lines
 * - Galvanized structural steel mounting posts rising from ground level (z = 0)
 *
 * Uses Relative-to-Center (RTC) 64-bit coordinate translation to prevent single-precision
 * vertex jitter at high zoom levels.
 */

import maplibregl from 'maplibre-gl';

const MercatorCoordinate = maplibregl.MercatorCoordinate || (maplibregl.default && maplibregl.default.MercatorCoordinate);

const VERTEX_SHADER_SRC = `
attribute vec3 a_pos;
attribute vec4 a_color;

uniform mat4 u_matrix;

varying vec4 v_color;

void main() {
    gl_Position = u_matrix * vec4(a_pos, 1.0);
    v_color = a_color;
}
`;

const FRAGMENT_SHADER_SRC = `
precision mediump float;

varying vec4 v_color;

void main() {
    gl_FragColor = v_color;
}
`;

export class SolarPanel3DLayer {
  constructor(options = {}) {
    this.id = options.id || 'solar-panel-3d-layer';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.visible = options.visible !== undefined ? options.visible : true;

    this.map = null;
    this.gl = null;
    this.program = null;

    this.aPosLocation = null;
    this.aColorLocation = null;
    this.uMatrixLocation = null;

    this.faceBuffer = null;
    this.lineBuffer = null;
    this.faceVertexCount = 0;
    this.lineVertexCount = 0;

    // Anchor Mercator coordinate for RTC (Relative to Center) precision
    this.anchorMerc = { x: 0, y: 0, z: 0 };
    this.layout = null;
    this.pendingLayout = null;

    // Cached raw arrays for testing and inspection
    this.faceVertices = null;
    this.lineVertices = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;

    if (gl) {
      this.initWebGL(gl);
    }

    if (this.pendingLayout) {
      this.setLayout(this.pendingLayout);
      this.pendingLayout = null;
    }
  }

  initWebGL(gl) {
    const vShader = this.createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fShader = this.createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);

    if (!vShader || !fShader) {
      console.warn('SolarPanel3DLayer: Failed to compile shaders');
      return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('SolarPanel3DLayer: Program link failure:', gl.getProgramInfoLog(program));
      return;
    }

    this.program = program;
    this.aPosLocation = gl.getAttribLocation(program, 'a_pos');
    this.aColorLocation = gl.getAttribLocation(program, 'a_color');
    this.uMatrixLocation = gl.getUniformLocation(program, 'u_matrix');

    this.faceBuffer = gl.createBuffer();
    this.lineBuffer = gl.createBuffer();
  }

  createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('SolarPanel3DLayer: Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  /**
   * Sets the maximal solar panel layout and rebuilds GPU vertex arrays.
   * @param {Object|null} layout PVLayoutResult from simulation response
   */
  setLayout(layout) {
    this.layout = layout;
    if (!this.gl) {
      this.pendingLayout = layout;
    }

    if (!layout || !layout.tables || layout.tables.length === 0) {
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.faceVertices = null;
      this.lineVertices = null;
      if (this.map && typeof this.map.triggerRepaint === 'function') {
        this.map.triggerRepaint();
      }
      return;
    }

    this.buildGeometry(layout);

    if (this.gl && this.faceBuffer && this.lineBuffer) {
      this.uploadBuffers();
    }

    if (this.map && typeof this.map.triggerRepaint === 'function') {
      this.map.triggerRepaint();
    }
  }

  getLayout() {
    return this.layout;
  }

  getTotalPanels() {
    return this.layout ? (this.layout.total_panels || 0) : 0;
  }

  getTotalTables() {
    return this.layout ? (this.layout.total_tables || 0) : 0;
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.map && typeof this.map.triggerRepaint === 'function') {
      this.map.triggerRepaint();
    }
  }

  isVisible() {
    return this.visible;
  }

  clear() {
    this.setLayout(null);
  }

  /**
   * Builds Float32 vertex buffers for tilted panel faces and mounting frames/posts.
   */
  buildGeometry(layout) {
    const tables = layout.tables;
    if (!tables || tables.length === 0) {
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      return;
    }

    // Set anchor point using center of first table for RTC coordinate stabilization
    const firstTable = tables[0];
    const anchorLngLat = firstTable.center_wgs84 || firstTable.corners_wgs84[0];
    const anchor = MercatorCoordinate.fromLngLat(anchorLngLat, 0);
    this.anchorMerc = { x: anchor.x, y: anchor.y, z: anchor.z };

    const dx = this.anchorMerc.x;
    const dy = this.anchorMerc.y;
    const dz = this.anchorMerc.z;

    const faceData = []; // [x, y, z, r, g, b, a] * 6 per table
    const lineData = []; // [x, y, z, r, g, b, a] * 2 per segment

    // Colors
    // Panel face gradient: bottom edge deep navy, top edge sunlit anti-reflective cobalt
    const colFaceBottom = [0.07, 0.15, 0.32, 0.95];
    const colFaceTop = [0.13, 0.28, 0.55, 0.95];

    // Aluminum perimeter rack frame
    const colFrame = [0.80, 0.86, 0.92, 0.95];
    // Aluminum 2P horizontal mid-seam
    const colMidSeam = [0.65, 0.74, 0.84, 0.85];
    // Vertical module separator lines
    const colModuleSeam = [0.52, 0.62, 0.72, 0.75];
    // Galvanized structural steel vertical posts
    const colPost = [0.42, 0.48, 0.56, 0.95];

    for (let t = 0; t < tables.length; t++) {
      const tbl = tables[t];
      const corners = tbl.corners_wgs84;
      if (!corners || corners.length < 4) continue;

      const tiltRad = ((tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0) * Math.PI) / 180.0;
      const hBottom = tbl.stand_height_m !== undefined ? tbl.stand_height_m : 1.0;
      const slantH = tbl.slant_height_m !== undefined ? tbl.slant_height_m : 4.56;
      const hTop = hBottom + slantH * Math.sin(tiltRad);

      // Elevated 3D rack corners: SW, SE, NE, NW
      const swM = MercatorCoordinate.fromLngLat(corners[0], hBottom);
      const seM = MercatorCoordinate.fromLngLat(corners[1], hBottom);
      const neM = MercatorCoordinate.fromLngLat(corners[2], hTop);
      const nwM = MercatorCoordinate.fromLngLat(corners[3], hTop);

      // Ground corners for mounting legs (z = 0)
      const swGM = MercatorCoordinate.fromLngLat(corners[0], 0);
      const seGM = MercatorCoordinate.fromLngLat(corners[1], 0);
      const neGM = MercatorCoordinate.fromLngLat(corners[2], 0);
      const nwGM = MercatorCoordinate.fromLngLat(corners[3], 0);

      // Local RTC coordinates
      const sw = [swM.x - dx, swM.y - dy, swM.z - dz];
      const se = [seM.x - dx, seM.y - dy, seM.z - dz];
      const ne = [neM.x - dx, neM.y - dy, neM.z - dz];
      const nw = [nwM.x - dx, nwM.y - dy, nwM.z - dz];

      const swG = [swGM.x - dx, swGM.y - dy, swGM.z - dz];
      const seG = [seGM.x - dx, seGM.y - dy, seGM.z - dz];
      const neG = [neGM.x - dx, neGM.y - dy, neGM.z - dz];
      const nwG = [nwGM.x - dx, nwGM.y - dy, nwGM.z - dz];

      // --- 1. Panel Face Triangles (Quad = 2 Triangles) ---
      // Triangle 1: SW, SE, NE
      this.pushVertex(faceData, sw, colFaceBottom);
      this.pushVertex(faceData, se, colFaceBottom);
      this.pushVertex(faceData, ne, colFaceTop);

      // Triangle 2: SW, NE, NW
      this.pushVertex(faceData, sw, colFaceBottom);
      this.pushVertex(faceData, ne, colFaceTop);
      this.pushVertex(faceData, nw, colFaceTop);

      // --- 2. Aluminum Framing Lines (Perimeter) ---
      this.pushLine(lineData, sw, se, colFrame);
      this.pushLine(lineData, se, ne, colFrame);
      this.pushLine(lineData, ne, nw, colFrame);
      this.pushLine(lineData, nw, sw, colFrame);

      // --- 3. 2P Horizontal Mid-Seam (Between Top and Bottom Portrait Modules) ---
      const midW = [0.5 * (sw[0] + nw[0]), 0.5 * (sw[1] + nw[1]), 0.5 * (sw[2] + nw[2])];
      const midE = [0.5 * (se[0] + ne[0]), 0.5 * (se[1] + ne[1]), 0.5 * (se[2] + ne[2])];
      this.pushLine(lineData, midW, midE, colMidSeam);

      // --- 4. Vertical Seams Dividing Module Pairs ---
      const panelCount = tbl.panel_count || 4;
      const numPairs = Math.max(1, Math.floor(panelCount / 2));
      for (let k = 1; k < numPairs; k++) {
        const tRatio = k / numPairs;
        const bK = [
          (1 - tRatio) * sw[0] + tRatio * se[0],
          (1 - tRatio) * sw[1] + tRatio * se[1],
          (1 - tRatio) * sw[2] + tRatio * se[2]
        ];
        const tK = [
          (1 - tRatio) * nw[0] + tRatio * ne[0],
          (1 - tRatio) * nw[1] + tRatio * ne[1],
          (1 - tRatio) * nw[2] + tRatio * ne[2]
        ];
        this.pushLine(lineData, bK, tK, colModuleSeam);

        // Intermediate ground mounting posts for wide tables
        if (numPairs >= 4 && k % 2 === 0) {
          const bgK = [
            (1 - tRatio) * swG[0] + tRatio * seG[0],
            (1 - tRatio) * swG[1] + tRatio * seG[1],
            (1 - tRatio) * swG[2] + tRatio * seG[2]
          ];
          const tgK = [
            (1 - tRatio) * nwG[0] + tRatio * neG[0],
            (1 - tRatio) * nwG[1] + tRatio * neG[1],
            (1 - tRatio) * nwG[2] + tRatio * neG[2]
          ];
          this.pushLine(lineData, bgK, bK, colPost);
          this.pushLine(lineData, tgK, tK, colPost);
        }
      }

      // --- 5. Four Corner Vertical Mounting Posts (Ground to Rack) ---
      this.pushLine(lineData, swG, sw, colPost);
      this.pushLine(lineData, seG, se, colPost);
      this.pushLine(lineData, nwG, nw, colPost);
      this.pushLine(lineData, neG, ne, colPost);
    }

    this.faceVertices = new Float32Array(faceData);
    this.lineVertices = new Float32Array(lineData);
    this.faceVertexCount = faceData.length / 7;
    this.lineVertexCount = lineData.length / 7;
  }

  pushVertex(arr, pos, color) {
    arr.push(pos[0], pos[1], pos[2], color[0], color[1], color[2], color[3]);
  }

  pushLine(arr, p1, p2, color) {
    arr.push(p1[0], p1[1], p1[2], color[0], color[1], color[2], color[3]);
    arr.push(p2[0], p2[1], p2[2], color[0], color[1], color[2], color[3]);
  }

  uploadBuffers() {
    const gl = this.gl;
    if (!gl || !this.faceVertices || !this.lineVertices) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.faceVertices, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVertices, gl.STATIC_DRAW);
  }

  render(gl, matrix) {
    if (!this.visible || this.faceVertexCount === 0 || !this.program) {
      return;
    }

    gl.useProgram(this.program);

    // Build local model-view-projection matrix: M * T(dx, dy, dz)
    const dx = this.anchorMerc.x;
    const dy = this.anchorMerc.y;
    const dz = this.anchorMerc.z;

    const mvp = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      mvp[i] = matrix[i];
    }
    mvp[12] = matrix[0] * dx + matrix[4] * dy + matrix[8] * dz + matrix[12];
    mvp[13] = matrix[1] * dx + matrix[5] * dy + matrix[9] * dz + matrix[13];
    mvp[14] = matrix[2] * dx + matrix[6] * dy + matrix[10] * dz + matrix[14];
    mvp[15] = matrix[3] * dx + matrix[7] * dy + matrix[11] * dz + matrix[15];

    gl.uniformMatrix4fv(this.uMatrixLocation, false, mvp);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE); // Two-sided viewing for tilted racking structures

    // 1. Draw Panel Faces (TRIANGLES)
    if (this.faceVertexCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, this.faceVertexCount);
    }

    // 2. Draw Frames, Module Seams, and Mounting Posts (LINES)
    if (this.lineVertexCount > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }
  }

  onRemove(map, gl) {
    if (gl) {
      if (this.faceBuffer) gl.deleteBuffer(this.faceBuffer);
      if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.map = null;
    this.gl = null;
    this.program = null;
  }
}
