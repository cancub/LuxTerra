/**
 * SolarPanel3DLayer Component
 * Custom MapLibre GL 3D WebGL layer that renders maximal ground-mount solar panel tables
 * in true 3D spatial coordinates:
 * - Each individual solar panel module is independently shaded based on its exact geographic position:
 *     * Deep forest green when under vegetative tree canopy shade
 *     * Dark slate shadow tone when under geological (terrain) or inter-row panel self-shade
 *     * Crisp architectural white by default in direct sunlight
 * - Fine-grained 2-in-portrait (2P) modular subdivision: every single module in the table rack
 *   evaluates terrain, canopy, and self-shading obstruction individually
 * - Aluminum perimeter frames, module seams, and galvanized structural steel vertical posts
 *
 * Uses Relative-to-Center (RTC) 64-bit coordinate translation to prevent single-precision
 * vertex jitter at high zoom levels.
 *
 * Note: Ground shadows are unified into ShadowCanvasLayer to guarantee strictly binary
 * ground coloring without deeper colors at geological and panel shadow intersections.
 */

import maplibregl from 'maplibre-gl';
import { decodeBitmask } from '../utils/maskDecoder.js';
import { metersPerDegLon } from '../utils/geometry.js';

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

// Color palette
const COL_SUNLIT_TOP = [0.96, 0.98, 1.00, 0.98];      // Crisp sunlit white with light sky reflection
const COL_SUNLIT_BOT = [0.90, 0.93, 0.96, 0.98];      // Crisp architectural white
const COL_CANOPY_SHADE = [0.09, 0.24, 0.17, 0.95];    // Rich forest green tree canopy shade
const COL_GEOLOGICAL_SHADE = [0.06, 0.09, 0.16, 0.96];// Deep dark slate geological/terrain/self shadow

// Structural framing colors
const COL_FRAME = [0.72, 0.78, 0.86, 0.95];          // Aluminum rack perimeter frame
const COL_MID_SEAM = [0.60, 0.68, 0.78, 0.85];       // 2P horizontal mid-seam
const COL_MODULE_SEAM = [0.50, 0.58, 0.68, 0.75];    // Vertical module separator lines
const COL_POST = [0.42, 0.48, 0.56, 0.95];           // Galvanized structural steel mounting legs

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
    this.highlightBuffer = null;

    this.faceVertexCount = 0;
    this.lineVertexCount = 0;
    this.highlightVertexCount = 0;

    // Anchor Mercator coordinate for RTC (Relative to Center) precision
    this.anchorMerc = { x: 0, y: 0, z: 0 };
    this.layout = null;
    this.pendingLayout = null;

    // Cached raw arrays for testing and inspection
    this.faceVertices = null;
    this.lineVertices = null;
    this.highlightVertices = null;

    // Discrete individual panels collection & interactive hover telemetry
    this.panels = [];
    this.avgSvf = 1.0;
    this.hoveredPanel = null;
    this.onHoverCallback = null;
    this.latestMvp = null;
    this.latestMetric = null;
    this.canopyTransmittance = 0.15;

    // Current solar state & shadow masks for dynamic updating
    this.currentSun = {
      azimuth: 180.0,
      elevation: 45.0,
      isDaylight: true
    };
    this.currentMasks = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;

    if (gl) {
      this.initWebGL(gl);
    }

    if (this.pendingLayout) {
      if (this.layout === this.pendingLayout && this.faceVertices && this.gl && this.program) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.faceVertices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, this.lineVertices, gl.STATIC_DRAW);
      } else {
        this.setLayout(this.pendingLayout);
      }
      this.pendingLayout = null;
    }
  }

  initWebGL(gl) {
    const vShader = this.createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fShader = this.createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);

    if (!vShader || !fShader) {
      if (vShader) gl.deleteShader(vShader);
      if (fShader) gl.deleteShader(fShader);
      console.warn('SolarPanel3DLayer: Failed to compile shaders');
      return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vShader);
    gl.attachShader(program, fShader);
    gl.linkProgram(program);
    gl.detachShader(program, vShader);
    gl.detachShader(program, fShader);
    gl.deleteShader(vShader);
    gl.deleteShader(fShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('SolarPanel3DLayer: Program link failure:', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return;
    }

    this.program = program;
    this.aPosLocation = gl.getAttribLocation(program, 'a_pos');
    this.aColorLocation = gl.getAttribLocation(program, 'a_color');
    this.uMatrixLocation = gl.getUniformLocation(program, 'u_matrix');

    this.faceBuffer = gl.createBuffer();
    this.lineBuffer = gl.createBuffer();
    this.highlightBuffer = gl.createBuffer();
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
      this._cachedLayout = null;
      this._panelRenderSpecs = [];
      this.panels = [];
      this.hoveredPanel = null;
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.faceVertices = null;
      this.lineVertices = null;
      if (this.map && typeof this.map.triggerRepaint === 'function') {
        this.map.triggerRepaint();
      }
      return;
    }

    this.buildStaticLayoutCache(layout);
    this.updateFaceColors(this.currentSun, this.currentMasks);
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
   * Updates sun angle and current raster shadow masks for dynamic per-panel face darkening
   * (canopy green vs geological dark slate vs direct sunlit white).
   */
  updateSunPosition(azimuthDeg, elevationDeg, isDaylight, maskStr = null, canopyMaskStr = null, patchBounds = null, rows = 0, cols = 0, metric = null, canopyTransmittance = 0.15, predecodedMasks = null) {
    this.latestMetric = metric;
    this.canopyTransmittance = canopyTransmittance;
    this.currentSun = {
      azimuth: azimuthDeg !== undefined ? azimuthDeg : 180.0,
      elevation: elevationDeg !== undefined ? elevationDeg : 0.0,
      isDaylight: Boolean(isDaylight)
    };

    if (predecodedMasks && predecodedMasks.terrain && patchBounds && predecodedMasks.rows === rows && predecodedMasks.cols === cols && rows > 0 && cols > 0) {
      this.currentMasks = {
        terrain: predecodedMasks.terrain,
        canopy: predecodedMasks.canopy || null,
        bounds: patchBounds,
        rows,
        cols
      };
    } else if (maskStr && patchBounds && rows > 0 && cols > 0) {
      this.currentMasks = {
        terrain: decodeBitmask(maskStr, rows, cols),
        canopy: canopyMaskStr ? decodeBitmask(canopyMaskStr, rows, cols) : null,
        bounds: patchBounds,
        rows,
        cols
      };
    } else if (isDaylight === false) {
      this.currentMasks = null;
    }

    if (this.layout && this.layout.tables && this.layout.tables.length > 0) {
      if (this._cachedLayout !== this.layout) {
        this.buildStaticLayoutCache(this.layout);
        if (this.gl && this.lineBuffer) {
          this.uploadLineBuffer();
        }
      }
      this.updateFaceColors(this.currentSun, this.currentMasks);
      if (this.gl && this.faceBuffer) {
        this.uploadFaceBuffer();
      }
      if (this.map && typeof this.map.triggerRepaint === 'function') {
        this.map.triggerRepaint();
      }
    }

    if (this.hoveredPanel && this.onHoverCallback) {
      const breakdown = this.computePanelBreakdown(this.hoveredPanel);
      this.onHoverCallback(this.hoveredPanel, breakdown);
    }
  }

  rebuildBuffers() {
    if (!this.layout || !this.layout.tables || this.layout.tables.length === 0) {
      return;
    }
    if (this._cachedLayout !== this.layout) {
      this.buildStaticLayoutCache(this.layout);
      if (this.gl && this.lineBuffer) {
        this.uploadLineBuffer();
      }
    }
    this.updateFaceColors(this.currentSun, this.currentMasks);

    if (this.gl && this.faceBuffer) {
      this.uploadFaceBuffer();
    }

    if (this.map && typeof this.map.triggerRepaint === 'function') {
      this.map.triggerRepaint();
    }
  }

  /**
   * Samples terrain and canopy shadow masks at a given geographic point [lon, lat].
   * Returns { inTerrainShade: boolean, inCanopyShade: boolean }.
   */
  sampleShadowAtPoint(lon, lat, maskData) {
    if (!maskData || !maskData.terrain || !maskData.bounds) {
      return { inTerrainShade: false, inCanopyShade: false };
    }

    const [minLon, minLat, maxLon, maxLat] = maskData.bounds;
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;

    if (lonSpan <= 0 || latSpan <= 0) {
      return { inTerrainShade: false, inCanopyShade: false };
    }

    const c = Math.min(maskData.cols - 1, Math.max(0, Math.floor(((lon - minLon) / lonSpan) * maskData.cols)));
    const r = Math.min(maskData.rows - 1, Math.max(0, Math.floor(((maxLat - lat) / latSpan) * maskData.rows))); // North is row 0

    const idx = r * maskData.cols + c;
    const isTerrainLit = maskData.terrain[idx] === 1;
    const isCanopyLit = maskData.canopy ? (maskData.canopy[idx] === 1) : true;

    return {
      inTerrainShade: !isTerrainLit,
      inCanopyShade: isTerrainLit && !isCanopyLit
    };
  }

  /**
   * Calculates row-to-row direct beam self-shading fraction for interior rows.
   */
  calculateRowSelfShadeFraction(rowPitchM, slantHM, tiltDeg, azDeg, elDeg, southTiltDeg = null) {
    if (elDeg <= 0.0) return 1.0;
    const azDeltaRad = ((azDeg - 180.0) * Math.PI) / 180.0;
    const cosAzDelta = Math.cos(azDeltaRad);
    if (cosAzDelta <= 0.001) return 0.0;

    const tiltRad = (tiltDeg * Math.PI) / 180.0;
    const southRad = ((southTiltDeg !== null && southTiltDeg !== undefined ? southTiltDeg : tiltDeg) * Math.PI) / 180.0;
    const tanAlphaP = Math.tan((elDeg * Math.PI) / 180.0) / cosAzDelta;
    if (tanAlphaP <= 1e-5) return 1.0;

    const dGap = rowPitchM - 0.5 * slantHM * (Math.cos(southRad) + Math.cos(tiltRad));
    const hRise = slantHM * Math.sin(southRad);
    const sY = hRise / tanAlphaP;

    if (sY <= dGap) return 0.0;

    const denom = Math.cos(tiltRad) + (Math.sin(tiltRad) / tanAlphaP);
    if (denom <= 1e-5) return 1.0;

    const sShade = (sY - dGap) / denom;
    return Math.min(1.0, Math.max(0.0, sShade / slantHM));
  }

  /**
   * Calculates the inter-row diffuse sky view factor multiplier for a module in a 2P table
   * due to solid obstruction of the lower southern sky dome by the rack in front of it.
   */
  calculateModuleRackSvf(rowPitchM, slantHM, tiltDeg, isTop, hasSouthObstruction, southTiltDeg = null) {
    if (!hasSouthObstruction || rowPitchM <= 0.0 || slantHM <= 0.0) {
      return 1.0;
    }
    const tiltRad = (tiltDeg * Math.PI) / 180.0;
    const southRad = ((southTiltDeg !== null && southTiltDeg !== undefined ? southTiltDeg : tiltDeg) * Math.PI) / 180.0;
    const fFrac = isTop ? 0.75 : 0.25;
    const dz = slantHM * Math.sin(southRad) - fFrac * slantHM * Math.sin(tiltRad);
    const dy = rowPitchM - 0.5 * slantHM * Math.cos(southRad) + (fFrac - 0.5) * slantHM * Math.cos(tiltRad);
    if (dy <= 0.1 || dz <= 0.0) {
      return 1.0;
    }
    const tanGamma = dz / dy;
    const obsFraction = 1.0 - 1.0 / (1.0 + tanGamma * tanGamma);
    const rackSvf = 1.0 - (1.0 / 3.0) * obsFraction;
    return Math.min(1.0, Math.max(0.5, rackSvf));
  }

  /**
   * Builds Float32 vertex buffers for tilted panel faces and frames/posts.
   * Every individual solar panel is shaded independently based on its exact geographic position.
   */
  buildGeometry(layout, sun = null, maskData = null) {
    this.buildStaticLayoutCache(layout);
    this.updateFaceColors(sun || this.currentSun, maskData !== undefined ? maskData : this.currentMasks);
  }

  /**
   * Builds and caches all sun-independent static WebGL geometry:
   * - Frame, seam, cell-grid, and mounting-post line vertices (STATIC_DRAW)
   * - Pre-sized Float32Array for 72-cell panel face vertices with static XYZ positions
   * - Precomputed per-cell geographic coordinates for fast per-frame color updates
   */
  buildStaticLayoutCache(layout) {
    const tables = layout && layout.tables;
    if (!tables || tables.length === 0) {
      this._cachedLayout = null;
      this._panelRenderSpecs = [];
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.faceVertices = null;
      this.lineVertices = null;
      this.panels = [];
      this.hoveredPanel = null;
      return;
    }

    this.panels = [];
    this._panelRenderSpecs = [];
    const minRowIndex = tables.reduce((min, t) => Math.min(min, t.row_index !== undefined ? t.row_index : 0), Infinity);

    const firstTable = tables[0];
    const anchorLngLat = firstTable.center_wgs84 || firstTable.corners_wgs84[0];
    const anchor = MercatorCoordinate.fromLngLat(anchorLngLat, 0);
    this.anchorMerc = { x: anchor.x, y: anchor.y, z: anchor.z };

    const dx = this.anchorMerc.x;
    const dy = this.anchorMerc.y;
    const dz = this.anchorMerc.z;

    const CELL_ROWS = 12;
    const CELL_COLS = 6;
    const CELLS_PER_MOD = CELL_ROWS * CELL_COLS;
    const FLOATS_PER_CELL = 6 * 7; // 2 triangles * 3 vertices * (x,y,z,r,g,b,a)
    const COL_CELL_GRID = [0.22, 0.28, 0.36, 0.35];
    const COL_HALF_SPLIT = [0.75, 0.80, 0.86, 0.70];

    const lerpPt3 = (a, b, t) => [
      (1 - t) * a[0] + t * b[0],
      (1 - t) * a[1] + t * b[1],
      (1 - t) * a[2] + t * b[2]
    ];

    let totalModules = 0;
    for (let t = 0; t < tables.length; t++) {
      const tbl = tables[t];
      if (!tbl.corners_wgs84 || tbl.corners_wgs84.length < 4) continue;
      const numPairs = Math.max(1, Math.floor((tbl.panel_count || 4) / 2));
      totalModules += numPairs * 2;
    }

    const faceVertices = new Float32Array(totalModules * CELLS_PER_MOD * FLOATS_PER_CELL);
    const lineData = [];
    const rowPitchM = layout.row_pitch_m || 10.57;

    const tablesByRow = new Map();
    for (let i = 0; i < tables.length; i++) {
      const rIdx = tables[i].row_index;
      if (!tablesByRow.has(rIdx)) tablesByRow.set(rIdx, []);
      tablesByRow.get(rIdx).push(tables[i]);
    }

    let faceFloatCursor = 0;

    for (let t = 0; t < tables.length; t++) {
      const tbl = tables[t];
      const corners = tbl.corners_wgs84;
      if (!corners || corners.length < 4) continue;

      const tblTiltDeg = tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0;
      const tiltRad = (tblTiltDeg * Math.PI) / 180.0;
      const hBottom = tbl.stand_height_m !== undefined ? tbl.stand_height_m : 1.0;
      const slantH = tbl.slant_height_m !== undefined ? tbl.slant_height_m : 4.56;
      const hTop = hBottom + slantH * Math.sin(tiltRad);

      const swM = MercatorCoordinate.fromLngLat(corners[0], hBottom);
      const seM = MercatorCoordinate.fromLngLat(corners[1], hBottom);
      const neM = MercatorCoordinate.fromLngLat(corners[2], hTop);
      const nwM = MercatorCoordinate.fromLngLat(corners[3], hTop);

      const swGM = MercatorCoordinate.fromLngLat(corners[0], 0);
      const seGM = MercatorCoordinate.fromLngLat(corners[1], 0);
      const neGM = MercatorCoordinate.fromLngLat(corners[2], 0);
      const nwGM = MercatorCoordinate.fromLngLat(corners[3], 0);

      const sw = [swM.x - dx, swM.y - dy, swM.z - dz];
      const se = [seM.x - dx, seM.y - dy, seM.z - dz];
      const ne = [neM.x - dx, neM.y - dy, neM.z - dz];
      const nw = [nwM.x - dx, nwM.y - dy, nwM.z - dz];

      const swG = [swGM.x - dx, swGM.y - dy, swGM.z - dz];
      const seG = [seGM.x - dx, seGM.y - dy, seGM.z - dz];
      const neG = [neGM.x - dx, neGM.y - dy, neGM.z - dz];
      const nwG = [nwGM.x - dx, nwGM.y - dy, nwGM.z - dz];

      const midW = [0.5 * (sw[0] + nw[0]), 0.5 * (sw[1] + nw[1]), 0.5 * (sw[2] + nw[2])];
      const midE = [0.5 * (se[0] + ne[0]), 0.5 * (se[1] + ne[1]), 0.5 * (se[2] + ne[2])];

      const southTables = tablesByRow.get(tbl.row_index - 1) || [];
      const southRackTiltDeg = (southTables.length > 0 && southTables[0].tilt_deg !== undefined)
        ? southTables[0].tilt_deg
        : tblTiltDeg;

      const c0 = corners[0];
      const c1 = corners[1];
      const c2 = corners[2];
      const c3 = corners[3];

      const panelCount = tbl.panel_count || 4;
      const numPairs = Math.max(1, Math.floor(panelCount / 2));

      for (let k = 0; k < numPairs; k++) {
        const t0 = k / numPairs;
        const t1 = (k + 1) / numPairs;
        const tMid = (k + 0.5) / numPairs;

        const b0 = lerpPt3(sw, se, t0);
        const b1 = lerpPt3(sw, se, t1);
        const m0 = lerpPt3(midW, midE, t0);
        const m1 = lerpPt3(midW, midE, t1);
        const t0_pt = lerpPt3(nw, ne, t0);
        const t1_pt = lerpPt3(nw, ne, t1);

        const lonBot = (1 - tMid) * c0[0] + tMid * c1[0];
        const latBot = (1 - tMid) * c0[1] + tMid * c1[1];
        const lonTop = (1 - tMid) * c3[0] + tMid * c2[0];
        const latTop = (1 - tMid) * c3[1] + tMid * c2[1];

        const centerLon_B = 0.75 * lonBot + 0.25 * lonTop;
        const centerLat_B = 0.75 * latBot + 0.25 * latTop;
        const centerLon_T = 0.25 * lonBot + 0.75 * lonTop;
        const centerLat_T = 0.25 * latBot + 0.75 * latTop;

        let hasSouthRack = false;
        if (tbl.row_index > minRowIndex && southTables.length > 0) {
          for (const st of southTables) {
            const sc = st.corners_wgs84;
            if (!sc || sc.length < 4) continue;
            const stMinLon = Math.min(sc[0][0], sc[3][0]);
            const stMaxLon = Math.max(sc[1][0], sc[2][0]);
            if (centerLon_B >= stMinLon && centerLon_B <= stMaxLon) {
              hasSouthRack = true;
              break;
            }
          }
        }

        const svf_B = (tbl.module_svf && tbl.module_svf[2 * k] !== undefined)
          ? tbl.module_svf[2 * k]
          : this.calculateModuleRackSvf(rowPitchM, slantH, tblTiltDeg, false, hasSouthRack, southRackTiltDeg);
        const svf_T = (tbl.module_svf && tbl.module_svf[2 * k + 1] !== undefined)
          ? tbl.module_svf[2 * k + 1]
          : this.calculateModuleRackSvf(rowPitchM, slantH, tblTiltDeg, true, hasSouthRack, southRackTiltDeg);

        const cacheModuleStatic = (ptSW, ptSE, ptNE, ptNW, vBase, rackStart, panelObj) => {
          const panelIdx = this.panels.length;
          this.panels.push(panelObj);

          const startOffset = faceFloatCursor;
          const cellsLon = new Float64Array(CELLS_PER_MOD);
          const cellsLat = new Float64Array(CELLS_PER_MOD);

          let cIdx = 0;
          for (let cr = 0; cr < CELL_ROWS; cr++) {
            const rv0 = cr / CELL_ROWS;
            const rv1 = (cr + 1) / CELL_ROWS;
            const rvMid = (cr + 0.5) / CELL_ROWS;
            const vRackMid = vBase + 0.5 * rvMid;

            for (let cc = 0; cc < CELL_COLS; cc++) {
              const cu0 = cc / CELL_COLS;
              const cu1 = (cc + 1) / CELL_COLS;
              const cuMid = (cc + 0.5) / CELL_COLS;
              const uTableMid = t0 + cuMid * (t1 - t0);

              const lonS = (1 - uTableMid) * c0[0] + uTableMid * c1[0];
              const latS = (1 - uTableMid) * c0[1] + uTableMid * c1[1];
              const lonN = (1 - uTableMid) * c3[0] + uTableMid * c2[0];
              const latN = (1 - uTableMid) * c3[1] + uTableMid * c2[1];
              cellsLon[cIdx] = (1 - vRackMid) * lonS + vRackMid * lonN;
              cellsLat[cIdx] = (1 - vRackMid) * latS + vRackMid * latN;
              cIdx++;

              const p00 = lerpPt3(lerpPt3(ptSW, ptSE, cu0), lerpPt3(ptNW, ptNE, cu0), rv0);
              const p10 = lerpPt3(lerpPt3(ptSW, ptSE, cu1), lerpPt3(ptNW, ptNE, cu1), rv0);
              const p11 = lerpPt3(lerpPt3(ptSW, ptSE, cu1), lerpPt3(ptNW, ptNE, cu1), rv1);
              const p01 = lerpPt3(lerpPt3(ptSW, ptSE, cu0), lerpPt3(ptNW, ptNE, cu0), rv1);

              const verts = [p00, p10, p11, p00, p11, p01];
              for (let vi = 0; vi < 6; vi++) {
                faceVertices[faceFloatCursor] = verts[vi][0];
                faceVertices[faceFloatCursor + 1] = verts[vi][1];
                faceVertices[faceFloatCursor + 2] = verts[vi][2];
                faceFloatCursor += 7;
              }
            }
          }

          for (let cr = 1; cr < CELL_ROWS; cr++) {
            const rv = cr / CELL_ROWS;
            this.pushLine(lineData, lerpPt3(ptSW, ptNW, rv), lerpPt3(ptSE, ptNE, rv), cr === 6 ? COL_HALF_SPLIT : COL_CELL_GRID);
          }
          for (let cc = 1; cc < CELL_COLS; cc++) {
            const cu = cc / CELL_COLS;
            this.pushLine(lineData, lerpPt3(ptSW, ptSE, cu), lerpPt3(ptNW, ptNE, cu), COL_CELL_GRID);
          }

          this._panelRenderSpecs.push({
            panelIdx,
            faceFloatOffset: startOffset,
            tableRowIndex: tbl.row_index,
            minRowIndex,
            southTables,
            centerLonB: centerLon_B,
            centerLatB: centerLat_B,
            tblTiltDeg,
            slantH,
            rowPitchM,
            rackStart,
            cellsLon,
            cellsLat
          });
        };

        cacheModuleStatic(b0, b1, m1, m0, 0.0, 0.0, {
          id: `t${tbl.table_id}_c${k}_B`,
          tableId: tbl.table_id,
          rowIndex: tbl.row_index,
          colIndex: k,
          position: 'bottom',
          label: `Table ${tbl.table_id + 1} · Row ${tbl.row_index + 1} · Module ${k * 2 + 1} (Bottom)`,
          centerLngLat: [centerLon_B, centerLat_B],
          rtcVertices: [b0, b1, m1, m0],
          selfShadeFrac: 0.0,
          moduleSelfShadeFrac: 0.0,
          geoFrac: 0.0,
          selfFrac: 0.0,
          canopyFrac: 0.0,
          svf: svf_B,
          shadeState: { inTerrainShade: false, inCanopyShade: false, isSelfShaded: false }
        });

        cacheModuleStatic(m0, m1, t1_pt, t0_pt, 0.5, 0.5, {
          id: `t${tbl.table_id}_c${k}_T`,
          tableId: tbl.table_id,
          rowIndex: tbl.row_index,
          colIndex: k,
          position: 'top',
          label: `Table ${tbl.table_id + 1} · Row ${tbl.row_index + 1} · Module ${k * 2 + 2} (Top)`,
          centerLngLat: [centerLon_T, centerLat_T],
          rtcVertices: [m0, m1, t1_pt, t0_pt],
          selfShadeFrac: 0.0,
          moduleSelfShadeFrac: 0.0,
          geoFrac: 0.0,
          selfFrac: 0.0,
          canopyFrac: 0.0,
          svf: svf_T,
          shadeState: { inTerrainShade: false, inCanopyShade: false, isSelfShaded: false }
        });
      }

      this.pushLine(lineData, sw, se, COL_FRAME);
      this.pushLine(lineData, se, ne, COL_FRAME);
      this.pushLine(lineData, ne, nw, COL_FRAME);
      this.pushLine(lineData, nw, sw, COL_FRAME);
      this.pushLine(lineData, midW, midE, COL_MID_SEAM);

      for (let k = 1; k < numPairs; k++) {
        const tRatio = k / numPairs;
        const bK = lerpPt3(sw, se, tRatio);
        const tK = lerpPt3(nw, ne, tRatio);
        this.pushLine(lineData, bK, tK, COL_MODULE_SEAM);

        if (numPairs >= 4 && k % 2 === 0) {
          const bgK = lerpPt3(swG, seG, tRatio);
          const tgK = lerpPt3(nwG, neG, tRatio);
          this.pushLine(lineData, bgK, bK, COL_POST);
          this.pushLine(lineData, tgK, tK, COL_POST);
        }
      }

      this.pushLine(lineData, swG, sw, COL_POST);
      this.pushLine(lineData, seG, se, COL_POST);
      this.pushLine(lineData, nwG, nw, COL_POST);
      this.pushLine(lineData, neG, ne, COL_POST);
    }

    if (this.panels.length > 0) {
      const sumSvf = this.panels.reduce((acc, p) => acc + (p.svf !== undefined ? p.svf : 1.0), 0.0);
      this.avgSvf = sumSvf / this.panels.length;
    } else {
      this.avgSvf = 1.0;
    }

    this.faceVertices = faceVertices;
    this.lineVertices = new Float32Array(lineData);
    this.faceVertexCount = faceVertices.length / 7;
    this.lineVertexCount = lineData.length / 7;
    this._cachedLayout = layout;
  }

  /**
   * Updates only per-cell RGBA colors and panel shade breakdown metadata using the cached static geometry.
   */
  updateFaceColors(sun = null, maskData = null) {
    if (!this.faceVertices || !this._panelRenderSpecs || this._panelRenderSpecs.length === 0) {
      return;
    }

    const currentSun = sun || this.currentSun;
    const solarAz = currentSun.azimuth;
    const solarEl = currentSun.elevation;
    const isDaylight = currentSun.isDaylight && solarEl > 0.0;

    const azDeltaRad = ((solarAz - 180.0) * Math.PI) / 180.0;
    const cosAzDelta = Math.cos(azDeltaRad);
    const tanAzDelta = cosAzDelta > 0.001 ? Math.tan(azDeltaRad) : 0.0;
    const canCheckSelfShade = isDaylight && cosAzDelta > 0.001;

    const CELL_ROWS = 12;
    const CELL_COLS = 6;
    const tau = this.canopyTransmittance !== undefined ? this.canopyTransmittance : 0.15;
    const subW = 1.0 / 6.0;
    const faceVertices = this.faceVertices;

    // Precompute sunlit row gradient colors for rows 0..11
    if (!this._sunlitRowBot) {
      this._sunlitRowBot = [];
      this._sunlitRowTop = [];
      for (let cr = 0; cr < CELL_ROWS; cr++) {
        const rv0 = cr / CELL_ROWS;
        const rv1 = (cr + 1) / CELL_ROWS;
        this._sunlitRowBot.push([
          (1 - rv0) * COL_SUNLIT_BOT[0] + rv0 * COL_SUNLIT_TOP[0],
          (1 - rv0) * COL_SUNLIT_BOT[1] + rv0 * COL_SUNLIT_TOP[1],
          (1 - rv0) * COL_SUNLIT_BOT[2] + rv0 * COL_SUNLIT_TOP[2],
          (1 - rv0) * COL_SUNLIT_BOT[3] + rv0 * COL_SUNLIT_TOP[3]
        ]);
        this._sunlitRowTop.push([
          (1 - rv1) * COL_SUNLIT_BOT[0] + rv1 * COL_SUNLIT_TOP[0],
          (1 - rv1) * COL_SUNLIT_BOT[1] + rv1 * COL_SUNLIT_TOP[1],
          (1 - rv1) * COL_SUNLIT_BOT[2] + rv1 * COL_SUNLIT_TOP[2],
          (1 - rv1) * COL_SUNLIT_BOT[3] + rv1 * COL_SUNLIT_TOP[3]
        ]);
      }
    }

    const cellLitTerrain = new Uint8Array(CELL_ROWS * CELL_COLS);
    const cellSelfShade = new Uint8Array(CELL_ROWS * CELL_COLS);
    const cellCanopyShade = new Uint8Array(CELL_ROWS * CELL_COLS);

    for (let sIdx = 0; sIdx < this._panelRenderSpecs.length; sIdx++) {
      const spec = this._panelRenderSpecs[sIdx];
      const panel = this.panels[spec.panelIdx];

      let hasSouthObstruction = false;
      let selfShadeFrac = 0.0;
      if (canCheckSelfShade && spec.tableRowIndex > spec.minRowIndex && spec.southTables.length > 0) {
        const deltaXM = spec.rowPitchM * tanAzDelta;
        const mPerDegLon = metersPerDegLon(spec.centerLatB);
        const deltaLon = mPerDegLon > 0 ? deltaXM / mPerDegLon : 0.0;
        const lonShadowSource = spec.centerLonB - deltaLon;

        let matchedSouthTable = null;
        for (const st of spec.southTables) {
          const sc = st.corners_wgs84;
          if (!sc || sc.length < 4) continue;
          const stMinLon = Math.min(sc[0][0], sc[3][0]);
          const stMaxLon = Math.max(sc[1][0], sc[2][0]);
          if (lonShadowSource >= stMinLon && lonShadowSource <= stMaxLon) {
            hasSouthObstruction = true;
            matchedSouthTable = st;
            break;
          }
        }

        if (hasSouthObstruction) {
          const southTiltDeg = matchedSouthTable && matchedSouthTable.tilt_deg !== undefined
            ? matchedSouthTable.tilt_deg
            : spec.tblTiltDeg;
          selfShadeFrac = this.calculateRowSelfShadeFraction(
            spec.rowPitchM,
            spec.slantH,
            spec.tblTiltDeg,
            solarAz,
            solarEl,
            southTiltDeg
          );
        }
      }

      let cursor = spec.faceFloatOffset;
      let cellIdx = 0;

      for (let cr = 0; cr < CELL_ROWS; cr++) {
        const isRowSelfShaded = hasSouthObstruction && (selfShadeFrac > spec.rackStart + (cr / 24.0) + 1e-4);
        const litBot = this._sunlitRowBot[cr];
        const litTop = this._sunlitRowTop[cr];

        for (let cc = 0; cc < CELL_COLS; cc++) {
          const cellShade = this.sampleShadowAtPoint(spec.cellsLon[cellIdx], spec.cellsLat[cellIdx], maskData);
          const inTerrain = !isDaylight || cellShade.inTerrainShade;
          const inCanopy = !inTerrain && !isRowSelfShaded && cellShade.inCanopyShade;

          cellLitTerrain[cellIdx] = inTerrain ? 0 : 1;
          cellSelfShade[cellIdx] = isRowSelfShaded ? 1 : 0;
          cellCanopyShade[cellIdx] = inCanopy ? 1 : 0;
          cellIdx++;

          let colBot, colTop;
          if (inTerrain || isRowSelfShaded) {
            colBot = COL_GEOLOGICAL_SHADE;
            colTop = COL_GEOLOGICAL_SHADE;
          } else if (inCanopy) {
            colBot = COL_CANOPY_SHADE;
            colTop = COL_CANOPY_SHADE;
          } else {
            colBot = litBot;
            colTop = litTop;
          }

          // Vertex colors for 6 vertices: p00(bot), p10(bot), p11(top), p00(bot), p11(top), p01(top)
          // Each vertex has stride 7; color starts at +3
          faceVertices[cursor + 3] = colBot[0]; faceVertices[cursor + 4] = colBot[1]; faceVertices[cursor + 5] = colBot[2]; faceVertices[cursor + 6] = colBot[3];
          faceVertices[cursor + 10] = colBot[0]; faceVertices[cursor + 11] = colBot[1]; faceVertices[cursor + 12] = colBot[2]; faceVertices[cursor + 13] = colBot[3];
          faceVertices[cursor + 17] = colTop[0]; faceVertices[cursor + 18] = colTop[1]; faceVertices[cursor + 19] = colTop[2]; faceVertices[cursor + 20] = colTop[3];
          faceVertices[cursor + 24] = colBot[0]; faceVertices[cursor + 25] = colBot[1]; faceVertices[cursor + 26] = colBot[2]; faceVertices[cursor + 27] = colBot[3];
          faceVertices[cursor + 31] = colTop[0]; faceVertices[cursor + 32] = colTop[1]; faceVertices[cursor + 33] = colTop[2]; faceVertices[cursor + 34] = colTop[3];
          faceVertices[cursor + 38] = colTop[0]; faceVertices[cursor + 39] = colTop[1]; faceVertices[cursor + 40] = colTop[2]; faceVertices[cursor + 41] = colTop[3];
          cursor += 42;
        }
      }

      let geoFrac = 0.0;
      let selfFrac = 0.0;
      let canopyFrac = 0.0;
      let anyTerrain = false;
      let anyCanopy = false;
      let anySelf = false;

      for (let h = 0; h < 2; h++) {
        const rStart = h * 6;
        const rEnd = rStart + 6;
        for (let s = 0; s < 3; s++) {
          const cStart = s * 2;
          const cEnd = cStart + 2;
          let subTerrain = false;
          let subSelf = false;
          let subCanopy = false;
          for (let cr = rStart; cr < rEnd; cr++) {
            for (let cc = cStart; cc < cEnd; cc++) {
              const idx = cr * CELL_COLS + cc;
              if (!cellLitTerrain[idx]) subTerrain = true;
              if (cellSelfShade[idx]) subSelf = true;
              if (cellCanopyShade[idx]) subCanopy = true;
            }
          }
          if (subTerrain) {
            geoFrac += subW;
            anyTerrain = true;
          } else if (subSelf) {
            selfFrac += subW;
            anySelf = true;
          } else if (subCanopy) {
            canopyFrac += subW * (1.0 - tau);
            anyCanopy = true;
          }
        }
      }

      panel.selfShadeFrac = selfShadeFrac;
      panel.moduleSelfShadeFrac = selfFrac;
      panel.geoFrac = geoFrac;
      panel.selfFrac = selfFrac;
      panel.canopyFrac = canopyFrac;
      panel.shadeState.inTerrainShade = Boolean(!currentSun.isDaylight || anyTerrain);
      panel.shadeState.inCanopyShade = Boolean(anyCanopy);
      panel.shadeState.isSelfShaded = Boolean(anySelf);
    }
  }

  pushVertex(arr, pos, color) {
    arr.push(pos[0], pos[1], pos[2], color[0], color[1], color[2], color[3]);
  }

  pushLine(arr, p1, p2, color) {
    arr.push(p1[0], p1[1], p1[2], color[0], color[1], color[2], color[3]);
    arr.push(p2[0], p2[1], p2[2], color[0], color[1], color[2], color[3]);
  }

  uploadFaceBuffer() {
    const gl = this.gl;
    if (!gl || !this.faceBuffer || !this.faceVertices) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.faceVertices, gl.DYNAMIC_DRAW);
  }

  uploadLineBuffer() {
    const gl = this.gl;
    if (!gl || !this.lineBuffer || !this.lineVertices) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.lineVertices, gl.STATIC_DRAW);
  }

  uploadBuffers() {
    this.uploadFaceBuffer();
    this.uploadLineBuffer();
  }

  render(gl, matrix) {
    if (!this.visible || !this.program) {
      return;
    }

    gl.useProgram(this.program);

    // Build local model-view-projection matrix: M * T(dx, dy, dz)
    const dx = this.anchorMerc.x;
    const dy = this.anchorMerc.y;
    const dz = this.anchorMerc.z;

    const mvp = this._mvpMatrix || (this._mvpMatrix = new Float32Array(16));
    for (let i = 0; i < 16; i++) {
      mvp[i] = matrix[i];
    }
    mvp[12] = matrix[0] * dx + matrix[4] * dy + matrix[8] * dz + matrix[12];
    mvp[13] = matrix[1] * dx + matrix[5] * dy + matrix[9] * dz + matrix[13];
    mvp[14] = matrix[2] * dx + matrix[6] * dy + matrix[10] * dz + matrix[14];
    mvp[15] = matrix[3] * dx + matrix[7] * dy + matrix[11] * dz + matrix[15];

    this.latestMvp = mvp;
    gl.uniformMatrix4fv(this.uMatrixLocation, false, mvp);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE); // Two-sided viewing for tilted racking structures

    // 1. Draw 3D Tilted Panel Faces (TRIANGLES)
    if (this.faceVertexCount > 0 && this.faceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, this.faceVertexCount);
    }

    // 2. Draw Frames, Module Seams, and Mounting Posts (LINES)
    if (this.lineVertexCount > 0 && this.lineBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.LINES, 0, this.lineVertexCount);
    }

    // 3. Draw Hovered Panel Thick Solid Yellow Border (TRIANGLES)
    if (this.hoveredPanel && this.highlightVertexCount > 0 && this.highlightBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, this.highlightVertexCount);
    }
  }

  setHoveredPanel(panel) {
    if (this.hoveredPanel === panel) return;
    this.hoveredPanel = panel;

    this.rebuildHighlightBuffer();

    if (this.map && typeof this.map.triggerRepaint === 'function') {
      this.map.triggerRepaint();
    }

    if (this.map && typeof this.map.getCanvas === 'function') {
      const canvas = this.map.getCanvas();
      if (canvas && canvas.style) {
        canvas.style.cursor = panel ? 'pointer' : '';
      }
    }

    if (this.onHoverCallback) {
      const breakdown = panel ? this.computePanelBreakdown(panel) : null;
      this.onHoverCallback(panel, breakdown);
    }
  }

  rebuildHighlightBuffer() {
    if (!this.hoveredPanel || !this.hoveredPanel.rtcVertices) {
      this.highlightVertexCount = 0;
      this.highlightVertices = null;
      return;
    }

    const pts = this.hoveredPanel.rtcVertices; // [b0, b1, m1, m0] in local RTC
    const colYellow = [0.98, 0.80, 0.08, 1.0]; // Solid bright yellow (#facc15)

    // Compute panel local axes and upward normal for a thick z-fighting-free quad border
    const ux = pts[1][0] - pts[0][0];
    const uy = pts[1][1] - pts[0][1];
    const uz = pts[1][2] - pts[0][2];
    const uLen = Math.hypot(ux, uy, uz) || 1;

    const vx = pts[3][0] - pts[0][0];
    const vy = pts[3][1] - pts[0][1];
    const vz = pts[3][2] - pts[0][2];
    const vLen = Math.hypot(vx, vy, vz) || 1;

    const uDir = [ux / uLen, uy / uLen, uz / uLen];
    const vDir = [vx / vLen, vy / vLen, vz / vLen];

    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen;
    ny /= nLen;
    nz /= nLen;
    if (nz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const minSide = Math.min(uLen, vLen);
    const halfT = minSide * 0.055; // ~11% of module width total border thickness
    const lift = minSide * 0.015;  // Slight lift above panel surface to prevent z-fighting

    const offsetCorner = (pt, uSign, vSign) => [
      pt[0] + uDir[0] * halfT * uSign + vDir[0] * halfT * vSign + nx * lift,
      pt[1] + uDir[1] * halfT * uSign + vDir[1] * halfT * vSign + ny * lift,
      pt[2] + uDir[2] * halfT * uSign + vDir[2] * halfT * vSign + nz * lift
    ];

    const outer = [
      offsetCorner(pts[0], -1, -1),
      offsetCorner(pts[1], +1, -1),
      offsetCorner(pts[2], +1, +1),
      offsetCorner(pts[3], -1, +1)
    ];
    const inner = [
      offsetCorner(pts[0], +1, +1),
      offsetCorner(pts[1], -1, +1),
      offsetCorner(pts[2], -1, -1),
      offsetCorner(pts[3], +1, -1)
    ];

    const tris = [];
    for (let i = 0; i < 4; i++) {
      const next = (i + 1) % 4;
      this.pushVertex(tris, outer[i], colYellow);
      this.pushVertex(tris, outer[next], colYellow);
      this.pushVertex(tris, inner[next], colYellow);

      this.pushVertex(tris, outer[i], colYellow);
      this.pushVertex(tris, inner[next], colYellow);
      this.pushVertex(tris, inner[i], colYellow);
    }

    this.highlightVertices = new Float32Array(tris);
    this.highlightVertexCount = tris.length / 7;

    const gl = this.gl;
    if (gl && this.highlightBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.highlightVertices, gl.DYNAMIC_DRAW);
    }
  }

  findPanelAtPoint(screenX, screenY, width, height) {
    if (!this.visible || !this.latestMvp || !this.panels || this.panels.length === 0) {
      return null;
    }

    const M = this.latestMvp;
    let closestPanel = null;
    let minZ = Infinity;

    for (let i = 0; i < this.panels.length; i++) {
      const p = this.panels[i];
      const screenQuad = [];
      let behind = false;
      let avgZ = 0;

      for (let j = 0; j < 4; j++) {
        const v = p.rtcVertices[j];
        const xc = M[0] * v[0] + M[4] * v[1] + M[8] * v[2] + M[12];
        const yc = M[1] * v[0] + M[5] * v[1] + M[9] * v[2] + M[13];
        const zc = M[2] * v[0] + M[6] * v[1] + M[10] * v[2] + M[14];
        const wc = M[3] * v[0] + M[7] * v[1] + M[11] * v[2] + M[15];

        if (wc <= 0.0001) {
          behind = true;
          break;
        }

        const ndcX = xc / wc;
        const ndcY = yc / wc;
        const sx = (ndcX * 0.5 + 0.5) * width;
        const sy = (1.0 - (ndcY * 0.5 + 0.5)) * height;
        screenQuad.push([sx, sy]);
        avgZ += zc / wc;
      }

      if (behind || screenQuad.length < 4) continue;

      if (this.pointInQuad(screenX, screenY, screenQuad)) {
        if (avgZ < minZ) {
          minZ = avgZ;
          closestPanel = p;
        }
      }
    }

    return closestPanel;
  }

  pointInQuad(px, py, q) {
    let sign = null;
    for (let i = 0; i < 4; i++) {
      const p1 = q[i];
      const p2 = q[(i + 1) % 4];
      const cp = (p2[0] - p1[0]) * (py - p1[1]) - (p2[1] - p1[1]) * (px - p1[0]);
      if (Math.abs(cp) > 1e-4) {
        const currentSign = cp > 0;
        if (sign === null) {
          sign = currentSign;
        } else if (sign !== currentSign) {
          return false;
        }
      }
    }
    return true;
  }

  computePanelBreakdown(panel) {
    if (!panel) return null;

    const metric = this.latestMetric;
    const totalPanels = this.getTotalPanels() || 1;
    const isDaylight = metric ? (metric.is_daylight && metric.solar_elevation_deg > 0) : this.currentSun.isDaylight;

    if (!isDaylight || !metric) {
      return {
        incidentW: 0.0,
        totalShadeW: 0.0,
        geoLossW: 0.0,
        treeLossW: 0.0,
        selfLossW: 0.0,
        diffuseW: 0.0,
        acPowerW: 0.0,
        unshadedW: 0.0
      };
    }

    // Direct incident potential and diffuse sky radiation for this single panel module
    const arrayUnshadedKw = metric.unshaded_power_kw !== undefined ? metric.unshaded_power_kw : metric.power_kw;
    const panelSvf = panel.svf !== undefined ? panel.svf : 1.0;
    const avgSvf = this.avgSvf && this.avgSvf > 0 ? this.avgSvf : 1.0;
    const svfRatio = panelSvf / avgSvf;

    let incidentW;
    let diffuseW;
    if (metric.incident_power_kw !== undefined && metric.diffuse_power_kw !== undefined) {
      incidentW = (metric.incident_power_kw / totalPanels) * 1000.0;
      diffuseW = ((metric.diffuse_power_kw / totalPanels) * 1000.0) * svfRatio;
    } else {
      const unshadedW = (arrayUnshadedKw / totalPanels) * 1000.0;
      incidentW = unshadedW * 0.85;
      diffuseW = (unshadedW * 0.15) * svfRatio;
    }

    let geoLossW = 0.0;
    let treeLossW = 0.0;
    let selfLossW = 0.0;

    if (panel.geoFrac !== undefined && panel.selfFrac !== undefined && panel.canopyFrac !== undefined) {
      geoLossW = incidentW * panel.geoFrac;
      selfLossW = incidentW * panel.selfFrac;
      treeLossW = incidentW * panel.canopyFrac;
    } else {
      const shade = panel.shadeState;
      if (shade.inTerrainShade) {
        // In geological terrain shadow: 100% opaque geological barrier blocks all direct beam
        geoLossW = incidentW;
      } else {
        // Solid panel self-shading takes physical precedence over semi-transparent tree canopy
        const modFrac = shade.isSelfShaded
          ? (panel.moduleSelfShadeFrac !== undefined ? panel.moduleSelfShadeFrac : Math.min(1.0, (panel.selfShadeFrac || 0.0) * 2.0))
          : 0.0;
        selfLossW = incidentW * modFrac;

        const unblockedDirectW = Math.max(0.0, incidentW - selfLossW);

        if (shade.inCanopyShade && unblockedDirectW > 0.0) {
          // Vegetative tree canopy attenuates only the remaining unblocked direct beam
          const tau = this.canopyTransmittance !== undefined ? this.canopyTransmittance : 0.15;
          treeLossW = unblockedDirectW * (1.0 - tau);
        }
      }
    }

    const totalShadeW = geoLossW + treeLossW + selfLossW;
    const directReachingW = Math.max(0.0, incidentW - totalShadeW);
    const acPowerW = Math.max(0.0, directReachingW + diffuseW);
    const unshadedW = incidentW + diffuseW;

    return {
      incidentW,
      totalShadeW,
      geoLossW,
      treeLossW,
      selfLossW,
      diffuseW,
      acPowerW,
      unshadedW,
      svf: panelSvf
    };
  }

  setOnPanelHover(callback) {
    this.onHoverCallback = callback;
  }

  getPanels() {
    return this.panels;
  }

  getHoveredPanel() {
    return this.hoveredPanel;
  }

  onRemove(map, gl) {
    if (gl) {
      if (this.faceBuffer) gl.deleteBuffer(this.faceBuffer);
      if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
      if (this.highlightBuffer) gl.deleteBuffer(this.highlightBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.map = null;
    this.gl = null;
    this.program = null;
  }
}
