# Phase 3: Phenology, PV Power Generation & Dual Mask Serialization

> **Phase Objective**: Implement the Quebec seasonal canopy phenology model, calculate fractional direct beam attenuation in the PV power engine, and serialize dual-channel shadow masks for high-speed network transmission.

---

## Granular Standalone Commits

### Commit 3.1: `feat(solar): add Quebec seasonal canopy phenology model`
* **Purpose & Scope**:
  Create `backend/app/services/solar/phenology.py` modeling day-of-year (DOY) direct beam transmittance $\tau(t)$ and diffuse attenuation across Quebec's temperate/boreal climatic zones.
* **Files Modified / Created**:
  - `backend/app/services/solar/phenology.py`
  - `backend/tests/test_phenology.py`
* **Key Implementation Details**:
  - Implement schedule:
    - **Summer (Leaf-On, May 15 – Oct 15 / DOY 135–288)**: $\tau_{\text{direct}} = 0.15$, $\tau_{\text{diffuse}} = 0.25$.
    - **Autumn Senescence (Oct 16 – Nov 15 / DOY 289–319)**: Linear transition from $0.15 \to 0.60$.
    - **Winter (Leaf-Off, Nov 16 – Apr 15 / DOY 320–365 & 1–105)**: $\tau_{\text{direct}} = 0.60$, $\tau_{\text{diffuse}} = 0.70$ (bare deciduous branches + conifer retention).
    - **Spring Budburst (Apr 16 – May 14 / DOY 106–134)**: Linear transition from $0.60 \to 0.15$.
  - Provide override support for user modes:
    - `"seasonal"`: Auto-computed by date (Default).
    - `"leaf_on"`: Fixed summer density ($\tau = 0.15$).
    - `"leaf_off"`: Fixed winter bare branch ($\tau = 0.60$).
    - `"bare_terrain"`: Canopy ignored ($\tau = 1.0$).
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_phenology.py -v
  ```

---

### Commit 3.2: `feat(pv): integrate canopy attenuation into PVSystemModel`
* **Purpose & Scope**:
  Update [`standard_model.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/pv/standard_model.py) and schemas to calculate instantaneous kW with canopy transmittance.
* **Files Modified / Created**:
  - `backend/app/services/pv/standard_model.py`
  - `backend/app/interfaces/pv_model.py`
  - `backend/tests/test_pv.py`
* **Key Implementation Details**:
  - Update `calculate_power_kw()` to accept `canopy_mask: Optional[np.ndarray] = None` and `canopy_transmittance: float = 0.15`.
  - Calculate pixel direct irradiance:
    $$I_{\text{direct, pixel}} = I_{\text{direct}} \times \text{terrain\_mask}_{\text{pixel}} \times \left(1.0 - (1.0 - \tau_{\text{canopy}}) \times (1 - \text{canopy\_mask}_{\text{pixel}})\right)$$
  - Unshaded cells receive $100\%$ direct beam.
  - Canopy-shaded cells receive $\tau_{\text{canopy}} \times I_{\text{direct}} + I_{\text{diffuse}}$.
  - Terrain-shaded cells receive $0 \times I_{\text{direct}} + I_{\text{diffuse}}$.
  - Compute separate percentage metrics: `terrain_shaded_pct` and `canopy_shaded_pct`.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_pv.py -v
  ```

---

### Commit 3.3: `feat(simulate): update SimulationOrchestrator and serializer for dual-channel shadow masks`
* **Purpose & Scope**:
  Update [`serializer.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/serializer.py), [`simulate.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/schemas/simulate.py), and [`simulator.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/simulator.py) to return dual-channel shadow bitmasks and canopy summary telemetry.
* **Files Modified / Created**:
  - `backend/app/schemas/domain.py`
  - `backend/app/schemas/simulate.py`
  - `backend/app/services/serializer.py`
  - `backend/app/services/simulator.py`
  - `backend/tests/test_api_simulate.py`
* **Key Implementation Details**:
  - Extend `SimulateRequest` with:
    - `include_tree_canopy: bool = True` (Default enabled per user decision)
    - `canopy_mode: str = "seasonal"` (`"seasonal"`, `"leaf_on"`, `"leaf_off"`, `"bare_terrain"`)
  - Extend `SimulateResponse` with:
    - `canopy_masks: List[str]` (Bit-packed Base64 binary masks for canopy shade)
    - `canopy_transmittance: float`
    - `daily_summary.avg_canopy_shaded_pct: float`
  - Ensure nighttime frames clip both terrain and canopy masks strictly to active user polygons (`night_mask` and `night_canopy_mask`).
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_api_simulate.py -v
  ```

---

## Phase 3 Acceptance Criteria
- [ ] Seasonal phenology dynamically returns appropriate transmittance based on the requested simulation date.
- [ ] PV electrical power accurately reflects partial irradiance transmission under canopy vs. 0% under solid terrain.
- [ ] Backend API returns dual-channel bitmasks (`masks` for terrain, `canopy_masks` for trees) with full backwards compatibility.
