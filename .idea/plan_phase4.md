# LuxTerra - Phase 4: Frontend UI & Interactive Map
## Granular Implementation Plan & Incremental Commits

---

### Objective
Develop a modern, highly responsive browser application using Vite and MapLibre GL JS that provides:
1. Interactive map navigation with OSM street view and ESRI World Imagery satellite tiles.
2. Quebec address/city search via Nominatim.
3. Bounding box drawing tool clamped to $\le 100,000\text{ m}^2$ with live dimension readouts.
4. High-performance HTML5 Canvas shadow overlay rendering the GPU-computed shadow masks over the map.
5. Interactive 24-hour timeline scrubber with $5\text{ min/s}$ and $15\text{ min/s}$ animation playback presets.
6. Real-time solar power dashboard with **Rooftop ($100\%$ GCR)** vs. **Ground-Mount ($45\%$ GCR)** toggle, instantaneous $\text{kW}$ gauge, and daily $\text{kWh}$ curve.

---

### Incremental Commit Sequence

#### Commit 4.1: `chore(frontend): initialize Vite SPA project with MapLibre GL JS and base styling`
* **Files:**
  * `frontend/package.json`
  * `frontend/vite.config.js`
  * `frontend/index.html`
  * `frontend/src/styles.css`
  * `frontend/src/main.js`
* **Description:**
  * Scaffolds Vite client using modern ES modules for maximum rendering performance.
  * Installs `maplibre-gl`.
  * Configures dev proxy to redirect `/api/*` requests to the FastAPI backend (`http://localhost:8000`).
* **Acceptance / Verification:**
  * `npm run dev` starts Vite server on `localhost:5173` without build or dependency errors.

---

#### Commit 4.2: `feat(map): mount MapLibre viewer with OSM street and ESRI satellite layer switcher`
* **Files:**
  * `frontend/src/components/MapViewer.js`
  * `frontend/src/components/LayerToggle.js`
* **Description:**
  * Mounts MapLibre GL map centered on Quebec ($46.8^\circ\text{ N}, -71.2^\circ\text{ W}$, zoom 6).
  * Adds raster base layer switcher:
    * **Street View:** OpenStreetMap standard tiles (`tile.openstreetmap.org`).
    * **Satellite View:** ESRI World Imagery tiles (`server.arcgisonline.com`).
* **Acceptance / Verification:**
  * User can switch base layers seamlessly with a single click in the UI.

---

#### Commit 4.3: `feat(map): add quick-navigation bookmarks for Montreal and Sainte-Lucie test locations`
* **Files:**
  * `frontend/src/components/Bookmarks.js`
* **Description:**
  * Adds preset bookmark buttons:
    * **Montréal:** 2201 boul. Édouard-Montpetit (zoom 16).
    * **Sainte-Lucie-des-Laurentides:** 2120 chemin du Golf (zoom 15).
  * Smooth camera fly-to animation with pitch adjustment for 3D terrain perspective.
* **Acceptance / Verification:**
  * Clicking either preset smoothly animates the camera to the target coordinates.

---

#### Commit 4.4: `feat(geocoder): integrate Nominatim address search bounded to Quebec`
* **Files:**
  * `frontend/src/components/Geocoder.js`
* **Description:**
  * Adds an address search bar in the top-left map overlay.
  * Queries OpenStreetMap's Nominatim API with geographic boundaries restricted to Quebec (`countrycodes=ca`, `viewbox=-79.76,44.99,-57.10,62.58`).
  * Displays an autocomplete dropdown; selecting a result flies the camera to the coordinate with a temporary marker.
* **Acceptance / Verification:**
  * Searching for "2201 Edouard-Montpetit" or "Sainte-Lucie-des-Laurentides" suggests matching locations and centers the map upon selection.

---

#### Commit 4.5: `feat(draw): implement geodesic area calculation and 100,000 m² clamping utilities`
* **Files:**
  * `frontend/src/utils/geometry.js`
* **Description:**
  * Implements geodesic geometric utilities:
    * Calculates geodesic surface area ($m^2$), width (m), and height (m) between coordinates.
    * Clamps box coordinates so that area never exceeds $100,000\text{ m}^2$ (preserving aspect ratio during drag).
* **Acceptance / Verification:**
  * Unit tests verify area calculations against standard spherical Earth polygons.

---

#### Commit 4.6: `feat(draw): build interactive box drawing tool with real-time dimension readout`
* **Files:**
  * `frontend/src/components/BoxDrawer.js`
* **Description:**
  * Interactive rectangle drawer built on MapLibre mouse events:
    * Click "Draw Solar Area" to initiate drawing mode.
    * Real-time tooltip overlay showing width, height, and area ($m^2$).
    * Visual boundary highlighting (amber/red indicator if approaching/reaching the $100,000\text{ m}^2$ maximum).
    * Emits `selectionComplete` event with bounding box coordinates upon mouse release.
* **Acceptance / Verification:**
  * User can draw an arbitrary rectangle on the map; selection clamps to $\le 100,000\text{ m}^2$ with live readout.

---

#### Commit 4.7: `feat(canvas): create binary mask decoder and offscreen canvas renderer`
* **Files:**
  * `frontend/src/utils/maskDecoder.js`
  * `frontend/src/components/ShadowRenderer.js`
* **Description:**
  * Implements high-speed client-side decoding:
    * Unpacks backend bitmask / compressed image buffers into typed array pixel masks.
    * Draws shadow pixels to an offscreen canvas with semi-transparent tint (`rgba(15, 23, 42, 0.55)`).
    * Direct sunlight pixels remain 100% transparent.
* **Acceptance / Verification:**
  * Decoding and rendering a $316 \times 316$ mask takes $< 2\text{ ms}$ on the CPU/Canvas.

---

#### Commit 4.8: `feat(canvas): integrate MapLibre custom canvas layer with synchronized spatial projection`
* **Files:**
  * `frontend/src/components/ShadowCanvasLayer.js`
* **Description:**
  * Integrates the offscreen shadow canvas as a MapLibre custom layer:
    * Projects the canvas texture precisely onto the geographic bounding box of the drawn patch.
    * Automatically repositions, scales, and reprojects on map pan, zoom, pitch, and bearing changes without drift or jitter.
* **Acceptance / Verification:**
  * Shadow mask stays locked to the ground coordinates during map movement and rotation.

---

#### Commit 4.9: `feat(timeline): build 24-hour timeline scrubber and date selector`
* **Files:**
  * `frontend/src/components/TimeScrubber.js`
  * `frontend/src/components/DateSelector.js`
* **Description:**
  * Adds bottom timeline control bar:
    * Date picker allowing simulation of any day of the year (defaults to summer solstice or current date).
    * 24-hour horizontal scrubber slider (00:00 to 23:59).
    * Current timestamp readout with sunrise and sunset markers.
    * Scrubbing immediately swaps the rendered shadow mask on the canvas layer.
* **Acceptance / Verification:**
  * Scrubbing the slider provides instant visual feedback with zero network latency.

---

#### Commit 4.10: `feat(timeline): implement requestAnimationFrame playback engine with 5 min/s and 15 min/s presets`
* **Files:**
  * `frontend/src/components/PlaybackEngine.js`
* **Description:**
  * Implements smooth client-side animation loop:
    * Play/Pause toggle.
    * Speed preset buttons:
      * **$5\text{ min/s}$:** 1 real second = 5 minutes of simulation time.
      * **$15\text{ min/s}$:** 1 real second = 15 minutes of simulation time.
    * Smooth interpolation using `requestAnimationFrame` ensuring 60 FPS playback.
* **Acceptance / Verification:**
  * Clicking Play at $15\text{ min/s}$ smoothly animates shadows across the daylight hours.

---

#### Commit 4.11: `feat(pv-panel): build PV configuration panel with Rooftop vs Ground toggle`
* **Files:**
  * `frontend/src/components/PVConfigPanel.js`
* **Description:**
  * Adds PV configuration panel:
    * Toggle between **Rooftop ($100\%$ GCR)** and **Ground-Mount ($45\%$ GCR)**.
    * Accordion for fine-tuning module efficiency ($15\%\text{--}24\%$) and system performance ratio ($70\%\text{--}90\%$).
    * Dispatches update events recalculating electrical output without requiring re-computation of shadow masks.
* **Acceptance / Verification:**
  * Toggling between Rooftop and Ground immediately scales power metrics by the GCR ratio.

---

#### Commit 4.12: `feat(pv-panel): build real-time solar metrics dashboard with interactive power curve`
* **Files:**
  * `frontend/src/components/SolarDashboard.js`
  * `frontend/src/components/SparklineChart.js`
* **Description:**
  * Adds real-time telemetry readout:
    * Instantaneous power gauge ($\text{kW}$).
    * Percentage of selected patch currently in shadow ($0\%\text{--}100\%$).
    * Total cumulative daily energy yield ($\text{kWh}$).
    * SVG daily power curve chart with a synchronized playhead indicator tracking the timeline scrubber.
* **Acceptance / Verification:**
  * Telemetry updates in sync with the timeline scrubber and playback animation.

---

#### Commit 4.13: `test(e2e): end-to-end integration and visual verification across complete workflow`
* **Files:**
  * `frontend/tests/e2e.test.js`
* **Description:**
  * Verifies the complete user journey:
    1. Search for Montreal or Sainte-Lucie address.
    2. Draw a box clamped to $\le 100,000\text{ m}^2$ on a hillside.
    3. Trigger batch simulation.
    4. Scrub timeline to observe morning vs noon vs evening shadow transitions.
    5. Play at $15\text{ min/s}$ speed and verify fluid 60 FPS animation.
    6. Switch Rooftop vs Ground mode and verify instantaneous telemetry update.
* **Acceptance / Verification:**
  * Full user workflow executes cleanly with no console errors or visual anomalies.
