# LuxTerra

**LuxTerra** is a high-performance web-based solar potential and geological terrain-shadow simulator for Quebec. It models how bare-earth topography casts moving shadows across plots of land (up to 100,000 m²) throughout any day of the year at 1-meter spatial resolution.

## Key Features
- **Terrain Occlusion Engine:** GPU-accelerated ray-marching via CuPy targeting local NVIDIA GPUs (RTX 4070 Ti) with vectorized NumPy CPU fallback.
- **Solar & PV Modeling:** Clear-sky radiation using `pvlib.clearsky.ineichen`, unobstructed sky view factor, optimal seasonal tilt, and configurable **Rooftop ($100\%$ GCR)** vs. **Ground-Mount ($45\%$ GCR)** deployment modes.
- **High-Resolution Elevation:** Powered by NRCan / Données Québec 1m/2m LiDAR High Resolution Digital Elevation Models (HRDEM).
- **Interactive UI:** MapLibre GL JS map with OSM street and ESRI satellite layers, Nominatim geocoder, box drawing tool ($\le 100,000\text{ m}^2$), 24-hour timeline scrubber, and $5\text{ min/s}$ and $15\text{ min/s}$ playback modes.

## Monorepo Layout
- `backend/` - FastAPI REST API and compute engine.
- `frontend/` - Vite single-page application with MapLibre GL JS.
- `scripts/` - Data acquisition and processing tools.
- `data/dtm/` - Local storage and manifest index for Quebec LiDAR GeoTIFF tiles.
