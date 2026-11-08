# Phase 5: Verification, Benchmarking & Production Deployment

> **Phase Objective**: Pre-cache official Quebec LiDAR DSM GeoTIFFs for default presets (Montreal, Sainte-Lucie, Laval), run end-to-end simulation benchmarks across urban forest and rooftop environments, and deploy the containerized application to the Kubernetes cluster.

---

## Granular Standalone Commits

### Commit 5.1: `feat(elevation): pre-cache Montreal and Sainte-Lucie DSM GeoTIFFs`
* **Purpose & Scope**:
  Acquire and store the co-registered 1m DSM Cloud-Optimized GeoTIFFs from AWS S3 for the default presets into `data/dsm/`, and update `manifest.json`.
* **Files Modified / Created**:
  - `data/dsm/dsm_montreal_edouard_montpetit.tif`
  - `data/dsm/dsm_sainte_lucie_laurentides.tif`
  - `data/dsm/manifest.json` (or integrated `data/dtm/manifest.json`)
  - `backend/tests/test_elevation.py`
* **Key Implementation Details**:
  - Download official CanElevation DSM tiles corresponding to Montreal (Mount Royal) and Sainte-Lucie-des-Laurentides.
  - Verify spatial extent, resolution, and pixel alignment match existing DTM rasters.
  - Test instant offline elevation window extraction for both presets without network delay.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_elevation.py -v
  ```

---

### Commit 5.2: `test(e2e): add end-to-end tests for urban forest and rooftop canopy shading`
* **Purpose & Scope**:
  Implement comprehensive end-to-end simulation integration tests in both Python and Node.js covering tree canopy physics and rooftop vs. ground-mount shading.
* **Files Modified / Created**:
  - `backend/tests/test_api_simulate.py`
  - `frontend/tests/e2e.test.js`
* **Key Implementation Details**:
  - Test A: Mount Royal (dense urban deciduous forest) in June (Leaf-On) vs. December (Leaf-Off) — assert total kWh is significantly lower in June under dense canopy for ground-mount, but recovers partially in December.
  - Test B: Rooftop Mode on Édouard-Montpetit building — assert rooftop array sits above tree line for low buildings and receives zero self-shading from the roof.
  - Test C: Benchmark 24-hour simulation execution time with canopy ray-marching to ensure $< 600\text{ ms}$ total request latency.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_api_simulate.py -v
  cd frontend && npm test
  ```

---

### Commit 5.3: `ci(deploy): build container and deploy tree canopy modeling to Kubernetes`
* **Purpose & Scope**:
  Update deployment manifests/scripts, build production multi-stage container with frontend bundle and dual elevation caches, push to local container registry, and deploy to Kubernetes.
* **Files Modified / Created**:
  - `Dockerfile` (ensure `data/dsm/` is copied into container)
  - `scripts/deploy.sh`
* **Key Implementation Details**:
  - Verify container builds cleanly with Podman / Buildah.
  - Push image `127.0.0.1:30500/luxterra:latest` to local cluster registry.
  - Roll out deployment `deployment.apps/luxterra` in namespace `webapps`.
  - Verify live HTTP status and check API responses on `https://luxterra.alfok.ca`.
* **Verification**:
  ```bash
  ./scripts/deploy.sh
  kubectl rollout status deployment/luxterra -n webapps
  ```

---

## Phase 5 Acceptance Criteria
- [ ] Montreal and Sainte-Lucie preset views load instant DTM + DSM elevation data with zero missing coverage errors.
- [ ] E2E integration tests confirm expected seasonal attenuation across leaf-on and leaf-off conditions.
- [ ] Container image contains both frontend build and elevation assets.
- [ ] Application successfully deployed and running in Kubernetes at `https://luxterra.alfok.ca`.
