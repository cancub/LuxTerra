/**
 * SolarPanel3DLayer Component
 * Custom MapLibre GL 3D WebGL layer that renders maximal ground-mount solar panel tables
 * in true 3D spatial coordinates:
 * - Dynamic 3D ground shadows cast onto the terrain plane tracking solar azimuth and elevation
 * - Crisp architectural white panel surfaces by default, dynamically darkening as shadows pass:
 *     * Deep forest green when under vegetative tree canopy shade
 *     * Dark slate shadow tone when under geological (terrain) or inter-row panel self-shade
 * - Independent bottom/top 2P module rendering for realistic partial self-shading progression
 * - Aluminum perimeter frames, module seams, and galvanized structural steel vertical posts
 *
 * Uses Relative-to-Center (RTC) 64-bit coordinate translation to prevent single-precision
 * vertex jitter at high zoom levels.
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
const COL_GROUND_SHADOW = [0.06, 0.09, 0.16, 0.60];   // Ground shadow polygon on earth plane

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

    this.shadowBuffer = null;
    this.faceBuffer = null;
    this.lineBuffer = null;

    this.shadowVertexCount = 0;
    this.faceVertexCount = 0;
    this.lineVertexCount = 0;

    // Anchor Mercator coordinate for RTC (Relative to Center) precision
    this.anchorMerc = { x: 0, y: 0, z: 0 };
    this.layout = null;
    this.pendingLayout = null;

    // Cached raw arrays for testing and inspection
    this.shadowVertices = null;
    this.faceVertices = null;
    this.lineVertices = null;

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

    this.shadowBuffer = gl.createBuffer();
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
      this.shadowVertexCount = 0;
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      this.shadowVertices = null;
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
   * Updates sun angle and current raster shadow masks for dynamic 3D ground shadows
   * and live panel face darkening (canopy green vs geological dark slate).
   */
  updateSunPosition(azimuthDeg, elevationDeg, isDaylight, maskStr = null, canopyMaskStr = null, patchBounds = null, rows = 0, cols = 0) {
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
      // Nighttime: entire field in shadow
      this.currentMasks = null;
    }

    if (this.layout && this.layout.tables && this.layout.tables.length > 0) {
      this.rebuildBuffers();
    }
  }

  rebuildBuffers() {
    this.buildGeometry(this.layout, this.currentSun, this.currentMasks);

    if (this.gl && this.faceBuffer && this.lineBuffer && this.shadowBuffer) {
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
   * Builds Float32 vertex buffers for tilted panel faces, ground shadows, and frames/posts.
   */
  buildGeometry(layout, sun = null, maskData = null) {
    const tables = layout.tables;
    if (!tables || tables.length === 0) {
      this.shadowVertexCount = 0;
      this.faceVertexCount = 0;
      this.lineVertexCount = 0;
      return;
    }

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

    const shadowData = []; // Ground shadow triangles on z = 0
    const faceData = [];   // Elevated panel faces (2 quads per 2P table: bottom & top)
    const lineData = [];   // Perimeter frames, module seams, and mounting legs

    // Calculate displacement in Mercator units for ground shadow projection
    // Mercator coordinate scale: 1 meter = meterUnits
    const firstMerc = MercatorCoordinate.fromLngLat(anchorLngLat, 0);
    const meterUnits = typeof firstMerc.meterInMercatorCoordinateUnits === 'function'
      ? firstMerc.meterInMercatorCoordinateUnits()
      : 1e-7;

    let shadowProjDX_perM = 0;
    let shadowProjDY_perM = 0;

    if (isDaylight) {
      const azRad = (solarAz * Math.PI) / 180.0;
      const elRad = (Math.max(1.5, solarEl) * Math.PI) / 180.0;
      const tanEl = Math.tan(elRad);

      // In meters:
      // dx = -sin(az) / tan(el)
      // dy_North = -cos(az) / tan(el). In Mercator, +y is South, so dy_merc = +cos(az) / tan(el)
      const maxShadowMeters = 50.0;
      const shadowLengthMeters = Math.min(maxShadowMeters, 1.0 / tanEl);
      shadowProjDX_perM = -Math.sin(azRad) * shadowLengthMeters * meterUnits;
      shadowProjDY_perM = Math.cos(azRad) * shadowLengthMeters * meterUnits;
    }

    const rowPitchM = layout.row_pitch_m || 10.57;

    for (let t = 0; t < tables.length; t++) {
      const tbl = tables[t];
      const corners = tbl.corners_wgs84;
      if (!corners || corners.length < 4) continue;

      const tiltRad = ((tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0) * Math.PI) / 180.0;
      const hBottom = tbl.stand_height_m !== undefined ? tbl.stand_height_m : 1.0;
      const slantH = tbl.slant_height_m !== undefined ? tbl.slant_height_m : 4.56;
      const hMid = hBottom + 0.5 * slantH * Math.sin(tiltRad);
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

      // --- 1. Dynamic 3D Ground Shadow Quads (rendered at z = 0) ---
      if (isDaylight) {
        // Project SW, SE (at hBottom) and NW, NE (at hTop) down to ground plane
        const swProj = [swG[0] + shadowProjDX_perM * hBottom, swG[1] + shadowProjDY_perM * hBottom, swG[2]];
        const seProj = [seG[0] + shadowProjDX_perM * hBottom, seG[1] + shadowProjDY_perM * hBottom, seG[2]];
        const neProj = [neG[0] + shadowProjDX_perM * hTop,    neG[1] + shadowProjDY_perM * hTop,    neG[2]];
        const nwProj = [nwG[0] + shadowProjDX_perM * hTop,    nwG[1] + shadowProjDY_perM * hTop,    nwG[2]];

        // Rack footprint shadow quad (underneath rack)
        this.pushQuad(shadowData, swG, seG, neG, nwG, COL_GROUND_SHADOW);

        // Projected rack face shadow quad
        this.pushQuad(shadowData, swProj, seProj, neProj, nwProj, COL_GROUND_SHADOW);

        // Bridge quad linking rack ground base to projected top edge
        this.pushQuad(shadowData, nwG, neG, neProj, nwProj, COL_GROUND_SHADOW);
        this.pushQuad(shadowData, swG, seG, seProj, swProj, COL_GROUND_SHADOW);
      }

      // --- 2. Dynamic Module Shading (Canopy Green vs Geological Dark Slate vs Sunlit White) ---
      let colBotTop = COL_SUNLIT_TOP;
      let colBotBot = COL_SUNLIT_BOT;
      let colTopTop = COL_SUNLIT_TOP;
      let colTopBot = COL_SUNLIT_BOT;

      if (!currentSun.isDaylight) {
        // Nighttime: full dark geological shade
        colBotTop = COL_GEOLOGICAL_SHADE;
        colBotBot = COL_GEOLOGICAL_SHADE;
        colTopTop = COL_GEOLOGICAL_SHADE;
        colTopBot = COL_GEOLOGICAL_SHADE;
      } else {
        const center = tbl.center_wgs84 || corners[0];
        const shade = this.sampleShadowAtPoint(center[0], center[1], maskData);

        if (shade.inTerrainShade) {
          // Terrain / mountain blocks direct sunlight
          colBotTop = COL_GEOLOGICAL_SHADE;
          colBotBot = COL_GEOLOGICAL_SHADE;
          colTopTop = COL_GEOLOGICAL_SHADE;
          colTopBot = COL_GEOLOGICAL_SHADE;
        } else if (shade.inCanopyShade) {
          // Tree canopy blocks direct sunlight -> rich forest green
          colBotTop = COL_CANOPY_SHADE;
          colBotBot = COL_CANOPY_SHADE;
          colTopTop = COL_CANOPY_SHADE;
          colTopBot = COL_CANOPY_SHADE;
        } else {
          // Direct sunlight is available: evaluate inter-row self-shading
          if (tbl.row_index > 0) {
            const selfShadeFrac = this.calculateRowSelfShadeFraction(
              rowPitchM,
              slantH,
              tbl.tilt_deg !== undefined ? tbl.tilt_deg : 30.0,
              solarAz,
              solarEl
            );

            if (selfShadeFrac >= 0.5) {
              // Both bottom and top modules shaded by front row
              colBotTop = COL_GEOLOGICAL_SHADE;
              colBotBot = COL_GEOLOGICAL_SHADE;
              colTopTop = COL_GEOLOGICAL_SHADE;
              colTopBot = COL_GEOLOGICAL_SHADE;
            } else if (selfShadeFrac > 0.0) {
              // Lower module in self-shade, upper module in direct sun
              colBotTop = COL_GEOLOGICAL_SHADE;
              colBotBot = COL_GEOLOGICAL_SHADE;
              colTopTop = COL_SUNLIT_TOP;
              colTopBot = COL_SUNLIT_BOT;
            }
          }
        }
      }

      // --- 3. Panel Face Triangles (Bottom & Top 2P Module Quads) ---
      // Bottom 2P Module Quad: SW, SE, midE, midW
      this.pushVertex(faceData, sw, colBotBot);
      this.pushVertex(faceData, se, colBotBot);
      this.pushVertex(faceData, midE, colBotTop);

      this.pushVertex(faceData, sw, colBotBot);
      this.pushVertex(faceData, midE, colBotTop);
      this.pushVertex(faceData, midW, colBotTop);

      // Top 2P Module Quad: midW, midE, ne, nw
      this.pushVertex(faceData, midW, colTopBot);
      this.pushVertex(faceData, midE, colTopBot);
      this.pushVertex(faceData, ne, colTopTop);

      this.pushVertex(faceData, midW, colTopBot);
      this.pushVertex(faceData, ne, colTopTop);
      this.pushVertex(faceData, nw, colTopTop);

      // --- 4. Aluminum Framing Lines (Perimeter) ---
      this.pushLine(lineData, sw, se, COL_FRAME);
      this.pushLine(lineData, se, ne, COL_FRAME);
      this.pushLine(lineData, ne, nw, COL_FRAME);
      this.pushLine(lineData, nw, sw, COL_FRAME);

      // --- 5. 2P Horizontal Mid-Seam ---
      this.pushLine(lineData, midW, midE, COL_MID_SEAM);

      // --- 6. Vertical Seams Dividing Module Pairs ---
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

      // --- 7. Four Corner Vertical Mounting Posts (Ground to Rack) ---
      this.pushLine(lineData, swG, sw, COL_POST);
      this.pushLine(lineData, seG, se, COL_POST);
      this.pushLine(lineData, nwG, nw, COL_POST);
      this.pushLine(lineData, neG, ne, COL_POST);
    }

    this.shadowVertices = new Float32Array(shadowData);
    this.faceVertices = new Float32Array(faceData);
    this.lineVertices = new Float32Array(lineData);

    this.shadowVertexCount = shadowData.length / 7;
    this.faceVertexCount = faceData.length / 7;
    this.lineVertexCount = lineData.length / 7;
  }

  pushVertex(arr, pos, color) {
    arr.push(pos[0], pos[1], pos[2], color[0], color[1], color[2], color[3]);
  }

  pushQuad(arr, p1, p2, p3, p4, color) {
    // Triangle 1: p1, p2, p3
    this.pushVertex(arr, p1, color);
    this.pushVertex(arr, p2, color);
    this.pushVertex(arr, p3, color);
    // Triangle 2: p1, p3, p4
    this.pushVertex(arr, p1, color);
    this.pushVertex(arr, p3, color);
    this.pushVertex(arr, p4, color);
  }

  pushLine(arr, p1, p2, color) {
    arr.push(p1[0], p1[1], p1[2], color[0], color[1], color[2], color[3]);
    arr.push(p2[0], p2[1], p2[2], color[0], color[1], color[2], color[3]);
  }

  uploadBuffers() {
    const gl = this.gl;
    if (!gl) return;

    if (this.shadowBuffer && this.shadowVertices) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.shadowVertices, gl.DYNAMIC_DRAW);
    }

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

    // 1. Draw Dynamic Ground Shadows (TRIANGLES on ground plane z = 0)
    // Rendered with depthMask false so shadows lay smoothly beneath racks without occluding legs
    if (this.shadowVertexCount > 0 && this.shadowBuffer) {
      gl.depthMask(false);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, this.shadowVertexCount);
      gl.depthMask(true);
    }

    // 2. Draw 3D Tilted Panel Faces (TRIANGLES)
    if (this.faceVertexCount > 0 && this.faceBuffer) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.faceBuffer);
      gl.enableVertexAttribArray(this.aPosLocation);
      gl.vertexAttribPointer(this.aPosLocation, 3, gl.FLOAT, false, 7 * 4, 0);
      gl.enableVertexAttribArray(this.aColorLocation);
      gl.vertexAttribPointer(this.aColorLocation, 4, gl.FLOAT, false, 7 * 4, 3 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, this.faceVertexCount);
    }

    // 3. Draw Frames, Module Seams, and Mounting Posts (LINES)
    if (this.lineVertexCount > 0 && this.lineBuffer) {
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
      if (this.shadowBuffer) gl.deleteBuffer(this.shadowBuffer);
      if (this.faceBuffer) gl.deleteBuffer(this.faceBuffer);
      if (this.lineBuffer) gl.deleteBuffer(this.lineBuffer);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.map = null;
    this.gl = null;
    this.program = null;
  }
}
