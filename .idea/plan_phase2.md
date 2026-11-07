# LuxTerra - Phase 2: Compute Engine & Ray-Marcher
## Granular Implementation Plan & Incremental Commits

---

### Objective
Implement the modular compute engine incorporating:
1. Compiled GPU ray-marching via CuPy on the local NVIDIA RTX 4070 Ti, accompanied by a vectorized NumPy CPU fallback.
2. Solar position, optimal seasonal tilt, and clear-sky atmospheric radiation via `pvlib`.
3. Usable PV electrical output conversion with unobstructed view factor ($SVF = 1.0$) and a toggle between **Rooftop ($100\%$ GCR)** and **Ground-Mount ($45\%$ GCR)**.
4. Clean dependency injection interfaces and validation testing against synthetic hill benchmarks.

---

### Incremental Commit Sequence

#### Commit 2.1: `feat(domain): define domain models and validation schemas for simulation parameters`
* **Files:**
  * `backend/app/schemas/domain.py`
* **Description:**
  * Defines Pydantic domain models:
    * `GeoBoundingBox`: Latitude and longitude bounds with validation ensuring area $\le 100,000\text{ m}^2$.
    * `SolarAngles`: Azimuth ($\gamma$), elevation ($\alpha$), zenith, and incident angle.
    * `IrradianceComponents`: Direct normal ($\text{DNI}$), diffuse horizontal ($\text{DHI}$), and plane-of-array ($\text{POA}$).
    * `SimulationTimestep`: Timestamp, sun angles, aggregate $\text{kW}$, shaded percentage, and raw mask reference.
* **Acceptance / Verification:**
  * Domain models instantiate and enforce data types and constraints.

---

#### Commit 2.2: `feat(interfaces): establish abstract base classes for solar, occlusion, and PV engines`
* **Files:**
  * `backend/app/interfaces/solar_engine.py`
  * `backend/app/interfaces/occlusion_engine.py`
  * `backend/app/interfaces/pv_model.py`
* **Description:**
  * Implements Abstract Base Classes (ABCs):
    * `SolarEngine`: Interface for solar position and clear-sky radiation calculations.
    * `OcclusionEngine`: Interface accepting elevation grid and sun position, returning binary shadow masks.
    * `PVSystemModel`: Interface converting irradiance and shadow masks into usable electrical $\text{kW}$.
* **Acceptance / Verification:**
  * Interfaces compile without circular imports and enforce required method signatures.

---

#### Commit 2.3: `feat(solar): implement solar geometry and optimal seasonal tilt calculator`
* **Files:**
  * `backend/app/services/solar/geometry.py`
* **Description:**
  * Implements solar position geometry:
    * Uses `pvlib.solarposition.get_solarposition` to determine solar azimuth ($\gamma$) and elevation ($\alpha$).
    * Calculates optimal panel tilt facing true south ($180^\circ$ azimuth): $\text{tilt} = 90^\circ - \alpha$.
    * Computes incident beam angle on tilted panel:
      $$\cos(\theta_{\text{incident}}) = \sin(\alpha)\cos(\text{tilt}) + \cos(\alpha)\sin(\text{tilt})\cos(\gamma - 180^\circ)$$
* **Acceptance / Verification:**
  * Unit test verifies that on solar noon with panel tilted to solar zenith, incident angle $\theta_{\text{incident}} = 0^\circ$ ($\cos(\theta) = 1.0$).

---

#### Commit 2.4: `feat(solar): implement clear-sky irradiance model via pvlib Ineichen`
* **Files:**
  * `backend/app/services/solar/pvlib_engine.py`
* **Description:**
  * Implements `PvlibSolarEngine` implementing `SolarEngine`:
    * Computes clear-sky $\text{DNI}$ and $\text{DHI}$ using `pvlib.clearsky.ineichen`.
    * Integrates solar geometry to calculate unshaded Plane-of-Array ($\text{POA}$) irradiance components.
    * Incorporates unobstructed sky view factor ($SVF = 1.0$, adjusted for panel tilt):
      $$\text{Diffuse}_{\text{tilted}} = \text{DHI} \cdot \left(\frac{1 + \cos(\text{tilt})}{2}\right)$$
* **Acceptance / Verification:**
  * Verifies realistic clear-sky radiation values for Montreal across solstice and equinox dates.

---

#### Commit 2.5: `feat(pv): implement PV electrical conversion model with Rooftop/Ground GCR toggle`
* **Files:**
  * `backend/app/services/pv/standard_pv.py`
* **Description:**
  * Implements `StandardPVModel` implementing `PVSystemModel`:
    * Computes cell-by-cell effective irradiance:
      $$\text{Irradiance}_{\text{cell}} = (\text{DNI} \cdot \cos(\theta_{\text{incident}}) \cdot \text{Mask}_{\text{cell}}) + \text{Diffuse}_{\text{tilted}}$$
    * Converts effective irradiance to total usable AC power:
      $$\text{Power} (\text{kW}) = \frac{\sum_{\text{cells}} \text{Irradiance}_{\text{cell}} \cdot A_{\text{cell}} \cdot \text{GCR} \cdot \eta_{\text{module}} \cdot PR}{1000}$$
    * Supports configurable parameters:
      * **Deployment Mode:** Rooftop ($\text{GCR} = 1.0$) vs. Ground-Mount ($\text{GCR} = 0.45$).
      * **Module Efficiency ($\eta$):** Default $0.20$ ($20\%$).
      * **System Performance Ratio ($PR$):** Default $0.80$ ($80\%$).
* **Acceptance / Verification:**
  * A $10,000\text{ m}^2$ unshaded patch under $1000\text{ W/m}^2$ irradiance yields $1,600\text{ kW}$ in rooftop mode and $720\text{ kW}$ in ground mode.

---

#### Commit 2.6: `feat(occlusion): build compiled CUDA ray-marching kernel via CuPy`
* **Files:**
  * `backend/app/services/occlusion/cuda_kernels.py`
* **Description:**
  * Implements the CUDA C++ ray-marching kernel string compiled with `cupy.RawKernel`:
    * Dispatches one GPU thread per cell of the target patch.
    * Steps outward in 1-meter increments along the sun azimuth vector $(\Delta x = \sin\gamma, \Delta y = \cos\gamma)$ up to $500\text{ m}$.
    * Computes ray elevation at distance $d$:
      $$Z_{\text{ray}}(d) = Z_{\text{origin}} + d \cdot \tan(\alpha)$$
    * Samples terrain height $Z_{\text{terrain}}(x_d, y_d)$; terminates early as shaded ($0$) if $Z_{\text{terrain}} > Z_{\text{ray}}$.
* **Acceptance / Verification:**
  * Kernel compiles cleanly on the local RTX 4070 Ti with CUDA 13.

---

#### Commit 2.7: `feat(occlusion): implement CuPy GPU occlusion service with memory management`
* **Files:**
  * `backend/app/services/occlusion/cupy_raymarch.py`
* **Description:**
  * Implements `CuPyOcclusionEngine` implementing `OcclusionEngine`:
    * Manages VRAM allocation for the buffered elevation array and output mask buffers.
    * Translates geographic azimuth and elevation angles to grid step coordinates.
    * Dispatches kernel execution across GPU thread blocks; returns a compact 2D uint8 mask array.
* **Acceptance / Verification:**
  * Benchmarking a $100,000\text{ m}^2$ patch with 500m ray-march executes in $< 10\text{ ms}$ on the RTX 4070 Ti.

---

#### Commit 2.8: `feat(occlusion): implement vectorized NumPy CPU fallback ray-marcher`
* **Files:**
  * `backend/app/services/occlusion/numpy_raymarch.py`
* **Description:**
  * Implements `NumPyOcclusionEngine` as a pure CPU fallback:
    * Uses vectorized striding along the sun azimuth vector.
    * Serves as an automatic fallback when CUDA or CuPy is unavailable.
* **Acceptance / Verification:**
  * Produces identical binary shadow masks to the GPU kernel when tested on identical elevation inputs.

---

#### Commit 2.9: `test(engine): add unit tests for solar geometry, clear-sky irradiance, and PV yields`
* **Files:**
  * `backend/tests/test_solar.py`
  * `backend/tests/test_pv.py`
* **Description:**
  * Unit tests validating:
    * Sun azimuth and elevation angles for key dates (solstice, equinox).
    * Clear-sky irradiance calculations against reference `pvlib` baselines.
    * Power yield conversions under full sun, partial shade, and full shade.
* **Acceptance / Verification:**
  * `pytest backend/tests/test_solar.py backend/tests/test_pv.py` passes all tests.

---

#### Commit 2.10: `test(engine): benchmark GPU ray-marcher against synthetic hill profiles and CPU baseline`
* **Files:**
  * `backend/tests/test_occlusion.py`
  * `backend/tests/benchmark_raymarch.py`
* **Description:**
  * Sets up synthetic terrain benchmarks:
    * Tests a 50m hill placed 100m from a patch at varying sun elevations ($\alpha = 15^\circ, 45^\circ, 75^\circ$) to mathematically confirm shadow length ($L = \Delta h / \tan(\alpha)$).
    * Compares CuPy GPU performance against NumPy CPU performance and validates bit-level mask equivalence.
* **Acceptance / Verification:**
  * Test confirms mathematical accuracy of shadow boundaries and confirms GPU speedup $> 20\times$ over CPU.
