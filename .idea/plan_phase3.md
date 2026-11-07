# LuxTerra - Phase 3: Backend API Service
## Granular Implementation Plan & Incremental Commits

---

### Objective
Build the FastAPI REST API service that accepts simulation requests (bounding box, date, parameter overrides), coordinates full-day 5-minute batch precomputations, serializes compressed shadow masks for rapid network transmission, and serves preloaded test location datasets.

---

### Incremental Commit Sequence

#### Commit 3.1: `feat(api): scaffold FastAPI application with CORS and configuration injection`
* **Files:**
  * `backend/app/main.py`
  * `backend/app/config.py`
  * `backend/app/dependencies.py`
* **Description:**
  * Creates FastAPI application instance with CORS middleware configured for Vite frontend (`localhost:5173`).
  * Establishes dependency injection wiring using FastAPI's `Depends()`:
    * `get_config()`: Injects application constants and defaults.
    * `get_elevation_provider()`: Resolves `LocalGeoTIFFProvider`.
    * `get_solar_engine()`: Resolves `PvlibSolarEngine`.
    * `get_occlusion_engine()`: Resolves `CuPyOcclusionEngine` (or falls back to `NumPyOcclusionEngine`).
    * `get_pv_model()`: Resolves `StandardPVModel`.
  * Adds health check endpoint `GET /api/health` returning system and GPU availability status.
* **Acceptance / Verification:**
  * `uvicorn backend.app.main:app --port 8000` boots cleanly and `curl http://localhost:8000/api/health` returns operational GPU status.

---

#### Commit 3.2: `feat(api): define simulation request and response Pydantic schemas`
* **Files:**
  * `backend/app/schemas/simulate.py`
  * `backend/app/schemas/elevation.py`
* **Description:**
  * Defines Pydantic validation schemas:
    * `BoundingBox`: Latitude/longitude corners with validation ensuring area $\le 100,000\text{ m}^2$.
    * `SimulateRequest`:
      * `bbox`: Bounding box coordinates.
      * `date`: ISO date string (e.g. `2026-06-21`).
      * `time_step_minutes`: Integer (default: 5).
      * `deployment_mode`: Enum `rooftop` or `ground_mount`.
      * `module_efficiency`: Optional float override.
      * `system_derate`: Optional float override.
      * `gcr`: Optional float override.
    * `SimulateResponse`: Metadata, daily energy summary ($\text{kWh}$), and timeseries records.
* **Acceptance / Verification:**
  * Schemas reject invalid inputs (e.g., negative efficiencies, inverted bounding boxes, areas exceeding $100,000\text{ m}^2$) with clear HTTP 422 error messages.

---

#### Commit 3.3: `feat(api): implement compact binary mask serializer for high-speed network transfer`
* **Files:**
  * `backend/app/services/serializer.py`
* **Description:**
  * Implements an efficient mask encoder:
    * Packs 2D binary uint8 shadow masks into bit-packed buffers or compressed PNGs to minimize payload size.
    * A $316 \times 316$ patch (100k pixels) bit-packed is only $\approx 12.5\text{ KB}$ per frame ($\approx 1.7\text{ MB}$ for an entire day of 140 frames).
    * Provides fast client-side decoding instructions.
* **Acceptance / Verification:**
  * Serializer compresses 140 frames of $316 \times 316$ masks to under $2\text{ MB}$ in $< 50\text{ ms}$.

---

#### Commit 3.4: `feat(api): build timeseries simulation orchestrator service`
* **Files:**
  * `backend/app/services/simulator.py`
* **Description:**
  * Implements `SimulationOrchestrator`:
    1. Generates 5-minute timestep intervals for the requested date.
    2. Calculates solar angles with `SolarEngine`; filters down to daylight timesteps (solar elevation $\alpha > 0^\circ$).
    3. Batches occlusion calculations through `OcclusionEngine` to generate all daytime shadow masks.
    4. Computes instantaneous $\text{kW}$ output and percentage shaded for each timestep using `PVSystemModel`.
    5. Integrates power curve using trapezoidal rule to calculate total daily energy yield ($\text{kWh}$).
* **Acceptance / Verification:**
  * Orchestrator produces a full day's timeseries and power yield for a sample patch in $< 400\text{ ms}$.

---

#### Commit 3.5: `feat(api): implement POST /api/simulate batch endpoint with error handling`
* **Files:**
  * `backend/app/routers/simulate.py`
* **Description:**
  * Implements `POST /api/simulate`:
    * Injects `ElevationProvider` to retrieve the elevation window.
    * Invokes `SimulationOrchestrator` to generate timeseries and masks.
    * Serializes masks and metrics into `SimulateResponse`.
    * Implements error handling for out-of-bounds coordinates, missing raster coverage, and excessive areas.
* **Acceptance / Verification:**
  * `curl -X POST http://localhost:8000/api/simulate -H "Content-Type: application/json" -d '{...}'` returns HTTP 200 with complete timeseries data.

---

#### Commit 3.6: `feat(api): implement GET /api/elevation/locations metadata endpoint`
* **Files:**
  * `backend/app/routers/elevation.py`
* **Description:**
  * Implements `GET /api/elevation/locations`:
    * Returns metadata for the preloaded test locations:
      * **Montreal:** 2201 boul. Édouard-Montpetit (bounding box, bounds, description).
      * **Sainte-Lucie-des-Laurentides:** 2120 chemin du Golf (bounding box, bounds, description).
    * Indicates whether local LiDAR GeoTIFFs are present on disk or require download.
* **Acceptance / Verification:**
  * Endpoint returns valid JSON listing both locations with their coordinates and status.

---

#### Commit 3.7: `test(api): implement unit and validation tests for API schemas and serializer`
* **Files:**
  * `backend/tests/test_schemas.py`
  * `backend/tests/test_serializer.py`
* **Description:**
  * Unit tests verifying:
    * Request validation clamping area to $\le 100,000\text{ m}^2$.
    * Bit-packing and unpacking roundtrip equality.
* **Acceptance / Verification:**
  * `pytest backend/tests/test_schemas.py backend/tests/test_serializer.py` passes all tests.

---

#### Commit 3.8: `test(api): write full integration tests for simulation timeseries and parameter overrides`
* **Files:**
  * `backend/tests/test_api_simulate.py`
* **Description:**
  * End-to-end API integration tests using `httpx.AsyncClient`:
    * Verifies successful simulation on Édouard-Montpetit test site.
    * Verifies that switching `deployment_mode` between `rooftop` and `ground_mount` scales power values appropriately.
    * Confirms that requests with bounding box $> 100,000\text{ m}^2$ return HTTP 422.
* **Acceptance / Verification:**
  * `pytest backend/tests/test_api_simulate.py` passes with 0 failures.
