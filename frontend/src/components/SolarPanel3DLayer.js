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
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.faceVertices = null;
      this.lineVertices = null;
      if (this.map && typeof this.map.triggerRepaint === 'function') {
        this.map.triggerRepaint();
      }
      return;
    }

    this.rebuildBuffers();
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
  updateSunPosition(azimuthDeg, elevationDeg, isDaylight, maskStr = null, canopyMaskStr = null, patchBounds = null, rows = 0, cols = 0, metric = null, canopyTransmittance = 0.15) {
    this.latestMetric = metric;
    this.canopyTransmittance = canopyTransmittance;
    this.currentSun = {
      azimuth: azimuthDeg !== undefined ? azimuthDeg : 180.0,
      elevation: elevationDeg !== undefined ? elevationDeg : 0.0,
      isDaylight: Boolean(isDaylight)
    };

    if (maskStr && patchBounds && rows > 0 && cols > 0) {
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
      this.rebuildBuffers();
    }

    if (this.hoveredPanel && this.onHoverCallback) {
      const breakdown = this.computePanelBreakdown(this.hoveredPanel);
      this.onHoverCallback(this.hoveredPanel, breakdown);
    }
  }

  rebuildBuffers() {
    this.buildGeometry(this.layout, this.currentSun, this.currentMasks);

    if (this.gl && this.faceBuffer && this.lineBuffer) {
      this.uploadBuffers();
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
  calculateRowSelfShadeFraction(rowPitchM, slantHM, tiltDeg, azDeg, elDeg) {
    if (elDeg <= 0.0) return 1.0;
    const azDeltaRad = ((azDeg - 180.0) * Math.PI) / 180.0;
    const cosAzDelta = Math.cos(azDeltaRad);
    if (cosAzDelta <= 0.001) return 0.0;

    const tiltRad = (tiltDeg * Math.PI) / 180.0;
    const tanAlphaP = Math.tan((elDeg * Math.PI) / 180.0) / cosAzDelta;
    if (tanAlphaP <= 1e-5) return 1.0;

    const dGap = rowPitchM - slantHM * Math.cos(tiltRad);
    const hRise = slantHM * Math.sin(tiltRad);
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
  calculateModuleRackSvf(rowPitchM, slantHM, tiltDeg, isTop, hasSouthObstruction) {
    if (!hasSouthObstruction || rowPitchM <= 0.0 || slantHM <= 0.0) {
      return 1.0;
    }
    const tiltRad = (tiltDeg * Math.PI) / 180.0;
    const fFrac = isTop ? 0.75 : 0.25;
    const dz = (1.0 - fFrac) * slantHM * Math.sin(tiltRad);
    const dy = rowPitchM - (1.0 - fFrac) * slantHM * Math.cos(tiltRad);
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
    const tables = layout.tables;
    if (!tables || tables.length === 0) {
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.panels = [];
      this.hoveredPanel = null;
      return;
    }

    this.panels = [];
    const minRowIndex = tables.reduce((min, t) => Math.min(min, t.row_index !== undefined ? t.row_index : 0), Infinity);

    const currentSun = sun || this.currentSun;
    const solarAz = currentSun.azimuth;
    const solarEl = currentSun.elevation;
    const isDaylight = currentSun.isDaylight && solarEl > 0.0;

    // Set anchor point using center of first table for RTC coordinate stabilization
    const firstTable = tables[0];
    const anchorLngLat = firstTable.center_wgs84 || firstTable.corners_wgs84[0];
    const anchor = MercatorCoordinate.fromLngLat(anchorLngLat, 0);
    this.anchorMerc = { x: anchor.x, y: anchor.y, z: anchor.z };

    const dx = this.anchorMerc.x;
    const dy = this.anchorMerc.y;
    const dz = this.anchorMerc.z;

    const faceData = []; // Elevated panel faces: 2 quads per module pair (bottom & top modules)
    const lineData = []; // Perimeter frames, module seams, and mounting legs

    const rowPitchM = layout.row_pitch_m || 10.57;

    const tablesByRow = new Map();
    for (let i = 0; i < tables.length; i++) {
      const rIdx = tables[i].row_index;
      if (!tablesByRow.has(rIdx)) tablesByRow.set(rIdx, []);
      tablesByRow.get(rIdx).push(tables[i]);
    }

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

      // Local RTC coordinates (Elevated rack)
      const sw = [swM.x - dx, swM.y - dy, swM.z - dz];
      const se = [seM.x - dx, seM.y - dy, seM.z - dz];
      const ne = [neM.x - dx, neM.y - dy, neM.z - dz];
      const nw = [nwM.x - dx, nwM.y - dy, nwM.z - dz];

      // Local RTC coordinates (Ground post bases on z = 0)
      const swG = [swGM.x - dx, swGM.y - dy, swGM.z - dz];
      const seG = [seGM.x - dx, seGM.y - dy, seGM.z - dz];
      const neG = [neGM.x - dx, neGM.y - dy, neGM.z - dz];
      const nwG = [nwGM.x - dx, nwGM.y - dy, nwGM.z - dz];

      // Mid-seam elevated 3D points
      const midW = [0.5 * (sw[0] + nw[0]), 0.5 * (sw[1] + nw[1]), 0.5 * (sw[2] + nw[2])];
      const midE = [0.5 * (se[0] + ne[0]), 0.5 * (se[1] + ne[1]), 0.5 * (se[2] + ne[2])];

      // Find tables in the row immediately to the south for precise ray obstruction checks
      const southTables = tablesByRow.get(tbl.row_index - 1) || [];

      const c0 = corners[0]; // SW
      const c1 = corners[1]; // SE
      const c2 = corners[2]; // NE
      const c3 = corners[3]; // NW

      const panelCount = tbl.panel_count || 4;
      const numPairs = Math.max(1, Math.floor(panelCount / 2));

      // --- Render EACH individual solar panel independently! ---
      for (let k = 0; k < numPairs; k++) {
        const t0 = k / numPairs;
        const t1 = (k + 1) / numPairs;
        const tMid = (k + 0.5) / numPairs;

        // 3D elevated points for this panel column
        const b0 = [
          (1 - t0) * sw[0] + t0 * se[0],
          (1 - t0) * sw[1] + t0 * se[1],
          (1 - t0) * sw[2] + t0 * se[2]
        ];
        const b1 = [
          (1 - t1) * sw[0] + t1 * se[0],
          (1 - t1) * sw[1] + t1 * se[1],
          (1 - t1) * sw[2] + t1 * se[2]
        ];

        const m0 = [
          (1 - t0) * midW[0] + t0 * midE[0],
          (1 - t0) * midW[1] + t0 * midE[1],
          (1 - t0) * midW[2] + t0 * midE[2]
        ];
        const m1 = [
          (1 - t1) * midW[0] + t1 * midE[0],
          (1 - t1) * midW[1] + t1 * midE[1],
          (1 - t1) * midW[2] + t1 * midE[2]
        ];

        const t0_pt = [
          (1 - t0) * nw[0] + t0 * ne[0],
          (1 - t0) * nw[1] + t0 * ne[1],
          (1 - t0) * nw[2] + t0 * ne[2]
        ];
        const t1_pt = [
          (1 - t1) * nw[0] + t1 * ne[0],
          (1 - t1) * nw[1] + t1 * ne[1],
          (1 - t1) * nw[2] + t1 * ne[2]
        ];

        // Specific geographic coordinates for this individual panel module
        const lonBot = (1 - tMid) * c0[0] + tMid * c1[0];
        const latBot = (1 - tMid) * c0[1] + tMid * c1[1];
        const lonTop = (1 - tMid) * c3[0] + tMid * c2[0];
        const latTop = (1 - tMid) * c3[1] + tMid * c2[1];

        const centerLon_B = 0.75 * lonBot + 0.25 * lonTop;
        const centerLat_B = 0.75 * latBot + 0.25 * latTop;
        const centerLon_T = 0.25 * lonBot + 0.75 * lonTop;
        const centerLat_T = 0.25 * latBot + 0.75 * latTop;

        const tblTiltDeg = tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0;

        // Check if there is a physical table directly south of this module column (for diffuse SVF)
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

        // Check if there is an actual physical table directly to the south along the solar vector
        let hasSouthObstruction = false;
        let selfShadeFrac = 0.0;
        if (tbl.row_index > minRowIndex && isDaylight && southTables.length > 0) {
          const azDeltaRad = ((solarAz - 180.0) * Math.PI) / 180.0;
          const cosAzDelta = Math.cos(azDeltaRad);
          if (cosAzDelta > 0.001) {
            const deltaXM = rowPitchM * Math.tan(azDeltaRad);
            const mPerDegLon = 111320.0 * Math.cos((centerLat_B * Math.PI) / 180.0);
            const deltaLon = mPerDegLon > 0 ? deltaXM / mPerDegLon : 0.0;
            const lonShadowSource = centerLon_B - deltaLon;

            for (const st of southTables) {
              const sc = st.corners_wgs84;
              if (!sc || sc.length < 4) continue;
              const stMinLon = Math.min(sc[0][0], sc[3][0]);
              const stMaxLon = Math.max(sc[1][0], sc[2][0]);
              if (lonShadowSource >= stMinLon && lonShadowSource <= stMaxLon) {
                hasSouthObstruction = true;
                break;
              }
            }

            if (hasSouthObstruction) {
              selfShadeFrac = this.calculateRowSelfShadeFraction(
                rowPitchM,
                slantH,
                tblTiltDeg,
                solarAz,
                solarEl
              );
            }
          }
        }
        const isSelfShaded_B = selfShadeFrac > 0.0;
        const isSelfShaded_T = selfShadeFrac >= 0.5;

        const svf_B = (tbl.module_svf && tbl.module_svf[2 * k] !== undefined)
          ? tbl.module_svf[2 * k]
          : this.calculateModuleRackSvf(rowPitchM, slantH, tblTiltDeg, false, hasSouthRack);
        const svf_T = (tbl.module_svf && tbl.module_svf[2 * k + 1] !== undefined)
          ? tbl.module_svf[2 * k + 1]
          : this.calculateModuleRackSvf(rowPitchM, slantH, tblTiltDeg, true, hasSouthRack);

        const shade_B = this.sampleShadowAtPoint(centerLon_B, centerLat_B, maskData);
        const shade_T = this.sampleShadowAtPoint(centerLon_T, centerLat_T, maskData);

        // Independent color for bottom panel module
        let colB_top = COL_SUNLIT_TOP;
        let colB_bot = COL_SUNLIT_BOT;
        if (!currentSun.isDaylight || shade_B.inTerrainShade || isSelfShaded_B) {
          colB_top = COL_GEOLOGICAL_SHADE;
          colB_bot = COL_GEOLOGICAL_SHADE;
        } else if (shade_B.inCanopyShade) {
          colB_top = COL_CANOPY_SHADE;
          colB_bot = COL_CANOPY_SHADE;
        }

        // Independent color for top panel module
        let colT_top = COL_SUNLIT_TOP;
        let colT_bot = COL_SUNLIT_BOT;
        if (!currentSun.isDaylight || shade_T.inTerrainShade || isSelfShaded_T) {
          colT_top = COL_GEOLOGICAL_SHADE;
          colT_bot = COL_GEOLOGICAL_SHADE;
        } else if (shade_T.inCanopyShade) {
          colT_top = COL_CANOPY_SHADE;
          colT_bot = COL_CANOPY_SHADE;
        }

        // --- Bottom Panel Quad (SW, SE, midE, midW) ---
        this.pushVertex(faceData, b0, colB_bot);
        this.pushVertex(faceData, b1, colB_bot);
        this.pushVertex(faceData, m1, colB_top);

        this.pushVertex(faceData, b0, colB_bot);
        this.pushVertex(faceData, m1, colB_top);
        this.pushVertex(faceData, m0, colB_top);

        // --- Top Panel Quad (midW, midE, ne, nw) ---
        this.pushVertex(faceData, m0, colT_bot);
        this.pushVertex(faceData, m1, colT_bot);
        this.pushVertex(faceData, t1_pt, colT_top);

        this.pushVertex(faceData, m0, colT_bot);
        this.pushVertex(faceData, t1_pt, colT_top);
        this.pushVertex(faceData, t0_pt, colT_top);

        const modSelfFrac_B = Math.min(1.0, Math.max(0.0, selfShadeFrac * 2.0));
        const modSelfFrac_T = Math.min(1.0, Math.max(0.0, (selfShadeFrac - 0.5) * 2.0));

        // Record discrete panel modules for interactive ray-casting and per-panel power hover
        this.panels.push({
          id: `t${tbl.table_id}_c${k}_B`,
          tableId: tbl.table_id,
          rowIndex: tbl.row_index,
          colIndex: k,
          position: 'bottom',
          label: `Table ${tbl.table_id + 1} · Row ${tbl.row_index + 1} · Module ${k * 2 + 1} (Bottom)`,
          centerLngLat: [centerLon_B, centerLat_B],
          rtcVertices: [b0, b1, m1, m0],
          selfShadeFrac: selfShadeFrac,
          moduleSelfShadeFrac: modSelfFrac_B,
          svf: svf_B,
          shadeState: {
            inTerrainShade: Boolean(!currentSun.isDaylight || shade_B.inTerrainShade),
            inCanopyShade: Boolean(shade_B.inCanopyShade),
            isSelfShaded: Boolean(isSelfShaded_B)
          }
        });

        this.panels.push({
          id: `t${tbl.table_id}_c${k}_T`,
          tableId: tbl.table_id,
          rowIndex: tbl.row_index,
          colIndex: k,
          position: 'top',
          label: `Table ${tbl.table_id + 1} · Row ${tbl.row_index + 1} · Module ${k * 2 + 2} (Top)`,
          centerLngLat: [centerLon_T, centerLat_T],
          rtcVertices: [m0, m1, t1_pt, t0_pt],
          selfShadeFrac: selfShadeFrac,
          moduleSelfShadeFrac: modSelfFrac_T,
          svf: svf_T,
          shadeState: {
            inTerrainShade: Boolean(!currentSun.isDaylight || shade_T.inTerrainShade),
            inCanopyShade: Boolean(shade_T.inCanopyShade),
            isSelfShaded: Boolean(isSelfShaded_T)
          }
        });
      }

      // --- Aluminum Framing Lines (Perimeter) ---
      this.pushLine(lineData, sw, se, COL_FRAME);
      this.pushLine(lineData, se, ne, COL_FRAME);
      this.pushLine(lineData, ne, nw, COL_FRAME);
      this.pushLine(lineData, nw, sw, COL_FRAME);

      // --- 2P Horizontal Mid-Seam ---
      this.pushLine(lineData, midW, midE, COL_MID_SEAM);

      // --- Vertical Seams Dividing Module Pairs ---
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
        this.pushLine(lineData, bK, tK, COL_MODULE_SEAM);

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
          this.pushLine(lineData, bgK, bK, COL_POST);
          this.pushLine(lineData, tgK, tK, COL_POST);
        }
      }

      // --- Four Corner Vertical Mounting Posts (Ground to Rack) ---
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
    if (!gl) return;

    if (this.faceBuffer && this.faceVertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.faceVertices, gl.DYNAMIC_DRAW);
    }

    if (this.lineBuffer && this.lineVertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.lineVertices, gl.DYNAMIC_DRAW);
    }
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

    // 3. Draw Hovered Panel Vibrant Highlight (LINES)
    if (this.hoveredPanel && this.highlightVertexCount > 0 && this.highlightBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.highlightBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.LINES, 0, this.highlightVertexCount);
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
    const colHighlight = [0.22, 0.74, 0.97, 1.0]; // Bright electric cyan
    const colAccent = [0.98, 0.80, 0.20, 0.95];   // Golden amber accent

    const lines = [];
    // 4 perimeter lines for the hovered module
    this.pushLine(lines, pts[0], pts[1], colHighlight);
    this.pushLine(lines, pts[1], pts[2], colHighlight);
    this.pushLine(lines, pts[2], pts[3], colHighlight);
    this.pushLine(lines, pts[3], pts[0], colHighlight);

    // Cross diagonals for architectural reticle highlight
    this.pushLine(lines, pts[0], pts[2], colAccent);
    this.pushLine(lines, pts[1], pts[3], colAccent);

    this.highlightVertices = new Float32Array(lines);
    this.highlightVertexCount = lines.length / 7;

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
