# Phase 1: Ingestion & Elevation Data Pipeline (DTM + DSM Dual-Layer)

> **Phase Objective**: Expand LuxTerra's elevation ingestion and caching system from bare-earth DTM to co-registered dual-layer **DTM (bare ground)** + **DSM (surface with canopy and structures)**, deriving the **Canopy Height Model (CHM)** for any bounding box in Quebec.

---

## Granular Standalone Commits

### Commit 1.1: `feat(elevation): add DSM asset discovery and download to NRCanClient`
* **Purpose & Scope**:
  Extend [`nrcan_client.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/elevation/nrcan_client.py) to query and download both `dtm` and `dsm` Cloud-Optimized GeoTIFFs (COGs) from the CanElevation STAC API (`https://datacube.services.geo.ca/stac/api/collections/hrdem-lidar/items`).
* **Files Modified / Created**:
  - `backend/app/services/elevation/nrcan_client.py`
  - `backend/tests/test_nrcan_client.py`
* **Key Implementation Details**:
  - In `query_tiles_by_bbox()`, extract both `assets.get("dtm")` and `assets.get("dsm")` URLs.
  - Add method `download_dsm_tile(dsm_url: str, output_path: Path) -> Path` with chunked streaming and retry logic parallel to `download_dtm_tile`.
  - Add helper `download_tile_pair(item: Dict, target_dir: Path) -> Tuple[Path, Path]` to download both layers atomically.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_nrcan_client.py -v
  ```

---

### Commit 1.2: `feat(elevation): extend TileCache for paired DTM and DSM dual-layer storage`
* **Purpose & Scope**:
  Upgrade [`tile_cache.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/elevation/tile_cache.py) to manage a `data/dsm/` directory alongside `data/dtm/`, updating `manifest.json` to index paired tile metadata.
* **Files Modified / Created**:
  - `backend/app/services/elevation/tile_cache.py`
  - `backend/tests/test_tile_cache.py`
* **Key Implementation Details**:
  - Initialize `dsm_dir = data_dir / "dsm"` and ensure directory creation.
  - Update tile metadata structure in `manifest.json`:
    ```json
    {
      "id": "QC-600023_52_CMM_2023-1m",
      "dtm_filename": "dtm_montreal_edouard_montpetit.tif",
      "dsm_filename": "dsm_montreal_edouard_montpetit.tif",
      "has_dsm": true,
      "bounds_wgs84": [-73.644, 45.484, -73.591, 45.521],
      "crs": "EPSG:3979"
    }
    ```
  - Implement `get_tile_pair(bbox: GeoBoundingBox) -> Optional[Tuple[Path, Path]]` which verifies both DTM and DSM exist locally.
  - Implement graceful degradation: if DSM is absent and cannot be acquired, return `(dtm_path, None)` with logging.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_tile_cache.py -v
  ```

---

### Commit 1.3: `feat(elevation): update LocalGeoTIFFService to extract co-registered dual-raster windows`
* **Purpose & Scope**:
  Update [`local_geotiff.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/elevation/local_geotiff.py) to cut and resample matching dual-raster windows (`dtm_grid`, `dsm_grid`) for the buffered simulation region and compute the Canopy Height Model (`chm_grid = np.maximum(0.0, dsm_grid - dtm_grid)`).
* **Files Modified / Created**:
  - `backend/app/services/elevation/local_geotiff.py`
  - `backend/tests/test_elevation.py`
* **Key Implementation Details**:
  - Update `extract_elevation_patch()` signature to accept optional `dsm_path: Optional[Path] = None`.
  - Open both rasters using `rasterio`, verify identical spatial bounds and resolution, and extract windowed arrays:
    ```python
    dtm_window = src_dtm.read(1, window=window)
    dsm_window = src_dsm.read(1, window=window) if src_dsm else dtm_window.copy()
    chm_window = np.maximum(0.0, dsm_window - dtm_window)
    ```
  - Return updated dictionary containing `dtm_array`, `dsm_array`, `chm_array`, `has_canopy: bool`, and metadata.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_elevation.py -v
  ```

---

## Phase 1 Acceptance Criteria
- [ ] STAC client can discover and download both DTM and DSM GeoTIFFs from AWS S3.
- [ ] Tile cache indexes both DTM and DSM layers with complete spatial manifest tracking.
- [ ] Elevation extraction service returns aligned `dtm` and `dsm` grids with non-negative CHM values.
- [ ] All 45 existing unit tests + new Phase 1 tests pass without regressions.
