# LuxTerra

**LuxTerra** is a high-performance web-based solar potential and geological terrain-shadow simulator for Quebec. It models how bare-earth topography casts moving shadows across plots of land (up to 100,000 m²) throughout any day of the year at 1-meter spatial resolution.

## Key Features
- **Terrain Occlusion Engine:** GPU-accelerated ray-marching via CuPy targeting local NVIDIA GPUs (RTX 4070 Ti) across a 500m outward perimeter buffer, with a vectorized NumPy CPU fallback.
- **Solar & PV Modeling:** Clear-sky radiation using `pvlib.clearsky.ineichen`, unobstructed sky view factor ($SVF = 1.0$), optimal seasonal tilt facing due south ($180^\circ$), and configurable **Rooftop ($100\%$ GCR)** vs. **Ground-Mount ($45\%$ GCR)** deployment modes.
- **High-Resolution Elevation:** Powered by NRCan / Données Québec 1m LiDAR High Resolution Digital Elevation Models (HRDEM) streamed via Cloud-Optimized GeoTIFFs (COGs).
- **Interactive UI:** MapLibre GL JS map with OSM street and ESRI satellite layers, Nominatim geocoder bounded to Quebec, box drawing tool clamped to $\le 100,000\text{ m}^2$, 24-hour timeline scrubber, and $5\text{ min/s}$ and $15\text{ min/s}$ playback modes.

## Monorepo Layout
- `backend/` — FastAPI REST API, solar geometry, PV modeling, and CuPy/NumPy ray-marching engines.
- `frontend/` — Vite single-page application with MapLibre GL JS, custom canvas shadow projection, and interactive solar telemetry dashboard.
- `scripts/` — Automated CLI tool (`fetch_test_dtm.py`) to acquire and index test LiDAR GeoTIFFs.
- `data/dtm/` — Local storage and `manifest.json` index for Quebec LiDAR GeoTIFF tiles.

## Quickstart

### 1. Acquire Test LiDAR DTM Rasters
Fetch the 1m resolution bare-earth LiDAR DTMs for the benchmark test sites (Montréal — Mount Royal flank & Sainte-Lucie-des-Laurentides):
```bash
.venv/bin/python scripts/fetch_test_dtm.py --preset all
```

### 2. Start the FastAPI Backend
```bash
.venv/bin/uvicorn backend.app.main:app --host 127.0.0.1 --port 8000 --reload
```
- Health & GPU Check: `http://127.0.0.1:8000/api/health`
- Interactive OpenAPI Docs: `http://127.0.0.1:8000/docs`

### 3. Start the Vite Frontend
```bash
cd frontend
npm run dev
```
Open `http://127.0.0.1:5173` in your browser.

## Testing & Verification

### Backend Unit & Integration Tests
```bash
.venv/bin/pytest -v
```

### Frontend Unit & End-to-End Tests
```bash
cd frontend
npm test
```
