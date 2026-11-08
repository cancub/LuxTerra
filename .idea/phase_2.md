# Phase 2: Multi-Surface Ray-Marching Kernels (CUDA & CPU)

> **Phase Objective**: Upgrade LuxTerra's ray-marching occlusion engines (GPU CUDA and CPU NumPy fallback) to simultaneously trace solar rays against both **bare ground (DTM)** and **canopy/structures (DSM)**, conditioned on rooftop vs. ground-mount receiver altitudes.

---

## Granular Standalone Commits

### Commit 2.1: `feat(occlusion): implement multi-surface receiver altitude calculation for rooftop vs ground-mount`
* **Purpose & Scope**:
  Update [`ray_math.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/occlusion/ray_math.py) to compute target cell altitude $z_0(x_0, y_0)$ based on array deployment mode:
  $$z_0 = \begin{cases} z_{DSM}(x_0, y_0), & \text{if Rooftop Mode (panel on roof, not shaded by roof)} \\ z_{DTM}(x_0, y_0) + 1.5\,\text{m}, & \text{if Ground-Mount Mode (1.5m rack above ground)} \end{cases}$$
* **Files Modified / Created**:
  - `backend/app/services/occlusion/ray_math.py`
  - `backend/tests/test_occlusion.py`
* **Key Implementation Details**:
  - Add function `compute_receiver_altitude_grid(dtm: np.ndarray, dsm: np.ndarray, is_rooftop: bool, ground_stand_height_m: float = 1.5) -> np.ndarray`.
  - Ensure roof structures do not self-shadow the panels on their own surface, but taller trees or adjacent buildings above $z_0$ remain valid shadow casters.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_occlusion.py -k "test_receiver_altitude" -v
  ```

---

### Commit 2.2: `feat(occlusion): implement CUDA dual-surface ray-marching kernel for terrain and canopy`
* **Purpose & Scope**:
  Update [`cuda_kernels.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/occlusion/cuda_kernels.py) and [`cupy_raymarch.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/occlusion/cupy_raymarch.py) to compile and execute a multi-surface ray-marching kernel.
* **Files Modified / Created**:
  - `backend/app/services/occlusion/cuda_kernels.py`
  - `backend/app/services/occlusion/cupy_raymarch.py`
  - `backend/tests/test_occlusion.py`
* **Key Implementation Details**:
  - Extend CUDA kernel arguments to take `const float* dtm` and `const float* dsm`.
  - Perform bilinear texture sampling on both heightfields along the marching ray vector.
  - Classify occlusion per pixel into two masks or a packed 8-bit occlusion state:
    - `0`: Solid terrain occlusion ($z_{\text{ray}} < z_{DTM}$) — 0% direct beam transmittance.
    - `1`: Vegetative canopy occlusion ($z_{DTM} \le z_{\text{ray}} < z_{DSM}$) — direct beam filtered by canopy transmittance.
    - `2`: Completely unshaded ($z_{\text{ray}} \ge z_{DSM}$) — 100% direct beam sunlight.
  - Return separate binary masks: `terrain_mask` (1 = no terrain shade, 0 = terrain shade) and `canopy_mask` (1 = no canopy shade, 0 = canopy shade).
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_occlusion.py -k "test_cuda_dual_surface" -v
  ```

---

### Commit 2.3: `feat(occlusion): implement vectorized NumPy fallback for dual-surface ray-marching`
* **Purpose & Scope**:
  Update [`numpy_raymarch.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/occlusion/numpy_raymarch.py) and [`factory.py`](file:///home/alf/Code/dsh-sandbox/workspace/LuxTerra/backend/app/services/occlusion/factory.py) with an identical dual-surface ray-marching algorithm for environments without an active NVIDIA CUDA GPU.
* **Files Modified / Created**:
  - `backend/app/services/occlusion/numpy_raymarch.py`
  - `backend/app/services/occlusion/factory.py`
  - `backend/tests/test_occlusion.py`
* **Key Implementation Details**:
  - March along azimuth vector using NumPy vectorized operations and bilinear interpolation on both `dtm` and `dsm`.
  - Output identical `terrain_mask` and `canopy_mask` arrays matching CUDA kernel behavior.
  - Add equivalence test asserting bit-for-bit equality between CuPy GPU and NumPy CPU implementations on synthetic elevation patches with test trees and buildings.
* **Verification**:
  ```bash
  .venv/bin/pytest backend/tests/test_occlusion.py -v
  ```

---

## Phase 2 Acceptance Criteria
- [ ] Receiver altitude $z_0$ dynamically adjusts between rooftop ($z_0 = z_{DSM}$) and ground mount ($z_0 = z_{DTM} + 1.5\,\text{m}$).
- [ ] CUDA ray-marcher runs in $< 500\text{ ms}$ for 1,440 timesteps over a 500m patch.
- [ ] Both CPU and GPU engines return distinct terrain and canopy occlusion masks with bit-for-bit equivalence.
