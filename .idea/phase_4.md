# Phase 4: Frontend UI Controls & Dappled Shading Visualization

> **Phase Objective**: Implement the dual-channel bitmask decoder, render solid terrain vs. dappled semi-transparent tree canopy shadows in WebGL/Canvas, and provide intuitive tree canopy controls in the Studio configuration dock.

---

## Granular Standalone Commits

### Commit 4.1: `feat(ui): update mask decoder to unpack dual-channel terrain and canopy shadow masks`
* **Purpose & Scope**:
  Update [`maskDecoder.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/utils/maskDecoder.js) to decode both terrain and canopy bitmasks into typed 32-bit pixel words for maximum rendering throughput.
* **Files Modified / Created**:
  - `frontend/src/utils/maskDecoder.js`
  - `frontend/tests/maskDecoder.test.js`
* **Key Implementation Details**:
  - Define color words:
    - `TERRAIN_SHADOW_WORD`: Solid terrain shadow (`rgba(15, 23, 42, 0.70)`) — `0xB22a170f`.
    - `CANOPY_SHADOW_WORD`: Dappled tree canopy shadow (`rgba(22, 60, 45, 0.45)`) — `0x732d3c16`.
    - `SUN_PIXEL_WORD`: Transparent unshaded (`0x00000000`).
  - Add function `decodeDualBitmasksToImageData(terrainB64, canopyB64, rows, cols, ctx)`:
    - If terrain is occluded (bit == 0) $\to$ write `TERRAIN_SHADOW_WORD`.
    - Else if canopy is occluded (bit == 0) $\to$ write `CANOPY_SHADOW_WORD`.
    - Else $\to$ write `SUN_PIXEL_WORD`.
* **Verification**:
  ```bash
  cd frontend && npm test
  ```

---

### Commit 4.2: `feat(ui): implement dappled semi-transparent canopy shadow rendering in ShadowRenderer`
* **Purpose & Scope**:
  Upgrade [`ShadowRenderer.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/components/ShadowRenderer.js) and [`ShadowCanvasLayer.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/components/ShadowCanvasLayer.js) to render multi-layer terrain and canopy shadows simultaneously.
* **Files Modified / Created**:
  - `frontend/src/components/ShadowRenderer.js`
  - `frontend/src/components/ShadowCanvasLayer.js`
  - `frontend/tests/ShadowRenderer.test.js`
* **Key Implementation Details**:
  - Update `renderFrame(terrainMask, canopyMask, rows, cols)` to draw the composite multi-layer ImageData.
  - Update `renderFullShade()` for nighttime: render deep nighttime shade strictly clipped to the active polygon geometry.
  - Maintain WebGL repaint synchronization with MapLibre canvas source.
* **Verification**:
  ```bash
  cd frontend && npm test
  ```

---

### Commit 4.3: `feat(ui): add Tree Canopy Shading toggle and foliage controls to Studio dock`
* **Purpose & Scope**:
  Add dedicated Tree Canopy controls to the collapsible right-hand dock in [`PVConfigPanel.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/components/PVConfigPanel.js), update telemetry readouts in [`SolarDashboard.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/components/SolarDashboard.js), and wire requests in [`main.js`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/frontend/src/main.js).
* **Files Modified / Created**:
  - `frontend/src/components/PVConfigPanel.js`
  - `frontend/src/components/SolarDashboard.js`
  - `frontend/src/main.js`
  - `frontend/src/styles.css`
* **Key Implementation Details**:
  - Add "🌲 Tree Canopy Shading" toggle switch:
    - Default: **Enabled** (per user confirmation).
  - Add foliage mode segmented control or dropdown:
    - `Auto (Seasonal)` [Default]
    - `Dense Summer (Leaf-On)`
    - `Bare Winter (Leaf-Off)`
    - `Bare Terrain Only`
  - Display instantaneous canopy shading percentage and direct transmittance in `SolarDashboard`.
  - Pass canopy parameters in simulation requests and update shadow layers seamlessly during timeline scrubbing.
* **Verification**:
  ```bash
  cd frontend && npm test && npm run build
  ```

---

## Phase 4 Acceptance Criteria
- [ ] Solid terrain shadows render in dark navy (`rgba(15, 23, 42, 0.70)`).
- [ ] Tree canopy shadows render in dappled semi-transparent tone (`rgba(22, 60, 45, 0.45)`).
- [ ] Tree canopy toggle and foliage selector operate cleanly in the right-hand studio card.
- [ ] All 20+ frontend test suites pass and production build generates without warnings.
