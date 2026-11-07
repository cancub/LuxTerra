# LuxTerra - Phase 1: Environment Setup & DTM Data Pipeline
## Granular Implementation Plan & Incremental Commits

---

### Objective
Scaffold the LuxTerra workspace, configure the Python environment with GPU (CUDA/CuPy) and GIS (`rasterio`, `pvlib`, `pyproj`) capabilities, initialize the frontend structure, and build an automated acquisition and windowed extraction pipeline for Quebec 1m/2m LiDAR DTMs (specifically for 2201 boul. Édouard-Montpetit and 2120 chemin du Golf).

---

### Incremental Commit Sequence

#### Commit 1.1: `chore: scaffold monorepo directory structure and base configs`
* **Files:**
  * `.gitignore`
  * `README.md`
  * `backend/` (directory)
  * `frontend/` (directory)
  * `scripts/` (directory)
  * `data/dtm/` (directory with `.gitkeep`)
* **Description:**
  * Establishes clean repository organization separating backend API, frontend SPA, shared elevation data storage, and CLI acquisition scripts.
  * Adds standard `.gitignore` rules (Python venv, `__pycache__`, Node modules, raw `.tif` rasters, build artifacts).
* **Acceptance / Verification:**
  * Directory layout matches specification; `git status` shows clean tracking without ignoring required configuration files.

---

#### Commit 1.2: `chore(backend): configure python dependencies and requirements lock`
* **Files:**
  * `backend/requirements.txt`
* **Description:**
  * Declares strict production and development dependencies: `fastapi`, `uvicorn[standard]`, `rasterio`, `pvlib`, `cupy-cuda12x`, `numpy`, `scipy`, `pyproj`, `shapely`, `pydantic`, `pytest`, `pytest-asyncio`, `httpx`.
* **Acceptance / Verification:**
  * Virtualenv successfully installs all dependencies (`pip install -r backend/requirements.txt`) without dependency conflicts.

---

#### Commit 1.3: `chore(backend): implement environment and hardware verification script`
* **Files:**
  * `backend/verify_env.py`
* **Description:**
  * Provides an automated diagnostic script that checks:
    1. NVIDIA GPU availability and CuPy CUDA compute capabilities (confirming RTX 4070 Ti).
    2. GDAL / `rasterio` GeoTIFF read and write drivers.
    3. `pvlib` solar calculation and clear-sky model availability.
* **Acceptance / Verification:**
  * Running `python backend/verify_env.py` exits with code 0 and logs device name, driver version, and driver operational status.

---

#### Commit 1.4: `feat(elevation): implement NRCan HRDEM STAC discovery client`
* **Files:**
  * `backend/app/services/elevation/nrcan_client.py`
* **Description:**
  * Implements query client for the Government of Canada's High Resolution Digital Elevation Model (HRDEM / CanElevation) STAC API and Données Québec catalogs.
  * Given a WGS84 bounding box or coordinate in Quebec, discovers intersecting 1m/2m bare-earth DTM GeoTIFF URLs and spatial footprint polygons.
* **Acceptance / Verification:**
  * Running the client with Montreal coordinates ($45.503^\circ\text{ N}, -73.618^\circ\text{ W}$) resolves the exact downloadable HRDEM tile URL(s).

---

#### Commit 1.5: `feat(elevation): implement resilient DTM tile downloader and cache manager`
* **Files:**
  * `backend/app/services/elevation/tile_cache.py`
* **Description:**
  * Implements downloading and local caching of remote GeoTIFFs into `data/dtm/`:
    * Streaming chunked download with progress indicator.
    * Checksum and raster header validation to ensure downloaded `.tif` is uncorrupted.
    * Cache index checking to skip re-downloading existing tiles.
* **Acceptance / Verification:**
  * Downloading a test tile successfully saves to `data/dtm/` and validates raster metadata (dimensions, CRS, nodata values).

---

#### Commit 1.6: `feat(elevation): automate acquisition and manifest indexing for Montreal and Sainte-Lucie test sites`
* **Files:**
  * `scripts/fetch_test_dtm.py`
  * `data/dtm/manifest.json`
* **Description:**
  * Provides a standalone CLI script to automatically fetch and verify LiDAR DTM rasters for the two initial test locations:
    * **Montreal (Mount Royal flank):** 2201 boul. Édouard-Montpetit ($45.503^\circ\text{ N}, -73.618^\circ\text{ W}$).
    * **Sainte-Lucie-des-Laurentides:** 2120 chemin du Golf ($46.136^\circ\text{ N}, -74.195^\circ\text{ W}$).
  * Generates `data/dtm/manifest.json` indexing local raster paths, bounding boxes, coordinate systems, and ground resolutions.
* **Acceptance / Verification:**
  * Running `python scripts/fetch_test_dtm.py --all` downloads both datasets and generates a complete `manifest.json`.

---

#### Commit 1.7: `feat(elevation): implement spatial reprojection and geodesic 500m buffer utility`
* **Files:**
  * `backend/app/services/elevation/geo_utils.py`
* **Description:**
  * Implements geographic coordinate math using `pyproj` and `shapely`:
    * Transforms user WGS84 (EPSG:4326) bounding boxes into the raster's native projected planar metric CRS (e.g. NAD83 / MTM or UTM).
    * Calculates the perimeter buffer: extends the box outward by exactly $500\text{ meters}$ in all directions.
    * Returns both the buffered metric bounding box and the target patch metric bounding box.
* **Acceptance / Verification:**
  * Unit test verifies that a $200\text{ m} \times 200\text{ m}$ box buffered by $500\text{ m}$ results in a planar bounding box measuring exactly $1200\text{ m} \times 1200\text{ m}$.

---

#### Commit 1.8: `feat(elevation): implement windowed GeoTIFF reader and elevation grid extractor`
* **Files:**
  * `backend/app/interfaces/elevation_source.py`
  * `backend/app/services/elevation/local_geotiff.py`
* **Description:**
  * Implements `LocalGeoTIFFProvider` adhering to `ElevationProvider` ABC.
  * Uses `rasterio.windows.from_bounds` to read only the buffered window directly from disk into a 2D NumPy array.
  * Detects and bilinearly interpolates any nodata pixels; extracts affine transform and cell resolution (1m).
* **Acceptance / Verification:**
  * Reading a window centered on 2201 Édouard-Montpetit loads the elevation matrix and produces realistic elevation values ($\sim 100\text{--}200\text{ m}$ above sea level).

---

#### Commit 1.9: `test(elevation): add comprehensive unit and integration tests for DTM pipeline`
* **Files:**
  * `backend/tests/test_elevation.py`
* **Description:**
  * Unit tests for:
    * Reprojection accuracy between WGS84 and local planar CRS.
    * Strict 500m outward buffer geometry math.
    * Rasterio windowed extraction boundaries and nodata handling.
* **Acceptance / Verification:**
  * `pytest backend/tests/test_elevation.py` passes all test cases.
