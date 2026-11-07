# LuxTerra - Quebec Solar Potential & Terrain Shadow Simulator
## Project Plan & Technical Specification

---

### 1. Executive Summary & Objective

**LuxTerra** is a web-based solar potential and terrain-occlusion modeling application tailored for Quebec. The application allows a user to explore an interactive map, search for any address or city in Quebec, select a plot of land up to **100,000 m²** (10 hectares), and simulate how geological terrain features cast shadows across the plot throughout any selected day of the year.

The system computes:
1. **Dynamic High-Resolution Shadow Masks (1m grid resolution)** across the selected patch over a 24-hour cycle.
2. **Instantaneous Usable PV Electric Power (kW)** and **Cumulative Daily Energy (kWh)**, accounting for direct beam shading, diffuse sky radiation, optimal seasonal panel tilt, and system derating.
3. **Interactive Playback & Scrubbing** at $5\text{ min/s}$ and $15\text{ min/s}$ animation speeds via GPU-accelerated precalculation.

The entire stack is built using **100% Free and Open Source Software (FOSS)** and free public APIs/data sources (NRCan / Données Québec).

---

### 2. Core Specifications & Technical Parameters

| Parameter | Specification | Notes |
| :--- | :--- | :--- |
| **Max Selection Area** | $100,000\text{ m}^2$ (~$316\text{ m} \times 316\text{ m}$) | Enforced on UI; extensible to irregular polygons |
| **Grid Resolution** | $1.0\text{ meter}$ per cell | $\le 100,000$ points per frame |
| **Shadow Search Radius** | $500\text{ meters}$ outward from patch perimeter | Buffer box width = $\text{Patch Width} + 1000\text{ m}$ |
| **Elevation Model (DTM)** | Bare-earth High-Resolution Digital Elevation Model (HRDEM) | 1m/2m resolution LiDAR derived from NRCan / Données Québec |
| **Solar Model** | `pvlib` clear-sky Ineichen radiation model | Direct Normal Irradiance (DNI) + Diffuse Horizontal Irradiance (DHI) |
| **Panel Orientation & Tilt** | South-facing ($180^\circ$ azimuth), optimal instantaneous tilt | Tilt matches solar zenith angle at median patch elevation |
| **Sky View Factor** | Unobstructed Sky View Factor ($SVF = 1.0$) | Shaded pixels still collect ambient diffuse skylight |
| **PV Electrical Model** | Usable AC Power output ($\text{kW}$) | Default $20\%$ module efficiency, $80\%$ system performance ratio |
| **Deployment Mode Toggle** | **Rooftop** ($100\%$ GCR) vs. **Ground-Mount** ($45\%$ GCR) | Tweakable via frontend settings panel |
| **Simulation Granularity** | $5\text{-minute}$ timesteps (sunrise to sunset) | Precalculated in one batch for fluid client-side playback |
| **Playback Rates** | $5\text{ min/s}$ and $15\text{ min/s}$ | Real-time scrubber (60 FPS on HTML5 Canvas) |
| **Hardware Target** | NVIDIA GeForce RTX 4070 Ti (CUDA 13 / CuPy) | Sub-second batch computation with CPU fallback |

---

### 3. Test Locations (Initial Verification)

1. **Montréal (Urban / Hill Flank)**
   * **Address:** 2201 boul. Édouard-Montpetit, Montréal, QC
   * **Coordinates:** $\sim 45.503^\circ\text{ N}, -73.618^\circ\text{ W}$
   * **Terrain:** Flank of Mount Royal, providing immediate geological elevation gradients.
2. **Sainte-Lucie-des-Laurentides (Mountainous)**
   * **Address:** 2120 chemin du Golf, Sainte-Lucie-des-Laurentides, QC
   * **Coordinates:** $\sim 46.136^\circ\text{ N}, -74.195^\circ\text{ W}$
   * **Terrain:** Complex Laurentian ridge-and-valley topography casting significant morning/afternoon terrain shadows.

---

### 4. System Architecture & Dependency Injection

The application adheres strictly to modular separation of concerns. All mathematical constants, solar coefficients, raster sources, and hardware acceleration backends are injected via interfaces to enable future extension (e.g., adding DSM canopies, irregular polygon clipping, or cloud API backends).

```
LuxTerra Architecture
├── backend/
│   ├── app/
│   │   ├── main.py                  # FastAPI entry point & CORS configuration
│   │   ├── config.py                # Injected defaults (PV efficiency, buffer radius, GCR)
│   │   ├── interfaces/              # Abstract Base Classes (ABCs)
│   │   │   ├── elevation_source.py  # ElevationProvider ABC
│   │   │   ├── solar_engine.py      # SolarModel ABC
│   │   │   ├── pv_model.py          # PVSystemModel ABC
│   │   │   └── occlusion_engine.py  # OcclusionEngine ABC
│   │   ├── services/
│   │   │   ├── elevation/
│   │   │   │   ├── local_geotiff.py # Windowed GeoTIFF reader via rasterio
│   │   │   │   └── nrcan_fetcher.py # Automated NRCan HRDEM / STAC / WCS downloader
│   │   │   ├── solar/
│   │   │   │   └── pvlib_engine.py  # Sun position (azimuth, elevation) & Ineichen clear-sky
│   │   │   ├── pv/
│   │   │   │   └── standard_pv.py   # Usable kW calculation (Rooftop vs Ground-mount)
│   │   │   └── occlusion/
│   │   │       ├── cupy_raymarch.py # GPU ray-marching kernel for RTX 4070 Ti
│   │   │       └── numpy_raymarch.py# Vectorized CPU fallback
│   │   └── routers/
│   │       ├── simulate.py          # POST /api/simulate (Full-day batch timeseries)
│   │       └── elevation.py         # GET /api/elevation/status
│   └── requirements.txt
│
├── frontend/
│   ├── src/
│   │   ├── main.js                  # Vite application root
│   │   ├── components/
│   │   │   ├── MapViewer.js         # MapLibre GL JS + Satellite / OSM base switcher
│   │   │   ├── Geocoder.js          # Free Nominatim address/city search
│   │   │   ├── BoxDrawer.js         # Area selector clamped to <= 100,000 m2
│   │   │   ├── ShadowCanvasLayer.js # Canvas overlay rendering GPU shadow mask
│   │   │   ├── TimeScrubber.js      # Timeline slider + 5min/s & 15min/s play controls
│   │   │   └── PVConfigPanel.js     # Rooftop vs Ground toggle & efficiency sliders
│   │   └── services/
│   │       └── api.js               # Client API calls to FastAPI backend
│   ├── index.html
│   └── package.json
└── scripts/
    └── fetch_test_dtm.py            # Automated CLI tool to download test LiDAR GeoTIFFs
```

---

### 5. Solar & Occlusion Mathematics

#### 5.1 Solar Angles & Irradiance
For any coordinate $(\text{lat}, \text{lon})$ and timestamp $t$:
* Solar elevation angle $\alpha$ and azimuth angle $\gamma$ are computed using `pvlib.solarposition.get_solarposition()`.
* Direct Normal Irradiance ($\text{DNI}$) and Diffuse Horizontal Irradiance ($\text{DHI}$) are computed using `pvlib.clearsky.ineichen()`.
* Panel tilt $\beta$ is set to optimal solar zenith ($90^\circ - \alpha$) facing due south ($\gamma_{\text{panel}} = 180^\circ$).

#### 5.2 Ray-Marching Terrain Occlusion
For each cell $(x_0, y_0)$ in the patch at elevation $Z_0$:
* Step outward in increments of $\Delta s = 1\text{ m}$ along the solar vector $(\Delta x = \sin\gamma, \Delta y = \cos\gamma)$ up to $d_{\max} = 500\text{ m}$.
* Ray elevation at distance $d$:
  $$Z_{\text{ray}}(d) = Z_0 + d \cdot \tan(\alpha)$$
* Shading test:
  $$\text{Mask}(x_0, y_0) = \begin{cases} 0 & \text{if } \exists d \le 500\text{ m s.t. } Z_{\text{terrain}}(x_d, y_d) > Z_{\text{ray}}(d) \\ 1 & \text{otherwise (unshaded)} \end{cases}$$

#### 5.3 Usable Electrical Power Output
$$\text{Irradiance}_{\text{cell}} = \left(\text{DNI} \cdot \cos(\theta_{\text{incident}}) \cdot \text{Mask}_{\text{cell}}\right) + \left(\text{DHI} \cdot SVF_{\text{tilt}}\right)$$
$$\text{Power}_{\text{total}} (\text{kW}) = \frac{\sum_{\text{cells}} \text{Irradiance}_{\text{cell}} \cdot A_{\text{cell}} \cdot \text{GCR} \cdot \eta_{\text{module}} \cdot PR}{1000}$$
Where:
* $A_{\text{cell}} = 1.0\text{ m}^2$
* $\text{GCR} = 1.0$ (Rooftop mode) or $0.45$ (Ground-mount mode)
* $\eta_{\text{module}} = 0.20$ ($20\%$ module efficiency)
* $PR = 0.80$ ($80\%$ system performance ratio)

---

### 6. Step-by-Step Implementation Roadmap

#### Phase 1: Environment Setup & Data Pipeline
- [ ] Initialize Python virtual environment with FastAPI, `rasterio`, `pvlib`, and `cupy-cuda12x`.
- [ ] Initialize Vite frontend with MapLibre GL JS and Tailwind/CSS.
- [ ] Create `scripts/fetch_test_dtm.py` to automatically fetch high-resolution 1m/2m LiDAR DTM GeoTIFFs from NRCan's CanElevation HRDEM product for both Montréal and Sainte-Lucie-des-Laurentides.

#### Phase 2: Compute Engine & Ray-Marcher
- [ ] Implement `OcclusionEngine` using CuPy to execute parallel ray-marching across the 500m buffer on the RTX 4070 Ti.
- [ ] Implement CPU fallback via NumPy vectorization.
- [ ] Implement `PVSystemModel` and `SolarEngine` with configurable parameters (GCR, efficiency, PR).
- [ ] Verify GPU shadow masks against verified solar azimuth/elevation angles.

#### Phase 3: Backend API Service
- [ ] Implement `POST /api/simulate`: Accepts bounding box coordinates, date, and configuration overrides.
- [ ] Generates the 5-minute precomputed timeseries for daylight hours.
- [ ] Packages binary shadow masks and power metrics into a compact response payload.

#### Phase 4: Frontend UI & Interactive Map
- [ ] Set up MapLibre GL JS with street (OSM) and satellite (ESRI World Imagery) tile layers.
- [ ] Integrate Nominatim geocoding address search.
- [ ] Implement bounding box drawer clamped to $\le 100,000\text{ m}^2$.
- [ ] Build canvas overlay layer for live shadow rendering.
- [ ] Implement timeline scrubber with $5\text{ min/s}$ and $15\text{ min/s}$ playback controls.
- [ ] Build stats panel showing instantaneous power ($\text{kW}$) and daily cumulative energy ($\text{kWh}$).
